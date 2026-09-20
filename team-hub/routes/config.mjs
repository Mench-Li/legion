// team-hub/routes/config.mjs
// ============================================================================
// 路由层第 18 族：**能力发现（免鉴权探测：auth / db / port / runPlane / tokenizer / eventDelivery）** —— PRT-316 切片 19
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 18 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show b92dc6e:team-hub/server.mjs` 的 `/api/config` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 1 条的形态分布（生成器算的，不是抄的）
//
//   ×  1  `path === '…'`
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
// 1 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造能力发现（免鉴权探测：auth / db / port / runPlane / tokenizer / eventDelivery）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createConfigRoutes({
  json,
  TOKEN, DB_FILE, PORT,
  tokenizerRegistryStatus, eventClients,
  live,
}) {
  // ★★★ 活绑定（切片 19）：这几个名字在宿主里是 `let` 且会被重新赋值。
  //   按值注入只会拿到"接线那一刻"的快照 —— 之后宿主再怎么改，这里都是旧的，
  //   而这类错误 `node --check`、逐字对拍、自由标识符判据**全部看不见**。
  //   所以把它们提到工厂作用域，并在**每次请求**开头从 `live()` 重取一次：
  //   体里那几行**一字未改**，值却始终是新的，`router.mjs` 也一行没动。
  if (typeof live !== 'function') throw new TypeError('缺注入项：live（可变绑定需要每请求同步）')
  let deliveryBookkeepingFailures = live().deliveryBookkeepingFailures
  const syncLive = () => {
    const v = live()
    if (v.deliveryBookkeepingFailures === undefined || v.deliveryBookkeepingFailures === null) throw new TypeError(`live() 没给 deliveryBookkeepingFailures`)
    deliveryBookkeepingFailures = v.deliveryBookkeepingFailures
  }

  const deps = { json,
    TOKEN, DB_FILE, PORT,
    tokenizerRegistryStatus, eventClients,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createConfigRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/config',
      async run(req, res) {
        // `runPlane: true` 是能力发现位（PRT-301 起）：worker 用它判断「这个 hub 支不支持
        // 带 epoch 的运行面」。没有这个位时，一个升级了一半的部署（hub 还是旧的）
        // 会让 worker 收到 404，而 404 的文案无法区分「路由不存在」与「路径拼错」。
        //
        // PRT-413 加一栏 `tokenizer`：**"配了目录"与"真的用上了"是两件事**，
        // 而它们只在 `tokens.kind` 里分得开——那个字段没人会去看，除非已经超限。
        // 这里把它变成可探测的。★ `status()` **不读盘、不抛错**，
        // 所以这个免鉴权的探测端点不会因为一个坏词表目录而变慢或 500
        // （真正的读盘发生在第一次需要 tokenizer 时，失败会在那次请求上抛出）。
        //
        // F-05 加一栏 `eventDelivery`：投递记账是**旁路**，它的失败被刻意设计成
        // 不影响审计。一个被刻意设计成"不影响主流程"的失败，若没有任何地方能看见，
        // 就会永远没人知道——所以它必须在这里有一个读数。
        json(res, 200, {
          auth: TOKEN !== '', db: DB_FILE, port: PORT, runPlane: true,
          tokenizer: tokenizerRegistryStatus(),
          eventDelivery: {
            // 能力发现位：老客户端不认识它就不传 `clientId`，退化成匿名订阅者（不共用游标）。
            subscribers: true,
            bookkeepingFailures: deliveryBookkeepingFailures,
            liveConnections: eventClients.size,
          },
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
    id: 'config',
    routes,
    /** 1 条；顺序与 `handle` 里原来那 1 条 `if` 相同。 */
    async dispatch(req, res, ctx) {
      syncLive()
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
