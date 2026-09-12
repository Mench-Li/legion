// security/secrets/acl.mjs
// ============================================================================
// 密钥库文件的**访问控制**加固（PRT-509 的「跨账户与 ACL 加固」）
//
// 为什么密文受保护还不够：DPAPI 保护的是**内容**，不是**文件**。
// 另一个 Windows 账户仍然可以：
//   - 复制这个文件带走（离线暴力/社会工程/把它塞进工单）；
//   - 看到里面有哪些引用名（`refs` 是明文的 key，能画出"这台机器配了哪些供应商"）；
//   - 反复触发解密失败，把它变成一个可观测的信号。
//
// 所以文件本身必须**只有所有者可读**。
//
// ---------------------------------------------------------------------------
// 「查不出来」必须与「查出来是安全的」分开
//
// DSH 自己的 `credentials-local` 在这一点上做得很清楚，注释原文：
//
//   POSIX only: Windows has no mode to inspect — its ACLs are not expressible
//   here — so the check is skipped rather than faked.
//
// **skipped rather than faked** —— 这条纪律必须继承。但它留下一个缺口：
// 本产品的主平台**就是** Windows（PRT-505 的标题就是 Windows Secret Store），
// 而"跳过"在这里等于"Windows 上从不检查"。
//
// Windows 的 ACL **是可查的**：`icacls` 就是它的机制。所以本模块不跳过，
// 而是**真的去读**，并且把三种结果分开：
//
//   ok        —— 只有所有者（+ 系统必需主体）可访问
//   TOO_PERMISSIVE —— 查出来了，别人也能读 → 明确拒绝
//   UNVERIFIABLE   —— **查不出来**（icacls 不存在/输出看不懂/平台未知）
//
// 第三种**绝不等同于第一种**。一条"查不出来就当通过"的检查，
// 比没有检查更坏：它会让人相信一件没被验证过的事。
// ============================================================================

/** ACL 检查的内部码。`UNVERIFIABLE` 与 `OK` 必须分开。 */
export const ACL_CODES = Object.freeze({
  OK: 'ACL_OK',
  TOO_PERMISSIVE: 'ACL_TOO_PERMISSIVE',
  UNVERIFIABLE: 'ACL_UNVERIFIABLE',
  UNSUPPORTED_PLATFORM: 'ACL_UNSUPPORTED_PLATFORM',
  HARDEN_FAILED: 'ACL_HARDEN_FAILED',
  NO_RUNNER: 'ACL_NO_RUNNER',
})

/**
 * Windows 上**允许**出现在密钥库 ACL 里的主体（小写比较）。
 *
 * 这几个不是"我们信任它们"，而是**操作系统要求**它们在场：
 * 没有 SYSTEM/Administrators，文件会变成连系统维护都做不了的状态。
 * 而管理员本来就等价于所有者权限——挡管理员不是 ACL 能做的事
 * （那要靠 EFS/DPAPI 的账户绑定，正是内容保护负责的部分）。
 *
 * 因此这里的判据是：**除了所有者和这几个必需主体，别人一律不许有权限。**
 * 特别地 `BUILTIN\Users`、`Everyone`、`Authenticated Users` 都在拒绝之列
 * ——它们才是"多用户机器上另一个用户能读到"的真正原因。
 */
export const WINDOWS_ALLOWED_PRINCIPALS = Object.freeze([
  'nt authority\\system',
  'builtin\\administrators',
  'nt authority\\administrators',
])

/** POSIX 上"只有所有者"的权限位上限。 */
export const POSIX_OWNER_ONLY_BITS = 0o600
const POSIX_GROUP_OTHER_BITS = 0o077

/**
 * 解析 `icacls <file>` 的输出。
 *
 * 真实输出（本机实测，注意**这台机器真的**把 Modify 给了两个非所有者主体）：
 *
 *   C:\Users\x\AppData\Local\Temp\f.json Amench\CodexSandboxUsers:(I)(M)
 *                                          S-1-5-21-...-928322546:(I)(M)
 *                                          NT AUTHORITY\SYSTEM:(I)(F)
 *                                          BUILTIN\Administrators:(I)(F)
 *                                          AMENCH\x:(I)(F)
 *
 *   Successfully processed 1 files; Failed processing 0 files
 *
 * 解析要注意两件事，两件都踩过：
 *
 * ① **第一行带文件路径**，且中间只有一个空格。所以"整行当主体"会把
 *    `C:\Users\...json Amench\CodexSandboxUsers` 当成一个主体名。
 *    正确做法是**按空白切成 token**，再对每个 token 做严格匹配。
 * ② **权限串可以有多个括号组**（`(I)(M)` / `(OI)(CI)(F)`），
 *    只取第一组会把继承标记 `I` 当成权限字母——而 `I` 不是权限。
 *    继承状态必须单独判断，因为它决定"这条 ACE 是文件自己的还是父目录给的"。
 */
export function parseIcacls(text, { file = null } = {}) {
  const principals = []
  const unparsed = []
  if (typeof text !== 'string') return { principals, unparsed }

  let body = text
  // **先去掉文件路径**。`icacls` 把它打印在第一行，与第一个 ACE 之间只隔一个空格，
  // 所以"按空白切 token"会把 `C:\...\f.json Amench\Users` 当成一个主体名，
  // 而"整行当一个主体"又会把路径一起吃进去。知道路径就直接删掉它。
  if (typeof file === 'string' && file !== '') {
    body = body.split(file).join(' ')
  } else {
    // 没给路径时的兜底：第一行第一个 token 若像路径就丢掉它。
    // **只丢这一个**，不做更多猜测——猜错会把真正的主体名吃掉。
    body = body.replace(/^(\s*)(?:[A-Za-z]:\\|\/|\\\\)\S*/, '$1')
  }

  // 主体名**可以含空格**（`NT AUTHORITY\SYSTEM`），所以不能按空白切。
  // 用"到 `:(...)` 为止、且不含括号"的形态匹配：括号只出现在权限组里，
  // 所以这个约束足以把主体名与权限串分开。
  const ACE_RE = /([^\s()][^()]*?):((?:\([^)]*\))+)/g

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^successfully processed/i.test(line)) continue

    let matched = 0
    for (const m of line.matchAll(ACE_RE)) {
      const name = m[1].trim()
      if (name === '') continue
      matched += 1
      principals.push({
        name,
        groups: m[2],
        inherited: m[2].includes('(I)'),
        access: accessLettersOf(m[2]),
      })
    }
    if (matched === 0 && line.includes(':(')) unparsed.push(line)
  }
  return { principals, unparsed }
}

/**
 * 从权限串里取出**实质权限字母**。
 *
 * 必须排除的（它们不是权限，是标志）：`I` 继承、`OI`/`CI`/`IO`/`NP` 传播标志。
 * 不排除的话 `(I)` 会被读成"有某个权限"，于是**每一条继承来的 ACE 都会被
 * 判成授权**——而继承来的 ACE 恰恰是最需要警惕的那类。
 */
export function accessLettersOf(groups) {
  return [...String(groups).matchAll(/\(([^)]*)\)/g)]
    .map((m) => m[1].trim().toUpperCase())
    .filter((g) => !['I', 'OI', 'CI', 'IO', 'NP', ''].includes(g))
    .join('')
}

/** 实质权限字母里是否含读/写/执行（`F` / `M` / `R` / `RX` / `W`）。 */
function grantsAccess(accessLetters) {
  return /[FMRXWD]/.test(String(accessLetters))
}

/**
 * 判断一组 Windows 主体是否"只有所有者可访问"。
 *
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function evaluateWindowsPrincipals(principals, { allowedExtra = [] } = {}) {
  const allowed = new Set([
    ...WINDOWS_ALLOWED_PRINCIPALS,
    ...allowedExtra.map((s) => String(s).toLowerCase()),
  ])
  const offenders = []
  for (const p of principals) {
    // 只看**实质权限**。继承来的也算——继承恰恰是最需要警惕的来源：
    // 文件自己没授权，但父目录给了 `Users`，效果完全一样。
    // 注意 `p.access` 是**已经抽好的权限字母**，不能再抽一次括号
    // （再抽一次得到空串，于是所有主体都被跳过、检查永远通过）。
    const letters = p.access !== undefined ? p.access : accessLettersOf(p.groups)
    if (!grantsAccess(letters)) continue
    const name = String(p.name).toLowerCase()
    // 所有者自己由调用方通过 allowedExtra 传入（`icacls` 输出里不标出所有者）。
    // 这里**不做"看起来像所有者就放过"的猜测**——猜错会让检查形同虚设。
    if (allowed.has(name)) continue
    offenders.push(p.name)
  }
  return { ok: offenders.length === 0, offenders }
}

/**
 * 读一次 ACL 判定。
 *
 * @param {object} opts
 * @param {string} opts.file        密钥库文件路径
 * @param {string} [opts.platform]  `process.platform`
 * @param {Function} [opts.run]     `(cmd, args) => {stdout, status}`；不注入则用默认实现
 * @param {string} [opts.owner]     所有者（Windows 上从 `icacls` 的第一行取）
 * @returns {Promise<{ok, code, message, principals, owner, platform, skipped}>}
 */
export async function inspectFileAcl({
  file,
  platform = process.platform,
  run,
  owner = null,
} = {}) {
  if (typeof file !== 'string' || file === '') {
    return { ok: false, code: ACL_CODES.UNVERIFIABLE, message: '没有给出文件路径，无法检查访问控制', principals: [], owner: null, platform, skipped: false }
  }

  if (platform === 'win32') {
    if (typeof run !== 'function') {
      // **不假装通过**：没有 runner 就没查过，而"没查过"绝不能被当成"是安全的"。
      return {
        ok: false, code: ACL_CODES.NO_RUNNER,
        message: '没有 icacls runner，无法确认访问控制（**不要把"没查过"当成"是安全的"**）',
        principals: [], owner: null, platform, skipped: false,
      }
    }
    let res
    try {
      res = await run('icacls', [file])
    } catch (e) {
      return {
        ok: false, code: ACL_CODES.UNVERIFIABLE,
        message: `icacls 执行失败：${e?.name ?? 'Error'}。**未验证**不等于通过`,
        principals: [], owner: null, platform, skipped: false,
      }
    }
    const stdout = typeof res?.stdout === 'string' ? res.stdout : ''
    if (res?.status !== 0 && stdout.trim() === '') {
      return {
        ok: false, code: ACL_CODES.UNVERIFIABLE,
        message: `icacls 返回 ${res?.status} 且无输出（文件可能不存在或不可读）。**未验证**不等于通过`,
        principals: [], owner: null, platform, skipped: false,
      }
    }
    const { principals, unparsed } = parseIcacls(stdout, { file })
    if (principals.length === 0) {
      return {
        ok: false, code: ACL_CODES.UNVERIFIABLE,
        message: `icacls 输出里认不出任何访问条目（${unparsed.slice(0, 2).join(' / ') || '无内容'}）：**未验证**不等于通过`,
        principals: [], owner: null, platform, skipped: false,
      }
    }
    const { ok, offenders } = evaluateWindowsPrincipals(principals, {
      allowedExtra: owner === null ? [] : [owner],
    })
    if (!ok) {
      return {
        ok: false, code: ACL_CODES.TOO_PERMISSIVE,
        message: `密钥库文件对所有者和系统之外的主体可读：${offenders.join(' / ')}。` +
          'DPAPI 保护的是内容、不是文件——别人仍可复制它、看到有哪些引用名',
        principals, owner, platform, skipped: false, offenders,
      }
    }
    return { ok: true, code: ACL_CODES.OK, message: '访问控制仅限所有者', principals, owner, platform, skipped: false }
  }

  // POSIX：用 mode。与 DSH 的 `assertOwnerOnly` 同一判据。
  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    if (typeof run !== 'function') {
      return {
        ok: false, code: ACL_CODES.NO_RUNNER,
        message: '没有 stat runner，无法确认文件权限', principals: [], owner: null, platform, skipped: false,
      }
    }
    let res
    try {
      res = await run('stat', ['-c', '%a', file])
    } catch (e) {
      return {
        ok: false, code: ACL_CODES.UNVERIFIABLE,
        message: `stat 执行失败：${e?.name ?? 'Error'}。**未验证**不等于通过`,
        principals: [], owner: null, platform, skipped: false,
      }
    }
    const mode = parseInt(String(res?.stdout ?? '').trim(), 8)
    if (!Number.isInteger(mode)) {
      return {
        ok: false, code: ACL_CODES.UNVERIFIABLE,
        message: `stat 输出无法解析为权限位（${String(res?.stdout ?? '').trim().slice(0, 40)}）`,
        principals: [], owner: null, platform, skipped: false,
      }
    }
    const offending = mode & POSIX_GROUP_OTHER_BITS
    if (offending !== 0) {
      return {
        ok: false, code: ACL_CODES.TOO_PERMISSIVE,
        message: `密钥库文件对所有者之外可读（mode ${(mode & 0o777).toString(8)}）：` +
          `请先 \`chmod 600 ${file}\``,
        principals: [], owner, platform, skipped: false, mode,
      }
    }
    return { ok: true, code: ACL_CODES.OK, message: `权限仅限所有者（mode ${(mode & 0o777).toString(8)}）`, principals: [], owner, platform, skipped: false, mode }
  }

  // 未知平台：**如实说"不知道"**，不假装通过、也不假装失败。
  return {
    ok: false, code: ACL_CODES.UNSUPPORTED_PLATFORM,
    message: `平台 ${platform} 的访问控制尚未实现：**未验证**不等于通过（也不等于失败）`,
    principals: [], owner: null, platform, skipped: false,
  }
}

/**
 * 把文件收紧到"只有所有者"。
 *
 * Windows 上**先断继承再授权**，顺序不能反：
 * 只加权限不删继承，父目录给的 `Users` 授权仍然在，而我们刚刚"设置"过
 * 一次权限——那种"操作成功了但结果没变"最容易被误认为加固已完成。
 *
 * POSIX 上就是 `chmod 600`。
 *
 * @returns {{ok, code, message, actions}}
 */
export async function hardenFileAcl({
  file,
  platform = process.platform,
  run,
  owner = null,
} = {}) {
  if (typeof run !== 'function') {
    return { ok: false, code: ACL_CODES.NO_RUNNER, message: '没有 runner，无法加固访问控制', actions: [] }
  }
  const actions = []

  if (platform === 'win32') {
    if (typeof owner !== 'string' || owner === '') {
      // 不知道所有者就没法"只留给所有者"。猜一个主体去授权等于把权限给错人。
      return {
        ok: false, code: ACL_CODES.HARDEN_FAILED,
        message: '不知道文件所有者，无法把权限收紧到"仅所有者"（猜一个主体去授权等于把权限给错人）',
        actions,
      }
    }
    // 1) 断继承（把继承来的 ACE 转成显式拷贝，再移除继承）
    actions.push({ cmd: 'icacls', args: [file, '/inheritance:r'] })
    // 2) 授予所有者完全控制
    actions.push({ cmd: 'icacls', args: [file, '/grant:r', `${owner}:(F)`] })
    // 3) 保留系统必需主体（否则系统维护会做不了）
    for (const p of ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']) {
      actions.push({ cmd: 'icacls', args: [file, '/grant:r', `${p}:(F)`] })
    }
    for (const a of actions) {
      let res
      try {
        res = await run(a.cmd, a.args)
      } catch (e) {
        return { ok: false, code: ACL_CODES.HARDEN_FAILED, message: `${a.cmd} ${a.args.join(' ')} 执行失败：${e?.name ?? 'Error'}`, actions }
      }
      if (res?.status !== 0) {
        return { ok: false, code: ACL_CODES.HARDEN_FAILED, message: `${a.cmd} ${a.args.join(' ')} 返回 ${res?.status}`, actions }
      }
    }
    // 加固之后**重新验一遍**：只说"我设置过了"不算加固完成
    const after = await inspectFileAcl({ file, platform, run, owner })
    return {
      ok: after.ok,
      code: after.ok ? ACL_CODES.OK : after.code,
      message: after.ok ? '访问控制已收紧到仅所有者' : `加固后复验未通过：${after.message}`,
      actions,
      verified: after,
    }
  }

  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    actions.push({ cmd: 'chmod', args: ['600', file] })
    let res
    try {
      res = await run('chmod', ['600', file])
    } catch (e) {
      return { ok: false, code: ACL_CODES.HARDEN_FAILED, message: `chmod 执行失败：${e?.name ?? 'Error'}`, actions }
    }
    if (res?.status !== 0) {
      return { ok: false, code: ACL_CODES.HARDEN_FAILED, message: `chmod 600 返回 ${res?.status}`, actions }
    }
    const after = await inspectFileAcl({ file, platform, run, owner })
    return {
      ok: after.ok,
      code: after.ok ? ACL_CODES.OK : after.code,
      message: after.ok ? '权限已收紧到 600' : `加固后复验未通过：${after.message}`,
      actions,
      verified: after,
    }
  }

  return {
    ok: false, code: ACL_CODES.UNSUPPORTED_PLATFORM,
    message: `平台 ${platform} 的加固尚未实现`,
    actions,
  }
}
