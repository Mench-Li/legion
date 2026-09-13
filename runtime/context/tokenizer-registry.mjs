// runtime/context/tokenizer-registry.mjs
// ============================================================================
// PRT-413：从**本地产物**装载精确 tokenizer
//
// `TOKENIZER_REGISTRY` 在此之前是一个空的 `Map`，注释写着"有词表时在这里
// `set(model, ...)` 即可"。那句话把"精确"永远挂在**别人改这段代码**上。
//
//   > 一个"留了接入点、但没有任何东西能走进去"的注册表，
//   > 与一个"根本没有注册表"的实现，在没人提供词表的时候是同一个东西——
//   > 只不过前者会让"精确 tokenizer 这条路径"看起来是**通的**。
//
// 本模块把入口做成**运维可用的**：给一个目录，里面的 `*.tokenizer.json`
// 会被逐个加载、校验、算 sha256，然后按 `model` 注册。词表仍然必须由使用者提供
// （零依赖 + 供应商数据许可，这两件事都不允许我们把它打进仓库），
// 但**从"提供词表"到"用上词表"之间不再需要改代码**。
//
// 三条判断：
//
// ① **坏的产物让装载失败，而不是被跳过。**
//    跳过看起来"更健壮"：少一个模型，别的照用。但运维会把"这个模型的预算是精确的"
//    当成事实，而实际上它在用**保守估算**——两者在快照里长得不一样（`tokens.kind`），
//    可是没人会去看那个字段，除非已经出事。
//
//    一个"坏产物就静默跳过"的装载器，
//    与一个"坏产物就让装载失败"的装载器，在每份产物都合法的时候是同一个东西——
//    只不过前者会让一个**拼错的词表文件名**变成"这个模型没有精确 tokenizer"。
//
// ② **evidence 里带上 sha256。** 快照里的 `tokens.note` 要说清这个数是用哪一份
//    字节算出来的。只写一个路径是不够的：同一条路径下的文件会被换掉，
//    而"换了词表"正是会让两次运行的数字对不上的那种变化。
//
// ③ **目录不存在不是错误。** 没配置 = 没有精确词表 = 用保守估算（`tokenizerForProfile`
//    的既有行为）。这一条要小心与 ① 区分：**没给**与**给了个坏的**是两件事。
// ============================================================================

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { exactTokenizerFromArtifact } from './bpe.mjs'

/** 加载失败码。**不复用别的模块的码**——排查时要知道是谁失败的。 */
export const TOKENIZER_LOAD_ERRORS = Object.freeze({
  /** 产物不是合法 JSON。 */
  BAD_JSON: 'TOKENIZER_BAD_JSON',
  /** 产物形状不对（缺字段 / 类型错）。 */
  BAD_ARTIFACT: 'TOKENIZER_BAD_ARTIFACT',
  /** 同一个 model 被两份产物声明。 */
  DUPLICATE_MODEL: 'TOKENIZER_DUPLICATE_MODEL',
})

export class TokenizerLoadError extends Error {
  constructor(code, message, { cause = null, file = null } = {}) {
    super(message)
    this.name = 'TokenizerLoadError'
    this.code = code
    if (cause !== null) this.cause = cause
    if (file !== null) this.file = file
  }
}

/** 产物文件名的后缀。**由本模块定义**，免得调用方各处拼字符串。 */
export const TOKENIZER_ARTIFACT_SUFFIX = '.tokenizer.json'

/**
 * 加载一个目录下的全部 tokenizer 产物。
 *
 * @param {string|null} dir 目录；`null`/`undefined`/空串都表示**没有配置**（不是错误）
 * @returns {Map<string, object>} `model → 精确 tokenizer`
 */
export function loadTokenizerRegistry(dir) {
  const registry = new Map()
  // ③ 没配置 = 没有精确词表。这与"配置了一个坏目录"不同，后者交给 readdir 抛。
  if (dir === null || dir === undefined || dir === '') return registry
  if (typeof dir !== 'string') throw new TypeError('tokenizer 目录必须是字符串或 null')

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new TokenizerLoadError(TOKENIZER_LOAD_ERRORS.BAD_ARTIFACT,
      `读不了 tokenizer 目录 ${dir}：${e instanceof Error ? e.message : String(e)}。`
      + '注意这与"没有配置目录"不同：**配了但读不到**会让"这个模型在精确算 token"'
      + '变成一句没有依据的话', { cause: e })
  }

  // 文件名排序：加载顺序不该是文件系统的函数（否则同一份目录在两台机器上
  // 可能因为"哪份重复声明先被看到"而给出不同的注册结果）。
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(TOKENIZER_ARTIFACT_SUFFIX))
    .map((e) => e.name)
    .sort()

  for (const name of files) {
    const full = join(dir, name)
    const text = readFileSync(full, 'utf8')
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
    let raw
    try {
      raw = JSON.parse(text)
    } catch (e) {
      // ① 坏 JSON 让**装载失败**，不跳过。
      throw new TokenizerLoadError(TOKENIZER_LOAD_ERRORS.BAD_JSON,
        `tokenizer 产物 ${full} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
        { cause: e, file: full })
    }
    let tok
    try {
      tok = exactTokenizerFromArtifact(raw, { source: `${full}（sha256 ${sha256.slice(0, 16)}…）` })
    } catch (e) {
      throw new TokenizerLoadError(TOKENIZER_LOAD_ERRORS.BAD_ARTIFACT,
        `tokenizer 产物 ${full} 形状不对：${e instanceof Error ? e.message : String(e)}`,
        { cause: e, file: full })
    }
    const model = raw.model
    if (registry.has(model)) {
      // 同一个 model 两份产物：**不猜哪份对**。取先加载的那份会让"哪份生效"
      // 变成文件名的函数，而两台机器上的文件名排序可能不同。
      throw new TokenizerLoadError(TOKENIZER_LOAD_ERRORS.DUPLICATE_MODEL,
        `model ${model} 被两份产物声明（${full}）；不猜用哪一份——`
        + '取"先加载的"会让同一个目录在两台机器上注册出不同的 tokenizer', { file: full })
    }
    registry.set(model, tok)
  }
  return registry
}

/**
 * 惰性注册表：**第一次真正用到时才读盘**，且只读一次。
 *
 * 与 `contextStore` 同样的理由：只跑不涉及 token 的路由的进程不该因为建注册表而读盘。
 * 读失败会被记住（`error`），而不是每次都重试——一个坏目录不该让每次请求都去摸盘。
 *
 * ★ `getDir()` **只在构造时调一次**，之后不再调。
 *   第一版把它放进了 `status()`（"顺便报一下目录"），于是**一个诊断函数会把
 *   `getDir` 再调一遍**——而 `getDir` 在生产里是从配置里取值，不是纯函数。
 *
 *   > 一个"报告状态的函数会顺手读一次配置"的实现，
 *   > 与一个"只在装载时才读配置"的实现，在没人调用 `status()` 的时候
 *   > 是同一个东西——只不过前者会让**排障**这件事本身产生副作用。
 */
export function createLazyTokenizerRegistry(getDir) {
  if (typeof getDir !== 'function') throw new TypeError('createLazyTokenizerRegistry 需要 getDir 函数')
  const dir = getDir()
  // ★ `attempted` 与 `loaded` **必须分开**。
  //
  //   第一版在读盘失败时写了 `loaded = new Map()`，于是：
  //   ① `status().loaded` 报 `true`——**"读失败了"被报成"加载过了"**；
  //   ② 一个空 Map 会成为后续 `get` 的答案来源，而"注册表是空的"
  //      与"我们没能读到注册表"在调用方看来必须不同。
  //
  //   > 一个"失败后把状态标成已加载"的惰性装载器，
  //   > 与一个"加载成功但词表恰好为空"的装载器，
  //   > 在 `status()` 这一个读数上是同一个东西——
  //   > 只不过前者会让"配置写错了"看起来像"这个模型没有精确 tokenizer"。
  //
  //   `attempted` 只负责"别再摸盘了"；`loaded` 只负责"读到了什么"。
  let attempted = false
  let loaded = null
  let error = null
  const registry = {
    /** `tokenizerForProfile` 只要求 `.get`。 */
    get(model) {
      if (!attempted) {
        attempted = true
        try {
          loaded = loadTokenizerRegistry(dir)
        } catch (e) {
          // ★ 不吞掉：记下来，由 `status()` 显式暴露，并由后续 `get` 继续抛出。
          error = e
        }
      }
      // 失败是**粘住**的：同一次运行里不重试，也不给一个空答案。
      if (error !== null) throw error
      return loaded.get(model)
    },
    size() { return loaded === null ? 0 : loaded.size },
    /** 排障用：注册了什么、失败在哪。**不抛，也没有副作用**。 */
    status() {
      return Object.freeze({
        dir,
        loaded: loaded !== null,
        count: loaded === null ? 0 : loaded.size,
        models: loaded === null ? [] : [...loaded.keys()].sort(),
        error: error === null ? null : { code: error.code, message: error.message, file: error.file ?? null },
      })
    },
  }
  return Object.freeze(registry)
}
