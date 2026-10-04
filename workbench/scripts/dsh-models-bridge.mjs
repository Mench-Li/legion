// Reuse the authenticated DSH Remote owners; never read or rewrite Harness files.
//
// ★ 宿主端口是**派生值，不是默认值**（Bug #1「供应商与模型无法读取」的根因）。
//   本文件曾把宿主写死成 `http://127.0.0.1:3080`：web profile 里恰好对，Desktop 部署里
//   宿主实际在别的端口（实测 19387），于是 `llm/listConfigurableProviders` /
//   `settings/describe` / `session/modelCatalog` 三个读取全部连不上，「供应商与模型」整页
//   读不出来——而界面只拿到一句 `fetch failed`，既看不出是端口错了，也看不出该改哪里。
//   这与 `DSH_HUB_UPSTREAM` 是同一条教训（见 `product/config-schema.mjs` 的 injects 表：
//   「**派生值**：workbench 必须指到本次启动的 hub，而不是默认 8787」）。
//   修法：宿主地址由启动方注入（`DSH_MODELS_BASE_URL`，legion-services 插件按
//   `ctx.webServer.port` 派生），3080 只作为独立跑 web profile 时的兜底。
export const DEFAULT_DSH_BASE_URL = 'http://127.0.0.1:3080'

/** 归一化宿主地址：只接受 http(s)，只取 origin（带路径/尾斜杠的写法不至于拼出 `//api/...`）。 */
export function normalizeDshBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch { return '' }
}

const METHODS = new Set(['llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels', 'session/modelCatalog', 'settings/describe', 'settings/mutate', 'credentials/set'])
export function validateDshModelsRequest(body) {
  if (!METHODS.has(body?.method) || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new Error('不支持的模型配置请求')
  if (body.method === 'settings/mutate') {
    const { ns, ops, expectedRevision } = body.args
    if (!['llm-pi-ai', 'llm-deepseek'].includes(ns) || !Number.isInteger(expectedRevision) || !Array.isArray(ops) || ops.length === 0) throw new Error('模型配置命名空间或版本无效')
    for (const op of ops) {
      const path = op?.path
      if (!['set', 'unset'].includes(op.op) || !Array.isArray(path) || path.some(p => typeof p !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('模型配置路径无效')
      if (op.op === 'unset' && !(ns === 'llm-pi-ai' && path[0] === 'providers' && path.length === 2)) throw new Error('仅允许删除自定义供应商配置')
      if (ns === 'llm-pi-ai' && !(path[0] === 'providers' && path.length >= 2)) throw new Error('仅允许修改供应商配置')
      if (ns === 'llm-deepseek' && !['baseURL', 'models', 'apiKeyEnv'].includes(path[0])) throw new Error('仅允许修改模型连接配置')
    }
  }
  if (body.method === 'credentials/set' && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.args.ref ?? '') || typeof body.args.value !== 'string' || !body.args.value.trim())) throw new Error('凭证引用或密钥无效')
  if (body.method === 'llm/discoverModels' && (!['llm-pi-ai', 'llm-deepseek'].includes(body.args.settingsNs) || !body.args.request || typeof body.args.request !== 'object')) throw new Error('模型探测请求无效')
  return body
}

/** 连不上宿主时要说的话：把**实际用的地址**和**下一步**说清楚。
 *  `fetch failed` 是 Node 的笼统说法——它不说是哪个地址、也不说这是本机配置问题。 */
function unreachableError(url, e) {
  const cause = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? e?.message ?? '未知原因'
  const hint = '这是 Legion 侧「宿主地址」的问题（Desktop 部署里宿主端口由 legion-services 插件注入），不是供应商的问题。'
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return Object.assign(new Error(`模型配置请求超时（15s）：${url}。${hint}`), { status: 504 })
  return Object.assign(new Error(`连不上模型配置宿主（${url}）：${cause}。${hint}`), { status: 502 })
}

export async function forwardDshModels(body, { cookie = '', fetchImpl = fetch, baseUrl = DEFAULT_DSH_BASE_URL } = {}) {
  validateDshModelsRequest(body)
  const origin = normalizeDshBaseUrl(baseUrl) || DEFAULT_DSH_BASE_URL
  const url = `${origin}/api/${body.method}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: `legion-models-${crypto.randomUUID()}`, method: body.method, payload: { args: body.args } }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    throw unreachableError(url, e)
  }
  if (response.status === 401) throw Object.assign(new Error('模型服务连接未授权，请重新连接服务后刷新配置。'), { status: 401 })
  if (!response.ok) throw new Error(`模型服务接口返回 ${response.status}`)
  const envelope = await response.json()
  const result = envelope.result
  if (!result || typeof result.ok !== 'boolean') throw new Error('模型服务接口版本不兼容')
  if (!result.ok) throw new Error(result.error?.message ?? '模型服务拒绝了配置请求')
  return result.value ?? null
}
