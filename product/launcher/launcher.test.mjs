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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { resolveLayout } from '../paths.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { createLauncher, expandExpectation, productStateOf, withRunCredentialPatch } from './launcher.mjs'
import { launcherOptionsFrom } from './cli.mjs'
import { runCredentialPaths } from './run-credential-materialization.mjs'

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

test('preflight：**密钥库自检接在启动前**，且 error 级会拦下启动（PRT-254/257 的接线）', async () => {
  // 这一条守的是**接线本身**：把它拔掉（`secretsDiagnostics = []`）时，
  // secrets-check 那一组仍然全绿——因为那一组只测"怎么判"，不测"有没有被判"。
  // **一个没被调用到的判定，和一个不存在的判定，在输出上完全一样。**
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    let spawned = 0
    const seen = []
    const L = createLauncher({
      layout: layoutIn(root),
      // 限定范围：不限定的话其它进程的入口在临时目录里解析不出来，
      // plan 阶段就失败，走不到密钥库那一步（实测 ENTRY_UNRESOLVED）。
      include: ['team-hub'],
      // 显式给一个空闲端口：默认端口在本机可能已被占用，那样 plan 阶段就会
      // 报 PORT_IN_USE，同样走不到密钥库那一步。
      ports: { 'team-hub': await reserveEphemeralPort() },
      exists: () => true,
      spawnImpl: () => { spawned += 1; throw new Error('不应被调用') },
      secretsCheck: (args) => {
        seen.push(args)
        return [{ severity: 'error', code: 'SECRETS_STORE_UNPROTECTED', message: '明文后端' }]
      },
    })
    const r = await L.preflight()
    assert.equal(seen.length, 1, '自检必须被调用且只调一次')
    assert.equal(typeof seen[0].platform, 'string', '要把平台传下去（ACL 按平台选实现）')
    assert.equal(typeof seen[0].layout?.secretsFile, 'string', '要把布局传下去（自检要知道密钥库在哪）')
    assert.equal(r.ok, false, 'error 级密钥库诊断必须拦下启动')
    assert.ok(r.diagnostics.some((d) => d.code === 'SECRETS_STORE_UNPROTECTED'),
      `诊断里必须有密钥库那条：${JSON.stringify(r.diagnostics.map((d) => d.code))}`)
    assert.equal(spawned, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflight：密钥库的 **warn 级不拦启动**（否则用户被锁在门外，连修的地方都进不去）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const L = createLauncher({
      layout: layoutIn(root),
      // 限定范围：不限定的话其它进程的入口在临时目录里解析不出来，
      // plan 阶段就失败，走不到密钥库那一步（实测 ENTRY_UNRESOLVED）。
      include: ['team-hub'],
      ports: { 'team-hub': await reserveEphemeralPort() },
      exists: () => true,
      secretsCheck: () => [{ severity: 'warn', code: 'SECRETS_STORE_OPEN_FAILED', message: '打不开' }],
    })
    const r = await L.preflight()
    assert.equal(r.ok, true, 'warn 不该阻止启动')
    // 但必须**留在诊断里**：不阻塞不等于沉默
    assert.ok(r.diagnostics.some((d) => d.code === 'SECRETS_STORE_OPEN_FAILED'),
      'warn 必须出现在诊断中，不能被丢掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflight：密钥库自检自己抛异常也只降级为 warn（**体检程序崩溃不该让产品起不来**）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const L = createLauncher({
      layout: layoutIn(root),
      // 限定范围：不限定的话其它进程的入口在临时目录里解析不出来，
      // plan 阶段就失败，走不到密钥库那一步（实测 ENTRY_UNRESOLVED）。
      include: ['team-hub'],
      ports: { 'team-hub': await reserveEphemeralPort() },
      exists: () => true,
      secretsCheck: () => { throw Object.assign(new Error('boom'), { name: 'SecretStoreError' }) },
    })
    const r = await L.preflight()
    assert.equal(r.ok, true, '自检崩溃不该阻止启动')
    const d = r.diagnostics.find((x) => x.code === 'SECRETS_CHECK_FAILED')
    assert.ok(d !== undefined, '但必须被看见，不能静默')
    assert.equal(d.severity, 'warn')
    assert.ok(!d.message.includes('boom'), '不原样带出底层 message')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start：Run 的凭证材料化**接在生产启动路径上**，且那份文件是 Legion 自己的（PRT-509 缺口 ①）', async () => {
  // ★ 这一条测的是**接线**，不是那个模块的算法。
  //
  //   在本用例之前，`openRunCredentials()` 与 `materializeRunCredentials()` 两边
  //   都有用例、都全绿，而它们在生产里的调用方数是 **0**。把 `launcher.start()`
  //   里那次 `prepareRuntimeCredentials(...)` 整段删掉时，那个模块自己的 15 条
  //   **仍然全绿**——因为那一组只测"算得对不对"，不测"有没有人算"。
  //
  //   > 一个"能力齐全、测试全绿、而没有任何生产代码调用它"的模块，
  //   > 与一个不存在的模块，在部署上是同一个东西——只不过前者的报告是绿的。
  //
  //   所以判据落在三件**只有真接线才有**的事情上：`start()` 之后
  //   `runCredentials()` 不是 null；盘上真的有一份 `.credentials.yaml`；
  //   那份文件在**产品家目录**下而不是在 operator 的真实 home 里。
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  try {
    const layout = layoutIn(root)
    // 假的 DSH 声明（真实现会去 DSH 的 base bundle 补丁里读 `apiKeyEnv`）：
    // 这一条测的是"接线把声明用起来了"，不是"DSH 的包装在哪"。
    const dshBase = join(root, 'fake-dsh-base', 'cordis.patch.yml')
    mkdirSync(dirname(dshBase), { recursive: true })
    writeFileSync(dshBase, '      config:\n        apiKeyEnv: PROBE_API_KEY\n', 'utf8')

    let spawned = 0
    // ★ 记下**真正被 spawn 出去的**那份命令。断言必须落在这里，而不是 `L.plan`
    //   上：凭证覆盖层的 `--patch` 是**按需**追加的（只有真的写出了凭证才指过去，
    //   否则每一次启动的 argv 都会多一个指向空覆盖层的参数）。
    //   于是"计划里有"与"真的起进程时带上了"是两件事——而只有后者有关系。
    const spawnedArgs = []
    // 虚拟时钟（与邻近那几条 `start()` 用例同一做法）：本用例不测"等了多久"，
    // 而真实 sleep 会让一次就绪超时按真实秒数走完，用例从 5 秒变成 35 秒。
    let t = 0
    const L = createLauncher({
      layout,
      include: ['team-hub'],
      ports: { 'team-hub': await reserveEphemeralPort() },
      exists: () => true,
      spawnImpl: (file, args) => { spawned += 1; spawnedArgs.push({ file, args: [...(args ?? [])] }); return liveFakeChild() },
      // 就绪必然失败（没有真的在监听）：本用例要的是"走到材料化那一步之后"，
      // 不是"起得来"。回滚与就绪的判据由本文件其它用例守着。
      readiness: { timeoutMs: 150, intervalMs: 50 },
      sleep: async (ms) => { t += ms },
      now: () => t,
      fetchImpl: async () => { throw new Error('refused') },
      secretsCheck: () => [],
      runtimeCommand: { file: 'node', args: [join(root, 'dsh', 'lib', 'bin.js')] },
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      runCredentialRequire: { resolve: () => dshBase },
      runCredentialHandleFactory: async ({ refs }) => ({
        refs, held: () => true, get: () => 'probe-value',
      }),
    })

    const r = await L.start()
    assert.ok(spawned >= 1, '必须先真的走到 spawn（材料化在它之前，没 spawn 就是更早的阶段就失败了）')

    // ★ 覆盖层必须**真的进了 Runtime 的命令行**。
    //
    //   光写出一份覆盖层文件是不够的：DSH 只有当 `--patch` 指向它时才会读到它。
    //   一个"文件写好了、而命令行里没有 --patch"的接线，与"什么都没写"在 DSH
    //   那一侧是同一个结果——而写文件那一步的读数看起来完全正常。
    const paths0 = runCredentialPaths(layout)
    const runtimeProc = L.plan.processes.find((p) => p.key === 'runtime')
    assert.ok(runtimeProc?.command != null, '计划里必须有 runtime 进程')
    // ★★ 这一步**不许**把**凭证**覆盖层无条件塞进冻结的 `plan`。
    //
    //    凭证覆盖层的 `--patch` 是**按需**追加的（在 `start()` 里、材料化成功之后）。
    //    无条件追加会让每一次启动的 argv 都变，包括那些**根本没有凭证可写**的
    //    部署——指向一份空覆盖层的 `--patch` 会变成所有部署的常态，
    //    而它在凭证配好的机器上与正确接线逐字相同。
    //
    //    ★ 判据必须指向**那一份具体的文件**：强制面覆盖层（`enforcementOverlay`）
    //      本来就会往计划里放一个 `--patch`，那是另一条缝、是**对的**。
    //      只断言"计划里没有 --patch"会把那条正确的缝一起判红——
    //      一条分不清两件事的断言，会在正确的那一件事上先响。
    assert.ok(!runtimeProc.command.args.includes(paths0.overlayFile),
      '`plan` 在 spawn 之前就冻结了，它**不该**已经带**凭证**覆盖层的路径：'
      + `带着就说明这一步是无条件追加的。args = ${JSON.stringify(runtimeProc.command.args)}`)

    const reading = L.runCredentials()
    assert.notEqual(reading, null,
      '启动路径没有走到凭证材料化那一步（`runCredentials()` 返回 null = 那次调用不在）')
    assert.equal(reading.applied, true, reading.message ?? '')
    assert.equal(reading.blocking, false)

    const paths = runCredentialPaths(layout)
    assert.equal(existsSync(paths.targetFile), true,
      `材料化出来的凭证文件必须真的在盘上：${paths.targetFile}`)
    // operator 的真实 home **不得**被写（那是另一个程序的地盘）
    assert.equal(existsSync(join(root, 'operator-dsh')), false, '不得往 operator 的真实 DSH 家目录里写')
    assert.equal(existsSync(join(root, 'operator-home', '.dsh')), false, '不得往 ~/.dsh 里写')
    // 覆盖层把 DSH 指到 Legion 那份（否则写的是一份**没人读**的文件——缺口 ③ 的形状）
    const overlay = readFileSync(paths.overlayFile, 'utf8')
    assert.match(overlay, /^- id: credentials$/m)
    assert.ok(overlay.includes(JSON.stringify(paths.targetFile)))
    assert.equal(r.ok, false, '本用例的就绪必然失败（没有真的在监听）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('★★★★★ 凭证覆盖层的 `--patch` 是**按需**追加的：没写出凭证就一个参数都不加', () => {
  // 这一条判的是 PRT-509 收尾时发现的一个真问题：覆盖层参数最初是**无条件**
  // 追加到冻结的 `plan` 上的，于是每一次启动的 argv 都变——包括那些
  // **根本没有凭证可写**的部署。而三条既有用例正是按 `--patch` 这个 flag
  // 本身做断言的，它们红了才发现。
  //
  //   > 一个"没东西可写时也把 DSH 指过去"的接线，
  //   > 与一个"只在真的写了东西时才指过去"的接线，
  //   > 在凭证配好的机器上表现完全一样——
  //   > 差别只在没配好的机器上，而那里多出来的那个参数看起来像生效了。
  //
  // 判据必须是**双向**的：只测"applied=true 时会加"会漏掉无条件追加
  // （那条路永远都会加）；只有同时测"applied=false 时一点不变"才能把
  // "按需"与"无条件"分开。
  const root = mkdtempSync(join(tmpdir(), 'legion-rcp-'))
  try {
    const layout = layoutIn(root)
    const paths = runCredentialPaths(layout)
    // 一份最小的假计划：runtime 一个进程，另加一个**别的**进程当对照
    // （证明我们只动 runtime，没顺手把 parameters 加到所有人身上）。
    const mkPlan = () => Object.freeze({
      waves: Object.freeze([Object.freeze(['runtime']), Object.freeze(['team-hub'])]),
      processes: Object.freeze([
        Object.freeze({ key: 'runtime', command: Object.freeze({ file: 'node', args: Object.freeze(['bin.js', '--profile', 'web']) }) }),
        Object.freeze({ key: 'team-hub', command: Object.freeze({ file: 'node', args: Object.freeze(['hub.js']) }) }),
      ]),
    })
    const argsOf = (p, k) => p.processes.find((x) => x.key === k).command.args
    const base = mkPlan()

    // ① 没有写出凭证 ⇒ **逐字不变**（同一个对象，连参数都不多一个）。
    assert.equal(withRunCredentialPatch(base, false, paths), base,
      'applied=false 时计划必须原样返回——否则每次启动的 argv 都会多出指向空覆盖层的 --patch')
    assert.deepEqual(argsOf(withRunCredentialPatch(base, false, paths), 'runtime'), ['bin.js', '--profile', 'web'])

    // ② 写出来了 ⇒ runtime 的命令行**末尾**追加 `--patch <覆盖层>`。
    const patched = withRunCredentialPatch(base, true, paths)
    assert.deepEqual(argsOf(patched, 'runtime'),
      ['bin.js', '--profile', 'web', '--patch', paths.overlayFile],
      '写出凭证之后，runtime 的命令行必须真的把 DSH 指到那份覆盖层上')

    // ③ 别的进程**一点都不变**：覆盖层是给 DSH 的，不是给 hub 的。
    assert.deepEqual(argsOf(patched, 'team-hub'), ['hub.js'], '覆盖层被顺手加到了别的进程上')

    // ④ 原计划没被就地改（`plan` 是冻结的，但这条判的是"我们真的复制了"）：
    assert.deepEqual(argsOf(base, 'runtime'), ['bin.js', '--profile', 'web'], '原计划被就地改掉了')

    // ⑤ 路径算不出来（`ok !== true`）时 ⇒ 一个参数都不加。
    //    这条防的是"路径是空字符串却照样加 --patch"——那会让 DSH 起不来，
    //    而失败看起来像"运行时装坏了"。
    assert.equal(withRunCredentialPatch(base, true, { ok: false, overlayFile: paths.overlayFile }), base,
      '路径算不出来时不许加 --patch')
    assert.equal(withRunCredentialPatch(base, true, { ok: true, overlayFile: '' }), base,
      '覆盖层路径是空字符串时不许加 --patch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflight：端口冲突排在密钥库之前（先报更硬的那个）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
  const { createServer } = await import('node:net')
  const server = createServer()
  const port = await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server.address().port)))
  try {
    let secretsCalls = 0
    const L = createLauncher({
      layout: layoutIn(root),
      // 限定范围：不限定的话其它进程的入口在临时目录里解析不出来，
      // plan 阶段就失败，走不到密钥库那一步（实测 ENTRY_UNRESOLVED）。
      include: ['team-hub'],
      exists: () => true,
      ports: { 'team-hub': port },
      secretsCheck: () => { secretsCalls += 1; return [] },
    })
    const r = await L.preflight()
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'ports')
    // 端口已经失败了，就没必要再去开密钥库（那会白花一次 icacls / DPAPI）
    assert.equal(secretsCalls, 0, '端口阶段失败后不该继续跑密钥库自检')
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

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

// ------------------------------------------------------------ F. PRT-705 孤儿进程
//
// `run-record.mjs` 自己的用例已经把"哪种 pid 不能杀"判清楚了。
// 这一组问的是另一件事：**那个判断有没有真的接在启动路径上**，
// 以及"默认不清理"这条纪律会不会被绕过去。
//
//   > 一个写在模块里、却没有任何入口会调用的安全判断，
//   > 与没有这个判断，在"用户会不会被误伤"上是同一个答案。

function orphanRoot(processes) {
  const root = mkdtempSync(join(tmpdir(), 'legion-orphan-'))
  const dir = join(root, 'data')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'launcher-run.json'), JSON.stringify({
    version: 'legion/launcher-run@1', runId: 'prev', startedAt: '2026-01-01T00:00:00.000Z', processes,
  }))
  return { root, dir }
}

/** 起一个 Launcher，走 `--check` 那条路（不真起进程，但仍会查上一次运行）。 */
function launcherAt(root, dir, extra = {}) {
  const killed = []
  const L = createLauncher({
    layout: layoutIn(root),
    include: [],
    ports: {},
    processProbe: {
      isAlive: (pid) => extra.alive?.(pid) ?? false,
      imageOf: async (pid) => extra.imageOf?.(pid) ?? null,
    },
    killTreeImpl: async (pid) => { killed.push(pid); return true },
    // dataDir 必须与 layout 一致，记录才落在我们造的那个目录里
    ...extra.options,
  })
  void dir
  return { launcher: L, killed }
}

test('① 启动时读上一次运行的记录：残留进程**进 allDiagnostics**', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 4321, image: 'node.exe' }])
  try {
    const { launcher } = launcherAt(root, join(root, 'data'), {
      alive: (pid) => pid === 4321, imageOf: () => 'node.exe',
    })
    await launcher.start()
    const d = launcher.allDiagnostics().find((x) => x.code === 'ORPHANS_FOUND')
    assert.ok(d, `记录了残留却没有诊断：${JSON.stringify(launcher.allDiagnostics().map((x) => x.code))}`)
    assert.deepEqual(d.pids, [4321])
    assert.ok(d.message.includes('--sweep-orphans'), '必须给出出口')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② ★ 默认**不清理**：残留进程一个都不会被杀', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 4321, image: 'node.exe' }])
  try {
    const { launcher, killed } = launcherAt(root, join(root, 'data'), {
      alive: () => true, imageOf: () => 'node.exe',
    })
    await launcher.start()
    assert.deepEqual(killed, [],
      '用户没要求清理却动了手——"默认会杀进程"的启动路径是不可接受的')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② ★ pid 被回收时**绝不杀**，并单独报出来', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 4321, image: 'node.exe' }])
  try {
    // 记录里写着 node.exe，现在这个号码上是 Code.exe——用户的编辑器
    const { launcher, killed } = launcherAt(root, join(root, 'data'), {
      alive: () => true, imageOf: () => 'Code.exe',
      options: { sweepOrphansOnStart: true },
    })
    await launcher.start()
    assert.deepEqual(killed, [], '杀了一个不相干的程序：那是不可撤销的')
    const d = launcher.allDiagnostics().find((x) => x.code === 'PID_RECYCLED')
    assert.ok(d, 'pid 被回收这件事没被报出来')
    assert.ok(d.message.includes('Code.exe'), d.message)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('③ 显式要求清理时，确认是我们的那些会被杀', async () => {
  const { root } = orphanRoot([
    { key: 'team-hub', pid: 111, image: 'node.exe' },
    { key: 'workbench', pid: 222, image: 'node.exe' },
  ])
  try {
    const { launcher, killed } = launcherAt(root, join(root, 'data'), {
      alive: (pid) => pid === 111, imageOf: () => 'node.exe',
      options: { sweepOrphansOnStart: true },
    })
    await launcher.start()
    assert.deepEqual(killed, [111], '只该杀还活着且确认是我们的那一个（222 已经没了）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('③ 映像名读不出来时，**即使要求清理也不动**它们', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 333, image: 'node.exe' }])
  try {
    const { launcher, killed } = launcherAt(root, join(root, 'data'), {
      alive: () => true, imageOf: () => null,
      options: { sweepOrphansOnStart: true },
    })
    await launcher.start()
    assert.deepEqual(killed, [], '没有映像名就无法确认那号码还是不是我们的')
    assert.ok(launcher.orphanStatus().sweep.refused.some((r) => r.reason === 'identity-unknown'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('④ 记录是坏的时也要报出来（不能读成「很干净」）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-orphan-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'launcher-run.json'), '{ 写了一半')
    const { launcher } = launcherAt(root, join(root, 'data'), {})
    await launcher.start()
    assert.ok(launcher.allDiagnostics().some((x) => x.code === 'RUN_RECORD_CORRUPT'),
      '坏记录被当成「没有记录」了')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('④ 没有记录文件时**不报任何诊断**（这确实是干净的情况）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-orphan-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    const { launcher } = launcherAt(root, join(root, 'data'), {})
    await launcher.start()
    assert.deepEqual(launcher.orphanStatus().diagnostics.map((x) => x.code), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('⑤ 正常停止之后记录被删掉（它描述的是「这次运行」，不是历史）', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 4321, image: 'node.exe' }])
  try {
    const { launcher } = launcherAt(root, join(root, 'data'), {})
    await launcher.start()
    await launcher.stop()
    assert.equal(launcher.orphanStatus().previousRun.entries.length, 1, '已经判过的结果应当留着供查询')
    assert.equal(existsSync(join(root, 'data', 'launcher-run.json')), false,
      '停止之后记录还在：下次启动会重复报告同一批残留，用户会以为残留一直在长')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('⑤ 启动在体检就失败时，记录同样被删掉（否则会重复报告）', async () => {
  const { root } = orphanRoot([{ key: 'team-hub', pid: 4321, image: 'node.exe' }])
  try {
    // `include: []` 是「不限定范围」，**不是**「什么都不含」——那样 plan 会成功。
    // 要让体检确定性地失败，用密钥库自检报一个 error 级诊断（现成的那条路）。
    const launcher = createLauncher({
      layout: layoutIn(root),
      include: ['team-hub'],
      ports: { 'team-hub': await reserveEphemeralPort() },
      processProbe: { isAlive: () => false, imageOf: async () => null },
      killTreeImpl: async () => true,
      exists: () => true,
      spawnImpl: () => { throw new Error('不应被调用') },
      secretsCheck: () => [{ severity: 'error', code: 'SECRETS_STORE_UNPROTECTED', message: '明文后端' }],
    })
    const r = await launcher.start()
    assert.equal(r.ok, false, '这条用例要靠体检失败才成立')
    assert.equal(existsSync(join(root, 'data', 'launcher-run.json')), false,
      '早退路径没删记录：什么都没起来，这条记录只可能描述上一次运行，' +
      '留着它下次启动会把同一批残留再报一遍')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('⑥ CLI 的两个开关**默认是关的**（不存在「忘记关」这回事）', () => {
  const env = { LEGION_HOME: process.cwd() }
  const off = launcherOptionsFrom({ argv: [], env })
  assert.equal(off.options.sweepOrphansOnStart, false)
  assert.equal(off.options.allowUnverifiedSweep, false)
  const on = launcherOptionsFrom({ argv: ['--sweep-orphans'], env })
  assert.equal(on.options.sweepOrphansOnStart, true)
  assert.equal(on.options.allowUnverifiedSweep, false, '允许未验证必须单独要求')
})

// ═══════════════════════════════════════════════ 单实例锁接进启动路径（PRT-708）
//
// `single-instance.mjs` 写出来之后，`product/launcher/` 里对它的引用次数是 **0** ——
// 也就是本会话反复在修的那一类：*一个"写好了、也有用例"的机制，与一个"从未被
// 交给任何调用方"的机制，在运行的部署上是同一个东西——只不过前者的用例是绿的。*
//
// 这一组钉的是**接线**，而且钉的是顺序（顺序在这里是安全性）。

/** 一个记账用的假锁：记录拿到/释放，并按脚本给结论。 */
function fakeLock({ outcomes = null, code = 'INSTANCE_LOCK_ACQUIRED' } = {}) {
  const calls = { acquire: [], release: 0 }
  let n = 0
  const impl = async (input) => {
    calls.acquire.push(input)
    const scripted = outcomes === null ? null : outcomes[Math.min(n, outcomes.length - 1)]
    n++
    const c = scripted ?? code
    const ok = c === 'INSTANCE_LOCK_ACQUIRED' || c === 'INSTANCE_LOCK_STALE_RECLAIMED'
    return {
      ok,
      code: c,
      lock: { file: join(input.dataDir, 'legion-instance.lock'), pid: input.pid },
      holder: ok ? { pid: input.pid } : { pid: 424242, startedAt: '2026-09-11T00:00:00.000Z' },
      handle: ok ? { release: () => { calls.release++; return { ok: true, code: 'INSTANCE_LOCK_RELEASED' } } } : null,
      diagnostics: ok ? [] : ['已经有实例在跑（pid 424242）', `确认没有 Legion 在跑之后删掉：${join(input.dataDir, 'legion-instance.lock')}`],
    }
  }
  return { impl, calls }
}

test('★ 拿到锁：`start()` 会在 `dataDir` 上真的去拿一次，且读数被暴露出来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    const lock = fakeLock()
    const L = createLauncher({
      layout: layoutIn(root), include: ['team-hub'], exists: () => true,
      runtimeCommand: null, acquireInstanceLockImpl: lock.impl,
    })
    assert.equal(L.instanceLock, null, '还没 start()，读数应该是 null（不是"拿到了"）')
    await L.start()
    assert.equal(lock.calls.acquire.length, 1)
    // 锁必须落在**产品家目录**上，那是被保护的东西所在的地方。
    assert.equal(lock.calls.acquire[0].dataDir, layoutIn(root).dataDir)
    assert.equal(L.instanceLock.code, 'INSTANCE_LOCK_ACQUIRED')
    assert.equal(L.instanceLock.holder.pid, lock.calls.acquire[0].pid)
    await L.stop()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★★ 另一个实例持有锁 → `start()` 在 `instance-lock` 阶段拒绝，起 0 个进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    const lock = fakeLock({ code: 'INSTANCE_ALREADY_RUNNING' })
    let spawned = 0
    const L = createLauncher({
      layout: layoutIn(root), include: ['team-hub'], exists: () => true,
      runtimeCommand: null, acquireInstanceLockImpl: lock.impl,
      spawnImpl: () => { spawned++; return liveFakeChild(1) },
    })
    const r = await L.start()
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'instance-lock')
    assert.equal(r.code, 'INSTANCE_ALREADY_RUNNING')
    assert.equal(spawned, 0, '拿不到锁却还是起了进程 —— 那样两个实例会真的同时在跑')
    // 诊断要原样交出来：里面有"该删哪个文件"，那是用户唯一的出路。
    assert.match(r.diagnostics.join('\n'), /legion-instance\.lock/)
    assert.equal(L.instanceLock.ok, false)
    assert.equal(L.instanceLock.holder.pid, 424242, '要说清是谁占着')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★★ 锁**早于**上一次运行的残留检查：拿不到锁就不去碰任何进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    // 磁盘上放一份"上一次运行"的记录，里面有一个活着的 pid。
    const dataDir = layoutIn(root).dataDir
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'launcher-run.json'), JSON.stringify({
      version: 'legion/launcher-run@1',
      runId: 'run-old', launcherPid: 111,
      processes: [{ key: 'team-hub', pid: 111, image: 'node.exe' }],
    }))
    const killed = []
    const lock = fakeLock({ code: 'INSTANCE_ALREADY_RUNNING' })
    const L = createLauncher({
      layout: layoutIn(root), include: ['team-hub'], exists: () => true,
      runtimeCommand: null, acquireInstanceLockImpl: lock.impl,
      options: { sweepOrphansOnStart: true },
    })
    const r = await L.start()
    assert.equal(r.phase, 'instance-lock')
    // ★ 这条断言是这一组里最要紧的：
    //   运行记录里那个 pid 属于**第一个实例**。第二个实例若先跑到
    //   `checkPreviousRun()`/清理那一步，它清理的就是别人正在用的进程。
    //   *一个"先清理残留、再检查自己该不该启动"的启动器，会把"我上次没退干净"
    //   与"别人正在跑"当成同一件事处理——只不过它清理的是别人正在用的那批。*
    assert.deepEqual(killed, [], '拿不到锁却动了进程')
    assert.match(r.diagnostics.join('\n'), /pid 424242/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★★ 早退路径（preflight 不过）也要**放锁**，否则下一次启动被自己挡住', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    const lock = fakeLock()
    const L = createLauncher({
      layout: layoutIn(root), include: ['team-hub'],
      // 清单里少一个入口 → preflight/plan 阶段就返回，`supervisor` 始终是 null。
      exists: () => false,
      runtimeCommand: null, acquireInstanceLockImpl: lock.impl,
    })
    const r = await L.start()
    assert.notEqual(r.phase, 'instance-lock', '这一跑应该是**拿到了锁**之后才失败的')
    // ★ 这一条同样是"用例测的是不是那条分支"的诚实性检查：
    //   早退路径的特征就是 `supervisor` 从没被建起来（`phase` 停在 plan）。
    assert.equal(r.phase, 'plan', `这一跑没走到早退那条路径：${JSON.stringify(r)}`)
    assert.equal(lock.calls.acquire.length, 1)
    await L.stop()
    // ★ 锁是在 `supervisor` 被建**之前**拿到的，所以"没起来就没什么可收的"
    //   这个判断会漏掉它——而残留的锁会把**下一次**启动挡在门外，
    //   提示还是"已经有一个实例在运行"（那句话是假的）。
    assert.equal(lock.calls.release, 1, '早退路径没放锁')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★ 正常 stop() 放锁，且**重复 stop() 不会重复释放**', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    const lock = fakeLock()
    const port = await reserveEphemeralPort()
    let t = 0
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const L = createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': port },
      include: ['team-hub'],
      exists: () => true,
      acquireInstanceLockImpl: lock.impl,
      readiness: { timeoutMs: 1000, intervalMs: 100 },
      sleep: async (ms) => { t += ms },
      now: () => t,
      fetchImpl: async () => { throw refused },
      spawnImpl: () => liveFakeChild(1),
    })
    const r = await L.start()
    // ★★★ 这条断言是**这一组用例自己**的诚实性检查。
    //
    //   破验 L4（"正常 stop() 不放锁"）第一次**没咬住**，原因就在这里：
    //   当时的夹具让 `start()` 在 preflight 就失败了，于是 `supervisor` 始终是
    //   `null`、`stop()` 走的是**早退**那条 —— 一条叫"正常 stop() 放锁"的用例，
    //   实际上测的是早退路径，而早退那条本来就有释放。
    //
    //     > 一条"测正常停止路径"的用例，
    //     > 与一条"碰巧测了同一段代码的另一条分支"的用例，
    //     > 在绿灯上是同一个东西——只不过前者会在被测的那条分支坏掉时保持绿。
    //
    //   所以这里先钉住"这一次真的走到了 readiness（= supervisor 已建）"，
    //   再谈锁。`phase: 'readiness'` 是那条路径的具名读数。
    assert.equal(r.phase, 'readiness', `这一跑没有走到 supervisor 那一步，用例测错了分支：${JSON.stringify(r)}`)
    assert.equal(lock.calls.acquire.length, 1)

    // ★★★ 在**这里**断言，而不是在下面那次显式 `stop()` 之后。
    //
    //   破验 L4（"正常 stop() 不放锁"）第二次仍然**没咬住**，就是因为第一次
    //   我把断言写在显式 `stop()` 之后：`start()` 的就绪失败会**内部**调一次
    //   `stop({ reason: '启动失败回滚' })`，而那时 `supervisor` 还活着 ——
    //   也就是**正常路径已经在 `start()` 里被走过了**，同时 `supervisor`
    //   被置成了 `null`。于是紧随其后的显式 `stop()` 走的是**早退**那条
    //   （早退有释放），计数被"救"回 1，被摘掉的那条分支就查不出来了。
    //
    //     > 一次"计数恰好等于 1"的读数，
    //     > 与一次"我测的那条分支恰好释放过"的读数，
    //     > 只有在**没有第二条分支会补上这个计数**时才等价。
    //
    //   所以：紧接 `start()` 返回就断言——此刻唯一可能释放过的就是
    //   `supervisor` 还活着时的那次回滚 `stop()`。
    assert.equal(lock.calls.release, 1, '正常路径（supervisor 已建时）没放锁')

    // 之后 supervisor 已是 null，这次显式 stop() 走早退路径；
    // 它必须**幂等**，不能因为"又 release 了一次"把计数顶到 2。
    await L.stop()
    assert.equal(lock.calls.release, 1)
    await L.stop()
    assert.equal(lock.calls.release, 1, '重复释放 —— 一个已经放掉的句柄不该被再用一次')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★ 每次 `start()` 各拿各的锁（`retry()` 不会复用上一次那个句柄）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    const lock = fakeLock()
    const port = await reserveEphemeralPort()
    let t = 0
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const make = () => createLauncher({
      layout: layoutIn(root),
      ports: { 'team-hub': port },
      include: ['team-hub'],
      exists: () => true,
      acquireInstanceLockImpl: lock.impl,
      readiness: { timeoutMs: 1000, intervalMs: 100 },
      sleep: async (ms) => { t += ms },
      now: () => t,
      fetchImpl: async () => { throw refused },
      spawnImpl: () => liveFakeChild(1),
    })
    const L = make()
    await L.start()
    // 就绪失败 → `start()` 内部回滚（正常路径，supervisor 还活着）→ 已放一次。
    assert.equal(lock.calls.acquire.length, 1)
    assert.equal(lock.calls.release, 1, '第一次启动没有放锁')
    await L.stop()
    assert.equal(lock.calls.release, 1, '第二次 stop 不该再放一次')
    // 第二次启动（`retry()` 就是"先 stop 再 start"）：必须**重新**拿一次锁。
    await L.start()
    await L.stop()
    assert.equal(lock.calls.acquire.length, 2, '第二次启动没有重新拿锁 —— 那把锁在第一次 stop 之后已经放掉了')
    assert.equal(lock.calls.release, 2, '两次启动各要放一次 —— 漏一次就把家目录锁死了')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('★★ 没有 dataDir 时锁落不下 —— 如实退到 `instance-lock` 而不是静默跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-lk-'))
  try {
    // 真实现（不注入）：空 dataDir 会抛，而"抛"绝不能变成"那就跳过这把锁"。
    const L = createLauncher({
      layout: { ...layoutIn(root), dataDir: '' },
      include: ['team-hub'], exists: () => true, runtimeCommand: null,
    })
    const r = await L.start()
    assert.equal(r.ok, false, '拿不到锁却照常启动 —— 那就等于没有这把锁')
    assert.equal(r.phase, 'instance-lock')
    assert.match(r.diagnostics.join('\n'), /dataDir|产品家目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
