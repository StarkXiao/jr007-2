import { describe, expect, it, beforeEach } from "vitest";
import { gradeBoxes, gradeRegion, decideAsset } from "../../src/services/detection/grading";
import { dropOverlapping, iou, nonMaxSuppression } from "../../src/services/detection/merge";
import { adapterRegistry, initDetectionAdapters } from "../../src/services/detection/registry";
import { detectSensitiveRegions } from "../../src/services/detection";
import type { DetectionAdapter, DetectionBox } from "../../src/services/detection";

const THRESHOLDS = { autoConfirm: 0.85, review: 0.55 };

function box(x: number, y: number, w: number, h: number, label: string, confidence: number): DetectionBox {
  return { x, y, w, h, label, confidence };
}

describe("置信度自动分级", () => {
  it("按阈值分成 trusted / ambiguous / candidate 三档", () => {
    expect(gradeRegion(0.99, THRESHOLDS)).toBe("trusted");
    expect(gradeRegion(0.85, THRESHOLDS)).toBe("trusted");
    expect(gradeRegion(0.7, THRESHOLDS)).toBe("ambiguous");
    expect(gradeRegion(0.55, THRESHOLDS)).toBe("ambiguous");
    expect(gradeRegion(0.3, THRESHOLDS)).toBe("candidate");
  });

  it("图片级决策：干净、全自动放行、需要复核、人工兜底", () => {
    const allTrusted = gradeBoxes([box(0, 0, 0.1, 0.1, "face", 0.95)], THRESHOLDS);
    expect(decideAsset(allTrusted, true)).toBe("auto_confirmed");

    const mixed = gradeBoxes(
      [box(0, 0, 0.1, 0.1, "face", 0.95), box(0.2, 0.2, 0.1, 0.1, "plate", 0.6)],
      THRESHOLDS,
    );
    expect(decideAsset(mixed, true)).toBe("needs_review");

    // 只有低置信度候选也要人工看一眼，不能自动放行
    const onlyCandidates = gradeBoxes([box(0, 0, 0.1, 0.1, "face", 0.2)], THRESHOLDS);
    expect(decideAsset(onlyCandidates, true)).toBe("needs_review");

    const empty = gradeBoxes([], THRESHOLDS);
    expect(decideAsset(empty, true)).toBe("clean");
    expect(decideAsset(empty, false)).toBe("manual_required");

    // 有命中但检测器全部不可用 → 人工兜底，绝不自动放行
    expect(decideAsset(allTrusted, false)).toBe("manual_required");
  });
});

describe("多适配器结果合并", () => {
  it("IoU 计算正确", () => {
    expect(iou(box(0, 0, 0.5, 0.5, "face", 1), box(0, 0, 0.5, 0.5, "face", 1))).toBe(1);
    expect(iou(box(0, 0, 0.5, 0.5, "face", 1), box(0.5, 0.5, 0.5, 0.5, "face", 1))).toBe(0);
  });

  it("同类重叠框 NMS 保留置信度更高者", () => {
    const merged = nonMaxSuppression([
      box(0.1, 0.1, 0.2, 0.2, "face", 0.7),
      box(0.105, 0.105, 0.2, 0.2, "face", 0.95),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(0.95);
  });

  it("不同标签的重叠框不合并", () => {
    const merged = nonMaxSuppression([
      box(0.1, 0.1, 0.2, 0.2, "face", 0.9),
      box(0.1, 0.1, 0.2, 0.2, "plate", 0.8),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("与人工既判区域重叠的新框被丢弃（批量重跑保护）", () => {
    const remaining = dropOverlapping(
      [box(0.1, 0.1, 0.2, 0.2, "face", 0.99)],
      [{ x: 0.12, y: 0.12, w: 0.2, h: 0.2 }],
    );
    expect(remaining).toHaveLength(0);

    // 不重叠的保留
    const untouched = dropOverlapping(
      [box(0.7, 0.7, 0.1, 0.1, "face", 0.99)],
      [{ x: 0.12, y: 0.12, w: 0.2, h: 0.2 }],
    );
    expect(untouched).toHaveLength(1);
  });
});

describe("适配器注册表（可插拔）", () => {
  beforeEach(() => {
    initDetectionAdapters();
  });

  it("内置适配器已注册，未知 id 返回不可用结果", async () => {
    const outcomes = await adapterRegistry.run(["face", "nonexistent"], {
      buffer: Buffer.from("x"),
      mimetype: "image/webp",
      width: 10,
      height: 10,
    });
    const unknown = outcomes.find((o) => o.adapter === "nonexistent");
    expect(unknown?.available).toBe(false);
    expect(unknown?.reason).toContain("未知");
  });

  it("可以注册自定义适配器并被编排执行", async () => {
    const custom: DetectionAdapter = {
      id: "test-stub",
      name: "测试桩",
      labels: ["face"],
      async detect() {
        return {
          adapter: "test-stub",
          available: true,
          boxes: [box(0.1, 0.1, 0.1, 0.1, "face", 0.97)],
        };
      },
    };
    adapterRegistry.register(custom);
    expect(adapterRegistry.get("test-stub")).toBe(custom);

    const outcomes = await adapterRegistry.run(["test-stub"], {
      buffer: Buffer.from("x"),
      mimetype: "image/webp",
      width: 100,
      height: 100,
    });
    expect(outcomes[0].boxes).toHaveLength(1);
  });

  it("适配器抛异常时降级为不可用，不影响整体", async () => {
    const broken: DetectionAdapter = {
      id: "test-broken",
      name: "故障桩",
      labels: ["face"],
      async detect(): Promise<never> {
        throw new Error("模型炸了");
      },
    };
    adapterRegistry.register(broken);
    const outcomes = await adapterRegistry.run(["test-broken"], {
      buffer: Buffer.from("x"),
      mimetype: "image/webp",
      width: 10,
      height: 10,
    });
    expect(outcomes[0].available).toBe(false);
    expect(outcomes[0].reason).toContain("模型炸了");
  });
});

describe("检测编排 + 分级总入口", () => {
  it("没有启用任何适配器时判定为人工兜底", async () => {
    // 默认 DETECTION_ADAPTERS 为空且旧开关关闭（测试环境）
    const result = await detectSensitiveRegions({
      buffer: Buffer.from("x"),
      mimetype: "image/webp",
      width: 10,
      height: 10,
    });
    expect(result.anyAvailable).toBe(false);
    expect(result.decision).toBe("manual_required");
    expect(result.thresholds.autoConfirm).toBeGreaterThan(result.thresholds.review);
  });

  it("高置信度命中自动放行，中置信度进入疑难队列", async () => {
    adapterRegistry.register({
      id: "unit-stub",
      name: "单测桩",
      labels: ["face", "plate"],
      async detect() {
        return {
          adapter: "unit-stub",
          available: true,
          boxes: [
            box(0.05, 0.05, 0.1, 0.1, "face", 0.99),
            box(0.5, 0.5, 0.1, 0.1, "plate", 0.62),
            box(0.8, 0.8, 0.05, 0.05, "face", 0.2),
          ],
        };
      },
    });

    const result = await detectSensitiveRegions(
      { buffer: Buffer.from("x"), mimetype: "image/webp", width: 100, height: 100 },
      { adapterIds: ["unit-stub"] },
    );

    expect(result.anyAvailable).toBe(true);
    expect(result.graded.trusted).toHaveLength(1);
    expect(result.graded.ambiguous).toHaveLength(1);
    expect(result.graded.candidate).toHaveLength(1);
    expect(result.decision).toBe("needs_review");
  });

  it("protectedRegions 覆盖的位置不会被重检结果写入", async () => {
    adapterRegistry.register({
      id: "unit-stub-2",
      name: "单测桩2",
      labels: ["face"],
      async detect() {
        return {
          adapter: "unit-stub-2",
          available: true,
          boxes: [box(0.1, 0.1, 0.1, 0.1, "face", 0.99)],
        };
      },
    });

    const result = await detectSensitiveRegions(
      { buffer: Buffer.from("x"), mimetype: "image/webp", width: 100, height: 100 },
      {
        adapterIds: ["unit-stub-2"],
        protectedRegions: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }],
      },
    );
    expect(result.boxes).toHaveLength(0);
    expect(result.decision).toBe("clean");
  });
});
