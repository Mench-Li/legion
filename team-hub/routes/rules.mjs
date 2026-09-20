// team-hub/routes/rules.mjs
// ============================================================================
// 路由层第一族：**规范（rules）** —— PRT-316 第一片的另一半
//
// 缝在 `team-hub/router.mjs`，本文件是**第一个搬进那个家的人**。
//
// ## 为什么第一族挑 rules
//
// 因为"搬对了没有"这个问题，在本族上有一个**不用新写**的判据：
// `team-hub/rules.test.mjs`（7 例，走真实 HTTP：临时 `TEAM_HUB_DB` +
// dynamic import `server.mjs` + `listen(0)` + fetch），覆盖
// 新库建表 / 老库自动建表且存量无损 / 未设置的回读 / 保存后逐字回读 +
// audit + SSE 帧 / 四类 400 且零落库 / 边界 3000 字与 upsert / GET 不产生 audit。
//
//   > 一个"搬完之后需要新写一批用例才能证明没搬坏"的切片，
//   > 与一个"既有用例原样跑就是判据"的切片，在**没写那批用例**时是同一个东西——
//   > 只不过前者会把"还没验证"读成"已验证"。
//
// ## 逐字保留，且**没有一处注入改写**
//
// 两条路由的函数体与 `server.mjs` 原文（L8210-8224）**逐字节相同**（仅缩进不同）。
// 做法是刻意的：`json` / `handleWrite` / `validRuleScope` / `getRule` / `saveRule`
// 以及 `url` 全部从注入参数或 `ctx` 到达**同名**绑定，于是**没有任何一处需要改写**。
//
// 这一点让对拍可以是**逐行字面相等（忽略缩进）**，而不是"归一化之后相等"：
//
//   > 一份"归一化之后相等"的对拍，与一份"字面相等"的对拍，
//   > 在只跑一次的场景里是同一个东西——只不过前者的归一化规则**本身没人对拍**。
//
// 对拍脚本：`.worktrees/_prt-handoff/pair-rules-routes.mjs`。
//
// ## 本片**没有**搬走的部分（如实记下，免得下一片以为做完了）
//
// 域的四个绑定仍留在 `server.mjs`：`MAX_RULES_LEN`（L4006）、
// `validRuleScope`（L4009）、`getRule`（L4014）、`saveRule`（L4021）。
// 本片只搬**路由**。`server.mjs` 对这四个的 `export` 一字未动 ——
// 它们是 63 个导出面的一部分，动它们要单独一片。
// ============================================================================

/**
 * 造 rules 族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入（本模块不 import 任何 hub 内部件）
 * @param {Function} deps.json        `server.mjs` 的 json(res, code, obj)
 * @param {Function} deps.handleWrite `server.mjs` 的 handleWrite(req, res, fn)
 * @param {Function} deps.validRuleScope
 * @param {Function} deps.getRule
 * @param {Function} deps.saveRule
 */
export function createRulesRoutes({
  json, handleWrite, validRuleScope, getRule, saveRule,
}) {
  for (const [name, fn] of Object.entries({ json, handleWrite, validRuleScope, getRule, saveRule })) {
    if (typeof fn !== 'function') throw new TypeError(`createRulesRoutes 缺注入项：${name}`)
  }

  // ── 规范（rules）：GET/POST /api/rules（全局层维护；写走 handleWrite：by 必填 + audit rules:update + SSE）──
  const routes = [
    {
      method: 'GET',
      path: '/api/rules',
      async run(req, res, { url }) {
        try {
          const scopeParam = url.searchParams.get('scope') ?? 'global'
          if (!validRuleScope(scopeParam)) throw new Error('scope 非法：global 或小写字母/数字开头的空间 id')
          json(res, 200, { ok: true, rules: getRule(scopeParam) })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/rules',
      async run(req, res) {
        await handleWrite(req, res, (body, by) => saveRule({ scope: body.scope, content: body.content, by }))
      },
    },
  ]

  return {
    id: 'rules',
    routes,
    /**
     * 本族只认**等值**两条（GET/POST `/api/rules`）。
     * 顺序与 `handle` 里原来那两条 `if` 相同：先 GET 后 POST。
     */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
