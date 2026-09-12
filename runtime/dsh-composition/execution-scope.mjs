// runtime/dsh-composition/execution-scope.mjs
// ============================================================================
// PRT-605：命令、网络与 MCP 权限控制
//
// spec line 927：「`PRT-605`：实现命令、网络和 MCP 权限控制。」
// spec §6.6 line 461–464：权限至少覆盖「Git 和 worktree 操作」「命令执行」
//   「网络访问」「MCP 工具」。
// spec §6.6 line 449：禁止越界路径/动作 → pre-execute 提前拒绝 + guard 最终复核。
//
// PRT-604 管的是"碰文件"。本模块管**另外三条出去做事的通道**：起进程、发请求、
// 调 MCP 工具。三条通道的共同点是：**被检查的东西是一个字符串，而真正执行的东西
// 是那个字符串被某一层解释之后的结果。**
//
//   > 一个「检查字符串」的权限门，
//   > 与一个「检查完之后字符串才被解释成动作」的权限门，是同一个东西。
//
// 所以本模块的每一条规则都是"不解释"：命令行必须是**已分词的 argv**（没有 shell），
// URL 必须用真正的解析器拆（不做子串匹配），MCP 工具名必须**成对**出现。
// ============================================================================

export const EXECUTION_SCOPE_VERSION = 'legion/execution-scope@1'

export const EXEC_CODES = Object.freeze({
  BAD_GRANT: 'exec-scope-malformed',
  BAD_ARGV: 'exec-scope-bad-argv',
  NOT_TOKENIZED: 'exec-scope-not-tokenized',
  PROGRAM_NOT_ALLOWED: 'exec-scope-program-not-allowed',
  RELATIVE_PROGRAM: 'exec-scope-relative-program',
  WRAPPER_PROGRAM: 'exec-scope-wrapper-program',
  SUBCOMMAND_DENIED: 'exec-scope-subcommand-denied',
  FLAG_DENIED: 'exec-scope-flag-denied',
  ENV_KEY_DENIED: 'exec-scope-env-key-denied',
  BAD_URL: 'exec-scope-bad-url',
  SCHEME_DENIED: 'exec-scope-scheme-denied',
  HOST_NOT_ALLOWED: 'exec-scope-host-not-allowed',
  SUFFIX_NOT_ENOUGH: 'exec-scope-suffix-not-enough',
  USERINFO_PRESENT: 'exec-scope-userinfo-present',
  IP_LITERAL: 'exec-scope-ip-literal',
  PRIVATE_ADDRESS: 'exec-scope-private-address',
  PORT_DENIED: 'exec-scope-port-denied',
  NON_ASCII_HOST: 'exec-scope-non-ascii-host',
  CROSS_HOST_REDIRECT: 'exec-scope-cross-host-redirect',
  MCP_NOT_NAMESPACED: 'exec-scope-mcp-not-namespaced',
  MCP_AMBIGUOUS_NAME: 'exec-scope-mcp-ambiguous-name',
  MCP_SERVER_DENIED: 'exec-scope-mcp-server-denied',
  MCP_TOOL_DENIED: 'exec-scope-mcp-tool-denied',
  MCP_BYPASS: 'exec-scope-mcp-bypass',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

// ---------------------------------------------------------------- ① 命令

/**
 * shell 元字符。**任何**出现都拒绝。
 *
 *   > 一个「把整条命令当成一个字符串去匹配白名单」的检查，
 *   > 与一个「`ls; rm -rf /` 命中了 `ls` 这条白名单」的检查，是同一个东西——
 *   > 而它的方向是放行。
 *
 * 注意这里连 `$`、`~`、`*` 都算：不做通配展开，是因为"展开之后是什么"取决于当时
 * 的工作目录——检查的时候看到的东西与执行的时候看到的东西不是同一个。
 */
export const SHELL_METACHARACTERS = Object.freeze([
  ';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '[', ']',
  '*', '?', '~', '!', '\n', '\r', '\0', '#',
])

/**
 * 会**重新引入任意执行**的程序：解释器、shell、包装器、以及**自己会起进程**的那些。
 *
 *   > 一个「白名单里有 `sh`」的检查，
 *   > 与一个「白名单里有任意命令」的检查，是同一个东西。
 *
 * 它们不是无条件拒绝——显式声明 `allowsWrapper: true`、或者给出一个**子命令白名单**
 * 才能放行，而那时授权人写的是"这个岗位可以执行任意命令"，这是一个**有意**的决定。
 *
 * ⚠️ 表里只放**真的能当 argv[0] 用的程序**。`eval` / `exec` / `source` 是 shell 内建，
 * 永远不会出现在 argv[0] 上——把它们放进来是**不可达的规则**：
 *
 *   > 一个「在名单里但实际上永远匹配不到」的规则，
 *   > 与一条不存在的规则，在"它到底拦住了什么"上是同一个东西。
 */
export const WRAPPER_PROGRAMS = Object.freeze([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cscript', 'wscript',
  'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'r', 'Rscript',
  'env', 'xargs', 'find', 'nice', 'nohup', 'timeout', 'stdbuf', 'setsid', 'chroot', 'busybox',
  'sudo', 'doas', 'runas', 'su',
  'awk', 'gawk', 'sed', 'make',
  'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo', 'go',
  'docker', 'kubectl',
  'ssh', 'rsync', 'tar',
])

/**
 * 会改变**后续程序行为**的环境变量。授权里给了 env 就等于给了绕过的通道。
 *
 *   > 一个「能设 `LD_PRELOAD`」的权限，
 *   > 与一个「可以执行任意代码」的权限，是同一个东西——只不过前者看起来像配置。
 */
export const DANGEROUS_ENV_KEYS = Object.freeze([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PATH', 'PATHEXT', 'COMSPEC',
  'NODE_OPTIONS', 'NODE_PATH',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'PERL5LIB', 'PERL5OPT', 'RUBYOPT', 'RUBYLIB',
  'BASH_ENV', 'ENV', 'ZDOTDIR',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'IFS', 'PROMPT_COMMAND',
])

/**
 * 校验 argv：必须是**已经分好词**的字符串数组。
 *
 * 单一字符串（还没分词）直接拒绝——本模块不做分词，因为"怎么分词"本身就是被攻击的
 * 那一环：`sh -c "..."` 与 `sh -c ...` 的分词结果不同，而检查者与执行者的分词器
 * 不一定是同一个。
 *
 *   > 一个「自己做分词」的权限门，
 *   > 与一个「分词结果和执行时不一样」的权限门，是同一个东西。
 */
export function parseArgv({ argv, platform } = {}) {
  if (typeof argv === 'string') {
    throw fail(
      EXEC_CODES.NOT_TOKENIZED,
      `命令必须是已分词的 argv 数组，收到的是单个字符串 ${JSON.stringify(argv)}。` +
      '本模块不做分词——分词结果与执行时的分词器不一定一致',
    )
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw fail(EXEC_CODES.BAD_ARGV, `argv 必须是非空数组，收到 ${JSON.stringify(argv)}`)
  }
  for (const part of argv) {
    if (typeof part !== 'string') {
      throw fail(EXEC_CODES.BAD_ARGV, `argv 的每一项都必须是字符串，收到 ${JSON.stringify(part)}`)
    }
    const hit = SHELL_METACHARACTERS.find((c) => part.includes(c))
    if (hit !== undefined) {
      throw fail(
        EXEC_CODES.NOT_TOKENIZED,
        `argv 里出现了 shell 元字符 ${JSON.stringify(hit)}（在 ${JSON.stringify(part)} 里）。` +
        '已经分好词的 argv 里不该有它——一个"把整条命令当字符串匹配"的检查，' +
        '与一个"ls; rm -rf / 命中了 ls"的检查，是同一个东西',
      )
    }
  }
  const program = argv[0]
  const sep = /[\\/]/.test(program)
  const base = (platform === 'win32' ? program.replace(/\.(exe|cmd|bat|com|ps1)$/i, '') : program)
    .split(/[\\/]/).pop()
  return Object.freeze({
    argv: Object.freeze([...argv]),
    program,
    basename: base,
    hasSeparator: sep,
    isRelative: sep && !(platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\)/ : /^\//).test(program),
  })
}

/**
 * 判定一条命令是否在授权之内。
 *
 * @returns {{allowed: boolean, code: string|null, reason: string|null, program: string|null, matched: object|null}}
 */
export function checkCommand({ argv, grant, platform, envKeys = [] } = {}) {
  let parsed
  try {
    parsed = parseArgv({ argv, platform })
  } catch (err) {
    return Object.freeze({ allowed: false, code: err?.code ?? EXEC_CODES.BAD_ARGV, reason: err?.message ?? String(err), program: null, matched: null })
  }
  const rules = grant?.command
  if (rules === null || typeof rules !== 'object') {
    return Object.freeze({ allowed: false, code: EXEC_CODES.PROGRAM_NOT_ALLOWED, reason: '这个岗位没有命令执行授权', program: parsed.program, matched: null })
  }
  const deniedEnv = envKeys.filter((k) => DANGEROUS_ENV_KEYS.includes(String(k).toUpperCase()))
  if (deniedEnv.length > 0) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.ENV_KEY_DENIED,
      reason: `授权里带了会改变后续程序行为的环境变量 ${JSON.stringify(deniedEnv)}——` +
        '一个"能设 LD_PRELOAD"的权限，与一个"可以执行任意代码"的权限，是同一个东西',
      program: parsed.program,
      matched: null,
    })
  }

  const programs = Array.isArray(rules.programs) ? rules.programs : []
  const match = programs.find((p) => (typeof p === 'string' ? p : p.program) === parsed.basename)
  if (match === undefined) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.PROGRAM_NOT_ALLOWED,
      reason: `程序 ${JSON.stringify(parsed.basename)} 不在授权列表 ${JSON.stringify(programs.map((p) => (typeof p === 'string' ? p : p.program)))} 之内`,
      program: parsed.program,
      matched: null,
    })
  }
  const rule = typeof match === 'string' ? { program: match } : match

  // 带路径的程序名：`./rm` 与 `rm` 是**两个**东西——前者可以是调用方自己放的脚本。
  //
  //   > 一个「按 basename 匹配程序名」的检查，
  //   > 与一个「在工作目录里放一个叫 `rm` 的脚本、然后 `./rm` 就得到了权限」的检查，
  //   > 是同一个东西——而它的方向是放行。
  if (parsed.hasSeparator && rule.allowPath !== true) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.RELATIVE_PROGRAM,
      reason: `程序名 ${JSON.stringify(parsed.program)} 带了路径，而授权没有显式允许（allowPath）。` +
        '一个"按 basename 匹配"的检查，与一个"在工作目录里放一个叫 rm 的脚本就得到权限"的检查，是同一个东西',
      program: parsed.program,
      matched: rule,
    })
  }

  const words = parsed.argv.slice(1).filter((a) => !a.startsWith('-'))

  // ⚠️ **顺序**：子命令与开关先判，包装器后判。
  //
  // 反过来的话，一个声明了 `subcommands: ['test','run']` 的 `npm` 会先被包装器规则
  // 拦下，那条 allow-list **永远走不到**：
  //
  //   > 一个「被前一道更宽的规则挡住」的规则，
  //   > 与一条不存在的规则，在"它到底拦住了什么"上是同一个东西。
  //
  // 这条在装载自检里真的发生过。

  const subs = Array.isArray(rule.denySubcommands) ? rule.denySubcommands : []
  const badSub = words.find((w) => subs.includes(w))
  if (badSub !== undefined) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.SUBCOMMAND_DENIED,
      reason: `子命令 ${JSON.stringify(badSub)} 被 ${JSON.stringify(parsed.basename)} 的授权显式禁止`,
      program: parsed.program,
      matched: rule,
    })
  }

  const badFlags = (Array.isArray(rule.denyFlags) ? rule.denyFlags : [])
    .filter((f) => parsed.argv.slice(1).some((a) => a === f || a.startsWith(`${f}=`) || (f.length === 2 && a.startsWith(f) && a.length > 2)))
  if (badFlags.length > 0) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.FLAG_DENIED,
      reason: `开关 ${JSON.stringify(badFlags)} 被 ${JSON.stringify(parsed.basename)} 的授权显式禁止`,
      program: parsed.program,
      matched: rule,
    })
  }

  const allowSubs = Array.isArray(rule.subcommands) ? rule.subcommands : null
  if (allowSubs !== null && words.length > 0 && !allowSubs.includes(words[0])) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.SUBCOMMAND_DENIED,
      reason: `子命令 ${JSON.stringify(words[0])} 不在授权的子命令列表 ${JSON.stringify(allowSubs)} 之内`,
      program: parsed.program,
      matched: rule,
    })
  }

  // 包装器/解释器：会重新引入任意执行。
  //
  // 两种情形才算**收窄过了**：
  //   - `allowsWrapper: true`：授权人写的是"这个岗位可以执行任意命令"，这是**有意**的
  //   - `subcommands` 白名单：授权人列举了能跑的子命令
  //
  // ⚠️ `denySubcommands` **不算**收窄。黑名单天生不完整：
  //
  //   > 一个「用禁止清单来收窄一个能执行任意东西的程序」的授权，
  //   > 与一个「禁止了 publish 就想当然认为 npm 不能干别的」的授权，是同一个东西——
  //   > 而它的方向是放行。
  const narrowedBySubcommands = allowSubs !== null
  if (WRAPPER_PROGRAMS.includes(parsed.basename) && rule.allowsWrapper !== true && !narrowedBySubcommands) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.WRAPPER_PROGRAM,
      reason: `程序 ${JSON.stringify(parsed.basename)} 是解释器/包装器，会重新引入任意执行。` +
        '必须显式声明 allowsWrapper，或者给出一个子命令白名单（subcommands）——' +
        '一个"白名单里有 sh"的检查，与一个"白名单里有任意命令"的检查，是同一个东西。' +
        '禁止清单（denySubcommands）不算收窄：黑名单天生不完整',
      program: parsed.program,
      matched: rule,
    })
  }

  return Object.freeze({ allowed: true, code: null, reason: null, program: parsed.program, matched: rule })
}

// ---------------------------------------------------------------- ② 网络

/** 地址字面量的私有/保留网段（SSRF 面）。 */
const PRIVATE_V4 = Object.freeze([
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./, /^198\.(18|19)\./, /^22[4-9]\./, /^23\d\./, /^24\d\./, /^255\./,
])

/**
 * 用**真正的解析器**拆 URL。不做子串匹配。
 *
 *   > 一个「用 `url.includes('example.com')` 判断」的检查，
 *   > 与一个「`https://example.com@evil.com/` 被当成 example.com」的检查，
 *   > 是同一个东西——而它的方向是放行。
 *
 * ⚠️ 但解析器**会**帮我们做一件事：`new URL()` 对非 ASCII 域名做 punycode。
 * 所以"域名里有非 ASCII 字符"这件事**必须从原始串上读**——读 `u.hostname` 只会
 * 看到 `xn--...`，于是那条检查永远不触发：
 *
 *   > 一个「在解析之后才检查非 ASCII」的检查，
 *   > 与一个「解析器已经悄悄把它们转掉了、所以这条检查从不触发」的检查，
 *   > 是同一个东西。
 */
export function parseEgressUrl({ url } = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw fail(EXEC_CODES.BAD_URL, `URL 必须是非空字符串，收到 ${JSON.stringify(url)}`)
  }
  let u
  try {
    u = new URL(url)
  } catch (err) {
    throw fail(EXEC_CODES.BAD_URL, `URL 解析不了：${JSON.stringify(url)}（${err?.message ?? String(err)}）`)
  }
  const rawAuthority = (() => {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)
    return m === null ? '' : m[1]
  })()
  const rawHost = rawAuthority.includes('@') ? rawAuthority.slice(rawAuthority.lastIndexOf('@') + 1) : rawAuthority
  const rawHostname = rawHost.startsWith('[') ? rawHost : rawHost.replace(/:\d*$/, '')
  const nonAscii = [...rawHostname].find((ch) => ch.charCodeAt(0) > 127) ?? null

  const hostname = u.hostname
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')
  const ipv4 = isIp && !hostname.startsWith('[') ? hostname : null
  return Object.freeze({
    scheme: u.protocol.replace(':', '').toLowerCase(),
    host: hostname.toLowerCase(),
    // ⚠️ **不**把尾点当成"另一个域名"：去掉 FQDN 根点之后再比
    hostWithoutRootDot: hostname.toLowerCase().replace(/\.$/, ''),
    hasRootDot: hostname.endsWith('.'),
    port: u.port === '' ? null : Number(u.port),
    hasUserinfo: u.username !== '' || u.password !== '',
    userinfo: u.username === '' ? null : u.username,
    isIpLiteral: isIp,
    ipv4,
    nonAscii,
    punycoded: hostname.startsWith('xn--') ? hostname : null,
    rawAuthority,
    path: u.pathname,
    explicitPort: u.port !== '',
  })
}

/** IPv4 是否落在私有/保留网段。 */
export function isPrivateV4(host) {
  return PRIVATE_V4.some((re) => re.test(host))
}

/**
 * 判定一次出网是否在授权之内。
 */
export function checkNetwork({ url, method = 'GET', grant, redirectFrom = null } = {}) {
  let parsed
  try {
    parsed = parseEgressUrl({ url })
  } catch (err) {
    return Object.freeze({ allowed: false, code: err?.code ?? EXEC_CODES.BAD_URL, reason: err?.message ?? String(err), host: null, scheme: null })
  }
  const rules = grant?.network
  if (rules === null || typeof rules !== 'object') {
    return Object.freeze({ allowed: false, code: EXEC_CODES.SCHEME_DENIED, reason: '这个岗位没有网络访问授权', host: parsed.host, scheme: parsed.scheme })
  }

  const schemes = Array.isArray(rules.schemes) ? rules.schemes.map((s) => String(s).toLowerCase()) : []
  if (!schemes.includes(parsed.scheme)) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.SCHEME_DENIED,
      reason: `协议 ${JSON.stringify(parsed.scheme)} 不在授权列表 ${JSON.stringify(schemes)} 之内`,
      host: parsed.host,
      scheme: parsed.scheme,
    })
  }

  // `user@host`：真正的 host 是 `@` **之后**那一段。
  if (parsed.hasUserinfo) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.USERINFO_PRESENT,
      reason: `URL 里带了 userinfo（${JSON.stringify(parsed.userinfo)}@）。` +
        '真正的 host 在 @ 之后——一个"用 includes 判断"的检查，' +
        '与一个"https://example.com@evil.com/ 被当成 example.com"的检查，是同一个东西',
      host: parsed.host,
      scheme: parsed.scheme,
    })
  }

  // 非 ASCII 域名（同形异义攻击）。本仓库零依赖，不做 punycode 转换，
  // 所以**拒绝**而不是"尽力比较"。
  if (parsed.nonAscii !== null) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.NON_ASCII_HOST,
      reason: `域名 ${JSON.stringify(parsed.rawAuthority)} 含非 ASCII 字符 ${JSON.stringify(parsed.nonAscii)}。` +
        '本模块不做 punycode 转换（零依赖），所以拒绝而不是"尽力比较"——' +
        '一个"不做转换就比域名"的检查，与一个"西里尔字母的 example.com 被当成 example.com"的检查，是同一个东西',
      host: parsed.host,
      scheme: parsed.scheme,
    })
  }

  const hosts = Array.isArray(rules.hosts) ? rules.hosts.map((h) => String(h).toLowerCase().replace(/\.$/, '')) : []

  // 地址字面量：域名白名单**管不住** IP。
  //
  //   > 一个「只查域名白名单」的检查，
  //   > 与一个「`http://169.254.169.254/` 走 IP 字面量绕过域名白名单」的检查，
  //   > 是同一个东西——而它的方向是放行。
  if (parsed.isIpLiteral) {
    if (rules.allowIpLiterals !== true) {
      return Object.freeze({
        allowed: false,
        code: EXEC_CODES.IP_LITERAL,
        reason: `目标 ${JSON.stringify(parsed.host)} 是 IP 字面量，而授权没有允许（allowIpLiterals）——` +
          '域名白名单管不住 IP 字面量',
        host: parsed.host,
        scheme: parsed.scheme,
      })
    }
    if (parsed.ipv4 !== null && isPrivateV4(parsed.ipv4) && rules.allowPrivate !== true) {
      return Object.freeze({
        allowed: false,
        code: EXEC_CODES.PRIVATE_ADDRESS,
        reason: `目标 ${JSON.stringify(parsed.ipv4)} 落在私有/保留网段。授信网段之外的地址不出网`,
        host: parsed.host,
        scheme: parsed.scheme,
      })
    }
  }

  // host 必须**整段相等**（去掉 FQDN 根点之后），不做后缀匹配。
  //
  //   > 一个「用后缀匹配判断域名是否允许」的检查，
  //   > 与一个「`evil-example.com` 也在 `example.com` 白名单里」的检查，
  //   > 是同一个东西——而它的方向是放行。
  const exact = hosts.includes(parsed.hostWithoutRootDot)
  if (!exact) {
    const suffixHit = hosts.find((h) => parsed.hostWithoutRootDot.endsWith(`.${h}`) || parsed.hostWithoutRootDot.endsWith(h))
    return Object.freeze({
      allowed: false,
      code: suffixHit === undefined ? EXEC_CODES.HOST_NOT_ALLOWED : EXEC_CODES.SUFFIX_NOT_ENOUGH,
      reason: suffixHit === undefined
        ? `域名 ${JSON.stringify(parsed.hostWithoutRootDot)} 不在授权列表 ${JSON.stringify(hosts)} 之内`
        : `域名 ${JSON.stringify(parsed.hostWithoutRootDot)} 与白名单项 ${JSON.stringify(suffixHit)} 只是**后缀**关系。` +
          '后缀不是包含——一个"用后缀匹配判断域名"的检查，' +
          '与一个"evil-example.com 也在 example.com 白名单里"的检查，是同一个东西',
      host: parsed.host,
      scheme: parsed.scheme,
    })
  }

  const allowPorts = Array.isArray(rules.ports) ? rules.ports.map(Number) : null
  if (parsed.explicitPort && allowPorts !== null && !allowPorts.includes(parsed.port)) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.PORT_DENIED,
      reason: `端口 ${parsed.port} 不在授权列表 ${JSON.stringify(allowPorts)} 之内`,
      host: parsed.host,
      scheme: parsed.scheme,
    })
  }

  // 重定向：跨 host 的跳转必须**再判一次**。
  //
  //   > 一个「只在第一次请求时检查 host」的策略，
  //   > 与一个「跟随一次 302 就出去了」的策略，是同一个东西。
  if (redirectFrom !== null) {
    const from = String(redirectFrom).toLowerCase().replace(/\.$/, '')
    if (from !== parsed.hostWithoutRootDot && rules.allowCrossHostRedirect !== true) {
      return Object.freeze({
        allowed: false,
        code: EXEC_CODES.CROSS_HOST_REDIRECT,
        reason: `这是一次跨域名重定向：${JSON.stringify(from)} → ${JSON.stringify(parsed.hostWithoutRootDot)}。` +
          '跨域跳转默认拒绝——一个"只在第一次请求时检查 host"的策略，' +
          '与一个"跟随一次 302 就出去了"的策略，是同一个东西',
        host: parsed.host,
        scheme: parsed.scheme,
      })
    }
  }

  if (method !== null && rules.methods !== undefined && rules.methods !== null) {
    const methods = (Array.isArray(rules.methods) ? rules.methods : []).map((m) => String(m).toUpperCase())
    if (!methods.includes(String(method).toUpperCase())) {
      return Object.freeze({
        allowed: false,
        code: EXEC_CODES.HOST_NOT_ALLOWED,
        reason: `方法 ${JSON.stringify(method)} 不在授权列表 ${JSON.stringify(methods)} 之内`,
        host: parsed.host,
        scheme: parsed.scheme,
      })
    }
  }

  return Object.freeze({ allowed: true, code: null, reason: null, host: parsed.hostWithoutRootDot, scheme: parsed.scheme })
}

// ---------------------------------------------------------------- ③ MCP

const MCP_PART = /^[A-Za-z0-9._-]+$/

/**
 * 拆 MCP 工具名。必须是**成对**的 `server__tool`。
 *
 *   > 一个「只按工具名授权 MCP 工具」的检查，
 *   > 与一个「任意一个 MCP server 暴露同名工具就得到权限」的检查，是同一个东西——
 *   > 而它的方向是放行。
 *
 * 而且**恰好一个**分隔符：`a__b__c` 是歧义的。按"第一个 `__` 切分"的写法，
 * 一个 server 名叫 `a__b` 就能伪装成 server `a` 的工具：
 *
 *   > 一个「按第一个 `__` 切分」的检查，
 *   > 与一个「server 名里带 `__` 就能伪装成另一个 server」的检查，是同一个东西。
 */
export function splitMcpTool({ raw } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw fail(EXEC_CODES.MCP_NOT_NAMESPACED, `MCP 工具名必须是非空字符串，收到 ${JSON.stringify(raw)}`)
  }
  const name = raw.trim()
  const parts = name.split('__')
  if (parts.length !== 2) {
    throw fail(
      EXEC_CODES.MCP_AMBIGUOUS_NAME,
      `MCP 工具名 ${JSON.stringify(name)} 里的 __ 分隔符不是恰好一个（${parts.length - 1} 个）。` +
      '按"第一个 __ 切分"的写法，一个 server 名叫 a__b 就能伪装成 server a 的工具——' +
      '一个"按第一个 __ 切分"的检查，与一个"server 名里带 __ 就能伪装"的检查，是同一个东西',
    )
  }
  const [server, tool] = parts
  if (!MCP_PART.test(server) || !MCP_PART.test(tool)) {
    throw fail(
      EXEC_CODES.MCP_AMBIGUOUS_NAME,
      `MCP 工具名 ${JSON.stringify(name)} 的 server/tool 段含有不安全的字符`,
    )
  }
  return Object.freeze({ server, tool, raw: name, key: `${server}__${tool}` })
}

/**
 * 判定一次 MCP 调用是否在授权之内。
 */
export function checkMcp({ tool, grant, pathVerdict = null, networkVerdict = null } = {}) {
  let split
  try {
    split = splitMcpTool({ raw: tool })
  } catch (err) {
    return Object.freeze({ allowed: false, code: err?.code ?? EXEC_CODES.MCP_NOT_NAMESPACED, reason: err?.message ?? String(err), server: null, tool: null })
  }
  const rules = grant?.mcp
  if (rules === null || typeof rules !== 'object') {
    return Object.freeze({ allowed: false, code: EXEC_CODES.MCP_SERVER_DENIED, reason: '这个岗位没有 MCP 授权', server: split.server, tool: split.tool })
  }
  const servers = Array.isArray(rules.servers) ? rules.servers : []
  const serverRule = servers.find((s) => (typeof s === 'string' ? s : s.server) === split.server)
  if (serverRule === undefined) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.MCP_SERVER_DENIED,
      reason: `MCP server ${JSON.stringify(split.server)} 不在授权列表之内`,
      server: split.server,
      tool: split.tool,
    })
  }
  const rule = typeof serverRule === 'string' ? { server: serverRule } : serverRule

  // ★ MCP 授权是**额外**的收窄，不是替代：一个 MCP 工具能读文件、能出网，
  //   那些判定必须**照样生效**。
  //
  //   > 一个「拿到 MCP 工具授权就等于绕过路径与网络范围」的实现，
  //   > 与一个「装一个 MCP server 就能读整块磁盘」的实现，是同一个东西——
  //   > 只不过前者看起来像"这个岗位可以用这个工具"。
  if (pathVerdict !== null && pathVerdict.allowed !== true) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.MCP_BYPASS,
      reason: `MCP 工具 ${split.key} 被授权，但它这次调用没通过路径范围检查（${pathVerdict.code}）：${pathVerdict.reason}。` +
        'MCP 授权是额外收窄，不是替代——它不能绕过路径范围',
      server: split.server,
      tool: split.tool,
    })
  }
  if (networkVerdict !== null && networkVerdict.allowed !== true) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.MCP_BYPASS,
      reason: `MCP 工具 ${split.key} 被授权，但它这次调用没通过网络范围检查（${networkVerdict.code}）：${networkVerdict.reason}。MCP 授权不能绕过网络范围`,
      server: split.server,
      tool: split.tool,
    })
  }

  const tools = Array.isArray(rule.tools) ? rule.tools : null
  if (tools === null || !tools.includes(split.tool)) {
    return Object.freeze({
      allowed: false,
      code: EXEC_CODES.MCP_TOOL_DENIED,
      reason: `MCP 工具 ${JSON.stringify(split.tool)} 不在 server ${JSON.stringify(split.server)} 的授权列表 ${JSON.stringify(tools ?? [])} 之内。` +
        '只按工具名授权的话，任意一个 server 暴露同名工具就得到了权限',
      server: split.server,
      tool: split.tool,
    })
  }
  return Object.freeze({ allowed: true, code: null, reason: null, server: split.server, tool: split.tool })
}

// ---------------------------------------------------------------- 授权表

const GRANT_FIELDS = Object.freeze(['version', 'command', 'network', 'mcp'])

/** 归一化授权表。字段必须闭合（同 PRT-603/604 的纪律）。 */
export function normalizeGrant(input) {
  if (input === null || typeof input !== 'object') {
    throw fail(EXEC_CODES.BAD_GRANT, 'normalizeGrant 需要一份授权对象')
  }
  const unknown = Object.keys(input).filter((k) => !GRANT_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw fail(
      EXEC_CODES.BAD_GRANT,
      `授权表里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的授权表，与一个"多打的一个字母让整条限制静默失效"的授权表，是同一个东西',
    )
  }
  if (input.version !== undefined && input.version !== EXECUTION_SCOPE_VERSION) {
    throw fail(EXEC_CODES.BAD_GRANT, `授权表的 version 是 ${JSON.stringify(input.version)}，期望 ${JSON.stringify(EXECUTION_SCOPE_VERSION)}`)
  }
  const command = input.command ?? null
  if (command !== null) {
    if (!Array.isArray(command.programs)) {
      throw fail(EXEC_CODES.BAD_GRANT, 'command.programs 必须是数组')
    }
    for (const p of command.programs) {
      const name = typeof p === 'string' ? p : p?.program
      if (typeof name !== 'string' || name.trim() === '') {
        throw fail(EXEC_CODES.BAD_GRANT, `command.programs 里有空项：${JSON.stringify(p)}`)
      }
    }
  }
  const network = input.network ?? null
  if (network !== null && !Array.isArray(network.hosts)) {
    throw fail(EXEC_CODES.BAD_GRANT, 'network.hosts 必须是数组（空数组表示什么都不许出网）')
  }
  const mcp = input.mcp ?? null
  if (mcp !== null && !Array.isArray(mcp.servers)) {
    throw fail(EXEC_CODES.BAD_GRANT, 'mcp.servers 必须是数组')
  }
  return Object.freeze({
    version: EXECUTION_SCOPE_VERSION,
    command: command === null ? null : Object.freeze({ ...command, programs: Object.freeze([...command.programs]) }),
    network: network === null ? null : Object.freeze({ ...network, hosts: Object.freeze([...network.hosts]) }),
    mcp: mcp === null ? null : Object.freeze({ ...mcp, servers: Object.freeze([...mcp.servers]) }),
  })
}

// ---------------------------------------------------------------- 装载自检

const PROBE_GRANT = Object.freeze({
  version: EXECUTION_SCOPE_VERSION,
  command: Object.freeze({
    programs: Object.freeze([
      Object.freeze({ program: 'git', denySubcommands: Object.freeze(['push', 'reset']), denyFlags: Object.freeze(['--force']) }),
      Object.freeze({ program: 'npm', subcommands: Object.freeze(['test', 'run']) }),
      'ls',
      Object.freeze({ program: 'sh' }),
      Object.freeze({ program: 'node', allowsWrapper: true }),
    ]),
  }),
  network: Object.freeze({
    schemes: Object.freeze(['https']),
    hosts: Object.freeze(['example.com', 'api.example.com']),
    ports: Object.freeze([443]),
    methods: Object.freeze(['GET', 'POST']),
  }),
  mcp: Object.freeze({
    servers: Object.freeze([
      Object.freeze({ server: 'fs', tools: Object.freeze(['read_file', 'list_dir']) }),
      Object.freeze({ server: 'db', tools: Object.freeze(['query']) }),
    ]),
  }),
})

const PROBE_PROGRAM_NAMES = PROBE_GRANT.command.programs.map((p) => (typeof p === 'string' ? p : p.program))

/** ① 命令拼接：`ls; rm -rf /` 不能在"命中了 ls"的意义上被放行。 */
export function assertNoShellChaining() {
  const samples = ['ls; rm -rf /', 'ls && rm -rf /', 'ls | tee /etc/passwd', 'ls `id`', 'ls $(id)', 'ls > /etc/passwd', 'ls\nrm', 'ls & rm']
  const out = samples.map((s) => {
    const v = checkCommand({ argv: [s], grant: PROBE_GRANT, platform: 'linux' })
    return Object.freeze({ single: s, code: v.code, allowed: v.allowed, firstToken: s.split(/\s+/)[0] })
  })
  // ★ 证据：**朴素分词**（按空白切第一个词）会让其中 7 条命中白名单里的 `ls`。
  //   只有 `ls; rm -rf /` 因为第一个词是 `ls;`（带了分号）而侥幸不命中——也就是说，
  //   "按第一个词匹配"这条路在绝大多数拼接写法上都是放行的。
  //
  //   （早先这条证据取的是 `'ls; rm -rf /'.split(' ')[0]`，得到 `false` —— 它**恰好**
  //   证明了相反的事。证据要挑能把危险展示出来的样本，而不是挑运气好的那一个。）
  const naiveHits = out
    .filter((o) => PROBE_PROGRAM_NAMES.includes(o.firstToken))
    .map((o) => Object.freeze({ single: o.single, firstToken: o.firstToken }))
  return Object.freeze({
    rejected: Object.freeze(out),
    naiveFirstTokenMatches: Object.freeze(naiveHits),
    naiveWouldAllowCount: naiveHits.length,
    naiveWouldAllowSamples: naiveHits.length,
    asString: checkCommand({ argv: 'ls', grant: PROBE_GRANT, platform: 'linux' }).code,
  })
}

/** ② argv[0] 带路径：`./rm` 与 `rm` 不是同一个东西。 */
export function assertPathProgramRejected() {
  const ok = checkCommand({ argv: ['ls', '-la'], grant: PROBE_GRANT, platform: 'linux' })
  const relative = checkCommand({ argv: ['./ls', '-la'], grant: PROBE_GRANT, platform: 'linux' })
  const absolute = checkCommand({ argv: ['/usr/bin/ls', '-la'], grant: PROBE_GRANT, platform: 'linux' })
  const allowedPath = checkCommand({
    argv: ['./ls'],
    grant: { command: { programs: [{ program: 'ls', allowPath: true }] } },
    platform: 'linux',
  })
  return Object.freeze({
    ok: Object.freeze({ allowed: ok.allowed }),
    relative: Object.freeze({ allowed: relative.allowed, code: relative.code }),
    absolute: Object.freeze({ allowed: absolute.allowed, code: absolute.code }),
    allowedPath: Object.freeze({ allowed: allowedPath.allowed }),
  })
}

/** ③ 包装器：白名单里有 `sh` 就等于有任意命令；而子命令白名单是**收窄**。 */
export function assertWrapperDenied() {
  const sh = checkCommand({ argv: ['sh', '-c', 'rm'], grant: PROBE_GRANT, platform: 'linux' })
  const node = checkCommand({ argv: ['node', 'script.js'], grant: PROBE_GRANT, platform: 'linux' })
  const npmAllowed = checkCommand({ argv: ['npm', 'test'], grant: PROBE_GRANT, platform: 'linux' })
  const npmDenyListOnly = checkCommand({
    argv: ['npm', 'test'],
    grant: { command: { programs: [{ program: 'npm', denySubcommands: ['publish'] }] } },
    platform: 'linux',
  })
  // ⚠️ 顺序证明：`npm publish` 同时"是包装器"且"不在子命令白名单里"——
  // 如果包装器规则排在前面，这里会拿到 WRAPPER_PROGRAM，白名单永远走不到。
  const subcommandRuleWins = checkCommand({ argv: ['npm', 'publish'], grant: PROBE_GRANT, platform: 'linux' })
  const wrappers = WRAPPER_PROGRAMS.map((w) => Object.freeze({
    program: w,
    code: checkCommand({ argv: [w], grant: { command: { programs: [w] } }, platform: 'linux' }).code,
  }))
  return Object.freeze({
    shWithoutWrapperFlag: Object.freeze({ allowed: sh.allowed, code: sh.code }),
    nodeWithWrapperFlag: Object.freeze({ allowed: node.allowed }),
    npmWithSubcommandWhitelist: Object.freeze({ allowed: npmAllowed.allowed, code: npmAllowed.code }),
    npmWithDenyListOnly: Object.freeze({ allowed: npmDenyListOnly.allowed, code: npmDenyListOnly.code }),
    subcommandRuleWins: Object.freeze({ allowed: subcommandRuleWins.allowed, code: subcommandRuleWins.code }),
    wrappers: Object.freeze(wrappers),
    wrapperCount: WRAPPER_PROGRAMS.length,
    builtinsExcluded: Object.freeze(['eval', 'exec', 'source'].filter((b) => WRAPPER_PROGRAMS.includes(b))),
  })
}

/** ④ 子命令与危险开关。 */
export function assertSubcommandAndFlags() {
  const allowSub = checkCommand({ argv: ['npm', 'test'], grant: PROBE_GRANT, platform: 'linux' })
  const badSub = checkCommand({ argv: ['npm', 'publish'], grant: PROBE_GRANT, platform: 'linux' })
  const gitStatus = checkCommand({ argv: ['git', 'status'], grant: PROBE_GRANT, platform: 'linux' })
  const gitPush = checkCommand({ argv: ['git', 'push'], grant: PROBE_GRANT, platform: 'linux' })
  const gitForce = checkCommand({ argv: ['git', 'rebase', '--force'], grant: PROBE_GRANT, platform: 'linux' })
  const gitForceEq = checkCommand({ argv: ['git', 'rebase', '--force=yes'], grant: PROBE_GRANT, platform: 'linux' })
  return Object.freeze({
    allowSub: allowSub.allowed,
    badSub: Object.freeze({ allowed: badSub.allowed, code: badSub.code }),
    gitStatus: gitStatus.allowed,
    gitPush: Object.freeze({ allowed: gitPush.allowed, code: gitPush.code }),
    gitForce: Object.freeze({ allowed: gitForce.allowed, code: gitForce.code }),
    gitForceEq: Object.freeze({ allowed: gitForceEq.allowed, code: gitForceEq.code }),
  })
}

/** ⑤ 危险环境变量。 */
export function assertDangerousEnvRejected() {
  const out = DANGEROUS_ENV_KEYS.map((k) => Object.freeze({ key: k, code: checkCommand({ argv: ['git', 'status'], grant: PROBE_GRANT, platform: 'linux', envKeys: [k] }).code }))
  return Object.freeze({
    keys: Object.freeze(out),
    count: DANGEROUS_ENV_KEYS.length,
    ok: checkCommand({ argv: ['git', 'status'], grant: PROBE_GRANT, platform: 'linux', envKeys: ['HOME', 'LANG'] }).allowed,
  })
}

/** ⑥ 域名后缀匹配与尾点。 */
export function assertHostMatchingIsExact() {
  const cases = [
    { url: 'https://example.com/a', expect: true },
    { url: 'https://api.example.com/a', expect: true },
    { url: 'https://evil-example.com/a', expect: false, code: EXEC_CODES.SUFFIX_NOT_ENOUGH },
    // ⚠️ 这一条与上一条**不同**：`example.com.evil.com` 并**不**以 `example.com` 结尾，
    // 所以它不是"后缀命中"，而是普通的不在名单里。两条都留，是为了说明
    // "看起来像子域名的攻击"有两种形状，而它们的诊断不同——诊断不同则修复动作不同。
    { url: 'https://example.com.evil.com/a', expect: false, code: EXEC_CODES.HOST_NOT_ALLOWED },
    { url: 'https://notexample.com/a', expect: false, code: EXEC_CODES.SUFFIX_NOT_ENOUGH },
    { url: 'https://example.com./a', expect: true },
    { url: 'https://EXAMPLE.COM/a', expect: true },
  ]
  const out = cases.map((c) => {
    const v = checkNetwork({ url: c.url, grant: PROBE_GRANT })
    return Object.freeze({ url: c.url, expect: c.expect, allowed: v.allowed, code: v.code, host: v.host })
  })
  const wrong = out.filter((o) => o.allowed !== o.expect)
  const hosts = PROBE_GRANT.network.hosts
  const textual = ['https://evil-example.com/a', 'https://example.com.evil.com/a', 'https://notexample.com/a']
    .map((u) => Object.freeze({ url: u, includesWouldMatch: hosts.some((h) => u.includes(h)) }))
  return Object.freeze({ cases: Object.freeze(out), wrong: Object.freeze(wrong), textualWouldMatch: Object.freeze(textual) })
}

/** ⑦ URL 混淆：userinfo、IP 字面量、私有网段、非 ASCII。 */
export function assertUrlConfusionRejected() {
  const userinfo = checkNetwork({ url: 'https://example.com@evil.com/a', grant: PROBE_GRANT })
  const ipLiteral = checkNetwork({ url: 'https://93.184.216.34/a', grant: PROBE_GRANT })
  const ssrf = checkNetwork({ url: 'https://169.254.169.254/latest/meta-data/', grant: PROBE_GRANT })
  const ssrfAllowedLiteral = checkNetwork({
    url: 'https://169.254.169.254/latest/meta-data/',
    grant: { network: { schemes: ['https'], hosts: [], allowIpLiterals: true } },
  })
  const cyrillicUrl = 'https://\u0435xample.com/a'
  const cyrillic = checkNetwork({ url: cyrillicUrl, grant: PROBE_GRANT })
  const cyrillicParsed = parseEgressUrl({ url: cyrillicUrl })
  const scheme = checkNetwork({ url: 'file:///etc/passwd', grant: PROBE_GRANT })
  const textual = ['https://example.com@evil.com/a', 'https://169.254.169.254/x', cyrillicUrl]
    .map((u) => Object.freeze({ url: u, includesWouldMatch: PROBE_GRANT.network.hosts.some((h) => u.includes(h)) }))
  return Object.freeze({
    userinfo: Object.freeze({ allowed: userinfo.allowed, code: userinfo.code }),
    ipLiteral: Object.freeze({ allowed: ipLiteral.allowed, code: ipLiteral.code }),
    ssrf: Object.freeze({ allowed: ssrf.allowed, code: ssrf.code }),
    ssrfWithLiteralsAllowed: Object.freeze({ allowed: ssrfAllowedLiteral.allowed, code: ssrfAllowedLiteral.code }),
    cyrillic: Object.freeze({ allowed: cyrillic.allowed, code: cyrillic.code }),
    cyrillicParser: Object.freeze({
      rawAuthority: cyrillicParsed.rawAuthority,
      host: cyrillicParsed.host,
      nonAscii: cyrillicParsed.nonAscii,
      punycoded: cyrillicParsed.punycoded,
      nonAsciiInParsedHost: [...cyrillicParsed.host].find((ch) => ch.charCodeAt(0) > 127) ?? null,
    }),
    scheme: Object.freeze({ allowed: scheme.allowed, code: scheme.code }),
    textualWouldMatch: Object.freeze(textual),
  })
}

/** ⑧ 跨域名重定向。 */
export function assertCrossHostRedirect() {
  const same = checkNetwork({ url: 'https://example.com/b', grant: PROBE_GRANT, redirectFrom: 'example.com' })
  const cross = checkNetwork({ url: 'https://evil.com/b', grant: PROBE_GRANT, redirectFrom: 'example.com' })
  const crossAllowed = checkNetwork({
    url: 'https://evil.com/b',
    grant: { network: { schemes: ['https'], hosts: ['example.com', 'evil.com'], allowCrossHostRedirect: true } },
    redirectFrom: 'example.com',
  })
  // 关键：`evil.com` 本来就不在白名单里，所以它**首先**被主机检查拦下 —— 这是对的。
  // 这里要证明的是"重定向那一层也有判定"，所以把它放进白名单再看。
  const crossInList = checkNetwork({
    url: 'https://evil.com/b',
    grant: { network: { schemes: ['https'], hosts: ['example.com', 'evil.com'] } },
    redirectFrom: 'example.com',
  })
  return Object.freeze({
    sameHost: Object.freeze({ allowed: same.allowed }),
    crossNotInList: Object.freeze({ allowed: cross.allowed, code: cross.code }),
    crossInList: Object.freeze({ allowed: crossInList.allowed, code: crossInList.code }),
    crossExplicitlyAllowed: Object.freeze({ allowed: crossAllowed.allowed }),
  })
}

/** ⑨ MCP 必须**成对**授权。 */
export function assertMcpPairScoped() {
  const onFs = checkMcp({ tool: 'fs__read_file', grant: PROBE_GRANT })
  const onDb = checkMcp({ tool: 'db__read_file', grant: PROBE_GRANT })
  const bare = checkMcp({ tool: 'read_file', grant: PROBE_GRANT })
  const ambiguous = checkMcp({ tool: 'a__b__read_file', grant: PROBE_GRANT })
  const spoof = checkMcp({ tool: 'fs__read_file', grant: { mcp: { servers: [{ server: 'fs__read', tools: ['file'] }] } } })
  const unknownServer = checkMcp({ tool: 'other__read_file', grant: PROBE_GRANT })
  const deniedTool = checkMcp({ tool: 'fs__delete_file', grant: PROBE_GRANT })
  return Object.freeze({
    onFs: Object.freeze({ allowed: onFs.allowed }),
    onDb: Object.freeze({ allowed: onDb.allowed, code: onDb.code }),
    bare: Object.freeze({ allowed: bare.allowed, code: bare.code }),
    ambiguous: Object.freeze({ allowed: ambiguous.allowed, code: ambiguous.code }),
    spoof: Object.freeze({ allowed: spoof.allowed, code: spoof.code }),
    unknownServer: Object.freeze({ allowed: unknownServer.allowed, code: unknownServer.code }),
    deniedTool: Object.freeze({ allowed: deniedTool.allowed, code: deniedTool.code }),
  })
}

/** ⑩ MCP 授权**不能**绕过路径与网络范围。 */
export function assertMcpDoesNotBypass() {
  const badPath = { allowed: false, code: 'path-scope-outside-write', reason: '目标在写范围之外' }
  const badNet = { allowed: false, code: 'exec-scope-host-not-allowed', reason: '域名不在白名单' }
  const good = { allowed: true, code: null, reason: null }
  return Object.freeze({
    noVerdicts: Object.freeze({ allowed: checkMcp({ tool: 'fs__read_file', grant: PROBE_GRANT }).allowed }),
    badPath: Object.freeze(checkMcp({ tool: 'fs__read_file', grant: PROBE_GRANT, pathVerdict: badPath })),
    badNet: Object.freeze(checkMcp({ tool: 'fs__read_file', grant: PROBE_GRANT, networkVerdict: badNet })),
    bothGood: Object.freeze({ allowed: checkMcp({ tool: 'fs__read_file', grant: PROBE_GRANT, pathVerdict: good, networkVerdict: good }).allowed }),
  })
}

/** ⑪ 授权表字段闭合与幂等。 */
export function assertGrantClosedAndIdempotent() {
  let unknownCode = null
  try { normalizeGrant({ command: { programs: [] }, denyPaths: [] }) } catch (err) { unknownCode = err.code }
  let versionCode = null
  try { normalizeGrant({ version: 'legion/execution-scope@0' }) } catch (err) { versionCode = err.code }
  const once = normalizeGrant(PROBE_GRANT)
  const twice = normalizeGrant(once)
  return Object.freeze({
    unknownCode,
    versionCode,
    idempotent: JSON.stringify({ ...once }) === JSON.stringify({ ...twice }),
    version: twice.version,
    emptyHosts: normalizeGrant({ network: { hosts: [] } }).network.hosts.length,
  })
}

export const EXECUTION_SCOPE_CHECKED = Object.freeze({
  version: EXECUTION_SCOPE_VERSION,
  metacharacters: SHELL_METACHARACTERS,
  wrappers: WRAPPER_PROGRAMS,
  dangerousEnv: DANGEROUS_ENV_KEYS,
  chaining: assertNoShellChaining(),
  pathProgram: assertPathProgramRejected(),
  wrapper: assertWrapperDenied(),
  subcommand: assertSubcommandAndFlags(),
  env: assertDangerousEnvRejected(),
  host: assertHostMatchingIsExact(),
  urlConfusion: assertUrlConfusionRejected(),
  redirect: assertCrossHostRedirect(),
  mcpPair: assertMcpPairScoped(),
  mcpBypass: assertMcpDoesNotBypass(),
  grant: assertGrantClosedAndIdempotent(),
})
