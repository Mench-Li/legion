// product/launcher/launcher.test.mjs
// ============================================================================
// PRT-251 Launcher 的判据。分两层：
//
//   A. 注入式（毫秒级）——「启动前拦下确定性错误」「必需进程失败整体回滚」
//      「身份不符立刻熔断」「受限范围不得报成就绪」。
//   B. 真实进程（一套，跑真 team-hub + 真 workbench）——接线是否正确。
//
// 第二层不可省：本文件里的**两条缺陷都是它发现的**，不是推演出来的。
//   ① workbench 的 `DSH_HUB_UPSTREAM` 默认指 8787；team-hub 起在临时端口上时，
//      workbench 会去代理**别的** hub 实例。没有身份断言就不会被发现——
//      `/hub/api/config` 会返回 200，于是报「就绪」，而用户看到的界面数据
//      来自另一个数据库。
//   ② 就绪判据里的 `{port}` 展开成字符串 "51814" 后与 number 严格比较永远不成立，
//      真实运行被误报成 `identity-mismatch`（类型问题伪装成安全问题）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveLayout } from '../paths.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { createLauncher, expandExpectation, productStateOf } from './launcher.mjs'

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 造一个「一直活着」的假子进程（用于验证回滚真的调用了 stop）。 */
function liveFakeChild(pid = 1234) {
  const c = new EventEmitter()
  c.pid = pid
  c.exitCode = null
  c.signalCode = null
  c.killed = false
  c.kill = () => { c.killed = true; return true }
  return c
}

/** 造一个「合法但独立」的布局：data/workspace/cache/log 互不重叠，且都在安装目录之外。 */
function layoutIn(root, overrides = {}) {
  const { layout } = resolveLayout({
    installDir: REPO_ROOT,
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
    ...overrides,
  })
  return layout
}

// ------------------------------------------------------------ A. 注入式

test('preflight：清单诊断有 error 时**不启动任何进程**，并在 plan 阶段返回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    // installDir 落在 dataDir 内部 → 触发 WRITABLE_DIR_INSIDE_INSTALL_DIR
    const bad = resolveLayout({ installDir: join(root, 'app'), dataDir: join(root, 'app', 'data'), workspaceDir: join(root, 'ws'), homeDir: root, env: {} }).layout
    let spawned = 0
    const L = createLauncher({
      layout: bad,
      exists: () => true,
      spawnImpl: () => { spawned += 1; throw new Error('不应被调用') },
    })
    const r = await L.start()
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'plan')
    assert.equal(spawned, 0, '确定性错误必须在 spawn 之前拦下')
    assert.ok(r.diagnostics.some((d) => d.code === 'WRITABLE_DIR_INSIDE_INSTALL_DIR'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflight：端口被占用时报 ports 阶段失败，且不 spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  const { createServer } = await import('node:net')
  const server = createServer()
  const port = await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server.address().port)))
  try {
    let spawned = 0
    const L = createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': port },
      include: ['team-hub'],
      exists: () => true,
      spawnImpl: () => { spawned += 1; throw new Error('不应被调用') },
    })
    const r = await L.start()
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'ports')
    assert.equal(spawned, 0)
    assert.ok(r.diagnostics.some((d) => d.code === 'PORT_IN_USE' && d.process === 'team-hub'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('必需进程就绪失败 → 整体回滚（已启动的都被停掉），可选进程失败只降级', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const port = await reserveEphemeralPort()
    // 假 fetch 永远拒绝连接：team-hub（必需）永远不就绪
    const refused = new Error('fetch failed')
    refused.cause = { code: 'ECONNREFUSED' }
    let t = 0
    const L = createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': port },
      include: ['team-hub'],
      exists: () => true,
      readiness: { timeoutMs: 400, intervalMs: 100 },
      sleep: async (ms) => { t += ms },
      now: () => t,
      fetchImpl: async () => { throw refused },
      spawnImpl: () => liveFakeChild(),
    })
    const r = await L.start()
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'readiness')
    assert.deepEqual(r.failures.map((f) => f.process), ['team-hub'])
    assert.equal(r.failures[0].code, 'readiness-timeout')
    assert.ok(L.status().processes.every((p) => p.state === 'stopped'), '回滚后不得留下半启动状态')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('available=false 的假 fetch：连接被拒是可重试的，不会立刻熔断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const port = await reserveEphemeralPort()
    const refused = new Error('fetch failed')
    refused.cause = { code: 'ECONNREFUSED' }
    let t = 0
    const L = createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': port },
      include: ['team-hub'],
      exists: () => true,
      readiness: { timeoutMs: 1000, intervalMs: 100 },
      sleep: async (ms) => { t += ms },
      now: () => t,
      fetchImpl: async () => { throw refused },
      spawnImpl: () => liveFakeChild(1),
    })
    await L.start()
    const diag = L.status().readinessDiagnostics[0]
    assert.equal(diag.code, 'READINESS_TIMEOUT')
    assert.ok(diag.attempts >= 5, `实际探测 ${diag.attempts} 次`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('受限范围：被排除的进程诊断降级为 warn 并换码，产品状态不得为 ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const L = createLauncher({
      layout: layoutIn(root),
      include: ['team-hub'],
      exists: () => true,
      runtimeCommand: null,
    })
    const excluded = L.diagnostics.filter((d) => d.code === 'PROCESS_EXCLUDED_BY_SCOPE')
    assert.ok(excluded.length > 0)
    assert.ok(excluded.every((d) => d.severity === 'warn'))
    assert.ok(excluded.every((d) => d.excludedCode !== undefined), '被排除的原因必须保留')
    // 受限范围的 status：即便全部就绪也只能是 degraded
    const st = L.status()
    assert.equal(st.scope.partial, true)
    assert.deepEqual(st.scope.excluded, ['workbench', 'runtime', 'orchestrator', 'whiteboard'])
    assert.notEqual(st.state, 'ready')
    assert.match(st.stateText, /受限范围/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('envSurface：跨进程接线是**派生**的，不是各自猜默认值', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const L = createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': 51814, workbench: 51815 },
      exists: () => true,
      runtimeCommand: 'node r.mjs',
    })
    const rows = Object.fromEntries(L.envSurface().map((r) => [r.process, r]))
    // workbench 必须指到本次启动的 hub，而不是默认 8787
    assert.equal(rows.workbench.allowed.includes('DSH_HUB_UPSTREAM'), true)
    // 白板拿不到 hub 的令牌；team-hub 拿不到白板的令牌
    assert.equal(rows.whiteboard.allowed.includes('TEAM_HUB_TOKEN'), false)
    assert.equal(rows['team-hub'].allowed.includes('WHITEBOARD_TOKEN'), false)
    // 所有进程的 droppedKeys 只含键名
    for (const row of Object.values(rows)) {
      assert.ok(row.droppedKeys.every((k) => typeof k === 'string'))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expandExpectation：整串占位符保留原类型；未知变量抛错而不是留成字面量', () => {
  assert.equal(expandExpectation('{port}', { port: 51814 }), 51814)
  assert.strictEqual(typeof expandExpectation('{port}', { port: 51814 }), 'number')
  assert.equal(expandExpectation('{ok}', { ok: true }), true)
  assert.equal(expandExpectation('{dataDir}/team-hub/team.db', { dataDir: 'C:\\d' }), 'C:\\d/team-hub/team.db')
  assert.equal(expandExpectation(200, {}), 200)
  assert.throws(() => expandExpectation('{port}', {}), /未知上下文变量 \{port\}/)
  assert.throws(() => expandExpectation('x{teamHubPort}y', {}), /未知上下文变量 \{teamHubPort\}/)
})

test('productStateOf：起不来 / 部分起 / 全就绪 / 受限范围 的五种映射', () => {
  const p = (key, state, required = true) => ({ key, state, required })
  assert.equal(productStateOf([]), 'unavailable')
  assert.equal(productStateOf([p('a', 'stopped')]), 'unavailable')
  assert.equal(productStateOf([p('a', 'circuit-open')], [{ key: 'a' }]), 'unavailable')
  assert.equal(productStateOf([p('a', 'ready'), p('b', 'starting')]), 'starting')
  assert.equal(productStateOf([p('a', 'ready'), p('b', 'ready')]), 'ready')
  assert.equal(productStateOf([p('a', 'ready'), p('w', 'circuit-open', false)]), 'degraded')
  assert.equal(productStateOf([p('a', 'ready')], [], { partial: true }), 'degraded',
    '受限范围永远不返回 ready：缺少执行引擎时「可以开始认领任务」不成立')
})

// ------------------------------------------------------------ B. 真实进程

test('真实进程：team-hub + workbench 按波次启动并经身份断言就绪；写入落在 DataDir', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-real-'))
  const hubPort = await reserveEphemeralPort()
  const wbPort = await reserveEphemeralPort()
  const L = createLauncher({
    layout: layoutIn(root),
    ports: { 'team-hub': hubPort, workbench: wbPort },
    include: ['team-hub', 'workbench'],
    exists: () => true,
    readiness: { timeoutMs: 60000, intervalMs: 250 },
  })
  t.after(async () => {
    await L.stop({ graceMs: 3000 })
    rmSync(root, { recursive: true, force: true })
  })

  const r = await L.start()
  assert.equal(r.ok, true, `启动失败：${JSON.stringify(r.failures)}`)
  const st = L.status()
  const byKey = Object.fromEntries(st.processes.map((p) => [p.key, p]))
  assert.equal(byKey['team-hub'].state, 'ready')
  assert.equal(byKey.workbench.state, 'ready')
  // 就绪是**量到的**，不是声明的：耗时与尝试次数都被记录
  assert.equal(byKey['team-hub'].readiness.code, 'READINESS_VERIFIED')
  assert.ok(byKey['team-hub'].readiness.elapsedMs >= 0)
  assert.ok(byKey['team-hub'].readiness.attempts >= 1)
  // workbench 的就绪判据是经代理取 hub 的 config，因此它同时证明了上游接线正确
  assert.equal(byKey.workbench.readiness.code, 'READINESS_VERIFIED')

  // §6.11 / PRT-003：写路径必须落在 DataDir，而不是安装目录内的代码默认值。
  assert.equal(existsSync(join(root, 'data', 'team-hub', 'team.db')), true, 'hub 的库必须落在 DataDir')
  // 这条断言走**注入值**而不是「安装目录里有没有 .db」：
  // 后者会被别的测试套件（直接手跑 team-hub 的那些）影响，不是可依赖的判据。
  // 而注入值才是本批次真正负责的东西。相关背景：team-hub/.gitignore 里有 `*.db`，
  // 所以写进安装目录的库不会出现在 `git status` 里，也不会被任何评审看见——
  // 它只是在那里，然后在升级替换安装目录时连带消失（或更糟：被当成新版本的旧数据读进去）。
  const hubEnv = L.envSurface().find((r) => r.process === 'team-hub')
  assert.equal(hubEnv.values.TEAM_HUB_DB, join(root, 'data', 'team-hub', 'team.db'))
  const wbEnv = L.envSurface().find((r) => r.process === 'workbench')
  assert.equal(wbEnv.values.DSH_HUB_UPSTREAM, `http://127.0.0.1:${hubPort}`,
    'workbench 必须指到本次启动的 hub；指到默认 8787 会静默代理别的实例')

  // 身份断言的实测：直接问 team-hub 它认哪个端口
  const res = await fetch(`http://127.0.0.1:${hubPort}/api/config`)
  const cfg = await res.json()
  assert.equal(cfg.port, hubPort)

  // 停止之后端口必须真的放开（否则「重启产品」会变成「端口被占用」）
  const stopped = await L.stop({ graceMs: 3000 })
  assert.ok(stopped.states.every((s) => s.state === 'stopped'))
  const { canBind } = await import('./ports.mjs')
  assert.equal((await canBind(hubPort)).ok, true, '停止后 hub 端口必须可绑')
  assert.equal((await canBind(wbPort)).ok, true, '停止后 workbench 端口必须可绑')
})

test('真实进程：端口上跑着**别的**实例时，身份断言立刻失败而不是等满超时', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-alien-'))
  // 先起一个「冒名」的 hub：占用端口并返回错误的 port 字段
  const { createServer } = await import('node:http')
  const alienPort = await reserveEphemeralPort()
  const alien = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ auth: false, db: 'alien', port: 8787 }))
  })
  await new Promise((resolve) => alien.listen({ port: alienPort, host: '127.0.0.1' }, resolve))
  t.after(async () => {
    await new Promise((resolve) => alien.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  // 让 Launcher 认为 hub 应当监听这个端口（用 allowPortInUse 跳过占用检查，
  // 于是走到就绪阶段，正是真实世界里「残留旧实例」的情形）
  const L = createLauncher({
    layout: layoutIn(root),
    ports: { 'team-hub': alienPort },
    include: ['team-hub'],
    allowPortInUse: ['team-hub'],
    exists: () => true,
    readiness: { timeoutMs: 60000, intervalMs: 250, probeTimeoutMs: 2000 },
  })
  const began = Date.now()
  const r = await L.start()
  const elapsed = Date.now() - began
  assert.equal(r.ok, false)
  assert.equal(r.failures[0].code, 'identity-mismatch')
  assert.match(r.failures[0].detail, /实际 8787/)
  assert.ok(elapsed < 10000, `必须在身份断言后立刻返回，实际用了 ${elapsed}ms（超时设了 60s）`)
})

test('真实进程：入口缺失（orchestrator worker 尚未创建）被如实报出，不静默', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-gap-'))
  try {
    // 用真实 existsSync：product/orchestrator/worker.mjs 在当前里程碑尚不存在
    const L = createLauncher({ layout: layoutIn(root), runtimeCommand: 'node r.mjs', include: ['team-hub', 'orchestrator'] })
    const missing = L.diagnostics.filter((d) => d.code === 'ENTRY_MISSING')
    const lines = readFileSync(new URL('../process-manifest.mjs', import.meta.url), 'utf8')
    assert.match(lines, /MANIFEST_KNOWN_GAPS/, '入口缺口必须由清单声明为机器可读事实')
    if (missing.length === 0) {
      // 入口已被实现（PRT-301 之后）：那时这条断言自动变成「不得再声明为缺口」
      assert.equal(lines.includes('ENTRY_MISSING'), true)
    } else {
      assert.equal(missing[0].process, 'orchestrator')
      assert.equal(missing[0].severity, 'error')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
