import { createRootRow } from '../runtime/dsh-composition/plugins/root-row.mjs'
import { enforcementRoot, resetEnforcementRoot } from '../runtime/dsh-composition/root.mjs'
import { projectToolRequest } from '../runtime/dsh-composition/tool-request.mjs'

const CWD = process.platform === 'win32' ? 'C:/work' : '/work'

function fakeContext() {
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    provide(n, v) { services.set(n, v) },
    get(n) { return services.get(n) },
    async plugin(p) { if (p?.apply) await p.apply(ctx) },
  }
  return { ctx, services }
}

resetEnforcementRoot()
const { ctx } = fakeContext()
await ctx.plugin(createRootRow({
  env: {
    TEAM_HUB_URL: 'http://hub.invalid:8787', LEGION_ACTOR: 'alice', LEGION_SCOPE: 's1',
    LEGION_ENFORCEMENT_ACTION: 'write', LEGION_CWD: CWD,
    // 宽松策略：**允许**一切不需要人批的东西。这样"被拦下"只可能来自别处。
    LEGION_APPROVAL_POLICY: 'never', LEGION_ATTENDED: 'true',
    LEGION_CONNECTOR_DECLARATIONS: JSON.stringify([{
      connectorId: 'github', transport: 'stdio', command: 'npx mcp-github', policy: 'allow',
      tools: [{ name: 'list_issues', capabilities: ['repo:read'] }], secretRefs: [],
    }]),
  },
  createRequestApproval: () => ({ requestApproval: async () => 'approved' }),
}))

const root = enforcementRoot()
const ctxForProject = { cwd: CWD, scope: 's1', actor: 'alice', action: 'write', taskId: 't1' }

console.log('工具名              kind     known  归属      理由')
console.log('-'.repeat(104))
for (const name of [
  'list_issues',        // github 声明过
  'git-status',         // DSH 核心工具，没人声明
  'write-file',         // DSH 核心工具，没人声明
  'github__delete_repo',// 看起来像连接器工具，但**没人声明**
  'totally-made-up',    // 完全未知
  'delete-file',        // DSH 核心工具（危险）
]) {
  const d = await root.bridge.preExecute({ name, callId: `c-${name}`, arguments: { path: `${CWD}/x` } })
  let known = '?'
  try {
    known = String(projectToolRequest({
      request: { toolName: name, callId: `p-${name}`, arguments: { path: `${CWD}/x` } },
      context: ctxForProject,
    }).known)
  } catch (e) { known = 'ERR' }
  const attribution = root.bridge.connectorJudgment.resolveConnectorId === undefined ? '?' : ''
  console.log(`${name.padEnd(19)} ${String(d.kind).padEnd(8)} ${known.padEnd(7)} ${attribution.padEnd(9)} ${String(d.reason ?? '(null)').slice(0, 52)}`)
}
console.log('')
console.log('receipts = ' + JSON.stringify(root.bridge.connectorJudgment.receipts(), null, 0))
resetEnforcementRoot()
