import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('./server.mjs?security=' + Date.now())

describe('team-hub 安全监听配置', () => {
  it('默认回环地址允许本地无 token 开发模式', () => {
    assert.deepEqual(mod.validateSecurityConfig({ host: '127.0.0.1', token: '' }), {
      host: '127.0.0.1', authenticated: false,
    })
  })

  it('非回环监听没有 token 时拒绝启动', () => {
    assert.throws(() => mod.validateSecurityConfig({ host: '0.0.0.0', token: '' }), /TEAM_HUB_TOKEN/)
  })

  it('非回环监听配置 token 后允许启动', () => {
    assert.deepEqual(mod.validateSecurityConfig({ host: '0.0.0.0', token: 'secret' }), {
      host: '0.0.0.0', authenticated: true,
    })
  })
})

describe('team-hub 读面鉴权决策（P2-2）', () => {
  it('本地回环 + 无 token → 读面开放（开发模式不回退）', () => {
    assert.equal(mod.readAuthRequired({ host: '127.0.0.1', token: '' }), false)
    assert.equal(mod.readAuthRequired({ host: 'localhost', token: '' }), false)
    assert.equal(mod.readAuthRequired({ host: '::1', token: '' }), false)
  })

  it('本地回环 + 已配 token → 读面仍开放（仅写面按 token 门禁，既有语义不变）', () => {
    assert.equal(mod.readAuthRequired({ host: '127.0.0.1', token: 'secret' }), false)
  })

  it('远程监听 + 已配 token → 读面必须鉴权', () => {
    assert.equal(mod.readAuthRequired({ host: '0.0.0.0', token: 'secret' }), true)
    assert.equal(mod.readAuthRequired({ host: '10.0.0.5', token: 'secret' }), true)
    assert.equal(mod.isLoopbackHost('0.0.0.0'), false)
    assert.equal(mod.isLoopbackHost('localhost'), true)
  })
})

try { mod.db?.close() } catch { /* test cleanup */ }
