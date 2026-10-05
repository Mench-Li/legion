// workbench/scripts/mobile-board-parity.test.mjs
// ============================================================================
// 手机看板与指挥台任务中心的**同轴性**。
//
// 手机端与指挥台各有各的渲染，但"哪个状态属于哪个视角"必须是**同一条轴**。
// 两份镜像会漂移，而漂移的表现是：用户在指挥台点「待我决定」看到三条，
// 到手机上点同一个名字看到两条——两端都"没报错"。
//
//   > 一个"手机能看任务"的看板，与一个"手机能和指挥台一样看任务"的看板，
//   > 在只有单一轴的版本里长得一模一样——直到用户想筛一下。
//
// 所以这条用例**读指挥台的源码**来对，而不是靠人记得同步。这与仓库里
// `config-schema` 的 min/max 交叉校验、`api.ts` 的路由交叉校验是同一个做法。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BOARD_VIEWS, applyView, viewOf } from '../mobile/board.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 从指挥台源码里抽出 `TC_VIEWS` 的 id → statuses。
 *
 * ★ 取数组用**括号配平扫描**，不用一条正则。
 *   首版写的是 `\[([^\]]*\][^\]]*)\]`，它在 `statuses: []` 那个**空数组**处
 *   就提前收尾了——于是只抓到前两个视角，而"少抓了三个"报出来的却是
 *   "两端不一致"，读起来像手机端写错了。
 *
 *   > 一个"观测点被输入里的方括号挡住"的交叉校验，
 *   > 与一个"真的不同步"的交叉校验，报的是同一句话。
 */
function webViews() {
  const src = readFileSync(resolve(ROOT, 'workbench/src/components/TaskCenterView.tsx'), 'utf8')
  const decl = src.indexOf('const TC_VIEWS')
  assert.ok(decl >= 0, '读不到 TaskCenterView 的 TC_VIEWS——它改名了，这条交叉校验就失效了')
  // ★ 数组起点必须在**类型注解之后**。
  //   直接从 `decl` 往后找第一个 `[` 会命中类型里的 `CardStatus[]`，
  //   于是扫出一个空的 `[]`——报出来的却是"两端不一致"。
  //   判据是那个 `=`：类型注解在它左边，初值在它右边。
  const eq = src.indexOf('=', src.indexOf('statuses', decl))
  assert.ok(eq > decl, 'TC_VIEWS 的声明形状变了（找不到 `=`）')
  const open = src.indexOf('[', eq)
  assert.ok(open > eq, 'TC_VIEWS 的初值不是数组字面量')
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > open, 'TC_VIEWS 的数组没有闭合——源码形状变了，请复核这条交叉校验')
  const block = src.slice(open, end + 1)
  const out = new Map()
  for (const m of block.matchAll(/\{\s*id:\s*'([a-z]+)'[^}]*statuses:\s*\[([^\]]*)\]/g)) {
    const statuses = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    out.set(m[1], statuses)
  }
  assert.ok(out.size >= 5, `只从 TC_VIEWS 里解析出 ${out.size} 个视角，源码形状可能变了`)
  return out
}

describe('手机看板与指挥台任务中心同一轴', () => {
  test('视角 id 集合相同', () => {
    const web = webViews()
    assert.deepEqual(
      BOARD_VIEWS.map((v) => v.id).sort(),
      [...web.keys()].sort(),
      '两端的视角 id 必须一致（用户看到的是同一组名字）',
    )
  })

  test('每个视角的状态归属**逐字**相同', () => {
    const web = webViews()
    for (const view of BOARD_VIEWS) {
      assert.deepEqual(
        [...view.statuses].sort(),
        [...(web.get(view.id) ?? [])].sort(),
        `视角「${view.label}」(${view.id}) 的状态归属两端不一致`,
      )
    }
  })

  test('`all` 不筛任何东西', () => {
    assert.deepEqual(viewOf('all').statuses, [])
    const tasks = [{ status: 'todo' }, { status: 'done' }, { status: 'canceled' }]
    assert.equal(applyView(tasks, 'all').length, 3)
  })

  test('认不出的视角退回"全部"，**不返回空**', () => {
    // 一个"筛没了"的界面，用户会以为任务丢了，而真实原因只是一个没见过的查询串。
    const tasks = [{ status: 'todo' }, { status: 'done' }]
    assert.equal(applyView(tasks, 'not-a-view').length, 2)
    assert.equal(applyView(tasks, undefined).length, 2)
  })

  test('`canceled` 不在任何筛选视角里，但在"全部"里——不丢任务', () => {
    // 指挥台也这样：取消掉的任务不该混进"已完成"，但也不该消失。
    const tasks = [{ id: 'A', status: 'canceled' }]
    assert.equal(applyView(tasks, 'done').length, 0)
    assert.equal(applyView(tasks, 'all').length, 1)
  })
})

describe('手机端：空间与会话的绑定', () => {
  const app = readFileSync(resolve(ROOT, 'workbench/mobile/app.mjs'), 'utf8')

  test('★ 开会话前要问"这个 agentId 属于当前空间吗"，不只是"非空吗"', () => {
    // 实测踩过：localStorage 里存着**上一个空间**的 agentId，而当前空间
    // （刚建好、还没编队的）一个 Agent 都没有。那时 `refreshTasks` 里
    // "修正 agentId" 那一步因 `state.agents.length > 0` 不成立而跳过，
    // 于是带着别的空间的 id 去开会话——服务端正确回「该空间不存在此 Agent」，
    // 而界面只留一行 console.warn，用户看到的是"聊天坏了"。
    const fn = /async function openConversation\(\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 openConversation')
    assert.match(fn, /state\.agents\.some\(/)
    assert.match(fn, /agentId === state\.agentId/)
  })

  test('切空间要重置一切与它绑定的东西', () => {
    // 少重置任何一项，都会表现为"上一个空间的东西串到这个空间来"——
    // 而那种错误**不报错**，只是显示错的内容。
    const fn = /async function switchScope\(scope\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 switchScope')
    for (const [what, re] of [
      ['Agent 选择', /state\.agentId = null/],
      ['会话', /state\.convId = null/],
      ['时间线', /state\.timeline = \[\]/],
      ['事件游标', /state\.cursor = null/],
      ['事件流', /state\.sse = null/],
      ['任务列表', /state\.tasks = \[\]/],
    ]) assert.match(fn, re, `切空间没有重置「${what}」——不重置不会报错，只会显示错的内容`)
  })

  test('空间列表来自 `/api/identity/me` 的 roles（用户在哪些空间有角色）', () => {
    const fn = /async function refreshSpaces\(\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 refreshSpaces')
    assert.match(fn, /roles/)
    // 只有一个空间时不给下拉框：那会让人以为别处还有得选。
    assert.match(fn, /spaces\.length === 1/)
  })
})
