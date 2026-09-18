import { env } from "../../config/env";
import {
  ERROR_CODES,
  PUBLISHABLE_PRIVACY_STATUSES,
  SIGNED_URL_TTL_MS,
} from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { getStorage } from "../../services/storage";
import {
  contentHash,
  probeImage,
  processImage,
  type BlurRegionInput,
} from "../../services/imaging";
import { detectSensitiveRegions } from "../../services/detection";
import { enqueueImageJob } from "../../services/queue";
import { logger } from "../../utils/logger";
import { isModerator } from "../../types/auth";
import type { AuthUser } from "../../types/auth";
import { IMAGE_VARIANT_NAMES } from "../shared/serialize";
import { Prisma, PrivacyStatus, type RegionReviewStatus } from "@prisma/client";

export const PUBLISHABLE: PrivacyStatus[] = [...PUBLISHABLE_PRIVACY_STATUSES];

export function isPublishableStatus(status: PrivacyStatus): boolean {
  return PUBLISHABLE.includes(status);
}

function originalKey(uuid: string): string {
  return `${uuid}/original`;
}

function variantKey(uuid: string, variant: string): string {
  return `${uuid}/${variant}.webp`;
}

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface UploadResult {
  uuid: string;
  duplicated: boolean;
  privacyStatus: PrivacyStatus;
  width: number;
  height: number;
  variants: Record<string, string>;
}

/**
 * 上传入口只做三件必须同步完成的事：校验、落原图、投递任务。
 * 耗时的模糊化与多档渲染交给 worker，保证接口响应稳定在几百毫秒内。
 */
export async function uploadImage(file: UploadedFile, user: AuthUser): Promise<UploadResult> {
  const probe = await probeImage(file.buffer, file.mimetype);
  const hash = contentHash(file.buffer);

  // 同一用户重复上传同一张图时复用已有资源，避免重复占用存储与审核成本
  const existing = await prisma.mediaAsset.findFirst({
    where: { ownerId: user.id, contentHash: hash, originalPath: { not: null } },
  });

  if (existing) {
    return {
      uuid: existing.uuid,
      duplicated: true,
      privacyStatus: existing.privacyStatus,
      width: existing.width,
      height: existing.height,
      variants: buildVariantMap(existing.uuid, existing.variantVersion),
    };
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId: user.id,
      contentHash: hash,
      originalSize: BigInt(file.size),
      originalMime: file.mimetype,
      width: probe.width,
      height: probe.height,
      privacyStatus: "processing",
      purgeAfter: new Date(Date.now() + env.ORIGINAL_RETENTION_DAYS * 86400000),
    },
    select: { uuid: true },
  });

  const storage = getStorage();
  await storage.putPrivate(originalKey(asset.uuid), file.buffer);
  await prisma.mediaAsset.update({
    where: { uuid: asset.uuid },
    data: { originalPath: originalKey(asset.uuid) },
  });

  const queued = await enqueueImageJob({ assetUuid: asset.uuid, reason: "upload" });
  if (!queued) {
    // 队列不可用时同步处理，避免图片永远停在 processing
    await processAsset(asset.uuid, "upload").catch((error) => {
      logger.error({ err: (error as Error).message, uuid: asset.uuid }, "同步处理图片失败");
    });
  }

  const fresh = await prisma.mediaAsset.findUniqueOrThrow({ where: { uuid: asset.uuid } });

  return {
    uuid: fresh.uuid,
    duplicated: false,
    privacyStatus: fresh.privacyStatus,
    width: fresh.width,
    height: fresh.height,
    variants: buildVariantMap(fresh.uuid, fresh.variantVersion),
  };
}

function buildVariantMap(uuid: string, version: number): Record<string, string> {
  const map: Record<string, string> = {};
  for (const variant of IMAGE_VARIANT_NAMES) {
    map[variant] = `/api/v1/media/${uuid}/${variant}?v=${version}`;
  }
  return map;
}

export interface ProcessOutcome {
  privacyStatus: PrivacyStatus;
  autoDetected: number;
  /** 置信度分级统计：trusted 自动放行 / ambiguous 待人工 / candidate 仅候选 */
  grades: { trusted: number; ambiguous: number; candidate: number };
  notes: string[];
}

/** 走隐私检测（含置信度自动分级）的处理原因 */
const DETECTION_REASONS = new Set(["upload", "retry", "redetect"]);

/** 人工已经做过判定的自动区域：已采纳 / 已驳回，批量重跑不得覆盖 */
const ADJUDICATED_REVIEW: RegionReviewStatus[] = ["accepted", "dismissed"];

/**
 * 图片处理流水线（worker 与同步降级路径共用）。
 *
 * 顺序：读原图 → 检测（在干净的清洗图上）→ 分级落框 → 一次性渲染变体 → 更新状态。
 * 每一步都从**原图**重新渲染，避免重复编辑导致模糊区域叠加失真。
 */
export async function processAsset(
  assetUuid: string,
  reason: "upload" | "blur-update" | "retry" | "redetect" | "privacy-reset",
): Promise<ProcessOutcome> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  const storage = getStorage();
  const key = asset.originalPath ?? originalKey(assetUuid);
  const original = await storage.getPrivate(key);

  const existingRegions = await prisma.blurRegion.findMany({ where: { assetId: asset.id } });

  let privacyStatus: PrivacyStatus;
  let autoDetected = 0;
  let notes: string[] = [];
  const grades = { trusted: 0, ambiguous: 0, candidate: 0 };
  /** 低置信度候选框：不打码，只随检测元数据留存供人工抽查 */
  let candidateBoxes: unknown[] = [];
  /** 检测分支的完整结果，末尾统一写元数据 */
  let detectionResult: import("../../services/detection").DetectionResult | null = null;
  let appliedRegions = existingRegions.filter((region) => !region.ignored);

  if (DETECTION_REASONS.has(reason)) {
    // 先在原图上做一次清洗（去 EXIF + 方向摆正），检测跑在干净的全分辨率图上，
    // 不能用已打码的变体，否则检测器看到的人脸已经糊了
    const clean = await sanitizeForDetection(original);

    // 重跑/重试都属于"重新检测"：人工既判区域受保护——手动框 +
    // 已被复核接受/驳回的自动框。只有首次上传（无历史框）才全量替换。
    const isReprocessing = reason === "redetect" || reason === "retry";

    const protectedRegions = isReprocessing
      ? existingRegions
          .filter(
            (region) =>
              region.source === "manual" ||
              (region.source === "auto" &&
                region.reviewStatus !== null &&
                ADJUDICATED_REVIEW.includes(region.reviewStatus)),
          )
          .map((region) => ({ x: region.x, y: region.y, w: region.w, h: region.h }))
      : [];

    const detection = await detectSensitiveRegions(
      { buffer: clean.buffer, mimetype: "image/webp", width: clean.width, height: clean.height },
      { protectedRegions },
    );
    detectionResult = detection;
    notes = detection.notes;
    grades.trusted = detection.graded.trusted.length;
    grades.ambiguous = detection.graded.ambiguous.length;
    grades.candidate = detection.graded.candidate.length;
    candidateBoxes = detection.graded.candidate.map((box) => ({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      label: box.label,
      confidence: box.confidence,
      detector: originOf(box, detection.adapterOutcomes),
    }));

    // 只删除"机器尚未被人工裁定"的自动框；
    // accepted/dismissed 是人工结论，重检也不能冲掉
    await prisma.blurRegion.deleteMany({
      where: {
        assetId: asset.id,
        source: "auto",
        ...(isReprocessing ? { reviewStatus: { in: ["trusted", "pending"] } } : {}),
      },
    });

    // trusted 与 ambiguous 落为打码区域；candidate 不打码，只进检测元数据
    const autoRows = [
      ...detection.graded.trusted.map((box) => ({ box, reviewStatus: "trusted" as const })),
      ...detection.graded.ambiguous.map((box) => ({ box, reviewStatus: "pending" as const })),
    ];

    if (autoRows.length > 0) {
      await prisma.blurRegion.createMany({
        data: autoRows.map(({ box, reviewStatus }) => ({
          assetId: asset.id,
          source: "auto" as const,
          algorithm: "pixelate" as const,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          label: box.label,
          confidence: box.confidence,
          detector: originOf(box, detection.adapterOutcomes),
          reviewStatus,
          // 高置信度框视为机器已复核
          reviewedAt: reviewStatus === "trusted" ? new Date() : null,
          strength: 14,
        })),
      });
      autoDetected = autoRows.length;
    }

    const allRegions = await prisma.blurRegion.findMany({
      where: { assetId: asset.id, ignored: false },
    });
    appliedRegions = allRegions;

    if (!detection.anyAvailable) {
      // 没有检测能力时必须人工确认，这是不可跳过的门禁
      privacyStatus = "needs_manual";
    } else if (detection.decision === "clean") {
      // 检测器可用且未发现敏感区域，才算真正干净
      privacyStatus = "auto_clean";
    } else if (detection.decision === "auto_confirmed") {
      // 全部命中都是高置信度：自动模糊并直接放行，不占用人工复核
      privacyStatus = "auto_confirmed";
    } else {
      // 有中置信度框（默认先模糊）或低置信度候选（未打码）——都只让人工看这些疑难
      privacyStatus = "auto_blurred";
    }
  } else {
    if (reason === "blur-update") {
      const manualCount = existingRegions.filter((region) => region.source === "manual").length;
      // 驳回重渲染时若已经是 confirmed（逐条复核场景），保持已确认状态
      privacyStatus = asset.privacyStatus === "confirmed"
        ? "confirmed"
        : manualCount > 0
          ? "manual_blurred"
          : "auto_blurred";
    } else {
      // privacy-reset（隐私举报成立后的重置）：必须人工处理
      privacyStatus = "needs_manual";
    }
  }

  // 统一在最后从原图渲染一次：检测分支拿到的是新落的分级框，
  // 编辑分支拿到的是审核员保存后的区域，避免旧实现里"检测后再渲染第二次"的双版本号
  const rendered = await processImage(original, appliedRegions.map(toBlurInput));
  await writeVariants(assetUuid, asset.variantVersion + 1, rendered.variants);

  // blur-update 只是人工调整区域，上一轮检测的分级 / 候选 / 适配器信息必须保留
  // （复核自动升级依赖 grades.candidate）；只刷新渲染时间戳。
  let detectionMeta: Prisma.InputJsonValue;
  if (detectionResult) {
    detectionMeta = toJsonValue({
      notes,
      autoDetected,
      grades,
      candidates: candidateBoxes,
      adapters: detectionResult.adapterOutcomes.map((outcome) => ({
        id: outcome.adapter,
        available: outcome.available,
        found: outcome.boxes.length,
        reason: outcome.reason ?? null,
      })),
      thresholds: detectionResult.thresholds,
      processedAt: new Date().toISOString(),
    });
  } else {
    const previous = (asset.detectionMeta ?? {}) as Record<string, unknown>;
    detectionMeta = toJsonValue({ ...previous, rerenderedAt: new Date().toISOString() });
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      privacyStatus,
      exifStripped: true,
      detectionMeta,
      retryCount: reason === "retry" ? { increment: 1 } : undefined,
      width: rendered.width,
      height: rendered.height,
      // 重检/重试把曾经放行的图片降回待复核时，清掉旧确认人，避免"谁确认的"对不上当前状态
      ...(DETECTION_REASONS.has(reason) && !isPublishableStatus(privacyStatus)
        ? { privacyConfirmedBy: null, privacyConfirmedAt: null }
        : {}),
    },
  });

  return { privacyStatus, autoDetected, grades, notes };
}

/** 清洗原图（去元数据、按方向摆正），检测器的输入 */
async function sanitizeForDetection(original: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { sanitizeImage } = await import("../../services/imaging");
  return sanitizeImage(original);
}

/** 反查某个框来自哪个适配器（框对象在 NMS / 分级中保持同一引用，按身份匹配） */
function originOf(
  box: object,
  outcomes: Array<{ adapter: string; boxes: object[] }>,
): string | null {
  for (const outcome of outcomes) {
    if (outcome.boxes.includes(box)) return outcome.adapter;
  }
  return null;
}

function toBlurInput(region: {
  x: number;
  y: number;
  w: number;
  h: number;
  algorithm: string;
  strength: number;
}): BlurRegionInput {
  return {
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
    algorithm: region.algorithm === "gaussian" ? "gaussian" : "pixelate",
    strength: region.strength,
  };
}

async function writeVariants(
  assetUuid: string,
  version: number,
  variants: Record<string, { buffer: Buffer; width: number; height: number }>,
): Promise<void> {
  const storage = getStorage();
  const meta: Record<string, unknown> = {};

  for (const [name, variant] of Object.entries(variants)) {
    const key = variantKey(assetUuid, name);
    await storage.putPublic(key, variant.buffer);
    meta[name] = { key, bytes: variant.buffer.byteLength, width: variant.width, height: variant.height };
  }

  await prisma.mediaAsset.update({
    where: { uuid: assetUuid },
    data: { variants: toJsonValue(meta), variantVersion: version },
  });
}

export interface BlurRegionPayload {
  id?: number | string;
  source: "auto" | "manual";
  algorithm?: "pixelate" | "gaussian";
  strength?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  ignored?: boolean;
  ignoreReason?: string;
}

/**
 * 覆盖式更新模糊区域。
 * 请求体描述的是"修改后的完整状态"，服务端据此增删改，
 * 避免前端需要维护复杂的差分逻辑。
 *
 * 审核员对自动框的去留会落成 reviewStatus（accepted / dismissed），
 * 之后批量重跑检测时这些人工结论受保护，不会被机器结果冲掉。
 */
export async function updateBlurRegions(
  assetUuid: string,
  regions: BlurRegionPayload[],
  reason: string | undefined,
  actorId?: bigint,
): Promise<{ privacyStatus: PrivacyStatus; regionsApplied: number }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  if (!asset.originalPath) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      "原图已按隐私策略清理，无法再编辑模糊区域。如确有问题，请下架该图片。",
    );
  }

  for (const region of regions) {
    if (region.source === "manual") {
      const valid =
        typeof region.x === "number" &&
        typeof region.y === "number" &&
        typeof region.w === "number" &&
        typeof region.h === "number" &&
        region.x >= 0 &&
        region.y >= 0 &&
        region.w > 0 &&
        region.h > 0 &&
        region.x + region.w <= 1.0001 &&
        region.y + region.h <= 1.0001;

      if (!valid) {
        throw AppError.badRequest("手动模糊区域必须位于图片范围内（归一化坐标 0–1）");
      }
    }

    if (region.ignored && !region.ignoreReason?.trim()) {
      throw AppError.badRequest("忽略自动检测区域时必须填写理由");
    }
  }

  const keepIds = regions
    .filter((region) => region.id !== undefined)
    .map((region) => BigInt(region.id as number | string));

  // 校验这些区域确实属于当前图片。
  // 少了这一步，审核员可以传别的图片的 region id 来改动它。
  if (keepIds.length > 0) {
    const owned = await prisma.blurRegion.count({
      where: { id: { in: keepIds }, assetId: asset.id },
    });
    if (owned !== keepIds.length) {
      throw AppError.badRequest("提交的模糊区域不属于这张图片");
    }
  }

  await prisma.$transaction(async (tx) => {
    // 删除本次未保留的区域。
    // 例外：已经过人工复核裁定（accepted/dismissed）的自动框不允许被"覆盖式保存"
    // 静默删掉——复核台与模糊工作台是两个入口，工作台加载时看不到被驳回的框，
    // 不保护就会让审核员在别处保存时把人工结论冲掉。要删除需显式传 id。
    // 例外：已经过人工复核裁定（accepted/dismissed）的自动框不允许被"覆盖式保存"
    // 静默删掉——复核台与模糊工作台是两个入口，工作台加载时看不到被驳回的框，
    // 不保护就会让审核员在别处保存时把人工结论冲掉。要删除需显式传 id。
    const notAdjudicated = {
      OR: [
        { source: "manual" as const },
        { source: "auto" as const, reviewStatus: { in: ["trusted", "pending"] satisfies RegionReviewStatus[] } },
        { source: "auto" as const, reviewStatus: null },
      ],
    };
    await tx.blurRegion.deleteMany({
      where: {
        assetId: asset.id,
        ...notAdjudicated,
        ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
      },
    });

    for (const region of regions) {
      if (region.id !== undefined) {
        // 对自动检测框的复核结论：保留=accepted（含从忽略恢复），忽略=dismissed
        const isAdjudication = region.source === "auto" && actorId !== undefined;
        await tx.blurRegion.update({
          where: { id: BigInt(region.id) },
          data: {
            ignored: region.ignored ?? false,
            ignoreReason: region.ignoreReason ?? null,
            algorithm: region.algorithm ?? undefined,
            strength: region.strength ?? undefined,
            ...(isAdjudication
              ? {
                  reviewStatus: (region.ignored ? "dismissed" : "accepted") as RegionReviewStatus,
                  reviewedAt: new Date(),
                  reviewedBy: actorId,
                }
              : {}),
          },
        });
        continue;
      }

      await tx.blurRegion.create({
        data: {
          assetId: asset.id,
          source: region.source,
          algorithm: region.algorithm ?? "pixelate",
          x: region.x ?? 0,
          y: region.y ?? 0,
          w: region.w ?? 0,
          h: region.h ?? 0,
          strength: region.strength ?? 14,
          label: region.label ?? null,
          createdBy: actorId ?? null,
        },
      });
    }
  });

  const outcome = await processAsset(assetUuid, "blur-update");
  logger.info({ assetUuid, reason, regions: regions.length }, "模糊区域已更新并重新渲染");

  return { privacyStatus: outcome.privacyStatus, regionsApplied: regions.filter((r) => !r.ignored).length };
}

/** 审核员确认隐私处理完成——这是图片可发布的出口之一（人工通道） */
export async function confirmPrivacy(assetUuid: string, actorId: bigint): Promise<PrivacyStatus> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  if (!["auto_clean", "auto_blurred", "manual_blurred"].includes(asset.privacyStatus)) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      `当前状态（${asset.privacyStatus}）不允许确认，请先完成模糊处理`,
    );
  }

  // 兜底：确认时把所有尚未裁定的自动框标记为人工采纳，避免遗留 pending
  await prisma.blurRegion.updateMany({
    where: { assetId: asset.id, source: "auto", reviewStatus: "pending", ignored: false },
    data: { reviewStatus: "accepted", reviewedAt: new Date(), reviewedBy: actorId },
  });

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { privacyStatus: "confirmed", privacyConfirmedBy: actorId, privacyConfirmedAt: new Date() },
  });

  return "confirmed";
}

export interface RegionVerdict {
  /** true=保留打码（accepted），false=确认无需打码（dismissed，必须给理由） */
  accept: boolean;
  reason?: string;
}

/**
 * 复核单个疑难（中置信度）检测区域。
 *
 * 这是"只让人工复核疑难区域"的最小动作：审核员逐条对 pending 框下判断，
 * 全部裁定完且没有遗留低置信度候选时，图片自动升级，无需再点整图确认。
 */
export async function reviewRegion(
  assetUuid: string,
  regionId: bigint,
  verdict: RegionVerdict,
  actorId: bigint,
): Promise<{ privacyStatus: PrivacyStatus; remaining: number }> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  const region = await prisma.blurRegion.findUnique({ where: { id: regionId } });
  if (!region || region.assetId !== asset.id) throw AppError.notFound("检测区域不存在");
  if (region.source !== "auto") throw AppError.badRequest("手动区域不需要复核");
  if (!verdict.accept && !verdict.reason?.trim()) {
    throw AppError.badRequest("驳回检测区域时必须填写理由");
  }

  await prisma.blurRegion.update({
    where: { id: regionId },
    data: {
      reviewStatus: verdict.accept ? "accepted" : "dismissed",
      ignored: !verdict.accept,
      ignoreReason: verdict.accept ? null : verdict.reason!.trim(),
      reviewedAt: new Date(),
      reviewedBy: actorId,
    },
  });

  // 驳回意味着要去掉这块打码，必须从原图重新渲染公开变体
  if (!verdict.accept) {
    await processAsset(assetUuid, "blur-update");
  }

  const [remaining, fresh] = await Promise.all([
    prisma.blurRegion.count({ where: { assetId: asset.id, reviewStatus: "pending" } }),
    prisma.mediaAsset.findUniqueOrThrow({ where: { uuid: assetUuid } }),
  ]);

  // 所有疑难框裁定完毕，且没有遗留低置信度候选时才自动升级；
  // needs_manual（检测器曾不可用）整张图没有检测背书，必须走整图确认。
  let privacyStatus = fresh.privacyStatus;
  if (remaining === 0 && fresh.privacyStatus === "auto_blurred") {
    const meta = (fresh.detectionMeta ?? {}) as { grades?: { candidate?: number } };
    if ((meta.grades?.candidate ?? 0) === 0) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { privacyStatus: "confirmed", privacyConfirmedBy: actorId, privacyConfirmedAt: new Date() },
      });
      privacyStatus = "confirmed";
    }
  }

  return { privacyStatus, remaining };
}

export async function retryProcessing(assetUuid: string): Promise<ProcessOutcome> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");
  if (!asset.originalPath) throw AppError.badRequest("原图已清理，无法重试");
  return processAsset(assetUuid, "retry");
}

/** 隐私举报成立：删除公开变体并重置隐私状态，公开地址立即失效 */
export async function revokePublicVariants(assetUuid: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) return;

  const storage = getStorage();
  for (const variant of IMAGE_VARIANT_NAMES) {
    await storage.deletePublic(variantKey(assetUuid, variant)).catch(() => undefined);
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      privacyStatus: "needs_manual",
      variantVersion: { increment: 1 },
      variants: {},
      privacyConfirmedBy: null,
      privacyConfirmedAt: null,
    },
  });
}

export async function getVariant(
  assetUuid: string,
  variant: string,
  viewer?: AuthUser,
): Promise<{ body: Buffer; contentType: string; publishable: boolean }> {
  if (!IMAGE_VARIANT_NAMES.includes(variant as never)) {
    throw AppError.notFound("图片尺寸不存在");
  }

  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");

  const publishable = isPublishableStatus(asset.privacyStatus);
  const privileged = viewer && (viewer.id === asset.ownerId || isModerator(viewer));

  // 未通过隐私门禁的图片只对作者与审核角色可见
  if (!publishable && !privileged) {
    throw AppError.notFound("图片不存在");
  }

  const storage = getStorage();
  const object = await storage.getPublic(variantKey(assetUuid, variant));
  return { ...object, publishable };
}

export async function signedOriginalUrl(assetUuid: string): Promise<string> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset) throw AppError.notFound("图片不存在");
  if (!asset.originalPath) throw AppError.notFound("原图已按隐私策略清理");

  return getStorage().signedPrivateUrl(asset.originalPath, SIGNED_URL_TTL_MS);
}

/** 签名 URL 回源读取（仅本地存储驱动需要） */
export async function readOriginalByKey(key: string): Promise<{ body: Buffer; contentType: string }> {
  const body = await getStorage().getPrivate(key);
  return { body, contentType: "application/octet-stream" };
}

export async function purgeOriginal(assetUuid: string): Promise<boolean> {
  const asset = await prisma.mediaAsset.findUnique({ where: { uuid: assetUuid } });
  if (!asset?.originalPath) return false;

  await getStorage().deletePrivate(asset.originalPath).catch(() => undefined);
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { originalPath: null, purgeAfter: null },
  });
  return true;
}

export function assertAllPublishable(assets: Array<{ uuid: string; privacyStatus: PrivacyStatus }>): void {
  const blocked = assets.filter((asset) => !isPublishableStatus(asset.privacyStatus));
  if (blocked.length > 0) {
    throw AppError.unprocessable(
      ERROR_CODES.PRIVACY_NOT_CONFIRMED,
      `有 ${blocked.length} 张图片尚未完成隐私确认，无法通过审核。请先处理图片中的隐私区域。`,
      { assets: blocked.map((asset) => ({ uuid: asset.uuid, privacyStatus: asset.privacyStatus })) },
    );
  }
}
