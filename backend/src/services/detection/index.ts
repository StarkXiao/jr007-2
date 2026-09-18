import { env } from "../../config/env";
import { faceDetector, faceModelDir } from "./face";
import { plateDetector } from "./plate";
import type {
  BoxGrade,
  DetectionResult,
  DetectorReport,
  GradedBox,
  PrivacyDetector,
} from "./types";

export type {
  BoxGrade,
  DetectionBox,
  DetectionOutcome,
  DetectionResult,
  DetectorReport,
  GradedBox,
  PrivacyDetector,
} from "./types";
export { faceModelDir };

/**
 * 检测器注册表。
 *
 * 新增检测能力（证件、二维码、屏幕截图……）只需实现 PrivacyDetector
 * 并在这里注册一行，流水线、分级、批量重跑全部自动生效。
 */
const registry: PrivacyDetector[] = [];

export function registerDetector(detector: PrivacyDetector): void {
  if (registry.some((existing) => existing.name === detector.name)) {
    throw new Error(`隐私检测器 "${detector.name}" 重复注册`);
  }
  registry.push(detector);
}

export function listDetectors(): readonly PrivacyDetector[] {
  return registry;
}

registerDetector(faceDetector);
registerDetector(plateDetector);

/**
 * 置信度三级分流：
 * - ≥ DETECTION_AUTO_THRESHOLD   → auto   ：自动打码并放行，不占用人工
 * - ≥ DETECTION_REVIEW_THRESHOLD → review ：仍然打码，但标记为疑难区域，必须人工复核
 * - 其余                          → 丢弃   ：大概率是误报，不落库、不打扰审核员
 */
export function gradeConfidence(confidence: number): BoxGrade | null {
  if (confidence >= env.DETECTION_AUTO_THRESHOLD) return "auto";
  if (confidence >= env.DETECTION_REVIEW_THRESHOLD) return "review";
  return null;
}

/**
 * 隐私检测总入口。
 *
 * 设计原则：检测是**增强**而非前提。检测器缺失或失败时返回 anyAvailable=false，
 * 图片会被置为 needs_manual，必须由审核员框选并确认后才能发布——闭环不打折。
 *
 * detectors 参数默认取全局注册表，测试可以注入 mock 适配器。
 */
export async function detectSensitiveRegions(
  buffer: Buffer,
  detectors: readonly PrivacyDetector[] = listDetectors(),
): Promise<DetectionResult> {
  const notes: string[] = [];
  const boxes: GradedBox[] = [];
  const reports: DetectorReport[] = [];
  let anyAvailable = false;
  let droppedCount = 0;

  for (const detector of detectors) {
    if (!detector.isEnabled()) {
      notes.push(`检测器 ${detector.name} 未启用，已跳过`);
      continue;
    }

    const outcome = await detector.detect(buffer);
    anyAvailable ||= outcome.available;
    if (outcome.reason) notes.push(outcome.reason);

    let kept = 0;
    for (const box of outcome.boxes) {
      const grade = gradeConfidence(box.confidence);
      if (grade === null) {
        droppedCount += 1;
        continue;
      }
      boxes.push({ ...box, grade });
      kept += 1;
    }

    reports.push({
      name: detector.name,
      available: outcome.available,
      detected: kept,
      reason: outcome.reason,
    });
  }

  if (droppedCount > 0) {
    notes.push(`${droppedCount} 个低置信度区域已按误报丢弃`);
  }

  return { anyAvailable, boxes, droppedCount, detectors: reports, notes };
}
