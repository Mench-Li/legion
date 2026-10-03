// runtime/contracts/agent-workflow-definition.mjs
// Pure validation for reusable, versioned Agent workflow definitions.

import { validateWorkflowTestRunner } from './agent-workflow-test-runner.mjs'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function needName(value, label) {
  if (typeof value !== 'string' || !NAME.test(value.trim())) throw new TypeError(`${label} 格式无效`)
  return value.trim()
}

function needRef(value, label, optional = false) {
  if (value === null || value === undefined) {
    if (optional) return null
    throw new TypeError(`${label} 必须包含 id 与正整数 version`)
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须包含 id 与正整数 version`)
  return Object.freeze({ id: needName(value.id, `${label}.id`), version: positiveVersion(value.version, `${label}.version`) })
}

function positiveVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} 必须是正整数`)
  return value
}

function immutableJsonObject(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是 JSON 对象`)
  let clone
  try { clone = JSON.parse(JSON.stringify(value)) } catch { throw new TypeError(`${label} 必须可序列化为 JSON`) }
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
    return item
  }
  return freeze(clone)
}

/**
 * Validate and deeply freeze a reusable workflow definition.
 * `edges` describe the forward success graph and must form a DAG. Review
 * rework routes are separate because they create a new execution attempt and
 * intentionally return to an earlier stage.
 */
export function createAgentWorkflowDefinition({
  id,
  version,
  name,
  description = '',
  stages,
  edges,
  entryStageIds,
  terminalStageIds,
  reviewStageId,
  reviewRoutes = { implementation: 'implement', design: 'design' },
  maxReworkRounds = 3,
} = {}) {
  const definitionId = needName(id, 'workflow id')
  const definitionVersion = positiveVersion(version, 'workflow version')
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('workflow name 不能为空')
  if (typeof description !== 'string') throw new TypeError('workflow description 必须是字符串')
  if (!Array.isArray(stages) || stages.length < 2) throw new TypeError('workflow 至少需要两个阶段')
  if (!Array.isArray(edges)) throw new TypeError('workflow edges 必须是数组')
  if (!Array.isArray(entryStageIds) || entryStageIds.length === 0) throw new TypeError('workflow entryStageIds 必须是非空数组')
  if (!Array.isArray(terminalStageIds) || terminalStageIds.length === 0) throw new TypeError('workflow terminalStageIds 必须是非空数组')
  if (!Number.isSafeInteger(maxReworkRounds) || maxReworkRounds < 0 || maxReworkRounds > 100) {
    throw new TypeError('maxReworkRounds 必须是 0..100 的整数')
  }

  const normalizedStages = stages.map((stage, index) => {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) throw new TypeError(`阶段 ${index} 必须是对象`)
    const stageId = needName(stage.id, `阶段 ${index} id`)
    const role = needName(stage.role, `阶段 ${stageId} role`)
    const tool = needRef(stage.agentToolConfig, `阶段 ${stageId} agentToolConfig`)
    const model = needRef(stage.modelConfig, `阶段 ${stageId} modelConfig`, true)
    const nodeId = stage.nodeId == null || stage.nodeId === '' ? null : needName(stage.nodeId, `阶段 ${stageId} nodeId`)
    const testRunner = stage.testRunner == null ? null : validateWorkflowTestRunner(stage.testRunner)
    if (testRunner !== null && !testRunner.ok) throw new TypeError(`阶段 ${stageId} testRunner 无效：${testRunner.message}`)
    return Object.freeze({
      id: stageId,
      role,
      label: typeof stage.label === 'string' && stage.label.trim() ? stage.label.trim() : role,
      agentToolConfig: tool,
      modelConfig: model,
      nodeId,
      testRunner: testRunner?.value ?? null,
      inputContract: immutableJsonObject(stage.inputContract, `阶段 ${stageId} inputContract`),
      outputContract: immutableJsonObject(stage.outputContract, `阶段 ${stageId} outputContract`),
    })
  })
  const byId = new Map()
  for (const stage of normalizedStages) {
    if (byId.has(stage.id)) throw new TypeError(`阶段 id 重复：${stage.id}`)
    byId.set(stage.id, stage)
  }

  const normalizeStageSet = (values, label) => {
    const normalized = values.map((item) => needName(item, label))
    if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} 不得重复`)
    for (const stageId of normalized) if (!byId.has(stageId)) throw new TypeError(`${label} 引用未知阶段：${stageId}`)
    return Object.freeze(normalized)
  }
  const entries = normalizeStageSet(entryStageIds, 'entryStageIds')
  const terminals = normalizeStageSet(terminalStageIds, 'terminalStageIds')
  const normalizedEdges = edges.map((edge, index) => {
    if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError(`edge ${index} 必须是对象`)
    const from = needName(edge.from, `edge ${index}.from`)
    const to = needName(edge.to, `edge ${index}.to`)
    if (!byId.has(from) || !byId.has(to)) throw new TypeError(`edge ${index} 引用未知阶段`)
    if (from === to) throw new TypeError(`edge ${index} 不可连接阶段自身`)
    return Object.freeze({ from, to })
  })
  const edgeKeys = new Set()
  for (const edge of normalizedEdges) {
    const key = `${edge.from}\0${edge.to}`
    if (edgeKeys.has(key)) throw new TypeError(`工作流边重复：${edge.from} → ${edge.to}`)
    edgeKeys.add(key)
  }

  const incoming = new Map([...byId.keys()].map((stageId) => [stageId, 0]))
  const outgoing = new Map([...byId.keys()].map((stageId) => [stageId, []]))
  for (const edge of normalizedEdges) {
    incoming.set(edge.to, incoming.get(edge.to) + 1)
    outgoing.get(edge.from).push(edge.to)
  }
  for (const stageId of entries) if (incoming.get(stageId) !== 0) throw new TypeError(`入口阶段 ${stageId} 不得有入边`)
  for (const stage of normalizedStages) {
    if (!entries.includes(stage.id) && incoming.get(stage.id) === 0) throw new TypeError(`非入口阶段 ${stage.id} 必须有入边`)
    if (terminals.includes(stage.id) && outgoing.get(stage.id).length !== 0) throw new TypeError(`终止阶段 ${stage.id} 不得有出边`)
    if (!terminals.includes(stage.id) && outgoing.get(stage.id).length === 0) throw new TypeError(`非终止阶段 ${stage.id} 必须有出边`)
  }

  // Kahn's algorithm both rejects cycles and verifies every node is in the DAG.
  const remainingIncoming = new Map(incoming)
  const queue = [...byId.keys()].filter((stageId) => remainingIncoming.get(stageId) === 0)
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()
    visited += 1
    for (const next of outgoing.get(current)) {
      remainingIncoming.set(next, remainingIncoming.get(next) - 1)
      if (remainingIncoming.get(next) === 0) queue.push(next)
    }
  }
  if (visited !== normalizedStages.length) throw new TypeError('工作流 success graph 必须无环')

  const reachable = new Set(entries)
  const pending = [...entries]
  while (pending.length > 0) {
    for (const next of outgoing.get(pending.pop())) {
      if (!reachable.has(next)) { reachable.add(next); pending.push(next) }
    }
  }
  for (const stage of normalizedStages) if (!reachable.has(stage.id)) throw new TypeError(`阶段 ${stage.id} 无法从入口到达`)
  for (const terminal of terminals) if (!reachable.has(terminal)) throw new TypeError(`终止阶段 ${terminal} 无法从入口到达`)

  const reviewId = needName(reviewStageId, 'reviewStageId')
  if (!byId.has(reviewId)) throw new TypeError(`审查阶段不存在：${reviewId}`)
  if (reviewRoutes === null || typeof reviewRoutes !== 'object' || Array.isArray(reviewRoutes)) throw new TypeError('reviewRoutes 必须是对象')
  const routes = {}
  for (const kind of ['implementation', 'design']) {
    const target = needName(reviewRoutes[kind], `reviewRoutes.${kind}`)
    if (!byId.has(target)) throw new TypeError(`审查类别 ${kind} 指向无效阶段：${target}`)
    routes[kind] = target
  }
  if (byId.get(routes.implementation).testRunner === null) {
    throw new TypeError(`实现阶段 ${routes.implementation} 必须配置独立 testRunner`)
  }

  return Object.freeze({
    id: definitionId,
    version: definitionVersion,
    name: name.trim(),
    description: description.trim(),
    stages: Object.freeze(normalizedStages),
    edges: Object.freeze(normalizedEdges),
    entryStageIds: entries,
    terminalStageIds: terminals,
    reviewStageId: reviewId,
    reviewRoutes: Object.freeze(routes),
    maxReworkRounds,
  })
}
