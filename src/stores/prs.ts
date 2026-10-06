import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { providers } from '../services/platforms'
import { PLATFORMS, type Platform, type PullRequestSummary } from '../types/platform'
import { useSettingsStore } from './settings'
import { useWatchlistStore } from './watchlist'
import { useLocalReposStore } from './localRepos'

const POLL_INTERVAL = 60_000

export function repoKey(platform: Platform, repo: string): string {
  return `${platform}:${repo}`
}

export const usePrsStore = defineStore('prs', () => {
  const settings = useSettingsStore()
  const watchlist = useWatchlistStore()
  const localRepos = useLocalReposStore()

  const prCache = ref<Record<string, PullRequestSummary[]>>({})
  const prLoading = ref<Record<string, boolean>>({})
  const prErrors = ref<Record<string, string>>({})
  const lastUpdated = ref<number | null>(null)
  const polling = ref(false)
  const refreshingAll = ref(false)
  let timer: number | null = null

  const totalOpenCount = computed(() =>
    Object.values(prCache.value).reduce((sum, list) => sum + list.length, 0),
  )

  const watchedRepoCount = computed(() =>
    PLATFORMS.reduce((sum, p) => sum + watchlist.repos[p].length, 0),
  )

  function accountOf(platform: Platform) {
    const s = settings.accounts[platform]
    return { platform, token: s.token, baseUrl: s.baseUrl }
  }

  async function loadPrs(platform: Platform, repo: string) {
    const key = repoKey(platform, repo)
    prLoading.value[key] = true
    prErrors.value[key] = ''
    try {
      prCache.value[key] = await providers[platform].listPullRequests(
        accountOf(platform),
        { repo, state: 'open' },
      )
    } catch (err) {
      prErrors.value[key] = err instanceof Error ? err.message : String(err)
      prCache.value[key] = []
    } finally {
      prLoading.value[key] = false
    }
  }

  /** 清理单个仓库的请求列表缓存（仓库移除时调用），缓存字段的删除路径收敛于 store 内部 */
  function clearRepo(platform: Platform, repo: string) {
    const key = repoKey(platform, repo)
    delete prCache.value[key]
    delete prLoading.value[key]
    delete prErrors.value[key]
  }

  async function refreshAll() {
    const targets = PLATFORMS.flatMap((p) =>
      settings.accounts[p].token
        ? watchlist.repos[p].map((repo) => ({ platform: p, repo }))
        : [],
    )
    refreshingAll.value = true
    await Promise.all(targets.map((t) => loadPrs(t.platform, t.repo)))
    refreshingAll.value = false
    lastUpdated.value = Date.now()
  }

  function startPolling() {
    if (timer !== null) return
    polling.value = true
    void refreshAll()
    timer = window.setInterval(() => {
      void refreshAll()
      void localRepos.refreshChanges()
    }, POLL_INTERVAL)
  }

  function stopPolling() {
    if (timer === null) return
    window.clearInterval(timer)
    timer = null
    polling.value = false
  }

  function setPolling(enabled: boolean) {
    if (enabled) startPolling()
    else stopPolling()
  }

  return {
    prCache,
    prLoading,
    prErrors,
    lastUpdated,
    polling,
    refreshingAll,
    totalOpenCount,
    watchedRepoCount,
    loadPrs,
    clearRepo,
    refreshAll,
    startPolling,
    stopPolling,
    setPolling,
  }
})
