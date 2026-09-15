// runtime/dsh-composition/plugins/runtime-contract-server-row.test.mjs
// ============================================================================
// `runtime-contract-server-row.mjs` 的**行内**套件（PRT-253 续批四）
//
// 本套件补的是续批四新增的那一截：**端口发布**。
//
// ## 它断言什么、不断言什么
//
// 断言的是**这一行把什么发布出去了**：
//   · 发布的内容里的端口**就是** `address()` 读回来的那个（不是参数里的 0）；
//   · 没有 `dataDir` 时是一条**可见的降级**（`ok:true` + warning），不是失败；
//   · 写失败时是 `PUBLICATION_FAILED`（与"没给目录"分得开）；
//   · 卸载时监听器关掉、发布文件**也被清掉**（不留陈旧发布）；
//   · 陈旧发布会被本次覆盖（写侧的那一半）。
//
// 它**不**断言"另一个进程里的 worker 因此能连上"——那是
// `orchestrator/worker/runtime-contract-cross-process.test.mjs` 的事：
// 本套件里跑的是**替身运行时宿主**，所以这里也只许断言"这一行发布了什么"。
//
//   > 一条"发布文件里有端口"的断言，与一条"worker 连上了"的断言，
//   > 在替身宿主在场时完全同形——只不过后者根本没有被验过。
//
// ## 反向锚
//
// 每一处都额外断言：**服务值与发布文件里都不出现 token 的值**。
// 它是一条"否定性断言"，只有真的把值写进去才会红。
// ============================================================================

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import runtimeContractServerRow, {
  RUNTIME_CONTRACT_ROW_CODES,
  RUNTIME_CONTRACT_ROW_VERSION,
  RUNTIME_CONTRACT_SERVER_SERVICE,
  resetRuntimeContractInputsFactory,
  runtimeContractInputsFactory,
  setRuntimeContractInputsFactory,
  verdictFromRuntimeHostBinding,
} from './runtime-contract-server-row.mjs'
import { RUNTIME_HOST_ROW_CODES } from './runtime-host-row.mjs'
import { RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS } from '../runtime-contract-publication.mjs'

const TOKEN = 'prt253row-token-z-4b81'
const OTHER_TOKEN = 'prt253row-token-y-77e2'

/** 这两份凭证哪一个都不许出现在任何可读输出里。 */
const ALL_TOKENS = [TOKEN, OTHER_TOKEN]

/** 一个够用的替身宿主：`assertHostPort` 只要求这两个方法在。 */
const HOST = Object.freeze({ startRun() {}, probeRuntime() {} })

/** 最小 Context：`provide` 必填，`get` / `effect` 按需。 */
function fakeCtx() {
  const services = new Map()
  const effects = []
  return {
    services,
    effects,
    dispose() { for (const fn of [...effects].reverse()) fn() },    provide(name, value) { services.set(name, value) },
    get(name) { return services.get(name) },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
  }
}

/**
 * 装一次这一行。
 *
 * ★ 每个用例都必须 dispose：这一行会真的绑一个监听器，
 *   留着它就等于留一个占着临时端口的句柄（也会让 `node --test` 不退出）。
 */
const OPEN = []
afterEach(() => {
  for (const ctx of OPEN.splice(0)) {
    try { ctx.dispose() } catch { /* 已关 */ }
  }
  resetRuntimeContractInputsFactory()
})

async function mount({ dataDir, token = TOKEN, bindPort = 0 } = {}) {
  setRuntimeContractInputsFactory(() => ({ runtimeHost: HOST, token, bindPort, dataDir }))
  const ctx = fakeCtx()
  OPEN.push(ctx)
  await runtimeContractServerRow.apply(ctx)
  const served = ctx.services.get(RUNTIME_CONTRACT_SERVER_SERVICE)
  assert.ok(served !== undefined, '这一行没有 provide 任何服务值')
  const usableDir = typeof dataDir === 'string' && dataDir.trim() !== ''
  return {
    ctx,
    served,
    publicationPath: usableDir ? join(dataDir.trim(), ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS) : null,
  }
}

function tmpRoot(tag) {
  return mkdtempSync(join(tmpdir(), `legion-rcrow-${tag}-`))
}

/** 这个进程自己的 pid —— 行内发布时用的就是这个来源。 */
const SELF_PID = process.pid

test('① 发布的内容里，端口**就是** bindPort:0 之后内核分配的那个（不是 0，不是默认值）', async () => {
  const root = tmpRoot('bind')
  try {
    const dataDir = join(root, 'data')
    const { served, publicationPath } = await mount({ dataDir })
    assert.equal(served.ok, true, `${served.code} ${served.message}`)
    assert.equal(served.listening, true)
    assert.equal(served.publication.published, true, `没发布：${served.publication.code}`)
    assert.equal(served.publication.path, publicationPath)
    assert.equal(existsSync(publicationPath), true)

    const record = JSON.parse(readFileSync(publicationPath, 'utf8'))
    // ★ 这一条是本套件的核心：**发布的端口等于实际在听的那个端口**。
    //   它是"写侧发布的是 address() 的结果、不是 bindPort 参数"的唯一证据——
    //   把 `listened.port` 写成 `bindPort` 会让这条断言读到 0。
    assert.equal(record.port, served.port,
      `发布里的端口(${record.port})与在听的端口(${served.port})不一致`)
    assert.notEqual(record.port, 0, '发布了 0：那是"让内核分配"，不是"端口是 0"')
    assert.notEqual(record.port, 3080, '发布了 3080：一个默认端口会让"没配"与"配了"同形')
    assert.equal(record.host, '127.0.0.1')
    assert.equal(record.pid, SELF_PID, '发布的 pid 必须是本进程自己的——它是消费侧唯一的陈旧判据')
    assert.equal(record.version, 1)

    // ── 反向锚：凭证的值不在服务值里、也不在发布文件里 ──
    const servedText = JSON.stringify(served)
    const fileText = readFileSync(publicationPath, 'utf8')
    for (const t of ALL_TOKENS) {
      assert.equal(servedText.includes(t), false, '服务值里出现了凭证的值')
      assert.equal(fileText.includes(t), false, '发布文件里出现了凭证的值')
    }
    assert.equal(served.tokenConfigured, true)
    assert.equal('token' in served, false, '服务值上有一个 token 字段——那正是"看起来只是状态"的泄漏口')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('① 连续两次挂载拿到**不同**的端口（临时端口，不是固定值）', async () => {
  const root = tmpRoot('twice')
  try {
    const dataDir = join(root, 'data')
    const a = await mount({ dataDir })
    const b = await mount({ dataDir })
    assert.notEqual(a.served.port, b.served.port,
      '两次挂载拿到了同一个端口——那说明它不是内核分配的临时端口')
    // 后一次把前一次顶掉：发布文件描述的永远是**当下**那个监听器
    assert.equal(JSON.parse(readFileSync(b.publicationPath, 'utf8')).port, b.served.port)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('② 没有 `dataDir` → **可见的降级**：ok:true、在听、但 publication.published=false 且 warning 具名', async () => {
  const { served } = await mount({ dataDir: undefined })
  // 关键：它**不是**失败。把降级与"没装上"合成一个读数，
  // 会让一个只配了一半的部署看起来像完全没配。
  assert.equal(served.ok, true, `少一个可选输入竟然让整行失败了：${served.code}`)
  assert.equal(served.listening, true)
  assert.equal(typeof served.port, 'number')
  assert.equal(served.publication.published, false)
  assert.equal(served.publication.path, null)
  assert.equal(served.publication.code, RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR)
  // 而且理由必须出现在 warnings 里——只在状态字段上的话，不查它的人看不到
  assert.ok(served.warnings.includes(RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR),
    `warnings 里没有那条码：${served.warnings.join(',')}`)
  // 反向：它**不是**"写失败"那一条码
  assert.equal(served.warnings.includes(RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED), false)
})

test('② 空串/纯空白 `dataDir` 与没给一样算"没配"，不算"配了一个空路径"', async () => {
  for (const dataDir of ['', '   ', '\t']) {
    const { served } = await mount({ dataDir })
    assert.equal(served.ok, true, `dataDir=${JSON.stringify(dataDir)} 让整行失败了`)
    assert.equal(served.publication.code, RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR,
      `dataDir=${JSON.stringify(dataDir)} 被判成了别的处境`)
    assert.equal(served.publication.published, false)
  }
})

test('③ 发布写不进去 → `PUBLICATION_FAILED`，与"没给目录"**是两个码**', async () => {
  const root = tmpRoot('fail')
  try {
    // 用**一个文件**当父目录：mkdirSync 递归必然失败（ENOTDIR/EEXIST）。
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const { served } = await mount({ dataDir: join(blocker, 'data') })
    assert.equal(served.ok, true, '写不进去不该让整行失败——监听器本身是好的')
    assert.equal(served.listening, true)
    assert.equal(served.publication.published, false)
    assert.equal(served.publication.code, RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED)
    assert.ok(served.warnings.includes(RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED))
    // ★ 两条码必须分得开：一个去补输入，一个去查路径
    assert.notEqual(RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED, RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR)
    assert.equal(served.publication.path, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('④ 卸载时：监听器关掉，**发布文件也被清掉**（不留一份"看起来还在"的陈旧发布）', async () => {
  const root = tmpRoot('dispose')
  try {
    const dataDir = join(root, 'data')
    const { ctx, served, publicationPath } = await mount({ dataDir })
    assert.equal(existsSync(publicationPath), true)
    ctx.dispose()
    assert.equal(existsSync(publicationPath), false,
      '这一行卸掉了，发布文件还在——那描述的是一个已经不在听的端口')
    // 再看一眼那个端口：必须已经没人应答（关掉的是真的监听器，不是只删了个文件）
    const res = await fetch(`http://127.0.0.1:${served.port}/legion/runtime/v1/health`)
      .then(() => 'connected', (e) => `refused:${e?.cause?.code ?? e?.code ?? 'unknown'}`)
    assert.match(res, /^refused:/, `卸载之后端口还在应答：${res}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('④ 陈旧发布会被本次**覆盖**（写侧的那一半：文件里是本进程的 pid 与本次的端口）', async () => {
  const root = tmpRoot('stale')
  try {
    const dataDir = join(root, 'data')
    const publicationPath = join(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)
    // 先造一份"上一次运行"的发布：pid 1（不可能存活）、端口 1
    mkdirSync(join(dataDir, 'runtime'), { recursive: true })
    writeFileSync(publicationPath, `${JSON.stringify({
      version: 1, pid: 1, host: '127.0.0.1', port: 1, wireVersion: 1,
    })}\n`)

    const { served } = await mount({ dataDir })
    const record = JSON.parse(readFileSync(publicationPath, 'utf8'))
    assert.equal(record.pid, SELF_PID, '本次启动没有覆盖陈旧的 pid——消费侧会把它判成 STALE')
    assert.equal(record.port, served.port)
    assert.notEqual(record.port, 1)
    // 反向锚（**逐字**比较，不用 `includes`）：文件里剩下的就只有本次这一份，
    // 上一份的任何字段都不该还在。用 `includes('"pid":1')` 这种写法是错的——
    // 本进程 pid 是 12345 时它也会命中，于是一条"没覆盖"的实现照样绿。
    assert.deepEqual(record, {
      version: 1,
      pid: SELF_PID,
      host: '127.0.0.1',
      port: served.port,
      wireVersion: 1,
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('⑤ 行接口版本跟着服务值的形状走（续批四新增了 `publication`，所以是 2）', () => {
  assert.equal(RUNTIME_CONTRACT_ROW_VERSION, 2)
  // 输入工厂是单槽，且存取对称
  resetRuntimeContractInputsFactory()
  assert.equal(runtimeContractInputsFactory(), null)
  const unregister = setRuntimeContractInputsFactory(() => ({}))
  assert.equal(typeof runtimeContractInputsFactory(), 'function')
  unregister()
  assert.equal(runtimeContractInputsFactory(), null, '注销之后工厂还在——单槽的幂等注销没生效')
})

test('⑤ 没有输入工厂时，服务值里也有**形状完整**的 `publication`（不是 undefined）', async () => {
  resetRuntimeContractInputsFactory()
  const ctx = fakeCtx()
  await runtimeContractServerRow.apply(ctx)
  const served = ctx.services.get(RUNTIME_CONTRACT_SERVER_SERVICE)
  assert.equal(served.ok, false)
  assert.equal(served.code, RUNTIME_CONTRACT_ROW_CODES.NO_INPUTS_FACTORY)
  // 读侧读 `undefined.published` 与读 `false` 是两件事：
  // 后者说"这一行明确地没有发布"，前者会让调用方崩或静默判假。
  assert.equal(served.publication.published, false)
  assert.equal(served.publication.path, null)
})

// ============================================================================
// ⑥ `verdictFromRuntimeHostBinding`：**三种**形态必须互不同形
//
// 这个函数此前**一个用例都没有**，而它是 `line 854` 那条链上的一环：
// 宿主行说"强制面没生效"，靠它翻成一条 worker 读得懂的结论。
//
// 三条路的**下游后果完全不同**，混起来就等于把 spec 要求的
// 「按 `incompatible` 处理」退化成一个笼统的"读不到"：
//
//   ① 服务不在            → null → HTTP 503 → worker `RUNTIME_REFUSED`
//                          → 产品 `unavailable`（"执行引擎不可用"）
//   ② 服务在、说强制面不行 → 结论 `autoExecutionForbidden: true`
//                          → worker `SELF_CHECK_INCOMPATIBLE`
//                          → 产品 `incompatible`（"提示修复或回滚"）
//   ③ 服务在、说行         → 结论 `autoExecutionForbidden: false`
// ============================================================================

test('⑥ ★★★ 服务**不在** → null（会被翻成 503/不可用），绝不返回"自动执行被禁止"', () => {
  // 「读不到」与「读到了、说不行」是两件事。前者要去查进程和端口，
  // 后者只要照 `repair` 修——把它当成后者会让排障方向从一开始就错。
  for (const absent of [undefined, null, 42, 'x', []]) {
    assert.equal(verdictFromRuntimeHostBinding(absent), null, `${JSON.stringify(absent)} 被当成了结论`)
  }
})

test('⑥ ★★★ 服务在、说自检不兼容 → 一条真的 `incompatible` 结论（不是 null、也不是"允许"）', () => {
  const binding = Object.freeze({
    ok: false,
    code: RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE,
    innerCode: 'BOOTSTRAP_SELF_CHECK_INCOMPATIBLE',
    state: 'incompatible',
    patchVersion: 7,
    checks: [{ name: 'sandbox-enforcement', ok: false }],
    reasons: ['沙箱仅 partial'],
    repair: { actions: [{ id: 'install-sandbox' }] },
    autoExecutionForbidden: true,
  })
  const v = verdictFromRuntimeHostBinding(binding)
  assert.ok(v !== null, '服务明明在说"强制面没生效"，却被读成了"服务不在"')
  assert.equal(v.autoExecutionForbidden, true, '这一条读错方向的后果是**放行执行**')
  assert.equal(v.state, 'incompatible')
  assert.deepEqual([...v.reasons], ['沙箱仅 partial'])
  assert.deepEqual(v.checks.map((c) => c.name), ['sandbox-enforcement'])
  assert.equal(v.patchVersion, 7)
  // 修法要跟着结论走：spec §6.3 要求的是「提示修复或回滚」。
  assert.deepEqual(v.repair.actions.map((a) => a.id), ['install-sandbox'])
  // 来源必须写得出来，读者不必从字段猜这条结论是哪一种。
  assert.match(v.source, /self-check-incompatible/)
})

test('⑥ ★★★ 但**不是**任何 `ok:false` 都禁止执行——出口自己的降级不算强制面不行', () => {
  // ★ 这是上一条的**反向**，也是它最容易被过度推广的地方。
  //   出口（本行）自身的降级也是 `ok:false`：没给 bindPort、发布写不进去……
  //   那些**没有**说"强制面没生效"。如果一律翻成"禁止自动执行"，
  //   就造出一个"出口没配好 ⇒ 整个产品不能干活"的假故障——
  //   而那与"强制面没生效"是两条完全不同的读数。
  const otherRefusals = [
    RUNTIME_CONTRACT_ROW_CODES.NO_BIND_PORT,
    RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED,
    RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR,
    RUNTIME_CONTRACT_ROW_CODES.LISTEN_FAILED,
    RUNTIME_CONTRACT_ROW_CODES.NO_INPUTS_FACTORY,
    'WHATEVER_ELSE',
  ]
  for (const code of otherRefusals) {
    const v = verdictFromRuntimeHostBinding({ ok: false, code, state: 'incompatible' })
    assert.equal(v, null, `${code} 被当成了"强制面未生效"——出口的降级不该禁止执行`)
  }
})

test('⑥ 服务在、说行 → `autoExecutionForbidden: false`，但**不**顺手把 reasons 编出来', () => {
  const v = verdictFromRuntimeHostBinding({
    ok: true, state: 'enforcement-effective', patchVersion: 3, checks: [{ name: 'x', ok: true }],
  })
  assert.equal(v.autoExecutionForbidden, false)
  assert.equal(v.state, 'enforcement-effective')
  assert.equal(v.patchVersion, 3)
  // 「说行」的那条路**没有**理由可报，就不该编一个空数组以外的任何东西。
  assert.deepEqual([...v.reasons], [])
  assert.equal(v.source, 'legionRuntimeHostBinding')
})
