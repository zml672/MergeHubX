// @vitest-environment jsdom
// 本文件覆盖 store 持久化归一化路径，依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { issueFingerprint, issueFingerprints, looseIssueFingerprint } from '../../utils/issueFingerprint'
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

  it('宽松指纹命中（P1-15①核心）：描述措辞漂移后仍按宽松键判已处置；类型或位置不同不误命中', () => {
    const store = useGovernanceIssuesStore()
    const original = makeIssue('存在空指针解引用风险')
    original.file = 'a.ts'
    original.line = 12
    store.record('repo-a', original, 'exempt')
    // 记录写入后同时携带双指纹
    expect(store.records[0].looseFingerprint).toBe(looseIssueFingerprint(original))

    // 换皮重报：描述完全不同、同文件同类型同行号 → isRecorded 宽松命中
    const reworded = makeIssue('此处可能 NPE，建议增加判空保护')
    reworded.file = 'a.ts'
    reworded.line = 12
    expect(issueFingerprint(reworded)).not.toBe(issueFingerprint(original)) // 精确键确已失配
    expect(store.isRecorded('repo-a', reworded, 'exempt')).toBe(true)

    // 类型不同 → 宽松键不同 → 不命中
    const otherType = makeIssue('随便什么描述')
    otherType.file = 'a.ts'
    otherType.line = 12
    otherType.type = 'security'
    expect(store.isRecorded('repo-a', otherType, 'exempt')).toBe(false)

    // 行号漂出桶（12→22，桶 2→4）→ 不命中（宁漏拦不误拦）
    const farLine = makeIssue('再换个说法')
    farLine.file = 'a.ts'
    farLine.line = 22
    expect(store.isRecorded('repo-a', farLine, 'exempt')).toBe(false)

    // 再 record 换皮问题：宽松命中已有记录 → 幂等更新而非新增
    store.record('repo-a', reworded, 'exempt', '第二次豁免')
    expect(store.records).toHaveLength(1)
    expect(store.records[0].reason).toBe('第二次豁免')
  })

  it('旧数据缺宽松键：仅精确匹配不报错，处置翻转时顺势回填宽松键', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({
          id: '1',
          fingerprint: issueFingerprint({ file: 'a.ts', comment: '空指针' }),
          // 无 looseFingerprint 字段——v0.2.0 及更早的存量记录
        }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    const issue = makeIssue('空指针')
    issue.file = 'a.ts'
    // 精确命中不受影响
    expect(store.isRecorded('repo-a', issue, 'exempt')).toBe(true)
    // 同位置不同措辞：旧记录无宽松键 → 不命中（旧数据退化为仅精确，符合预期）
    const reworded = makeIssue('换个说法的空指针')
    reworded.file = 'a.ts'
    expect(store.isRecorded('repo-a', reworded, 'exempt')).toBe(false)
    // 处置翻转时回填宽松键，此后换皮问题即可命中
    store.record('repo-a', issue, 'comply')
    expect(store.records[0].looseFingerprint).toBe(looseIssueFingerprint(issue))
    expect(store.isRecorded('repo-a', reworded, 'exempt')).toBe(false) // comply ≠ exempt，处置仍隔离
  })

  it('幂等命中也回填宽松键（P1-15①补丁 7）：旧记录重复处置无任何变化时同样补全，换皮复活此后被宽松匹配拦截', () => {
    // 旧存量记录：精确指纹指向「判空缺失」，无宽松键，处置 exempt 理由旧文案
    localStorage.setItem(
      KEY,
      JSON.stringify([
        seedRecord({
          id: 'legacy',
          fingerprint: issueFingerprint({ file: 'a.ts', comment: '判空缺失' }),
          disposition: 'exempt',
          reason: '误报',
        }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    const same = makeIssue('判空缺失') // 精确命中；file a.ts / line 9 → 桶 1
    // 幂等命中：同处置同理由重复 record，此前实现此路径不回填——宽松键长期缺失
    store.record('repo-a', same, 'exempt', '误报')
    expect(store.records).toHaveLength(1) // 不新增
    expect(store.records[0].looseFingerprint).toBe(looseIssueFingerprint(same)) // 已回填

    // 回填生效：同位置换皮重报（描述完全不同）→ 宽松命中已处置，不再复活
    const reworded = makeIssue('此处可能 NPE 建议判空')
    expect(store.isRecorded('repo-a', reworded, 'exempt')).toBe(true)

    // 幂等命中不误写：无变化时 touched 恒 false，不触发 persist（记录与磁盘保持原样）
    const before = localStorage.getItem(KEY)
    store.record('repo-a', makeIssue('判空缺失'), 'exempt', '误报')
    expect(localStorage.getItem(KEY)).toBe(before)
  })

  it('issueFingerprints 双指纹口径与 store 写入一致（单源）', () => {
    const issue = makeIssue('双指纹')
    const { exact, loose } = issueFingerprints(issue)
    expect(exact).toBe(issueFingerprint(issue))
    expect(loose).toBe(looseIssueFingerprint(issue))
  })

  it('record 两段式查找：宽松可命中记录排在数组前也不遮蔽精确命中（处置翻转作用到正确记录）', () => {
    const issue = makeIssue('目标问题') // file a.ts / line 9 / type bug
    localStorage.setItem(
      KEY,
      JSON.stringify([
        // 数组顺序故意复现意见场景：宽松可命中的记录在前（描述不同），精确命中的旧记录在后（无宽松键）
        seedRecord({
          id: 'loose-first',
          fingerprint: '别的精确指纹',
          looseFingerprint: looseIssueFingerprint(issue),
          comment: '另一处同类问题',
          line: 14,
          recordedAt: 100,
          reason: '先豁免了隔壁的',
        }),
        seedRecord({
          id: 'exact-second',
          fingerprint: issueFingerprint(issue),
          comment: '目标问题',
          line: 12,
          recordedAt: 200,
          sedimentedTo: { ruleId: 'r9', ruleName: '规则九', at: 1 },
        }),
      ]),
    )
    const store = useGovernanceIssuesStore()
    expect(store.records).toHaveLength(2)

    // 处置翻转：两段式应先精确命中 exact-second，而非数组在前的 loose-first
    store.record('repo-a', issue, 'comply', '改为遵守')
    expect(store.records).toHaveLength(2)
    const exactRecord = store.records.find((r) => r.id === 'exact-second')!
    const looseRecord = store.records.find((r) => r.id === 'loose-first')!
    expect(exactRecord.disposition).toBe('comply')
    expect(exactRecord.reason).toBe('改为遵守')
    expect(exactRecord.sedimentedTo).toBeUndefined() // 翻转清的是精确命中记录的回执
    // 宽松记录毫发无损：处置与理由未被覆盖
    expect(looseRecord.disposition).toBe('exempt')
    expect(looseRecord.reason).toBe('先豁免了隔壁的')
  })

  it('宽松命中处置约束（P1-15①补丁 3）：同桶仅 exempt 记录时录 comply 不翻转不清回执，改为新增；处置一致时宽松幂等更新', () => {
    const issue = makeIssue('第三条同类问题') // file a.ts / line 9 / type bug，与种子同桶（桶 1：行 6~10）
    localStorage.setItem(
      KEY,
      JSON.stringify([
        // 同桶仅一条 exempt 记录（带宽松键 + 沉淀回执）：无处置约束的旧实现会按数组序命中它并触发翻转/清回执
        seedRecord({
          id: 'exempt-rec',
          fingerprint: '精确指纹甲',
          looseFingerprint: looseIssueFingerprint(issue),
          comment: '第 8 行判空缺失已豁免',
          line: 8,
          disposition: 'exempt',
          recordedAt: 100,
          reason: '误报，已豁免',
          sedimentedTo: { ruleId: 'r1', ruleName: '规则一', at: 1 },
        }),
      ]),
    )
    const store = useGovernanceIssuesStore()

    // 对同桶新问题做 comply 处置：宽松指纹撞上 exempt-rec 但处置不一致 → 不命中 → 新增记录
    store.record('repo-a', issue, 'comply', '遵守处理')
    const exemptRec = store.records.find((r) => r.id === 'exempt-rec')!
    expect(exemptRec.disposition).toBe('exempt') // 未被翻转
    expect(exemptRec.reason).toBe('误报，已豁免') // 理由未被覆盖
    expect(exemptRec.sedimentedTo).toBeDefined() // 沉淀回执未被清
    expect(store.records).toHaveLength(2)
    const added = store.records[1]
    expect(added.disposition).toBe('comply')
    expect(added.reason).toBe('遵守处理')
    expect(added.looseFingerprint).toBe(looseIssueFingerprint(issue))

    // 同问题再来一次 comply：宽松 + 处置一致 → 命中 added 做幂等理由更新（exempt-rec 依旧不被波及）
    store.record('repo-a', issue, 'comply', '补充理由')
    expect(store.records).toHaveLength(2)
    expect(added.reason).toBe('补充理由')
    expect(store.records.find((r) => r.id === 'exempt-rec')!.reason).toBe('误报，已豁免')
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
