import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { AdapterOutcome, DetectionAdapter, DetectionBox, DetectionInput } from "./types";

function tryRequire(moduleName: string): Record<string, unknown> | undefined {
  try {
    // 可选依赖，缺失时走人工兜底而不是让服务崩溃
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  label: DetectionBox["label"],
  confidence: number,
): DetectionBox {
  return { x: round(x), y: round(y), w: round(w), h: round(h), label, confidence: round(confidence) };
}

/** 人脸检测：需要 @vladmandic/face-api + @tensorflow/tfjs-node 与本地模型文件 */
export const faceAdapter: DetectionAdapter = {
  id: "face",
  name: "本地人脸检测（face-api tinyFaceDetector）",
  labels: ["face"],

  async detect({ buffer }: DetectionInput): Promise<AdapterOutcome> {
    const faceapi = tryRequire("@vladmandic/face-api");
    const tf = tryRequire("@tensorflow/tfjs-node");

    if (!faceapi || !tf) {
      return {
        adapter: "face",
        available: false,
        reason: "未安装 @vladmandic/face-api 或 @tensorflow/tfjs-node，已转为人工确认",
        boxes: [],
      };
    }

    try {
      const api = faceapi as unknown as {
        nets: Record<string, { loadFromDisk: (dir: string) => Promise<void> }>;
        tf: { tensor3d: (data: Uint8Array, shape: [number, number, number]) => unknown };
        detectAllFaces: (
          input: unknown,
          options: unknown,
        ) => Promise<Array<{ box: { x: number; y: number; width: number; height: number }; score: number }>>;
        TinyFaceDetectorOptions: new (options: Record<string, unknown>) => unknown;
      };

      await api.nets.tinyFaceDetector.loadFromDisk(faceModelDir());

      const sharp = tryRequire("sharp") as unknown as {
        default: (input: Buffer) => {
          ensureAlpha: () => { raw: () => { toBuffer: (options: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number } }> } };
        };
      };
      const decoder = (sharp.default ?? (sharp as unknown as (input: Buffer) => unknown)) as (
        input: Buffer,
      ) => {
        ensureAlpha: () => {
          raw: () => {
            toBuffer: (options: { resolveWithObject: true }) => Promise<{
              data: Buffer;
              info: { width: number; height: number };
            }>;
          };
        };
      };

      const { data, info } = await decoder(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const tensor = api.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 4]);
      const detections = await api.detectAllFaces(
        tensor,
        new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: env.FACE_CONFIDENCE_THRESHOLD }),
      );

      return {
        adapter: "face",
        available: true,
        boxes: detections.map((detection) =>
          box(
            detection.box.x / info.width,
            detection.box.y / info.height,
            detection.box.width / info.width,
            detection.box.height / info.height,
            "face",
            detection.score,
          ),
        ),
      };
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "人脸检测执行失败，转为人工确认");
      return { adapter: "face", available: false, reason: `人脸检测失败：${(error as Error).message}`, boxes: [] };
    }
  },
};

const CN_PLATE = /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/;

/** 车牌检测：基于 tesseract.js 的 OCR 识别，再按号牌规则过滤 */
export const plateAdapter: DetectionAdapter = {
  id: "plate",
  name: "本地车牌检测（tesseract OCR + 号牌规则）",
  labels: ["plate"],

  async detect({ buffer, width, height }: DetectionInput): Promise<AdapterOutcome> {
    const tesseract = tryRequire("tesseract.js");
    if (!tesseract) {
      return {
        adapter: "plate",
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

      const boxes: DetectionBox[] = [];
      for (const word of data.words ?? []) {
        const text = word.text.replace(/\s+/g, "");
        if (!CN_PLATE.test(text)) continue;

        boxes.push(
          box(
            word.bbox.x0 / width,
            word.bbox.y0 / height,
            (word.bbox.x1 - word.bbox.x0) / width,
            (word.bbox.y1 - word.bbox.y0) / height,
            "plate",
            word.confidence / 100,
          ),
        );
      }

      return { adapter: "plate", available: true, boxes };
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "车牌检测执行失败，转为人工确认");
      return { adapter: "plate", available: false, reason: `车牌检测失败：${(error as Error).message}`, boxes: [] };
    }
  },
};

/** 解析为绝对路径，避免受 cwd 影响 */
export function faceModelDir(): string {
  return path.resolve(process.cwd(), env.FACE_MODEL_DIR);
}
