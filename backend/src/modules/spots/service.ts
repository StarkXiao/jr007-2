import type { Prisma, SpotStatus } from "@prisma/client";
import { env } from "../../config/env";
import {
  CONFIRMATION_COOLDOWN_MS,
  ERROR_CODES,
  STALE_REPORT_THRESHOLD,
  MAX_BBOX_SPAN_DEG,
  PUBLISHABLE_PRIVACY_STATUSES,
} from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { parsePagination, pagedResult } from "../../utils/pagination";
import { assertNoBlockedContent, assertNoPii, checkText } from "../../services/moderation/contentFilter";
import { computeFreshness } from "../../services/moderation/credit";
import { boundingBox, fuzzCoordinates, haversineMeters, isValidLatLng, reverseGeocode } from "../../services/geo";
import { assertAttributesValid, validateAttributes } from "../categories/schemaValidator";
import { requireCategoryByCode } from "../categories/service";
import { serializeSpot } from "../shared/serialize";
import type { AuthUser } from "../../types/auth";
import { isModerator } from "../../types/auth";
import { notify } from "../../services/notify";
import { adjustCredit, CREDIT_DELTAS } from "../../services/moderation/credit";
import { logger } from "../../utils/logger";
import type { CreateSpotInput, ListSpotsQuery, UpdateSpotInput } from "./schemas";

const MS_PER_DAY = 86400000;

// ------------------------------------------------------------------ 工具

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  if (value.length === 1) set.add(value);
  return set;
}

/** Dice 系数，用于重复条目检测（0–1，越大越相似） */
export function textSimilarity(a: string, b: string): number {
  const left = bigrams(normalizeText(a));
  const right = bigrams(normalizeText(b));
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const gram of left) if (right.has(gram)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function parseAttributeFilters(raw: string[]): Array<{ key: string; value: unknown }> {
  return raw
    .flatMap((item) => item.split("&"))
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf(":");
      if (index <= 0) throw AppError.badRequest(`属性筛选格式应为 key:value，收到：${item}`);
      const key = item.slice(0, index).trim();
      const rawValue = item.slice(index + 1).trim();

      let value: unknown = rawValue;
      if (rawValue === "true") value = true;
      else if (rawValue === "false") value = false;
      else if (rawValue !== "" && !Number.isNaN(Number(rawValue))) value = Number(rawValue);

      return { key, value };
    });
}

function parseBbox(raw: string | undefined) {
  if (!raw) return undefined;
  const parts = raw.split(",").map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw AppError.badRequest("bbox 格式应为 minLng,minLat,maxLng,maxLat");
  }
  const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
  if (!isValidLatLng(minLat, minLng) || !isValidLatLng(maxLat, maxLng)) {
    throw AppError.badRequest("bbox 坐标超出合法范围");
  }
  if (Math.abs(maxLng - minLng) > MAX_BBOX_SPAN_DEG || Math.abs(maxLat - minLat) > MAX_BBOX_SPAN_DEG) {
    throw AppError.badRequest("地图范围过大，请放大后再筛选");
  }
  return { minLng, minLat, maxLng, maxLat };
}

function parseNear(raw: string | undefined) {
  if (!raw) return undefined;
  const parts = raw.split(",").map((value) => Number(value.trim()));
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    throw AppError.badRequest("near 格式应为 lat,lng");
  }
  const [lat, lng] = parts as [number, number];
  if (!isValidLatLng(lat, lng)) throw AppError.badRequest("定位坐标超出合法范围");
  return { lat, lng };
}

// ------------------------------------------------------------------ 读取

const baseInclude = {
  category: true,
  owner: { select: { uuid: true, nickname: true } },
  _count: { select: { favorites: true, comments: { where: { status: "visible" as const } } } },
} satisfies Prisma.SpotInclude;

type SpotPayload = Prisma.SpotGetPayload<{ include: typeof baseInclude }>;

function toSpotLike(spot: SpotPayload, lastConfirmedAt: Date | null) {
  return {
    ...spot,
    lastConfirmedAt,
    counts: { comments: spot._count.comments, favorites: spot._count.favorites },
  };
}

async function lastConfirmedMap(spotIds: bigint[]): Promise<Map<string, Date>> {
  if (spotIds.length === 0) return new Map();

  const rows = await prisma.spotConfirmation.groupBy({
    by: ["spotId"],
    where: { spotId: { in: spotIds }, isAccurate: true },
    _max: { createdAt: true },
  });

  return new Map(
    rows
      .filter((row) => row._max.createdAt)
      .map((row) => [row.spotId.toString(), row._max.createdAt as Date]),
  );
}

export async function listSpots(query: ListSpotsQuery, viewer?: AuthUser) {
  const pagination = parsePagination(query);
  const where: Prisma.SpotWhereInput = { status: "published", deletedAt: null };

  const bbox = parseBbox(query.bbox);
  const near = parseNear(query.near);
  const radius = query.radius ?? 1000;

  if (near) {
    const box = boundingBox(near, radius * 1.5);
    where.publicLat = { gte: box.minLat, lte: box.maxLat };
    where.publicLng = { gte: box.minLng, lte: box.maxLng };
  } else if (bbox) {
    where.publicLat = { gte: bbox.minLat, lte: bbox.maxLat };
    where.publicLng = { gte: bbox.minLng, lte: bbox.maxLng };
  }

  const categories = query.category
    ? (Array.isArray(query.category) ? query.category : [query.category])
    : [];
  if (categories.length > 0) {
    where.category = { code: { in: categories } };
  }

  if (query.q) {
    where.OR = [
      { title: { contains: query.q, mode: "insensitive" } },
      { description: { contains: query.q, mode: "insensitive" } },
      { addressText: { contains: query.q, mode: "insensitive" } },
    ];
  }

  if (query.fresh) {
    where.isStale = false;
    where.confirmations = { some: { isAccurate: true, createdAt: { gte: new Date(Date.now() - 90 * MS_PER_DAY) } } };
  }

  const attributes = query.attr
    ? parseAttributeFilters(Array.isArray(query.attr) ? query.attr : [query.attr])
    : [];

  // Prisma 的 JSON 过滤器类型是一个联合体，动态 path/equals 无法被 TS 收窄，
  // 这里显式收敛到 SpotWhereInput；运行时行为由 Prisma 自己校验。
  const andFilters = attributes.map(
    (filter) =>
      ({
        attributes: { path: [filter.key], equals: filter.value },
      }) as unknown as Prisma.SpotWhereInput,
  );
  if (andFilters.length > 0) {
    where.AND = andFilters;
  }

  const orderBy: Prisma.SpotOrderByWithRelationInput[] =
    query.sort === "newest"
      ? [{ publishedAt: "desc" }]
      : [{ freshnessScore: "desc" }, { publishedAt: "desc" }];

  const [items, total] = await Promise.all([
    prisma.spot.findMany({
      where,
      include: baseInclude,
      orderBy,
      skip: near ? undefined : pagination.skip,
      take: near ? Math.min(pagination.take * 4, 400) : pagination.take,
    }),
    prisma.spot.count({ where }),
  ]);

  const confirmed = await lastConfirmedMap(items.map((item) => item.id));
  let serialized = items.map((item) =>
    serializeSpot(toSpotLike(item, confirmed.get(item.id.toString()) ?? null), {
      distanceMeters: near ? haversineMeters(near, { lat: item.publicLat ?? 0, lng: item.publicLng ?? 0 }) : undefined,
    }),
  );

  // 按距离排序时在应用层完成：候选集已由 bbox 收窄，成本可控
  if (near && query.sort === "distance") {
    serialized = serialized
      .filter((item) => (item.distanceMeters as number) <= radius)
      .sort((a, b) => (a.distanceMeters as number) - (b.distanceMeters as number));
  } else if (near) {
    serialized = serialized.filter((item) => (item.distanceMeters as number) <= radius);
  }

  const paged = near ? serialized.slice(pagination.skip, pagination.skip + pagination.take) : serialized;

  return pagedResult(paged, near ? serialized.length : total, pagination);
}

export async function getSpotByUuid(uuid: string, viewer?: AuthUser) {
  const spot = await prisma.spot.findUnique({ where: { uuid }, include: baseInclude });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在或已被删除");

  const privileged = viewer ? viewer.id === spot.ownerId || isModerator(viewer) : false;
  if (spot.status !== "published" && !privileged) {
    throw AppError.notFound("该地点不存在或尚未发布");
  }

  const confirmed = await lastConfirmedMap([spot.id]);
  const media = await prisma.mediaAsset.findMany({
    where: {
      spotId: spot.id,
      // 与发布门禁共用同一份状态清单，避免两处定义漂移
      ...(privileged ? {} : { privacyStatus: { in: [...PUBLISHABLE_PRIVACY_STATUSES] } }),
    },
    select: { uuid: true, width: true, height: true, privacyStatus: true, variantVersion: true },
    orderBy: { id: "asc" },
  });

  const favorite = viewer
    ? (await prisma.favorite.count({ where: { userId: viewer.id, spotId: spot.id } })) > 0
    : undefined;

  return serializeSpot(
    {
      ...toSpotLike(spot, confirmed.get(spot.id.toString()) ?? null),
      media,
    },
    { includeExact: privileged, favorite },
  );
}

// ------------------------------------------------------------------ 写入

async function attachMedia(spotId: bigint | null, ownerId: bigint, mediaUuids: string[]) {
  if (mediaUuids.length === 0) return;

  const assets = await prisma.mediaAsset.findMany({
    where: { uuid: { in: mediaUuids } },
    select: { id: true, ownerId: true, uuid: true },
  });

  if (assets.length !== mediaUuids.length) {
    throw AppError.badRequest("部分图片不存在或已被清理");
  }
  const foreign = assets.find((asset) => asset.ownerId !== ownerId);
  if (foreign) throw AppError.forbidden("不能使用他人上传的图片");

  await prisma.mediaAsset.updateMany({
    where: { uuid: { in: mediaUuids } },
    data: { spotId },
  });
}

export async function createDraft(user: AuthUser, input: CreateSpotInput) {
  const category = await requireCategoryByCode(input.categoryCode);

  if (!isValidLatLng(input.lat, input.lng)) throw AppError.badRequest("坐标不合法");
  if (input.mediaUuids.length > 6) throw AppError.badRequest("最多上传 6 张图片");

  assertNoBlockedContent(input.title, input.description);

  const since = new Date(Date.now() - MS_PER_DAY);
  const todayCount = await prisma.spot.count({
    where: { ownerId: user.id, createdAt: { gte: since }, status: { not: "draft" } },
  });
  if (todayCount >= env.DAILY_SPOT_LIMIT) {
    throw AppError.conflict(
      ERROR_CODES.RATE_LIMITED,
      `每天最多提交 ${env.DAILY_SPOT_LIMIT} 条，今天已达上限，明天再来吧`,
    );
  }

  // 草稿阶段不强制必填属性，用户可以先存一半再去现场确认
  const spot = await prisma.spot.create({
    data: {
      ownerId: user.id,
      categoryId: category.id,
      status: "draft",
      title: input.title,
      description: input.description || null,
      attributes: toJsonValue(input.attributes),
      exactLat: input.lat,
      exactLng: input.lng,
      fuzzEnabled: input.fuzzEnabled,
      fuzzRadiusM: input.fuzzEnabled ? input.fuzzRadiusM : 0,
    },
    select: { id: true, uuid: true },
  });

  if (input.mediaUuids.length > 0) {
    await attachMedia(spot.id, user.id, input.mediaUuids);
  }

  return getSpotByUuid(spot.uuid, user);
}

const EDITABLE_STATUSES: SpotStatus[] = ["draft", "changes_requested", "auto_rejected", "rejected"];

export async function updateSpot(uuid: string, user: AuthUser, input: UpdateSpotInput) {
  const spot = await prisma.spot.findUnique({ where: { uuid } });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) {
    throw AppError.forbidden("你只能编辑自己提交的内容");
  }
  if (!EDITABLE_STATUSES.includes(spot.status) && !isModerator(user)) {
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_STATE_INVALID,
      `当前状态（${spot.status}）不能编辑，请先撤回或等待审核结果`,
    );
  }

  const data: Prisma.SpotUpdateInput = {};

  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description || null;
  if (input.title !== undefined || input.description !== undefined) {
    assertNoBlockedContent(input.title ?? spot.title, input.description ?? spot.description);
  }

  if (input.categoryCode !== undefined) {
    const category = await requireCategoryByCode(input.categoryCode);
    data.category = { connect: { id: category.id } };
  }
  if (input.attributes !== undefined) data.attributes = toJsonValue(input.attributes);
  if (input.lat !== undefined) data.exactLat = input.lat;
  if (input.lng !== undefined) data.exactLng = input.lng;
  if (input.fuzzEnabled !== undefined) data.fuzzEnabled = input.fuzzEnabled;
  if (input.fuzzRadiusM !== undefined) {
    data.fuzzRadiusM = input.fuzzEnabled === false ? 0 : input.fuzzRadiusM;
  }

  if (input.lat !== undefined && input.lng !== undefined && !isValidLatLng(input.lat, input.lng)) {
    throw AppError.badRequest("坐标不合法");
  }

  // 已发布的条目被修改后需要重新审核，直接回到草稿状态
  if (spot.status === "published" && !isModerator(user)) {
    data.status = "draft";
    data.publishedAt = null;
    data.publicLat = null;
    data.publicLng = null;
  }

  await prisma.spot.update({ where: { id: spot.id }, data });

  if (input.mediaUuids !== undefined) {
    await prisma.mediaAsset.updateMany({ where: { spotId: spot.id }, data: { spotId: null } });
    await attachMedia(spot.id, spot.ownerId, input.mediaUuids);
  }

  return getSpotByUuid(uuid, user);
}

export async function deleteSpot(uuid: string, user: AuthUser) {
  const spot = await prisma.spot.findUnique({ where: { uuid } });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) {
    throw AppError.forbidden("你只能删除自己提交的内容");
  }

  // 已发布的条目转为归档，从地图上消失但保留追溯记录
  const nextStatus: SpotStatus = spot.status === "published" ? "archived" : spot.status;
  await prisma.spot.update({
    where: { id: spot.id },
    data: {
      status: nextStatus,
      archivedAt: nextStatus === "archived" ? new Date() : undefined,
      deletedAt: new Date(),
    },
  });

  await prisma.reviewTask.updateMany({
    where: { spotId: spot.id, status: { in: ["pending", "in_review"] } },
    data: { status: "rejected", decisionReason: "作者主动删除", decidedAt: new Date() },
  });

  return { uuid, status: nextStatus };
}

// ------------------------------------------------------------------ 自动预检

export interface AutoCheckIssue {
  code: string;
  message: string;
}

export interface AutoCheckResult {
  passed: boolean;
  issues: AutoCheckIssue[];
  meta: Record<string, unknown>;
}

export async function runAutoCheck(spotId: bigint): Promise<AutoCheckResult> {
  const spot = await prisma.spot.findUnique({
    where: { id: spotId },
    include: {
      category: { include: { schemas: { where: { isCurrent: true }, take: 1 } } },
      media: true,
    },
  });
  if (!spot) throw AppError.notFound("条目不存在");

  const issues: AutoCheckIssue[] = [];
  const meta: Record<string, unknown> = {};

  // 1) 必填属性
  const schema = spot.category.schemas[0];
  if (schema) {
    const result = validateAttributes(schema.schema as never, (spot.attributes ?? {}) as Record<string, unknown>);
    if (!result.ok) {
      issues.push(...result.errors.map((error) => ({ code: "ATTRIBUTE_INVALID", message: error.message })));
    }
  }

  // 2) 违规内容
  const contentFlags = checkText(`${spot.title}\n${spot.description ?? ""}`);
  const blocked = contentFlags.flags.filter((flag) => flag.type === "blocked");
  if (blocked.length > 0) {
    issues.push({
      code: "CONTENT_BLOCKED",
      message: `内容包含不允许的信息：${blocked.map((flag) => flag.label).join("、")}`,
    });
  }
  const pii = contentFlags.flags.filter((flag) => flag.type === "pii");
  if (pii.length > 0) {
    issues.push({
      code: "PII_DETECTED",
      message: `内容疑似包含个人信息（${pii.map((flag) => flag.label).join("、")}），请先删除`,
    });
  }

  // 3) 隐私门禁：只要有图片未确认，就不能进入发布流程
  const blockedMedia = spot.media.filter(
    (asset) => asset.privacyStatus === "needs_manual" || asset.privacyStatus === "failed" || asset.privacyStatus === "processing",
  );
  if (blockedMedia.length > 0) {
    issues.push({
      code: "PRIVACY_NOT_READY",
      message: `有 ${blockedMedia.length} 张图片尚未完成隐私处理`,
    });
    meta.blockedMedia = blockedMedia.map((asset) => ({ uuid: asset.uuid, status: asset.privacyStatus }));
  }

  // 4) 重复检测
  // 用精确坐标而不是 publicLat/publicLng：后者只有发布后才有值，
  // 而重复提交恰恰最容易发生在两条都还在待审的时候。
  // 精确坐标只在服务端参与比对，不会外泄。
  const box = boundingBox({ lat: spot.exactLat, lng: spot.exactLng }, 100);
  const neighbors = await prisma.spot.findMany({
    where: {
      id: { not: spot.id },
      categoryId: spot.categoryId,
      status: { in: ["published", "pending", "in_review"] },
      exactLat: { gte: box.minLat, lte: box.maxLat },
      exactLng: { gte: box.minLng, lte: box.maxLng },
    },
    select: { uuid: true, title: true, exactLat: true, exactLng: true },
    take: 50,
  });

  // 包围盒是超集，再用真实距离收一次，保证"100 米内"这个判断准确
  const origin = { lat: spot.exactLat, lng: spot.exactLng };
  const duplicates = neighbors
    .filter((neighbor) => haversineMeters(origin, { lat: neighbor.exactLat, lng: neighbor.exactLng }) <= 100)
    .map((neighbor) => ({
      uuid: neighbor.uuid,
      similarity: textSimilarity(spot.title, neighbor.title),
    }))
    .filter((item) => item.similarity > 0.9);

  if (duplicates.length > 0) {
    issues.push({
      code: "DUPLICATE_SUSPECTED",
      message: "附近 100 米内已有一条高度相似的记录，请确认是否重复",
    });
    meta.duplicates = duplicates;
  }

  // 5) 频控
  const recentCount = await prisma.spot.count({
    where: { ownerId: spot.ownerId, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
  });
  if (recentCount > 5) {
    issues.push({ code: "TOO_FREQUENT", message: "短时间提交过于频繁，请稍后再试" });
  }
  meta.recentCount = recentCount;

  // 6) 无效区域（水域 / 建筑内部）
  const geo = await reverseGeocode({ lat: spot.exactLat, lng: spot.exactLng });
  if (geo) {
    if (geo.featureClass === "waterway" || (geo.featureClass === "natural" && geo.featureType === "water")) {
      issues.push({ code: "INVALID_AREA", message: "该坐标落在大面积水域上，请确认位置" });
    }
    if (geo.featureClass === "building") {
      issues.push({ code: "INVALID_AREA", message: "该坐标位于建筑内部，请确认位置" });
    }
    meta.address = geo.address;
    meta.feature = { class: geo.featureClass, type: geo.featureType };
  }

  return { passed: issues.length === 0, issues, meta };
}

// ------------------------------------------------------------------ 提交流程

const SUBMITTABLE: SpotStatus[] = ["draft", "changes_requested", "rejected", "auto_rejected"];

function buildSnapshot(spot: {
  title: string;
  description: string | null;
  attributes: unknown;
  exactLat: number;
  exactLng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  addressText: string | null;
  category: { code: string };
}, schemaVersion: number, media: Array<{ uuid: string; privacyStatus: string }>) {
  return {
    title: spot.title,
    description: spot.description,
    attributes: spot.attributes ?? {},
    categoryCode: spot.category.code,
    categorySchemaVersion: schemaVersion,
    lat: spot.exactLat,
    lng: spot.exactLng,
    fuzzEnabled: spot.fuzzEnabled,
    fuzzRadiusM: spot.fuzzRadiusM,
    addressText: spot.addressText,
    media,
  };
}

export async function submitForReview(uuid: string, user: AuthUser, options: { fromAutoRejected?: boolean } = {}) {
  const spot = await prisma.spot.findUnique({
    where: { uuid },
    include: {
      category: { include: { schemas: { where: { isCurrent: true }, take: 1 } } },
      media: { select: { uuid: true, privacyStatus: true } },
    },
  });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) throw AppError.forbidden("你只能提交自己的条目");

  const allowed: SpotStatus[] = options.fromAutoRejected ? ["auto_rejected"] : SUBMITTABLE;
  if (!allowed.includes(spot.status)) {
    throw AppError.unprocessable(
      ERROR_CODES.SPOT_STATE_INVALID,
      `当前状态（${spot.status}）不能提交审核`,
    );
  }

  const category = await requireCategoryByCode(spot.category.code);

  // 提交时必须齐备必填属性——草稿宽容，提交严格
  assertAttributesValid(category.schema, (spot.attributes ?? {}) as Record<string, unknown>);
  assertNoBlockedContent(spot.title, spot.description);
  assertNoPii(spot.title, spot.description);

  const lastRevision = await prisma.spotRevision.findFirst({
    where: { spotId: spot.id },
    orderBy: { revisionNo: "desc" },
    select: { revisionNo: true },
  });

  const addressText =
    spot.addressText ??
    (await reverseGeocode({ lat: spot.exactLat, lng: spot.exactLng }).then((result) => result?.address ?? null));

  const revision = await prisma.spotRevision.create({
    data: {
      spotId: spot.id,
      revisionNo: (lastRevision?.revisionNo ?? 0) + 1,
      editorId: user.id,
      snapshot: toJsonValue(buildSnapshot({ ...spot, addressText }, category.schemaVersion, spot.media)),
      schemaVersion: category.schemaVersion,
    },
    select: { id: true, revisionNo: true },
  });

  const autoCheck = await runAutoCheck(spot.id);
  const slaDueAt = new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000);

  const task = await prisma.reviewTask.create({
    data: {
      spotId: spot.id,
      revisionId: revision.id,
      status: autoCheck.passed ? "pending" : "auto_rejected",
      priority: autoCheck.issues.some((issue) => issue.code === "PRIVACY_NOT_READY") ? 5 : 0,
      autoCheck: toJsonValue({ issues: autoCheck.issues, meta: autoCheck.meta, passed: autoCheck.passed }),
      slaDueAt,
    },
    select: { id: true },
  });

  const nextStatus: SpotStatus = autoCheck.passed ? "pending" : "auto_rejected";
  await prisma.spot.update({
    where: { id: spot.id },
    data: { status: nextStatus, currentRevisionId: revision.id, addressText },
  });

  // 无视自动预检、坚持转人工复核的，扣信用分。
  // 这是"误判可以申诉"与"别拿人工审核当免费通道"之间的平衡。
  if (options.fromAutoRejected) {
    await adjustCredit(spot.ownerId, CREDIT_DELTAS.SPOT_AUTO_REJECTED_OVERRIDE);
  }

  if (!autoCheck.passed) {
    await notify({
      userId: spot.ownerId,
      type: "review_changes",
      title: "这条记录需要先做点调整",
      body: autoCheck.issues.map((issue) => issue.message).join("；"),
      payload: { spotUuid: spot.uuid, issues: autoCheck.issues, taskId: task.id.toString() },
    });
  }

  return {
    status: nextStatus,
    revisionNo: revision.revisionNo,
    taskId: task.id,
    autoCheck,
    canRequestManualReview: !autoCheck.passed,
  };
}

export async function withdrawSubmission(uuid: string, user: AuthUser) {
  const spot = await prisma.spot.findUnique({ where: { uuid } });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) throw AppError.forbidden("你只能撤回自己的提交");

  if (!["pending", "in_review"].includes(spot.status)) {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, `当前状态（${spot.status}）不能撤回`);
  }

  await prisma.$transaction([
    prisma.spot.update({ where: { id: spot.id }, data: { status: "draft" } }),
    prisma.reviewTask.updateMany({
      where: { spotId: spot.id, status: { in: ["pending", "in_review"] } },
      data: {
        status: "changes_requested",
        decisionReason: "作者主动撤回",
        decidedAt: new Date(),
        assignedTo: null,
        lockedUntil: null,
      },
    }),
  ]);

  return { uuid, status: "draft" as const };
}

export async function listRevisions(uuid: string, user: AuthUser) {
  const spot = await prisma.spot.findUnique({ where: { uuid }, select: { id: true, ownerId: true } });
  if (!spot) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id && !isModerator(user)) throw AppError.forbidden("无权查看该条目的修订历史");

  const revisions = await prisma.spotRevision.findMany({
    where: { spotId: spot.id },
    orderBy: { revisionNo: "desc" },
    include: {
      editor: { select: { nickname: true } },
      reviewTasks: {
        orderBy: { id: "desc" },
        take: 1,
        select: {
          status: true,
          decisionReason: true,
          reasonCode: true,
          decidedAt: true,
          autoCheck: true,
        },
      },
    },
  });

  return revisions.map((revision) => ({
    revisionNo: revision.revisionNo,
    createdAt: revision.createdAt,
    editor: revision.editor.nickname,
    schemaVersion: revision.schemaVersion,
    snapshot: revision.snapshot,
    review: revision.reviewTasks[0] ?? null,
  }));
}

// ------------------------------------------------------------------ 互动

export async function confirmSpot(uuid: string, user: AuthUser, isAccurate: boolean, note?: string) {
  const spot = await prisma.spot.findUnique({ where: { uuid } });
  if (!spot || spot.status !== "published") throw AppError.notFound("该地点不存在或尚未发布");
  if (spot.ownerId === user.id) throw AppError.badRequest("不能确认自己提交的条目，请邀请其他人来确认");

  const recent = await prisma.spotConfirmation.findFirst({
    where: { spotId: spot.id, userId: user.id, createdAt: { gte: new Date(Date.now() - CONFIRMATION_COOLDOWN_MS) } },
  });
  if (recent) {
    throw AppError.conflict(ERROR_CODES.ALREADY_CONFIRMED, "你最近已经确认过这条记录，30 天后可以再次确认");
  }

  await prisma.spotConfirmation.create({
    data: { spotId: spot.id, userId: user.id, isAccurate, note: note ?? null },
  });

  const [confirmCount, staleReportCount, lastConfirmed] = await Promise.all([
    prisma.spotConfirmation.count({ where: { spotId: spot.id, isAccurate: true } }),
    prisma.spotConfirmation.count({ where: { spotId: spot.id, isAccurate: false } }),
    prisma.spotConfirmation.findFirst({
      where: { spotId: spot.id, isAccurate: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const freshnessScore = computeFreshness({
    confirmCount,
    staleReportCount,
    lastConfirmedAt: lastConfirmed?.createdAt ?? null,
    publishedAt: spot.publishedAt,
  });

  const shouldMarkStale = !isAccurate && staleReportCount >= STALE_REPORT_THRESHOLD;

  await prisma.spot.update({
    where: { id: spot.id },
    data: {
      confirmCount,
      staleReportCount,
      freshnessScore,
      isStale: shouldMarkStale ? true : spot.isStale,
    },
  });

  if (shouldMarkStale && !spot.isStale) {
    // 过期上报达到阈值 → 生成待复核任务，让条目重新回到审核视野
    const revision = await prisma.spotRevision.findFirst({
      where: { spotId: spot.id },
      orderBy: { revisionNo: "desc" },
      select: { id: true },
    });

    if (revision) {
      await prisma.reviewTask.create({
        data: {
          spotId: spot.id,
          revisionId: revision.id,
          status: "pending",
          priority: 3,
          autoCheck: toJsonValue({ issues: [{ code: "STALE_REPORTED", message: "多位用户反馈信息已过期" }] }),
          slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000),
        },
      });
    }

    await notify({
      userId: spot.ownerId,
      type: "spot_stale",
      title: "你记录的这条信息可能已经过期",
      body: "有用户反馈现场情况发生了变化，请抽空确认或更新。",
      payload: { spotUuid: spot.uuid },
    });
  }

  return {
    confirmCount,
    staleReportCount,
    freshnessScore,
    isStale: shouldMarkStale || spot.isStale,
    addedReviewTask: shouldMarkStale && !spot.isStale,
  };
}

export async function setFavorite(uuid: string, user: AuthUser, favorite: boolean) {
  const spot = await prisma.spot.findUnique({ where: { uuid }, select: { id: true, status: true } });
  if (!spot || spot.status !== "published") throw AppError.notFound("该地点不存在或尚未发布");

  if (favorite) {
    await prisma.favorite.upsert({
      where: { userId_spotId: { userId: user.id, spotId: spot.id } },
      create: { userId: user.id, spotId: spot.id },
      update: {},
    });
  } else {
    await prisma.favorite.deleteMany({ where: { userId: user.id, spotId: spot.id } });
  }

  const favoriteCount = await prisma.favorite.count({ where: { spotId: spot.id } });
  return { favorite, favoriteCount };
}

export async function listMySpots(user: AuthUser, query: { status?: SpotStatus; page: number; pageSize: number }) {
  const pagination = parsePagination(query);
  const where: Prisma.SpotWhereInput = {
    ownerId: user.id,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.spot.findMany({
      where,
      include: baseInclude,
      orderBy: { updatedAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.spot.count({ where }),
  ]);

  const confirmed = await lastConfirmedMap(items.map((item) => item.id));

  return pagedResult(
    items.map((item) => serializeSpot(toSpotLike(item, confirmed.get(item.id.toString()) ?? null), { includeExact: true })),
    total,
    pagination,
  );
}

export async function listMyFavorites(user: AuthUser, query: { page: number; pageSize: number }) {
  const pagination = parsePagination(query);

  const [rows, total] = await Promise.all([
    prisma.favorite.findMany({
      where: { userId: user.id, spot: { status: "published", deletedAt: null } },
      include: { spot: { include: baseInclude } },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.favorite.count({ where: { userId: user.id, spot: { status: "published", deletedAt: null } } }),
  ]);

  const confirmed = await lastConfirmedMap(rows.map((row) => row.spot.id));

  return pagedResult(
    rows.map((row) =>
      serializeSpot(toSpotLike(row.spot, confirmed.get(row.spot.id.toString()) ?? null), { favorite: true }),
    ),
    total,
    pagination,
  );
}

// ------------------------------------------------------------------ 申诉

export async function appealSpot(uuid: string, user: AuthUser, reason: string) {
  const spot = await prisma.spot.findUnique({ where: { uuid } });
  if (!spot || spot.deletedAt) throw AppError.notFound("该地点不存在");
  if (spot.ownerId !== user.id) throw AppError.forbidden("只能对自己的条目提出申诉");
  if (spot.status !== "rejected") {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "只有被驳回的条目才能申诉");
  }

  const original = await prisma.reviewTask.findFirst({
    where: { spotId: spot.id, status: "rejected" },
    orderBy: { id: "desc" },
  });
  if (!original) throw AppError.notFound("找不到对应的审核记录");

  const existingAppeal = await prisma.reviewTask.findFirst({
    where: { appealOfTaskId: original.id },
  });
  if (existingAppeal) {
    throw AppError.conflict(ERROR_CODES.SPOT_STATE_INVALID, "该条目已经申诉过，且只能申诉一次");
  }

  if (original.decidedAt && Date.now() - original.decidedAt.getTime() > 7 * MS_PER_DAY) {
    throw AppError.unprocessable(ERROR_CODES.SPOT_STATE_INVALID, "申诉期已过（驳回后 7 天内可申诉）");
  }

  const task = await prisma.reviewTask.create({
    data: {
      spotId: spot.id,
      revisionId: original.revisionId,
      status: "appealed",
      priority: 8,
      appealOfTaskId: original.id,
      appealText: reason,
      slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 2 * 3600000),
    },
    select: { id: true },
  });

  await prisma.spot.update({ where: { id: spot.id }, data: { status: "appealing" } });

  logger.info({ spotUuid: uuid, taskId: task.id.toString() }, "用户提交申诉");
  return { taskId: task.id, status: "appealing" as const };
}
