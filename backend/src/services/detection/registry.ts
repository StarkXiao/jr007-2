import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { faceAdapter, plateAdapter } from "./builtin";
import { httpAdapter } from "./http";
import type { AdapterOutcome, DetectionAdapter, DetectionInput } from "./types";

/**
 * 适配器注册表。
 *
 * 内置适配器按需懒加载（重依赖只在真的启用时 require），
 * 外部插件（npm 包或本地路径）通过 DETECTION_PLUGINS 注入。
 * 业务代码只面向 DetectionAdapter，不关心后面是 tfjs、tesseract 还是远程 API。
 */
class AdapterRegistry {
  private readonly adapters = new Map<string, DetectionAdapter>();

  register(adapter: DetectionAdapter): void {
    if (this.adapters.has(adapter.id)) {
      logger.warn({ adapter: adapter.id }, "隐私检测适配器 ID 重复，后注册者覆盖前者");
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): DetectionAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): DetectionAdapter[] {
    return [...this.adapters.values()];
  }

  /** 顺序执行选中的适配器；单个抛错不影响其他检测器，失败结果降级为人工复核 */
  async run(ids: string[], input: DetectionInput): Promise<AdapterOutcome[]> {
    const outcomes: AdapterOutcome[] = [];

    for (const id of ids) {
      const adapter = this.adapters.get(id);
      if (!adapter) {
        outcomes.push({ adapter: id, available: false, reason: `未知的检测适配器：${id}`, boxes: [] });
        continue;
      }

      try {
        outcomes.push(await adapter.detect(input));
      } catch (error) {
        logger.warn({ adapter: id, err: (error as Error).message }, "隐私检测适配器执行异常");
        outcomes.push({
          adapter: id,
          available: false,
          reason: `${adapter.name}执行失败：${(error as Error).message}`,
          boxes: [],
        });
      }
    }

    return outcomes;
  }
}

export const adapterRegistry = new AdapterRegistry();

let initialized = false;

/** 加载内置适配器、http 适配器（配置了 URL 时）与外部插件。重复调用是安全的 */
export function initDetectionAdapters(): void {
  if (initialized) return;
  initialized = true;

  adapterRegistry.register(faceAdapter);
  adapterRegistry.register(plateAdapter);

  if (env.DETECTOR_HTTP_URL) {
    adapterRegistry.register(httpAdapter);
  }

  for (const spec of env.DETECTION_PLUGINS) {
    try {
      // 可选外部模块，缺失或导出不符合契约时只告警、不影响启动
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(spec) as { default?: unknown };
      const plugin = mod.default ?? mod;
      if (typeof plugin !== "function") {
        logger.warn({ plugin: spec }, "检测插件未导出注册函数，已跳过");
        continue;
      }
      (plugin as (register: typeof adapterRegistry.register) => void)((adapter) =>
        adapterRegistry.register(adapter),
      );
      logger.info({ plugin: spec }, "已加载外部隐私检测插件");
    } catch (error) {
      logger.warn({ plugin: spec, err: (error as Error).message }, "检测插件加载失败，已跳过");
    }
  }
}

/**
 * 当前生效的适配器 ID 列表。
 *
 * DETECTION_ADAPTERS 显式指定时以它为准；
 * 未指定时沿用旧开关 ENABLE_FACE_DETECTION / ENABLE_PLATE_DETECTION，
 * 保证升级前的部署配置无需改动。
 */
export function activeAdapterIds(): string[] {
  if (env.DETECTION_ADAPTERS.length > 0) return [...env.DETECTION_ADAPTERS];

  const legacy: string[] = [];
  if (env.ENABLE_FACE_DETECTION) legacy.push(faceAdapter.id);
  if (env.ENABLE_PLATE_DETECTION) legacy.push(plateAdapter.id);
  return legacy;
}
