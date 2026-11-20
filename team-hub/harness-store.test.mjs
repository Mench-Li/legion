// team-hub/harness-store.test.mjs
// ============================================================================
// 执行节点的**声明 vs 观测**（BUG-050-a）。
//
// ## 现场（2026-11-20，本机，personal-profile 空间）
//
//   11:25 守护自注册节点，把当时读到的能力冻结成「声明」：
//         providers ["spawn","fork"] + structuredOutput/cancellation true
//   之后每次启动 DSH 的子 Agent 注册表都读成空 ⇒ 心跳「观测」：
//         providers [] + 各能力 false
//   ⇒ 声明 ⊄ 观测 ⇒ 节点**永久** `incompatible` ⇒ 认领 409
//     「执行节点未注册或未就绪：desktop-personal-profile (incompatible)」
//   ⇒ 界面只显示"待认领"，4 条链任务一动不动。
//
// 这一组钉住三件事：
//   ① 自注册节点在漂移时**自动降级声明**（只降不升），降完当场 ready；
//   ② 人手登记的节点**一律不动**（那是人的意图，心跳无权改写）；
//   ③ 状态理由必须写出**差在哪一项**，而不是三个字母 `incompatible`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createHarnessStore } from './harness-store.mjs'

const CAPS_FULL = { isolatedWorktree: true, externalAgent: false, structuredOutput: true, toolFilter: false, cancellation: true }
const CAPS_OBSERVED = { isolatedWorktree: true, externalAgent: false, structuredOutput: false, toolFilter: false, cancellation: false }

const withStore = (mutate) => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = createHarnessStore({ db })
    return mutate({ db, store })
  } finally {
    try { db.close() } catch { /* 已关 */ }
  }
}

const node = (store, id, scope = 'personal-profile') => store.listAgentNodeConfigs({ scope }).find((item) => item.id === id)

test('① ★★★ 自注册节点：声明与观测不一致时**自动降级**，降完当场 ready（只降不升）', () => withStore(({ store }) => {
  const created = store.putAgentNodeConfig({
    id: 'desktop-personal-profile', label: 'soldier-auto@personal-profile（守护自注册）', scope: 'personal-profile',
    providerNames: ['spawn', 'fork'], capabilities: CAPS_FULL, selfRegistered: true, nowMs: 1000,
  })
  assert.equal(created.selfRegistered, true, '★ 自注册标记必须落库（自愈的唯一前提）')
  assert.equal(created.version, 1)

  const healed = store.heartbeatAgentNode({
    id: 'desktop-personal-profile', scope: 'personal-profile',
    providerNames: [], capabilities: CAPS_OBSERVED, nowMs: 2000,
  })

  assert.equal(healed.status, 'ready', '★★★ 降级之后必须当场 ready —— 否则认领永远 409')
  assert.deepEqual(healed.providerNames, [], '★★ 声明降到观测：观测里没有 spawn/fork，声明里就不该留着')
  assert.equal(healed.capabilities.structuredOutput, false, '★★ 只降不升：观测不到的能力位降为 false')
  assert.equal(healed.capabilities.isolatedWorktree, true, '★ 观测得到的能力位保留')
  assert.equal(healed.version, 2, '★ 一次自动改写 = 版本 +1（可追溯）')
  assert.deepEqual(healed.selfHealed?.providers, ['spawn', 'fork'], '★★ 响应里要写清"降了什么"（守护据此打日志）')
  assert.deepEqual(healed.selfHealed?.capabilities, ['structuredOutput', 'cancellation'])

  // 再心跳一次：已经一致了，**不该**继续刷版本（否则版本每 30 秒涨一次）
  const again = store.heartbeatAgentNode({
    id: 'desktop-personal-profile', scope: 'personal-profile',
    providerNames: [], capabilities: CAPS_OBSERVED, nowMs: 3000,
  })
  assert.equal(again.version, 2, '★★ 已一致时不刷版本（幂等）')
  assert.equal(again.selfHealed, undefined)
}))

test('② ★★★ 观测**变多**时不动声明（只降不升：升是人的决定）', () => withStore(({ store }) => {
  store.putAgentNodeConfig({
    id: 'n1', label: '自注册', scope: 'ozon',
    providerNames: [], capabilities: CAPS_OBSERVED, selfRegistered: true, nowMs: 1000,
  })
  const seen = store.heartbeatAgentNode({
    id: 'n1', scope: 'ozon',
    providerNames: ['spawn', 'fork', 'codex'], capabilities: CAPS_FULL, nowMs: 2000,
  })
  assert.equal(seen.status, 'ready')
  assert.deepEqual(seen.providerNames, [], '★★ 观测到更多 provider 也不改声明')
  assert.equal(seen.version, 1, '★★ 版本不动')
  assert.equal(seen.capabilities.structuredOutput, false)
}))

test('③ ★★★ 人手登记的节点：同样的漂移**不许**被自动改写（保持 incompatible，说清差在哪）', () => withStore(({ store }) => {
  store.putAgentNodeConfig({
    id: 'human-node', label: '人手登记（由将军填写）', scope: 'software',
    providerNames: ['spawn', 'fork'], capabilities: CAPS_FULL, selfRegistered: false, nowMs: 1000,
  })
  const observed = store.heartbeatAgentNode({
    id: 'human-node', scope: 'software',
    providerNames: [], capabilities: CAPS_OBSERVED, nowMs: 2000,
  })
  assert.equal(observed.status, 'incompatible', '★ 人的声明不被心跳改写 —— 宁可红，也不悄悄降级')
  assert.equal(observed.version, 1, '★★ 版本不动')
  assert.deepEqual(observed.providerNames, ['spawn', 'fork'])
  assert.equal(observed.selfHealed, undefined)
  // ★ 但**理由**必须说清差在哪几项（从前只有三个字母 incompatible）
  assert.match(String(observed.statusReason), /provider\[spawn、fork\]/)
  assert.match(String(observed.statusReason), /能力\[structuredOutput、cancellation\]/)
}))

test('④ ★★ statusReason 的三种非 ready 各说各的话（不许挤成一句话）', () => withStore(({ store }) => {
  const created = store.putAgentNodeConfig({
    id: 'n2', label: 'x', scope: 'ozon',
    providerNames: ['spawn'], capabilities: CAPS_OBSERVED, selfRegistered: false, nowMs: 1000,
  })
  // 从未心跳 ⇒ unknown
  const unknown = node(store, 'n2', 'ozon')
  assert.equal(unknown.status, 'unknown')
  assert.match(String(unknown.statusReason), /从未上报/)

  // 心跳过期（61 秒前）⇒ offline
  store.heartbeatAgentNode({ id: 'n2', scope: 'ozon', providerNames: ['spawn'], capabilities: CAPS_OBSERVED, nowMs: 1000 })
  const offline = node(store, 'n2', 'ozon')
  assert.notEqual(created, null)
  assert.equal(offline.status, 'offline', 'nowMs 默认是现在，1000ms 的心跳必然过期')
  assert.match(String(offline.statusReason), /心跳过期|版本\/空间不符/)

  // 停用 ⇒ disabled
  store.putAgentNodeConfig({ id: 'n3', label: 'y', scope: 'ozon', providerNames: [], capabilities: CAPS_OBSERVED, enabled: false, nowMs: 1000 })
  const disabled = store.listAgentNodeConfigs({ scope: 'ozon', includeDisabled: true }).find((item) => item.id === 'n3')
  assert.equal(disabled.status, 'disabled')
  assert.match(String(disabled.statusReason), /停用/)
}))
