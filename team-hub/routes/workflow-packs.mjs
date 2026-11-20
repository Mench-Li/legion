import { inspectWorkflowPackInstall, installWorkflowPack, validateWorkflowPack } from '../../product/workflow-packs/pack.mjs'

export function createWorkflowPackRoutes({ db, json, handleWrite, audit, withTx, grantSpaceCreator }) {
  // ★ 与其它族同一条 fail-closed 纪律：注入项缺了就在**构造时**抛，
  //   而不是等到某一次装包时才发现"空间建出来了、创建者却进不去"（BUG-048）。
  for (const [k, v] of Object.entries({ db, json, handleWrite, audit, withTx, grantSpaceCreator })) {
    if (v === undefined || v === null) throw new TypeError(`createWorkflowPackRoutes 缺注入项：${k}`)
  }
  const routes = [
    {
      method: 'GET', match: 'exact', path: '/api/workflow-packs',
      async run(req, res) {
        try {
          const packages = db.prepare(`SELECT pack_id AS id, scope, version, digest, installed_at AS installedAt
            FROM workflow_pack_installs ORDER BY pack_id`).all()
          json(res, 200, { packages })
        } catch (error) { json(res, 503, { error: 'workflow pack store unavailable' }) }
      },
    },
    {
      method: 'GET', match: 'exact', path: '/api/workflow-packs/assets',
      async run(req, res) {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const scope = url.searchParams.get('scope') ?? ''
          const packId = url.searchParams.get('pack') ?? ''
          if (!scope || !packId) { json(res, 400, { error: 'scope and pack are required' }); return }
          const assets = db.prepare(`SELECT asset_id AS id, type, title, path, content
            FROM workflow_pack_assets WHERE scope = ? AND pack_id = ? ORDER BY asset_id`).all(scope, packId)
          json(res, 200, { assets })
        } catch { json(res, 503, { error: 'workflow pack assets unavailable' }) }
      },
    },
    {
      method: 'POST', match: 'exact', path: '/api/workflow-packs/preview',
      async run(req, res) {
        await handleWrite(req, res, body => {
          const validated = validateWorkflowPack(body.pack)
          const plan = inspectWorkflowPackInstall(db, validated)
          return { ...plan, name: validated.pack.name, description: validated.pack.description,
            roles: validated.pack.roles.length, stages: validated.pack.stages.length, assets: validated.pack.assets.length }
        })
      },
    },
    {
      method: 'POST', match: 'exact', path: '/api/workflow-packs/install',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => {
          if (by !== 'general') throw Object.assign(new Error('流程包安装仅允许 general 确认'), { statusCode: 403 })
          const validated = validateWorkflowPack(body.pack)
          const preview = inspectWorkflowPackInstall(db, validated)
          if (!['install', 'upgrade'].includes(preview.action)) {
            throw Object.assign(new Error(preview.reason ?? 'WORKFLOW_PACK_NOT_INSTALLABLE'), {
              code: preview.reason ?? 'WORKFLOW_PACK_NOT_INSTALLABLE', statusCode: 409,
            })
          }
          const result = installWorkflowPack(db, validated, { withTx, audit: () => audit(by, validated.pack.scope.id,
            'workflow-pack:install', null, { id: validated.pack.id, version: validated.pack.version, digest: validated.digest }),
          // ★ BUG-048 的第二条入口：装包会顺手建出空间（`receipt === undefined` 时），
          //   所以"建空间即把创建者登记成 owner"这条规矩在这里也要接一下 ——
          //   钩子在 `installWorkflowPack` 的**同一个事务里**触发。
          onSpaceCreated: (scopeId) => grantSpaceCreator({ req, space: scopeId, created: true }) })
          return { ...result, name: validated.pack.name, roles: validated.pack.roles.length,
            stages: validated.pack.stages.length, assets: validated.pack.assets.length }
        })
      },
    },
  ]
  return {
    id: 'workflow-packs', routes,
    async dispatch(req, res, ctx) {
      for (const route of routes) {
        if (req.method !== route.method || ctx.path !== route.path) continue
        await route.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
