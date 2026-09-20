// team-hub/approval-port.test.mjs
// ============================================================================
// PRT-212：审批端口 → team-hub 审批箱。
//
// ★ 本套件**起一个真的 hub**。理由与 PRT-409 那套相同，但这里更硬：
// 这套件里几乎每一个判据都取决于**别人写的**东西——状态串叫什么、
// 判定体放在响应的哪一层、`by` 是不是必填、绑定的哈希对不对得上。
//
// 实测抓到过三条，全部是"读代码看不出来、只有发过那次请求才知道"：
//
//   ① `POST /api/permissions/check` **必填 `by`**（`handleWrite` 第一件事是
//      `requireMember(body)`）。缺了它整个请求 400，而端口会把它记成
//      "审批箱不可达"——一次**参数缺失**被报成**基础设施故障**。
//   ② 判定体在响应的 **`task`** 下面（`{ok:true, task:result}`），不在顶层。
//      从顶层读 `status` 永远读到 `undefined` → `UNKNOWN_STATUS` →
//      "这端口现在不可信"，而审批箱答得好好的。
//   ③ `approved` 有**两个**来源：策略放行（不落行、没有人）与人批准（落在行上、
//      有 `decidedBy`）。第一版一律当策略放行，于是探针打出一张**自相矛盾**的凭据：
//      `human:false` + `reason:"策略直接放行"` + `decidedBy:"general"`。
//
//   > 一个用假 hub 喂出来的「审批已经接通」，
//   > 与一个从没发出过那次请求的「审批已经接通」，是同一个东西，
//   > 只不过前者的用例数是完整的。
//
// 所以：凡是"hub 会怎么答"的判据，都在**真 hub** 上验；
// 凡是"端口自己怎么算"的判据（轮询、到期、撤回、坏接线），用注入时间验。
// ============================================================================

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  APPROVAL_PORT_CODES, APPROVAL_PORT_VERSION, APPROVAL_STATUS_MAP, DEFAULT_POLL_INTERVAL_MS,
  createHubApprovalPort, deciderOf, outcomeOfRow, statusOf,
} from './approval-port.mjs'
import { BRIDGE_CODES } from './tool-request-bridge.mjs'
import { APPROVAL_OUTCOMES } from '../runtime/dsh-composition/enforcement.mjs'
// ★ PRT-316 切片 2：permissions/审批箱 族已搬进独立模块——本文件末尾按**缝上契约**补判据。
import { createPermissionsRoutes } from './routes/permissions.mjs'
// ★ 副作用导入：**注册那一步就发生在这里**。注册方在模块求值期调
//   `setApprovalPortFactory()`，把工厂放进 `root-row` 的注册缝。
//   不导入它，注册缝就是空的——而"空注册缝"与"链没接通"在读数上分不开，
//   这正是下面第 ③ 组用例要跑真 hub 的理由。
import './approval-registrar-row.mjs'

const REPO = resolve(import.meta.dirname, '..')

// ── 真 hub ───────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'legion-approval-port-'))
process.env.TEAM_HUB_DB = join(tmp, 'hub.db')
process.env.TEAM_HUB_TOKEN = ''
const hub = await import(pathToFileURL(join(REPO, 'team-hub', 'server.mjs')).href)
await new Promise((r) => hub.server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${hub.server.address().port}`

process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 让位给下次 */ } })

// ★ 必须显式关掉监听：一个还开着的 HTTP server 会让事件循环永不排空，
//   于是 `node --test` **跑完所有用例也不结束**——表现为整条命令挂到超时，
//   而不是任何一条用例变红。
//
//     > 一个"所有断言都过了、而进程不退出"的套件，
//     > 与一个"卡死不返回"的套件，在 CI 上是同一个东西。
after(async () => {
  hub.server.closeAllConnections?.()
  await new Promise((r) => hub.server.close(r))
})

/** 一次 HTTP 往返。**非 200 就抛**，让端口走它自己的"不可达"分支。 */
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (res.status !== 200) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed).slice(0, 200)}`)
  }
  return parsed
}

/** 端口要的两个能力。与生产里 `executor-binding.mjs` 给 `createHubSourceLoader` 的形状同源。 */
const realHub = {
  read: (path) => call('GET', path),
  write: (path, body) => call('POST', path, body),
}
/** 记录端口**请求过哪些路径**——用来证明它查自己的行时没带 scope 过滤。 */
function tracingHub(inner = realHub) {
  const paths = []
  return {
    paths,
    hub: {
      read: (p) => { paths.push(p); return inner.read(p) },
      write: (p, b) => { paths.push(p); return inner.write(p, b) },
    },
  }
}

const CALLER = Object.freeze({ scope: 'team-approval', actor: 'general' })
let seq = 0
const uniqueTag = () => `${Date.now().toString(36)}-${seq++}`

function projectionOf(over = {}) {
  const tag = over.tag ?? uniqueTag()
  return {
    toolName: 'file_write',
    callId: `call-${tag}`,
    arguments: { path: `repo/${tag}.txt`, mode: 'w' },
    canonicalTarget: `repo/${tag}.txt`,
    ...over,
  }
}

const portOf = (over = {}) => createHubApprovalPort({
  hub: realHub, caller: CALLER, attemptId: null, pollIntervalMs: 10, ...over,
})

/** 后台当"用户"：等某条待批准行出现，然后按 `decision` 处理它。 */
function decideWhenPending(decision, { reason = '用例处理', match = null, onRow = null } = {}) {
  let settled = false
  const done = (async () => {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 10))
      const inbox = await realHub.read('/api/permissions/inbox')
      const row = (inbox.requests ?? []).find((r) => r.status === 'pending'
        && (match === null || match(r)))
      if (row !== undefined) {
        settled = true
        // `onRow` 让调用方拿到**审批箱那一侧看到的**行本体（字段名不能靠猜：
        // 实测 `target` 是**规范化之后**的绝对路径，不是用例传进去的那一份）。
        if (typeof onRow === 'function') onRow(row)
        return realHub.write('/api/permissions/decide', {
          requestId: row.requestId, decision, by: 'general', reason,
        })
      }
    }
    return null
  })()
  return { done, wasSettled: () => settled }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 真 hub：默认（无规则）就是"要问人"，人批了就放行
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ 真 hub：默认无规则 → 待批准 → 人批准 → allowed-once，凭据带 requestId', async () => {
  const port = portOf()
  const projection = projectionOf()
  let connectedAt = null
  const approver = decideWhenPending('approve', {
    reason: '用例①批准', match: (r) => r.target === projection.canonicalTarget,
  })

  const outcome = await port.requestApproval(projection, {
    onConnected: () => { connectedAt = port.tickets().length },
    responseTimeoutMs: 8000,
  })
  const decided = await approver.done

  assert.equal(outcome, 'allowed-once', '人批了却没放行')
  assert.notEqual(decided, null, '审批行始终没出现在审批箱里——端口根本没把申请送进去')

  const t = port.lastTicket()
  assert.equal(t.version, APPROVAL_PORT_VERSION)
  assert.equal(t.outcome, 'allowed-once')
  assert.equal(t.human, true, '★★ 人批的必须记成有人参与')
  assert.equal(t.decidedBy, 'general', '★★ 凭据必须记下是谁批的')
  assert.equal(t.decisionReason, '用例①批准')
  assert.equal(t.code, null)
  assert.match(t.reason, /已批准/)
  assert.match(t.reason, /by=general/)
  assert.equal(t.callId, projection.callId)
  assert.equal(t.target, projection.canonicalTarget)
  assert.ok(t.requestId !== null && t.requestId.startsWith('perm-'), `requestId 不对：${t.requestId}`)
  assert.match(t.bindingHash ?? '', /^sha256:[0-9a-f]{64}$/, '凭据里必须带上绑定哈希')
  assert.ok(APPROVAL_OUTCOMES.includes(t.outcome), '结局必须落在闭集里')
  // ★ 自报点必须在**拿到 requestId 之前**就已经发生（即 check 返回后立刻自报）
  assert.equal(connectedAt, 0, 'onConnected 不该晚于第一次凭据产生')
})

test('★★★ 真 hub：人拒绝 → rejected（且是 human）', async () => {
  const port = portOf()
  const projection = projectionOf()
  const approver = decideWhenPending('deny', {
    reason: '用例②拒绝', match: (r) => r.target === projection.canonicalTarget,
  })
  const outcome = await port.requestApproval(projection, { responseTimeoutMs: 8000 })
  const decided = await approver.done

  assert.notEqual(decided, null, '审批行没出现')
  assert.equal(outcome, 'rejected')
  const t = port.lastTicket()
  assert.equal(t.human, true, '人拒的也是有人参与')
  assert.equal(t.decidedBy, 'general')
  assert.match(t.reason, /已拒绝/)
  assert.ok(APPROVAL_OUTCOMES.includes(t.outcome))
})

// ─────────────────────────────────────────────────────────────────────────────
// ② ★★★ 凭据不是装饰：拿它真的能消费，换个参数就消费不了
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ 真 hub：凭据里的 requestId + 绑定**真的**能消费，改一个参数就消费不了', async () => {
  // 这是整套件里最重要的断言。一个"批准了、也返回 allowed-once、
  // 但拿回来的票据根本消费不了"的端口，与一个"什么都没接"的端口，
  // 在用户那里都是"我批了，执行时说操作不匹配"。
  const port = portOf()
  const projection = projectionOf()
  const approver = decideWhenPending('approve', {
    reason: '用例③', match: (r) => r.target === projection.canonicalTarget,
  })
  const outcome = await port.requestApproval(projection, { responseTimeoutMs: 8000 })
  await approver.done
  assert.equal(outcome, 'allowed-once')
  const t = port.lastTicket()

  // 端口送审时用的操作，与消费时必须**逐字段一致**。
  const { legionOperationOf } = await import('./tool-request-bridge.mjs')
  const { operation } = legionOperationOf(projection, CALLER)

  // ① 先试**错的**：换一份参数（argsHash 就不一样了）→ **必须**被拒。
  //    这一条证明绑定绑的是**内容**，不是一张可以随便挪用的票。
  //
  //    ⚠️ 顺序要紧，而且这个顺序本身就是一条知识：必须在**第一次消费之前**试。
  //    用掉的票再拿来用时走的是 `ALREADY_CONSUMED`，而 hub 有意让它
  //    **落回策略判定**（"用掉之后再发起"是一次正常的新申请），
  //    于是它会拿到 200 并产生一条新的待批准行——看起来像"换个操作也能用"。
  const other = projectionOf()
  const { operation: otherOp } = legionOperationOf(other, CALLER)
  await assert.rejects(
    () => realHub.write('/api/permissions/check', {
      ...otherOp, by: otherOp.actor, permissionRequestId: t.requestId,
    }),
    /mismatch|operation-changed/,
    '★ 拿一次批准去放行**另一个**操作，居然通过了',
  )

  // ② 再试**对的**：原样消费 → 通过，并且状态是 consumed
  const consume = () => realHub.write('/api/permissions/check', {
    ...operation, by: operation.actor, permissionRequestId: t.requestId,
  })
  const okRes = await consume()
  const okTask = okRes.task ?? okRes
  assert.equal(okTask.allowed, true, `原样消费被拒了：${JSON.stringify(okTask).slice(0, 300)}`)
  assert.equal(okTask.status, 'consumed')
  assert.equal(okTask.requestId, t.requestId)
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ ★★ `approved` 的两个来源不能长得一样
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ 策略直接放行 → allowed-once 但 human:false 且**没有** requestId', async () => {
  // 与上一条成对：都是 `approved`，都是 `allowed-once`，
  // 但一个有人参与、一个没有。把它们记成一样，等于让一次
  // **人工批准的越权操作**看起来像一次策略放行。
  const tag = uniqueTag()
  await realHub.write('/api/permissions/rules', {
    id: `r-policy-${tag}`, scope: CALLER.scope, mode: 'allow-by-policy',
    action: 'file_policy_probe', by: 'general',
  })
  const port = portOf()
  const projection = {
    toolName: 'file_policy_probe', callId: `call-${tag}`,
    arguments: { path: `repo/${tag}.txt` }, canonicalTarget: `repo/${tag}.txt`,
  }
  const outcome = await port.requestApproval(projection, { responseTimeoutMs: 2000 })
  assert.equal(outcome, 'allowed-once')
  const t = port.lastTicket()
  assert.equal(t.human, false, '★★ 策略放行被记成了"有人参与"')
  assert.equal(t.decidedBy, null)
  assert.equal(t.requestId, null, '策略放行不落行，所以不该有 requestId')
  assert.match(t.reason, /策略直接放行/)
  assert.match(t.reason, /没有.*人/, '理由必须说清"没有人类参与"')
})

test('★★★ outcomeOfRow：`approved` 靠**凭据**两分，不靠状态串', () => {
  // 上游那两条是端到端的；这条把判据本身钉死，因为它就是那个缺陷的所在。
  const policy = outcomeOfRow({ status: 'approved' })
  const human = outcomeOfRow({ status: 'approved', decidedBy: 'general' })

  assert.equal(policy.outcome, 'allowed-once')
  assert.equal(human.outcome, 'allowed-once')
  // ★ 结局相同，**归因必须不同**——这正是这条判据存在的理由
  assert.notEqual(policy.human, human.human)
  assert.equal(policy.human, false)
  assert.equal(human.human, true)
  assert.notEqual(policy.reason, human.reason)
  assert.equal(policy.decidedBy, null)
  assert.equal(human.decidedBy, 'general')

  // 空白串与 null 一样算"没有决定者"——`'  '` 不是一个人的名字
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(deciderOf({ status: 'approved', decidedBy: empty }), null, `decidedBy=${JSON.stringify(empty)} 应算没有`)
  }
  // 人拒同理
  const humanDeny = outcomeOfRow({ status: 'denied', decidedBy: 'general' })
  assert.equal(humanDeny.outcome, 'rejected')
  assert.equal(humanDeny.human, true)
  assert.match(humanDeny.reason, /已拒绝/)
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 状态映射的**闭集**性质
// ─────────────────────────────────────────────────────────────────────────────

test('★★ 未知状态一律 unavailable——**不当作放行，也不当作拒绝**', () => {
  for (const status of ['approved-ish', 'ALLOW', 'consumed?', '全新状态']) {
    const got = outcomeOfRow({ status })
    assert.equal(got.outcome, 'unavailable', `未知状态 ${status} 被当成了结局`)
    assert.equal(got.code, APPROVAL_PORT_CODES.UNKNOWN_STATUS)
    assert.match(got.reason, /不能当作放行/)
  }
  // 没有 status 的行也是"端口不可信"
  assert.equal(outcomeOfRow({}).code, APPROVAL_PORT_CODES.ROW_MALFORMED)
  assert.equal(statusOf(null), null)
  assert.equal(statusOf({ status: '' }), null)
  assert.equal(statusOf({ status: 'pending' }), 'pending')
  // `pending` **不是结局**（返回 null，调用方据此继续等）
  assert.equal(outcomeOfRow({ status: 'pending' }), null)
})

test('★★ 到期是"没人回答"，**不是**"人说不"', () => {
  const got = outcomeOfRow({ status: 'expired' })
  assert.equal(got.outcome, 'unavailable', '到期被当成了拒绝——那会让人去追问一个从未被问过的人')
  assert.notEqual(got.outcome, 'rejected')
  assert.match(got.reason, /到期/)
  assert.match(got.reason, /没有人/)
  // 映射表里每一个结局都在闭集内
  for (const [status, m] of Object.entries(APPROVAL_STATUS_MAP)) {
    assert.ok(APPROVAL_OUTCOMES.includes(m.outcome), `${status} → ${m.outcome} 不在闭集里`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ ★★ 查不到那一行 ≠ 还没人批
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ 审批行在箱子里查不到 → 当场 ROW_VANISHED，**不是**继续等到超时', async () => {
  // `checkPermission` 在 `withTx` 里写那一行，**返回之前就提交**了。
  // 所以 check 一回来那一行就必须在。查不到只有几种可能：打到了别的实例、
  // 行被删了、查询方式不对——**没有一种是"继续等人"**。
  //
  //   > 一个"查不到就安静地继续轮询到超时"的实现，
  //   > 与一个"这份申请根本不存在"的实现，在屏幕上都是"等了一会儿然后超时"——
  //   > 只不过前者的理由是"没人处理"，后者是"你查错地方了"。
  const fake = {
    // check 说"待批准"并给一个 requestId，但 inbox 里永远没有它。
    write: async () => ({ ok: true, task: { status: 'pending', requestId: 'perm-不存在-1', bindingHash: 'sha256:' + 'a'.repeat(64) } }),
    read: async () => ({ ok: true, requests: [] }),
  }
  const port = portOf({ hub: fake })
  const outcome = await port.requestApproval(projectionOf(), { responseTimeoutMs: 60_000 })

  assert.equal(outcome, 'unavailable')
  const t = port.lastTicket()
  assert.equal(t.code, APPROVAL_PORT_CODES.ROW_VANISHED)
  assert.notEqual(t.code, APPROVAL_PORT_CODES.TTL_NOT_ANSWERED,
    '★ 查不到与等不到**必须**是两个不同的码')
  assert.match(t.reason, /查不到/)
  assert.match(t.reason, /不是"还没人批"/)
  // ★ 而且是**当场**：预算给了 60 秒，不该真的等满
  assert.ok(t.elapsedMs < 2000, `应该立刻返回，实际花了 ${t.elapsedMs}ms`)
})

test('★★ 查自己的行时**不带** scope 过滤（把"参数传错"与"行不存在"分开）', async () => {
  const traced = tracingHub({
    write: async () => ({ ok: true, task: { status: 'pending', requestId: 'perm-x', bindingHash: 'sha256:' + 'b'.repeat(64) } }),
    read: async () => ({ ok: true, requests: [] }),
  })
  const port = portOf({ hub: traced.hub })
  await port.requestApproval(projectionOf(), { responseTimeoutMs: 5000 })

  const inboxReads = traced.paths.filter((p) => p.includes('/api/permissions/inbox'))
  assert.ok(inboxReads.length > 0, '端口根本没读审批箱')
  for (const p of inboxReads) {
    assert.doesNotMatch(p, /scope=/, '★ 带上 scope 过滤就把"空间参数传错"变成了"这行不存在"')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 端口自己的行为（注入时间 / 注入 hub）
// ─────────────────────────────────────────────────────────────────────────────

test('★★ 等满预算没人处理 → TTL_NOT_ANSWERED，且理由说清"申请本身是好的"', async () => {
  const fake = {
    write: async () => ({ ok: true, task: { status: 'pending', requestId: 'perm-等不到', bindingHash: null } }),
    read: async () => ({ ok: true, requests: [{ requestId: 'perm-等不到', status: 'pending' }] }),
  }
  const port = portOf({ hub: fake, sleep: async () => {} })
  const outcome = await port.requestApproval(projectionOf(), { responseTimeoutMs: 1 })

  assert.equal(outcome, 'unavailable')
  const t = port.lastTicket()
  assert.equal(t.code, APPROVAL_PORT_CODES.TTL_NOT_ANSWERED)
  assert.ok(t.code !== APPROVAL_PORT_CODES.ROW_VANISHED)
  assert.match(t.reason, /没有人处理/)
  assert.match(t.reason, /申请本身是好的/, '必须把"没人批"与"送不出去"分开')
})

test('★★ `responseTimeoutMs` 真的被用上（不是写死 60 秒）', async () => {
  //   > 一个"自己有期限、却不等调用方期限"的轮询，
  //   > 与一个"把 Run 的期限交给下游模块自己猜"的轮询，是同一个东西。
  for (const budget of [1, 5, 20]) {
    const fake = {
      write: async () => ({ ok: true, task: { status: 'pending', requestId: 'p', bindingHash: null } }),
      read: async () => ({ ok: true, requests: [{ requestId: 'p', status: 'pending' }] }),
    }
    const port = portOf({ hub: fake, sleep: async () => {} })
    const started = Date.now()
    await port.requestApproval(projectionOf(), { responseTimeoutMs: budget })
    const t = port.lastTicket()
    assert.equal(t.code, APPROVAL_PORT_CODES.TTL_NOT_ANSWERED)
    assert.ok(t.elapsedMs < 3000, `预算 ${budget}ms 却花了 ${t.elapsedMs}ms——说明用的是写死的默认值`)
    assert.ok(Date.now() - started < 3000)
  }
})

test('★ 送审之前就撤回 → cancelled（不是我方的故障）', async () => {
  const port = portOf()
  const ac = new AbortController()
  ac.abort()
  const outcome = await port.requestApproval(projectionOf(), { signal: ac.signal })
  assert.equal(outcome, 'cancelled')
  assert.equal(port.lastTicket().code, APPROVAL_PORT_CODES.ABORTED)
})

test('★ 等待期间撤回 → cancelled，且不再打 hub', async () => {
  let reads = 0
  const ac = new AbortController()
  const fake = {
    write: async () => ({ ok: true, task: { status: 'pending', requestId: 'p', bindingHash: null } }),
    read: async () => { reads += 1; return { ok: true, requests: [{ requestId: 'p', status: 'pending' }] } },
  }
  const port = portOf({ hub: fake, sleep: async () => { ac.abort() } })
  const outcome = await port.requestApproval(projectionOf(), { signal: ac.signal, responseTimeoutMs: 5000 })
  assert.equal(outcome, 'cancelled')
  assert.equal(port.lastTicket().code, APPROVAL_PORT_CODES.ABORTED)
  assert.ok(reads <= 1, `撤回后还在打 hub（读了 ${reads} 次）`)
})

test('★★★ `onConnected` 只在 hub **真的答了**之后才自报', async () => {
  // 一进门就自报，会把一次**连不上**记成"响应阶段超时"——
  // 值班的人会去翻审批箱有没有积压，而真正的问题是 hub 根本没起来。
  let connected = false
  const broken = {
    write: async () => { throw new Error('ECONNREFUSED') },
    read: async () => ({ ok: true, requests: [] }),
  }
  const portA = portOf({ hub: broken })
  const a = await portA.requestApproval(projectionOf(), { onConnected: () => { connected = true } })
  assert.equal(a, 'unavailable')
  assert.equal(connected, false, '★★ hub 没答话却自报了已连接')
  assert.equal(portA.lastTicket().code, APPROVAL_PORT_CODES.CHECK_FAILED)
  assert.match(portA.lastTicket().reason, /不可达/)

  // 答了话就必须自报——哪怕当场的结论是"策略拒绝"
  let connectedB = false
  const denying = { write: async () => ({ ok: true, task: { status: 'denied' } }), read: async () => ({ ok: true, requests: [] }) }
  const portB = portOf({ hub: denying })
  const b = await portB.requestApproval(projectionOf(), { onConnected: () => { connectedB = true } })
  assert.equal(b, 'rejected')
  assert.equal(connectedB, true, '审批箱答了话却没自报已连接')
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 坏接线 / 坏输入一律 fail closed
// ─────────────────────────────────────────────────────────────────────────────

test('★★ 缺 read/write 一律**抛**，不给"没 hub 也能跑"的兜底', () => {
  for (const bad of [{}, { read: () => {} }, { write: () => {} }, null, { read: 1, write: 2 }]) {
    assert.throws(() => createHubApprovalPort({ hub: bad }), (e) => {
      assert.equal(e.code, APPROVAL_PORT_CODES.BAD_WIRING)
      assert.match(e.message, /read, write/)
      return true
    }, `hub=${JSON.stringify(bad)} 没被拦下`)
  }
  assert.throws(() => createHubApprovalPort({ hub: realHub, pollIntervalMs: 0 }),
    (e) => e.code === APPROVAL_PORT_CODES.BAD_POLL_INTERVAL)
  assert.throws(() => createHubApprovalPort({ hub: realHub, pollIntervalMs: 1.5 }),
    (e) => e.code === APPROVAL_PORT_CODES.BAD_POLL_INTERVAL)
  assert.equal(DEFAULT_POLL_INTERVAL_MS > 0, true)
})

test('★★★ 投影造不出主体 → unavailable 且**一个字节都不发给 hub**', async () => {
  // 一个"投影失败也照样去问一次"的实现，会让一次畸形请求在审批箱里留下一行，
  // 而那一行绑的是一个谁也没执行过的操作。
  const traced = tracingHub()
  const port = portOf({ hub: traced.hub })
  const bad = projectionOf()
  delete bad.callId

  const outcome = await port.requestApproval(bad, { responseTimeoutMs: 1000 })
  assert.equal(outcome, 'unavailable')
  assert.equal(port.lastTicket().code, BRIDGE_CODES.CALL_ID_MISSING,
    '桥的失败码必须原样透出——定位时要能看出是哪一层缺字段')
  assert.deepEqual(traced.paths, [], '★ 主体造不出来还是发了请求')
  assert.ok(APPROVAL_OUTCOMES.includes(outcome))
})

test('★ 缺 requestId 的"待批准"是故障，不是可以继续等的状态', async () => {
  const fake = {
    write: async () => ({ ok: true, task: { status: 'pending' } }),
    read: async () => { throw new Error('不该读审批箱') },
  }
  const port = portOf({ hub: fake })
  const outcome = await port.requestApproval(projectionOf(), { responseTimeoutMs: 5000 })
  assert.equal(outcome, 'unavailable')
  assert.equal(port.lastTicket().code, APPROVAL_PORT_CODES.REQUEST_ID_MISSING)
  assert.match(port.lastTicket().reason, /消费/)
})

test('★ inbox 响应形状不对 → unavailable，不静默当成"空箱子"', async () => {
  for (const bad of [{ ok: true }, { ok: true, requests: null }, {}]) {
    const fake = {
      write: async () => ({ ok: true, task: { status: 'pending', requestId: 'p', bindingHash: null } }),
      read: async () => bad,
    }
    const port = portOf({ hub: fake })
    const outcome = await port.requestApproval(projectionOf(), { responseTimeoutMs: 1000 })
    assert.equal(outcome, 'unavailable')
    assert.equal(port.lastTicket().code, APPROVAL_PORT_CODES.INBOX_FAILED,
      `inbox=${JSON.stringify(bad)} 被当成了空箱子，而不是形状不对`)
  }
})

test('★ 每条路径的结局都在 `APPROVAL_OUTCOMES` 闭集里', async () => {
  // 端口是 `createApprovalAnswerer` 的 `request`，而 answerer 会把闭集外的值
  // 判成"这个端口现在不可信"。所以端口自己绝不能吐出闭集外的值。
  const cases = [
    { write: async () => { throw new Error('x') }, read: async () => ({ requests: [] }) },
    { write: async () => ({ task: { status: 'pending' } }), read: async () => ({ requests: [] }) },
    { write: async () => ({ task: { status: '全新' } }), read: async () => ({ requests: [] }) },
    { write: async () => ({ task: { status: 'expired' } }), read: async () => ({ requests: [] }) },
    { write: async () => ({ task: { status: 'denied' } }), read: async () => ({ requests: [] }) },
    { write: async () => ({ task: { status: 'approved' } }), read: async () => ({ requests: [] }) },
  ]
  for (const [i, fake] of cases.entries()) {
    const port = portOf({ hub: fake, sleep: async () => {} })
    const outcome = await port.requestApproval(projectionOf(), { responseTimeoutMs: 1 })
    assert.ok(APPROVAL_OUTCOMES.includes(outcome), `第 ${i} 种返回了闭集外的 ${JSON.stringify(outcome)}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ ★★★ 组合根 → 注册缝工厂 → **真 hub**：端到端真的发出一次请求
//
// PRT-212 的台账里长期挂着一条限定：「端点的**生产者**已交付，但端点**从未真的
// 发过一次请求**（构造期不发 HTTP，进程里也没有 hub）」。
//
// 上面各条已经分别守住了两段：端口自己接真 hub（①②），工厂自己翻译错误
// （`approval-registrar-row.test.mjs`，注入传输）。**缺的是中间那一截**：
// `installEnforcementRoot` 从注册缝取工厂、拿解析好的身份配置跑出端口、
// 交给桥——这条链**从来没有对着一个真 hub 跑过一次**。
//
//   > 一个「每一段各自都被测过」的链路，
//   > 与一个「真的接通过一次」的链路，在它被接通之前是同一个东西——
//   > 只不过前者的用例数是完整的。
//
// 判据不是"函数返回了 allowed-once"（那可以靠默认值蒙对），而是
// **审批箱里真的出现过一条携带着 hub 自己铸的 `requestId` 的待批准行**：
// 那个 id 只能由真 hub 铸出来，本地编不出来。
// ─────────────────────────────────────────────────────────────────────────────

/** 组合根读的这几个键，就是根行在真 DSH 进程里会读到的那一组。 */
const ROOT_ENV = Object.freeze({
  TEAM_HUB_URL: BASE,
  LEGION_ACTOR: 'e2e-actor',
  LEGION_SCOPE: 'e2e-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

/**
 * 装一份组合根，**走注册缝**取审批端口工厂——即生产里那条链。
 *
 * `resetEnforcementRoot()` 是必须的：组合根是**进程单例**，而"只装一次"正是它的
 * 设计（两次装配会得到两份桥和两本登记簿）。用例之间要换 hub 地址，就得显式重置。
 */
async function installRoot({
  hubUrl = BASE,
  approvalResponseTimeoutMs = 8000,
  approvalConnectTimeoutMs = 2000,
  decide = () => ({ kind: 'allow' }),
} = {}) {
  const { resetEnforcementRoot, installEnforcementRoot } = await import('../runtime/dsh-composition/root.mjs')
  const row = await import('../runtime/dsh-composition/plugins/root-row.mjs')
  resetEnforcementRoot()
  const inst = installEnforcementRoot({
    env: { ...ROOT_ENV, TEAM_HUB_URL: hubUrl },
    // `decide` 是组合根**必需**的端口。注意：桥的 `answerer` **不读它**
    // （它无条件把可投影的调用交给审批端口），所以下面两条用例都不把结局归因于它。
    decide,
    // ★ 生产那条链的中间一截：注册缝里的工厂 + 解析好的身份配置 → 端口 → `requestApproval`。
    //   组合根要的是**函数**，而工厂给的是 `{requestApproval, ticketFor, …}`，
    //   中间那次提取就是根行 `requestApprovalOf` 做的事。
    createRequestApproval: (resolved) => row.approvalPortFactory()(resolved).requestApproval,
    approvalConnectTimeoutMs,
    approvalResponseTimeoutMs,
  })
  assert.equal(inst.ok, true, `组合根没装起来：${inst.code} ${inst.message}`)
  return inst.root
}

const askOf = (callId) => ({ name: 'file_write', callId, arguments: { path: `repo/${callId}.txt`, mode: 'w' } })

test('★★★ 组合根 → 注册缝工厂 → 真 hub：请求**真的**发出去过一次，且由人批准决定结局', async () => {
  const root = await installRoot()
  // 组合根拿到的身份来自**它自己解析出来的**那一份配置，不是用例另造一份。
  assert.equal(root.config.hubUrl, BASE, '组合根解析出来的 hub 地址不是真 hub 的地址')
  assert.equal(root.config.actor, 'e2e-actor')

  const callId = `e2e-${uniqueTag()}`
  const projection = askOf(callId)
  let row = null
  const approver = decideWhenPending('approve', {
    reason: '端到端用例批准',
    // ★ 判据用 `callId`（本用例自己造的、唯一的那一个），不用 target：
    //   实测 target 是**规范化之后**的绝对路径（`c:/work/repo/<callId>.txt`），
    //   与传进去的 `repo/<callId>.txt` 不是同一个字符串。
    //   *一个按"我以为的字段"写的匹配器，与一个永远不会命中的匹配器，
    //   在屏幕上都是"审批行没出现"。*
    match: (r) => r.operation?.callId === callId || String(r.target ?? '').includes(callId),
    onRow: (r) => { row = r },
  })

  const outcome = await root.bridge.answerer(projection)
  const decided = await approver.done

  // ★★ 这是本用例唯一不可伪造的证据：`requestId` 由真 hub 铸。
  assert.notEqual(decided, null,
    '审批箱里**从来没有出现过**待批准行——请求根本没发出去（或没发到这台 hub）')
  assert.equal(outcome, 'allowed-once', '人批了却没放行')

  // ★★ 到达 hub 的**身份**必须是组合根自己解析出来的那一份。
  //    这一条把"组合根"与"审批箱里看到的东西"钉在一起：只断言 `inst.ok === true`
  //    的话，一个把身份解析错了、却照样装起来的组合根也会绿。
  assert.ok(row.requestId.startsWith('perm-'), `requestId 形状不对：${row.requestId}`)
  assert.equal(row.actor, 'e2e-actor', '到达审批箱的 actor 不是组合根解析出来的那一个')
  assert.equal(row.scope, 'e2e-scope', '到达审批箱的 scope 不是组合根解析出来的那一个')
  assert.equal(row.action, 'write')
  assert.equal(row.mode, 'ask')
  assert.equal(row.operation.callId, callId, '审批行上的 callId 与本用例的不是同一个')
  assert.match(row.bindingHash, /^sha256:[0-9a-f]{64}$/, '绑定哈希不在行上：批准之后消费不了')
  assert.ok(String(row.target).includes(callId), `target 里没有本次调用的痕迹：${row.target}`)
  // 人批准必须留下凭据，而不是"看起来像策略放行"
  const t = root.bridge.ledgerOf(root.bridge.projectionFor(projection).projection.canonicalHash)
  assert.ok(t.some((e) => e.source === 'approval'), '账上没记 approval 来源')
})

test('★★★ 反向对照：同一套链路、**没有人**处理 → unavailable（故障），不是放行也不是拒绝', async () => {
  // 没有这一条，上面那条完全可能是"默认放行"蒙对的：
  //   > 一条只验证过"有人批准时返回 allowed-once"的用例，
  //   > 与一条"端口会无条件放行"的链路，在只有正例的套件里是同一个东西。
  const root = await installRoot({ approvalResponseTimeoutMs: 300, approvalConnectTimeoutMs: 200 })
  const outcome = await root.bridge.answerer(askOf(`e2e-none-${uniqueTag()}`))
  assert.equal(outcome, 'unavailable',
    '没人处理的申请返回了 ' + JSON.stringify(outcome) + '——"没人回答"必须是故障（unavailable），不是 allow、也不是 rejected（人说不）')
  assert.ok(APPROVAL_OUTCOMES.includes(outcome))
})

test('★★★ 反向对照：hub 地址指向一个**没人监听**的端口 → 一律 fail closed', async () => {
  // 先起一个真 server 拿一个确定空闲的端口，再关掉它 —— 这样"连不上"是构造出来的，
  // 不是碰运气撞上一个没被占的端口号。
  const probe = await import('node:net')
  const srv = probe.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const deadPort = srv.address().port
  await new Promise((r) => srv.close(r))

  const root = await installRoot({
    hubUrl: `http://127.0.0.1:${deadPort}`,
    approvalResponseTimeoutMs: 300,
    approvalConnectTimeoutMs: 300,
  })
  const outcome = await root.bridge.answerer(askOf(`e2e-dead-${uniqueTag()}`))
  assert.equal(outcome, 'unavailable',
    '审批箱不可达时返回了 ' + JSON.stringify(outcome) + '——不可达必须是故障（fail closed）')
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ ★★★ 驱动**生产的两行插件本体**（不是桥）：tools/pre-execute → 登记簿 → approval/request → 真 hub
//
// 上面第 ③ 组走的是 `root.bridge.answerer`——那是**桥**。而 DSH 真正派发的是事件，
// 承接它的是 `root.rows.approvalAnswerer` 这个**插件行**；两行之间靠一本共享登记簿
// 会合：pre-execute 行在 `ask` 时把投影写进去，answerer 行靠它算绑定哈希。
//
//   > 一个"桥自己接得上审批箱"的证明，
//   > 与一个"DSH 派发事件时这一行答得出话"的证明，是两件事——
//   > 只不过前者看起来已经覆盖了后者。
//
// DSH 那一侧的契约（事件名、瀑布语义、`ctx.plugin` 的装载）已经由
// `enforcement-plugin.test.mjs` 对着**真运行时**守住；这里补的是**我们自己两行之间的
// 会合**在真 hub 上跑不跑得通，所以用记录型 ctx 把两行的 handler 抓出来直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

/** 记录型 ctx：行只需要 `ctx.on`（其余都是可选的）。 */
function recordingCtx() {
  const handlers = new Map()
  return {
    handlers,
    /** 取某事件的处理器；取不到就是**接线本身**没接上，如实报出来。 */
    handlerOf(event) {
      const fn = handlers.get(event)
      assert.equal(typeof fn, 'function', `没有任何一行注册了 ${event}——两行的接线没接上`)
      return fn
    },
    ctx: {
      on: (event, fn) => { handlers.set(event, fn); return () => { handlers.delete(event) } },
      logger: { info: () => {} },
    },
  }
}

test('★★★ 生产两行之间真的会合：pre-execute 留投影 → approval/request 认领 → 真 hub 批准', async () => {
  // `decide` 必须答 `ask`，否则 pre-execute 行走的是 `allow` 分支（让路），不留投影。
  const root = await installRoot({ decide: () => ({ kind: 'ask' }) })

  // ★ 两行必须闭包到**同一本**登记簿 —— 那是它们唯一的会合点，而"共用"是身份不是形状。
  assert.equal(root.rows.preExecute.registry, root.rows.approvalAnswerer.registry,
    '生产的两行没有共用同一本登记簿：ask 留下的投影在审批那一侧查不到，审批将永远问不到人')
  assert.equal(typeof root.rows.approvalAnswerer.port, 'function', 'answerer 行闭包到的端口不是端口')

  const pre = recordingCtx()
  root.rows.preExecute.apply(pre.ctx, undefined)
  const answer = recordingCtx()
  root.rows.approvalAnswerer.apply(answer.ctx, undefined)

  const callId = `row-${uniqueTag()}`
  const exec = askOf(callId)

  // ① 真·第一道门：DSH 会派发的 `tools/pre-execute`。
  const decision = await pre.handlerOf('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask', '策略答 ask 时 pre-execute 行没有认领')
  assert.notEqual(root.registry.peek(callId), undefined,
    'pre-execute 行没有把投影写进登记簿——answerer 行随后必然算不出绑定哈希')

  // ② 后台当"人"，然后派发 `approval/request`（DSH 在需要审批时派发的那个事件）。
  let row = null
  const approver = decideWhenPending('approve', {
    reason: '两行会合用例批准',
    match: (r) => r.operation?.callId === callId || String(r.target ?? '').includes(callId),
    onRow: (r) => { row = r },
  })

  const nextCalls = []
  const outcome = await answer.handlerOf('approval/request')(
    { callId, toolName: 'file_write', reason: '端到端' },
    async () => { nextCalls.push(1); return 'unavailable' },
  )
  const decided = await approver.done

  // ★★ 只有真 hub 铸得出 requestId —— 这是"审批申请真的到了审批箱"的唯一硬证据。
  assert.notEqual(decided, null, '审批箱里从来没有出现过待批准行：请求没发出去')
  assert.equal(outcome, 'allowed-once', '人批准了，而 answerer 行给的是 ' + JSON.stringify(outcome))
  // ★ answerer 行**认领**了这次询问：它不能把球踢给 next()，
  //   否则 DSH 的兜底会接管，而"我们拦下了"与"我们让开了"在结局上可能同形。
  assert.deepEqual(nextCalls, [], 'answerer 行没有认领这次审批，把它让给了下一道（next()）')
  assert.equal(row.operation.callId, callId, '送到审批箱的不是本次调用')
  assert.equal(row.actor, 'e2e-actor', '到达审批箱的 actor 不是组合根解析出来的那一个')
  assert.match(row.bindingHash, /^sha256:[0-9a-f]{64}$/
    , '审批行上没有绑定哈希——说明投影没有经过登记簿')
})

// ══════════════════════════════════════════════════════════════════════════════
// PRT-316 切片 2：搬走的 permissions/审批箱 族的**缝上契约**
//
// 为什么要补：破验（`.worktrees/_prt-handoff/mutate-slice2.mjs`）量出既有 HTTP 套件
// 只咬住 6 条里的 1 条。逐条查过之后，**另外 4 条是"从来没人测过"**，
// 不是"我的变异等价"：
//
//   - `DELETE /api/permissions/rules/<id>`：全仓 **0 个套件**碰过（带 id 的前缀路由）；
//   - `GET /api/permissions/inbox?scope=`：全仓 **0 个套件**带过 scope；
//   - `POST /api/permissions/check` 不带 `actor`：没有套件走过那条回退。
//
//   > 一个"所有用例都绿"的路由族，与一个"有一半行为从来没人问过"的路由族，
//   > 在测试报告上是同一个读数。
//
// ★ 补在**这个文件**里而不是新建文件，是有意的：新建 `*.test.mjs` 会改变
//   `git ls-files "*.test.mjs"` 的条数，而那个数被 `boundary-facts` 的
//   `handover-tracked-suites` 钉着（另一会话正在同一处工作）。
//
// ★ 判据打在**缝**上（注入桩）：本片改动引入的正是缝——
//   "路由把注入的依赖用对了没有"。既有 23 例仍在**真 hub** 上验
//   "hub 会怎么答"，两层互补。
// ══════════════════════════════════════════════════════════════════════════════

/** 造一个记录所有注入点调用的族；`overrides` 可覆写任意注入点。 */
function spyFamily(overrides = {}) {
  const calls = { inbox: [], delete: [], upsert: [], check: [], decide: [], sent: [] }
  const fam = createPermissionsRoutes({
    json: (_res, code, obj) => { calls.sent.push([code, obj]) },
    handleWrite: async (_req, _res, fn) => { fn({}, 'general', 'global') },
    authorized: () => true,
    readBody: async () => ({}),
    requireMember: () => 'general',
    listPermissionInbox: (scope) => { calls.inbox.push(scope); return [] },
    decidePermission: (a) => { calls.decide.push(a); return a },
    checkPermission: (a) => { calls.check.push(a); return { status: 'ask' } },
    upsertPermissionRule: (a) => { calls.upsert.push(a); return a },
    deletePermissionRule: (id, by) => { calls.delete.push([id, by]); return { scope: id, by } },
    ...overrides,
  })
  return { fam, calls }
}

// ★ `path` 必须是 **pathname**（不带查询串）——真实 `handle()` 就是这么传的
//   （`let path = url.pathname`）。把 `?scope=` 一起传进 path 会让**等值路由匹配不上**，
//   而那正是我第一版夹具的错：读数是"scope 没透传"，真相是"路由根本没被调用"。
const dispatchPerm = (fam, method, target) => {
  const url = new URL(`http://x${target}`)
  return fam.dispatch({ method, headers: {} }, {}, { path: url.pathname, url })
}

test('切片2 ① inbox 的鉴权真的来自注入的 authorized（取掉它必须 401，且不许读审批箱）', async () => {
  const { fam, calls } = spyFamily({ authorized: () => false })
  const handled = await dispatchPerm(fam, 'GET', '/api/permissions/inbox')
  assert.equal(handled, true, 'inbox 没被本族接住')
  assert.deepEqual(calls.sent, [[401, { error: '未授权：Bearer token 无效' }]]
    , '未授权时没有回 401（鉴权被取掉了）')
  assert.deepEqual(calls.inbox, [], '未授权时仍然把审批箱读出来了')

  // 反面控制：授权通过时必须真的读，否则上面那条会退化成"恒 401 也算过"
  //   ⚠️ 成功路径**也会**调 `json`（200），所以不能断言 `sent` 为空——
  //   要断言的是"没有 401"，不是"没有响应"。
  const ok = spyFamily()
  await dispatchPerm(ok.fam, 'GET', '/api/permissions/inbox')
  assert.deepEqual(ok.calls.inbox, [null], '授权通过时没有读审批箱')
  assert.ok(ok.calls.sent.length > 0 && ok.calls.sent.every(([code]) => code === 200)
    , '授权通过时出现了非 200 的响应：' + JSON.stringify(ok.calls.sent))
})

test('切片2 ② inbox 的 scope 是**透传**的（不带时必须是 null，不是空串）', async () => {
  const { fam, calls } = spyFamily()
  await dispatchPerm(fam, 'GET', '/api/permissions/inbox?scope=software')
  await dispatchPerm(fam, 'GET', '/api/permissions/inbox')
  assert.deepEqual(calls.inbox, ['software', null]
    , 'scope 没有从 url 透传下去（或空值没归成 null）——审批箱会把别的空间的行混进来')
})

test('切片2 ③ check 缺 actor 时回落成 by；显式给了 actor 就不许被覆盖', async () => {
  const absent = spyFamily()
  await dispatchPerm(absent.fam, 'POST', '/api/permissions/check')
  assert.equal(absent.calls.check.length, 1, 'check 路由没被接住')
  assert.equal(absent.calls.check[0].actor, 'general'
    , '缺 actor 时没有回落成 by（这次判定会落在一个空主体上）')

  const explicit = spyFamily({
    handleWrite: async (_req, _res, fn) => { fn({ actor: 'someone-else' }, 'general') },
  })
  await dispatchPerm(explicit.fam, 'POST', '/api/permissions/check')
  assert.equal(explicit.calls.check[0].actor, 'someone-else', '显式 actor 被 by 覆盖了')
})

test('切片2 ④ 带 id 的删除是**前缀**路由：id 逐字传出，且不吃掉 POST rules', async () => {
  const { fam, calls } = spyFamily()
  const hit = await dispatchPerm(fam, 'DELETE', '/api/permissions/rules/rule-abc')
  assert.equal(hit, true, '带 id 的 DELETE 没被接住（前缀路由退化成了等值比较）')
  assert.deepEqual(calls.delete, [['rule-abc', 'general']]
    , 'id 没有被逐字切出来（切多或切少都会删错行）')

  // 不带 id（无尾斜杠）⇒ 不该命中
  assert.equal(await dispatchPerm(fam, 'DELETE', '/api/permissions/rules'), false
    , 'DELETE 不带 id 也被接住了')

  // POST /api/permissions/rules 必须走 upsert，而不是被删除那条吃掉
  await dispatchPerm(fam, 'POST', '/api/permissions/rules')
  assert.equal(calls.upsert.length, 1, 'POST rules 没走 upsert')
  assert.equal(calls.delete.length, 1, 'POST rules 被删除那条吃掉了')

  // 方法不匹配 ⇒ 不命中
  assert.equal(await dispatchPerm(fam, 'GET', '/api/permissions/rules/rule-abc'), false
    , 'GET 也被删除路由接住了')
})
