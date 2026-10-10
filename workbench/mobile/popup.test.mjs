/**
 * popup.test.mjs — 手机端提醒弹框（BUG-021 的手机一半）。
 *
 * 两部分：
 *   ① 手机端自己的行为（弹什么、文案、游标只前进、首次补告时间窗）；
 *   ② **对等判据**：同一批审计行喂给手机端 `mobile/popup.mjs` 与桌面端 `src/notify.ts`，
 *      逐条断言**该弹/不该弹、弹几条、文案**完全相同。
 *
 * 为什么要 ②：手机端零构建、不能 import `.ts`，所以判据是两份实现。
 * 两份实现会漂移，而漂移的样子是"电脑上会弹、手机上不弹"——没人会去查，
 * 因为两端各自都"看起来正常"。
 *
 *   > 一份"两端各自实现、靠人记得同步"的规则，
 *   > 与一份"两端实现不同、但每次改动都被一条判据顶住"的规则，
 *   > 在没人记得同步的那天之前，是一模一样的。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  POPUP_STATUS_LABEL, popupBatch as mobileBatch, popupReason as mobileReason, popupSeqKey,
  popupText as mobileText, readPopupSeq, shouldPopup as mobileShouldPopup, shouldUseSystemNotify,
  writePopupSeq,
} from '../mobile/popup.mjs'
import {
  NOTIFY_STATUS_LABEL, popupBatch as desktopBatch, popupReason as desktopReason,
  popupText as desktopText, shouldPopup as desktopShouldPopup, toNotifyItem,
} from '../src/notify.ts'
import { shouldUseSystemNotify as desktopShouldUseSystemNotify } from '../src/desktopNotify.ts'

const row = (seq, action, extra = {}) => ({
  seq, ts: '2026-10-10T17:00:00.000Z', member: 'researcher', scope: 'software',
  action, taskId: null, goalId: null, detail: {}, ...extra,
})

/** 内存版 Storage。 */
function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    dump: () => Object.fromEntries(map),
  }
}

// ── ① 手机端自己的行为 ─────────────────────────────────────────────────────

describe('BUG-021 手机端：弹框决策与文案', () => {
  test('★★ 进入「待验收」要弹（这就是会浪费等待时间的那条）', () => {
    assert.equal(mobileShouldPopup(row(1, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } })), true)
  })

  test('★★ 开工 / 产物 / 普通状态变更不弹', () => {
    for (const r of [
      row(2, 'claim', { taskId: 'T-1' }),
      row(3, 'artifact', { taskId: 'T-1' }),
      row(4, 'progress', { taskId: 'T-1' }),
      row(5, 'transition', { taskId: 'T-1', detail: { to: 'in_progress' } }),
      row(6, 'transition', { taskId: 'T-1', detail: { to: 'done' } }),
    ]) assert.equal(mobileShouldPopup(r), false, r.action + ' 不该弹')
  })

  test('★ 文案含任务号 + 「待你验收」，可带角色中文名', () => {
    const r = row(7, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } })
    assert.ok(mobileText(r).includes('T-196'))
    assert.ok(mobileText(r).includes('待你验收'))
    assert.ok(mobileText(r, '方案研究员').includes('（方案研究员）'))
  })

  test('状态表覆盖全部状态（少一个会在弹框里露出英文原文）', () => {
    for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']) {
      assert.equal(typeof POPUP_STATUS_LABEL[s], 'string')
    }
  })
})

describe('BUG-021 手机端：游标', () => {
  test('★ 键名与桌面端**不同**（共用会让"电脑上看过"顺手吞掉手机上的）', () => {
    assert.equal(popupSeqKey('software'), 'legion.mobile.popupseq.software')
    assert.notEqual(popupSeqKey('software'), 'legion.notify.popupseq.software')
  })

  test('★ 读：没有/损坏/负数 → 0', () => {
    assert.equal(readPopupSeq('software', memStorage()), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.mobile.popupseq.software': 'x' })), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.mobile.popupseq.software': '-1' })), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.mobile.popupseq.software': '88' })), 88)
  })

  test('★★ 写：只前进；非正数不写', () => {
    const s = memStorage({ 'legion.mobile.popupseq.software': '500' })
    writePopupSeq('software', 400, s)
    assert.equal(readPopupSeq('software', s), 500)
    writePopupSeq('software', 600, s)
    assert.equal(readPopupSeq('software', s), 600)
    const empty = memStorage()
    writePopupSeq('software', 0, empty)
    writePopupSeq('software', Number.NaN, empty)
    assert.deepEqual(empty.dump(), {})
  })

  test('★★ 首次 + 6 小时窗：窗内补告（否则"装了提醒却什么也不说"）', () => {
    const now = Date.parse('2026-10-10T18:00:00.000Z')
    const rows = [
      { ...row(10, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }), ts: '2026-10-10T17:20:00.000Z' },
      { ...row(11, 'transition', { taskId: 'T-OLD', detail: { to: 'in_review' } }), ts: '2026-10-09T02:00:00.000Z' },
    ]
    const r = mobileBatch(rows, 0, 3, { nowMs: now, replayWindowMs: 6 * 60 * 60 * 1000 })
    assert.deepEqual(r.popups.map((p) => p.row.taskId), ['T-196'])
    assert.equal(r.lastSeq, 11)
    // 窗口 0 = 纯建立基线
    assert.deepEqual(mobileBatch(rows, 0, 3).popups, [])
  })
})

// ── ② 对等判据：手机端 ≡ 桌面端 ────────────────────────────────────────────

/** 覆盖"会弹"与"不弹"两类的代表行。 */
const MATRIX = [
  row(100, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }),
  row(101, 'transition', { taskId: 'T-9', detail: { to: 'blocked' } }),
  row(102, 'transition', { taskId: 'T-9', detail: { to: 'in_progress' } }),
  row(103, 'transition', { taskId: 'T-9', detail: { to: 'done' } }),
  row(104, 'transition', { taskId: 'T-9', detail: {} }),
  row(105, 'hold', { taskId: 'T-7' }),
  row(106, 'reassign', { taskId: 'T-7' }),
  row(107, 'test-report', { taskId: 'T-7' }),
  row(108, 'claim', { taskId: 'T-7' }),
  row(109, 'artifact', { taskId: 'T-7' }),
  row(110, 'progress', { taskId: 'T-7', detail: { percent: 50 } }),
  row(111, 'release-stale', { taskId: '*' }),
  row(112, 'chat:message', { taskId: 'T-7' }),
  row(113, 'comment', { taskId: 'T-7' }),
  row(114, 'create', { taskId: 'T-7' }),
  row(115, 'goal:publish', { goalId: 'G-1' }),
  row(116, 'goal:done', { goalId: 'G-1' }),
  row(117, 'goal:cancel', { goalId: 'G-1' }),
  row(118, 'goal:pause', { goalId: 'G-1' }),
  row(119, 'goal:context', { goalId: 'G-1' }),
  row(120, 'evidence', { taskId: 'T-7' }),
  row(121, 'review-note', { taskId: 'T-7' }),
  row(122, 'model:set', {}),
  row(123, 'space:update', {}),
  row(124, 'skill:grant', {}),
]

describe('BUG-021 对等判据：手机端与桌面端同一套判据', () => {
  test('★★ 每条审计行的"该不该弹"两端一致', () => {
    for (const r of MATRIX) {
      const m = mobileShouldPopup(r)
      const d = desktopShouldPopup(toNotifyItem(r, { cursor: 0, ids: [] }))
      assert.equal(m, d, `${r.action}${JSON.stringify(r.detail)}：手机=${m} 桌面=${d}（两端漂移了）`)
    }
  })

  test('★★ 同一批行、同一个游标：两端弹出的条数与文案逐字相同', () => {
    for (const lastSeq of [0, 99, 110, 124, 999]) {
      const m = mobileBatch(MATRIX, lastSeq, 5)
      const d = desktopBatch(MATRIX, lastSeq, 5)
      assert.deepEqual(
        m.popups.map((p) => p.text), d.popups.map((p) => p.text),
        `游标 ${lastSeq}：手机与桌面弹出的文案必须一致`,
      )
      assert.deepEqual(m.popups.map((p) => p.seq), d.popups.map((p) => p.seq), `游标 ${lastSeq}：seq 序列一致`)
      assert.equal(m.lastSeq, d.lastSeq, `游标 ${lastSeq}：推进后的游标值一致`)
    }
  })

  test('★★ 带上角色中文名时两端也一致（手机端从编队取名字）', () => {
    const r = row(200, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } })
    assert.equal(mobileText(r, '方案研究员'), desktopText(toNotifyItem(r, { cursor: 0, ids: [] }), '方案研究员'))
  })

  test('★★ 首次补告时间窗两端一致（同 nowMs、同窗口）', () => {
    const now = Date.parse('2026-10-10T18:00:00.000Z')
    const rows = [
      { ...row(300, 'transition', { taskId: 'T-A', detail: { to: 'in_review' } }), ts: '2026-10-10T17:30:00.000Z' },
      { ...row(301, 'transition', { taskId: 'T-B', detail: { to: 'blocked' } }), ts: '2026-10-10T11:00:00.000Z' },
      { ...row(302, 'transition', { taskId: 'T-C', detail: { to: 'in_review' } }), ts: '2026-10-09T20:00:00.000Z' },
    ]
    const opts = { nowMs: now, replayWindowMs: 6 * 60 * 60 * 1000 }
    assert.deepEqual(
      mobileBatch(rows, 0, 3, opts).popups.map((p) => p.text),
      desktopBatch(rows, 0, 3, opts).popups.map((p) => p.text),
    )
  })

  test('★★ 状态中文表两端逐字一致（各写一份就是为了能被这条顶住）', () => {
    assert.deepEqual({ ...POPUP_STATUS_LABEL }, { ...NOTIFY_STATUS_LABEL })
  })

  test('★★ "为什么停在这"（popupReason）两端逐字一致（BUG-022）', () => {
    const cases = [
      '⚠ 编码实现完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/T-199。请人工合入并推进：git merge --no-ff w/T-199',
      '⚠ 自动合入失败，等待人工处理\n\ngit merge --no-ff w/T-199',
      '✅ 需求澄清完成，方案文档已合入主分支。请将军人工验收',
      '🟢 已派 AI worker 开始执行（worker=scrum:T-199，隔离 worktree=…）——进行中，完成/异常将自动更新并流转',
      '进度 50%',
      '\n\n⛔ 冲突未解决',
      '',
      null,
      undefined,
      42,
      '失败：' + '很长的说明'.repeat(40),
    ]
    for (const c of cases) {
      assert.equal(
        mobileReason(c), desktopReason(c),
        `两端对同一段评论给出的"原因"必须一致：${String(c).slice(0, 40)}`,
      )
    }
  })

  test('★★ 常规验收与进展播报**不**被当成"要你动手的原因"（否则是噪音）', () => {
    for (const routine of [
      '✅ 需求澄清完成，方案文档已合入主分支。请将军人工验收',
      '🟢 已派 AI worker 开始执行（worker=scrum:T-199，隔离 worktree=…）——进行中，完成/异常将自动更新并流转',
      '进度 50%',
    ]) {
      assert.equal(mobileReason(routine), null, '不该附在弹框上：' + routine.slice(0, 30))
      assert.equal(desktopReason(routine), null)
    }
    // 而真实那条挡住 T-199 的，必须抽出来（否则用户仍然不知道该做什么）
    const real = '⚠ 编码实现完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/T-199。请人工合入并推进'
    assert.ok((mobileReason(real) ?? '').includes('自动合入主分支失败'))
  })

  test('★★ 系统通知的决策两端一致（页面不在前台时才发、且要已授权）', () => {
    for (const hidden of [true, false]) {
      for (const permission of ['granted', 'default', 'denied', 'unsupported']) {
        assert.equal(
          shouldUseSystemNotify({ hidden, permission }),
          desktopShouldUseSystemNotify({ hidden, permission }),
          `hidden=${hidden} permission=${permission}：两端决策必须一致`,
        )
      }
    }
    // 单独钉住语义：绝不自动请求、可见时不重复打扰
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'granted' }), true)
    assert.equal(shouldUseSystemNotify({ hidden: false, permission: 'granted' }), false)
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'default' }), false)
  })
})

// ── ③ 手机端的接线（源码级：读 app.mjs 文本，不 import —— 它顶层读浏览器存储）──

describe('BUG-021 手机端接线：提醒必须骑在合并刷新上，不许单开计时器', () => {
  const src = readFileSync(new URL('../mobile/app.mjs', import.meta.url), 'utf8')

  test('★★ `refreshPopups` 在 refreshLoop 的 run 里被调用', () => {
    const runBody = /const refreshLoop = createRefresher\(\{[\s\S]*?\n\}\)/.exec(src)?.[0] ?? ''
    assert.ok(runBody.length > 0, '读不到 refreshLoop 的定义——它改名了，这条判据要跟着改')
    assert.match(runBody, /refreshPopups\(\)/,
      '★ 不挂在合并刷新里 ⇒ 每个进展事件都要多取一次审计（手机流量/电量），而换来的只是把同一条提醒弹三遍')
  })

  test('★★ 提醒有自己的游标，且与"看板徽标"那把尺子分开', () => {
    assert.match(src, /state\.popupSeq = readPopupSeq\(/, '进应用/切空间时要读 per-scope 游标')
    assert.match(src, /writePopupSeq\(state\.scope, lastSeq\)/, '弹过之后要推进游标（否则会重弹）')
    assert.doesNotMatch(src, /attentionCount[\s\S]{0,80}writePopupSeq/,
      '★ 不许拿看板徽标的口径当"弹过了没有"：看不看板和弹没弹过是两件事')
  })

  test('★★ 变空间要清屏并换游标（旧空间的提醒不该留在屏幕上）', () => {
    const sw = /async function switchScope\(scope\)[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
    assert.match(sw, /state\.popupSeq = readPopupSeq\(scope\)/, '★ 换空间换一把游标')
    assert.match(sw, /popup-host/, '★ 换空间要清掉上一个空间残留的提醒')
  })

  test('★★ 授权只在用户点击时请求（绝不自动请求）', () => {
    // 第一版这条写成了 `doesNotMatch(/^\s*void requestSystemNotifyPermission\(\)/m)` —— 它**太松**：
    // `\s` 含换行，于是"缩进在点击处理里的那句正常调用"也被判成了自动请求。
    // 判据要能失败，也要**只在真出问题时**才失败，所以改成钉调用点数量与位置。
    const occurrences = src.split('requestSystemNotifyPermission').length - 1
    assert.equal(occurrences, 2,
      '定义 1 次 + 调用 1 次；多出来的调用点很可能就是"加载时自动请求"——那会被用户直接拒掉，拒一次就再也回不来')

    const handler = /\$\('btn-notify'\)\.addEventListener\('click',[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? ''
    assert.ok(handler.length > 0, '读不到 btn-notify 的点击处理——它改名了，这条判据要跟着改')
    assert.match(handler, /requestSystemNotifyPermission\(\)/,
      '★ 授权请求必须挂在一个真实点击上（浏览器也只允许在用户手势里请求）')
  })

  test('★ 弹框宿主必须存在（否则 showPopup 静默什么都不做）', () => {
    const html = readFileSync(new URL('../mobile/index.html', import.meta.url), 'utf8')
    assert.match(html, /id="popup-host"/, '★ 没有宿主容器 ⇒ 弹框一个都不会出现，而且不会报错')
    assert.match(html, /id="btn-notify"/, '★ 授权按钮不在 DOM 里 ⇒ 上面那条监听绑不上')
  })
})
