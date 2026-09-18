<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, mediaUrl } from "@/api/client";
import type { ReviewTaskDetail } from "@/api/types";
import BlurEditor from "@/components/BlurEditor.vue";

const route = useRoute();
const router = useRouter();

const task = ref<ReviewTaskDetail | null>(null);
const loading = ref(true);
const deciding = ref(false);
const activeMedia = ref(0);
const versionBump = ref(0);

// 决策弹窗：原因码、说明、修改要点都在这里收集
const dialog = ref({
  visible: false,
  mode: "reject" as "reject" | "changes",
  reasonCode: "",
  reason: "",
  points: "",
});

const taskId = computed(() => String(route.params.id));

const PUBLISHABLE = ["auto_clean", "auto_confirmed", "confirmed"];
// 发布门禁：只要还有图片没通过隐私门禁（自动放行或人工确认），就不能通过审核。
// 服务端同样会拦一次，这里只是让审核员提前看到原因。
const blockedMedia = computed(
  () => task.value?.media.filter((asset) => !PUBLISHABLE.includes(asset.privacyStatus)) ?? [],
);
const canApprove = computed(() => blockedMedia.value.length === 0);

async function load() {
  loading.value = true;
  try {
    task.value = await api.get<ReviewTaskDetail>(`/moderation/tasks/${taskId.value}`);
    activeMedia.value = 0;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function approve() {
  if (!canApprove.value) {
    ElMessage.warning(`还有 ${blockedMedia.value.length} 张图片未完成隐私确认，不能通过`);
    return;
  }

  deciding.value = true;
  try {
    const result = await api.post<{ status: string; spotUuid: string }>(
      `/moderation/tasks/${taskId.value}/approve`,
      {},
    );
    ElMessage.success("已通过并发布到地图");
    void router.push({ name: "spot-detail", params: { uuid: result.spotUuid } });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    deciding.value = false;
  }
}

// 要求修改时把问题拆成逐条要点，用户才知道具体改什么
function openDecision(mode: "reject" | "changes") {
  dialog.value = { visible: true, mode, reasonCode: "", reason: "", points: "" };
}

async function submitDecision() {
  if (!dialog.value.reasonCode) {
    ElMessage.warning("请选择原因");
    return;
  }
  if (dialog.value.reason.trim().length < 2) {
    ElMessage.warning("请填写说明，至少 2 个字");
    return;
  }

  deciding.value = true;
  try {
    if (dialog.value.mode === "changes") {
      const points = dialog.value.points
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      await api.post(`/moderation/tasks/${taskId.value}/request-changes`, {
        reasonCode: dialog.value.reasonCode,
        reason: dialog.value.reason.trim(),
        points,
      });
      ElMessage.success("已通知作者修改");
    } else {
      await api.post(`/moderation/tasks/${taskId.value}/reject`, {
        reasonCode: dialog.value.reasonCode,
        reason: dialog.value.reason.trim(),
      });
      ElMessage.success("已驳回，作者可以在 7 天内申诉");
    }

    dialog.value.visible = false;
    void router.push({ name: "review-queue" });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    deciding.value = false;
  }
}

async function release() {
  try {
    await api.post(`/moderation/tasks/${taskId.value}/release`);
    ElMessage.success("已释放任务");
    void router.push({ name: "review-queue" });
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

function attributeEntries(attributes: Record<string, unknown>) {
  const properties = task.value?.spot.schema.properties ?? {};
  return Object.entries(attributes).map(([key, value]) => {
    const property = properties[key];
    let text: string;
    if (typeof value === "boolean") text = value ? "是" : "否";
    else if (Array.isArray(value)) text = value.join("、");
    else if (typeof value === "string" && property?.enumLabels?.[value]) text = property.enumLabels[value];
    else text = String(value);

    return { label: property?.label ?? key, text, required: (task.value?.spot.schema.required ?? []).includes(key) };
  });
}

const currentMedia = computed(() => task.value?.media[activeMedia.value] ?? null);
const previousSnapshot = computed(() => task.value?.previousRevision?.snapshot as Record<string, unknown> | undefined);
const currentSnapshot = computed(() => task.value?.revision.snapshot as Record<string, unknown> | undefined);

onMounted(load);
</script>

<template>
  <div class="page page--wide" v-loading="loading">
    <el-empty v-if="!loading && !task" description="任务不存在" />

    <template v-if="task">
      <h1 class="page-title">
        <span>
          审核：{{ task.spot.title }}
          <el-tag v-if="task.overdue" type="danger" size="small" style="margin-left: 8px">已超时</el-tag>
        </span>
        <span style="display: flex; gap: 8px">
          <el-button size="small" @click="release">释放任务</el-button>
          <el-button size="small" @click="load">刷新</el-button>
        </span>
      </h1>

      <el-alert
        v-if="!canApprove"
        type="error"
        :closable="false"
        show-icon
        title="隐私门禁未通过"
        :description="`还有 ${blockedMedia.length} 张图片没有完成隐私确认。请在下方逐张处理，确认后才能通过审核。`"
        style="margin-bottom: 16px"
      />

      <el-alert
        v-if="task.appeal"
        type="warning"
        :closable="false"
        show-icon
        title="这是一次申诉"
        style="margin-bottom: 16px"
      >
        <p style="margin: 4px 0">
          原审核员 {{ task.appeal.originalDecisionBy }} 判定：
          {{ task.reasonCodes[task.appeal.originalReasonCode ?? ""] ?? task.appeal.originalReasonCode }}
        </p>
        <p style="margin: 4px 0">否决理由：{{ task.appeal.originalReason }}</p>
        <p style="margin: 4px 0">作者的申诉：{{ task.appeal.text }}</p>
      </el-alert>

      <el-row :gutter="16">
        <el-col :xs="24" :md="14">
          <el-card shadow="never">
            <template #header>条目内容（第 {{ task.revision.revisionNo }} 版）</template>

            <h3 style="margin: 0 0 8px">{{ task.spot.title }}</h3>
            <p class="muted" style="margin: 0 0 12px">
              {{ task.spot.category.name }} ·
              {{ task.spot.addressText || "未解析地址" }}
            </p>
            <p style="white-space: pre-wrap; line-height: 1.7">{{ task.spot.description || "（无描述）" }}</p>

            <el-divider />

            <dl class="review-attributes">
              <template v-for="row in attributeEntries(task.spot.attributes)" :key="row.label">
                <dt>{{ row.label }}<span v-if="row.required" style="color: var(--color-danger)"> *</span></dt>
                <dd>{{ row.text }}</dd>
              </template>
            </dl>

            <el-divider />

            <p class="muted" style="margin: 0">
              精确坐标：{{ task.spot.exactLocation.lat.toFixed(6) }},
              {{ task.spot.exactLocation.lng.toFixed(6) }}
              （对外显示会模糊 {{ task.spot.fuzzEnabled ? `${task.spot.fuzzRadiusM} 米` : "关闭" }}）
            </p>

            <div v-if="previousSnapshot" style="margin-top: 12px">
              <el-collapse>
                <el-collapse-item :title="`与上一版（第 ${task.previousRevision?.revisionNo} 版）对比`">
                  <pre class="diff-block">{{ JSON.stringify(previousSnapshot, null, 2) }}</pre>
                  <pre class="diff-block">{{ JSON.stringify(currentSnapshot, null, 2) }}</pre>
                </el-collapse-item>
              </el-collapse>
            </div>
          </el-card>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>作者情况</template>
            <p style="margin: 0">
              {{ task.spot.author.nickname }} · 信用分 {{ task.spot.author.creditScore }} ·
              已通过 {{ task.spot.author.approvedCount }} 条
            </p>
            <el-divider />
            <p class="muted" style="margin: 0 0 6px">历史审核记录</p>
            <el-timeline>
              <el-timeline-item
                v-for="record in task.spot.history"
                :key="record.id"
                :timestamp="record.decidedAt ? new Date(record.decidedAt).toLocaleString('zh-CN') : '未处理'"
              >
                {{ record.status }}
                <span v-if="record.reasonCode">
                  · {{ task.reasonCodes[record.reasonCode] ?? record.reasonCode }}
                </span>
                <div v-if="record.decisionReason" class="muted">{{ record.decisionReason }}</div>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="10">
          <el-card shadow="never">
            <template #header>
              图片隐私处理
              <span class="muted">（{{ task.media.length }} 张）</span>
            </template>

            <el-empty v-if="task.media.length === 0" description="这条记录没有上传图片" :image-size="70" />

            <template v-else>
              <el-radio-group v-model="activeMedia" size="small" style="margin-bottom: 10px">
                <el-radio-button v-for="(asset, index) in task.media" :key="asset.uuid" :value="index">
                  第 {{ index + 1 }} 张
                </el-radio-button>
              </el-radio-group>

              <div v-if="currentMedia" style="margin-bottom: 8px">
                <el-tag
                  size="small"
                  :type="PUBLISHABLE.includes(currentMedia.privacyStatus) ? 'success' : 'warning'"
                >
                  {{ currentMedia.privacyStatus }}
                </el-tag>
                <span class="muted" style="margin-left: 8px">
                  {{ currentMedia.exifStripped ? "元数据已清除" : "元数据未处理" }}
                </span>
              </div>

              <BlurEditor
                v-if="currentMedia"
                :key="`${currentMedia.uuid}-${currentMedia.variantVersion}-${versionBump}`"
                :asset-uuid="currentMedia.uuid"
                :image-url="mediaUrl(currentMedia.variants.grid)"
                :regions="currentMedia.regions"
                :variant-version="currentMedia.variantVersion"
                :original-purged="currentMedia.originalPurged"
                @saved="() => ((versionBump += 1), load())"
                @confirmed="() => load()"
              />
            </template>
          </el-card>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>审核决策</template>
            <div style="display: flex; flex-direction: column; gap: 10px">
              <el-button type="success" :loading="deciding" :disabled="!canApprove" @click="approve">
                通过并发布
              </el-button>
              <el-button :disabled="deciding" @click="openDecision('changes')">要求修改</el-button>
              <el-button type="danger" plain :disabled="deciding" @click="openDecision('reject')">驳回</el-button>
            </div>
            <p class="muted" style="margin: 10px 0 0">
              三种决策都会写入审计日志，并通过站内通知告知作者。
            </p>
          </el-card>
        </el-col>
      </el-row>

      <el-dialog
        v-model="dialog.visible"
        :title="dialog.mode === 'changes' ? '要求作者修改' : '驳回这条记录'"
        width="480px"
      >
        <el-form label-position="top">
          <el-form-item label="原因" required>
            <el-select v-model="dialog.reasonCode" placeholder="请选择原因" style="width: 100%">
              <el-option
                v-for="(label, code) in task.reasonCodes"
                :key="code"
                :label="label"
                :value="code"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="说明（会展示给作者）" required>
            <el-input v-model="dialog.reason" type="textarea" :rows="3" maxlength="300" show-word-limit />
          </el-form-item>

          <el-form-item v-if="dialog.mode === 'changes'" label="逐条修改点（每行一条，选填）">
            <el-input
              v-model="dialog.points"
              type="textarea"
              :rows="3"
              placeholder="例如：&#10;请补充这张长椅是否有靠背&#10;描述里的语气请更客观"
            />
          </el-form-item>
        </el-form>

        <template #footer>
          <el-button @click="dialog.visible = false">取消</el-button>
          <el-button :type="dialog.mode === 'changes' ? 'primary' : 'danger'" :loading="deciding" @click="submitDecision">
            确定
          </el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.review-attributes {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 8px 16px;
  margin: 0;
}

.review-attributes dt {
  color: var(--color-text-soft);
  font-size: 14px;
}

.review-attributes dd {
  margin: 0;
  font-size: 14px;
}

.diff-block {
  max-height: 220px;
  overflow: auto;
  background: var(--color-bg);
  padding: 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
</style>
