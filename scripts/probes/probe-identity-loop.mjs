// scripts/probes/probe-identity-loop.mjs  (只读探针，可删)
// PRT-214 缺口②：把「租约 → RunRequest → 适配器 → 端口 → Agent」整条链在一个进程里跑通。
// 每一步都用**生产代码**，不造替身——除了最外面那个 host 端口（它是引擎，进程外）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const R = pathToFileURL('D:/project/DSH/legion/').href

const { resolveRunInputs } = await import(R + 'orchestrator/worker/run-inputs.mjs')
const { defaultRequestFor, deriveRunIdentityCarrier } = await import(R + 'orchestrator/worker/executor.mjs')
const { readRunIdentity } = await import(R + 'runtime/contracts/run-identity.mjs')
const { createRunIdentityInstallation, installRunIdentityIntoAgent, identityOverlayForExecution } =
  await import(R + 'runtime/dsh-composition/run-identity.mjs')
const { createEnforcementBridge } = await import(R + 'runtime/dsh-composition/tool-request.mjs')

const PROC = Object.freeze({
  scope: 'legion', actor: 'owner:11150', action: 'employee-run', taskId: null,
  cwd: 'D:/project/DSH/legion', platform: 'win32',
})

// ── ① worker：租约 → 三个运行输入 → RunRequest ──────────────────────────────
const lease = { attemptId: 'a1', taskId: 'T-9', scope: 'gf001', leaseEpoch: 1, workerId: 'w' }
const inputs = resolveRunInputs({
  lease, workspace: { kind: 'worktree', slotDir: 'D:/project/DSH/gf001-scratch' },
  modelProfileRef: 'mp:primary',
})
console.log('① runInputs.ok =', inputs.ok, JSON.stringify(inputs.inputs))
const snapshot = {
  finalText: '冻结正文',
  associations: { goalId: 'G-1', taskId: 'T-1', employeeId: 'emp:T-1/coder', teamPlanId: 'tp:1' },
  modelProfileRef: inputs.inputs.modelProfileRef,
  expectedOutput: { schema: { type: 'object' }, acceptance: 'ok' },
  permissions: { preset: 'restricted', tools: ['read-file'] },
}
const req = defaultRequestFor(lease, snapshot, inputs)
console.log('① RunRequest.workspaceId =', req.workspaceId, '| workdir =', req.workdir)

// ── ② executor：RunRequest → 身份载荷 ──────────────────────────────────────
const carried = deriveRunIdentityCarrier(req)
console.log('② state =', carried.state, '| payload =', JSON.stringify(carried.payload))

// ── ③ 适配器那一跳：线上载荷 → 端口载荷（模拟 index.mjs 的那三行） ───────────
const reading = readRunIdentity(carried.request.enforcementIdentity)
const portPayload = reading.state === 'installed'
  ? { state: 'installed', identity: reading.overlay }
  : { state: 'absent' }
console.log('③ portPayload =', JSON.stringify(portPayload))

// ── ④ 宿主端口：装到那个 Agent 上（不新增任何判定点） ────────────────────────
const agent = { id: 'child-1', options: {} }   // 引擎交回的 in-process 子 Agent
installRunIdentityIntoAgent({ agent, installation: createRunIdentityInstallation(portPayload) })
console.log('④ overlay =', JSON.stringify(identityOverlayForExecution({ agent })))

// ── ⑤ 桥：这次调用被记在**哪个空间**名下 ────────────────────────────────────
const bridge = createEnforcementBridge({ context: PROC, decide: () => ({ kind: 'allow' }) })
const p = bridge.projectionFor({
  name: 'write-file', callId: 'c1', arguments: { path: 'C:/x/a.txt' }, agent,
}).projection
console.log('⑤ subject.scope =', p.subject.scope, '| actor =', p.subject.actor, '| action =', p.subject.action)
console.log('⑤ canonicalHash =', p.canonicalHash.slice(0, 30) + '…')

// ── 反向控制：**没有**覆盖时用的是进程级那个空间 ────────────────────────────
const bare = createEnforcementBridge({ context: PROC, decide: () => ({ kind: 'allow' }) })
const q = bare.projectionFor({ name: 'write-file', callId: 'c2', arguments: { path: 'C:/x/a.txt' }, agent: { id: 'child-2' } }).projection
console.log('⑤ 反面控制 subject.scope =', q.subject.scope)

const ok = p.subject.scope === 'gf001' && p.subject.actor === PROC.actor
  && p.subject.action === PROC.action && q.subject.scope === 'legion'
  && p.canonicalHash !== q.canonicalHash
console.log(ok ? '\n★ 整条链通了：租约的空间名一路走到了授权哈希' : '\n✖ 链断了')
process.exit(ok ? 0 : 1)
