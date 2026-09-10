import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { childLogFile, isSupervisor, planSpaceRunners, statusFileNames } from '../lib/index.js'

/**
 * SP-P1 多空间编排：监督者的**决策**是纯函数，这里逐条钉住它的边界。
 * 覆盖：单空间兼容（scopes 缺省）、白名单/auto、未开通执行、无数据面流水线、执行配置下发、
 *      子实例不再递归监督、状态文件与日志文件的按空间分文件。
 */

function config(overrides = {}) {
  return {
    role: 'soldier-auto', intervalMs: 30_000, maxWorkers: 1, workerTimeoutMs: 60_000,
    staleMinutes: 40, taskTtlMinutes: 0, provider: 'spawn', scrumDir: 'D:/scrum',
    workspace: 'D:/w', isolate: true, repoRoot: 'D:/repo', worktreeRoot: '', denyTools: [],
    rolesFile: 'D:/repo/roles.json', logFile: 'C:/logs/worker.log',
    hubUrl: 'http://127.0.0.1:8787', hubToken: '', scope: 'software', agentPreset: 'code',
    ...overrides,
  }
}

const space = (id, { enabled = true, stages = 6, maxWorkers, isolate } = {}) => ({
  id, enabled, stages, ...(maxWorkers === undefined ? {} : { maxWorkers }), ...(isolate === undefined ? {} : { isolate }),
})

test('TC-SP-P1-01 scopes 缺省 = 单空间模式：不做任何编排（P1 之前的既有行为逐字不变）', () => {
  assert.deepEqual(planSpaceRunners(config(), [space('software'), space('ozon')]), [])
  assert.deepEqual(planSpaceRunners(config({ scopes: undefined }), [space('ozon')]), [])
})

test('TC-SP-P1-02 scopes=auto → 接管全部「已开通且已配流水线」的空间', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software'), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['software', 'ozon'])
})

test('TC-SP-P1-03 白名单只接管列出的空间（顺序按数据面返回顺序）', () => {
  const runners = planSpaceRunners(config({ scopes: ['ozon'] }), [space('software'), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-04 space_runtime.enabled=false → 不接管（P1 执行开关的依据）', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software', { enabled: false }), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-05 数据面无流水线（0 环）→ 不接管：避免退化成单角色认领任意 todo', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software', { stages: 0 }), space('ozon', { stages: 6 })])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-06 数据面执行配置下发到子实例：maxWorkers/isolate 覆盖部署面默认值', () => {
  const [only] = planSpaceRunners(config({ scopes: 'auto', maxWorkers: 2, isolate: true }), [space('ozon', { maxWorkers: 1, isolate: false })])
  assert.equal(only.scope, 'ozon')
  assert.equal(only.maxWorkers, 1)
  assert.equal(only.isolate, false)
  // 数据面没给的值 → 保留部署面
  const [kept] = planSpaceRunners(config({ scopes: 'auto', maxWorkers: 3, isolate: false }), [space('ozon')])
  assert.equal(kept.maxWorkers, 3)
  assert.equal(kept.isolate, false)
})

test('TC-SP-P1-07 子实例退回单空间模式，且不继承父 rolesFile（多空间共用一个文件会串味）', () => {
  const [child] = planSpaceRunners(config({ scopes: 'auto' }), [space('ozon')])
  assert.equal(child.scopes, 'off', '子实例必须退回单空间模式，否则无限递归')
  assert.equal(child.rolesFile, '', '数据面才是流水线来源；子实例不吃父的部署面文件')
})

test('TC-SP-P1-08 子实例日志分文件（多空间共用一份日志会互相淹没）', () => {
  const [child] = planSpaceRunners(config({ scopes: 'auto' }), [space('ozon')])
  assert.equal(child.logFile, 'C:/logs/worker-ozon.log')
  assert.equal(childLogFile('', 'ozon'), '', '未配日志（空串）保持空串 → 子实例沿用默认路径')
  assert.equal(childLogFile('C:/logs/w', 'ozon'), 'C:/logs/w-ozon', '无扩展名时直接追加后缀')
  assert.equal(childLogFile('C:/logs/w.log', 'a/b'), 'C:/logs/w-a_b.log', 'scope 里的非法字符转下划线')
})

test('TC-SP-P1-09 状态文件：主 scope 继续维护 daemon.json（看板/健康页兼容），其余空间只写 per-scope', () => {
  assert.deepEqual(statusFileNames('software', undefined), ['daemon.json', 'daemon-software.json'], '单空间部署：行为与 P1 之前兼容')
  assert.deepEqual(statusFileNames('software', ''), ['daemon.json', 'daemon-software.json'], '空串 = 本实例即主（单空间部署默认值）')
  assert.deepEqual(statusFileNames('software', 'software'), ['daemon.json', 'daemon-software.json'])
  assert.deepEqual(statusFileNames('ozon', 'software'), ['daemon-ozon.json'], '非主空间不得抢写 daemon.json')
})

test('TC-SP-P1-10 主 scope 归属：父 scope 在接管集合内归父；否则第一个空间顶上（daemon.json 不能没人写）', () => {
  const own = planSpaceRunners(config({ scopes: 'auto', scope: 'software' }), [space('software'), space('ozon')])
  assert.deepEqual(own.map(c => c.primaryScope), ['software', 'software'])

  const fallback = planSpaceRunners(config({ scopes: 'auto', scope: 'legacy' }), [space('software'), space('ozon')])
  assert.deepEqual(fallback.map(c => c.primaryScope), ['software', 'software'], '父 scope 未被接管 → 第一个空间顶上')
  const files = fallback.map(c => statusFileNames(c.scope, c.primaryScope))
  assert.deepEqual(files, [['daemon.json', 'daemon-software.json'], ['daemon-ozon.json']])
})

test('TC-SP-P1-11 监督者判定：缺省/off = 单空间（未校验的手工配置不炸），数组或 auto = 监督者', () => {
  assert.equal(isSupervisor(config()), false, '缺省 scopes（手工构造配置）必须按单空间处理')
  assert.equal(isSupervisor(config({ scopes: 'off' })), false)
  assert.equal(isSupervisor(config({ scopes: 'auto' })), true)
  assert.equal(isSupervisor(config({ scopes: ['ozon'] })), true)
})
