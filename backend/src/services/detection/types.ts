/**
 * 隐私检测的可插拔适配器契约。
 *
 * 检测器（人脸、车牌、外部 AI 服务、自研模型……）都实现同一个 DetectionAdapter
 * 接口，由 registry 按 env.DETECTION_ADAPTERS 装载。新增一种检测能力时
 * 不需要改动媒体流水线，只需注册一个适配器——开闭原则。
 */

/** 敏感区域类别。内置 face / plate，外部适配器可以给出自己的字符串类别 */
export type DetectionLabel = "face" | "plate" | string;

export interface DetectionBox {
  /** 归一化坐标（0–1），与 blur_regions 的存储格式一致 */
  x: number;
  y: number;
  w: number;
  h: number;
  label: DetectionLabel;
  /** 0–1，自动分级与人工复核排序的唯一依据 */
  confidence: number;
}

/** 单个检测器的一次执行结果。检测器不可用或执行失败与"检测到 0 个框"必须可区分 */
export interface AdapterOutcome {
  /** 适配器标识，例如 face / plate / http:cloud-vision，写入检测元数据便于追溯 */
  adapter: string;
  /** 检测器是否真正完成了检测（依赖缺失、模型加载失败、网络错误都算 false） */
  available: boolean;
  /** 不可用原因，会汇总到 detectionMeta.notes 并在复核台展示 */
  reason?: string;
  boxes: DetectionBox[];
}

export interface DetectionInput {
  buffer: Buffer;
  mimetype: string;
  width: number;
  height: number;
}

export interface DetectionAdapter {
  /** 全局唯一标识；http 适配器可用 "http:<name>" 形式注册多个实例 */
  readonly id: string;
  /** 人类可读名称，写日志与运维信息用 */
  readonly name: string;
  /** 该适配器负责的类别，仅用于诊断展示，不做过滤 */
  readonly labels: readonly DetectionLabel[];
  detect(input: DetectionInput): Promise<AdapterOutcome>;
}

/** 外部插件（DETECTION_PLUGINS 指向的模块）需要默认导出的注册函数 */
export type AdapterPlugin = (register: (adapter: DetectionAdapter) => void) => void;

// ── 置信度自动分级 ──────────────────────────────────────────────────────────

/**
 * 区域分级。只有 ambiguous 进入人工复核队列，这是"只让人工看疑难区域"的落点：
 *
 * - trusted    置信度 ≥ autoConfirm 阈值：直接模糊并自动放行（auto_confirmed）
 * - ambiguous  介于两阈值之间：先模糊（默认安全），但必须人工复核（auto_blurred）
 * - candidate  低于 review 阈值：不打码、不落 blur_regions，仅记录在检测元数据里
 */
export type RegionGrade = "trusted" | "ambiguous" | "candidate";

export type AssetDecision =
  /** 检测器可用，没有需要处理的区域 → auto_clean */
  | "clean"
  /** 有命中且全部高置信度，已自动模糊并放行 → auto_confirmed */
  | "auto_confirmed"
  /** 有中置信度区域或需要复核的候选 → auto_blurred，等人工 */
  | "needs_review"
  /** 没有任何检测器可用 → needs_manual，整张图人工兜底 */
  | "manual_required";
