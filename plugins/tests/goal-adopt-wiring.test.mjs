// plugins/tests/goal-adopt-wiring.test.mjs
// ============================================================================
// 接手既有交付（adopt）在守护侧的**接线**判据。
//
// 为什么是读源码而不是跑函数：`buildWorkerPrompt` 与工作区准备都在
// `runWorker` 的闭包里，没有可注入的导出点；而这条链要守住的恰恰是**接线**——
// 两处必须同时认 adopt，漏一处就变成"工作区建在旧提交上、提示词却让它从 main 重写"
// 那种沉默的重复劳动。
//
// 运行：node --test plugins/tests/goal-adopt-wiring.test.mjs
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const index = readFileSync(resolve(ROOT, 'plugins/src/index.ts'), 'utf8')
const types = readFileSync(resolve(ROOT, 'plugins/src/types.ts'), 'utf8')

test('① 类型面上有 adopt（否则读快照那一行就是 any，接线错了也没人发现）', () => {
  assert.match(types, /adopt\?:\s*{[\s\S]*?commit: string/)
})

test('② 工作区基线：adopt 优先，其次才是审查阶段的上游冻结提交', () => {
  assert.match(index, /const adoptedCommit = [\s\S]{0,200}?agentSelectionSnapshot\?\.adopt\?\.commit[\s\S]{0,120}?\/\^\[0-9a-f\]\{40,64\}\$\/i\.test/)
  assert.match(index, /const baseRef = adoptedCommit \?\? workflowBaseRef/)
  assert.match(index, /prepareWorktree\(t\.id, \{ baseRef \}\)/)
  // 从前那行直接传 workflowBaseRef —— 留着它就等于 adopt 永远不生效。
  assert.doesNotMatch(index, /prepareWorktree\(t\.id, \{ baseRef: workflowBaseRef \}\)/)
})

test('③ 提示词里必须明说"接手，别重写"，且同样受 sha 形状约束', () => {
  // 锚在**提示词正文**那一行（`本环接手任务…`），不是文件里的注释——两者都在，
  // 但注释永远在正文之前，锚错位置会切出一段只有注释的片段。
  const at = index.indexOf('本环接手任务')
  assert.ok(at > 0, '提示词里没有 adopt 那一节')
  const block = index.slice(at - 1200, at + 600)
  assert.match(block, /agentSelectionSnapshot\?\.adopt/)
  assert.match(block, /\/\^\[0-9a-f\]\{40,64\}\$\/i\.test\(adopt\.commit\)/, '提示词分支也要校验 sha，别把随便什么字符串当基线')
  assert.match(block, /不要从 main 重写/)
  assert.match(block, /核对并只做必要修补/)
})

test('④ adopt 段落只在有该字段时出现（不带 adopt 的目标提示词与今天一致）', () => {
  const at = index.indexOf('const adopt = t.agentSelectionSnapshot?.adopt')
  assert.ok(at > 0, '找不到 adopt 的取值行')
  const after = index.slice(at, at + 200)
  assert.match(after, /if \(adopt !== null && adopt !== undefined/)
})
