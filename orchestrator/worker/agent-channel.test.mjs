import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRunChannel } from './agent-channel.mjs'

const lease={ workerId:'worker-a',scope:'s',attemptId:'a',leaseEpoch:2 }
test('failed transport retains events; duplicate cancellation deliveries execute once',async () => {
  let fails=true,cancels=0
  const bodies=[]
  const channel=createAgentRunChannel({ lease,runId:'r',adapter:{ async cancel() { cancels++;return { terminalType:'run.cancelled' } } },
    post:async (path,body) => { bodies.push(body);if (fails) throw Error('offline');return { status:200,body:{ ok:true,commands:[{ id:'c' }] } } } })
  channel.observe({ runId:'r',seq:1,type:'run.started' })
  channel.observe({ runId:'other',seq:2,type:'run.started' })
  await channel.tick();fails=false;await channel.tick();await channel.tick();await channel.stop()
  assert.equal(bodies[1].events.length,1)
  assert.equal(bodies[2].events.length,0)
  assert.equal(bodies[1].workerId,'worker-a')
  assert.equal(cancels,1)
})
test('cancel received before run starts is retried until runtime knows the run',async () => {
  let calls=0
  const channel=createAgentRunChannel({ lease,runId:'r',adapter:{ async cancel() { calls++;return { alreadyTerminal:true,terminalType:calls===1 ? null : 'run.cancelled' } } },
    post:async () => ({ status:200,body:{ ok:true,commands:[{ id:'c' }] } }) })
  await channel.tick();await channel.tick();await channel.tick();await channel.stop()
  assert.equal(calls,2)
})
test('stale lease rejection never calls runtime cancel',async () => {
  let cancels=0
  const channel=createAgentRunChannel({ lease,runId:'r',adapter:{ async cancel() { cancels++ } },
    post:async () => ({ status:409,body:{ ok:false,error:'stale lease' } }) })
  await channel.tick();await channel.stop();assert.equal(cancels,0)
})
