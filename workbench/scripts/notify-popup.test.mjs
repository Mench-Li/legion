/**
 * notify-popup.test.mjs — BUG-021：**右下角弹框**的纯函数回归。
 *
 * ## 这条缺陷是什么
 *
 * 通知这条线从前只做了一个未读计数徽标：`App.tsx` 拉到审计行后只调 `setNotifyUnread(...)`，
 * 数一下、点亮侧栏，**从来不打扰人**。于是一个 worker 干完活停在 `in_review` 等将军，
 * 将军不知道，等待时间全浪费（实测：T-196 于 09:20:58 进入待验收，无人知晓）。
 *
 *   > 一个"有通知中心"的系统，与一个"到点了会来叫你"的系统，
 *   > 在有人正好盯着侧栏的时候一模一样。
 *
 * 本文件守的是**决策与游标**（弹什么、什么时候不弹、游标怎么走），不是渲染。
 * 直接 import workbench/src/notify.ts（无 JSX/DOM 依赖，由 run-ci 以 --strip-types 运行）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_READ_STATE, NOTIFY_STATUS_LABEL, popupBatch, popupReason, popupSeqKey, popupText, readPopupSeq,
  shouldPopup, toNotifyItem, writePopupSeq,
} from '../src/notify.ts'
import { shouldUseSystemNotify } from '../src/desktopNotify.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const row = (seq, action, extra = {}) => ({
  seq, ts: '2026-10-10T09:20:' + String(seq % 60).padStart(2, '0') + '.000Z',
  member: 'soldier-auto', scope: 'software', action, taskId: null, detail: {}, ...extra,
})

/** 内存版 Storage（只实现 readPopupSeq/writePopupSeq 用到的两个方法）。 */
function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    dump: () => Object.fromEntries(map),
  }
}

describe('BUG-021 弹框决策：只弹高优先级', () => {
  test('★★ 进入「待验收」要弹（这就是将军没收到的那条）', () => {
    const it = toNotifyItem(row(100, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }), EMPTY_READ_STATE)
    assert.equal(shouldPopup(it), true, '★ in_review 是高优先级（notifyPriority 既有口径） ⇒ 必须弹')
  })

  test('★★ 进入「受阻」要弹', () => {
    const it = toNotifyItem(row(101, 'transition', { taskId: 'T-9', detail: { to: 'blocked' } }), EMPTY_READ_STATE)
    assert.equal(shouldPopup(it), true)
  })

  test('★★ 开工/产物登记/普通状态变更**不弹**（进徽标与通知中心即可）', () => {
    const cases = [
      row(102, 'claim', { taskId: 'T-1' }),
      row(103, 'artifact', { taskId: 'T-1' }),
      row(104, 'transition', { taskId: 'T-1', detail: { to: 'in_progress' } }),
      row(105, 'transition', { taskId: 'T-1', detail: { to: 'done' } }),
      row(106, 'create', { taskId: 'T-1' }),
    ]
    for (const r of cases) {
      const it = toNotifyItem(r, EMPTY_READ_STATE)
      assert.equal(shouldPopup(it), false, `${r.action}${JSON.stringify(r.detail)} 不该弹（弹框是打扰，门槛必须比进列表高）`)
    }
  })

  test('★★ 白名单外的噪音（progress/release-stale/chat:*）永远不弹', () => {
    for (const r of [
      row(107, 'progress', { taskId: 'T-1', detail: { percent: 50 } }),
      row(108, 'release-stale', { taskId: '*' }),
      row(109, 'chat:message', { taskId: 'T-1' }),
      row(110, 'comment', { taskId: 'T-1' }),
    ]) {
      const { popups } = popupBatch([r], 50, 3)
      assert.equal(popups.length, 0, r.action + ' 不该弹')
    }
  })
})

describe('BUG-021 弹框文案：一句话说清"哪个任务、要你做什么"', () => {
  test('★ 待验收：含任务号 + 「待你验收」', () => {
    const it = toNotifyItem(row(120, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }), EMPTY_READ_STATE)
    const text = popupText(it)
    assert.ok(text.includes('T-196'), '必须带任务号（否则用户不知道去哪处理）：' + text)
    assert.ok(text.includes('待你验收'), '必须说清是"等你验收"：' + text)
  })

  test('★ 受阻带"等你处理"；拦截/转派/测试报告各有自己的话', () => {
    assert.ok(popupText(toNotifyItem(row(121, 'transition', { taskId: 'T-7', detail: { to: 'blocked' } }), EMPTY_READ_STATE)).includes('等你处理'))
    assert.ok(popupText(toNotifyItem(row(122, 'hold', { taskId: 'T-7' }), EMPTY_READ_STATE)).includes('被拦截'))
    assert.ok(popupText(toNotifyItem(row(123, 'reassign', { taskId: 'T-7' }), EMPTY_READ_STATE)).includes('被转派'))
    assert.ok(popupText(toNotifyItem(row(124, 'test-report', { taskId: 'T-7' }), EMPTY_READ_STATE)).includes('测试报告'))
  })

  test('★ 可选角色中文名会被拼进括号（App 用 labels 解析后传入）', () => {
    const it = toNotifyItem(row(125, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }), EMPTY_READ_STATE)
    assert.ok(popupText(it, '方案搜索').includes('（方案搜索）'))
  })

  test('状态表覆盖全部任务状态（少一个就会在弹框里露出英文原文）', () => {
    for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']) {
      assert.equal(typeof NOTIFY_STATUS_LABEL[s], 'string', s + ' 缺中文')
      assert.ok(NOTIFY_STATUS_LABEL[s].length > 0)
    }
  })
})

describe('BUG-021 游标：不重弹、不补弹历史、不漏弹', () => {
  test('★★ 首次运行（无游标）只建立基线，**不弹历史**', () => {
    const rows = [row(200, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } }), row(199, 'transition', { taskId: 'T-1', detail: { to: 'blocked' } })]
    const { popups, lastSeq } = popupBatch(rows, 0, 3)
    assert.deepEqual(popups, [], '★ 否则一打开页面就被 200 条历史糊一脸，而下一步就是把这个功能关掉')
    assert.equal(lastSeq, 200, '基线要建立到最新，之后才算"新"')
  })

  test('★★ 同一批行弹过之后不再弹（游标推进，刷新页面也不重弹）', () => {
    const rows = [row(300, 'transition', { taskId: 'T-196', detail: { to: 'in_review' } })]
    const first = popupBatch(rows, 299, 3)
    assert.equal(first.popups.length, 1)
    assert.equal(first.lastSeq, 300)
    const second = popupBatch(rows, first.lastSeq, 3)
    assert.equal(second.popups.length, 0, '★ 游标已推进到 300 ⇒ 同一条不该再弹')
  })

  test('★★ 只有 seq 真正增长时才弹（乱序/重复帧不入）', () => {
    const rows = [
      row(402, 'transition', { taskId: 'T-B', detail: { to: 'in_review' } }),
      row(400, 'transition', { taskId: 'T-A', detail: { to: 'in_review' } }), // 已在游标之下
      row(401, 'transition', { taskId: 'T-C', detail: { to: 'blocked' } }),
    ]
    const { popups } = popupBatch(rows, 400, 3)
    assert.deepEqual(popups.map(p => p.seq), [401, 402], '★ 升序弹出（先发生先弹），且丢掉 <= 游标的')
  })

  test('★★ 一轮超过上限：只弹**最新**的几条，游标仍推进到最新（丢掉的进通知中心，不补弹）', () => {
    const rows = [1, 2, 3, 4, 5].map(n => row(500 + n, 'transition', { taskId: 'T-' + String(n), detail: { to: 'in_review' } }))
    const { popups, lastSeq } = popupBatch(rows, 500, 3)
    assert.deepEqual(popups.map(p => p.seq), [503, 504, 505], '★ 只弹最新的 3 条')
    assert.equal(lastSeq, 505, '★ 游标推进到最新 ⇒ 被丢掉的不会下一轮又弹一遍')
  })

  test('★ 空列表不推进游标（断线/拉空不该把游标清零）', () => {
    const { popups, lastSeq } = popupBatch([], 777, 3)
    assert.deepEqual(popups, [])
    assert.equal(lastSeq, 777)
  })

  test('★ 游标按**未过滤**全量行推进（白名单外的行也在涨 seq，否则会反复重扫）', () => {
    const rows = [
      row(900, 'release-stale', { taskId: '*' }),
      row(901, 'progress', { taskId: 'T-1', detail: { percent: 50 } }),
      row(899, 'transition', { taskId: 'T-1', detail: { to: 'in_review' } }),
    ]
    const { popups, lastSeq } = popupBatch(rows, 898, 3)
    assert.equal(lastSeq, 901, '★ 游标要吃到 901（否则每轮都从 899 重扫）')
    assert.deepEqual(popups.map(p => p.seq), [899], '但只弹白名单内的高优先级那条')
  })
})

describe('BUG-021 游标持久化：与已读游标分开、只前进', () => {
  test('★ 存储键与已读键**不同**（拿已读游标当弹框游标会两头都错）', () => {
    assert.equal(popupSeqKey('software'), 'legion.notify.popupseq.software')
    assert.notEqual(popupSeqKey('software'), 'legion.notify.read.software')
    assert.equal(popupSeqKey(null), 'legion.notify.popupseq.__all__')
  })

  test('★ 读：没有/损坏/负数一律 0（= 下次只建立基线，不炸）', () => {
    assert.equal(readPopupSeq('software', memStorage()), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.notify.popupseq.software': 'abc' })), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.notify.popupseq.software': '-5' })), 0)
    assert.equal(readPopupSeq('software', memStorage({ 'legion.notify.popupseq.software': '421' })), 421)
  })

  test('★★ 写：只前进 —— 落后的一方不许把游标推回去（否则会重弹）', () => {
    const s = memStorage({ 'legion.notify.popupseq.software': '500' })
    writePopupSeq('software', 400, s)
    assert.equal(readPopupSeq('software', s), 500, '★ 并发标签页里落后的那个不许回退游标')
    writePopupSeq('software', 600, s)
    assert.equal(readPopupSeq('software', s), 600)
  })

  test('★ 写：非正数/NaN 不写（首次基线为 0 时不该留下记录）', () => {
    const s = memStorage()
    writePopupSeq('software', 0, s)
    writePopupSeq('software', Number.NaN, s)
    assert.deepEqual(s.dump(), {})
  })

  test('★ 换空间换一把游标（否则新空间的历史会被当成"新发生的"弹出来）', () => {
    const s = memStorage()
    writePopupSeq('software', 100, s)
    assert.equal(readPopupSeq('software', s), 100)
    assert.equal(readPopupSeq('ozon', s), 0, '★ 另一个空间没有游标 ⇒ 只建立基线')
  })
})

describe('BUG-021 首次补告时间窗：装上提醒的那一刻不能什么都不说', () => {
  // 上面那条"首次只建立基线"守的是**不糊脸**；这一节守的是它的另一面：
  // 若首次完全沉默，则"我装了提醒"与"可我还是不知道 T-196 在等我"会同时成立。
  const NOW = Date.parse('2026-10-10T18:00:00.000Z')
  const SIX_H = 6 * 60 * 60 * 1000
  const at = (seq, action, taskId, detail, ts) => ({ ...row(seq, action, { taskId, detail }), ts })

  test('★★ 首次运行 + 时间窗：窗内的补告，窗外的丢掉', () => {
    const rows = [
      at(600, 'transition', 'T-196', { to: 'in_review' }, '2026-10-10T17:20:00.000Z'), // 40 分钟前
      at(601, 'transition', 'T-OLD', { to: 'in_review' }, '2026-10-09T02:00:00.000Z'), // 一天前
    ]
    const { popups, lastSeq } = popupBatch(rows, 0, 3, { nowMs: NOW, replayWindowMs: SIX_H })
    assert.deepEqual(popups.map(p => p.item.taskId), ['T-196'], '★ 只补告窗内那件"在等你"的事')
    assert.equal(lastSeq, 601, '游标仍建立在最新（窗外的不会再补弹）')
  })

  test('★ 窗口为 0（默认）= 纯建立基线，与老行为一致', () => {
    const rows = [at(602, 'transition', 'T-196', { to: 'in_review' }, '2026-10-10T17:59:00.000Z')]
    assert.deepEqual(popupBatch(rows, 0, 3).popups, [])
    assert.deepEqual(popupBatch(rows, 0, 3, { nowMs: NOW, replayWindowMs: 0 }).popups, [])
  })

  test('★ 时间窗只对**首次**生效：游标已有之后，窗内的旧事件不许重弹', () => {
    const rows = [at(603, 'transition', 'T-196', { to: 'in_review' }, '2026-10-10T17:50:00.000Z')]
    const { popups } = popupBatch(rows, 603, 3, { nowMs: NOW, replayWindowMs: SIX_H })
    assert.deepEqual(popups, [], '★ 游标已推进 ⇒ 窗内也不再补弹（只有真正新发生的才弹）')
  })

  test('★ 未来时间戳（时钟漂移/坏数据）不入窗', () => {
    const rows = [at(604, 'transition', 'T-FUTURE', { to: 'in_review' }, '2026-10-10T20:00:00.000Z')]
    const { popups } = popupBatch(rows, 0, 3, { nowMs: NOW, replayWindowMs: SIX_H })
    assert.deepEqual(popups, [], 'age < 0（未来）不算"你刚才不在时发生的"')
  })

  test('★ 窗内超过上限：只补告最新的几条', () => {
    const rows = [1, 2, 3, 4, 5].map(n => at(700 + n, 'transition', 'T-' + String(n), { to: 'in_review' }, '2026-10-10T17:5' + String(n) + ':00.000Z'))
    const { popups } = popupBatch(rows, 0, 2, { nowMs: NOW, replayWindowMs: SIX_H })
    assert.deepEqual(popups.map(p => p.item.taskId), ['T-4', 'T-5'])
  })

  test('★ 窗内也只看高优先级（开工/产物登记不因"首次"而混进来）', () => {
    const rows = [
      at(800, 'claim', 'T-A', {}, '2026-10-10T17:55:00.000Z'),
      at(801, 'artifact', 'T-B', {}, '2026-10-10T17:56:00.000Z'),
      at(802, 'transition', 'T-C', { to: 'in_progress' }, '2026-10-10T17:57:00.000Z'),
    ]
    assert.deepEqual(popupBatch(rows, 0, 3, { nowMs: NOW, replayWindowMs: SIX_H }).popups, [])
  })
})

describe('BUG-021 系统通知（桌面端"人不在看页面"时的那一半）', () => {
  test('★★ 只在页面不可见 **且** 已授权时才发', () => {
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'granted' }), true)
    assert.equal(shouldUseSystemNotify({ hidden: false, permission: 'granted' }), false,
      '★ 页面可见时右下角弹框已经说过了，再发一条系统通知是重复打扰')
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'default' }), false,
      '★ 没授权不许发（也绝不自动请求——自动弹授权框会被拒，拒一次就回不来）')
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'denied' }), false)
    assert.equal(shouldUseSystemNotify({ hidden: true, permission: 'unsupported' }), false)
  })
})

// ============================================================================
// BUG-022：将军实测「T-199 我没看到弹框」——两处让提醒**根本不会响**的缺陷
//
//   ① 桌面端那个 effect 从前的第一行是 `if (!hubMode || !scope) return`：
//      **"全部空间"视图一个弹框都没有**。而"我现在没选空间"与"我不想被提醒"
//      毫无关系 —— 将军当时就停在这个视图上。
//   ② 文案只说状态（「待你验收」），不说**为什么停在这**。T-199 的真实原因是
//      `自动合入失败，等待人工处理`，与"等你验收"是**两个不同的动作**。
// ============================================================================

describe('BUG-022 弹框必须能说明"为什么停在这"', () => {
  test('★★ 真实那条挡住 T-199 的评论，要能被抽出来', () => {
    const real = '⚠ 编码实现完成，但自动合入主分支失败（可能冲突），改动保留在分支 w/T-199。请人工合入并推进：git -C D:/project/DSH/legion merge --no-ff w/T-199'
    const reason = popupReason(real)
    assert.ok(reason !== null, '★ 这条是"要人动手"的语气，必须抽出来')
    assert.ok(reason.includes('自动合入主分支失败'), '原因要说清是"合入失败"：' + reason)
    assert.ok(reason.length <= 64, '弹框是一句话，不能把整段 worker 汇报糊上去：' + reason)
  })

  test('★★ 纯进展播报**不加**说明（弹框已经够吵了）', () => {
    for (const t of [
      '🟢 已派 AI worker 开始执行（worker=scrum:T-199，隔离 worktree=…）——进行中，完成/异常将自动更新并流转',
      '✅ 需求澄清完成，方案文档已合入主分支。请将军人工验收',
      '进度 50%',
    ]) {
      assert.equal(popupReason(t), null, '进展播报不该被当成"要你动手"：' + t.slice(0, 30))
    }
  })

  test('★ 取**第一行**（评论第一行就是结论，后面是命令与细节）', () => {
    const reason = popupReason('⚠ 自动合入失败，等待人工处理\n\ngit merge --no-ff w/T-199\n解决冲突后推进')
    assert.equal(reason, '⚠ 自动合入失败，等待人工处理')
  })

  test('★ 空/非字符串/空行开头都安全（返回 null，不抛）', () => {
    assert.equal(popupReason(null), null)
    assert.equal(popupReason(undefined), null)
    assert.equal(popupReason(''), null)
    assert.equal(popupReason('\n\n  \n'), null)
    assert.equal(popupReason(42), null)
    assert.equal(popupReason('\n\n⛔ 冲突未解决'), '⛔ 冲突未解决')
  })

  test('★ 超长截断（带省略号，不是硬切）', () => {
    const r = popupReason('失败：' + '很长的说明'.repeat(40))
    assert.ok(r.endsWith('…'))
    assert.ok(r.length <= 64)
  })
})

describe('BUG-022 接线：不许因为"没选空间"就不提醒', () => {
  const src = readFileSync(resolve(ROOT, 'workbench/src/App.tsx'), 'utf8')

  test('★★ 桌面端：拉审计时不把 scope 当必要条件（null = 全部空间）', () => {
    assert.match(src, /fetchHubActivity\(\{ scope: scope \?\? undefined/,
      '★ 从前 `if (!hubMode || !scope) return` ⇒ "全部空间"视图一个弹框都没有（将军就停在那）')
    assert.doesNotMatch(src, /if \(!hubMode \|\| !scope\) \{\n\s+setNotifyUnread\(0\)\n\s+popupSeqRef\.current = 0/,
      '★ 那段早退必须消失，否则提醒在"没选空间"时静默失效')
  })

  test('★★ 桌面端：弹框会去取任务最新评论作为"为什么停在这"', () => {
    assert.match(src, /reasonForPopup\(/, '弹框要带上原因（实测 T-199 的真实原因与"待你验收"完全不同）')
    assert.match(src, /fetchHubTask\(tid\)/, '原因来自任务详情的最新评论')
  })

  test('★ 桌面端：点弹框要跳到**那条任务所在的空间**的通知中心', () => {
    assert.match(src, /itemScope !== null && itemScope !== scope/, '跨空间提醒要先把空间切过去')
  })
})
