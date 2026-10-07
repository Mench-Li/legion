// product/update/platform-build.mjs
// ============================================================================
// 本机 Windows 版本号（`minWindowsBuild` 那条判据的读数来源）
//
// ## 为什么需要这个模块（第四个"判据的输入没有生产方"）
//
// `release.mjs` 有一条判据：
//
//     else if (Number.isSafeInteger(minWindowsBuildRequired) && payload.minWindowsBuild > minWindowsBuildRequired) {
//       problems.push(... 'UNSUPPORTED_PLATFORM' ...)   // 「需要 Windows build N，本机是 M」
//     }
//
// 它由 `validateRelease(payload, { minWindowsBuildRequired })` 驱动，而**全仓
// 没有任何调用方传过这个参数**（`client.mjs` 只传 `expect`）。于是那条判据
// 在生产里**不可达**：一份声明 `minWindowsBuild: 22000`（只支持 Win11）的
// 发行，会在一台 19045（Win10 22H2）的机器上被接受并安装。
//
// 同一批里 `install.mjs` 把 `windowsBuild` 传给了 `runPreflight`，而
// `runPreflight` **从不读这个参数**——它是死参数。两处加起来的意思是：
// 操作系统的版本门禁**从来没有生效过**。
//
//   > 一个"从来不生效的门禁"与一个"没有这个门禁"，
//   > 在用户能观察到的行为上是同一个东西。
//
// ## 读数从哪来
//
// `os.release()` 在 Windows 上返回内核版本，形如 `10.0.19045`；
// 第三个分量就是 `minWindowsBuild` 用的那个 build 号（19045 = Win10 22H2，
// 22631 = Win11 23H2）。非 Windows 上它返回别的东西（如 `6.8.0-45-generic`），
// 而那些平台由 `platform` 字段另行排除，所以本模块只在 win32 上使用。
//
// ## 读不出来时**不放行**
//
// `parseWindowsBuild()` 解析不出来时返回 `null`，而调用方（`client.mjs`）
// 在 win32 上把 `null` 当成一次**明确的失败**，不是"跳过这条判据"。
// 理由与磁盘读数那条同源：一个"读不出本机版本就当作无所谓"的门禁，
// 会在最需要它的时候（异常环境、被改过的系统信息）静默打开。
// ============================================================================

export const PLATFORM_BUILD_CODES = Object.freeze({
  UNPARSEABLE: 'platform-build-unparseable',
  /** 本机 build 低于目标声明的下限。 */
  UNSUPPORTED: 'platform-build-unsupported',
})

/**
 * 从 `os.release()` 的字符串里取出 Windows build 号。
 *
 * 接受 `10.0.19045`、`10.0.22631.4890`（带 revision）这类形状。
 * 只取**第三个**分量：第一个是主版本（`10`），第二个是次版本（`0`），
 * 而 `minWindowsBuild` 的口径（19045/22000/22631）就是第三个。
 *
 * @returns {number|null} 解析不出来时 `null`（调用方必须把它当成"没读到"）
 */
export function parseWindowsBuild(release) {
  if (typeof release !== 'string') return null
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,6})(?:\.\d{1,8})?$/.exec(release.trim())
  if (match === null) return null
  const build = Number(match[3])
  // build 0 不是任何真实系统；一个"解析出来是 0"的结果会让
  // `minWindowsBuild > 0` 永远成立，从而把**每一台**机器都判成不支持。
  if (!Number.isSafeInteger(build) || build <= 0) return null
  return build
}

/**
 * 本机 Windows build，`null` 表示读不出来。
 *
 * `platform` 与 `release` 都可注入，所以这条判据能在任何平台上被测。
 */
export function currentWindowsBuild({
  platform = process.platform, release = null, osRelease = null,
} = {}) {
  if (platform !== 'win32') return null
  const raw = release ?? osRelease ?? safeOsRelease()
  return parseWindowsBuild(raw)
}

/**
 * 目标发行能不能装在**这台**机器上。
 *
 * ★ 返回值是**三态**，不是布尔：
 *
 *   · `{ ok: true, skipped: true }`   —— 判据不适用，且**说明了为什么**
 *   · `{ ok: true, skipped: false }`  —— 判据通过
 *   · `{ ok: false, code }`           —— 明确不支持，或**读不出本机版本**
 *
 * 第三种的第二种情形（读不出本机版本）是一条**失败**而不是跳过：见文件头。
 *
 * ## `hostPlatform` 与 `platform` 是两件事
 *
 *   · `platform`     —— 目标发行声明的平台（发行清单里的字段）
 *   · `hostPlatform` —— **正在跑这段代码的**机器
 *
 *   两者在真实部署里相同（客户端只更新它自己所在的机器），但在 CI 上不同：
 *   一个跑在 Linux 上的用例会声明 `platform: 'win32'` 来测 Windows 分支，
 *   而那时 `os.release()` 是 `6.8.0-45-generic` —— 把"读不出 Windows build"
 *   判成失败会让每一条这样的用例红。
 *
 *   所以判据的适用条件是 `hostPlatform === 'win32'`：我们只对**真正在
 *   Windows 上运行的**这一次更新回答"这台机器支不支持"。
 */
export function checkLocalWindowsBuild({
  hostPlatform = process.platform,
  platform = null,
  release = null, minWindowsBuild = null, osRelease = null,
} = {}) {
  // 目标没声明 win32 就不再往下问（`platform` 省略时以 host 为准）。
  const target = platform ?? hostPlatform
  if (target !== 'win32') {
    return Object.freeze({ ok: true, skipped: true, reason: `目标平台不是 win32（${target}）` })
  }
  if (hostPlatform !== 'win32') {
    return Object.freeze({
      ok: true, skipped: true,
      reason: `本机不是 Windows（${hostPlatform}），Windows 版本判据不适用于这次运行`,
    })
  }
  if (!Number.isSafeInteger(minWindowsBuild) || minWindowsBuild <= 0) {
    return Object.freeze({ ok: true, skipped: true, reason: '目标没有声明 minWindowsBuild' })
  }
  const local = currentWindowsBuild({ platform: hostPlatform, release, osRelease })
  if (local === null) {
    return Object.freeze({
      ok: false, code: PLATFORM_BUILD_CODES.UNPARSEABLE,
      reason: '读不出本机 Windows build，无法确认这个版本是否支持本机'
        + '（"读不出来"与"支持"是两件事）',
    })
  }
  if (minWindowsBuild > local) {
    return Object.freeze({
      ok: false, code: PLATFORM_BUILD_CODES.UNSUPPORTED,
      reason: `需要 Windows build ${minWindowsBuild}，本机是 ${local}`,
      minWindowsBuild, local,
    })
  }
  return Object.freeze({ ok: true, skipped: false, local, minWindowsBuild })
}

function safeOsRelease() {
  try {
    return globalThis.process?.getBuiltinModule?.('node:os')?.release?.() ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckPlatformBuild() {
  const problems = []

  // ① 真实形状。
  if (parseWindowsBuild('10.0.19045') !== 19045) problems.push('10.0.19045 没解析成 19045')
  if (parseWindowsBuild('10.0.22631.4890') !== 22631) problems.push('带 revision 的形状没解析对')
  if (parseWindowsBuild('  10.0.22000  ') !== 22000) problems.push('首尾空白没被容忍')

  // ② 解析不出来的必须返回 null（**不是** 0，也不抛）。
  const bad = [null, undefined, 42, '', '10.0', '10.0.', 'Windows 10', '10.0.0', '10.0.x',
    '6.8.0-45-generic', '10.0.19045.1.2.3']
  for (const value of bad) {
    const got = parseWindowsBuild(value)
    if (got !== null) problems.push(`parseWindowsBuild(${JSON.stringify(value)}) 返回了 ${got}，应当是 null`)
  }

  // ③ `currentWindowsBuild` 只在 win32 上有结论。
  if (currentWindowsBuild({ platform: 'linux' }) !== null) problems.push('非 win32 上求出了 build')
  if (currentWindowsBuild({ platform: 'darwin' }) !== null) problems.push('darwin 上求出了 build')
  if (currentWindowsBuild({ platform: 'win32', release: '10.0.19045' }) !== 19045) {
    problems.push('win32 上没有从注入的 release 求出版本')
  }

  // ④ 三态判据。
  const win = (overrides) => checkLocalWindowsBuild({ hostPlatform: 'win32', platform: 'win32', ...overrides })
  const newer = win({ release: '10.0.22631', minWindowsBuild: 19045 })
  if (newer.ok !== true || newer.skipped !== false) problems.push('比下限新的机器没有被判为通过')
  const older = win({ release: '10.0.19045', minWindowsBuild: 22000 })
  if (older.ok !== false) problems.push('比下限旧的机器被判为支持')
  if (!String(older.reason).includes('22000')) problems.push('不支持的文案没有说出需要哪个 build')
  if (!String(older.reason).includes('19045')) problems.push('不支持的文案没有说出本机是哪个 build')
  const exact = win({ release: '10.0.19045', minWindowsBuild: 19045 })
  if (exact.ok !== true) problems.push('恰好等于下限被判为不支持')
  // ★ 读不出本机版本 → **失败**，不是跳过。
  const unreadable = win({ release: 'weird', minWindowsBuild: 19045 })
  if (unreadable.ok !== false) problems.push('读不出本机版本时被判为通过（门禁静默打开）')
  // 目标没声明下限 → 跳过（并且**明确**标出 skipped）。
  const noFloor = win({ release: 'weird', minWindowsBuild: null })
  if (noFloor.ok !== true || noFloor.skipped !== true) problems.push('目标没有下限时没有明确跳过')
  // 非 win32 目标 → 跳过。
  const otherTarget = checkLocalWindowsBuild({ hostPlatform: 'win32', platform: 'linux', minWindowsBuild: 99999 })
  if (otherTarget.ok !== true || otherTarget.skipped !== true) problems.push('非 win32 目标时没有跳过')

  // ★ `hostPlatform` 与 `platform` 是两件事（CI 上跑 Linux 却测 win32 分支）。
  const crossHost = checkLocalWindowsBuild({ hostPlatform: 'linux', platform: 'win32', minWindowsBuild: 99999 })
  if (crossHost.ok !== true || crossHost.skipped !== true) {
    problems.push('在非 Windows 主机上测 win32 分支时判据没有跳过（会让每一条这样的用例红）')
  }
  if (!String(crossHost.reason).includes('linux')) problems.push('跨主机跳过的理由没有说明本机是什么')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    codes: PLATFORM_BUILD_CODES,
  })
}

export const PLATFORM_BUILD_CHECKED = selfCheckPlatformBuild()
