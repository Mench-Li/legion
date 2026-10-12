// team-hub/storage-state.mjs
// ============================================================================
// **定时体检的读数**：谁在监控、多久前测的、结论是什么。
//
// 上一轮有了体检脚本与四档退出码，但**没有定时器** —— 于是"盘快满了"仍然
// 不会主动告警（当时如实写在 DEPLOY.md 的"尚未接线"里）。这一轮补上，
// 而这个模块负责其中三件**不显然**的事。
//
// ## ★ ① 状态文件不能写在**正在满的那块盘**上
//
// 最自然的做法是把它写进 `/var/lib/legion-hub/`（库和备份都在那儿）。
// 那正好是错的：那块盘满的时候，**写状态文件也会失败** ——
// 而那一刻正是最需要这个读数的时候。
//
//   > 一个"写在被测磁盘上"的健康状态，会在磁盘满的时候**连同磁盘一起坏掉** ——
//   > 而它存在的全部理由就是报告那件事。
//
// 所以它落在 **tmpfs**（`/run/…`）：由内存提供，不受磁盘满影响，
// 重启后自动消失（这本身也诚实 —— 重启前那次检查的结论不该被当成现在的）。
//
// ## ★ ② "读不到"有三个**不同**的意思，而它们要采取的动作不同
//
//   · `no-state`      —— 定时器从来没跑过 → **去装定时器**
//   · `stale`         —— 跑过，但很久没跑了 → **去查定时器为什么停了**
//   · `unreadable`    —— 文件在，但读不出来/版本不对 → **去查写入方**
//
// 把它们合成一个 `unknown` 是偷懒，而代价是**值班的人不知道该做什么**。
//
// ## ★ ③ 陈旧的 `ok` 比陈旧的 `critical` 危险得多
//
//   · 三天前测到"充足"，今天报"充足" → 你以为有人看着，其实**没有人在测**
//   · 三天前测到"危险"，今天报"危险"  → 你被惊动，可能是虚的，但至少有人看
//
// 所以**陈旧一律降级成 `unknown`**（而不是沿用上次的结论），
// 但把上次的结论作为 `lastKnownLevel` **一起报出来** ——
// 于是"没人测了"与"上次测到的是危险"两件事同时可见。
// ============================================================================

/** 状态文件的格式版本。读到不认识的版本时**不许猜**（见 `parseState`）。 */
export const STATE_SCHEMA = 1

/** 超过这个时间没更新就算陈旧。定时器是每小时一次，6 小时 = 至少漏了 5 次。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** 状态文件的默认落点：**tmpfs**（见文件头 ①）。 */
export const DEFAULT_STATE_PATH = '/run/legion-hub/storage-state.json'

/** 四种判定（与 `storage-health.mjs` 同一套词）。 */
export const LEVELS = Object.freeze(['ok', 'warn', 'critical', 'unknown'])

export const STATE_REASONS = Object.freeze({
  NO_STATE: 'no-state',
  STALE: 'stale',
  UNREADABLE: 'unreadable',
  SCHEMA_MISMATCH: 'schema-mismatch',
  CHECK_COULD_NOT_READ: 'check-could-not-read',
  FRESH: 'fresh',
})

/**
 * 这个等级算不算"要人动手"。
 *
 * ★ `unknown` 也算 —— 没人测就是没人测。
 *
 * ★★ 判据写成 `level !== 'ok'`（**不是**列举那三个坏档）。
 *   两个方向不对等：一个因为 bug 产生的垃圾等级，
 *   报成"要人看"最坏是虚惊一场，报成"没事"则是**静默漏掉**。
 *   所以只有**明确是 ok** 才算不需要人。
 */
export function isAlarming(level) {
  return level !== 'ok'
}

/**
 * 造一份状态（体检脚本跑完之后调）。
 *
 * @param {{level, exitCode, report, problems, atMs, host}} input
 * @returns {object} 可直接 `JSON.stringify` 的对象
 */
export function makeState(input = {}) {
  const src = (input === null || typeof input !== 'object') ? {} : input
  const level = LEVELS.includes(src.level) ? src.level : 'unknown'
  return {
    schema: STATE_SCHEMA,
    atMs: Number.isFinite(Number(src.atMs)) ? Number(src.atMs) : Date.now(),
    level,
    exitCode: Number.isFinite(Number(src.exitCode)) ? Number(src.exitCode) : 3,
    // 只保留读数里那几个**数**，不整份透传（免得把路径之类的东西写进状态）。
    report: {
      dbBytes: numOrNull(src.report?.dbBytes),
      walBytes: numOrNull(src.report?.walBytes),
      totalUsedBytes: numOrNull(src.report?.totalUsedBytes),
      freeBytes: numOrNull(src.report?.freeBytes),
      totalBytes: numOrNull(src.report?.totalBytes),
      neededBytes: numOrNull(src.report?.neededBytes),
      backupAgeMs: numOrNull(src.report?.backupAgeMs),
      backupStale: src.report?.backupStale === true,
    },
    problems: Array.isArray(src.problems) ? src.problems.filter((p) => typeof p === 'string').slice(0, 20) : [],
    host: typeof src.host === 'string' && src.host.length > 0 ? src.host.slice(0, 120) : null,
  }
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 解析状态文件的原文。
 *
 * ★ 坏 JSON / 不认识的 schema 一律**判成读不出来**，而不是"当作没有" ——
 *   两者的含义不同：文件在但读不出来说明**写入方**有问题（去查它），
 *   文件不在说明**从来没跑过**（去装它）。
 *
 * @returns {{ok: boolean, state: object|null, why: string|null}}
 */
export function parseState(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, state: null, why: STATE_REASONS.UNREADABLE }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ok: false, state: null, why: STATE_REASONS.UNREADABLE } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, state: null, why: STATE_REASONS.UNREADABLE }
  }
  // ★ 版本不认识时**不许猜**：格式换了之后，"按旧格式读新文件"最可能的
  //   结果是读出一个**看起来正常但其实没意义**的结论。
  if (parsed.schema !== STATE_SCHEMA) {
    return { ok: false, state: null, why: STATE_REASONS.SCHEMA_MISMATCH }
  }
  if (!LEVELS.includes(parsed.level)) {
    return { ok: false, state: null, why: STATE_REASONS.UNREADABLE }
  }
  if (!Number.isFinite(Number(parsed.atMs)) || Number(parsed.atMs) <= 0) {
    // 没有时间戳的状态**无法判断新旧** —— 而没有时间戳的读数只能当读不出来。
    return { ok: false, state: null, why: STATE_REASONS.UNREADABLE }
  }
  return { ok: true, state: parsed, why: null }
}

/**
 * 定这份读数算不算"当前的"。
 *
 * @param {{raw, nowMs, staleAfterMs}} input
 *        `raw` 是状态文件原文（`null` = 文件不存在）
 * @returns {{level, reason, atMs, stateAgeMs, fresh, lastKnownLevel, exitCode, report, problems, host}}
 *          `level` 是**现在**该报的等级；`lastKnownLevel` 是文件里记着的那个。
 */
export function readStateLevel(input = {}) {
  const src = (input === null || typeof input !== 'object') ? {} : input
  const now = Number.isFinite(Number(src.nowMs)) ? Number(src.nowMs) : Date.now()
  const staleAfter = Number.isFinite(Number(src.staleAfterMs)) && Number(src.staleAfterMs) > 0
    ? Number(src.staleAfterMs) : STALE_AFTER_MS
  const miss = (reason, raw) => ({
    level: 'unknown',
    reason,
    atMs: null,
    stateAgeMs: null,
    fresh: false,
    lastKnownLevel: raw === undefined ? null : null,
    exitCode: 3,
    report: null,
    problems: [],
    host: null,
  })
  // ① 文件根本不在 → 定时器从来没跑过（**不是**"没问题"）。
  if (src.raw === null || src.raw === undefined) return miss(STATE_REASONS.NO_STATE)
  const parsed = parseState(src.raw)
  if (parsed.ok !== true) return miss(parsed.why)
  const state = parsed.state
  const atMs = Number(state.atMs)
  // 时钟倒退（状态来自未来）按 0 岁处理 —— 与 `read-cache.mjs` 同一条规矩。
  const ageMs = Math.max(0, now - atMs)
  const base = {
    atMs,
    stateAgeMs: ageMs,
    fresh: false,
    lastKnownLevel: state.level,
    exitCode: Number.isFinite(Number(state.exitCode)) ? Number(state.exitCode) : 3,
    report: state.report ?? null,
    problems: Array.isArray(state.problems) ? state.problems : [],
    host: state.host ?? null,
  }
  // ② 太久没更新 → **降级成 unknown**，但把上次的结论一起带着（见文件头 ③）。
  if (ageMs > staleAfter) {
    return { ...base, level: 'unknown', reason: STATE_REASONS.STALE }
  }
  // ③ 新鲜：用文件里那个等级。
  return {
    ...base,
    fresh: true,
    level: state.level,
    // 体检本身"读不到"（`unknown`）也是一个**需要人**的结论，所以单独给原因。
    reason: state.level === 'unknown' ? STATE_REASONS.CHECK_COULD_NOT_READ : STATE_REASONS.FRESH,
  }
}

/**
 * 原子写状态文件：**同一个目录里**写临时文件再 `rename`。
 *
 * ★ 为什么必须原子：Hub 会读这个文件。非原子写（直接覆盖）会让 Hub
 *   有机会读到**半截 JSON** —— 于是它报"状态文件读不出来"，
 *   而真相只是"写入方正在写"。一个报假故障的健康检查会让人不再信它。
 *
 * ★ 为什么失败**不抛**：状态写不进去**不影响体检结论本身**（那个结论已经
 *   算出来了、也已经打印/退出码给出了）。写失败只意味着 Hub 那边会显示
 *   "陈旧/读不到" —— 那是一个**诚实的**降级，而不是把整次体检判为失败。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function writeStateAtomic({ fs, path, state, dir = null } = {}) {
  if (fs === undefined || fs === null || typeof fs.writeFileSync !== 'function') {
    return { ok: false, reason: 'no-fs' }
  }
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'no-path' }
  const text = `${JSON.stringify(state, null, 2)}\n`
  // 临时文件必须与目标**同目录**：跨文件系统的 `rename` 不是原子的。
  const tmp = `${path}.tmp-${process.pid}`
  try {
    if (typeof dir === 'string' && dir.length > 0 && typeof fs.mkdirSync === 'function') {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 })
    fs.renameSync(tmp, path)
    return { ok: true, reason: null }
  } catch (e) {
    // 收尾：临时文件留着只会让下次的 `ls` 多一个看不懂的东西。
    try { fs.unlinkSync?.(tmp) } catch { /* 删不掉就算了 */ }
    return { ok: false, reason: e?.code ?? e?.message ?? 'write-failed' }
  }
}

/**
 * 给界面/运维看的一句话。
 *
 * ## ★★ 为什么同时回 `text` 与 `key`/`vars`
 *
 * 这是**一个真实的陷阱**，不是冗余：
 *
 *   · `key` + `vars` 是**给 i18n 层**的形状（键是模板、值在 vars 里）；
 *   · 而这是**服务端**的运维文案 —— 运维脚本会直接 `console.log(...)` 它。
 *
 * 一个只有 `key` 的返回值，被直接打印时会把 `{hours}` **原样印给值班的人看**。
 * 我差点就这么发出去了 —— 判据在我自己的测试里先红了一次。
 *
 * 所以两个都给：打印的地方用 `text`，需要翻译的地方用 `key`+`vars`。
 * 并且有一条判据盯着"`text` 里不许剩占位符"。
 *
 * ★ 陈旧的读数要把**两件事**都说出来："没人测了" 与 "上次测到的是什么"。
 *   只说前一半，值班的人不知道要不要立刻动手；只说后一半，
 *   他会以为那是现在的状态。
 */
export function stateSummary(input = {}) {
  const r = readStateLevel(input)
  const hrs = r.stateAgeMs === null ? null : Math.max(1, Math.round(r.stateAgeMs / 3600000))
  return withText(buildSummary(r, hrs))
}

/** 造 `{key, vars}`（内部用，便于把"渲染"这一步单独收口）。 */
function buildSummary(r, hrs) {
  if (r.reason === STATE_REASONS.NO_STATE) {
    return { key: '这台 Hub **没有**在定时体检存储 —— 没人会提前发现盘快满了。', vars: {} }
  }
  if (r.reason === STATE_REASONS.UNREADABLE) {
    return { key: '存储体检的状态文件读不出来（写入方可能有问题）。', vars: {} }
  }
  if (r.reason === STATE_REASONS.SCHEMA_MISMATCH) {
    return { key: '存储体检的状态文件版本不认识 —— 体检脚本与 Hub 版本不一致。', vars: {} }
  }
  if (r.reason === STATE_REASONS.STALE) {
    return {
      key: '存储体检已经 {hours} 小时没跑了（上次的结论是 {last}，但已经不作为现在的判断）。',
      vars: { hours: String(hrs), last: String(r.lastKnownLevel) },
    }
  }
  if (r.reason === STATE_REASONS.CHECK_COULD_NOT_READ) {
    return { key: '存储体检跑过了，但它自己读不到读数 —— 去查挂载与权限。', vars: {} }
  }
  if (r.level === 'critical') return { key: '存储余量危险：写入随时会失败，备份也已经做不成。', vars: {} }
  if (r.level === 'warn') return { key: '存储余量偏低：备份需要的空间快不够了。', vars: {} }
  return { key: '存储余量充足（{hours} 小时前测过）。', vars: { hours: String(hrs) } }
}

/**
 * 把 `{name}` 占位符替换成 `vars` 里的值。
 *
 * ★ 缺变量时**原样留占位符**（与 `workbench/mobile/i18n.mjs` 的 `interpolate`
 *   同一条规矩）：留一个看得见的 `{hours}` 比印一个 `undefined` 好查 ——
 *   前者一眼能看出是模板没填，后者看起来像数据坏了。
 */
export function renderSummary(key, vars = {}) {
  const src = typeof key === 'string' ? key : ''
  return src.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const v = vars?.[name]
    return v === undefined || v === null ? whole : String(v)
  })
}

function withText(s) {
  return { key: s.key, vars: s.vars, text: renderSummary(s.key, s.vars) }
}
