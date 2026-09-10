/**
 * chat-ui.test.mjs — 对话中心前端纯函数回归（P2-6）。
 *
 * 覆盖 workbench/src/chatUi.ts：
 *   健康状态判定与可行动文案（模型不可用/超时/守护离线/开关关闭）、AI 三态栏位、
 *   消息合并（awaiting→replied/failed 同 id 覆盖）、断线恢复缺口判据与连接状态文案、
 *   发送可用性与失败文案、诚实标注。
 * 运行：node --test --experimental-strip-types workbench/scripts/chat-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aiStateView, aiStatusOf, canSend, chatHealthView, chatSseLabel,
  isMine, maxSeqOf, replyModelOf, sendFailText, shouldRefillChat,
} from '../src/chatUi.ts'
// 合并语义的实现是 dedupe.mergeById（ChatView 直接调用它）——此处对**同一函数**做对话语义锚定，
// 避免为同一语义维护两份 API。
import { mergeById } from '../src/dedupe.ts'

const msg = (id, o = {}) => ({ id, author: 'general', body: 'b' + String(id), meta: null, ...o })

test('AI 三态取值：awaiting/replied/failed 之外一律 null（不显示状态条）', () => {
  assert.equal(aiStatusOf(msg(1, { meta: { aiStatus: 'awaiting' } })), 'awaiting')
  assert.equal(aiStatusOf(msg(2, { meta: { aiStatus: 'replied' } })), 'replied')
  assert.equal(aiStatusOf(msg(3, { meta: { aiStatus: 'failed' } })), 'failed')
  assert.equal(aiStatusOf(msg(4, { meta: { aiStatus: 'other' } })), null)
  assert.equal(aiStatusOf(msg(5, { meta: null })), null)
  assert.equal(aiStatusOf(msg(6, {})), null)
})

test('AI 态栏位：三态文案、模型名透出、失败可重试、非本人消息不显示', () => {
  assert.equal(aiStateView(msg(1, { meta: { aiStatus: 'awaiting' } }), 'general')?.state, 'awaiting')
  assert.equal(aiStateView(msg(1, { meta: { aiStatus: 'awaiting' } }), 'general')?.text, '等待 AI 回复…')
  const failed = aiStateView(msg(2, { meta: { aiStatus: 'failed', aiError: 'provider 超时' } }), 'general')
  assert.equal(failed?.state, 'failed')
  assert.equal(failed?.retryable, true)
  assert.ok(failed?.text.includes('provider 超时'))
  // 失败但无原因 → 不显示 undefined
  assert.equal(aiStateView(msg(3, { meta: { aiStatus: 'failed' } }), 'general')?.text, '回复失败：原因未知')
  const replied = aiStateView(msg(4, { meta: { aiStatus: 'replied' } }), 'general')
  assert.equal(replied?.state, 'replied')
  assert.equal(replied?.text, '已回复', '无模型信息时不编造模型名')
  assert.equal(replied?.retryable, false)
  assert.equal(aiStateView(msg(4, { meta: { aiStatus: 'replied', aiModel: 'x' } }), 'other'), null, '别人的消息不显示 AI 态')
  assert.equal(aiStateView(msg(4, { meta: { aiStatus: 'replied' } }), null), null, '未识别身份 → 不显示')
  assert.equal(isMine(msg(9, { author: 'general' }), 'general'), true)
  assert.equal(isMine(msg(9, { author: 'other' }), 'general'), false)
})

test('回复模型解析：模型在**回复行**上（服务端 postAiReply 只给源消息写 replyMsg），须按 replyMsg 回查', () => {
  // 服务端实际形态：源消息 meta = {aiStatus, repliedAt, replyMsg}；回复行 meta = {replyTo, aiModel}
  const source = msg(10, { meta: { aiStatus: 'replied', repliedAt: 't', replyMsg: 11 } })
  const reply = msg(11, { author: 'software-assistant', meta: { replyTo: 10, aiModel: 'deepseek-v4-flash-openai' } })
  assert.equal(replyModelOf(source, [source, reply]), 'deepseek-v4-flash-openai', '按 replyMsg 回查到回复行模型')
  assert.equal(aiStateView(source, 'general', [source, reply])?.text, '已回复 · deepseek-v4-flash-openai')
  // 列表里没有回复行（未加载/被清理）→ 不显示模型，但不崩溃
  assert.equal(replyModelOf(source, []), null)
  assert.equal(replyModelOf(source, null), null)
  assert.equal(aiStateView(source, 'general', [])?.text, '已回复')
  // 源消息自带 aiModel（旧数据/兼容路径）优先
  assert.equal(replyModelOf(msg(12, { meta: { aiStatus: 'replied', aiModel: 'legacy-model' } }), []), 'legacy-model')
  // aiReplyId 兼容别名
  assert.equal(replyModelOf(msg(13, { meta: { aiStatus: 'replied', aiReplyId: 11 } }), [reply]), 'deepseek-v4-flash-openai')
  // 回复行 meta 无 aiModel / 空白 → null（不显示「· undefined」）
  assert.equal(replyModelOf(msg(14, { meta: { aiStatus: 'replied', replyMsg: 15 } }), [msg(15, { meta: { replyTo: 14 } })]), null)
  assert.equal(replyModelOf(msg(16, { meta: { aiStatus: 'replied', replyMsg: 17 } }), [msg(17, { meta: { aiModel: '   ' } })]), null)
  assert.equal(replyModelOf(msg(18, { meta: null }), []), null, '无 meta 不崩溃')
})

test('健康判定：未知/加载中/最近失败/前提缺失/就绪 五级优先级', () => {
  assert.deepEqual(chatHealthView(null, '端点不存在').label, '健康状态未知')
  assert.equal(chatHealthView(null, '端点不存在').color, 'var(--muted-2)', '端点缺失灰态不误导')
  assert.equal(chatHealthView(null).label, '检测中…')
  // 最近失败优先于其它前提缺失（红态给出可行动指引）
  const red = chatHealthView({ online: false, enabled: false, modelResolved: false, lastFail: { aiError: 'foreman down' } })
  assert.equal(red.color, 'var(--red)')
  assert.ok(red.title.includes('foreman down'))
  assert.ok(red.title.includes('重试'), '可行动：给出重试指引')
  // 前提缺失三条并列（黄态）
  const yellow = chatHealthView({ online: false, enabled: false, modelResolved: false, lastFail: null })
  assert.equal(yellow.color, 'var(--yellow)')
  assert.ok(yellow.title.includes('守护离线'))
  assert.ok(yellow.title.includes('AI 回复未开启'))
  assert.ok(yellow.title.includes('模型未配置'))
  // 单项缺失
  assert.ok(chatHealthView({ online: true, enabled: true, modelResolved: false }).title.includes('模型未配置'))
  assert.ok(chatHealthView({ online: false, enabled: true, modelResolved: true }).title.includes('守护离线'))
  assert.ok(chatHealthView({ online: true, enabled: false, modelResolved: true }).title.includes('未开启'))
  // 就绪（绿态）且带诚实标注
  const green = chatHealthView({ online: true, enabled: true, modelResolved: true })
  assert.equal(green.color, 'var(--green)')
  assert.ok(green.title.includes('已解析不代表 provider 实际可用'))
})

test('消息合并（dedupe.mergeById，ChatView 实际调用）：同 id 覆盖（AI 三态流转）、追加、保序去重、更早历史保留', () => {
  const a = msg(1, { meta: { aiStatus: 'awaiting' } })
  const older = msg(0)
  const prev = [older, a]
  // ② awaiting → replied：同 id 必须被覆盖（这正是「气泡停在等待回复」的根因）
  const merged = mergeById(prev, [msg(1, { meta: { aiStatus: 'replied', aiModel: 'm' } })])
  assert.equal(merged.length, 2)
  assert.equal(merged.find(m => m.id === 1)?.meta?.aiStatus, 'replied', '同 id 以最新版本覆盖')
  assert.equal(merged[0].id, 0, '更早历史保留在前')
  // ③ 新消息追加且整体按 id 升序（乱序输入也归位）
  const m2 = mergeById(prev, [msg(3), msg(2)])
  assert.deepEqual(m2.map(x => x.id), [0, 1, 2, 3])
  // 去重：同一批 incoming 内重复 id 只留一条
  const m3 = mergeById([], [msg(5), msg(5)])
  assert.equal(m3.length, 1)
  // 空输入边界
  assert.deepEqual(mergeById([], []), [])
  assert.deepEqual(mergeById(prev, []), prev, 'incoming 空 → 内容等价（保序）')
  // 与三态渲染联动：合并后再取值，模型经回复行解析可得（端到端语义闭合）
  const source = msg(20, { meta: { aiStatus: 'awaiting' } })
  const rows = mergeById([source], [
    msg(20, { meta: { aiStatus: 'replied', replyMsg: 21 } }),
    msg(21, { author: 'software-assistant', meta: { replyTo: 20, aiModel: 'm-x' } }),
  ])
  const finalSource = rows.find(x => x.id === 20)
  assert.equal(aiStateView(finalSource, 'general', rows)?.text, '已回复 · m-x', '合并后的三态与模型解析一致')
})

test('断线恢复缺口判据：首帧建基线不误报，跳变即判缺口，连续不报', () => {
  assert.equal(shouldRefillChat(0, [1]), false, '首帧只建立基线')
  assert.equal(shouldRefillChat(0, [999]), false, '首帧即使 seq 很大也不误报')
  assert.equal(shouldRefillChat(10, [11]), false, '连续 → 不需补齐')
  assert.equal(shouldRefillChat(10, [10]), false, '重复帧 → 不需补齐')
  assert.equal(shouldRefillChat(10, [12]), true, '跳变 1 个 → 判缺口')
  assert.equal(shouldRefillChat(10, [11, 12, 20]), true, '批内出现跳变即判缺口')
  assert.equal(shouldRefillChat(10, [Number.NaN, 11]), false, '非法 seq 忽略')
  assert.equal(maxSeqOf([3, 9, 1]), 9)
  assert.equal(maxSeqOf([Number.NaN, -5]), 0)
})

test('实时连接状态文案：四种状态各有可读文案与颜色', () => {
  assert.deepEqual(chatSseLabel('open'), { text: '实时已连接', color: 'var(--green)' })
  const re = chatSseLabel('reconnected', 3)
  assert.ok(re.text.includes('已重连') && re.text.includes('3'))
  assert.equal(re.color, 'var(--yellow)')
  assert.ok(chatSseLabel('reconnecting').text.includes('重连中'))
  assert.ok(chatSseLabel('closed').text.includes('已断开'))
  assert.equal(chatSseLabel('closed').color, 'var(--red)')
})

test('发送可用性与失败文案：草稿保留语义必须体现（重发指引）', () => {
  assert.equal(canSend('', 0), false)
  assert.equal(canSend('   ', 0), false, '纯空白不可发')
  assert.equal(canSend('hi', 0), true)
  assert.equal(canSend('', 1), true, '仅附件也可发')
  assert.ok(sendFailText(new Error('401 Unauthorized token 无效')).includes('草稿已保留'))
  assert.ok(sendFailText(new Error('401')).includes('未授权'), '401 归为未授权且给 token 指引')
  assert.ok(sendFailText(new Error('Failed to fetch')).includes('中枢不可达'))
  assert.ok(sendFailText(new Error('ECONNREFUSED')).includes('中枢不可达'))
  assert.ok(sendFailText(new Error('boom')).startsWith('发送失败：boom'))
  assert.ok(sendFailText('plain string').includes('plain string'), '非 Error 也可读')
})
