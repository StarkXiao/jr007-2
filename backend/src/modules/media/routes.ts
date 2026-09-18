import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env";
import { ERROR_CODES } from "../../config/constants";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { AppError } from "../../utils/errors";
import { requireActiveWriter, requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { rateLimit } from "../../middleware/rateLimit";
import { validate } from "../../middleware/validate";
import { prisma } from "../../db/prisma";
import { getStorage } from "../../services/storage";
import { LocalStorage } from "../../services/storage/local";
import { recordAudit } from "../../services/audit";
import { AUDIT_ACTIONS } from "../../config/constants";
import {
  confirmPrivacy,
  getVariant,
  retryProcessing,
  reviewRegion,
  signedOriginalUrl,
  updateBlurRegions,
  uploadImage,
} from "./service";
import { enqueueRedetectBatch, privacyReviewStats } from "./redetect";

export const mediaRouter = Router();
export const moderationMediaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.IMAGE_MAX_SIZE_MB * 1024 * 1024, files: 6 },
});

const uuidParam = z.object({ assetUuid: z.string().uuid("资源标识不正确") });

/**
 * 批量上传：最多 6 张。
 * 逐张处理并返回各自状态，某一张失败不影响其他张——
 * 用户不必因为第 3 张格式不对而重传前两张。
 */
mediaRouter.post(
  "/uploads/images",
  requireAuth,
  requireActiveWriter,
  rateLimit({ scope: "upload", limit: 60, windowSeconds: 600 }),
  upload.array("files", 6),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw AppError.badRequest("请选择要上传的图片");

    const assets = [];
    const failures: Array<{ name: string; message: string }> = [];

    for (const file of files) {
      try {
        assets.push(
          await uploadImage(
            {
              buffer: file.buffer,
              mimetype: file.mimetype,
              originalname: file.originalname,
              size: file.size,
            },
            req.user!,
          ),
        );
      } catch (error) {
        failures.push({
          name: file.originalname,
          message: error instanceof AppError ? error.message : "上传失败",
        });
      }
    }

    if (assets.length === 0) {
      throw AppError.badRequest(failures[0]?.message ?? "图片上传失败", failures);
    }

    res.status(201).json(ok(req, { assets, failures }));
  }),
);

mediaRouter.get(
  "/media/:assetUuid/status",
  requireAuth,
  validate({ params: uuidParam }),
  asyncHandler(async (req, res) => {
    const asset = await prisma.mediaAsset.findUnique({
      where: { uuid: req.params.assetUuid },
      select: {
        uuid: true,
        privacyStatus: true,
        width: true,
        height: true,
        variantVersion: true,
        ownerId: true,
        detectionMeta: true,
        blurRegions: {
          where: { ignored: false },
          select: { id: true, source: true, algorithm: true, x: true, y: true, w: true, h: true, strength: true, label: true, confidence: true, detector: true, reviewStatus: true, reviewedAt: true, ignored: true, ignoreReason: true },
        },
      },
    });

    if (!asset) throw AppError.notFound("图片不存在");

    const privileged = asset.ownerId === req.user!.id || req.user!.role !== "user";
    if (!privileged) throw AppError.forbidden("你没有权限查看该图片的处理状态");

    const version = asset.variantVersion;
    res.json(
      ok(req, {
        uuid: asset.uuid,
        privacyStatus: asset.privacyStatus,
        width: asset.width,
        height: asset.height,
        variantVersion: version,
        detectionMeta: asset.detectionMeta ?? {},
        regions: asset.blurRegions,
        variants: {
          thumb: `/api/v1/media/${asset.uuid}/thumb?v=${version}`,
          grid: `/api/v1/media/${asset.uuid}/grid?v=${version}`,
          full: `/api/v1/media/${asset.uuid}/full?v=${version}`,
        },
      }),
    );
  }),
);

/** 审核角色获取原图的短时效签名地址，访问行为会写入审计日志 */
mediaRouter.get(
  "/media/:assetUuid/original-url",
  requireAuth,
  requireRole("moderator"),
  validate({ params: uuidParam }),
  asyncHandler(async (req, res) => {
    const url = await signedOriginalUrl(req.params.assetUuid);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_ORIGINAL_VIEW,
      targetType: "media",
      reason: "审核需要查看原图",
      req,
    });
    res.json(ok(req, { url, expiresInSeconds: 300 }));
  }),
);

/**
 * 签名地址回源读取。
 * 只对本地存储驱动开放：S3 模式下返回的是对象存储自身的签名地址，无需经过本服务。
 */
mediaRouter.get(
  "/media/:assetUuid/original",
  requireAuth,
  requireRole("moderator"),
  asyncHandler(async (req, res) => {
    const storage = getStorage();
    if (!(storage instanceof LocalStorage)) {
      throw AppError.badRequest("当前存储驱动不支持该访问方式");
    }

    const key = String(req.query.key ?? "");
    const expires = Number(req.query.expires ?? 0);
    const signature = String(req.query.signature ?? "");

    if (!storage.verifyPrivateSignature(key, expires, signature)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "图片访问链接已失效，请重新获取");
    }

    const object = await storage.getPrivate(key);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    res.send(object);
  }),
);

/** 公开变体读取：缓存头按是否已通过隐私门禁区分 */
mediaRouter.get(
  "/media/:assetUuid/:variant",
  validate({ params: z.object({ assetUuid: z.string(), variant: z.string() }) }),
  asyncHandler(async (req, res) => {
    const result = await getVariant(req.params.assetUuid, req.params.variant, req.user);

    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
      "Cache-Control",
      result.publishable
        ? "public, max-age=31536000, immutable"
        : "private, no-store, must-revalidate",
    );
    res.send(result.body);
  }),
);

// ---------------------------------------------------------------- 审核侧

const blurRegionSchema = z.object({
  regions: z
    .array(
      z.object({
        id: z.union([z.number().int(), z.string()]).optional(),
        source: z.enum(["auto", "manual"]),
        algorithm: z.enum(["pixelate", "gaussian"]).optional(),
        strength: z.number().int().min(4).max(60).optional(),
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
        w: z.number().min(0).max(1).optional(),
        h: z.number().min(0).max(1).optional(),
        label: z.string().max(32).optional(),
        ignored: z.boolean().optional(),
        ignoreReason: z.string().max(200).optional(),
      }),
    )
    .max(50),
  reason: z.string().max(200).optional(),
});

moderationMediaRouter.put(
  "/media/:assetUuid/blur-regions",
  requireAuth,
  requireRole("moderator"),
  validate({ params: uuidParam, body: blurRegionSchema }),
  asyncHandler(async (req, res) => {
    const result = await updateBlurRegions(
      req.params.assetUuid,
      req.body.regions,
      req.body.reason,
      req.user!.id,
    );

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_BLUR_UPDATE,
      targetType: "media",
      reason: req.body.reason,
      after: { regions: req.body.regions.length },
      req,
    });

    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { uuid: req.params.assetUuid },
      select: { uuid: true, variantVersion: true },
    });

    res.json(
      ok(req, {
        privacyStatus: result.privacyStatus,
        regionsApplied: result.regionsApplied,
        variants: {
          thumb: `/api/v1/media/${asset.uuid}/thumb?v=${asset.variantVersion}`,
          grid: `/api/v1/media/${asset.uuid}/grid?v=${asset.variantVersion}`,
          full: `/api/v1/media/${asset.uuid}/full?v=${asset.variantVersion}`,
        },
      }),
    );
  }),
);

moderationMediaRouter.post(
  "/media/:assetUuid/confirm-privacy",
  requireAuth,
  requireRole("moderator"),
  validate({ params: uuidParam }),
  asyncHandler(async (req, res) => {
    const status = await confirmPrivacy(req.params.assetUuid, req.user!.id);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_PRIVACY_CONFIRM,
      targetType: "media",
      after: { privacyStatus: status },
      req,
    });
    res.json(ok(req, { privacyStatus: status }));
  }),
);

moderationMediaRouter.post(
  "/media/:assetUuid/retry",
  requireAuth,
  requireRole("moderator"),
  validate({ params: uuidParam }),
  asyncHandler(async (req, res) => {
    const outcome = await retryProcessing(req.params.assetUuid);
    res.json(ok(req, outcome));
  }),
);

// ── 置信度分级后的人工复核：队列、单框裁定、批量重跑 ──────────────────────────

const PRIVACY_STATUSES = [
  "processing",
  "auto_clean",
  "auto_confirmed",
  "auto_blurred",
  "needs_manual",
  "manual_blurred",
  "confirmed",
  "failed",
] as const;

/**
 * 隐私复核队列。
 * 默认只返回**需要人工**的图片（待人工兜底 + 有中置信度疑难框），
 * 高置信度自动放行的图片不出现在这里——这是"只让人工复核疑难区域"的接口落点。
 */
moderationMediaRouter.get(
  "/privacy/review-queue",
  requireAuth,
  requireRole("moderator"),
  validate({
    query: z.object({
      status: z.enum(PRIVACY_STATUSES).optional(),
      // ambiguous=只有疑难框待裁定的图；manual=检测器不可用需整图人工；all=含已完成
      scope: z.enum(["ambiguous", "manual", "all"]).default("ambiguous"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      status?: string;
      scope: "ambiguous" | "manual" | "all";
      page: number;
      pageSize: number;
    };

    const where: Record<string, unknown> = {};
    if (query.status) {
      where.privacyStatus = query.status;
    } else if (query.scope === "ambiguous") {
      where.privacyStatus = { in: ["auto_blurred", "needs_manual", "failed", "processing"] };
    } else if (query.scope === "manual") {
      where.privacyStatus = { in: ["needs_manual", "failed", "processing"] };
    }

    const [items, total, stats] = await Promise.all([
      prisma.mediaAsset.findMany({
        where,
        orderBy: [{ privacyStatus: "asc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          uuid: true,
          privacyStatus: true,
          width: true,
          height: true,
          variantVersion: true,
          detectionMeta: true,
          originalPath: true,
          createdAt: true,
          owner: { select: { uuid: true, nickname: true } },
          blurRegions: {
            orderBy: [{ source: "desc" }, { reviewStatus: "asc" }, { id: "asc" }],
            select: {
              id: true, x: true, y: true, w: true, h: true, label: true, confidence: true,
              detector: true, source: true, reviewStatus: true, ignored: true, ignoreReason: true,
            },
          },
        },
      }),
      prisma.mediaAsset.count({ where }),
      privacyReviewStats(),
    ]);

    res.json(
      ok(req, {
        stats,
        items: items.map((asset) => ({
          uuid: asset.uuid,
          privacyStatus: asset.privacyStatus,
          width: asset.width,
          height: asset.height,
          variantVersion: asset.variantVersion,
          originalPurged: asset.originalPath === null,
          createdAt: asset.createdAt,
          owner: asset.owner,
          detectionMeta: asset.detectionMeta ?? {},
          regions: asset.blurRegions,
          variants: {
            thumb: `/api/v1/media/${asset.uuid}/thumb?v=${asset.variantVersion}`,
            grid: `/api/v1/media/${asset.uuid}/grid?v=${asset.variantVersion}`,
            full: `/api/v1/media/${asset.uuid}/full?v=${asset.variantVersion}`,
          },
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }),
    );
  }),
);

/** 对单条疑难检测框下人工结论：采纳（保留打码）或驳回（确认无需打码+理由） */
moderationMediaRouter.post(
  "/media/:assetUuid/regions/:regionId/review",
  requireAuth,
  requireRole("moderator"),
  validate({
    params: z.object({
      assetUuid: z.string().uuid("资源标识不正确"),
      regionId: z.coerce.number().int().positive(),
    }),
    body: z.object({
      accept: z.boolean(),
      reason: z.string().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await reviewRegion(
      req.params.assetUuid,
      BigInt(req.params.regionId),
      { accept: req.body.accept, reason: req.body.reason },
      req.user!.id,
    );

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_PRIVACY_REVIEW,
      targetType: "media",
      targetId: BigInt(req.params.regionId),
      reason: req.body.reason,
      after: { accept: req.body.accept, privacyStatus: result.privacyStatus, remaining: result.remaining },
      req,
    });

    res.json(ok(req, result));
  }),
);

const redetectBodySchema = z.object({
  assetUuids: z.array(z.string().uuid()).max(2000).optional(),
  statuses: z.array(z.enum(PRIVACY_STATUSES)).max(20).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

/**
 * 批量重跑存量图片的隐私检测（安装/升级适配器后补检历史图片用）。
 * 仅管理员可触发，参数与结果写入审计日志。
 */
moderationMediaRouter.post(
  "/privacy/redetect",
  requireAuth,
  requireRole("admin"),
  validate({ body: redetectBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof redetectBodySchema>;
    const result = await enqueueRedetectBatch({
      assetUuids: body.assetUuids,
      statuses: body.statuses as never,
      since: body.since ? new Date(body.since) : undefined,
      limit: body.limit,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_REDETECT_BATCH,
      targetType: "media",
      after: toJsonResult(result),
      req,
    });

    res.status(202).json(ok(req, result));
  }),
);

function toJsonResult(result: unknown) {
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}
