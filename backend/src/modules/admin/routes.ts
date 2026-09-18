import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { prisma, toJsonValue } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { AUDIT_ACTIONS } from "../../config/constants";
import { recordAudit } from "../../services/audit";
import { notify } from "../../services/notify";
import { moderationStats } from "../reviews/decisions";
import { rerunDetectionBatch, RERUN_BATCH_LIMIT } from "../media/service";
import { listDetectors } from "../../services/detection";

export const adminRouter = Router();

adminRouter.use("/admin", requireAuth, requireRole("admin"));

adminRouter.get(
  "/admin/dashboard",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 86400000);

    const [
      users,
      publishedSpots,
      spotsToday,
      comments,
      pendingModeration,
      reports,
      privacyQueue,
      byCategory,
      staleSpots,
      recentAudits,
    ] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.spot.count({ where: { status: "published", deletedAt: null } }),
      prisma.spot.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.comment.count({ where: { status: "visible" } }),
      prisma.reviewTask.count({ where: { status: { in: ["pending", "in_review"] } } }),
      prisma.report.count({ where: { status: { in: ["open", "in_review"] } } }),
      prisma.mediaAsset.count({ where: { privacyStatus: { in: ["needs_manual", "failed"] } } }),
      prisma.spot.groupBy({
        by: ["categoryId"],
        where: { status: "published" },
        _count: { _all: true },
      }),
      prisma.spot.count({ where: { status: "published", isStale: true } }),
      prisma.auditLog.findMany({
        where: { createdAt: { gte: weekAgo } },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { actor: { select: { nickname: true } } },
      }),
    ]);

    const categories = await prisma.category.findMany({ select: { id: true, name: true, code: true } });
    const nameById = new Map(categories.map((item) => [item.id.toString(), item]));

    const stats = await moderationStats();

    res.json(
      ok(req, {
        users: Object.fromEntries(users.map((row) => [row.role, row._count._all])),
        spots: { published: publishedSpots, today: spotsToday, stale: staleSpots },
        comments,
        moderation: {
          awaitingDecision: pendingModeration,
          pending: stats.queue.pending,
          inReview: stats.queue.inReview,
          overdue: stats.queue.overdue,
        },
        reports: { open: reports },
        privacy: { pending: privacyQueue },
        review: stats.today,
        appeals: stats.appeals,
        averageReviewHours: stats.averageReviewHours,
        workload: stats.workload,
        byCategory: byCategory.map((row) => ({
          code: nameById.get(row.categoryId.toString())?.code ?? "unknown",
          name: nameById.get(row.categoryId.toString())?.name ?? "未知",
          count: row._count._all,
        })),
        recentAudits: recentAudits.map((log) => ({
          action: log.action,
          targetType: log.targetType,
          targetId: log.targetId,
          actor: log.actor?.nickname ?? "系统",
          reason: log.reason,
          createdAt: log.createdAt,
        })),
      }),
    );
  }),
);

adminRouter.get(
  "/admin/users",
  validate({
    query: z.object({
      q: z.string().max(40).optional(),
      role: z.enum(["visitor", "user", "moderator", "admin"]).optional(),
      status: z.enum(["active", "muted", "banned", "deleted"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      q?: string;
      role?: string;
      status?: string;
      page: number;
      pageSize: number;
    };

    const where = {
      ...(query.q
        ? {
            OR: [
              { nickname: { contains: query.q, mode: "insensitive" as const } },
              { email: { contains: query.q, mode: "insensitive" as const } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
      ...(query.role ? { role: query.role as never } : {}),
      ...(query.status ? { status: query.status as never } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          uuid: true,
          nickname: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          creditScore: true,
          approvedCount: true,
          mutedUntil: true,
          banReason: true,
          createdAt: true,
          deletedAt: true,
          _count: { select: { spots: true, comments: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(
      ok(req, {
        items: items.map((user) => ({
          uuid: user.uuid,
          nickname: user.nickname,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status,
          creditScore: user.creditScore,
          approvedCount: user.approvedCount,
          mutedUntil: user.mutedUntil,
          banReason: user.banReason,
          createdAt: user.createdAt,
          deleted: user.deletedAt !== null,
          counts: { spots: user._count.spots, comments: user._count.comments },
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }),
    );
  }),
);

async function findUserByUuid(uuid: string) {
  const user = await prisma.user.findUnique({
    where: { uuid },
    select: { id: true, uuid: true, nickname: true, role: true, status: true },
  });
  if (!user) throw AppError.notFound("用户不存在");
  return user;
}

adminRouter.patch(
  "/admin/users/:uuid/role",
  validate({
    params: z.object({ uuid: z.string().uuid() }),
    body: z.object({ role: z.enum(["user", "moderator", "admin"]) }),
  }),
  asyncHandler(async (req, res) => {
    const user = await findUserByUuid(req.params.uuid);
    if (user.id === req.user!.id) throw AppError.badRequest("不能修改自己的角色");

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: req.body.role },
      select: { uuid: true, role: true },
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.USER_ROLE,
      targetType: "user",
      targetId: user.id,
      before: { role: user.role },
      after: { role: updated.role },
      req,
    });

    res.json(ok(req, { user: updated }));
  }),
);

adminRouter.post(
  "/admin/users/:uuid/mute",
  validate({
    params: z.object({ uuid: z.string().uuid() }),
    body: z.object({
      hours: z.number().int().min(1).max(720),
      reason: z.string().trim().min(2).max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const user = await findUserByUuid(req.params.uuid);
    const mutedUntil = new Date(Date.now() + req.body.hours * 3600000);

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "muted", mutedUntil },
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.USER_MUTE,
      targetType: "user",
      targetId: user.id,
      reason: req.body.reason,
      after: { mutedUntil: mutedUntil.toISOString() },
      req,
    });

    await notify({
      userId: user.id,
      type: "comment_hidden",
      title: "你已被限制发言",
      body: `${req.body.reason}（解禁时间：${mutedUntil.toLocaleString("zh-CN")}）`,
      payload: {},
    });

    res.json(ok(req, { uuid: user.uuid, status: "muted", mutedUntil }));
  }),
);

adminRouter.post(
  "/admin/users/:uuid/ban",
  validate({
    params: z.object({ uuid: z.string().uuid() }),
    body: z.object({ reason: z.string().trim().min(2).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const user = await findUserByUuid(req.params.uuid);
    if (user.id === req.user!.id) throw AppError.badRequest("不能封禁自己");

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { status: "banned", banReason: req.body.reason },
      }),
      // 封禁后立即踢下线，不等 access token 自然过期
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "banned" },
      }),
    ]);

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.USER_BAN,
      targetType: "user",
      targetId: user.id,
      reason: req.body.reason,
      req,
    });

    res.json(ok(req, { uuid: user.uuid, status: "banned" }));
  }),
);

adminRouter.post(
  "/admin/users/:uuid/unban",
  validate({
    params: z.object({ uuid: z.string().uuid() }),
    body: z.object({ reason: z.string().trim().min(2).max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const user = await findUserByUuid(req.params.uuid);

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "active", banReason: null, mutedUntil: null },
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.USER_UNBAN,
      targetType: "user",
      targetId: user.id,
      reason: req.body.reason,
      req,
    });

    res.json(ok(req, { uuid: user.uuid, status: "active" }));
  }),
);

adminRouter.get(
  "/admin/audit-logs",
  validate({
    query: z.object({
      action: z.string().max(48).optional(),
      targetType: z.string().max(24).optional(),
      actorUuid: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      action?: string;
      targetType?: string;
      actorUuid?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    };

    let actorId: bigint | undefined;
    if (query.actorUuid) {
      const actor = await prisma.user.findUnique({
        where: { uuid: query.actorUuid },
        select: { id: true },
      });
      actorId = actor?.id;
      if (!actorId) throw AppError.notFound("操作人不存在");
    }

    const where = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(actorId ? { actorId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { uuid: true, nickname: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json(
      ok(req, {
        items: items.map((log) => ({
          id: log.id,
          action: log.action,
          targetType: log.targetType,
          targetId: log.targetId,
          before: log.before,
          after: log.after,
          reason: log.reason,
          traceId: log.traceId,
          createdAt: log.createdAt,
          actor: log.actor
            ? { uuid: log.actor.uuid, nickname: log.actor.nickname, role: log.actor.role }
            : null,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }),
    );
  }),
);

adminRouter.get(
  "/admin/system/filter-stats",
  asyncHandler(async (req, res) => {
    const { filterStats } = await import("../../services/moderation/contentFilter");
    res.json(ok(req, toJsonValue({ ...filterStats })));
  }),
);

const PRIVACY_STATUSES = [
  "processing",
  "auto_clean",
  "auto_blurred",
  "auto_confirmed",
  "needs_manual",
  "manual_blurred",
  "confirmed",
  "failed",
] as const;

/**
 * 批量重跑存量图片的隐私检测。
 *
 * 典型场景：启用了新检测器、升级了模型或调整了置信度阈值后，
 * 让存量图片按新能力重新分级。任务逐张入队由 worker 异步执行；
 * 单次有上限，按返回值里的 remaining 循环调用即可跑完全量。
 */
adminRouter.post(
  "/admin/media/rerun-detection",
  validate({
    body: z.object({
      statuses: z.array(z.enum(PRIVACY_STATUSES)).max(PRIVACY_STATUSES.length).optional(),
      limit: z.coerce.number().int().min(1).max(RERUN_BATCH_LIMIT).default(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await rerunDetectionBatch({
      statuses: req.body.statuses,
      limit: req.body.limit,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.MEDIA_DETECTION_RERUN,
      targetType: "media",
      after: {
        statuses: req.body.statuses ?? "default",
        limit: req.body.limit,
        ...result,
      },
      req,
    });

    res.json(
      ok(req, {
        ...result,
        detectors: listDetectors().map((detector) => ({
          name: detector.name,
          enabled: detector.isEnabled(),
        })),
      }),
    );
  }),
);
