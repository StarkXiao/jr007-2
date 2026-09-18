/**
 * 批量重跑存量图片隐私检测（运维脚本）。
 *
 * 用法：
 *   npm run redetect -- --statuses needs_manual,auto_blurred --limit 500
 *   npm run redetect -- --uuids uuid1,uuid2
 *   npm run redetect -- --since 2026-01-01 --inline
 *
 * 默认把任务投到图片队列由 worker 消费；--inline 时本进程串行处理
 * （队列/Redis 不可用或只想临时补检时使用）。
 */
import { enqueueRedetectBatch } from "../modules/media/redetect";
import { processAsset } from "../modules/media/service";
import { prisma } from "../db/prisma";
import { initStorage } from "../services/storage";
import { disconnectPrisma } from "../db/prisma";
import { logger } from "../utils/logger";
import type { PrivacyStatus } from "@prisma/client";

interface CliArgs {
  statuses?: PrivacyStatus[];
  uuids?: string[];
  since?: Date;
  limit?: number;
  inline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { inline: false };

  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split("=", 2);
    const value = inlineValue ?? argv[i + 1];

    switch (flag) {
      case "--statuses":
        args.statuses = value.split(",").map((item) => item.trim()) as PrivacyStatus[];
        if (inlineValue === undefined) i += 1;
        break;
      case "--uuids":
        args.uuids = value.split(",").map((item) => item.trim());
        if (inlineValue === undefined) i += 1;
        break;
      case "--since":
        args.since = new Date(value);
        if (Number.isNaN(args.since.getTime())) throw new Error("--since 需要合法日期");
        if (inlineValue === undefined) i += 1;
        break;
      case "--limit":
        args.limit = Number(value);
        if (inlineValue === undefined) i += 1;
        break;
      case "--inline":
        args.inline = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initStorage();

  if (args.inline) {
    // inline 模式绕过队列，直接逐张 processAsset
    const assets = await prisma.mediaAsset.findMany({
      where: {
        originalPath: { not: null },
        ...(args.statuses ? { privacyStatus: { in: args.statuses } } : {}),
        ...(args.uuids ? { uuid: { in: args.uuids } } : {}),
        ...(args.since ? { createdAt: { gte: args.since } } : {}),
      },
      select: { uuid: true },
      orderBy: { id: "asc" },
      take: args.limit ?? 500,
    });

    let okCount = 0;
    for (const [index, asset] of assets.entries()) {
      try {
        const outcome = await processAsset(asset.uuid, "redetect");
        okCount += 1;
        logger.info(
          { index: index + 1, total: assets.length, uuid: asset.uuid, status: outcome.privacyStatus, grades: outcome.grades },
          "重跑完成",
        );
      } catch (error) {
        logger.error({ uuid: asset.uuid, err: (error as Error).message }, "重跑失败");
      }
    }
    logger.info({ total: assets.length, ok: okCount, failed: assets.length - okCount }, "批量重跑（inline）结束");
  } else {
    const result = await enqueueRedetectBatch({
      statuses: args.statuses,
      assetUuids: args.uuids,
      since: args.since,
      limit: args.limit,
    });
    logger.info(result, "批量重跑任务已派发");
  }
}

main()
  .catch((error) => {
    logger.fatal({ err: (error as Error).message }, "批量重跑脚本失败");
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
