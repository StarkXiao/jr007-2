/** 统一错误码，与《项目文档.md》第 10.1 节一致 */
export const ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_MUTED: "ACCOUNT_MUTED",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  NOT_FOUND: "NOT_FOUND",
  REVIEW_ALREADY_CLAIMED: "REVIEW_ALREADY_CLAIMED",
  REVIEW_LOCK_EXPIRED: "REVIEW_LOCK_EXPIRED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  PRIVACY_NOT_CONFIRMED: "PRIVACY_NOT_CONFIRMED",
  SPOT_ATTRIBUTE_REQUIRED: "SPOT_ATTRIBUTE_REQUIRED",
  SPOT_STATE_INVALID: "SPOT_STATE_INVALID",
  COMMENT_PII_BLOCKED: "COMMENT_PII_BLOCKED",
  DUPLICATE_REPORT: "DUPLICATE_REPORT",
  ALREADY_CONFIRMED: "ALREADY_CONFIRMED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 审核决策原因码，前端用选择器呈现 */
export const REVIEW_REASON_CODES = {
  INSUFFICIENT_DETAIL: "细节信息不足",
  LOCATION_WRONG: "位置不准确",
  DUPLICATE: "与已有条目重复",
  PRIVACY_RISK: "存在隐私风险",
  ADVERTISING: "含有广告或引流",
  OFF_TOPIC: "内容与公共空间无关",
  INAPPROPRIATE: "含有不当内容",
  PHOTO_QUALITY: "图片质量过低无法辨认",
} as const;

export type ReviewReasonCode = keyof typeof REVIEW_REASON_CODES;

/** 举报类型 */
export const REPORT_REASONS = {
  FALSE_INFO: "虚假信息",
  LOCATION_WRONG: "位置错误",
  PRIVACY_LEAK: "隐私泄露",
  INFRINGEMENT: "侵权",
  ADVERTISING: "广告引流",
  INAPPROPRIATE: "违规内容",
  OTHER: "其他",
} as const;

export type ReportReason = keyof typeof REPORT_REASONS;

/** 隐私类举报需要更短的处置时限 */
export const PRIVACY_SENSITIVE_REASONS: ReportReason[] = ["PRIVACY_LEAK"];

export const REPORT_TARGET_TYPES = ["spot", "comment", "media", "user"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** 通知类型，与文档第 5.8 节一致 */
export const NOTIFICATION_TYPES = {
  review_approved: "审核通过",
  review_changes: "需要修改",
  review_rejected: "审核未通过",
  appeal_result: "申诉结果",
  comment_reply: "收到回复",
  comment_hidden: "评论被隐藏",
  report_result: "举报处理结果",
  spot_stale: "条目信息可能已过期",
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/**
 * 允许发布到地图的隐私状态。
 * 全项目只有这一处定义，审核门禁、图片读取、前端提示都从这里取。
 *
 * - auto_clean：检测器可用且未发现任何敏感区域
 * - auto_confirmed：敏感区域全部为高置信度命中，已自动模糊，无需人工介入
 * - confirmed：经过人工确认（含模糊工作台保存 / 复核确认）
 */
export const PUBLISHABLE_PRIVACY_STATUSES = ["auto_clean", "auto_confirmed", "confirmed"] as const;

/** 需要隐私人工复核的状态：模糊不放心或检测器不可用 */
export const PRIVACY_REVIEW_STATUSES = ["needs_manual", "auto_blurred", "failed", "processing"] as const;

export type PublishablePrivacyStatus = (typeof PUBLISHABLE_PRIVACY_STATUSES)[number];

// BullMQ 的队列名不允许包含冒号，命名空间要用 prefix 选项表达。
// 这里保留纯名字，Redis 里的完整键形如 psdm:image:wait。
export const QUEUE_NAMES = {
  IMAGE: "image",
  SLA: "sla",
} as const;

/** 所有队列共用的 Redis 键前缀，避免和同实例上的其他应用撞名 */
export const QUEUE_PREFIX = "psdm";

/** worker 存活心跳的 Redis 键，供容器健康检查读取 */
export const WORKER_HEARTBEAT_KEY = "psdm:worker:heartbeat";

export const AUDIT_ACTIONS = {
  REVIEW_APPROVE: "review.approve",
  REVIEW_REJECT: "review.reject",
  REVIEW_REQUEST_CHANGES: "review.request_changes",
  REVIEW_CLAIM: "review.claim",
  REVIEW_APPEAL_DECIDE: "review.appeal.decide",
  MEDIA_BLUR_UPDATE: "media.blur.update",
  MEDIA_PRIVACY_CONFIRM: "media.privacy.confirm",
  MEDIA_PRIVACY_REVIEW: "media.privacy.review",
  MEDIA_REDETECT_BATCH: "media.redetect.batch",
  MEDIA_ORIGINAL_VIEW: "media.original.view",
  USER_BAN: "user.ban",
  USER_UNBAN: "user.unban",
  USER_MUTE: "user.mute",
  USER_ROLE: "user.role",
  SPOT_HIDE: "spot.hide",
  SPOT_RESTORE: "spot.restore",
  REPORT_RESOLVE: "report.resolve",
  REPORT_DISMISS: "report.dismiss",
  CATEGORY_SCHEMA_UPDATE: "category.schema.update",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** 地图默认展示范围限制（防止一次性拉全表） */
export const MAX_BBOX_SPAN_DEG = 5;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** 评论编辑窗口与次数 */
export const COMMENT_EDIT_WINDOW_MS = 10 * 60 * 1000;
export const COMMENT_MAX_EDITS = 1;

/** 同一用户对同一条目的确认冷却期 */
export const CONFIRMATION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** 过期上报达到该数量后条目进入待复核 */
export const STALE_REPORT_THRESHOLD = 3;

/** 举报合并窗口 */
export const REPORT_MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 审核任务领取锁时长 */
export const REVIEW_LOCK_MS = 30 * 60 * 1000;

/** 原图签名 URL 有效期 */
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

export const IMAGE_VARIANTS = {
  thumb: 320,
  grid: 800,
  full: 1600,
} as const;

export type ImageVariant = keyof typeof IMAGE_VARIANTS;
