// runtime/adapters/dsh/subagent-start-unregistered.test.mjs
// ============================================================================
// BUG-050-b：provider **不在册** 时必须是一句具名错误，而不是 DSH 内部的 TypeError。
//
// 现场（2026-11-20 本机）：
//   那次启动后 DSH 的子 Agent 注册表读成空（`注册表 provider=[]`），而守护照旧按
//   `config.provider`（`spawn`）派工 ⇒ DSH 内部抛
//
//       T-312 派工失败：TypeError: Cannot read properties of undefined (reading 'id')
//
//   这句话既不指名 provider、也不说"本机有哪些"，还看不出根因是"注册表空了"；
//   任务连试三次后被置 blocked，全链路唯一的线索就是它。
//
//   > 一个"provider 不在册"的失败，
//   > 与一个"provider 内部崩溃"的失败，在 TypeError 面前是同一句话 ——
//   > 而它们的修法完全不同。
//
// 运行：node --test runtime/adapters/dsh/subagent-start-unregistered.test.mjs
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { startChildAgent } from './subagent-start.mjs'

const request = { label: 'scrum:T-312', prompt: [{ type: 'text', text: 'hi' }], parent: {} }

/** 一个"服务在、注册表为空"的运行期（实测那次启动的形状）。 */
const emptyRegistry = (log = []) => ({
  list: () => [],
  getProvider: () => undefined,
  async startActivation(spec) {
    log.push(spec)
    // DSH 在真实实现里就是在这一层读 undefined 的属性 —— 我们不该走到这里。
    return { childId: 'never', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
  },
})

/** 一个"注册表里有 spawn"的运行期。 */
const withSpawn = (log = []) => ({
  list: () => ['spawn', 'fork'],
  getProvider: (name) => (name === 'spawn' ? { id: 'spawn', capabilities: {} } : undefined),
  async startActivation(spec) {
    log.push(spec)
    return { childId: 'child-1', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
  },
})

test('① ★★★ provider 不在册 ⇒ 抛具名错误（指名 provider + 列出本机已注册），且**不进入** DSH 内部', async () => {
  const log = []
  const runtime = emptyRegistry(log)
  await assert.rejects(
    () => startChildAgent(runtime, 'spawn', request),
    (error) => {
      assert.match(String(error.message), /SUBAGENT_PROVIDER_UNREGISTERED: spawn/,
        '★★ 必须指名是哪个 provider 不在册（不是 TypeError）')
      assert.match(String(error.message), /（空 —— 一个 provider 都没有/, '★★ 还要说清"注册表是空的"（这正是本次现场）')
      assert.equal(error.code, 'SUBAGENT_PROVIDER_UNREGISTERED', '★ 带上稳定码，供错误分类器使用')
      return true
    },
  )
  assert.equal(log.length, 0, '★★ 一次都不该真的去启动 —— 那才是 TypeError 的来源')
})

test('② ★★ provider 在册 ⇒ 照常启动（判据不许误杀）', async () => {
  const log = []
  const run = await startChildAgent(withSpawn(log), 'spawn', request)
  assert.equal(run.id, 'child-1')
  assert.equal(log.length, 1)
  assert.equal(log[0].provider, 'spawn')
})

test('③ ★★ 注册表里**有别的** provider 但缺这一个 ⇒ 错误里把那几个名字列出来（"本机有什么"是修法的依据）', async () => {
  const runtime = {
    list: () => ['fork', 'codex'],
    getProvider: () => undefined,
    async startActivation() { throw new Error('should not be called') },
  }
  await assert.rejects(() => startChildAgent(runtime, 'spawn', request), (error) => {
    assert.match(String(error.message), /已注册：fork、codex/)
    return true
  })
})

test('④ ★★ 运行期**不支持**查询时不编造失败（旧版服务没有 getProvider ⇒ 保持既有行为）', async () => {
  const log = []
  const legacy = {
    async start(name, spec) {
      log.push({ name, spec })
      return { id: 'legacy-1', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
    },
  }
  const run = await startChildAgent(legacy, 'spawn', request)
  assert.equal(run.id, 'legacy-1', '★ 查不了就别拦：宁可让它按老路走，也不许凭"查不到"判它不在册')
  assert.equal(log.length, 1)
})
