import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { getLocalDiff } from '../services/local/git'
import { loadJson, persistJson } from '../services/storage'

const STORAGE_KEY = 'mergehub:local-repos'

export interface LocalRepo {
  path: string
  name: string
}

function load(): LocalRepo[] {
  const parsed = loadJson(STORAGE_KEY)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((r) => Boolean(r) && typeof (r as LocalRepo).path === 'string') as LocalRepo[]
}

function repoName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/** 本地仓库列表：记录用户添加过的本地仓库目录，供本地仓库审阅使用 */
export const useLocalReposStore = defineStore('localRepos', () => {
  const repos = ref<LocalRepo[]>(load())

  function persist(): void {
    persistJson(STORAGE_KEY, repos.value)
  }

  function add(path: string): boolean {
    const value = path.trim()
    if (!value || repos.value.some((r) => r.path === value)) return false
    repos.value.push({ path: value, name: repoName(value) })
    persist()
    void refreshChanges()
    return true
  }

  function remove(path: string): void {
    repos.value = repos.value.filter((r) => r.path !== path)
    delete changeCounts[path]
    delete changeLoading[path]
    delete changeErrors[path]
    persist()
  }

  /** 本地仓库工作区变更文件数：path → 变更文件个数 */
  const changeCounts = reactive<Record<string, number>>({})
  const changeLoading = reactive<Record<string, boolean>>({})
  const changeErrors = reactive<Record<string, string>>({})

  /** 有变更的本地仓库数：一个仓库只要有变更即计 1（与远程 PR 一单一工单的口径对齐） */
  const changeTotal = computed(
    () => Object.values(changeCounts).filter((count) => count > 0).length,
  )

  let refreshInflight: Promise<void> | null = null

  /** 刷新全部本地仓库的工作区变更数（并发查询仅统计个数；进行中时复用同一请求） */
  function refreshChanges(): Promise<void> {
    if (refreshInflight) return refreshInflight
    refreshInflight = Promise.all(
      repos.value.map(async (r) => {
        changeLoading[r.path] = true
        changeErrors[r.path] = ''
        try {
          const diffs = await getLocalDiff(r.path)
          changeCounts[r.path] = diffs.length
        } catch (err) {
          changeErrors[r.path] = err instanceof Error ? err.message : String(err)
        } finally {
          changeLoading[r.path] = false
        }
      }),
    ).then(() => undefined)
    return refreshInflight.finally(() => {
      refreshInflight = null
    })
  }

  /** 以工作台加载结果同步单仓库统计：loadLocalRepo 成功后调用——本次加载已验证仓库可用，更新侧栏角标计数并清除后台统计路径的过时错误（否则 git init 后旧错误会一直残留） */
  function syncChangeStats(path: string, count: number): void {
    changeCounts[path] = count
    changeErrors[path] = ''
  }

  return {
    repos,
    add,
    remove,
    changeCounts,
    changeLoading,
    changeErrors,
    changeTotal,
    refreshChanges,
    syncChangeStats,
  }
})
