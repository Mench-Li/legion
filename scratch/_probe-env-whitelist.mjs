// scratch/_probe-env-whitelist.mjs —— spec 要求 RunRequest 带「环境变量白名单」，实测它在不在（**不提交**）
import { readFileSync } from 'node:fs'
import { validateRunRequest, RUN_REQUEST_REQUIRED } from '../runtime/contracts/run.mjs'

console.log('RUN_REQUEST_REQUIRED =', RUN_REQUEST_REQUIRED.length, '个字段')
console.log('  含 env / envWhitelist ?', RUN_REQUEST_REQUIRED.some((f) => /env/i.test(f)))
console.log('  字段：', RUN_REQUEST_REQUIRED.join(', '))

// ① 不给 env 的请求能不能过契约？
const noEnv = {
  runId: 'r', attemptId: 'a', idempotencyKey: 'i', workspaceId: 'w', goalId: 'g',
  taskId: 't', employeeId: 'e', teamPlanRef: 'tp', contextSnapshotRef: 'cs',
  modelProfileRef: 'mp', budget: {}, timeoutMs: 1, workdir: 'D:/x',
  permissions: { preset: 'p', tools: [] },
  expectedOutput: { schema: {}, acceptance: 'x' },
}
const r1 = validateRunRequest(noEnv)
console.log('\n① 完全不给 env 的请求：ok =', r1.ok, r1.ok ? '（⇒ 这个字段不是必填）' : r1.errors)

// ② 给一个**胡乱写的** env 呢？会不会被拒？
const badEnv = { ...noEnv, env: 'not-an-array-at-all' }
const r2 = validateRunRequest(badEnv)
console.log('② env 写成字符串 ' + JSON.stringify(badEnv.env) + '：ok =', r2.ok,
  r2.ok ? '（⇒ 形状也没人校验）' : r2.errors)

// ③ spec 那两处逐字
for (const [name, p] of [
  ['优化文档 F-01', 'docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md'],
  ['设计 spec', 'docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md'],
]) {
  const t = readFileSync(`D:/project/DSH/legion/${p}`, 'utf8')
  const hit = t.split(/\r?\n/).filter((l) => l.includes('环境变量白名单'))
  console.log(`\n③ ${name} 提到「环境变量白名单」${hit.length} 处：`)
  for (const h of hit) console.log('   ' + h.trim().slice(0, 150))
}
