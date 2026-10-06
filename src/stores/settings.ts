import { defineStore } from 'pinia'
import { providers } from '../services/platforms'
import { deleteSecret, getSecret, setSecret } from '../services/secret'
import { loadJson, loadString, persistJson, persistString } from '../services/storage'
import type { Platform } from '../types/platform'

const TOKEN_KEY_PREFIX = 'mergehub:token:'

/** 推送目标策略：same-name = 同名硬指定；ask = 每次弹框询问 */
export type PushTargetMode = 'same-name' | 'ask'

/** 推送目标：remote 为远程仓库名（如 origin），branch 为远端分支名 */
export interface PushTarget {
  remote: string
  branch: string
}

/** 单个仓库的推送目标记忆：last 为最后一次推送的目标，list 为历史记录（新在前） */
export interface PushTargetRecord {
  last: PushTarget | null
  list: PushTarget[]
}

const PUSH_MODE_KEY = 'mergehub:pushMode'
const PUSH_TARGETS_KEY = 'mergehub:pushTargets'
const PUSH_TARGET_HISTORY_LIMIT = 20

/** 归一化推送目标：剔除两端空白，branch 为空视为无效；非对象或字段非字符串的坏条目直接丢弃 */
function normalizePushTarget(target: unknown): PushTarget | null {
  if (!target || typeof target !== 'object') return null
  const { remote, branch } = target as { remote?: unknown; branch?: unknown }
  if (typeof remote !== 'string' || typeof branch !== 'string') return null
  const trimmedBranch = branch.trim()
  if (!trimmedBranch) return null
  return { remote: remote.trim(), branch: trimmedBranch }
}

/** 推送目标等价判断：remote+branch 双键全等（记录去重、迁移去重与删除共用） */
function samePushTarget(a: PushTarget, b: PushTarget): boolean {
  return a.remote === b.remote && a.branch === b.branch
}

/** 归一化整份记忆数据并迁移旧版格式：旧版 last/list 仅存分支名字符串 → remote 置空；无有效条目的仓库不保留 */
function normalizePushTargets(raw: unknown): Record<string, PushTargetRecord> {
  if (!raw || typeof raw !== 'object') return {}
  const result: Record<string, PushTargetRecord> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  for (const [repoPath, value] of entries) {
    // __proto__ 跳过：纵深第二层（第一层 loadJson 源头 stripProtoKey），防止回写触发原型 setter
    if (repoPath === '__proto__') continue
    if (!value || typeof value !== 'object') continue
    const record = value as { last?: unknown; list?: unknown }
    const list: PushTarget[] = []
    if (Array.isArray(record.list)) {
      for (const item of record.list) {
        const candidate = typeof item === 'string' ? { remote: '', branch: item } : (item as PushTarget)
        const normalized = normalizePushTarget(candidate)
        if (normalized && !list.some((t) => samePushTarget(t, normalized))) {
          list.push(normalized)
        }
      }
    }
    const rawLast = typeof record.last === 'string' ? { remote: '', branch: record.last } : (record.last as PushTarget | null | undefined)
    const last = rawLast ? normalizePushTarget(rawLast) : null
    if (!last && list.length === 0) continue
    result[repoPath] = { last, list }
  }
  return result
}

export interface AccountState {
  token: string
  baseUrl: string
  loaded: boolean
  /** 连接测试进行中 */
  verifying?: boolean
  /** 验证成功后记录的账号用户名 */
  verifiedName?: string
  /** 验证失败原因 */
  verifyError?: string
}

function baseUrlStorageKey(platform: Platform): string {
  return `mergehub:baseUrl:${platform}`
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    accounts: {
      github: { token: '', baseUrl: '', loaded: false },
      gitlab: { token: '', baseUrl: '', loaded: false },
      gitee: { token: '', baseUrl: '', loaded: false },
    } as Record<Platform, AccountState>,
    /** 本地仓库推送目标策略（默认同名硬指定） */
    pushMode: 'same-name' as PushTargetMode,
    /** 各仓库的推送目标记忆，key 为仓库路径 */
    pushTargets: {} as Record<string, PushTargetRecord>,
  }),
  actions: {
    async loadAccount(platform: Platform) {
      const account = this.accounts[platform]
      try {
        account.token = (await getSecret(`${TOKEN_KEY_PREFIX}${platform}`)) ?? ''
      } catch {
        account.token = ''
      }
      account.baseUrl = loadString(baseUrlStorageKey(platform)) ?? ''
      account.loaded = true
    },
    async saveAccount(platform: Platform) {
      const account = this.accounts[platform]
      const token = account.token.trim()
      if (token) {
        account.token = token
        await setSecret(`${TOKEN_KEY_PREFIX}${platform}`, token)
      } else {
        await deleteSecret(`${TOKEN_KEY_PREFIX}${platform}`)
      }
      // baseUrl 是自建实例的连接入口：丢失后令牌虽在但连不上，用户须重新手填——
      // 落盘失败向上抛错（UI 层 catch 后 toast），与 token 的 setSecret 失败同一暴露级别
      const ok = persistString(baseUrlStorageKey(platform), account.baseUrl.trim())
      if (!ok) {
        throw new Error('Base URL 保存失败（存储空间不足或访问受限），重新打开应用后需重新填写')
      }
      account.loaded = true
      if (token) {
        await this.verifyAccount(platform)
      } else {
        account.verifiedName = ''
        account.verifyError = ''
      }
    },
    /** 连接测试：调平台 /user 接口验证令牌，成功记录登录名，失败记录原因 */
    async verifyAccount(platform: Platform) {
      const account = this.accounts[platform]
      if (!account.token.trim()) return
      account.verifying = true
      account.verifyError = ''
      try {
        account.verifiedName = await providers[platform].fetchAccountUser({
          platform,
          token: account.token.trim(),
          baseUrl: account.baseUrl.trim(),
        })
      } catch (err) {
        account.verifiedName = ''
        account.verifyError = err instanceof Error ? err.message : String(err)
      } finally {
        account.verifying = false
      }
    },
    /** 读取推送目标偏好（App 启动时调用一次；旧版仅记分支名的数据自动迁移） */
    loadPushPrefs() {
      const mode = loadString(PUSH_MODE_KEY)
      if (mode === 'same-name' || mode === 'ask') {
        this.pushMode = mode
      }
      try {
        const parsed = loadJson(PUSH_TARGETS_KEY)
        this.pushTargets = normalizePushTargets(parsed)
      } catch {
        this.pushTargets = {}
      }
    },
    /** 切换推送目标策略并写穿 localStorage */
    setPushMode(mode: PushTargetMode) {
      this.pushMode = mode
      // 推送偏好属便利性低敏数据（丢了仅回落默认策略），失败按 storage 层 warn 留痕即可，不为它加 UI 提示
      persistString(PUSH_MODE_KEY, mode)
    },
    /** 推送成功后记录推送目标：remote+branch 双键去重，last 置顶并截断至上限 */
    recordPushTarget(repoPath: string, target: PushTarget) {
      const normalized = normalizePushTarget(target)
      if (!normalized) return
      const prev = this.pushTargets[repoPath]
      this.pushTargets = {
        ...this.pushTargets,
        [repoPath]: {
          last: normalized,
          list: [normalized, ...(prev?.list ?? []).filter((item) => !samePushTarget(item, normalized))].slice(0, PUSH_TARGET_HISTORY_LIMIT),
        },
      }
      // 推送目标记忆可自动重建（每次推送成功重新记录），丢失成本≈0，失败 warn 留痕即可，刻意不做 UI 提示
      persistJson(PUSH_TARGETS_KEY, this.pushTargets)
    },
    /** 删除某仓库的历史记录项（remote+branch 双键匹配）；last 被删时回落到剩余首项，全部为空时移除该仓库条目 */
    removePushTarget(repoPath: string, target: PushTarget) {
      const record = this.pushTargets[repoPath]
      if (!record) return
      const normalized = normalizePushTarget(target)
      if (!normalized) return
      const list = record.list.filter((item) => !samePushTarget(item, normalized))
      const last = record.last && samePushTarget(record.last, normalized) ? (list[0] ?? null) : record.last
      const next = { ...this.pushTargets }
      if (last || list.length > 0) {
        next[repoPath] = { last, list }
      } else {
        delete next[repoPath]
      }
      this.pushTargets = next
      // 同 recordPushTarget：低敏可自动重建，失败 warn 留痕即可
      persistJson(PUSH_TARGETS_KEY, this.pushTargets)
    },
  },
})
