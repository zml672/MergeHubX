// @vitest-environment jsdom
// 统一持久化门面：JSON 负载读写、原始字符串读写、失败语义（解析失败/配额超限留痕并降级）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadJson,
  loadJsonObject,
  loadString,
  persistJson,
  persistString,
  readSchemaVersion,
  removeKey,
} from '../storage'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadJson / persistJson', () => {
  it('正常路径：写入并读回相同负载', () => {
    expect(persistJson('k', { a: 1, list: [1, 2] })).toBe(true)
    expect(loadJson('k')).toEqual({ a: 1, list: [1, 2] })
  })

  it('读取不存在的键返回 null', () => {
    expect(loadJson('missing')).toBeNull()
  })

  it('解析失败（损坏 JSON）返回 null 并 warn 留痕', () => {
    localStorage.setItem('k', '{broken json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadJson('k')).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('配额超限：返回 false 并以配额文案 warn 留痕', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(persistJson('k', { a: 1 })).toBe(false)
    expect(warn.mock.calls[0][0]).toContain('配额超限')
  })

  it('配额超限的跨引擎变体：旧 WebKit/Firefox/数值码/普通 Error 包装均判为配额', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // DOMException 的 code 是原型只读 getter，用 defineProperty 在实例上覆盖
    const withCode = (err: Error, code: number): Error => {
      Object.defineProperty(err, 'code', { value: code })
      return err
    }
    const variants: unknown[] = [
      new DOMException('quota', 'QUOTA_EXCEEDED_ERR'), // 旧 WebKit/Safari
      Object.assign(new Error('quota'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }), // Firefox
      Object.assign(new Error('quota'), { name: 'QuotaExceededError' }), // 被包装的普通 Error
      Object.assign(new Error('quota'), { code: 22 }), // 旧规范数值码（QUOTA_EXCEEDED_ERR=22）
    ]
    for (const [i, variant] of variants.entries()) {
      warn.mockClear()
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw variant
      })
      expect(persistString(`k${i}`, 'v')).toBe(false)
      expect(warn.mock.calls[0][0]).toContain('配额超限')
    }
    // code 18 是 SECURITY_ERR（SecurityError）：浏览器隐私设置阻止站点数据访问，
    // 属访问被拒而非配额超限，不得误给「存储空间已满」文案掩盖真实原因
    warn.mockClear()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw withCode(new DOMException('denied', 'SecurityError'), 18)
    })
    expect(persistString('security', 'v')).toBe(false)
    expect(warn.mock.calls[0][0]).not.toContain('配额超限')
  })

  it('一般写入失败：返回 false 并留痕，不抛出', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new TypeError('unexpected')
    })
    expect(persistJson('k', { a: 1 })).toBe(false)
    expect(warn).toHaveBeenCalled()
    // 一般失败不给配额文案（name 恰好含 quota 字样的无关错误也不误判）
    expect(warn.mock.calls[0][0]).not.toContain('配额超限')
  })

  it('removeKey 幂等：删除不存在的键不报错', () => {
    expect(() => removeKey('never-existed')).not.toThrow()
    persistJson('k', 1)
    removeKey('k')
    expect(loadJson('k')).toBeNull()
  })
})

describe('loadJsonObject', () => {
  it('正常路径：对象负载原样返回（带泛型断言）', () => {
    persistJson('obj', { a: 1, b: 'x' })
    expect(loadJsonObject<Record<string, unknown>>('obj', {})).toEqual({ a: 1, b: 'x' })
  })

  it('键不存在返回 fallback', () => {
    expect(loadJsonObject('missing', { d: 1 })).toEqual({ d: 1 })
  })

  it('解析失败返回 fallback', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem('broken', '{oops')
    expect(loadJsonObject('broken', { d: 1 })).toEqual({ d: 1 })
  })

  it('数组和原始类型值不符合 Record 语义，返回 fallback', () => {
    persistJson('arr', [1, 2])
    persistJson('num', 42)
    persistJson('str', '"text"')
    persistJson('nul', 'null')
    const fallback = { d: 1 }
    expect(loadJsonObject('arr', fallback)).toBe(fallback)
    expect(loadJsonObject('num', fallback)).toBe(fallback)
    expect(loadJsonObject('str', fallback)).toBe(fallback)
    expect(loadJsonObject('nul', fallback)).toBe(fallback)
  })

  it('空对象负载是合法 Record，原样返回', () => {
    persistJson('empty', {})
    expect(loadJsonObject('empty', { d: 1 })).toEqual({})
  })

  it('__proto__ 自有键剔除：普通赋值回写不再触发原型 setter（原型污染收口）', () => {
    // JSON.parse 产生自有可枚举 __proto__ 键；若不剔除，调用方逐键回写
    // （for..entries + obj[key]=value）会触发 Object.prototype 访问器 setter：
    // 返回对象的原型被改写为脏值且该键静默丢失
    localStorage.setItem('proto-polluted', '{"__proto__":{"issues":[]},"good":{"a":1}}')
    const parsed = loadJsonObject<Record<string, unknown>>('proto-polluted', {})
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
    expect(Object.keys(parsed)).toEqual(['good'])
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)

    // 模拟各 store 的逐键回写模式：结果对象原型必须完好、脏键不复活
    const rebuilt: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) rebuilt[k] = v
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype)
    expect(Object.keys(rebuilt)).toEqual(['good'])

    // constructor 等其他敏感名是数据属性（无 setter），普通赋值安全，不做处理
    localStorage.setItem('ctor-key', '{"constructor":{"x":1},"ok":2}')
    const parsedCtor = loadJsonObject<Record<string, unknown>>('ctor-key', {})
    expect(parsedCtor.constructor).toEqual({ x: 1 })
  })

  it('loadJson 直连路径同样剔除 __proto__ 自有键（settings/localReview 不走 loadJsonObject）', () => {
    localStorage.setItem('raw', '{"__proto__":{"x":1},"good":2}')
    const parsed = loadJson('raw') as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
    expect(Object.keys(parsed)).toEqual(['good'])
    // 逐键回写模拟：原型完好、脏键不复活
    const rebuilt: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) rebuilt[k] = v
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype)
    // 嵌套/数组负载不在清洗范围：stripProtoKey 只处理顶层对象——嵌套对象不会被
    // 逐键回写重建（只被引用），不存在 setter 触发路径，不清洗是刻意边界。
    // 断言用 Object.keys 而非字面量 toEqual：期望侧写 [{ __proto__: {} }] 字面量
    // 同样触发原型设置，自身就不含自有键，没法当期望值用
    localStorage.setItem('arr', '[{"__proto__":{}}]')
    const nested = loadJson('arr') as { id: string }[]
    expect(nested).toHaveLength(1)
    expect(Object.keys(nested[0])).toEqual(['__proto__'])
  })
})

describe('loadString / persistString', () => {
  it('原始字符串读写：不经 JSON 序列化，原样存取', () => {
    expect(persistString('s', 'D:\\repos\\demo')).toBe(true)
    expect(loadString('s')).toBe('D:\\repos\\demo')
  })

  it('读取不存在的键返回 null（区别于空串）', () => {
    expect(loadString('missing')).toBeNull()
  })
})

describe('readSchemaVersion', () => {
  it('携带 v 字段的负载返回版本号', () => {
    expect(readSchemaVersion({ v: 2, data: 1 })).toBe(2)
  })

  it('未携带 v 字段或 v 非有限数字返回 0（存量数据口径）', () => {
    expect(readSchemaVersion({ data: 1 })).toBe(0)
    expect(readSchemaVersion({ v: 'x' })).toBe(0)
    expect(readSchemaVersion(null)).toBe(0)
    expect(readSchemaVersion('text')).toBe(0)
  })
})
