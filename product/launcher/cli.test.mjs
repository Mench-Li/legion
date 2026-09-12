// product/launcher/cli.test.mjs
// ============================================================================
// PRT-251 命令行入口的判据。
//
// CLI 层最容易出的两类问题是「参数解析」与「退出码」：
//   - `--port.team-hub=abc` 若被静默忽略，用户会以为端口改了，实际没有；
//   - 失败返回 0 会让脚本化的启动流程把「起不来」当成「起好了」。
// 这两类都不抛异常，因此必须有用例盯着。
//
// `run()` 全程不碰真实进程与真实信号：`write` 注入、`waitForSignal: false`，
// 且只用 `--check` 或参数错误这两种不启动进程的路径。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_FLAGS, EXIT_CODES, defaultInstallDir, launcherOptionsFrom, parseArgs, readEnv, readReadinessTimeoutMs, run } from './cli.mjs'
import { reserveEphemeralPort } from './ports.mjs'

/** 收集输出的收集器。 */
function collector() {
  const lines = []
  return { lines, write: (m) => lines.push(String(m)), text: () => lines.join('\n') }
}

function envFor(root) {
  return {
    LEGION_HOME: root,
    LEGION_INSTALL_DIR: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    LEGION_DATA_DIR: join(root, 'data'),
    LEGION_WORKSPACE_DIR: join(root, 'ws'),
  }
}

test('parseArgs：只接受 --k=v，位置参数与未知参数都被点名拒绝', () => {
  assert.deepEqual(parseArgs([]).errors, [])
  const ok = parseArgs(['--install-dir=C:\\L', '--port.team-hub=9000', '--include=a,b', '--check'])
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.flags['install-dir'], 'C:\\L')
  assert.equal(ok.ports['team-hub'], 9000)
  assert.equal(ok.flags.include, 'a,b')
  assert.equal(ok.flags.check, true)

  const positional = parseArgs(['start'])
  assert.equal(positional.errors.length, 1)
  assert.match(positional.errors[0], /无法识别的参数「start」/)

  const unknown = parseArgs(['--gizmo=1'])
  assert.match(unknown.errors[0], /未知参数「--gizmo」/)

  const badPort = parseArgs(['--port.team-hub=abc'])
  assert.match(badPort.errors[0], /不是合法端口/)
  assert.equal('team-hub' in badPort.ports, false, '非法端口不得被静默丢弃成一个键')
})

test('readEnv：逐字读取七个 LEGION_* 布局键（供 scan --check 列出读取点）', () => {
  const env = readEnv({
    LEGION_HOME: '/h', LEGION_INSTALL_DIR: '/i', LEGION_DATA_DIR: '/d', LEGION_WORKSPACE_DIR: '/w',
    LEGION_CACHE_DIR: '/c', LEGION_LOG_DIR: '/l', LEGION_PRODUCT_CONFIG: '/p',
    TEAM_HUB_PORT: '9000', // 不属于本进程读取面
  })
  assert.deepEqual(Object.keys(env).sort(), [
    'LEGION_CACHE_DIR', 'LEGION_DATA_DIR', 'LEGION_HOME', 'LEGION_INSTALL_DIR',
    'LEGION_LOG_DIR', 'LEGION_PRODUCT_CONFIG', 'LEGION_WORKSPACE_DIR',
  ])
  assert.equal('TEAM_HUB_PORT' in env, false)
})

test('readReadinessTimeoutMs：非法值回落为「未设置」而不是变成一个诡异的超时', () => {
  assert.equal(readReadinessTimeoutMs({}), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: 'abc' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '-5' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '1500' }), 1500)
})

test('--help：列出全部支持的参数（帮助与实现同源，不会各自漂移）', async () => {
  const out = collector()
  const code = await run({ argv: ['--help'], env: {}, write: out.write })
  assert.equal(code, 0)
  assert.match(out.text(), /Legion Launcher/)
  for (const f of CLI_FLAGS) assert.ok(out.text().includes(f.name), `帮助里缺少 ${f.name}`)
})

test('参数错误返回退出码 2，且不启动任何进程', async () => {
  const out = collector()
  const code = await run({ argv: ['--nope=1'], env: {}, write: out.write })
  assert.equal(code, 2)
  assert.match(out.text(), /未知参数/)
})

test('布局未确定（未给工作区）返回退出码 3，并把原因说清楚', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const out = collector()
    // 刻意不给 LEGION_WORKSPACE_DIR：工作区是用户授权的目录，产品不提供默认值
    const code = await run({
      argv: [],
      env: { LEGION_HOME: root, LEGION_INSTALL_DIR: process.cwd(), LEGION_DATA_DIR: join(root, 'data') },
      write: out.write,
    })
    assert.equal(code, 3)
    assert.match(out.text(), /工作区/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check 通过时返回 0；端口被占用时返回 4 并点名进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  const { createServer } = await import('node:net')
  const server = createServer()
  const port = await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server.address().port)))
  try {
    const ok = collector()
    const freePort = await reserveEphemeralPort()
    const codeOk = await run({
      argv: [`--port.team-hub=${freePort}`, '--include=team-hub', '--check'],
      env: envFor(root),
      write: ok.write,
    })
    assert.equal(codeOk, 0, ok.text())
    assert.match(ok.text(), /启动前体检通过/)

    const bad = collector()
    const codeBad = await run({
      argv: [`--port.team-hub=${port}`, '--include=team-hub', '--check'],
      env: envFor(root),
      write: bad.write,
    })
    assert.equal(codeBad, 4)
    assert.match(bad.text(), /端口/)
    assert.match(bad.text(), /team-hub/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check --json：输出机器可读结论（供验收脚本使用）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const out = collector()
    const port = await reserveEphemeralPort()
    const code = await run({
      argv: [`--port.team-hub=${port}`, '--include=team-hub', '--check', '--json'],
      env: envFor(root),
      write: out.write,
    })
    assert.equal(code, 0)
    const parsed = JSON.parse(out.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.phase, null)
    // 受限范围的提醒必须出现在 JSON 里，而不是只出现在人读的文案里
    assert.ok(parsed.diagnostics.some((d) => d.code === 'PROCESS_EXCLUDED_BY_SCOPE'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('defaultInstallDir：默认安装目录就是 Launcher 自己所在的那棵树', () => {
  // 没有这个默认值，「双击启动」的第一个动作（初始化）会因为
  // INSTALL_DIR_UNRESOLVED 报错——而 Launcher 恰好是唯一知道答案的那一方。
  const dir = defaultInstallDir()
  assert.equal(existsSync(join(dir, 'product', 'launcher', 'cli.mjs')), true, dir)
})

test('--init：在真实文件系统上建目录、写默认配置与元数据，返回 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const out = collector()
    const code = await run({
      argv: [`--workspace=${ws}`, '--init'],
      env: { LEGION_HOME: root, LEGION_DATA_DIR: join(root, 'data') },
      write: out.write,
    })
    assert.equal(code, EXIT_CODES.ok, out.text())
    assert.match(out.text(), /初始化完成/)
    assert.equal(existsSync(join(root, 'data', 'product.config.json')), true)
    assert.equal(existsSync(join(root, 'data', 'product.json')), true)
    assert.equal(existsSync(join(root, 'data', 'team-hub')), true)
    // 写下的配置必须是**能被自己读懂**的：初始化与读取用的是同一份格式
    assert.equal(JSON.parse(readFileSync(join(root, 'data', 'product.config.json'), 'utf8')).runtime.command, '')

    // 幂等：第二次不得覆盖用户后来写进去的东西
    writeFileSync(join(root, 'data', 'product.config.json'), JSON.stringify({ runtime: { command: 'node x.mjs' } }))
    const out2 = collector()
    const code2 = await run({ argv: [`--workspace=${ws}`, '--init'], env: { LEGION_HOME: root, LEGION_DATA_DIR: join(root, 'data') }, write: out2.write })
    assert.equal(code2, 0)
    assert.equal(JSON.parse(readFileSync(join(root, 'data', 'product.config.json'), 'utf8')).runtime.command, 'node x.mjs')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--init --dry-run：报告将创建什么，但一个目录都不落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const out = collector()
    const code = await run({
      argv: [`--workspace=${ws}`, '--init', '--dry-run', '--json'],
      env: { LEGION_HOME: root, LEGION_DATA_DIR: join(root, 'data') },
      write: out.write,
    })
    assert.equal(code, EXIT_CODES.ok, out.text())
    const parsed = JSON.parse(out.text())
    assert.equal(parsed.dryRun, true)
    assert.ok(parsed.created.length >= 8, 'dry-run 也要说明将会创建什么')
    assert.deepEqual(parsed.files.map((f) => f.role).sort(), ['product-config', 'product-meta'])
    assert.equal(existsSync(join(root, 'data')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--init：工作区不存在时返回 7，且不替用户创建（也不留半个目录树）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const missing = join(root, 'user-has-not-chosen-yet')
    const out = collector()
    const code = await run({
      argv: [`--workspace=${missing}`, '--init'],
      env: { LEGION_HOME: root, LEGION_DATA_DIR: join(root, 'data') },
      write: out.write,
    })
    assert.equal(code, EXIT_CODES.init)
    assert.equal(existsSync(missing), false, '不得替用户创建项目目录')
    // DataDir 已建好：工作区是**用户要先解决的事**，不是拒绝初始化的理由
    assert.equal(existsSync(join(root, 'data')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('配置文件坏掉时返回退出码 6，并说明「否则所有值会悄悄退回默认值」', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'product.config.json'), '{ "ports": { "team-hub": 8000, } }')
    const out = collector()
    const code = await run({ argv: [`--workspace=${ws}`, '--check'], env: envFor(root), write: out.write })
    assert.equal(code, EXIT_CODES.config, out.text())
    assert.match(out.text(), /产品配置有问题/)
    assert.match(out.text(), /CONFIG_INVALID_JSON/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('配置文件提供 runtime.command 后，runtime 入口不再报 ENTRY_UNRESOLVED', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(root, 'data'), { recursive: true })
    const env = envFor(root)

    const before = launcherOptionsFrom({ argv: [], env })
    assert.equal(before.options.runtimeCommand, null)
    assert.equal(before.config.ok, true)

    writeFileSync(join(root, 'data', 'product.config.json'), JSON.stringify({ runtime: { command: 'node runtime/index.mjs' }, ports: { 'team-hub': 8123 } }))
    const after = launcherOptionsFrom({ argv: [], env })
    assert.equal(after.config.ok, true)
    assert.equal(after.options.runtimeCommand, 'node runtime/index.mjs')
    assert.equal(after.options.ports['team-hub'], 8123)

    // 命令行仍然压得过配置文件（「就这一次」必须做得到）
    const overridden = launcherOptionsFrom({ argv: ['--port.team-hub=9001', '--runtime-command=node other.mjs'], env })
    assert.equal(overridden.options.ports['team-hub'], 9001)
    assert.equal(overridden.options.runtimeCommand, 'node other.mjs')

    // --no-config：显式忽略配置文件（排障时用来回答「是不是配置的问题」）
    const noConfig = launcherOptionsFrom({ argv: ['--no-config'], env })
    assert.equal(noConfig.options.ports['team-hub'], undefined)
    assert.equal(noConfig.options.runtimeCommand, null)

    // 坏配置在**创建 Launcher 之前**就被报出来，而不是启动到一半才失败
    writeFileSync(join(root, 'data', 'product.config.json'), '{ 坏')
    const broken = launcherOptionsFrom({ argv: [], env })
    assert.equal(broken.config.ok, false)
    assert.ok(broken.configDiagnostics.some((d) => d.code === 'CONFIG_INVALID_JSON'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EXIT_CODES：退出码是契约（0 成功 / 2 参数 / 3 布局 / 4 体检 / 5 启动 / 6 配置 / 7 初始化）', () => {
  assert.deepEqual({ ...EXIT_CODES }, { ok: 0, args: 2, layout: 3, check: 4, start: 5, config: 6, init: 7 })
})

// 说明：这里**故意没有**「受限范围下启动真实进程并检查状态」的用例。
// `run()` 的启动路径会一直持有子进程直到收到信号，从用例里调用它只能靠
// 泄漏一个 team-hub 进程来收场。受限范围的状态语义因此放在
// `launcher.test.mjs`（直接构造 Launcher，用完显式 stop）里断言。

// ============================================================================
// PRT-709：日志策略必须从配置文件**走到 launcher 的选项里**
//
// 这一条守的是"接没接上"。`launcherInputFromConfig` 派生出了 `logPolicy`、
// `createLauncher` 也接受它——但中间那一跳（CLI 组装 `options`）如果漏了，
// 用户改了配置会发现"改了没用"，而两边各自的用例都是绿的。
//
//   > 「没接」与「没做」是两个不同的问题，
//   > 而它们在"用户改了配置有没有用"上给出同一个答案。
// ============================================================================

test('logPolicy：配置文件里的 `log.*` 会出现在 launcher 选项里', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-clilog-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'product.config.json'), JSON.stringify({
      log: { maxFileBytes: 2048, keepFiles: 3 },
    }))
    const { options } = launcherOptionsFrom({ argv: [], env: envFor(root) })
    assert.deepEqual(options.logPolicy, { maxFileBytes: 2048, keepFiles: 3 },
      '配置里的 log.* 没有走到 launcher 选项里：用户改了会发现「改了没用」')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('logPolicy：配置文件没写 `log.*` 时是空对象，**不是** undefined', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-clilog-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'product.config.json'), JSON.stringify({ runtime: { command: '' } }))
    const { options } = launcherOptionsFrom({ argv: [], env: envFor(root) })
    // `createLauncher` 的默认值是 `{}`，`validateLogPolicy({})` 落到 DEFAULT_LOG_POLICY。
    // 传 undefined 也能工作，但断言 `{}` 能把"这里应当有一个对象"这件事钉住。
    assert.deepEqual(options.logPolicy, {})
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ============================================================================
// CLI_FLAGS 与 parseArgs 的**一致性**
//
// 这一组守的是一个**刚刚真的踩过的**坑：`parseArgs` 里原本有两份手工维护的
// 名单（布尔开关一份、取值开关一份），而 `--help` 的正文是第三处 `CLI_FLAGS`。
// 加 `--sweep-orphans` 时我只改了 `CLI_FLAGS`，于是它在 `--help` 里写着、
// 用起来却是「无法识别的参数」。
//
// 原来那份代码的注释甚至写着：「新开关漏加会让它被当成未知参数」——
// 警告的正是这件事，而写注释的人（我）照样漏了。
//
//   > 一份要写两处的名单，第二处总有一天会忘。
//   > 一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
//   > 在"新加的开关能不能用"上是同一个东西。
//
// 现在两份名单都从 `CLI_FLAGS` 派生。下面这条断言把"派生"这件事钉住：
// 不管实现怎么改，**声明了的就必须能用**。
// ============================================================================

test('CLI_FLAGS 里声明的每一个开关，parseArgs 都必须接受', () => {
  for (const f of CLI_FLAGS) {
    const isPort = f.name.startsWith('--port.')
    if (isPort) continue
    const argv = f.kind === 'boolean'
      ? [f.name]
      : [`${f.name.replace(/=<.*>$/, '')}=x`]
    const r = parseArgs(argv)
    assert.deepEqual(r.errors, [],
      `${f.name} 在 --help 里写着、却用不了：${JSON.stringify(r.errors)}。` +
      '「文档里写的」与「能用的」分成两件事，等于文档在骗人')
  }
})

test('CLI_FLAGS 里声明的开关，报错信息里也要列全（用户唯一能看到的线索）', () => {
  const { errors } = parseArgs(['--nonsense'])
  assert.equal(errors.length, 1)
  for (const f of CLI_FLAGS) {
    if (f.kind !== 'boolean' || f.name.includes('=')) continue
    assert.ok(errors[0].includes(f.name),
      `报错信息里没列 ${f.name}：那句硬编码的"支持 --check/--json/--help"` +
      '已经与真实名单不一致过一次了')
  }
})
