import { env } from "../../config/env";
import type { AdapterOutcome, DetectionAdapter, DetectionBox, DetectionInput } from "./types";

/**
 * 外部检测服务适配器。
 *
 * 把图片 POST 到 DETECTOR_HTTP_URL，对端返回：
 * ```json
 * { "boxes": [{ "x": 0.1, "y": 0.2, "w": 0.1, "h": 0.2, "label": "face", "confidence": 0.97 }] }
 * ```
 * 坐标必须是归一化（0–1）。对接任意第三方视觉服务时，在对端做一层格式适配即可，
 * 本仓库代码无需改动——这是可插拔架构里"接别人家模型"的标准出口。
 */
export const httpAdapter: DetectionAdapter = {
  id: "http",
  name: "外部隐私检测服务（HTTP）",
  labels: ["face", "plate"],

  async detect({ buffer, mimetype, width, height }: DetectionInput): Promise<AdapterOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.DETECTOR_HTTP_TIMEOUT_MS);
    timer.unref();

    try {
      const headers: Record<string, string> = { "Content-Type": mimetype || "application/octet-stream" };
      if (env.DETECTOR_HTTP_TOKEN) headers.Authorization = `Bearer ${env.DETECTOR_HTTP_TOKEN}`;

      const response = await fetch(env.DETECTOR_HTTP_URL, {
        method: "POST",
        headers,
        body: buffer,
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          adapter: "http",
          available: false,
          reason: `外部检测服务返回 ${response.status}，已转为人工确认`,
          boxes: [],
        };
      }

      const payload = (await response.json()) as {
        available?: boolean;
        reason?: string;
        boxes?: Array<Record<string, unknown>>;
      };

      if (payload.available === false) {
        return { adapter: "http", available: false, reason: payload.reason ?? "外部检测服务不可用", boxes: [] };
      }

      const boxes = (payload.boxes ?? [])
        .map((raw) => normalizeBox(raw, width, height))
        .filter((b): b is DetectionBox => b !== null);

      return { adapter: "http", available: true, boxes };
    } catch (error) {
      return {
        adapter: "http",
        available: false,
        reason: `外部检测服务调用失败：${(error as Error).message}`,
        boxes: [],
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * 校验并归一化外部返回的框。
 * 兼容两种坐标：归一化（0–1，首选）与像素坐标（任一值 > 1 时按图片尺寸换算）。
 * 非法条目直接丢弃，不能让外部服务的脏数据写进打码区域。
 */
function normalizeBox(
  raw: Record<string, unknown>,
  width: number,
  height: number,
): DetectionBox | null {
  const num = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key] as number) ? (raw[key] as number) : null;

  let x = num("x");
  let y = num("y");
  let w = num("w");
  let h = num("h");
  const confidence = num("confidence");
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "unknown";

  if (x === null || y === null || w === null || h === null || confidence === null) return null;
  if (w <= 0 || h <= 0) return null;

  // 像素坐标 → 归一化
  if (Math.max(x, y, w, h) > 1) {
    if (width <= 0 || height <= 0) return null;
    x /= width;
    y /= height;
    w /= width;
    h /= height;
  }

  // 裁到 [0,1]，越界框平移回收
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  w = Math.min(1 - x, w);
  h = Math.min(1 - y, h);
  if (w <= 0 || h <= 0) return null;

  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    w: Math.round(w * 10000) / 10000,
    h: Math.round(h * 10000) / 10000,
    label,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 10000) / 10000,
  };
}
