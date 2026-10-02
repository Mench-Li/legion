export function createAgentsRoutes({ service, json, authorized, readBody, requireMember, readScope }) {
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
        input={ ...body,by:requireMember(body),scope:readScope(body) }
      }
      const result=r.run(input)
      json(res,req.method==='POST' && path==='/api/agent-commands' && result.status==='queued' ? 202 : 200,{ ok:true,...result })
    } catch(e) { json(res,e.status ?? 400,{ ok:false,code:e.code ?? 'AGENT_REQUEST_FAILED',error:e.message }) }
    return true
  } }
}
