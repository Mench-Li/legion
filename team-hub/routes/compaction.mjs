// team-hub/routes/compaction.mjs
// ============================================================================
// 路由层第 5 族：**上下文压缩（compaction）：只追加的原文 + CAS 摘要 + 有效上下文读数** —— PRT-316 切片 5
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 5 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show fd668ff:team-hub/server.mjs` 的 `/api/compaction/` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 生成器在切片 5 修正了一处**静默漏取**
//
// 切片 4 的生成器只认一种写法。切片 5 开工前普查发现 `handle` 里有 **4 种**形态，
// 旧版会静默跳过后面 48 条（旧版的自检只为"一条都没取到"准备，所以不会响）：
//
//   ×114  方法在前、`path ===`
//   × 33  **`path ===` 在前**、方法在后      ← 本族 5 条**全部**是这一种
//   × 10  方法在前、`path.startsWith`
//   ×  5  上面那条再 `&& path.endsWith`
//
//   > 一个"按前缀取族、却只认一种写法"的生成器，
//   > 与一个"把这一族搬走一半"的提交，在 `node --check` 通过时是同一个东西。
//
// ## 零注入改写
//
// 5 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造上下文压缩（compaction）：只追加的原文 + CAS 摘要 + 有效上下文读数族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createCompactionRoutes({
  json,
  handleRun, requireString, authorized,
  compactionStore,
}) {
  const deps = { json,
    handleRun, requireString, authorized,
    compactionStore,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createCompactionRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/compaction/messages',
      async run(req, res, { url }) {
        await handleRun(req, res, (body) => ({
          ok: true,
          message: compactionStore.appendMessage({
            sessionId: requireString(body, 'sessionId'),
            seq: body.seq,
            role: requireString(body, 'role'),
            content: typeof body.content === 'string' ? body.content : '',
          }),
        }))
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/compaction/summarize',
      async run(req, res, { url }) {
        await handleRun(req, res, (body) => compactionStore.proposeSummary({
          sessionId: requireString(body, 'sessionId'),
          coversFromSeq: body.coversFromSeq,
          coversToSeq: body.coversToSeq,
          summary: requireString(body, 'summary'),
          author: body.author ?? 'model',
          // `baseVersion` **原样透传，包括 `undefined`**：把它折叠成 `null`
          // 会让"我以为还没有摘要"与"我没传这个参数"变成同一件事，
          // 而后者是一个应该被报出来的调用错误（否则并发压缩会静默通过）。
          baseVersion: body.baseVersion === undefined ? null : body.baseVersion,
          createdBy: requireString(body, 'by'),
          reason: body.reason ?? null,
        }))
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/compaction/context',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
        const maxRaw = Number(url.searchParams.get('maxTokens'))
        try {
          const ctx = compactionStore.effectiveContext(sessionId, {
            maxTokens: Number.isSafeInteger(maxRaw) && maxRaw > 0 ? maxRaw : null,
          })
          json(res, 200, { ok: true, sessionId, ...ctx })
        } catch (e) {
          json(res, Number(e?.statusCode) || 400, { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code ?? 'COMPACTION_FAILED' })
        }
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/compaction/state',
      async run(req, res, { url }) {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, ...compactionStore.compactionState(sessionId) })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/compaction/summaries',
      async run(req, res, { url }) {
        // 版本史：**每个版本都可读**，因为"曾经有过一个更好的摘要"这件事
        // 只有在旧版还在的时候才能被证明。
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
        json(res, 200, { ok: true, sessionId, summaries: compactionStore.summariesOf(sessionId) })
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
    id: 'compaction',
    routes,
    /** 5 条；顺序与 `handle` 里原来那 5 条 `if` 相同。 */
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
