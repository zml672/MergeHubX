// @vitest-environment jsdom
// 本文件覆盖 store 持久化归一化路径，依赖 localStorage，需显式声明 jsdom 环境（默认 node）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
// secret 层走 Tauri invoke，jsdom 测试环境不可用：mock 掉（本文件只测 localStorage 路径）
vi.mock('../../services/secret', () => ({
  getSecret: vi.fn(async () => ''),
  setSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
}))
import { useSettingsStore } from '../settings'

const MODE_KEY = 'mergehub:pushMode'
const TARGETS_KEY = 'mergehub:pushTargets'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('settings store：推送偏好归一化（loadPushPrefs）', () => {
  it('正常路径：现代结构完整读回，推送策略仅接受合法枚举', () => {
    localStorage.setItem(MODE_KEY, 'ask')
    localStorage.setItem(
      TARGETS_KEY,
      JSON.stringify({
        repoA: {
          last: { remote: 'origin', branch: 'main' },
          list: [
            { remote: 'origin', branch: 'main' },
            { remote: 'up', branch: 'dev' },
          ],
        },
      }),
    )
    const store = useSettingsStore()
    store.loadPushPrefs()
    expect(store.pushMode).toBe('ask')
    expect(store.pushTargets.repoA).toEqual({
      last: { remote: 'origin', branch: 'main' },
      list: [
        { remote: 'origin', branch: 'main' },
        { remote: 'up', branch: 'dev' },
      ],
    })
  })

  it('脏数据路径：旧版字符串格式迁移、坏条目剔除、空仓库条目整体移除、非法模式忽略', () => {
    localStorage.setItem(MODE_KEY, 'hacked-mode') // 非法 → 保持默认 same-name
    localStorage.setItem(
      TARGETS_KEY,
      JSON.stringify({
        repoA: { last: 'dev', list: ['dev', 'main', 'dev'] }, // 全旧格式：字符串迁移 + 去重
        repoB: { list: [{ remote: 'o', branch: '' }, null] }, // 无任何有效条目 → 整仓剔除
        repoC: 'not-an-object', // 非对象 → 剔除
        repoD: { last: 42, list: ['ok'] }, // last 非法被剔，list 有效保留
      }),
    )
    const store = useSettingsStore()
    store.loadPushPrefs()
    expect(store.pushMode).toBe('same-name')
    expect(store.pushTargets.repoA).toEqual({
      last: { remote: '', branch: 'dev' },
      list: [
        { remote: '', branch: 'dev' },
        { remote: '', branch: 'main' },
      ],
    })
    expect(store.pushTargets.repoB).toBeUndefined()
    expect(store.pushTargets.repoC).toBeUndefined()
    expect(store.pushTargets.repoD).toEqual({
      last: null,
      list: [{ remote: '', branch: 'ok' }],
    })
  })
})

describe('settings store：推送目标记忆（recordPushTarget / removePushTarget）', () => {
  it('recordPushTarget：remote+branch 双键去重、last 置顶、写穿 localStorage', () => {
    const store = useSettingsStore()
    store.recordPushTarget('r', { remote: 'origin', branch: 'main' })
    store.recordPushTarget('r', { remote: 'up', branch: 'dev' })
    store.recordPushTarget('r', { remote: 'origin', branch: 'main' }) // 重复：移动到首位而非新增
    expect(store.pushTargets.r).toEqual({
      last: { remote: 'origin', branch: 'main' },
      list: [
        { remote: 'origin', branch: 'main' },
        { remote: 'up', branch: 'dev' },
      ],
    })
    const persisted = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '{}') as typeof store.pushTargets
    expect(persisted.r.list).toHaveLength(2)
  })

  it('removePushTarget：删除 last 回落到剩余首项；全部删除后移除仓库条目', () => {
    const store = useSettingsStore()
    store.recordPushTarget('r', { remote: 'origin', branch: 'main' })
    store.recordPushTarget('r', { remote: 'up', branch: 'dev' })

    store.removePushTarget('r', { remote: 'up', branch: 'dev' }) // 删除 last → 回落
    expect(store.pushTargets.r.last).toEqual({ remote: 'origin', branch: 'main' })
    expect(store.pushTargets.r.list).toEqual([{ remote: 'origin', branch: 'main' }])

    store.removePushTarget('r', { remote: 'origin', branch: 'main' }) // 全删 → 条目移除
    expect(store.pushTargets.r).toBeUndefined()
    expect(localStorage.getItem(TARGETS_KEY)).not.toContain('"r"')
  })

  it('持久化失败分级：saveAccount 的 baseUrl 落盘失败抛错（高敏，UI 需提示），推送目标记忆失败静默 warn（低敏可自动重建）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const store = useSettingsStore()

    // baseUrl：自建实例连接入口，丢失须重新手填 → 抛错给 UI catch 提示
    store.accounts.github.baseUrl = 'https://ghe.example.com'
    await expect(settingsStoreSaveAccount(store, 'github')).rejects.toThrow(/Base URL 保存失败/)
    // 内存态不受影响，重试即可

    // 推送目标记忆：便利性数据，推送成功自动重建 → 不抛错，仅 storage 层 warn 留痕
    expect(() => store.recordPushTarget('r', { remote: 'origin', branch: 'main' })).not.toThrow()
    expect(store.pushTargets.r?.last).toEqual({ remote: 'origin', branch: 'main' })

    vi.mocked(Storage.prototype.setItem).mockRestore()
    warn.mockRestore()
  })
})

/** saveAccount 是 async action：helper 收窄类型，测试内直调 */
function settingsStoreSaveAccount(store: ReturnType<typeof useSettingsStore>, platform: 'github') {
  return store.saveAccount(platform)
}
