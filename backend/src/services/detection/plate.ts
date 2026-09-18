import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { DetectionBox, DetectionOutcome, PrivacyDetector } from "./types";

function tryRequire(moduleName: string): Record<string, unknown> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const CN_PLATE = /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/;

/** 车牌检测：基于 tesseract.js 的 OCR 识别，再按号牌规则过滤 */
async function detectPlates(buffer: Buffer): Promise<DetectionOutcome> {
  const tesseract = tryRequire("tesseract.js");
  if (!tesseract) {
    return {
      available: false,
      reason: "未安装 tesseract.js，已转为人工确认",
      boxes: [],
    };
  }

  try {
    const recognize = tesseract.recognize as (
      image: Buffer,
      lang: string,
    ) => Promise<{ data: { words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> } }>;

    const { data } = await recognize(buffer, "chi_sim+eng");
    const sharpMeta = await (tryRequire("sharp") as unknown as {
      default: (input: Buffer) => { metadata: () => Promise<{ width?: number; height?: number }> };
    }).default(buffer).metadata();

    const width = sharpMeta.width ?? 1;
    const height = sharpMeta.height ?? 1;

    const boxes: DetectionBox[] = [];
    for (const word of data.words ?? []) {
      const text = word.text.replace(/\s+/g, "");
      if (!CN_PLATE.test(text)) continue;

      boxes.push({
        x: round(word.bbox.x0 / width),
        y: round(word.bbox.y0 / height),
        w: round((word.bbox.x1 - word.bbox.x0) / width),
        h: round((word.bbox.y1 - word.bbox.y0) / height),
        label: "plate",
        confidence: round(word.confidence / 100),
      });
    }

    return { available: true, boxes };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "车牌检测执行失败，转为人工确认");
    return { available: false, reason: `车牌检测失败：${(error as Error).message}`, boxes: [] };
  }
}

export const plateDetector: PrivacyDetector = {
  name: "plate",
  isEnabled: () => env.ENABLE_PLATE_DETECTION,
  detect: detectPlates,
};
