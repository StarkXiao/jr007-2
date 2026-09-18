import type { DetectionBox } from "./types";

type Box = { x: number; y: number; w: number; h: number };

function intersectionArea(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function area(box: Box): number {
  return box.w * box.h;
}

/** 交并比 */
export function iou(a: DetectionBox, b: DetectionBox): number {
  const inter = intersectionArea(a, b);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * 非极大值抑制：多个适配器（或同一适配器的多个框）圈到同一块区域时只保留一个。
 *
 * 合并规则：同类标签、IoU 超过阈值时保留置信度更高的框。
 * 不同标签（如同一位置分别被识别成人脸和车牌）不合并，交由人工判断。
 */
export function nonMaxSuppression(boxes: DetectionBox[], iouThreshold = 0.4): DetectionBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectionBox[] = [];

  for (const candidate of sorted) {
    const duplicate = kept.some(
      (box) => box.label === candidate.label && iou(box, candidate) >= iouThreshold,
    );
    if (!duplicate) kept.push(candidate);
  }

  return kept;
}

/**
 * 新检测框与**已被人工处理过**的区域做重叠过滤。
 * 批量重跑存量图片时，审核员已经确认 / 调整 / 忽略过的位置不能被机器结果覆盖：
 * 与任何受保护区域明显重叠的新框直接丢弃。
 */
export function dropOverlapping(
  boxes: DetectionBox[],
  protectedRegions: Array<{ x: number; y: number; w: number; h: number }>,
  overlapThreshold = 0.3,
): DetectionBox[] {
  if (protectedRegions.length === 0) return boxes;

  return boxes.filter((box) => {
    const overlaps = protectedRegions.some((region) => {
      const inter = intersectionArea(box, region);
      return inter > 0 && inter / Math.min(area(box), area(region)) >= overlapThreshold;
    });
    return !overlaps;
  });
}
