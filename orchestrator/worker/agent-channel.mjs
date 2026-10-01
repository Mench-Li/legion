/** Run-bound progress publication and cancellation. Transport failure never invents a terminal. */
export function createAgentRunChannel({ post, adapter, lease, runId, intervalMs = 2000, requestTimeoutMs = 5000, onError = () => {} }) {
  let stopped=false, timer=null, active=null
  const pending=[], cancelled=new Set()
  async function tick() {
    if (stopped) return
    if (active) return active
    active=(async () => {
      const batch=pending.slice(0,100)
      try {
        const response=await post('/api/agent-runtime',{ by:lease.workerId,scope:lease.scope,workerId:lease.workerId,
          attemptId:lease.attemptId,leaseEpoch:lease.leaseEpoch,runId,events:batch },{ signal:AbortSignal.timeout(requestTimeoutMs) })
        if (response?.status !== 200 || response.body?.ok !== true) throw new Error(response?.body?.error ?? 'Agent channel unavailable')
        pending.splice(0,batch.length)
        for (const c of response.body.commands ?? []) {
          if (cancelled.has(c.id)) continue
          const result=await adapter.cancel(runId)
          // The first poll may precede execute(). An unseen run is not cancelled.
          if (!(result?.alreadyTerminal && !result?.terminalType)) cancelled.add(c.id)
        }
      } catch(e) { onError(e) }
    })().finally(() => { active=null })
    return active
  }
  return {
    async start() { await tick(); if (!stopped) { timer=setInterval(() => void tick(),intervalMs); timer.unref?.() } },
    observe(event) { if (event && event.runId===runId && Number.isSafeInteger(event.seq) && event.seq>0 && pending.length<5000) pending.push(event) },
    async stop() { clearInterval(timer); if (active) await active; await tick(); stopped=true },
    tick,
  }
}
