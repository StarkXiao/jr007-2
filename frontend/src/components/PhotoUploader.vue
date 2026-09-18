<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, mediaUrl } from "@/api/client";
import type { MediaStatus, UploadedAsset } from "@/api/types";

const props = defineProps<{
  modelValue: string[];
  max?: number;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string[]): void;
}>();

interface TrackedAsset extends UploadedAsset {
  variantVersion: number;
  statusText: string;
  previewUrl: string;
}

const assets = ref<TrackedAsset[]>([]);
const uploading = ref(false);
const polling = new Set<string>();
let pollTimer: number | undefined;

const limit = computed(() => props.max ?? 6);
const canAdd = computed(() => assets.value.length < limit.value);

// 隐私状态直接展示给贡献者，让他知道图片还要过一道隐私处理
const STATUS_TEXT: Record<string, string> = {
  processing: "隐私处理中…",
  auto_clean: "未发现敏感区域，待审核确认",
  auto_blurred: "已自动模糊，待审核确认",
  auto_confirmed: "已自动模糊并放行",
  needs_manual: "需要人工确认隐私区域",
  manual_blurred: "已人工模糊，待确认",
  confirmed: "隐私处理已确认",
  failed: "处理失败，请重新上传",
};

function syncModel() {
  emit(
    "update:modelValue",
    assets.value.map((asset) => asset.uuid),
  );
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0) return;

  const room = limit.value - assets.value.length;
  if (room <= 0) {
    ElMessage.warning(`最多上传 ${limit.value} 张图片`);
    return;
  }

  const formData = new FormData();
  for (const file of files.slice(0, room)) {
    formData.append("files", file);
  }

  uploading.value = true;
  try {
    const result = await api.upload<{ assets: UploadedAsset[]; failures: Array<{ name: string; message: string }> }>(
      "/uploads/images",
      formData,
    );

    for (const asset of result.assets) {
      assets.value.push({
        ...asset,
        variantVersion: 0,
        statusText: STATUS_TEXT[asset.privacyStatus] ?? asset.privacyStatus,
        previewUrl: mediaUrl(asset.variants.grid ?? asset.variants.thumb),
      });
      startPolling(asset.uuid);
    }

    for (const failure of result.failures) {
      ElMessage.error(`${failure.name}：${failure.message}`);
    }

    syncModel();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    uploading.value = false;
  }
}

// 上传接口立即返回，真正的模糊化在后台完成，因此这里轮询状态
function startPolling(uuid: string) {
  if (polling.has(uuid)) return;
  polling.add(uuid);

  if (pollTimer === undefined) {
    pollTimer = window.setInterval(refreshStatuses, 2500);
  }
}

async function refreshStatuses() {
  const pending = assets.value.filter((asset) => asset.privacyStatus === "processing");

  if (pending.length === 0) {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    polling.clear();
    return;
  }

  await Promise.all(
    pending.map(async (asset) => {
      try {
        const status = await api.get<MediaStatus>(`/media/${asset.uuid}/status`);
        const target = assets.value.find((item) => item.uuid === asset.uuid);
        if (!target) return;
        target.privacyStatus = status.privacyStatus;
        target.variantVersion = status.variantVersion;
        target.statusText = STATUS_TEXT[status.privacyStatus] ?? status.privacyStatus;
        target.previewUrl = mediaUrl(status.variants.grid ?? status.variants.thumb);
      } catch {
        // 单张状态查询失败不打断整体轮询
      }
    }),
  );
}

function remove(uuid: string) {
  assets.value = assets.value.filter((asset) => asset.uuid !== uuid);
  syncModel();
}

defineExpose({
  setExisting(next: Array<{ uuid: string; variants: Record<string, string>; privacyStatus: string; variantVersion: number; width: number; height: number }>) {
    assets.value = next.map((item) => ({
      uuid: item.uuid,
      duplicated: false,
      privacyStatus: item.privacyStatus,
      width: item.width,
      height: item.height,
      variants: item.variants,
      variantVersion: item.variantVersion,
      statusText: STATUS_TEXT[item.privacyStatus] ?? item.privacyStatus,
      previewUrl: mediaUrl(item.variants.grid ?? item.variants.thumb),
    }));
    syncModel();
  },
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
});
</script>

<template>
  <div class="photo-uploader">
    <div class="photo-grid">
      <div v-for="asset in assets" :key="asset.uuid" class="photo-thumb">
        <img :src="asset.previewUrl" :alt="`已上传图片 ${asset.uuid.slice(0, 8)}`" />
        <el-button
          class="photo-thumb__remove"
          size="small"
          circle
          type="danger"
          aria-label="移除这张图片"
          @click="remove(asset.uuid)"
        >
          <el-icon><Close /></el-icon>
        </el-button>
        <span class="photo-thumb__status">{{ asset.statusText }}</span>
      </div>

      <label v-if="canAdd" class="photo-add">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif"
          multiple
          :disabled="uploading"
          @change="handleFiles"
        />
        <el-icon v-if="!uploading"><Plus /></el-icon>
        <span>{{ uploading ? "上传中…" : "添加照片" }}</span>
      </label>
    </div>

    <p class="muted" style="margin: 8px 0 0">
      最多 {{ limit }} 张。上传时会自动清除照片里的位置等元数据，人脸、车牌等区域由审核员确认后打码。
    </p>
  </div>
</template>

<style scoped>
.photo-add {
  width: 104px;
  height: 104px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-soft);
  font-size: 12px;
  cursor: pointer;
  background: var(--color-bg);
}

.photo-add:hover {
  border-color: var(--color-primary);
  color: var(--color-primary-dark);
}

.photo-add input {
  display: none;
}
</style>
