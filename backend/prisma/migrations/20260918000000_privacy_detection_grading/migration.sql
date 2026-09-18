-- 隐私检测置信度分级：
-- 1. 新增 auto_confirmed 状态——高置信度自动打码的图片系统直接放行，不再占用人工复核
-- 2. blur_regions 增加 needs_review 标记——疑难区域（中置信度）才进入人工复核队列
ALTER TYPE "PrivacyStatus" ADD VALUE 'auto_confirmed';

ALTER TABLE "blur_regions" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;

-- 复核队列按"有待复核区域的图片"筛选，避免全表扫描
CREATE INDEX "idx_blur_needs_review" ON "blur_regions"("needs_review");
