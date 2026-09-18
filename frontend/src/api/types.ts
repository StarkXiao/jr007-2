export interface CategoryAttribute {
  type: "boolean" | "integer" | "number" | "string" | "array";
  label?: string;
  help?: string;
  ui?: string;
  unit?: string;
  enum?: string[];
  enumLabels?: Record<string, string>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: { type: string; enum?: string[]; enumLabels?: Record<string, string> };
}

export interface AttributeSchema {
  type: "object";
  required?: string[];
  properties: Record<string, CategoryAttribute>;
}

export interface Category {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder?: number;
  isActive?: boolean;
  schemaVersion: number;
  schema: AttributeSchema;
}

export interface MediaItem {
  uuid: string;
  width: number;
  height: number;
  privacyStatus: string;
  variantVersion: number;
  variants: { thumb: string; grid: string; full: string };
}

export interface SpotLocation {
  lat: number;
  lng: number;
  fuzzed: boolean;
  radiusMeters: number;
  addressText: string | null;
  precise: boolean;
}

export interface Spot {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  category: Category;
  attributes: Record<string, unknown>;
  location: SpotLocation;
  media: MediaItem[];
  freshness: { score: number; confirmCount: number; isStale: boolean; lastConfirmedAt: string | null };
  stats: { commentCount: number; favoriteCount: number };
  author: { uuid: string | null; nickname: string } | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
  distanceMeters?: number;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Comment {
  id: string;
  body: string;
  status: string;
  edited: boolean;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  author: { uuid: string; nickname: string } | null;
  replies?: Comment[];
  pendingModeration?: boolean;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface CurrentUser {
  uuid: string;
  nickname: string;
  role: "visitor" | "user" | "moderator" | "admin";
  status: string;
  creditScore: number;
  approvedCount: number;
  email: string | null;
  phone: string | null;
  createdAt: string;
  settings: {
    defaultFuzzRadius: number;
    notifyEmail: boolean;
    notifyInapp: boolean;
    locale: string;
  };
}

export interface UploadedAsset {
  uuid: string;
  duplicated: boolean;
  privacyStatus: string;
  width: number;
  height: number;
  variants: Record<string, string>;
}

export interface MediaStatus {
  uuid: string;
  privacyStatus: string;
  width: number;
  height: number;
  variantVersion: number;
  detectionMeta: { notes?: string[]; autoDetected?: number };
  regions: BlurRegion[];
  variants: Record<string, string>;
}

export interface BlurRegion {
  id?: number | string;
  source: "auto" | "manual";
  algorithm?: "pixelate" | "gaussian";
  strength?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string | null;
  confidence?: number | null;
  /** 疑难区域标记：中置信度区域需要人工复核确认 */
  needsReview?: boolean;
  ignored?: boolean;
  ignoreReason?: string | null;
}

export interface ReviewQueueItem {
  id: string;
  status: string;
  priority: number;
  createdAt: string;
  slaDueAt: string;
  overdue: boolean;
  claimedBy: string | null;
  lockActive: boolean;
  lockExpiresAt: string | null;
  spot: {
    uuid: string;
    title: string;
    status: string;
    category: { code: string; name: string; color: string; icon: string };
    mediaCount: number;
    author: { uuid: string; nickname: string; creditScore: number; approvedCount: number };
  };
}

export interface ReviewTaskDetail {
  id: string;
  status: string;
  priority: number;
  autoCheck: { issues?: Array<{ code: string; message: string }>; passed?: boolean };
  slaDueAt: string;
  overdue: boolean;
  lockActive: boolean;
  lockExpiresAt: string | null;
  claimedBy: string | null;
  claimedByMe: boolean;
  appeal: {
    originalTaskId: string;
    text: string | null;
    originalReasonCode: string | null;
    originalReason: string | null;
    originalDecisionBy: string | null;
    originalDecidedAt: string | null;
  } | null;
  spot: {
    uuid: string;
    status: string;
    title: string;
    description: string | null;
    attributes: Record<string, unknown>;
    category: { code: string; name: string; color: string; icon: string };
    schemaVersion: number;
    schema: AttributeSchema;
    exactLocation: { lat: number; lng: number };
    fuzzEnabled: boolean;
    fuzzRadiusM: number;
    addressText: string | null;
    createdAt: string;
    author: { uuid: string; nickname: string; creditScore: number; approvedCount: number };
    history: Array<{
      id: string;
      status: string;
      reasonCode: string | null;
      decisionReason: string | null;
      decidedAt: string | null;
      decider: { nickname: string } | null;
    }>;
  };
  revision: { revisionNo: number; createdAt: string; schemaVersion: number; snapshot: unknown };
  previousRevision: { revisionNo: number; snapshot: unknown; createdAt: string } | null;
  media: Array<MediaItem & {
    exifStripped: boolean;
    detectionMeta: { notes?: string[] };
    originalPurged: boolean;
    regions: BlurRegion[];
  }>;
  reasonCodes: Record<string, string>;
}

export interface ReportItem {
  id: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  reason: string;
  reasonLabel: string;
  detail: string | null;
  status: string;
  createdAt: string;
  slaDueAt: string;
  overdue: boolean;
  privacySensitive: boolean;
  reporter: { uuid: string; nickname: string };
  handler: string | null;
  relatedCount: number;
}
