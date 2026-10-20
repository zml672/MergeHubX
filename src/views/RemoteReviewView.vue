<script setup lang="ts">
import { computed, h, nextTick, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { Empty, Modal, message } from 'ant-design-vue'
import dayjs from 'dayjs'
import {
  BranchesOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons-vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import AiReportPanel from '../components/review/AiReportPanel.vue'
import DiffFileCard from '../components/review/DiffFileCard.vue'
import ReviewModeModal from '../components/review/ReviewModeModal.vue'
import { useAiReviewFlow } from '../composables/useAiReviewFlow'
import { reviewGroupOptions, useReviewGroup } from '../composables/useReviewGroup'
import type { AiReviewMode } from '../services/ai'
import { buildReviewComment, findReviewComment, reviewCommentMarker } from '../services/ai/reviewComment'
import { providers } from '../services/platforms'
import { aiResultKey, useAiStore } from '../stores/ai'
import { repoKey, usePrsStore } from '../stores/prs'
import { useSettingsStore } from '../stores/settings'
import { useWatchlistStore } from '../stores/watchlist'
import {
  MERGE_METHOD_LABELS,
  type MergeMethod,
  PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_TAG_COLORS,
  type Platform,
  type PlatformAccount,
  type PullRequestDetail,
} from '../types/platform'
import '../styles/review-shared.css'

const settings = useSettingsStore()
const watchlist = useWatchlistStore()
// 关注列表是手工维护数据丢失不可再生，持久化失败必须提示后果；watch failSeq（每次失败
// 自增，连续失败也每次触发）而非判 add/remove 返回值，与 RuleSets/GovernanceRecords 同一
// 机制（覆盖当前与未来所有写操作入口）
watch(
  () => watchlist.persistState.failSeq,
  (seq) => {
    if (seq > 0 && !watchlist.persistState.ok) {
      message.error('关注列表保存失败（存储空间不足或访问受限），本次变更刷新后将丢失，请重试或检查磁盘')
    }
  },
)
const prStore = usePrsStore()
const aiStore = useAiStore()
const { prCache, prLoading, prErrors } = storeToRefs(prStore)

const route = useRoute()

const activePlatform = ref<Platform>('github')
const openRepos = reactive<Record<string, boolean>>({})
const repoMenuOpen = ref(false)
const addPlatform = ref<Platform>('github')
const addRepoInput = ref('')

const selected = ref<{
  platform: Platform
  repo: string
  number: number
} | null>(null)
const detail = ref<PullRequestDetail | null>(null)
const detailLoading = ref(false)
const activeTab = ref('files')

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

const stateMeta: Record<string, { color: string; label: string }> = {
  open: { color: 'green', label: '开启' },
  opened: { color: 'green', label: '开启' },
  closed: { color: 'red', label: '已关闭' },
  merged: { color: 'purple', label: '已合并' },
}

const totalPrCount = computed(() =>
  Object.values(prCache.value).reduce((sum, list) => sum + list.length, 0),
)

const platformSegments = computed(() =>
  PLATFORMS.map((p) => ({
    value: p,
    label: h('span', { class: 'seg-item' }, [
      PLATFORM_LABELS[p],
      ...(watchlist.repos[p].length > 0
        ? [h('span', { class: 'seg-count' }, String(watchlist.repos[p].length))]
        : []),
    ]),
  })),
)

const activeRepos = computed(() => watchlist.repos[activePlatform.value])

function repoPrCount(platform: Platform, repo: string): number | null {
  const list = prCache.value[repoKey(platform, repo)]
  return list ? list.length : null
}

/** 处理来自工作台的跳转参数：?platform&repo&number=直达远程 PR 详情 */
async function applyRepoQuery(): Promise<void> {
  const platform = route.query.platform
  const repo = route.query.repo
  if (typeof platform !== 'string' || typeof repo !== 'string') return
  const p = PLATFORMS.find((item) => item === platform)
  if (!p) return
  if (!watchlist.repos[p].includes(repo)) return
  activePlatform.value = p
  const key = repoKey(p, repo)
  if (!openRepos[key]) {
    openRepos[key] = true
    await loadPrs(p, repo)
  }
  const number = route.query.number
  const n = typeof number === 'string' ? Number(number) : Number.NaN
  if (Number.isInteger(n) && prCache.value[key]?.some((pr) => pr.number === n)) {
    await selectPr(p, repo, n)
    return
  }
  void nextTick(() => {
    document.getElementById(`repo-anchor-${key}`)?.scrollIntoView({ block: 'nearest' })
  })
}

onMounted(() => {
  void Promise.all(PLATFORMS.map((p) => settings.loadAccount(p)))
})

onActivated(() => {
  void applyRepoQuery()
})

function accountOf(platform: Platform): PlatformAccount {
  const s = settings.accounts[platform]
  return { platform, token: s.token, baseUrl: s.baseUrl }
}

function formatTime(value: string): string {
  return dayjs(value).format('MM-DD HH:mm')
}

async function toggleRepo(platform: Platform, repo: string) {
  const key = repoKey(platform, repo)
  openRepos[key] = !openRepos[key]
  if (openRepos[key] && !prCache.value[key]) await loadPrs(platform, repo)
}

async function loadPrs(platform: Platform, repo: string) {
  await prStore.loadPrs(platform, repo)
}

/** 刷新仓库的请求列表：点刷新即代表要查看该仓库，自动展开并重新拉取（展开后 loading 与列表直接可见） */
async function reloadRepo(platform: Platform, repo: string) {
  openRepos[repoKey(platform, repo)] = true
  await loadPrs(platform, repo)
}

function confirmAdd() {
  const value = addRepoInput.value.trim()
  // GitHub/Gitee 固定 owner/repo 两段；GitLab namespace 支持任意级子群组（服务层按 URL-encoded path 整体寻址），须放行多段路径
  const isGitLab = addPlatform.value === 'gitlab'
  const repoPattern = isGitLab ? /^[\w.-]+(?:\/[\w.-]+)+$/ : /^[^/\s]+\/[^/\s]+$/
  if (!repoPattern.test(value)) {
    message.warning(
      isGitLab
        ? '仓库格式应为 group/repo，如 gitlab-org/gitlab；含子群组时写全路径，如 group/sub/repo'
        : '仓库格式应为 owner/repo，例如 vuejs/core',
    )
    return
  }
  if (watchlist.add(addPlatform.value, value)) {
    activePlatform.value = addPlatform.value
    message.success(`已添加 ${PLATFORM_LABELS[addPlatform.value]} · ${value}`)
    addRepoInput.value = ''
    repoMenuOpen.value = false
  } else {
    message.info('该仓库已在远程仓库列表中')
  }
}

function openAdd() {
  addPlatform.value = activePlatform.value
  addRepoInput.value = ''
  repoMenuOpen.value = true
}

function removeRepo(platform: Platform, repo: string) {
  watchlist.remove(platform, repo)
  prStore.clearRepo(platform, repo)
  delete openRepos[repoKey(platform, repo)]
  if (
    selected.value?.platform === platform &&
    selected.value?.repo === repo
  ) {
    selected.value = null
    detail.value = null
    detailLoading.value = false
  }
}

async function selectPr(platform: Platform, repo: string, number: number) {
  selected.value = { platform, repo, number }
  activeTab.value = 'files'
  await loadDetail()
}

/** 详情请求序号：每次发起递增；await 返回后序号已被更新请求取代的结果一律过期丢弃 */
let detailRequestSeq = 0

/** 拉取当前选中 PR 详情并写入共享 detail。返回值是「本次请求自己拉到的详情」：
 *  过期（被更新的请求取代/选中项被清空）或失败时返回 null——调用方需要详情做后续
 *  动作时（如发起评审）必须用返回值而非读共享 detail，否则 await 期间用户切换选中项，
 *  共享位已是其他 PR 的详情（评审 #60 竞态）。仅刷新展示的调用方（selectPr/runPrAction）
 *  可忽略返回值 */
async function loadDetail(): Promise<PullRequestDetail | null> {
  const sel = selected.value
  if (!sel) return null
  const requestId = ++detailRequestSeq
  detailLoading.value = true
  /** 过期判定：选中项已被清空（如移除仓库）或已有更新的详情请求发出，本次结果不得写入任何状态 */
  const isStale = () => !selected.value || requestId !== detailRequestSeq
  try {
    const result = await providers[sel.platform].getPullRequestDetail(
      accountOf(sel.platform),
      sel.repo,
      sel.number,
    )
    if (isStale()) return null
    detail.value = result
    return result
  } catch (err) {
    if (isStale()) return null
    detail.value = null
    message.error(err instanceof Error ? err.message : String(err))
    return null
  } finally {
    if (!isStale()) detailLoading.value = false
  }
}

async function openInBrowser() {
  if (!detail.value) return
  try {
    await openUrl(detail.value.url)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const acting = ref<string | null>(null)

const canAct = computed(() => {
  const s = detail.value?.state
  return s === 'open' || s === 'opened'
})

async function runPrAction(
  name: string,
  action: () => Promise<void>,
  successText: string,
) {
  const sel = selected.value
  if (!sel || acting.value) return
  acting.value = name
  try {
    await action()
    message.success(successText)
    await loadDetail()
    void loadPrs(sel.platform, sel.repo)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    acting.value = null
  }
}

function approveDetail() {
  const sel = selected.value
  if (!sel) return
  void runPrAction(
    'approve',
    () =>
      providers[sel.platform].approvePullRequest(
        accountOf(sel.platform),
        sel.repo,
        sel.number,
      ),
    '已通过该合并请求',
  )
}

function closeDetail() {
  const sel = selected.value
  if (!sel) return
  void runPrAction(
    'close',
    () =>
      providers[sel.platform].closePullRequest(
        accountOf(sel.platform),
        sel.repo,
        sel.number,
      ),
    '已关闭该合并请求',
  )
}

function onMergeMenu({ key }: { key: string | number }) {
  void mergeDetail(key as MergeMethod)
}

function mergeDetail(method: MergeMethod) {
  if (!detail.value) return
  const { number, title, targetBranch } = detail.value
  Modal.confirm({
    title: '确认合并该请求？',
    content: `将以「${MERGE_METHOD_LABELS[method]}」方式把 #${number} ${title} 合入 ${targetBranch}，合并后不可撤销。`,
    okText: '确认合并',
    okType: 'primary',
    cancelText: '取消',
    onOk: () => {
      const sel = selected.value
      if (!sel) return Promise.resolve()
      return runPrAction(
        'merge',
        () =>
          providers[sel.platform].mergePullRequest(
            accountOf(sel.platform),
            sel.repo,
            sel.number,
            method,
          ),
        `已${MERGE_METHOD_LABELS[method]} #${number}`,
      )
    },
  })
}

/** 弹窗确认后真正发起远程评审：先重新拉取 PR 详情再评审（评审老大 10-20：推送新代码后
 *  点评审仍出旧报告）——detail 是选中 PR 那一刻的快照，beginReview 原样透传，平台侧
 *  代码更新后旧 diff 会整份交给模型；拉取失败（detail 置空）则中止，不拿旧快照硬评 */
async function beginRemoteReview(mode: AiReviewMode) {
  const sel = selected.value
  if (!sel) return
  // 双重防串（评审 #60）：await 期间用户切换选中项时，①loadDetail 返回的是本次请求
  // 自己的结果（共享 detail 可能已被其他 PR 的请求覆盖）；②返回前复核选中项身份——
  // 用户已切走时中止，绝不以 A 的评审意图拿 B 的 diff 交给模型
  const pr = await loadDetail()
  if (!pr || selected.value !== sel) return
  activeTab.value = 'ai'
  aiPanels.value = ['progress']
  void aiStore.runReview(pr, mode)
}

const { activeGroup } = useReviewGroup()

const flow = useAiReviewFlow({
  aiKey: computed(() =>
    selected.value
      ? aiResultKey(selected.value.platform, selected.value.repo, selected.value.number)
      : '',
  ),
  activeRepoId: computed(() => selected.value?.repo ?? null),
  changedFiles: computed(() => detail.value?.files ?? []),
  reviewTarget: computed(() => detail.value),
  showFilesTab: () => {
    activeTab.value = 'files'
  },
  beginReview: (mode) => beginRemoteReview(mode),
  exportTitle: computed(() =>
    selected.value ? `${selected.value.repo} #${selected.value.number}` : '',
  ),
  exportFilename: computed(() => {
    const sel = selected.value
    if (!sel) return 'ai-review.md'
    return `ai-review-${sel.repo.replace(/[\\/]/g, '-')}-${sel.number}-${dayjs().format('YYYYMMDD-HHmmss')}.md`
  }),
})

const {
  aiReviewing,
  aiPanels,
  aiResult,
  openModeModal,
  detailBodyRef,
  showBackTop,
  onDetailScroll,
  scrollDetailToTop,
  registerFileCard,
} = flow

/** 头部/报告面板共用的发起评审入口：已有结果时切到 AI Tab，否则经模式弹窗发起 */
function startReview(force = false) {
  if (!detail.value) return
  if (!force && aiResult.value) {
    activeTab.value = 'ai'
    return
  }
  openModeModal()
}

/** 回写评论进行中标记：与 acting 互不混用（acting 的动作会触发 loadDetail，回写不需要） */
const writingComment = ref(false)

/** 可回写 = 已选中 PR 且当前有 AI 结果（评审中/无结果时按钮隐藏，面板传参控制显隐） */
const canWriteComment = computed(() => Boolean(selected.value && aiResult.value && !aiReviewing.value))

/** 回写评审汇总评论（R2）：先拉评论列表拿真凭据 → 确认弹窗内嵌评论原文（可编辑）→ 发布/更新。
 *  幂等：有 MergeHub 标记的旧评论原帖更新（不追加刷屏）；找不到标记（首次/被人删除）发布新评论。
 *  弹窗预判必须有真凭据（#31 教训）：弹窗前的列表拉取提供 existingId/truncated，
 *  发布/更新不再是二选一的含糊文案，而是精确状态；
 *  预览可编辑（评审老大 10-19：预览不能改吗）——textarea 双向绑定，确认发出的是编辑后内容；
 *  但首行幂等锚点受保护（readonly 首行提示 + 发出前校验）：锚点被改/删会让下次回写
 *  找不到本条评论而重复发布，破坏幂等 */
async function writeComment() {
  const sel = selected.value
  const result = aiResult.value
  if (!sel || !result || writingComment.value) return
  writingComment.value = true
  let body: string
  let existingId: number | null
  let truncated: boolean
  try {
    body = buildReviewComment({
      repo: sel.repo,
      number: sel.number,
      result,
      pending: flow.pendingStats.value,
    })
    const provider = providers[sel.platform]
    // truncated（评审 #42，#56 收紧为对称中止）：护栏截断且正序下截掉的是最新区间——
    // 不仅「未检索到」不可信（发布必重复），「检索到锚点」同样不可信：命中的可能是
    // 被截掉的更早旧帖，更新它会与截断区间内更新的汇总评论并存、产生双份汇总。
    // 截断时无论是否定位到锚点一律中止，防重复口径对称
    const listed = await provider.listPullRequestComments(
      accountOf(sel.platform),
      sel.repo,
      sel.number,
    )
    truncated = listed.truncated
    existingId = findReviewComment(listed.comments, sel.repo, sel.number)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    return
  } finally {
    writingComment.value = false
  }
  if (truncated) {
    message.error(
      `该 PR 评论数超过翻页上限（最新区间被截断），无法确认检索到的汇总评论是否为最新；为避免重复发布或新旧并存已中止，请先到平台清理历史评论后重试`,
    )
    return
  }
  // 编辑内容用普通变量承载（#57）：Modal.confirm 的 content 是一次性静态 vnode，
  // 不进入 Vue 渲染管线，ref 包装是死响应式——onInput 回写变量 + onOk 读变量即可，
  // 挂 ref 反而暗示「会驱动渲染」误导维护者
  let editableBody = body
  const marker = reviewCommentMarker(sel.repo, sel.number)
  Modal.confirm({
    title: '回写评审意见到平台？',
    content: h('div', { class: 'write-preview' }, [
      h('div', { class: 'write-preview-meta' }, [
        `${sel.repo} #${sel.number}（${PLATFORM_LABELS[sel.platform]}） · `,
        existingId === null
          ? '将发布新评论'
          : `将更新既有汇总评论 #${existingId}`,
      ]),
      h('div', { class: 'write-preview-label' }, '评论内容（Markdown，可直接编辑；首行锚点保证下次不重复发布，请勿修改）：'),
      h('textarea', {
        class: 'write-preview-body',
        value: editableBody,
        onInput: (e: Event) => {
          editableBody = (e.target as HTMLTextAreaElement).value
        },
        spellcheck: false,
      }),
    ]),
    okText: '回写',
    cancelText: '取消',
    width: 640,
    onOk: async () => {
      // 发出前校验幂等锚点（编辑可能误删）：首行必须仍是完整标记，
      // 否则下次回写检索不到本条 → 重复发布
      const finalBody = editableBody
      if (finalBody.split('\n', 1)[0] !== marker) {
        message.error('首行幂等锚点已被修改或删除，无法保证下次不重复发布；请恢复首行原样（或撤销本次回写）')
        return Promise.reject()
      }
      writingComment.value = true
      try {
        const provider = providers[sel.platform]
        const commentId = await provider.upsertPullRequestComment(
          accountOf(sel.platform),
          sel.repo,
          sel.number,
          existingId,
          finalBody,
        )
        message.success(
          existingId === null
            ? `评审意见已回写（评论 #${commentId}）`
            : '评审意见已更新到既有汇总评论',
        )
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      } finally {
        writingComment.value = false
      }
    },
  })
}
</script>

<template>
  <div class="review-page">
    <aside class="review-aside">
      <div class="aside-toolbar">
        <span class="aside-title">远程仓库</span>
        <a-popover
          v-model:open="repoMenuOpen"
          trigger="click"
          placement="bottomRight"
          overlay-class-name="add-repo-popover"
        >
          <template #content>
            <div class="add-repo-form">
              <div class="add-repo-title">添加远程仓库</div>
              <a-segmented
                v-model:value="addPlatform"
                block
                :options="platformSegments"
              />
              <a-input
                v-model:value="addRepoInput"
                placeholder="owner/repo，例如 vuejs/core"
                allow-clear
                @press-enter="confirmAdd"
              />
              <a-button type="primary" block @click="confirmAdd">
                添加仓库
              </a-button>
              <div class="add-repo-hint">
                添加后将自动拉取该仓库处于开启状态的合并请求
              </div>
            </div>
          </template>
          <button
            type="button"
            class="add-btn"
            aria-label="添加远程仓库"
            @click="openAdd"
          >
            <PlusOutlined />
          </button>
        </a-popover>
      </div>
      <div class="aside-segments">
        <a-segmented
          v-model:value="activeGroup"
          block
          :options="reviewGroupOptions"
        />
        <a-segmented
          v-model:value="activePlatform"
          block
          :options="platformSegments"
        />
      </div>
      <div class="aside-body">
        <div v-if="activeRepos.length === 0" class="aside-empty">
          <a-empty
            :image="simpleImage"
            :description="`暂无 ${PLATFORM_LABELS[activePlatform]} 远程仓库`"
            :image-style="{ height: '40px' }"
          >
            <a-button type="primary" size="small" @click="openAdd">
              添加仓库
            </a-button>
          </a-empty>
        </div>
        <div v-else class="repo-list">
          <div
            v-for="repo in activeRepos"
            :key="repo"
            :id="`repo-anchor-${repoKey(activePlatform, repo)}`"
            class="repo-card"
            :class="{ open: openRepos[repoKey(activePlatform, repo)] }"
          >
            <div
              class="repo-head"
              role="button"
              tabindex="0"
              :aria-expanded="
                openRepos[repoKey(activePlatform, repo)] ? 'true' : 'false'
              "
              @click="toggleRepo(activePlatform, repo)"
              @keydown.enter.prevent="toggleRepo(activePlatform, repo)"
              @keydown.space.prevent="toggleRepo(activePlatform, repo)"
            >
              <span class="repo-name" :title="repo">{{ repo }}</span>
              <span
                v-if="repoPrCount(activePlatform, repo) !== null"
                class="repo-count"
              >
                {{ repoPrCount(activePlatform, repo) }}
              </span>
              <RightOutlined class="repo-chevron" />
              <span class="repo-actions">
                <a-tooltip title="刷新请求列表">
                  <a-button
                    type="text"
                    size="small"
                    class="repo-action"
                    @click.stop="reloadRepo(activePlatform, repo)"
                  >
                    <template #icon><ReloadOutlined /></template>
                  </a-button>
                </a-tooltip>
                <a-popconfirm
                  title="移除该远程仓库？"
                  @confirm="removeRepo(activePlatform, repo)"
                >
                  <a-tooltip title="移除远程仓库">
                    <a-button
                      type="text"
                      size="small"
                      danger
                      class="repo-action"
                      @click.stop
                    >
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-tooltip>
                </a-popconfirm>
              </span>
            </div>
            <div
              class="pr-collapse"
              :class="{ open: openRepos[repoKey(activePlatform, repo)] }"
            >
              <div class="pr-collapse-inner">
                <div class="pr-list">
                  <a-spin
                    v-if="prLoading[repoKey(activePlatform, repo)]"
                    size="small"
                    class="pr-loading"
                  />
                  <a-alert
                    v-else-if="prErrors[repoKey(activePlatform, repo)]"
                    type="error"
                    show-icon
                    class="pr-error"
                  >
                    <template #message>
                      <span class="pr-error-text">
                        {{ prErrors[repoKey(activePlatform, repo)] }}
                      </span>
                    </template>
                  </a-alert>
                  <div
                    v-else-if="
                      (prCache[repoKey(activePlatform, repo)] ?? []).length === 0
                    "
                    class="pr-empty"
                  >
                    暂无开启中的请求
                  </div>
                  <div
                    v-for="pr in prCache[repoKey(activePlatform, repo)] ?? []"
                    :key="pr.key"
                    class="pr-item"
                    :class="{
                      active:
                        selected?.platform === activePlatform &&
                        selected?.repo === repo &&
                        selected?.number === pr.number,
                    }"
                    @click="selectPr(activePlatform, repo, pr.number)"
                  >
                    <div class="pr-line">
                      <span class="pr-dot" :class="pr.state" />
                      <span class="pr-no">#{{ pr.number }}</span>
                      <span class="pr-title">{{ pr.title }}</span>
                      <a-tag v-if="pr.fromFork" color="orange" class="pr-fork">
                        fork
                      </a-tag>
                    </div>
                    <div class="pr-sub">
                      {{ pr.sourceBranch }} → {{ pr.targetBranch }} ·
                      {{ pr.author }} · {{ formatTime(pr.updatedAt) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="aside-footer">
        远程仓库 {{ PLATFORMS.reduce((n, p) => n + watchlist.repos[p].length, 0) }}
        个 · 加载 {{ totalPrCount }} 个请求
      </div>
    </aside>

    <main class="review-main">
      <div v-if="!selected" class="review-empty">
        <a-empty description="从左侧选择一个合并请求开始审阅">
          <span class="empty-hint">
            可先点击左上角 ➕ 添加 GitHub / GitLab / Gitee 远程仓库
          </span>
        </a-empty>
      </div>
      <div v-else-if="detailLoading && !detail" class="review-empty">
        <a-spin size="large" tip="正在加载请求详情…" />
      </div>
      <template v-else-if="detail">
        <header class="detail-header">
          <div class="detail-title-row">
            <h3 class="detail-title">{{ detail.title }}</h3>
            <span class="detail-no">#{{ detail.number }}</span>
          </div>
          <div class="detail-meta">
            <a-tag :color="PLATFORM_TAG_COLORS[detail.platform]">
              {{ PLATFORM_LABELS[detail.platform] }}
            </a-tag>
            <a-tag :color="stateMeta[detail.state]?.color ?? 'default'">
              {{ stateMeta[detail.state]?.label ?? detail.state }}
            </a-tag>
            <a-tag v-if="detail.fromFork" color="orange">Fork 请求</a-tag>
            <span class="meta-branches">
              <BranchesOutlined />
              {{ detail.sourceBranch }} → {{ detail.targetBranch }}
            </span>
            <span class="meta-sep">·</span>
            <span>{{ detail.author }}</span>
            <span class="meta-sep">·</span>
            <span>更新于 {{ formatTime(detail.updatedAt) }}</span>
            <span class="detail-stats">
              <span class="stat-add">+{{ detail.additions }}</span>
              <span class="stat-del">-{{ detail.deletions }}</span>
              <span class="stat-files">{{ detail.changedFiles }} 个文件</span>
            </span>
          </div>
          <div class="detail-actions">
            <div class="detail-actions-left">
              <a-button
                size="small"
                :loading="detailLoading"
                @click="loadDetail"
              >
                <template #icon><ReloadOutlined /></template>
                刷新
              </a-button>
              <a-button size="small" @click="openInBrowser">
                <template #icon><ExportOutlined /></template>
                浏览器打开
              </a-button>
            </div>
            <div class="detail-actions-right">
              <template v-if="canAct">
                <a-popconfirm
                  title="通过该合并请求？"
                  ok-text="通过"
                  cancel-text="取消"
                  @confirm="approveDetail"
                >
                  <a-button
                    size="small"
                    :loading="acting === 'approve'"
                    :disabled="acting !== null"
                  >
                    <template #icon><CheckOutlined /></template>
                    通过
                  </a-button>
                </a-popconfirm>
                <a-dropdown-button
                  size="small"
                  type="primary"
                  :loading="acting === 'merge'"
                  :disabled="acting !== null"
                  @click="mergeDetail('merge')"
                >
                  合并
                  <template #overlay>
                    <a-menu @click="onMergeMenu">
                      <a-menu-item key="merge">普通合并 · 生成合并提交</a-menu-item>
                      <a-menu-item key="squash">压缩合并 · 压为一个提交</a-menu-item>
                      <a-menu-item key="rebase">变基合并 · 保持线性历史</a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown-button>
                <a-popconfirm
                  title="关闭该合并请求？"
                  ok-text="关闭"
                  cancel-text="取消"
                  @confirm="closeDetail"
                >
                  <a-button
                    size="small"
                    danger
                    :loading="acting === 'close'"
                    :disabled="acting !== null"
                  >
                    <template #icon><CloseOutlined /></template>
                    关闭
                  </a-button>
                </a-popconfirm>
              </template>
              <a-tooltip title="使用大模型分析 diff 并生成结构化评审意见">
                <a-button
                  size="small"
                  type="primary"
                  ghost
                  :loading="aiReviewing"
                  @click="startReview()"
                >
                  <template #icon><RobotOutlined /></template>
                  AI 评审
                </a-button>
              </a-tooltip>
            </div>
          </div>
        </header>
        <div ref="detailBodyRef" class="detail-body" @scroll="onDetailScroll">
          <a-tabs v-model:active-key="activeTab">
            <a-tab-pane key="files" :tab="`变更文件 (${detail.files.length})`">
              <div class="diff-list">
                <DiffFileCard
                  v-for="f in detail.files"
                  :key="f.path"
                  :ref="(el) => registerFileCard(f.path, el)"
                  :file="f"
                  :platform-label="PLATFORM_LABELS[detail.platform]"
                />
              </div>
            </a-tab-pane>
            <a-tab-pane key="body" tab="描述">
              <pre v-if="detail.body" class="pr-body">{{ detail.body }}</pre>
              <a-empty
                v-else
                :image="simpleImage"
                description="该请求没有填写描述"
              />
            </a-tab-pane>
            <a-tab-pane key="ai" tab="AI 评审">
              <AiReportPanel
                :flow="flow"
                :start-review="startReview"
                :write-comment="canWriteComment ? writeComment : undefined"
                :writing-comment="writingComment"
                empty-text="尚未对该请求进行 AI 评审"
              />
            </a-tab-pane>
          </a-tabs>
        </div>
        <transition name="fade">
          <button
            v-if="showBackTop"
            class="back-top"
            type="button"
            title="回到顶部"
            @click="scrollDetailToTop"
          >
            <VerticalAlignTopOutlined />
          </button>
        </transition>
      </template>
    </main>
    <ReviewModeModal :flow="flow" />
  </div>
</template>

<style scoped>
.pr-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s cubic-bezier(0.2, 0, 0, 1);
}

.pr-collapse.open {
  grid-template-rows: 1fr;
}

.pr-collapse-inner {
  overflow: hidden;
  min-height: 0;
}

.pr-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 10px 10px 30px;
}

.pr-item {
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.pr-item:hover {
  background: #f5f5f5;
}

.pr-item.active {
  background: #e6f4ff;
}

.pr-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.pr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #52c41a;
  box-shadow: 0 0 0 3px rgba(82, 196, 26, 0.15);
}

.pr-dot.closed {
  background: #ff4d4f;
  box-shadow: 0 0 0 3px rgba(255, 77, 79, 0.15);
}

.pr-dot.merged {
  background: #722ed1;
  box-shadow: 0 0 0 3px rgba(114, 46, 209, 0.15);
}

.pr-no {
  color: #8c8c8c;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  flex-shrink: 0;
}

.pr-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pr-fork {
  font-size: 10px;
  line-height: 16px;
  padding: 0 4px;
  margin: 0;
  flex-shrink: 0;
}

.pr-sub {
  margin-top: 3px;
  padding-left: 14px;
  font-size: 12px;
  line-height: 1.4;
  color: #8c8c8c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pr-loading {
  display: block;
  padding: 12px 8px;
}

.pr-error {
  margin: 4px 0;
}

.pr-error-text {
  word-break: break-all;
  font-size: 12px;
}

.pr-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: #8c8c8c;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.pr-body {
  margin: 0;
  padding: 16px;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(0, 0, 0, 0.85);
}

@media (prefers-reduced-motion: reduce) {
  .pr-collapse,
  .pr-item {
    transition: none;
  }
}
</style>

<style>
.add-repo-popover .ant-popover-arrow {
  display: none;
}

.add-repo-popover .ant-popover-inner {
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
}

.add-repo-popover .ant-popover-inner-content {
  padding: 16px;
  width: 296px;
}

.add-repo-popover .seg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.add-repo-popover .seg-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
