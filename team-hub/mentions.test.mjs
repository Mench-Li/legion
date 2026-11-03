// team-hub/mentions.test.mjs
// ============================================================================
// F3 · `@` 的三种语义（设计稿 §3 F3 / M4）
//
// 一条评论因为"@ 了谁"而分流：
//   无 @          → comment（现状：普通批注 / 打回）
//   @<其他角色>    → order（追加续跑）
//   @general     → escalate（升级为提问，等人拍板）
//
// 四条护栏（按设计稿 I-3.1 ~ I-3.5）：
//   ① 只认 scope 成员（@ 一个不存在的角色不算数）
//   ② 只在可续跑状态生效（in_progress / awaiting_answer）；其它状态只写输入不投递
//   ③ 自己 @ 自己 ⇒ 忽略（评论者 == 当前士兵）
//   ④ 幂等：重复 @ 同一个人只算一次；@ 只提升强度，**永不绕过闸**
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MENTION_EFFECTS, parseMentions, classifyComment } from './mentions.mjs'

test('① 常量固定：三种语义', () => {
  assert.deepEqual([...MENTION_EFFECTS], ['comment', 'order', 'escalate'])
})

test('② 边界正则：邮箱 / 单词中间的 @ 不算提及', () => {
  const out = parseMentions('联系 me@example.com 与 foo@coder，以及 @general 拍板', { roles: ['general', 'coder'] })
  assert.deepEqual(out.addresses, ['general'], '★ 邮箱与单词内 @ 不是提及')
  assert.equal(out.mentions.length, 1)
})

test('③ 只认 scope 成员：@ 一个不在编队里的角色 ⇒ 不算数', () => {
  const out = parseMentions('@ghost 你看下', { roles: ['coder', 'general'] })
  assert.deepEqual(out.addresses, [])
  assert.deepEqual(out.unknownRoles, ['ghost'], '未知角色要能被诊断出来')
})

test('④ 幂等：重复 @ 同一个人只算一次', () => {
  const out = parseMentions('@coder @coder @coder 干活', { roles: ['coder'] })
  assert.deepEqual(out.addresses, ['coder'])
})

test('⑤ 自己 @ 自己 ⇒ 忽略（评论者 == 当前士兵）', () => {
  const out = parseMentions('@coder 我自己看看', { roles: ['coder'], selfRole: 'coder' })
  assert.deepEqual(out.addresses, [])
  assert.deepEqual(out.ignoredSelf, ['coder'], '★ 自 @ 要被记为忽略，而不是静默消失')
})

test('⑥ 分流：无 @ ⇒ comment；@ 他人 ⇒ order；@general ⇒ escalate', () => {
  assert.equal(classifyComment({ text: '这里有问题', author: 'general', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder', 'general'] }).effect, 'comment')
  assert.equal(classifyComment({ text: '@coder 顺手把日志也加上', author: 'general', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder', 'general'] }).effect, 'order')
  assert.equal(classifyComment({ text: '@general 这个取舍要您定', author: 'coder', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder', 'general'] }).effect, 'escalate')
})

test('⑦ 状态白名单：不在可续跑状态时只写输入，不投递', () => {
  const out = classifyComment({ text: '@coder 补一句', author: 'general', soldier: 'coder', status: 'in_review', scopeRoles: ['coder'] })
  assert.equal(out.effect, 'order', '语义仍算 order（记录意图）')
  assert.equal(out.deliverable, false, '★ 但 in_review 不该因此派工')
  assert.equal(out.reason, 'status-not-deliverable')

  const ok = classifyComment({ text: '@coder 补一句', author: 'general', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder'] })
  assert.equal(ok.deliverable, true)
  const waiting = classifyComment({ text: '@coder 补一句', author: 'general', soldier: 'coder', status: 'awaiting_answer', scopeRoles: ['coder'] })
  assert.equal(waiting.deliverable, true, 'awaiting_answer 也算可续跑')
})

test('⑧ 自 @ 只剩空 ⇒ 退化成普通评论（不投递给自己）', () => {
  const out = classifyComment({ text: '@coder 我再补一句', author: 'coder', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder'] })
  assert.equal(out.effect, 'comment')
  assert.equal(out.deliverable, false)
  assert.deepEqual(out.ignoredSelf, ['coder'])
})

test('⑨ escalate 与 order 同时出现时，escalate 优先（人要拍板的事不能被当成顺手活）', () => {
  const out = classifyComment({ text: '@coder @general 这个要先定口径', author: 'general', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder', 'general'] })
  assert.equal(out.effect, 'escalate')
  assert.deepEqual([...out.addressedTo].sort(), ['coder', 'general'])
})

test('⑩ 纯函数：同一输入两次结果相同（守护可以安全重算）', () => {
  const input = { text: '@coder 试试', author: 'general', soldier: 'coder', status: 'in_progress', scopeRoles: ['coder'] }
  assert.deepEqual(classifyComment(input), classifyComment(input))
})
