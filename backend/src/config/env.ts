import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

// 支持两种常见布局：在 backend/ 下放 .env，或在仓库根目录放 .env
function loadDotEnv(): void {
  if (process.env.ENV_FILE) {
    dotenv.config({ path: process.env.ENV_FILE });
    return;
  }

  for (const candidate of [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ]) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  dotenv.config();
}

loadDotEnv();

/** 允许 "true/1/yes/on" 这类写法，也允许真正的布尔值 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) =>
      typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
    );

const intFromEnv = (defaultValue: number, min?: number, max?: number) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema.default(defaultValue);
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PORT: intFromEnv(3000, 1, 65535),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  FRONTEND_BASE_URL: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL 未配置"),
  REDIS_URL: z.string().min(1, "REDIS_URL 未配置"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET 至少 32 个字符"),
  JWT_ACCESS_TTL: intFromEnv(900, 60),
  REFRESH_TTL: intFromEnv(604800, 3600),
  BCRYPT_ROUNDS: intFromEnv(12, 8, 15),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_PUBLIC_DIR: z.string().default("./storage/public"),
  STORAGE_PRIVATE_DIR: z.string().default("./storage/private"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default(""),
  S3_BUCKET_PUBLIC: z.string().optional().default(""),
  S3_BUCKET_PRIVATE: z.string().optional().default(""),
  S3_ACCESS_KEY: z.string().optional().default(""),
  S3_SECRET_KEY: z.string().optional().default(""),

  IMAGE_MAX_SIZE_MB: intFromEnv(10, 1, 50),
  IMAGE_MAX_DIMENSION: intFromEnv(8000, 640, 20000),
  ORIGINAL_RETENTION_DAYS: intFromEnv(30, 1, 3650),
  ENABLE_FACE_DETECTION: boolFromEnv(false),
  ENABLE_PLATE_DETECTION: boolFromEnv(false),
  FACE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  // 置信度分级阈值：≥ AUTO 自动打码放行；≥ REVIEW 打码但转人工复核；低于 REVIEW 视为误报丢弃
  DETECTION_AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  DETECTION_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  DEFAULT_FUZZ_RADIUS_M: intFromEnv(50, 0, 500),

  MAP_TILE_URL: z.string().default("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
  MAP_TILE_ATTRIBUTION: z.string().default("© OpenStreetMap contributors"),
  GEOCODING_PROVIDER: z.enum(["nominatim", "amap", "none"]).default("nominatim"),
  GEOCODING_API_KEY: z.string().optional().default(""),

  MAIL_DRIVER: z.enum(["console", "smtp"]).default("console"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: intFromEnv(587, 1, 65535),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  MAIL_FROM: z.string().default("no-reply@example.com"),

  DAILY_SPOT_LIMIT: intFromEnv(20, 1, 1000),
  DAILY_COMMENT_LIMIT: intFromEnv(30, 1, 1000),
  REVIEW_SLA_HOURS: intFromEnv(24, 1, 720),
  REPORT_SLA_HOURS: intFromEnv(72, 1, 720),
  PRIVACY_REPORT_SLA_HOURS: intFromEnv(24, 1, 720),
  PREMODERATE_CREDIT_THRESHOLD: intFromEnv(60, 0, 100),

  // 可选增强：AI 检测模型目录（ENABLE_* 打开时使用）
  FACE_MODEL_DIR: z.string().optional().default("./models/face"),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    // 配置不合法时拒绝启动，避免带着错误配置上线
    throw new Error(`环境变量校验失败，请检查 .env：\n${issues}`);
  }

  // 复核阈值高于自动阈值时，所有检测框都会被丢弃，隐私检测形同虚设——必须拒绝启动
  if (parsed.data.DETECTION_REVIEW_THRESHOLD > parsed.data.DETECTION_AUTO_THRESHOLD) {
    throw new Error(
      "环境变量校验失败：DETECTION_REVIEW_THRESHOLD 不能大于 DETECTION_AUTO_THRESHOLD",
    );
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** 解析为绝对路径，避免受 cwd 影响 */
export const paths = {
  publicDir: path.resolve(process.cwd(), env.STORAGE_PUBLIC_DIR),
  privateDir: path.resolve(process.cwd(), env.STORAGE_PRIVATE_DIR),
};
