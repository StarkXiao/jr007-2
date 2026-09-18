<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { BlurRegion } from "@/api/types";

interface QueueItem {
  uuid: string;
  privacyStatus: string;
  width: number;
  height: number;
  variantVersion: number;
  originalPurged: boolean;
  createdAt: string;
  owner: { uuid: string; nickname: string };
  detectionMeta: {
    notes?: string[];
    grades?: { trusted: number; ambiguous: number; candidate: number };
    candidates?: Array<{ label: string; confidence: number }>;
  };
  regions: BlurRegion[];
  variants: Record<string, string>;
}

interface QueueResponse {
  stats: { needsManual: number; ambiguousRegions: number; awaitingAssets: number; failed: number };
  items: QueueItem[];
  page: number;
  pageSize: number;
  total: number;
}

const items = ref<QueueItem[]>([]);
const stats = ref<QueueResponse["stats"]>({ needsManual: 0, ambiguousRegions: 0, awaitingAssets: 0, failed: 0 });
const loading = ref(false);
const scope = ref<"ambiguous" | "manual" | "all">("ambiguous");
const acting = ref<string | null>(null);
const redetecting = ref(false);

const STATUS_TEXT: Record<string, { text: string; type: "success" | "warning" | "info" | "danger" | "primary" }> = {
  auto_clean: { text: "自动判定干净", type: "success" },
  auto_confirmed: { text: "高置信度已自动模糊放行", type: "success" },
  auto_blurred: { text: "自动模糊 · 待复核疑难框", type: "warning" },
  needs_manual: { text: "检测不可用 · 需整图人工", type: "danger" },
  manual_blurred: { text: "人工处理 · 待确认", type: "warning" },
  confirmed: { text: "人工已确认", type: "info" },
  processing: { text: "处理中", type: "primary" },
  failed: { text: "处理失败", type: "danger" },
};

async function load() {
  loading.value = true;
  try {
    const result = await api.get<QueueResponse>("/moderation/privacy/review-queue", {
      scope: scope.value,
      pageSize: 50,
    });
    items.value = result.items;
    stats.value = result.stats;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

function labelText(label?: string | null): string {
  if (label === "face") return "人脸";
  if (label === "plate") return "车牌";
  return label || "区域";
}

function canConfirm(asset: QueueItem): boolean {
  return ["needs_manual", "auto_blurred", "manual_blurred"].includes(asset.privacyStatus) && !asset.originalPurged;
}

async function review(asset: QueueItem, region: BlurRegion, accept: boolean) {
  let reason: string | undefined;
  if (!accept) {
    try {
      const { value } = await ElMessageBox.prompt(
        "确认为什么这块区域不需要打码（例如：海报上的图案、远处不可辨识的路人）",
        "驳回检测结果",
        {
          confirmButtonText: "确认驳回",
          cancelButtonText: "取消",
          inputValidator: (v) => (v && v.trim().length >= 2 ? true : "请填写至少 2 个字的理由"),
        },
      );
      reason = value.trim();
    } catch {
      return;
    }
  }

  acting.value = String(region.id);
  try {
    await api.post(`/moderation/media/${asset.uuid}/regions/${region.id}/review`, { accept, reason });
    ElMessage.success(accept ? "已采纳，该区域保持打码" : "已驳回，公开版本已重新生成");
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    acting.value = null;
  }
}

async function confirmWhole(asset: QueueItem) {
  try {
    await ElMessageBox.confirm("确认这张图片的隐私处理没有问题？确认后即可随条目公开发布。", "整图确认", {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }

  acting.value = asset.uuid;
  try {
    await api.post(`/moderation/media/${asset.uuid}/confirm-privacy`);
    ElMessage.success("已确认");
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    acting.value = null;
  }
}

async function redetectAll() {
  let scopeDesc: string;
  if (scope.value === "manual") {
    scopeDesc = "当前筛选下所有检测不可用的图片";
  } else if (scope.value === "all") {
    scopeDesc = "全部存量图片";
  } else {
    scopeDesc = "所有待人工/待复核的图片";
  }

  try {
    await ElMessageBox.confirm(
      `将把${scopeDesc}（最多 500 张）重新投递到检测队列。人工已裁定的区域会被保留。继续？`,
      "批量重跑存量图片检测",
      { confirmButtonText: "开始重跑", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  redetecting.value = true;
  try {
    const result = await api.post<{ selected: number; enqueued: number; processedInline: number; skippedNoOriginal: number }>(
      "/moderation/privacy/redetect",
      { limit: 500 },
    );
    ElMessage.success(`已选中 ${result.selected} 张：入队 ${result.enqueued}，就地处理 ${result.processedInline}，原图已清理跳过 ${result.skippedNoOriginal}`);
    setTimeout(() => void load(), 2000);
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    redetecting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <h2>隐私复核台</h2>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px">
      <template #title>
        高置信度命中已自动模糊并放行，只有机器拿不准的中置信度区域（以及检测器不可用的图片）才会进入这里。
        当前待复核图片 {{ stats.awaitingAssets }} 张 · 疑难区域 {{ stats.ambiguousRegions }} 块 ·
        需整图人工 {{ stats.needsManual }} 张 · 失败 {{ stats.failed }} 张
      </template>
    </el-alert>

    <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap">
      <el-radio-group v-model="scope" @change="load">
        <el-radio-button value="ambiguous">待复核（疑难）</el-radio-button>
        <el-radio-button value="manual">需整图人工</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button type="warning" plain :loading="redetecting" @click="redetectAll">
        批量重跑存量图片检测
      </el-button>
    </div>

    <el-skeleton v-if="loading && items.length === 0" :rows="6" animated />

    <el-empty v-else-if="items.length === 0" description="没有需要人工处理的图片，机器已兜住全部检测" />

    <div v-else class="queue">
      <el-card v-for="asset in items" :key="asset.uuid" class="queue__card" shadow="never">
        <div class="queue__head">
          <el-tag :type="STATUS_TEXT[asset.privacyStatus]?.type ?? 'info'" size="small">
            {{ STATUS_TEXT[asset.privacyStatus]?.text ?? asset.privacyStatus }}
          </el-tag>
          <span class="muted">{{ asset.owner?.nickname }} · {{ new Date(asset.createdAt).toLocaleString("zh-CN") }}</span>
          <el-tag v-if="asset.originalPurged" type="danger" size="small">原图已清理</el-tag>
          <span class="muted" v-if="asset.detectionMeta.grades">
            高置信度 {{ asset.detectionMeta.grades.trusted }} · 疑难 {{ asset.detectionMeta.grades.ambiguous }}
            · 候选 {{ asset.detectionMeta.grades.candidate }}
          </span>
        </div>

        <div class="queue__body">
          <img :src="asset.variants.grid" alt="待复核图片" class="queue__img" />

          <div class="queue__regions">
            <el-alert
              v-for="note in asset.detectionMeta.notes ?? []"
              :key="note"
              :title="note"
              type="warning"
              :closable="false"
              show-icon
              style="margin-bottom: 6px"
            />

            <div
              v-for="region in asset.regions.filter((r) => r.source === 'auto')"
              :key="region.id"
              class="region-row"
            >
              <el-tag
                :type="region.reviewStatus === 'pending' ? 'warning' : region.reviewStatus === 'dismissed' ? 'info' : 'success'"
                size="small"
              >
                {{ region.reviewStatus === "pending" ? "待复核" : region.reviewStatus === "accepted" ? "已采纳" : region.reviewStatus === "dismissed" ? "已驳回" : "高置信度" }}
              </el-tag>
              <span>{{ labelText(region.label) }} · {{ Math.round((region.confidence ?? 0) * 100) }}%</span>
              <span v-if="region.detector" class="muted">{{ region.detector }}</span>
              <span v-if="region.ignoreReason" class="muted">理由：{{ region.ignoreReason }}</span>
              <template v-if="region.reviewStatus === 'pending' && !asset.originalPurged">
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :loading="acting === String(region.id)"
                  @click="review(asset, region, true)"
                >
                  采纳打码
                </el-button>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :loading="acting === String(region.id)"
                  @click="review(asset, region, false)"
                >
                  驳回
                </el-button>
              </template>
            </div>

            <p
              v-if="asset.detectionMeta.candidates && asset.detectionMeta.candidates.length > 0"
              class="muted"
            >
              另有 {{ asset.detectionMeta.candidates.length }} 个低置信度候选（置信度过低未自动打码），
              请肉眼确认图中是否有遗漏的人脸/车牌。
            </p>

            <p v-if="asset.regions.some((r) => r.source === 'manual')" class="muted">
              含 {{ asset.regions.filter((r) => r.source === "manual").length }} 块人工框选区域。
            </p>

            <el-button
              v-if="canConfirm(asset)"
              size="small"
              type="primary"
              :loading="acting === asset.uuid"
              @click="confirmWhole(asset)"
            >
              整图确认无误
            </el-button>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.queue__card {
  margin-bottom: 14px;
}

.queue__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.queue__body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.queue__img {
  max-width: 360px;
  max-height: 300px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
}

.queue__regions {
  flex: 1;
  min-width: 280px;
}

.region-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
</style>
