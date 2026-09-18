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
  signedOriginalUrl,
  updateBlurRegions,
  uploadImage,
} from "./service";

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
          select: { id: true, source: true, algorithm: true, x: true, y: true, w: true, h: true, strength: true, label: true, confidence: true, needsReview: true, ignored: true, ignoreReason: true },
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

/**
 * 疑难区域复核队列。
 *
 * 只列需要人工介入的图片（needs_manual）：可能是检测器不可用，
 * 也可能是存在中置信度的疑难区域。审核员只需处理这些图片，
 * 高置信度自动打码的图片（auto_confirmed）已由系统直接放行。
 */
moderationMediaRouter.get(
  "/media/review-queue",
  requireAuth,
  requireRole("moderator"),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { page: number; pageSize: number };

    const where = { privacyStatus: "needs_manual" as const };
    const [items, total] = await Promise.all([
      prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          uuid: true,
          privacyStatus: true,
          width: true,
          height: true,
          variantVersion: true,
          createdAt: true,
          detectionMeta: true,
          owner: { select: { nickname: true } },
          blurRegions: {
            where: { ignored: false },
            select: {
              id: true,
              source: true,
              x: true,
              y: true,
              w: true,
              h: true,
              label: true,
              confidence: true,
              needsReview: true,
            },
          },
        },
      }),
      prisma.mediaAsset.count({ where }),
    ]);

    res.json(
      ok(req, {
        items: items.map((asset) => {
          const reviewRegions = asset.blurRegions.filter((region) => region.needsReview);
          return {
            uuid: asset.uuid,
            privacyStatus: asset.privacyStatus,
            width: asset.width,
            height: asset.height,
            createdAt: asset.createdAt,
            owner: asset.owner.nickname,
            detectionMeta: asset.detectionMeta ?? {},
            // 审核员只需要看疑难区域；高置信度区域已自动打码，列个数量即可
            reviewRegions,
            autoRegionCount: asset.blurRegions.length - reviewRegions.length,
            variants: {
              grid: `/api/v1/media/${asset.uuid}/grid?v=${asset.variantVersion}`,
              full: `/api/v1/media/${asset.uuid}/full?v=${asset.variantVersion}`,
            },
          };
        }),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }),
    );
  }),
);

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
