import { inspectWorkflowPackInstall, installWorkflowPack, validateWorkflowPack } from '../../product/workflow-packs/pack.mjs'

export function createWorkflowPackRoutes({ db, json, handleWrite, audit, withTx }) {
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
            'workflow-pack:install', null, { id: validated.pack.id, version: validated.pack.version, digest: validated.digest }) })
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
