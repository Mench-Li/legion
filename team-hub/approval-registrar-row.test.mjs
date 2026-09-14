// team-hub/approval-registrar-row.test.mjs
// ============================================================================
// PRT-214（续）：**审批端口注册方**那一小段接线的判据。
//
// 这一套守的不是"能不能问人"（那是 `approval-port.test.mjs` 起真 hub 在守的），
// 而是四件此前**没有任何判据**的事：
//
//   ① 注册方默认导出的就是**真的那个** root row 插件对象（`===`），不是替身。
//      只断言"形状像插件"的话，一个把 root 行整个换掉的实现照样能绿。
//   ② 注册**真的发生了**（模块求值期），而且"注册了"与"没注册"必须可分：
//      把注册缝清空后读数必须变，恢复后必须变回来。
//   ③ 工厂**没有 hub 地址时抛具名码**，而不是造一个空端口，也不是一个 TypeError。
//   ④ 工厂交出来的是**真端口**：它按 `/api/permissions/check` 的协议说话，
//      把 hub 的 `denied` 翻成 `rejected`，把 401 翻成 `unavailable`（**故障**）。
//      后两者必须**不同**——"人说不"与"我们没问到"是两件相反的事。
//
// ## 用的是注入的 `fetchImpl`，不是假端口
//
// 假的是 **HTTP 传输**这一层（`fetchImpl`），不是端口本身：`hubIo()` →
// `approvalHubOf()` → `createHubApprovalPort()` 三段全是**产品代码**。
// 一个把 `hub` 换成 `{read: async()=>..., write: async()=>...}` 的用例，
// 会同时跳过本批新写的那一段（`approvalHubOf` 的错误翻译）——
// 而"翻译错了"正是最难在真 hub 上偶然撞到的缺陷。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APPROVAL_PORT_CODES } from './approval-port.mjs'
import approvalPortRegistrar, {
  APPROVAL_REGISTRAR_CODES,
  APPROVAL_REGISTRAR_VERSION,
  approvalHubOf,
  createApprovalPortFactory,
  registeredApprovalPortFactory,
} from './approval-registrar-row.mjs'
import realRootRow, {
  ROOT_ROW_PLUGIN_NAME,
  approvalPortFactory,
  setApprovalPortFactory,
} from '../runtime/dsh-composition/plugins/root-row.mjs'

/** 一个"HTTP 层"的假：adapter 与端口之上的每一行都是产品代码。 */
function fakeFetch({ status = 200, body = {}, calls = [] } = {}) {
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? null })
    return { status, text: async () => JSON.stringify(body) }
  }
  impl.calls = calls
  return impl
}

const RESOLVED = Object.freeze({
  hubUrl: 'http://hub.invalid:8787',
  hubToken: null,
  actor: 'alice',
  scope: 'space-1',
  action: 'write',
  cwd: 'C:\\work',
  taskId: null,
  platform: 'win32',
})

const PROJECTION = Object.freeze({
  toolName: 'file_write',
  callId: 'call-registrar-1',
  arguments: Object.freeze({ path: 'repo/a.txt', mode: 'w' }),
  canonicalTarget: 'repo/a.txt',
})

// ───────────────────────────────────────────────────── ① 身份：不是替身

test('★★★ 默认导出就是真的 root row 插件对象（`===`，不是形状相同的替身）', () => {
  assert.equal(approvalPortRegistrar, realRootRow,
    '注册方换掉了 root 行插件对象——那么"这一行还是那一行"就没有任何判据了')
  assert.equal(realRootRow.name, ROOT_ROW_PLUGIN_NAME)
  assert.equal(typeof realRootRow.apply, 'function')
  // 反向：这一条不是恒真——两个不同的对象不会 `===`。
  assert.notEqual(approvalPortRegistrar, { ...realRootRow })
})

// ─────────────────────────────────────── ② 注册真的发生了，且两种状态可分

test('★★★ 模块求值期注册了工厂：`approvalPortFactory()` 就是本模块那一个', () => {
  assert.equal(typeof registeredApprovalPortFactory, 'function')
  assert.equal(APPROVAL_REGISTRAR_VERSION, 1)
  assert.equal(approvalPortFactory(), registeredApprovalPortFactory,
    '模块被 import 了却没有注册——那"注册方"三个字就是一句注释')
})

test('★★★ 反向对照：注册缝清空后读数**必须变**，恢复后必须变回来', () => {
  const restore = setApprovalPortFactory(null)
  try {
    assert.equal(approvalPortFactory(), null, '清空后还是"有工厂"——那这条反向对照什么都没证明')
    assert.notEqual(approvalPortFactory(), registeredApprovalPortFactory)
  } finally {
    restore()
  }
  assert.equal(approvalPortFactory(), registeredApprovalPortFactory, '恢复没有回到我们注册的那一个')
})

// ────────────────────────────────────────────────── ③ 没有 hub 地址就抛具名码

test('★★ 组合根没给 hub 地址时抛 `APPROVAL_REGISTRAR_HUB_URL_MISSING`，不造空端口', () => {
  const factory = createApprovalPortFactory()
  let err = null
  try {
    factory({ scope: 's', actor: 'a' })
  } catch (e) {
    err = e
  }
  assert.ok(err !== null, '没有 hub 地址却造出了端口——那是一个永远问不到人的端口')
  assert.equal(err.code, APPROVAL_REGISTRAR_CODES.HUB_URL_MISSING)
  // 两种处境不能同形：这与"hub 客户端形状不对"是两个码。
  assert.notEqual(err.code, APPROVAL_REGISTRAR_CODES.HUB_IO_BAD_RESPONSE)
  // 也不是审批端口自己的 BAD_WIRING（那是"hub 客户端没给全"，与"没给地址"修法不同）。
  assert.notEqual(err.code, APPROVAL_PORT_CODES.BAD_WIRING)
})

// ──────────────────────────────── ④ HTTP 故障 → 抛出（不是把 {status,body} 交出去）

test('★★ `approvalHubOf`：非 2xx 抛（带 status/code），形状不对抛另一个码', async () => {
  const body = { error: '未授权：Bearer token 无效' }
  const hub = approvalHubOf({ get: async () => ({ status: 401, body }), post: async () => ({ status: 401, body }) })
  let unauthorized = null
  try {
    await hub.write('/api/permissions/check', {})
  } catch (e) {
    unauthorized = e
  }
  assert.ok(unauthorized !== null, '401 被当成正文交出去了——端口会把它读成 UNKNOWN_STATUS')
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.body, body)

  // 形状不对（不是 {status, body}）——**另一个码**：这是接线错，不是鉴权失败。
  const broken = approvalHubOf({ get: async () => ({ ok: true }), post: async () => ({ ok: true }) })
  let shape = null
  try {
    await broken.read('/api/permissions/inbox')
  } catch (e) {
    shape = e
  }
  assert.ok(shape !== null)
  assert.equal(shape.code, APPROVAL_REGISTRAR_CODES.HUB_IO_BAD_RESPONSE)
  assert.notEqual(shape.code, unauthorized.code)

  // 正面：200 时原样返回 body。
  const ok = approvalHubOf({ get: async () => ({ status: 200, body: { requests: [] } }), post: async () => ({ status: 200, body: {} }) })
  assert.deepEqual(await ok.read('/api/permissions/inbox'), { requests: [] })
})

// ───────────────────── ⑤ ★ 真端口：`denied` → rejected；401 → unavailable（两者必须不同）

test('★★★ 工厂交的是真端口：按 check 协议说话，`denied`→rejected，401→unavailable', async () => {
  const calls = []
  const denied = fakeFetch({ status: 200, body: { ok: true, task: { status: 'denied' } }, calls })
  const port = createApprovalPortFactory({ fetchImpl: denied })(RESOLVED)

  assert.equal(typeof port.requestApproval, 'function')
  const rejected = await port.requestApproval(PROJECTION)
  assert.equal(rejected, 'rejected')
  // 它说的是 hub 的协议，而不是"我们自己编一个结果"：路径、方法、`by` 都必须对。
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.match(calls[0].url, /\/api\/permissions\/check$/)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.by, 'alice')
  assert.equal(sent.scope, 'space-1')
  assert.equal(sent.callId, 'call-registrar-1')
  // 没有 token 的进程发的是空 Bearer（hub 的 `authorized()` 在 token 为空时恒放行），
  // 而不是一个编出来的凭证。
  assert.equal(calls[0].headers.authorization, 'Bearer ')

  const unauthorized = fakeFetch({ status: 401, body: { error: '未授权' } })
  const port401 = createApprovalPortFactory({ fetchImpl: unauthorized })(RESOLVED)
  const unavailable = await port401.requestApproval(PROJECTION)
  // ★ 这是本批最要紧的一条区分：故障 ≠ 拒绝。
  assert.equal(unavailable, 'unavailable')
  assert.notEqual(unavailable, rejected, '"问不到人"被记成了"人说不"——审计上这是两件相反的事')

  // 有 token 时原样带上（不丢、不猜）。
  const withToken = fakeFetch({ status: 200, body: { ok: true, task: { status: 'denied' } } })
  const portT = createApprovalPortFactory({ fetchImpl: withToken })({ ...RESOLVED, hubToken: 't0k' })
  await portT.requestApproval(PROJECTION)
  assert.equal(withToken.calls[0].headers.authorization, 'Bearer t0k')
})
