<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import { useCatalogStore } from "@/stores/catalog";

const catalog = useCatalogStore();
const tab = ref("dashboard");

const dashboard = ref<Record<string, any> | null>(null);
const users = ref<Array<Record<string, any>>>([]);
const userQuery = ref({ q: "", role: "", status: "" });
const appeals = ref<Array<Record<string, any>>>([]);
const audits = ref<Array<Record<string, any>>>([]);
const categories = ref<Array<Record<string, any>>>([]);
const loading = ref(false);

async function loadDashboard() {
  dashboard.value = await api.get<Record<string, any>>("/admin/dashboard");
}

const rerunning = ref(false);

/** 批量重跑存量图片的隐私检测（检测器/阈值升级后使用），按 remaining 循环直到跑完全量 */
async function rerunDetection() {
  try {
    await ElMessageBox.confirm(
      "将对存量图片重新执行隐私检测并按置信度重新分级（人工已确认的图片默认不受影响）。任务在后台异步执行，确定开始？",
      "批量重跑隐私检测",
      { confirmButtonText: "开始重跑", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  rerunning.value = true;
  try {
    let totalEnqueued = 0;
    // 单次调用有批量上限，剩余量通过 remaining 返回，循环跑到清空为止
    for (;;) {
      const result = await api.post<{ enqueued: number; remaining: number; failed: number }>(
        "/admin/media/rerun-detection",
        { limit: 500 },
      );
      totalEnqueued += result.enqueued;
      if (result.failed > 0) {
        ElMessage.warning(`已入队 ${totalEnqueued} 张，有 ${result.failed} 张入队失败（队列不可用），请稍后重试`);
        return;
      }
      if (result.remaining <= 0) break;
    }
    ElMessage.success(`已把 ${totalEnqueued} 张图片加入重跑队列，结果将陆续生效`);
    await loadDashboard();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    rerunning.value = false;
  }
}

async function loadUsers() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/users", {
    q: userQuery.value.q || undefined,
    role: userQuery.value.role || undefined,
    status: userQuery.value.status || undefined,
    pageSize: 50,
  });
  users.value = result.items;
}

async function loadAppeals() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/moderation/appeals");
  appeals.value = result.items;
}

async function loadAudits() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/audit-logs", { pageSize: 50 });
  audits.value = result.items;
}

async function loadCategories() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/categories");
  categories.value = result.items;
}

async function banUser(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("请填写封禁理由（会展示给用户）", "封禁账号", {
      inputValidator: (text) => (text && text.trim().length >= 2 ? true : "请填写至少 2 个字的理由"),
    });
    await api.post(`/admin/users/${row.uuid}/ban`, { reason: value.trim() });
    ElMessage.success("已封禁并踢下线");
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function unbanUser(row: Record<string, any>) {
  await api.post(`/admin/users/${row.uuid}/unban`, { reason: "管理员解封" });
  ElMessage.success("已解封");
  await loadUsers();
}

async function muteUser(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("禁言时长（小时）与理由，用空格分隔，例如：24 言语攻击", "禁言", {
      inputValidator: (text) => {
        const hours = Number((text ?? "").trim().split(/\s+/)[0]);
        return Number.isFinite(hours) && hours >= 1 ? true : "请按「小时 理由」格式填写";
      },
    });

    const [hoursRaw, ...rest] = value.trim().split(/\s+/);
    await api.post(`/admin/users/${row.uuid}/mute`, {
      hours: Number(hoursRaw),
      reason: rest.join(" ") || "违反社区规范",
    });
    ElMessage.success("已禁言");
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function changeRole(row: Record<string, any>, role: string) {
  try {
    await api.patch(`/admin/users/${row.uuid}/role`, { role });
    ElMessage.success("角色已更新");
    await loadUsers();
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function decideAppeal(row: Record<string, any>, decision: "approve" | "uphold") {
  try {
    const { value } = await ElMessageBox.prompt("终审理由（会通知作者）", "申诉终审", {
      inputValidator: (text) => (text && text.trim().length >= 5 ? true : "请填写至少 5 个字的理由"),
    });
    await api.post(`/moderation/appeals/${row.id}/decide`, { decision, reason: value.trim() });
    ElMessage.success("终审完成");
    await loadAppeals();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function updateSchema(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("粘贴新的属性 Schema（JSON）", `编辑「${row.name}」的属性`, {
      inputType: "textarea",
      inputValue: JSON.stringify(row.schema, null, 2),
      inputValidator: (text) => {
        try {
          JSON.parse(text ?? "");
          return true;
        } catch {
          return "JSON 格式不正确";
        }
      },
    });

    const result = await api.put<{ version: number; changed: boolean }>(`/admin/categories/${row.id}/schema`, {
      schema: JSON.parse(value),
    });

    ElMessage.success(result.changed ? `已发布 Schema 版本 v${result.version}` : "内容没有变化");
    await loadCategories();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function toggleCategory(row: Record<string, any>) {
  await api.patch(`/admin/categories/${row.id}`, { isActive: !row.isActive });
  ElMessage.success(row.isActive ? "已停用该分类" : "已启用该分类");
  await loadCategories();
}

async function loadTab(name: string) {
  loading.value = true;
  try {
    if (name === "dashboard") await loadDashboard();
    if (name === "users") await loadUsers();
    if (name === "categories") await loadCategories();
    if (name === "appeals") await loadAppeals();
    if (name === "audit") await loadAudits();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
  await loadTab("dashboard");
});
</script>

<template>
  <div class="page page--wide" v-loading="loading">
    <h1 class="page-title">管理后台</h1>

    <el-tabs v-model="tab" @tab-change="(name: string | number) => loadTab(String(name))">
      <el-tab-pane label="数据看板" name="dashboard">
        <template v-if="dashboard">
          <el-row :gutter="12">
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>已发布条目</span><strong>{{ dashboard.spots.published }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>今日新增</span><strong>{{ dashboard.spots.today }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待审核</span><strong>{{ dashboard.moderation.pending }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待处理举报</span><strong>{{ dashboard.reports.open }}</strong></div></el-card>
            </el-col>
          </el-row>

          <el-row :gutter="12" style="margin-top: 12px">
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>疑似过期条目</span><strong>{{ dashboard.spots.stale }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待确认隐私图片</span><strong>{{ dashboard.privacy.pending }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never">
                <div class="stat">
                  <span>隐私检测</span>
                  <el-button size="small" :loading="rerunning" @click="rerunDetection">批量重跑存量图片</el-button>
                </div>
              </el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>平均审核时长</span><strong>{{ dashboard.averageReviewHours }}h</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待终审申诉</span><strong>{{ dashboard.appeals }}</strong></div></el-card>
            </el-col>
          </el-row>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>分类分布</template>
            <el-table :data="dashboard.byCategory" size="small">
              <el-table-column prop="name" label="分类" />
              <el-table-column prop="count" label="已发布数量" />
            </el-table>
          </el-card>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>最近操作</template>
            <el-table :data="dashboard.recentAudits" size="small">
              <el-table-column prop="action" label="动作" width="200" />
              <el-table-column prop="actor" label="操作人" width="140" />
              <el-table-column prop="reason" label="说明" />
              <el-table-column label="时间" width="180">
                <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>
      </el-tab-pane>

      <el-tab-pane label="用户管理" name="users">
        <div style="display: flex; gap: 10px; margin-bottom: 12px">
          <el-input v-model="userQuery.q" placeholder="搜索昵称 / 邮箱 / 手机号" style="width: 240px" @keyup.enter="loadUsers" />
          <el-select v-model="userQuery.role" placeholder="全部角色" clearable style="width: 140px">
            <el-option label="普通用户" value="user" />
            <el-option label="审核员" value="moderator" />
            <el-option label="管理员" value="admin" />
          </el-select>
          <el-select v-model="userQuery.status" placeholder="全部状态" clearable style="width: 140px">
            <el-option label="正常" value="active" />
            <el-option label="禁言" value="muted" />
            <el-option label="封禁" value="banned" />
          </el-select>
          <el-button @click="loadUsers">查询</el-button>
        </div>

        <el-table :data="users" style="width: 100%">
          <el-table-column prop="nickname" label="昵称" width="140" />
          <el-table-column prop="email" label="邮箱" width="200" />
          <el-table-column prop="role" label="角色" width="110" />
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column prop="creditScore" label="信用分" width="90" />
          <el-table-column label="内容" width="140">
            <template #default="{ row }">{{ row.counts.spots }} 条 / {{ row.counts.comments }} 评论</template>
          </el-table-column>
          <el-table-column label="操作" min-width="260">
            <template #default="{ row }">
              <el-select
                :model-value="row.role"
                size="small"
                style="width: 110px; margin-right: 6px"
                @change="(value: string) => changeRole(row, value)"
              >
                <el-option label="普通用户" value="user" />
                <el-option label="审核员" value="moderator" />
                <el-option label="管理员" value="admin" />
              </el-select>
              <el-button size="small" @click="muteUser(row)">禁言</el-button>
              <el-button v-if="row.status !== 'banned'" size="small" type="danger" plain @click="banUser(row)">
                封禁
              </el-button>
              <el-button v-else size="small" @click="unbanUser(row)">解封</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="分类与属性" name="categories">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="属性 Schema 是版本化的"
          description="发布新版本后，已存在的条目不受影响，只有新提交会按新版本校验。"
          style="margin-bottom: 12px"
        />

        <el-table :data="categories" style="width: 100%">
          <el-table-column prop="name" label="分类" width="120" />
          <el-table-column prop="code" label="代码" width="160" />
          <el-table-column label="属性数量" width="100">
            <template #default="{ row }">
              {{ Object.keys(row.schema?.properties ?? {}).length }}
            </template>
          </el-table-column>
          <el-table-column prop="schemaVersion" label="Schema 版本" width="120" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                {{ row.isActive ? "启用" : "停用" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="200">
            <template #default="{ row }">
              <el-button size="small" @click="updateSchema(row)">编辑属性</el-button>
              <el-button size="small" @click="toggleCategory(row)">
                {{ row.isActive ? "停用" : "启用" }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="申诉终审" name="appeals">
        <el-empty v-if="appeals.length === 0" description="没有待终审的申诉" />
        <el-card v-for="item in appeals" :key="item.id" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
            <div>
              <strong>{{ item.spot.title }}</strong>
              <div class="muted">
                作者 {{ item.spot.owner.nickname }} · 信用分 {{ item.spot.owner.creditScore }}
              </div>
              <p style="margin: 8px 0 0; white-space: pre-wrap">申诉理由：{{ item.appealText }}</p>
              <p class="muted" style="margin: 6px 0 0">
                原判定：{{ item.original?.decisionReason }}
              </p>
            </div>
            <div style="display: flex; gap: 8px; align-items: flex-start">
              <el-button size="small" type="success" @click="decideAppeal(item, 'approve')">改判通过</el-button>
              <el-button size="small" @click="decideAppeal(item, 'uphold')">维持原判</el-button>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="审计日志" name="audit">
        <el-table :data="audits" style="width: 100%">
          <el-table-column prop="action" label="动作" width="220" />
          <el-table-column label="操作人" width="140">
            <template #default="{ row }">{{ row.actor?.nickname ?? "系统" }}</template>
          </el-table-column>
          <el-table-column label="对象" width="160">
            <template #default="{ row }">{{ row.targetType }} #{{ row.targetId ?? "-" }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="说明" min-width="200" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-soft);
}

.stat strong {
  font-size: 22px;
  color: var(--color-text);
}
</style>
