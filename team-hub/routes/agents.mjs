export function createAgentsRoutes({ service, json, authorized, readBody, requireMember, readScope, requireSpace = null, requireQuota = null }) {
  const routes = [
    { method:'GET',path:'/api/agents',run: (u) => ({ agents:service.list(u.searchParams.get('scope')) }) },
    { method:'GET',path:'/api/agent-detail',run: u => ({ agent:service.detail(u.searchParams.get('agentId'),u.searchParams.get('scope')) }) },
    { method:'GET',path:'/api/agent-commands',run:u => ({ command:service.getCommand(u.searchParams.get('commandId'),u.searchParams.get('scope')) }) },
    { method:'POST',path:'/api/agent-conversations',run: body => service.conversation(body) },
    // ★ `quota: 'message'` 不是路由声明，是**策略声明**：这条路径每成功一次就
    //    往 `messages` 表插一行，所以它要过按账号的用量配额（见 server.mjs 的
    //    `requireAccountQuota` 与 DEPLOY.md §2.5）。
    //    放在路由表上而不是写在 `service.send` 里，是因为配额只该管**人**，
    //    而 `service.send` 与 Agent 自己的汇报共用底层写入。
    { method:'POST',path:'/api/agent-messages',run:body => service.send(body), quota:'message' },
    { method:'POST',path:'/api/agent-commands',run:body => service.command(body) },
    { method:'POST',path:'/api/agent-read-cursors',run:body => service.read(body) },
    { method:'POST',path:'/api/agent-runtime',run:body => service.runtime(body) },
    { method:'POST',path:'/api/agent-questions',run:body => service.question(body) },
  ]
  return { id:'agents',routes,async dispatch(req,res,{ path,url }) {
    const r=routes.find(r => r.path===path && r.method===req.method)
    if (!r) return false
    // ★★★ 2026-10-05（T-178）：`GET /api/agents` 是**两套契约共用的一条路径**，
    //   靠 `scope` 的有无分流：
    //     · `/api/agents?scope=<s>` —— 本族的空间内岗位清单（`service.list(scope)`）；
    //     · `/api/agents`（不带 scope）—— read-models 族的**全局智能体目录**
    //       （按 role 去重、把来源空间收进 `scopes`），workbench「配置编队」用它，
    //       契约见 `workbench/README.md:91-92` 与 `workbench/src/api.ts:340`。
    //
    //   两个族都声明了 `GET /api/agents`（见 `team-hub/routes/read-models.mjs:218`），
    //   而派发按**注册顺序**命中即返回 —— 本族排在 read-models 之前（`server.mjs:6786`
    //   vs `:6957`），于是那条目录请求**永远**被本族接走；`service.list` 对缺 scope
    //   抛 `required(scope,'scope')`，落到 catch 里变成 400：
    //
    //     > 一个「同一路径两族各实现一半、由注册顺序决定谁赢」的接线，
    //     > 与一个「前端那条不带 scope 的目录请求永远 400」的接线，
    //     > 在路由清单上长得一模一样 —— 清单按 (method,path) 去重，只留一行。
    //
    //   所以本族把**不带 scope** 的那一条**让出去**（返回 false，交给后面的族），
    //   带着 scope 的那一条仍归本族。全局鉴权在 `server.mjs:7091` 那一道，
    //   让出不会绕过认证。
    if (req.method === 'GET' && path === '/api/agents' && (url.searchParams.get('scope') ?? '').trim() === '') return false
    if (!authorized(req)) { json(res,401,{ ok:false,error:'未授权' }); return true }
    try {
      let input=url
      if (req.method==='POST') {
        const body=await readBody(req)
        const scope=readScope(body)
        // ★ **写路径的空间授权**。
        //
        // 远程门禁（`remote-auth.mjs` 那一层）只看得到 URL：
        // 它能给 `?scope=` 做空间判定，但 **POST 的 scope 在请求体里**，
        // 而门禁读不到 body —— 读了就把流消耗掉，路由再也拿不到。
        //
        // 于是门禁只回答了"你是谁"，没回答"你能不能碰这个空间"。
        // 不补这一道的话，任何登录用户只要在 body 里把 `scope` 换成别人的空间，
        // 就能往那个空间写消息、建会话、下命令——而设计文档 §13 要求
        // 「一个项目的 Agent 无权读取未授权项目」。
        //
        // 放在这里是因为**只有这里**同时具备三件事：已解析的 body、
        // 已注入的身份（`req.__legionUser`，由门禁在验证用户令牌后打上）、
        // 以及一个确定的失败出口。`requireSpace` 未注入时**不做判定**，
        // 与 `authorized` 在无 token 时的既有语义一致（远程通道未启用时不注册判定）。
        if (typeof requireSpace === 'function') requireSpace(req, scope)
        // ★ 按账号的用量配额。与 `requireSpace` 同样放在**解析完 body 之后** ——
        //   配额被拒时不该先白解析一遍正文（那本身就是一个便宜的放大点）。
        //   顺序：先空间授权（403），再配额（429）。反过来会把"你无权碰这个空间"
        //   说成"你建得太多了"，而那是两句完全不同的话。
        if (typeof r.quota === 'string' && typeof requireQuota === 'function') requireQuota(req, r.quota)
        input={ ...body,by:requireMember(body),scope }
      }
      const result=r.run(input)
      json(res,req.method==='POST' && path==='/api/agent-commands' && result.status==='queued' ? 202 : 200,{ ok:true,...result })
    } catch(e) {
      // ★ `Retry-After` 是 HTTP 语义的一部分，而配额/限速把它算出来了 ——
      //   不落到响应头上就等于让客户端自己猜一个重试间隔，
      //   而那正是配额最想避免的行为（它会让用户反复试，把窗口一直占住）。
      if (Number.isFinite(e?.retryAfterSec) && e.retryAfterSec > 0) {
        try { res.setHeader('retry-after', String(e.retryAfterSec)) } catch { /* 适配层没有 setHeader */ }
      }
      json(res,e.status ?? e.statusCode ?? 400,{ ok:false,code:e.code ?? 'AGENT_REQUEST_FAILED',error:e.message,...(Number.isFinite(e?.retryAfterSec) ? { retryAfterSec: e.retryAfterSec } : {}) })
    }
    return true
  } }
}
