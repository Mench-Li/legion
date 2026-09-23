// 临时探针（未跟踪）：对**真实运行的** team-hub 走一遍新的运行输入解析链。
// 只读（GET）。目的：把"这条链在真数据上给出什么"量出来，而不是靠夹具断言。
import { createModelProfileRefResolver, resolveRunInputs } from '../orchestrator/worker/run-inputs.mjs'
import { defaultRequestFor } from '../orchestrator/worker/executor.mjs'
import { validateRunRequest } from '../runtime/contracts/run.mjs'

const HUB = process.env.LEGION_PROBE_HUB ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.TEAM_HUB_TOKEN ?? ''

async function get(path) {
  const res = await fetch(HUB + path, {
    method: 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

const modelProfileRefFor = createModelProfileRefResolver({ get })

// 用真实的 (space, role) 组合试。role 从任务上取，这里逐个空间找第一个有 role 的任务。
const spaces = await get('/api/spaces')
const ids = (spaces.body?.spaces ?? spaces.body?.items ?? spaces.body ?? [])
  .map((s) => s?.id).filter((x) => typeof x === 'string')
console.log('空间：', ids.join('、') || '（读不到）')

for (const scope of ids) {
  const tasks = await get(`/api/tasks?scope=${encodeURIComponent(scope)}`)
  const list = tasks.body?.tasks ?? tasks.body?.items ?? (Array.isArray(tasks.body) ? tasks.body : [])
  const withRole = list.filter((t) => typeof t?.role === 'string' && t.role.trim() !== '')
  console.log(`\n[${scope}] 任务 ${list.length} 条，其中有岗位的 ${withRole.length} 条`)
  const sample = withRole.slice(0, 3)
  for (const t of sample) {
    const lease = { attemptId: `att:${t.id}:1`, taskId: t.id, scope, leaseEpoch: 1, workerId: 'probe' }
    const reading = await modelProfileRefFor(lease)
    console.log(`  任务 ${t.id} role=${t.role} → ${reading.ok ? reading.modelProfileRef : `${reading.code}: ${reading.message}`}`)
  }
  if (sample.length === 0) {
    // 没有带岗位的任务时，直接用任务的 id 试（会读到 role=null 那条拒绝路径）
    const anyTask = list[0]
    if (anyTask !== undefined) {
      const lease = { attemptId: `att:${anyTask.id}:1`, taskId: anyTask.id, scope, leaseEpoch: 1, workerId: 'probe' }
      const reading = await modelProfileRefFor(lease)
      console.log(`  任务 ${anyTask.id} → ${reading.ok ? reading.modelProfileRef : `${reading.code}: ${reading.message}`}`)
    }
  }
}

// 把这条链走完整：真租约形状 + 真模型解析 + 一个假装已经建好的 worktree 槽位。
const bindings = await get('/api/model-bindings')
console.log('\n现有模型绑定：', JSON.stringify(bindings.body?.bindings ?? bindings.body ?? null).slice(0, 400))

const probeLease = { attemptId: 'att:probe:1', taskId: 'probe', scope: ids[0] ?? 'default', leaseEpoch: 1, workerId: 'probe' }
const bound = await modelProfileRefFor(probeLease)
const inputs = resolveRunInputs({
  lease: probeLease,
  workspace: { kind: 'worktree', slotDir: 'C:\\probe\\slot\\att-probe-1' },
  modelProfileRef: bound.ok ? bound.modelProfileRef : null,
})
console.log('\n装配：', inputs.ok, JSON.stringify(inputs.missing), JSON.stringify(inputs.sources))
if (inputs.ok) {
  const req = defaultRequestFor(probeLease, { finalText: 'x', associations: {} }, inputs)
  console.log('契约：', JSON.stringify(validateRunRequest(req).errors))
  console.log('三个字段：', req.workspaceId, '|', req.modelProfileRef, '|', req.workdir)
}
