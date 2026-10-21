// runtime/adapters/dsh/provider-readiness.mjs
// ============================================================================
// 本机「哪个 Agent 运行时**真的**能用」的探测面。
//
// ## 为什么需要它（我们踩过的那次）
//
// 工作流面板原来让用户手填一个「本地执行服务 注册名」，提示语是
// 「填写 ctx.subagents 中的 provider 名称」——而界面上**没有任何地方能查到它**，
// 且发布时必填。用户的原话是「相当茫然，完全不知道怎么配置」。
//
// 更根本的问题是：**已注册 ≠ 可用**。DSH 把 provider 注册上了，不代表这台机器上
// 它真能跑起来 —— 外部 CLI 可能没装（或不在子进程 PATH 上）、可能没登录、
// 可能连不上供应商端点。而先前的心跳只上报 `providerNames` + 能力位
// （outputSchema / toolFilter / cancellation / permissionMode），
// 那些是**声明**，不是**读数**：
//
//   > 一句"我注册了 codex"，与一句"我这台机器上的 codex 现在能跑"，
//   > 在**它真能跑**的时候是同一个读数 ——
//   > 区别只在它跑不起来的那些机器上，而那时界面显示的是"就绪"。
//
// 同形态的事故在别处已有记录：`agent-network`（Apache-2.0）的 #622 里，
// 21 个「主机 × runtime」格子有 15 个会失败，而它的「可建节点 ✓」对它们全部打勾。
//
// ## 四条纪律（照抄那些踩过坑的项目，理由都是实测出来的）
//
//   ① **只看存在性，永不读取凭据内容**。登录文件只看在不在；env 变量只看**名字**在不在。
//      唯一例外是 CLI `--version` 的输出，且只从中抠 `x.y.z`，其余一律丢弃。
//   ② **绝不阻塞心跳**。探测在后台跑，调用方读缓存（见 `createReadinessCache`）。
//      每一步有超时，每个 provider 有总截止时间 —— **超了就报 unknown，不猜**。
//   ③ **不把几种"不知道"挤成同一个词**。`unprobed`（没有探测规格）与
//      `unknown`（探测超时/出错）是两个不同的事实，`missing_cli` 与
//      `not_logged_in` 的修法完全不同。合成一个 "not ready" 会让人修错方向。
//   ④ **输出里不出现机器路径**。`reason` 只写 `~/.codex/auth.json` 这类通用写法；
//      "哪台机器的哪个路径缺什么"本身就是一张地图。
// ============================================================================
import { join } from 'node:path'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { delimiter } from 'node:path'

/** 探测结论的取值。**每一个都要有独立的修法**，否则就该合并。 */
export const READINESS_STATE = Object.freeze({
  /** 现在就能用。 */
  READY: 'ready',
  /** 外部 CLI 不在（子进程真正拿到的）PATH 上。 */
  MISSING_CLI: 'missing_cli',
  /** CLI 在，但找不到登录态/凭据变量。 */
  NOT_LOGGED_IN: 'not_logged_in',
  /** 前两样都在，但供应商端点连不上。 */
  NO_NETWORK: 'no_network',
  /** **没有探测规格**：既不是已知外部 CLI，也不是内置 provider。已注册 ≠ 可用。 */
  UNPROBED: 'unprobed',
  /** 探测本身超时或抛错。**不猜**，如实说不知道。 */
  UNKNOWN: 'unknown',
})

export const STEP_TIMEOUT_MS = 4_000
export const PROVIDER_DEADLINE_MS = 12_000

// Node's global fetch does not automatically use the Windows user's WinINet proxy.
// Run the small HEAD probe through .NET's default proxy in an isolated PowerShell
// process instead of changing the DSH process-wide dispatcher.
const WINDOWS_SYSTEM_PROXY_HEAD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$client = $null',
  '$probeUrl = $null',
  '$request = $null',
  '$response = $null',
  'try {',
  '  $probeUrl = [Console]::In.ReadLine() | ConvertFrom-Json',
  "  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Net.Http')",
  '  $handler = [System.Net.Http.HttpClientHandler]::new()',
  '  $handler.UseProxy = $true',
  '  $handler.Proxy = [System.Net.WebRequest]::DefaultWebProxy',
  '  $client = [System.Net.Http.HttpClient]::new($handler)',
  '  $client.Timeout = [TimeSpan]::FromMilliseconds(3000)',
  '  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, [Uri]$probeUrl)',
  '  $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()',
  "  [Console]::Out.WriteLine('reachable')",
  '} catch {',
  "  [Console]::Out.WriteLine('unreachable')",
  '} finally {',
  '  if ($response) { $response.Dispose() }',
  '  if ($request) { $request.Dispose() }',
  '  if ($client) { $client.Dispose() }',
  '}',
].join('\n')
const WINDOWS_SYSTEM_PROXY_HEAD_COMMAND = Buffer.from(WINDOWS_SYSTEM_PROXY_HEAD_SCRIPT, 'utf16le').toString('base64')

const CLAUDE_LOGIN_HINT = '在这台机器上运行 `claude` 并执行 /login（会生成 ~/.claude/.credentials.json）'
const CLAUDE_API_HINT = '在 ~/.claude/settings.json 的 env 块里配 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN'
  + '（或 ANTHROPIC_API_KEY），也可以改用顶层 apiKeyHelper'
const CODEX_LOGIN_HINT = '在这台机器上运行 `codex login`（会生成 ~/.codex/auth.json）'

/** 凭据从哪来。**修法随它而变**，所以必须分开说。 */
export const AUTH_MODE = Object.freeze({
  /** 订阅态登录文件（`claude` 的 OAuth）/ 各家的 auth.json。 */
  SUBSCRIPTION: 'subscription',
  /** 从 CLI 自己的配置文件里读到的 API 凭据（Claude Code 的 `settings.json` env 块 / apiKeyHelper）。 */
  API_SETTINGS: 'api-settings',
  /** 从进程环境变量读到的 key。 */
  ENV: 'env',
  /** 什么都没找到。 */
  NONE: 'none',
  /** 该 runtime 不需要凭据。 */
  NOT_REQUIRED: 'not-required',
})

/**
 * provider 名 → 探测规格。**唯一来源**：新增一个外部运行时只改这里。
 *
 * `kind`：
 *   · `native`   —— 随 DSH 进程内运行，没有外部依赖 ⇒ 恒 ready（不是"没探测"）。
 *   · `external` —— 包着别人家的 CLI，需要装 + 登录 + 网络。
 *   不在此表里的名字 ⇒ `unprobed`，**不默认判 ready**。
 */
export const PROVIDER_SPECS = Object.freeze({
  // DSH 自带的进程内 provider（`plugins/src/index.ts` 的 `config.provider` 默认值）。
  spawn: Object.freeze({
    kind: 'native',
    reason: '随 Legion 守护进程内运行，不需要额外安装或登录',
  }),
  /**
   * `fork` —— DSH**另一个**自带的进程内后端（2026-10-13 实机补）。
   *
   * 实机读数是 `unprobed`（"没有探测规格"），而那是**低估**：它并不是什么来路不明的注册项。
   * 证据（都在 DSH 检出里）：
   *   · `packages/subagent/subagent-fork-in-process/src/index.ts:23`
   *     `export const name = 'subagent-fork-in-process'`；
   *   · 同文件 `:37` `providerName: z.string().default('fork')`
   *     ⇒ **这个 DSH 版本自己的默认 provider 就是 `fork`**；
   *   · 同文件 `:58` 注释写明它 "Supports `depthLimit` and `outputSchema`"
   *     —— 也就是说它连工作流那条**硬要求**（结构化输出）都满足。
   *
   *   > 把"我还没写规格"说成"已注册不等于可用"，
   *   > 与把"确实不可用"说成同一句话，在界面上是同一行字 ——
   *   > 而前者会让用户去排查一个本来就好用的东西。
   *
   * 所以它和 `spawn` 同类：进程内、无外部依赖 ⇒ 恒 ready。
   * （它支不支持结构化输出由**注册表**上报的 `declared` 决定，不是这里说了算。）
   */
  fork: Object.freeze({
    kind: 'native',
    reason: '随 DSH 进程内运行的 forked 子代理后端（DSH 自带的默认 provider），不需要额外安装或登录',
  }),
  'claude-code': Object.freeze({
    kind: 'external',
    cli: 'claude',
    authFiles: ['.claude/.credentials.json'],
    authEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    /**
     * ★★ 2026-10-13 实机修正：Claude Code **还有第二种凭据来源** —— 它自己的
     *   `settings.json`，很多人（包括本机用户）就是靠它走 **API 模式**的：
     *
     *     { "env": { "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_AUTH_TOKEN": "…" } }
     *
     *   只查 `.credentials.json`（订阅 OAuth）与进程环境变量，会把这套完全合法的配置
     *   判成 `not_logged_in`，并**建议人家去跑 `/login`** —— 那条建议是有害的：
     *   照做会把人家刻意配好的 API 模式顶掉。
     *
     *     > 一个"我没找到你的凭据"的结论，
     *     > 与一个"你没有凭据"的结论，在界面上是同一句话 ——
     *     > 而前者的正确下一步是**改我的检查**，不是改用户的机器。
     *
     *   我们只读**键名与是否非空**，绝不读取、绝不外传任何值。
     */
    settingsFiles: ['.claude/settings.json', '.claude/settings.local.json'],
    /** 自定义端点：配了它就该探**它**，而不是厂商默认地址（否则又是一次假阴性）。 */
    baseUrlEnvKeys: ['ANTHROPIC_BASE_URL'],
    endpoint: 'https://api.anthropic.com',
    installHint: 'npm i -g @anthropic-ai/claude-code，并确保它在这个守护能看到的 PATH 上',
    loginHint: CLAUDE_LOGIN_HINT,
    apiHint: CLAUDE_API_HINT,
  }),
  codex: Object.freeze({
    kind: 'external',
    cli: 'codex',
    authFiles: ['.codex/auth.json'],
    authEnvKeys: ['OPENAI_API_KEY'],
    endpoint: 'https://chatgpt.com',
    installHint: 'npm i -g @openai/codex，并确保它在这个守护能看到的 PATH 上',
    loginHint: CODEX_LOGIN_HINT,
  }),
})

/** 该 provider 有没有探测规格（没有 ⇒ unprobed，判据不默认给 ready）。 */
export function hasReadinessSpec(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_SPECS, name)
}

/**
 * 真正要探测的名字 = **注册表里的** ∪ **规格表里已知的**。
 *
 * ## 为什么必须并上规格表（2026-10-13 实测踩到）
 *
 * 第一版只探 `listSubagentProviders(ctx)` 返回的名字。上线到实机后读数**一直是空的**，
 * 而日志里**一条探测错误都没有** —— 因为注册表为空时，`probeProviders([])` 立刻返回 `{}`，
 * 于是心跳发出的 `providers` 是个**空对象**，服务端按"空对象应省略"整份丢掉。
 *
 * 全过程**没有任何一处报错**：没有抛错、没有日志、没有告警，只有一个永远不出现的读数。
 *
 *   > 一个"什么都没探，于是什么都没报"的读数，
 *   > 与一个"探过了，本机确实什么都不能用"的读数，
 *   > 在界面上都是**空**的 —— 区别只在后者有一天会变绿。
 *
 * 而是不是真的"本机什么都不能用"？**不是。** `spawn` 是随进程内跑的 provider，
 * 它**永远可用**，根本不需要注册表告诉我们 —— 规格表里就写着它是 `native`。
 * 用注册表当唯一入口，等于让"注册表读不到"这件事**伪装成**"本机没有可用的运行时"。
 *
 * 所以：注册表给的是"**还有哪些**"，规格表给的是"**至少这些**"。
 * 两者取并集，读数才不会因为上游读不到而整个消失。
 *
 * 顺序稳定（注册表顺序在前，再补规格表里缺的），便于比对与判据。
 */
export function readinessProbeTargets(names) {
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '' || seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  for (const name of names ?? []) push(name)
  for (const name of Object.keys(PROVIDER_SPECS)) push(name)
  return out
}

/**
 * 在给定 PATH 里解析可执行文件。
 *
 * ★ 必须用**子进程真正拿到的那个 PATH**，不是守护自己的 PATH ——
 *   这正是"我 shell 里明明能跑"却被判成 `missing_cli` 的来源。
 *   （anet #622 的原话：daemon 创建的节点看不到你 shell 里的 PATH。）
 */
export function resolveOnPath(bin, pathValue, { platform = process.platform, exists = existsSync } = {}) {
  if (typeof bin !== 'string' || bin === '') return null
  const dirs = String(pathValue ?? '').split(delimiter).filter((d) => d !== '')
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try { if (exists(candidate)) return candidate } catch { /* 不可达目录按不存在处理 */ }
    }
  }
  return null
}

/** 从 `--version` 输出里抠版本号；其余输出（**可能含机器路径**）一律丢弃。 */
export function extractVersion(stdout) {
  const m = /\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?/.exec(String(stdout ?? ''))
  return m ? m[0].slice(0, 64) : undefined
}

/** 默认的真实依赖（可注入，测试用假实现；纯函数部分因此不需要碰真实文件系统）。 */
export function createLocalReadinessDeps({
  env = process.env,
  home = null,
  platform = process.platform,
  execFileImpl = execFile,
  spawnImpl = spawn,
} = {}) {
  const resolvedHome = home ?? env.HOME ?? env.USERPROFILE ?? ''
  return {
    platform,
    home: resolvedHome,
    /** ★ 只看存在性 —— 绝不读取内容。 */
    fileExists: (abs) => {
      try { accessSync(abs, constants.F_OK); return true } catch { return false }
    },
    /**
     * 读一个 JSON 配置（CLI 自己的 settings.json）。
     *
     * ★ 读进来的对象**只用于取键名与非空判断**（见 `readCliAuthConfig`），
     *   值不会进结论、不会被记录、不会外传。
     * ★ 读不到 / 不是合法 JSON ⇒ `null`，与"没有这个文件"同一处理：探测不该因为
     *   一份正在被编辑器写一半的文件而报错。
     */
    readJsonFile: (abs) => {
      try {
        if (!existsSync(abs)) return null
        const parsed = JSON.parse(readFileSync(abs, 'utf8'))
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch { return null }
    },
    envHas: (key) => typeof env[key] === 'string' && env[key] !== '',
    pathValue: env.PATH ?? env.Path ?? '',
    resolveOnPath: (bin) => resolveOnPath(bin, env.PATH ?? env.Path ?? '', { platform }),
    execVersion: (bin) => new Promise((resolve) => {
      try {
        execFileImpl(bin, ['--version'], { timeout: STEP_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
          if (err) resolve({ ok: false, stdout: '' })
          else resolve({ ok: true, stdout: String(stdout ?? '') })
        })
      } catch { resolve({ ok: false, stdout: '' }) }
    }),
    /** HEAD 一次供应商端点；不读响应体，只判能不能连上。 */
    httpHead: async (url) => {
      if (platform === 'win32') {
        const windowsRoot = env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows'
        const powershell = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        return new Promise((resolve) => {
          let child
          let timer = null
          let output = ''
          let settled = false
          const finish = (result) => {
            if (settled) return
            settled = true
            if (timer !== null) clearTimeout(timer)
            resolve(result)
          }
          try {
            child = spawnImpl(powershell, [
              '-NoLogo', '-NoProfile', '-NonInteractive',
              '-EncodedCommand', WINDOWS_SYSTEM_PROXY_HEAD_COMMAND,
            ], {
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'ignore'],
              env,
            })
            child.stdout.setEncoding('utf8')
            child.stdout.on('data', (chunk) => {
              if (output.length < 32) output += String(chunk).slice(0, 32 - output.length)
            })
            child.once('error', () => finish('unreachable'))
            child.once('close', (code) => {
              finish(code === 0 && output.trim() === 'reachable' ? 'reachable' : 'unreachable')
            })
            timer = setTimeout(() => {
              try { child.kill() } catch { /* 退出竞态 */ }
              finish('unreachable')
            }, STEP_TIMEOUT_MS)
            timer.unref?.()
            child.stdin.end(`${JSON.stringify(String(url))}\n`)
          } catch {
            try { child?.kill() } catch { /* 启动失败时无需再处理 */ }
            finish('unreachable')
          }
        })
      }
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(STEP_TIMEOUT_MS) })
        return res.status > 0 ? 'reachable' : 'unreachable'
      } catch { return 'unreachable' }
    },
    now: () => Date.now(),
  }
}

/**
 * 从一个 CLI 自己的配置文件里读出「凭据是否配好了」与「它指向哪个端点」。
 *
 * ★ 只取**键名与是否非空**，不取、不存、不外传任何值。
 *   （这与 `fileExists` 是同一档强度：我们知道"填了"，但不知道"填的是什么"。）
 *
 * 认两种写法（都是 Claude Code 支持的）：
 *   · `env: { ANTHROPIC_AUTH_TOKEN | ANTHROPIC_API_KEY: <非空> }`
 *   · 顶层 `apiKeyHelper: <非空字符串>`（一个能吐出 key 的命令；**只认它存在，不执行它** ——
 *     一个就绪度探测没有理由去跑用户机器上的任意命令）
 */
export function readCliAuthConfig(config, { authEnvKeys = [], baseUrlEnvKeys = [] } = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { hasAuth: false, baseUrl: null }
  }
  const env = config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env)
    ? config.env
    : {}
  const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
  const hasAuth = authEnvKeys.some((k) => nonEmptyString(env[k])) || nonEmptyString(config.apiKeyHelper)
  const baseUrlKey = baseUrlEnvKeys.find((k) => nonEmptyString(env[k]))
  return {
    hasAuth,
    // ★ 只回一个**字符串原值**给调用方去探；调用方负责只显示 host（见 describeEndpoint）。
    baseUrl: baseUrlKey === undefined ? null : String(env[baseUrlKey]).trim(),
  }
}

/**
 * 把 URL 收敛成**只含 host** 的形式，用于显示与判据。
 *
 * 为什么不显示完整 URL：端点地址可能带路径、甚至带查询串（有些代理把 token 放在 query 里）。
 * 显示 host 已经足够让人认出"在探哪个服务"，而**多显示的部分只有泄露的风险、没有诊断价值**。
 * （与"reason 里不出现机器路径"是同一条纪律的不同面。）
 */
export function endpointHost(url) {
  try {
    const u = new URL(String(url))
    return u.host === '' ? null : u.host
  } catch { return null }
}

/** 该 provider 用哪个端点：**用户配的优先**，没配才用厂商默认。 */
export function endpointFor(spec, authConfig) {
  const configured = typeof authConfig?.baseUrl === 'string' && authConfig.baseUrl !== '' ? authConfig.baseUrl : null
  return { url: configured ?? spec.endpoint, configured: configured !== null }
}

/**
 * 有时限地求值一个**惰性回调**：抛错/超时都返回 `sentinel`。
 *
 * ★ 参数是 thunk（`() => …`）而不是 Promise：传 Promise 的话，同步抛错发生在
 *   **构造实参**的那一刻 —— 也就是 `settle()` 还没被调用，异常直接穿出去。
 *   第一版就是这么写的，被自己的一条用例抓到了（"解析抛错按找不到处理"）。
 */
async function settle(thunk, sentinel) {
  try {
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(sentinel), STEP_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.resolve().then(thunk), timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  } catch { return sentinel }
}

/**
 * 探测**一个** provider。纯逻辑 + 注入依赖 ⇒ 可被判据逐格钉住。
 *
 * @returns {Promise<{state: string, reason: string, cli?: string, auth?: string, network?: string, version?: string, checkedAtMs: number}>}
 */
export async function probeProvider(name, deps = createLocalReadinessDeps()) {
  const spec = PROVIDER_SPECS[name]
  const checkedAtMs = deps.now()
  if (spec === undefined) {
    return {
      state: READINESS_STATE.UNPROBED,
      reason: '没有探测规格：它既不是已知的外部 CLI，也不是内置 provider。'
        + '**已注册不等于可用** —— 要用它，请先确认对应子 Agent bundle 在这台机器上真能跑起来。',
      checkedAtMs,
    }
  }
  if (spec.kind === 'native') {
    return { state: READINESS_STATE.READY, reason: spec.reason, cli: 'bundled', auth: 'not_required', checkedAtMs }
  }

  const cliPath = await settle(() => deps.resolveOnPath(spec.cli), null)
  if (cliPath === null || cliPath === undefined) {
    return {
      state: READINESS_STATE.MISSING_CLI,
      reason: `这个守护的子进程 PATH 上找不到 \`${spec.cli}\`。安装：${spec.installHint}`,
      cli: 'missing',
      checkedAtMs,
    }
  }

  const ver = await settle(() => deps.execVersion(cliPath), { ok: false, stdout: '' })
  const version = ver && ver.ok ? extractVersion(ver.stdout) : undefined
  const withVersion = version === undefined ? {} : { version }

  // ── 凭据：三处来源，**每一处都对应一种不同的用法**，所以模式要分开报 ──
  const readConfig = (rel) => {
    if (typeof deps.readJsonFile !== 'function') return null
    try { return deps.readJsonFile(join(deps.home, rel)) } catch { return null }
  }
  const settingsConfigs = (spec.settingsFiles ?? []).map(readConfig)
  const fromSettings = settingsConfigs.map((cfg) => readCliAuthConfig(cfg, spec)).find((r) => r.hasAuth)
  const envHasAuth = (spec.authEnvKeys ?? []).some((k) => deps.envHas(k))
  const hasAuthFile = (spec.authFiles ?? []).some((rel) => deps.fileExists(join(deps.home, rel)))

  const authMode = envHasAuth ? AUTH_MODE.ENV
    : hasAuthFile ? AUTH_MODE.SUBSCRIPTION
      : fromSettings !== undefined ? AUTH_MODE.API_SETTINGS
        : AUTH_MODE.NONE

  if (authMode === AUTH_MODE.NONE) {
    // ★ 修法要说清**两种模式各自的配法**，不能只喊 /login ——
    //   对 API 模式的用户来说，"去 /login"是把人家配好的东西顶掉的建议。
    const checked = [...(spec.authFiles ?? []), ...(spec.settingsFiles ?? []), ...(spec.authEnvKeys ?? [])].join('、')
    return {
      state: READINESS_STATE.NOT_LOGGED_IN,
      reason: `找到了 \`${spec.cli}\`，但这台机器上找不到凭据（查过：${checked}）。`
        + `两种配法任选其一 —— 订阅：${spec.loginHint}；API 模式：${spec.apiHint ?? '在 CLI 配置里填 API key'}。`,
      cli: 'found',
      auth: 'absent',
      authMode,
      ...withVersion,
      checkedAtMs,
    }
  }

  // ── 网络：探**用户实际在用的**端点（配了 baseURL 就探它，否则探厂商默认） ──
  const endpoint = endpointFor(spec, fromSettings)
  const host = endpointHost(endpoint.url)
  const net = await settle(() => deps.httpHead(endpoint.url), 'unreachable')
  const authLabel = authMode === AUTH_MODE.API_SETTINGS ? '凭据（CLI 配置里的 API 模式）'
    : authMode === AUTH_MODE.SUBSCRIPTION ? '登录态（订阅）' : '凭据（环境变量）'
  if (net !== 'reachable') {
    return {
      state: READINESS_STATE.NO_NETWORK,
      reason: `CLI 与${authLabel}都在，但连不上 ${host ?? endpoint.url}`
        + `${endpoint.configured ? '（这是你配置的自定义端点）' : ''}（可能是离线/代理/防火墙）。`,
      cli: 'found',
      auth: 'present',
      authMode,
      network: 'unreachable',
      ...(host === null ? {} : { endpointHost: host }),
      ...withVersion,
      checkedAtMs,
    }
  }

  return {
    state: READINESS_STATE.READY,
    reason: `\`${spec.cli}\` 可用、${authLabel}在、端点 ${host ?? endpoint.url} 可达`
      + `${endpoint.configured ? '（自定义端点）' : ''}。`,
    cli: 'found',
    auth: 'present',
    authMode,
    network: 'reachable',
    ...(host === null ? {} : { endpointHost: host }),
    ...withVersion,
    checkedAtMs,
  }
}

/**
 * 探测**一批** provider，带**总截止时间**：整体超时的那几个报 `unknown`（不猜）。
 *
 * 串行而不是并发：这些探测会起子进程，一次性并发起一堆在弱机器上本身就是故障源。
 */
export async function probeProviders(names, deps = createLocalReadinessDeps(), { deadlineMs = PROVIDER_DEADLINE_MS } = {}) {
  const startedMs = deps.now()
  const out = {}
  for (const raw of names ?? []) {
    const name = String(raw)
    if (out[name] !== undefined) continue
    if (deps.now() - startedMs > deadlineMs) {
      out[name] = {
        state: READINESS_STATE.UNKNOWN,
        reason: `探测总时长超过 ${deadlineMs}ms，还没轮到它就停了。**这次没有探测过**，不是"不可用"。`,
        checkedAtMs: deps.now(),
      }
      continue
    }
    out[name] = await probeProvider(name, deps)
  }
  return out
}

/**
 * 后台探测 + 读缓存的壳子（纪律 ②：绝不阻塞心跳）。
 *
 * 调用方在心跳里只调 `snapshot()` —— 它**立刻返回**上一次的结果（可能为空），
 * 同时在后台按需要刷新。于是探测慢/挂死都不会拖住心跳。
 */
export function createReadinessCache({
  probe,
  ttlMs = 10 * 60 * 1000,
  transientFailureTtlMs = 30 * 1000,
  now = () => Date.now(),
  onError = null,
} = {}) {
  let cached = null
  let inflight = null
  return {
    /** 立刻返回缓存（可能为 null = 本轮还没有读数）。为空时会触发一次后台刷新。 */
    snapshot(names) {
      const stale = cached === null || now() - cached.atMs > cached.ttlMs
      if (stale && inflight === null) {
        inflight = Promise.resolve()
          .then(() => probe(names))
          .then((value) => {
            // 网络失败或探测超时可能是瞬时状况。若与成功读数一样缓存 10 分钟，
            // 一次代理抖动就会在网络恢复后继续显示为不可用。
            const transientFailure = Object.values(value ?? {}).some(entry =>
              entry?.state === READINESS_STATE.NO_NETWORK || entry?.state === READINESS_STATE.UNKNOWN)
            cached = { atMs: now(), ttlMs: transientFailure ? transientFailureTtlMs : ttlMs, value }
          })
          .catch((e) => { if (onError) onError(e) })
          .finally(() => { inflight = null })
      }
      return cached === null ? null : cached.value
    },
    /** 测试/关停用：等这次后台刷新结束。 */
    async settled() { if (inflight !== null) await inflight },
  }
}
