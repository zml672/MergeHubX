// @vitest-environment jsdom
// 覆盖 ai store 的持久化脏数据清洗（loadPersistedHistory / sanitizeObjectValues），
// 依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiStore } from '../ai'

const HISTORY_KEY = 'mergehub:ai-review-history'
const RESULTS_KEY = 'mergehub:ai-results'
const LOGS_KEY = 'mergehub:ai-review-logs'
const RESUME_KEY = 'mergehub:ai-review-resume'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('ai store：loadPersistedHistory 脏数据清洗', () => {
  it('某键存非数组：该键剔除、合法键保留，消费点 spread 不崩溃', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({
        badRepo: 123,
        worse: { not: 'array' },
        goodRepo: [{ issues: [], degraded: false, reviewedAt: '2026-09-23T00:00:00Z' }],
      }),
    )
    const store = useAiStore()
    expect(Object.keys(store.reviewHistory)).toEqual(['goodRepo'])
    // 消费点原语义（reviewHistory[key] ?? [] 后 spread）不再有非可迭代崩溃风险
    expect([...(store.reviewHistory['goodRepo'] ?? [])]).toHaveLength(1)
  })

  it('根数据非对象：整体回退空历史', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([1, 2, 3]))
    expect(useAiStore().reviewHistory).toEqual({})
  })

  it('无历史记录：空对象，行为与旧实现一致', () => {
    expect(useAiStore().reviewHistory).toEqual({})
  })
})

describe('ai store：results/logs/resumePoints 值级清洗（sanitizeObjectValues）', () => {
  it('results：值为非对象/缺 issues 数组的键剔除，合法键保留且消费点安全', () => {
    localStorage.setItem(
      RESULTS_KEY,
      JSON.stringify({
        good: { issues: [{ file: 'a.ts', line: 1 }], degraded: false, reviewedAt: 1 },
        badNumber: 42,
        badString: 'x',
        badArray: [1, 2],
        noIssues: { degraded: false, reviewedAt: 2 },
        nullIssues: { issues: null, reviewedAt: 3 },
      }),
    )
    const store = useAiStore()
    expect(Object.keys(store.results)).toEqual(['good'])
    expect(store.results['good']?.issues).toHaveLength(1)
  })

  it('logs：值为非对象/缺 steps 数组的键剔除，合法键保留', () => {
    localStorage.setItem(
      LOGS_KEY,
      JSON.stringify({
        good: { steps: [{ key: 'analyze', status: 'done' }], done: true },
        badNumber: 7,
        noSteps: { done: true },
        nullSteps: { steps: null, done: true },
      }),
    )
    const store = useAiStore()
    expect(Object.keys(store.reviewLogs)).toEqual(['good'])
    expect(store.reviewLogs['good']?.steps).toHaveLength(1)
  })

  it('resumePoints：fingerprint 非字符串、results 非对象或 savedAt 非有限数值的键剔除，不参与续跑判定与排序裁剪', () => {
    localStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        good: { fingerprint: 'fp-1', totalBatches: 2, results: { 1: {} }, savedAt: 1 },
        badFingerprint: { fingerprint: 42, results: {}, savedAt: 2 },
        nullResults: { fingerprint: 'fp-2', results: null, savedAt: 3 },
        stringSavedAt: { fingerprint: 'fp-3', results: { 1: {} }, savedAt: 'x' },
        nanSavedAt: { fingerprint: 'fp-4', results: { 1: {} }, savedAt: NaN },
        badNumber: 9,
      }),
    )
    const store = useAiStore()
    expect(Object.keys(store.resumePoints)).toEqual(['good'])
    // 消费点原语义：Object.keys(results) 遇 null 崩溃的路径已被入口清洗挡住
    expect(Object.keys(store.resumePoints['good']?.results ?? {})).toEqual(['1'])
  })

  it('空存储：三个键全部回退空对象，行为与旧实现一致', () => {
    const store = useAiStore()
    expect(store.results).toEqual({})
    expect(store.reviewLogs).toEqual({})
    expect(store.resumePoints).toEqual({})
  })

  it('__proto__ 自有键：results/history/logs/resumePoints 全部剔除且原型完好', () => {
    // 构造必须用原始 JSON 文本直接入库：对象字面量里的 __proto__: 触发原型设置而非
    // 创建自有键，JSON.stringify 输出不含该键，用例会空转（守卫删了断言照样绿）。
    // 只有 JSON.parse 原始文本才产生自有可枚举 __proto__ 键（与真实损坏数据入库路径一致），
    // 该键经普通赋值回写会触发原型 setter（改写清洗结果原型 + 键静默丢失），必须被剔除
    localStorage.setItem(
      RESULTS_KEY,
      '{"__proto__":{"issues":[{"file":"evil.ts"}]},"good":{"issues":[],"degraded":false,"reviewedAt":1}}',
    )
    localStorage.setItem(HISTORY_KEY, '{"__proto__":[{"issues":[]}],"good":[{"issues":[]}]}')
    localStorage.setItem(LOGS_KEY, '{"__proto__":{"steps":[]},"good":{"steps":[]}}')
    localStorage.setItem(
      RESUME_KEY,
      '{"__proto__":{"fingerprint":"fp","results":{},"savedAt":1},"good":{"fingerprint":"fp","results":{},"savedAt":2}}',
    )
    const store = useAiStore()
    for (const record of [store.results, store.reviewHistory, store.reviewLogs, store.resumePoints]) {
      expect(Object.keys(record)).toEqual(['good'])
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    }
    expect(store.results['good']?.issues).toEqual([])
  })
})
