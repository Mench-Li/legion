// workbench/scripts/rework-plan.test.mjs
// ============================================================================
// 看板**往回拖**（重做 / 打回）的语义判定 —— 纯函数契约 + 接线判据
//
// ## 为什么这一份要单独存在
//
// 这条路径上一次是**不存在**的：已完成的卡片 `draggable=false`（根本拖不动），
// 而 `done → in_progress` 是一条合法但静默的回退（改状态、无评论、不重建下游）。
// 也就是说"验收不满意，打回重做"这个动作在当时有两种结局，**都不报错**：
// 拖不动（没有任何提示），或者拖动了但下游一条都不重跑。
//
//   > 一个"拖不动"的卡片，与一个"能拖但什么都不会发生"的卡片，
//   > 在用户按下鼠标那一刻是同一个东西——直到他以为重做已经安排上了。
//
// 所以这里逐条钉住"拖到哪一列 ⇒ 走哪条路"，另加一组**接线判据**（静态读源码）：
// 判定对了但没接上（比如卡片仍然不可拖），行为与判定错了是同一个结果。
//
// 运行：node --test workbench/scripts/rework-plan.test.mjs
// ============================================================================
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  planDrop, isUsableReason, reworkToast, returnToast, REWORK_TARGETS, RETURN_TARGETS,
} from '../src/reworkPlan.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8')

/** 与 hub / 客户端同构的状态机（`TaskCenterView.TRANSITIONS` 的副本，用作 planDrop 的 allowed）。 */
const TRANSITIONS = {
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'todo', 'in_progress', 'blocked', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: ['in_progress', 'canceled'],
  canceled: [],
}
const plan = (from, to) => planDrop(from, to, TRANSITIONS[from])

describe('planDrop：往回拖的语义', () => {
  it('已验收往回拖（todo / in_progress / in_review）⇒ rework（发新目标 + 重建下游）', () => {
    for (const to of REWORK_TARGETS) {
      const p = plan('done', to)
      assert.equal(p.kind, 'rework', `done → ${to} 必须是重做`)
      assert.match(p.reasonLabel, /必填/)
    }
  })

  it('★ 已验收拖回「待认领」也必须是重做——尽管服务端状态机没有 done → todo 这条边', () => {
    assert.equal(TRANSITIONS.done.includes('todo'), false, '前提：状态机确实没有这条边')
    assert.equal(plan('done', 'todo').kind, 'rework',
      '先问状态机的话，这个动作会被自己判成非法——而它正是"验收不满意"的落点')
  })

  it('★ 已验收拖回「进行中」不许退化成静默回退', () => {
    // `done → in_progress` 在状态机里**是**合法的；只按状态机走，它就会静默改状态、不写评论、不重建下游
    assert.equal(TRANSITIONS.done.includes('in_progress'), true, '前提：这条边确实合法')
    assert.equal(plan('done', 'in_progress').kind, 'rework', '合法 ≠ 语义正确')
  })

  it('待验收往回拖 ⇒ return（同一目标内打回，改动点必填）', () => {
    for (const to of RETURN_TARGETS) {
      const p = plan('in_review', to)
      assert.equal(p.kind, 'return', `in_review → ${to} 是打回`)
      assert.match(p.reasonLabel, /必填/)
    }
  })

  it('其余合法迁移照旧走 plain（不因这次改动给它们加上弹框）', () => {
    const plain = [
      ['backlog', 'todo'], ['todo', 'in_progress'], ['in_progress', 'in_review'],
      ['in_review', 'blocked'], ['in_review', 'done'], ['blocked', 'todo'],
      ['in_progress', 'todo'], ['done', 'canceled'],
    ]
    for (const [from, to] of plain) {
      assert.equal(plan(from, to).kind, 'plain', `${from} → ${to} 应当照旧`)
    }
  })

  it('非法迁移与原地放下 ⇒ illegal，并给得出人话理由', () => {
    assert.equal(plan('todo', 'backlog').kind, 'illegal')
    assert.equal(plan('canceled', 'todo').kind, 'illegal')
    const same = plan('done', 'done')
    assert.equal(same.kind, 'illegal')
    assert.match(same.hint, /相同/)
    assert.match(plan('todo', 'backlog').hint, /不允许/)
  })
})

describe('改动点必填', () => {
  it('空 / 纯空白不够用；非空够用', () => {
    for (const bad of ['', '   ', '\n\t ', null, undefined, 42]) {
      assert.equal(isUsableReason(bad), false, JSON.stringify(bad))
    }
    assert.equal(isUsableReason('头像有黑边'), true)
  })
})

describe('回执文案', () => {
  it('重做：念清旧任务、新目标、重建的链', () => {
    const text = reworkToast({
      reworked: { id: 'T-199', fromStatus: 'done' },
      goal: { id: 'G-new1' },
      created: [
        { id: 'T-203', role: 'coder', label: '编码实现' },
        { id: 'T-204', role: 'tester', label: '测试执行' },
      ],
      superseded: ['T-199', 'T-200', 'T-201', 'T-202'],
    })
    assert.match(text, /T-199/)
    assert.match(text, /G-new1/)
    assert.match(text, /T-203（编码实现）/)
    assert.match(text, /T-204（测试执行）/)
    assert.match(text, /→/, '链的顺序要看得出')
  })

  it('重做：响应缺字段（老中枢/空回执）也不许拼出 "undefined"', () => {
    for (const bad of [null, undefined, {}, { created: null }, { created: [{}] }]) {
      const text = reworkToast(bad)
      assert.equal(text.includes('undefined'), false, JSON.stringify(bad))
      assert.ok(text.length > 0)
    }
  })

  it('打回：说清改动点去了哪里', () => {
    const text = returnToast('T-203')
    assert.match(text, /T-203/)
    assert.match(text, /评论/)
  })
})

describe('接线判据（静态读源码）：判定对了还要真的接上', () => {
  it('★ 已完成的卡片必须可拖——从前 draggable 判据把 done 排除在外，卡片根本不长手柄', () => {
    const view = read('src/components/TaskCenterView.tsx')
    assert.match(view, /const draggableCard = \(r: TcRow\): boolean => r\.status !== 'canceled'/,
      '可拖判据必须只排除「已取消」')
    assert.match(view, /draggable=\{hubMode && draggableCard\(r\)\}/)
    assert.equal(/doneOpen/.test(view), false, '旧的 doneOpen（排除 done）不许再回来')
  })

  it('★ 拖动判定必须走 planDrop，而不是各自再写一遍 if', () => {
    const view = read('src/components/TaskCenterView.tsx')
    assert.match(view, /import \{ planDrop \} from '\.\.\/reworkPlan\.ts'/)
    assert.match(view, /const plan = planDrop\(item\.status, to, TRANSITIONS\[item\.status\] \?\? \[\]\)/)
    assert.match(view, /plan\.kind === 'rework' \|\| plan\.kind === 'return'/)
  })

  it('★ 重做/打回必须弹必填框（不许再有 window.prompt 那种"空理由也能提交"）', () => {
    const view = read('src/components/TaskCenterView.tsx')
    assert.equal(/window\.prompt/.test(view), false, '往回拖不许再用 prompt 收理由')
    assert.match(view, /<ReworkModal/)
    assert.match(view, /intent=\{dropAsk\.intent\}/)
    const modal = read('src/components/ReworkModal.tsx')
    assert.match(modal, /disabled=\{busy \|\| !usable\}/, '改动点为空时提交按钮必须禁用')
    assert.match(modal, /const usable = isUsableReason\(reason\)/)
  })

  it('★ 重做走 /api/rework；打回走 rejectTask（"评论先行"这条不变量在它里面守着）', () => {
    const modal = read('src/components/ReworkModal.tsx')
    assert.match(modal, /await hubRework\(/)
    // ★ 2026-10-12 搬家：打回原先在**这里**自己拼 comment + transition，现在收进
    //   `rejectTask()`（`src/api.ts`）—— 三个调用点共用一份实现。不变量没变（评论必须先行），
    //   变的是它归谁守：两份实现的下场是某一天给出两句不一样的话。
    assert.match(modal, /await rejectTask\(\{/)
    assert.equal(/hubComment\(/.test(modal), false, '弹窗不再自己拼评论')
    const api = read('src/api.ts')
    assert.match(api, /export async function hubRework/)
    assert.match(api, /hubPost\('\/api\/rework'/)
    // 不变量搬到 api.ts 之后，**得有人继续钉着它**：下面这一条 + reject-path.test.mjs 的运行时用例
    const at = api.indexOf('export async function rejectTask')
    assert.ok(at > 0, '找不到 rejectTask')
    const body = api.slice(at, at + 3500)
    assert.ok(body.indexOf('hubComment(') < body.indexOf('hubTransition('),
      '先落评论再退回：退回后守护可能立刻认领，先落评论才保证它带得上改动点')
  })

  it('★ 重做按钮的实参要带 ifVersion 与 scope（乐观锁/分区不能丢）', () => {
    const modal = read('src/components/ReworkModal.tsx')
    assert.match(modal, /ifVersion === undefined \? \{\} : \{ ifVersion \}/)
    assert.match(modal, /scope \? \{ scope \} : \{\}/)
  })
})
