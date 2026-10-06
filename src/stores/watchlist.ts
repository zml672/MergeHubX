import { defineStore } from 'pinia'
import { ref } from 'vue'
import { loadJsonObject, persistJson } from '../services/storage'
import type { Platform } from '../types/platform'

const STORAGE_KEY = 'mergehub:watchlist'

type RepoMap = Record<Platform, string[]>

/** 数组类型守卫 + 元素级过滤：存量/损坏数据若存了非数组字段（如 {"github":"x"}），nullish 兜底（?? []）拦不住，后续 push/includes 会运行时崩溃 */
function pickRepos(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function load(): RepoMap {
  const parsed = loadJsonObject<Partial<RepoMap>>(STORAGE_KEY, {})
  return {
    github: pickRepos(parsed.github),
    gitlab: pickRepos(parsed.gitlab),
    gitee: pickRepos(parsed.gitee),
  }
}

export const useWatchlistStore = defineStore('watchlist', () => {
  const repos = ref<RepoMap>(load())
  /** 持久化结果状态：ok=false 时由 RemoteReviewView watch failSeq 提示后果；内存态不受影响，
   * 下次 add/remove 自动重试整份落盘。failSeq 每次失败自增（成功不变）作为 UI watch 的监听
   * 目标——Vue 的 watch 只在值变化时触发，布尔标志在连续失败时保持 false 不变，第二次起的
   * 失败不会再次弹提示；自增序号每次失败必变，保证每次失败都有提示 */
  const persistState = ref<{ ok: boolean; failSeq: number }>({ ok: true, failSeq: 0 })

  function persist(): void {
    const ok = persistJson(STORAGE_KEY, repos.value)
    persistState.value = { ok, failSeq: persistState.value.failSeq + (ok ? 0 : 1) }
  }

  function add(platform: Platform, repo: string): boolean {
    const value = repo.trim()
    if (!value || repos.value[platform].includes(value)) return false
    repos.value[platform].push(value)
    persist()
    return true
  }

  function remove(platform: Platform, repo: string): void {
    repos.value[platform] = repos.value[platform].filter((r) => r !== repo)
    persist()
  }

  return { repos, persistState, add, remove }
})
