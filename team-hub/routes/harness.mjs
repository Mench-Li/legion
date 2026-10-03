// team-hub/routes/harness.mjs
// ============================================================================
// 路由层新族：**harness 路由**（F-23 的生产消费者）
//
//   POST /api/harness/providers   增改一行 harness 产品（command/args/env/permission/enabled）
//   POST /api/harness/providers/remove
//   GET  /api/harness/providers   列出（含 protected 标记）
//   POST /api/harness/rules       配置表一行：任务类型 ⇒ provider
//   POST /api/harness/rules/remove
//   GET  /api/harness/rules       列出配置表
//   POST /api/harness/resolve     ★ **派工前问一句"这次交给谁"** —— 返回 {provider, source}
//
// ## 边界（写清楚）
//
// 本族把**判定**放上生产路径（配置可改、判定可问、来源可查），但**还没有**把它接进
// 真正建任务/起 Run 的那条路 —— 那是下一刀。所以 F-23 仍是 🟡。
//
// ★ 判定**只从配置表 + 请求字段**来（业主裁决：2 为主、1 兜底）；本族不做任何猜测，
//   也不在 provider 不在册时"顺手用默认顶上" —— 那是具名拒绝。
// ============================================================================

import { createHarnessRouter, ROUTE_REJECT } from '../../runtime/contracts/harness-routing.mjs'
import { createHarnessStore } from '../harness-store.mjs'

/**
 * @param {object} deps
 * @param {object} deps.harnessStore 配置表（`team-hub/harness-store.mjs`）
 */
export function createHarnessRoutes({ json, handleWrite, harnessStore } = {}) {
  const deps = { json, handleWrite, harnessStore }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError('createHarnessRoutes 缺注入项：' + k)
  }

  /** ★ 每次判定都**现读配置表**：改了配置就该立刻生效（不是启动时的快照）。 */
  const decide = (req) => {
    const cfg = harnessStore.routerConfig()
    return createHarnessRouter(cfg).resolve(req)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/harness/providers',
      async run(req, res) { await handleWrite(req, res, (body) => harnessStore.upsertProvider(body ?? {})) },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/harness/providers/remove',
      async run(req, res) { await handleWrite(req, res, (body) => harnessStore.removeProvider(body ?? {})) },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/harness/providers',
      async run(req, res) { json(res, 200, { providers: harnessStore.listProviders() }) },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/agent-tools/configs',
      async run(req, res) { await handleWrite(req, res, (body) => harnessStore.putAgentToolConfig(body ?? {})) },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/agent-tools/configs',
      async run(req, res) {
        const includeDisabled = new URL(req.url ?? '/', 'http://x').searchParams.get('includeDisabled') === 'true'
        json(res, 200, { configs: harnessStore.listAgentToolConfigs({ includeDisabled }) })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/agent-nodes/configs',
      async run(req, res) {
        await handleWrite(req, res, (body, _by, scope) => harnessStore.putAgentNodeConfig({ ...body, scope }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/agent-nodes',
      async run(req, res) {
        const url = new URL(req.url ?? '/', 'http://x')
        const scope = url.searchParams.get('scope')
        json(res, 200, { nodes: harnessStore.listAgentNodeConfigs({ scope: scope || null }) })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/agent-nodes/heartbeat',
      async run(req, res) {
        await handleWrite(req, res, (body, _by, scope) => harnessStore.heartbeatAgentNode({ ...body, scope }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/agent-workflows/definitions',
      async run(req, res) {
        await handleWrite(req, res, (body, _by, scope) => harnessStore.putAgentWorkflowDefinition({
          scope,
          definition: body?.definition,
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/agent-workflows/definitions',
      async run(req, res) {
        const params = new URL(req.url ?? '/', 'http://x').searchParams
        const scope = params.get('scope')
        const id = params.get('id')
        const version = params.has('version') ? Number(params.get('version')) : null
        if (!scope) {
          json(res, 400, { error: '读取工作流定义需要 scope' })
          return
        }
        if (id !== null || version !== null) {
          if (!id || !Number.isSafeInteger(version) || version < 1) {
            json(res, 400, { error: '读取单个工作流定义需要 scope、id 与正整数 version' })
            return
          }
          const definition = harnessStore.getAgentWorkflowDefinition({ scope, id, version })
          json(res, definition === null ? 404 : 200, definition === null ? { error: '工作流定义不存在' } : { definition })
          return
        }
        json(res, 200, { definitions: harnessStore.listAgentWorkflowDefinitions({ scope }) })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/harness/rules',
      async run(req, res) { await handleWrite(req, res, (body) => harnessStore.setRule(body ?? {})) },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/harness/rules/remove',
      async run(req, res) { await handleWrite(req, res, (body) => harnessStore.removeRule(body ?? {})) },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/harness/rules',
      async run(req, res) { json(res, 200, { rules: harnessStore.listRules() }) },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/harness/decisions',
      async run(req, res) {
        const limit = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 50)
        json(res, 200, { decisions: harnessStore.listDecisions({ limit }) })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/harness/resolve',
      async run(req, res) {
        await handleWrite(req, res, (body) => {
          const out = decide({ taskType: body?.taskType, requested: body?.requested, suggested: body?.suggested })
          // ★ 来源如实记账：**成功与被拒都记** —— 被拒那条是"这次为什么没派出去"的唯一去处。
          harnessStore.recordDecision({
            taskType: body?.taskType ?? null, requested: body?.requested ?? null, suggested: body?.suggested ?? null,
            provider: out.ok ? out.provider : null, source: out.ok ? out.source : out.reason, accepted: out.ok,
          })
          // ★ 不在册 ⇒ 具名拒绝（**不回落**）。message 里带上理由，便于调用方分辨"没人接"与"配错了"。
          if (!out.ok) throw new Error('harness 路由被拒：' + out.reason + '（' + JSON.stringify(out.detail ?? {}) + '）')
          return out
        })
      },
    },
  ]

  const matches = (r, path) => {
    if (r.match === 'exact') return path === r.path
    if (r.match === 'prefix') return path.startsWith(r.path)
    if (r.match === 'prefix+suffix') return path.startsWith(r.path) && path.endsWith(r.suffix)
    return false
  }

  return {
    id: 'harness',
    routes,
    decide,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}

export { ROUTE_REJECT }
