export function createAgentsRoutes({ service, json, authorized, readBody, requireMember, readScope, requireSpace = null }) {
  const routes = [
    { method:'GET',path:'/api/agents',run: (u) => ({ agents:service.list(u.searchParams.get('scope')) }) },
    { method:'GET',path:'/api/agent-detail',run: u => ({ agent:service.detail(u.searchParams.get('agentId'),u.searchParams.get('scope')) }) },
    { method:'GET',path:'/api/agent-commands',run:u => ({ command:service.getCommand(u.searchParams.get('commandId'),u.searchParams.get('scope')) }) },
    { method:'POST',path:'/api/agent-conversations',run: body => service.conversation(body) },
    { method:'POST',path:'/api/agent-messages',run:body => service.send(body) },
    { method:'POST',path:'/api/agent-commands',run:body => service.command(body) },
    { method:'POST',path:'/api/agent-read-cursors',run:body => service.read(body) },
    { method:'POST',path:'/api/agent-runtime',run:body => service.runtime(body) },
    { method:'POST',path:'/api/agent-questions',run:body => service.question(body) },
  ]
  return { id:'agents',routes,async dispatch(req,res,{ path,url }) {
    const r=routes.find(r => r.path===path && r.method===req.method)
    if (!r) return false
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
        input={ ...body,by:requireMember(body),scope }
      }
      const result=r.run(input)
      json(res,req.method==='POST' && path==='/api/agent-commands' && result.status==='queued' ? 202 : 200,{ ok:true,...result })
    } catch(e) { json(res,e.status ?? e.statusCode ?? 400,{ ok:false,code:e.code ?? 'AGENT_REQUEST_FAILED',error:e.message }) }
    return true
  } }
}
