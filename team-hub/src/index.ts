/**
 * @dsh-external/dsh-team-hub — 军团团队协作中枢（DSH 宿主服务形态）。
 *
 * P1-1 合并后：本插件**不再含第二套任务状态机/鉴权实现**，只做宿主侧薄外壳——
 * 把 v2 权威实现（team-hub/server.mjs，SQLite 单一中枢）挂到 DSH webServer 前缀路由：
 *
 *   - Config → 运行 env 转接（dbPath/teamToken/port 在 import server.mjs 前写入，
 *     server.mjs 与 8787 独立进程共享同一实现与同一默认数据池 team-hub/team.db）。
 *   - 路由注册 ctx.webServer.register({ kind:'prefix', path: routePrefix })，
 *     handler 剥离前缀后直调 v2 handle —— 与独立进程（无前缀）共用同一路由表。
 *   - teardown：卸载路由 + disposeHub()（end SSE 客户端），心跳随连接关闭自清。
 *
 * 旧版 taskctl 文件库实现（scrumDir/tasks.json + taskctl.mjs 子进程 + activity.jsonl
 * watch）已随 P1-1 删除；members/scopes 白名单为 v1 遗留配置，保留接受但不再生效
 * （v2 权威实现使用 scope/roster 模型），dbPath 为空时使用 server.mjs 默认库。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = '@dsh-external/dsh-team-hub'
export const inject = ['webServer']

export interface Config {
  /** 旧 v1 文件库目录（保留接受、不再使用；生产 patch 兼容过渡）。 */
  scrumDir?: string
  /** webServer 路由前缀（hub 挂在此前缀下）。 */
  routePrefix: string
  /** 团队共享 token；非空时写操作需 `Authorization: Bearer <token>`（v2 handleWrite 语义）。 */
  teamToken: string
  /** v1 遗留：成员白名单（不再生效，v2 用 scope/roster 模型）。 */
  members?: string[]
  /** v1 遗留：scope 级成员白名单（不再生效）。 */
  scopes?: Record<string, string[]>
  /** v2 SQLite 库文件；为空 = server.mjs 默认（生产与 8787 独立进程同库 team-hub/team.db）。 */
  dbPath: string
}

export const Config = z.object({
  scrumDir: z.string().default(''),
  routePrefix: z.string().default('/team-hub'),
  teamToken: z.string().default(''),
  members: z.array(z.string()).default([]),
  scopes: z.dict(z.array(z.string())).default({}),
  dbPath: z.string().default(''),
})

export function apply(ctx: Context, config: Config): void {
  const prefix = config.routePrefix.replace(/\/+$/, '') || '/'
  let hubMod: typeof import('../server.mjs') | null = null
  let disposeRoute: (() => void) | null = null

  // ── env 转接：必须在动态 import server.mjs 之前完成（模块加载即按 env 建库/读 token）。
  if (config.dbPath) process.env.TEAM_HUB_DB = config.dbPath
  process.env.TEAM_HUB_TOKEN = config.teamToken
  process.env.TEAM_HUB_PORT = String(ctx.webServer.port ?? 8787)

  // ── teardown 兜底（无论挂载与否，fiber dispose 时都要清 SSE 客户端并摘路由）。
  ctx.effect(() => () => {
    if (hubMod) {
      try { hubMod.disposeHub() } catch { /* dispose 已幂等 */ }
    }
    if (disposeRoute) {
      disposeRoute()
      disposeRoute = null
    }
  }, `${name}: hub teardown`)

  void import('../server.mjs').then((hub) => {
    if (hubMod) return
    hubMod = hub
    disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void hub.handle(req, res, prefix === '/' ? undefined : prefix)
      },
    })
    ctx.logger?.info?.(`[${name}] v2 中枢已挂载：${prefix}（db=${config.dbPath || '(默认 team.db)'}，鉴权=${config.teamToken !== '' ? 'on' : 'off'}）`)
  }).catch((error) => {
    ctx.logger?.error?.(`[${name}] 加载 v2 中枢失败：${String(error)}`)
  })
}
