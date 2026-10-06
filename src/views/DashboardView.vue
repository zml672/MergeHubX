<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import type { StepsProps } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import dayjs from 'dayjs'
import { useAiStore } from '../stores/ai'
import { useGovernanceIssuesStore } from '../stores/governanceIssues'
import { useLocalReposStore } from '../stores/localRepos'
import { repoKey, usePrsStore } from '../stores/prs'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useWatchlistStore } from '../stores/watchlist'
import { AI_RISK_META } from '../types/ai'
import { PLATFORMS, PLATFORM_LABELS, PLATFORM_TAG_COLORS } from '../types/platform'

const router = useRouter()
const ui = useUiStore()
const settings = useSettingsStore()
const watchlist = useWatchlistStore()
const prs = usePrsStore()
const ai = useAiStore()
const governanceStore = useGovernanceIssuesStore()
const localReposStore = useLocalReposStore()
const { prCache, prLoading, prErrors, lastUpdated, polling, refreshingAll } =
  storeToRefs(prs)
const loading = ref(true)

onMounted(async () => {
  governanceStore.load()
  await Promise.all(PLATFORMS.map((p) => settings.loadAccount(p)))
  void localReposStore.refreshChanges()
  loading.value = false
})

const connectedCount = computed(
  () => PLATFORMS.filter((p) => settings.accounts[p].token).length,
)

const aiReviewCount = computed(() => Object.keys(ai.results).length)

/** 仓库行：远程取自远程仓库列表，本地取自本地仓库列表，标签与跳转参数预构造 */
interface RepoRow {
  key: string
  kind: 'remote' | 'local'
  tagLabel: string
  tagColor: string
  repo: string
  query: Record<string, string>
  count: number
  loaded: boolean
  loading: boolean
  error: string
}

const repoRows = computed<RepoRow[]>(() => {
  const remoteRows: RepoRow[] = PLATFORMS.flatMap((p) =>
    watchlist.repos[p].map((repo) => {
      const key = repoKey(p, repo)
      return {
        key,
        kind: 'remote' as const,
        tagLabel: PLATFORM_LABELS[p],
        tagColor: PLATFORM_TAG_COLORS[p],
        repo,
        query: { platform: p, repo },
        count: prCache.value[key]?.length ?? 0,
        loaded: Boolean(prCache.value[key]),
        loading: Boolean(prLoading.value[key]),
        error: prErrors.value[key] || '',
      }
    }),
  )
  const localRows: RepoRow[] = localReposStore.repos.map((r) => ({
    key: `local:${r.path}`,
    kind: 'local',
    tagLabel: '本地',
    tagColor: 'cyan',
    repo: r.name,
    query: { local: r.path },
    count: localReposStore.changeCounts[r.path] ?? 0,
    loaded: r.path in localReposStore.changeCounts,
    loading: Boolean(localReposStore.changeLoading[r.path]),
    error: localReposStore.changeErrors[r.path] || '',
  }))
  return [...remoteRows, ...localRows]
})

/** 折叠态默认最多显示的仓库行数 */
const COLLAPSED_REPO_LIMIT = 5
const repoExpanded = ref(false)

/** 实际渲染的仓库行：折叠时只显示前 5 个 */
const visibleRepoRows = computed(() =>
  repoExpanded.value ? repoRows.value : repoRows.value.slice(0, COLLAPSED_REPO_LIMIT),
)

/** 折叠时未展示的仓库数量 */
const hiddenRepoCount = computed(() =>
  Math.max(0, repoRows.value.length - COLLAPSED_REPO_LIMIT),
)

function toggleRepoList() {
  repoExpanded.value = !repoExpanded.value
}

const pollingEnabled = computed({
  get: () => polling.value,
  set: (value: boolean) => prs.setPolling(value),
})

const lastUpdatedText = computed(() =>
  lastUpdated.value ? dayjs(lastUpdated.value).format('HH:mm:ss') : '尚未刷新',
)

const stepsCurrent = computed(() =>
  repoRows.value.length > 0 ? 2 : connectedCount.value > 0 ? 1 : 0,
)

async function manualRefresh() {
  await Promise.all([prs.refreshAll(), localReposStore.refreshChanges()])
  message.success('数据已刷新')
}

function goReview() {
  router.push('/review')
}

/** 跳转审阅页并定位到指定仓库（远程展开分组，本地直达工作台） */
function goRepoReview(row: RepoRow) {
  router.push({ path: '/review', query: row.query })
}

/** 最近评审条目的展示视图：标签/指标与跳转参数预构造完成，模板零类型分支 */
interface RecentReviewItem {
  key: string
  tagLabel: string
  tagColor: string
  title: string
  riskLabel: string
  riskColor: string
  issueText: string
  timeText: string
  query: Record<string, string>
}

/** 折叠态默认最多显示的评审条数 */
const RECENT_REVIEW_LIMIT = 8

/** 最近 AI 评审动态：聚合远程 PR 与本地工作区结果，按评审时间倒序 */
const recentReviews = computed<RecentReviewItem[]>(() => {
  const collected: { reviewedAt: number; view: RecentReviewItem }[] = []
  for (const [key, result] of Object.entries(ai.results)) {
    if (!result || typeof result.reviewedAt !== 'number' || !Array.isArray(result.issues)) continue
    let repoId: string
    let tagLabel: string
    let tagColor: string
    let title: string
    let query: Record<string, string>
    if (key.startsWith('local:')) {
      const path = key.slice('local:'.length)
      if (!path) continue
      repoId = path
      const name =
        localReposStore.repos.find((r) => r.path === path)?.name ??
        path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ??
        path
      tagLabel = '本地'
      tagColor = 'cyan'
      title = `${name} · 工作区变更`
      query = { local: path }
    } else {
      const colon = key.indexOf(':')
      const hash = key.lastIndexOf('#')
      const platform = PLATFORMS.find((p) => p === key.slice(0, colon))
      const repo = key.slice(colon + 1, hash)
      const number = Number(key.slice(hash + 1))
      if (!platform || !repo || !Number.isInteger(number)) continue
      repoId = repo
      tagLabel = PLATFORM_LABELS[platform]
      tagColor = PLATFORM_TAG_COLORS[platform]
      const summary = prCache.value[repoKey(platform, repo)]?.find((pr) => pr.number === number)
      title = summary?.title ?? `${repo} #${number}`
      query = { platform, repo, number: String(number) }
    }
    const exemptCount = result.issues.filter((issue) =>
      governanceStore.isRecorded(repoId, issue, 'exempt'),
    ).length
    const openCount = result.issues.length - exemptCount
    const risk = AI_RISK_META[result.riskLevel] ?? AI_RISK_META.low
    collected.push({
      reviewedAt: result.reviewedAt,
      view: {
        key,
        tagLabel,
        tagColor,
        title,
        riskLabel: risk.label,
        riskColor: risk.color,
        issueText:
          openCount > 0
            ? `${openCount} 个待处理`
            : exemptCount > 0
              ? '问题已全部豁免'
              : '无问题',
        timeText: dayjs(result.reviewedAt).format('MM-DD HH:mm'),
        query,
      },
    })
  }
  return collected
    .sort((a, b) => b.reviewedAt - a.reviewedAt)
    .slice(0, RECENT_REVIEW_LIMIT)
    .map((item) => item.view)
})

/** 跳转审阅页并直达对应评审详情（远程 PR 或本地工作台） */
function goReviewEntry(item: RecentReviewItem) {
  router.push({ path: '/review', query: item.query })
}

const steps: StepsProps['items'] = [
  {
    title: '配置平台令牌',
    description: '在「设置」页录入 GitHub / GitLab / Gitee 的访问令牌，令牌存入系统凭据管理器',
  },
  {
    title: '拉取合并请求',
    description: '在「审阅」页左上角添加远程仓库（owner/repo），浏览 Fork 发起的 PR / MR 差异',
  },
  {
    title: 'AI 辅助评审',
    description: '在「设置」中配置大模型与评审规范，审阅页一键生成结构化评审意见',
  },
]
</script>

<template>
  <a-spin :spinning="loading" wrapper-class-name="dashboard-scroll">
    <a-row :gutter="16">
      <a-col :span="8">
        <a-card>
          <a-statistic
            title="待审阅"
            :value="prs.totalOpenCount + localReposStore.changeTotal"
            :sub-title="`远程 ${prs.totalOpenCount} 个待审 PR · 本地 ${localReposStore.changeTotal} 个仓库有变更`"
          />
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card>
          <a-statistic
            title="已接入平台"
            :value="connectedCount"
            :suffix="`/ ${PLATFORMS.length}`"
          />
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card>
          <a-statistic
            title="AI 评审意见"
            :value="aiReviewCount"
            sub-title="在审阅页发起 AI 评审后统计"
          />
        </a-card>
      </a-col>
    </a-row>

    <a-card style="margin-top: 16px">
      <div class="refresh-bar">
        <div class="refresh-left">
          <a-button size="small" :loading="refreshingAll" @click="manualRefresh">
            <template #icon><ReloadOutlined /></template>
            刷新数据
          </a-button>
          <span class="refresh-meta">上次更新 {{ lastUpdatedText }}</span>
        </div>
        <div class="refresh-right">
          <span class="refresh-meta">自动刷新 · 60 秒</span>
          <a-switch v-model:checked="pollingEnabled" size="small" />
        </div>
      </div>
    </a-card>

    <a-card title="仓库概览" style="margin-top: 16px">
      <a-empty v-if="repoRows.length === 0" description="暂无仓库">
        <a-button type="primary" @click="goReview">前往审阅页添加</a-button>
      </a-empty>
      <div v-else class="repo-list">
        <div
          v-for="row in visibleRepoRows"
          :key="row.key"
          class="repo-row"
          role="button"
          tabindex="0"
          :title="`前往审阅页查看 ${row.repo}`"
          @click="goRepoReview(row)"
          @keydown.enter="goRepoReview(row)"
          @keydown.space.prevent="goRepoReview(row)"
        >
          <a-tag :color="row.tagColor" class="repo-tag">{{ row.tagLabel }}</a-tag>
          <span class="repo-name">{{ row.repo }}</span>
          <a-spin v-if="row.loading" size="small" />
          <span
            v-else-if="row.error"
            class="repo-error"
            :title="row.error"
          >{{ row.error }}</span>
          <a-tag v-else-if="row.kind === 'local'" color="blue" class="repo-count">{{ row.count }} 个变更</a-tag>
          <a-tag v-else-if="row.loaded" color="blue" class="repo-count">{{ row.count }} 个待审</a-tag>
          <span v-else class="repo-pending">等待刷新</span>
        </div>
        <button
          v-if="hiddenRepoCount > 0 || repoExpanded"
          type="button"
          class="repo-toggle"
          @click="toggleRepoList"
        >
          {{ repoExpanded ? '收起' : `展开全部（共 ${repoRows.length} 个仓库）` }}
        </button>
      </div>
    </a-card>

    <a-card title="最近 AI 评审" style="margin-top: 16px">
      <a-empty v-if="recentReviews.length === 0" description="暂无 AI 评审记录">
        <a-button type="primary" @click="goReview">前往审阅页发起评审</a-button>
      </a-empty>
      <div v-else class="repo-list">
        <div
          v-for="item in recentReviews"
          :key="item.key"
          class="repo-row"
          role="button"
          tabindex="0"
          title="前往审阅页查看评审详情"
          @click="goReviewEntry(item)"
          @keydown.enter="goReviewEntry(item)"
          @keydown.space.prevent="goReviewEntry(item)"
        >
          <a-tag :color="item.tagColor" class="repo-tag">{{ item.tagLabel }}</a-tag>
          <span class="review-title">{{ item.title }}</span>
          <a-tag :color="item.riskColor" class="review-risk">{{ item.riskLabel }}</a-tag>
          <span class="review-issues">{{ item.issueText }}</span>
          <span class="review-time">{{ item.timeText }}</span>
        </div>
      </div>
    </a-card>

    <a-card title="平台接入状态" style="margin-top: 16px">
      <a-space wrap>
        <a-tag
          v-for="p in PLATFORMS"
          :key="p"
          :color="settings.accounts[p].token ? 'green' : 'default'"
          style="font-size: 13px; padding: 4px 10px"
        >
          {{ PLATFORM_LABELS[p] }} · {{ settings.accounts[p].token ? '已配置' : '未配置' }}
        </a-tag>
      </a-space>
    </a-card>

    <a-card title="快速开始" style="margin-top: 16px">
      <a-steps :items="steps" direction="vertical" :current="stepsCurrent" style="max-width: 640px" />
      <a-button type="primary" style="margin-top: 16px" @click="ui.openSettings()">
        配置平台令牌
      </a-button>
    </a-card>
  </a-spin>
</template>

<style scoped>
.dashboard-scroll {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  overflow: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
}

.dashboard-scroll :deep(.ant-spin-container) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dashboard-scroll :deep(.ant-spin-container > .ant-card:last-child) {
  flex: 1;
}

.refresh-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.refresh-left,
.refresh-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.refresh-meta {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.repo-list {
  display: flex;
  flex-direction: column;
}

.repo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 8px;
  margin: 0 -8px;
  border-bottom: 1px solid #f5f5f5;
  min-width: 0;
  cursor: pointer;
  border-radius: 6px;
  transition: background-color 0.2s;
}

.repo-row:hover {
  background: rgba(22, 119, 255, 0.04);
}

.repo-toggle {
  align-self: flex-start;
  margin-top: 6px;
  padding: 2px 0;
  border: none;
  background: none;
  color: #1677ff;
  font-size: 12px;
  cursor: pointer;
}

.repo-toggle:hover {
  color: #4096ff;
}

.repo-row:last-child {
  border-bottom: none;
}

.repo-tag {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.repo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
}

.repo-error {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #cf1322;
}

.repo-count {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.repo-pending {
  flex-shrink: 0;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.review-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.review-risk {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.review-issues {
  flex-shrink: 0;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
}

.review-time {
  flex-shrink: 0;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  font-variant-numeric: tabular-nums;
}
</style>
