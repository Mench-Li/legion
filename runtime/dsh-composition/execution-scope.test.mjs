// runtime/dsh-composition/execution-scope.test.mjs
// ============================================================================
// PRT-605 的判据：命令、网络与 MCP 权限控制
//
// spec line 927：「实现命令、网络和 MCP 权限控制。」
// spec §6.6 line 461–464：权限至少覆盖「Git 和 worktree 操作」「命令执行」
//   「网络访问」「MCP 工具」。
// spec §6.6 line 449：禁止的动作 → pre-execute 提前拒绝 + guard 最终复核。
//
// PRT-604 管的是"碰文件"。本模块管**另外三条出去做事的通道**：起进程、发请求、
// 调 MCP 工具。三条通道的共同点：
//
//   > 一个「检查字符串」的权限门，
//   > 与一个「检查完之后字符串才被解释成动作」的权限门，是同一个东西。
//
// 所以每一条规则都是"不解释"：命令必须是**已分词的 argv**，URL 必须用真正的解析器拆，
// MCP 工具名必须**成对**出现。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DANGEROUS_ENV_KEYS,
  EXECUTION_SCOPE_CHECKED,
  EXECUTION_SCOPE_VERSION,
  EXEC_CODES,
  SHELL_METACHARACTERS,
  WRAPPER_PROGRAMS,
  assertCrossHostRedirect,
  assertDangerousEnvRejected,
  assertGrantClosedAndIdempotent,
  assertHostMatchingIsExact,
  assertMcpDoesNotBypass,
  assertMcpPairScoped,
  assertNoShellChaining,
  assertPathProgramRejected,
  assertSubcommandAndFlags,
  assertUrlConfusionRejected,
  assertWrapperDenied,
  checkCommand,
  checkMcp,
  checkNetwork,
  isPrivateV4,
  normalizeGrant,
  parseArgv,
  parseEgressUrl,
  splitMcpTool,
} from './execution-scope.mjs'

const GRANT = normalizeGrant({
  command: {
    programs: [
      { program: 'git', denySubcommands: ['push', 'reset'], denyFlags: ['--force'] },
      { program: 'npm', subcommands: ['test', 'run'] },
      'ls',
      { program: 'sh' },
      { program: 'node', allowsWrapper: true },
    ],
  },
  network: { schemes: ['https'], hosts: ['example.com', 'api.example.com'], ports: [443], methods: ['GET', 'POST'] },
  mcp: { servers: [{ server: 'fs', tools: ['read_file', 'list_dir'] }, { server: 'db', tools: ['query'] }] },
})
const cmd = (argv, over = {}) => checkCommand({ argv, grant: GRANT, platform: 'linux', ...over })
const net = (url, over = {}) => checkNetwork({ url, grant: GRANT, ...over })
const mcp = (tool, over = {}) => checkMcp({ tool, grant: GRANT, ...over })

// ------------------------------------------------- ① 命令：不能把整条命令当一个字符串

test('① ★★ 单一字符串命令**没有资格**被检查（不做分词）', () => {
  //   > 一个「自己做分词」的权限门，
  //   > 与一个「分词结果和执行时不一样」的权限门，是同一个东西。
  //
  // 本模块不做分词，因为"怎么分词"本身就是被攻击的那一环：检查者与执行者的分词器
  // 不一定是同一个。
  const v = cmd('ls')
  assert.equal(v.allowed, false)
  assert.equal(v.code, EXEC_CODES.NOT_TOKENIZED)
  assert.match(v.reason, /已分词的 argv 数组/)
  assert.throws(() => parseArgv({ argv: 'ls', platform: 'linux' }), new RegExp(EXEC_CODES.NOT_TOKENIZED))
  assert.throws(() => parseArgv({ argv: [], platform: 'linux' }), new RegExp(EXEC_CODES.BAD_ARGV))
  assert.throws(() => parseArgv({ argv: ['ls', 3], platform: 'linux' }), new RegExp(EXEC_CODES.BAD_ARGV))
  assert.throws(() => parseArgv({ argv: null, platform: 'linux' }), new RegExp(EXEC_CODES.BAD_ARGV))
})

test('① ★★ 命令拼接：`ls; rm -rf /` 不能在"命中了 ls"的意义上被放行', () => {
  //   > 一个「把整条命令当成一个字符串去匹配白名单」的检查，
  //   > 与一个「`ls; rm -rf /` 命中了 `ls` 这条白名单」的检查，是同一个东西——
  //   > 而它的方向是放行。
  const e = assertNoShellChaining()
  assert.equal(e.rejected.length, 8)
  for (const r of e.rejected) {
    assert.equal(r.allowed, false, `${JSON.stringify(r.single)} 被放行了`)
    assert.equal(r.code, EXEC_CODES.NOT_TOKENIZED, r.single)
  }
  // 证据：字符串形式的命令根本没有被检查的资格
  assert.equal(e.asString, EXEC_CODES.NOT_TOKENIZED)
  // ★ 证据：**朴素分词**（按空白切第一个词）会让其中 **7 条**命中白名单里的 `ls`。
  //   只有 `ls; rm -rf /` 因为第一个词是 `ls;`（带分号）而侥幸不命中。
  //
  //   > 一个「按第一个词匹配就放行」的检查，
  //   > 与一个「7 种拼接写法里有 7 种都放行」的检查，是同一个东西。
  //
  //   这条证据必须挑**能展示危险**的样本：早先取的是
  //   `'ls; rm -rf /'.split(' ')[0]`，得到的结论是 `false`——它恰好证明了相反的事。
  assert.equal(e.naiveWouldAllowCount, 7, `朴素分词只放行了 ${e.naiveWouldAllowCount} 条`)
  assert.equal(e.naiveFirstTokenMatches.length, 7)
  for (const h of e.naiveFirstTokenMatches) assert.equal(h.firstToken, 'ls', h.single)
  // 而 `ls; rm -rf /` 是那唯一一条朴素分词也不命中的 —— 保留它作为对照
  assert.equal(e.rejected.length - e.naiveWouldAllowCount, 1)
  assert.equal(e.rejected.find((r) => r.firstToken === 'ls;').single, 'ls; rm -rf /')
  // 而**正常的**已分词 argv 安静通过 —— 元字符清单不是在拒绝一切
  assert.equal(cmd(['ls', '-la']).allowed, true)
  assert.equal(cmd(['git', 'status', '--short']).allowed, true)
  // 每个元字符单独都要拒绝
  for (const c of SHELL_METACHARACTERS) {
    const v = cmd(['ls', `a${c}b`])
    assert.equal(v.allowed, false, `元字符 ${JSON.stringify(c)} 被放行`)
    assert.equal(v.code, EXEC_CODES.NOT_TOKENIZED)
  }
  assert.equal(SHELL_METACHARACTERS.length, 21)
})

test('① ★★ argv[0] 带路径：`./ls` 与 `ls` 不是同一个东西', () => {
  //   > 一个「按 basename 匹配程序名」的检查，
  //   > 与一个「在工作目录里放一个叫 `rm` 的脚本、然后 `./rm` 就得到了权限」的检查，
  //   > 是同一个东西——而它的方向是放行。
  const e = assertPathProgramRejected()
  assert.equal(e.ok.allowed, true)
  assert.equal(e.relative.allowed, false)
  assert.equal(e.relative.code, EXEC_CODES.RELATIVE_PROGRAM)
  assert.equal(e.absolute.allowed, false, '绝对路径 `/usr/bin/ls` 拿到了 `ls` 的授权')
  assert.equal(e.absolute.code, EXEC_CODES.RELATIVE_PROGRAM)
  // 而显式 allowPath 之后就能过（授权人写下了这个决定）
  assert.equal(e.allowedPath.allowed, true)
  // Windows 上同理：`.\ls.exe` 也要拦
  const win = checkCommand({ argv: ['C:\\tools\\ls.exe'], grant: GRANT, platform: 'win32' })
  assert.equal(win.allowed, false)
  assert.equal(win.code, EXEC_CODES.RELATIVE_PROGRAM)
  // basename 提取：`.exe` 在 win32 上被剥掉
  assert.equal(parseArgv({ argv: ['C:\\tools\\ls.exe'], platform: 'win32' }).basename, 'ls')
  assert.equal(parseArgv({ argv: ['ls'], platform: 'linux' }).hasSeparator, false)
})

test('① ★★ 包装器：白名单里有 `sh` 就等于有任意命令', () => {
  //   > 一个「白名单里有 `sh`」的检查，
  //   > 与一个「白名单里有任意命令」的检查，是同一个东西。
  const e = assertWrapperDenied()
  assert.equal(e.shWithoutWrapperFlag.allowed, false)
  assert.equal(e.shWithoutWrapperFlag.code, EXEC_CODES.WRAPPER_PROGRAM)
  assert.equal(e.nodeWithWrapperFlag.allowed, true, '显式 allowsWrapper 之后应当放行')
  assert.equal(e.wrapperCount, WRAPPER_PROGRAMS.length)
  // 名单里**每一个**在"表里有它、但没有 allowsWrapper"时都要被拒
  for (const w of e.wrappers) {
    assert.equal(w.code, EXEC_CODES.WRAPPER_PROGRAM, w.program)
  }
  // 名单里不能有永远当不上 argv[0] 的东西（shell 内建 `eval`/`exec`/`source`）——
  // 它们是不可达的规则：
  //   > 一个「在名单里但实际上永远匹配不到」的规则，
  //   > 与一条不存在的规则，在"它到底拦住了什么"上是同一个东西。
  assert.deepEqual([...e.builtinsExcluded], [])
  // 而普通程序不受影响
  assert.equal(cmd(['git', 'status']).allowed, true)
})

test('① ★★ 子命令白名单必须**走得到**（包装器规则不能挡在前面）', () => {
  // 这条是装载自检真的抓到的：`npm` 既是包装器、又有子命令白名单。原来的顺序是
  // 包装器先判，于是 `subcommands: ['test','run']` **永远走不到**。
  //
  //   > 一个「被前一道更宽的规则挡住」的规则，
  //   > 与一条不存在的规则，在"它到底拦住了什么"上是同一个东西。
  const e = assertWrapperDenied()
  assert.equal(e.npmWithSubcommandWhitelist.allowed, true, '子命令白名单走不到')
  assert.equal(e.subcommandRuleWins.code, EXEC_CODES.SUBCOMMAND_DENIED, '报的是包装器而不是子命令')
  // ⚠️ 黑名单**不算**收窄：
  //   > 一个「用禁止清单来收窄一个能执行任意东西的程序」的授权，
  //   > 与一个「禁止了 publish 就想当然认为 npm 不能干别的」的授权，是同一个东西——
  //   > 而它的方向是放行。
  assert.equal(e.npmWithDenyListOnly.allowed, false)
  assert.equal(e.npmWithDenyListOnly.code, EXEC_CODES.WRAPPER_PROGRAM)
})

test('① ★★ 子命令与危险开关', () => {
  const e = assertSubcommandAndFlags()
  assert.equal(e.allowSub, true)
  assert.equal(e.badSub.allowed, false)
  assert.equal(e.badSub.code, EXEC_CODES.SUBCOMMAND_DENIED)
  assert.equal(e.gitStatus, true)
  assert.equal(e.gitPush.code, EXEC_CODES.SUBCOMMAND_DENIED)
  assert.equal(e.gitForce.code, EXEC_CODES.FLAG_DENIED)
  assert.equal(e.gitForceEq.code, EXEC_CODES.FLAG_DENIED, '`--force=yes` 绕过了 `--force`')
  // 短开关的粘连形式
  const shortFlag = checkCommand({
    argv: ['git', 'status', '-v'], grant: { command: { programs: [{ program: 'git', denyFlags: ['-v'] }] } }, platform: 'linux',
  })
  assert.equal(shortFlag.code, EXEC_CODES.FLAG_DENIED)
  // 子命令白名单之外
  const outside = checkCommand({
    argv: ['git', 'clean'], grant: { command: { programs: [{ program: 'git', subcommands: ['status'] }] } }, platform: 'linux',
  })
  assert.equal(outside.code, EXEC_CODES.SUBCOMMAND_DENIED)
  // 没有子命令时白名单不误伤（`ls -la` 没有子命令）
  assert.equal(cmd(['ls', '-la']).allowed, true)
  // 未知程序
  assert.equal(cmd(['rm', '-rf', '/']).code, EXEC_CODES.PROGRAM_NOT_ALLOWED)
  // 没有命令授权
  assert.equal(checkCommand({ argv: ['ls'], grant: { command: null }, platform: 'linux' }).code, EXEC_CODES.PROGRAM_NOT_ALLOWED)
})

test('① ★★ 危险环境变量：能设 `LD_PRELOAD` 就等于能执行任意代码', () => {
  //   > 一个「能设 `LD_PRELOAD`」的权限，
  //   > 与一个「可以执行任意代码」的权限，是同一个东西——只不过前者看起来像配置。
  const e = assertDangerousEnvRejected()
  assert.equal(e.count, DANGEROUS_ENV_KEYS.length)
  for (const k of e.keys) assert.equal(k.code, EXEC_CODES.ENV_KEY_DENIED, k.key)
  assert.equal(e.ok, true, '正常的环境变量被误拒')
  // 大小写不敏感（`ld_preload` 在 Linux 上是另一个变量，但 Windows 上不是）
  assert.equal(cmd(['git', 'status'], { envKeys: ['ld_preload'] }).code, EXEC_CODES.ENV_KEY_DENIED)
  // 而它**优先于**程序检查：配置错误先报出来
  assert.equal(cmd(['rm', '-rf', '/'], { envKeys: ['PATH'] }).code, EXEC_CODES.ENV_KEY_DENIED)
})

// ------------------------------------------------- ② 网络：不能做子串匹配

test('② ★★ 域名必须是**整段相等**，不是后缀', () => {
  //   > 一个「用后缀匹配判断域名是否允许」的检查，
  //   > 与一个「`evil-example.com` 也在 `example.com` 白名单里」的检查，
  //   > 是同一个东西——而它的方向是放行。
  const e = assertHostMatchingIsExact()
  assert.deepEqual(e.wrong, [], `有样本判错：${JSON.stringify(e.wrong)}`)
  const byUrl = Object.fromEntries(e.cases.map((c) => [c.url, c]))
  assert.equal(byUrl['https://example.com/a'].allowed, true)
  assert.equal(byUrl['https://api.example.com/a'].allowed, true)
  assert.equal(byUrl['https://evil-example.com/a'].code, EXEC_CODES.SUFFIX_NOT_ENOUGH)
  // `example.com.evil.com` 并不以 `example.com` 结尾 ⇒ 普通的不在名单里（不是"后缀命中"）
  assert.equal(byUrl['https://example.com.evil.com/a'].code, EXEC_CODES.HOST_NOT_ALLOWED)
  assert.equal(byUrl['https://notexample.com/a'].code, EXEC_CODES.SUFFIX_NOT_ENOUGH)
  // FQDN 根点：`example.com.` 与 `example.com` 是同一个位置
  //   > 一个「把 `example.com.` 当成另一个域名」的检查，
  //   > 与一个「FQDN 根点让它绕过白名单」的检查，是同一个东西。
  assert.equal(byUrl['https://example.com./a'].allowed, true)
  assert.equal(byUrl['https://example.com./a'].host, 'example.com')
  // 大小写折叠
  assert.equal(byUrl['https://EXAMPLE.COM/a'].allowed, true)
  // ★ 证据：`includes` 会在**哪三个** URL 上说 yes
  assert.equal(e.textualWouldMatch.filter((t) => t.includesWouldMatch).length, 3)
  for (const t of e.textualWouldMatch) assert.equal(t.includesWouldMatch, true, t.url)
})

test('② ★★ URL 混淆：userinfo / IP 字面量 / 私有网段 / 非 ASCII', () => {
  //   > 一个「用 `url.includes('example.com')` 判断」的检查，
  //   > 与一个「`https://example.com@evil.com/` 被当成 example.com」的检查，
  //   > 是同一个东西——而它的方向是放行。
  const e = assertUrlConfusionRejected()
  assert.equal(e.userinfo.allowed, false)
  assert.equal(e.userinfo.code, EXEC_CODES.USERINFO_PRESENT)
  assert.equal(e.textualWouldMatch[0].includesWouldMatch, true, '`includes` 在 userinfo 那条上说 yes')
  // IP 字面量绕过域名白名单
  //   > 一个「只查域名白名单」的检查，
  //   > 与一个「`http://169.254.169.254/` 走 IP 字面量绕过域名白名单」的检查，
  //   > 是同一个东西——而它的方向是放行。
  assert.equal(e.ipLiteral.code, EXEC_CODES.IP_LITERAL)
  assert.equal(e.ssrf.code, EXEC_CODES.IP_LITERAL, '云元数据地址先走 IP 字面量这一关')
  // 显式允许 IP 字面量之后，私有网段那一关仍然拦得住
  assert.equal(e.ssrfWithLiteralsAllowed.code, EXEC_CODES.PRIVATE_ADDRESS)
  assert.equal(isPrivateV4('169.254.169.254'), true)
  assert.equal(isPrivateV4('10.0.0.1'), true)
  assert.equal(isPrivateV4('172.16.0.1'), true)
  assert.equal(isPrivateV4('172.32.0.1'), false)
  assert.equal(isPrivateV4('127.0.0.1'), true)
  assert.equal(isPrivateV4('93.184.216.34'), false)
  // 非 ASCII 域名
  assert.equal(e.cyrillic.code, EXEC_CODES.NON_ASCII_HOST)
  // ★ 而这条检查为什么从前**从不触发**：解析器把域名 punycode 掉了
  //
  //   > 一个「在解析之后才检查非 ASCII」的检查，
  //   > 与一个「解析器已经悄悄把它们转掉了、所以这条检查从不触发」的检查，
  //   > 是同一个东西。
  assert.equal(e.cyrillicParser.rawAuthority, '\u0435xample.com')
  assert.equal(e.cyrillicParser.nonAscii, '\u0435')
  assert.equal(e.cyrillicParser.host, 'xn--xample-2of.com')
  assert.equal(e.cyrillicParser.punycoded, 'xn--xample-2of.com')
  assert.equal(e.cyrillicParser.nonAsciiInParsedHost, null, '解析后的 hostname 里已经没有那个字符了')
  // 协议
  assert.equal(e.scheme.code, EXEC_CODES.SCHEME_DENIED)
  // 端口
  assert.equal(net('https://example.com:8443/a').code, EXEC_CODES.PORT_DENIED)
  assert.equal(net('https://example.com:443/a').allowed, true)
  // 方法
  assert.equal(net('https://example.com/a', { method: 'DELETE' }).allowed, false)
  assert.equal(net('https://example.com/a', { method: 'POST' }).allowed, true)
  // 没有网络授权
  assert.equal(checkNetwork({ url: 'https://example.com/a', grant: { network: null } }).code, EXEC_CODES.SCHEME_DENIED)
  // 空 host 白名单 = 什么都不许出网
  assert.equal(checkNetwork({ url: 'https://example.com/a', grant: { network: { schemes: ['https'], hosts: [] } } }).code, EXEC_CODES.HOST_NOT_ALLOWED)
  // URL 解析不了
  assert.equal(net('not a url').code, EXEC_CODES.BAD_URL)
  assert.throws(() => parseEgressUrl({ url: '' }), new RegExp(EXEC_CODES.BAD_URL))
})

test('② ★★ 跨域名重定向要**再判一次**', () => {
  //   > 一个「只在第一次请求时检查 host」的策略，
  //   > 与一个「跟随一次 302 就出去了」的策略，是同一个东西。
  const e = assertCrossHostRedirect()
  assert.equal(e.sameHost.allowed, true)
  assert.equal(e.crossNotInList.allowed, false)
  // 目标不在白名单里时，**先**被主机检查拦下（这是对的，也更具体）
  assert.equal(e.crossNotInList.code, EXEC_CODES.HOST_NOT_ALLOWED)
  // ★ 关键：目标**在**白名单里、但与原 host 不同 ⇒ 走重定向这一关
  assert.equal(e.crossInList.allowed, false, '跨域跳转没被拦')
  assert.equal(e.crossInList.code, EXEC_CODES.CROSS_HOST_REDIRECT)
  // 显式允许之后才能过
  assert.equal(e.crossExplicitlyAllowed.allowed, true)
  // 尾点/大小写不影响"同一个 host"的判定
  assert.equal(net('https://example.com/b', { redirectFrom: 'EXAMPLE.COM.' }).allowed, true)
})

// ------------------------------------------------- ③ MCP：必须成对

test('③ ★★ MCP 工具名必须**成对**，分隔符恰好一个', () => {
  //   > 一个「只按工具名授权 MCP 工具」的检查，
  //   > 与一个「任意一个 MCP server 暴露同名工具就得到权限」的检查，是同一个东西——
  //   > 而它的方向是放行。
  assert.deepEqual({ ...splitMcpTool({ raw: 'fs__read_file' }) }, { server: 'fs', tool: 'read_file', raw: 'fs__read_file', key: 'fs__read_file' })
  // 恰好一个分隔符：`a__b__c` 有歧义
  //   > 一个「按第一个 `__` 切分」的检查，
  //   > 与一个「server 名里带 `__` 就能伪装成另一个 server」的检查，是同一个东西。
  assert.throws(() => splitMcpTool({ raw: 'a__b__read_file' }), new RegExp(EXEC_CODES.MCP_AMBIGUOUS_NAME))
  assert.throws(() => splitMcpTool({ raw: 'read_file' }), new RegExp(EXEC_CODES.MCP_AMBIGUOUS_NAME))
  assert.throws(() => splitMcpTool({ raw: 'fs__' }), new RegExp(EXEC_CODES.MCP_AMBIGUOUS_NAME))
  assert.throws(() => splitMcpTool({ raw: 'fs__a b' }), new RegExp(EXEC_CODES.MCP_AMBIGUOUS_NAME))
  assert.throws(() => splitMcpTool({ raw: '' }), new RegExp(EXEC_CODES.MCP_NOT_NAMESPACED))
  // 分段字符集
  assert.throws(() => splitMcpTool({ raw: 'fs/../x__read' }), new RegExp(EXEC_CODES.MCP_AMBIGUOUS_NAME))
  // ★ 伪装：server 名叫 `fs__read` 时，`fs__read_file` 不能被当成 server `fs`
  const spoof = checkMcp({ tool: 'fs__read_file', grant: { mcp: { servers: [{ server: 'fs__read', tools: ['file'] }] } } })
  assert.equal(spoof.allowed, false)
})

test('③ ★★ 同一个工具名在两个 server 上是**两个**工具', () => {
  const e = assertMcpPairScoped()
  assert.equal(e.onFs.allowed, true)
  // `db` 只授权了 `query`，所以 `db__read_file` 必须拒绝
  assert.equal(e.onDb.allowed, false, '同名工具在另一个 server 上被放行了')
  assert.equal(e.onDb.code, EXEC_CODES.MCP_TOOL_DENIED)
  assert.equal(e.bare.code, EXEC_CODES.MCP_AMBIGUOUS_NAME)
  assert.equal(e.ambiguous.code, EXEC_CODES.MCP_AMBIGUOUS_NAME)
  assert.equal(e.spoof.allowed, false)
  assert.equal(e.unknownServer.code, EXEC_CODES.MCP_SERVER_DENIED)
  assert.equal(e.deniedTool.code, EXEC_CODES.MCP_TOOL_DENIED)
  // 工具白名单为空 ⇒ 什么都没授权
  assert.equal(checkMcp({ tool: 'fs__read_file', grant: { mcp: { servers: [{ server: 'fs', tools: [] }] } } }).code, EXEC_CODES.MCP_TOOL_DENIED)
  assert.equal(checkMcp({ tool: 'fs__read_file', grant: { mcp: { servers: ['fs'] } } }).code, EXEC_CODES.MCP_TOOL_DENIED)
  assert.equal(checkMcp({ tool: 'fs__read_file', grant: { mcp: null } }).code, EXEC_CODES.MCP_SERVER_DENIED)
})

test('③ ★★ MCP 授权**不能**绕过路径与网络范围', () => {
  //   > 一个「拿到 MCP 工具授权就等于绕过路径与网络范围」的实现，
  //   > 与一个「装一个 MCP server 就能读整块磁盘」的实现，是同一个东西——
  //   > 只不过前者看起来像"这个岗位可以用这个工具"。
  const e = assertMcpDoesNotBypass()
  assert.equal(e.noVerdicts.allowed, true)
  assert.equal(e.badPath.allowed, false)
  assert.equal(e.badPath.code, EXEC_CODES.MCP_BYPASS)
  assert.match(e.badPath.reason, /path-scope-outside-write/)
  assert.match(e.badPath.reason, /额外收窄/)
  assert.equal(e.badNet.allowed, false)
  assert.equal(e.badNet.code, EXEC_CODES.MCP_BYPASS)
  assert.match(e.badNet.reason, /exec-scope-host-not-allowed/)
  assert.equal(e.bothGood.allowed, true)
  // ★ 与 PRT-604 真的接起来：一个越界的路径判定会把被授权的 MCP 工具拦下
  const real = checkMcp({
    tool: 'fs__read_file', grant: GRANT,
    pathVerdict: { allowed: false, code: 'path-scope-outside-write', reason: '目标在写范围之外（path-scope-outside-write）' },
  })
  assert.equal(real.allowed, false)
  assert.equal(real.code, EXEC_CODES.MCP_BYPASS)
})

// ------------------------------------------------- ④ 授权表

test('④ ★★ 授权表字段闭合、版本校验、幂等', () => {
  const e = assertGrantClosedAndIdempotent()
  assert.equal(e.unknownCode, EXEC_CODES.BAD_GRANT)
  assert.equal(e.versionCode, EXEC_CODES.BAD_GRANT)
  assert.equal(e.idempotent, true, '归一化不接受自己的输出')
  assert.equal(e.version, EXECUTION_SCOPE_VERSION)
  assert.equal(e.emptyHosts, 0)
  assert.throws(() => normalizeGrant(null), new RegExp(EXEC_CODES.BAD_GRANT))
  assert.throws(() => normalizeGrant({ denyPaths: [] }), /不认识的字段/)
  assert.throws(() => normalizeGrant({ version: 'legion/execution-scope@0' }), /version/)
  // ⚠️ 带正确 version 的表**也**要重新校验（不能靠 version 字段跳过）
  //   > 一个「看到 version 字段就认为它已经校验过」的校验，
  //   > 与一个「在授权表里写一行 version 就能跳过所有检查」的校验，是同一个东西。
  assert.throws(() => normalizeGrant({ version: EXECUTION_SCOPE_VERSION, command: { programs: [{}] } }), /空项/)
  assert.throws(() => normalizeGrant({ command: { programs: 'ls' } }), /必须是数组/)
  assert.throws(() => normalizeGrant({ network: { hosts: null } }), /必须是数组/)
  assert.throws(() => normalizeGrant({ mcp: { servers: null } }), /必须是数组/)
  // 幂等：二次归一化之后内容一致
  const twice = normalizeGrant(normalizeGrant(GRANT))
  assert.deepEqual(twice.network.hosts, [...GRANT.network.hosts])
  assert.deepEqual(twice.command.programs.length, GRANT.command.programs.length)
})

// ------------------------------------------------- ⑤ 装载时证据

test('⑤ ★★ 装载时留下的证据都是**算出来的产物**', () => {
  const e = EXECUTION_SCOPE_CHECKED
  assert.equal(e.version, EXECUTION_SCOPE_VERSION)
  assert.equal(e.metacharacters.length, SHELL_METACHARACTERS.length)
  assert.equal(e.wrappers.length, e.wrapper.wrapperCount)
  assert.equal(e.dangerousEnv.length, e.env.count)
  // 命令
  assert.equal(e.chaining.rejected.filter((r) => !r.allowed).length, 8)
  assert.equal(e.chaining.naiveWouldAllowCount, 7)
  assert.equal(e.chaining.asString, EXEC_CODES.NOT_TOKENIZED)
  assert.equal(e.pathProgram.relative.code, EXEC_CODES.RELATIVE_PROGRAM)
  assert.equal(e.pathProgram.allowedPath.allowed, true)
  assert.equal(e.wrapper.npmWithSubcommandWhitelist.allowed, true)
  assert.equal(e.wrapper.subcommandRuleWins.code, EXEC_CODES.SUBCOMMAND_DENIED)
  assert.deepEqual([...e.wrapper.builtinsExcluded], [])
  assert.equal(e.subcommand.gitForceEq.code, EXEC_CODES.FLAG_DENIED)
  assert.equal(e.env.ok, true)
  // 网络
  assert.deepEqual(e.host.wrong, [])
  assert.equal(e.host.textualWouldMatch.every((t) => t.includesWouldMatch), true)
  assert.equal(e.urlConfusion.userinfo.code, EXEC_CODES.USERINFO_PRESENT)
  assert.equal(e.urlConfusion.cyrillic.code, EXEC_CODES.NON_ASCII_HOST)
  assert.equal(e.urlConfusion.cyrillicParser.nonAsciiInParsedHost, null)
  assert.equal(e.urlConfusion.ssrfWithLiteralsAllowed.code, EXEC_CODES.PRIVATE_ADDRESS)
  assert.equal(e.redirect.crossInList.code, EXEC_CODES.CROSS_HOST_REDIRECT)
  // MCP
  assert.equal(e.mcpPair.onDb.code, EXEC_CODES.MCP_TOOL_DENIED)
  assert.equal(e.mcpPair.spoof.allowed, false)
  assert.equal(e.mcpBypass.badPath.code, EXEC_CODES.MCP_BYPASS)
  assert.equal(e.mcpBypass.bothGood.allowed, true)
  // 授权表
  assert.equal(e.grant.idempotent, true)
  assert.equal(e.grant.unknownCode, EXEC_CODES.BAD_GRANT)
  // 证据自身必须自洽：wrapper 表里每一项都在名单里
  assert.equal(e.wrapper.wrappers.every((w) => WRAPPER_PROGRAMS.includes(w.program)), true)
  // 码清单里没有重复值
  const codes = Object.values(EXEC_CODES)
  assert.equal(new Set(codes).size, codes.length, '有重复的错误码')
})
