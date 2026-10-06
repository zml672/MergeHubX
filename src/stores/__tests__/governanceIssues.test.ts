// @vitest-environment jsdom
// 本文件覆盖 store 持久化归一化路径，依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { issueFingerprint } from '../../utils/issueFingerprint'
import type { AiIssue } from '../../types/ai'
import { useGovernanceIssuesStore } from '../governanceIssues'

const KEY = 'mergehub:governance-issues'
const LEGACY = 'mergehub:ignored-issues'

/** 生成持久化种子记录（绕开类型约束，模拟磁盘上的任意脏数据） */
function seedRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'gov_x',
    fingerprint: 'f',
    scope: 'repo-a',
    disposition: 'exempt',
    file: 'a.ts',
    line: 1,
    type: 'bug',
    comment: 'c',
    recordedAt: 1000,
    ...overrides,
  }
}

function makeIssue(comment: string): AiIssue {
  return { file: 'a.ts', line: 9, severity: 'high', type: 'bug', comment }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('governanceIssues store：持久化归一化', () => {
  it('正常路径：合法记录完整读回，字段原样保留', () => {
    localStorage.setItem(KEY, JSON.stringify([seedRecord({ id: '1' })]))
    const store = useGovernanceIssuesStore()
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({
      id: '1',
      scope: 'repo-a',
      disposition: 'exempt',
      type: 'bug',
      recordedAt: 1000,
    })
  })

  it('脏数据路径：非法枚举回退、旧字段迁移、非对象条目过滤，单条脏数据不拖垮整表', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({ id: '1', disposition: 'weird', type: 'hacking' }), // 双回退：exempt + convention
        seedRecord({ id: '2', disposition: 'comply', reason: '团队约定' }), // comply 与 reason 保留
        { id: '3', fingerprint: 'f3', scope: 'repo-a', file: 'b.ts', comment: '旧', ignoredAt: 555 }, // 旧版忽略记录
        'junk',
        null,
        42,
        { id: '4' }, // 缺关键字段 → 整条丢弃
      ]),
    )
    const store = useGovernanceIssuesStore()
    expect(store.records.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(store.records[0]).toMatchObject({ disposition: 'exempt', type: 'convention' })
    expect(store.records[1]).toMatchObject({ disposition: 'comply', reason: '团队约定' })
    expect(store.records[2]).toMatchObject({ recordedAt: 555, disposition: 'exempt' })
    expect('ignoredAt' in store.records[2]).toBe(false)
  })

  it('旧 key 一次性迁移：写入新 key、读回校验、移除旧 key', () => {
    localStorage.setItem(LEGACY, JSON.stringify([seedRecord({ id: 'old-1' })]))
    const store = useGovernanceIssuesStore()
    expect(store.records.map((r) => r.id)).toEqual(['old-1'])
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toHaveLength(1)
    expect(localStorage.getItem(LEGACY)).toBeNull()
  })

  it('新 key 有数据即优先：同时残留的旧 key 被清理（备份恢复场景）', () => {
    localStorage.setItem(KEY, JSON.stringify([seedRecord({ id: 'new-1' })]))
    localStorage.setItem(LEGACY, JSON.stringify([seedRecord({ id: 'old-1' })]))
    const store = useGovernanceIssuesStore()
    expect(store.records.map((r) => r.id)).toEqual(['new-1'])
    expect(localStorage.getItem(LEGACY)).toBeNull()
  })
})

describe('governanceIssues store：生效范围与指纹匹配', () => {
  it('listFor：通用层 + 指定仓库层生效，他仓库不生效，可按处置过滤且按时间倒序', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({ id: '1', scope: 'general', recordedAt: 100 }),
        seedRecord({ id: '2', scope: 'repo-a', recordedAt: 300 }),
        seedRecord({ id: '3', scope: 'repo-a', recordedAt: 200, disposition: 'comply' }),
        seedRecord({ id: '4', scope: 'repo-b', recordedAt: 400 }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    expect(store.listFor('repo-a').map((r) => r.id)).toEqual(['2', '3', '1'])
    expect(store.listFor('repo-a', 'comply').map((r) => r.id)).toEqual(['3'])
    expect(store.listFor('repo-b', 'exempt').map((r) => r.id)).toEqual(['4', '1'])
  })

  it('isRecorded：指纹按空白归一化匹配、行号不参与；scope 与 disposition 双重限定', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({ id: '1', fingerprint: issueFingerprint({ file: 'a.ts', comment: '空 指针' }) }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    const issue = makeIssue('空  指针\n') // 空白差异 + 行号漂移（line 9 vs 记录 line 1）
    expect(store.isRecorded('repo-a', issue, 'exempt')).toBe(true)
    expect(store.isRecorded('repo-b', issue, 'exempt')).toBe(false)
    expect(store.isRecorded('repo-a', issue, 'comply')).toBe(false)
  })

  it('record：同指纹同范围幂等更新；处置翻转清沉淀回执，仅改理由不清', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({
          id: '1',
          fingerprint: issueFingerprint({ file: 'a.ts', comment: '空指针' }),
          sedimentedTo: { ruleId: 'r1', ruleName: '规则', at: 1 },
        }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    const issue = makeIssue('空指针')
    const persistedRecords = () =>
      JSON.parse(localStorage.getItem(KEY) ?? '[]') as {
        disposition: string
        reason?: string
        sedimentedTo?: unknown
      }[]
    // 前置确认：种子的沉淀回执在盘
    expect('sedimentedTo' in persistedRecords()[0]).toBe(true)

    store.record('repo-a', issue, 'comply', '改为遵守')
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({ disposition: 'comply', reason: '改为遵守' })
    expect(store.records[0].sedimentedTo).toBeUndefined() // 翻转 → 回执失效
    // 处置翻转写穿：盘面 disposition/reason 同步更新、回执键消失
    expect(persistedRecords()[0]).toMatchObject({ disposition: 'comply', reason: '改为遵守' })
    expect('sedimentedTo' in persistedRecords()[0]).toBe(false)

    store.record('repo-a', issue, 'comply', '补充理由')
    expect(store.records).toHaveLength(1)
    expect(store.records[0].reason).toBe('补充理由')
    // 仅补填理由同样写穿持久化
    expect(persistedRecords()[0]).toMatchObject({ disposition: 'comply', reason: '补充理由' })
  })

  it('restore / restoreMany：删除记录并持久化', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([seedRecord({ id: '1' }), seedRecord({ id: '2' }), seedRecord({ id: '3' })]),
    )
    const store = useGovernanceIssuesStore()
    const persistedIds = () =>
      (JSON.parse(localStorage.getItem(KEY) ?? '[]') as { id: string }[]).map((r) => r.id)

    // 单条 restore：记录与 localStorage 同步删除，其余记录不受影响
    store.restore('1')
    expect(store.records.map((r) => r.id)).toEqual(['2', '3'])
    expect(persistedIds()).toEqual(['2', '3'])

    // 批量 restoreMany：一次移除多条
    store.restoreMany(['2', '3'])
    expect(store.records).toHaveLength(0)
    expect(persistedIds()).toEqual([])
  })
})
