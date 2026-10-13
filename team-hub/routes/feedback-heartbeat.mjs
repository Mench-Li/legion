// team-hub/routes/feedback-heartbeat.mjs
// ============================================================================
// 路由层第 42 族：**用户反馈的独立读端点（PRT-404，含跨空间越权防线）与 worker 心跳** —— PRT-316 切片 44
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 42 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show b8b9172:team-hub/server.mjs` 的 这一段区间（显式路径表）。
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
//
// ⚠ 2026-10-13 一处**有意**的偏离：`/api/heartbeat` 现在 import 了纯校验器
//   `../provider-readiness.mjs`（无 db、无路由、无 hub 内部件），用于校验心跳里
//   新增的 provider 就绪度字段。这与 `agent-intake.mjs` import `../agent-avatars.mjs`
//   是同一个先例。改这一行的理由见下面 `/api/heartbeat` 的注释。
// ============================================================================
import { parseProfileName, serializeProviderReadiness } from '../provider-readiness.mjs'

/**
 * 造用户反馈的独立读端点（PRT-404，含跨空间越权防线）与 worker 心跳族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createFeedbackHeartbeatRoutes({
  json,
  db, parseJson, handleWrite,
  touchMember,
}) {
  const deps = { json,
    db, parseJson, handleWrite,
    touchMember,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createFeedbackHeartbeatRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/task-feedback',
      async run(req, res, { url }) {
        // PRT-404：用户反馈的**独立读端点**。
        //
        // 为什么不是"读 /api/task 然后自己挑"：`/api/task` 回来的是整行任务，
        // 里面有几个不同性质的批注列（comments / evidence / feedback）。
        // 让每个消费者自己去挑，等于把"哪一列是用户反馈"这件事复制到每个读点——
        // 而 PRT-404 全部的意义就是让它**只有一个答案**。
        //
        //   > 一个"从任务行里自己挑反馈"的读法，
        //   > 与一个"问专门那个端点"的读法，在只有一种批注的时候是同一个东西——
        //   > 只不过前者会在有人忘了挑、顺手把 `comments` 也当反馈时，
        //   > 把"同事说了一句话"读成"用户要求调整"。
        const askId = url.searchParams.get('taskId')
        if (askId === null || askId.trim() === '') {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少参数 taskId', serverTimeMs: Date.now() })
          return
        }
        const scopeParam = url.searchParams.get('scope')
        const task = db.prepare('SELECT id, scope, feedback FROM tasks WHERE id = ?').get(askId.trim())
        if (task === undefined || task === null) {
          // 404 而不是 `{feedback: []}`：**"任务不存在"与"这个任务没有反馈"是两件事**，
          // 而一个空数组会让两者在调用方那里长得一样。装配器把 404 翻成 `null`，
          // 再由 `sources.mjs` 决定这是不是致命。
          json(res, 404, {
            ok: false,
            code: 'TASK_NOT_FOUND',
            error: `任务 ${askId.trim()} 不存在`,
            serverTimeMs: Date.now(),
          })
          return
        }
        // 空间必须对得上：任务 id 是全库唯一的，但拿别空间的 id 来问
        // 仍然是一次越权读取（装配是**按空间**做的）。调用方给了 scope 就校验。
        if (scopeParam !== null && scopeParam.trim() !== '' && task.scope !== scopeParam.trim()) {
          json(res, 404, {
            ok: false,
            code: 'TASK_NOT_FOUND',
            error: `任务 ${askId.trim()} 不在空间 ${scopeParam.trim()} 里`,
            serverTimeMs: Date.now(),
          })
          return
        }
        const feedback = parseJson(task.feedback, [])
        json(res, 200, { ok: true, taskId: task.id, count: feedback.length, feedback, serverTimeMs: Date.now() })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/heartbeat',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          // S2/R-1（决策 B1）：kind=worker 的心跳可附带 model {provider,model}（守护当前选用模型），
          // 供 GET /api/chat/health 的模型解析链聚合展示（members.model 列，可空）。
          const m = body?.model && typeof body.model === 'object' && body.model !== null ? body.model : null
          const modelText = m && (typeof m.model === 'string' || typeof m.provider === 'string')
            ? JSON.stringify({ provider: typeof m.provider === 'string' ? m.provider : '', model: typeof m.model === 'string' ? m.model : '' })
            : undefined
          // ★★ 2026-10-13：心跳可附带**本机 provider 就绪度**（装了没 / 登录了没 / 端点通不通），
          //    供工作流面板只读展示、取代让人手填 provider 名。
          //
          //    🔴 校验失败**只丢字段、不丢心跳**。心跳失败的代价是这台守护被标成离线
          //       （60 秒在线窗）——对话健康降级、任务不再派给它；而就绪度只是诊断信息，
          //       没有它一切照常。这两件事的代价差一个量级，不允许共命运：
          //
          //         一个坏掉的诊断字段，与一个坏掉的健康上报，
          //         在**字段总是合法**的时候是同一条路径 ——
          //         区别只在字段坏掉的那一刻：前者该少一行信息，后者会让整台机器"下线"。
          //
          //    缺失（旧守护不上报）是**合法**的，不是坏掉。
          let providersJson = null
          if (body?.providers !== undefined && body.providers !== null) {
            providersJson = serializeProviderReadiness(body.providers)
          }
          // ★ 2026-10-13：守护所属的 DSH profile 名。用它把"装上缺的 bundle"那条修法
          //   填成**真名**（`--profile` 必填，原来写的是字面占位符 ⇒ 粘了跑不了）；
          //   若它是 Desktop 独占的 profile，面板会**不给命令**而是指向界面 ——
          //   因为 DSH 明确拒绝 `dsh plugin --profile desktop …`。
          //   同一条纪律：不合法就当没上报，**不带崩心跳**。
          const profileName = parseProfileName(body?.profile)
          touchMember(by, scope, typeof body.kind === 'string' ? body.kind : 'unknown', modelText, providersJson, profileName)
          return { member: by, scope, online: true }
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
    id: 'feedback-heartbeat',
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
