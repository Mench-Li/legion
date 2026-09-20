// team-hub/routes/web.mjs
// ============================================================================
// 路由层第 26 族：**浏览器助手抓取历史（入表/累加 + 读一版带统计 + 清一个或清一空间）** —— PRT-316 切片 27
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 26 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 6d50295:team-hub/server.mjs` 的 `/api/web` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 3 条的形态分布（生成器算的，不是抄的）
//
//   ×  3  `path === '…'`
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
// 3 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 3 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// P2-8①：浏览器助手抓取历史（按空间；serve.mjs 抓取后回写，前端读最近 N 条）。
// 语义：同 (scope,url) 只保留一行并累加 hits —— 历史是「抓过哪些地址、结果如何」，不是逐次流水
// （逐次审计已在 serve.mjs 的 web 审计 JSONL 里，两者分工不同，不重复记）。


/**
 * 造浏览器助手抓取历史（入表/累加 + 读一版带统计 + 清一个或清一空间）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createWebRoutes({
  json,
  db, readBody,
}) {
  const deps = { json,
    db, readBody,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createWebRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/web/history',
      async run(req, res, { url }) {
        const body = await readBody(req)
        const scope = String(body.scope ?? '').trim()
        const rawUrl = String(body.url ?? '').trim()
        if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
        if (!rawUrl) { json(res, 400, { error: '缺少 url' }); return }
        const now = new Date().toISOString()
        let host = ''
        try { host = new URL(rawUrl).host } catch { /* 非法 URL 也记：错误码本身就是历史的一部分 */ }
        const row = db.prepare('SELECT id, hits, createdAt FROM web_fetch_history WHERE scope = ? AND url = ?').get(scope, rawUrl)
        const errCode = body.errorCode == null ? null : String(body.errorCode)
        const fields = {
          finalUrl: body.finalUrl == null ? null : String(body.finalUrl),
          host,
          title: body.title == null ? null : String(body.title).slice(0, 300),
          excerpt: body.excerpt == null ? null : String(body.excerpt).slice(0, 500),
          status: Number.isFinite(Number(body.status)) ? Number(body.status) : null,
          bytes: Number.isFinite(Number(body.bytes)) ? Number(body.bytes) : null,
          ms: Number.isFinite(Number(body.ms)) ? Number(body.ms) : null,
          errorCode: errCode,
          cached: body.cached ? 1 : 0,
        }
        if (row) {
          db.prepare(`UPDATE web_fetch_history SET finalUrl = ?, host = ?, title = ?, excerpt = ?, status = ?,
                      bytes = ?, ms = ?, errorCode = ?, cached = ?, hits = hits + 1, updatedAt = ? WHERE id = ?`)
            .run(fields.finalUrl, fields.host, fields.title, fields.excerpt, fields.status, fields.bytes, fields.ms, fields.errorCode, fields.cached, now, row.id)
          json(res, 200, { ok: true, id: row.id, hits: row.hits + 1, updated: true })
          return
        }
        const id = 'wh_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
        db.prepare(`INSERT INTO web_fetch_history
                    (id, scope, url, finalUrl, host, title, excerpt, status, bytes, ms, errorCode, cached, hits, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(id, scope, rawUrl, fields.finalUrl, fields.host, fields.title, fields.excerpt, fields.status, fields.bytes, fields.ms, fields.errorCode, fields.cached, now, now)
        // 空间级容量上限：只保留每空间最近 N 条（防止长期使用把库撑大；被清理的地址下次抓取会重新入表）
        const overflow = Number(body.maxPerScope ?? 200)
        const cap = Number.isFinite(overflow) && overflow > 0 ? Math.min(overflow, 2000) : 200
        const count = db.prepare('SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
        let trimmed = 0
        if (count > cap) {
          trimmed = count - cap
          db.prepare(`DELETE FROM web_fetch_history WHERE scope = ? AND id IN (
                        SELECT id FROM web_fetch_history WHERE scope = ? ORDER BY updatedAt ASC LIMIT ?)`)
            .run(scope, scope, trimmed)
        }
        json(res, 200, { ok: true, id, hits: 1, updated: false, trimmed })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/web/history',
      async run(req, res, { url }) {
        const scope = url.searchParams.get('scope')
        if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 200)
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        let rows = db.prepare('SELECT * FROM web_fetch_history WHERE scope = ? ORDER BY updatedAt DESC LIMIT ?').all(scope, q ? 200 : limit)
        if (q) rows = rows.filter(r => String(r.url).toLowerCase().includes(q) || String(r.title ?? '').toLowerCase().includes(q)).slice(0, limit)
        const total = db.prepare('SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
        const failed = db.prepare("SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ? AND errorCode IS NOT NULL").get(scope).n
        const bytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
        json(res, 200, {
          scope,
          items: rows.map(r => ({
            id: r.id, url: r.url, finalUrl: r.finalUrl, host: r.host, title: r.title, excerpt: r.excerpt,
            status: r.status, bytes: r.bytes, ms: r.ms, errorCode: r.errorCode, cached: !!r.cached,
            hits: r.hits, createdAt: r.createdAt, updatedAt: r.updatedAt,
          })),
          stats: { total, failed, bytes, shown: rows.length },
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/web/history/clear',
      async run(req, res) {
        const body = await readBody(req)
        const scope = String(body.scope ?? '').trim()
        if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
        const id = body.id == null ? '' : String(body.id).trim()
        const removed = id
          ? db.prepare('DELETE FROM web_fetch_history WHERE scope = ? AND id = ?').run(scope, id).changes
          : db.prepare('DELETE FROM web_fetch_history WHERE scope = ?').run(scope).changes
        json(res, 200, { ok: true, removed })
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
    id: 'web',
    routes,
    /** 3 条；顺序与 `handle` 里原来那 3 条 `if` 相同。 */
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
