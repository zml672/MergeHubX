import { computed, nextTick, ref, watch } from 'vue'
import type { ComputedRef } from 'vue'
import { message } from 'ant-design-vue'
import dayjs from 'dayjs'
import { estimateReviewPlan } from '../services/ai'
import type { AiReviewMode } from '../services/ai'
import { formatChars, formatDuration, useAiStore } from '../stores/ai'
import { useGovernanceIssuesStore } from '../stores/governanceIssues'
import { issueFingerprint } from '../utils/issueFingerprint'
import { useUiStore } from '../stores/ui'
import type {
  AiIssue,
  AiIssueSeverity,
  AiIssueStatus,
  AiReviewResult,
  AiReviewStep,
  AiReviewStepStatus,
  GovernanceRecord,
  IssueDisposition,
} from '../types/ai'
import type { DiffFile, PullRequestDetail } from '../types/platform'

/** AI 评审流程的数据源：行为在 composable 内共用，「当前评审的是谁」由各视图注入 */
export interface AiReviewFlowSource {
  /** 当前评审对象的 AI 结果 key（本地=localResultKey(路径)，远程=aiResultKey(...)），空串表示未选中 */
  aiKey: ComputedRef<string>
  /** 当前生效仓库标识：本地用仓库路径，远程用 owner/repo；豁免屏蔽与规则沉淀共用该定义 */
  activeRepoId: ComputedRef<string | null>
  /** 本次评审覆盖的变更文件（本地=工作区变更，远程=PR diff 文件，两者结构同构） */
  changedFiles: ComputedRef<DiffFile[]>
  /** 当前评审对象（本地=工作区包装的伪 PR，远程=PR 详情），用于模式弹窗的批次预估 */
  reviewTarget: ComputedRef<PullRequestDetail | null>
  /** 切到变更文件 Tab（问题定位跳转用，各视图 Tab 结构不同） */
  showFilesTab: () => void
  /** 弹窗确认后真正发起评审（各视图差异点：本地 runLocalReview / 远程 runReview） */
  beginReview: (mode: AiReviewMode) => void
  /** 导出报告标题（本地=「xxx（工作区变更）」，远程=「owner/repo #N」） */
  exportTitle: ComputedRef<string>
  /** 导出报告默认文件名 */
  exportFilename: ComputedRef<string>
}

export type AiReviewFlow = ReturnType<typeof useAiReviewFlow>

export type SeverityFilterValue = 'all' | 'high' | 'medium' | 'low'

export const severityOptions: { value: SeverityFilterValue; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'high', label: '严重' },
  { value: 'medium', label: '一般' },
  { value: 'low', label: '轻微' },
]

export const PREV_STATUS_META: Record<AiIssueStatus, { color: string; label: string }> = {
  fixed: { color: 'success', label: '已修复' },
  partial: { color: 'warning', label: '部分修复' },
  not_fixed: { color: 'error', label: '未修复' },
}

/** 严重度风险权重：high=3 / medium=2 / low=1，与摘要统计、问题分组、导出 Markdown 三处共用同一口径 */
export const SEVERITY_WEIGHT: Record<AiIssueSeverity, number> = { high: 3, medium: 2, low: 1 }

/** 文件组风险排序：先比组内最高严重度（含严重问题的文件整体靠前），同档再比风险总分 */
export function compareGroupRisk(
  a: { maxWeight: number; score: number },
  b: { maxWeight: number; score: number },
) {
  return b.maxWeight - a.maxWeight || b.score - a.score
}

/** Markdown 单元格净化：竖线转义 + 压缩换行，避免破坏表格与列表结构 */
export function mdCell(text: string) {
  return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ')
}

type DiffFileCardInstance = { revealLine: (line: number) => void }

/** AI 评审全流程：结果/历史链、进度日志、模式弹窗、问题清单（筛选/分组/折叠/治理/复制/定位）、变更文件跳转 */
export function useAiReviewFlow(source: AiReviewFlowSource) {
  const aiStore = useAiStore()
  const governanceStore = useGovernanceIssuesStore()
  const ui = useUiStore()

  const historyIndex = ref(0)
  const aiHistory = computed(() =>
    source.aiKey.value ? aiStore.reviewHistory[source.aiKey.value] ?? [] : [],
  )
  const aiResult = computed<AiReviewResult | undefined>(() => {
    if (!source.aiKey.value) return undefined
    if (historyIndex.value > 0) return aiHistory.value[historyIndex.value - 1]
    return aiStore.results[source.aiKey.value]
  })
  watch(source.aiKey, () => {
    historyIndex.value = 0
  })

  function setHistoryIndex(value: number | string) {
    historyIndex.value = Number(value)
  }

  const prevStats = computed(() => {
    const checks = aiResult.value?.previousChecks ?? []
    const fixed = checks.filter((c) => c.status === 'fixed').length
    const partial = checks.filter((c) => c.status === 'partial').length
    const notFixed = checks.filter((c) => c.status === 'not_fixed').length
    return `对比 ${formatAiTime(aiResult.value?.comparedWith ?? 0)} · 已修复 ${fixed} · 部分修复 ${partial} · 未修复 ${notFixed}`
  })

  /** 上轮核对结论索引：键复用治理指纹（文件 + 压缩空白描述，行号漂移不参与），与 mergeResults 补入的派生问题同口径，精确匹配不错标 */
  const prevStatusIndex = computed(() => {
    const map = new Map<string, AiIssueStatus>()
    for (const check of aiResult.value?.previousChecks ?? []) {
      map.set(issueFingerprint(check), check.status)
    }
    return map
  })

  /** 摘要统计：由代码从 issues 精确汇总（模型计数不可靠且多批次时看不到全貌），随历史切换联动 */
  const summaryStats = computed(() => {
    const issues = aiResult.value?.issues ?? []
    const topFiles = (list: AiIssue[]) => {
      const counter = new Map<string, number>()
      for (const issue of list) counter.set(issue.file, (counter.get(issue.file) ?? 0) + 1)
      return [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([file]) => file)
    }
    const high = issues.filter((issue) => issue.severity === 'high')
    const medium = issues.filter((issue) => issue.severity === 'medium')
    const low = issues.filter((issue) => issue.severity === 'low')
    const conventions = issues.filter((issue) => issue.type === 'convention')
    const focus = new Map<string, number>()
    for (const issue of issues) {
      focus.set(issue.file, (focus.get(issue.file) ?? 0) + SEVERITY_WEIGHT[issue.severity])
    }
    return {
      totalFiles: source.changedFiles.value.length,
      issueFileCount: new Set(issues.map((issue) => issue.file)).size,
      high: high.length,
      medium: medium.length,
      low: low.length,
      conventionCount: conventions.length,
      highFiles: topFiles(high),
      mediumFiles: topFiles(medium),
      conventionFiles: topFiles(conventions),
      focusFiles: [...focus.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([file]) => file),
    }
  })

  /** 统计块行数据：每行的文件名可点击跳转到变更文件列表并展开该文件 */
  const statLines = computed(() => {
    const stats = summaryStats.value
    const lines: { key: string; label: string; files: string[]; focus?: boolean }[] = []
    if (stats.high > 0) lines.push({ key: 'high', label: '高风险问题集中于', files: stats.highFiles })
    if (stats.medium > 0)
      lines.push({ key: 'medium', label: '中风险问题集中于', files: stats.mediumFiles })
    if (stats.conventionCount > 0)
      lines.push({
        key: 'convention',
        label: `不符合团队规范 ${stats.conventionCount} 处，集中于`,
        files: stats.conventionFiles,
      })
    if (stats.focusFiles.length > 0)
      lines.push({ key: 'focus', label: '建议优先检查', files: stats.focusFiles, focus: true })
    return lines
  })

  const aiReviewing = computed(() =>
    Boolean(source.aiKey.value && aiStore.reviewing[source.aiKey.value]),
  )
  const aiError = computed(() =>
    source.aiKey.value ? aiStore.reviewErrors[source.aiKey.value] || '' : '',
  )
  const aiLog = computed(() =>
    source.aiKey.value ? aiStore.reviewLogs[source.aiKey.value] : undefined,
  )
  /** AI 报告折叠面板展开状态：默认展开分析结果（统计汇总）与问题清单；评审开始展开进度，完成后回到该组合 */
  const aiPanels = ref<string[]>(['result', 'issues'])
  watch(aiReviewing, (reviewing) => {
    if (reviewing) aiPanels.value = ['progress']
  })
  watch(
    () => aiLog.value?.done,
    (done, prev) => {
      if (done && !prev) aiPanels.value = ['result', 'issues']
    },
  )
  const progressTag = computed<{ color: string; label: string }>(() => {
    const log = aiLog.value
    if (!log) {
      return aiReviewing.value
        ? { color: 'processing', label: '准备中' }
        : { color: 'default', label: '' }
    }
    if (log.canceled) return { color: 'warning', label: '已停止' }
    if (log.error) return { color: 'error', label: '失败' }
    if (log.done) return { color: 'success', label: '完成' }
    return { color: 'processing', label: '进行中' }
  })
  const progressSummary = computed(() => {
    const log = aiLog.value
    if (!log) return ''
    if (log.canceled) {
      const doneBatches = log.steps.filter(
        (s) => s.key.startsWith('batch-') && s.status === 'done',
      ).length
      return log.totalBatches > 0
        ? `已停止 · 已完成 ${doneBatches}/${log.totalBatches} 批`
        : '已手动停止'
    }
    if (log.error) {
      const point = source.aiKey.value ? aiStore.resumePoints[source.aiKey.value] : undefined
      const doneBatches = Object.keys(point?.results ?? {}).length
      return doneBatches > 0 ? `评审失败 · 已完成 ${doneBatches} 批，可继续分析` : '评审失败'
    }
    if (!log.done) return '评审进行中…'
    const parts = [`共 ${log.totalBatches} 批`]
    if (log.endedAt > log.startedAt) parts.push(`总耗时 ${formatDuration(log.endedAt - log.startedAt)}`)
    return parts.join(' · ')
  })
  const logStatsText = computed(() => {
    const log = aiLog.value
    if (!log) return ''
    const parts = [
      `发送 ${formatChars(log.sentChars)} 字`,
      `接收 ${formatChars(log.answerChars + log.reasoningChars)} 字`,
    ]
    if (log.reasoningChars > 0) parts.push(`含思考 ${formatChars(log.reasoningChars)} 字`)
    if (log.usage.totalTokens > 0) parts.push(`Tokens ${formatChars(log.usage.totalTokens)}`)
    if (log.endedAt > log.startedAt) parts.push(`总耗时 ${formatDuration(log.endedAt - log.startedAt)}`)
    return parts.join(' · ')
  })
  const aiHint = computed(() => {
    const running = aiLog.value?.steps.find((s) => s.status === 'running')
    const detail = running?.detail || '正在分析变更内容，请勿关闭页面…'
    return `${detail}（可点击「停止评审」随时中止）`
  })

  function stopAiReview() {
    if (source.aiKey.value) aiStore.stopReview(source.aiKey.value)
  }

  /** 断点中已完成的批次数：断点仅在 error 中断后保留（canceled/成功路径已删），供续跑提示展示 */
  const resumeBatchCount = computed(() => {
    if (!source.aiKey.value) return 0
    const point = aiStore.resumePoints[source.aiKey.value]
    return point ? Object.keys(point.results).length : 0
  })

  /** 断点续跑可用性：error 中断且断点仍有已完成批次 */
  const resumeAvailable = computed(
    () => !aiReviewing.value && Boolean(aiError.value) && resumeBatchCount.value > 0,
  )

  /** 断点续跑：沿用已完成批次继续分析（绕过模式弹窗，模式由断点指纹锁定） */
  function resumeAiReview() {
    const pr = source.reviewTarget.value
    if (!pr || !source.aiKey.value) return
    if (!ensureConfigReady()) return
    void aiStore.resumeReviewByKey(source.aiKey.value, pr)
  }

  function stepColor(status: AiReviewStepStatus): string {
    if (status === 'done') return 'green'
    if (status === 'running') return 'blue'
    if (status === 'error') return 'red'
    return 'gray'
  }

  function stepDuration(step: AiReviewStep): string {
    if (step.status !== 'done' || !step.startedAt || !step.endedAt) return ''
    return formatDuration(step.endedAt - step.startedAt)
  }

  function formatAiTime(value: number): string {
    return dayjs(value).format('MM-DD HH:mm')
  }

  /** AI 模型未配置时提示并打开设置页 */
  function ensureConfigReady(): boolean {
    if (aiStore.configReady) return true
    message.warning('请先在设置中配置 AI 评审模型')
    ui.openSettings()
    return false
  }

  /** 模式选择弹窗状态：默认沿用上次的分析模式 */
  const modeModalOpen = ref(false)
  const pendingMode = ref<AiReviewMode>(aiStore.reviewMode)
  /** 两种模式的批次方案预估（纯字符串运算），用于弹窗内实时预览 */
  const modePreview = computed(() => {
    const pr = source.reviewTarget.value
    if (!pr) return null
    return { budget: estimateReviewPlan(pr, 'budget'), full: estimateReviewPlan(pr, 'full') }
  })

  function openModeModal() {
    if (!ensureConfigReady()) return
    pendingMode.value = aiStore.reviewMode
    modeModalOpen.value = true
  }

  /** 弹窗确认：各视图通过 beginReview 注入真正的发起动作（本地 runLocalReview / 远程 runReview） */
  function confirmMode() {
    modeModalOpen.value = false
    source.beginReview(pendingMode.value)
  }

  const severityFilter = ref<SeverityFilterValue>('all')
  /** 问题条目折叠态：key 为「文件#组内索引」，按文件分组后组内索引在筛选切换时保持稳定 */
  const collapsedIssues = ref(new Set<string>())
  /** 问题组折叠态：key 为文件路径，点击组头部折叠/展开整个文件组 */
  const collapsedGroups = ref(new Set<string>())

  /** 指纹 → 治理记录的映射：记录侧 Map 化中间层，供问题映射预查记录，避免逐条线性扫描（原实现为 O(问题数×记录数)） */
  const governanceRecordByFingerprint = computed(() => {
    const repo = source.activeRepoId.value
    const map = new Map<string, GovernanceRecord>()
    if (!repo) return map
    for (const r of governanceStore.records) {
      if (r.scope === 'general' || r.scope === repo) map.set(r.fingerprint, r)
    }
    return map
  })

  /** 问题 → 治理记录的映射：模板同一条目多处调 recordOf，原实现每处都现场计算指纹（正则归一化）；以问题对象引用为键预计算一次，分组/筛选/导出链路均透传 aiResult.issues 的原引用 */
  const governanceRecordByIssue = computed(() => {
    const map = new Map<AiIssue, GovernanceRecord>()
    for (const issue of aiResult.value?.issues ?? []) {
      const record = governanceRecordByFingerprint.value.get(issueFingerprint(issue))
      if (record) map.set(issue, record)
    }
    return map
  })

  /** 查找问题命中的治理记录（通用层或当前仓库层，含豁免与遵守），未命中返回 null */
  function recordOf(issue: AiIssue): GovernanceRecord | null {
    return governanceRecordByIssue.value.get(issue) ?? null
  }

  /** 剔除豁免隐藏项后的问题清单：豁免问题不再展示，仅保留未命中或遵守命中的问题 */
  const unhiddenIssues = computed(() => {
    const issues = aiResult.value?.issues ?? []
    return issues.filter((issue) => recordOf(issue)?.disposition !== 'exempt')
  })

  /** 本次报告中被豁免隐藏的问题条数，用于清单底部跳转治理的提示 */
  const hiddenExemptCount = computed(() => {
    const issues = aiResult.value?.issues ?? []
    return issues.filter((issue) => recordOf(issue)?.disposition === 'exempt').length
  })

  const issueStats = computed(() => {
    const issues = unhiddenIssues.value
    return {
      total: issues.length,
      high: issues.filter((issue) => issue.severity === 'high').length,
      medium: issues.filter((issue) => issue.severity === 'medium').length,
      low: issues.filter((issue) => issue.severity === 'low').length,
    }
  })

  const visibleIssues = computed(() => {
    if (severityFilter.value === 'all') return unhiddenIssues.value
    return unhiddenIssues.value.filter((issue) => issue.severity === severityFilter.value)
  })

  /** 问题清单按文件分组：档位筛选先作用于 visibleIssues，再按文件聚合；含严重问题的文件排最前，同档按风险权重降序（导出 Markdown 同口径）；条目附带预计算的上轮核对结论，模板单次取值分支渲染避免重复查询 */
  const issueGroups = computed(() => {
    const groups = new Map<
      string,
      {
        file: string
        issues: (AiIssue & { prevStatus?: AiIssueStatus })[]
        high: number
        medium: number
        low: number
        score: number
        maxWeight: number
      }
    >()
    for (const issue of visibleIssues.value) {
      let group = groups.get(issue.file)
      if (!group) {
        group = { file: issue.file, issues: [], high: 0, medium: 0, low: 0, score: 0, maxWeight: 0 }
        groups.set(issue.file, group)
      }
      group.issues.push({ ...issue, prevStatus: prevStatusIndex.value.get(issueFingerprint(issue)) })
      group[issue.severity] += 1
      group.score += SEVERITY_WEIGHT[issue.severity]
      group.maxWeight = Math.max(group.maxWeight, SEVERITY_WEIGHT[issue.severity])
    }
    return [...groups.values()].sort(compareGroupRisk)
  })

  const issueGroupEls = new Map<string, HTMLElement>()
  const locatedGroup = ref<string | null>(null)

  function setIssueGroupEl(file: string, el: unknown) {
    if (el instanceof HTMLElement) {
      issueGroupEls.set(file, el)
    } else {
      issueGroupEls.delete(file)
    }
  }

  /** 从报告统计块定位到问题清单中的文件组：确保面板展开、必要时放开筛选，滚动并闪烁提示 */
  function locateIssueGroup(file: string) {
    const issues = aiResult.value?.issues ?? []
    if (!issues.some((issue) => issue.file === file)) {
      message.warning('该文件不在问题清单中')
      return
    }
    if (!issueGroups.value.some((group) => group.file === file)) {
      setSeverityFilter('all')
    }
    const needExpand = !aiPanels.value.includes('issues')
    if (needExpand) {
      aiPanels.value = [...aiPanels.value, 'issues']
    }
    void nextTick(() => {
      const flashAndScroll = () => {
        locatedGroup.value = file
        issueGroupEls.get(file)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        window.setTimeout(() => {
          if (locatedGroup.value === file) locatedGroup.value = null
        }, 1600)
      }
      const scrollToGroup = () => {
        if (collapsedGroups.value.has(file)) {
          const next = new Set(collapsedGroups.value)
          next.delete(file)
          collapsedGroups.value = next
          void nextTick(flashAndScroll)
        } else {
          flashAndScroll()
        }
      }
      if (needExpand) {
        window.setTimeout(scrollToGroup, 320)
      } else {
        scrollToGroup()
      }
    })
  }

  function setSeverityFilter(value: SeverityFilterValue) {
    severityFilter.value = value
    collapsedIssues.value = new Set()
  }

  /** 问题条目折叠 key：文件路径 + 组内索引 */
  function issueKeyOf(file: string, gi: number) {
    return `${file}#${gi}`
  }

  function toggleIssue(key: string) {
    const next = new Set(collapsedIssues.value)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    collapsedIssues.value = next
  }

  /** 折叠/展开整个文件组 */
  function toggleGroup(file: string) {
    const next = new Set(collapsedGroups.value)
    if (next.has(file)) {
      next.delete(file)
    } else {
      next.add(file)
    }
    collapsedGroups.value = next
  }

  /** 新的分析结果到达（重新分析/切 PR/切历史）时重置折叠态，问题清单默认全部展开 */
  watch(aiResult, () => {
    collapsedIssues.value = new Set()
    collapsedGroups.value = new Set()
  })

  /** 加入治理：exempt 豁免（清单隐藏且不再报告）/ comply 遵守（保留清单待提炼规范）；scope='general' 为通用层 */
  function governIssue(issue: AiIssue, disposition: IssueDisposition, scope: string, reason?: string) {
    const repo = source.activeRepoId.value
    if (!repo) return
    governanceStore.record(scope === 'general' ? 'general' : repo, issue, disposition, reason)
    message.success(
      disposition === 'exempt'
        ? scope === 'general'
          ? '已豁免：所有仓库的 AI 分析不再报告该问题'
          : '已豁免：当前仓库的 AI 分析不再报告该问题'
        : '已加入遵守记录：可前往治理工作台提炼为团队规范',
    )
  }

  /** 切换治理记录的生效范围：通用 ↔ 仅当前仓库 */
  function toggleRecordScope(record: GovernanceRecord) {
    const repo = source.activeRepoId.value
    if (!repo) return
    governanceStore.setScope(record.id, record.scope === 'general' ? repo : 'general')
  }

  /** 恢复显示：移除治理记录（需在移除前读取处置类型）；豁免问题此前被隐藏、恢复后重新分析会再次出现，遵守问题本就展示于清单仅退出遵守统计，两类文案区分 */
  function restoreRecord(id: string) {
    const record = governanceStore.records.find((r) => r.id === id)
    governanceStore.restore(id)
    message.success(
      record?.disposition === 'comply'
        ? '已退出遵守，该问题不再纳入遵守统计'
        : '已恢复显示，重新分析后该问题将再次出现',
    )
  }

  /** 从问题条目上直接恢复显示（退出豁免/遵守） */
  function restoreIssue(issue: AiIssue) {
    const record = recordOf(issue)
    if (record) restoreRecord(record.id)
  }

  /** 复制问题对应文件路径（含行号），便于快速定位 */
  async function copyIssuePath(issue: AiIssue) {
    try {
      await navigator.clipboard.writeText(`${issue.file}:${issue.line}`)
      message.success('已复制文件路径')
    } catch (err) {
      message.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 单条问题的完整信息文本（文件 + 问题 + 建议），问题级与文件级复制共用同一格式 */
  function formatIssueText(issue: AiIssue): string {
    const lines = [
      `文件：${issue.file}:${issue.line}`,
      `问题：${issue.comment}`,
    ]
    if (issue.suggestion) lines.push(`建议修复：${issue.suggestion}`)
    return lines.join('\n')
  }

  /** 复制完整问题信息（文件 + 问题 + 建议），粘贴后可直接交给 AI 修改 */
  async function copyIssueAll(issue: AiIssue) {
    try {
      await navigator.clipboard.writeText(formatIssueText(issue))
      message.success('已复制完整问题信息，可直接粘贴给 AI 修改')
    } catch (err) {
      message.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** "…"菜单分发：复制路径 / 全部复制 */
  function onIssueCopyMenu(issue: AiIssue, info: { key: string | number }) {
    if (String(info.key) === 'all') {
      void copyIssueAll(issue)
      return
    }
    void copyIssuePath(issue)
  }

  /** 复制文件分组的文件路径（不含行号），便于直接定位该文件 */
  async function copyGroupPath(file: string) {
    try {
      await navigator.clipboard.writeText(file)
      message.success('已复制文件路径')
    } catch (err) {
      message.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 复制一个文件下的全部问题（逐条完整信息），粘贴后可一次性交给 AI 修改 */
  async function copyGroupAllIssues(file: string, issues: AiIssue[]) {
    const text = issues.map(formatIssueText).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      message.success(`已复制「${file}」全部 ${issues.length} 条问题，可直接粘贴给 AI 修改`)
    } catch (err) {
      message.error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 文件分组"…"菜单分发：复制路径 / 全部复制 */
  function onGroupCopyMenu(file: string, issues: AiIssue[], info: { key: string | number }) {
    if (String(info.key) === 'all') {
      void copyGroupAllIssues(file, issues)
      return
    }
    void copyGroupPath(file)
  }

  /** 持有每个文件卡片的实例，用于从 AI 结果跳转定位 */
  const fileCards = new Map<string, DiffFileCardInstance>()

  function registerFileCard(path: string, el: unknown) {
    const inst = el as DiffFileCardInstance | null
    if (inst && typeof inst.revealLine === 'function') fileCards.set(path, inst)
    else fileCards.delete(path)
  }

  /** 把 AI 给出的文件路径匹配到本次变更文件（精确匹配失败时按路径后缀兜底） */
  function resolveDiffFile(file: string) {
    const files = source.changedFiles.value
    return (
      files.find((f) => f.path === file) ??
      files.find((f) => f.path.endsWith(file) || file.endsWith(f.path))
    )
  }

  /** 跳转到变更文件列表并定位到指定行：切 Tab → 自动展开文件 diff → 滚动到目标行并闪烁提示 */
  function jumpToFileLine(file: string, line: number) {
    const target = resolveDiffFile(file)
    if (!target) {
      message.warning('该文件不在本次变更文件列表中')
      return
    }
    source.showFilesTab()
    void nextTick(() => {
      fileCards.get(target.path)?.revealLine(line)
    })
  }

  /** 详情区滚动容器，用于浮动“回到顶部”按钮 */
  const detailBodyRef = ref<HTMLElement | null>(null)
  /** 详情区滚动超过 300px 时显示回到顶部按钮 */
  const showBackTop = ref(false)

  /** 详情区滚动时更新回到顶部按钮的显隐 */
  function onDetailScroll() {
    const el = detailBodyRef.value
    showBackTop.value = el !== null && el.scrollTop > 300
  }

  /** 平滑滚动回详情区顶部 */
  function scrollDetailToTop() {
    detailBodyRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return {
    exportTitle: source.exportTitle,
    exportFilename: source.exportFilename,
    aiHistory,
    historyIndex,
    aiResult,
    setHistoryIndex,
    prevStats,
    summaryStats,
    statLines,
    aiReviewing,
    aiError,
    aiLog,
    aiPanels,
    progressTag,
    progressSummary,
    logStatsText,
    aiHint,
    stopAiReview,
    resumeBatchCount,
    resumeAvailable,
    resumeAiReview,
    stepColor,
    stepDuration,
    formatAiTime,
    ensureConfigReady,
    modeModalOpen,
    pendingMode,
    modePreview,
    openModeModal,
    confirmMode,
    severityFilter,
    collapsedIssues,
    collapsedGroups,
    recordOf,
    hiddenExemptCount,
    issueStats,
    visibleIssues,
    issueGroups,
    locatedGroup,
    setIssueGroupEl,
    locateIssueGroup,
    setSeverityFilter,
    issueKeyOf,
    toggleIssue,
    toggleGroup,
    governIssue,
    toggleRecordScope,
    restoreRecord,
    restoreIssue,
    copyIssuePath,
    copyIssueAll,
    onIssueCopyMenu,
    onGroupCopyMenu,
    registerFileCard,
    resolveDiffFile,
    jumpToFileLine,
    detailBodyRef,
    showBackTop,
    onDetailScroll,
    scrollDetailToTop,
  }
}
