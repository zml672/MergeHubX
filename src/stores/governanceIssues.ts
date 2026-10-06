import { defineStore } from 'pinia'
import { issueFingerprint } from '../utils/issueFingerprint'
import { loadJson, persistJson, removeKey } from '../services/storage'
import type { AiIssue, AiIssueType, GovernanceRecord, IssueDisposition, SedimentLink } from '../types/ai'

const STORAGE_KEY = 'mergehub:governance-issues'
const LEGACY_STORAGE_KEY = 'mergehub:ignored-issues'
/** 治理记录 type 的合法枚举集：持久化数据可能携带枚举外脏值（手改或跨版本残留），归一化时校验回退；成员需与 AiIssueType 保持同步 */
const VALID_ISSUE_TYPES: readonly AiIssueType[] = ['bug', 'security', 'performance', 'style', 'convention']

function generateId(): string {
  return `gov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 宽松归一化持久化记录：disposition 缺省视为豁免（旧版忽略记录的语义即豁免），type 校验枚举合法性非法回退 convention，recordedAt 兼容旧字段 ignoredAt */
function normalizeRecord(raw: unknown): GovernanceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.id !== 'string' ||
    typeof r.fingerprint !== 'string' ||
    typeof r.scope !== 'string' ||
    typeof r.file !== 'string' ||
    typeof r.comment !== 'string'
  ) {
    return null
  }
  const recordedAt =
    typeof r.recordedAt === 'number'
      ? r.recordedAt
      : typeof r.ignoredAt === 'number'
        ? r.ignoredAt
        : Date.now()
  const record: GovernanceRecord = {
    id: r.id,
    fingerprint: r.fingerprint,
    scope: r.scope,
    disposition: r.disposition === 'comply' ? 'comply' : 'exempt',
    file: r.file,
    line: typeof r.line === 'number' ? r.line : 0,
    type:
      typeof r.type === 'string' && VALID_ISSUE_TYPES.includes(r.type as AiIssueType)
        ? (r.type as GovernanceRecord['type'])
        : 'convention',
    comment: r.comment,
    recordedAt,
  }
  if (
    r.sedimentedTo &&
    typeof r.sedimentedTo === 'object' &&
    typeof (r.sedimentedTo as SedimentLink).ruleId === 'string'
  ) {
    record.sedimentedTo = r.sedimentedTo as SedimentLink
  }
  if (typeof r.reason === 'string' && r.reason.trim()) record.reason = r.reason.trim()
  return record
}

function parseRecords(raw: unknown): GovernanceRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeRecord).filter((r): r is GovernanceRecord => r !== null)
}

function loadPersisted(): GovernanceRecord[] {
  const persisted = parseRecords(loadJson(STORAGE_KEY))
  if (persisted.length > 0) {
    // 新 key 有数据即视为迁移已完成：从备份恢复的 localStorage 可能同时带回旧 key 残留，早退路径同样清理，避免旧忽略数据永久滞留
    removeKey(LEGACY_STORAGE_KEY)
    return persisted
  }
  // 旧版忽略记录（v2.27 及之前）一次性静默迁移：语义即豁免；写入新 key 并读回校验成功后才移除旧 key，迁移失败时保留旧数据待下次重试
  const legacy = parseRecords(loadJson(LEGACY_STORAGE_KEY))
  if (legacy.length > 0) {
    persist(legacy)
    if (parseRecords(loadJson(STORAGE_KEY)).length !== legacy.length) return legacy
  }
  removeKey(LEGACY_STORAGE_KEY)
  return legacy
}

function persist(records: GovernanceRecord[]) {
  persistJson(STORAGE_KEY, records)
}

export const useGovernanceIssuesStore = defineStore('governanceIssues', {
  state: () => ({
    records: loadPersisted(),
    loaded: false,
  }),
  getters: {
    /** 未沉淀（尚未提炼为规则）的治理记录数：侧边导航治理角标使用 */
    unsedimentedCount(state) {
      return state.records.filter((r) => !r.sedimentedTo).length
    },
    /** 未沉淀记录数按处置分类：治理工作台 Tab 角标使用 */
    unsedimentedCountBy(state) {
      return (disposition: IssueDisposition) =>
        state.records.filter((r) => r.disposition === disposition && !r.sedimentedTo).length
    },
    /** 某仓库生效的全部治理记录（通用层 + 仓库层），可按处置分类过滤，按记录时间倒序 */
    listFor(state) {
      return (repo: string, disposition?: IssueDisposition) =>
        state.records
          .filter(
            (r) =>
              (r.scope === 'general' || r.scope === repo) &&
              (!disposition || r.disposition === disposition),
          )
          .sort((a, b) => b.recordedAt - a.recordedAt)
    },
  },
  actions: {
    load() {
      if (this.loaded) return
      this.loaded = true
    },
    /** 判断问题是否已有指定处置的记录：通用层或指定仓库层指纹命中即视为已处理 */
    isRecorded(repo: string, issue: AiIssue, disposition: IssueDisposition): boolean {
      const fingerprint = issueFingerprint(issue)
      return this.records.some(
        (r) =>
          r.fingerprint === fingerprint &&
          (r.scope === 'general' || r.scope === repo) &&
          r.disposition === disposition,
      )
    },
    /** 加入豁免/遵守：同范围同指纹已存在时更新处置分类与理由，不产生重复记录 */
    record(scope: string, issue: AiIssue, disposition: IssueDisposition, reason?: string): void {
      const fingerprint = issueFingerprint(issue)
      const trimmedReason = reason?.trim() || undefined
      const existing = this.records.find((r) => r.fingerprint === fingerprint && r.scope === scope)
      if (existing) {
        if (existing.disposition !== disposition) {
          existing.disposition = disposition
          existing.reason = trimmedReason
          // 仅处置翻转时旧沉淀回执失效：原关联规则的屏蔽/核验语义已不适用，清除回执待重新提炼；
          // 仅补填/修改理由不影响沉淀状态
          delete existing.sedimentedTo
          persist(this.records)
        } else if (existing.reason !== trimmedReason) {
          existing.reason = trimmedReason
          persist(this.records)
        }
        return
      }
      this.records.push({
        id: generateId(),
        fingerprint,
        scope,
        disposition,
        file: issue.file,
        line: issue.line,
        type: issue.type,
        comment: issue.comment,
        recordedAt: Date.now(),
        reason: trimmedReason,
      })
      persist(this.records)
    },
    /** 切换生效范围：通用（'general'）↔ 指定仓库 */
    setScope(id: string, scope: string): void {
      const record = this.records.find((r) => r.id === id)
      if (!record || record.scope === scope) return
      record.scope = scope
      persist(this.records)
    },
    /** 恢复（取消豁免/遵守），当前结果中被隐藏的豁免问题会立即重新显示 */
    restore(id: string): void {
      this.records = this.records.filter((r) => r.id !== id)
      persist(this.records)
    },
    /** 批量恢复：一次移除多条治理记录（治理工作台使用） */
    restoreMany(ids: string[]): void {
      const idSet = new Set(ids)
      this.records = this.records.filter((r) => !idSet.has(r.id))
      persist(this.records)
    },
    /** 回写沉淀回执：治理记录已提炼为规范规则（沉淀状态展示用） */
    markSedimented(ids: string[], ruleId: string, ruleName: string): void {
      const at = Date.now()
      const idSet = new Set(ids)
      for (const r of this.records) {
        if (idSet.has(r.id)) r.sedimentedTo = { ruleId, ruleName, at }
      }
      persist(this.records)
    },
    /** 规则被删除后清理指向它的沉淀回执（记录回归未沉淀状态，指纹兜底不受影响） */
    clearSedimentForRules(ruleIds: string[]): void {
      const idSet = new Set(ruleIds)
      let touched = false
      for (const r of this.records) {
        if (r.sedimentedTo && idSet.has(r.sedimentedTo.ruleId)) {
          delete r.sedimentedTo
          touched = true
        }
      }
      if (touched) persist(this.records)
    },
    /** 规则改名后同步沉淀回执中的冗余名称 */
    renameSediment(ruleId: string, ruleName: string): void {
      let touched = false
      for (const r of this.records) {
        if (r.sedimentedTo?.ruleId === ruleId && r.sedimentedTo.ruleName !== ruleName) {
          r.sedimentedTo.ruleName = ruleName
          touched = true
        }
      }
      if (touched) persist(this.records)
    },
  },
})
