// 临时探针（未跟踪）：把运行中的 team-hub 的**路由面**与仓库源码对账。
// 只读。目的：判断这台 hub 是不是比仓库旧（那会影响"切过去"这件事的全部预期）。
const HUB = process.env.LEGION_PROBE_HUB ?? 'http://127.0.0.1:8787'

async function probe(path) {
  try {
    const res = await fetch(HUB + path, { headers: { authorization: `Bearer ${process.env.TEAM_HUB_TOKEN ?? ''}` } })
    const text = await res.text()
    let note = text.slice(0, 120).replace(/\s+/g, ' ')
    return `${String(res.status).padEnd(3)} ${path}  ${note}`
  } catch (e) {
    return `ERR ${path}  ${e.message}`
  }
}

const paths = [
  '/api/health',
  '/api/spaces',
  '/api/agents',
  '/api/tasks',
  '/api/tasks?scope=software',
  '/api/task?id=__probe__',
  '/api/model-bindings',
  '/api/model-bindings/resolve?scope=software&role=coder',
  '/api/model-profiles',
  '/api/employee-manifest?scope=software&role=coder',
  '/api/runtime/claim',
  '/api/permissions/inbox',
]
for (const p of paths) console.log(await probe(p))
