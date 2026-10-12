// team-hub/routes/model-materialization.mjs
// ============================================================================
// 物化读数那一族：**"打开写入会改 DSH 的什么"**（P2→P3 的放行读数）。
//
//   `POST /api/model-materialization/reading`  插件上报（只读方向：中枢是收方）
//   `GET  /api/model-materialization`          面板/命令读最后一份
//
// ## 为什么需要这一族（实测抓到的）
//
// 将军问"这个密钥库意义是什么"之后要打开"配置写进 DSH"。打开之前我先去算
// **会改什么** —— 而它只活在一行日志里，并且那份日志是**乱码**：
//
//     [2026-10-12T08:20:02Z] 供应商影子对账：新增 0 / 修改 3 / 删除 0 / 未变 1（clean=false）
//
// 只有计数、没有"改哪几个字段"。决策文档 P2→P3 的放行条件恰恰是
// **"连续几轮 diff 为空"** —— 一个看不见的 diff 没法用来放行。
//
// ## 两读口径与鉴权
//
// `POST` 要**令牌**（它是外部进程往中枢写状态，与 `?includeSecretRefs=1` 同一条纪律）；
// `GET` 只要本机可达 —— 它读的是**计数与字段名**，**不含任何值**
// （`plan` 本来就是 `{id, fields[]}` 的形状，没有密钥、没有地址之外的敏感内容）。
// ============================================================================

/**
 * @param {object} deps
 * @param {Function} deps.json     写 JSON 响应的注入件（属于 server.mjs）
 * @param {Function} deps.handleRun 带鉴权与错误映射的包装（属于 server.mjs）
 * @param {object} deps.reading    `createMaterializationReadingStore(...)` 的返回值
 * @param {Function} deps.authorized 机器令牌判定（省略时 POST 一律拒绝）
 */
export function createModelMaterializationRoutes({ json, handleRun, reading, authorized = null }) {
  if (reading === null || reading === undefined) throw new TypeError('createModelMaterializationRoutes 需要 reading')

  return {
    id: 'model-materialization',
    routes: [
      {
        method: 'GET',
        match: 'exact',
        path: '/api/model-materialization',
        async run(req, res) {
          const r = reading.get({})
          // ⚠ 第一个参数是 `res` —— 第一版写成了 `json(null, 200, …)`，
          //   于是这一条路由**看起来注册了**（`POST` 的校验报错正常），
          //   而所有**读**它的用例一起红。注入件的参数位置错了不会抛异常，
          //   只会把响应写到一个不存在的对象上。
          json(res, 200, { ok: true, ...r })
        },
      },
      {
        method: 'POST',
        match: 'exact',
        path: '/api/model-materialization/reading',
        async run(req, res, ctx) {
          // 与 `?includeSecretRefs=1` 同一条：外部进程要往中枢写状态，必须过令牌。
          if (typeof authorized !== 'function' || authorized(req) !== true) {
            json(res, 403, {
              ok: false, code: 'READING_REQUIRES_TOKEN',
              error: '上报物化读数需要令牌：它是外部进程写中枢状态，不是公开只读数据',
            })
            return
          }
          await handleRun(req, res, async (body) => {
            const stored = reading.record(body)
            return { ok: true, at: stored.at }
          })
        },
      },
    ],
    /** 2 条；顺序与上面一致。 */
    async dispatch(req, res, ctx) {
      for (const r of this.routes) {
        if (req.method !== r.method || ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
