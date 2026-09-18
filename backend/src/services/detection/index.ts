import { env } from "../../config/env";
import { gradeBoxes, type GradedBoxes } from "./grading";
import { dropOverlapping, nonMaxSuppression } from "./merge";
import { activeAdapterIds, adapterRegistry, initDetectionAdapters } from "./registry";
import type {
  AdapterOutcome,
  AssetDecision,
  DetectionBox,
  DetectionInput,
} from "./types";

export { adapterRegistry, initDetectionAdapters, activeAdapterIds } from "./registry";
export { gradeBoxes, gradeRegion, decideAsset } from "./grading";
export type { GradeThresholds } from "./grading";
export { nonMaxSuppression, dropOverlapping, iou } from "./merge";

export type {
  AdapterOutcome,
  AssetDecision,
  DetectionAdapter,
  DetectionBox,
  DetectionInput,
  RegionGrade,
} from "./types";

export interface DetectionResult {
  /** 至少有一个适配器真正完成了检测 */
  anyAvailable: boolean;
  /** 去重、分级后的全部命中 */
  boxes: DetectionBox[];
  graded: GradedBoxes;
  decision: AssetDecision;
  /** 每个适配器的执行情况，用于诊断与审计 */
  adapterOutcomes: AdapterOutcome[];
  notes: string[];
  /** 分级阈值快照，随检测元数据落库，保证结果可复现解释 */
  thresholds: { autoConfirm: number; review: number };
}

export interface DetectOptions {
  /**
   * 已被人工处理过（手动框选 / 审核员已判定）的区域。
   * 批量重跑时这些位置受保护，新检测框与之重叠即丢弃。
   */
  protectedRegions?: Array<{ x: number; y: number; w: number; h: number }>;
  /** 覆盖本次执行的适配器选择（测试 / 按图灰度用）；默认取全局配置 */
  adapterIds?: string[];
}

/**
 * 隐私检测总入口（适配器编排 + 置信度自动分级）。
 *
 * 设计原则：检测是**增强**而非前提。所有适配器都缺失或失败时 anyAvailable=false，
 * 图片会被置为 needs_manual，必须由审核员确认后才能发布——闭环不打折。
 */
export async function detectSensitiveRegions(
  input: DetectionInput,
  options: DetectOptions = {},
): Promise<DetectionResult> {
  initDetectionAdapters();

  const ids = options.adapterIds ?? activeAdapterIds();
  const outcomes = await adapterRegistry.run(ids, input);

  const notes: string[] = [];
  const anyAvailable = outcomes.some((outcome) => outcome.available);

  for (const outcome of outcomes) {
    if (outcome.reason) notes.push(`[${outcome.adapter}] ${outcome.reason}`);
  }
  if (ids.length === 0) {
    notes.push("未启用任何隐私检测适配器（DETECTION_ADAPTERS 为空）");
  }

  const thresholds = {
    autoConfirm: env.DETECTION_AUTO_CONFIRM_THRESHOLD,
    review: env.DETECTION_REVIEW_THRESHOLD,
  };

  // 多适配器结果先去重，再剔除覆盖人工既判区域的框，最后按置信度分级
  let merged = nonMaxSuppression(outcomes.flatMap((outcome) => (outcome.available ? outcome.boxes : [])));
  merged = dropOverlapping(merged, options.protectedRegions ?? []);
  const graded = gradeBoxes(merged, thresholds);

  let decision: AssetDecision;
  if (!anyAvailable) {
    decision = "manual_required";
  } else if (merged.length === 0) {
    decision = "clean";
  } else if (graded.ambiguous.length === 0 && graded.candidate.length === 0) {
    decision = "auto_confirmed";
  } else {
    decision = "needs_review";
  }

  return { anyAvailable, boxes: merged, graded, decision, adapterOutcomes: outcomes, notes, thresholds };
}
