// workbench/scripts/goal-publish-wiring.test.mjs
// ---------------------------------------------------------------------------
// 接线守卫（T1.1 / T1.3 / T1.5 / T1.6）。
//
// 这一组不测业务逻辑（那是 `goal-plan-view.test.mjs` 与 `team-hub/goal-orchestration.test.mjs`
// 的事），只钉住三件**纯函数测不到、只能从源码上看出来**的事：
//
//   ① 发布与预览必须共用同一个请求体构造函数 —— 否则两份实现会在
//      "恰好一致"的配置上看不出区别，只在第一次不一致时表现为"预览说行、发布 409"；
//   ② 编排模式与分配层必须真的被送到 API（写好了但没接线是本仓反复出现的事）；
//   ③ `orchestration` 为 pipeline 时**不发送**该字段（保持旧行为，少发一个字段
//      就不会意外触发另一条路径）。
//
// 运行：node workbench/scripts/goal-publish-wiring.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

test('① ★★★ 发布与预览共用 `goalPublishBody`（不许各拼一份请求体）', () => {
  const api = read('api.ts')
  // 两个函数都必须经过同一个构造函数。
  const preview = api.slice(api.indexOf('export async function previewGoalPlan'))
  const previewBody = preview.slice(0, preview.indexOf('\n}'))
  assert.match(previewBody, /goalPublishBody\(/, '★★ 预览必须走 goalPublishBody')

  const publish = api.slice(api.indexOf('export function publishGoal'))
  const publishBody = publish.slice(0, publish.indexOf('\n}'))
  assert.match(publishBody, /goalPublishBody\(/, '★★ 发布必须走 goalPublishBody')
})

test('② ★★★ pipeline 是默认时不发送 `orchestration`（保持旧行为）', () => {
  const api = read('api.ts')
  const body = api.slice(api.indexOf('function goalPublishBody'))
  const fn = body.slice(0, body.indexOf('\n}'))
  assert.match(fn, /orchestration !== 'pipeline'/, '★★ 只有非默认值才发——少发一个字段就不会意外走另一条路径')
  // 反例：无条件把 orchestration 塞进去会让所有旧调用方突然带上这个字段。
  assert.doesNotMatch(fn, /\borchestration,\s*\n/, '★★ 不许无条件透传 orchestration')
})

test('③ ★★★ 分配层必须真的送到 API（写好了没接线是本仓反复出现的事）', () => {
  const api = read('api.ts')
  const body = api.slice(api.indexOf('function goalPublishBody'))
  const fn = body.slice(0, body.indexOf('\n}'))
  assert.match(fn, /agentToolConfig:\s*assignment\.agentToolConfig/, '★ 目标级 Agent 要被搬进请求体')
  assert.match(fn, /stageOverrides:\s*assignment\.stageOverrides/, '★ 逐节点覆盖要被搬进请求体')
  // 空对象不许发：`{}` 与"没选"是两件事，发出去等于"我选了一个空的"。
  assert.match(fn, /Object\.keys\(assignment\.stageOverrides\)\.length > 0/, '★★ 空 stageOverrides 不发')
})

test('④ ★★★ 发布弹窗真的把 extras 交给了 App 层，App 层真的交给了 api', () => {
  const modal = read('components/GoalModal.tsx')
  assert.match(modal, /orchestration,\s*\n?\s*assignment:/, '★★ 弹窗提交时必须带上编排模式与分配层')
  assert.match(modal, /previewGoalPlan\(/, '★ 弹窗必须真的调用预览')
  const app = read('App.tsx')
  assert.match(app, /publishGoal\(scopeValue, objective, undefined, workflowDefinition, agentNodeId, \{/, '★★ App 层必须把 extras 透传给 publishGoal')
})

test('⑤ 编排模式与执行者是**两个**控件（不是塞进同一个下拉）', () => {
  const modal = read('components/GoalModal.tsx')
  assert.match(modal, /aria-label="编排模式"/, '★ 编排模式要有独立控件')
  assert.match(modal, /aria-label="执行者粒度"/, '★ 执行者粒度要有独立控件')
  // 文案必须各自说清"它改变什么、不改变什么"——这两个概念本仓都踩过坑。
  assert.match(modal, /决定\*\*阶段从哪来\*\*/, '★ 编排模式的标题要说清它决定什么')
  assert.match(modal, /决定\*\*谁执行\*\*/, '★ 执行者的标题要说清它决定什么')
})

test('⑥ ★★ custom-dag 时不许再发送分配层（分配由定义本身决定）', () => {
  const modal = read('components/GoalModal.tsx')
  const hits = [...modal.matchAll(/orchestration === 'custom-dag' \? undefined : assignment/g)]
  assert.ok(hits.length >= 1, '★★ custom-dag 下分配层必须不发送：否则"按定义建链"与"按覆盖分配"会打架')
})

test('⑦ 预览失败必须显式显示，不许静默保持上一份计划', () => {
  const modal = read('components/GoalModal.tsx')
  assert.match(modal, /setPlanError\(/, '★ 失败要记下来')
  assert.match(modal, /setPlanResponse\(null\)/, '★★ 失败时必须清掉旧计划：留着上一份会让用户看着过期结果点发布')
  assert.match(modal, /计划预览失败/, '★ 界面上要说出来')
})
