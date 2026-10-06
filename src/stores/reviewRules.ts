import { defineStore } from 'pinia'
import { loadJson, persistJson } from '../services/storage'
import type { ReviewRule, RuleKind, RuleSet, RuleSource, RuleSourceKind } from '../types/ai'
import { useGovernanceIssuesStore } from './governanceIssues'

const STORAGE_KEY = 'mergehub:rule-sets'
const LEGACY_STORAGE_KEY = 'mergehub:review-rules'

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const SOURCE_KINDS: RuleSourceKind[] = ['manual', 'exempt-sediment', 'comply-sediment', 'ai-summary']

/** 旧版来源归一化：ignored-sediment（v2.27 及之前的忽略沉淀）→ exempt-sediment */
function normalizeSourceKind(kind: unknown): RuleSourceKind {
  return kind === 'ignored-sediment' ? 'exempt-sediment' : (kind as RuleSourceKind)
}

function isValidSource(source: unknown): source is RuleSource {
  if (!source || typeof source !== 'object') return false
  const s = source as RuleSource
  return SOURCE_KINDS.includes(s.kind) && Array.isArray(s.items) && typeof s.createdAt === 'number'
}

/** 快照项字段归一化：旧版持久化的溯源快照记录时间为 ignoredAt（v2.27 及之前），统一映射为 recordedAt；非对象元素（脏数据 null/原始值）直接过滤——否则属性访问或严格模式 delete 抛 TypeError 会使整个规则集回退为空，与容错归一化设计相悖 */
function normalizeSourceItems(items: unknown): RuleSource['items'] {
  if (!Array.isArray(items)) return []
  return items
    .filter(
      (raw): raw is RuleSource['items'][number] =>
        Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw),
    )
    .map((raw) => {
      const item = raw as RuleSource['items'][number] & { ignoredAt?: unknown }
      if (typeof item.recordedAt !== 'number' && typeof item.ignoredAt === 'number') {
        item.recordedAt = item.ignoredAt
      }
      delete (item as { ignoredAt?: unknown }).ignoredAt
      return item as RuleSource['items'][number]
    })
}

function normalizeRules(input: unknown): ReviewRule[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (r): r is ReviewRule =>
        Boolean(r) &&
        typeof r.id === 'string' &&
        typeof r.name === 'string' &&
        typeof r.content === 'string',
    )
    .map((r) => {
      const rule: ReviewRule = {
        ...r,
        enabled: r.enabled !== false,
        kind: r.kind === 'exemption' ? 'exemption' : 'standard',
      }
      if (rule.source) {
        rule.source = { ...rule.source, kind: normalizeSourceKind(rule.source.kind) }
        rule.source.items = normalizeSourceItems(rule.source.items)
      }
      if (!isValidSource(rule.source)) delete rule.source
      return rule
    })
}

interface RuleSetsPersisted {
  sets: RuleSet[]
  activeSetId: string
}

function migrateLegacy(): RuleSetsPersisted {
  const legacy = loadJson(LEGACY_STORAGE_KEY)
  const rules = legacy ? normalizeRules(legacy) : []
  const set: RuleSet = { id: 'default', name: '默认规范集', rules }
  return { sets: [set], activeSetId: set.id }
}

function loadPersisted(): RuleSetsPersisted {
  const parsed = loadJson(STORAGE_KEY) as Partial<RuleSetsPersisted> | null
  if (parsed) {
    const sets = (Array.isArray(parsed.sets) ? parsed.sets : [])
      .filter(
        (s): s is RuleSet =>
          Boolean(s) && typeof s.id === 'string' && typeof s.name === 'string',
      )
      .map((s) => ({ id: s.id, name: s.name, rules: normalizeRules(s.rules) }))
    if (sets.length > 0) {
      const activeSetId =
        typeof parsed.activeSetId === 'string' && sets.some((s) => s.id === parsed.activeSetId)
          ? parsed.activeSetId
          : sets[0].id
      return { sets, activeSetId }
    }
  }
  return migrateLegacy()
}

/** 写穿落盘并回传结果：规则集是用户手工维护数据丢失不可再生，结果由 persistNow 汇入 persistState 供 UI watch 提示 */
function persist(sets: RuleSet[], activeSetId: string): boolean {
  return persistJson(STORAGE_KEY, { sets, activeSetId })
}

/** 持久化结果状态：ok 标记最近一次是否成功；failSeq 每次失败自增（成功不变），
 * 作为 UI watch 的监听目标——Vue 的 watch 只在值变化时触发，布尔标志在「连续失败」时
 * 保持 false 不变，第二次起的失败不会再次弹提示；自增序号每次失败必变，保证每次失败都有提示 */
interface PersistState {
  ok: boolean
  failSeq: number
}

export const useReviewRulesStore = defineStore('reviewRules', {
  state: () => {
    const persisted = loadPersisted()
    return {
      sets: persisted.sets,
      activeSetId: persisted.activeSetId,
      loaded: false,
      /** 持久化结果状态：ok=false 时由 RuleSets/GovernanceRecords watch failSeq 并 toast 告知后果；内存态不受影响可重试 */
      persistState: { ok: true, failSeq: 0 } as PersistState,
    }
  },
  getters: {
    activeSet(state): RuleSet | undefined {
      return state.sets.find((s) => s.id === state.activeSetId) ?? state.sets[0]
    },
    enabledRules(): ReviewRule[] {
      return this.activeSet?.rules.filter((r) => r.enabled) ?? []
    },
  },
  actions: {
    /** 写穿落盘并更新持久化状态：成功 ok=true（failSeq 不动），失败 ok=false 且 failSeq 自增触发 UI watch */
    persistNow() {
      const ok = persist(this.sets, this.activeSetId)
      const seq = this.persistState.failSeq + (ok ? 0 : 1)
      this.persistState = { ok, failSeq: seq }
    },
    load() {
      if (this.loaded) return
      this.loaded = true
    },
    setActive(setId: string) {
      if (!this.sets.some((s) => s.id === setId)) return
      this.activeSetId = setId
      this.persistNow()
    },
    addSet(name: string): RuleSet {
      const set: RuleSet = {
        id: generateId('set'),
        name: name.trim() || '未命名规范集',
        rules: [],
      }
      this.sets.push(set)
      this.persistNow()
      return set
    },
    renameSet(setId: string, name: string) {
      const set = this.sets.find((s) => s.id === setId)
      if (!set) return
      set.name = name.trim() || set.name
      this.persistNow()
    },
    removeSet(setId: string) {
      if (this.sets.length <= 1) return
      const target = this.sets.find((s) => s.id === setId)
      if (!target) return
      this.sets = this.sets.filter((s) => s.id !== setId)
      if (this.activeSetId === setId) this.activeSetId = this.sets[0].id
      useGovernanceIssuesStore().clearSedimentForRules(target.rules.map((r) => r.id))
      this.persistNow()
    },
    addRule(
      setId: string,
      name: string,
      content: string,
      kind: RuleKind = 'standard',
      source?: RuleSource,
    ): ReviewRule {
      const rule: ReviewRule = {
        id: generateId('rule'),
        name: name.trim(),
        enabled: true,
        content: content.trim(),
        kind,
        ...(source ? { source } : {}),
      }
      const set = this.sets.find((s) => s.id === setId)
      if (set) set.rules.push(rule)
      this.persistNow()
      return rule
    },
    updateRule(
      setId: string,
      ruleId: string,
      patch: Partial<Pick<ReviewRule, 'name' | 'content' | 'kind'>>,
    ) {
      const rule = this.sets
        .find((s) => s.id === setId)
        ?.rules.find((r) => r.id === ruleId)
      if (!rule) return
      if (patch.name !== undefined) {
        rule.name = patch.name.trim()
        useGovernanceIssuesStore().renameSediment(ruleId, rule.name)
      }
      if (patch.content !== undefined) rule.content = patch.content.trim()
      if (patch.kind !== undefined) rule.kind = patch.kind
      this.persistNow()
    },
    toggleRule(setId: string, ruleId: string) {
      const rule = this.sets
        .find((s) => s.id === setId)
        ?.rules.find((r) => r.id === ruleId)
      if (!rule) return
      rule.enabled = !rule.enabled
      this.persistNow()
    },
    removeRule(setId: string, ruleId: string) {
      const set = this.sets.find((s) => s.id === setId)
      if (!set) return
      const before = set.rules.length
      set.rules = set.rules.filter((r) => r.id !== ruleId)
      if (set.rules.length === before) return
      useGovernanceIssuesStore().clearSedimentForRules([ruleId])
      this.persistNow()
    },
  },
})
