// plugins/tests/chat-responder.test.mjs — S10（R-4）chat-responder 纯函数契约（身份解析/提示词/护栏）。
// 运行：node plugins/tests/chat-responder.test.mjs；依赖 pnpm build 产物 plugins/lib。
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatIdentityFor, buildChatAnswerPrompt } from '../lib/chatResponder.js'

test('TC-S10-04/D-15 回复方身份默认 <scope>-assistant；settings.identity 覆盖；与 general 不同', () => {
  assert.equal(chatIdentityFor('software'), 'software-assistant')
  assert.notEqual(chatIdentityFor('software'), 'general')
  assert.equal(chatIdentityFor('software', 's9-bot'), 's9-bot', 'settings.identity 覆盖默认')
  assert.equal(chatIdentityFor('software', ''), 'software-assistant', '空覆盖 → 回退默认')
})

test('TC-S10-01 提示词 = 空间对话助手 + 会话历史（含提问）；无仓库工具授权字样', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software',
    convTitle: '帮助会话',
    identity: 'software-assistant',
    systemHint: '你是该空间的编码助手',
    context: [
      { id: 1, author: 'general', body: '前置问题' },
      { id: 2, author: 'coder', body: '追问细节' },
      { id: 3, author: 'general', body: '请总结' },
    ],
  })
  assert.ok(p.includes('software-assistant'), '身份行')
  assert.ok(p.includes('帮助会话'), '会话标题')
  assert.ok(p.includes('你是该空间的编码助手'), 'systemHint')
  assert.ok(p.includes('[general（消息 1）] 前置问题'), '历史按序')
  assert.ok(p.includes('[general（消息 3）] 请总结'), '含提问本身')
  assert.ok(/不(要|做)任何工具调用/.test(p) || /不做任何工具调用/.test(p), '禁工具声明')
})

test('TC-S10-02/03 空回复/异常语义在提示词层面的护栏：提示词要求如实说明而非编造（防半条回复）', () => {
  const p = buildChatAnswerPrompt({ scope: 'software', identity: 'software-assistant', systemHint: null, context: [{ id: 7, author: 'general', body: '不知道就问' }] })
  assert.ok(p.length > 0)
  assert.ok(/无法回答|超出可回答范围/.test(p) || /如实说明/.test(p), '不可答时如实说明')
})

test('TC-S10-05 护栏：prompt 生成不依赖任何设置开关（开关语义由调用方/服务端队列收口）', () => {
  // 开关关时服务端根本不产生 awaiting；本纯函数只负责身份与提示词，identity 与 general 区分即可
  const p = buildChatAnswerPrompt({ scope: 'mkt', identity: chatIdentityFor('mkt'), context: [] })
  assert.ok(p.includes('mkt-assistant'))
  assert.ok(p.includes('（无更早消息）'), '无历史不崩')
})
