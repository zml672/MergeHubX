<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { Empty, message, Modal } from 'ant-design-vue'
import { MessageOutlined } from '@ant-design/icons-vue'
import dayjs from 'dayjs'
import {
  friendlyAiError,
  summarizeGovernanceRules,
  type ReviewCancelHandle,
} from '../../services/ai'
import { httpStreamCancel } from '../../services/http'
import { useAiStore } from '../../stores/ai'
import { useGovernanceIssuesStore } from '../../stores/governanceIssues'
import { useReviewRulesStore } from '../../stores/reviewRules'
import { useLocalReposStore } from '../../stores/localRepos'
import { useWatchlistStore } from '../../stores/watchlist'
import {
  AI_ISSUE_TYPE_META,
  type GovernanceRecord,
  type IssueDisposition,
  type RuleKind,
  type RuleSource,
} from '../../types/ai'
import { PLATFORMS } from '../../types/platform'

const props = defineProps<{ disposition: IssueDisposition }>()

const aiStore = useAiStore()
const governanceStore = useGovernanceIssuesStore()
const rulesStore = useReviewRulesStore()
// 规范沉淀也会写规则集盘（addRule → persist），持久化失败同样提示后果；watch failSeq
// （每次失败自增，连续失败也每次触发）而非布尔标志，与 RuleSets.vue 同一机制
// （覆盖模板内联调用与未来新增 action）
watch(
  () => rulesStore.persistState.failSeq,
  (seq) => {
    if (seq > 0 && !rulesStore.persistState.ok) {
      message.error('规范集保存失败（存储空间不足或访问受限），沉淀的规范刷新后将丢失，请及时导出备份')
    }
  },
)
const watchlist = useWatchlistStore()
const localRepos = useLocalReposStore()
const router = useRouter()

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

/** 双轨文案：豁免=不再报告并从审阅清单隐藏；遵守=保留在清单并沉淀为规范逐条核验 */
const DISPOSITION_META: Record<
  IssueDisposition,
  {
    label: string
    ruleKindText: string
    hint: string
    emptyText: string
    sedimentModalDesc: string
    restoreBatchTip: string
    restoreOneTitle: string
    restoreOneTip: string
    sedimentedClearContent: string
    staleClearContent: string
    clearAllContent: string
  }
> = {
  exempt: {
    label: '豁免',
    ruleKindText: '豁免规则',
    hint:
      '豁免记录按生效范围分组：通用（跨仓库）、各远程/本地仓库、失效（范围已无对应仓库）。' +
      '已提炼的记录已沉淀为豁免规则，AI 评审不再报告；清理已提炼记录只移除豁免屏蔽，不影响规范规则本身。',
    emptyText: '暂无豁免记录',
    sedimentModalDesc: '提炼后将创建豁免规则：AI 评审不再报告与之相同或实质相似的问题。',
    restoreBatchTip: '重新评审时会再次报告。',
    restoreOneTitle: '确认恢复该问题？重新评审时会再次报告。',
    restoreOneTip: '已恢复该问题，重新评审时会再次报告',
    sedimentedClearContent:
      '清理后这些豁免立即失效，对应问题在下次评审时可能重新报告（若对应豁免规则仍启用则不会重复报告）；规范规则与溯源快照不受影响，但豁免列表中将不再保留沉淀痕迹。',
    staleClearContent:
      '失效记录的范围已无对应仓库，在审阅页永远不会显示，清理不影响任何生效中的豁免与规范。',
    clearAllContent: '清空后所有被豁免的问题会重新被报告，此操作不可撤销。',
  },
  comply: {
    label: '遵守',
    ruleKindText: '遵守规范',
    hint:
      '遵守记录按生效范围分组：通用（跨仓库）、各远程/本地仓库、失效（范围已无对应仓库）。' +
      '这些是 AI 报告的有效问题，提炼为遵守规范后 AI 评审将逐条核验；清理已提炼记录只移除沉淀回执，不影响规范规则本身。',
    emptyText: '暂无遵守记录',
    sedimentModalDesc: '提炼后将创建遵守规范：AI 评审时逐条对照 diff 核验，违反项会引用该规范名称。',
    restoreBatchTip: '对应问题恢复为普通问题展示。',
    restoreOneTitle: '确认退出遵守？该问题恢复为普通问题展示。',
    restoreOneTip: '已退出遵守，问题恢复为普通展示',
    sedimentedClearContent:
      '清理后这些记录的沉淀回执立即移除，记录不再保留；对应遵守规范与溯源快照不受影响。',
    staleClearContent:
      '失效记录的范围已无对应仓库，在审阅页永远不会显示，清理不影响任何生效中的遵守与规范。',
    clearAllContent: '清空后所有遵守记录被移除，此操作不可撤销。',
  },
}

/** 当前处置的文案集合 */
const meta = computed(() => DISPOSITION_META[props.disposition])

/** 记录范围分类：general=通用层；remote/local=当前可达仓库；stale=失效（范围无对应仓库，审阅页不可见） */
type ScopeKind = 'general' | 'remote' | 'local' | 'stale'

/** 管理页行视图：范围分类、标签、展示文案与沉淀状态预构造完成，模板零类型分支 */
interface GovernanceRow {
  key: string
  scope: string
  scopeKind: ScopeKind
  scopeText: string
  fileText: string
  typeLabel: string
  typeColor: string
  comment: string
  reason: string
  fingerprint: string
  timeText: string
  sedimented: boolean
  sedimentRuleName: string
  sedimentTimeText: string
}

/** 分组视图：按生效范围归类，组头显示范围标识与条数，可折叠 */
interface RecordGroup {
  key: string
  kindLabel: string
  kindColor: string
  label: string
  rows: GovernanceRow[]
}

/** 当前处置的治理记录行视图：scope 落在当前远程仓库与本地仓库之外的均归为失效 */
const rows = computed<GovernanceRow[]>(() => {
  const remoteIds = new Set(PLATFORMS.flatMap((p) => watchlist.repos[p]))
  const localPaths = new Set(localRepos.repos.map((r) => r.path))
  return [...governanceStore.records]
    .filter((r) => r.disposition === props.disposition)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .map((r: GovernanceRecord) => {
      let scopeKind: ScopeKind
      if (r.scope === 'general') {
        scopeKind = 'general'
      } else if (remoteIds.has(r.scope)) {
        scopeKind = 'remote'
      } else if (localPaths.has(r.scope)) {
        scopeKind = 'local'
      } else {
        scopeKind = 'stale'
      }
      const typeMeta = AI_ISSUE_TYPE_META[r.type]
      const sediment = r.sedimentedTo
      return {
        key: r.id,
        scope: r.scope,
        scopeKind,
        scopeText: r.scope === 'general' ? '跨仓库生效' : r.scope,
        fileText: r.line > 0 ? `${r.file}:${r.line}` : r.file,
        typeLabel: typeMeta?.label ?? r.type,
        typeColor: typeMeta?.color ?? 'default',
        comment: r.comment,
        reason: r.reason ?? '',
        fingerprint: r.fingerprint,
        timeText: dayjs(r.recordedAt).format('YYYY-MM-DD HH:mm'),
        sedimented: Boolean(sediment),
        sedimentRuleName: sediment?.ruleName ?? '',
        sedimentTimeText: sediment ? dayjs(sediment.at).format('YYYY-MM-DD HH:mm') : '',
      }
    })
})

/** 分组顺序：通用 → 各远程仓库（关注清单顺序）→ 各本地仓库（清单顺序）→ 失效兜底；空组不显示 */
const groups = computed<RecordGroup[]>(() => {
  const remoteOrder = PLATFORMS.flatMap((p) => watchlist.repos[p])
  const localOrder = localRepos.repos.map((r) => r.path)
  // 单遍分桶后按既定顺序取桶，避免逐组全量 filter
  const generalRows: GovernanceRow[] = []
  const staleRows: GovernanceRow[] = []
  const remoteBuckets = new Map<string, GovernanceRow[]>()
  const localBuckets = new Map<string, GovernanceRow[]>()
  for (const row of rows.value) {
    if (row.scopeKind === 'general') {
      generalRows.push(row)
    } else if (row.scopeKind === 'stale') {
      staleRows.push(row)
    } else if (row.scopeKind === 'remote') {
      const list = remoteBuckets.get(row.scope) ?? []
      list.push(row)
      remoteBuckets.set(row.scope, list)
    } else {
      const list = localBuckets.get(row.scope) ?? []
      list.push(row)
      localBuckets.set(row.scope, list)
    }
  }
  const result: RecordGroup[] = []
  if (generalRows.length > 0) {
    result.push({ key: 'general', kindLabel: '通用', kindColor: 'green', label: '跨仓库生效', rows: generalRows })
  }
  for (const repoId of remoteOrder) {
    const list = remoteBuckets.get(repoId)
    if (list && list.length > 0) {
      result.push({ key: `remote:${repoId}`, kindLabel: '远程', kindColor: 'blue', label: repoId, rows: list })
    }
  }
  for (const path of localOrder) {
    const list = localBuckets.get(path)
    if (list && list.length > 0) {
      result.push({ key: `local:${path}`, kindLabel: '本地', kindColor: 'cyan', label: path, rows: list })
    }
  }
  if (staleRows.length > 0) {
    result.push({ key: 'stale', kindLabel: '失效', kindColor: 'red', label: '范围已无对应仓库', rows: staleRows })
  }
  return result
})

const totalCount = computed(() => rows.value.length)
const sedimentedCount = computed(() => rows.value.filter((r) => r.sedimented).length)
const staleCount = computed(() => rows.value.filter((r) => r.scopeKind === 'stale').length)

/** 折叠的分组 key */
const collapsedKeys = ref<string[]>([])

/** 展开详情的记录 id */
const expandedIds = ref<string[]>([])

/** 受控列表切换：存在即移除、不存在即追加（分组折叠与行展开共用） */
function toggleInList(list: Ref<string[]>, key: string): void {
  list.value = list.value.includes(key)
    ? list.value.filter((k) => k !== key)
    : [...list.value, key]
}

function isCollapsed(key: string): boolean {
  return collapsedKeys.value.includes(key)
}

function toggleGroup(key: string): void {
  toggleInList(collapsedKeys, key)
}

function isExpanded(key: string): boolean {
  return expandedIds.value.includes(key)
}

function toggleExpand(key: string): void {
  toggleInList(expandedIds, key)
}

/** 勾选的记录 id */
const checkedIds = ref<string[]>([])
/** 重新提炼覆盖勾选集前的快照：弹窗关闭时还原用户原勾选，避免临时预勾选残留为批量操作的选择集；提交成功路径主动丢弃 */
let checkedIdsBeforeResediment: string[] | null = null

/** 勾选集合视图：模板与全选判断 O(1) 命中，避免逐行线性扫描 */
const checkedIdSet = computed(() => new Set(checkedIds.value))

/** 单行勾选/取消：使用 checkbox 事件的真实目标态，不依赖对当前状态取反推断 */
function toggleRow(id: string, checked: boolean) {
  if (checked) checkedIds.value = [...checkedIds.value, id]
  else checkedIds.value = checkedIds.value.filter((x) => x !== id)
}

/** 行勾选：直接读事件真实值，避免对当前状态取反推断导致视觉与状态短暂不一致时勾选反向 */
function onRowToggle(id: string, e: { target: { checked: boolean } }): void {
  toggleRow(id, e.target.checked)
}

/** 全选/取消全选全部记录（跨分组） */
function onToggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  checkedIds.value = checked ? rows.value.map((r) => r.key) : []
}

/** 是否已全选 */
const allChecked = computed(
  () => rows.value.length > 0 && rows.value.every((r) => checkedIdSet.value.has(r.key)),
)

/** 是否部分选中（半选态） */
const someChecked = computed(() => {
  const count = rows.value.filter((r) => checkedIdSet.value.has(r.key)).length
  return count > 0 && count < rows.value.length
})

/** 双轨复用同一组件实例：处置切换后清空勾选/展开/折叠状态，避免残留勾选误操作另一处置的记录 */
watch(
  () => props.disposition,
  () => {
    checkedIds.value = []
    expandedIds.value = []
    collapsedKeys.value = []
  },
)

/** 记录变动后同步清理勾选与展开态中已消失的 id */
function pruneChecked() {
  const validIds = new Set(governanceStore.records.map((r) => r.id))
  checkedIds.value = checkedIds.value.filter((id) => validIds.has(id))
  expandedIds.value = expandedIds.value.filter((id) => validIds.has(id))
}

function restoreOne(id: string) {
  governanceStore.restore(id)
  pruneChecked()
  message.success(meta.value.restoreOneTip)
}

function restoreChecked() {
  const ids = [...checkedIds.value]
  if (ids.length === 0) return
  governanceStore.restoreMany(ids)
  pruneChecked()
  message.success(`已恢复 ${ids.length} 条${meta.value.label}记录`)
}

/** 清理已提炼记录（折叠在批量操作中）：移除豁免屏蔽或沉淀回执，规则与溯源快照不受影响 */
function confirmClearSedimented() {
  const ids = rows.value.filter((r) => r.sedimented).map((r) => r.key)
  if (ids.length === 0) return
  Modal.confirm({
    title: `清理 ${ids.length} 条已提炼的${meta.value.label}记录？`,
    content: meta.value.sedimentedClearContent,
    okText: '清理',
    okType: 'danger',
    cancelText: '取消',
    onOk: () => {
      governanceStore.restoreMany(ids)
      pruneChecked()
      message.success(`已清理 ${ids.length} 条已提炼记录`)
    },
  })
}

function confirmClearStale() {
  const ids = rows.value.filter((r) => r.scopeKind === 'stale').map((r) => r.key)
  if (ids.length === 0) return
  Modal.confirm({
    title: `清理 ${ids.length} 条失效记录？`,
    content: meta.value.staleClearContent,
    okText: '清理',
    okType: 'danger',
    cancelText: '取消',
    onOk: () => {
      governanceStore.restoreMany(ids)
      pruneChecked()
      message.success(`已清理 ${ids.length} 条失效记录`)
    },
  })
}

function confirmClearAll() {
  const count = totalCount.value
  if (count === 0) return
  Modal.confirm({
    title: `清空全部 ${count} 条${meta.value.label}记录？`,
    content: meta.value.clearAllContent,
    okText: '清空',
    okType: 'danger',
    cancelText: '取消',
    onOk: () => {
      governanceStore.restoreMany(rows.value.map((r) => r.key))
      checkedIds.value = []
      expandedIds.value = []
      message.success(`已清空全部 ${count} 条${meta.value.label}记录`)
    },
  })
}

/** 勾选的原始记录（含已提炼，支持重新提炼另存）：提炼按钮计数与弹窗固化共用 */
const sedimentCandidates = computed(() =>
  governanceStore.records.filter(
    (r) => r.disposition === props.disposition && checkedIdSet.value.has(r.id),
  ),
)

/** 提炼弹窗打开时固化的记录 id：避免弹窗期间勾选变动导致请求与提交不一致 */
const sedimentPickIds = ref<string[]>([])

const sedimentModalOpen = ref(false)
/** 提炼会话序号：弹窗关闭或重新发起即递增，旧会话的回调与结果据此全部失效，防止跨会话串扰 */
let sedimentSession = 0
/** 当前提炼流对应的取消句柄：弹窗关闭时置位并通知 Rust 侧中止请求 */
let activeSedimentCancel: ReviewCancelHandle | null = null
const sedimentForm = reactive({ setId: '', name: '' })
/** 弹窗内各记录的评论草稿（按记录 id）：随提炼请求提交给 AI，落库时存入溯源快照 */
const sedimentNotes = reactive<Record<string, string>>({})
/** 当前展开评论框的记录 id：默认全部收起，点「评论」按需展开，失焦自动收起 */
const noteEditingId = ref<string | null>(null)
/** 展开中的评论框实例：用于展开后自动聚焦 */
const noteInputRef = ref<{ focus: () => void } | null>(null)
/** AI 提炼请求进行中 */
const summarizing = ref(false)
/** AI 提炼结果：content 只读预览，title 回填名称框供微调 */
const sedimentResult = ref<{ title: string; content: string } | null>(null)

/** 提炼实时进度：已收字数与尽力提取的规则正文片段 */
const summaryProgress = ref({ answerChars: 0, reasoningChars: 0, contentText: '' })
/** 已用时（毫秒）：提炼开始起每 100ms 步进，结束即停 */
const summaryElapsedMs = ref(0)
let summaryTimer: ReturnType<typeof setInterval> | null = null
/** 实时预览滚动容器：跟随最新输出自动滚底 */
const progressPreRef = ref<HTMLElement | null>(null)
/** 预览是否跟随滚底：用户上滚离开底部即暂停跟随，滚回底部恢复 */
const previewFollow = ref(true)

function startSummaryTimer() {
  stopSummaryTimer()
  summaryElapsedMs.value = 0
  summaryProgress.value = { answerChars: 0, reasoningChars: 0, contentText: '' }
  previewFollow.value = true
  summaryTimer = setInterval(() => {
    summaryElapsedMs.value += 100
  }, 100)
}

function stopSummaryTimer() {
  if (summaryTimer) {
    clearInterval(summaryTimer)
    summaryTimer = null
  }
}

function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 100) / 10
  if (totalSecs < 60) return `${totalSecs.toFixed(1)} 秒`
  let mins = Math.floor(totalSecs / 60)
  let secs = Math.round(totalSecs - mins * 60)
  if (secs === 60) {
    mins += 1
    secs = 0
  }
  return `${mins} 分 ${secs} 秒`
}

/** 预览手动滚动：判断是否仍贴着底部，决定是否继续自动滚底 */
function onPreviewScroll(e: Event) {
  const el = e.target as HTMLElement
  previewFollow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => summaryProgress.value.contentText,
  async () => {
    if (!previewFollow.value) return
    await nextTick()
    const el = progressPreRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

/** 弹窗固化的记录明细（含已提炼：确认后另存为新规则，旧规则需手动清理） */
const sedimentPicked = computed(() => {
  const pickSet = new Set(sedimentPickIds.value)
  return governanceStore.records.filter((r) => pickSet.has(r.id))
})

/** 弹窗内已提炼的记录数：>0 时显示另存警示，成功后提示清理旧规则 */
const resedimentCount = computed(
  () => sedimentPicked.value.filter((r) => r.sedimentedTo).length,
)

const typeLabel = (type: GovernanceRecord['type']) => AI_ISSUE_TYPE_META[type]?.label ?? type

/** 展开/收起某条记录的评论框：同时只展开一条，再次点击收起 */
function toggleNoteEditor(id: string) {
  noteEditingId.value = noteEditingId.value === id ? null : id
}

/** 评论框失焦即收起：仅隐藏输入框，草稿仍保留在 sedimentNotes 并亮起「已有评论」提示 */
function collapseNoteEditor() {
  noteEditingId.value = null
}

/** 评论框挂载后自动聚焦，省一次点击 */
function setNoteRef(el: unknown) {
  noteInputRef.value = (el as { focus: () => void } | null) ?? null
}

watch(noteEditingId, async (id) => {
  if (!id) return
  await nextTick()
  noteInputRef.value?.focus()
})

function openSediment() {
  const picked = sedimentCandidates.value
  if (picked.length === 0) return
  sedimentPickIds.value = picked.map((r) => r.id)
  sedimentForm.setId = rulesStore.activeSetId
  sedimentForm.name = ''
  sedimentResult.value = null
  noteEditingId.value = null
  sedimentModalOpen.value = true
}

/** 从行详情发起重新提炼：预勾选沉淀到同一规则的全部源记录，保证新规则覆盖完整来源；覆盖前快照用户原勾选，弹窗关闭时还原 */
function openResediment(id: string) {
  const record = governanceStore.records.find((r) => r.id === id)
  if (!record) return
  const ruleId = record.sedimentedTo?.ruleId
  checkedIdsBeforeResediment = checkedIds.value
  checkedIds.value = ruleId
    ? governanceStore.records.filter((r) => r.sedimentedTo?.ruleId === ruleId).map((r) => r.id)
    : [id]
  openSediment()
}

/** 作废当前提炼会话：递增序号使旧回调失效，并置位取消句柄、通知 Rust 中止流（弹窗关闭与组件卸载共用） */
function invalidateSedimentSession() {
  sedimentSession += 1
  const cancel = activeSedimentCancel
  if (cancel && !cancel.cancelled) {
    cancel.cancelled = true
    void httpStreamCancel(cancel.requestId).catch(() => {})
  }
  activeSedimentCancel = null
}

/** 弹窗关闭后作废提炼会话，再清空评论草稿与提炼结果，避免旧会话串扰或下次打开残留 */
watch(sedimentModalOpen, (open) => {
  if (open) return
  invalidateSedimentSession()
  sedimentPickIds.value = []
  sedimentResult.value = null
  summarizing.value = false
  stopSummaryTimer()
  noteEditingId.value = null
  // 重新提炼曾覆盖勾选集时还原用户原勾选（提交成功路径已丢弃快照，不影响其勾选集消费语义）
  if (checkedIdsBeforeResediment) {
    checkedIds.value = checkedIdsBeforeResediment
    checkedIdsBeforeResediment = null
  }
  for (const key of Object.keys(sedimentNotes)) delete sedimentNotes[key]
})

/** 组件卸载兜底：提炼进行中直接导航离开时清理计时器并中止进行中的提炼流，避免定时器泄漏与后台空耗 API 配额 */
onUnmounted(() => {
  invalidateSedimentSession()
  stopSummaryTimer()
})

/** 调 AI 把勾选记录连同评论归纳为一条规则，结果回填预览区；会话失效（弹窗关闭或已重开）则丢弃结果 */
async function runSummarize() {
  const picked = sedimentPicked.value
  if (picked.length === 0 || summarizing.value) return
  if (!aiStore.configReady) {
    message.warning('请先在设置中配置 AI 模型')
    return
  }
  const session = ++sedimentSession
  const cancel: ReviewCancelHandle = {
    requestId: `sediment_${Date.now().toString(36)}`,
    cancelled: false,
  }
  activeSedimentCancel = cancel
  summarizing.value = true
  startSummaryTimer()
  try {
    const repos = [...new Set(picked.map((r) => r.scope))].join('、')
    const result = await summarizeGovernanceRules(
      aiStore.modelConfig(),
      props.disposition,
      repos,
      picked.map((r) => {
        const note = sedimentNotes[r.id]?.trim()
        return {
          file: r.file,
          line: r.line,
          type: r.type,
          comment: r.comment,
          ...(note ? { note } : {}),
        }
      }),
      (p) => {
        if (session === sedimentSession && sedimentModalOpen.value) summaryProgress.value = p
      },
      cancel,
    )
    if (session !== sedimentSession || !sedimentModalOpen.value) return
    sedimentForm.name = result.title
    sedimentResult.value = result
  } catch (e) {
    if (session === sedimentSession && sedimentModalOpen.value) {
      // 重新提炼失败时保留上一次结果：清空会使「确认提炼」不可用，逼用户整次重试
      message.error(friendlyAiError(e) || 'AI 提炼失败，请重试')
    }
  } finally {
    // 计时器归属当前会话时才停表：旧请求的 finally 若无条件清理，会冻住用户重开弹窗后新会话的用时统计（弹窗关闭与卸载路径已各自无条件停表，此处守卫不产生泄漏）
    if (session === sedimentSession) stopSummaryTimer()
    if (activeSedimentCancel === cancel) activeSedimentCancel = null
    if (session === sedimentSession) summarizing.value = false
  }
}

/** 提炼落库：以 AI 提炼结果创建规范规则（带溯源快照与评论留档）并回写沉淀回执 */
function submitSediment() {
  const picked = sedimentPicked.value
  if (picked.length === 0) {
    sedimentModalOpen.value = false
    return
  }
  const name = sedimentForm.name.trim()
  if (!name) {
    message.warning('规范名称不能为空')
    return
  }
  if (!sedimentForm.setId) {
    message.warning('请选择目标规范集')
    return
  }
  const content = sedimentResult.value?.content
  if (!content) {
    message.warning('请先完成 AI 提炼')
    return
  }
  // markSedimented 会回写沉淀回执，resedimentCount 须在此之前快照，否则成功提示恒判定为重新提炼
  const hasResediment = resedimentCount.value > 0
  const kind: RuleKind = props.disposition === 'exempt' ? 'exemption' : 'standard'
  const source: RuleSource = {
    kind: props.disposition === 'exempt' ? 'exempt-sediment' : 'comply-sediment',
    items: picked.map((r) => {
      const note = sedimentNotes[r.id]?.trim()
      return {
        scope: r.scope,
        file: r.file,
        line: r.line,
        type: r.type,
        comment: r.comment,
        recordedAt: r.recordedAt,
        ...(note ? { note } : {}),
      }
    }),
    createdAt: Date.now(),
  }
  const rule = rulesStore.addRule(sedimentForm.setId, name, content, kind, source)
  governanceStore.markSedimented(picked.map((r) => r.id), rule.id, rule.name)
  const pickIdSet = new Set(picked.map((r) => r.id))
  checkedIds.value = checkedIds.value.filter((id) => !pickIdSet.has(id))
  // 重新提炼成功即用户意图已被新流程取代：丢弃勾选快照，保留剔除已归档记录后的勾选状态
  checkedIdsBeforeResediment = null
  sedimentModalOpen.value = false
  message.success(
    `已提炼为${meta.value.ruleKindText}「${rule.name}」，${picked.length} 条记录已归档` +
      (hasResediment ? '；已另存为新规则，请清理旧规则避免重复' : ''),
    5,
  )
}

/** 跳转规范集视图查看沉淀结果 */
function goRules(): void {
  router.replace({ query: { view: 'rules' } })
}
</script>

<template>
  <div>
    <p class="records-hint">{{ meta.hint }}</p>

    <div class="records-toolbar">
      <a-checkbox
        :checked="allChecked"
        :indeterminate="someChecked"
        :disabled="rows.length === 0"
        @change="onToggleAll"
      >
        全选
      </a-checkbox>
      <div class="toolbar-ops">
        <a-button
          v-if="sedimentCandidates.length > 0"
          size="small"
          type="primary"
          @click="openSediment"
        >
          提炼为{{ meta.ruleKindText }}（{{ sedimentCandidates.length }}）
        </a-button>
        <a-popconfirm
          v-if="checkedIds.length > 0"
          :title="`确认恢复所选 ${checkedIds.length} 条记录？${meta.restoreBatchTip}`"
          ok-text="恢复"
          cancel-text="取消"
          @confirm="restoreChecked"
        >
          <a-button size="small" danger>恢复所选（{{ checkedIds.length }}）</a-button>
        </a-popconfirm>
        <a-dropdown :disabled="totalCount === 0">
          <a-button size="small">更多操作</a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="sedimented" :disabled="sedimentedCount === 0" @click="confirmClearSedimented">
                清理已提炼（{{ sedimentedCount }}）
              </a-menu-item>
              <a-menu-item key="stale" :disabled="staleCount === 0" @click="confirmClearStale">
                清理失效（{{ staleCount }}）
              </a-menu-item>
              <a-menu-divider />
              <a-menu-item key="all" danger :disabled="totalCount === 0" @click="confirmClearAll">
                清空全部（{{ totalCount }}）
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
    </div>

    <a-empty
      v-if="groups.length === 0"
      :image="simpleImage"
      :description="meta.emptyText"
      :image-style="{ height: '48px' }"
    />
    <div v-else class="records-groups">
      <section v-for="group in groups" :key="group.key" class="records-group">
        <div class="group-head" @click="toggleGroup(group.key)">
          <span class="group-arrow" :class="{ collapsed: isCollapsed(group.key) }">▶</span>
          <a-tag :color="group.kindColor" class="group-kind">{{ group.kindLabel }}</a-tag>
          <span class="group-label" :title="group.label">{{ group.label }}</span>
          <span class="group-count">{{ group.rows.length }} 条</span>
        </div>
        <div v-if="!isCollapsed(group.key)" class="group-rows">
          <div
            v-for="row in group.rows"
            :key="row.key"
            class="records-row"
            :class="{ checked: checkedIdSet.has(row.key) }"
          >
            <div class="row-head">
              <a-checkbox
                :checked="checkedIdSet.has(row.key)"
                @change="onRowToggle(row.key, $event)"
              />
              <div class="row-main" @click="toggleExpand(row.key)">
                <div class="row-line1">
                  <span class="row-file" :title="row.fileText">{{ row.fileText }}</span>
                  <a-tag v-if="row.sedimented" color="success" class="row-sediment">已提炼</a-tag>
                </div>
                <div class="row-comment" :title="row.comment">{{ row.comment }}</div>
              </div>
              <a-tag :color="row.typeColor" class="row-type">{{ row.typeLabel }}</a-tag>
              <span class="row-time">{{ row.timeText }}</span>
              <a-button size="small" type="text" class="row-expand" @click="toggleExpand(row.key)">
                {{ isExpanded(row.key) ? '收起' : '详情' }}
              </a-button>
              <a-popconfirm
                :title="meta.restoreOneTitle"
                ok-text="恢复"
                cancel-text="取消"
                @confirm="restoreOne(row.key)"
              >
                <a-button size="small">恢复</a-button>
              </a-popconfirm>
            </div>
            <div v-if="isExpanded(row.key)" class="row-detail">
              <div class="detail-item">
                <span class="detail-label">生效范围</span>
                <span class="detail-value">{{ row.scopeText }}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">问题描述</span>
                <span class="detail-value">{{ row.comment }}</span>
              </div>
              <div v-if="row.reason" class="detail-item">
                <span class="detail-label">处置理由</span>
                <span class="detail-value">{{ row.reason }}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">记录时间</span>
                <span class="detail-value">{{ row.timeText }}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">记录指纹</span>
                <code class="detail-fingerprint">{{ row.fingerprint }}</code>
              </div>
              <div v-if="row.sedimented" class="detail-item">
                <span class="detail-label">沉淀状态</span>
                <span class="detail-value">
                  已提炼为{{ meta.ruleKindText }}「{{ row.sedimentRuleName }}」· {{ row.sedimentTimeText }}
                  <a class="detail-link" @click="openResediment(row.key)">重新提炼</a>
                  <a class="detail-link" @click="goRules">去规范集中查看</a>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <a-modal
      v-model:open="sedimentModalOpen"
      :title="`AI 提炼为${meta.ruleKindText}`"
      :width="680"
      cancel-text="取消"
    >
      <a-alert class="sediment-desc" type="info" show-icon :message="meta.sedimentModalDesc" />
      <a-alert
        v-if="resedimentCount > 0"
        class="sediment-desc"
        type="warning"
        show-icon
        :message="`其中 ${resedimentCount} 条此前已提炼过：确认后将另存为新规则，旧规则不会自动更新，请自行清理旧规则避免重复生效`"
      />
      <a-form layout="vertical">
        <a-form-item label="目标规范集" required>
          <a-select v-model:value="sedimentForm.setId">
            <a-select-option v-for="s in rulesStore.sets" :key="s.id" :value="s.id">
              {{ s.name }}（{{ s.rules.length }} 条规范）
            </a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
      <div class="sediment-section-title">
        勾选记录（{{ sedimentPicked.length }} 条），点「评论」可为单条补充团队判断
      </div>
      <div class="sediment-list">
        <div v-for="(r, idx) in sedimentPicked" :key="r.id" class="sediment-item">
          <div class="sediment-item-head">
            <span class="sediment-item-index">{{ idx + 1 }}</span>
            <a-tag :color="AI_ISSUE_TYPE_META[r.type]?.color" class="sediment-item-tag">
              {{ typeLabel(r.type) }}
            </a-tag>
            <span class="sediment-item-loc" :title="`${r.file}:${r.line}`">
              {{ r.file }}:{{ r.line }}
            </span>
            <a-tag v-if="r.sedimentedTo" color="orange" class="sediment-item-flag">已提炼</a-tag>
            <button
              type="button"
              class="sediment-note-trigger"
              :class="{ 'has-note': Boolean(sedimentNotes[r.id]?.trim()) }"
              :title="sedimentNotes[r.id]?.trim() || '写评论引导 AI 提炼'"
              @click="toggleNoteEditor(r.id)"
            >
              <MessageOutlined />
              {{ sedimentNotes[r.id]?.trim() ? '已有评论' : '评论' }}
            </button>
          </div>
          <div class="sediment-item-desc" :title="r.comment">{{ r.comment }}</div>
          <a-textarea
            v-if="noteEditingId === r.id"
            :ref="setNoteRef"
            v-model:value="sedimentNotes[r.id]"
            class="sediment-note-input"
            :auto-size="{ minRows: 2, maxRows: 4 }"
            placeholder="我的评论（可选）：补充团队判断，AI 会结合评论提炼；失焦自动收起"
            @blur="collapseNoteEditor"
          />
        </div>
      </div>
      <div class="sediment-section-title">AI 提炼结果</div>
      <template v-if="summarizing">
        <div class="summary-progress">
          <div class="summary-progress-meta">
            <span>已用时 {{ formatElapsed(summaryElapsedMs) }}</span>
            <span>已接收 {{ summaryProgress.answerChars }} 字</span>
            <span v-if="summaryProgress.reasoningChars > 0">
              思考链 {{ summaryProgress.reasoningChars }} 字
            </span>
            <span v-if="!previewFollow" class="summary-progress-hint">已暂停跟随，滚回底部恢复</span>
          </div>
          <pre
            ref="progressPreRef"
            class="summary-progress-preview"
            @scroll="onPreviewScroll"
            >{{ summaryProgress.contentText || '正在生成规则内容…' }}</pre
          >
        </div>
      </template>
      <template v-else-if="sedimentResult">
        <a-form layout="vertical">
          <a-form-item label="规范名称" required>
            <a-input
              v-model:value="sedimentForm.name"
              placeholder="AI 已回填，可微调"
              allow-clear
            />
          </a-form-item>
        </a-form>
        <pre class="sediment-preview">{{ sedimentResult.content }}</pre>
      </template>
      <div v-else class="sediment-empty">尚未提炼：点击下方「AI 提炼」生成规则草稿</div>
      <template #footer>
        <a-button @click="sedimentModalOpen = false">取消</a-button>
        <a-button :loading="summarizing" @click="runSummarize">
          {{ sedimentResult ? '重新提炼' : 'AI 提炼' }}
        </a-button>
        <a-button type="primary" :disabled="!sedimentResult || summarizing" @click="submitSediment">
          确认提炼
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.records-hint {
  padding-top: 12px;
  margin: 0 0 12px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.6;
}

.records-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 -20px 12px;
  padding: 4px 20px 8px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}

.toolbar-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.records-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.records-group {
  overflow: hidden;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.02);
  user-select: none;
}

.group-head:hover {
  background: rgba(0, 0, 0, 0.04);
}

.group-arrow {
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 10px;
  transform: rotate(90deg);
  transition: transform 0.2s;
}

.group-arrow.collapsed {
  transform: rotate(0deg);
}

.group-kind {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.group-count {
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.group-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.records-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
}

.records-row.checked {
  border-color: rgba(22, 119, 255, 0.45);
  background: rgba(22, 119, 255, 0.04);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.row-head :deep(.ant-checkbox-wrapper) {
  flex-shrink: 0;
}

.row-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.row-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row-file {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-sediment {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.row-comment {
  overflow: hidden;
  margin-top: 2px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-type {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.row-time {
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.row-expand {
  flex-shrink: 0;
  padding-inline: 4px;
}

.row-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px dashed rgba(5, 5, 5, 0.1);
  background: rgba(0, 0, 0, 0.02);
  border-radius: 6px;
}

.detail-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.detail-label {
  flex-shrink: 0;
  width: 60px;
  color: rgba(0, 0, 0, 0.45);
}

.detail-value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.detail-fingerprint {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  color: rgba(0, 0, 0, 0.65);
  font-size: 11px;
  word-break: break-all;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
}

.detail-link {
  margin-left: 8px;
}

.sediment-desc {
  margin-bottom: 16px;
}

.sediment-desc :deep(.ant-alert-message) {
  font-size: 12px;
}

.sediment-section-title {
  margin: 12px 0 8px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.sediment-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
}

.sediment-item {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}

.sediment-item:hover {
  border-color: #d9d9d9;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.sediment-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sediment-item-index {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.45);
  font-size: 11px;
  line-height: 1;
}

.sediment-item-tag {
  flex: none;
  margin-inline-end: 0;
}

.sediment-item-loc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}

.sediment-note-trigger {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
  transition:
    color 0.2s,
    background-color 0.2s;
}

.sediment-note-trigger:hover {
  color: #1677ff;
  background: rgba(22, 119, 255, 0.06);
}

.sediment-note-trigger.has-note {
  color: #1677ff;
}

.sediment-item-desc {
  margin-top: 6px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.sediment-note-input {
  margin-top: 8px;
}

.sediment-item-flag {
  flex: none;
  margin-inline-end: 0;
}

.summary-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-progress-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.summary-progress-hint {
  color: #faad14;
}

.summary-progress-preview {
  margin: 0;
  padding: 10px 12px;
  height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
  line-height: 1.6;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.sediment-preview {
  margin: 0;
  padding: 12px;
  max-height: 280px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.sediment-empty {
  padding: 24px 0;
  text-align: center;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
</style>
