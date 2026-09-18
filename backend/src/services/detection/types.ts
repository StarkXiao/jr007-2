/**
 * 隐私检测适配器的公共类型。
 *
 * 任何检测能力（人脸、车牌、证件、二维码……）只要实现 PrivacyDetector
 * 并调用 registerDetector 即可接入流水线，无需改动调用方代码。
 */

export interface DetectionBox {
  /** 归一化坐标（0–1），与 blur_regions 的存储格式一致 */
  x: number;
  y: number;
  w: number;
  h: number;
  label: "face" | "plate" | string;
  confidence: number;
}

export interface DetectionOutcome {
  /** 检测器本次是否真的跑起来了（依赖缺失/执行失败时为 false） */
  available: boolean;
  /** 不可用或失败时的说明，会汇总进 detectionMeta 便于排查 */
  reason?: string;
  boxes: DetectionBox[];
}

export interface PrivacyDetector {
  /** 适配器标识，会写入 detectionMeta，批量重跑后据此判断结果来自哪套检测器 */
  readonly name: string;
  /** 环境开关。关闭时流水线跳过该检测器并记录，不算"检测不可用" */
  isEnabled(): boolean;
  /**
   * 执行检测。
   * 约定：依赖缺失或运行失败时返回 available=false，而不是抛错——
   * 检测是增强而非前提，单个检测器挂掉不能拖垮整条上传流水线。
   */
  detect(buffer: Buffer): Promise<DetectionOutcome>;
}

/**
 * 置信度分级：
 * - auto   ：高置信度，自动打码并直接放行，不需要人工介入
 * - review ：疑难区域，仍然打码（宁滥勿缺），但必须人工复核确认
 * 低于复核阈值的框在入口处就被丢弃（视为误报），不会进入这两个等级。
 */
export type BoxGrade = "auto" | "review";

export interface GradedBox extends DetectionBox {
  grade: BoxGrade;
}

export interface DetectorReport {
  name: string;
  available: boolean;
  detected: number;
  reason?: string;
}

export interface DetectionResult {
  /** 至少有一个检测器可用——为 false 时图片必须转人工，这是不可跳过的门禁 */
  anyAvailable: boolean;
  /** 已通过置信度过滤的框（含 auto 与 review 两级） */
  boxes: GradedBox[];
  /** 因置信度过低被丢弃的框数，仅用于统计与排查 */
  droppedCount: number;
  /** 每个已启用适配器的运行情况 */
  detectors: DetectorReport[];
  notes: string[];
}
