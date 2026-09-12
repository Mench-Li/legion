// runtime/dsh-composition/path-scope.mjs
// ============================================================================
// PRT-604：文件与工作目录范围限制
//
// spec line 926：「`PRT-604`：实现文件和工作目录范围限制。」
// spec §6.6 line 449：hard floor、禁止工具、**禁止越界路径** →
//   `tools/pre-execute` 提前拒绝 **+** `ctx.tools.guard()` 最终复核
// spec §6.6 line 460：权限至少覆盖「文件读写范围」
// spec §6.6 line 454：「文件和子进程约束 → `ctx.sandbox` 及 sandbox-aware executor；
//   必须探测实际后端和 enforcement；**仅有配置名不算生效**」
//
// ---------------------------------------------------------------------------
// 唯一真正要紧的事：**包含关系不能用字符串比**
//
// 最容易写出来的版本是 `target.startsWith(root)`。它在每一条只用了普通文件名的
// 用例里都是绿的，因为那些名字确实在 root 里面。它错在三个地方，每一个的方向都是
// **放行**：
//
//   ① 边界不是前缀
//
//   > 一个「用 `startsWith(root)` 判包含」的范围检查，
//   > 与一个「`C:\work-evil` 也在 `C:\work` 之内」的范围检查，是同一个东西——
//   > 而它的方向是放行。
//
//   ② 字符串相等 ≠ 同一个文件
//
//   > 一个「只比路径字符串、不解析链接」的范围检查，
//   > 与一个「在允许目录里放一个指向 `/etc` 的链接就得到了 `/etc`」的范围检查，
//   > 是同一个东西——而它的方向是放行。
//
//   ③ 写操作恰好都是**新文件**
//
//   `realpath` 对不存在的路径会失败。于是"先 realpath 再比较"的写法在**新建文件**时
//   要么抛、要么被 catch 掉当成"解析不了，跳过解析"。而写操作正是新建文件：
//
//   > 一个「只对已存在的文件做真实路径解析」的范围检查，
//   > 与一个「新建文件时静默跳过解析」的范围检查，是同一个东西——
//   > 而写操作恰好都是新建文件。
//
// 所以本模块的包含判定有三层，缺一层就是放行：
//   规范化（分隔符 / NFC / 大小写 / 尾点尾空格 / `..` 折叠）
//   → **真实路径解析**（只解析最深的存在前缀，然后接回剩余段）
//   → 边界感知比较（相等的路径，或在 `root + 分隔符` 之下）
//
// ---------------------------------------------------------------------------
// 第二件事：范围只能**收窄**（与 PRT-603 同一条纪律）
//
//   > 一个「写范围可以大于读范围」的范围表，
//   > 与一个「写不了的东西先读出来、再写到别处」的范围表，是同一个东西。
//
// 写范围必须是读范围的子集。范围来自 host 平面；PRT-603 的 `workspaceRoot` 是
// **进一步收窄**它，不是取代它。
//
// ---------------------------------------------------------------------------
// 第三件事：沙箱**配置名**不算证据
//
// spec §6.6 line 454 明说"仅有配置名不算生效"。本模块只回答"这个目标在不在范围
// 之内"，并**声明**它需要一个真实的后端探测作为证据；它不把 `sandbox: workspace-write`
// 这行配置当成已生效。
// ============================================================================

import { nfc } from './enforcement.mjs'

export const PATH_SCOPE_VERSION = 'legion/path-scope@1'

export const SCOPE_CODES = Object.freeze({
  BAD_SCOPE: 'path-scope-malformed',
  BAD_TARGET: 'path-scope-bad-target',
  NOT_ABSOLUTE: 'path-scope-not-absolute',
  NO_ROOTS: 'path-scope-no-roots',
  OUT_OF_SCOPE: 'path-scope-out-of-scope',
  OUTSIDE_READ: 'path-scope-outside-read',
  OUTSIDE_WRITE: 'path-scope-outside-write',
  SYMLINK_ESCAPE: 'path-scope-symlink-escape',
  UNRESOLVED: 'path-scope-unresolved',
  RESOLVER_MISSING: 'path-scope-resolver-missing',
  DEVICE_PATH: 'path-scope-device-namespace',
  UNC_UNSCOPED: 'path-scope-unc-not-in-scope',
  ADS_STREAM: 'path-scope-alternate-data-stream',
  WRITE_NOT_IN_READ: 'path-scope-write-not-in-read',
  CASE_RULE: 'path-scope-case-rule-missing',
  TRAILING_HAZARD: 'path-scope-trailing-hazard',
})

/**
 * Win32 的设备名。这些名字**无论有没有扩展名**都被操作系统当成设备，
 * 所以 `C:\work\CON` 写的不是文件。
 */
export const WINDOWS_DEVICE_NAMES = Object.freeze([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 大小写规则**跟着平台走**，不是"总是折叠"。 */
export function caseFoldsOn(platform) {
  if (platform === 'win32' || platform === 'darwin') return true
  if (platform === 'linux') return false
  // 平台不认识时**抛**：不知道大小写规则的包含判定等于没有判定。
  //
  //   > 一个「平台不认识就按 Linux 处理」的范围检查，
  //   > 与一个「在 Windows 上 `C:\WORK` 与 `C:\work` 是两个不同目录」的范围检查，
  //   > 是同一个东西——而它的方向取决于哪一边被当成根。
  throw fail(
    SCOPE_CODES.CASE_RULE,
    `平台 ${JSON.stringify(platform)} 的大小写规则未知，不能做路径包含判定。` +
    '合法值：win32 / darwin（折叠）或 linux（敏感）。不给默认值——' +
    '一个"平台不认识就按 Linux 处理"的检查，与一个"在 Windows 上 C:\\WORK 与 C:\\work 是两个目录"的检查，是同一个东西',
  )
}

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/**
 * 把一个路径切成 `{ root, segments, kind }`。
 *
 * **不做**任何 IO，也**不做**任何"猜"：不认识的形态一律抛。
 */
export function parsePath(input, { platform } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw fail(SCOPE_CODES.BAD_TARGET, `路径必须是非空字符串，收到 ${JSON.stringify(input)}`)
  }
  caseFoldsOn(platform) // 平台不认识时在这里抛
  let s = nfc(input.trim())

  // `\\?\` / `\\.\` 是 Win32 设备命名空间：那里的 `..` 与规范化规则**不适用**，
  // 尾点尾空格也不被剥掉。本模块拒绝它，而不是假装能理解它。
  if (platform === 'win32' && /^\\\\[?.]\\/.test(s)) {
    throw fail(
      SCOPE_CODES.DEVICE_PATH,
      `路径 ${JSON.stringify(input)} 使用 Win32 设备命名空间（\\\\?\\ 或 \\\\.\\）。` +
      '那里的 `..` 与规范化规则与普通路径不同，尾点尾空格也不会被剥掉——' +
      '本模块拒绝它，而不是假装能理解它',
    )
  }

  if (platform === 'win32') {
    // UNC：`\\server\share\...`
    const unc = /^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(s)
    if (unc) {
      const root = `//${unc[1]}/${unc[2]}`
      return Object.freeze({
        kind: 'unc',
        root,
        segments: splitTail(unc[3]),
        raw: s,
      })
    }
    const drive = /^([A-Za-z]):(.*)$/.exec(s)
    if (drive) {
      const rest = drive[2]
      if (rest === '' || (!rest.startsWith('\\') && !rest.startsWith('/'))) {
        // `C:foo` 是**盘符相对**路径：它相对该盘的当前目录，不是绝对路径。
        //
        //   > 一个「把 `C:foo` 当成绝对路径」的解析，
        //   > 与一个「同一个字符串在不同进程里指向不同文件」的解析，是同一个东西。
        throw fail(
          SCOPE_CODES.NOT_ABSOLUTE,
          `路径 ${JSON.stringify(input)} 是盘符相对路径（C: 后面没有分隔符），` +
          '它相对该盘的当前目录、不是绝对路径',
        )
      }
      return Object.freeze({ kind: 'drive', root: `${drive[1].toLowerCase()}:`, segments: splitTail(rest), raw: s })
    }
    if (s.startsWith('\\') || s.startsWith('/')) {
      // `\foo` 是**当前盘**的根：绝对但不完整。
      throw fail(
        SCOPE_CODES.NOT_ABSOLUTE,
        `路径 ${JSON.stringify(input)} 没有盘符（反斜杠开头表示"当前盘的根"），` +
        '当前盘随进程而变，不能用来做包含判定',
      )
    }
    throw fail(SCOPE_CODES.NOT_ABSOLUTE, `路径 ${JSON.stringify(input)} 不是绝对路径`)
  }

  if (!s.startsWith('/')) {
    throw fail(SCOPE_CODES.NOT_ABSOLUTE, `路径 ${JSON.stringify(input)} 不是绝对路径`)
  }
  return Object.freeze({ kind: 'posix', root: '/', segments: splitTail(s), raw: s })
}

function splitTail(tail) {
  if (tail === undefined || tail === null) return Object.freeze([])
  return Object.freeze(
    nfc(String(tail))
      .split(/[\\/]+/)
      .filter((x) => x !== ''),
  )
}

/**
 * Windows 会把**路径段末尾的点与空格**剥掉：`work\a.txt.` 与 `work\a.txt ` 都指向
 * `work\a.txt`。所以在比较之前必须剥，否则检查的是另一个字符串。
 *
 * ⚠️ **但 `.` 与 `..` 不是"尾点"**。第一版无条件地在这里剥，于是 `..` 被剥成空串、
 * 再被兜底成 `.`——**每一个 `..` 都变成了 `.`**。装载自检抓到了它：
 * `C:\work\..\..\etc` 折叠出来是 `c:/work/etc`。
 *
 * 这个方向很坏：`/work/sub/../../../etc` 折叠成 `/work/sub/etc`，
 * **在范围之内**——一次完整的越界。而且它在任何只往前走（不用 `..`）的用例里都是绿的。
 *
 *   > 一个「把 `..` 也当成'尾点'剥掉」的规范化，
 *   > 与一个「`..` 静默变成 `.`、于是路径永远往深处走」的规范化，是同一个东西——
 *   > 而它的方向是放行。
 *
 * 调用方必须先判 `.` / `..`，再调用本函数（见 `collapseSegments`）。
 */
export function stripTrailingHazards(segment, { platform } = {}) {
  if (platform !== 'win32') return segment
  if (segment === '.' || segment === '..') return segment
  const stripped = segment.replace(/[. ]+$/, '')
  return stripped === '' ? '.' : stripped
}

/** 文本层面折叠 `.` 与 `..`。**不碰文件系统**。 */
export function collapseSegments(segments, { platform } = {}) {
  const out = []
  let escaped = 0
  for (const raw of segments) {
    // `.` 与 `..` 先认出来，**不能**交给 stripTrailingHazards。
    if (raw === '.') continue
    if (raw === '..') {
      if (out.length > 0) out.pop()
      else escaped += 1
      continue
    }
    const seg = stripTrailingHazards(raw, { platform })
    if (seg === '.' || seg === '') continue
    out.push(seg)
  }
  if (escaped > 0) {
    // 折叠后仍然往上逃出根（`C:\..\..` 或 `/..`）→ 这个路径没有意义。
    throw fail(
      SCOPE_CODES.OUT_OF_SCOPE,
      `路径在折叠后往上逃出了根本身（多出 ${escaped} 层 \`..\`）`,
    )
  }
  return Object.freeze(out)
}

/** 比较用的规范形式：分隔符归一 + 尾点尾空格剥离 + 大小写按平台折叠。 */
export function normalizeForCompare(input, { platform } = {}) {
  const parsed = parsePath(input, { platform })
  const segs = collapseSegments(parsed.segments, { platform }).map((s) => {
    // Win32 设备名在**任何**位置都被当成设备（含带扩展名，如 `NUL.txt`）。
    const base = s.split('.')[0].toUpperCase()
    return { seg: s, device: platform === 'win32' && WINDOWS_DEVICE_NAMES.includes(base) }
  })
  const device = segs.find((x) => x.device)
  if (device !== undefined) {
    throw fail(
      SCOPE_CODES.DEVICE_PATH,
      `路径 ${JSON.stringify(input)} 的段 ${JSON.stringify(device.seg)} 是 Win32 设备名——` +
      '它写的不是文件（设备名无论有没有扩展名都生效）',
    )
  }
  const folded = segs.map((x) => (caseFoldsOn(platform) ? x.seg.toLowerCase() : x.seg))
  const base = caseFoldsOn(platform) ? parsed.root.toLowerCase() : parsed.root
  // ⚠️ 拼接要顾到根**自己**以分隔符结尾的情形：POSIX 的根是 `/`，
  // 朴素的 `${base}/${body}` 会拼出 `//work/sub`，而 `//work/sub` 与
  // `/work/sub` 是两个不同的字符串（也指向两个不同的位置）。
  //
  //   > 一个「把 POSIX 根拼成 `//work`」的规范化，
  //   > 与一个「同一个目录有两种规范形式、包含判定随机成立」的规范化，是同一个东西。
  const body = folded.join('/')
  const joined = body === '' ? base : (base.endsWith('/') ? `${base}${body}` : `${base}/${body}`)
  const key = joined.replace(/\/+$/, '') || base
  return Object.freeze({
    root: base,
    segments: Object.freeze(folded),
    key,
    hasStream: segs.some((x) => x.seg.includes(':')),
  })
}

/**
 * 边界感知的包含判定：相等，或在 `root + '/'` 之下。
 *
 * 这一条是 `startsWith` 的替代品。两者的区别只在**边界**上，所以只测"普通文件在
 * root 里"的用例区分不出它们。
 */
export function contains(rootKey, targetKey) {
  if (rootKey === targetKey) return true
  return targetKey.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
}

/** 文本层面的包含判定（**不解析链接**，只用于先做一次便宜的前置拒绝）。 */
export function containsTextual({ root, target, platform }) {
  return contains(normalizeForCompare(root, { platform }).key, normalizeForCompare(target, { platform }).key)
}

/**
 * 找到**最深的存在前缀**，然后把剩下的段接回去。
 *
 * 这是"写操作恰好都是新文件"那一条的落地：`realpath` 必须只施加在存在的前缀上。
 */
export function splitAtDeepestExisting({ path, exists, platform } = {}) {
  if (typeof exists !== 'function') {
    throw fail(SCOPE_CODES.RESOLVER_MISSING, 'splitAtDeepestExisting 需要一个 exists(path) 函数（真实实现接 fs.existsSync）')
  }
  const parsed = parsePath(path, { platform })
  const segs = collapseSegments(parsed.segments, { platform })
  const joinAbs = (n) => {
    const body = segs.slice(0, n).map((s) => stripTrailingHazards(s, { platform })).join('/')
    if (body === '') return parsed.root
    // 同 `normalizeForCompare`：根自己可能以分隔符结尾（POSIX 的 `/`），
    // 朴素的 `${root}/${body}` 会拼出一个**不存在**的 `//work/sub`。
    return parsed.root.endsWith('/') ? `${parsed.root}${body}` : `${parsed.root}/${body}`
  }
  let n = segs.length
  while (n > 0 && !exists(joinAbs(n))) n -= 1
  if (n === 0 && !exists(parsed.root)) {
    throw fail(
      SCOPE_CODES.UNRESOLVED,
      `路径 ${JSON.stringify(path)} 连根 ${JSON.stringify(parsed.root)} 都不存在——无法确定它落在哪里，拒绝`,
    )
  }
  return Object.freeze({
    existing: joinAbs(n),
    missing: Object.freeze(segs.slice(n)),
    // 新建文件时 `missing` 非空：**这正是写操作的样子**。
    createsNew: n < segs.length,
  })
}

/**
 * 解析成真实路径：最存在前缀走 `realpath`，剩余段接回来，**然后重来**。
 *
 * ★ 为什么必须重来：`exists()` **看不穿链接**。
 *
 * 目标 `/work/link1/link2/f`，其中 `link1 → /base`、`/base/link2 → /deep`：
 * `exists('/work/link1/link2/f')` 是 false（真实 fs 上也一样），
 * `exists('/work/link1')` 是 true。于是最深存在前缀是 `/work/link1`，
 * 解析成 `/base`，接回 `link2/f` 得到 `/base/link2/f`——**而真实路径是 `/deep/f`**。
 *
 * 也就是说接回来的那一段**自己还会走链接**，而它从没被解析过：
 *
 *   > 一个「只解析最深存在前缀、剩下那段直接拼接」的解析，
 *   > 与一个「在链接目录下面再套一层链接就逃出去了」的解析，是同一个东西——
 *   > 而它的方向是放行。
 *
 * 所以是**迭代**：每轮解析当前的最深存在前缀，直到路径不再变化。
 * 轮数有上限，超过就拒绝——一份会无限自我展开的链接表本身就该拒绝。
 *
 * @param {object} p
 * @param {string} p.path
 * @param {(p: string) => string|null} p.realpath 真实实现接 `fs.realpathSync.native`
 * @param {(p: string) => boolean} p.exists
 * @param {number} [p.maxRounds]
 */
export function resolveReal({ path, realpath, exists, platform, maxRounds = 12 } = {}) {
  if (typeof realpath !== 'function') {
    throw fail(
      SCOPE_CODES.RESOLVER_MISSING,
      'resolveReal 需要一个 realpath(path) 函数。' +
      '不提供"解析不了就跳过解析"的降级——那正是新建文件时静默绕过范围检查的那条路径',
    )
  }
  let current = path
  let createsNew = false
  let missing = Object.freeze([])
  let firstSplit = null
  for (let round = 0; round < maxRounds; round += 1) {
    const split = splitAtDeepestExisting({ path: current, exists, platform })
    if (firstSplit === null) firstSplit = split
    const base = realpath(split.existing)
    if (base === null || base === undefined || base === '') {
      throw fail(SCOPE_CODES.UNRESOLVED, `真实路径解析返回了空值：${JSON.stringify(split.existing)}`)
    }
    const combined = split.missing.length === 0 ? base : `${base}/${split.missing.join('/')}`
    const nextKey = normalizeForCompare(combined, { platform }).key
    const hereKey = normalizeForCompare(current, { platform }).key
    createsNew = createsNew || split.createsNew
    if (nextKey === hereKey) {
      return Object.freeze({
        resolved: nextKey,
        existingResolved: normalizeForCompare(base, { platform }).key,
        createsNew,
        missing,
        // 留下轮数：叠了几层链接才稳定下来，是可查的事实
        rounds: round + 1,
      })
    }
    // 接回来的那一段自己还会走链接 → 用解析后的路径再来一轮。
    current = combined
    missing = split.missing
  }
  throw fail(
    SCOPE_CODES.UNRESOLVED,
    `真实路径解析在 ${maxRounds} 轮之后仍不稳定：${JSON.stringify(path)}。` +
    '一份会无限自我展开的链接表本身就该拒绝',
  )
}

// ---------------------------------------------------------------- 范围表

/**
 * 允许出现的字段。`version` 在列：归一化的输出带它，所以**归一化必须能接受自己的
 * 输出**（幂等）。
 *
 *   > 一个「接受不了自己的输出」的归一化，
 *   > 与一个「第二次经过就抛」的归一化，是同一个东西。
 */
const ROOT_FIELDS = Object.freeze(['version', 'read', 'write', 'cwd', 'platform'])

/**
 * 归一化一份范围表。**写范围必须是读范围的子集**。
 *
 * ⚠️ 幂等：`normalizeScope(normalizeScope(x))` 必须成立（见 ROOT_FIELDS 的注释）。
 *
 *   > 一个「写范围可以大于读范围」的范围表，
 *   > 与一个「写不了的东西先读出来、再写到别处」的范围表，是同一个东西。
 */
export function normalizeScope(input) {
  if (input === null || typeof input !== 'object') {
    throw fail(SCOPE_CODES.BAD_SCOPE, 'normalizeScope 需要一份范围对象')
  }
  const seen = Object.keys(input)
  const unknown = seen.filter((k) => !ROOT_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw fail(
      SCOPE_CODES.BAD_SCOPE,
      `范围表里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的范围表，与一个"多打的一个字母让整条限制静默失效"的范围表，是同一个东西',
    )
  }
  if (input.version !== undefined && input.version !== PATH_SCOPE_VERSION) {
    throw fail(SCOPE_CODES.BAD_SCOPE, `范围表的 version 是 ${JSON.stringify(input.version)}，期望 ${JSON.stringify(PATH_SCOPE_VERSION)}`)
  }
  const platform = input.platform
  caseFoldsOn(platform)
  const read = Array.isArray(input.read) ? input.read : null
  const write = Array.isArray(input.write) ? input.write : null
  if (read === null || write === null) {
    throw fail(SCOPE_CODES.BAD_SCOPE, '范围表必须有 read 与 write 两个数组')
  }
  if (read.length === 0) {
    // 空读范围是合法的（什么都不许读），但那时写范围必须也是空的；见下。
    // 这里不抛：空集合是"什么都不许"，方向安全。
  }
  const readKeys = read.map((r) => normalizeForCompare(r, { platform }).key)
  const writeKeys = write.map((r) => normalizeForCompare(r, { platform }).key)
  const outside = writeKeys.filter((w) => !readKeys.some((r) => contains(r, w)))
  if (outside.length > 0) {
    throw fail(
      SCOPE_CODES.WRITE_NOT_IN_READ,
      `写范围里有不在读范围之内的项 ${JSON.stringify(outside)}。` +
      '写范围必须是读范围的子集——一个"写范围可以大于读范围"的范围表，' +
      '与一个"写不了的东西先读出来、再写到别处"的范围表，是同一个东西',
    )
  }
  const cwd = input.cwd === undefined || input.cwd === null ? null : normalizeForCompare(input.cwd, { platform }).key
  return Object.freeze({
    version: PATH_SCOPE_VERSION,
    platform,
    read: Object.freeze(readKeys),
    write: Object.freeze(writeKeys),
    cwd,
  })
}

/**
 * 用 PRT-603 的 `workspaceRoot` **进一步收窄**工作目录（不取代范围表）。
 *
 * ★ 收窄是**取交集**，不是"筛掉不包含的"。
 *
 * 第一版写的是"只保留落在 workspaceRoot 之内的写根"。于是
 * `write:['/work/sub']` + `workspaceRoot:'/work/sub/deep'` 被判成"没有交集"——
 * 而正确答案是 `/work/sub/deep`：工作目录**比写根更深**，所以它把写根收到了自己这里。
 *
 *   > 一个「把'工作目录比写根更深'当成'没有交集'」的收窄，
 *   > 与一个「岗位配了一个更深的目录就什么都写不了」的收窄，是同一个东西。
 */
export function narrowScopeToWorkspace({ scope, workspaceRoot } = {}) {
  // ⚠️ **总是**归一化。第一版写的是
  //     `scope?.version === PATH_SCOPE_VERSION ? scope : normalizeScope(scope)`
  // —— 于是手工构造一个带 `version` 的范围表就跳过了**全部**校验
  //（包括"写范围必须是读范围的子集"）。这是 PRT-603 那条教训的同一个形状：
  //
  //   > 一个「看到 version 字段就认为它已经校验过」的校验，
  //   > 与一个「在范围表里写一行 version 就能跳过所有检查」的校验，是同一个东西。
  const s = normalizeScope(scope)
  if (workspaceRoot === undefined || workspaceRoot === null) return s
  const root = normalizeForCompare(workspaceRoot, { platform: s.platform }).key
  // 两个根的"交集"：谁在谁之内就取更深的那个，互不包含则没有交集。
  const intersect = (a, b) => {
    if (contains(a, b)) return b
    if (contains(b, a)) return a
    return null
  }
  const narrowed = [...new Set(s.write.map((w) => intersect(w, root)).filter((x) => x !== null))]
  if (narrowed.length === 0 && s.write.length > 0) {
    throw fail(
      SCOPE_CODES.OUT_OF_SCOPE,
      `岗位工作目录 ${JSON.stringify(workspaceRoot)} 与写范围 ${JSON.stringify(s.write)} 没有交集——` +
      '那意味着这个岗位什么都写不了，配置一定是错的',
    )
  }
  // 收窄之后 `write ⊆ read` 这条不变量**在数学上自动成立**（写根本来就在读根之内，
  // 而交集只会更深），所以这里不再放一道检查：
  //
  //   > 一段从未被执行的分支，与一段不存在的分支，在"它到底对不对"上是同一个东西。
  //
  // 真正需要这道检查的地方是入口（`normalizeScope`），而它在那里是**可达**的
  // （形态各异的输入都能到），所以校验收在入口，并由用例直接断言不变量。
  return Object.freeze({
    version: PATH_SCOPE_VERSION,
    platform: s.platform,
    read: s.read,
    write: Object.freeze(narrowed),
    cwd: root,
  })
}

// ---------------------------------------------------------------- 判定

/**
 * 判定一个目标路径是否在范围之内。
 *
 * @param {object} p
 * @param {string} p.target
 * @param {object} p.scope        已归一化的范围表
 * @param {'read'|'write'} p.direction
 * @param {function} p.realpath    真实实现接 fs.realpathSync.native
 * @param {function} p.exists      真实实现接 fs.existsSync
 * @returns {{allowed: boolean, code: string|null, reason: string|null, targetResolved: string|null, rootMatched: string|null, createsNew: boolean}}
 */
export function checkPathScope({ target, scope, direction, realpath, exists } = {}) {
  // 同 `narrowScopeToWorkspace`：**总是**归一化，不信 `version` 字段。
  const s = normalizeScope(scope)
  if (direction !== 'read' && direction !== 'write') {
    throw fail(SCOPE_CODES.BAD_SCOPE, `direction 必须是 read 或 write，收到 ${JSON.stringify(direction)}`)
  }
  const roots = direction === 'write' ? s.write : s.read
  if (roots.length === 0) {
    return Object.freeze({
      allowed: false,
      code: direction === 'write' ? SCOPE_CODES.OUTSIDE_WRITE : SCOPE_CODES.OUTSIDE_READ,
      reason: `这个岗位的${direction === 'write' ? '写' : '读'}范围是空的`,
      targetResolved: null,
      rootMatched: null,
      createsNew: false,
    })
  }
  let resolved
  try {
    resolved = resolveReal({ path: target, realpath, exists, platform: s.platform })
  } catch (err) {
    return Object.freeze({
      allowed: false,
      code: err?.code ?? SCOPE_CODES.UNRESOLVED,
      reason: err?.message ?? String(err),
      targetResolved: null,
      rootMatched: null,
      createsNew: false,
    })
  }

  // 根**也要**解析一次：根自己可能是一个链接。
  //   > 一个「只解析目标、不解析根」的范围检查，
  //   > 与一个「根被换成一个链接之后就整片失效」的范围检查，是同一个东西。
  const rootPairs = roots.map((r) => {
    try {
      return { declared: r, resolved: resolveReal({ path: r, realpath, exists, platform: s.platform }).resolved }
    } catch {
      return { declared: r, resolved: null }
    }
  })
  const matched = rootPairs.find((rp) => rp.resolved !== null && contains(rp.resolved, resolved.resolved))

  if (matched === undefined) {
    // 文本上在范围里、解析后却不在 → 这是一次**链接逃逸**，要报成它自己的码。
    //   > 一个「把链接逃逸报成普通的'越界'」的拒绝，
    //   > 与一个「值班的人去改了错误的配置」的拒绝，是同一个东西。
    const textual = roots.some((r) => contains(r, normalizeForCompare(target, { platform: s.platform }).key))
    const code = textual
      ? SCOPE_CODES.SYMLINK_ESCAPE
      : (direction === 'write' ? SCOPE_CODES.OUTSIDE_WRITE : SCOPE_CODES.OUTSIDE_READ)
    const why = textual
      ? `${JSON.stringify(target)} 文本上在范围之内，但解析后的真实路径 ${JSON.stringify(resolved.resolved)} 不在——这是一次链接逃逸`
      : `${JSON.stringify(target)} 解析后是 ${JSON.stringify(resolved.resolved)}，不在${direction === 'write' ? '写' : '读'}范围 ${JSON.stringify(roots)} 之内`
    return Object.freeze({
      allowed: false,
      code,
      reason: why,
      targetResolved: resolved.resolved,
      rootMatched: null,
      createsNew: resolved.createsNew,
    })
  }

  return Object.freeze({
    allowed: true,
    code: null,
    reason: null,
    targetResolved: resolved.resolved,
    rootMatched: matched.declared,
    createsNew: resolved.createsNew,
  })
}

// ---------------------------------------------------------------- 参考解析器

/**
 * 一个**纯内存**的解析器，作为 seam 的参考实现与判据的夹具。
 *
 * 真实实现接 `fs.realpathSync.native` + `fs.existsSync`。函数不能跨 JSON，
 * 所以这一层永远留在进程内。
 *
 * @param {object} p
 * @param {string[]} p.real     真实存在的文件/目录（绝对路径）
 * @param {Record<string,string>} p.links  链接路径 → 目标路径
 */
export function createResolver({ real = [], links = {}, platform = 'linux' } = {}) {
  const norm = (x) => normalizeForCompare(x, { platform }).key
  const realSet = new Set(real.map(norm))
  const linkMap = new Map(Object.entries(links).map(([k, v]) => [norm(k), norm(v)]))

  const exists = (p) => {
    let key
    try { key = norm(p) } catch { return false }
    if (realSet.has(key) || linkMap.has(key)) return true
    // 目录：只要它是某条真实路径的前缀，就当作存在。
    const prefix = key.endsWith('/') ? key : `${key}/`
    for (const r of realSet) if (r.startsWith(prefix)) return true
    for (const l of linkMap.keys()) if (l.startsWith(prefix)) return true
    return false
  }

  const realpath = (p) => {
    const key = norm(p)
    if (linkMap.has(key)) return linkMap.get(key)
    // 逐段把链接替换掉（`a/b/c` 里 `a/b` 可能是链接）。
    const parts = key.split('/')
    for (let n = parts.length; n > 0; n -= 1) {
      const prefix = parts.slice(0, n).join('/')
      if (linkMap.has(prefix)) {
        const rest = parts.slice(n)
        return rest.length === 0 ? linkMap.get(prefix) : `${linkMap.get(prefix)}/${rest.join('/')}`
      }
    }
    return key
  }

  return Object.freeze({ exists, realpath, known: Object.freeze({ real: Object.freeze([...realSet]), links: Object.freeze(Object.fromEntries(linkMap)) }) })
}

/** 探测结果**不是**布尔：它必须说清楚是靠什么判定的。 */
export function describeBackendEvidence({ sandboxMode, probed }) {
  const named = typeof sandboxMode === 'string' && sandboxMode !== ''
  return Object.freeze({
    sandboxMode: sandboxMode ?? null,
    configuredNameOnly: named && probed !== true,
    // spec §6.6 line 454：仅有配置名不算生效
    effective: named && probed === true,
    note: named && probed !== true
      ? '只看到了配置名，没有后端探测结果——按"未生效"处理'
      : null,
  })
}

// ---------------------------------------------------------------- 装载自检

/** ① 边界不是前缀：`/work-evil` 不在 `/work` 之内。 */
export function assertBoundaryNotPrefix({ cases = null } = {}) {
  const samples = cases ?? [
    { root: '/work', target: '/work/a.txt', inside: true },
    { root: '/work', target: '/work', inside: true },
    { root: '/work', target: '/work/sub/a.txt', inside: true },
    { root: '/work', target: '/work-evil', inside: false },
    { root: '/work', target: '/work-evil/a.txt', inside: false },
    { root: '/work', target: '/workshop', inside: false },
    { root: '/work', target: '/', inside: false },
    { root: '/work', target: '/work/../etc', inside: false },
  ]
  const out = samples.map((s) => {
    const rootKey = normalizeForCompare(s.root, { platform: 'linux' }).key
    const targetKey = normalizeForCompare(s.target, { platform: 'linux' }).key
    return Object.freeze({
      root: s.root,
      target: s.target,
      expected: s.inside,
      got: contains(rootKey, targetKey),
      // 同时给出 `startsWith` 的答案：两者相等的那一列就是"区分不出"的那一列。
      startsWith: targetKey.startsWith(rootKey),
    })
  })
  const wrong = out.filter((o) => o.got !== o.expected)
  return Object.freeze({
    samples: Object.freeze(out),
    wrong: Object.freeze(wrong),
    // `startsWith` 在哪一行给出错误答案 —— 这就是"为什么必须有边界"的证据
    prefixWouldBeWrongOn: Object.freeze(out.filter((o) => o.startsWith !== o.expected).map((o) => o.target)),
  })
}

/**
 * ② 链接逃逸：在允许目录里放一个指向外的链接。
 *
 * 同时给出"只比字符串"的答案，用来证明字符串比较在**只用了普通文件名**的用例里
 * 是绿的。
 */
export function assertSymlinkEscapeCaught({
  scope = { read: ['/work'], write: ['/work'], platform: 'linux' },
  real = ['/work', '/etc', '/etc/passwd'],
  links = { '/work/etc': '/etc' },
} = {}) {
  const s = normalizeScope(scope)
  const r = createResolver({ real, links, platform: scope.platform })
  const target = '/work/etc/passwd'
  const verdict = checkPathScope({ target, scope: s, direction: 'read', realpath: r.realpath, exists: r.exists })
  const textualKey = normalizeForCompare(target, { platform: scope.platform }).key
  return Object.freeze({
    target,
    link: Object.freeze(links),
    // 纯字符串判定会说什么
    textualWouldAllow: s.read.some((root) => contains(root, textualKey)),
    resolved: verdict.targetResolved,
    allowed: verdict.allowed,
    code: verdict.code,
    verdict,
  })
}

/** ③ 写操作恰好都是**新文件**：解析必须只施加在存在的前缀上。 */
export function assertNewFileResolved({
  scope = { read: ['/work'], write: ['/work'], platform: 'linux' },
  real = ['/work', '/work/sub'],
  links = { '/work/sub': '/elsewhere' },
} = {}) {
  const s = normalizeScope(scope)
  const r = createResolver({ real: [...real, '/elsewhere'], links, platform: scope.platform })
  const target = '/work/sub/new-file.txt'
  const created = checkPathScope({ target, scope: s, direction: 'write', realpath: r.realpath, exists: r.exists })
  // 同一个目标，但父目录不是链接 → 应当放行
  const plain = createResolver({ real: ['/work', '/work/sub'], links: {}, platform: scope.platform })
  const ok = checkPathScope({ target, scope: s, direction: 'write', realpath: plain.realpath, exists: plain.exists })
  return Object.freeze({
    target,
    createsNew: created.createsNew,
    // 关键证据：链接下的**新文件**被拦住了
    escaped: Object.freeze({ allowed: created.allowed, code: created.code, resolved: created.targetResolved }),
    // 而普通目录下的新文件放行
    plain: Object.freeze({ allowed: ok.allowed, code: ok.code, resolved: ok.targetResolved, createsNew: ok.createsNew }),
    split: splitAtDeepestExisting({ path: target, exists: r.exists, platform: scope.platform }),
  })
}

/** ④ 尾点尾空格：`..\etc.` 与 `..\etc` 是同一个位置。 */
export function assertTrailingHazards() {
  const samples = ['a.txt.', 'a.txt ', 'a.txt...', 'a. .', 'sub. ']
  const out = samples.map((s) => Object.freeze({
    segment: s,
    stripped: stripTrailingHazards(s, { platform: 'win32' }),
    untouchedOnLinux: stripTrailingHazards(s, { platform: 'linux' }),
  }))
  // `C:\work\..\etc.` 折叠后是 `c:/etc` —— 与 `C:\work\..\etc` 同一个位置
  const a = normalizeForCompare('C:\\work\\..\\etc.', { platform: 'win32' }).key
  const b = normalizeForCompare('C:\\work\\..\\etc', { platform: 'win32' }).key
  return Object.freeze({
    samples: Object.freeze(out),
    windows: Object.freeze({ trailingDots: a, plain: b, same: a === b }),
    inserted: normalizeForCompare('C:\\work\\a .txt', { platform: 'win32' }).key,
  })
}

/** ⑤ 大小写规则跟着平台走。 */
export function assertCaseRuleFollowsPlatform() {
  const win = normalizeForCompare('C:\\WORK\\A.TXT', { platform: 'win32' }).key
  const winLower = normalizeForCompare('c:\\work\\a.txt', { platform: 'win32' }).key
  const lin = normalizeForCompare('/WORK/A.TXT', { platform: 'linux' }).key
  const linLower = normalizeForCompare('/work/a.txt', { platform: 'linux' }).key
  let unknownPlatformCode = null
  try { normalizeForCompare('/x', { platform: 'plan9' }) } catch (err) { unknownPlatformCode = err.code }
  return Object.freeze({
    win32: Object.freeze({ folded: win, plain: winLower, same: win === winLower }),
    linux: Object.freeze({ folded: lin, plain: linLower, same: lin === linLower }),
    unknownPlatformCode,
  })
}

/** ⑥ 盘符相对 / 无盘符 / 设备命名空间 / 设备名 / ADS 都必须被拒。 */
export function assertHazardsRejected({ samples = HAZARD_SAMPLES } = {}) {
  const out = samples.map((s) => {
    try {
      const n = normalizeForCompare(s.path, { platform: s.platform })
      return Object.freeze({ path: s.path, platform: s.platform, expected: s.code, code: null, key: n.key })
    } catch (err) {
      return Object.freeze({ path: s.path, platform: s.platform, expected: s.code, code: err.code ?? null, key: null })
    }
  })
  return Object.freeze({ samples: Object.freeze(out), mismatched: Object.freeze(out.filter((o) => o.code !== o.expected)) })
}

const HAZARD_SAMPLES = Object.freeze([
  Object.freeze({ path: 'C:foo', platform: 'win32', code: SCOPE_CODES.NOT_ABSOLUTE }),
  Object.freeze({ path: '\\foo', platform: 'win32', code: SCOPE_CODES.NOT_ABSOLUTE }),
  Object.freeze({ path: 'foo/bar', platform: 'win32', code: SCOPE_CODES.NOT_ABSOLUTE }),
  Object.freeze({ path: 'foo/bar', platform: 'linux', code: SCOPE_CODES.NOT_ABSOLUTE }),
  Object.freeze({ path: '\\\\?\\C:\\work\\a', platform: 'win32', code: SCOPE_CODES.DEVICE_PATH }),
  Object.freeze({ path: '\\\\.\\PHYSICALDRIVE0', platform: 'win32', code: SCOPE_CODES.DEVICE_PATH }),
  Object.freeze({ path: 'C:\\work\\NUL', platform: 'win32', code: SCOPE_CODES.DEVICE_PATH }),
  Object.freeze({ path: 'C:\\work\\nul.txt', platform: 'win32', code: SCOPE_CODES.DEVICE_PATH }),
  Object.freeze({ path: 'C:\\work\\COM1.log', platform: 'win32', code: SCOPE_CODES.DEVICE_PATH }),
  Object.freeze({ path: 'C:\\work\\..\\..\\etc', platform: 'win32', code: SCOPE_CODES.OUT_OF_SCOPE }),
  Object.freeze({ path: '/..', platform: 'linux', code: SCOPE_CODES.OUT_OF_SCOPE }),
  Object.freeze({ path: '', platform: 'linux', code: SCOPE_CODES.BAD_TARGET }),
  Object.freeze({ path: '   ', platform: 'linux', code: SCOPE_CODES.BAD_TARGET }),
  Object.freeze({ path: 'C:\\work\\a.txt', platform: 'plan9', code: SCOPE_CODES.CASE_RULE }),
  Object.freeze({ path: '/x', platform: undefined, code: SCOPE_CODES.CASE_RULE }),
])

/** ⑦ 范围表：写范围必须是读范围的子集（与 PRT-603 同一条纪律）。 */
export function assertWriteScopeNarrowed() {
  const okScope = normalizeScope({ read: ['/work'], write: ['/work/sub'], platform: 'linux' })
  let widened = null
  try {
    normalizeScope({ read: ['/work'], write: ['/etc'], platform: 'linux' })
  } catch (err) { widened = err.code }
  let emptyWrite = null
  try {
    narrowScopeToWorkspace({
      scope: { read: ['/work'], write: ['/work/sub'], platform: 'linux' },
      workspaceRoot: '/elsewhere',
    })
  } catch (err) { emptyWrite = err.code }
  return Object.freeze({
    ok: Object.freeze({ read: okScope.read, write: okScope.write }),
    widenedWriteCode: widened,
    emptyIntersectionCode: emptyWrite,
    narrowed: narrowScopeToWorkspace({
      scope: normalizeScope({ read: ['/work'], write: ['/work/sub'], platform: 'linux' }),
      workspaceRoot: '/work/sub/deep',
    }),
  })
}

/** ⑧ 沙箱配置名不算证据（spec §6.6 line 454）。 */
export function assertBackendEvidenceRequired() {
  return Object.freeze({
    namedOnly: describeBackendEvidence({ sandboxMode: 'workspace-write', probed: false }),
    probed: describeBackendEvidence({ sandboxMode: 'workspace-write', probed: true }),
    missing: describeBackendEvidence({}),
  })
}

export const PATH_SCOPE_CHECKED = Object.freeze({
  version: PATH_SCOPE_VERSION,
  devices: WINDOWS_DEVICE_NAMES,
  boundary: assertBoundaryNotPrefix(),
  symlink: assertSymlinkEscapeCaught(),
  newFile: assertNewFileResolved(),
  trailing: assertTrailingHazards(),
  caseRule: assertCaseRuleFollowsPlatform(),
  hazards: assertHazardsRejected(),
  scopeTable: assertWriteScopeNarrowed(),
  backend: assertBackendEvidenceRequired(),
})
