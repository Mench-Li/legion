// F-23 判据：配置表可改、判定立刻生效、来源如实、指名不在册不回落、默认不可摘/不可悬空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHarnessRoutes } from './harness.mjs'
import { createHarnessStore, DEFAULT_HARNESS_NAME } from '../harness-store.mjs'
import { ROUTE_SOURCES, ROUTE_REJECT } from '../../runtime/contracts/harness-routing.mjs'

function mk() {
  const store = createHarnessStore({ db: new DatabaseSync(':memory:') })
  const calls = []
  const responses = []
  let body
  const handleWrite = async (_q, _s, cb) => {
    try { calls.push({ ok: true, value: await cb(body, 'tester', 'default') }) }
    catch (e) { calls.push({ ok: false, message: String(e.message) }) }
  }
  const routes = createHarnessRoutes({ json: (_res, status, value) => responses.push({ status, value }), handleWrite, harnessStore: store })
  const hit = async (path, b, method = 'POST') => { body = b; return routes.dispatch({ method, url: `http://x${path}` }, {}, { path: path.split('?')[0] }) }
  return { store, routes, calls, responses, hit }
}
const CODEX = { name: 'codex', kind: 'codex', command: 'codex', args: ['exec'], permission: 'reject' }

test('F-23 缺注入项 ⇒ 当场抛', () => {
  assert.throws(() => createHarnessRoutes({ json: () => {}, handleWrite: async () => {} }), /createHarnessRoutes 缺注入项：harnessStore/)
})

test('Agent 节点身份独立登记；心跳报告真实 provider/能力，未知、离线与在线状态分开', () => {
  const { store } = mk()
  const config = store.putAgentNodeConfig({ id: 'workstation-a', label: '本机 DSH', scope: 'default' })
  assert.equal(config.version, 1)
  assert.equal(config.status, 'unknown')
  assert.equal(store.listAgentNodeConfigs({ scope: 'default', nowMs: 50_000 })[0].status, 'unknown')
  const heartbeat = store.heartbeatAgentNode({
    id: 'workstation-a', version: 1, scope: 'default', providerNames: ['codex', 'deepseek'],
    capabilities: {
      isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
      providers: { codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me', systemProxyMode: 'system' } },
    }, nowMs: 50_000,
  })
  assert.equal(heartbeat.status, 'ready')
  assert.deepEqual(heartbeat.observedProviders, ['codex', 'deepseek'])
  assert.equal(heartbeat.observedCapabilities.providers.codex.systemProxyMode, 'system')
  assert.equal(store.listAgentNodeConfigs({ scope: 'default', nowMs: 111_001 })[0].status, 'offline')
  const revised = store.putAgentNodeConfig({ id: 'workstation-a', label: '本机 DSH', scope: 'default' })
  assert.equal(revised.version, 2)
  assert.equal(store.listAgentNodeConfigs({ scope: 'default', nowMs: 50_001 })[0].status, 'offline', '旧版节点心跳不得冒充新配置在线')
  assert.throws(() => store.heartbeatAgentNode({
    id: 'workstation-a', version: 1, scope: 'default', providerNames: ['codex'],
    capabilities: { isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true },
  }), /配置不存在/)
})

test('Agent 节点路由可创建配置并接收心跳；配置读面按空间隔离', async () => {
  const s = mk()
  await s.hit('/api/agent-nodes/configs', { id: 'node-a', label: 'DSH workstation', scope: 'default' })
  assert.equal(s.calls[0].ok, true)
  assert.equal(s.calls[0].value.version, 1)
  await s.hit('/api/agent-nodes/heartbeat', {
    id: 'node-a', providerNames: ['codex'],
    capabilities: { isolatedWorktree: true, externalAgent: true, structuredOutput: false, toolFilter: false, cancellation: true },
  })
  assert.equal(s.calls[1].ok, true)
  assert.equal(s.calls[1].value.status, 'ready')
})

test('命名工作流定义独立于空间阶段配置，按 scope/id/version 不可变保存并可读回', async () => {
  const s = mk()
  const caps = { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true }
  for (const [id, providerName, adapter, permissionProfile] of [['tool.claude', 'claude-code', 'dsh-subagent', 'claude-code-acceptEdits'], ['tool.dsh', 'deepseek', 'dsh-native', 'native'], ['tool.codex', 'codex', 'dsh-subagent', 'codex-workspace-write']]) {
    s.store.putAgentToolConfig({ id, version: 1, providerName, adapter, permissionProfile, workspacePolicy: 'attempt-worktree', capabilities: caps })
  }
  const workflow = {
    id: 'design-code-review', version: 1, name: '设计-实现-审查', description: '跨 Agent 标准闭环',
    stages: [
      { id: 'design', role: 'designer', agentToolConfig: { id: 'tool.claude', version: 1 }, outputContract: { artifacts: ['design.md'] } },
      { id: 'implement', role: 'coder', agentToolConfig: { id: 'tool.dsh', version: 1 }, inputContract: { artifacts: ['design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] }, testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
      { id: 'review', role: 'reviewer', agentToolConfig: { id: 'tool.codex', version: 1 }, inputContract: { artifacts: ['design.md', 'commit', 'test-evidence'] } },
    ],
    edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 3,
  }
  await s.hit('/api/agent-workflows/definitions', { definition: workflow })
  assert.equal(s.calls[0].ok, true)
  assert.equal(s.calls[0].value.idempotent, false)
  await s.hit('/api/agent-workflows/definitions', { definition: workflow })
  assert.equal(s.calls[1].value.idempotent, true)
  await s.hit('/api/agent-workflows/definitions', { definition: { ...workflow, name: '改写同版本' } })
  assert.equal(s.calls[2].ok, false)
  assert.match(s.calls[2].message, /版本不可变/)
  await s.hit('/api/agent-workflows/definitions', { definition: { ...workflow, id: 'missing-tool', version: 1,
    stages: workflow.stages.map((item, index) => index === 0 ? { ...item, agentToolConfig: { id: 'tool.missing', version: 1 } } : item) } })
  assert.equal(s.calls[3].ok, false)
  assert.match(s.calls[3].message, /工具配置不存在/)

  await s.hit('/api/agent-workflows/definitions?scope=default', {}, 'GET')
  assert.equal(s.responses.at(-1).value.definitions.length, 1)
  await s.hit('/api/agent-workflows/definitions?scope=default&id=design-code-review&version=1', {}, 'GET')
  assert.equal(s.responses.at(-1).status, 200)
  assert.deepEqual(s.responses.at(-1).value.definition.edges, workflow.edges)
  assert.equal(s.store.getAgentWorkflowDefinition({ scope: 'other', id: workflow.id, version: 1 }), null)
})

test('★ F-23 默认表：只有 DeepSeek Harness 一行，且标记 protected；不指定就走它', async () => {
  const s = mk()
  assert.deepEqual(s.store.routerConfig().providers, [DEFAULT_HARNESS_NAME])
  assert.equal(s.store.listProviders().length, 1)
  assert.equal(s.store.listProviders()[0].protected, true)
  await s.hit('/api/harness/resolve', {})
  assert.equal(s.calls[0].value.provider, DEFAULT_HARNESS_NAME)
  assert.equal(s.calls[0].value.source, ROUTE_SOURCES.DEFAULT)
})

test('★ F-23 配置表为权威：落一行 codex，改任务类型规则 ⇒ 判定立刻按表（不必重启）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/resolve', { taskType: 'code-review', suggested: 'claude-code' })
  assert.equal(s.calls[2].value.provider, 'codex', '表命中压过建议')
  assert.equal(s.calls[2].value.source, ROUTE_SOURCES.TABLE)
  // ★ 表是**现读**的：改掉它，下一次判定立刻变
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: DEFAULT_HARNESS_NAME })
  await s.hit('/api/harness/resolve', { taskType: 'code-review' })
  assert.equal(s.calls[4].value.provider, DEFAULT_HARNESS_NAME)
})

test('★ F-23 单次指定压过表；指名不在册 ⇒ 具名拒绝（且不回落默认）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/resolve', { taskType: 'code-review', requested: DEFAULT_HARNESS_NAME })
  assert.equal(s.calls[2].value.source, ROUTE_SOURCES.EXPLICIT)
  assert.equal(s.calls[2].value.provider, DEFAULT_HARNESS_NAME)
  await s.hit('/api/harness/resolve', { taskType: 'code-review', requested: 'gemini' })
  assert.equal(s.calls[3].ok, false)
  assert.match(s.calls[3].message, new RegExp(ROUTE_REJECT.UNKNOWN_PROVIDER))
})

test('★ F-23 默认 provider 不可摘除：摘它报 protected-default 且仍在册', async () => {
  const s = mk()
  await s.hit('/api/harness/providers/remove', { name: DEFAULT_HARNESS_NAME })
  assert.equal(s.calls[0].value.removed, 0)
  assert.equal(s.calls[0].value.reason, 'protected-default')
  assert.equal(s.store.routerConfig().providers.includes(DEFAULT_HARNESS_NAME), true)
  await s.hit('/api/harness/resolve', {})
  assert.equal(s.calls[1].value.provider, DEFAULT_HARNESS_NAME)
})

test('★ F-23 被规则指着的 provider 不许摘（别让配置表悬空）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/providers/remove', { name: 'codex' })
  assert.equal(s.calls[2].value.reason, 'in-use')
  assert.deepEqual(s.calls[2].value.taskTypes, ['code-review'])
  await s.hit('/api/harness/rules/remove', { taskType: 'code-review' })
  assert.equal(s.calls[3].value.removed, 1)
  await s.hit('/api/harness/providers/remove', { name: 'codex' })
  assert.equal(s.calls[4].value.removed, 1, '规则摘掉后才允许摘 provider')
})

test('★ F-23 规则指向不在册 ⇒ 写入当场拒（别等派工时才发现）', async () => {
  const s = mk()
  await s.hit('/api/harness/rules', { taskType: 'x', provider: 'gemini' })
  assert.equal(s.calls[0].ok, false)
  assert.match(s.calls[0].message, /规则指向不在册的 provider/)
  assert.equal(s.store.listRules().length, 0)
})

test('F-23 停用一行 = 从在册清单里消失（但规则会因此指向不存在 ⇒ 拒绝写入，先配套）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', { ...CODEX, enabled: false })
  assert.equal(s.store.routerConfig().providers.includes('codex'), false, '停用的不在册')
  await s.hit('/api/harness/rules', { taskType: 'x', provider: 'codex' })
  assert.equal(s.calls[1].ok, false, '停用的 provider 不能被规则指')
})

test('F-23 provider 字段校验：permission 只有 reject/allow；args 必须是数组；env 必须是对象', async () => {
  const s = mk()
  for (const [b, re] of [[{ ...CODEX, permission: 'maybe' }, /permission/], [{ ...CODEX, args: 'x' }, /args/], [{ ...CODEX, env: [] }, /env/], [{ command: 'x' }, /缺少参数 name/]]) {
    s.calls.length = 0
    await s.hit('/api/harness/providers', b)
    assert.equal(s.calls[0].ok, false, JSON.stringify(b))
    assert.match(s.calls[0].message, re)
  }
})

test('Agent 工具配置按 id+version 保存完整执行能力，配置版本不可被覆盖', async () => {
  const s = mk()
  const config = {
    id: 'tool.codex', version: 1, providerName: 'codex', adapter: 'dsh-subagent',
    permissionProfile: 'codex-workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
  }
  await s.hit('/api/agent-tools/configs', config)
  assert.equal(s.calls[0].ok, true)
  assert.equal(s.store.getAgentToolConfig({ id: config.id, version: 1 }).providerName, 'codex')
  await s.hit('/api/agent-tools/configs', config)
  assert.equal(s.calls[1].value.idempotent, true, '同一不可变版本允许幂等写入')
  await s.hit('/api/agent-tools/configs', { ...config, providerName: 'claude-code', permissionProfile: 'claude-code-acceptEdits' })
  assert.equal(s.calls[2].ok, false, '同版本不能改指向另一个 provider')
  assert.match(s.calls[2].message, /不可变/)
  assert.equal(s.store.getAgentToolConfig({ id: config.id, version: 1 }).providerName, 'codex')
})

test('Agent 工具配置拒绝不完整能力与悬空 version', async () => {
  const s = mk()
  await s.hit('/api/agent-tools/configs', { id: 'tool.codex', version: 0, providerName: 'codex' })
  assert.equal(s.calls[0].ok, false)
  await s.hit('/api/agent-tools/configs', {
    id: 'tool.codex', version: 1, providerName: 'codex', permissionProfile: 'default',
    workspacePolicy: 'attempt-worktree-parent-cwd', capabilities: { outputSchema: 'yes' },
  })
  assert.equal(s.calls[1].ok, false)
  assert.equal(s.store.getAgentToolConfig({ id: 'tool.codex', version: 1 }), null)
})

test('DSH 外部工具配置拒绝含糊的默认档和危险权限档', () => {
  const { store } = mk()
  const caps = { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true }
  for (const permissionProfile of ['codex-native-default', 'dangerously-bypass-approvals-and-sandbox']) {
    assert.throws(() => store.putAgentToolConfig({
      id: `tool.codex.${permissionProfile}`, version: 1, providerName: 'codex', adapter: 'dsh-subagent',
      permissionProfile, workspacePolicy: 'attempt-worktree-parent-cwd', capabilities: caps,
    }), /permissionProfile 未映射到受支持的原生权限模式/)
  }
})

test('★★ F-23 来源如实记账：每条判定都入账，source 记的是**实际**来源（default/table/explicit/suggested）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/resolve', {})                                  // default
  await s.hit('/api/harness/resolve', { taskType: 'code-review' })         // table
  await s.hit('/api/harness/resolve', { requested: DEFAULT_HARNESS_NAME }) // explicit
  await s.hit('/api/harness/resolve', { suggested: 'codex' })              // suggested
  const d = s.store.listDecisions()
  assert.equal(d.length, 4)
  assert.deepEqual(d.map((x) => x.source).sort(), ['default', 'explicit', 'suggested', 'table'])
  assert.equal(d.every((x) => x.accepted === true), true)
  assert.equal(d.every((x) => x.provider !== null), true)
})

test('★★ F-23 **被拒的判定也入账**（记 reason、记 accepted=0、provider 为空）——"这次为什么没派出去"有据可查', async () => {
  const s = mk()
  await s.hit('/api/harness/resolve', { requested: 'gemini' })
  assert.equal(s.calls[0].ok, false)
  const d = s.store.listDecisions()
  assert.equal(d.length, 1, '被拒也必须留下一条')
  assert.equal(d[0].accepted, false)
  assert.equal(d[0].provider, null)
  assert.equal(d[0].source, ROUTE_REJECT.UNKNOWN_PROVIDER, '记的是**具名理由**，不是"失败"两个字')
  assert.equal(d[0].requested, 'gemini')
  assert.equal(s.store.countDecisions(), 1)
})

test('F-23 台账**只记流水、不替代判定**：清不掉的账不妨碍下一次判定；查询按时间倒序', async () => {
  const s = mk()
  await s.hit('/api/harness/resolve', {})
  await s.hit('/api/harness/resolve', { requested: DEFAULT_HARNESS_NAME })
  const d = s.store.listDecisions({ limit: 1 })
  assert.equal(d.length, 1)
  assert.equal(d[0].source, ROUTE_SOURCES.EXPLICIT, '倒序：最新那条在前')
  await s.hit('/api/harness/resolve', { taskType: '任意' })
  assert.equal(s.calls[2].value.provider, DEFAULT_HARNESS_NAME, '台账变化不影响判定结果')
})

test('★★ F-23 建任务前的判定(routeForTask)：不指名⇒按表/默认，且必记流水', () => {
  const store = createHarnessStore({ db: new DatabaseSync(':memory:') })
  store.upsertProvider(CODEX)
  store.setRule({ taskType: 'coder', provider: 'codex' })
  const a = store.routeForTask({ taskType: 'coder' })
  assert.equal(a.ok, true); assert.equal(a.provider, 'codex'); assert.equal(a.source, ROUTE_SOURCES.TABLE)
  const b = store.routeForTask({ taskType: 'tester' })
  assert.equal(b.provider, DEFAULT_HARNESS_NAME)
  assert.equal(b.source, ROUTE_SOURCES.DEFAULT)
  assert.equal(store.countDecisions(), 2, '判定必记流水')
})

test('★★ F-23 建任务前指名不在册 ⇒ 拒（这是「指定」有后果的地方），被拒也留流水', () => {
  const store = createHarnessStore({ db: new DatabaseSync(':memory:') })
  const out = store.routeForTask({ taskType: 'coder', requested: 'gemini' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, ROUTE_REJECT.UNKNOWN_PROVIDER)
  assert.equal(store.listDecisions()[0].source, ROUTE_REJECT.UNKNOWN_PROVIDER)
  assert.equal(store.listDecisions()[0].accepted, false)
})

test('★★ F-23 裁决里的"1 兜底"：表没命中才轮到建议，命中时建议不插手；建议也必须在册', () => {
  const store = createHarnessStore({ db: new DatabaseSync(':memory:') })
  store.upsertProvider(CODEX)
  // 表没命中 ⇒ 建议生效，来源如实记 suggested
  const a = store.routeForTask({ taskType: '未登记的活儿', suggested: 'codex' })
  assert.equal(a.ok, true); assert.equal(a.provider, 'codex'); assert.equal(a.source, ROUTE_SOURCES.SUGGESTED)
  // 表命中 ⇒ 建议不插手（"表是权威"这句在建议同时存在时也必须是真的）
  store.setRule({ taskType: 'coder', provider: DEFAULT_HARNESS_NAME })
  const b = store.routeForTask({ taskType: 'coder', suggested: 'codex' })
  assert.equal(b.provider, DEFAULT_HARNESS_NAME); assert.equal(b.source, ROUTE_SOURCES.TABLE)
  // 建议不在册 ⇒ 具名拒绝（不回落默认）
  const c = store.routeForTask({ taskType: '未登记的活儿', suggested: 'gemini' })
  assert.equal(c.ok, false); assert.equal(c.reason, ROUTE_REJECT.UNKNOWN_PROVIDER)
  // 三条都留了流水，且 suggested 也记下来了
  const d = store.listDecisions()
  assert.equal(d.length, 3)
  assert.equal(d.find((x) => x.source === ROUTE_SOURCES.SUGGESTED).suggested, 'codex')
})

test('F-23 本族只认自己那几条路', async () => {
  const s = mk()
  assert.equal(await s.hit('/api/tasks', {}), false)
  assert.equal(await s.hit('/api/harness/resolve', {}, 'GET'), false)
  assert.equal(await s.hit('/api/harness/decisions', {}, 'POST'), false)
  assert.equal(s.routes.id, 'harness')
  assert.equal(s.routes.routes.length, 15)
})
