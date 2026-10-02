import assert from 'node:assert/strict'
import test from 'node:test'

import { EXTERNAL_AGENT_CODES, executeExternalAgent, parseExternalWorkerReport } from './external-agent.mjs'

function fixture({ stopReason = 'completed', output = [{ type: 'text', text: 'done' }], diagnostic = undefined, startError = null, disposeError = null } = {}) {
  const calls = []
  const provider = { name: 'codex', permissionMode: 'approve-for-me', capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }
  const subagents = {
    getProvider(name) { return name === provider.name ? provider : undefined },
    async start(name, request) {
      calls.push({ name, request })
      if (startError) throw startError
      return {
        id: 'external-run-1',
        result: Promise.resolve({ stopReason, output, ...(diagnostic === undefined ? {} : { diagnostic }) }),
        async dispose() { if (disposeError) throw disposeError },
      }
    },
  }
  return { calls, subagents }
}
const parent = { session: { header: { cwd: process.cwd() } } }

test('启动只传文本、父会话与取消信号，不伪造外部 provider 不支持的能力', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'review this change', signal, policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me' })
  assert.equal(out.ok, true)
  assert.equal(out.provider, 'codex')
  assert.equal(out.output, 'done')
  assert.deepEqual(Object.keys(f.calls[0].request).sort(), ['label', 'parent', 'prompt', 'signal'])
})

test('cwd 不匹配时不启动 provider', async () => {
  const f = fixture()
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: `${process.cwd()}-other`, prompt: 'task', policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me' })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.WORKDIR_MISMATCH)
  assert.equal(f.calls.length, 0)
})

test('未完成执行前预检时拒绝启动', async () => {
  const f = fixture()
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task' })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.PREFLIGHT_REQUIRED)
  assert.match(out.message, /不证明原生权限模式已生效/)
  assert.match(out.message, /账户认证由 provider 启动\/执行结果确认/)
  assert.equal(f.calls.length, 0)
})

test('未知 provider 具名拒绝', async () => {
  const f = fixture()
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'claude-code', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.PROVIDER_MISSING)
})

test('冻结能力与运行时 provider 能力不一致时拒绝启动', async () => {
  const f = fixture()
  const out = await executeExternalAgent({
    subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true,
    expectedCapabilities: { outputSchema: true, toolFilter: false }, expectedPermissionMode: 'approve-for-me',
  })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.PROVIDER_MISSING)
  assert.equal(f.calls.length, 0)
})

test('worker 可取得外部 run 句柄并继续使用统一取消/超时处理', async () => {
  const f = fixture()
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me', returnRun: true })
  assert.equal(out.ok, true)
  assert.equal(typeof out.run.result.then, 'function')
  await out.run.dispose()
})

test('启动失败可辨认，且诊断不回显 provider 异常内容', async () => {
  const f = fixture({ startError: new Error('secret-bearing command line') })
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me' })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.START_FAILED)
  assert.equal(out.diagnostic, 'Error')
  assert.doesNotMatch(JSON.stringify(out), /secret-bearing command line/)
})

test('非 completed 终态保留 stopReason 并判为失败', async () => {
  const f = fixture({ stopReason: 'error', output: [], diagnostic: 'provider rejected the request' })
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me' })
  assert.equal(out.ok, false)
  assert.equal(out.stopReason, 'error')
  assert.equal(out.diagnostic, 'provider rejected the request')
})

test('回收失败不把结果报告为成功，且诊断不回显异常内容', async () => {
  const f = fixture({ disposeError: new Error('sensitive path detail') })
  const out = await executeExternalAgent({ subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task', policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me' })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.RESULT_INVALID)
  assert.equal(out.diagnostic, 'Error')
  assert.doesNotMatch(JSON.stringify(out), /sensitive path detail/)
})

test('未知或与冻结配置不一致的原生权限模式不启动 provider', async () => {
  const f = fixture()
  const out = await executeExternalAgent({
    subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task',
    policyPreflightPassed: true, expectedPermissionMode: 'never',
  })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.PERMISSION_MODE_UNVERIFIED)
  assert.equal(out.actualPermissionMode, 'approve-for-me')
  assert.equal(f.calls.length, 0)
})

test('DSH provider 未报告原生权限模式时不启动', async () => {
  const f = fixture()
  delete f.subagents.getProvider('codex').permissionMode
  const out = await executeExternalAgent({
    subagents: f.subagents, providerName: 'codex', parent, workdir: process.cwd(), prompt: 'task',
    policyPreflightPassed: true, expectedPermissionMode: 'approve-for-me',
  })
  assert.equal(out.code, EXTERNAL_AGENT_CODES.PERMISSION_MODE_UNVERIFIED)
  assert.equal(out.actualPermissionMode, null)
  assert.equal(f.calls.length, 0)
})

test('外部 WorkerReport 要求唯一且完整的 JSON 契约，拒绝自然语言和多报告歧义', () => {
  const valid = JSON.stringify({ status: 'done', summary: 'reviewed', evidence: 'checked diff', blocker: '', artifact: null })
  assert.deepEqual(parseExternalWorkerReport(valid).report, JSON.parse(valid))
  assert.equal(parseExternalWorkerReport(`\`\`\`json\n${valid}\n\`\`\``).ok, true)
  assert.deepEqual(parseExternalWorkerReport(`已完成审查。\n${valid}\n有一处小结。`).report, JSON.parse(valid))
  const bracesInString = JSON.stringify({ status: 'done', summary: 'brace } in text', evidence: 'checked', blocker: '', artifact: null })
  assert.deepEqual(parseExternalWorkerReport(`结果：${bracesInString}`).report, JSON.parse(bracesInString))
  assert.equal(parseExternalWorkerReport(`${valid}\n${valid}`).ok, false)
  assert.equal(parseExternalWorkerReport('Looks good').code, EXTERNAL_AGENT_CODES.RESULT_INVALID)
  assert.equal(parseExternalWorkerReport(JSON.stringify({ status: 'done', summary: 'x', evidence: '', blocker: '' })).ok, false)
  assert.equal(parseExternalWorkerReport(JSON.stringify({ status: 'done', summary: 'x', evidence: '', blocker: '', artifact: null, testReport: { passed: 'yes' } })).ok, false)
  assert.equal(parseExternalWorkerReport(JSON.stringify({ status: 'done', summary: 'reviewed', evidence: 'diff checked', blocker: '', artifact: null, review: { passed: false, findings: [{ kind: 'design', summary: 'criteria missing', evidence: 'spec §2' }] } })).ok, true)
  assert.equal(parseExternalWorkerReport(JSON.stringify({ status: 'done', summary: 'reviewed', evidence: '', blocker: '', artifact: null, review: { passed: true, findings: [{ kind: 'other', summary: 'x' }] } })).ok, false)
})
