import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES, QUEUE_PREFIX, WORKER_HEARTBEAT_KEY } from "./config/constants";
import { createBullConnection } from "./db/redis";
import {
  getImageQueue,
  getSweepQueue,
  type ImageJobData,
  type SweepJobData,
} from "./services/queue";
import { processAsset } from "./modules/media/service";
import { cleanup, purgeOriginalImages, slaSweep, staleSweep } from "./jobs";
import { initStorage } from "./services/storage";
import { disconnectPrisma } from "./db/prisma";
import { closeRedis, redis } from "./db/redis";
import { logger } from "./utils/logger";

// 定时任务调度配置。
// 使用 BullMQ 的 Job Scheduler（每次启动时 upsert），
// 因此重启 worker 不会产生重复的调度项。
const SCHEDULES: Array<{ task: SweepJobData["task"]; pattern: string; label: string }> = [
  { task: "sla-sweep", pattern: "*/15 * * * *", label: "每 15 分钟：SLA 超时巡检" },
  { task: "stale-sweep", pattern: "20 3 * * *", label: "每天 03:20：新鲜度巡检" },
  { task: "purge-originals", pattern: "40 3 * * *", label: "每天 03:40：清理超期原图" },
  { task: "cleanup", pattern: "0 4 * * *", label: "每天 04:00：清理过期令牌与通知" },
];

async function runSweep(task: SweepJobData["task"]) {
  switch (task) {
    case "sla-sweep":
      return slaSweep();
    case "stale-sweep":
      return staleSweep();
    case "purge-originals":
      return purgeOriginalImages();
    case "cleanup":
      return cleanup();
    default:
      throw new Error(`未知的定时任务：${task}`);
  }
}

async function bootstrap(): Promise<void> {
  await initStorage();

  const imageWorker = new Worker<ImageJobData>(
    QUEUE_NAMES.IMAGE,
    async (job: Job<ImageJobData>) => {
      const outcome = await processAsset(job.data.assetUuid, job.data.reason);
      logger.info(
        {
          assetUuid: job.data.assetUuid,
          status: outcome.privacyStatus,
          autoDetected: outcome.autoDetected,
          needsReview: outcome.needsReview,
        },
        "图片处理完成",
      );
      return outcome;
    },
    { connection: createBullConnection(), concurrency: 3, prefix: QUEUE_PREFIX },
  );

  imageWorker.on("failed", (job, error) => {
    logger.error(
      { assetUuid: job?.data.assetUuid, attempts: job?.attemptsMade, err: error.message },
      "图片处理失败",
    );
  });

  const sweepWorker = new Worker<SweepJobData>(
    QUEUE_NAMES.SLA,
    async (job: Job<SweepJobData>) => {
      const result = await runSweep(job.data.task);
      logger.info({ task: job.data.task, result }, "定时任务执行完成");
      return result;
    },
    { connection: createBullConnection(), concurrency: 1, prefix: QUEUE_PREFIX },
  );

  sweepWorker.on("failed", (job, error) => {
    logger.error({ task: job?.data.task, err: error.message }, "定时任务执行失败");
  });

  const queue = getSweepQueue();
  for (const schedule of SCHEDULES) {
    await queue.upsertJobScheduler(
      schedule.task,
      { pattern: schedule.pattern },
      {
        name: schedule.task,
        data: { task: schedule.task },
        opts: { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
      },
    );
    logger.info({ pattern: schedule.pattern }, `已注册定时任务：${schedule.label}`);
  }

  logger.info("worker 已启动：图片处理队列 + 定时任务调度");

  // 心跳：容器健康检查与运维监控都靠它判断 worker 是否真的在干活
  const writeHeartbeat = () =>
    redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 60).catch((error) => {
      logger.warn({ err: (error as Error).message }, "worker 心跳写入失败");
    });

  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => void writeHeartbeat(), 20000);
  heartbeatTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker 收到退出信号，等待当前任务结束");
    clearInterval(heartbeatTimer);
    const timer = setTimeout(() => process.exit(1), 30000);
    timer.unref();

    await imageWorker.close();
    await sweepWorker.close();
    await getImageQueue().close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await closeRedis();
    await disconnectPrisma();
    clearTimeout(timer);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error) => {
  logger.fatal({ err: (error as Error).message }, "worker 启动失败");
  process.exit(1);
});
