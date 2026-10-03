// Reuse the authenticated DSH Remote owners; never read or rewrite Harness files.
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
export async function forwardDshModels(body, { cookie = '', fetchImpl = fetch } = {}) {
  validateDshModelsRequest(body)
  const response = await fetchImpl(`http://127.0.0.1:3080/api/${body.method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: `legion-models-${crypto.randomUUID()}`, method: body.method, payload: { args: body.args } }),
    signal: AbortSignal.timeout(15000),
  })
  if (response.status === 401) throw Object.assign(new Error('模型服务连接未授权，请重新连接服务后刷新配置。'), { status: 401 })
  if (!response.ok) throw new Error(`模型服务接口返回 ${response.status}`)
  const envelope = await response.json()
  const result = envelope.result
  if (!result || typeof result.ok !== 'boolean') throw new Error('模型服务接口版本不兼容')
  if (!result.ok) throw new Error(result.error?.message ?? '模型服务拒绝了配置请求')
  return result.value ?? null
}
