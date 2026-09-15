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
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_FLAGS, EXIT_CODES, RUNTIME_INSTALL_CLI_EXIT, RUNTIME_PLAN_CODES, defaultInstallDir, dshCredentialsFileFrom, launcherOptionsFrom, parseArgs, readEnv, readReadinessTimeoutMs, run, underNodeTestRunner } from './cli.mjs'
import { COMPLETION_MARKER_FILENAME, installRuntime, planRuntimeInstall, readActiveRuntime, runtimeRootOf } from './runtime-install.mjs'
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

// ═══════════════════════════════════════════════ --doctor（PRT-257 修复入口）
//
// `line 275` 要的是「禁止自动执行，**提示修复或回滚**」。`repairPlanFor()` 早就
// 算得出修法，而 `product/launcher/` 里对它的引用次数曾经是 **0** ——
// 这一组钉的就是"那个出口真的在命令行上"。
//
// ★ 三个退出码必须分开，其中**"没诊断"绝不能是 0**：
//   一个"读不到结论所以什么都没报"的体检，与一个"结论是一切正常"的体检，
//   在退出码上是同一个东西——而前者会让一个已经坏掉的部署安静地通过门禁。

test('★ --doctor：stdin 上有一份「未生效」的拒绝 → 退出 1，并列出逐项修法', async () => {
  const out = collector()
  const refusal = {
    code: 'RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE',
    state: 'incompatible',
    autoExecutionForbidden: true,
    patchVersion: 'prt-chain-1',
    reasons: ['缺必需能力：tool-permission-enforcement'],
    repair: {
      ok: false,
      items: [{
        check: 'sandbox-enforcement', action: 'fix-sandbox-backend',
        label: '修好沙箱后端到 full 级管制', why: 'partial 意味着存在不被管制的路径', reasons: ['sandbox-partial'],
      }],
    },
  }
  const code = await run({ argv: ['--doctor'], env: {}, write: out.write, readStdinFn: async () => JSON.stringify(refusal) })
  assert.equal(code, 1, `未生效的诊断必须退 1：\n${out.text()}`)
  const text = out.text()
  assert.match(text, /DOCTOR_ACTIONABLE/)
  assert.match(text, /sandbox-enforcement/)
  assert.match(text, /fix-sandbox-backend/, '生产修法表里的动作名要落到输出上')
  assert.match(text, /自动执行已禁止/, '操作后果要先说清楚')
  assert.match(text, /回滚/, 'line 275 是「提示修复**或**回滚」，回滚那条路总要在')
})

test('★★★ --doctor：stdin **空** → 退出 **3**，绝不是 0', async () => {
  const out = collector()
  const code = await run({ argv: ['--doctor'], env: {}, write: out.write, readStdinFn: async () => '' })
  assert.equal(code, 3, `读不到诊断却退 0 —— 那会让接线遗漏看起来像体检通过：\n${out.text()}`)
  assert.match(out.text(), /DOCTOR_NO_DIAGNOSIS/)
  assert.match(out.text(), /这不等于"一切正常"/)
})

test('★★★ --doctor：stdin 上是**畸形 JSON** → 退出 3（当"没有诊断"，不猜也不崩）', async () => {
  const out = collector()
  const code = await run({ argv: ['--doctor'], env: {}, write: out.write, readStdinFn: async () => '{ 这不是 JSON' })
  assert.equal(code, 3)
  assert.match(out.text(), /DOCTOR_NO_DIAGNOSIS/)
})

test('★★★ --doctor：stdin 读入**抛错** → 退出 3，且把读失败的原因带出来', async () => {
  const out = collector()
  const code = await run({
    argv: ['--doctor'], env: {}, write: out.write,
    readStdinFn: async () => { throw new Error('EIO 管道断了') },
  })
  assert.equal(code, 3)
  assert.match(out.text(), /EIO 管道断了/, '读失败的原因必须读得到，否则用户只会看到一个 3')
})

test('★ --doctor：自检全过 → 退出 0（唯一一个 0）', async () => {
  const out = collector()
  const code = await run({
    argv: ['--doctor'], env: {}, write: out.write,
    readStdinFn: async () => JSON.stringify({ ok: true, items: [{ check: 'a', ok: true }] }),
  })
  assert.equal(code, 0)
  assert.match(out.text(), /DOCTOR_CLEAN/)
})

test('★ --doctor：拒绝说了「未生效」却没带修法 → 退出 3，并指出那是**产品侧缺口**', async () => {
  const out = collector()
  const code = await run({
    argv: ['--doctor'], env: {}, write: out.write,
    readStdinFn: async () => JSON.stringify({ autoExecutionForbidden: true, state: 'incompatible', reasons: ['x-code'], repair: null }),
  })
  assert.equal(code, 3, '说不出怎么修，就不能退 0 也不能退 1')
  assert.match(out.text(), /DOCTOR_NO_PLAN/)
  assert.match(out.text(), /产品侧的缺口/)
})

test('★ --doctor --json：输出是**可脚本化**的 JSON，退出码照旧', async () => {
  const out = collector()
  const code = await run({
    argv: ['--doctor', '--json'], env: {}, write: out.write,
    readStdinFn: async () => JSON.stringify({ autoExecutionForbidden: true, state: 'incompatible', repair: { ok: false, items: [{ check: 'runtime-probe', action: 'a', label: 'b', why: 'c', reasons: [] }] } }),
  })
  assert.equal(code, 1)
  const parsed = JSON.parse(out.text())
  assert.equal(parsed.code, 'DOCTOR_ACTIONABLE')
  assert.equal(parsed.exitCode, 1)
  assert.equal(parsed.items.length, 1)
  // JSON 里不得出现不可序列化的东西（`Object.freeze` 的数组要照常序列化）。
  assert.equal(Array.isArray(parsed.lines), true)
})

test('★ --doctor：帮助里列出了这个参数（帮助与实现同源）', async () => {
  const out = collector()
  await run({ argv: ['--help'], env: {}, write: out.write })
  assert.match(out.text(), /--doctor/)
  assert.match(out.text(), /只提示、不自动改/, '"不自动改"这条取舍要写在帮助里，否则下一个人会顺手把它自动化')
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

// ═══════════════════════════════════════════════════════════════════════════
// DSH 只读回退来源的路径解析（PRT-509 路线 A′）
// ═══════════════════════════════════════════════════════════════════════════
//
// 这一组守的是**边界**，不是读取器（读取器有它自己的 162 例）：
//   · `DSH_HOME` 是唯一来源，**不猜路径**；
//   · `DSH_HOME` 未设 ⇒ 不接（`null`），与"设了但文件不在"是两件事；
//   · `--no-dsh-credentials` 能显式关掉。
//
// 为什么"不猜路径"值得一条用例：猜路径会读完**另一个账户**留下的凭证文件
// ——用户不知道它存在，也没同意过读它。

test('DSH_HOME 决定回退来源的路径；未设就是 null（不猜路径）', () => {
  assert.equal(dshCredentialsFileFrom({}), null)
  assert.equal(dshCredentialsFileFrom({ DSH_HOME: '' }), null)
  assert.equal(dshCredentialsFileFrom({ DSH_HOME: '   ' }), null)
  assert.equal(dshCredentialsFileFrom({ DSH_HOME: join('C:', 'Users', 'alice', '.dsh') }),
    join('C:', 'Users', 'alice', '.dsh', '.credentials.yaml'))
  // ★ 反面对照：`USERPROFILE` / `HOME` 存在也**不**去猜 `~/.dsh`。
  //   少了这一条，一个"翻几个候选位置"的实现照样能绿。
  assert.equal(dshCredentialsFileFrom({ USERPROFILE: join('C:', 'Users', 'alice'), HOME: '/home/alice' }), null)
})

test('★ --no-dsh-credentials 显式关掉回退来源（读别人的文件应当可以被拒绝）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-dsh-'))
  try {
    mkdirSync(join(root, 'ws'), { recursive: true })
    const dshHome = join('C:', 'Users', 'alice', '.dsh')
    const env = { ...envFor(root), DSH_HOME: dshHome }

    // 默认：DSH_HOME 已设 ⇒ 接上
    const on = launcherOptionsFrom({ argv: [], env })
    assert.equal(on.options.dshCredentialsFile, join(dshHome, '.credentials.yaml'))

    // 显式关掉 ⇒ null。它与"DSH_HOME 未设"落到同一个值，这是刻意的：
    // 两者对读取器都意味着"这次没有回退来源"。
    const off = launcherOptionsFrom({ argv: ['--no-dsh-credentials'], env })
    assert.equal(off.options.dshCredentialsFile, null)

    // DSH_HOME 未设、也没关 ⇒ 同样是 null（两个不同原因，同一个结果）
    const none = launcherOptionsFrom({ argv: [], env: envFor(root) })
    assert.equal(none.options.dshCredentialsFile, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ============================================================================
// PRT-257：DSH 运行时安装的**生产调用方**（计划 + 应用）
//
// ## 这一套守的是什么
//
// `runtime-install.mjs` 自己那 28 条用例守的是"判据对不对"。这一套守的是
// **另一件事**：有没有一条命令行真的走到那些判据上。
//
//   > 一个"判据齐全、用例全绿"的安装器，
//   > 与一个"没有任何人能敲出来"的安装器，在部署上是同一个东西——
//   > 只不过前者的测试报告很好看。
//
// ## 两条最要紧的断言，以及它们为什么**不能**合并
//
//   > 一条"计划打出来了"的断言，
//   > 与一条"计划这一步什么都没写"的断言，在计划恰好没写东西的那些运行里
//   > 是同一片绿——只不过前者的绿，在一次把 DataDir 建出来的"计划"上
//   > 也照样是绿的。
//
// 所以计划那两条**分开**断言：一条看输出里有没有那份计划，另一条拿
// `readdirSync(root, {recursive:true})` 快照整个临时树，逐条比。
//
// ## 测试从不联网
//
// 三条结构性的事实一起保证这件事，而不是靠"记得注入"：
//   ① `installRuntime` 的 `runner` 在模块里是**必填**的（没有缺省实现）；
//   ② 本套用例的 `npmRunnerFn` 只返回一个把假 DSH 写进目标目录的函数；
//   ③ **默认**运行器在 `NODE_TEST_CONTEXT` 存在时**构造不出来**——
//      所以"漏注入一次"跑的是"拒绝执行"，不是一次真实的 npm install。
// ============================================================================

/** 这一段的临时根：两层清理，失败也一样清（与 `runtime-install.test.mjs` 同一做法）。 */
const RUNTIME_TEMP_ROOTS = []

function runtimeTempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-cli-runtime-${tag}-`))
  RUNTIME_TEMP_ROOTS.push(dir)
  return dir
}

function sweepRuntimeTemps() {
  while (RUNTIME_TEMP_ROOTS.length > 0) {
    const dir = RUNTIME_TEMP_ROOTS.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力而为；不清会留孤儿目录 */ }
  }
}

after(sweepRuntimeTemps)

/** 目录树的快照：断言"什么都没多出来"的可执行形式。 */
const snapshotDir = (root) => readdirSync(root, { recursive: true }).map(String).sort()

/** Legion 自有包的源目录（`runtime-install.mjs` 的 `LEGION_FILE_PACKAGES`）。 */
const RUNTIME_SOURCE_DIRS = ['team-hub', 'plugins', 'board-plugin', 'services-plugin']

/** 一份 spec §9.1 形状的清单对象（**用例现造的**：本仓库不发货任何一份）。 */
function manifestObject({ dshVersion = '7.7.7', patchVersion = 4, productVersion = '0.9.0', channel = 'stable' } = {}) {
  return {
    manifestFormat: 'legion/version-manifest@1',
    productVersion,
    legionVersion: productVersion,
    dshVersion,
    dshCompositionPatchVersion: patchVersion,
    schemaVersion: 12,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    channel,
  }
}

function writeManifest(path, options) {
  writeFileSync(path, `${JSON.stringify(manifestObject(options), null, 2)}\n`, 'utf8')
  return path
}

/**
 * 夹具：安装目录里有那四个 Legion 源目录，数据目录在同一个临时根下。
 * **全部在 `mkdtempSync` 里**——一个字节都不会落到真实的 DataDir。
 */
function runtimeFixture(tag, options) {
  const root = runtimeTempRoot(tag)
  const installDir = join(root, 'install')
  for (const d of RUNTIME_SOURCE_DIRS) mkdirSync(join(installDir, d), { recursive: true })
  const dataDir = join(root, 'data')
  const manifestPath = writeManifest(join(root, 'manifest.json'), options)
  return {
    root,
    installDir,
    dataDir,
    manifestPath,
    env: {
      LEGION_HOME: root,
      LEGION_INSTALL_DIR: installDir,
      LEGION_DATA_DIR: dataDir,
      LEGION_WORKSPACE_DIR: join(root, 'ws'),
    },
  }
}

/** 假运行器：把 `node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}` 写出来。 */
function fakeNpmRunner(version) {
  const calls = []
  const runner = (cmd) => {
    calls.push({ file: cmd.file, args: [...cmd.args] })
    const prefix = cmd.args[cmd.args.indexOf('--prefix') + 1]
    const pkgDir = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
    writeFileSync(join(pkgDir, 'lib', 'bin.js'), '// 假的 DSH 入口（用例造的，不是真 npm 装的）\n', 'utf8')
    return { ok: true, status: 0, stdout: '', stderr: '', error: null }
  }
  runner.calls = calls
  return runner
}

/**
 * 一个**带计数**的模块替身：计划/现役读数走真实现，只有"装"这一边被盯住。
 *
 * 为什么不整个造假：如果连 `planRuntimeInstall` 也换成假的，那么
 * "没有 `--runtime-install` 时 `installRuntime` 零次调用"这句话，在一个
 * **压根没进那一支**的运行里也成立。所以 `calls.plan` 必须一起断言。
 */
function spiedRuntimeModule() {
  const calls = { plan: 0, install: 0, readActive: 0, runnerFactory: 0 }
  return {
    calls,
    mod: {
      readActiveRuntime: (o) => { calls.readActive += 1; return readActiveRuntime(o) },
      planRuntimeInstall: (o) => { calls.plan += 1; return planRuntimeInstall(o) },
      installRuntime: (o) => { calls.install += 1; return installRuntime(o) },
      createNpmRunner: () => { calls.runnerFactory += 1; throw new Error('用例里不得构造真实 npm 运行器') },
    },
  }
}

/** 把 stdout 与 stderr 两路按发生顺序收进同一个数组。 */
function eventCollector() {
  const events = []
  return {
    events,
    write: (m) => events.push({ ch: 'out', m: String(m) }),
    writeErr: (m) => events.push({ ch: 'err', m: String(m) }),
    text: (ch) => events.filter((e) => e.ch === ch).map((e) => e.m).join('\n'),
  }
}

test('★★★★ --runtime-install-plan：版本与区间来自**清单**，不是 CLI 里的字面量', async () => {
  const a = runtimeFixture('plan-a', { dshVersion: '7.7.7', patchVersion: 4 })
  const b = runtimeFixture('plan-b', { dshVersion: '0.2.3', patchVersion: 1 })
  const seen = []

  for (const [f, version, patch] of [[a, '7.7.7', 4], [b, '0.2.3', 1]]) {
    const json = collector()
    const code = await run({
      argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan', '--json'],
      env: f.env,
      write: json.write,
    })
    assert.equal(code, 0)
    const doc = JSON.parse(json.text())
    assert.equal(doc.phase, 'runtime-install-plan')
    assert.equal(doc.manifest.dshVersion, version)
    assert.equal(doc.plan.targetVersion, version)
    // ★ 精确锁定，不是 caret：清单只声明一个精确版本，`=` 就是这个事实的写法。
    assert.equal(doc.plan.supportedRange, `=${version}`)
    assert.equal(doc.plan.expectedPatchVersion, patch)
    assert.equal(doc.plan.patchPair.verdict, 'match')
    assert.equal(doc.plan.installCommand.args.at(-1), `@deepseek-ai/dsh@${version}`)
    seen.push(doc.plan.supportedRange)

    const human = collector()
    const code2 = await run({
      argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan'],
      env: f.env,
      write: human.write,
    })
    assert.equal(code2, 0)
    assert.match(human.text(), /计划可执行/)
    assert.ok(human.text().includes(version), '人读输出里没有清单声明的版本')
  }

  // ★ 两份**不同**的清单算出了两个不同的区间。一条硬编码在 CLI 里的区间
  //   在这里必然红——而"计划算出来了"那一条在硬编码下照样是绿的。
  assert.notEqual(seen[0], seen[1], '两份不同的清单算出了同一个区间：区间没有从清单来')
})

test('★★★★★ --runtime-install-plan：计划打出来了，而且磁盘上一个字节都没多', async () => {
  const f = runtimeFixture('plan-pure')
  const before = snapshotDir(f.root)

  const out = collector()
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan'],
    env: f.env,
    write: out.write,
  })

  assert.equal(code, 0)
  assert.match(out.text(), /计划可执行/)
  // ★ 这两条**不能**互相代替：前一条在一次"把 DataDir 建出来的计划"上
  //   也照样是绿的，只有后一条会红。
  assert.deepEqual(snapshotDir(f.root), before, '计划在磁盘上留下了东西')
  assert.equal(existsSync(f.dataDir), false, '计划把 DataDir 建出来了')
})

test('★★★★ 计划被拒绝：退出 1（与 0、3 都分开），且给出照着做就能往前走的下一步', async () => {
  const f = runtimeFixture('plan-refuse')
  const dshHome = join(f.root, 'dsh-home')
  const insideDshHome = join(dshHome, 'data')
  const env = { ...f.env, DSH_HOME: dshHome, LEGION_DATA_DIR: insideDshHome }
  const before = snapshotDir(f.root)

  const out = collector()
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan'],
    env,
    write: out.write,
  })

  assert.equal(code, RUNTIME_INSTALL_CLI_EXIT.REFUSED)
  assert.equal(code, 1)
  assert.notEqual(code, RUNTIME_INSTALL_CLI_EXIT.PLANNED)
  assert.notEqual(code, RUNTIME_INSTALL_CLI_EXIT.UNDIAGNOSED)
  assert.match(out.text(), /RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME/)
  // ★ 拒绝必须**可解**：一句"被拒绝了"与一个不存在的入口，对用户是同一个东西。
  assert.match(out.text(), /下一步/)
  assert.match(out.text(), /--doctor/)

  assert.deepEqual(snapshotDir(f.root), before, '被拒绝的计划在磁盘上留下了东西')
  assert.equal(existsSync(insideDshHome), false)

  // 脚本形态也要能照着做：`repair` 与逐码的下一步都在 JSON 里。
  const json = collector()
  const jcode = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan', '--json'],
    env,
    write: json.write,
  })
  assert.equal(jcode, 1)
  const doc = JSON.parse(json.text())
  assert.equal(doc.ok, false)
  assert.equal(doc.exitCode, 1)
  assert.equal(doc.plan.ok, false)
  assert.match(doc.repair.command, /--doctor/)
  assert.equal(doc.code, 'RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME')
})

test('★★★★ 算不出计划 ⇒ 退出 3（缺清单/文件不在/读不出来/清单不合法），**不是 0**', async () => {
  const f = runtimeFixture('plan-undiagnosed')

  // ① 没给 --runtime-manifest：没有来源，也就没有结论。
  const noFlag = collector()
  const c1 = await run({ argv: ['--runtime-install-plan'], env: f.env, write: noFlag.write })
  assert.equal(c1, RUNTIME_INSTALL_CLI_EXIT.UNDIAGNOSED)
  assert.equal(c1, 3)
  assert.match(noFlag.text(), new RegExp(RUNTIME_PLAN_CODES.NO_MANIFEST))
  assert.match(noFlag.text(), /--runtime-manifest/)
  assert.doesNotMatch(noFlag.text(), /计划可执行/)

  // ② 路径给了，那个路径下没有文件。
  const missing = collector()
  const c2 = await run({
    argv: [`--runtime-manifest=${join(f.root, 'nope.json')}`, '--runtime-install-plan'],
    env: f.env,
    write: missing.write,
  })
  assert.equal(c2, 3)
  assert.match(missing.text(), new RegExp(RUNTIME_PLAN_CODES.MANIFEST_NOT_FOUND))

  // ③ 文件在、也是合法 JSON，但**不是一份合法清单**：区间写法。
  //    那正是 `manifest.mjs` 拒绝的 `^0.8.3`（"看起来是钉住的"）。
  const bad = writeManifest(join(f.root, 'bad.json'), { dshVersion: '^7.7.7' })
  const invalid = collector()
  const c3 = await run({ argv: [`--runtime-manifest=${bad}`, '--runtime-install-plan'], env: f.env, write: invalid.write })
  assert.equal(c3, 3)
  assert.match(invalid.text(), new RegExp(RUNTIME_PLAN_CODES.MANIFEST_INVALID))
  // 逐项问题要**出得来**：只说"清单不合法"等于让用户去猜是哪一行。
  assert.match(invalid.text(), /manifest-version-not-exact/)
  assert.match(invalid.text(), /dshVersion/)

  // ④ 坏 JSON 是"读不出来"，与"读出来了但不合法"**分开**：下一步动作不同。
  const garbage = join(f.root, 'garbage.json')
  writeFileSync(garbage, '{ 这不是 JSON', 'utf8')
  const unreadable = collector()
  const c4 = await run({ argv: [`--runtime-manifest=${garbage}`, '--runtime-install-plan'], env: f.env, write: unreadable.write })
  assert.equal(c4, 3)
  assert.match(unreadable.text(), new RegExp(RUNTIME_PLAN_CODES.MANIFEST_UNREADABLE))

  // 四条"算不出"一条都没有写出任何东西。
  assert.equal(existsSync(f.dataDir), false)
})

test('★★★★ 没有 --runtime-install：installRuntime 与真实运行器都**一次都没有**被碰到', async () => {
  const f = runtimeFixture('no-apply')
  const { mod, calls } = spiedRuntimeModule()

  const out = collector()
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install-plan'],
    env: f.env,
    write: out.write,
    runtimeInstallModuleFn: async () => mod,
  })

  assert.equal(code, 0)
  assert.match(out.text(), /计划可执行/)
  // ★ 反证：这一支**真的走过**。少了它，"installRuntime 零次"在一个
  //   压根没进去的分支上也成立。
  assert.equal(calls.plan, 1)
  assert.equal(calls.install, 0, '没有 --runtime-install，却调用了 installRuntime')
  assert.equal(calls.runnerFactory, 0, '没有 --runtime-install，却去构造了真实 npm 运行器')
  assert.equal(existsSync(f.dataDir), false)

  // 别的入口**连模块都不加载**：安装器的依赖不该被体检/修复入口拖进来。
  let loaded = 0
  const doctorOut = collector()
  const dcode = await run({
    argv: ['--doctor'],
    env: f.env,
    write: doctorOut.write,
    readStdinFn: async () => '',
    runtimeInstallModuleFn: async () => { loaded += 1; return mod },
  })
  assert.equal(dcode, 3, '没有诊断时 --doctor 必须是「拿不到诊断」，不是 0')
  assert.equal(loaded, 0, '别的入口把安装器模块加载进来了')
})

test('★★★★ --runtime-install 在计划被拒绝时**一步都不走**，磁盘上也不留目录', async () => {
  const f = runtimeFixture('refuse-apply')
  const dshHome = join(f.root, 'dsh-home')
  const insideDshHome = join(dshHome, 'data')
  const env = { ...f.env, DSH_HOME: dshHome, LEGION_DATA_DIR: insideDshHome }
  const before = snapshotDir(f.root)

  const { mod, calls } = spiedRuntimeModule()
  let runnerBuilt = 0
  const out = collector()
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install'],
    env,
    write: out.write,
    writeErr: () => {},
    runtimeInstallModuleFn: async () => mod,
    npmRunnerFn: () => { runnerBuilt += 1; return fakeNpmRunner('7.7.7') },
  })

  assert.equal(code, RUNTIME_INSTALL_CLI_EXIT.REFUSED)
  assert.match(out.text(), /RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME/)
  // `installRuntime` 对一条被拒绝的计划**会抛**（模块自己的守卫），所以
  // 这里的 0 不只是"没装成"，而是"根本没有走到它"。
  assert.equal(calls.install, 0)
  assert.equal(runnerBuilt, 0)
  assert.deepEqual(snapshotDir(f.root), before)
  assert.equal(existsSync(insideDshHome), false)
})

test('★★★★ --runtime-install：用模块的注入运行器真的装完一遍，指针与完成标记都落下（绝不联网）', async () => {
  const f = runtimeFixture('apply')
  const runner = fakeNpmRunner('7.7.7')
  const ev = eventCollector()

  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install'],
    env: f.env,
    write: ev.write,
    writeErr: ev.writeErr,
    npmRunnerFn: () => runner,
  })

  assert.equal(code, 0)
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].file, 'npm.cmd')
  assert.equal(runner.calls[0].args.at(-1), '@deepseek-ai/dsh@7.7.7')

  // ★ 先说"要做什么"，再动手：那条通知必须出现在结果**之前**。
  //   两条流分开收集的话，这个顺序就**没有**任何断言在看——而"打印在动作之前"
  //   正是这一条的全部意义。
  const announceAt = ev.events.findIndex((e) => e.ch === 'err' && /npm install/.test(e.m))
  const resultAt = ev.events.findIndex((e) => e.ch === 'out' && /已装好/.test(e.m))
  assert.ok(announceAt >= 0, '没有先说要执行什么')
  assert.ok(resultAt > announceAt, '通知出现在结果之后（等于没有提前说）')
  assert.match(ev.text('err'), /@deepseek-ai\/dsh@7\.7\.7/)

  // 磁盘终态：指针、完成标记、假入口、四个 junction。
  const root = runtimeRootOf({ dataDir: f.dataDir })
  assert.equal(existsSync(root.pointerPath), true)
  const pointer = JSON.parse(readFileSync(root.pointerPath, 'utf8'))
  assert.equal(pointer.version, '7.7.7')
  assert.equal(existsSync(join(pointer.dir, COMPLETION_MARKER_FILENAME)), true)
  assert.match(readFileSync(join(pointer.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8'), /假的 DSH 入口/)
  for (const name of ['dsh-team-hub', 'dsh-scrum-worker', 'dsh-scrum-board', 'dsh-legion-services']) {
    assert.equal(existsSync(join(pointer.dir, 'node_modules', '@dsh-external', name)), true, `缺 junction：${name}`)
  }
  // 装完之后现役读数也认得它（计划里的 `fresh` 变成了 `active`）。
  const active = readActiveRuntime({ dataDir: f.dataDir })
  assert.equal(active.state, 'active')
  assert.equal(active.version, '7.7.7')
})

test('★★★★ --runtime-install --dry-run：只打命令，不起 npm、不建目录', async () => {
  const f = runtimeFixture('apply-dry')
  let runnerBuilt = 0
  const out = collector()

  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install', '--dry-run'],
    env: f.env,
    write: out.write,
    writeErr: () => {},
    npmRunnerFn: () => { runnerBuilt += 1; return fakeNpmRunner('7.7.7') },
  })

  assert.equal(code, 0)
  assert.match(out.text(), /--dry-run/)
  assert.match(out.text(), /将要执行：npm/)
  assert.equal(runnerBuilt, 0, '--dry-run 竟然构造了运行器')
  assert.equal(existsSync(f.dataDir), false)
})

test('★★★★ 在测试进程里真实运行器**构造不出来**：--runtime-install 拒绝执行而不是去连网', async () => {
  const f = runtimeFixture('apply-guard')
  // 本用例的前提：它自己就跑在 node --test 里。前提不成立时这条用例**没有意义**，
  // 所以先把前提断言出来，而不是让它安静地绿。
  assert.equal(underNodeTestRunner(), true, '本用例只有在 node --test 里才有意义')
  // 判据是"这个键**在不在**"，不是它的值——把 Node 的实现细节（`child-v8`）
  // 写进判据的话，它改的那天这条守卫会静默失效。
  assert.equal(underNodeTestRunner({ NODE_TEST_CONTEXT: 'child-v8' }), true)
  assert.equal(underNodeTestRunner({ NODE_TEST_CONTEXT: '' }), true)
  assert.equal(underNodeTestRunner({}), false, '没有这个键就不是测试运行器（真实运行必须能过）')
  assert.equal(underNodeTestRunner({ LEGION_HOME: 'x' }), false)

  const out = collector()
  const errs = collector()
  const { mod } = spiedRuntimeModule()
  // ★ 这一层是**防自己**的：这个替身的 `createNpmRunner()` 会抛，
  //   所以万一守卫被改掉，红的是这条用例（抛一个可辨认的标记），
  //   **而不是真的去跑一次 `npm install`**。
  //   一条"守卫坏了就会联网"的用例，在守卫坏掉的那天会把测试机连上外网——
  //   它自己就是它要防的那件事。
  const poisoned = { ...mod, createNpmRunner: () => { throw new Error('守卫没有生效：真实 npm 运行器被构造了') } }

  // ★ 刻意**不**注入 npmRunnerFn：走默认那条路。
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install'],
    env: f.env,
    write: out.write,
    writeErr: errs.write,
    runtimeInstallModuleFn: async () => poisoned,
  })

  assert.equal(code, RUNTIME_INSTALL_CLI_EXIT.APPLY_FAILED)
  assert.equal(code, 10)
  assert.notEqual(code, RUNTIME_INSTALL_CLI_EXIT.REFUSED, '守卫拒绝不是"计划被拒"（两者该看的磁盘状态不同）')
  assert.match(errs.text(), /测试运行器|NODE_TEST_CONTEXT/)
  assert.equal(existsSync(f.dataDir), false, '守卫必须在建任何目录之前生效')
  // 退出 9 的原因**不是**计划被拒：计划是过的。
  assert.match(out.text(), /计划可执行/)
})

test('★ 诚实边界：这一套接线**没有**证明什么', async () => {
  const f = runtimeFixture('honest')
  const runner = fakeNpmRunner('7.7.7')
  const ev = eventCollector()
  const code = await run({
    argv: [`--runtime-manifest=${f.manifestPath}`, '--runtime-install'],
    env: f.env,
    write: ev.write,
    writeErr: ev.writeErr,
    npmRunnerFn: () => runner,
  })
  assert.equal(code, 0)

  // ① **没有真的跑过 npm install。** 被执行的命令是假运行器记录下来的那一条；
  //    真 npm 一次也没有被起过。这里是这一句的机器可读形式：
  //    落盘的是用例造的假 DSH（只有两个文件），而不是任何一个真的 DSH 包。
  const root = runtimeRootOf({ dataDir: f.dataDir })
  const pointer = JSON.parse(readFileSync(root.pointerPath, 'utf8'))
  assert.deepEqual(readdirSync(join(pointer.dir, 'node_modules', '@deepseek-ai', 'dsh')).sort(), ['lib', 'package.json'])

  // ② **一个字节都没有装进真实的 DataDir。** 这套用例里 DataDir 永远是
  //    `mkdtempSync` 出来的临时目录。
  assert.ok(f.dataDir.startsWith(tmpdir()), `DataDir 不在临时目录里：${f.dataDir}`)

  // ③ **junction 路线仍然没有在任何一个真的装好的 DSH 上跑过。**
  //    链接指向的是仓库/夹具里的源码目录，而它们里面并没有一个装好的 DSH。
  for (const d of RUNTIME_SOURCE_DIRS) {
    assert.equal(existsSync(join(f.installDir, d, 'node_modules')), false,
      `${d} 的源目录里出现了 node_modules —— 这一跑碰到了某种真实安装`)
  }

  // ④ **默认（真实）运行器这条路一次都没有被跑过**：测试守护卫把它挡在
  //    "构造运行器"之前（上一条用例的退出 9 就是证据）。

  // ⑤ **本仓库没有随产品发货任何一份 §9.1 清单。** 这套用例里的清单都是现造的，
  //    而"没有清单"在生产里的读数是退出 3——不是 0。
  const none = collector()
  const c = await run({ argv: ['--runtime-install-plan'], env: f.env, write: none.write })
  assert.equal(c, RUNTIME_INSTALL_CLI_EXIT.UNDIAGNOSED)

  // ⑥ 所以：**这一套证明的是"接线接上了"，不是"产品能装 DSH 了"。**
})
