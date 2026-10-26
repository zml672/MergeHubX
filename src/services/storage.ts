/** 统一持久化门面（P1-3 收口 → P1-17 底座切换）。
 *
 *  双模设计（刻意约定）：
 *  - 生产模式（Tauri 环境 + bootstrapStorage 已完成）：读写走内存缓存，写入按
 *    分级策略落盘到文件（Rust storage_read/storage_write/storage_remove）。
 *    这是 P1-3 头注释预留的「迁移阀门」——底座切换只发生在本文件，7 个 store
 *    调用点零改动；Pinia 同步水合时序由 main.ts 先 await bootstrapStorage 保证。
 *  - 兼容模式（无 Tauri 的测试环境，或 bootstrap 尚未完成的防御路径）：保持
 *    P1-3 原语义直连浏览器存储——全部门面测试与 store 持久化测试（注入
 *    Storage.prototype 失败模拟等）的语义基础不动摇。
 *
 *  生产模式失败语义：persistJson 的同步返回值只反映「缓存已更新」（序列化失败/
 *  未登记 key 才返回 false——本地存储配额问题已随底座消失）；文件落盘失败经
 *  flushFile 捕获，驱动 flushState（响应式 failSeq）供全局提示，failedKeys 留痕。
 *
 *  一次性迁移：bootstrap 时若文件侧无迁移标记，把浏览器存储里的 mergehub:* 旧
 *  数据导入缓存并立即落盘，然后写标记（文件侧，防重迁）。浏览器存储保留不清
 *  （天然备份）；标记丢失时的二次迁移跳过文件侧已有数据的文件（文件优先于浏览器
 *  陈旧快照），不会以旧覆新。
 *
 *  版本约定（沿用）：新增持久化结构一律在负载中携带 v 数字字段（readSchemaVersion）。
 */

import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

/** 当前持久化负载的 schema 版本（新增持久化结构使用；存量结构为 0） */
export const CURRENT_SCHEMA_VERSION = 1

/** 防抖落盘间隔：缓存类数据连续写入的合并窗口 */
const DEBOUNCE_MS = 300

/** 迁移完成标记的存储路径（数据根下） */
const MIGRATION_MARKER_FILE = 'migration/completed.json'

/** 信封内原始串的包裹形态：带类型标记位（__t: 'raw'），避免与业务负载撞库——
 *  用户数据本身可能是 {"__raw": "..."} 形态，单一键判断会误判改型 */
const RAW_WRAPPER_KEY = '__raw'
const RAW_WRAPPER_TAG = '__t'

/**
 * REGISTRY：存储 key → 数据根下相对路径（单源映射表）。
 * 全部 store 的 STORAGE_KEY 常量必须登记在此，storageFile.test.ts 导入本表做
 * 防漏断言；生产模式下未登记 key 的写入被拒绝（warn + false），防静默丢数据。
 * 只读导出：消费方仅可查询，不可变更（变更会破坏 flush 聚合的不变量）。
 *
 * 目录三域（老大定稿）：settings 全局设置 / rules 规则治理 / repos 仓库域。
 * 说明：仓库域评审数据（results/logs/history/resume）v1 暂落 repos/review/ 平铺
 * 文件——按仓库 ID 分层需 index.json 仓库注册表先行，作为 P1-17 后续步骤，
 * 不阻塞底座切换（信封格式与路径登记方式已为此预留，届时只改本表 + 迁移）。
 */
export const STORAGE_REGISTRY: Readonly<Record<string, string>> = Object.freeze({
  // settings 域
  'mergehub:ai-profiles': 'settings/ai-profiles.json',
  'mergehub:pushMode': 'settings/push.json',
  'mergehub:pushTargets': 'settings/push.json',
  'mergehub.ai-debug.last-log-path': 'settings/misc.json',
  // rules 域
  'mergehub:rule-sets': 'rules/rule-sets.json',
  'mergehub:governance-issues': 'rules/governance-issues.json',
  // repos 域
  'mergehub:watchlist': 'repos/watchlist.json',
  'mergehub:local-repos': 'repos/local-repos.json',
  'mergehub:local-review:drafts': 'repos/local-review-drafts.json',
  'mergehub:ai-results': 'repos/review/results.json',
  'mergehub:ai-review-logs': 'repos/review/logs.json',
  'mergehub:ai-review-history': 'repos/review/history.json',
  'mergehub:ai-review-resume': 'repos/review/resume.json',
})

/** 门面内部统一走 STORAGE_REGISTRY（冻结表，无别名副本） */

/** 每文件在飞写盘 Promise 链：串行化同文件的 flush，防旧快照后完成覆盖新值 */
const inflightFlush = new Map<string, Promise<void>>()

/** 原始串 key 集合：persistString 写入的 key（信封包裹 __raw，读回不做 JSON 往返） */
const rawKeys = new Set<string>()

/** 写穿集合：不可再生数据（用户手工维护/配置），persistJson 立即触发文件落盘不等防抖 */
const WRITE_THROUGH = new Set([
  'mergehub:ai-profiles',
  'mergehub:rule-sets',
  'mergehub:governance-issues',
  'mergehub:pushMode',
  'mergehub:pushTargets',
  'mergehub:local-repos',
  'mergehub:watchlist',
  'mergehub:local-review:drafts',
])

/** 文件 → 该文件下全部 key（flush 时按文件聚合，同文件多 key 合并为一个信封写） */
const FILE_TO_KEYS: Record<string, string[]> = {}
for (const [regKey, file] of Object.entries(STORAGE_REGISTRY)) {
  ;(FILE_TO_KEYS[file] ??= []).push(regKey)
}

/** 内存缓存：生产模式下全部已注册 key 的当前值（字符串形态，与序列化结果同构） */
const cache = new Map<string, string>()

/** 防抖定时器（每文件一个；写穿 key 不经此直接 flush） */
const pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()

/** 文件落盘失败的 key 集合（诊断留痕；成功后移除） */
export const failedKeys = new Set<string>()

/** 全局落盘失败信号（响应式）：flush 失败时 failSeq 自增，App.vue watch 弹全局提示 */
export const flushState = ref<{ ok: boolean; failSeq: number }>({ ok: true, failSeq: 0 })

/** 门面是否已完成预热（生产模式判据；兼容模式恒 false） */
let bootstrapped = false

/** 写保护：bootstrap 失败（预热/迁移异常）时置位——此后 persistJson/persistString
 *  只更新内存不落盘。防「空缓存默认值写穿覆盖磁盘完命数据」：预热失败说明文件侧
 *  读取链路可疑，此时允许写盘等于拿默认值覆盖真实数据 */
let writeProtected = false

/** 测试环境/非 Tauri 探针 */
function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 生产模式判据：bootstrap 完成后才启用缓存 + 文件路径 */
function fileMode(): boolean {
  return bootstrapped
}

function fileOf(key: string): string | null {
  return STORAGE_REGISTRY[key] ?? null
}

/** 把某文件下缓存中的全部 key 合并写成信封 {"<storageKey>": <原始负载>}。
 *  同文件在飞时排队串行执行（执行时重新快照 cache），保证磁盘时序与缓存一致。
 *  返回是否成功——迁移流程据此决定能否写迁移标记 */
function flushFile(file: string): Promise<boolean> {
  const prev = inflightFlush.get(file) ?? Promise.resolve(true)
  const task = prev
    .catch(() => {
      /* 前序失败不阻断本次落盘 */
    })
    .then(() => flushFileNow(file))
  // 槽位常驻，仅保存「最近一次在飞」链供后续排队；不回删——删除动作与排队之间存在
  // 竞态窗口（刚 delete 完又有新 flush 排队时 get 不到前序链，串行化失效）
  inflightFlush.set(
    file,
    task.then(
      () => undefined,
      () => undefined,
    ),
  )
  void task.catch(() => {
    /* 独立执行不留 unhandled rejection */
  })
  return task
}

/** flushFile 的实际执行体：调用时点重新快照缓存，信封内容永远是最新值 */
async function flushFileNow(file: string): Promise<boolean> {
  const keys = FILE_TO_KEYS[file]
  if (!keys) return false
  const envelope: Record<string, unknown> = {}
  for (const key of keys) {
    const raw = cache.get(key)
    if (raw === undefined) continue
    // 原始串语义（persistString 路径）：值可能恰是合法 JSON 字面量（如 "123"），
    // 信封里包 __raw 标记，读回时原样取串不做 parse/stringify 往返；
    // JSON 负载（persistJson 路径）直存解析结果
    if (rawKeys.has(key)) {
      envelope[key] = { [RAW_WRAPPER_TAG]: 'raw', [RAW_WRAPPER_KEY]: raw }
    } else {
      try {
        envelope[key] = JSON.parse(raw) as unknown
      } catch {
        // persistJson 的缓存恒为 JSON.stringify 产物（合法 JSON），此分支仅防御
        envelope[key] = { [RAW_WRAPPER_TAG]: 'raw', [RAW_WRAPPER_KEY]: raw }
      }
    }
  }
  // 空信封（removeKey 删掉文件内最后一个缓存 key）也必须落盘：磁盘旧信封要被
  // `{}` 覆盖——否则重启预热把被删的值读回缓存，「删除」静默复活。
  // 文件本不存在时多出一个空信封文件：预热读回无 key，语义与无文件一致，无害
  return writeEnvelope(file, envelope)
}

/** 信封统一写盘 + 失败留痕（failedKeys / flushState），空信封与常规写共用。
 *  返回是否成功——迁移流程据此决定能否写迁移标记 */
async function writeEnvelope(file: string, envelope: Record<string, unknown>): Promise<boolean> {
  const keys = FILE_TO_KEYS[file]
  if (!keys) return false
  // 写保护：预热失败后拒绝落盘（内存态照常服务本会话，磁盘数据不被默认值覆盖）
  if (writeProtected) {
    for (const key of keys) failedKeys.add(key)
    console.warn(`[mergehub] 存储处于写保护状态（启动预热失败），本次不落盘：${file}`)
    return false
  }
  try {
    await invoke('storage_write', {
      key: file,
      content: JSON.stringify(envelope, null, 2),
    })
    for (const key of keys) failedKeys.delete(key)
    // 成功后 ok 回正但 failSeq 不清零：UI watch 依赖值变化触发，清零会丢一次失败提示
    if (!flushState.value.ok) flushState.value = { ok: true, failSeq: flushState.value.failSeq }
    return true
  } catch (err) {
    for (const key of keys) failedKeys.add(key)
    flushState.value = { ok: false, failSeq: flushState.value.failSeq + 1 }
    console.warn(`[mergehub] 数据落盘失败：${file}`, err)
    return false
  }
}

/** 调度落盘：写穿立即，其余防抖合并 */
function scheduleFlush(key: string): void {
  const file = fileOf(key)
  if (!file) return
  if (WRITE_THROUGH.has(key)) {
    void flushFile(file)
    return
  }
  if (pendingFlush.has(file)) return
  pendingFlush.set(
    file,
    setTimeout(() => {
      pendingFlush.delete(file)
      void flushFile(file)
    }, DEBOUNCE_MS),
  )
}

/**
 * 启动预热 + 一次性迁移：main.ts 在 createPinia 前 await。
 * 兼容模式（无 Tauri）为 no-op——测试环境保持纯浏览器存储语义。
 */
export async function bootstrapStorage(): Promise<void> {
  if (bootstrapped || !hasTauri()) return
  try {
    await migrateLegacyStorage()
  } catch (err) {
    // 迁移检查失败：置写保护（文件侧链路可疑，防默认值覆盖真数据），启动继续
    writeProtected = true
    console.warn('[mergehub] 旧数据迁移检查失败，存储已进入写保护（重启可重试）', err)
    bootstrapped = true
    return
  }
  // 按文件去重预热：共享文件（如 settings/push.json 双 key）只读一次盘
  let allReadsOk = true
  await Promise.all(
    Object.keys(FILE_TO_KEYS).map(async (file) => {
      try {
        const raw = await invoke<string | null>('storage_read', { key: file })
        if (raw === null) return
        const envelope = JSON.parse(raw) as Record<string, unknown>
        for (const key of FILE_TO_KEYS[file]!) {
          const value = envelope[key]
          if (value === undefined) continue
          // __raw 包裹（双键判别：__t='raw' 且仅此两键）→ persistString 原始串，
          // 原样还原；业务负载恰含 "__raw" 单键时不会被误判（缺 __t 或多键都走 JSON 分支）
          if (
            value !== null &&
            typeof value === 'object' &&
            (value as Record<string, unknown>)[RAW_WRAPPER_TAG] === 'raw' &&
            RAW_WRAPPER_KEY in value &&
            Object.keys(value).length === 2
          ) {
            rawKeys.add(key)
            cache.set(key, String((value as Record<string, unknown>)[RAW_WRAPPER_KEY]))
          } else {
            cache.set(key, JSON.stringify(value))
          }
        }
      } catch (err) {
        // 文件读取/解析失败：链路可疑，置写保护防默认值覆盖；该文件按缺失回退默认值
        allReadsOk = false
        console.warn(`[mergehub] 预热读取失败（${file}），该文件按缺失处理`, err)
      }
    }),
  )
  if (!allReadsOk) {
    writeProtected = true
    console.warn('[mergehub] 存储预热存在读取失败，写入已进入保护状态（重启可重试）')
  }
  bootstrapped = true
}

/** 一次性迁移：文件侧无标记时把浏览器存储旧数据导入缓存并立即全量落盘，再写标记。
 *  防旧覆新双保险：
 *  ① 预检「读失败 ≠ 不存在」——瞬时 IO/权限错误时中止迁移（宁可不迁，不可错迁），
 *    抛错交 bootstrapStorage 置写保护，下次启动重试；
 *  ② 文件侧已有数据的文件跳过（文件优先于浏览器陈旧快照）；
 *  ③ 迁移标记仅在全部目标文件确认写成功后落盘——部分失败不写标记，下次启动重试，
 *    杜绝「标记已写、数据没写」导致的旧数据永久丢失 */
async function migrateLegacyStorage(): Promise<void> {
  const marker = await invoke<unknown>('storage_read', { key: MIGRATION_MARKER_FILE })
  if (marker !== null) return
  const existing: Set<string> = new Set()
  let precheckFailed = false
  await Promise.all(
    Object.keys(FILE_TO_KEYS).map(async (file) => {
      try {
        if ((await invoke<string | null>('storage_read', { key: file })) !== null) {
          existing.add(file)
        }
      } catch (err) {
        // 读失败不等于文件不存在：此时迁=拿陈旧快照覆盖未知状态，宁可中止
        precheckFailed = true
        console.warn(`[mergehub] 迁移预检读取失败（${file}），本次迁移中止`, err)
      }
    }),
  )
  if (precheckFailed) {
    throw new Error('迁移预检失败：文件侧读取异常，已中止本次迁移（下次启动重试）')
  }
  let migrated = 0
  const filesToWrite = new Set<string>()
  for (const [key, file] of Object.entries(STORAGE_REGISTRY)) {
    if (existing.has(file)) continue // 文件侧已有数据（可能来自中断的首次迁移），不覆盖
    const legacy = legacyGet(key) // 收口走 legacyGet：存储访问被禁时返回 null 而非抛出
    if (legacy === null) continue
    cache.set(key, legacy)
    migrated++
    filesToWrite.add(file)
  }
  const results = await Promise.all([...filesToWrite].map((f) => flushFile(f)))
  const allWritten = results.length > 0 && results.every(Boolean)
  // 迁移零数据（全新用户）或全部写成功才写标记；任一文件失败 → 不写标记，下次重试
  if (!allWritten && filesToWrite.size > 0) {
    throw new Error(`迁移落盘部分失败（${results.filter((r) => !r).length}/${results.length}），不写迁移标记，下次启动重试`)
  }
  // 标记写入容错（评审 storage.ts:239）：数据文件此刻已全部落盘成功，迁移目标已达成——
  // 标记失败若上抛会触发 bootstrapStorage 写保护，属误判（文件链路已被全部写成功证明健康）。
  // 仅 warn 留痕：下次启动 marker 仍为 null，数据文件因已存在跳过重写（文件优先语义），
  // 只补写标记，成本一次预检
  await invoke('storage_write', {
    key: MIGRATION_MARKER_FILE,
    content: JSON.stringify({ migrated, at: new Date().toISOString() }, null, 2),
  }).catch((err) => {
    console.warn(
      '[mergehub] 迁移数据已全部落盘，但迁移标记写入失败：下次启动将重试标记写入（数据不会重迁）',
      err,
    )
  })
  if (migrated > 0) console.info(`[mergehub] 已迁移 ${migrated} 项本地数据到文件存储`)
}

/** —— 兼容模式的 P1-3 原语（直连浏览器存储） —— */

function legacyGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function legacySet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (err) {
    handleLegacyWriteError(err, key)
    return false
  }
}

/** 兼容模式的配额/安全错误判别与文案（沿用 P1-3 实现） */
function handleLegacyWriteError(err: unknown, key: string): void {
  if (isQuotaError(err)) {
    console.warn(
      `[mergehub] 持久化写入失败：存储空间已满（配额超限），近期评审数据可能无法保存。key=${key}`,
    )
  } else {
    console.warn(`[mergehub] 持久化写入失败：key=${key}`, err)
  }
}

/**
 * 配额超限的跨浏览器判定（沿用 P1-3 实现，兼容模式专用）。
 */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return false
  const e = err as { name?: unknown; code?: unknown }
  if (e.name === 'QuotaExceededError') return true
  if (e.name === 'QUOTA_EXCEEDED_ERR' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true
  }
  return e.code === 22
}

/**
 * 读取并反序列化 JSON 负载。「键不存在」与「解析失败」合并返回 null（沿用 P1-3 约定）。
 */
export function loadJson(key: string): unknown {
  const raw = fileMode() ? (cache.get(key) ?? null) : legacyGet(key)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    stripProtoKey(parsed)
    return parsed
  } catch (err) {
    console.warn(`[mergehub] 持久化数据解析失败，已按缺失处理：${key}`, err)
    return null
  }
}

/**
 * 剔除解析产物顶层的自有 __proto__ 键（源头安全收口，沿用 P1-3 实现）：
 * JSON.parse 会把它建成普通数据属性，但调用方逐键回写时触发的是
 * Object.prototype 上的访问器 setter——原型被改写为脏值且该键静默丢失。
 */
function stripProtoKey(parsed: unknown): void {
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, '__proto__')
  ) {
    // TS 限制：__proto__ 在 lib 定义里是访问器，不能用点号 delete；Reflect 可按字符串键删除自有数据属性
    Reflect.deleteProperty(parsed, '__proto__')
  }
}

/** 读取并校验为「普通对象」的 JSON 负载（键值映射表形态），沿用 P1-3 语义 */
export function loadJsonObject<T extends Record<string, unknown>>(
  key: string,
  fallback: T,
): T {
  const parsed = loadJson(key)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  return parsed as T
}

/** 序列化 + 写入。生产模式更新缓存立即返回（落盘分级调度）；兼容模式直写浏览器存储。
 *  返回是否成功——失败时调用方内存态不受影响，是否提示由调用方依业务决定 */
export function persistJson(key: string, value: unknown): boolean {
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch (err) {
    console.warn(`[mergehub] 持久化写入失败：key=${key}`, err)
    return false
  }
  if (fileMode()) {
    if (!fileOf(key)) {
      console.warn(`[mergehub] 未登记的存储 key，已拒绝写入（防静默丢数据）：${key}`)
      return false
    }
    cache.set(key, raw)
    scheduleFlush(key)
    return true
  }
  return legacySet(key, raw)
}

/** 删除指定键（幂等；兼容模式删浏览器存储，生产模式删缓存 + 按信封重写文件）。
 *  生产模式不整删文件：同文件其他 key（如 pushMode 与 pushTargets 共用 push.json）
 *  必须保留；写盘失败由 flushFile 留痕（failedKeys + flushState），下次写穿自愈 */
export function removeKey(key: string): void {
  if (fileMode()) {
    cache.delete(key)
    rawKeys.delete(key)
    const file = fileOf(key)
    if (!file) return
    // 取消该文件待执行的防抖，立即按最新缓存重写信封（删除值即刻落盘）
    const timer = pendingFlush.get(file)
    if (timer !== undefined) {
      clearTimeout(timer)
      pendingFlush.delete(file)
    }
    void flushFile(file)
    return
  }
  try {
    localStorage.removeItem(key)
  } catch {
    /* 忽略 */
  }
}

/** 读取原始字符串（非 JSON 值专用，如最近日志路径）；不存在返回 null */
export function loadString(key: string): string | null {
  return fileMode() ? (cache.get(key) ?? null) : legacyGet(key)
}

/** 写入原始字符串（非 JSON 值专用）；返回是否成功。
 *  生产模式登记 rawKeys（信封包裹 __raw），重启后 loadString 原样读回 */
export function persistString(key: string, value: string): boolean {
  if (fileMode()) {
    if (!fileOf(key)) {
      console.warn(`[mergehub] 未登记的存储 key，已拒绝写入（防静默丢数据）：${key}`)
      return false
    }
    rawKeys.add(key)
    cache.set(key, value)
    scheduleFlush(key)
    return true
  }
  return legacySet(key, value)
}

/** 读取负载的 schema 版本：未携带 v 字段或 v 非有限数字返回 0（存量数据口径） */
export function readSchemaVersion(raw: unknown): number {
  if (raw && typeof raw === 'object' && 'v' in raw) {
    const v = (raw as { v?: unknown }).v
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}

/** 测试辅助：重置门面内部状态（仅测试代码可用，生产代码不得调用） */
export function __resetStorageForTest(): void {
  cache.clear()
  pendingFlush.clear()
  inflightFlush.clear()
  rawKeys.clear()
  failedKeys.clear()
  flushState.value = { ok: true, failSeq: 0 }
  bootstrapped = false
  writeProtected = false
}
