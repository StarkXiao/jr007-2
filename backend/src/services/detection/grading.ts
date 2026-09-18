import type { AssetDecision, DetectionBox, RegionGrade } from "./types";

export interface GradeThresholds {
  /** ≥ 该值：自动模糊并放行 */
  autoConfirm: number;
  /** ≥ 该值且 < autoConfirm：模糊但需人工复核；< 该值：仅记录为候选 */
  review: number;
}

export function gradeRegion(confidence: number, thresholds: GradeThresholds): RegionGrade {
  if (confidence >= thresholds.autoConfirm) return "trusted";
  if (confidence >= thresholds.review) return "ambiguous";
  return "candidate";
}

export interface GradedBoxes {
  /** 高置信度：直接写为已复核通过的自动区域 */
  trusted: DetectionBox[];
  /** 中置信度：写为待复核的自动区域，默认先模糊 */
  ambiguous: DetectionBox[];
  /** 低置信度候选：不打码，只进检测元数据，供人工抽查 */
  candidate: DetectionBox[];
}

export function gradeBoxes(boxes: DetectionBox[], thresholds: GradeThresholds): GradedBoxes {
  const graded: GradedBoxes = { trusted: [], ambiguous: [], candidate: [] };
  for (const box of boxes) {
    graded[gradeRegion(box.confidence, thresholds)].push(box);
  }
  return graded;
}

/**
 * 汇总所有适配器的结果，给出图片级处置决策。
 *
 * 关键的保守原则：只要还有候选（低置信度命中）存在，就需要人工看一眼——
 * 宁可多复核，不能让一张可能有人脸的图自动放行。
 */
export function decideAsset(
  graded: GradedBoxes,
  anyAvailable: boolean,
): AssetDecision {
  if (!anyAvailable) return "manual_required";
  if (graded.trusted.length === 0 && graded.ambiguous.length === 0 && graded.candidate.length === 0) {
    return "clean";
  }
  if (graded.ambiguous.length === 0 && graded.candidate.length === 0) {
    return "auto_confirmed";
  }
  return "needs_review";
}
