// @vitest-environment jsdom
// P1-17 生产模式门面行为：预热/迁移/分级落盘/未登记 key 拒绝 + REGISTRY 防漏断言。
// 机制：mock @tauri-apps/api/core 的 invoke，并在 window 上注入 __TAURI_INTERNALS__
// 使门面进入「生产模式」判定；storage_write 的入参即文件信封断言点。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapStorage,
  failedKeys,
  flushState,
  loadJson,
  loadString,
  persistJson,
  persistString,
  removeKey,
  STORAGE_REGISTRY,
  __resetStorageForTest,
} from '../storage'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// 既有 store/服务声明的全部存储 key 字面量（静态清单，手工维护；项目无 @types/node
// 不能读源码）。双向断言防漂移：① 清单 ⊆ REGISTRY（新增 key 漏登记直接红）；
// ② REGISTRY 每个文件至少被一个清单 key 命中（REGISTRY 单边加条目也红，提示同步清单）。
// 已知边界（评审四轮 #9）：清单与 REGISTRY **同时**漏改同一 key 时两个断言都无法发现——
// 该缺口需源码扫描（读 store 源文件提取字面量）才能关掉，受无 @types/node 限制暂不可行；
// 缓解：新增存储 key 的 PR 改动点必然含 storage.ts 的 REGISTRY，code review 可见性高
const STORE_KEY_LITERALS = [
  'mergehub:ai-profiles',
  'mergehub:ai-results',
  'mergehub:ai-review-logs',
  'mergehub:ai-review-history',
  'mergehub:ai-review-resume',
  'mergehub:rule-sets',
  'mergehub:governance-issues',
  'mergehub:watchlist',
  'mergehub:local-repos',
  'mergehub:local-review:drafts',
  'mergehub:pushMode',
  'mergehub:pushTargets',
  'mergehub.ai-debug.last-log-path',
]

function writes(): { file: string; content: string }[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === 'storage_write' && c[1].key !== 'migration/completed.json')
    .map((c) => ({ file: c[1].key as string, content: c[1].content as string }))
}

function writeOf(file: string): Record<string, unknown> {
  const hits = writes().filter((w) => w.file === file)
  const hit = hits.length > 0 ? hits[hits.length - 1] : undefined
  expect(hit, `未发生对 ${file} 的写入`).toBeTruthy()
  return JSON.parse(hit!.content) as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(null) // storage_read 默认返回 null（文件侧全空）
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  __resetStorageForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('REGISTRY 防漏登记', () => {
  it('全部 store KEY 字面量已登记（REGISTRY 内含对应条目）', () => {
    for (const key of STORE_KEY_LITERALS) {
      expect(STORAGE_REGISTRY[key], `REGISTRY 缺少 ${key} 的登记`).toBeTruthy()
    }
  })

  it('REGISTRY 反向覆盖：每个登记条目都能被清单 key 命中（防单边漂移）', () => {
    const listed = new Set(STORE_KEY_LITERALS)
    for (const key of Object.keys(STORAGE_REGISTRY)) {
      expect(listed.has(key), `REGISTRY 中的 ${key} 不在测试清单内，请同步 STORE_KEY_LITERALS`).toBe(true)
    }
  })

  it('REGISTRY 全部路径合法：相对路径、无穿越、限定三域或迁移目录', () => {
    for (const [key, file] of Object.entries(STORAGE_REGISTRY)) {
      expect(file.startsWith('settings/') || file.startsWith('rules/') || file.startsWith('repos/'),
        `${key} 的路径 ${file} 不在 settings/rules/repos 三域内`).toBe(true)
      expect(file.includes('..'), `${key} 的路径 ${file} 含穿越段`).toBe(false)
      expect(file.endsWith('.json'), `${key} 的路径 ${file} 应为 .json 文件`).toBe(true)
    }
  })
})

describe('bootstrapStorage：预热与一次性迁移', () => {
  it('迁移：浏览器存储有旧数据时导入缓存并落盘 + 写标记；文件信封形态正确', async () => {
    localStorage.setItem('mergehub:rule-sets', JSON.stringify({ sets: [1], activeSetId: 's1' }))
    localStorage.setItem('mergehub:watchlist', JSON.stringify({ github: ['a/b'] }))
    await bootstrapStorage()

    const rules = writeOf('rules/rule-sets.json')
    expect(rules).toEqual({ 'mergehub:rule-sets': { sets: [1], activeSetId: 's1' } })
    const watch = writeOf('repos/watchlist.json')
    expect(watch).toEqual({ 'mergehub:watchlist': { github: ['a/b'] } })
    const markerCall = invokeMock.mock.calls.find(
      (c) => c[0] === 'storage_write' && c[1].key === 'migration/completed.json',
    )
    expect(markerCall, '未写入迁移完成标记').toBeTruthy()
    const marker = JSON.parse(markerCall![1].content as string) as { migrated: number }
    expect(marker.migrated).toBe(2)

    // 预热后同步读得迁移值
    expect(loadJson('mergehub:rule-sets')).toEqual({ sets: [1], activeSetId: 's1' })
  })

  it('已有迁移标记时不重复迁移（从备份恢复带回旧数据不重迁）', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { key: string; content?: string }) => {
      if (cmd === 'storage_read' && args.key === 'migration/completed.json') {
        return '{"migrated":5}'
      }
      return null
    })
    localStorage.setItem('mergehub:rule-sets', '{"stale":true}')
    await bootstrapStorage()
    expect(writes()).toHaveLength(0)
    expect(loadJson('mergehub:rule-sets')).toBeNull() // 文件侧无值 → null 回退默认
  })

  it('标记丢失后二次迁移：文件侧已有数据的文件跳过（防陈旧 localStorage 以旧覆新）', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === 'storage_read') {
        // 标记丢失；rules 文件侧已有用户更新后的数据
        if (args.key === 'rules/rule-sets.json') {
          return JSON.stringify({ 'mergehub:rule-sets': { sets: ['user-new'], activeSetId: 'n' } })
        }
        return null
      }
      return undefined
    })
    localStorage.setItem('mergehub:rule-sets', '{"stale":true}') // 浏览器侧陈旧快照
    localStorage.setItem('mergehub:watchlist', '{"github":["fresh-migrate"]}') // 文件侧为空，正常迁移
    await bootstrapStorage()
    const files = writes().map((w) => w.file)
    expect(files).not.toContain('rules/rule-sets.json') // 已有数据的文件不被覆盖
    expect(files).toContain('repos/watchlist.json') // 空文件正常迁移
    expect(loadJson('mergehub:rule-sets')).toEqual({ sets: ['user-new'], activeSetId: 'n' })
    expect(loadJson('mergehub:watchlist')).toEqual({ github: ['fresh-migrate'] })
  })

  it('预热：文件侧已有数据时信封拆包进缓存，store 同步读生效', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === 'storage_read' && args.key === 'rules/rule-sets.json') {
        return JSON.stringify({
          'mergehub:rule-sets': { sets: ['from-file'], activeSetId: 'x' },
        })
      }
      return null
    })
    await bootstrapStorage()
    expect(loadJson('mergehub:rule-sets')).toEqual({ sets: ['from-file'], activeSetId: 'x' })
  })
})

describe('生产模式写入：分级落盘', () => {
  it('写穿 key：persistJson 同步触发 storage_write，无需等防抖', async () => {
    await bootstrapStorage()
    expect(persistJson('mergehub:rule-sets', { sets: [], activeSetId: 'a' })).toBe(true)
    await vi.waitFor(() => {
      expect(writeOf('rules/rule-sets.json')).toEqual({
        'mergehub:rule-sets': { sets: [], activeSetId: 'a' },
      })
    })
  })

  it('缓存 key：合并防抖窗口内的多次写，最后一次生效', async () => {
    vi.useFakeTimers()
    try {
      await bootstrapStorage()
      persistJson('mergehub:ai-results', { v: 1 })
      persistJson('mergehub:ai-results', { v: 2 })
      persistJson('mergehub:ai-review-logs', { l: 1 })
      expect(writes()).toHaveLength(0) // 防抖窗口内不落盘
      await vi.advanceTimersByTimeAsync(400)
      const results = writeOf('repos/review/results.json')
      expect(results).toEqual({ 'mergehub:ai-results': { v: 2 } }) // 合并后最后一次
      expect(writeOf('repos/review/logs.json')).toEqual({ 'mergehub:ai-review-logs': { l: 1 } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('同文件多 key 合并信封：pushMode/pushTargets 同写 settings/push.json 不互相覆盖', async () => {
    await bootstrapStorage()
    persistJson('mergehub:pushMode', 'ask')
    persistJson('mergehub:pushTargets', { github: { r: ['x/y'] } })
    await vi.waitFor(() => {
      expect(writeOf('settings/push.json')).toEqual({
        'mergehub:pushMode': 'ask',
        'mergehub:pushTargets': { github: { r: ['x/y'] } },
      })
    })
  })

  it('未登记 key 拒绝写入（防静默丢数据）', async () => {
    await bootstrapStorage()
    expect(persistJson('unknown:key', { a: 1 })).toBe(false)
    expect(persistString('unknown:key', 'v')).toBe(false)
    expect(writes()).toHaveLength(0)
  })

  it('removeKey 只删本 key：同文件其他 key 保留，信封重写而非整删文件', async () => {
    await bootstrapStorage()
    persistJson('mergehub:pushMode', 'ask')
    persistJson('mergehub:pushTargets', { github: { r: ['x/y'] } })
    await vi.waitFor(() => {
      expect(writeOf('settings/push.json')).toEqual({
        'mergehub:pushMode': 'ask',
        'mergehub:pushTargets': { github: { r: ['x/y'] } },
      })
    })
    removeKey('mergehub:pushMode')
    await vi.waitFor(() => {
      // pushMode 从信封消失，pushTargets 原样保留（绝不整删 settings/push.json）
      expect(writeOf('settings/push.json')).toEqual({
        'mergehub:pushTargets': { github: { r: ['x/y'] } },
      })
    })
    expect(loadJson('mergehub:pushMode')).toBeNull()
  })

  it('removeKey 删掉文件内最后一个 key：空信封 {} 覆盖落盘，重启预热不再复活', async () => {
    await bootstrapStorage()
    persistString('mergehub.ai-debug.last-log-path', 'D:\\logs\\a.log')
    await vi.waitFor(() => {
      expect(writeOf('settings/misc.json')).toEqual({
        'mergehub.ai-debug.last-log-path': { __t: 'raw', __raw: 'D:\\logs\\a.log' },
      })
    })
    removeKey('mergehub.ai-debug.last-log-path')
    await vi.waitFor(() => {
      // 关键断言：文件被 {} 覆盖（旧实现短路不写盘，删除重启后复活）
      expect(writeOf('settings/misc.json')).toEqual({})
    })
    expect(loadString('mergehub.ai-debug.last-log-path')).toBeNull()
  })

  it('预热读取失败置写保护：persist 更新内存但不落盘（防默认值覆盖磁盘数据）', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === 'storage_read' && args.key === 'rules/rule-sets.json') {
        return '{broken json' // 损坏文件触发预热失败
      }
      return null
    })
    await bootstrapStorage()
    expect(persistJson('mergehub:rule-sets', { sets: [], activeSetId: 'a' })).toBe(true)
    // 内存可读（本会话功能正常）
    expect(loadJson('mergehub:rule-sets')).toEqual({ sets: [], activeSetId: 'a' })
    // 但不落盘（磁盘上的数据不被会话态覆盖）
    expect(writes()).toHaveLength(0)
  })

  it('原始字符串读写走缓存（loadString 不经 JSON 解析）', async () => {
    await bootstrapStorage()
    expect(persistString('mergehub.ai-debug.last-log-path', 'D:\\logs\\a.log')).toBe(true)
    expect(loadString('mergehub.ai-debug.last-log-path')).toBe('D:\\logs\\a.log')
    await vi.waitFor(() => {
      // 原始串信封形态：__t + __raw 双键包裹（值恰为合法 JSON 字面量时也不会被误解析）
      expect(writeOf('settings/misc.json')).toEqual({
        'mergehub.ai-debug.last-log-path': { __t: 'raw', __raw: 'D:\\logs\\a.log' },
      })
    })
  })

  it('原始串恰为 JSON 字面量时往返保真：写入 "123" 读回仍是字符串 "123"', async () => {
    await bootstrapStorage()
    expect(persistString('mergehub.ai-debug.last-log-path', '123')).toBe(true)
    // 信封内带 __t + __raw 双键标记
    await vi.waitFor(() => {
      expect(writeOf('settings/misc.json')).toEqual({
        'mergehub.ai-debug.last-log-path': { __t: 'raw', __raw: '123' },
      })
    })
    // 模拟重启：重置后按文件信封预热回填
    invokeMock.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === 'storage_read' && args.key === 'settings/misc.json') {
        return JSON.stringify({
          'mergehub.ai-debug.last-log-path': { __t: 'raw', __raw: '123' },
        })
      }
      return null
    })
    __resetStorageForTest()
    await bootstrapStorage()
    expect(loadString('mergehub.ai-debug.last-log-path')).toBe('123')
  })

  it('落盘失败：failedKeys 留痕 + flushState.failSeq 自增，恢复后重写成功清痕', async () => {
    await bootstrapStorage()
    invokeMock.mockRejectedValueOnce(new Error('disk full'))
    persistJson('mergehub:rule-sets', { sets: [], activeSetId: 'a' })
    await vi.waitFor(() => {
      expect(failedKeys.has('mergehub:rule-sets')).toBe(true)
      expect(flushState.value.failSeq).toBe(1)
    })
    // 恢复：重写成功后清痕回正
    persistJson('mergehub:rule-sets', { sets: [], activeSetId: 'b' })
    await vi.waitFor(() => {
      expect(failedKeys.has('mergehub:rule-sets')).toBe(false)
      expect(flushState.value.failSeq).toBe(1) // failSeq 只增不清零（watch 值变化语义）
      expect(flushState.value.ok).toBe(true)
    })
  })
})
