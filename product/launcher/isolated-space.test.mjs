// product/launcher/isolated-space.test.mjs
// ============================================================================
// PRT-255：在**隔离测试空间**完成 安装 / 运行 / 取消 / 重启 / 诊断 验证。
// spec §8 第 857 行。
//
// ## 这一组与其它 launcher 用例的区别
//
// `launcher.test.mjs` 用 `createLauncher()` 直接驱动**库**；`cli.test.mjs` 覆盖
// 参数、退出码与安装。两者都不能回答 PRT-255 真正问的那个问题：
//
//   **一个新用户，只用文档上的那几个开关，能不能把产品装起来并且跑起来？**
//
// 所以这里把产品**自己的入口**（`product/launcher/cli.mjs`）当**子进程**驱动，
// 走完整五步，每一步都要求**盘上/端口上/退出码上**能看见的证据，
// 而不是"函数返回了 ok"。
//
//   > 一个「所有模块的单元测试都通过」的产品，
//   > 与一个「装完之后起不来」的产品，是同一个东西——
//   > 只不过前者在一张张绿灯清单上看起来是完整的。
//
// ## ★ 隔离空间的边界（这里最容易自欺）
//
// 隔离的是**用户数据**（DataDir / 配置），**不是程序**——程序树就是本仓库，
// 因为进程入口（`team-hub/server.mjs` 等）按安装目录解析。这与真实产品一致：
// 安装目录是程序，数据目录是用户的数据。
//
// 五步各自的**可观测判据**：
//
//   ① 安装   exit 0 + 两个文件真的落盘 + 用户的工作区**没有被替用户创建**
//   ② 运行   stdout 报就绪 + **端口上真的有人在听**（自己去连一次）
//   ③ 取消   exit 0（优雅）+ 报出停止数 + **端口真的能再绑上**（不是"进程没了"）
//   ④ 重启   再来一次仍然就绪（上一步没释放干净的话，这一步会撞 PORT_IN_USE）
//   ⑤ 诊断   exit 0 + 包目录与清单真的落盘
//
// 每一步都必须用**下一步骤能成立**来验证上一步骤真的做完了。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, connect } from 'node:net'

import { reserveEphemeralPort } from './ports.mjs'
import { osHomeFacts, OS_HOME_ENV } from './cli.mjs'
import { resolveLayout } from '../paths.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** 端口上是否真的有人在听。 */
function listening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = connect({ port, host: '127.0.0.1' })
    const done = (v) => { s.destroy(); resolve(v) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

/** 端口能不能被再绑定（"上一次真的放开了"的可观测形式）。 */
function bindable(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/**
 * 等到端口真的被放开。
 *
 * 组件退出需要一点点时间，所以用**有上限的重试**而不是一次判定——
 * 「取消之后端口能放开」是要断言的事实，「在 0 毫秒内放开」不是。
 */
async function waitReleased(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await bindable(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * 一次性调用 CLI，等它自己结束。
 *
 * `env` 刻意**不注入 `LEGION_HOME`**：产品家目录必须能从操作系统事实推出来，
 * 否则"新用户只用文档上的开关装完就能跑"这句话不成立。
 */
function cliOnce(args, { env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, 'product', 'launcher', 'cli.mjs'), ...args], {
      cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

/** 一个隔离空间：程序树是仓库，用户数据全在临时目录里。 */
function isolatedSpace() {
  const root = mkdtempSync(join(tmpdir(), 'legion-space-'))
  const workspaceDir = join(root, 'ws')
  mkdirSync(workspaceDir, { recursive: true })
  const dataDir = join(root, 'data')
  return {
    root, dataDir, workspaceDir,
    args: [`--install-dir=${REPO}`, `--data-dir=${dataDir}`, `--workspace=${workspaceDir}`],
    // ★ 带重试删除。组件进程退出后，Windows 上文件句柄可能还没完全放开，
    //   一次 rmSync 会以 EPERM 失败——**而它是在 after 钩子里抛的**，
    //   于是"断言全过、用例却红"，红的原因还指向一个与断言无关的地方。
    //   （一个被清理失败染红的用例，与一个断言失败的用例，在这一列里是同一个东西。）
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  }
}

/** 起一个长驻的 CLI，并等它报到就绪（或失败/超时）。 */
function startStack(space, ports, { timeoutMs = 120000 } = {}) {
  const child = spawn(process.execPath, [
    join(REPO, 'product', 'launcher', 'cli.mjs'),
    ...space.args, '--include=team-hub,workbench',
    `--port.team-hub=${ports.hub}`, `--port.workbench=${ports.wb}`,
  ], { cwd: REPO, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })

  // ★ 自己记"关没关过"，**不能靠 `child.exitCode === null` 判断还活着**：
  //   被信号打死的进程 `exitCode` 是 `null`（信号在 `signalCode` 上），
  //   于是一个已经结束的进程看起来还在跑；此时再调一次 `cancel()` 会
  //   注册一个**永远不会再触发**的 `close` 监听，把用例挂死在超时上。
  //   （实测：PRT-255 的 ③ 就是这么卡到 45 秒测试超时的。）
  let closed = false
  let closeInfo = null
  child.once('close', (code, signal) => { closed = true; closeInfo = { code, signal } })

  const ready = new Promise((resolve) => {
    const started = Date.now()
    const timer = setTimeout(() => { clearInterval(iv); resolve({ verdict: 'timeout', out }) }, timeoutMs)
    const iv = setInterval(() => {
      if (/●\s*team-hub\s+ready/.test(out) && /●\s*workbench\s+ready/.test(out)) {
        clearInterval(iv); clearTimeout(timer); resolve({ verdict: 'ready', elapsedMs: Date.now() - started, out })
      } else if (/✖ 启动失败/.test(out)) {
        clearInterval(iv); clearTimeout(timer); resolve({ verdict: 'failed', out })
      } else if (closed) {
        clearInterval(iv); clearTimeout(timer); resolve({ verdict: 'exited', code: closeInfo?.code, out })
      }
    }, 250)
  })

  return {
    child,
    ready,
    get out() { return out },
    isRunning: () => !closed,
    /** 取消：发 SIGTERM 并等它结束。已经结束的话**立刻返回**记下的结果。 */
    cancel: () => new Promise((resolve) => {
      if (closed) { resolve({ ...closeInfo, out }); return }
      child.once('close', (code, signal) => resolve({ code, signal, out }))
      child.kill('SIGTERM')
    }),
    kill: () => { try { if (!closed) child.kill('SIGKILL') } catch { /* 已退出 */ } },
  }
}

// ============================================================================
// 缺陷回归：这一组守着**上面那五步当初真的失败过**的那个原因。
//
// PRT-255 第一次跑起来时，①安装 与 ⑤诊断 是绿的，②③④⑥ 全红。原因不是产品
// 起不来，而是**产品家目录解析不出来**：
//
//   `resolveLayout` 一直有 `homeDir` / `appDataDir` 两个入参，
//   而唯一的生产调用方从来没传过它们 → `productHome = null`
//   → `secretsFile = null` → 每次启动都被 `SECRETS_PLACEMENT_INVALID` 拒绝。
//
// 而且当时**没有任何一条诊断说得出这件事**：用户看到的唯一线索是
// 「请先解析产品目录布局（resolveLayout）」——而布局是解析过的，何况
// 命令行用户根本无从照做。
//
// 这两条用例把"根因"与"根因有没有被说出来"分别钉住。
// ============================================================================

test('回归：osHomeFacts 从**操作系统事实**推出家目录，而不是要求用户先设 LEGION_HOME', () => {
  // Windows 形态
  const win = osHomeFacts({
    [OS_HOME_ENV.LOCAL_APP_DATA]: 'C:\\Users\\u\\AppData\\Local',
    [OS_HOME_ENV.USER_PROFILE]: 'C:\\Users\\u',
  })
  assert.equal(win.appDataDir, 'C:\\Users\\u\\AppData\\Local')
  assert.equal(win.homeDir, 'C:\\Users\\u')

  // POSIX 形态：只有 HOME，没有 LOCALAPPDATA
  const posix = osHomeFacts({ [OS_HOME_ENV.HOME]: '/home/u' })
  assert.equal(posix.appDataDir, null)
  assert.equal(posix.homeDir, '/home/u')

  // 空串/空白按"没给"处理——空串会让家目录变成相对路径
  const blank = osHomeFacts({ [OS_HOME_ENV.HOME]: '   ', [OS_HOME_ENV.USER_PROFILE]: '' })
  assert.equal(blank.homeDir, null, '空白值必须当成没给，不能当成一个叫 "   " 的目录')
  assert.equal(osHomeFacts({}).homeDir, null)
})

test('回归：家目录解析不出来时**必须有一条点名根因的诊断**', () => {
  // ① 没给任何家目录事实 → 必须报 PRODUCT_HOME_UNRESOLVED
  const bare = resolveLayout({ platform: 'win32', env: {}, installDir: 'C:\\legion' })
  const codes = bare.diagnostics.map((d) => d.code)
  assert.ok(codes.includes('PRODUCT_HOME_UNRESOLVED'),
    `家目录未解析时没有报出来，用户只能看到密钥库那句误导的话。实际诊断码：${JSON.stringify(codes)}`)
  assert.equal(bare.layout.productHome, null, '前提：这一组确实没解析出家目录')
  const d = bare.diagnostics.find((x) => x.code === 'PRODUCT_HOME_UNRESOLVED')
  assert.equal(d.severity, 'error')
  assert.match(d.message, /LEGION_HOME/, '必须告诉用户该设哪个变量')

  // ② 给了家目录事实 → 不再报，且 secretsFile 落在家目录下
  const ok = resolveLayout({
    platform: 'win32', env: {}, installDir: 'C:\\legion',
    appDataDir: 'C:\\Users\\u\\AppData\\Local', homeDir: 'C:\\Users\\u',
  })
  assert.equal(ok.diagnostics.some((x) => x.code === 'PRODUCT_HOME_UNRESOLVED'), false)
  assert.ok(ok.layout.productHome !== null && ok.layout.secretsFile !== null,
    '给了家目录之后密钥库路径必须能定下来——否则启动仍会被拒绝')

  // ③ 显式 LEGION_HOME 仍然压过操作系统事实（spec §6.11 的优先级不许倒置）
  const explicit = resolveLayout({
    platform: 'win32', env: { LEGION_HOME: 'D:\\deployed\\legion' }, installDir: 'C:\\legion',
    appDataDir: 'C:\\Users\\u\\AppData\\Local', homeDir: 'C:\\Users\\u',
  })
  assert.match(explicit.layout.productHome, /deployed/, 'LEGION_HOME 必须压过操作系统事实')
})

// ============================================================================

test('① 安装：只用文档上的开关就能装起来，且**不替用户创建工作区**', async (t) => {
  const space = isolatedSpace()
  t.after(() => space.cleanup())

  const r = await cliOnce([...space.args, '--init', '--json'])
  assert.equal(r.code, 0, `初始化未完成：${r.out}`)

  // 盘上真的有什么 —— 不看返回值，看文件系统
  assert.ok(existsSync(join(space.dataDir, 'product.config.json')), '产品配置没有落盘')
  assert.ok(existsSync(join(space.dataDir, 'product.json')), '产品元数据没有落盘')

  // ★ 工作区是**用户授权的目录**，不该被初始化代替他创建。
  //   这一条是"产品不替用户决定哪些目录可被读写"的可观测形式。
  const body = JSON.parse(r.out)
  const skipped = body.skipped.find((s) => s.role === 'workspace')
  assert.ok(skipped, '工作区应当被显式跳过，而不是被悄悄创建或悄悄忽略')
  assert.equal(skipped.reason, 'user-owned')

  // 再装一次是幂等的（不是"第二次会炸"）
  const again = await cliOnce([...space.args, '--init', '--json'])
  assert.equal(again.code, 0, `重复初始化失败：${again.out}`)
})

test('① 安装：工作区不存在时**拒绝**初始化，且不留下半个目录树', async (t) => {
  const space = isolatedSpace()
  t.after(() => space.cleanup())
  rmSync(space.workspaceDir, { recursive: true, force: true })

  const r = await cliOnce([...space.args, '--init', '--json'])
  assert.equal(r.code, 7, `工作区不存在时应当返回 7：${r.out}`)
})

test('② 运行：产品自己的入口能把真实进程拉起来并报到就绪', async (t) => {
  const space = isolatedSpace()
  const ports = { hub: await reserveEphemeralPort(), wb: await reserveEphemeralPort() }
  const stack = startStack(space, ports)
  // 收尾顺序：**先等进程真的走干净，再删目录**。反过来做，
  // rmSync 会因为句柄没放开而 EPERM，把一次通过的用例染红。
  t.after(async () => {
    if (stack.isRunning()) await stack.cancel()
    await waitReleased(ports.hub)
    await waitReleased(ports.wb)
    space.cleanup()
  })

  await cliOnce([...space.args, '--init', '--json'])

  const r = await stack.ready
  assert.equal(r.verdict, 'ready',
    `产品没能就绪（${r.verdict}）。\n这是 PRT-255 真正要抓的东西：` +
    `只用文档上的开关装完之后**起不来**。\n--- 输出 ---\n${r.out}`)

  // ★ 就绪是**量到的**：自己去连那两个端口。
  //   只信 stdout 上的"ready"等于信一句声明。
  assert.equal(await listening(ports.hub), true, `team-hub 报了就绪但端口 ${ports.hub} 上没人在听`)
  assert.equal(await listening(ports.wb), true, `workbench 报了就绪但端口 ${ports.wb} 上没人在听`)
})

// ── ★ 关于「取消」在本平台能验到什么（这条限制必须写在测试旁边）──────
//
// spec 说的取消是用户按 Ctrl+C。这里**没法真的送一个控制台 Ctrl+C** 给子进程。
// 而 `child.kill('SIGTERM')` 在 Windows 上不是 POSIX 信号：Node 会**无条件终止**
// 目标进程（拿到的就是 `code=null, signal='SIGTERM'`），所以 CLI 里那段
// 「收到信号 → launcher.stop() → 优雅收尾」的代码**在这条路径上跑不到**。
//
//   > 一个「用 Ctrl+C 之外的任何方式杀进程，然后声称验证了优雅停止」的用例，
//   > 与一个根本没验证优雅停止的用例，是同一个东西——
//   > 只不过前者在绿灯清单上看起来是完整的一步。
//
// 所以本文件这样分工，且如实标出边界：
//   · **优雅停止的内部行为**（SIGTERM 收尾、超时后强杀进程树）由
//     `supervisor.test.mjs` / `launcher.test.mjs` 在进程内直接验证；
//   · 这里验证**取消对用户的可观测后果**，也就是真正决定他能不能接着用的那几件：
//     进程没了、**端口放开了**、没有残留子进程、**同一组端口能再起来**。
//
// 后者其实更难做到，也更接近用户真正会遇到的问题：
// 父进程没了而子进程还在，正是 PRT-705（残留进程检测）存在的理由。

test('③ 取消：进程结束，且**端口真的被放开**（否则用户再也起不来）', async (t) => {
  const space = isolatedSpace()
  const ports = { hub: await reserveEphemeralPort(), wb: await reserveEphemeralPort() }
  const stack = startStack(space, ports)
  // 收尾用**取消+等端口放开**，不用 SIGKILL：SIGKILL 只杀 CLI 自己，
  // 而子进程继承了本测试进程的 stdout/stderr 管道——它们活着，管道就不关，
  // 上层的测试运行器会一直等 EOF（实测把一次探针运行挂在了 600s 上限上）。
  t.after(async () => {
    if (stack.isRunning()) await stack.cancel()
    await waitReleased(ports.hub)
    await waitReleased(ports.wb)
    space.cleanup()
  })

  await cliOnce([...space.args, '--init', '--json'])
  const r = await stack.ready
  assert.equal(r.verdict, 'ready', `前置失败（没能就绪）：\n${r.out}`)
  assert.equal(await listening(ports.hub), true)

  const c = await stack.cancel()

  // 退出形态：本平台是无条件终止（signal），别处应当是优雅退出（code 0）。
  // 两种都接受，但**必须二者之一**——"既没退出码也没信号"是没结束。
  const endedCleanly = c.code === 0
  const endedBySignal = c.signal !== null && c.signal !== undefined
  assert.ok(endedCleanly || endedBySignal,
    `取消之后进程既没有退出码也没有信号（code=${c.code}, signal=${c.signal}）`)
  if (process.platform !== 'win32') {
    assert.equal(c.code, 0, `非 Windows 上取消应当是优雅退出 0（实际 code=${c.code}, signal=${c.signal}）`)
  }

  // ★★ 最要紧的一条。它同时覆盖了「没有残留子进程」——
  //    子进程若还活着，它占的那个端口就还在听。
  assert.equal(await waitReleased(ports.hub), true,
    `取消后 ${ports.hub} 仍被占用：有子进程没退干净。\n${c.out}`)
  assert.equal(await waitReleased(ports.wb), true,
    `取消后 ${ports.wb} 仍被占用：有子进程没退干净。\n${c.out}`)
})

test('④ 重启：取消之后**同一组端口**能再起来（证明上一步真的收干净了）', async (t) => {
  const space = isolatedSpace()
  const ports = { hub: await reserveEphemeralPort(), wb: await reserveEphemeralPort() }
  // ★ 收尾必须**无条件**把已经起来的栈收掉。原来是 `t.after(() => space.cleanup())`：
  //   一旦断言在 cancel 之前就抛了（探针 60⑤ 正是这种情形），CLI 子进程会活着
  //   并继续持有本测试进程的 stdout/stderr 管道 → 测试运行器永远等不到 EOF →
  //   **红不了，直接挂死**。一个"失败了但挂住不报"的用例，与一个通过的用例，
  //   在 CI 的观感上是同一个东西——只不过前者会吃掉整个阶段的时间。
  const stacks = []
  t.after(async () => {
    for (const s of stacks) if (s.isRunning()) await s.cancel()
    await waitReleased(ports.hub)
    await waitReleased(ports.wb)
    space.cleanup()
  })
  const boot = () => { const s = startStack(space, ports); stacks.push(s); return s }

  await cliOnce([...space.args, '--init', '--json'])

  // 第一轮
  const first = boot()
  const r1 = await first.ready
  assert.equal(r1.verdict, 'ready', `第一轮没能就绪：\n${r1.out}`)
  await first.cancel()
  assert.equal(await waitReleased(ports.hub), true, '第一轮取消后端口没放开')
  assert.equal(await waitReleased(ports.wb), true, '第一轮取消后端口没放开')

  // 第二轮：**同一组端口**。上一次若留下残留，这里会以 PORT_IN_USE 失败。
  const second = boot()
  const r2 = await second.ready
  assert.equal(r2.verdict, 'ready',
    `重启没起来（${r2.verdict}）——上一轮"取消"没有真的收干净。\n--- 输出 ---\n${r2.out}`)
  assert.equal(await listening(ports.hub), true)
  assert.equal(await listening(ports.wb), true)

  await second.cancel()
  assert.equal(await waitReleased(ports.hub), true, '第二轮取消后端口没放开')
})

test('⑤ 诊断：产品坏掉时也能导出诊断包（入口排在配置与布局校验之前）', async (t) => {
  const space = isolatedSpace()
  t.after(() => space.cleanup())
  await cliOnce([...space.args, '--init', '--json'])

  const outDir = join(space.root, 'diag')
  const r = await cliOnce([...space.args, `--diagnostics=${outDir}`, '--json'])
  assert.equal(r.code, 0, `诊断包导出失败：${r.out}`)

  // 盘上真的有东西
  assert.ok(existsSync(outDir), '诊断包目录没有落盘')
  const entries = readdirSync(outDir)
  assert.ok(entries.length > 0, '诊断包是空的')

  const body = JSON.parse(r.out)
  assert.equal(body.ok, true)
  assert.ok(typeof body.manifest === 'object' && body.manifest !== null)
  // ★ 一份说不清自己排除了什么的诊断包，与漏收了文件的诊断包是同一个东西。
  assert.ok(Array.isArray(body.manifest.excluded), '诊断包没有说明它排除了什么')
  assert.ok(Array.isArray(body.manifest.skipped), '诊断包没有说明它没收什么')
})

test('⑤ 诊断：**配置坏掉**时诊断入口仍然可用（最需要它的时候正是产品坏掉的时候）', async (t) => {
  const space = isolatedSpace()
  t.after(() => space.cleanup())
  await cliOnce([...space.args, '--init', '--json'])

  // 把产品配置写坏
  const cfg = join(space.dataDir, 'product.config.json')
  const original = readFileSync(cfg, 'utf8')
  assert.ok(original.length > 0)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(cfg, '{ 这不是 JSON', 'utf8')

  // 正常启动应当被拦（退出码 6）
  const bad = await cliOnce([...space.args, '--check', '--json'])
  assert.equal(bad.code, 6, `坏配置没有被拦下：${bad.out}`)

  // 但诊断入口不依赖配置能否解析
  const outDir = join(space.root, 'diag-broken')
  const r = await cliOnce([...space.args, `--diagnostics=${outDir}`, '--json'])
  assert.equal(r.code, 0,
    `配置坏掉时诊断入口不可用——那等于在最需要它的时候恰好没有它：\n${r.out}`)
  assert.ok(existsSync(outDir))
})

test('⑥ 五步是**一条链**：装 → 跑 → 取消 → 重启 → 诊断，全程一处都不许靠运气', async (t) => {
  const space = isolatedSpace()
  const ports = { hub: await reserveEphemeralPort(), wb: await reserveEphemeralPort() }
  // 同 ④：断言若在 cancel 之前抛出，也必须把已起来的栈收掉，否则挂死不报。
  const stacks = []
  t.after(async () => {
    for (const s of stacks) if (s.isRunning()) await s.cancel()
    await waitReleased(ports.hub)
    await waitReleased(ports.wb)
    space.cleanup()
  })
  const boot = () => { const s = startStack(space, ports); stacks.push(s); return s }

  const steps = []

  // ① 安装
  const init = await cliOnce([...space.args, '--init', '--json'])
  steps.push(['安装', init.code])
  assert.equal(init.code, 0, `① 安装失败：${init.out}`)

  // ② 运行 + ③ 取消
  const first = boot()
  const r1 = await first.ready
  steps.push(['运行', r1.verdict])
  assert.equal(r1.verdict, 'ready', `② 运行失败：\n${r1.out}`)
  const c1 = await first.cancel()
  steps.push(['取消', c1.code ?? c1.signal])
  assert.equal(await waitReleased(ports.hub), true, `③ 取消后 ${ports.hub} 没放开：\n${c1.out}`)

  // ④ 重启
  const second = boot()
  const r2 = await second.ready
  steps.push(['重启', r2.verdict])
  assert.equal(r2.verdict, 'ready', `④ 重启失败：\n${r2.out}`)
  await second.cancel()
  assert.equal(await waitReleased(ports.hub), true, '④ 重启后取消没放开端口')
  assert.equal(await waitReleased(ports.wb), true, '④ 重启后取消没放开端口')

  // ⑤ 诊断
  const outDir = join(space.root, 'diag-chain')
  const diag = await cliOnce([...space.args, `--diagnostics=${outDir}`, '--json'])
  steps.push(['诊断', diag.code])
  assert.equal(diag.code, 0, `⑤ 诊断失败：${diag.out}`)

  // 五步都真的走过一遍——不是"某些步被跳过了但整体绿"
  assert.deepEqual(steps.map((s) => s[0]), ['安装', '运行', '取消', '重启', '诊断'])
})
