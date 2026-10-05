// plugins/tests/timeout-settlement.test.mjs
// ============================================================================
// BUG-007 回归：worker 超时后的结算必须**先取证、再决定**
//
// 缺陷形态（现场记录 docs/bugs/BUG-007-timeout-reservation-not-released.md）：
//   超时结算只写一句"任务保留在 in_progress，下一轮自动重试"就返回——既不改变任务状态、
//   也不碰写入预约；15 分钟后守护自己的 stale 回收器把预约冻结成 reconciling，
//   那句话永远无法兑现，任务每 40 分钟卡死一次（实测 T-178/T-179 同时卡死）。
//
// 本套件钉两件事，缺一不可：
//   ① **能取证**时必须走既有诚实出口（released + 回 todo + 下一轮真能重派）；
//   ② **取不到证据**时必须保持持有（不许"顺手释放"——abort 不保证杀死子代理，
//      而重派会复用同一个 worktree ⇒ 两个写者落进同一目录），且文案要**说实话**。
//
// ★ ②是这套件最容易被人"顺手改掉"的一条：把 hold 改成 release 会让测试更容易绿，
//   但会把"两个写者"放进来。所以 ② 的断言写得比 ① 更死。
// ============================================================================
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  planTimeoutSettlement,
  planTimeoutTransitionFailure,
  workerStoppedWithin,
  TIMEOUT_SETTLE_GRACE_MS,
} from '../lib/timeoutSettlement.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_SRC = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')

// ★ 断言要针对**可执行代码**，不是注释：修好之后，源码里仍应允许（也应当）
//   出现"从前是这么写的"这种**解释性注释**——把注释也算进去，会让这条防回归
//   在"有人老实写了为什么改"时误报，从而被下一个人顺手删掉。
const stripComments = (s) => s
  .replace(/\r\n/g, '\n')                      // ★ CRLF 归一：跨行断言在 Windows 检出上必须成立
  .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, '')             // 整行行注释（只剥整行，避免误伤含 :// 的字符串）
const INDEX_CODE = stripComments(INDEX_SRC)

test('① 取得终止证据 ⇒ 释放并重派：回 todo、confirmedStopped=true', () => {
  const p = planTimeoutSettlement({ taskId: 'T-178', stopped: true, graceMs: 20_000, timeoutMinutes: 25 })
  assert.equal(p.action, 'release-and-retry')
  assert.equal(p.to, 'todo', '必须回 todo，否则下一轮无法重派')
  assert.equal(p.confirmedStopped, true,
    'must-be-true: 只有 confirmedStopped=true 才会让 hub 侧释放预约（team-hub/server.mjs 的 transition）')
  // 文案必须与效果一致：说了会重派，就必须写出"已确认终止"这个前提
  assert.match(p.comment, /已确认该次执行终止/)
  assert.match(p.comment, /写入占用随之释放/)
  assert.match(p.comment, /下一轮重派/)
  assert.match(p.comment, /w\/T-178/, '要写明复用哪个 worktree 的 WIP')
  assert.ok(!/不会自动重试/.test(p.comment), '释放分支不该出现"不会自动重试"')
})

test('② 取不到终止证据 ⇒ 保持持有，且文案必须说实话（这条不许被改成 release）', () => {
  const p = planTimeoutSettlement({ taskId: 'T-179', stopped: false, graceMs: 20_000, timeoutMinutes: 25 })
  assert.equal(p.action, 'hold-for-manual')
  assert.equal(p.to, null,
    'must-be-null: 不动状态。若改成 todo，hub 侧会因 confirmedStopped=false 把预约**冻结**，反而锁死')
  assert.equal(p.confirmedStopped, false,
    'must-be-false: 取不到证据时释放预约 = 放进第二个写者（重派复用同一 worktree）')
  // 文案三要素：说清占用还在、说清不会自动重试、给出确切恢复命令
  assert.match(p.comment, /未能确认该 worker 已停止/)
  assert.match(p.comment, /写入占用仍被本轮持有/)
  assert.match(p.comment, /不会自动重试/)
  assert.match(p.comment, /POST \/api\/tasks\/T-179\/reservation\/confirm-stopped/)
  assert.match(p.comment, /"confirm":"stopped:T-179"/)
  // ★ 反向：不许承诺自动重试（这正是原缺陷的病征）
  assert.ok(!/下一轮自动重试/.test(p.comment), 'hold 分支不许承诺自动重试：它做不到')
})

test('③ workerStoppedWithin：run 结算（resolve 或 reject）都算取得证据', async () => {
  const ok = await workerStoppedWithin({ result: Promise.resolve({ stopReason: 'aborted' }) }, 1000)
  assert.equal(ok, true, 'run 结算 = 该次执行已到终态，这是可用的终止证据')
  const rejected = await workerStoppedWithin({ result: Promise.reject(new Error('boom')) }, 1000)
  assert.equal(rejected, true, 'reject 同样是"run 已结束"的证据（异常路径不许被当成"还在跑"）')
})

test('④ workerStoppedWithin：宽限期内不结算 ⇒ 取不到证据（不许猜成"已停止"）', async () => {
  const never = new Promise(() => {})   // 永不结算，模拟"subagent 挂死"
  const started = Date.now()
  const ok = await workerStoppedWithin({ result: never }, 60)
  assert.equal(ok, false, '取不到证据必须是 false —— 这里若返回 true，就会放进第二个写者')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 50, `必须真的等满宽限期才放弃（实测等了 ${elapsed}ms）`)
  assert.ok(elapsed < 2000, '宽限期到点必须返回，不能把扫描循环拖住')
})

test('⑤ 宽限期常量是个"给收尾留余量、又不拖住扫描"的量级', () => {
  assert.equal(TIMEOUT_SETTLE_GRACE_MS, 20_000)
  assert.ok(TIMEOUT_SETTLE_GRACE_MS >= 5_000, '太短会把"正在收尾的写操作"误判成挂死')
  assert.ok(TIMEOUT_SETTLE_GRACE_MS <= 30_000, '太大会拖住扫描循环（intervalMs 是 30 秒量级）')
})

test('⑥ 接线防回归：index.ts 不许再出现那句做不到的承诺，且必须真的取证', () => {
  // 这一条钉的是"调用点"。纯函数再对，调用点不用它也等于没修——
  // 而原来的实现恰好就是"写了一句好听的评论然后什么都不做"。
  // ★ 针对**代码**而非注释（见上面 stripComments 的理由）。
  assert.ok(!INDEX_CODE.includes('任务保留在 in_progress，下一轮自动重试'),
    'index.ts 的可执行代码里那句"下一轮自动重试"必须已被删除（它是本缺陷的病征）')
  // ★ 不变量：超时那条评论**只在一处产出**（planTimeoutSettlement）。
  //   从前它是散在调用点里的一句字面量，于是"实现改了、评论还在承诺旧行为"——
  //   这正是本缺陷的形态（承诺与效果两张皮）。所以这里钉"调用点不许再自己写超时文案"。
  //   （注意不能简单断言"safeComment 里不许出现自动重试"：L3647 的调解器文案
  //    "调解已自动重试 2 次"是**真的**，那样写会误伤合法代码而被下一个人删掉。）
  assert.ok(!/safeComment\([^)]*worker 超时/.test(INDEX_CODE),
    '超时评论必须由 planTimeoutSettlement 产出，不许在调用点另写一份（否则文案会与实现漂移）')
  assert.ok(INDEX_CODE.includes('planTimeoutSettlement({'),
    'index.ts 必须经 planTimeoutSettlement 决定结算方式（不要在调用点重写一遍判断）')
  assert.ok(INDEX_CODE.includes('await workerStoppedWithin(run, TIMEOUT_SETTLE_GRACE_MS)'),
    'index.ts 必须先取证（workerStoppedWithin），再决定是否释放')
  assert.ok(INDEX_CODE.includes('stopped: workerStopped'),
    '取证结果必须真的喂给 planTimeoutSettlement')
  assert.ok(INDEX_CODE.includes('transitionTo(t.id, settlement.to, t.scope ?? scope, settlement.confirmedStopped)'),
    '释放路径必须走 transitionTo 并把 confirmedStopped 传下去（hub 侧正是靠它决定释放还是冻结）')
  // 顺序也要钉住：dispose 必须在取证之前（先终止本次会话，再问它是否终止）
  const iDispose = INDEX_CODE.indexOf('await run.dispose().catch(() => undefined)\n      const workerStopped = await workerStoppedWithin')
  assert.ok(iDispose >= 0, '顺序必须是：先 dispose（终止会话），再取证（workerStoppedWithin）')
})

test('⑦ 取证成功但转 todo 失败 ⇒ 文案必须改成"没释放、不会自动重试"（不许沿用释放成功的文案）', () => {
  const f = planTimeoutTransitionFailure({ taskId: 'T-178', scope: 'default', reason: '乐观锁冲突：任务 T-178 当前 version=9' })
  // 必须说清失败与后果——这两条是"读数与事实一致"的核心
  assert.match(f.comment, /自动把任务释放回 todo 失败/)
  assert.match(f.comment, /写入占用仍被本轮持有/)
  assert.match(f.comment, /不会自动重试/)
  // ★ 反向：释放没成功时，句子必须是"随之释放 / 下一轮重派"的**否定**
  assert.ok(!/写入占用随之释放/.test(f.comment), '释放失败时不许说"写入占用随之释放"')
  assert.ok(!/下一轮重派/.test(f.comment), '释放失败时不许承诺"下一轮重派"')
  // 恢复路径要能照着做：confirm-stopped 只对 reconciling+todo 开放，所以必须先迁回 todo
  assert.match(f.comment, /POST \/api\/transition \{"id":"T-178","to":"todo","by":"general","scope":"default"\}/)
  assert.match(f.comment, /POST \/api\/tasks\/T-178\/reservation\/confirm-stopped/)
  assert.match(f.comment, /"confirm":"stopped:T-178"/)
  // 失败原因要写进文案，不能让人去猜
  assert.match(f.comment, /乐观锁冲突/)
  assert.match(f.activity, /保持持有等待人工/)
})

test('⑧ 接线防回归：index.ts 在 transition 失败分支改用失败文案，成功文案只在成功后打印', () => {
  assert.ok(INDEX_CODE.includes('planTimeoutTransitionFailure({'),
    'index.ts 必须在 transition 抛错时产出"释放失败"文案')
  assert.ok(INDEX_CODE.includes('timeoutComment = failure.comment'),
    '评论必须在失败分支被改写成 failure.comment，否则释放没成功却打印释放成功的读数')
  assert.ok(INDEX_CODE.includes('timeoutActivity = failure.activity'),
    '活动流同样要改写（否则活动流说已释放重派、预约却还持有）')
  assert.ok(INDEX_CODE.includes('await safeComment(t.id, timeoutComment)'),
    'safeComment 必须打印最终裁定后的文案，而不是无条件打印 settlement.comment')
  assert.ok(INDEX_CODE.includes('let timeoutComment = settlement.comment'),
    '成功路径仍须使用 planTimeoutSettlement 产出的文案（防被顺带删掉）')
})
