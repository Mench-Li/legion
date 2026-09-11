// product/launcher/ports.test.mjs
// ============================================================================
// PRT-703 端口冲突诊断的判据。
//
// 核心是**把两件事分开**：「我能不能绑」与「有没有人在听」。
// 用后者当前者会得到一个假绿：残留的旧实例占着端口，探针连得上，
// Launcher 于是宣布「已就绪」，而跑的是上一版程序。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { canBind, checkPorts, reserveEphemeralPort, somethingIsListening } from './ports.mjs'

function listenOn(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port, host, exclusive: true }, () => resolve({ server, port: server.address().port }))
  })
}

const close = (server) => new Promise((resolve) => server.close(() => resolve()))

test('canBind：空闲端口可绑；已被占用的端口报 PORT_IN_USE 且指出「有人在听」', async () => {
  const { server, port } = await listenOn()
  try {
    const busy = await canBind(port)
    assert.equal(busy.ok, false)
    assert.equal(busy.code, 'PORT_IN_USE')
    assert.match(busy.message, /占用/)
    assert.equal(await somethingIsListening(port), true, '占用者确实在监听')
  } finally {
    await close(server)
  }
  // 释放之后应当可绑
  const after = await canBind(port)
  assert.equal(after.ok, true)
  assert.equal(await somethingIsListening(port), false)
})

test('canBind：非法端口报 PORT_OUT_OF_RANGE，不做无意义的绑定尝试', async () => {
  const neg = await canBind(-1)
  assert.equal(neg.code, 'PORT_OUT_OF_RANGE')
  const big = await canBind(70000)
  assert.equal(big.code, 'PORT_OUT_OF_RANGE')
  assert.equal(await canBind(1.5).then((r) => r.code), 'PORT_OUT_OF_RANGE')
})

test('reserveEphemeralPort 返回的端口当下可绑（名字说明它只是「先问一下」）', async () => {
  const port = await reserveEphemeralPort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
  assert.equal((await canBind(port)).ok, true)
})

test('checkPorts：冲突诊断点名进程与端口，并携带「是否有人在听」', async () => {
  const { server, port } = await listenOn()
  try {
    const diags = await checkPorts([
      { key: 'team-hub', port, host: '127.0.0.1' },
      { key: 'workbench', port: 0, host: '127.0.0.1' },
      { key: 'orchestrator', port: null, host: null },
    ])
    assert.equal(diags.length, 1)
    const d = diags[0]
    assert.equal(d.severity, 'error')
    assert.equal(d.code, 'PORT_IN_USE')
    assert.equal(d.process, 'team-hub')
    assert.equal(d.port, port)
    assert.equal(d.portListening, true)
    assert.match(d.message, /关闭占用它的进程|配置另一个端口/)
  } finally {
    await close(server)
  }
})

test('checkPorts：同批两个进程申请同一端口 → PORT_CLAIMED_TWICE，且点名先申请者', async () => {
  // 关键：即使端口是空闲的，也必须报出来。`canBind` 探完就放开端口，
  // 因此「前一个已占用」在探测层面不存在——只有比对清单才能发现重复申请。
  const port = await reserveEphemeralPort()
  const diags = await checkPorts([
    { key: 'a', port, host: '127.0.0.1' },
    { key: 'b', port, host: '127.0.0.1' },
  ])
  assert.equal(diags.length, 1, '端口空闲时也必须报重复申请，否则会漏到「后启动者静默退出」')
  assert.equal(diags[0].code, 'PORT_CLAIMED_TWICE')
  assert.equal(diags[0].process, 'b')
  assert.match(diags[0].message, /与 a 申请了同一端口/)
  assert.match(diags[0].message, /静默退出/)
})

test('checkPorts：allowInUse 的进程被跳过（复用已有实例是显式决定，不是默认行为）', async () => {
  const { server, port } = await listenOn()
  try {
    const diags = await checkPorts([{ key: 'team-hub', port, host: '127.0.0.1' }], { allowInUse: ['team-hub'] })
    assert.deepEqual([...diags], [])
  } finally {
    await close(server)
  }
})
