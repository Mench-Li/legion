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

try { mod.db?.close() } catch { /* test cleanup */ }
