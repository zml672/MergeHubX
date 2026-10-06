import { defineStore } from 'pinia'
import { buildBatchPlan, buildResumeFingerprint, isReviewCancelled, reviewPullRequest } from '../services/ai'
import type { AiReviewEvent, AiReviewMode, FileContentFetcher, ReviewCancelHandle } from '../services/ai'
import { httpStreamCancel } from '../services/http'
import { readLocalFile } from '../services/local/git'
import { providers } from '../services/platforms'
import { deleteSecret, getSecret, setSecret } from '../services/secret'
import { loadJson, loadJsonObject, persistJson } from '../services/storage'
import type {
  AiModelConfig,
  AiModelProfile,
  AiReviewResult,
  AiReviewResumePoint,
  AiReviewRunLog,
} from '../types/ai'
import type { DiffFile, PullRequestDetail, Platform } from '../types/platform'
import { useGovernanceIssuesStore } from './governanceIssues'
import { useReviewRulesStore } from './reviewRules'
import { useSettingsStore } from './settings'

const AI_STORAGE_KEY = 'mergehub:ai-profiles'
const LEGACY_STORAGE_KEY = 'mergehub:ai'
const LEGACY_KEYRING_KEY = 'mergehub:ai-key'
const AI_RESULTS_STORAGE_KEY = 'mergehub:ai-results'
const AI_LOGS_STORAGE_KEY = 'mergehub:ai-review-logs'
const AI_HISTORY_STORAGE_KEY = 'mergehub:ai-review-history'
const AI_RESUME_STORAGE_KEY = 'mergehub:ai-review-resume'
const MAX_PERSISTED_RESULTS = 30
const MAX_PERSISTED_LOGS = 20
const MAX_PERSISTED_HISTORY = 5
const MAX_PERSISTED_RESUME = 8

const activeStreamIds = new Map<string, ReviewCancelHandle>()

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function keyringKey(profileId: string): string {
  return `mergehub:ai-key:${profileId}`
}

function generateId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

interface AiPersisted {
  profiles: AiModelProfile[]
  activeProfileId: string
  /** 上次选择的分析模式，作为下次模式弹窗的默认值 */
  reviewMode?: AiReviewMode
}

function fallbackPersisted(): AiPersisted {
  const profile: AiModelProfile = {
    id: 'default',
    name: '默认模型',
    presetId: 'deepseek',
    baseUrl: '',
    model: '',
  }
  return { profiles: [profile], activeProfileId: profile.id }
}

function migrateLegacy(): AiPersisted {
  const legacy = loadJson(LEGACY_STORAGE_KEY) as {
    presetId?: unknown
    baseUrl?: unknown
    model?: unknown
  } | null
  if (legacy) {
    const profile: AiModelProfile = {
      id: 'default',
      name: '默认模型',
      presetId: typeof legacy.presetId === 'string' ? legacy.presetId : 'deepseek',
      baseUrl: typeof legacy.baseUrl === 'string' ? legacy.baseUrl : '',
      model: typeof legacy.model === 'string' ? legacy.model : '',
    }
    return { profiles: [profile], activeProfileId: profile.id }
  }
  return fallbackPersisted()
}

function loadPersisted(): AiPersisted {
  const parsed = loadJson(AI_STORAGE_KEY) as Partial<AiPersisted> | null
  if (parsed) {
    const profiles = (Array.isArray(parsed.profiles) ? parsed.profiles : []).filter(
      (p): p is AiModelProfile =>
        Boolean(p) &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.presetId === 'string' &&
        typeof p.baseUrl === 'string' &&
        typeof p.model === 'string',
    )
    if (profiles.length > 0) {
      const activeProfileId =
        typeof parsed.activeProfileId === 'string' &&
        profiles.some((p) => p.id === parsed.activeProfileId)
          ? parsed.activeProfileId
          : profiles[0].id
      return {
        profiles,
        activeProfileId,
        reviewMode: parsed.reviewMode === 'full' ? 'full' : 'budget',
      }
    }
  }
  return migrateLegacy()
}

export function aiResultKey(
  platform: Platform,
  repo: string,
  number: number,
): string {
  return `${platform}:${repo}#${number}`
}

/** 本地仓库评审结果的 key：`local:` 前缀与远程 PR 的 key 空间隔离，互不冲突 */
export function localResultKey(repoPath: string): string {
  return `local:${repoPath}`
}

/** 把工作区变更文件包装成 PR 评审 detail，完整复用远程评审管线（分批/流式/重试/豁免屏蔽/历史） */
export function buildLocalReviewDetail(
  repoPath: string,
  branch: string,
  files: DiffFile[],
): PullRequestDetail {
  const additions = files.reduce((sum, f) => sum + f.additions, 0)
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0)
  return {
    key: localResultKey(repoPath),
    platform: 'github',
    repo: repoPath,
    number: 0,
    title: `工作区变更（${files.length} 个文件）`,
    author: '本地',
    state: 'open',
    sourceBranch: branch || 'HEAD',
    targetBranch: '工作区',
    fromFork: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: '',
    body: '',
    additions,
    deletions,
    changedFiles: files.length,
    files,
  }
}

export function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)} 秒`
  return `${Math.floor(secs / 60)} 分 ${Math.round(secs % 60)} 秒`
}

/**
 * 逐键清洗 Record 形态的持久化负载：loadJsonObject 仅做外层形态断言不校验值，
 * 存量/损坏数据若某键的值形态不对（被写成数字/字符串/null），会以错误类型进入
 * 内存态，消费点（渲染模板 aiResult.issues.length、续跑 Object.keys(point.results)）
 * 直接运行时崩溃。统一清洗：键下值必须是普通对象，且通过调用方给的值级谓词
 * （关键数组字段存在性，如 issues/steps），任一不满足整键剔除。
 * 元素级深度校验不做——各消费点对元素已有宽松消费或空值容忍，防到字段层即可挡住崩溃路径。
 * 纵深第二层：__proto__ 键显式跳过（第一层在 loadJson 源头 stripProtoKey；若未来有调用方
 * 绕过门面传入外部对象，本层兜底防止回写触发原型 setter）。
 */
function sanitizeObjectValues<T>(
  parsed: Record<string, unknown>,
  isValue: (value: Record<string, unknown>) => boolean,
): Record<string, T> {
  const cleaned: Record<string, T> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '__proto__') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (!isValue(value as Record<string, unknown>)) continue
    cleaned[key] = value as T
  }
  return cleaned
}

/** 值级谓词：键下必须有数组形态的 issues（渲染与导出链路的直接崩溃源） */
function isResultShape(value: Record<string, unknown>): boolean {
  return Array.isArray(value.issues)
}

/** 值级谓词：运行日志必须有数组形态的 steps（applyReviewEvent 的 find/push 直接崩溃源） */
function isLogShape(value: Record<string, unknown>): boolean {
  return Array.isArray(value.steps)
}

function loadPersistedResults(): Record<string, AiReviewResult> {
  return sanitizeObjectValues<AiReviewResult>(
    loadJsonObject<Record<string, unknown>>(AI_RESULTS_STORAGE_KEY, {}),
    isResultShape,
  )
}

function loadPersistedLogs(): Record<string, AiReviewRunLog> {
  return sanitizeObjectValues<AiReviewRunLog>(
    loadJsonObject<Record<string, unknown>>(AI_LOGS_STORAGE_KEY, {}),
    isLogShape,
  )
}

function persistResults(results: Record<string, AiReviewResult>): void {
  const entries = Object.entries(results)
    .sort((a, b) => (b[1].reviewedAt ?? 0) - (a[1].reviewedAt ?? 0))
    .slice(0, MAX_PERSISTED_RESULTS)
  const ok = persistJson(AI_RESULTS_STORAGE_KEY, Object.fromEntries(entries))
  if (!ok) {
    // 评审结果可重跑再生（重新评审即恢复），不值得打断用户；但静默吞掉会让
    // 「刷新后结果还在」的预期落空且无迹可循，warn 留痕即可
    console.warn('[mergehub] 评审结果持久化失败，刷新后本轮结果将丢失（可重新评审恢复）')
  }
}

function persistLogs(logs: Record<string, AiReviewRunLog>): void {
  const entries = Object.entries(logs)
    .sort((a, b) => b[1].startedAt - a[1].startedAt)
    .slice(0, MAX_PERSISTED_LOGS)
  const ok = persistJson(AI_LOGS_STORAGE_KEY, Object.fromEntries(entries))
  if (!ok) {
    // 运行日志属低敏观测数据（内存态本次会话仍可看），失败仅 warn 留痕不打扰
    console.warn('[mergehub] 运行日志持久化失败')
  }
}

function loadPersistedHistory(): Record<string, AiReviewResult[]> {
  const parsed = loadJsonObject<Record<string, unknown>>(AI_HISTORY_STORAGE_KEY, {})
  const history: Record<string, AiReviewResult[]> = {}
  // loadJsonObject 仅做形态断言不校验值：存量数据若某键存了非数组（如 {"repo":123}），消费点 spread 非可迭代会运行时崩溃，进 store 前统一清洗。
  // __proto__ 跳过为纵深第二层（第一层 loadJson 源头 stripProtoKey）
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '__proto__') continue
    if (Array.isArray(value)) history[key] = value as AiReviewResult[]
  }
  return history
}

function persistHistory(history: Record<string, AiReviewResult[]>): void {
  const entries = Object.entries(history)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([key, list]) => [key, list.slice(0, MAX_PERSISTED_HISTORY)] as const)
  const ok = persistJson(AI_HISTORY_STORAGE_KEY, Object.fromEntries(entries))
  if (!ok) {
    // 与 results 同源可重跑再生，warn 留痕即可
    console.warn('[mergehub] 评审历史持久化失败，刷新后历史列表将丢失')
  }
}

function loadPersistedResumePoints(): Record<string, AiReviewResumePoint> {
  // 续跑接管的比对字段必须可信：fingerprint 非字符串或 results 非对象的键剔除，
  // 避免坏键参与续跑判定（Object.keys(point.results) 遇 null 直接 TypeError）；
  // savedAt 必须是有限数值——persistResumePointsNow 按 savedAt 降序排序后裁剪，
  // NaN 会让比较器返回 0 使裁剪结果不确定，最新断点可能反被挤出持久化
  return sanitizeObjectValues<AiReviewResumePoint>(
    loadJsonObject<Record<string, unknown>>(AI_RESUME_STORAGE_KEY, {}),
    (value) =>
      typeof value.fingerprint === 'string' &&
      !!value.results &&
      typeof value.results === 'object' &&
      Number.isFinite(value.savedAt),
  )
}

/** 断点落盘节流窗口：批次完成是高频事件，窗口内多次变更合并为一次全量写入，避免大结果反复同步序列化阻塞主线程 */
const RESUME_PERSIST_DELAY_MS = 1500

let resumePersistTimer: ReturnType<typeof setTimeout> | null = null

function persistResumePointsNow(resumePoints: Record<string, AiReviewResumePoint>) {
  const entries = Object.entries(resumePoints)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_PERSISTED_RESUME)
  const ok = persistJson(AI_RESUME_STORAGE_KEY, Object.fromEntries(entries))
  if (!ok) {
    // 写入失败（配额超限/存储不可用）必须留痕：内存断点仍在，本会话内继续分析不受影响，
    // 但刷新后断点丢失，静默吞掉会让「可继续分析」的提示变成误导
    console.warn('[mergehub] 断点持久化失败，刷新后断点将丢失')
  }
}

/** 批次完成热路径：尾随节流合并写入（定时器闭包引用活对象，触发时序列化的是最新状态） */
function schedulePersistResumePoints(resumePoints: Record<string, AiReviewResumePoint>) {
  if (resumePersistTimer !== null) return
  resumePersistTimer = setTimeout(() => {
    resumePersistTimer = null
    persistResumePointsNow(resumePoints)
  }, RESUME_PERSIST_DELAY_MS)
}

/** 终态转换（评审启动/成功/取消/失败）立即落盘：先清掉待写定时器，保证节流窗口内最后一批不随应用关闭丢失 */
function flushPersistResumePoints(resumePoints: Record<string, AiReviewResumePoint>) {
  if (resumePersistTimer !== null) {
    clearTimeout(resumePersistTimer)
    resumePersistTimer = null
  }
  persistResumePointsNow(resumePoints)
}

export const useAiStore = defineStore('ai', {
  state: () => {
    const persisted = loadPersisted()
    return {
      profiles: persisted.profiles,
      activeProfileId: persisted.activeProfileId,
      reviewMode: persisted.reviewMode ?? 'budget',
      apiKeyMap: {} as Record<string, string>,
      loaded: false,
      results: loadPersistedResults(),
      reviewing: {} as Record<string, boolean>,
      reviewErrors: {} as Record<string, string>,
      reviewLogs: loadPersistedLogs(),
      reviewHistory: loadPersistedHistory(),
      resumePoints: loadPersistedResumePoints(),
    }
  },
  getters: {
    activeProfile(state): AiModelProfile | undefined {
      return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0]
    },
    configReady(): boolean {
      const profile = this.activeProfile
      return Boolean(profile && profile.baseUrl.trim() && profile.model.trim())
    },
  },
  actions: {
    async load() {
      if (this.loaded) return
      for (const profile of this.profiles) {
        try {
          this.apiKeyMap[profile.id] = (await getSecret(keyringKey(profile.id))) ?? ''
        } catch {
          this.apiKeyMap[profile.id] = ''
        }
      }
      const fallbackProfile = this.profiles.find((p) => p.id === 'default')
      if (fallbackProfile && !this.apiKeyMap.default) {
        try {
          const legacyKey = (await getSecret(LEGACY_KEYRING_KEY)) ?? ''
          if (legacyKey) this.apiKeyMap.default = legacyKey
        } catch {
          /* 旧凭据读取失败按无 Key 处理 */
        }
      }
      this.loaded = true
    },
    persist() {
      const ok = persistJson(AI_STORAGE_KEY, {
        profiles: this.profiles,
        activeProfileId: this.activeProfileId,
        reviewMode: this.reviewMode,
      })
      if (!ok) {
        // 模型配置属高敏数据（baseUrl/model 重填成本高），必须留痕；
        // 但不抛错——调用点之一在 startReview 热路径上，localStorage 满不该阻断评审本身
        console.warn('[mergehub] 模型配置持久化失败，重新打开应用后配置改动将丢失')
      }
    },
    async saveKey(profileId: string) {
      const key = (this.apiKeyMap[profileId] ?? '').trim()
      if (key) await setSecret(keyringKey(profileId), key)
      else await deleteSecret(keyringKey(profileId))
    },
    upsertProfile(
      input: {
        id?: string
        name: string
        presetId: string
        baseUrl: string
        model: string
        concurrency?: number
      },
      apiKey: string,
    ): AiModelProfile {
      const id = input.id ?? generateId()
      const normalized: AiModelProfile = {
        id,
        name: input.name.trim() || '未命名模型',
        presetId: input.presetId,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        concurrency: input.concurrency,
      }
      const index = this.profiles.findIndex((p) => p.id === id)
      if (index >= 0) this.profiles.splice(index, 1, normalized)
      else this.profiles.push(normalized)
      this.apiKeyMap[id] = apiKey.trim()
      if (!this.profiles.some((p) => p.id === this.activeProfileId)) {
        this.activeProfileId = id
      }
      this.persist()
      void this.saveKey(id).catch((err: unknown) => {
        console.warn('模型凭据写入系统凭据管理器失败', err)
      })
      return normalized
    },
    removeProfile(profileId: string) {
      if (this.profiles.length <= 1) return
      this.profiles = this.profiles.filter((p) => p.id !== profileId)
      delete this.apiKeyMap[profileId]
      void deleteSecret(keyringKey(profileId)).catch(() => undefined)
      if (this.activeProfileId === profileId) {
        this.activeProfileId = this.profiles[0].id
      }
      this.persist()
    },
    setActiveProfile(profileId: string) {
      if (!this.profiles.some((p) => p.id === profileId)) return
      this.activeProfileId = profileId
      this.persist()
    },
    profileConfig(profileId: string): AiModelConfig {
      const profile = this.profiles.find((p) => p.id === profileId)
      return {
        baseUrl: profile?.baseUrl.trim() ?? '',
        model: profile?.model.trim() ?? '',
        apiKey: (this.apiKeyMap[profileId] ?? '').trim(),
        concurrency: profile?.concurrency,
      }
    },
    modelConfig(): AiModelConfig {
      return this.activeProfile
        ? this.profileConfig(this.activeProfile.id)
        : { baseUrl: '', model: '', apiKey: '' }
    },
    stopReview(key: string) {
      const handle = activeStreamIds.get(key)
      if (!handle) return
      handle.cancelled = true
      void httpStreamCancel(handle.requestId).catch(() => undefined)
    },
    applyReviewEvent(key: string, event: AiReviewEvent) {
      const log = this.reviewLogs[key]
      if (!log || log.done || !this.reviewing[key]) return
      const stepBy = (stepKey: string) => log.steps.find((s) => s.key === stepKey)
      switch (event.type) {
        case 'plan': {
          const analyze = stepBy('analyze')
          if (analyze) {
            analyze.status = 'done'
            analyze.endedAt = Date.now()
            analyze.detail = `共 ${event.totalFiles} 个变更文件`
          }
          const split = stepBy('split')
          if (split) {
            split.status = 'done'
            split.endedAt = Date.now()
            split.detail =
              event.batches === 0
                ? '没有可分析的文本 diff'
                : `${event.mode === 'full' ? '全量模式' : '预算模式'}：拆分为 ${event.batches} 批，纳入分析 ${event.analyzedFiles} 个文件${
                    event.excludedFiles > 0
                      ? `，${event.excludedFiles} 个文件未纳入分析（自动生成/锁定文件）`
                      : ''
                  }`
          }
          log.totalBatches = event.batches
          const resumePoint = this.resumePoints[key]
          if (resumePoint) {
            resumePoint.totalBatches = event.batches
            flushPersistResumePoints(this.resumePoints)
          }
          for (let i = 1; i <= event.batches; i += 1) {
            const resumedResult = resumePoint?.results[i]
            log.steps.push({
              key: `batch-${i}`,
              title: `发送第 ${i}/${event.batches} 批分析`,
              status: resumedResult ? 'done' : 'pending',
              detail: resumedResult
                ? `断点续跑：沿用已完成结果（${resumedResult.issues.length} 条问题）`
                : '',
              startedAt: resumedResult ? Date.now() : 0,
              endedAt: resumedResult ? Date.now() : 0,
            })
          }
          if (event.batches > 1) {
            log.steps.push({
              key: 'merge',
              title: '汇总分批总评',
              status: 'pending',
              detail: '',
              startedAt: 0,
              endedAt: 0,
            })
          }
          persistLogs(this.reviewLogs)
          break
        }
        case 'batchStart': {
          const step = stepBy(`batch-${event.batch}`)
          if (step) {
            step.status = 'running'
            step.startedAt = Date.now()
            step.detail = `已发送 ${formatChars(event.sentChars)} 字，等待模型响应…`
          }
          persistLogs(this.reviewLogs)
          break
        }
        case 'batchStream': {
          const step = stepBy(`batch-${event.batch}`)
          if (step) {
            step.detail = event.thinking
              ? `模型思考中，已思考 ${formatChars(event.reasoningChars)} 字…`
              : `生成评审中，已接收 ${formatChars(event.answerChars)} 字…`
          }
          break
        }
        case 'batchRetry': {
          const step = stepBy(`batch-${event.batch}`)
          if (step) {
            step.detail =
              event.reason === 'network'
                ? `请求被限流或网络波动，${Math.round((event.waitMs ?? 0) / 1000)}s 后自动重试…`
                : '输出格式异常，自动重试中…'
          }
          break
        }
        case 'batchDone': {
          const step = stepBy(`batch-${event.batch}`)
          if (step) {
            step.status = 'done'
            step.endedAt = Date.now()
            const parts = [
              `耗时 ${formatDuration(event.elapsedMs)}`,
              `接收 ${formatChars(event.answerChars)} 字`,
            ]
            if (event.reasoningChars > 0) parts.push(`思考 ${formatChars(event.reasoningChars)} 字`)
            if (event.usage && event.usage.completionTokens > 0) {
              parts.push(`${formatChars(event.usage.completionTokens)} tokens`)
            }
            step.detail = parts.join(' · ')
          }
          if (event.result) {
            const resumePoint = this.resumePoints[key]
            if (resumePoint) {
              resumePoint.results[event.batch] = event.result
              resumePoint.savedAt = Date.now()
              schedulePersistResumePoints(this.resumePoints)
            }
          }
          persistLogs(this.reviewLogs)
          break
        }
        case 'verifyStart': {
          log.steps.push({
            key: 'verify',
            title: `正在复核 ${event.files} 个问题文件`,
            status: 'running',
            detail: `共 ${event.issues} 条问题待全文取证`,
            startedAt: Date.now(),
            endedAt: 0,
          })
          persistLogs(this.reviewLogs)
          break
        }
        case 'verifyDone': {
          const step = stepBy('verify')
          if (step) {
            step.status = 'done'
            step.endedAt = Date.now()
            // 复核调用整批失败（鉴权失效/模型配置错误等）时明确示警，避免「确认 0 过滤 0」
            // 被误读为复核正常完成且全部未表态
            if (event.failedFiles != null && event.totalFiles != null) {
              const all =
                event.failedFiles === event.totalFiles
                  ? '复核调用全部失败'
                  : `${event.failedFiles}/${event.totalFiles} 个文件复核失败`
              step.status = event.failedFiles === event.totalFiles ? 'error' : 'done'
              step.detail = `${all}，未产出有效复核结论；第一遍评审结果已完整保留`
            } else {
              step.detail = `确认 ${event.confirmed} 条，过滤 ${event.filtered} 条疑似误报`
            }
          }
          persistLogs(this.reviewLogs)
          break
        }
        case 'verifySkip': {
          log.steps.push({
            key: 'verify',
            title: 'AI 复核未运行',
            status: 'done',
            detail: event.reason,
            startedAt: 0,
            endedAt: Date.now(),
          })
          persistLogs(this.reviewLogs)
          break
        }
        case 'merging': {
          const step = stepBy('merge')
          if (step) {
            step.status = 'running'
            step.startedAt = Date.now()
            step.detail = '正在合成整体总评…'
          }
          break
        }
        case 'done': {
          log.done = true
          log.endedAt = Date.now()
          log.sentChars = event.sentChars
          log.answerChars = event.answerChars
          log.reasoningChars = event.reasoningChars
          log.usage = event.usage
          persistLogs(this.reviewLogs)
          break
        }
      }
    },
    async runReview(pr: PullRequestDetail, mode?: AiReviewMode) {
      await this.runReviewByKey(aiResultKey(pr.platform, pr.repo, pr.number), pr, mode)
    },
    /** 按 key 执行评审管线：远程 PR 与本地工作区变更共用同一套流程 */
    async runReviewByKey(key: string, pr: PullRequestDetail, mode?: AiReviewMode, resume = false) {
      const rulesStore = useReviewRulesStore()
      rulesStore.load()
      if (this.reviewing[key]) return
      if (!this.configReady) {
        this.reviewErrors[key] = '尚未配置 AI 模型，请先在设置中完成配置'
        return
      }
      const rules = rulesStore.enabledRules
      const ruleSetName = rulesStore.activeSet?.name ?? '默认规范集'
      // 历史误报豁免清单（通用层 + 本仓库层）：仅豁免类记录注入提示词要求模型不再报告；遵守记录是有效问题，不屏蔽
      const governanceStore = useGovernanceIssuesStore()
      governanceStore.load()
      const exempt = governanceStore.listFor(pr.repo, 'exempt')
      // 记住本次选择，作为下次模式弹窗的默认值，并立即持久化
      const reviewMode = mode ?? this.reviewMode
      this.reviewMode = reviewMode
      this.persist()
      // 断点续跑：指纹一致才接管断点（换模型/换模式/换规则集/PR 变化均失配作废从头），否则重建空断点。
      // 批次计划只构建一次：buildBatchPlan 是纯函数（同输入同输出），同一份 plan 既算指纹又传给
      // reviewPullRequest 执行，消除大 PR 下分块与全量内容哈希的双重 O(n) 同步计算阻塞主线程
      const config = this.modelConfig()
      const plan = buildBatchPlan(pr, reviewMode)
      const fingerprint = buildResumeFingerprint(config, pr, reviewMode, ruleSetName, rules, plan)
      let resuming = false
      if (resume) {
        const point = this.resumePoints[key]
        if (point && point.fingerprint === fingerprint && Object.keys(point.results).length > 0) {
          resuming = true
          point.savedAt = Date.now()
        }
      }
      if (!resuming) {
        this.resumePoints[key] = { fingerprint, totalBatches: 0, results: {}, savedAt: Date.now() }
      }
      flushPersistResumePoints(this.resumePoints)
      const resumePoint = this.resumePoints[key]
      const completed =
        resuming && resumePoint
          ? new Map<number, AiReviewResult>(
              Object.entries(resumePoint.results).map(([batch, result]) => [
                Number(batch),
                result,
              ]),
            )
          : new Map<number, AiReviewResult>()
      const requestId = generateRequestId()
      const cancel: ReviewCancelHandle = { requestId, cancelled: false }
      activeStreamIds.set(key, cancel)
      this.reviewing[key] = true
      this.reviewErrors[key] = ''
      this.reviewLogs[key] = {
        steps: [
          {
            key: 'analyze',
            title: '分析变更代码',
            status: 'running',
            detail: '',
            startedAt: Date.now(),
            endedAt: 0,
          },
          {
            key: 'split',
            title: '拆分代码批次',
            status: 'pending',
            detail: '',
            startedAt: 0,
            endedAt: 0,
          },
        ],
        startedAt: Date.now(),
        endedAt: 0,
        done: false,
        canceled: false,
        error: '',
        totalBatches: 0,
        sentChars: 0,
        answerChars: 0,
        reasoningChars: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }
      try {
        const previous = this.results[key]
        // 已豁免的问题不随“上次问题清单”送入复核，避免豁免问题反复出现在修复对比中
        const validPrevious =
          previous && !previous.degraded
            ? {
                ...previous,
                issues: previous.issues.filter((issue) => !governanceStore.isRecorded(pr.repo, issue, 'exempt')),
              }
            : undefined
        // 第二遍对抗式复核的取文通道：本地仓库走 Tauri 读盘（禁止越出仓库根），远程走平台 contents 接口；缺 token 或取文失败时由复核侧跳过
        let fetchFileContent: FileContentFetcher | undefined
        if (pr.key.startsWith('local:')) {
          fetchFileContent = (path) => readLocalFile(pr.repo, path)
        } else {
          const settingsStore = useSettingsStore()
          const state = settingsStore.accounts[pr.platform]
          if (!state.loaded) await settingsStore.loadAccount(pr.platform)
          const account = {
            platform: pr.platform,
            token: state.token.trim(),
            baseUrl: state.baseUrl.trim(),
          }
          fetchFileContent = (path) =>
            providers[pr.platform].fetchFileContent(account, pr.repo, path, pr.sourceBranch)
        }
        const result = await reviewPullRequest(config, pr, {
          rules,
          ruleSetName,
          onEvent: (event) => {
            this.applyReviewEvent(key, event)
          },
          cancel,
          previous: validPrevious && validPrevious.issues.length > 0 ? validPrevious : undefined,
          mode: reviewMode,
          exempt,
          fetchFileContent,
          completed: completed.size > 0 ? completed : undefined,
          batchPlan: plan,
        })
        if (previous && !previous.degraded) {
          this.reviewHistory[key] = [previous, ...(this.reviewHistory[key] ?? [])].slice(
            0,
            MAX_PERSISTED_HISTORY,
          )
          persistHistory(this.reviewHistory)
        }
        this.results[key] = result
        persistResults(this.results)
        // 评审完成：断点使命结束
        delete this.resumePoints[key]
        flushPersistResumePoints(this.resumePoints)
      } catch (err) {
        if (isReviewCancelled(err)) {
          // 主动中断（含续跑途中主动停止）：断点作废，下次评审从头开始
          delete this.resumePoints[key]
          flushPersistResumePoints(this.resumePoints)
          this.reviewErrors[key] = ''
          const log = this.reviewLogs[key]
          if (log) {
            log.canceled = true
            for (let i = log.steps.length - 1; i >= 0; i -= 1) {
              const step = log.steps[i]
              if (step.status === 'running') {
                step.status = 'canceled'
                step.endedAt = Date.now()
                step.detail = '已手动停止'
                break
              }
            }
            log.done = true
            log.endedAt = Date.now()
            persistLogs(this.reviewLogs)
          }
        } else {
          this.reviewErrors[key] = err instanceof Error ? err.message : String(err)
          // 异常中断：保留断点供「继续分析」滚动续跑；一个批次都没完成则无保留价值。
          // 保留与否都立即冲刷：把节流窗口内尚未写入的最后批次落盘，失败瞬间的断点即续跑可用的断点
          const point = this.resumePoints[key]
          if (point && Object.keys(point.results).length === 0) {
            delete this.resumePoints[key]
          }
          flushPersistResumePoints(this.resumePoints)
          const log = this.reviewLogs[key]
          if (log) {
            log.error = this.reviewErrors[key]
            for (let i = log.steps.length - 1; i >= 0; i -= 1) {
              const step = log.steps[i]
              if (step.status === 'running') {
                step.status = 'error'
                step.endedAt = Date.now()
                break
              }
            }
            log.done = true
            log.endedAt = Date.now()
            persistLogs(this.reviewLogs)
          }
        }
      } finally {
        activeStreamIds.delete(key)
        this.reviewing[key] = false
      }
    },
    /** 断点续跑：沿用已完成批次结果继续分析；指纹失配时自动作废断点从头评审 */
    async resumeReviewByKey(key: string, pr: PullRequestDetail) {
      await this.runReviewByKey(key, pr, undefined, true)
    },
    /** 本地工作区变更评审：把变更文件包装成伪 PR detail 后走同一管线 */
    async runLocalReview(
      payload: { path: string; branch: string; files: DiffFile[] },
      mode?: AiReviewMode,
    ) {
      await this.runReviewByKey(
        localResultKey(payload.path),
        buildLocalReviewDetail(payload.path, payload.branch, payload.files),
        mode,
      )
    },
  },
})
