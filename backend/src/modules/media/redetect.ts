import { prisma } from "../../db/prisma";
import { enqueueImageJob } from "../../services/queue";
import { processAsset } from "./service";
import { logger } from "../../utils/logger";
import type { PrivacyStatus } from "@prisma/client";

/**
 * 存量图片批量重跑隐私检测。
 *
 * 典型场景：新装/升级了检测适配器（ENABLE_FACE_DETECTION 刚打开、接入新的
 * HTTP 检测服务），需要让历史图片也享受新能力。任务投递到既有图片队列，
 * 由 worker 按并发上限消费；队列不可用时退化为就地串行处理。
 *
 * 安全边界：
 * - 没有原图的图片无法重跑（原图按保留期删除是数据最小化承诺），跳过；
 * - processing / failed 之外的图片都会被重检，**人工已经裁定的模糊框受保护**
 *   （见 processAsset 的 redetect 分支）；
 * - 重检可能把已发布图片降级（新检测器发现了旧检测器漏掉的人脸）——
 *   这是隐私优先的有意设计，门禁状态收紧永远自动生效。
 */
export interface RedetectFilter {
  /** 只重跑这些隐私状态；默认全部可重检状态 */
  statuses?: PrivacyStatus[];
  /** 只重跑指定图片 */
  assetUuids?: string[];
  /** 只重跑该时间之后上传的 */
  since?: Date;
  /** 单次最多投递数量，防止一把梭把队列/外部检测配额打满 */
  limit?: number;
}

export interface RedetectBatchResult {
  selected: number;
  enqueued: number;
  processedInline: number;
  skippedNoOriginal: number;
  /** 队列不可用而就地处理时，逐张的结果 */
  outcomes: Array<{ uuid: string; privacyStatus: string; error?: string }>;
}

const DEFAULT_LIMIT = 500;

export async function enqueueRedetectBatch(filter: RedetectFilter = {}): Promise<RedetectBatchResult> {
  const where = {
    ...(filter.statuses ? { privacyStatus: { in: filter.statuses } } : {}),
    ...(filter.assetUuids ? { uuid: { in: filter.assetUuids } } : {}),
    ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
  };

  const [assets, skippedNoOriginal] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: { ...where, originalPath: { not: null } },
      select: { uuid: true },
      orderBy: { id: "asc" },
      take: Math.min(filter.limit ?? DEFAULT_LIMIT, 2000),
    }),
    prisma.mediaAsset.count({ where: { ...where, originalPath: null } }),
  ]);

  const result: RedetectBatchResult = {
    selected: assets.length,
    enqueued: 0,
    processedInline: 0,
    skippedNoOriginal,
    outcomes: [],
  };

  for (const asset of assets) {
    const queued = await enqueueImageJob({ assetUuid: asset.uuid, reason: "redetect" });
    if (queued) {
      result.enqueued += 1;
      continue;
    }

    // 队列不可用：串行就地处理，保持与上传路径相同的降级语义
    try {
      const outcome = await processAsset(asset.uuid, "redetect");
      result.processedInline += 1;
      result.outcomes.push({ uuid: asset.uuid, privacyStatus: outcome.privacyStatus });
    } catch (error) {
      logger.error({ err: (error as Error).message, uuid: asset.uuid }, "批量重跑检测失败");
      result.outcomes.push({ uuid: asset.uuid, privacyStatus: "failed", error: (error as Error).message });
    }
  }

  logger.info(result, "存量图片隐私检测批量重跑已派发");
  return result;
}

/** 复核队列统计：按隐私状态与疑难框数量聚合，管理台/复核台共用 */
export async function privacyReviewStats(): Promise<{
  needsManual: number;
  ambiguousRegions: number;
  awaitingAssets: number;
  failed: number;
}> {
  const [needsManual, failed, ambiguousAgg, awaitingAssets] = await Promise.all([
    prisma.mediaAsset.count({ where: { privacyStatus: "needs_manual" } }),
    prisma.mediaAsset.count({ where: { privacyStatus: "failed" } }),
    prisma.blurRegion.groupBy({
      by: ["reviewStatus"],
      where: { reviewStatus: "pending", ignored: false },
      _count: { _all: true },
    }),
    prisma.mediaAsset.count({
      where: { privacyStatus: { in: ["needs_manual", "auto_blurred", "failed", "processing"] } },
    }),
  ]);

  return {
    needsManual,
    failed,
    ambiguousRegions: ambiguousAgg.reduce((sum, row) => sum + row._count._all, 0),
    awaitingAssets,
  };
}
