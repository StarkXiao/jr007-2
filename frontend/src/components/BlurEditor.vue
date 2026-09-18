<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { BlurRegion } from "@/api/types";

const props = defineProps<{
  assetUuid: string;
  imageUrl: string;
  regions: BlurRegion[];
  variantVersion: number;
  originalPurged?: boolean;
}>();

const emit = defineEmits<{
  (event: "saved", payload: { privacyStatus: string; variants: Record<string, string> }): void;
  (event: "confirmed", payload: { privacyStatus: string }): void;
}>();

const stage = ref<HTMLDivElement | null>(null);
const localRegions = ref<BlurRegion[]>([]);
const selectedIndex = ref<number | null>(null);
const draft = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const saving = ref(false);
const confirming = ref(false);
const reason = ref("");

let dragOrigin: { x: number; y: number } | null = null;

watch(
  () => props.regions,
  (next) => {
    localRegions.value = next.map((region) => ({ ...region, ignored: region.ignored ?? false }));
    selectedIndex.value = null;
  },
  { immediate: true, deep: true },
);

const activeRegions = computed(() => localRegions.value.filter((region) => !region.ignored));
const autoRegions = computed(() => localRegions.value.filter((region) => region.source === "auto"));
const reviewRegions = computed(() =>
  localRegions.value.filter((region) => region.needsReview && !region.ignored),
);
const selected = computed(() =>
  selectedIndex.value === null ? null : (localRegions.value[selectedIndex.value] ?? null),
);

// 归一化坐标 → 百分比，容器缩放时区域会跟随图片一起变
function styleOf(region: { x?: number; y?: number; w?: number; h?: number }) {
  return {
    left: `${(region.x ?? 0) * 100}%`,
    top: `${(region.y ?? 0) * 100}%`,
    width: `${(region.w ?? 0) * 100}%`,
    height: `${(region.h ?? 0) * 100}%`,
  };
}

function toNormalized(event: PointerEvent) {
  const rect = stage.value?.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return null;

  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function onPointerDown(event: PointerEvent) {
  if (props.originalPurged) return;
  const point = toNormalized(event);
  if (!point) return;

  // 点在已有区域上时是"选中"，不是"新建"
  const target = event.target as HTMLElement;
  if (target.closest(".blur-region")) return;

  selectedIndex.value = null;
  dragOrigin = point;
  draft.value = { x: point.x, y: point.y, w: 0, h: 0 };
  stage.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!dragOrigin) return;
  const point = toNormalized(event);
  if (!point) return;

  draft.value = {
    x: Math.min(dragOrigin.x, point.x),
    y: Math.min(dragOrigin.y, point.y),
    w: Math.abs(point.x - dragOrigin.x),
    h: Math.abs(point.y - dragOrigin.y),
  };
}

function onPointerUp() {
  if (!dragOrigin || !draft.value) {
    dragOrigin = null;
    draft.value = null;
    return;
  }

  const box = draft.value;
  dragOrigin = null;
  draft.value = null;

  // 太小的框多半是误触，直接丢弃
  if (box.w < 0.02 || box.h < 0.02) return;

  localRegions.value.push({
    source: "manual",
    algorithm: "pixelate",
    strength: 14,
    x: Number(box.x.toFixed(4)),
    y: Number(box.y.toFixed(4)),
    w: Number(box.w.toFixed(4)),
    h: Number(box.h.toFixed(4)),
    ignored: false,
  });
  selectedIndex.value = localRegions.value.length - 1;
}

function selectRegion(index: number) {
  selectedIndex.value = index;
}

function removeSelected() {
  if (selectedIndex.value === null) return;
  localRegions.value.splice(selectedIndex.value, 1);
  selectedIndex.value = null;
}

function toggleIgnored(index: number) {
  const region = localRegions.value[index];
  if (!region) return;

  if (!region.ignored) {
    // 忽略自动检测结果必须留下理由，否则无法追溯为什么放过了这块区域
    ElMessageBox.prompt("请说明为什么这块区域不需要打码（例如：是海报上的图案）", "忽略检测结果", {
      confirmButtonText: "确认忽略",
      cancelButtonText: "取消",
      inputValidator: (value) => (value && value.trim().length >= 2 ? true : "请填写至少 2 个字的理由"),
    })
      .then(({ value }) => {
        region.ignored = true;
        region.ignoreReason = value.trim();
      })
      .catch(() => undefined);
    return;
  }

  region.ignored = false;
  region.ignoreReason = null;
}

async function save() {
  saving.value = true;
  try {
    const result = await api.put<{ privacyStatus: string; regionsApplied: number; variants: Record<string, string> }>(
      `/moderation/media/${props.assetUuid}/blur-regions`,
      {
        regions: localRegions.value.map((region) => ({
          id: region.id,
          source: region.source,
          algorithm: region.algorithm,
          strength: region.strength,
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
          label: region.label ?? undefined,
          ignored: region.ignored,
          ignoreReason: region.ignoreReason ?? undefined,
        })),
        reason: reason.value || undefined,
      },
    );

    ElMessage.success("隐私处理已更新，公开版本已重新生成");
    reason.value = "";
    emit("saved", { privacyStatus: result.privacyStatus, variants: result.variants });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    saving.value = false;
  }
}

async function confirmPrivacy() {
  confirming.value = true;
  try {
    const result = await api.post<{ privacyStatus: string }>(
      `/moderation/media/${props.assetUuid}/confirm-privacy`,
    );
    ElMessage.success("已确认该图片的隐私处理");
    emit("confirmed", result);
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <div class="blur-editor">
    <el-alert
      v-if="originalPurged"
      type="warning"
      :closable="false"
      show-icon
      title="原图已按隐私策略清理"
      description="保留期结束后原图会被彻底删除，因此无法再调整模糊区域。如果这张图片确实有问题，请直接下架它。"
      style="margin-bottom: 12px"
    />

    <div class="blur-editor__toolbar">
      <span class="muted">
        当前 {{ activeRegions.length }} 块打码区域（其中自动检测 {{ autoRegions.length }} 块）
      </span>
      <el-tag v-if="reviewRegions.length" type="danger" size="small">
        {{ reviewRegions.length }} 块疑难区域待复核
      </el-tag>
      <el-tag v-if="selected" type="danger" size="small">已选中第 {{ (selectedIndex ?? 0) + 1 }} 块</el-tag>
    </div>

    <div
      ref="stage"
      class="blur-stage"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img :src="imageUrl" alt="待处理的图片" draggable="false" />

      <div
        v-for="(region, index) in localRegions"
        :key="region.id ?? `new-${index}`"
        class="blur-region"
        :class="{
          'blur-region--auto': region.source === 'auto' && !region.needsReview,
          'blur-region--review': region.needsReview && !region.ignored,
          'blur-region--ignored': region.ignored,
          'blur-region--selected': selectedIndex === index,
        }"
        :style="styleOf(region)"
        @click.stop="selectRegion(index)"
      >
        <span class="blur-region__label">
          {{ region.label === "face" ? "人脸" : region.label === "plate" ? "车牌" : "手动" }}
          <template v-if="region.confidence"> · {{ Math.round(region.confidence * 100) }}%</template>
          <template v-if="region.needsReview && !region.ignored"> · 待复核</template>
          <template v-if="region.ignored"> · 已忽略</template>
        </span>
      </div>

      <div v-if="draft" class="blur-region blur-region--draft" :style="styleOf(draft)" />
    </div>

    <div v-if="selected" class="blur-editor__controls">
      <el-select v-model="selected.algorithm" size="small" style="width: 120px">
        <el-option label="马赛克" value="pixelate" />
        <el-option label="高斯模糊" value="gaussian" />
      </el-select>

      <span class="muted">强度</span>
      <el-slider v-model="selected.strength" :min="4" :max="40" size="small" style="width: 140px" />

      <el-button size="small" type="danger" plain @click="removeSelected">删除这块</el-button>
    </div>

    <div v-if="autoRegions.length" class="blur-editor__auto">
      <p class="muted" style="margin: 0 0 6px">
        自动检测结果（逐条确认是否采纳；标红的是置信度不高的疑难区域，请重点核对）
      </p>
      <div v-for="(region, index) in localRegions" :key="`auto-${index}`">
        <div v-if="region.source === 'auto'" class="blur-editor__auto-row">
          <el-checkbox
            :model-value="!region.ignored"
            @update:model-value="() => toggleIgnored(localRegions.indexOf(region))"
          >
            {{ region.label === 'face' ? '人脸' : region.label === 'plate' ? '车牌' : '区域' }}
            #{{ index + 1 }}
            <span v-if="region.confidence" class="muted">置信度 {{ Math.round(region.confidence * 100) }}%</span>
            <el-tag v-if="region.needsReview" type="danger" size="small">疑难</el-tag>
          </el-checkbox>
          <span v-if="region.ignoreReason" class="muted">忽略理由：{{ region.ignoreReason }}</span>
        </div>
      </div>
    </div>

    <div class="blur-editor__actions">
      <el-input v-model="reason" placeholder="可选：说明这次修改的原因（会写入审计日志）" style="max-width: 340px" />
      <el-button :loading="saving" :disabled="originalPurged" @click="save">保存并重新生成</el-button>
      <el-button type="primary" :loading="confirming" @click="confirmPrivacy">确认隐私处理完成</el-button>
    </div>
  </div>
</template>

<style scoped>
.blur-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.blur-editor__controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.blur-editor__auto {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--color-border);
}

.blur-editor__auto-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.blur-editor__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.blur-region--draft {
  border-style: solid;
  border-color: var(--color-primary);
  background: rgba(22, 160, 133, 0.16);
  pointer-events: none;
}

.blur-region--selected {
  outline: 2px solid var(--color-text);
  outline-offset: 1px;
}
</style>
