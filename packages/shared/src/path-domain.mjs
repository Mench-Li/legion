// packages/shared/src/path-domain.mjs
// ============================================================================
// 共享路径判定基座（并行任务文件冲突治理 S1 / R-1）
//
// 本模块是**唯一**一份写入路径语义：team-hub 的预约事务（S2）与 plugins 守护的
// pre-execute 校验（S5）都必须 import 它，任何地方再写第二份 startsWith 前缀判定
// 都会让「同一个路径在两处得到不同结论」——而那种缺陷只在两个任务真的抢同一文件时
// 才显形（AC-R1-6 的反证门禁即为此）。
//
// 语义（设计 §4）：
//   · 只接受仓库相对规范路径；绝对路径 / .. / 空 / .git / 非法类型逐条结构化拒绝；
//   · 路径分「文件」「目录」两种明确类型，不接受任意 glob；
//   · 目录按**段边界**覆盖：src/a 覆盖 src/a/b.mjs，但**不得**覆盖 src/ab；
//   · 大小写是否等价由仓库配置（opts.caseInsensitive）决定；
//   · 重命名同时占用旧路径与新路径（expandRename）。
//
// 纯函数：无 fs / 网络 / 时钟依赖，同输入同输出。
// ============================================================================

export const PATH_REJECTION_CODES = Object.freeze({
  EMPTY: 'empty-path',
  ABSOLUTE: 'absolute-path',
  TRAVERSAL: 'path-traversal',
  GIT_INTERNAL: 'git-internal',
  INVALID_TYPE: 'invalid-entry-type',
  INVALID_SHAPE: 'invalid-entry-shape',
})

const REASON_TEXT = Object.freeze({
  [PATH_REJECTION_CODES.EMPTY]: '路径为空或只有空白',
  [PATH_REJECTION_CODES.ABSOLUTE]: '不接受绝对路径（必须是仓库相对路径）',
  [PATH_REJECTION_CODES.TRAVERSAL]: '不接受包含 .. 的路径（可能越出仓库）',
  [PATH_REJECTION_CODES.GIT_INTERNAL]: '不接受 .git 内部路径',
  [PATH_REJECTION_CODES.INVALID_TYPE]: '路径类型只接受 file 或 dir',
  [PATH_REJECTION_CODES.INVALID_SHAPE]: '路径条目必须是字符串或 { path, type } 对象',
})

function reject(code) {
  return Object.freeze({ ok: false, code, reason: REASON_TEXT[code] })
}

/**
 * 规范化一个仓库相对路径。
 * @returns {{ok:true,path:string,segments:string[],caseInsensitive:boolean}|{ok:false,code:string,reason:string}}
 */
export function normalizeRepoPath(raw, opts = {}) {
  const caseInsensitive = opts?.caseInsensitive === true
  const s = String(raw ?? '').trim()
  if (s === '') return reject(PATH_REJECTION_CODES.EMPTY)
  // 绝对路径：Windows 盘符、POSIX 根、UNC。必须在反斜杠归一之前判断。
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\') || s.startsWith('//')) {
    return reject(PATH_REJECTION_CODES.ABSOLUTE)
  }
  const norm = s.replace(/\\/g, '/')
  const segments = []
  for (const seg of norm.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return reject(PATH_REJECTION_CODES.TRAVERSAL)
    if (seg.toLowerCase() === '.git') return reject(PATH_REJECTION_CODES.GIT_INTERNAL)
    segments.push(seg)
  }
  if (segments.length === 0) return reject(PATH_REJECTION_CODES.EMPTY)
  const canonical = segments.join('/')
  return Object.freeze({
    ok: true,
    path: caseInsensitive ? canonical.toLowerCase() : canonical,
    segments: Object.freeze(segments),
    caseInsensitive,
  })
}

/**
 * 把 { path, type }（或裸字符串，视为 file）规范化成一个可比较条目。
 */
export function classifyEntry(entry, opts = {}) {
  const e = typeof entry === 'string' ? { path: entry, type: 'file' } : entry
  if (e === null || typeof e !== 'object') return reject(PATH_REJECTION_CODES.INVALID_SHAPE)
  const type = e.type === 'dir' ? 'dir' : e.type === 'file' ? 'file' : null
  if (type === null) return reject(PATH_REJECTION_CODES.INVALID_TYPE)
  const n = normalizeRepoPath(e.path, opts)
  if (!n.ok) return n
  return Object.freeze({ ok: true, path: n.path, type })
}

/** 把任意数量条目正常化成数组（单个条目 / 数组 / 空）。 */
export function toEntryList(value, opts = {}) {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const ok = []
  const rejected = []
  for (const item of list) {
    const c = classifyEntry(item, opts)
    if (c.ok) ok.push(c)
    else rejected.push(c)
  }
  return Object.freeze({ entries: Object.freeze(ok), rejected: Object.freeze(rejected) })
}

function entriesOverlap(a, b) {
  if (a.path === b.path) return true
  // 目录按段边界覆盖其子路径；文件不覆盖任何路径。
  if (a.type === 'dir' && b.path.startsWith(a.path + '/')) return true
  if (b.type === 'dir' && a.path.startsWith(b.path + '/')) return true
  return false
}

/** 两个**已规范化**条目是否相交（供内部与需要预归一化的调用方使用）。 */
export function normalizedEntriesOverlap(a, b) {
  return entriesOverlap(a, b)
}

/**
 * 两组路径是否相交。任一侧可以是单个条目或条目数组；非法条目按「不相交」处理，
 * 单独用 normalizeRepoPath / classifyEntry 取拒绝原因（拒绝面不得静默通过）。
 */
export function pathsIntersect(a, b, opts = {}) {
  const left = toEntryList(a, opts).entries
  const right = toEntryList(b, opts).entries
  for (const x of left) for (const y of right) if (entriesOverlap(x, y)) return true
  return false
}

/** True only when the proposed file/directory is entirely inside an allowed domain. */
export function entriesWithinDomain(entries, domain, opts = {}) {
  const proposed = toEntryList(entries, opts)
  const allowed = toEntryList((domain ?? []).map((item) => typeof item === 'string' ? { path: item, type: 'dir' } : item), opts)
  if (proposed.rejected.length || allowed.rejected.length) return false
  return proposed.entries.every((entry) => allowed.entries.some((bound) =>
    (entry.path === bound.path && (bound.type === 'dir' || entry.type === 'file'))
    || (bound.type === 'dir' && entry.path.startsWith(bound.path + '/'))))
}

/** 找出两组路径中相交的具体路径对（给 FILE_CONTENTION 报冲突路径用）。 */
export function intersectingPaths(a, b, opts = {}) {
  const left = toEntryList(a, opts).entries
  const right = toEntryList(b, opts).entries
  const pairs = []
  for (const x of left) for (const y of right) if (entriesOverlap(x, y)) pairs.push({ a: x.path, b: y.path, aType: x.type, bType: y.type })
  return Object.freeze(pairs)
}

/**
 * 重命名同时占用旧路径与新路径（两端都算写入）。
 */
export function expandRename({ from, to } = {}, opts = {}) {
  const out = []
  for (const raw of [from, to]) {
    const n = normalizeRepoPath(raw, opts)
    if (n.ok) out.push(Object.freeze({ path: n.path, type: 'file' }))
  }
  return Object.freeze(out)
}

/** 规范并校验一组写入路径：返回可用条目与逐条拒绝原因（不静默丢）。 */
export function normalizePathSet(paths, opts = {}) {
  const list = Array.isArray(paths) ? paths : paths === null || paths === undefined ? [] : [paths]
  const entries = []
  const rejected = []
  for (const raw of list) {
    const n = normalizeRepoPath(raw, opts)
    if (n.ok) entries.push(Object.freeze({ path: n.path, type: 'file' }))
    else rejected.push(Object.freeze({ raw: String(raw ?? ''), code: n.code, reason: n.reason }))
  }
  return Object.freeze({
    ok: rejected.length === 0,
    entries: Object.freeze(entries),
    rejected: Object.freeze(rejected),
  })
}
