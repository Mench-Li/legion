// ============================================================================
// 目标级执行节点绑定（2026-10-13）
//
// 背景（用户诉求）：「任务创建后，自动扫描，再推用户确认使用哪个节点」
//
// 落在**目标发布**这一步，因为认领路径明写同一目标的链上出现两个节点 ⇒
// 409 AGENT_NODE_WORKSPACE_MISMATCH（「跨节点 workspace/Git 交接尚未实现」）
// ⇒ 一条链只能落在一台机器上 ⇒ 这个选择天然是**每个目标一次**。
//
// ★★★ 本文件最要紧的一条是**①默认不绑定**：
//     绑定是硬绑定（认领方必须带同一个 agentNodeId），而实测本机守护的 agentNodeId 是空的。
//     一旦默认绑定，今天能跑的流水线会**当场全停**。
// ============================================================================
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-goal-node-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const READY_CAPS = {
  isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
  providers: { spawn: { outputSchema: true, toolFilter: true, cancellation: true } },
}

/** 建一个空间 + 编队 + 阶段链（不配跨 Agent 工作流 —— 那才是默认部署的形状）。 */
async function makeSpace(scope, withWorkflow = false) {
  const space = await post('/api/spaces', { id: scope, name: scope, localDir: process.cwd(), by: 'general' })
  assert.equal(space.status, 200, '建空间失败：' + JSON.stringify(space.body))
  const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  const roles = ['designer', 'coder', 'reviewer']
  roles.forEach((role, i) => ins.run(scope, role, role, 'agent', '🤖', i))
  const stages = roles.map((role, i) => ({
    role, label: role, prompt: role, next: roles[i + 1] ?? null, agentToolConfig: null,
  }))
  // ★ 先登记节点，再存流水线：工作流的 nodeId 校验需要节点已存在。
  if (withWorkflow) await registerNode(scope, 'node-a')
  if (withWorkflow) {
    const tool = await post('/api/agent-tools/configs', {
      by: 'general', id: 'workflow.designer', version: 1, providerName: 'spawn', adapter: 'dsh-native',
      permissionProfile: 'dsh-native:spawn', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
    })
    assert.equal(tool.status, 200, '登记工具配置失败：' + JSON.stringify(tool.body))
    const workflow = {
      designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2,
      stageTools: Object.fromEntries(roles.map((role) => [role, {
        agentToolConfig: { id: 'workflow.designer', version: 1 }, modelConfig: null, nodeId: 'node-a',
        ...(role === 'coder' ? { testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } } : {}),
      }])),
    }
    const saved = await post('/api/pipeline', { scope, by: 'general', stages, workflow })
    // ★ 这条断言是必须的：第一版我**没有**断言它，于是流水线存失败（400）被静默吞掉，
    //   后面两条"跨节点"用例红在一个完全不相干的地方（响应里 workflowDefinition:null）。
    assert.equal(saved.status, 200, '存流水线（含工作流）失败：' + JSON.stringify(saved.body))
  } else {
    const saved = await post('/api/pipeline', { scope, by: 'general', stages, workflow: null })
    assert.equal(saved.status, 200, '存流水线失败：' + JSON.stringify(saved.body))
  }
}

/** 登记一个节点并让它就绪（心跳）。 */
async function registerNode(scope, id, { heartbeat = true } = {}) {
  await post('/api/agent-nodes/configs', { id, label: `节点 ${id}`, scope, by: 'general' })
  if (heartbeat) {
    await post('/api/agent-nodes/heartbeat', { id, scope, by: 'general', providerNames: ['spawn'], capabilities: READY_CAPS })
  }
}

const tasksOf = (goalId) => mod.db.prepare('SELECT * FROM tasks WHERE goalId=? ORDER BY rowid').all(goalId)
const goalRow = (goalId) => mod.db.prepare('SELECT * FROM goal WHERE id=?').get(goalId)

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ ① 默认：不绑定 ══════════════════════

test('★★★ 不给 agentNodeId ⇒ 不绑定，且任务快照**与今天完全一致**（null）', async () => {
  const scope = 'sp-default'
  await makeSpace(scope)

  const r = await post('/api/goal', { scope, by: 'general', objective: '默认不绑定' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const goalId = r.body.task.goal.id

  assert.equal(goalRow(goalId).agentNodeId ?? null, null, '库里必须是 NULL —— 不是空串')
  const tasks = tasksOf(goalId)
  assert.ok(tasks.length > 0, '应当建出链')
  for (const t of tasks) {
    assert.equal(t.agent_selection_snapshot, null,
      '没配工作流、也没绑节点 ⇒ 快照必须是 null（默认部署的语义一点都不能变）')
  }
})

test('★ goal 读回时带 agentNodeId（null 时也是显式 null，不是 undefined）', async () => {
  const scope = 'sp-default-read'
  await makeSpace(scope)
  const r = await post('/api/goal', { scope, by: 'general', objective: '读回' })
  const goalId = r.body.task.goal.id
  const read = await get('/api/goal?scope=' + scope)
  assert.equal(read.status, 200)
  const list = Array.isArray(read.body) ? read.body : (read.body.goals ?? [])
  const mine = list.find((g) => g.id === goalId)
  assert.ok(mine, '目标应当能读回：' + JSON.stringify(read.body).slice(0, 200))
  assert.ok('agentNodeId' in mine, '读模型里必须有这个字段')
  assert.equal(mine.agentNodeId, null)
})

// ══════════════════════ ② 绑定的正常路径 ══════════════════════

test('★★ 给了就绪节点 ⇒ goal 存下，且**链上每个任务**都钉在它上面', async () => {
  const scope = 'sp-bind'
  await makeSpace(scope)
  await registerNode(scope, 'node-a')

  const r = await post('/api/goal', { scope, by: 'general', objective: '绑定 node-a', agentNodeId: 'node-a' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const goalId = r.body.task.goal.id
  assert.equal(goalRow(goalId).agentNodeId, 'node-a')

  const tasks = tasksOf(goalId)
  assert.ok(tasks.length >= 2, '应当建出多阶段链')
  for (const t of tasks) {
    const snap = JSON.parse(t.agent_selection_snapshot)
    assert.equal(snap.source, 'goal-node-binding',
      '要用独立 source —— 不冒充 goal-agent-workflow（读的人要能一眼看出"没冻结工作流，只是钉了一台机器"）')
    assert.equal(snap.executionNode.id, 'node-a')
    assert.equal(snap.executionNode.label, '节点 node-a', '标签也冻进去（任务上要能显示用哪台）')
    // 形状与认领时写回的 claimedNodeSnapshot 一致
    assert.ok(Array.isArray(snap.executionNode.providers))
    assert.ok('capabilities' in snap.executionNode)
  }
})

test('★★ 空白 / 非字符串 agentNodeId 一律当"不绑定"（不写空串进库）', async () => {
  const scope = 'sp-blank'
  await makeSpace(scope)
  for (const v of ['', '   ', 123, null, {}, []]) {
    const r = await post('/api/goal', { scope, by: 'general', objective: `空白 ${JSON.stringify(v)}`, agentNodeId: v })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(goalRow(r.body.task.goal.id).agentNodeId ?? null, null, `${JSON.stringify(v)} 应当是不绑定`)
  }
})

// ══════════════════════ ③ 发布即拒（不是存下来等认领才失败）══════════════════════

test('★★ 未登记的节点 ⇒ 发布即拒（AGENT_NODE_NOT_REGISTERED），且**不留目标**', async () => {
  const scope = 'sp-unregistered'
  await makeSpace(scope)
  const before = mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n
  const r = await post('/api/goal', { scope, by: 'general', objective: '未登记', agentNodeId: 'nope' })
  assert.notEqual(r.status, 200, '未登记的节点不该发布成功')
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n, before,
    '失败必须回滚，不留下半个目标')
})

test('★★ 登记了但没就绪 ⇒ 发布即拒（AGENT_NODE_NOT_READY）', async () => {
  const scope = 'sp-notready'
  await makeSpace(scope)
  await registerNode(scope, 'node-a', { heartbeat: false })   // 登记但不心跳 ⇒ offline
  const r = await post('/api/goal', { scope, by: 'general', objective: '未就绪', agentNodeId: 'node-a' })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.match(JSON.stringify(r.body), /not_ready|未就绪|NOT_READY/i)
})

// ══════════════════════ ④ 跨节点：发布时说清 ══════════════════════

test('★★ 用户选的节点与工作流阶段绑的不同 ⇒ 发布即报，且**两个节点名都在**', async () => {
  const scope = 'sp-cross'
  await makeSpace(scope, true)                       // 工作流三阶段都绑 node-a
  await registerNode(scope, 'node-a')
  await registerNode(scope, 'node-b')

  const r = await post('/api/goal', { scope, by: 'general', objective: '跨节点', agentNodeId: 'node-b' })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  const text = JSON.stringify(r.body)
  assert.match(text, /node-b/, '要说清用户选的是什么')
  assert.match(text, /node-a/, '也要说清工作流绑的是什么')
  assert.match(text, /尚未实现/, '要说清真实原因（不是含糊的"冲突"）')
})

test('★ 选的与工作流一致 ⇒ 放行，且快照仍用工作流那个 source（不冒充）', async () => {
  const scope = 'sp-agree'
  await makeSpace(scope, true)
  await registerNode(scope, 'node-a')

  const r = await post('/api/goal', { scope, by: 'general', objective: '一致', agentNodeId: 'node-a' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const tasks = tasksOf(r.body.task.goal.id)
  for (const t of tasks) {
    const snap = JSON.parse(t.agent_selection_snapshot)
    assert.equal(snap.source, 'goal-agent-workflow', '有工作流时仍是工作流快照')
    assert.equal(snap.executionNode.id, 'node-a')
  }
})

test('★ 具名工作流自己就绑了两个节点 ⇒ 发布即报（与用户选什么无关）', async () => {
  // ★★ 为什么这条必须用**具名定义**而不是空间级工作流（查证过的区别）：
  //   · 空间级工作流：保存路径**已经**拒绝跨节点（server.mjs:2255「必须全部自动选节点，
  //     或全部绑定到同一节点」）⇒ 那里我那道检查只是纵深防御，走不到；
  //   · **具名工作流定义**：契约（runtime/contracts/agent-workflow-definition.mjs）只校验
  //     `nodeId` 的**格式**，**没有任何跨阶段同节点校验** ⇒ 这条路真的能存进一条跨节点定义，
  //     于是发布时那道检查是**唯一**的防线。
  const scope = 'sp-internal'
  await makeSpace(scope, true)
  await registerNode(scope, 'node-a')
  await registerNode(scope, 'node-b')

  const definition = {
    id: 'workflow.cross-node', version: 1, name: '跨节点定义', description: '两阶段绑到两台机器',
    stages: [
      { id: 'design', role: 'designer', agentToolConfig: { id: 'workflow.designer', version: 1 }, nodeId: 'node-a', outputContract: { artifacts: ['design.md'] } },
      { id: 'implement', role: 'coder', agentToolConfig: { id: 'workflow.designer', version: 1 }, nodeId: 'node-b', inputContract: { artifacts: ['design.md'] }, testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
    ],
    edges: [{ from: 'design', to: 'implement' }],
    entryStageIds: ['design'], terminalStageIds: ['implement'], reviewStageId: 'implement',
    reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 1,
  }
  const registered = await post('/api/agent-workflows/definitions', { scope, definition, by: 'general' })
  assert.equal(registered.status, 200, '登记具名定义失败：' + JSON.stringify(registered.body))
  // 前置条件自检：确认它**真的**存进去了两个节点
  const stored = (await get(`/api/agent-workflows/definitions?scope=${scope}&id=workflow.cross-node&version=1`)).body
  const nodeIds = [...new Set((stored.definition?.stages ?? stored.stages ?? []).map((s) => s.nodeId))]
  assert.deepEqual(nodeIds.sort(), ['node-a', 'node-b'], '前置条件：定义里确实有两个节点，实际 ' + JSON.stringify(nodeIds))

  const r = await post('/api/goal', {
    scope, by: 'general', objective: '定义内部跨节点',
    workflowDefinition: { id: 'workflow.cross-node', version: 1 },
  })
  assert.equal(r.status, 409, '跨节点定义必须发布即拒：' + JSON.stringify(r.body))
  assert.match(JSON.stringify(r.body), /node-a/)
  assert.match(JSON.stringify(r.body), /node-b/)
})

// ══════════════════════ ⑤ 绑定的真正后果：认领 ══════════════════════

test('★★★ 绑了节点之后：认领**必须**带同一个 agentNodeId，否则 409；带上才领得走', async () => {
  const scope = 'sp-claim'
  await makeSpace(scope)
  await registerNode(scope, 'node-a')

  const published = await post('/api/goal', { scope, by: 'general', objective: '认领', agentNodeId: 'node-a' })
  const goalId = published.body.task.goal.id
  const first = tasksOf(goalId)[0]

  // 不带 agentNodeId（= 守护没配）⇒ 领不走。这正是"绑定是硬绑定"的含义，也是默认必须不绑定的原因。
  const withoutNode = await post('/api/claim', { id: first.id, soldier: 'coder', by: 'general', scope })
  assert.equal(withoutNode.status, 409, '不配 agentNodeId 的守护必须领不走：' + JSON.stringify(withoutNode.body))
  assert.match(JSON.stringify(withoutNode.body), /MISMATCH|不匹配|绑定执行节点/i)

  // 带错节点 ⇒ 也领不走
  const wrongNode = await post('/api/claim', { id: first.id, soldier: 'coder', by: 'general', scope, agentNodeId: 'node-b' })
  assert.equal(wrongNode.status, 409)

  // 带对节点 ⇒ 领走
  const right = await post('/api/claim', { id: first.id, soldier: 'coder', by: 'general', scope, agentNodeId: 'node-a' })
  assert.equal(right.status, 200, JSON.stringify(right.body))
})

test('★★ 不绑定时：没配 agentNodeId 的守护**照常**领得走（今天的行为一点没变）', async () => {
  const scope = 'sp-claim-default'
  await makeSpace(scope)
  const published = await post('/api/goal', { scope, by: 'general', objective: '默认认领' })
  const first = tasksOf(published.body.task.goal.id)[0]
  // 上一条用例认领成功后，那个任务按"未规划范围"占住了**整个仓库**，
  // 于是这一条会撞 FILE_CONTENTION —— 那是**测试之间的耦合**，不是本用例要验的东西。
  // 清掉占用状态（测试库），让这条只验"默认路径能不能领"。
  for (const table of ['write_reservations', 'task_write_intents']) {
    try { mod.db.prepare(`DELETE FROM ${table}`).run() } catch { /* 表可能不存在 */ }
  }
  const r = await post('/api/claim', { id: first.id, soldier: 'coder', by: 'general', scope })
  assert.equal(r.status, 200, '默认路径必须与今天完全一致：' + JSON.stringify(r.body))
})
