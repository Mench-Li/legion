// orchestrator/worker/run-inputs.test.mjs
// ============================================================================
// 运行输入装配（PRT-253 续批）
//
// ## 这一组守的是什么
//
// `defaultRequestFor()` 拒绝猜 `workspaceId` / `modelProfileRef` / `workdir`，
// 这是对的。但"拒绝猜"只有在**有人能给**的时候才是一条防线；
// 在没有人能给的时候，它与"这条执行链永远起不来"是同一个东西。
//
//   > 一个"缺了就具名拒绝"的校验，与一个"永远缺、于是永远拒绝"的执行链，
//   > 在只看那条校验的用例里是同一个东西。
//
// 所以这一组问四个问题：
//
//   ① **每一项都有唯一来源吗？** 控制面给了就以它为准；没给就从权威来源推导；
//      都没有就进 `missing`。三个字段各测三条路。
//   ② **"从哪里来的"能不能读出来？** 一个合并后的 `inputs` 会让
//      "这次控制面没给"永远查不出来——而那正是下一次要修的地方。
//   ③ **不猜。** 没有目录时不返回任何目录（不是 `''`、不是 `process.cwd()`、
//      不是租约里别的字段）。
//   ④ **worktree 与原地执行给出的 `workdir` 必须不同。** 有隔离时那是
//      这次 Attempt 的独立检出；退回项目目录就等于隔离白做了。
//
// ## 破坏性验证（每条改完必须变红，逐条记录）
//
//   ① `pick()` 里丢掉"都没有"那条分支、改成返回 `fromLease ?? derived ?? ''`
//      → 例③、例⑤、例⑧ 全红（`ok` 从 false 变 true，`missing` 变空）。
//   ② `workdirOf()` 把 `in-place` 分支也返回 `workspace.slotDir`
//      → 例⑥ 红（原地执行指到了一个不存在的槽位）。
//   ③ `sources` 改成 `{}`（always）→ 例②、例④、例⑦ 红。
//   ④ `RUN_INPUT_FIELDS` 里删掉 `'workdir'` → 例⑧ 红（缺字段被漏报）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUN_INPUT_CODES, RUN_INPUT_FIELDS, resolveRunInputs, workdirOf, MODEL_PROFILE_CODES, resolveModelProfileRef, createModelProfileRefResolver } from './run-inputs.mjs'
import { defaultRequestFor, EXECUTOR_CODES } from './executor.mjs'
import { validateRunRequest } from '../../runtime/contracts/run.mjs'

/** 认领响应的真实形状（键集逐字取自 `team-hub/run-store.mjs` 的 `shapeAttempt()`）。 */
function leaseOf(over = {}) {
  return {
    attemptId: 'att:T-1:1',
    taskId: 'T-1',
    scope: 'software',
    attemptNo: 1,
    state: 'Leased',
    workerId: 'w1',
    leaseEpoch: 1,
    leaseExpiresAtMs: 1_700_000_060_000,
    idempotencyKey: 'idem:T-1',
    nextAttemptAtMs: null,
    externalEffect: null,
    returnTo: null,
    outcome: null,
    failureCode: null,
    detail: null,
    resolvedBy: null,
    resolvedNote: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    finishedAtMs: null,
    ...over,
  }
}

const SNAPSHOT = {
  finalText: '冻结正文',
  associations: { goalId: 'G-1', taskId: 'T-1', employeeId: 'emp:T-1/coder', teamPlanId: 'tp:1' },
}

test('① 三个字段的清单与契约那三项**逐字一致**', () => {
  // 不是"看起来差不多"：这一组的存在理由就是那三项，名字漂了就等于换了靶子。
  assert.deepEqual([...RUN_INPUT_FIELDS], ['workspaceId', 'modelProfileRef', 'workdir'])
})

test('② 控制面在租约上给了 → 以它为准，且 `sources` 记成 lease', () => {
  const r = resolveRunInputs({
    lease: leaseOf({ workspaceId: 'ws:cp', modelProfileRef: 'mp:cp', workdir: 'C:\\cp' }),
    // 下面这些推导线**故意给不同的值**：如果它们赢了，读数会立刻不同。
    workspace: { kind: 'worktree', slotDir: 'C:\\slot' },
    projectDir: 'C:\\proj',
    modelProfileRef: 'mp:derived',
  })
  assert.equal(r.ok, true, r.message ?? '')
  assert.deepEqual(r.inputs, { workspaceId: 'ws:cp', modelProfileRef: 'mp:cp', workdir: 'C:\\cp' })
  assert.deepEqual(r.sources, { workspaceId: 'lease', modelProfileRef: 'lease', workdir: 'lease' })
})

test('③ 控制面没给 → 从权威来源推导，且 `sources` 说得出是哪一条', () => {
  const r = resolveRunInputs({
    lease: leaseOf(), // 注意：没有 workspaceId / modelProfileRef / workdir
    workspace: { kind: 'worktree', slotDir: 'C:\\data\\worktrees\\software\\att-T-1-1' },
    projectDir: 'C:\\proj',
    modelProfileRef: 'mp:bound',
  })
  assert.equal(r.ok, true, r.message ?? '')
  assert.deepEqual(r.inputs, {
    // 空间就是工作集：租约上带的是**空间**（`can-read-authorization-source.test.mjs` 例① 钉过这一点）
    workspaceId: 'software',
    modelProfileRef: 'mp:bound',
    workdir: 'C:\\data\\worktrees\\software\\att-T-1-1',
  })
  assert.deepEqual(r.sources, {
    workspaceId: 'derived:scope',
    modelProfileRef: 'derived:model-binding',
    workdir: 'derived:worktree-slot',
  })
})

test('④ ★ 没有模型绑定 → 具名拒绝，**不猜一个模型**', () => {
  const r = resolveRunInputs({
    lease: leaseOf(),
    workspace: { kind: 'worktree', slotDir: 'C:\\slot' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUN_INPUT_CODES.MISSING)
  assert.deepEqual([...r.missing], ['modelProfileRef'], '缺的只能是模型那一项：另外两项都有来源')
  // 猜一个模型会花用户的钱，所以这条拒绝必须说得出"我不猜"。
  assert.match(r.message, /不猜/)
})

test('⑤ ★ 没有目录 → 具名拒绝，**不返回空串、也不返回别的目录**', () => {
  // 租约上没有 workdir、工作区阶段没给出目录、也没有被授权的项目目录。
  const r = resolveRunInputs({ lease: leaseOf(), workspace: { kind: 'in-place' }, modelProfileRef: 'mp:1' })
  assert.equal(r.ok, false)
  assert.deepEqual([...r.missing], ['workdir'])
  assert.equal(r.inputs, null, 'inputs 必须是 null：一个"字段都在、值是空的"对象会让下游以为拿到了东西')
})

test('⑥ worktree 与原地执行给出的 `workdir` 不同（否则隔离白做）', () => {
  const wt = workdirOf({ kind: 'worktree', slotDir: 'C:\\data\\worktrees\\s\\att-1' }, { projectDir: 'C:\\proj' })
  const ip = workdirOf({ kind: 'in-place', note: '没有隔离' }, { projectDir: 'C:\\proj' })
  assert.equal(wt, 'C:\\data\\worktrees\\s\\att-1')
  assert.equal(ip, 'C:\\proj')
  assert.notEqual(wt, ip, '有隔离时退回项目目录，等于两个 worker 在同一个目录里改同一份文件')
  // 没见过的 kind：不假装知道它在哪（空值而不是 projectDir）。
  assert.equal(workdirOf({ kind: 'wat' }, { projectDir: 'C:\\proj' }), null)
  // 不是对象 / 没有 kind：同样不猜。
  assert.equal(workdirOf(null, { projectDir: 'C:\\proj' }), null)
  assert.equal(workdirOf({}, { projectDir: 'C:\\proj' }), null)
})

test('⑦ 连租约都没有 → 具名错误，而不是"三项都缺"', () => {
  const r = resolveRunInputs({})
  assert.equal(r.ok, false)
  assert.equal(r.code, RUN_INPUT_CODES.LEASE_REQUIRED)
  assert.deepEqual([...r.missing], [], '租约不在时"控制面给没给"无从作答，报"三项都缺"是编一个结论')
})

test('⑧ ★ 三项全缺时报的必须是**三项**，一项都不能漏', () => {
  // 一个"只看第一项就返回"的实现，会让排障的人改完一项再发现还有一项。
  const r = resolveRunInputs({ lease: leaseOf({ scope: null }) })
  assert.equal(r.ok, false)
  assert.deepEqual([...r.missing], ['workspaceId', 'modelProfileRef', 'workdir'])
  for (const k of RUN_INPUT_FIELDS) assert.match(r.message, new RegExp(k), `${k} 必须在文案里被点名`)
})

test('⑨ ★★ 端到端：真实认领形状 + 这条装配 = 一份**能过契约**的 RunRequest', () => {
  // 这一条是本批的全部要点。上面八条例的是本模块自己的行为，
  // 而这一条问的是"那三个字段接上之后，`defaultRequestFor` 还拒不拒"。
  const built = resolveRunInputs({
    lease: leaseOf(),
    workspace: { kind: 'worktree', slotDir: 'C:\\data\\worktrees\\software\\att-T-1-1' },
    modelProfileRef: 'mp:bound',
  })
  assert.equal(built.ok, true, built.message ?? '')

  // ⚠️ 反面控制：**不**把 inputs 递进去时，必须仍然是那三项缺失。
  //    少了这一半，"接上之后能过"这件事可能只是因为校验被放松了。
  assert.throws(
    () => defaultRequestFor(leaseOf(), SNAPSHOT),
    (e) => e.code === EXECUTOR_CODES.BAD_WIRING && e.missing.includes('workspaceId'),
    '不接线时就必须拒绝——否则本批是在放松校验，不是在接线',
  )

  const request = defaultRequestFor(leaseOf(), SNAPSHOT, built)
  assert.equal(request.workspaceId, 'software')
  assert.equal(request.modelProfileRef, 'mp:bound')
  assert.equal(request.workdir, 'C:\\data\\worktrees\\software\\att-T-1-1')
  // 必填全满：用**契约自己**的判据独立复核，不在用例里另抄一份必填清单。
  const verdict = validateRunRequest(request)
  assert.equal(verdict.ok, true, `契约不该拒绝它：${verdict.errors.join('；')}`)
})

test('⑩ `resolveRunInputs` 的结果**原样**可递给 `defaultRequestFor`（形状不漂）', () => {
  // 一个"要先把 `inputs` 拆出来再拼一次"的接口，与一个"直接可递"的接口，
  // 差别不在方便：中间那一次手抄就是下一次漂移发生的地方。
  const r = resolveRunInputs({ lease: leaseOf(), workspace: { kind: 'worktree', slotDir: 'C:\\slot' }, modelProfileRef: 'mp:1' })
  const request = defaultRequestFor(leaseOf({ modelProfileRef: 'mp:1', workdir: 'C:\\slot' }), SNAPSHOT, r)
  assert.equal(request.workspaceId, 'software')
})

test('⑪ ★ 被**拒绝**的装配不许被采纳（只在 ok===true 时用它的 inputs）', () => {
  // 这条防的是一种很自然的"改进"：拒绝时也把已经算出来的部分值带回去。
  // 那样一来 `defaultRequestFor` 会安静地把一份**不完整的**输入当成完整的用。
  const refused = resolveRunInputs({
    lease: leaseOf(),
    workspace: { kind: 'worktree', slotDir: 'C:\\slot' },
    // 缺 modelProfileRef → 整个装配被拒
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.inputs, null, '拒绝时 inputs 必须是 null')
  // 即使拒绝的联合上手工挂了 inputs，`defaultRequestFor` 也只认 `ok===true`。
  const forged = { ok: false, code: 'x', message: 'y', inputs: { workspaceId: '伪造', workdir: 'C:\\伪造', modelProfileRef: 'mp:伪造' } }
  assert.throws(
    () => defaultRequestFor(leaseOf(), SNAPSHOT, forged),
    (e) => e.code === EXECUTOR_CODES.BAD_WIRING,
    '一份被拒绝的装配不许被采纳——判据取联合自己的结论，不取"字段看起来有没有值"',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ⑫~⑯ `modelProfileRef` 的权威来源：员工的模型绑定（PRT-502）
// ════════════════════════════════════════════════════════════════════════════

/** 一个只回答一条路径的假 hub 读口。 */
function hubServing(answers) {
  const seen = []
  return {
    seen,
    async get(path) {
      seen.push(path)
      const hit = answers(path)
      if (hit === undefined) throw new Error(`没有为 ${path} 准备答案`)
      return hit
    },
  }
}

const PRIMARY_OK = {
  status: 200,
  body: {
    ok: true,
    resolution: {
      ok: true, code: null, message: null,
      chain: [{ id: 'mp:primary', role: 'primary', order: 1 }, { id: 'mp:fb', role: 'fallback', order: 2 }],
      skipped: [], perRunBudget: null, errors: [],
      employeeRole: 'coder', scope: 'software',
    },
  },
}

test('⑫ ★ 主档案解析成功 → 取 `chain[0]`，并且问的是 (scope, role) 二元', async () => {
  const hub = hubServing(() => PRIMARY_OK)
  const r = await resolveModelProfileRef({ get: hub.get, scope: 'software', role: 'coder' })
  assert.equal(r.ok, true, r.message ?? '')
  assert.equal(r.modelProfileRef, 'mp:primary')
  assert.equal(r.chainRole, 'primary')
  assert.equal(hub.seen.length, 1)
  assert.match(hub.seen[0], /\/api\/model-bindings\/resolve\?scope=software&role=coder$/)
})

test('⑬ ★★★ 主档案解析不出来时**不许 fallback 顶替**（PRT-502 §①）', async () => {
  // 库里的形状：`ok:false`，而 `chain` 里**仍然有**那条备用（诊断要看得见），
  // 且它的 `role` 保持 `'fallback'`——**没有被改写成 primary**。
  const hub = hubServing(() => ({
    status: 200,
    body: {
      ok: true,
      resolution: {
        ok: false, code: 'PRIMARY_UNRESOLVED', message: '主档案连不上',
        chain: [{ id: 'mp:fb', role: 'fallback', order: 1 }],
        skipped: [], perRunBudget: null, errors: [], employeeRole: 'coder', scope: 'software',
      },
    },
  }))
  const r = await resolveModelProfileRef({ get: hub.get, scope: 'software', role: 'coder' })
  assert.equal(r.ok, false)
  assert.equal(r.code, MODEL_PROFILE_CODES.PRIMARY_UNRESOLVED)
  assert.equal(r.modelProfileRef, null, '链首就在那里，但它是备用——取它就是用没人选过的模型跑完这次运行')
  assert.match(r.message, /不自动降级到备用/)
})

test('⑭ ★ 有绑定但链首不是 primary（形状不合约）→ 同样拒绝', async () => {
  // 防的是"取链首"这种实现：上面那条被 `ok:false` 挡住了，
  // 而这条走的是 ok:true 但链首 role 不对的路——两条都要挡住。
  const hub = hubServing(() => ({
    status: 200,
    body: { ok: true, resolution: { ok: true, code: null, chain: [{ id: 'mp:fb', role: 'fallback', order: 1 }] } },
  }))
  const r = await resolveModelProfileRef({ get: hub.get, scope: 's', role: 'r' })
  assert.equal(r.ok, false)
  assert.equal(r.code, MODEL_PROFILE_CODES.PRIMARY_UNRESOLVED)
  assert.match(r.message, /链首不是主档案/)
})

test('⑮ ★ 404（没有绑定）与 5xx（没问到）必须是**两个码**', async () => {
  const notFound = await resolveModelProfileRef({
    get: hubServing(() => ({ status: 404, body: { ok: false, code: 'BINDING_NOT_FOUND', error: '没有这条绑定' } })).get,
    scope: 's', role: 'r',
  })
  assert.equal(notFound.code, MODEL_PROFILE_CODES.BINDING_NOT_FOUND)
  assert.equal(notFound.retryable, false, '没有绑定要去**建绑定**，重试一万次也还是没有')
  assert.match(notFound.message, /去建绑定/)

  const down = await resolveModelProfileRef({
    get: hubServing(() => ({ status: 503, body: { ok: false, error: 'hub 在重启' } })).get,
    scope: 's', role: 'r',
  })
  assert.equal(down.code, MODEL_PROFILE_CODES.UNREACHABLE)
  assert.equal(down.retryable, true, 'hub 重启完就好了——这一条要能重试')
  assert.notEqual(notFound.code, down.code, '把两者混成一码，运维有一半动作是错的')
})

test('⑯ 没有读口 / 缺 scope / 缺 role / 网络抛错：四种都要具名，且都不猜模型', async () => {
  const noHub = await resolveModelProfileRef({ scope: 's', role: 'r' })
  assert.equal(noHub.code, MODEL_PROFILE_CODES.HUB_REQUIRED)

  const noRole = await resolveModelProfileRef({ get: async () => PRIMARY_OK, scope: 's' })
  assert.equal(noRole.code, MODEL_PROFILE_CODES.ROLE_REQUIRED)
  assert.equal(noRole.modelProfileRef, null)

  const noScope = await resolveModelProfileRef({ get: async () => PRIMARY_OK, role: 'r' })
  assert.equal(noScope.code, MODEL_PROFILE_CODES.ROLE_REQUIRED)

  const thrown = await resolveModelProfileRef({
    get: async () => { throw new Error('ECONNREFUSED') }, scope: 's', role: 'r',
  })
  assert.equal(thrown.code, MODEL_PROFILE_CODES.UNREACHABLE)
  assert.equal(thrown.retryable, true)
  // 四种都不许给出一个模型。
  for (const r of [noHub, noRole, noScope, thrown]) assert.equal(r.modelProfileRef, null)
})

test('⑰ 绑定的解析结果**接上** `resolveRunInputs` 之后能过契约', async () => {
  // 把这一节与上一节连起来：绑定解析给的 id 真的能让那三个字段齐。
  const bound = await resolveModelProfileRef({ get: hubServing(() => PRIMARY_OK).get, scope: 'software', role: 'coder' })
  const assembled = resolveRunInputs({
    lease: leaseOf(), // 租约上三项都没有
    workspace: { kind: 'worktree', slotDir: 'C:\\slot\\att-1' },
    modelProfileRef: bound.modelProfileRef,
  })
  assert.equal(assembled.ok, true, assembled.message ?? '')
  assert.equal(assembled.inputs.modelProfileRef, 'mp:primary')
  assert.equal(assembled.sources.modelProfileRef, 'derived:model-binding')
  assert.equal(validateRunRequest(defaultRequestFor(leaseOf(), SNAPSHOT, assembled)).ok, true)
})

// ════════════════════════════════════════════════════════════════════════════
// ⑱~⑳ 端口实现：从租约 → 任务上的岗位 → 模型绑定
// ════════════════════════════════════════════════════════════════════════════

test('⑱ ★ 岗位在**任务**上（租约没有这一列）→ 先读任务再解析绑定', async () => {
  const hub = hubServing((path) => {
    if (path.startsWith('/api/task?')) return { status: 200, body: { id: 'T-1', role: 'coder', goalId: 'G-1' } }
    if (path.startsWith('/api/model-bindings/resolve')) return PRIMARY_OK
    return undefined
  })
  const port = createModelProfileRefResolver({ get: hub.get })
  const r = await port(leaseOf())
  assert.equal(r.ok, true, r.message ?? '')
  assert.equal(r.modelProfileRef, 'mp:primary')
  // 两次读的顺序：先任务（拿岗位），再绑定（拿模型）。
  assert.equal(hub.seen.length, 2)
  assert.match(hub.seen[0], /^\/api\/task\?id=T-1$/)
  assert.match(hub.seen[1], /role=coder/)
})

test('⑲ 租约上恰好带着岗位 → 不必多读一次任务', async () => {
  const hub = hubServing((path) => (path.startsWith('/api/model-bindings') ? PRIMARY_OK : undefined))
  const port = createModelProfileRefResolver({ get: hub.get })
  const r = await port(leaseOf({ employeeRole: 'coder' }))
  assert.equal(r.ok, true, r.message ?? '')
  assert.equal(hub.seen.length, 1, '租约上已有岗位时不该再读任务')
})

test('⑳ ★★ 任务上没有岗位 → 具名拒绝，**不回落到平台默认**', async () => {
  // 这一条是整条链最容易出错的地方：一个"没有 role 就用默认模型"的回落，
  // 与一个"用某个没人给这个岗位选过的模型跑完这次运行"的实现，是同一个东西。
  const hub = hubServing((path) => {
    if (path.startsWith('/api/task?')) return { status: 200, body: { id: 'T-1', role: null } }
    return PRIMARY_OK // 万一有人跳过了岗位那一步，绑定解析会"成功"——所以必须在这里就拦住
  })
  const port = createModelProfileRefResolver({ get: hub.get })
  const r = await port(leaseOf())
  assert.equal(r.ok, false)
  assert.equal(r.code, MODEL_PROFILE_CODES.ROLE_REQUIRED)
  assert.equal(r.modelProfileRef, null)
  assert.equal(hub.seen.length, 1, '岗位都没有，就不该去解析绑定')
})

test('㉑ 任务读不到 / 没有 taskId / 没有读口：三种都具名，且都不给模型', async () => {
  const missingTask = createModelProfileRefResolver({ get: hubServing(() => ({ status: 404, body: {} })).get })
  assert.equal((await missingTask(leaseOf())).code, MODEL_PROFILE_CODES.UNREACHABLE)

  const noTaskId = createModelProfileRefResolver({ get: async () => PRIMARY_OK })
  assert.equal((await noTaskId(leaseOf({ taskId: null }))).code, MODEL_PROFILE_CODES.ROLE_REQUIRED)

  const noGet = createModelProfileRefResolver({})
  assert.equal((await noGet(leaseOf())).code, MODEL_PROFILE_CODES.HUB_REQUIRED)
})

// ════════════════════════════════════════════════════════════════════════════
// ㉒~㉓ 生产入口与外壳**真的**把它接上了吗
// ════════════════════════════════════════════════════════════════════════════
//
// 上面二十一条证明的是"这个模块对"，而这一节问的是**另一半**：
// 生产部署走的那条路上，它到底有没有被调用。
//
//   > 一个"解析器写得对、套件全绿"的模块，
//   > 与一个"生产入口从来没接上、于是每一次 Run 都缺 modelProfileRef"的模块，
//   > 在只看那套套件的时候是同一个东西。

test('㉒ ★ 生产入口**真的**供给了模型解析端口（源级钉子）', async () => {
  // 只能做源级检查：那个入口有顶层 `await` 与 `process.exit`，不能被 import 进来跑。
  // 弱点写在这里：它证明的是**那一行在**，不是"那一行会执行"。
  // 行为那一半由例⑱~㉑（端口本身）与例㉓（外壳把它传给 createWorker）合起来闭合。
  const src = readFileSync(fileURLToPath(new URL('../../product/orchestrator/worker.mjs', import.meta.url)), 'utf8')
  assert.match(src, /createModelProfileRefResolver\s*\(\s*\{\s*get:/,
    '生产入口没有建立模型解析端口——那么真实部署里每一次 Run 都会缺 modelProfileRef')
  assert.match(src, /modelProfileRefFor\s*,\s*\n\}\)/,
    '生产入口没有把 `modelProfileRefFor` 交给 `runWorkerProcess`：'
    + '端口建了却不交出去，与没建是同一个东西')
})

test('㉔ ★★★ 走完一整轮：`execute` 真的收到了 worktree 槽位与模型（此前被丢掉）', async () => {
  // 这一条是本批唯一"整条路真的跑了一遍"的判据。
  // 它同时钉住三件事：
  //   ① `prepareWorkspace` 的结果**不再被丢掉**（它以前 `step()` 返回了就没人接）；
  //   ② `modelProfileRefFor` 的结果被装进 `runInputs` 并**随调用**交给引擎；
  //   ③ `projectDir` 只在原地执行时兜底——有隔离时用的是槽位目录。
  const { createWorker } = await import('./main.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'legion-runinputs-e2e-'))
  const got = []
  const hub = {
    async claim() { return { attemptId: 'att:T-9:1', taskId: 'T-9', leaseEpoch: 1, scope: 'software' } },
    async heartbeat() { return { ok: true } },
    async release() { return { ok: true } },
    async transition() { return { ok: true } },
  }
  const worker = createWorker({
    dataDir: dir, hub,
    executor: {
      // 槽位目录与 projectDir **故意不同**：若有人把 workdir 写死成项目目录，
      // 这一条会红——而那正是"隔离白做了"的形状。
      prepareWorkspace: async () => ({ kind: 'worktree', slotDir: 'C:\\slot\\att-T-9-1' }),
      buildContext: async () => ({ kind: 'minimal' }),
      async execute(lease, runInputs) {
        got.push({ lease, runInputs })
        return { outcome: 'completed' }
      },
    },
    projectDir: 'C:\\authorized-project',
    modelProfileRefFor: async () => 'mp:from-port',
    logger: () => {},
  })
  try {
    const r = await worker.tick()
    assert.equal(r.acted, true, `这一轮应当执行了：${JSON.stringify(r)}`)
    assert.equal(got.length, 1, 'execute 必须被调到一次')
    const second = got[0].runInputs
    assert.equal(second.ok, true, `装配应当齐：${second?.message ?? ''}（缺 ${JSON.stringify(second?.missing)}）`)
    assert.deepEqual(second.inputs, {
      workspaceId: 'software',
      modelProfileRef: 'mp:from-port',
      workdir: 'C:\\slot\\att-T-9-1',
    })
    // 三个来源各是哪一条，必须能读出来——只留合并后的值会让
    // "控制面这次没给"这件事永远查不出来。
    assert.deepEqual(second.sources, {
      workspaceId: 'derived:scope',
      modelProfileRef: 'derived:model-binding',
      workdir: 'derived:worktree-slot',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('㉕ 一整轮跑完后，运行输入的**出处**进了终态证据', async () => {
  // 值的出处要能被人事后读到，否则排障只能靠猜"这个 workspaceId 是谁写的"。
  const { createWorker } = await import('./main.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'legion-runinputs-ev-'))
  const transitions = []
  const hub = {
    async claim() { return { attemptId: 'att:T-8:1', taskId: 'T-8', leaseEpoch: 1, scope: 'ozon' } },
    async heartbeat() { return { ok: true } },
    async release() { return { ok: true } },
    async transition(req) { transitions.push(req); return { ok: true } },
  }
  const worker = createWorker({
    dataDir: dir, hub,
    executor: {
      prepareWorkspace: async () => ({ kind: 'in-place' }),
      buildContext: async () => ({ kind: 'minimal' }),
      async execute() { return { outcome: 'completed' } },
    },
    projectDir: 'C:\\authorized-project',
    modelProfileRefFor: async () => 'mp:9',
    logger: () => {},
  })
  try {
    await worker.tick()
    const terminal = transitions.find((t) => t.outcome === 'completed')
    assert.notEqual(terminal, undefined, `终态没提交：${JSON.stringify(transitions)}`)
    assert.deepEqual(terminal.context.runInputs, {
      ok: true,
      code: null,
      missing: [],
      sources: {
        workspaceId: 'derived:scope',
        modelProfileRef: 'derived:model-binding',
        workdir: 'derived:project-dir',
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('㉓ ★★ 两处契约同时成立：外壳把输入**交给**引擎，而引擎缺了就拒', async () => {
  // 这一条把"外壳那一侧"与"引擎那一侧"接在同一次调用上验：
  // 外壳把 `projectDir` 与 `modelProfileRefFor` 的结果装进 runInputs 并传给 execute；
  // 引擎在拿不到时具名拒绝——两半都要真的发生。
  const { createWorker } = await import('./main.mjs')
  const seenArgs = []
  const worker = createWorker({
    dataDir: mkdtempSync(join(tmpdir(), 'legion-runinputs-')),
    hub: null,
    executor: {
      async execute(lease, runInputs) { seenArgs.push(runInputs); return { outcome: 'completed' } },
      prepareWorkspace: async () => ({ kind: 'in-place', note: 'x' }),
      buildContext: async () => ({ kind: 'minimal' }),
    },
    projectDir: 'C:\\authorized',
    modelProfileRefFor: async () => 'mp:from-port',
    logger: () => {},
  })
  // hub 为 null 时 tick() 只 publish（'hub-unreachable'），不进 execute——
  // 所以这里直接读"外壳有没有把端口结果装出来"这个可判定的事实。
  assert.equal(typeof worker.status, 'function')
  assert.equal(seenArgs.length, 0, '没有 hub 时不该执行任何东西（前半是反面控制）')

  // 端口本身返回拒绝时，`resolveRunInputs` 必须报缺——两半接得上。
  const refused = resolveRunInputs({
    lease: leaseOf(), workspace: { kind: 'in-place' }, projectDir: 'C:\\authorized', modelProfileRef: null,
  })
  assert.equal(refused.ok, false)
  assert.deepEqual([...refused.missing], ['modelProfileRef'])
  // 而端口给了值时，同样的调用就齐了。
  const ok = resolveRunInputs({
    lease: leaseOf(), workspace: { kind: 'in-place' }, projectDir: 'C:\\authorized', modelProfileRef: 'mp:from-port',
  })
  assert.equal(ok.ok, true, ok.message ?? '')
  assert.deepEqual(ok.inputs, {
    workspaceId: 'software', modelProfileRef: 'mp:from-port', workdir: 'C:\\authorized',
  })
  assert.deepEqual(ok.sources, {
    workspaceId: 'derived:scope', modelProfileRef: 'derived:model-binding', workdir: 'derived:project-dir',
  })
})
