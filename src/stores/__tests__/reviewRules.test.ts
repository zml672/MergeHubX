// @vitest-environment jsdom
// 本文件覆盖 store 持久化归一化路径，依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGovernanceIssuesStore } from '../governanceIssues'
import { useReviewRulesStore } from '../reviewRules'

const KEY = 'mergehub:rule-sets'
const GOV_KEY = 'mergehub:governance-issues'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('reviewRules store：持久化归一化', () => {
  it('正常路径：规则集与规则完整读回，enabled 缺省为 true，kind 缺省为 standard', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sets: [{ id: 's1', name: '规范一', rules: [{ id: 'r1', name: '命名', content: 'c1' }] }],
        activeSetId: 's1',
      }),
    )
    const store = useReviewRulesStore()
    expect(store.sets).toHaveLength(1)
    expect(store.activeSet?.name).toBe('规范一')
    expect(store.sets[0].rules[0]).toMatchObject({ enabled: true, kind: 'standard' })
    expect(store.enabledRules).toHaveLength(1)
  })

  it('脏数据路径：非法 kind 回退、旧来源迁移、坏快照条目过滤、非法集合整体丢弃', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sets: [
          {
            id: 's1',
            name: '规范一',
            rules: [
              { id: 'r1', name: '禁用规则', content: 'c', enabled: false },
              { id: 'r2', name: '豁免规则', content: 'c', kind: 'exemption' },
              { id: 'r3', name: '怪值', content: 'c', kind: 'nonsense' }, // → standard
              {
                id: 'r4',
                name: '旧来源',
                content: 'c',
                source: {
                  kind: 'ignored-sediment', // v2.27 及之前的旧来源 → exempt-sediment
                  items: [{ file: 'a.ts', line: 1, type: 'bug', comment: 'x', ignoredAt: 42 }],
                  createdAt: 7,
                },
              },
              {
                id: 'r5',
                name: '坏来源',
                content: 'c',
                source: { items: [], createdAt: 7 }, // 缺 kind → 非法 → source 整体删除
              },
              {
                id: 'r6',
                name: '脏快照',
                content: 'c',
                source: {
                  kind: 'exempt-sediment',
                  items: [null, 'x', { file: 'a.ts', line: 1, type: 'bug', comment: 'y', recordedAt: 9 }],
                  createdAt: 7, // 非对象快照项过滤，合法项保留
                },
              },
            ],
          },
          { id: 'bad' }, // 缺 name → 集合丢弃
          'junk',
        ],
        activeSetId: 's1',
      }),
    )
    const store = useReviewRulesStore()
    expect(store.sets).toHaveLength(1)
    const rules = store.sets[0].rules
    expect(rules).toHaveLength(6)
    expect(rules[0]).toMatchObject({ enabled: false })
    expect(rules[1]).toMatchObject({ kind: 'exemption' })
    expect(rules[2]).toMatchObject({ kind: 'standard' })
    expect(rules[3].source).toMatchObject({ kind: 'exempt-sediment' })
    expect(rules[3].source?.items[0]).toMatchObject({ recordedAt: 42 })
    expect('ignoredAt' in rules[3].source!.items[0]).toBe(false)
    expect('source' in rules[4]).toBe(false)
    expect(rules[5].source?.items).toHaveLength(1)
    expect(rules[5].source?.items[0]).toMatchObject({ recordedAt: 9 })
    // enabledRules 过滤禁用项，豁免规则参与计数（是否注入提示词由评审管线按 kind 分流）
    expect(store.enabledRules.map((r) => r.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6'])
  })

  it('activeSetId 失效时回退首个集合；toggleRule 切换并持久化', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sets: [
          { id: 's1', name: 'A', rules: [{ id: 'r1', name: 'n', content: 'c' }] },
          { id: 's2', name: 'B', rules: [] },
        ],
        activeSetId: 'gone',
      }),
    )
    const store = useReviewRulesStore()
    expect(store.activeSetId).toBe('s1')
    store.toggleRule('s1', 'r1')
    expect(store.enabledRules).toHaveLength(0)
    const persisted = JSON.parse(localStorage.getItem(KEY) ?? '{}') as {
      sets: { rules: { enabled: boolean }[] }[]
    }
    expect(persisted.sets[0].rules[0].enabled).toBe(false)
  })

  it('持久化失败：persistState 记录失败（failSeq 自增）留给 UI 提示，内存态不受影响可重试', () => {
    const store = useReviewRulesStore()
    expect(store.persistState).toEqual({ ok: true, failSeq: 0 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 配额超限场景：setItem 抛 QuotaExceededError，persistJson 返回 false
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    store.addRule(store.sets[0].id, '新规则', '内容')
    expect(store.persistState.ok).toBe(false)
    expect(store.persistState.failSeq).toBe(1)
    // 内存态不受影响：规则仍在（刷新才会丢），下次写操作自动重试整份落盘
    expect(store.sets[0].rules.some((r) => r.name === '新规则')).toBe(true)
    // 恢复写通道后重试成功，ok 回正（failSeq 保留累计失败次数，不影响语义）
    vi.mocked(Storage.prototype.setItem).mockRestore()
    warn.mockRestore()
    store.toggleRule(store.sets[0].id, store.sets[0].rules[0].id)
    expect(store.persistState.ok).toBe(true)
    expect(store.persistState.failSeq).toBe(1)
  })

  it('连续两次持久化失败：failSeq 自增到 2，保证 UI watch（值变化触发）每次失败都能弹提示', () => {
    const store = useReviewRulesStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    // 布尔标志方案的缺陷场景：连续失败 lastPersistOk 保持 false 不变，watch 值不变化，
    // 第二次失败静默；failSeq 方案下每次失败序号必变，watch 必触发
    store.addRule(store.sets[0].id, '第一次', '内容')
    store.addRule(store.sets[0].id, '第二次', '内容')
    vi.mocked(Storage.prototype.setItem).mockRestore()
    warn.mockRestore()
    expect(store.persistState.ok).toBe(false)
    expect(store.persistState.failSeq).toBe(2)
  })
})

describe('reviewRules store：与治理记录的沉淀联动', () => {
  it('removeSet：规则删除后清理治理记录的沉淀回执（记录回归未沉淀）', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sets: [
          { id: 's1', name: 'A', rules: [{ id: 'r1', name: 'n', content: 'c' }] },
          { id: 's2', name: 'B', rules: [] },
        ],
        activeSetId: 's1',
      }),
    )
    localStorage.setItem(
      GOV_KEY,
      JSON.stringify([
        {
          id: 'gov1',
          fingerprint: 'f',
          scope: 'general',
          disposition: 'exempt',
          file: 'a.ts',
          line: 1,
          type: 'bug',
          comment: 'c',
          recordedAt: 1,
          sedimentedTo: { ruleId: 'r1', ruleName: 'n', at: 1 },
        },
      ]),
    )
    const store = useReviewRulesStore()
    const governance = useGovernanceIssuesStore()
    expect(governance.unsedimentedCount).toBe(0)
    const persistedGovRecords = () =>
      JSON.parse(localStorage.getItem(GOV_KEY) ?? '[]') as { sedimentedTo?: unknown }[]
    // 前置确认：种子的沉淀回执在盘
    expect('sedimentedTo' in persistedGovRecords()[0]).toBe(true)

    store.removeSet('s1')
    expect(store.sets.map((s) => s.id)).toEqual(['s2'])
    expect(store.activeSetId).toBe('s2')
    expect(governance.records[0].sedimentedTo).toBeUndefined()
    expect(governance.unsedimentedCount).toBe(1)
    // 跨 store 联动落盘：沉淀回执同步从 localStorage 清除（仅内存清除则刷新后回执复活）
    expect('sedimentedTo' in persistedGovRecords()[0]).toBe(false)
    // 规则集删除本身同样写穿
    const persistedSets = JSON.parse(localStorage.getItem(KEY) ?? '{}') as {
      sets: { id: string }[]
      activeSetId: string
    }
    expect(persistedSets.sets.map((s) => s.id)).toEqual(['s2'])
    expect(persistedSets.activeSetId).toBe('s2')
  })
})
