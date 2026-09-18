import { describe, expect, it } from "vitest";
import {
  detectSensitiveRegions,
  gradeConfidence,
  listDetectors,
  registerDetector,
  type PrivacyDetector,
} from "../../src/services/detection";
import {
  buildRerunWhere,
  decidePrivacyStatus,
  RERUNNABLE_DEFAULT_STATUSES,
} from "../../src/modules/media/service";
import { env } from "../../src/config/env";

function mockDetector(overrides: Partial<PrivacyDetector> & { name: string }): PrivacyDetector {
  return {
    isEnabled: () => true,
    detect: async () => ({ available: true, boxes: [] }),
    ...overrides,
  };
}

function box(confidence: number) {
  return { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "face", confidence };
}

describe("置信度分级", () => {
  it("高于自动阈值的框标记为 auto", () => {
    expect(gradeConfidence(env.DETECTION_AUTO_THRESHOLD)).toBe("auto");
    expect(gradeConfidence(0.99)).toBe("auto");
  });

  it("落在复核区间的框标记为 review", () => {
    expect(gradeConfidence(env.DETECTION_REVIEW_THRESHOLD)).toBe("review");
    expect(gradeConfidence((env.DETECTION_AUTO_THRESHOLD + env.DETECTION_REVIEW_THRESHOLD) / 2)).toBe("review");
  });

  it("低于复核阈值的框被丢弃", () => {
    expect(gradeConfidence(env.DETECTION_REVIEW_THRESHOLD - 0.01)).toBeNull();
    expect(gradeConfidence(0)).toBeNull();
  });
});

describe("检测器注册表", () => {
  it("内置人脸与车牌两个适配器", () => {
    const names = listDetectors().map((detector) => detector.name);
    expect(names).toContain("face");
    expect(names).toContain("plate");
  });

  it("同名适配器不允许重复注册", () => {
    expect(() => registerDetector(mockDetector({ name: "face" }))).toThrow(/重复注册/);
  });
});

describe("detectSensitiveRegions（可插拔聚合）", () => {
  it("聚合多个检测器的结果并按置信度分级", async () => {
    const result = await detectSensitiveRegions(Buffer.from("img"), [
      mockDetector({
        name: "a",
        detect: async () => ({ available: true, boxes: [box(0.99), box(0.5)] }),
      }),
      mockDetector({
        name: "b",
        detect: async () => ({ available: true, boxes: [box(0.9)] }),
      }),
    ]);

    expect(result.anyAvailable).toBe(true);
    expect(result.boxes.map((item) => item.grade).sort()).toEqual(["auto", "auto", "review"]);
    expect(result.detectors).toHaveLength(2);
  });

  it("低置信度的框被丢弃并计数，不进入结果", async () => {
    const result = await detectSensitiveRegions(Buffer.from("img"), [
      mockDetector({
        name: "noisy",
        detect: async () => ({ available: true, boxes: [box(0.1), box(0.2), box(0.95)] }),
      }),
    ]);

    expect(result.boxes).toHaveLength(1);
    expect(result.droppedCount).toBe(2);
    expect(result.notes.some((note) => note.includes("丢弃"))).toBe(true);
  });

  it("检测器不可用时 anyAvailable=false，调用方据此转人工", async () => {
    const result = await detectSensitiveRegions(Buffer.from("img"), [
      mockDetector({
        name: "broken",
        detect: async () => ({ available: false, reason: "依赖缺失", boxes: [] }),
      }),
    ]);

    expect(result.anyAvailable).toBe(false);
    expect(result.notes).toContain("依赖缺失");
  });

  it("未启用的检测器被跳过，不影响可用性判断", async () => {
    const result = await detectSensitiveRegions(Buffer.from("img"), [
      mockDetector({ name: "off", isEnabled: () => false }),
      mockDetector({ name: "on" }),
    ]);

    expect(result.anyAvailable).toBe(true);
    expect(result.detectors.map((report) => report.name)).toEqual(["on"]);
    expect(result.notes.some((note) => note.includes("off"))).toBe(true);
  });
});

describe("decidePrivacyStatus（隐私状态机）", () => {
  it("有疑难区域时必须人工复核", () => {
    const status = decidePrivacyStatus(
      { anyAvailable: true, boxes: [{ ...box(0.5), grade: "review" }] },
      0,
    );
    expect(status).toBe("needs_manual");
  });

  it("全部高置信度时系统自动放行", () => {
    const status = decidePrivacyStatus(
      { anyAvailable: true, boxes: [{ ...box(0.95), grade: "auto" }] },
      0,
    );
    expect(status).toBe("auto_confirmed");
  });

  it("检测器可用且无敏感区域时为干净图片", () => {
    expect(decidePrivacyStatus({ anyAvailable: true, boxes: [] }, 0)).toBe("auto_clean");
  });

  it("检测器不可用时无论是否有框都转人工", () => {
    expect(decidePrivacyStatus({ anyAvailable: false, boxes: [] }, 0)).toBe("needs_manual");
  });

  it("重跑后无自动区域但有人工框时，保持人工处理流程", () => {
    expect(decidePrivacyStatus({ anyAvailable: true, boxes: [] }, 2)).toBe("manual_blurred");
  });
});

describe("批量重跑筛选", () => {
  it("默认只重跑机器处理过的状态，且必须有原图", () => {
    const where = buildRerunWhere();
    expect(where.originalPath).toEqual({ not: null });
    expect(where.privacyStatus).toEqual({ in: RERUNNABLE_DEFAULT_STATUSES });
    // 人工确认/人工打码的成果默认不被重跑覆盖
    expect(RERUNNABLE_DEFAULT_STATUSES).not.toContain("confirmed");
    expect(RERUNNABLE_DEFAULT_STATUSES).not.toContain("manual_blurred");
  });

  it("允许显式指定状态范围（例如检测器重大升级后覆盖人工终态）", () => {
    const where = buildRerunWhere(["confirmed", "auto_confirmed"]);
    expect(where.privacyStatus).toEqual({ in: ["confirmed", "auto_confirmed"] });
  });
});
