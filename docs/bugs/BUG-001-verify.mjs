// .tmp-bug1-verify.mjs — Bug #1「供应商与模型无法读取」的现场复现 / 修复验证
//
// 三问：
//   ① 旧行为（未注入宿主地址 ⇒ 回落 3080）：报什么？（期望：一句能指出地址与原因的话，而不是 fetch failed）
//   ② 注入本次启动的宿主地址（桩宿主，同一个 client-request 信封）：三个读取方法能不能读到真数据？
//   ③ 注入**真实**宿主（Desktop 实测 19387）：请求是否真的到达宿主（宿主自己回 401，而不是"连不上"）？
//
// 全程只读：桩宿主是本地临时进程，真实宿主只收到一个必然被拒的请求。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CATALOG = { default: { provider: 'fjd-ds', model: 'deepseek-v4-flash-vision-openai' }, groups: [{ id: 'fjd-ds', name: 'FJD', models: [{ id: 'deepseek-v4-flash-vision-openai', name: 'vision' }] }], failures: [] }

// ── 桩宿主：与 DSH 宿主同形状（POST /api/<method>，client-request 信封） ──
const seen = []
const stub = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').pathname.slice('/api/'.length)
    const envelope = JSON.parse(body || '{}')
    seen.push({ method, type: envelope.type, args: envelope.payload?.args })
    const value = method === 'session/modelCatalog' ? CATALOG
      : method === 'llm/listConfigurableProviders' ? [{ provider: 'fjd-ds', displayName: 'FJD', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fjd-ds'], declared: false }]
        : method === 'settings/describe' ? { writable: true, namespaces: [] }
          : null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
  })
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))
const stubPort = stub.address().port

const children = []
function startWorkbench(port, extraEnv) {
  const child = spawn(process.execPath, [join(ROOT, 'workbench', 'scripts', 'serve.mjs'), '--port', String(port)], {
    cwd: join(ROOT, 'workbench'),
    env: { ...process.env, DSH_WORKBENCH_PORT: String(port), DSH_WORKBENCH_HOST: '127.0.0.1', DSH_WORKBENCH_TOKEN: '', DSH_HUB_UPSTREAM: 'http://127.0.0.1:8787', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  children.push(child)
  return new Promise((resolve) => {
    let out = ''
    const onData = (c) => { out += c; if (out.includes('legion-workbench 已启动')) resolve(out) }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    setTimeout(() => resolve(out), 8000)
  })
}
const stop = () => { for (const c of children) { try { c.kill() } catch {} } try { stub.close() } catch {} }
process.on('exit', stop)

async function rpc(port, method, args = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/dsh-models`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  const text = await res.text()
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

const results = {}
// ① 旧行为：没有 DSH_MODELS_BASE_URL ⇒ 回落 3080（Desktop 上没人监听）
await startWorkbench(5281, {})
results.regression = { port: 5281, ...(await rpc(5281, 'llm/listConfigurableProviders')) }
// ② 修复后：注入桩宿主地址 ⇒ 三个读取都拿得到真数据
await startWorkbench(5282, { DSH_MODELS_BASE_URL: `http://127.0.0.1:${stubPort}` })
results.fixed = {
  port: 5282,
  catalog: await rpc(5282, 'session/modelCatalog'),
  providers: await rpc(5282, 'llm/listConfigurableProviders'),
  settings: await rpc(5282, 'settings/describe'),
}
// ③ 注入**真实** Desktop 宿主：请求到达宿主本身（宿主回 401，而不是"连不上"）
await startWorkbench(5283, { DSH_MODELS_BASE_URL: 'http://127.0.0.1:19387' })
results.realHost = { port: 5283, ...(await rpc(5283, 'llm/listConfigurableProviders')) }
results.stubEnvelope = seen

console.log(JSON.stringify(results, null, 2))
stop()
process.exit(0)
