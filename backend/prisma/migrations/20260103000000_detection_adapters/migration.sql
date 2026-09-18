-- 可插拔隐私检测 + 置信度自动分级：
-- 1) PrivacyStatus 增加 auto_confirmed（高置信度自动模糊并放行，无需人工）
-- 2) blur_regions 记录检测器来源与人工复核状态，疑难区域才进人工队列

ALTER TYPE "PrivacyStatus" ADD VALUE IF NOT EXISTS 'auto_confirmed';

CREATE TYPE "RegionReviewStatus" AS ENUM ('trusted', 'pending', 'accepted', 'dismissed');

ALTER TABLE "blur_regions"
  ADD COLUMN "detector" VARCHAR(64),
  ADD COLUMN "review_status" "RegionReviewStatus",
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "reviewed_by" BIGINT;

-- 存量数据回填：
-- 旧的自动区域没有置信度分级信息，一律视为已被流程消费（trusted），
-- 避免升级后把历史图片全部打回复核队列；被忽略的框标记为人工驳回。
UPDATE "blur_regions"
SET "review_status" = CASE WHEN "ignored" THEN 'dismissed' ELSE 'trusted' END::"RegionReviewStatus"
WHERE "source" = 'auto';

ALTER TABLE "blur_regions"
  ADD CONSTRAINT "blur_regions_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;

-- 复核队列按状态扫描
CREATE INDEX "idx_blur_review_status" ON "blur_regions"("review_status");
