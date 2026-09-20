// team-hub/routes/space-config.mjs
// ============================================================================
// 路由层第 43 族：**工作空间注册/更新与空间流水线配置（含"仅 general 可改流水线"那道权限闸）** —— PRT-316 切片 45
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 43 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 7810727:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 2 条的形态分布（生成器算的，不是抄的）
//
//   ×  2  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  0  `path.startsWith('…') && path.endsWith('…')`
//
// 生成器在切片 5 修正过一次**静默漏取**：切片 4 的版本只认等值那一种，
// 会静默跳过另外 48 条（旧自检只为"一条都没取到"准备，所以不会响）。
//
//   > 一个"按前缀取族、却只认一种写法"的生成器，
//   > 与一个"把这一族搬走一半"的提交，在 `node --check` 通过时是同一个东西。
//
// 生成器在切片 6 修正过第二次：ctx 成员**按体逐条绑定**（旧版一律允许
// `path`/`url`、却只解构 `url` ⇒ 体里用 `path` 的族会拿到 `undefined`）。
//
//   > 一个"把名字登记成可用"的白名单，与一个"真的把它绑进来"的解构，
//   > 在没人用那个名字的时候是同一个东西。
//
// ## 零注入改写
//
// 2 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 工作空间 + 编队管理 ──


/**
 * 造工作空间注册/更新与空间流水线配置（含"仅 general 可改流水线"那道权限闸）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createSpaceConfigRoutes({
  json,
  db, now, audit,
  handleWrite, SCOPE_KEY_RE, normalizeStages,
  normalizeRuntime, withTx, readPipeline,
  pipelineWarnings,
}) {
  const deps = { json,
    db, now, audit,
    handleWrite, SCOPE_KEY_RE, normalizeStages,
    normalizeRuntime, withTx, readPipeline,
    pipelineWarnings,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createSpaceConfigRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/spaces',
      async run(req, res) {
        // 注册/更新工作空间（幂等 upsert：id + name 必填）。除 private 外支持仓库绑定：
        // localDir = 本地文件夹（该空间对应的本机目录），remoteUrl = 远程仓库 URL（空 = 仅本地/不进共享仓库）。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          const name = body.name
          if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
          if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
          const localDir = typeof body.localDir === 'string' ? body.localDir.trim() : ''
          const remoteUrl = typeof body.remoteUrl === 'string' ? body.remoteUrl.trim() : ''
          if (localDir.length > 512) throw new Error('localDir 过长（≤512 字符）')
          if (remoteUrl.length > 1024) throw new Error('remoteUrl 过长（≤1024 字符）')
          const existed = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
          db.prepare(`INSERT INTO spaces (id, name, private, local_dir, remote_url, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, private=excluded.private, local_dir=excluded.local_dir, remote_url=excluded.remote_url, updatedAt=excluded.updatedAt`)
            .run(id, name.trim(), body.private ? 1 : 0, localDir, remoteUrl, now(), now())
          const count = db.prepare('SELECT COUNT(*) AS c FROM roster WHERE scope = ?').get(id).c
          audit(by, scope, existed ? 'space:update' : 'space:create', null, { space: id, name: name.trim(), private: !!body.private, localDir, remoteUrl })
          return { id, name: name.trim(), private: !!body.private, localDir, remoteUrl, agentCount: count }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/pipeline',
      async run(req, res) {
        // SP-P0：写入空间流水线（阶段契约 + 执行配置）。整批 upsert（含删除未提交的旧阶段）。
        // 校验在写入期完成：role 形状/唯一性、next 可达、gate 必须有 artifact、docs 必须是仓库相对路径。
        // 编队与流水线的一致性**不在此处硬拦**（便于先配流水线后选人入编），由 GET /api/spaces/provision 报给将军。
        await handleWrite(req, res, (body, by, scope) => {
          const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
          if (!SCOPE_KEY_RE.test(targetScope)) throw new Error('scope 非法（字母/数字/下划线/连字符，≤64 字符）')
          if (body.by !== 'general' && by !== 'general' && body.forceGeneral !== true) throw new Error('流水线配置仅允许 general 执行（body.by 或操作者身份须为 general）')
          const stages = normalizeStages(targetScope, body.stages)
          const runtime = body.runtime === undefined ? null : normalizeRuntime(body.runtime)
          const result = withTx(() => {
            const prevRoles = new Set(db.prepare('SELECT role FROM space_stages WHERE scope = ?').all(targetScope).map(r => r.role))
            const upsert = db.prepare(`INSERT INTO space_stages (scope, role, label, prompt, next, gate, artifact, docs, sort, enabled, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope, role) DO UPDATE SET label=excluded.label, prompt=excluded.prompt, next=excluded.next,
                gate=excluded.gate, artifact=excluded.artifact, docs=excluded.docs, sort=excluded.sort, enabled=excluded.enabled, updatedAt=excluded.updatedAt`)
            const ts = now()
            for (const s of stages) {
              upsert.run(targetScope, s.role, s.label, s.prompt, s.next, s.gate, s.artifact, s.docs === null ? null : JSON.stringify(s.docs), s.sort, s.enabled, ts)
            }
            const keep = stages.map(s => s.role)
            const dropped = [...prevRoles].filter(r => !keep.includes(r))
            if (dropped.length > 0) {
              const del = db.prepare('DELETE FROM space_stages WHERE scope = ? AND role = ?')
              for (const r of dropped) del.run(targetScope, r)
            }
            if (runtime !== null) {
              db.prepare(`INSERT INTO space_runtime (scope, enabled, maxWorkers, isolate, updatedAt) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, maxWorkers=excluded.maxWorkers, isolate=excluded.isolate, updatedAt=excluded.updatedAt`)
                .run(targetScope, runtime.enabled ? 1 : 0, runtime.maxWorkers, runtime.isolate ? 1 : 0, ts)
            }
            audit(by, targetScope, 'pipeline:update', null, {
              stages: stages.length,
              added: stages.filter(s => !prevRoles.has(s.role)).map(s => s.role),
              dropped,
              runtime,
            })
            return { scope: targetScope, stages: stages.length, dropped, added: stages.filter(s => !prevRoles.has(s.role)).length, runtime }
          })
          const view = readPipeline(targetScope)
          return { ...result, version: view.version, activeRoles: view.activeRoles, warnings: pipelineWarnings(targetScope, view) }
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
    id: 'space-config',
    routes,
    /** 2 条；顺序与 `handle` 里原来那 2 条 `if` 相同。 */
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
