// team-hub/materialization-reading.mjs
// ============================================================================
// **物化读数**（"打开写入会改 DSH 的什么"）—— 中枢这一侧的存放与校验。
//
// ## 它从哪来、为什么在中枢
//
// 读 DSH 现状的只有**插件**（它跑在宿主进程里，能拿到 `ctx.llm` / `ctx.settings`）；
// 而拥有配置的是**中枢**。于是每轮对账由插件算完、POST 过来，中枢只负责
// **存住最后一份**并让面板读到 —— 比较逻辑**只有一份**（插件那边，有用例）。
//
//   > 一个"我算过、我知道"的读数，与一个"任何人（包括要按它做决定的人）都看得见"的读数，
//   > 在没有第二个读者的时候是同一个东西 —— 区别在有人要看它的那一刻。
//
// ## 三条纪律
//
// ① **只存不判**。中枢不重算、不解释、不改写插件的结论；它只做形状校验后原样存住。
//    重算等于把同一个判断实现两遍（`materialize-plan.mjs` 的文件头已经写过这条）。
// ② **新鲜度要能看出来**。读数带 `at`，读的时候一起给出 `ageMs` ——
//    一份 10 分钟前的"没有差异"与一份 5 秒前的，在**能不能据此动手**上不是一件事。
// ③ **没收到过 ≠ 没有差异**。`reading: null` 必须与 `clean: true` 分得开：
//    前者是"不知道"，后者是"知道且为空"（与 `credential-status.mjs` 纪律 ① 同族）。
// ============================================================================

/** 读数的形状（只校验结构，不校验语义）。 */
function bad(message, code = 'READING_INVALID') {
  const err = new Error(message)
  err.code = code
  err.statusCode = 400
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验一份上报的读数。**抛具名错误**（调用方翻成 400），而不是静默存下一个坏形状 ——
 * 一个坏读数的表现是面板显示"没有差异"，而那正好是最危险的那种假绿。
 */
export function validateMaterializationReading(input) {
  if (!isPlainObject(input)) throw bad('读数必须是一个对象')
  if (typeof input.at !== 'string' || input.at === '') throw bad('读数缺少 at（没有时间戳就无法判断新鲜度）')
  if (input.plan !== null && input.plan !== undefined) {
    const p = input.plan
    if (!isPlainObject(p)) throw bad('plan 必须是对象或 null')
    if (!isPlainObject(p.counts)) throw bad('plan 缺少 counts')
    for (const k of ['create', 'update', 'delete', 'unchanged']) {
      if (!Number.isInteger(p.counts[k])) throw bad(`plan.counts.${k} 必须是整数`)
    }
    if (typeof p.clean !== 'boolean') throw bad('plan 缺少 clean')
    if (!Array.isArray(p.update)) throw bad('plan.update 必须是数组')
    for (const u of p.update) {
      if (!isPlainObject(u) || typeof u.id !== 'string' || !Array.isArray(u.fields)) {
        throw bad('plan.update 的每一项必须是 { id, fields[] }')
      }
    }
    for (const k of ['create', 'delete', 'unchanged', 'engineInternal']) {
      if (p[k] !== undefined && !Array.isArray(p[k])) throw bad(`plan.${k} 必须是数组`)
    }
  }
  return Object.freeze({
    at: input.at,
    legionReadOk: input.legionReadOk === true,
    actualReadOk: input.actualReadOk === true,
    plan: input.plan ?? null,
    line: typeof input.line === 'string' ? input.line : null,
    gate: isPlainObject(input.gate)
      ? { applyModelConfig: input.gate.applyModelConfig === true, applyModelConfigDeletes: input.gate.applyModelConfigDeletes === true }
      : null,
  })
}

/**
 * 存最后一份读数（**进程内**，不落库）。
 *
 * 为什么不落库：它是每 5 分钟被覆盖的一份**观测**，不是产品的状态；
 * 而落库要动 schema + 数据表基线，换来的是"中枢重启后还能看到 5 分钟前的读数"——
 * 那点价值不值得多一张表（重启后下一轮就会重新上报）。
 */
export function createMaterializationReadingStore({ now = () => Date.now() } = {}) {
  let latest = null
  return Object.freeze({
    record(input) {
      latest = Object.freeze({ ...validateMaterializationReading(input), receivedAtMs: now() })
      return latest
    },
    /**
     * 读最后一份。`reading: null` = **从没收到过**（不是"没有差异"）。
     * `ageMs` 与 `stale` 一起给：一份过期的读数不该被当成现状。
     */
    get({ staleAfterMs = 15 * 60 * 1000 } = {}) {
      if (latest === null) return Object.freeze({ reading: null, ageMs: null, stale: null })
      const ageMs = Math.max(0, now() - latest.receivedAtMs)
      return Object.freeze({ reading: latest, ageMs, stale: ageMs > staleAfterMs })
    },
  })
}
