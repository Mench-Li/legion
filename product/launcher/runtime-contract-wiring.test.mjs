// product/launcher/runtime-contract-wiring.test.mjs
// ============================================================================
// Runtime Contract 的**接线**：Launcher 真的把端点与凭证交给了 worker
// （PRT-253 续批四）
//
// ## 这一套件为什么必须用**真进程**
//
// 注入式用例只能证明"Launcher 调了 `envFor()` 并算出了那个值"。
// 而本批要回答的问题是另一个：
//
//   > **那个值有没有到达另一个进程，并被那台真的监听器接受？**
//
// 一件"交出去了"的读数（`envSurface()` 里有这个键）与一件"对方收到了"的读数
// （对端回 200）在两份代码里可以完全同形——只不过后者才是这次接线的目的。
// 所以这里：
//
//   · **Runtime 那一侧**跑的是真的 `runtime-contract-publication.mjs`
//     与真的 `runtime-contract-server.mjs`（适配器是契约级的
//     `createFakeRuntimeAdapter`——与跨进程套件同一条替身纪律）；
//   · **worker 那一侧**跑的是一个真的 Node 子进程，读到的是 Launcher
//     按白名单算出来的**那一份 env**（`spawnImpl` 只换掉了"跑哪个文件"，
//     没有换掉 env）；
//   · 子进程真的发一次 HTTP 请求，把状态码与码写在盘上。
//
// ## 它**不**证明什么
//
// worker 那一侧跑的不是 `product/orchestrator/worker.mjs`（那需要一台 hub、
// 一份 lease 和一次真实的派工），而是"读这两个键 + 按契约发一次请求"的最小探针。
// 也就是说本套件证明的是**接线**，不是"产品真的执行了一个任务"。
// 后者由 `orchestrator/worker/runtime-contract-cross-process.test.mjs` 覆盖
// （它要求 `DSH_CHECKOUT`）。这条边界写在文档的诚实边界里，不靠读者推断。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveLayout } from '../paths.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { createLauncher } from './launcher.mjs'
import { runRecordPath } from './run-record.mjs'
import { RUNTIME_CONTRACT_ENDPOINT_CODES } from './runtime-contract-endpoint.mjs'

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * 生成脚本里的 import 说明符必须是**文件 URL**。
 *
 * 在 Windows 上写 `import ... from 'D:/.../x.mjs'` 会让 Node 的 ESM 加载器
 * 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（`d:` 不是一个认识的 scheme）——
 * 而那个错误发生在**子进程**里，主进程看到的只是"那个进程起来又退了"。
 */
const moduleHref = (...parts) => pathToFileURL(join(REPO_ROOT, ...parts)).href

/** 反向锚：这几份凭证哪一个都不许出现在任何可读输出里。 */
const TOKEN_A = 'prt253wire-token-a-1f9c'
const TOKEN_B = 'prt253wire-token-b-7d20'
const ALL_TOKENS = [TOKEN_A, TOKEN_B]

/** Launcher 交给 runtime / orchestrator 的键名（与清单声明的是同一个）。 */
const URL_ENV = 'LEGION_RUNTIME_URL'
const TOKEN_ENV = 'LEGION_RUNTIME_TOKEN'

const ABSENT = RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT
const STALE = RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE
const TOKEN_FAILED = RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED

// ───────────────────────────────────────────── 真进程用的两个脚本

/**
 * 替身 Runtime 进程：**真的**起一台契约监听器、**真的**发布临时端口。
 *
 * 它替换的只有"引擎"（用契约级 Fake 适配器），没有替换任何本批要验的机制：
 * 端口发布、鉴权、以及"临时端口只能从 `address()` 读回"。
 */
const RUNTIME_STUB_SRC = `
import { createServer } from 'node:http'
import { createRuntimeContractServer } from ${JSON.stringify(moduleHref('runtime', 'dsh-composition', 'runtime-contract-server.mjs'))}
import { publishRuntimeContractEndpoint } from ${JSON.stringify(moduleHref('runtime', 'dsh-composition', 'runtime-contract-publication.mjs'))}
import { createFakeRuntimeAdapter } from ${JSON.stringify(moduleHref('runtime', 'contracts', 'fake-adapter.mjs'))}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const readinessPort = Number(valueOf('--readiness-port'))
const noPublish = flag('--no-publish')

// ① DSH 进程"对外端口"上的最小服务：Launcher 的就绪判据打的是 \`/\`。
//    **与契约监听器是两个端口**（后者绑 0）。
const web = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('legion-runtime-stub')
})
await new Promise((resolve) => web.listen({ port: readinessPort, host: '127.0.0.1' }, resolve))

// ② 契约监听器：token 只从环境来，**不给默认值**。
const envToken = process.env.${TOKEN_ENV}
const token = typeof envToken === 'string' && envToken !== '' ? envToken : null
const created = createRuntimeContractServer({ adapter: createFakeRuntimeAdapter(), token, port: 0 })
if (created.ok !== true) { console.log('STUB SERVER-COULD-NOT-BE-CREATED ' + created.code); process.exit(2) }
const listened = await created.listen()
if (listened.ok !== true) { console.log('STUB LISTEN-FAILED ' + listened.code); process.exit(3) }

let published = null
if (!noPublish) {
  published = publishRuntimeContractEndpoint({
    dataDir: process.env.LEGION_DATA_DIR,
    host: listened.host,
    port: listened.port,
    pid: process.pid,
  })
}
// ★ 绝不打印 token：只打印"配没配"。
console.log('STUB ready contractPort=' + listened.port
  + ' tokenConfigured=' + (token !== null)
  + ' published=' + (published !== null && published.ok === true)
  + ' publicationCode=' + (published !== null && published.ok !== true ? published.code : 'none'))
setInterval(() => {}, 1 << 30)
`

/**
 * 替身 worker：读 Launcher 给的那一份 env，按契约发一次**带凭证**的真实请求，
 * 把读数写到 argv 给的文件里。它**不**打印 token。
 */
const WORKER_PROBE_SRC = `
import { writeFileSync } from 'node:fs'
const out = process.argv[2]
const url = process.env.${URL_ENV} ?? null
const rawToken = process.env.${TOKEN_ENV}
const token = typeof rawToken === 'string' && rawToken !== '' ? rawToken : null

const reading = { urlPresent: url !== null, tokenPresent: token !== null, status: null, code: null, error: null }
if (url !== null) {
  try {
    // capabilities 是**需要鉴权**的只读操作（getHealth 是唯一的匿名读操作）。
    const res = await fetch(url + '/legion/runtime/v1/capabilities', {
      headers: token === null ? {} : { authorization: 'Bearer ' + token },
    })
    reading.status = res.status
    const body = await res.json().catch(() => null)
    reading.code = body !== null && typeof body === 'object' ? (body.code ?? null) : null
  } catch (e) {
    reading.error = String(e?.cause?.code ?? e?.code ?? e?.message ?? e)
  }
}
writeFileSync(out, JSON.stringify(reading))
console.log('PROBE ' + JSON.stringify({ urlPresent: reading.urlPresent, tokenPresent: reading.tokenPresent, status: reading.status, code: reading.code }))
setInterval(() => {}, 1 << 30)
`

/** 造一个"合法但独立"的布局（与 launcher.test.mjs 同一条做法）。 */
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

/** 把两个脚本写进临时目录，返回它们的绝对路径。 */
function writeStubs(root) {
  const dir = join(root, 'stubs')
  mkdirSync(dir, { recursive: true })
  const runtime = join(dir, 'runtime-stub.mjs')
  const probe = join(dir, 'worker-probe.mjs')
  writeFileSync(runtime, RUNTIME_STUB_SRC)
  writeFileSync(probe, WORKER_PROBE_SRC)
  return { runtime, probe }
}

/** 等一个文件出现且能被解析（真进程写盘不是瞬时的）。 */
async function waitForJson(path, { timeoutMs = 15000, intervalMs = 100, onTimeout = null } = {}) {
  const began = Date.now()
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch { /* 还没写出来 */ }
    if (Date.now() - began >= timeoutMs) {
      throw new Error(`等不到 ${path}${onTimeout === null ? '' : `（子进程输出：${onTimeout()}）`}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 等**已经累积在父进程内存里**的子进程输出满足条件。返回当时的全文。
 *
 * ★ 为什么需要它：worker 桩的顺序是 `writeFileSync(out, …)` 之后才 `console.log('PROBE …')`
 * ——而 `boot()` 是**等那个文件**出现的。也就是说，`boot()` 返回时 `PROBE` 那一行
 * **可能还在管道里**。"子进程写过了"与"父进程读到了"是两件事。
 *
 *   > 一个"管道还没把字节送到"的读数，与一个"子进程根本没输出"的读数，
 *   > 在断言里是同一个失败——只不过前者要等一会儿，后者要改代码。
 *
 * 所以这里**不猜**：等到（有上限）或者报出等到了多少字节。
 */
async function waitForStdout(readText, re, { timeoutMs = 10000, intervalMs = 25, what = '子进程输出' } = {}) {
  const began = Date.now()
  for (;;) {
    const text = readText()
    if (re.test(text)) return text
    if (Date.now() - began >= timeoutMs) {
      throw new Error(`等不到 ${what} 匹配 ${re}（${timeoutMs}ms 内只收到 ${text.length} 字节：${JSON.stringify(text.slice(0, 300))}）`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 起一个受监督的部署：runtime 跑真监听器（stub），worker 跑探针。
 *
 * ★ `spawnImpl` **只**替换 worker 那一侧跑哪个文件；runtime 仍是真 spawn，
 *   而 worker 拿到的 `opts.env` 是 Launcher 算出来的那一份，**原样**传下去。
 */
async function boot({ tag, noPublish = false, seedStalePublication = null, over = {} }) {
  const root = mkdtempSync(join(tmpdir(), `legion-wire-${tag}-`))
  const stubs = writeStubs(root)
  const layout = layoutIn(root)
  const runtimePort = await reserveEphemeralPort()
  const resultFile = join(root, 'worker-reading.json')
  const stdout = { runtime: [], worker: [] }

  /**
   * 可选：在 Launcher 启动**之前**放一份"上一次运行留下的"发布。
   *
   * ★ 这条路径用的是**真 fs**（不注入 `publicationFs`）：它验的是
   * `clearStalePublication()` 里那个 `rmSync` 真的把旧文件删掉了。
   * 那个分支在"新装机器 / 上一次干净退出"时走的是 `ENOENT`，
   * 于是**只有先造一个旧文件**才走得到删除那一句。
   *
   *   > 一条只在崩溃后才走到的清理分支，与一条不存在的清理分支，
   *   > 在"新装机器"上是同一个东西——而它要防的恰恰是崩溃。
   */
  if (seedStalePublication !== null) {
    const dir = join(layout.dataDir, 'runtime')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'runtime-contract.json'), `${JSON.stringify(seedStalePublication)}\n`)
  }
  const publicationPath = join(layout.dataDir, 'runtime', 'runtime-contract.json')
  const seededBeforeStart = seedStalePublication !== null && existsSync(publicationPath)

  const spawnImpl = (file, args, opts) => {
    const isWorker = String(args?.[0] ?? '').includes('orchestrator')
    const child = spawn(
      isWorker ? process.execPath : file,
      isWorker ? [stubs.probe, resultFile] : args,
      { ...opts, env: opts.env },
    )
    const sink = isWorker ? stdout.worker : stdout.runtime
    // 自己再接一个监听器：监督层那个只是把它排空，这里要拿它做反向锚。
    if (child.stdout !== null && child.stdout !== undefined) {
      child.stdout.on('data', (chunk) => sink.push(String(chunk)))
    }
    return child
  }

  const L = createLauncher({
    layout,
    include: ['runtime', 'orchestrator'],
    runtimeCommand: `${process.execPath} "${stubs.runtime}" --readiness-port ${runtimePort}${noPublish ? ' --no-publish' : ''}`,
    ports: { runtime: runtimePort },
    // 强制面覆盖层这一套有自己的套件；本套件只验契约接线，
    // 关掉它以免"身份缺失"的那条诊断混进这里要断言的码里去。
    enforcementOverlay: false,
    exists: () => true,
    spawnImpl,
    ...over,
  })

  const started = await L.start()
  let reading = null
  try {
    reading = await waitForJson(resultFile, {
      timeoutMs: 15000,
      onTimeout: () => stdout.worker.join('').slice(0, 400),
    })
  } catch (e) {
    // worker 没写读数时，仍要把 Launcher 的读数交回调用方——
    // 否则"为什么没写"要从一条"等不到文件"里猜。
    reading = { unavailable: String(e.message) }
  }

  return {
    root,
    layout,
    L,
    started,
    reading,
    stdout,
    publicationPath,
    seededBeforeStart,
    resolved: L.runtimeContract(),
    codes: L.allDiagnostics().map((d) => d.code),
    envOf: (key) => L.envSurface().find((s) => s.process === key)?.values ?? null,
    argsOf: (key) => L.commandSurface().find((s) => s.process === key)?.args ?? null,
    async stop() {
      await L.stop({ graceMs: 2000 })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 一次部署的**签名**：负对照要断言的就是"两种处境的签名不同"。 */
function signature(b) {
  return JSON.stringify({
    resolvedOk: b.resolved === null ? null : b.resolved.ok,
    resolvedCode: b.resolved === null ? null : b.resolved.code,
    urlPresent: b.reading?.urlPresent ?? null,
    workerStatus: b.reading?.status ?? null,
    orchHasUrl: Object.prototype.hasOwnProperty.call(b.envOf('orchestrator') ?? {}, URL_ENV),
  })
}

// ═══════════════════════════════════════════ ① 端点真的到达 worker

test('① ★★★ 端点与凭证**真的到达** worker 进程，并被那台监听器接受（真进程、真 HTTP、真发布）', async (t) => {
  const b = await boot({ tag: 'ok' })
  t.after(() => b.stop())

  assert.equal(b.started.ok, true, `启动失败：${JSON.stringify(b.started.failures)}`)

  // Launcher 自己的读数：端点解析成功，且**是本次那个子进程**发布的
  assert.notEqual(b.resolved, null, '没有走到解析端点那一步')
  assert.equal(b.resolved.ok, true, `${b.resolved.code} ${b.resolved.message}`)
  assert.equal(b.resolved.pid, b.L.status().processes.find((p) => p.key === 'runtime').pid,
    'Launcher 采用的发布不是本次那个 runtime 子进程写的')

  // worker 那一侧的读数：它读到 URL、读到凭证，而且请求**被接受了**
  assert.equal(b.reading.urlPresent, true, `worker 没读到 ${URL_ENV}：${JSON.stringify(b.reading)}`)
  assert.equal(b.reading.tokenPresent, true, `worker 没读到 ${TOKEN_ENV}：${JSON.stringify(b.reading)}`)
  assert.equal(b.reading.status, 200, `worker 的请求没被接受：${JSON.stringify(b.reading)}`)

  // ★ 两边读数**对得上**：worker 用的那个端口就是发布里那一个
  assert.equal(b.resolved.url, `http://127.0.0.1:${b.resolved.port}`)
  // ★ 等它**真的到了父进程**再断言（见 `waitForStdout`：boot() 等的是那个读数文件，
  //   而 `PROBE` 那一行是在写文件**之后**才打印的，字节可能还在管道里）。
  await waitForStdout(() => b.stdout.worker.join(''), /PROBE /, { what: 'worker 的探针读数' })
  assert.match(b.stdout.worker.join(''), /PROBE /, '探针没有输出读数')

  // 别的进程**拿不到**这两个键（spec §6.7）
  for (const s of b.L.envSurface()) {
    if (s.process === 'runtime' || s.process === 'orchestrator') continue
    assert.equal(URL_ENV in s.values, false, `进程 ${s.process} 拿到了端点`)
    assert.equal(TOKEN_ENV in s.values, false, `进程 ${s.process} 拿到了凭证`)
  }
})

// ═══════════════════════════════════════════ ①b 顺带闭掉的第四个缺口

test('①b ★★ Launcher 也把 `LEGION_DATA_DIR` 交给 worker（否则 worker 起来就退 8）', async (t) => {
  const b = await boot({ tag: 'datadir' })
  t.after(() => b.stop())
  assert.equal(b.started.ok, true, `启动失败：${JSON.stringify(b.started.failures)}`)

  /**
   * ★ 这一条是本批**顺带**闭掉的第四个缺口，续批三与本事批的任务书里都没有它。
   *
   * `orchestrator/worker/run.mjs` 缺 `LEGION_DATA_DIR` 时返回 `exitCode: 8` /
   * `DATA_DIR_REQUIRED`（那段注释自己写着：状态文件是这个无监听端口进程的
   * **唯一观测出口**）。而在本批之前，`product/launcher/launcher.mjs`
   * 的 `derivedValuesFor()` **一次都没有**写过这个键——它能到达子进程
   * 只是因为白名单（`envNames`）一直放行它，然后由 `baseEnv`（默认是宿主的
   * `process.env`）顺手带进去。
   *
   *   > 「白名单放行」与「有人真的注入了它」是两件事。
   *   > 前者只在**宿主环境碰巧有**这个键时才等于后者。
   */
  assert.equal(b.envOf('orchestrator').LEGION_DATA_DIR, b.layout.dataDir,
    `worker 的状态文件锚点不是 Launcher 给的：${JSON.stringify(b.envOf('orchestrator'))}`)
  // runtime 也要（端口发布落在 DataDir 下），而且是**同一个**目录
  assert.equal(b.envOf('runtime').LEGION_DATA_DIR, b.layout.dataDir)
  // 反向锚：宿主环境**故意**带一个不同的值，注入的那个必须赢
  assert.notEqual(b.layout.dataDir, process.env.LEGION_DATA_DIR)
})

// ═══════════════════════════════════════════ ①b′ 同一个形状的反面

test('①b′ ★★★ Launcher 把 `LEGION_WORKSPACE_DIR` 交给 worker（否则一个任务都不认领）', async (t) => {
  const b = await boot({ tag: 'workspacedir' })
  t.after(() => b.stop())
  assert.equal(b.started.ok, true, `启动失败：${JSON.stringify(b.started.failures)}`)

  /**
   * ★ 这一条与 ①b 是**同一个形状的反面**，两个都要有：
   *
   * ```
   * LEGION_DATA_DIR       声明了，但 Launcher 从不给值  ⇒ 起来就退 8（崩溃循环）
   * LEGION_WORKSPACE_DIR  连声明都没有                  ⇒ 宿主环境里配了也传不下去
   * ```
   *
   * 第二种更安静：`buildChildEnv()` 只放行目标进程 `envNames` 里声明过的键，
   * 于是 `LEGION_WORKSPACE_DIR` 被**丢掉**，子进程读到 `undefined`。
   * 再往下走：`readWorkerEnv().workspaceDir === null`
   * ⇒ `resolveWorkspaceStages()` 返回 `{ stages: null }`
   * ⇒ worker 状态 `no-stages`，**一个任务都不认领**。
   *
   * 而它的外部表现只有状态文件里那一个词——没有错误、没有告警、
   * 没有任何一条日志说"我少了一个变量"。从产品上看就是"任务一直没人做"。
   *
   *   > 一个"没声明所以被白名单丢掉"的变量，
   *   > 与一个"根本没配"的变量，在子进程里是同一个读数（`undefined`）——
   *   > 只不过前者的部署方会反复确认自己明明配过了。
   */
  assert.equal(b.envOf('orchestrator').LEGION_WORKSPACE_DIR, b.layout.workspaceDir,
    `worker 的项目目录不是 Launcher 给的：${JSON.stringify(b.envOf('orchestrator'))}`)

  // 反向锚①：宿主环境**故意**带一个不同的值，注入的那个必须赢
  // （否则这一条断的只是"宿主碰巧有那个键"，与真的注入是两件事）
  assert.notEqual(b.layout.workspaceDir, process.env.LEGION_WORKSPACE_DIR)

  // 反向锚②：**只有 worker** 拿到它。hub / workbench / 白板不需要项目目录，
  // 放行给它们会让"这个进程能读到什么"重新变成一件要猜的事。
  // （runtime 也不需要：它的目录是**逐 Run** 由 `RunRequest.workdir` 给的。）
  for (const key of ['team-hub', 'workbench', 'whiteboard', 'runtime']) {
    const env = b.envOf(key)
    if (env === null || env === undefined) continue
    assert.equal('LEGION_WORKSPACE_DIR' in env, false,
      `进程 ${key} 不该拿到 LEGION_WORKSPACE_DIR：${JSON.stringify(env)}`)
  }
})

// ═══════════════════════════════════════════ ①d 端口真的到达 runtime 的 argv

test('①d ★★★ PRT-251 续：`ports.runtime` 到达 DSH 的 argv，且**在所有 launcher 旗标之后**', async (t) => {
  // 本缺口原来的一句话说：`ports.runtime` 收下、进计划、进诊断，**到不了 DSH**
  // （runtime 的 `argsTemplate` 是 `[]`，`envNames` 里也没有端口键）。
  //
  // ★ 这一条断的是**顺序**，不是「argv 里有没有 --port」。
  //   DSH 的命令行是「launcher 旗标段 + app 旗标段」，解析器遇到第一个不认识的
  //   token 就停止解析自己的旗标。所以 `--port` 一旦跑到 `--patch` **前面**，
  //   `--patch <覆盖层>` 就落进 app 段——**强制面补丁层静默消失**，
  //   而这次启动照样成功、端口照样生效。
  //
  //   > 一个「端口修好了但强制面没了」的启动，
  //   > 与一个「端口没修好、强制面还在」的启动，在**启动成功**这个读数上是
  //   > 同一个东西——只不过前者看起来更像一次成功的修复。
  //
  //   而那条 argv 的观察口在此之前**不存在**（`envSurface()` 只看环境），
  //   所以「覆盖层还在 launcher 段里」只能靠读代码相信。本批补了
  //   `L.commandSurface()`。
  const b = await boot({ tag: 'runtimeport' })
  t.after(() => b.stop())

  const args = b.argsOf('runtime')
  assert.notEqual(args, null, 'runtime 没有命令（入口没解析出来）')

  // ① 端口真的到了 argv，且值是**本次计划**那个端口
  const runtimeStatus = b.L.status().processes.find((s) => s.key === 'runtime')
  const expectedPort = runtimeStatus?.port
  assert.ok(args.includes('--port'), `runtime 的 argv 里没有 --port：${JSON.stringify(args)}`)
  assert.equal(args[args.indexOf('--port') + 1], String(expectedPort),
    `--port 后面不是本次计划的端口：${JSON.stringify(args)}`)

  // ② ★ 覆盖层仍在 **launcher 段**里：`--patch <文件>` 必须早于 `--port`
  const patchAt = args.indexOf('--patch')
  if (patchAt >= 0) {
    assert.ok(patchAt < args.indexOf('--port'),
      `--patch 跑到了 --port 后面，于是它变成 app 参数、强制面覆盖层静默失效：${JSON.stringify(args)}`)
    // 覆盖层后面紧跟的就是那个文件（不是随便一个值）
    assert.match(String(args[patchAt + 1]), /\.ya?ml$/, `--patch 后面不是一个补丁层文件：${JSON.stringify(args)}`)
  }

  // ③ 反向锚：**端口不进环境**。两条路径都能决定同一件事时，
  //    「实际生效的是哪一个」会变成每次排障都要重新确认的问题
  //    （与 workbench 那句理由逐字相同，见 launcher.mjs 的 PORT_ENV_KEYS）。
  const env = b.envOf('runtime') ?? {}
  for (const k of ['PORT', 'LEGION_RUNTIME_PORT']) {
    assert.equal(k in env, false, `runtime 的环境里出现了端口键 ${k}：端口应当只有一个来源`)
  }

  // ④ 它的就绪 URL 用的是同一个端口（否则"探测的"与"监听的"是两个数）
  if (runtimeStatus?.url) {
    assert.match(runtimeStatus.url, new RegExp(`:${expectedPort}$`),
      `就绪 URL 与 argv 的端口不一致：${runtimeStatus.url}`)
  }
})

// ═══════════════════════════════════════════ ①c 真入口（不是探针）

/**
 * 真入口那一条：跑的是 `product/orchestrator/worker.mjs` 本身，
 * 不是上面那个探针。
 *
 * 它存在的理由是 ①b 的一个**射程限制**：①b 断的是"Launcher 算出并注入了
 * `LEGION_DATA_DIR`"，而注入值的**消费者**是另一个文件里的另一段代码
 * （`orchestrator/worker/run.mjs`：缺它就 `exitCode 8` / `DATA_DIR_REQUIRED`）。
 * 「注入了」与「那个消费者因此不死了」是两件事，只有把真入口跑起来才连得上。
 */
test('①c ★★★ 真入口：Launcher 启动**真的** worker.mjs 时它稳定运行；没有 DataDir 时退 8', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-wire-realentry-'))
  const layout = layoutIn(root)
  mkdirSync(layout.dataDir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // ── 正向：真 existsSync（于是入口就是 product/orchestrator/worker.mjs），真 spawn ──
  const L = createLauncher({
    layout,
    include: ['orchestrator'],
    exists: existsSync,
    installRoot: REPO_ROOT,
    nodePath: process.execPath,
    // 强制面覆盖层与本套件的主题无关，关掉它以免它的诊断混进来。
    enforcementOverlay: false,
  })
  try {
    const started = await L.start()
    assert.equal(started.ok, true, `启动失败：${JSON.stringify(started.failures)}`)
    const proc = () => L.status().processes.find((p) => p.key === 'orchestrator')
    // 给它足够的时间**死掉并重启两次**（若它会死的话）——这个等待是断言的一部分：
    // 不等的话，"刚好还没崩"会让这条在错误的实现上也是绿的。
    await new Promise((r) => setTimeout(r, 2500))
    assert.equal(typeof proc().pid, 'number', `真 worker 没有进程：${JSON.stringify(proc())}`)
    assert.equal(proc().state, 'ready',
      `真 worker 不在稳定运行（拿到 DataDir 时它不该会死）：${JSON.stringify(proc())}`)
    // ★ 重启计数是零：这是"它一直在死"与"它好好活着"在读数上的分界。
    //   破验量过：去掉 Launcher 那行注入，这里会变成 restarts≥2、state='restarting'、pid=null。
    assert.equal(proc().restarts, 0, `真 worker 在重启循环里：${JSON.stringify(proc())}`)
  } finally {
    await L.stop({ graceMs: 2000 })
  }

  // ── 负向对照：**同一个文件**、只少 `LEGION_DATA_DIR`，它必须退 8 并说出码 ──
  const workerPath = join(REPO_ROOT, 'product', 'orchestrator', 'worker.mjs')
  assert.equal(existsSync(workerPath), true, `真入口不在：${workerPath}`)
  const bare = spawn(process.execPath, [workerPath], {
    cwd: REPO_ROOT,
    // 刻意只给最少的东西：不给 LEGION_DATA_DIR（这正是被验的前提）。
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  bare.stderr.on('data', (b) => { err += String(b) })
  const code = await new Promise((res, rej) => {
    const timer = setTimeout(() => { try { bare.kill() } catch { /* 已退 */ } ; rej(new Error(`真 worker 没有在 10s 内退出（stderr=${err}）`)) }, 10_000)
    bare.on('exit', (c) => { clearTimeout(timer); res(c) })
    bare.on('error', rej)
  })
  assert.equal(code, 8, `缺 DataDir 时真 worker 的退出码必须是 8，实际 ${code}（stderr=${err}）`)
  assert.match(err, /DATA_DIR_REQUIRED/, `缺 DataDir 的拒绝必须带具名码：${err}`)
  assert.match(err, /LEGION_DATA_DIR/, `拒绝理由必须点名那个键：${err}`)
})

// ═══════════════════════════════════════════ ② 负对照：没有发布

test('② ★★★ 负对照：Runtime 在听但**没有发布** → 具名拒绝、不编 URL，且读数与①**不同**', async (t) => {
  const ok = await boot({ tag: 'cmp-ok' })
  t.after(() => ok.stop())
  const absent = await boot({ tag: 'cmp-absent', noPublish: true, over: { runtimeContractWaitMs: 300, runtimeContractIntervalMs: 20 } })
  t.after(() => absent.stop())

  // ── 正向：证明上面那次"没有发布"不是环境问题造成的偶然 ──
  assert.equal(ok.reading.status, 200, `正向对照没跑通：${JSON.stringify(ok.reading)}`)

  // ── 启动本身**成功**：runtime 进程是健康的（它的 `/` 返回 200），
  //    缺的只是"没人发现得了那台契约监听器"。这正是本批要把它变成具名读数的处境。
  assert.equal(absent.started.ok, true, `启动失败：${JSON.stringify(absent.started.failures)}`)

  // ── 具名拒绝 ──
  assert.notEqual(absent.resolved, null)
  assert.equal(absent.resolved.ok, false, '没有发布却解析成功了——那说明 URL 是编出来的')
  assert.equal(absent.resolved.code, ABSENT)
  assert.equal(absent.resolved.code === ABSENT, true, '必须是**那一条**码，不是"其中一条"')
  assert.equal('url' in absent.resolved, false, '拒绝里带着一个 url——调用方可能顺手用它')
  assert.equal(absent.codes.filter((c) => c === ABSENT).length, 1,
    `诊断里应当恰好有一条 ABSENT：${JSON.stringify(absent.codes)}`)

  // ── 不编 URL：orchestrator 的环境里**没有**这个键 ──
  assert.equal(URL_ENV in absent.envOf('orchestrator'), false, '没解析出端点却注入了 URL')
  // 而凭证**仍然**在（它不依赖发布）——两件事互不牵连
  assert.equal(absent.envOf('orchestrator')[TOKEN_ENV], '<redacted>')

  // ── worker 那一侧的读数：它自己说"没有 URL" ──
  assert.equal(absent.reading.urlPresent, false)
  assert.equal(absent.reading.status, null, '没有 URL 却发出了请求')

  // ── ★ 两种处境的读数**必须不同**（负对照的全部意义） ──
  const a = signature(absent)
  const b = signature(ok)
  assert.notEqual(a, b, `两种处境读出了同一个签名：${a}`)
  assert.match(b, /"resolvedOk":true/)
  assert.match(a, /"resolvedOk":false/)
})

// ═══════════════════════════════════════════ ③ 陈旧发布

test('③ ★★ 陈旧发布（上一次运行留下的 pid）→ `PUBLICATION_STALE`，**不**被读成"引擎是好的"', async (t) => {
  // 一份"上一次运行"的发布：pid 不可能存活、端口上什么都没有。
  // 清理由注入的 fs 承担——它**故意不清**，于是读回来的一定是这一份。
  const staleRecord = { version: 1, pid: 999_999, host: '127.0.0.1', port: 1, wireVersion: 1 }
  const staleFs = {
    rmSync() { /* 故意不清：模拟"上一次的发布活到了本次启动" */ },
    readFileSync() { return JSON.stringify(staleRecord) },
  }
  const b = await boot({
    tag: 'stale',
    over: { publicationFs: staleFs, runtimeContractWaitMs: 300, runtimeContractIntervalMs: 20 },
  })
  t.after(() => b.stop())
  // 负对照：同一套装配、只是**没有**发布（用来断言"陈旧"与"没有"读数不同）
  const absent = await boot({
    tag: 'stale-cmp-absent',
    noPublish: true,
    over: { runtimeContractWaitMs: 300, runtimeContractIntervalMs: 20 },
  })
  t.after(() => absent.stop())

  assert.equal(b.resolved.ok, false)
  assert.equal(b.resolved.code, STALE)
  // 读数必须**指明**是哪个进程写的（否则运维只知道"不对"，不知道"谁写的"）
  assert.equal(b.resolved.publishedPid, 999_999)
  assert.notEqual(b.resolved.publishedPid, b.L.status().processes.find((p) => p.key === 'runtime').pid)

  assert.equal(b.codes.filter((c) => c === STALE).length, 1,
    `诊断里应当恰好有一条 STALE：${JSON.stringify(b.codes)}`)
  // ★ 两条码分开：一个去看"那一行挂没挂"，一个去看"谁在写同一个 DataDir"
  assert.notEqual(STALE, ABSENT)
  assert.equal(absent.resolved.code, ABSENT)

  assert.equal(URL_ENV in b.envOf('orchestrator'), false, '采用了一份陈旧的发布')
  assert.equal(b.reading.urlPresent, false)
  // ★ "陈旧"与"没有"的读数**必须不同**：一份坏掉的发布不得被读成"引擎是好的"，
  //   也不得被读成"没人发布"——后者的修法是"去挂那一行"，前者是"去看谁在写同一个 DataDir"。
  assert.notEqual(signature(b), signature(absent), `陈旧发布与没有发布的读数相同：${signature(b)}`)
})

// ═══════════════════════════════════════════ ③b 崩溃残留：真 fs 的清理

/**
 * 一份**记账包装**：每个调用都转给真的 `node:fs`，另外把调用顺序记下来。
 *
 * 为什么必须记账而不是只看"最后文件对了"：真 fs 下 Runtime 进程会把新发布
 * **覆盖**上去，于是"清掉了旧文件"与"没清、只是被覆盖了"在**最终状态上同形**。
 * 破验量过：把 `clearStalePublication()` 那一句 `rmSync` 删掉，只看最终状态的
 * 断言**照样绿**。
 *
 *   > 一条只能看见末态的断言，分不出"做过清理"与"结果碰巧一样"。
 */
function recordingRealFs() {
  const calls = []
  return {
    calls,
    rmSync(p, o) { calls.push(['rmSync', p, o]); return rmSync(p, o) },
    readFileSync(p, enc) { calls.push(['readFileSync', p]); return readFileSync(p, enc) },
  }
}

test('③b ★★ 崩溃残留：Launcher 在 spawn Runtime **之前**删掉上一次的发布，本次再覆盖它', async (t) => {
  // 上一次运行崩溃留下的那一份：pid 早已回收、端口早已不属于任何人。
  const crashed = { version: 1, pid: 999_998, host: '127.0.0.1', port: 1, wireVersion: 1 }
  const fs = recordingRealFs()
  const b = await boot({ tag: 'crash-stale', seedStalePublication: crashed, over: { publicationFs: fs } })
  t.after(() => b.stop())

  // ★ 先钉住"启动之前它确实在"——否则下面"启动之后它变了"可能是因为它从来没被写过，
  //   而 `clearStalePublication()` 那一句 `rmSync` 就只会走 ENOENT 分支。
  assert.equal(b.seededBeforeStart, true, '夹具没能在启动前造出旧发布')

  // ★ 清理**真的发生了**：先对发布路径调过 rmSync，而且 force 为真。
  const target = b.publicationPath
  const rmIndex = fs.calls.findIndex((c) => c[0] === 'rmSync' && c[1] === target)
  assert.notEqual(rmIndex, -1,
    `Launcher 没有清掉上一次的发布（记账：${JSON.stringify(fs.calls.map((c) => c[0] + ':' + String(c[1]).split(/[\\/]/).pop()))}）`)
  assert.equal(fs.calls[rmIndex][2]?.force, true, 'rmSync 必须带 force：ENOENT 要当成功')
  // 而且清理发生在**任何一次读**之前（否则"清"发生在读到旧值之后，等于没清）
  const firstRead = fs.calls.findIndex((c) => c[0] === 'readFileSync')
  assert.notEqual(firstRead, -1, '整个启动过程里一次发布都没被读过')
  assert.ok(rmIndex < firstRead, `清理排在读取之后（rm@${rmIndex} / read@${firstRead}）——那时已经晚了一步`)

  assert.equal(b.started.ok, true, `启动失败：${JSON.stringify(b.started.failures)}`)
  // 本次启动**成功解析**了端点：pid 对上了（旧文件先被删掉、随后新发布写进来）
  assert.equal(b.resolved.ok, true,
    `读到的是旧发布：${b.resolved.code} ${b.resolved.message}`)

  const after = JSON.parse(readFileSync(target, 'utf8'))
  assert.notEqual(after.pid, crashed.pid, '旧发布的 pid 还在文件里——清理/覆盖没生效')
  assert.equal(after.pid, b.L.status().processes.find((p) => p.key === 'runtime').pid)
  assert.equal(after.port, b.resolved.port)
  assert.notEqual(after.port, 1)

  // 而且 worker 那一侧真的连上了（不是"Launcher 自己以为通了"）
  assert.equal(b.reading.urlPresent, true)
  assert.equal(b.reading.status, 200, JSON.stringify(b.reading))
})

// ═══════════════════════════════════════════ ④ 凭证

test('④ ★★★ 凭证生成失败 ⇒ **不注入**，对端以 `NO_TOKEN` 拒（不是"关掉鉴权"）', async (t) => {
  const b = await boot({
    tag: 'notoken',
    over: {
      runtimeTokenFactory: () => { throw new Error('ENODEV: 没有随机源') },
    },
  })
  t.after(() => b.stop())

  // ① 生成失败 → 两个进程**都没有**这个键（fail closed：不空串、不默认值、不"关掉鉴权"）
  for (const key of ['runtime', 'orchestrator']) {
    assert.equal(TOKEN_ENV in b.envOf(key), false, `凭证生成失败却给 ${key} 注入了凭证`)
  }
  // ② 诊断里是**那一条**码
  assert.equal(b.codes.filter((c) => c === TOKEN_FAILED).length, 1,
    `诊断里应当恰好有一条生成失败：${JSON.stringify(b.codes)}`)
  // ③ 真进程里的对端读数：Server 没配 token → **403 + RUNTIME_CONTRACT_NO_TOKEN**
  assert.equal(b.reading.status, 403, `对端没有以 403 拒绝：${JSON.stringify(b.reading)}`)
  assert.equal(b.reading.code, 'RUNTIME_CONTRACT_NO_TOKEN')
  // ★ 反向锚：它**没有**变成"匿名放行"（200）
  assert.notEqual(b.reading.status, 200)
})

test('④ ★★★ token 路径四态（真监听器、真请求）：配对 ⇒ 200；缺 ⇒ 401；错 ⇒ 401；服务端没配 ⇒ 403', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-wire-token-'))
  const stubs = writeStubs(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  /**
   * 起一台替身 Runtime（真服务端 + 真发布），再用**指定的** env 跑一次探针。
   *
   * 这三态刻意不走 Launcher：Launcher 只会给"配好了"的那一种，
   * 而这里要问的是"另外三种长什么样"。
   */
  async function run({ serverToken, clientToken }) {
    const dataDir = mkdtempSync(join(root, 'data-'))
    const readinessPort = await reserveEphemeralPort()
    const env = { ...process.env, LEGION_DATA_DIR: dataDir }
    delete env[TOKEN_ENV]
    if (serverToken !== undefined) env[TOKEN_ENV] = serverToken
    const server = spawn(process.execPath, [stubs.runtime, '--readiness-port', String(readinessPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let serverOut = ''
    server.stdout.on('data', (c) => { serverOut += String(c) })
    server.stderr.on('data', (c) => { serverOut += String(c) })
    let probe = null
    try {
      // ★ 等发布出现——端口只从发布里拿（**不猜**）
      const publicationPath = join(dataDir, 'runtime', 'runtime-contract.json')
      const began = Date.now()
      while (!existsSync(publicationPath)) {
        if (Date.now() - began > 15000) throw new Error(`替身 runtime 没发布（输出：${serverOut}）`)
        await new Promise((r) => setTimeout(r, 50))
      }
      const record = JSON.parse(readFileSync(publicationPath, 'utf8'))
      assert.equal(record.pid, server.pid, '发布里的 pid 不是那台替身的')

      const probeEnv = { ...process.env, [URL_ENV]: `http://127.0.0.1:${record.port}` }
      delete probeEnv[TOKEN_ENV]
      if (clientToken !== undefined) probeEnv[TOKEN_ENV] = clientToken
      const resultFile = join(dataDir, 'probe.json')
      probe = spawn(process.execPath, [stubs.probe, resultFile], { env: probeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let probeOut = ''
      probe.stdout.on('data', (c) => { probeOut += String(c) })
      probe.stderr.on('data', (c) => { probeOut += String(c) })
      const reading = await waitForJson(resultFile, { onTimeout: () => probeOut.slice(0, 400) })
      return { reading, probeOut, serverOut, record }
    } finally {
      if (probe !== null) probe.kill('SIGKILL')
      server.kill('SIGKILL')
    }
  }

  const accepted = await run({ serverToken: TOKEN_A, clientToken: TOKEN_A })
  assert.equal(accepted.reading.status, 200, `配对凭证被拒了：${JSON.stringify(accepted.reading)}`)
  assert.equal(accepted.reading.code, null)

  const serverUnconfigured = await run({ serverToken: undefined, clientToken: undefined })
  assert.equal(serverUnconfigured.reading.status, 403, JSON.stringify(serverUnconfigured.reading))
  assert.equal(serverUnconfigured.reading.code, 'RUNTIME_CONTRACT_NO_TOKEN')

  const clientAbsent = await run({ serverToken: TOKEN_A, clientToken: undefined })
  assert.equal(clientAbsent.reading.status, 401, JSON.stringify(clientAbsent.reading))
  assert.equal(clientAbsent.reading.code, 'RUNTIME_CONTRACT_UNAUTHORIZED')

  const clientWrong = await run({ serverToken: TOKEN_A, clientToken: TOKEN_B })
  assert.equal(clientWrong.reading.status, 401, JSON.stringify(clientWrong.reading))
  assert.equal(clientWrong.reading.code, 'RUNTIME_CONTRACT_UNAUTHORIZED')

  // ★ 四态两两可分
  const sig = (r) => `${r.reading.status}/${r.reading.code}`
  const all = [accepted, serverUnconfigured, clientAbsent, clientWrong].map(sig)
  assert.equal(new Set(all).size, 3, `四种处境读出了 ${new Set(all).size} 种签名：${all.join(' | ')}`)
  // "缺"与"错"**必须**同码（修法相同：把凭证配对），
  // 而"服务端没配"必须**不同**码（修法不同：把凭证交给 Runtime 进程）。
  assert.equal(sig(clientAbsent), sig(clientWrong))
  assert.notEqual(sig(clientAbsent), sig(serverUnconfigured))
  assert.notEqual(sig(serverUnconfigured), sig(accepted))

  // ★ 反向锚：任何一处可读输出里都不许出现凭证的值
  for (const r of [accepted, serverUnconfigured, clientAbsent, clientWrong]) {
    for (const text of [JSON.stringify(r.reading), r.probeOut, r.serverOut, JSON.stringify(r.record)]) {
      for (const t2 of ALL_TOKENS) {
        assert.equal(text.includes(t2), false, `可读输出里出现了凭证的值：${text.slice(0, 200)}`)
      }
    }
  }
})

// ═══════════════════════════════════════════ ⑤ 反向锚

test('⑤ ★★★ 凭证的值**不出现**在任何进程的可读输出里（envSurface / status / 诊断 / 日志 / 运行记录 / 子进程 stdout）', async (t) => {
  // ★ 注入一个**已知值**：不这么做就只能断言"某个我不知道的字符串没出现"，
  //   而那是一条恒真的断言（与跨进程套件的 ALL_TOKENS 同一条做法）。
  const b = await boot({
    tag: 'anchor',
    over: { runtimeTokenFactory: () => ({ ok: true, token: TOKEN_A }) },
  })
  t.after(() => b.stop())

  assert.equal(b.started.ok, true, `启动失败：${JSON.stringify(b.started.failures)}`)
  // 正向：凭证**确实**到了 worker 并被接受——否则"它没出现在输出里"
  // 可能是因为它压根没被注入（一条恒真的反向锚）。
  assert.equal(b.reading.tokenPresent, true)
  assert.equal(b.reading.status, 200)

  // ★★ 先等两个子进程的输出**真的到了父进程**，再取快照。
  //
  // 这一条以前是**假红**的来源：`boot()` 等的是 worker 的读数文件，而 `PROBE` 那一行是在
  // 写文件**之后**才打印的——于是负载高时 `PROBE` 还没进管道，本用例就在
  // 「凭证不泄漏」这条断言上以 `/PROBE /` 不匹配而失败。**失败文案看起来像"凭证泄漏了"**，
  // 而它其实什么都没说。等之后再取快照还有一个好处：快照**更大**，泄漏断言覆盖更多输出。
  const stdoutOf = () => [...b.stdout.runtime, ...b.stdout.worker].join('')
  await waitForStdout(() => b.stdout.runtime.join(''), /STUB ready/, { what: 'runtime 的 ready 行' })
  await waitForStdout(() => b.stdout.worker.join(''), /PROBE /, { what: 'worker 的探针读数' })

  const surfaces = {
    envSurface: JSON.stringify(b.L.envSurface()),
    status: JSON.stringify(b.L.status()),
    diagnostics: JSON.stringify(b.L.allDiagnostics()),
    childStdout: stdoutOf(),
  }
  // 而且它确实出现在这张表里（掩码形态）——否则下面几条断言是空的
  assert.equal(b.envOf('orchestrator')[TOKEN_ENV], '<redacted>')

  for (const [name, text] of Object.entries(surfaces)) {
    assert.equal(text.includes(TOKEN_A), false, `${name} 泄漏了凭证的值`)
  }

  // 运行记录（"这台机器上有哪些我们的进程"，会被反复读写）
  const recordPath = runRecordPath(b.layout.dataDir)
  if (existsSync(recordPath)) {
    assert.equal(readFileSync(recordPath, 'utf8').includes(TOKEN_A), false, '运行记录泄漏了凭证的值')
  }

  // 日志（用户真正会打开、会贴进 issue、会附进诊断包的东西）
  let logFiles = []
  try { logFiles = readdirSync(b.layout.logDir) } catch { /* 没有日志目录 */ }
  for (const f of logFiles) {
    const text = readFileSync(join(b.layout.logDir, f), 'utf8')
    assert.equal(text.includes(TOKEN_A), false, `日志 ${f} 泄漏了凭证的值`)
  }

  // 两个子进程的 stdout 里必须有**内容**（否则这条断言什么都没查）。
  // 上面已经等到了，所以这两条现在不会因管道延迟而红——但它们仍然要留着：
  // 谁哪天把上面的等待删掉，这两条就会立刻把"断言变成空的"这件事喊出来。
  assert.match(surfaces.childStdout, /STUB ready/)
  assert.match(surfaces.childStdout, /PROBE /)
})
