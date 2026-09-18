import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { DetectionOutcome, PrivacyDetector } from "./types";

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

/** 人脸检测：需要 @vladmandic/face-api + @tensorflow/tfjs-node 与本地模型文件 */
async function detectFaces(buffer: Buffer): Promise<DetectionOutcome> {
  const faceapi = tryRequire("@vladmandic/face-api");
  const tf = tryRequire("@tensorflow/tfjs-node");

  if (!faceapi || !tf) {
    return {
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

    await api.nets.tinyFaceDetector.loadFromDisk(env.FACE_MODEL_DIR);

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

    const boxes = detections.map((detection) => ({
      x: round(detection.box.x / info.width),
      y: round(detection.box.y / info.height),
      w: round(detection.box.width / info.width),
      h: round(detection.box.height / info.height),
      label: "face" as const,
      confidence: round(detection.score),
    }));

    return { available: true, boxes };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "人脸检测执行失败，转为人工确认");
    return { available: false, reason: `人脸检测失败：${(error as Error).message}`, boxes: [] };
  }
}

export const faceDetector: PrivacyDetector = {
  name: "face",
  isEnabled: () => env.ENABLE_FACE_DETECTION,
  detect: detectFaces,
};

export function faceModelDir(): string {
  return path.resolve(process.cwd(), env.FACE_MODEL_DIR);
}
