// scratch/mutate.mjs —— 破坏性验证（未跟踪）。
// 每条改动都必须让**指定的**用例变红；不变红说明那条判据是摆设。
// 用 try/finally 保证源码一定被还原。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const SUITE = 'orchestrator/worker/run-inputs.test.mjs'

const MUTATIONS = [
  {
    id: '① 只在 ok===true 时采纳 inputs → 改成"有 inputs 就用"',
    file: 'orchestrator/worker/executor.mjs',
    from: "const supplied = runInputs !== null && typeof runInputs === 'object' && runInputs.ok === true",
    to: "const supplied = runInputs !== null && typeof runInputs === 'object' && true",
    expect: '⑪',
  },
  {
    id: '② 取链首（不检查 role===primary）→ 备用会顶班',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "if (id === null || chainRole !== 'primary') {",
    to: "if (id === null) {",
    expect: '⑭',
  },
  {
    id: '③ 主档案解析失败也照用 → fallback 悄悄顶替',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "  if (resolution.ok !== true) {",
    to: "  if (false) {",
    expect: '⑬',
  },
  {
    id: '④ 原地执行也返回槽位目录 → 隔离退化成原地',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "  if (workspace.kind === 'in-place') return clean(projectDir)",
    to: "  if (workspace.kind === 'in-place') return clean(workspace.slotDir)",
    expect: '⑥',
  },
  {
    id: '⑤ 反向控制：`tagStage` 只转发一个参数 → 运行输入根本到不了 execute',
    file: 'orchestrator/worker/main.mjs',
    from: 'const tagStage = (stageName, fn) => async (...args) => {',
    to: 'const tagStage = (stageName, fn) => async (onlyLease) => {',
    also: { from: 'return await fn(...args)', to: 'return await fn(onlyLease)' },
    expect: '㉔',
  },
  {
    id: '⑥ 反向控制：丢掉 prepareWorkspace 的结果 → workdir 没有权威来源',
    file: 'orchestrator/worker/main.mjs',
    from: 'const workspaceDetail = workspaceStep.detail ?? null',
    to: 'const workspaceDetail = null',
    expect: '㉔',
  },
  {
    id: '⑦ 生产入口不再交出模型端口',
    file: 'product/orchestrator/worker.mjs',
    from: '  modelProfileRefFor,\n})',
    to: '})',
    expect: '㉒',
  },
  {
    id: '⑧ 模型解析回落成"平台默认"（不给 job 岗位也能跑）',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "    const role = clean(res?.body?.role)\n    if (role === null) {",
    to: "    const role = clean(res?.body?.role) ?? 'coder'\n    if (false) {",
    expect: '⑳',
  },
]

function run() {
  try {
    const out = execFileSync(process.execPath, ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { failed: [], output: out }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1])
    return { failed: [...new Set(failed)], output: out }
  }
}

const baseline = run()
console.log(`基线：${baseline.failed.length === 0 ? '全绿' : `红 ${baseline.failed.length} 条 —— ${baseline.failed.join(' / ')}`}`)
if (baseline.failed.length > 0) process.exit(1)

let ok = 0
for (const m0 of MUTATIONS) {
  let m = m0
  const path = `${ROOT}${m.file}`
  const original = readFileSync(path, 'utf8')
  try {
    if (!original.includes(m.from)) {
      // 工作区是 CRLF（Windows core.autocrlf），锚点里的 `\n` 要跟着换。
      const nl = original.includes('\r\n') ? '\r\n' : '\n'
      m = { ...m, from: m.from.replace(/\n/g, nl), to: m.to.replace(/\n/g, nl),
        ...(m.also ? { also: { from: m.also.from.replace(/\n/g, nl), to: m.also.to.replace(/\n/g, nl) } } : {}) }
    }
    if (!original.includes(m.from)) { console.log(`⚠ ${m.id}：锚点没找到，跳过（${m.file}）`); continue }
    let mutated = original.replace(m.from, m.to)
    if (m.also) {
      if (!mutated.includes(m.also.from)) { console.log(`⚠ ${m.id}：第二锚点没找到，跳过`); continue }
      mutated = mutated.replace(m.also.from, m.also.to)
    }
    writeFileSync(path, mutated)
    const r = run()
    const bit = r.failed.some((n) => n.includes(m.expect))
    console.log(`${bit ? '✔' : '✖ 没咬住'} ${m.id}  → 期望 ${m.expect} 变红；实际红 ${r.failed.length} 条${r.failed.length ? `：${r.failed.slice(0, 6).join(' / ')}` : ''}`)
    if (bit) ok += 1
  } finally {
    writeFileSync(path, original)
  }
}
console.log(`\n破坏性验证：${ok}/${MUTATIONS.length} 条咬住`)
const after = run()
console.log(`还原后：${after.failed.length === 0 ? '全绿' : `仍红 ${after.failed.length} 条 —— ${after.failed.join(' / ')}`}`)
