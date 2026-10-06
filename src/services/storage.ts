/** 统一持久化门面：全应用唯一的 localStorage 访问入口（P1-3 收口）。
 *  职责：访问点收敛到本文件、JSON 序列化/解析异常统一处理（不再静默）、
 *  配额超限留痕并返回失败、持久化负载的版本字段约定。
 *
 *  关于「IndexedDB 迁移阀门」的诚实说明：本层 API 为同步——Pinia 的 state 初始化器
 *  是同步的，而 IndexedDB 天然异步，切换底座必然要求各 store 把水合时机改为显式
 *  加载（state 置空 + 初始化 action 内 await 读取），这部分是迁移期的固有改造，
 *  无法由门面吸收。本层提供的阀门是：底座切换时，序列化策略、失败语义、版本约定
 *  的改动只发生在本文件与各 store 的水合调用点，不再有散落各处的裸访问需要逐处狩猎。
 *
 *  版本约定：新增持久化结构一律在负载中携带 v 数字字段（readSchemaVersion 读取），
 *  存量结构待下一次破坏性迁移时补齐——提前写入会污染按 key 迭代负载的读取方
 *  （如 ai-results 的 Record 形态会把版本键误认为数据条目）。
 */

/** 当前持久化负载的 schema 版本（新增持久化结构使用；存量结构为 0） */
export const CURRENT_SCHEMA_VERSION = 1

/**
 * 配额超限的跨浏览器判定。各引擎抛法不一，单一判据会漏：
 * - 标准 DOMException + name=QuotaExceededError（Chrome/Edge/新 WebKit）
 * - 旧 WebKit/Safari：QUOTA_EXCEEDED_ERR（DOMException 但 name 不同）
 * - Firefox：NS_ERROR_DOM_QUOTA_REACHED（code 1014）
 * - 部分环境/包装层把异常降级为普通 Error 但保留 name，或带 code 22
 * 数值码只认 22（QUOTA_EXCEEDED_ERR 的标准遗留码，W3C DOM4 遗留码表）。
 * 18 是 SECURITY_ERR（SecurityError）——浏览器隐私设置阻止站点数据访问时抛的
 * 正是它（Firefox 实测场景），属访问被拒而非配额超限，不得据此给配额文案；
 * 真配额异常由 name 判据兜住。按上述特征并集判定，均不命中视为一般失败（原样留痕）。
 */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return false
  const e = err as { name?: unknown; code?: unknown }
  if (e.name === 'QuotaExceededError') return true
  if (
    e.name === 'QUOTA_EXCEEDED_ERR' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  ) {
    return true
  }
  return e.code === 22
}

/** 写入失败的统一留痕：配额超限给专属文案（提示数据可能未保存），其余原样记录 */
function handleWriteError(err: unknown, key: string): void {
  if (isQuotaError(err)) {
    console.warn(
      `[mergehub] 持久化写入失败：存储空间已满（配额超限），近期评审数据可能无法保存。key=${key}`,
    )
  } else {
    console.warn(`[mergehub] 持久化写入失败：key=${key}`, err)
  }
}

/**
 * 读取并反序列化 JSON 负载。
 * 取舍（刻意约定）：「键不存在」与「解析失败」合并返回 null，不提供区分两者的
 * 程序化通道——全部调用方（ai/watchlist/settings/localRepos/localReview/
 * reviewRules/governanceIssues）都按「null 即回退默认值」消费，缺失与损坏的
 * 处置相同（回退 + warn 留痕）；解析失败有独立文案的 warn 可事后排查。
 * 若未来出现必须区分的场景（如损坏数据提示用户手动清理），再提供
 * loadJsonStrict 之类带失败标记的变体，不提前抽象。
 */
export function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    stripProtoKey(parsed)
    return parsed
  } catch (err) {
    console.warn(`[mergehub] 持久化数据解析失败，已按缺失处理：${key}`, err)
    return null
  }
}

/**
 * 剔除解析产物顶层的自有 __proto__ 键（源头安全收口）：JSON.parse 会把它建成普通
 * 数据属性（Object.entries 枚举得出），但调用方逐键回写（obj[key]=value）时触发的
 * 却是 Object.prototype 上的访问器 setter——结果对象原型被改写为脏值且该键静默丢失。
 * 在读入口剔除一次，所有消费方统一受保护——包括不走 loadJsonObject、直连 loadJson
 * 的 settings/localReview；各 store 逐键回写循环内另有显式跳过守卫作纵深第二层。
 * constructor 等其他敏感名无需处理：Object.prototype 上它们是数据属性（无 setter），
 * 普通赋值安全落自有键。
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

/** 读取并校验为「普通对象」的 JSON 负载（键值映射表形态）：键不存在/解析失败/非对象/数组
 *  一律返回 fallback——各 store 的 Record 形态持久化共用此守卫，替代逐处复写的
 *  「!parsed || typeof !== object || Array.isArray」样板。数组的 JSON 也是 object，
 *  但 Record 语义不接受，显式排除。仅做形态断言，值的字段级校验仍归调用方。
 *  __proto__ 自有键已由 loadJson 源头剔除（见 stripProtoKey）。 */
export function loadJsonObject<T extends Record<string, unknown>>(
  key: string,
  fallback: T,
): T {
  const parsed = loadJson(key)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  return parsed as T
}

/** 序列化并写入 JSON 负载；返回是否成功——配额超限等失败不再静默，warn 留痕。
 *  失败时调用方内存态不受影响，是否需要向用户提示由调用方依据业务决定 */
export function persistJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    handleWriteError(err, key)
    return false
  }
}

/** 删除指定键（幂等；删除失败无可见后果，忽略） */
export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 忽略 */
  }
}

/** 读取原始字符串（非 JSON 值专用，如最近日志路径）；不存在或读取失败返回 null */
export function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写入原始字符串（非 JSON 值专用）；返回是否成功，失败 warn 留痕 */
export function persistString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (err) {
    handleWriteError(err, key)
    return false
  }
}

/** 读取负载的 schema 版本：未携带 v 字段或 v 非有限数字返回 0（存量数据口径） */
export function readSchemaVersion(raw: unknown): number {
  if (raw && typeof raw === 'object' && 'v' in raw) {
    const v = (raw as { v?: unknown }).v
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}
