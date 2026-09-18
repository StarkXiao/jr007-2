import type { ReviewStatus } from "@prisma/client";
import { AUDIT_ACTIONS, ERROR_CODES, PRIVACY_REVIEW_STATUSES, REVIEW_REASON_CODES, type ReviewReasonCode } from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { fuzzCoordinates, reverseGeocode } from "../../services/geo";
import { assertAttributesValid } from "../categories/schemaValidator";
import { requireCategoryByCode } from "../categories/service";
import { assertAllPublishable } from "../media/service";
import { notify } from "../../services/notify";
import { adjustCredit, CREDIT_DELTAS, incrementApprovedCount } from "../../services/moderation/credit";
import { recordAudit } from "../../services/audit";
import { logger } from "../../utils/logger";
import type { AuthUser } from "../../types/auth";

const DECIDABLE_STATUSES: ReviewStatus[] = ["pending", "in_review", "appealed"];
const APPEAL_WINDOW_MS = 7 * 86400000;

async function loadDecidableTask(taskId: bigint, moderator: AuthUser) {
  const task = await prisma.reviewTask.findUnique({
    where: { id: taskId },
    include: {
      spot: {
        include: {
          media: { select: { uuid: true, privacyStatus: true } },
          category: true,
        },
      },
      revision: true,
    },
  });

  if (!task) throw AppError.notFound("审核任务不存在");
  if (!DECIDABLE_STATUSES.includes(task.status)) {
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_STATE_INVALID,
      `该任务已经处理过了（当前状态 ${task.status}）`,
    );
  }
  if (task.assignedTo !== moderator.id) {
    throw AppError.conflict(ERROR_CODES.REVIEW_ALREADY_CLAIMED, "请先领取该任务再做出决策");
  }
  // 自己审自己等于没有审核，这条规则不能开例外
  if (task.spot.ownerId === moderator.id) {
    throw AppError.forbidden("不能审核自己提交的条目，请交由其他审核员处理");
  }
  if (task.lockedUntil && task.lockedUntil.getTime() < Date.now()) {
    throw AppError.conflict(ERROR_CODES.REVIEW_LOCK_EXPIRED, "任务锁已过期，请重新领取");
  }

  return task;
}

function assertReasonCode(code: string): asserts code is ReviewReasonCode {
  if (!(code in REVIEW_REASON_CODES)) {
    throw AppError.badRequest(`审核原因码不合法：${code}`);
  }
}

async function resolvePublicPoint(spot: {
  uuid: string;
  exactLat: number;
  exactLng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  addressText: string | null;
}) {
  const point = spot.fuzzEnabled
    ? fuzzCoordinates({ lat: spot.exactLat, lng: spot.exactLng }, spot.fuzzRadiusM, spot.uuid)
    : { lat: spot.exactLat, lng: spot.exactLng };

  const addressText =
    spot.addressText ??
    (await reverseGeocode({ lat: spot.exactLat, lng: spot.exactLng }).then(
      (result) => result?.address ?? null,
    ));

  return { point, addressText };
}

// 通过审核并发布。
// 这里是隐私门禁的最后一道闸门：只要还有图片没通过隐私确认，
// 无论调用方怎样传参，服务端都会拒绝。
export async function approveTask(
  taskId: bigint,
  moderator: AuthUser,
  payload: { reason?: string; overridePrivacy?: boolean } = {},
) {
  if (payload.overridePrivacy) {
    throw AppError.forbidden("隐私门禁不允许被绕过");
  }

  const task = await loadDecidableTask(taskId, moderator);
  assertAllPublishable(task.spot.media);

  const category = await requireCategoryByCode(task.spot.category.code);
  assertAttributesValid(category.schema, (task.spot.attributes ?? {}) as Record<string, unknown>);

  const { point, addressText } = await resolvePublicPoint(task.spot);
  const now = new Date();
  const isAppeal = task.status === "appealed";

  await prisma.$transaction([
    prisma.spot.update({
      where: { id: task.spotId },
      data: {
        status: "published",
        publicLat: point.lat,
        publicLng: point.lng,
        addressText,
        currentRevisionId: task.revisionId,
        publishedAt: task.spot.publishedAt ?? now,
        archivedAt: null,
      },
    }),
    prisma.reviewTask.update({
      where: { id: task.id },
      data: {
        status: isAppeal ? "appeal_approved" : "approved",
        decidedBy: moderator.id,
        decidedAt: now,
        decisionReason: payload.reason ?? null,
        lockedUntil: null,
      },
    }),
  ]);

  await incrementApprovedCount(task.spot.ownerId);
  await adjustCredit(task.spot.ownerId, CREDIT_DELTAS.SPOT_APPROVED);

  await recordAudit({
    actorId: moderator.id,
    action: isAppeal ? AUDIT_ACTIONS.REVIEW_APPEAL_DECIDE : AUDIT_ACTIONS.REVIEW_APPROVE,
    targetType: "spot",
    targetId: task.spotId,
    after: { status: "published", revisionNo: task.revision.revisionNo },
    reason: payload.reason,
  });

  await notify({
    userId: task.spot.ownerId,
    type: "review_approved",
    title: "你的记录已通过审核",
    body: `已发布到地图：${task.spot.title}`,
    payload: { spotUuid: task.spot.uuid },
  });

  logger.info({ taskId: taskId.toString(), moderator: moderator.uuid }, "审核通过并发布");

  return { status: "published" as const, spotUuid: task.spot.uuid, publicLocation: point };
}

// 要求修改：把问题拆成逐条修改点，用户才知道该改什么
export async function requestChanges(
  taskId: bigint,
  moderator: AuthUser,
  payload: { reasonCode: string; reason?: string; points?: string[] },
) {
  assertReasonCode(payload.reasonCode);
  const task = await loadDecidableTask(taskId, moderator);

  const points = (payload.points ?? [])
    .map((point) => point.trim())
    .filter(Boolean)
    .slice(0, 10);
  const summary = payload.reason?.trim() || REVIEW_REASON_CODES[payload.reasonCode];
  const body = [summary, ...points.map((point) => `· ${point}`)].join("\n");

  await prisma.$transaction([
    prisma.spot.update({ where: { id: task.spotId }, data: { status: "changes_requested" } }),
    prisma.reviewTask.update({
      where: { id: task.id },
      data: {
        status: "changes_requested",
        decidedBy: moderator.id,
        decidedAt: new Date(),
        reasonCode: payload.reasonCode,
        decisionReason: body,
        lockedUntil: null,
      },
    }),
  ]);

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_REQUEST_CHANGES,
    targetType: "spot",
    targetId: task.spotId,
    reason: body,
    after: { reasonCode: payload.reasonCode, points },
  });

  await notify({
    userId: task.spot.ownerId,
    type: "review_changes",
    title: "这条记录需要修改后才能发布",
    body,
    payload: { spotUuid: task.spot.uuid, reasonCode: payload.reasonCode, points },
  });

  return { status: "changes_requested" as const, reasonCode: payload.reasonCode, points };
}

export async function rejectTask(
  taskId: bigint,
  moderator: AuthUser,
  payload: { reasonCode: string; reason?: string },
) {
  assertReasonCode(payload.reasonCode);
  const task = await loadDecidableTask(taskId, moderator);

  const decisionReason = payload.reason?.trim() || REVIEW_REASON_CODES[payload.reasonCode];
  const now = new Date();

  await prisma.$transaction([
    prisma.spot.update({ where: { id: task.spotId }, data: { status: "rejected" } }),
    prisma.reviewTask.update({
      where: { id: task.id },
      data: {
        status: "rejected",
        decidedBy: moderator.id,
        decidedAt: now,
        reasonCode: payload.reasonCode,
        decisionReason,
        appealDeadline: new Date(now.getTime() + APPEAL_WINDOW_MS),
        lockedUntil: null,
      },
    }),
  ]);

  await adjustCredit(task.spot.ownerId, CREDIT_DELTAS.SPOT_REJECTED);

  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_REJECT,
    targetType: "spot",
    targetId: task.spotId,
    reason: decisionReason,
    after: { reasonCode: payload.reasonCode },
  });

  await notify({
    userId: task.spot.ownerId,
    type: "review_rejected",
    title: "这条记录未通过审核",
    body: `${decisionReason}（依据：${REVIEW_REASON_CODES[payload.reasonCode]}）。你可以在 7 天内提出申诉。`,
    payload: {
      spotUuid: task.spot.uuid,
      reasonCode: payload.reasonCode,
      appealDeadline: now.getTime() + APPEAL_WINDOW_MS,
    },
  });

  return { status: "rejected" as const, reasonCode: payload.reasonCode, decisionReason };
}

// ------------------------------------------------------------------ 申诉终审

export async function listAppeals() {
  const items = await prisma.reviewTask.findMany({
    where: { status: "appealed" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: {
      spot: {
        select: {
          uuid: true,
          title: true,
          status: true,
          category: { select: { name: true, code: true } },
          owner: { select: { nickname: true, creditScore: true } },
        },
      },
      appealOf: { select: { id: true, reasonCode: true, decisionReason: true, decidedAt: true } },
    },
  });

  return items.map((task) => ({
    id: task.id,
    appealText: task.appealText,
    createdAt: task.createdAt,
    slaDueAt: task.slaDueAt,
    spot: task.spot,
    original: task.appealOf,
  }));
}

// 管理员终审：只允许改判通过或维持驳回，避免申诉链无限延长
export async function decideAppeal(
  taskId: bigint,
  admin: AuthUser,
  decision: "approve" | "uphold",
  reason: string,
) {
  const task = await prisma.reviewTask.findUnique({
    where: { id: taskId },
    include: {
      spot: {
        include: { media: { select: { uuid: true, privacyStatus: true } }, category: true },
      },
      revision: true,
      appealOf: true,
    },
  });

  if (!task) throw AppError.notFound("申诉不存在");
  if (task.status !== "appealed") {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "该申诉已处理过");
  }

  const now = new Date();

  if (decision === "uphold") {
    await prisma.$transaction([
      prisma.reviewTask.update({
        where: { id: task.id },
        data: {
          status: "appeal_rejected",
          decidedBy: admin.id,
          decidedAt: now,
          decisionReason: reason,
          lockedUntil: null,
        },
      }),
      prisma.spot.update({ where: { id: task.spotId }, data: { status: "rejected_final" } }),
    ]);

    await recordAudit({
      actorId: admin.id,
      action: AUDIT_ACTIONS.REVIEW_APPEAL_DECIDE,
      targetType: "spot",
      targetId: task.spotId,
      reason,
      after: { decision: "uphold" },
    });

    await notify({
      userId: task.spot.ownerId,
      type: "appeal_result",
      title: "申诉结果：维持原结论",
      body: reason,
      payload: { spotUuid: task.spot.uuid },
    });

    return { status: "rejected_final" as const, decision };
  }

  // 改判通过仍需通过隐私门禁——改判不能成为绕过隐私要求的后门
  assertAllPublishable(task.spot.media);

  const category = await requireCategoryByCode(task.spot.category.code);
  assertAttributesValid(category.schema, (task.spot.attributes ?? {}) as Record<string, unknown>);

  const { point, addressText } = await resolvePublicPoint(task.spot);

  await prisma.$transaction([
    prisma.reviewTask.update({
      where: { id: task.id },
      data: {
        status: "appeal_approved",
        decidedBy: admin.id,
        decidedAt: now,
        decisionReason: reason,
        lockedUntil: null,
      },
    }),
    prisma.spot.update({
      where: { id: task.spotId },
      data: {
        status: "published",
        publicLat: point.lat,
        publicLng: point.lng,
        addressText,
        publishedAt: task.spot.publishedAt ?? now,
        currentRevisionId: task.revisionId,
      },
    }),
  ]);

  await incrementApprovedCount(task.spot.ownerId);
  await adjustCredit(task.spot.ownerId, CREDIT_DELTAS.APPEAL_UPHELD);

  await recordAudit({
    actorId: admin.id,
    action: AUDIT_ACTIONS.REVIEW_APPEAL_DECIDE,
    targetType: "spot",
    targetId: task.spotId,
    reason,
    after: { decision: "approve" },
  });

  await notify({
    userId: task.spot.ownerId,
    type: "appeal_result",
    title: "申诉结果：已改判通过",
    body: `${reason}\n你的记录已发布到地图。`,
    payload: { spotUuid: task.spot.uuid },
  });

  return { status: "published" as const, decision };
}

// ------------------------------------------------------------------ 统计

export async function moderationStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getTime() - 30 * 86400000);

  const [
    pending,
    inReview,
    overdue,
    decidedToday,
    approvedToday,
    rejectedToday,
    appeals,
    openReports,
    privacyPending,
    decisions,
    workload,
  ] = await Promise.all([
    prisma.reviewTask.count({ where: { status: "pending" } }),
    prisma.reviewTask.count({ where: { status: "in_review" } }),
    prisma.reviewTask.count({ where: { decidedAt: null, slaDueAt: { lt: now } } }),
    prisma.reviewTask.count({ where: { decidedAt: { gte: todayStart } } }),
    prisma.reviewTask.count({
      where: { decidedAt: { gte: todayStart }, status: { in: ["approved", "appeal_approved"] } },
    }),
    prisma.reviewTask.count({ where: { decidedAt: { gte: todayStart }, status: "rejected" } }),
    prisma.reviewTask.count({ where: { status: "appealed" } }),
    prisma.report.count({ where: { status: { in: ["open", "in_review"] } } }),
    prisma.mediaAsset.count({
      where: { privacyStatus: { in: [...PRIVACY_REVIEW_STATUSES] } },
    }),
    prisma.reviewTask.findMany({
      where: { decidedAt: { not: null }, createdAt: { gte: monthStart } },
      select: { createdAt: true, decidedAt: true },
    }),
    prisma.reviewTask.groupBy({
      by: ["decidedBy"],
      where: { decidedAt: { gte: new Date(now.getTime() - 7 * 86400000) }, decidedBy: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const durations = decisions
    .map((item) => (item.decidedAt ? item.decidedAt.getTime() - item.createdAt.getTime() : 0))
    .filter((value) => value > 0);

  const averageHours =
    durations.length > 0
      ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length / 3600000).toFixed(1))
      : 0;

  const moderators = await prisma.user.findMany({
    where: { id: { in: workload.map((row) => row.decidedBy!).filter(Boolean) } },
    select: { id: true, nickname: true },
  });
  const nameById = new Map(moderators.map((item) => [item.id.toString(), item.nickname]));

  return {
    queue: { pending, inReview, overdue },
    today: { decided: decidedToday, approved: approvedToday, rejected: rejectedToday },
    appeals,
    reports: { open: openReports },
    privacy: { pending: privacyPending },
    averageReviewHours: averageHours,
    workload: workload
      .map((row) => ({
        moderator: nameById.get(row.decidedBy!.toString()) ?? "未知",
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
