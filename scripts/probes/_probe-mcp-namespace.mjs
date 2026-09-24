// 关键实测：一个 `mcp__<已知连接器>__<未声明工具>` 走桥，今天是什么读数？
import { installEnforcementRoot, resetEnforcementRoot } from '../../runtime/dsh-composition/root.mjs'
import { namespaceOf } from '../../runtime/connectors/public-name.mjs'
import { connectorPortFromEnv } from '../../runtime/dsh-composition/connector-port.mjs'

const ENV_OK = {
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'alice',
  LEGION_SCOPE: 'space-1',
  LEGION_CWD: 'C:/work',
  LEGION_ENFORCEMENT_ACTION: 'write',
}

const DECL = [{
  connectorId: 'github', transport: 'stdio', command: 'npx mcp-github',
  policy: 'allow',
  tools: [{ name: 'list_issues', capabilities: ['repo:read'] }],
  secretRefs: [],
}]

// ★ 走**生产端口**的解析器（`connector-port.mjs`），不是本地手写的桩——
//   否则这条探针验的是探针自己。
const PROD = connectorPortFromEnv({ env: { LEGION_CONNECTOR_DECLARATIONS: JSON.stringify(DECL) } })
const derived = PROD.resolveConnectorId
console.log('（解析器来自 connector-port.mjs，state=' + PROD.state + '，工具数=' + PROD.toolCount + '）')
console.log('')

async function probe(label, toolName, opts = {}) {
  resetEnforcementRoot()
  const installed = installEnforcementRoot({
    env: { ...ENV_OK },
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => (async () => 'rejected'),
    pathScope: null,
    ...opts,
  })
  if (installed.ok !== true) { console.log('  ' + label + ' ⇒ 没装上：' + installed.code); return }
  const s = installed.root.enforcementSurfaces()
  // ★ 显式 `target`：`deriveTarget` 的第一条分支，任何工具名都推得出来。
  //   （用空 `{}` 会走 "候选一个都没有" 那条 ⇒ 抛 TARGET_MISSING，
  //    那是**参数**的问题，不是工具名的问题——第一版探针就栽在这里。）
  const v = await installed.root.bridge.preExecute({
    name: toolName, callId: 'c-1', arguments: { target: 'C:/work/x' },
  })
  console.log('  ' + label.padEnd(34) + '⇒ kind=' + String(v.kind).padEnd(6)
    + ' judgment=' + String(s.connectorJudgment).padEnd(5)
    + ' reason=' + String(v.reason ?? '').slice(0, 50))
  resetEnforcementRoot()
}

const WITH = { connectorDeclarations: DECL, resolveConnectorId: derived }

console.log('=== A. 命名空间是已知连接器、工具**未声明** ===')
await probe('没声明表', 'mcp__github__delete_repo')
await probe('有声明表、推导式不认它', 'mcp__github__delete_repo', WITH)

console.log('')
console.log('=== B. 对照 ===')
await probe('list_issues（声明过）', 'list_issues', WITH)
await probe('git-status（DSH 核心工具）', 'git-status', WITH)
await probe('mcp__github__list_issues（声明过）', 'mcp__github__list_issues', WITH)

console.log('')
console.log('=== C. 命名空间归属的读数（本轮新模块） ===')
for (const n of ['git-status', 'write-file', 'mcp__github__git-status', 'mcp__evil__x']) {
  const r = namespaceOf(['github'], n)
  console.log('  ' + JSON.stringify(n).padEnd(30) + '⇒ ' + r.state + (r.connectorId ? ' → ' + r.connectorId : ''))
}
