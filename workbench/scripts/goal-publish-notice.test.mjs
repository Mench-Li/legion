// workbench/scripts/goal-publish-notice.test.mjs
// BUG-049：发布目标后那句提示必须按**真的建了几环链任务**说话。
//
// 现场（2026-11-20，新空间 personal-profile）：编队空 + 流水线空 ⇒ 建链 0 环（tasks 表 0 行），
// 而界面说「链任务已建好…**不必重发**」——它把唯一有效的那一步（配好之后重新发布）明确否掉了。
//
// 跑法：node --experimental-strip-types --test workbench/scripts/goal-publish-notice.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { goalPublishNotice } from '../src/goalPublishNotice.ts'

const root = new URL('../', import.meta.url)
const app = readFileSync(new URL('./src/App.tsx', root), 'utf8')
const api = readFileSync(new URL('./src/api.ts', root), 'utf8')

const blockedOne = [{ level: 'error', code: 'pipeline-missing', message: '该空间未配置流水线——守护按角色过滤时会跳过全部任务', fix: 'POST /api/pipeline {scope:"x", stages:[…]}' }]
const blockedTwo = [...blockedOne, { level: 'error', code: 'daemon-offline', message: '该空间没有守护实例', fix: null }]

// ══════════════════════ ① 0 条链任务：必须说"没建"，并且要求重发 ══════════════════════

test('① ★★★ 建出 0 环 ⇒ 明说"一条都没建"，并要求**重新发布**（不许出现"不必重发"）', () => {
  const n = goalPublishNotice({ blocked: blockedTwo, builtStages: 0 })
  assert.equal(n.tone, 'info')
  assert.match(n.text, /一条链任务都没建出来/)
  assert.match(n.text, /需要重新发布/)
  assert.match(n.text, /编队 ∩ 流水线/)
  // 阻塞项照旧要说出来，而且要带可执行修复
  assert.match(n.text, /该空间未配置流水线/)
  assert.match(n.text, /另有 1 项/)
  assert.match(n.text, /POST \/api\/pipeline/)
  // ★★ 这一条是本 bug 的核心：那句话不许再出现
  assert.ok(!n.text.includes('不必重发'), '★ 0 环时"不必重发"是错的：配好流水线后**必须**重发')
  assert.ok(!n.text.includes('链任务已建好'), '★ 0 环时不许声称已建好')
})

test('② ★ 0 环但预检没报阻塞（编队空/流水线空却判 ok 的罕见读数）⇒ 仍然说 0 条 + 重发', () => {
  const n = goalPublishNotice({ blocked: [], builtStages: 0 })
  assert.equal(n.tone, 'info')
  assert.match(n.text, /一条链任务都没建出来/)
  assert.match(n.text, /需要重新发布/)
})

// ══════════════════════ ③ 建了 N 条：原措辞仍然成立 ══════════════════════

test('③ ★★ 建了 3 环 + 有阻塞 ⇒ 保留原语义（链是真的、阻塞也是真的、解开就自动认领）', () => {
  const n = goalPublishNotice({ blocked: blockedOne, builtStages: 3 })
  assert.equal(n.tone, 'info')
  assert.match(n.text, /3 环链任务已建好/)
  assert.match(n.text, /自动认领/)
  assert.match(n.text, /不必重发/)
  assert.match(n.text, /该空间未配置流水线/)
})

test('④ ★★ 建了 3 环 + 无阻塞 ⇒ ok，并说出环数（不是含糊的"自动生成独立任务链"）', () => {
  const n = goalPublishNotice({ blocked: [], builtStages: 3 })
  assert.equal(n.tone, 'ok')
  assert.match(n.text, /3 环链任务已建好/)
})

// ══════════════════════ ⑤ 回执没给数：不猜 ══════════════════════

test('⑤ ★★★ 回执没带建链数 ⇒ 两种断言都不许下（不猜"建好了"，也不猜"没建"）', () => {
  const withBlocked = goalPublishNotice({ blocked: blockedOne, builtStages: null })
  assert.equal(withBlocked.tone, 'info')
  assert.match(withBlocked.text, /无法确认/)
  assert.ok(!withBlocked.text.includes('链任务已建好'), '★ 不知道就别声称已建好')
  assert.ok(!withBlocked.text.includes('一条链任务都没建出来'), '★ 也不知道没建')
  assert.match(withBlocked.text, /任务中心/) // 给出去哪儿看

  const bare = goalPublishNotice({ blocked: [], builtStages: null })
  assert.equal(bare.tone, 'ok')
  assert.match(bare.text, /未带建链数/)
})

test('⑥ ★ 非数字/负数/NaN 的 stages 一律当"没给"（不把脏读数当 0 条）', () => {
  for (const bad of [undefined, null, Number.NaN, -1, '3', {}]) {
    const n = goalPublishNotice({ blocked: [], builtStages: bad })
    assert.match(n.text, /未带建链数/, `stages=${JSON.stringify(bad)} 应走"未带建链数"分支`)
  }
})

test('⑦ 纯函数：同输入同输出，且不改入参', () => {
  const input = { blocked: blockedTwo, builtStages: 0 }
  const snapshot = JSON.stringify(input)
  const a = goalPublishNotice(input)
  const b = goalPublishNotice(input)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(input), snapshot, '★ 不许就地改入参')
})

// ══════════════════════ ⑧ 接线：界面真的用这份读数 ══════════════════════

test('⑧ ★★★ 接线：App 用 goalPublishNotice + 回执里的 stages；旧那句硬编码文案已消失', () => {
  assert.match(app, /import \{ goalPublishNotice \} from '\.\/goalPublishNotice'/, '★ 必须引进来')
  assert.match(app, /const published = await publishGoal\(/, '★★ 回执要接着，不能 await 完就丢')
  assert.match(app, /published\?\.task\?\.stages/, '★★ 建链数只能来自服务端回执')
  assert.match(app, /goalPublishNotice\(\{ blocked, builtStages \}\)/, '★ 措辞交给纯函数')
  assert.ok(!app.includes('（链任务已建好，开通执行 / 守护上线后会自动认领，不必重发）'),
    '★★ 那句无条件声称"已建好"的硬编码文案必须已删除')
  // 回执的类型面也要有 stages（否则 TS 读不到，下一个人会退回 `as any`）
  assert.match(api, /export interface GoalPublishResult/, '★ 回执形状要有具名契约')
  assert.match(api, /stages\?: number/, '★ 并且带建链数')
})
