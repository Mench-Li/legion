// plugins/tests/comment-intent.test.mjs
// ============================================================================
// F3 · 守护侧：一条「他人评论」到底是**打回**还是**追加**（设计稿 §3 F3）
//
// 今天两者走同一条路（都当退回纠错），于是"顺手再加个日志"和"你这段不对，重做"
// 在守护眼里是同一件事——任务被标成失败、退避计数也跟着涨。
//
// 判据：
//   ① 无 @ ⇒ rework（打回，行为不变）
//   ② @<其他角色> ⇒ order（追加续跑：不是失败，不该涨退避）
//   ③ @general ⇒ escalate（升级为提问：**不要**自动重派，等人拍板）
//   ④ 边界：邮箱 / 单词内的 @ 不算；重复 @ 只算一次
//   ⑤ 只认最新一条评论的意图（旧评论不复活）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyFeedback, MENTION_INTENTS } from '../lib/commentIntent.js'

test('① 常量固定', () => {
  assert.deepEqual([...MENTION_INTENTS], ['rework', 'order', 'escalate'])
})

test('② 无 @ ⇒ rework（打回，与今天一致）', () => {
  const out = classifyFeedback({ texts: ['这段实现和需求不符，重做'], author: 'general', soldier: 'coder', roles: ['coder', 'general'] })
  assert.equal(out.intent, 'rework')
  assert.deepEqual(out.addressedTo, [])
})

test('③ @<其他角色> ⇒ order（追加续跑，不是失败）', () => {
  const out = classifyFeedback({ texts: ['@coder 顺手把日志也加上'], author: 'general', soldier: 'coder', roles: ['coder', 'general'] })
  assert.equal(out.intent, 'order')
  assert.deepEqual(out.addressedTo, ['coder'])
})

test('④ @general ⇒ escalate（等人拍板，别自动重派）', () => {
  const out = classifyFeedback({ texts: ['@general 这个取舍要您定'], author: 'coder', soldier: 'coder', roles: ['coder', 'general'] })
  assert.equal(out.intent, 'escalate')
  assert.equal(out.deliverable, false, '★ 升级为提问时守护应停手')
})

test('⑤ 边界：邮箱 / 单词内 @ 不算；重复 @ 只算一次', () => {
  const email = classifyFeedback({ texts: ['写我邮箱 me@example.com 即可'], author: 'general', soldier: 'coder', roles: ['coder', 'example'] })
  assert.equal(email.intent, 'rework', '★ 邮箱不是提及')

  const dup = classifyFeedback({ texts: ['@coder @coder @coder 干活'], author: 'general', soldier: 'coder', roles: ['coder'] })
  assert.deepEqual(dup.addressedTo, ['coder'])
})

test('⑥ 只看最新一条带内容的评论（旧 @ 不复活）', () => {
  const out = classifyFeedback({
    texts: ['@coder 早先那句追加', '现在这句是打回：这段不对'],
    author: 'general', soldier: 'coder', roles: ['coder', 'general'],
  })
  assert.equal(out.intent, 'rework', '★ 最新一句没有 @ ⇒ 就是打回')
})

test('⑦ 自我 @ 被忽略后回落 rework', () => {
  const out = classifyFeedback({ texts: ['@coder 我自己补一句'], author: 'coder', soldier: 'coder', roles: ['coder'] })
  assert.equal(out.intent, 'rework')
  assert.deepEqual(out.ignoredSelf, ['coder'])
})

test('⑧ 未注册角色的 @ 不算，回落 rework', () => {
  const out = classifyFeedback({ texts: ['@ghost 你看下'], author: 'general', soldier: 'coder', roles: ['coder', 'general'] })
  assert.equal(out.intent, 'rework')
  assert.deepEqual(out.unknownRoles, ['ghost'])
})
