// product/update/modules.test.mjs
// ============================================================================
// 装载期自检的汇总回归
//
// 每个模块在装载时都会把自己那几条核心判据真的跑一遍，并把结论挂在
// `*_CHECKED` 上。这一条测试做的事很简单：**把它们全部读一遍，并要求
// 全部为 ok**。
//
// 为什么值得单独一条测试：这些自检的价值在于"有人放宽了某条拒绝时下一次
// 启动就暴露"。而如果没有人读那些结论，它们就只是一段启动时白跑的开销——
// 一个 `ok: false` 躺在那里，而 CI 全绿。
//
// 除此之外它还钉住两件事：
//   · 模块清单（文件集）不会在重构里被悄悄删掉；
//   · 每个模块**都能在普通 Node 里载入**（不依赖 Electron、不依赖网络）。
// ============================================================================

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const EXPECTED_MODULES = Object.freeze([
  'barrier', 'cache', 'canonical', 'client', 'closure', 'config', 'credential', 'envelope',
  'errors', 'extract', 'feed', 'health', 'helper', 'host', 'index', 'install', 'journal',
  'platform-build',
  // ★ `recovery`（设计 §8 line 190 的数据备份恢复入口）在这个表里是**必须**的：
  //   这张表守的是"每个模块都在，且都能在普通 Node 里载入"，
  //   而"新加了一个模块但没人知道"正是它要拦的事。
  'recovery',
  'release', 'schedule', 'semver', 'state', 'transport', 'zip',
])

/** 模块 → 它导出的自检结论名。 */
const CHECKED_EXPORTS = Object.freeze({
  canonical: 'CANONICAL_CHECKED',
  envelope: 'ENVELOPE_CHECKED',
  semver: 'SEMVER_CHECKED',
  release: 'RELEASE_CHECKED',
  feed: 'FEED_CHECKED',
  host: 'HOST_CHECKED',
  transport: 'TRANSPORT_CHECKED',
  schedule: 'SCHEDULE_CHECKED',
  cache: 'CACHE_CHECKED',
  state: 'STATE_CHECKED',
  config: 'CONFIG_CHECKED',
  errors: 'ERRORS_CHECKED',
  extract: 'EXTRACT_CHECKED',
  closure: 'CLOSURE_CHECKED',
  zip: 'ZIP_CHECKED',
  health: 'HEALTH_CHECKED',
  'platform-build': 'PLATFORM_BUILD_CHECKED',
  journal: 'JOURNAL_CHECKED',
  barrier: 'BARRIER_CHECKED',
  credential: 'CREDENTIAL_CHECKED',
  install: 'INSTALL_CHECKED',
  helper: 'HELPER_CHECKED',
  recovery: 'RECOVERY_CHECKED',
})

test('每个更新模块都在，且都能在普通 Node 里载入', async () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const present = readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => name.replace(/\.mjs$/, ''))
    .sort()
  assert.deepEqual(present, [...EXPECTED_MODULES],
    '更新模块文件集与预期不符（新增/删除模块时请同步这张表）')
  for (const name of EXPECTED_MODULES) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    assert.ok(mod !== null && mod !== undefined, `${name}.mjs 没有导出任何东西`)
  }
})

test('★ 所有装载期自检结论都是 ok', async () => {
  const failures = []
  for (const [name, exportName] of Object.entries(CHECKED_EXPORTS)) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    const checked = mod[exportName]
    assert.ok(checked !== undefined, `${name}.mjs 没有导出 ${exportName}`)
    if (checked.ok !== true) {
      failures.push(`${name}: ${(checked.problems ?? []).join('；') || '(没有给出问题列表)'}`)
    }
  }
  assert.deepEqual(failures, [], `装载期自检未通过：\n${failures.join('\n')}`)
})

test('★★★ selfCheckAll() 必须覆盖**每一个**有自检的模块（新增一层要同时进两处）', async () => {
  // ★ 这条是我自己漏过一次之后补的：加 `recovery.mjs` 时我把 `EXPECTED_MODULES`
  //   与 `CHECKED_EXPORTS` 都改了，**忘了**改 `index.mjs` 的 `selfCheckAll()`。
  //   于是那个汇总读了 22 层，而实际上有 23 个模块带自检——
  //   上面那条"结论都是 ok"照样全绿，因为**它读的不是同一张清单**。
  //
  //   > 一份"汇总"漏掉一项时，它不会报错——它会**少报一个数**。
  //   > 而少报的那一项，恰恰是刚加的那个。
  //
  //   为什么必须两处都有：`CHECKED_EXPORTS` 是**测试**清单（只有跑测试时才读），
  //   而 `selfCheckAll()` 是**运行时**汇总（`product/update/index.mjs` 导出它，
  //   给桌面端/诊断用）。两处漏一处的后果不同，所以两处都要，且必须相等。
  const mod = await import(new URL('./index.mjs', import.meta.url))
  const all = await mod.selfCheckAll()
  const inSummary = [...all.results.map((r) => r.layer)].sort()
  const expected = Object.keys(CHECKED_EXPORTS).sort()
  assert.deepEqual(inSummary, expected,
    'selfCheckAll() 覆盖的层与有自检的模块对不上。缺的那一层不会让任何用例变红，'
    + '只会让运行时汇总**少报一个数**：\n'
    + `  只在 CHECKED_EXPORTS 里：${expected.filter((x) => !inSummary.includes(x)).join(', ') || '(无)'}\n`
    + `  只在 selfCheckAll 里：${inSummary.filter((x) => !expected.includes(x)).join(', ') || '(无)'}`)
  // 顺带把它**逐层**读过：汇总说全绿，就要求每一层真的 ok。
  for (const layer of all.results) {
    assert.equal(layer.ok, true, `${layer.layer} 在汇总里不是 ok：${JSON.stringify(layer.problems)}`)
  }
})

test('自检结论本身是检查过的（不是恒真的占位）', async () => {
  // ★ 一条"永远返回 ok:true"的自检比没有自检更糟：它会让"有人放宽了某条
  //   拒绝"看起来已经通过。所以这里逐条要求自检**真的报出了一个读数**。
  const requirements = Object.freeze({
    canonical: (c) => c.vectorCount >= 4 && c.rejectedCount >= 10,
    envelope: (c) => c.rejectedCases >= 8,
    semver: (c) => c.differenceCount >= 1,
    release: (c) => c.rejectedCases >= 15,
    feed: (c) => c.rejectedCases >= 8,
    host: (c) => c.rejectedOriginsOrSample !== undefined || c.sample !== undefined,
    schedule: (c) => Array.isArray(c.sample.ladder) && c.sample.ladder.length === 3,
    state: (c) => c.sample.chainLength >= 11,
    install: (c) => c.steps.length >= 8,
    extract: (c) => c.executableExtensions >= 15,
    health: (c) => c.loopbackHosts.length >= 3,
    'platform-build': (c) => c.codes.UNSUPPORTED === 'platform-build-unsupported',
    closure: (c) => c.protocol === 'legion/update-closure@1',
    zip: (c) => c.methods.DEFLATE === 8,
  })
  for (const [name, predicate] of Object.entries(requirements)) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    // 模块名里的连字符要换成下划线：`platform-build` → `PLATFORM_BUILD_CHECKED`。
    // （不带这个替换时，带连字符的模块会被查成 `PLATFORM-BUILD_CHECKED`——
    // 一个永远 undefined 的读数，于是这条用例对那个模块**什么也没检查**。）
    const checked = mod[`${name.toUpperCase().replace(/-/g, '_')}_CHECKED`]
    assert.ok(predicate(checked), `${name} 的自检读数看起来是占位的：${JSON.stringify(checked?.sample ?? checked)}`)
  }
})

test('更新模块不导入 Electron、不发起网络请求', async () => {
  // `product/update/` 是纯逻辑层：它必须能在 Node、CI、以及 helper 的
  // 随包 Node 里跑。Electron 只出现在 `desktop/`。
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const { readFileSync } = await import('node:fs')
  for (const name of EXPECTED_MODULES) {
    const source = readFileSync(`${dir}${name}.mjs`, 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.equal(/from 'electron'|require\('electron'\)/.test(code), false, `${name}.mjs 导入了 Electron`)
  }
})

// ---------------------------------------------------------------------------
// ★★★ 没有任何生产代码**关闭 TLS 证书校验**
// ---------------------------------------------------------------------------

/**
 * 被检查的目录：不只是 `product/update`，而是**整个更新链路**。
 *
 * ★ 为什么要把 `desktop/` 与 `scripts/update/` 也算进来：这条纪律最可能被
 *   破坏的地方**不是**协议层，而是**排查现场**——有人在真机上遇到证书问题时，
 *   最快的"修法"就是加一句关闭校验的代码或环境变量。而那句话一旦提交，
 *   它就同时关掉了所有人的校验。
 */
const TLS_SCAN_DIRS = Object.freeze(['product/update', 'product/launcher', 'desktop', 'scripts/update'])

/**
 * 找出**关闭证书校验**的写法。
 *
 * 依据是本目标第二份文档（`2026-10-04-update-host-bootstrap.md`）最后一段的原话：
 *
 * > HTTP 测试不授权正式更新；正式环境必须使用可信 HTTPS。
 * > **没有域名时不把自签证书或关闭证书验证作为正式方案。**
 *
 * ★ 这是一条**否定式**的判据——"没有任何地方这么做"。否定式的判据最容易
 *   退化成空话（比如扫错目录、或正则写得太窄于是永远匹配不上），
 *   所以下面第 ③ 组探针**先证明它抓得到**：拿几段真实的错误写法喂进去，
 *   要求每一个都被认出来。**没有这一组，这条用例的绿什么也不说明。**
 *
 * ★ 为什么不用"扫全仓"：`node_modules` 与测试替身里会有合法的出现
 *   （例如用例故意构造一个 `rejectUnauthorized: false` 来验证**别的**判据）。
 *   这条判据问的是"**我们自己的生产代码**有没有这么做"。
 */
const TLS_OFF_PATTERNS = Object.freeze([
  // Node 的显式关闭（https.request 选项 / fetch 的 dispatcher 选项）。
  { name: 'rejectUnauthorized: false', re: /rejectUnauthorized\s*:\s*false/ },
  { name: 'NODE_TLS_REJECT_UNAUTHORIZED 被赋值', re: /\bNODE_TLS_REJECT_UNAUTHORIZED\b\s*[:=]\s*['"]?0/ },
  { name: 'process.env.NODE_TLS_REJECT_UNAUTHORIZED 赋值', re: /process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=/ },
  { name: 'checkServerIdentity 被替换成放行', re: /checkServerIdentity\s*:\s*(\(\)\s*=>|function\s*\(\s*\)\s*\{?\s*\}?\s*$)/ },
  { name: 'strictSSL: false', re: /strictSSL\s*:\s*false/ },
  { name: 'Agent({ rejectUnauthorized: false })', re: /new\s+(https\.)?Agent\s*\(\s*\{[^}]*rejectUnauthorized\s*:\s*false/ },
  // ★ `NODE_EXTRA_CA_CERTS` 只在**被设置**时算（赋值 / export / 放进 env 对象）。
  //
  //   ⚠️ 第一版把它写成 `/NODE_EXTRA_CA_CERTS/`（只要出现就算），于是真仓里
  //   `product/launcher/allowlist.mjs` 立刻报红——而那一处是**白名单里的一项
  //   字符串**（决定哪些操作系统环境变量透传给子进程），不是"我们把校验指到
  //   自签证书上"。那个文件自己的注释写着这些键"应当被审阅而不是被继承"，
  //   说明它们是**被审阅过的**透传项。
  //
  //   > 一条"只要提到这个词就算违规"的规则，会把**讨论这件事的地方**
  //   > 判成**做了这件事的地方**——而前者恰恰是我们最希望存在的。
  //
  //   所以规则收窄到"设置"形态（`X = ...` / `X: ...` / `export X`）。
  //   ★ 收窄必须配一条**新的**正对照（见下面的 mustBeCaught），
  //     否则"收窄"与"为了让它变绿而把它删掉"在读数上是一样的。
  { name: 'NODE_EXTRA_CA_CERTS 被赋值', re: /NODE_EXTRA_CA_CERTS\s*[:=]|export\s+NODE_EXTRA_CA_CERTS/ },
])

/** 去掉注释再匹配：注释里**提到**这些写法是允许的（尤其本文件的说明）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function findTlsVerificationOff(readFile, listDir) {
  const findings = []
  const walk = (relDir) => {
    for (const entry of listDir(relDir)) {
      const relPath = `${relDir}/${entry.name}`
      if (entry.isDirectory()) { walk(relPath); continue }
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs') && !entry.name.endsWith('.js')) continue
      // 用例文件不算"生产代码"：它们可以（也必须）构造这些写法来验证别的判据。
      if (/\.test\.mjs$/.test(entry.name) || /\.testkit\.mjs$/.test(entry.name)) continue
      const code = stripComments(readFile(relPath))
      for (const pattern of TLS_OFF_PATTERNS) {
        if (pattern.re.test(code)) findings.push(Object.freeze({ file: relPath, pattern: pattern.name }))
      }
    }
  }
  for (const dir of TLS_SCAN_DIRS) walk(dir)
  return findings
}

test('★★★ 没有任何生产代码关闭 TLS 证书校验（否定式判据，先用探针证明它抓得到）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))

  // ── ① 定义本身就是对的（否则后面全是空话）──
  assert.ok(TLS_OFF_PATTERNS.length >= 6, 'TLS_OFF_PATTERNS 太短，这条判据的覆盖面可疑')

  // ── ② ★ 正对照：每一段**真实**的错误写法都必须被抓到 ──
  //
  //   ★★ 这一组是这条用例的**全部价值所在**。一条"扫描没发现任何东西"的判据，
  //      与一条"正则写错了所以永远匹配不上"的判据，读数完全一样。
  const mustBeCaught = [
    'const opts = { rejectUnauthorized: false }',
    'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"',
    'export NODE_TLS_REJECT_UNAUTHORIZED=0',
    'https.request(url, { checkServerIdentity: () => undefined })',
    'const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })',
    'agent = new Agent({ rejectUnauthorized: false })',
    'strictSSL: false',
    // ★ 收窄 `NODE_EXTRA_CA_CERTS` 之后**新加**的这一条：证明"设置"形态仍然被抓到。
    //   没有它，那次收窄就与"把这条规则删掉"无法区分。
    'process.env.NODE_EXTRA_CA_CERTS = "/etc/legion/self-signed.pem"',
    'env: { NODE_EXTRA_CA_CERTS: caPath }',
  ]
  for (const code of mustBeCaught) {
    const caught = TLS_OFF_PATTERNS.some((p) => p.re.test(code))
    assert.equal(caught, true, `这段关闭校验的写法没有被任何一条规则抓到（这条判据是瞎的）：${code}`)
  }

  // ── ③ 反对照：**合法的**写法不许被误报（否则有人会为了让 CI 变绿而删掉正确代码）──
  const mustNotBeCaught = [
    "import { request } from 'node:https'",
    'rejectUnauthorized: true',
    "origin: 'https://updates.example.com'",
    "const insecure = entry.allowInsecureHttp === true",   // http 只用于测试的显式开关
    'checkServerIdentity: (host, cert) => tls.checkServerIdentity(host, cert)',
    // ★ 真仓里 `product/launcher/allowlist.mjs` 的那一处：它是**白名单里的
    //   一项字符串**（哪些环境变量透传给子进程），不是"设置校验"。
    "'NODE_OPTIONS', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS',",
  ]
  for (const code of mustNotBeCaught) {
    const caught = TLS_OFF_PATTERNS.some((p) => p.re.test(code))
    assert.equal(caught, false, `合法写法被误报成"关闭校验"：${code}`)
  }

  // ── ③b ★ 把真仓里那一处**明写出来**，并断言它属于"白名单"而不是"设置" ──
  //
  //   ★ 这一段的用途：下一个读到这里的人不该只看到"规则被我收窄了"，
  //     而该看到**收窄是为了哪一处、那一处凭什么不算**。一条被悄悄收窄的规则
  //     与一条被悄悄删掉的规则，在"它今天还拦得住什么"上是同一个东西。
  {
    const allowlist = readFileSync(`${root}product/launcher/allowlist.mjs`, 'utf8')
    assert.match(allowlist, /NODE_EXTRA_CA_CERTS/,
      'allowlist.mjs 里已经没有 NODE_EXTRA_CA_CERTS 了——那么上面那条反对照应当重新审视')
    const allowlistCode = stripComments(allowlist)
    assert.equal(TLS_OFF_PATTERNS.some((p) => p.re.test(allowlistCode)), false,
      'allowlist.mjs 现在命中了"关闭校验"的规则（它从"透传白名单"变成了"设置校验"？）')
    // 它在那里是一个**带引号的字符串**（一份名字清单里的一项），
    // 而不是一次赋值的目标。这就是它不算"设置校验"的机械理由。
    assert.match(allowlistCode, /['"]NODE_EXTRA_CA_CERTS['"]/,
      'NODE_EXTRA_CA_CERTS 在 allowlist.mjs 里不再是一个带引号的字符串了——'
      + '那说明它从"白名单里的一项"变成了别的形态，请重新判定它算不算"关闭校验"')
    assert.match(allowlistCode, /OS_ESSENTIAL_ENV\s*=\s*Object\.freeze\(\[[\s\S]*?NODE_EXTRA_CA_CERTS/,
      'NODE_EXTRA_CA_CERTS 不再位于 OS_ESSENTIAL_ENV 这张白名单里了')
  }

  // ── ④ 注释里的**说明**不算（本模块的注释里就写着那些反例）──
  assert.equal(
    /rejectUnauthorized\s*:\s*false/.test(stripComments('// 不要写 rejectUnauthorized: false')),
    false, '去掉注释之后仍然匹配到了注释里的写法',
  )

  // ── ⑤ 真仓：一条都不许有 ──
  const findings = findTlsVerificationOff(
    (rel) => readFileSync(`${root}${rel}`, 'utf8'),
    (rel) => readdirSync(`${root}${rel}`, { withFileTypes: true }),
  )
  assert.deepEqual(findings, [],
    `更新链路上有关闭 TLS 校验的代码：${JSON.stringify(findings, null, 1)}\n`
    + '依据：更新托管部署计划最后一段「没有域名时不把自签证书或关闭证书验证作为正式方案」。'
    + '正式环境必须用可信 HTTPS；本地/测试需要绕开时，用 `allowInsecureHttp`（只对 internal 通道有效）。')
})

// ---------------------------------------------------------------------------
// ★★★ 每个**声明**的错误码都必须有**发出点**
// ---------------------------------------------------------------------------

/** 被扫描的目录：更新与升级两层（设计 §5–§9 的实现都在这里）。 */
const CODE_SCAN_DIRS = Object.freeze(['product/update', 'product/upgrade', 'product/launcher'])

/**
 * 扫出"声明了却从来不会被返回"的错误码。
 *
 * 判据（对表 `X_CODES` 里的项 `NAME`）：在**非用例**的 `.mjs` 里出现过
 * `X_CODES.NAME`（表定义本身写的是 `NAME: '字面量'`，所以任何 `X_CODES.NAME`
 * 都是**使用**），或者那个字面量出现在定义文件**之外**。
 *
 * 为什么这条判据值得单独存在：
 *
 *   `transport.mjs` 里有一段注释记着上一个同类缺陷——
 *   `BAD_HEADERS: 'net-bad-headers'`，**从来没有被任何分支返回过**。
 *   当时的结论是：
 *
 *   > 声明了却不发出的错误码，与一条不存在的判据是同一回事：
 *   > 读代码的人会以为"响应头有问题"这个情形被处理了。
 *
 *   ★ 而同一个缺陷在**隔壁的** `host.mjs` 里又躺了很久
 *     （`BAD_LENGTH: 'host-bad-length'`），另外还有十处散在七个文件里。
 *     一次机械扫描把它们全找了出来，每一处的判据其实都在——只是落在
 *     **别的形态**上（一个布尔字段、一个 `verdict` 字符串、另一个模块的码、
 *     或者干脆是 `code: null`）。所以每一处都是"删掉"，不是"补一条判据"。
 *
 *   > 教训在一个文件里学到了，而**隔壁那个文件**没有照做——
 *   > 这类不一致比一次孤立的手误更值得用一条机械判据钉住。
 */
function findDeclaredButNeverEmitted(readFile, listDir) {
  const files = []
  const collect = (dir) => {
    for (const entry of listDir(dir)) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) collect(rel)
      else if (entry.name.endsWith('.mjs')) files.push(rel)
    }
  }
  for (const dir of CODE_SCAN_DIRS) collect(dir)

  // ★★ 发出点只在**生产**文件里找，**不能**把用例算进去。
  //
  //   这一条是我自己撞出来的：第一版把用例也当成了"提到这个码"的证据，
  //   而本文件（`modules.test.mjs`）的注释里为了讲清这个缺陷，
  //   **原样写出**了 `BAD_LENGTH: 'host-bad-length'`。于是：
  //
  //     · 我把 host-bad-length 加回 `HOST_CODES` 做变异测试；
  //     · 守卫扫到"用例里提到过这个码" ⇒ 判定它有发出点 ⇒ **放行**。
  //
  //   也就是说**这条判据被它自己的说明文字弄瞎了**，而且只对它在注释里
  //   点名的那几个码失灵——正是它最该盯住的那几个。
  //
  //   > 一条判据的**解释**不能让这条判据失效；
  //   > 而"证据从哪来"这件事，比"判据怎么写"更容易出错。
  //
  //   原理上也站得住：**用例不可能"发出"一个错误码**——它只能断言。
  //   所以把用例排除掉不是绕过误报，是把判据的定义改对。
  const prod = files.filter((f) => !f.endsWith('.test.mjs'))
  const text = new Map(files.map((f) => [f, readFile(f)]))

  const dead = []
  for (const file of prod) {
    const src = text.get(file)
    const tableRe = /export const ([A-Z][A-Z0-9_]*CODES)\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/g
    let table
    while ((table = tableRe.exec(src)) !== null) {
      const tableName = table[1]
      const defStart = table.index
      const defEnd = table.index + table[0].length
      for (const item of table[2].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*'([a-z0-9][a-z0-9-]{3,})'/gm)) {
        const [, name, code] = item
        let used = false
        // 只在**生产**文件里找证据（见上面那段注释）。
        for (const other of prod) {
          const otherText = text.get(other)
          const hits = [...otherText.matchAll(new RegExp(`\\b${tableName}\\.${name}\\b`, 'g'))]
          if (hits.some((h) => !(other === file && h.index > defStart && h.index < defEnd))) { used = true; break }
          if (other !== file && (otherText.includes(`'${code}'`) || otherText.includes(`"${code}"`))) { used = true; break }
        }
        if (!used) dead.push(`${file} :: ${tableName}.${name} = ${code}`)
      }
    }
  }
  return dead
}

test('★★★ 每个声明的错误码都必须有发出点（"声明了却不发出"与"判据不存在"是一回事）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const dead = findDeclaredButNeverEmitted(
    (rel) => readFileSync(`${root}${rel}`, 'utf8'),
    (rel) => readdirSync(`${root}${rel}`, { withFileTypes: true }),
  )
  assert.deepEqual(dead, [],
    '这些错误码被声明了，但**没有任何分支会返回它们**。读代码的人会以为那个情形被处理了，'
    + '所以要么补上发出点，要么把这个码删掉：\n' + dead.join('\n'))
})

// ---------------------------------------------------------------------------
// ★★★ 生产代码里提到的 `*.test.mjs` 必须**真的存在**
// ---------------------------------------------------------------------------

/**
 * 找出"注释里承诺的证据文件不存在"的地方。
 *
 * ★ 这个形状是本次会话里最贵的一次发现：`transport.mjs` 的自检写着
 *   「网络行为的证据在 `transport.test.mjs` 里」，而**那个文件从来没有被写出来**。
 *   于是那个模块只有"常量等于设计数字"这一层证据，而补上缺失的用例之后
 *   **当场暴露了一个生产缺陷**（流式限长超限时的 `this.#onTrip()?.()` 会去调用
 *   一个 `AbortSignal`，把 `NET_TOO_LARGE` 顶成 `net-offline`）。
 *
 *   同一次扫描还发现第二处：`extract.mjs` 写着
 *   「两条常量各自声明，`closure.test.mjs` 有一条断言要求它们相等——一旦有人改了
 *   一边，契约就红」——而 `closure.test.mjs` 也不存在，那两条
 *   `MAX_CLOSURE_BYTES` 当时**只靠人工保持一致**。
 *
 *   > 一句"这个契约由某条判据守着"，与那条判据，
 *   > 在"契约会不会漂移"上不是同一个东西——
 *   > 而前者的代价比没有这句话更高：它让人**不去检查**。
 *
 *   判据就是上面那句话的机械形式：**提到就必须存在**。
 *   解析两种写法（与本文件其余地方一致）：相对提及者所在目录、相对仓库根。
 */
function findDanglingTestRefs(readFile, listDir, exists, basenameExists) {
  const findings = []
  const testRef = /([A-Za-z0-9_./-]+\.test\.mjs)/g
  const walk = (relDir) => {
    for (const entry of listDir(relDir)) {
      const relPath = `${relDir}/${entry.name}`
      if (entry.isDirectory()) { walk(relPath); continue }
      if (!entry.name.endsWith('.mjs') || /\.test\.mjs$/.test(entry.name) || /\.testkit\.mjs$/.test(entry.name)) continue
      let text
      try { text = readFile(relPath) } catch { continue }
      const dir = relPath.slice(0, relPath.lastIndexOf('/'))
      for (const match of text.matchAll(testRef)) {
        const ref = match[1]
        const candidates = [ref.startsWith('./') ? `${dir}/${ref.slice(2)}` : null,
          `${dir}/${ref}`, ref].filter((c) => c !== null)
        if (candidates.some((c) => exists(c))) continue
        // ★ 第三档：**按文件名**在整仓找一次。
        //
        //   实测有两处是"用文件名简称"的合法写法（`shell-files.test.mjs` 在
        //   `desktop/scripts/` 下、`patch-loadable.test.mjs` 在
        //   `runtime/dsh-composition/` 下）。这条判据要拦的是"这个文件
        //   **哪儿都没有**"——那才是"这句承诺是假的"。
        //
        //   > 把"简称"判成"悬空"，会让这条判据在第一次运行时就被人关掉；
        //   > 而它真正要拦的那一处（`closure.test.mjs`，全仓不存在）
        //   > 会跟着一起被放过。
        if (basenameExists(ref.slice(ref.lastIndexOf('/') + 1))) continue
        findings.push(Object.freeze({ file: relPath, ref, tried: Object.freeze(candidates) }))
      }
    }
  }
  for (const dir of TLS_SCAN_DIRS) walk(dir)
  return findings
}

test('★★★★ 生产代码里提到的 `*.test.mjs` 必须真的存在（证据的地址不能指向空处）', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))

  // ── ① ★ 正对照：这个判据必须抓得到"指向不存在的文件" ──
  //
  //   一条"扫描没发现任何东西"的判据，与一条"解析写错了所以永远匹配不上"的
  //   判据，读数完全一样。所以先喂它一个假的目录树。
  {
    const fakeFiles = {
      'product/update/fake.mjs': '// 证据在 fake-missing.test.mjs 里\n',
      'product/update/present.test.mjs': '// 存在\n',
    }
    const fakeList = (dir) => {
      const prefix = `${dir}/`
      const names = new Set()
      for (const p of Object.keys(fakeFiles)) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
          names.add(p.slice(prefix.length))
        }
      }
      return [...names].map((name) => ({ name, isDirectory: () => false }))
    }
    const found = findDanglingTestRefs(
      (rel) => fakeFiles[rel],
      fakeList,
      (rel) => fakeFiles[rel] !== undefined,
      // ★ 正对照里 basename 兜底必须**也是假的树**：否则它会去真实仓库里
      //   找到 `present.test.mjs`（真仓恰好有这么个文件？没有，但别的名字有），
      //   于是"抓不到悬空"的失败会被掩盖。
      () => false,
    )
    const dangling = found.filter((f) => f.file === 'product/update/fake.mjs')
    assert.equal(dangling.length, 1, `正对照失败（这个判据抓不到悬空引用）：${JSON.stringify(found)}`)
    assert.equal(dangling[0].ref, 'fake-missing.test.mjs')
  }

  // ── ② 反对照：指向**存在**的文件不许报（含"用文件名简称"的合法写法）──
  {
    const fakeFiles = {
      'product/update/fake.mjs': '// 证据在 present.test.mjs 里，另一处在 other.test.mjs 里\n',
      'product/update/present.test.mjs': '// 存在\n',
      'some/where/else/other.test.mjs': '// 在别处（简称写法）\n',
    }
    const basenames = new Set(Object.keys(fakeFiles).map((p) => p.slice(p.lastIndexOf('/') + 1)))
    const found = findDanglingTestRefs(
      (rel) => fakeFiles[rel],
      (dir) => Object.keys(fakeFiles)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => ({ name: p.slice(dir.length + 1), isDirectory: () => false })),
      (rel) => fakeFiles[rel] !== undefined,
      (name) => basenames.has(name),
    )
    assert.deepEqual(found, [], `反对照失败（存在的文件被报成悬空）：${JSON.stringify(found)}`)
  }

  // ── ③ 真仓：一处都不许有 ──
  //
  //   basename 索引从 `git ls-files` 取（整仓，含 product/、desktop/、runtime/…），
  //   这样"用文件名简称"的合法写法不会被误报。
  const { execFileSync } = await import('node:child_process')
  const allTracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const trackedBasenames = new Set(allTracked.map((p) => p.slice(p.lastIndexOf('/') + 1)))
  const findings = findDanglingTestRefs(
    (rel) => readFileSync(`${root}${rel}`, 'utf8'),
    (rel) => readdirSync(`${root}${rel}`, { withFileTypes: true }),
    (rel) => existsSync(`${root}${rel}`),
    (name) => trackedBasenames.has(name),
  )
  assert.deepEqual(findings, [],
    '生产代码里提到了不存在的用例文件（那句"由某条判据守着"是假的）：\n'
    + findings.map((f) => `  ${f.file} → ${f.ref}（试过：${f.tried.join(' / ')}）`).join('\n'))
})


// ---------------------------------------------------------------------------
// ★★★★ 仓库里**不许有**签名私钥（设计 §9 line 202）
// ---------------------------------------------------------------------------

/**
 * PEM 私钥头的形状。每一种都要列出来——只查一种会漏掉别的编码。
 *
 * ★★ 这些字符串**必须拼出来**，不能整段写成字面量。
 *
 *   第一版我写了字面量数组，于是这条判据**扫到了它自己**：
 *   `modules.test.mjs` 是已跟踪文件，而它里面正好有那些字面量。
 *
 *   > 一条按文本扫描全仓的判据，只要**它自己**含有被扫描的字符串，
 *   > 它就永远报一个假阳性——而那个假阳性会让人把整条判据关掉。
 *
 *   （这与 ㊵/㊹ 同一个手法：那两次是"**注释**里写了被扫描的字面量"，
 *     这次是"**清单**里写了被扫描的字面量"。）
 */
const PEM_BEGIN = ['-----', 'BEGIN '].join('')
const PEM_END = '-----'
/**
 * ★★ 结束标记的前缀是 `-----END `，**不是** `-----BEGIN `。
 *
 *   第一版我把结束标记写成 `PEM_BEGIN + 'END ' + kind + PEM_END`，
 *   于是它是 `-----BEGIN END PRIVATE KEY-----`——一个**永远匹配不上**的字符串。
 *   后果是扫描**静默地什么都不返回**，而"什么都没找到"与"没有泄漏"
 *   在读数上完全一样。
 *
 *   > 抓到它的是那条**正对照**（喂一把真私钥、要求必须被抓到）。
 *   > 没有正对照，这条判据会以"全绿"的形式**从未运行过**。
 */
const PEM_END_BEGIN = ['-----', 'END '].join('')
const PRIVATE_KEY_KINDS = Object.freeze([
  'PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'DSA PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
  'PGP PRIVATE KEY BLOCK',
])

/** 把一段文本里的每个 PEM 私钥块取出来（按 kind 逐个找，含 END 配对）。 */
function pemBlocksOf(text, kind) {
  const begin = PEM_BEGIN + kind + PEM_END
  const end = PEM_END_BEGIN + kind + PEM_END
  const blocks = []
  let cursor = 0
  for (;;) {
    const from = text.indexOf(begin, cursor)
    if (from < 0) break
    const to = text.indexOf(end, from)
    if (to < 0) break
    blocks.push(text.slice(from, to + end.length))
    cursor = to + end.length
  }
  return blocks
}

/**
 * 在**已跟踪**的文件里找**真的**签名私钥。
 *
 * ★★★ 判据是"**能不能被解析成一把真私钥**"，不是"有没有那个头"。
 *
 *   我第一版的判据是后者，而它在真仓里立刻红了——命中的是 **redaction 的
 *   用例夹具**：`product/diagnostics/redact-package.test.mjs` 与
 *   `runtime/context/redaction.test.mjs` **故意**含有 PEM 私钥头，用来验证
 *   日志与诊断会把它们打码；那些头是**哑的**（`createPrivateKey` 解析不了）。
 *
 *   > "含有私钥头"与"含有一把私钥"不是同一个读数——
 *   > 前者在一份专门测"打码"的夹具里**必须**为真。
 *
 *   如果当时按第一版把判据"修绿"（比如删掉那些夹具），代价是**打码的判据
 *   失去输入**——用一个安全判据去换另一个安全判据，两边都变弱。
 *
 * ★ 用 `git grep` 先筛（一次子进程，只扫跟踪的文件——未跟踪的东西不进历史，
 *   而这条判据问的正是"历史里有没有"），再对命中的少数文件做解析。
 */
function findLeakedPrivateKeys(root, exec, readFile, createPrivateKey) {
  const candidates = new Set()
  for (const kind of PRIVATE_KEY_KINDS) {
    let out = ''
    try {
      out = exec('git', ['grep', '-l', '-F', '-e', PEM_BEGIN + kind + PEM_END],
        { cwd: root, encoding: 'utf8' })
    } catch (error) {
      // `git grep` 无命中时退出码是 1（不是错误）。其余退出码要抛出去。
      if (error?.status === 1) continue
      throw error
    }
    for (const file of out.split('\n').map((s) => s.trim()).filter(Boolean)) candidates.add(file)
  }
  const findings = []
  for (const file of [...candidates].sort()) {
    let text = ''
    try { text = readFile(root + file) } catch { continue }
    for (const kind of PRIVATE_KEY_KINDS) {
      for (const pem of pemBlocksOf(text, kind)) {
        try {
          createPrivateKey(pem)
          findings.push(Object.freeze({ file, kind }))
        } catch {
          // 解析不了 ⇒ 哑夹具。**不是**违规。
        }
      }
    }
  }
  return Object.freeze({ findings: Object.freeze(findings), scanned: candidates.size })
}

test('★★★★ 仓库里没有任何**能解析成真私钥**的 PEM（设计 §9 line 202）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync: read, mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { createPrivateKey } = await import('node:crypto')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const readText = (p) => read(p, 'utf8')

  // ── ① 规则本身：七种头都在，而公钥不在其中 ──
  assert.ok(PRIVATE_KEY_KINDS.length >= 7, '私钥头的清单太短，覆盖面可疑')
  assert.equal(PRIVATE_KEY_KINDS.some((k) => k.includes('PUBLIC KEY')), false,
    '公钥混进了私钥清单——那会把随包分发的公钥判成违规')

  // ── ② ★★★ 正对照：一把**真的**私钥必须被抓到 ──
  //
  //   用 `envelope.mjs` 生成一对真的（与发布端同一套函数），所以这条正对照
  //   证明的是"我们能抓到**本仓会产出的那种**私钥"，而不是某个我编的字符串。
  {
    const { generateReleaseKeyPair } = await import('./envelope.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'legion-key-leak-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      const pair = generateReleaseKeyPair({ keyId: 'leak-check' })
      writeFileSync(join(dir, 'release.key.pem'), pair.privateKeyPem, 'utf8')
      writeFileSync(join(dir, 'release.pub.pem'), pair.publicKeyPem, 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      const result = findLeakedPrivateKeys(dir + '/', execFileSync, readText, createPrivateKey)
      assert.equal(result.findings.length, 1,
        '正对照失败：一把真私钥没有被抓到 → ' + JSON.stringify(result))
      assert.equal(result.findings[0].file, 'release.key.pem')
      // ★ 而公钥**不许**被报（它要随包分发）。
      assert.equal(result.findings.some((f) => f.file === 'release.pub.pem'), false,
        '公钥被误报成私钥')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── ③ ★★ 反对照：**哑的** PEM（redaction 夹具那种）不许被报 ──
  //
  //   这一条是这条判据能存在的前提：本仓**真的**有这种文件，而且它们必须在。
  //   没有这一条，下一个人看到真仓红了就会去删那些夹具。
  {
    const dir = mkdtempSync(join(tmpdir(), 'legion-key-dummy-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      const dummy = PEM_BEGIN + 'PRIVATE KEY' + PEM_END + '\nMIIEvQIBADANBgkq\n'
        + PEM_BEGIN + 'END PRIVATE KEY' + PEM_END + '\n'
      writeFileSync(join(dir, 'fixture.test.mjs'), 'const sample = ' + JSON.stringify(dummy) + '\n', 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      const result = findLeakedPrivateKeys(dir + '/', execFileSync, readText, createPrivateKey)
      assert.deepEqual([...result.findings], [],
        '哑夹具被误报成真私钥 → ' + JSON.stringify(result.findings))
      // 而它确实**被扫到了**（否则这条反对照只是"扫描没跑"）。
      assert.equal(result.scanned, 1, '反对照里连候选文件都没扫到——那这条反对照没有分辨力')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── ④ 真仓：一把真的都不许有 ──
  const result = findLeakedPrivateKeys(root, execFileSync, readText, createPrivateKey)
  assert.deepEqual([...result.findings], [],
    '仓库的已跟踪文件里有**能解析成真私钥**的 PEM（设计 §9 line 202 要求它留在发布机或 CI 密钥存储）：\n'
    + result.findings.map((f) => '  ' + f.file + '（' + f.kind + '）').join('\n')
    + '\n★ 私钥进历史之后，删文件不够——唯一的补救是**吊销那把钥匙**。')

  // ── ⑤ `.gitignore` 必须挡在**生成**那一侧（第一道防线） ──
  //
  //   `keygen.mjs new` 的 `--out` **默认是 `.`**（仓库根），所以这条规则拦的
  //   正是"在仓库里生成私钥、然后 `git add -A`"这个组合。
  const gitignore = read(root + '.gitignore', 'utf8')
  assert.match(gitignore, /^\*\.key\.pem\s*$/m,
    '`.gitignore` 里没有 `*.key.pem` —— 而 `keygen.mjs new` 的默认输出目录就是仓库根')
})

// ---------------------------------------------------------------------------
// ★★★★ 调用方引用的调度器方法必须**真的存在**
// ---------------------------------------------------------------------------

/**
 * ★★★ 把注释与字符串**挖空**，只留下可执行代码（长度与换行保持不变）。
 *
 *   这条辅助函数是被自己的判据逼出来的：两条新判据最初都**抓到了自己**——
 *   它们扫描的文件里，注释正引用着被删掉的那句代码：
 *
 *     · \`client.mjs\` 的解释性注释里写着 \`scheduler.run('periodic')\`；
 *     · \`update-service.mjs\` 的解释性注释里写着 \`client.check({ trigger: 'manual' })\`。
 *
 *   > 一条"不许出现某个调用"的文本判据，只要**它要扫的文件里的注释**
 *   > 提到过那个调用，它就永远报红——而那个红会让人把判据关掉，
 *   > 或者（更坏）把解释删掉：**把知识删掉去换一个绿**。
 *
 *   这与 ㊵/㊹/㊿ 是同一个坑的第三种形态：那三次是"判据自己的源码里有被扫的
 *   字面量"，这次是"**被扫文件的注释**里有"。共同点：**文本判据必须区分
 *   '代码里出现'与'注释里提到'**。
 *
 *   ★ 挖空而不是丢弃：偏移量与换行都保留，这样报错时的行号还有意义。
 *   ★ 字符串字面量也一起挖空：正则/模板里出现 \`scheduler.run(\` 同样不算引用。
 */
function codeOnly(text) {
  const out = text.split('')
  const blank = (from, to) => { for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ' }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      let j = i
      while (j < text.length && text[j] !== '\n') j += 1
      blank(i, j); i = j; continue
    }
    if (ch === '/' && next === '*') {
      let j = i + 2
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1
      blank(i, Math.min(j + 2, text.length)); i = j + 2; continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === ch) { j += 1; break }
        j += 1
      }
      // 引号本身保留（对"是不是某类字面量"的判据没影响），内容挖空。
      blank(i + 1, j - 1 <= i ? i + 1 : j - 1)
      i = j; continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * 找出"引用了调度器上不存在的方法"的地方。
 *
 * ★★★ 这条判据的来历是一个**一调就炸**的公开方法：
 *
 *     // product/update/client.mjs（已删除）
 *     runScheduledCheck: () => scheduler.run('periodic'),
 *
 *   而调度器的公开面是
 *   `snapshot / markInteractive / manual / notifyResume / retry / stop /
 *    suspend / reschedule` —— **没有 `run`**（`run` 是模块内的局部函数，
 *   只由计时器回调与 `manual()`/`retry()`/`notifyResume()` 调用）。
 *
 *   于是 `client.runScheduledCheck()` 抛 `TypeError`。它之所以一直没被发现，
 *   是因为**全仓没有任何生产调用者**——定时检查由调度器自己的计时器驱动。
 *   两个缺陷叠在一起互相掩护：
 *
 *     · 没有调用者 ⇒ 那个 TypeError 从来没出现过；
 *     · 那个方法"看起来能用" ⇒ 下一个人想"立刻检查一次"时会去用它。
 *
 *   > 一个"一调就炸、而没人调"的公开方法，比没有这个方法更坏：
 *   > 它把下一个人引到一条死路上，而他会把 TypeError 当成别处坏了。
 *
 *   这条判据把"引用"与"实际表面"接起来：**按文本找出 `scheduler.<name>(`
 *   的每一处，逐个在真实的调度器实例上查有没有这个键**。
 *   用真实实例而不是读源码，是因为"公开面"是**运行时**的事实。
 */
function findMissingSchedulerMethods({ text, surface }) {
  const findings = []
  // ★ 先挖空注释与字符串：否则**解释性注释里那句被删掉的代码**会把这条判据钉死。
  const code = codeOnly(text)
  for (const match of code.matchAll(/\bscheduler\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (!surface.has(name)) findings.push(name)
  }
  return [...new Set(findings)].sort()
}

test('★★★★ 引用的调度器方法必须真的存在（`scheduler.run` 那次是怎么来的）', async () => {
  const { readFileSync } = await import('node:fs')
  const { createCheckScheduler } = await import('./schedule.mjs')
  const root = fileURLToPath(new URL('../../', import.meta.url))

  // 造一个**真实的**调度器，读它的公开面。
  const probe = createCheckScheduler({
    runCheck: async () => ({ outcome: 'up-to-date' }),
    now: () => 0, random: () => 0.5,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  })
  const surface = new Set(Object.keys(probe))
  probe.stop()
  // ── ① 基本事实：`run` 不在表面上（这条缺陷的根）──
  assert.equal(surface.has('run'), false,
    '调度器竟然公开了 run —— 那么当初 runScheduledCheck 并不是"一调就炸"，这条注释要改')
  assert.ok(surface.has('manual') && surface.has('retry'),
    `调度器缺少手动/重试入口：${[...surface].join(', ')}`)

  // ── ①′ ★ `codeOnly` 本身的对照：注释与字符串要被挖空，代码不许被挖空 ──
  //
  //   这是**判据的判据**：一个把所有东西都挖空的 `codeOnly`，会让上面
  //   两条判据永远绿——而那与"没有缺陷"读数一样。
  {
    const sample = [
      "// scheduler.run('x')  ← 注释里的，不算",
      "/* scheduler.stop() ← 块注释里的，不算 */",
      "const s = 'scheduler.retry()'  // 字符串里的，不算",
      "scheduler.manual()   // ← 这一处是**代码**，必须留下",
    ].join('\n')
    const masked = codeOnly(sample)
    // 注释/字符串里的三处都被挖空：
    assert.equal(/scheduler\.run\s*\(/.test(masked), false, '注释里的引用没有被挖空')
    assert.equal(/scheduler\.stop\s*\(/.test(masked), false, '块注释里的引用没有被挖空')
    assert.equal(/scheduler\.retry\s*\(/.test(masked), false, '字符串里的引用没有被挖空')
    // 而真正的代码必须留下：
    assert.equal(/scheduler\.manual\s*\(/.test(masked), true,
      'codeOnly 把真代码也挖空了 —— 那两条判据会永远绿')
    // 换行数不变（报错行号才有意义）：
    assert.equal(masked.split('\n').length, sample.split('\n').length, 'codeOnly 改变了行数')
  }

  // ── ② ★ 正对照：一段引用了不存在方法的文本必须被抓到 ──
  //
  //   一条"扫描没发现任何东西"的判据，与一条"正则写错了所以永远匹配不上"
  //   的判据，读数完全一样。
  {
    const fake = "const x = () => scheduler.run('periodic')\n"
      + "const y = () => scheduler.snapshot()\n"
    const found = findMissingSchedulerMethods({ text: fake, surface })
    assert.deepEqual(found, ['run'], `正对照失败：${JSON.stringify(found)}`)
  }

  // ── ③ 真仓：调用 `scheduler.*` 的每一处都要对得上 ──
  const scanned = []
  for (const rel of ['product/update/client.mjs', 'desktop/update-wiring.mjs',
    'desktop/update-service.mjs', 'desktop/main.mjs']) {
    let text
    try { text = readFileSync(`${root}${rel}`, 'utf8') } catch { continue }
    scanned.push(rel)
    assert.deepEqual(findMissingSchedulerMethods({ text, surface }), [],
      `${rel} 引用了调度器上不存在的方法（一调就炸）：`
      + findMissingSchedulerMethods({ text, surface }).join('、'))
  }
  // ★ 读数：至少扫到一个文件——否则"没有发现问题"只是"没扫"。
  assert.ok(scanned.length >= 1, '一个文件都没扫到')
})

test('★★★★ 桌面端的"检查更新"必须走 `manualCheck`，不能直接调低层 `check`', async () => {
  // ★ 设计 §6 line 134 那一句的两个分句必须落在**同一个**入口上：
  //
  //   > 手动检查立即执行，并与已有检查共享一次网络请求。……
  //   > **成功恢复正常周期**。
  //
  //   `client.check()` 只满足前一个（它不碰调度器的账本）。所以服务层
  //   一旦直接调它，"成功恢复正常周期"就静默失效——而界面上看不出来
  //   （按钮照样能点、照样显示"当前已是最新版本"）。
  //
  //   这条判据是**文本**判据，而不是行为判据，因为它要守的正是
  //   "调用点用了哪个入口"这件事；行为那一半由 `client.test.mjs` 的两条
  //   用例守着（一条证明 `manualCheck` 复位、一条证明低层 `check` 不复位）。
  const { readFileSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const text = readFileSync(`${root}desktop/update-service.mjs`, 'utf8')

  // ── 正对照：这段"直接调 check"的文本必须被抓到 ──
  {
    const fake = "return { result: await client.check({ trigger: 'manual' }) }\n"
    assert.match(fake, /\bclient\.check\s*\(/, '正对照的正则匹配不上，这条判据是空跑的')
  }

  // ★ 同样先挖空注释：这条判据的解释里正引用着那句被修掉的调用。
  const code = codeOnly(text)
  const direct = [...code.matchAll(/\bclient\.check\s*\(/g)]
  assert.deepEqual(direct, [],
    '桌面端直接调了低层 client.check()：手动检查必须走 client.manualCheck()，'
    + '否则退避不会复位（设计 §6 line 134「成功恢复正常周期」）')

  // ── 而 `manualCheck` 必须真的被调到（否则"没调低层"只是因为"没调任何东西"）──
  assert.match(code, /\bclient\.manualCheck\s*\(/,
    '桌面端没有调用 client.manualCheck() —— 那么上面那条"没调低层 check"是空过的')
})

// ---------------------------------------------------------------------------
// ★★★★ 引用的**输入文档**必须在树里（否则那句"依据原话"无法复核）
// ---------------------------------------------------------------------------

/**
 * 找出"引用了本仓不存在的**日期命名文档**"的地方。
 *
 * ★★★ 这条判据的来历：本目标有两份输入文档，其中
 *   `2026-10-04-update-host-bootstrap.md` **连主仓都没有跟踪**（它是未跟踪的
 *   工作区文件），而本分支有 **5 个已跟踪文件**引用它——包括
 *   `modules.test.mjs` 里那条 TLS 判据的理由：
 *
 *   > 依据是本目标第二份文档（`2026-10-04-update-host-bootstrap.md`）最后一段的原话：
 *   > 「没有域名时不把自签证书或关闭证书验证作为正式方案。」
 *
 *   于是"这句原话"在分支里**找不到出处**。这与 ㊼/㊽ 是同一个族的第三个层次：
 *
 *     | # | 悬空的是什么 |
 *     |---|---|
 *     | ㊼ | 证据的地址（`transport.test.mjs`） |
 *     | ㊽ | 承诺的判据（`closure.test.mjs`） |
 *     | 这里 | 依据的**文档本身** |
 *
 *   > 一个"依据某文档原话"的判据，如果那份文档不在树里，
 *   > 复核它的人只能选择相信作者——而那正是判据本来要避免的事。
 *
 * ## 为什么只查**日期命名**的 .md
 *
 * 实测：全仓还有十几个"缺失的 .md 引用"，但它们是**测试夹具**刻意用的名字
 * （`b.md`、`nope.md`、`poison.md`、`secret.md`、`FAKE-generated.md`…）——
 * 它们**必须**不存在。一条"所有 .md 都要在"的判据会被这些假阳性淹没，
 * 然后被人关掉。
 *
 * 而 `2026-10-04-….md` 这种**日期前缀**是真实文档的构造方式：本仓的计划与
 * 设计文档全部这样命名，没有一个是夹具。所以这条判据只查日期命名的那一类——
 * **窄，但真**。
 */
function findMissingDatedDocs({ files, existsInRepo }) {
  const findings = []
  const dated = /\b(\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+\.md)\b/g
  for (const [rel, text] of Object.entries(files)) {
    for (const match of text.matchAll(dated)) {
      const ref = match[1]
      if (!existsInRepo(ref)) findings.push(Object.freeze({ file: rel, ref }))
    }
  }
  return findings
}

test('★★★★ 引用的日期命名文档必须真的在树里（`update-host-bootstrap.md` 那次）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))

  // ── ① ★ 正对照：引用一个不存在的日期文档必须被抓到 ──
  //
  //   ★★ 这个文件名**必须拼出来**，不能写成整字面量。
  //
  //     第一版我写的是字面量，于是这条判据**抓到了它自己**：
  //     `modules.test.mjs` 是它要扫的文件之一，而那个字面量就在里面。
  //     症状是"真仓里发现一个不存在的日期文档"，而报出来的文件名正是
  //     我刚编的那个——同一轮里第**四**次踩这个形状。
  //
  //     ★ 为什么这里**不能**用 `codeOnly()`（第 53 条那个助手）：
  //       那条助手是把**注释**挖空，而这条判据要扫的引用**恰恰住在注释里**
  //       （"依据某文档原话"就是一句注释）。挖空注释 = 把这条判据变成空跑。
  //
  //       > 同一个坑，两条判据要用**相反**的解法：
  //       > 一条要挖空注释（引用在代码里），一条要**拼出字面量**（引用在注释里）。
  //       > 照抄上一条的修法，会把这一条修成永远绿。
  {
    const noSuchDoc = ['2026', '01', '01-no-such-plan.md'].join('-')
    const fake = { 'x.mjs': `// 依据 ${noSuchDoc} 的原话\n` }
    const found = findMissingDatedDocs({
      files: fake,
      existsInRepo: () => false,
    })
    assert.equal(found.length, 1, `正对照失败：${JSON.stringify(found)}`)
    assert.equal(found[0].ref, noSuchDoc)
  }

  // ── ② 反对照：**夹具式的名字**不许被报（它们必须不存在）──
  {
    const fake = {
      'x.mjs': 'const names = ["b.md", "nope.md", "poison.md", "FAKE-generated.md"]\n'
        + `// 依据 ${['2026-10-02-legion-desktop-auto-update-design.md'].join('')}\n`,
    }
    const found = findMissingDatedDocs({
      files: fake,
      existsInRepo: (ref) => ref === '2026-10-02-legion-desktop-auto-update-design.md',
    })
    assert.deepEqual([...found], [],
      `反对照失败：夹具名被误报 → ${JSON.stringify(found)}`)
  }

  // ── ③ 真仓：扫本功能的代码与实施记录 ──
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const trackedSet = new Set(tracked)
  const basenames = new Set(tracked.map((p) => p.slice(p.lastIndexOf('/') + 1)))

  const scan = [
    'product/update/client.mjs', 'product/update/modules.test.mjs',
    'product/update/envelope.mjs', 'product/update/transport.mjs',
    'scripts/update/host-config.mjs', 'scripts/update/publish.mjs',
    'docs/superpowers/plans/2026-10-04-auto-update-implementation.md',
  ]
  const files = {}
  for (const rel of scan) {
    try { files[rel] = readFileSync(`${root}${rel}`, 'utf8') } catch { /* 不在就跳过 */ }
  }
  // ★ 读数：至少读到一条，否则"没问题"只是"没读"。
  assert.ok(Object.keys(files).length >= 5,
    `只读到 ${Object.keys(files).length} 个文件，这条判据几乎没扫东西`)

  const findings = findMissingDatedDocs({
    files,
    // 日期文档按**文件名**判定（引用里通常只写文件名，路径随文档移动而变）。
    existsInRepo: (ref) => trackedSet.has(ref) || basenames.has(ref),
  })
  assert.deepEqual([...findings], [],
    '引用了树里不存在的日期命名文档（那句"依据原话"无法复核）：\n'
    + findings.map((f) => `  ${f.file} → ${f.ref}`).join('\n'))

  // ── ④ ★ 而那句被引用的原话必须**真的能读到**（不只是文件在）──
  //
  //   ★ 这一半是必要的：文件在、但里面没有那句话，与文件不在，对复核者
  //     是同一件事。所以直接去读那一句。
  const doc = readFileSync(`${root}docs/superpowers/plans/2026-10-04-update-host-bootstrap.md`, 'utf8')
  assert.match(doc, /没有域名时不把自签证书或关闭证书验证作为正式方案/,
    'bootstrap 文档在树里，但 `modules.test.mjs` 引用的那句原话不在里面')
  assert.match(doc, /正式环境必须使用可信 HTTPS/,
    'bootstrap 文档缺少"正式环境必须使用可信 HTTPS"那一句')
})

// ---------------------------------------------------------------------------
// ★★★★ 「可交互」标记必须是工厂造出来的，而且装载完成之后要**补投**
// ---------------------------------------------------------------------------

test('★★★★ `desktop/main.mjs` 的可交互标记必须走工厂，且运行时装载后要补投', async () => {
  // ★★ 这条守的是那个**竞态**修法的两半，缺一不可：
  //
  //   · **走工厂**（`createInteractiveMarker`）：保证"投递失败不消费标记"。
  //     一个裸布尔量会在 `updateRuntime` 还是 `null` 时被空操作消费掉。
  //   · **装载后补投**：兜住"窗口先到"那个顺序——那一次标记没投成，
  //     运行时好了之后必须有**第二次**投递机会。
  //
  //   > 只改一半都能通过"看起来对"的检查：只走工厂而不补投，
  //   > 窗口先到那条路径下标记仍然永远不会被投递；
  //   > 只补投而不走工厂，补投那一次会被"已消费"的标记直接 return 掉。
  const { readFileSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const text = readFileSync(`${root}desktop/main.mjs`, 'utf8')
  // ★ 先挖空注释：`main.mjs` 里那段解释**故意**引用了旧写法，
  //   不挖空的话这条判据会被自己的文档钉死（本会话第五次遇到这个形状）。
  const code = codeOnly(text)

  // ── ① ★ 正对照：旧写法必须被这条判据抓到 ──
  //
  //   把旧实现喂进来。注意这里用的是**字符串拼接**而不是整字面量：
  //   若写成整字面量，`modules.test.mjs` 自己（它也在扫描范围内吗？不在，
  //   但保持与前面几次一致的习惯）会成为假阳性来源。
  {
    const legacy = [
      'let ' + 'updateMarks' + 'Interactive = false',
      'function markUpdateInteractive() {',
      '  if (' + 'updateMarks' + 'Interactive) return',
      '  ' + 'updateMarks' + 'Interactive = true',
      '}',
    ].join('\n')
    const legacyCode = codeOnly(legacy)
    assert.equal(/updateMarksInteractive/.test(legacyCode), true,
      '正对照失败：旧写法的标记名没有被认出来（这条判据的判据写错了）')
    // 而它**没有**走工厂：
    assert.equal(/createInteractiveMarker\s*\(/.test(legacyCode), false)
  }

  // ── ② 走工厂：一个裸布尔量都不许剩 ──
  assert.match(code, /createInteractiveMarker\s*\(/,
    'desktop/main.mjs 没有用 createInteractiveMarker —— 一次性标记会在运行时'
    + '还是 null 时被空操作消费掉，于是自动检查永远不开始')

  // ── ③ 装载完成之后必须**补投**一次 ──
  //
  //   判据落在 `startUpdateRuntime` 的函数体里：在 `ok !== true` 的早退**之后**，
  //   必须出现一次标记调用。
  const startAt = code.indexOf('function startUpdateRuntime()')
  assert.ok(startAt >= 0, '找不到 startUpdateRuntime')
  // 取到下一个顶层 function 之前（够用：这个函数体不长）。
  const afterStart = code.slice(startAt)
  const nextFn = afterStart.indexOf('\nfunction ', 1)
  const body = nextFn > 0 ? afterStart.slice(0, nextFn) : afterStart
  const okGuard = body.indexOf('updateRuntime.ok !== true')
  assert.ok(okGuard >= 0, 'startUpdateRuntime 里找不到 `updateRuntime.ok !== true` 早退')
  const remark = body.indexOf('markUpdateInteractive()', okGuard)
  assert.ok(remark > okGuard,
    '运行时装载完成之后没有补投"可交互"标记 —— 于是"窗口先到"那个顺序下'
    + '首次自动检查永远不会被安排（而那恰好是打包版的行为）')
})

// ---------------------------------------------------------------------------
// ★★★★ 生产入口**不许**把 helper 的真实现覆盖成 `null`
// ---------------------------------------------------------------------------

/**
 * 从一个 `buildEffects()` 风格的函数体里取出它**显式写了**的键与值。
 *
 * 只认 `key: value` 这种字面写法——那正是打包入口的写法
 * （`{ createMigrationStore: null, unpack: null }`）。取不出来时返回空表，
 * 而判据那边会因此报"没读到任何键"，不会静默通过。
 */
function explicitEffectKeys(source) {
  const start = source.indexOf('function buildEffects()')
  if (start < 0) return null
  const end = source.indexOf('\n}', start)
  const body = end < 0 ? source.slice(start) : source.slice(start, end)
  const out = new Map()
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([^,\n]+),?\s*$/gm)) {
    out.set(m[1], m[2].trim())
  }
  return out
}

test('★★★★ `desktop/helper-entry.mjs` 不许把 helper 的真实现覆盖成 `null`', async () => {
  // ★★★ 这条守的是一次**真实的生产故障**（本轮修掉的那一个）：
  //
  //     // desktop/helper-entry.mjs（旧）
  //     function buildEffects() {
  //       return { createMigrationStore: null, unpack: null }   // ← 覆盖了真实现
  //     }
  //
  //   而 `product/update/helper.mjs` 里 `DEFAULT_EFFECTS.unpack` 就是**真的**
  //   解压实现，合并又是 `{ ...DEFAULT_EFFECTS, ...effects }`
  //   ⇒ 那个 `null` 把它盖掉 ⇒ 解压被静默跳过 ⇒ **每一次真实升级都回滚**。
  //
  //   而所有用例照样全绿：`install.test.mjs` 的 `helperEffects()` 给每个用例
  //   注入了一个**假的** unpack，于是"生产传 null"这条路径从来没有被跑过。
  //
  //   > "测试全绿"与"生产能跑"之间，隔着的是**测试有没有用生产的那份 effects**。
  //
  //   判据的形状是结构性的，而不是文本性的：拿**真实的** `DEFAULT_EFFECTS`
  //   逐个比——"某个键的默认是函数，而入口把它写成了 `null`"就是实现丢失。
  const { readFileSync } = await import('node:fs')
  // ★ `DEFAULT_EFFECTS` 由本模块**导出**（见 `helper.mjs` 里那段注释）：
  //   这条判据要拿**真实的**默认表逐个比，而不是读源码文本——
  //   文本判据看不见"某个默认后来被改成了 null"。
  const { DEFAULT_EFFECTS } = await import('./helper.mjs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const source = readFileSync(`${root}desktop/helper-entry.mjs`, 'utf8')
  const written = explicitEffectKeys(source)

  // ── ① 必须读得到那个函数（否则下面全是空过）──
  assert.notEqual(written, null, 'helper-entry.mjs 里找不到 buildEffects()')
  assert.ok(written.size >= 1,
    'buildEffects() 里一个显式键都没读到 —— 判据的解析可能写错了（这就是一次空过）')

  // ── ② ★ `DEFAULT_EFFECTS` 里是**函数**的键，不许被写成 `null` ──
  const functionKeys = Object.entries(DEFAULT_EFFECTS)
    .filter(([, value]) => typeof value === 'function')
    .map(([key]) => key)
  assert.ok(functionKeys.includes('unpack'),
    `DEFAULT_EFFECTS.unpack 不再是函数了（现在是 ${typeof DEFAULT_EFFECTS.unpack}）——`
    + '那么"默认实现是真的"这句话要重新审：这条判据的前提变了')

  const nulled = []
  for (const key of functionKeys) {
    if (written.get(key) === 'null') nulled.push(key)
  }
  assert.deepEqual(nulled, [],
    'helper-entry.mjs 把有真实默认实现的注入点写成了 null：\n'
    + nulled.map((k) => `  ${k}（DEFAULT_EFFECTS.${k} 是一个函数）`).join('\n')
    + '\n★ 合并是 `{ ...DEFAULT_EFFECTS, ...effects }`，写 null 会**覆盖**真实现。'
    + '\n  要"不注入"，正确做法是**这个键根本不出现**。')

  // ── ③ 正对照：一段"把真实现写成 null"的源码必须被这条判据抓到 ──
  //
  //   ★ 没有这一组，一个"解析写错所以永远读到空表"的实现会让上面两条**都通过**。
  {
    const badSource = 'function buildEffects() {\n'
      + '  return {\n'
      + '    createMigrationStore: null,\n'
      + '    unpack: null,\n'
      + '  }\n'
      + '}\n'
    const parsed = explicitEffectKeys(badSource)
    assert.notEqual(parsed, null, '正对照：连假源码都解析不出来')
    assert.equal(parsed.get('unpack'), 'null', `正对照：解析出的 unpack 值是 ${parsed.get('unpack')}`)
    const caught = functionKeys.filter((k) => parsed.get(k) === 'null')
    assert.ok(caught.includes('unpack'),
      '正对照失败：把 unpack 写成 null 的源码没有被这条判据抓到')
  }

  // ── ④ 反对照：**不写**那个键（正确做法）不许被报 ──
  {
    const goodSource = 'function buildEffects() {\n'
      + '  return {\n'
      + '    createMigrationStore: null,\n'
      + '  }\n'
      + '}\n'
    const parsed = explicitEffectKeys(goodSource)
    const caught = functionKeys.filter((k) => parsed.get(k) === 'null')
    assert.deepEqual(caught, [], `反对照失败：不写 unpack 被误报 → ${JSON.stringify(caught)}`)
  }
})

// ---------------------------------------------------------------------------
// ★★★★ 生产调用点传的键，必须**真的被那个函数的签名接受**
// ---------------------------------------------------------------------------

/**
 * 从 `export (async )?function NAME({` 的参数表里取出**顶层参数名**。
 *
 * 只认"恰好 baseIndent 空格缩进"的行，于是嵌套的解构（更深的缩进）不会被算进来。
 * `param = default` 与简写 `param,` 都算。
 */
function signatureParams(source, functionName, baseIndent) {
  const anchor = source.indexOf('function ' + functionName + '({')
  if (anchor < 0) return null
  const end = source.indexOf('} = {}', anchor)
  if (end < 0) return null
  const out = new Set()
  const re = new RegExp('^ {' + baseIndent + '}([A-Za-z_$][\\w$]*)\\s*(?::|,|=|$)')
  for (const line of source.slice(anchor, end).split('\n')) {
    const m = re.exec(line)
    if (m !== null) out.add(m[1])
  }
  return out
}

/**
 * 从一个对象字面量的源码里取出**顶层键**（含简写键）。
 *
 * 用花括号配对切块，而不是"找下一个 `})`"——后者在含嵌套对象时会**提前截断**，
 * 于是更深层的键会被误当成顶层键（我第一版就是这么错的：把 `paths` 里的
 * `installDir` 也算了进来，于是差集里多出一串假阳性）。
 */
function topLevelKeys(source, startIndex, baseIndent) {
  const braceStart = source.indexOf('{', startIndex)
  if (braceStart < 0) return null
  let depth = 0
  let end = -1
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  const block = source.slice(braceStart, end + 1)
  const out = new Map()
  const re = new RegExp('^ {' + baseIndent + '}([A-Za-z_$][\\w$]*)\\s*(?::|,|$)')
  for (const line of block.split('\n')) {
    const m = re.exec(line)
    if (m !== null) out.set(m[1], line.trim())
  }
  return out
}

test('★★★★ 生产安装调用点不许传"签名不接受的键"（静默忽略 = 看起来配置了）', async () => {
  // ★★ 这条判据抓到的是一类**很安静的**缺陷：调用点传了一个键，而那个函数
  //    从来不读它。传的人以为配置生效了，读的人以为那个行为被设置了。
  //
  //    实测抓到两个（都在同一次调用里）：
  //
  //      · `requireSignature: false` —— 读起来就是"生产安装不要求验签"。
  //        它**没有任何效果**：`runInstallTransaction` 不接这个参数，
  //        而真正决定要不要验签的是它内部的
  //        `requireSignature: publicKeyPem !== null`。
  //        ★ 幸运的是方向安全（验签并没有被关掉）——但"看起来关掉了"
  //        本身就会让下一个人**不去检查验签到底有没有生效**。
  //
  //      · `signal` —— 从 `client.install(..., { signal })` 一路透传到
  //        `installer.install({ signal })` 再到这个调用点，而
  //        `runInstallTransaction` **一个字节都没读它**。
  //        它读起来是"这一次安装可以被取消"。
  //
  //    > 一个传了但没人读的选项，与一个声明了但不发出的错误码，
  //    > 是同一种病：它让读者以为那件事被处理了。
  const { readFileSync: read } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const install = read(`${root}product/update/install.mjs`, 'utf8').replace(/\r/g, '')
  const wiring = read(`${root}desktop/update-wiring.mjs`, 'utf8').replace(/\r/g, '')

  // ── ① 解析器本身要有分辨力 ──
  const accepted = signatureParams(install, 'runInstallTransaction', 2)
  assert.notEqual(accepted, null, '解析不出 runInstallTransaction 的签名')
  assert.ok(accepted.size >= 20, `只解析出 ${accepted.size} 个参数，明显偏少——解析器写错了`)
  assert.ok(accepted.has('paths') && accepted.has('release') && accepted.has('spawnHelper'),
    `签名解析结果不对：${[...accepted].sort().join(', ')}`)

  // ── ② ★ 正对照：一段"传了签名不要的键"的源码必须被抓到 ──
  {
    const fakeAccepted = new Set(['paths', 'release'])
    const fakeSource = 'return runInstallTransaction({\n'
      + '        paths: {},\n'
      + '        release,\n'
      + '        requireSignature: false,\n'
      + '      })\n'
    const keys = topLevelKeys(fakeSource, fakeSource.indexOf('runInstallTransaction('), 8)
    assert.notEqual(keys, null, '正对照：连假源码都解析不出来')
    const bad = [...keys.keys()].filter((k) => !fakeAccepted.has(k))
    assert.deepEqual(bad, ['requireSignature'], `正对照失败：${JSON.stringify([...keys.keys()])}`)
  }

  // ── ③ 反对照：嵌套对象里的键**不许**被当成顶层键 ──
  {
    const fakeAccepted = new Set(['paths'])
    const nested = 'return runInstallTransaction({\n'
      + '        paths: {\n'
      + '          installDir: x,\n'
      + '          dataDir: y,\n'
      + '        },\n'
      + '      })\n'
    const keys = topLevelKeys(nested, nested.indexOf('runInstallTransaction('), 8)
    assert.deepEqual([...keys.keys()], ['paths'],
      `反对照失败：嵌套键被误报 → ${JSON.stringify([...keys.keys()])}`)
  }

  // ── ④ 真仓 ──
  const at = wiring.indexOf('return runInstallTransaction(')
  assert.ok(at > 0, '在 update-wiring.mjs 里找不到安装事务的调用点')
  const passed = topLevelKeys(wiring, at, 8)
  assert.notEqual(passed, null, '解析不出调用点传的对象')
  assert.ok(passed.size >= 10, `调用点只解析出 ${passed.size} 个顶层键，明显偏少`)

  const unknown = [...passed.keys()].filter((k) => !accepted.has(k)).sort()
  assert.deepEqual(unknown, [],
    '生产安装调用点传了 runInstallTransaction **不接受**的键（会被静默忽略）：\n'
    + unknown.map((k) => `  ${k}   →   ${passed.get(k)}`).join('\n')
    + '\n★ 一个传了但没人读的选项，会让读者以为那个行为被配置了。'
    + '\n  要么接上它，要么删掉它——不要让它留在那里。')
})

test('★★ 安装事务**不可取消**：不要再往这条调用链上传 signal', async () => {
  // ★ 上一条判据删掉了两个死参数。这一条把"为什么 `signal` 不该回来"
  //   写成判据，免得下一个人又顺手加上。
  //
  //   设计 §7 line 150 对"等任务超时"的答案是「回到可选择界面，**不默认强杀**」。
  //   而一个已经写下 journal intent 的安装事务**不能在中间被放弃**：
  //   中止它留下的是一份"做了一半且没人继续"的现场。
  //   那一步的可选性来自**开始之前的用户确认**与 `drainInFlight` 的超时，
  //   不是来自一个 AbortSignal。
  const { readFileSync: read } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const wiring = read(`${root}desktop/update-wiring.mjs`, 'utf8').replace(/\r/g, '')

  // 正对照：旧写法必须被认出来。
  {
    const legacy = '      }).then((result) => {\n        void signal\n'
    assert.match(legacy, /void signal/, '正对照的正则匹配不上，这条判据是空跑的')
  }

  const at = wiring.indexOf('return runInstallTransaction(')
  const keys = topLevelKeys(wiring, at, 8)
  assert.equal(keys.has('signal'), false,
    '安装调用点又传了 signal —— runInstallTransaction 不读它，它只让读者以为安装可取消')
  assert.equal(keys.has('requireSignature'), false,
    '安装调用点又传了 requireSignature —— 真正决定验签的是函数内部的 publicKeyPem')
})
