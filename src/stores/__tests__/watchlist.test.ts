// @vitest-environment jsdom
// 覆盖 watchlist store 的持久化归一化路径，依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWatchlistStore } from '../watchlist'

const WATCHLIST_KEY = 'mergehub:watchlist'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('watchlist store：存量脏数据守卫', () => {
  it('正常路径：完整结构读回，各平台列表保持原序', () => {
    localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify({ github: ['a/b', 'c/d'], gitlab: ['e/f'], gitee: [] }),
    )
    const store = useWatchlistStore()
    expect(store.repos).toEqual({ github: ['a/b', 'c/d'], gitlab: ['e/f'], gitee: [] })
  })

  it('字段存非数组：字符串/对象/数字全部回退空数组，add/remove 不崩溃', () => {
    localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify({ github: 'x', gitlab: { 0: 'y' }, gitee: 42 }),
    )
    const store = useWatchlistStore()
    expect(store.repos).toEqual({ github: [], gitlab: [], gitee: [] })
    expect(() => store.add('github', 'new/repo')).not.toThrow()
    expect(store.repos.github).toContain('new/repo')
  })

  it('数组元素非字符串：坏元素剔除、好元素保留（类型级守卫落到元素）', () => {
    localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify({ github: ['ok/repo', 42, null, { id: 1 }, 'fine/repo'] }),
    )
    const store = useWatchlistStore()
    expect(store.repos.github).toEqual(['ok/repo', 'fine/repo'])
  })

  it('根数据非对象（数组/原始类型/解析失败）：整体回退空仓库表', () => {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(['not', 'a', 'map']))
    expect(useWatchlistStore().repos).toEqual({ github: [], gitlab: [], gitee: [] })

    localStorage.setItem(WATCHLIST_KEY, 'not-json{{')
    expect(useWatchlistStore().repos).toEqual({ github: [], gitlab: [], gitee: [] })
  })

  it('__proto__ 自有键：loadJsonObject 源头剔除且 repos 原型完好', () => {
    // 构造必须用原始 JSON 文本直接入库：对象字面量里的 __proto__: 触发原型设置而非
    // 创建自有键，JSON.stringify 输出不含该键，用例会空转（守卫删了断言照样绿）。
    // 只有 JSON.parse 原始文本才产生自有可枚举 __proto__ 键（与真实损坏数据入库路径一致）
    localStorage.setItem(WATCHLIST_KEY, '{"__proto__":{"github":["x"]},"github":["ok/repo"]}')
    const store = useWatchlistStore()
    expect(Object.keys(store.repos).sort()).toEqual(['gitee', 'github', 'gitlab'])
    expect(store.repos.github).toEqual(['ok/repo'])
    expect(Object.getPrototypeOf(store.repos)).toBe(Object.prototype)
  })
})

describe('watchlist store：持久化失败感知（persistState.failSeq）', () => {
  it('配额超限：failSeq 自增且 ok 翻 false、内存态变更保留，恢复后下次写操作自动重试落盘并回正', () => {
    const store = useWatchlistStore()
    expect(store.persistState).toEqual({ ok: true, failSeq: 0 })

    // 配额超限场景：jsdom 下 localStorage.setItem 是原型方法，实例赋值不生效，
    // 须 spy Storage.prototype（与 reviewRules.test.ts 同一机制）
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    store.add('github', 'bad/repo')
    expect(store.persistState.ok).toBe(false)
    expect(store.persistState.failSeq).toBe(1)
    // 关注列表是手工维护数据：失败时内存态不受影响，本会话内功能照常
    expect(store.repos.github).toContain('bad/repo')

    // 恢复写通道后重试成功，ok 回正，盘上内容与内存一致
    spy.mockRestore()
    store.remove('github', 'bad/repo')
    expect(store.persistState.ok).toBe(true)
    expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '{}')).toEqual({
      github: [],
      gitlab: [],
      gitee: [],
    })
  })

  it('连续两次持久化失败：failSeq 自增到 2，保证 UI watch（值变化触发）每次失败都能弹提示', () => {
    const store = useWatchlistStore()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    // 布尔标志方案的缺陷场景：连续失败布尔保持 false 不变，watch 值不变化，第二次失败静默；
    // failSeq 方案下每次失败序号必变，watch 必触发
    store.add('github', 'bad/repo')
    store.add('gitlab', 'bad/two')
    spy.mockRestore()
    expect(store.persistState.ok).toBe(false)
    expect(store.persistState.failSeq).toBe(2)
  })
})
