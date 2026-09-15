// security/secrets/run-credentials.mjs
// ============================================================================
// PRT-509 / spec §6.7（`line 428`）：**在途 Run 的凭证在它启动时就被解析进进程内，
// 中途不替换。**
//
// spec 的原话是：
//
//   密钥轮换只影响轮换后创建的 Run；在途 Run 保持其启动时解析到进程内的
//   短生命周期凭证，不在中途替换。
//
// 这句话成立需要**一个机制**：有东西在 Run 开始时把值抓一次，并让这个 Run
// 之后所有的读取都拿到**那一份**。
//
// ## 施工之前的状态
//
// `security/secrets/store.mjs` 的 `rotate()` 上写着（`:432-435`）：
//
//   > 轮换：引用名不变、值替换，并记录 `rotatedAt`。
//   > **只影响轮换之后创建的 Run**——在途 Run 已把凭证解析进进程内（spec §6.7），
//   > 这里不需要也无法影响它们。
//
// 而**没有任何一个对象在做那件事**。store 刻意**不缓存**（`:26-27`），
// 于是同一个 `store.get(ref)` 在轮换前后返回**两个不同的值**——
// 也就是说，对任何"两次读取之间可能发生轮换"的调用方，那个保证是**假的**。
//
//   > 一句"在途 Run 已把凭证解析进进程内"的注释，
//   > 与一个真的把凭证解析进进程内的机制，
//   > 在读到那句话的人眼里是同一个东西——
//   > 只不过前者会在某一次轮换之后，让一个跑到一半的任务换掉手里的钥匙。
//
// 而且这一整类失败**不报错**：轮换期间的一次重读拿到的是**合法的**新值，
// 调用方会正常地把任务跑完、正常地记账，没有任何读数显示"换了"。
//
// ## 本模块提供的机制
//
// `openRunCredentials()` 在 Run 开始时**一次性**解析它需要的每一个引用，
// 返回一个**冻结的句柄**。此后：
//
//   · `handle.get(ref)` **只从内存里取**，永远不再碰 store；
//   · 轮换、删除、库被改坏，都**不影响**这个句柄已经拿到的那一份；
//   · 下一个 Run 重新 `open`，于是它拿到的是**新的**那一份。
//
// 这正是 spec 那句话的两个方向：在途 Run 不变，新 Run 拿新值。
//
// ## 为什么"不再读一次"是必须被证明的，而不是被期待的
//
// "让 `get` 不去读 store"这件事，光靠代码看起来对是不够的——
// 一个每次都去 store 重读的实现，**在轮换还没发生的那些日子里读数完全一样**：
//
//   > 一个"抓了一次"的实现，与一个"每次都重读、只是恰好还没轮换"的实现，
//   > 在那次轮换到来之前是同一个东西——只不过前者的用例是绿的，
//   > 而后者的绿是"这一跑里没人轮换过"换来的。
//
// 所以本模块的用例里有一条**数数**的：拿一个会计数的 store 包一层，
// 开句柄之后调 `get()` 几十次，`store.get` 的调用次数**必须一次都不涨**。
// 那是"不再读" 的直接读数，而不是它的推论。
//
// ## fail-closed：一个都解析不出来，就一个句柄都不给
//
// 任一引用解析失败（不存在 / 解不开 / 库坏）→ **整个 open 失败**，不返回部分句柄。
// 理由是"半个凭证集合"比"没有凭证集合"危险得多：
//
//   > 一个拿到了 3/5 份凭证的 Run，
//   > 与一个明确起不来的 Run，
//   > 在事故复盘里是同一个东西——只不过前者会**带病跑完**，
//   > 并且在中途以某种"只有一部分调用成功"的形状失败。
//
// 失败时抛出的错误里**只带引用名与内部码，不带值**（`SECRET_ERROR_HINTS` 那条
// 纪律的延伸：错误对象也是会被打日志的地方）。
//
// ## 句柄不会把值序列化出去
//
// `toJSON()` / `describe()` 只给出引用名、解析时间与数量，**不含任何值**。
// 这样"把这个句柄顺手记进日志/诊断包"不会变成一次泄漏——
// 而顺手记一个对象，恰恰是最常发生的那件事。
// ============================================================================

/** 本模块的版本。落进句柄，便于把一次运行与一份实现对起来。 */
export const RUN_CREDENTIALS_VERSION = 1

/** 具名内部码。它们**不是**契约码：契约码仍由 `security/secrets/errors.mjs` 决定。 */
export const RUN_CREDENTIAL_CODES = Object.freeze({
  /** 没给引用清单（或给了空清单）——"没有凭证"与"忘了给"必须分得开。 */
  REFS_REQUIRED: 'RUN_CREDENTIAL_REFS_REQUIRED',
  /** 没给 `runId`：没有运行标识的句柄，事后说不清它属于哪一次运行。 */
  RUN_ID_REQUIRED: 'RUN_CREDENTIAL_RUN_ID_REQUIRED',
  /** 有引用解析不出来。**整个 open 失败**，不返回部分句柄。 */
  RESOLVE_FAILED: 'RUN_CREDENTIAL_RESOLVE_FAILED',
  /** 向句柄要一个**不属于这次运行**的引用。 */
  REF_NOT_HELD: 'RUN_CREDENTIAL_REF_NOT_HELD',
})

/** 本模块的错误类型。带上 `code`，让调用方能按码分支而不是按文案匹配。 */
export class RunCredentialError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RunCredentialError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 在 Run 开始时解析它的全部凭证，返回一个**冻结**的句柄。
 *
 * @param {object} deps
 * @param {{get: (ref: string) => Promise<{ref: string, value: string, resolvedAt: string}>}} deps.store
 *   密钥库。**本模块只在这里读一次**，之后不再碰它。
 * @param {ReadonlyArray<string>} deps.refs 这次运行需要的引用名。空清单是**错误**。
 * @param {string} deps.runId 运行标识。落进句柄。
 * @param {() => string} [deps.now] 时间来源（用例注入）。
 * @returns {Promise<object>} 冻结的句柄
 * @throws {RunCredentialError}
 */
export async function openRunCredentials({ store, refs, runId, now = () => new Date().toISOString() } = {}) {
  // ── 入参：错的一律拒绝，不猜、不补默认 ────────────────────────────────
  if (typeof store?.get !== 'function') {
    throw new RunCredentialError(RUN_CREDENTIAL_CODES.REFS_REQUIRED,
      '没有可用的密钥库（store.get 不是函数）——不能开出一个"空凭证"的句柄')
  }
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new RunCredentialError(RUN_CREDENTIAL_CODES.RUN_ID_REQUIRED,
      '没有 runId：一个不说明自己属于哪一次运行的凭证句柄，事后分不开是它还是别人拿了值')
  }
  // 空清单是**错误**而不是"没有凭证的运行"：
  // 一个真的不需要凭证的运行**不该开句柄**（它应该压根不调这个函数）。
  // 把空清单当合法，会让"接线漏了一截"看起来像"这次运行不需要凭证"。
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new RunCredentialError(RUN_CREDENTIAL_CODES.REFS_REQUIRED,
      'refs 必须是非空数组——"这次运行不需要凭证"应该是不开句柄，而不是开一个空句柄')
  }
  // 去重后保持输入顺序：同一个引用写两遍不该被解析两遍
  //（两遍会拿到两个 `resolvedAt`，而句柄只能报一个）。
  const wanted = Object.freeze([...new Set(refs.map((r) => {
    if (typeof r !== 'string' || r === '') {
      throw new RunCredentialError(RUN_CREDENTIAL_CODES.REFS_REQUIRED,
        `refs 里有非字符串/空字符串的引用：${JSON.stringify(r)}`)
    }
    return r
  }))])

  // ── 一次性解析：全部成功才算成功 ──────────────────────────────────────
  const held = new Map()
  const resolvedAt = now()
  for (const ref of wanted) {
    let record
    try {
      record = await store.get(ref)
    } catch (e) {
      // ★ 错误里**只带引用名与内部码**。`e.message` 可能含库路径等现场信息，
      //   而 `cause` 已经是密钥库自己的具名码——足够定位，且不会有值。
      throw new RunCredentialError(RUN_CREDENTIAL_CODES.RESOLVE_FAILED,
        `解析 ${ref} 失败，本次运行不开始（不是"少一份凭证也能跑"）`,
        { ref, cause: e?.code ?? e?.name ?? 'unknown', failedRefs: [ref], total: wanted.length })
    }
    // 值畸形（非字符串/空串）也当失败：store 的契约就是这两条，
    // 而一个 `undefined` 被当成凭证交下去，会在很远的地方以一个
    // 完全不提凭证的错误炸掉。
    if (record === null || typeof record !== 'object' || typeof record.value !== 'string' || record.value === '') {
      throw new RunCredentialError(RUN_CREDENTIAL_CODES.RESOLVE_FAILED,
        `解析 ${ref} 得到的不是一个可用凭证（值缺失或为空）`,
        { ref, cause: 'SECRET_VALUE_EMPTY', failedRefs: [ref], total: wanted.length })
    }
    held.set(ref, record.value)
  }

  // ── 句柄：**冻结**，且不含任何"能再读到 store"的入口 ────────────────
  const handle = {
    version: RUN_CREDENTIALS_VERSION,
    runId,
    resolvedAt,
    refs: wanted,

    /** 这次运行持有这个引用吗？（与 `get` 分开：问"有没有"不该有副作用） */
    held(ref) { return held.has(ref) },

    /**
     * 取这次运行**启动时**那一份值。
     *
     * 这是本模块的全部意义：它**永远不读 store**。
     * 不属于本次运行的引用 → 具名拒绝（而不是 `undefined`：
     * 一个 `undefined` 会被下游当成"没配置"，而真因是"问错了对象"）。
     */
    get(ref) {
      if (!held.has(ref)) {
        throw new RunCredentialError(RUN_CREDENTIAL_CODES.REF_NOT_HELD,
          `${ref} 不属于本次运行（runId=${runId}）持有的凭证集合`,
          { ref, runId, heldRefs: [...held.keys()] })
      }
      return held.get(ref)
    },

    /** 本次运行的凭证引用清单（**只有名字**）。 */
    describe() {
      return Object.freeze({
        version: RUN_CREDENTIALS_VERSION,
        runId,
        resolvedAt,
        refs: wanted,
        count: wanted.length,
      })
    },

    /** 序列化成**元数据**。见文件头："顺手记进日志"不该变成一次泄漏。 */
    toJSON() { return this.describe() },
  }

  return Object.freeze(handle)
}
