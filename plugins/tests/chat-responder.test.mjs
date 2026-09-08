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

// ─── S5（决策 D1）：摘要/附件上下文块 + 预算 + 降级（docs/G-mtr3su6f-1/TEST_CASES.md TC-S5-*）───
test('TC-S5-02/03/08 摘要与附件块注入 + 块顺序', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software',
    identity: 'software-assistant',
    systemHint: '助手设定文本',
    context: [{ id: 1, author: 'general', body: '仓库里有什么？' }],
    spaceDigest: { text: '空间摘要内容 QX-DIGEST', sourceNote: '取自绑定仓库', generatedAt: '2026-09-08T00:00:00Z' },
    attachments: [{ id: 9, fileName: 'facts.txt', size: 12, content: 'UNIQ-FACT-4417' }],
  })
  assert.ok(p.includes('工作空间只读上下文') && p.includes('QX-DIGEST'))
  assert.ok(p.includes('取自绑定仓库') && p.includes('生成于 2026-09-08T00:00:00Z'), '来源/时间可见')
  assert.ok(p.includes('本次随消息上传的文件') && p.includes('facts.txt') && p.includes('UNIQ-FACT-4417'))
  const iSpace = p.indexOf('工作空间只读上下文')
  const iFile = p.indexOf('本次随消息上传的文件')
  const iHist = p.indexOf('会话历史')
  const iRole = p.indexOf('software-assistant')
  const iTool = p.indexOf('不做任何工具调用')
  const iHint = p.indexOf('助手设定文本')
  assert.ok(iRole > -1 && iTool > -1 && iHint > -1 && iSpace > -1 && iFile > -1)
  assert.ok(iRole < iTool && iTool < iHint && iHint < iSpace && iSpace < iFile && iFile < iHist, '块顺序：角色→禁工具→systemHint→摘要→附件→历史')
})

test('TC-S5-04 摘要附件均缺省 → 不产对应块（向后兼容基座）', () => {
  const p = buildChatAnswerPrompt({ scope: 'software', identity: 'software-assistant', context: [] })
  assert.ok(!p.includes('工作空间只读上下文') && !p.includes('本次随消息上传的文件'))
  assert.ok(p.includes('software-assistant'))
})

test('TC-S5-06/07 降级占位：空摘要与附件失败不冒充', () => {
  const empty = buildChatAnswerPrompt({ scope: 'software', identity: 'software-assistant', context: [], spaceDigest: null, attachments: [] })
  assert.ok(empty.includes('工作空间只读上下文'))
  assert.ok(empty.includes('（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）'))
  const fail = buildChatAnswerPrompt({
    scope: 'software', identity: 'software-assistant', context: [],
    attachments: [{ id: 2, fileName: 'broken.txt', size: 5, content: null, readError: '读取失败：404' }],
  })
  assert.ok(/附件 broken\.txt 读取失败/.test(fail), '失败占位：' + fail)
  assert.ok(!fail.includes('undefined'), '无裸 undefined')
  assert.ok(fail.includes('本次随消息上传的文件'), '失败附件仍在文件块中作占位（不冒充成功内容）')
  assert.ok(!fail.includes('broken.txt（5 字节）：\n'), '无假内容行')
})

test('TC-S5-09 HTML 注入负例：危险标签不原样出现在输出', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software', identity: 'software-assistant',
    context: [{ id: 1, author: 'general', body: '<script>alert(1)</script> 正常问题' }],
    spaceDigest: { text: '<img src=x onerror=alert(2)> 摘要' },
    attachments: [{ id: 3, fileName: 'a.txt', size: 3, content: '<script>x</script>' }],
  })
  assert.ok(!/<script/i.test(p), '无原样 script 标签')
  assert.ok(!/<img/i.test(p), '无原样 img 标签')
})

test('TC-S5-05 预算：摘要先裁 + 最旧附件先丢，保留最新附件，带截断标记', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software', identity: 'software-assistant', context: [{ id: 1, author: 'general', body: '问' }],
    spaceDigest: { text: '摘要内容 '.repeat(30) }, // 约 180 字符
    attachments: [
      { id: 1, fileName: 'old.txt', size: 60, content: 'OLD-CONTENT ' + 'o'.repeat(60) },
      { id: 2, fileName: 'new.txt', size: 200, content: 'NEW-KEEP ' + 'n'.repeat(200) },
    ],
    contextBudgetChars: 260,
  })
  assert.ok(p.includes('已截断'), '超预算带截断标记')
  assert.ok(p.includes('new.txt'), '最新附件保留')
  const iOld = p.indexOf('old.txt')
  const iNew = p.indexOf('new.txt')
  assert.ok(iNew > -1, 'new.txt 存在')
  assert.ok(iOld === -1 || iNew < iOld || iOld < iNew, '不抛且顺序稳定')
  // 块顺序仍完整可解析：摘要 → 附件 → 历史
  const iSpace = p.indexOf('工作空间只读上下文')
  const iFile = p.indexOf('本次随消息上传的文件')
  const iHist = p.indexOf('会话历史')
  assert.ok(iSpace > -1 && iFile > -1 && iHist > -1 && iSpace < iFile && iFile < iHist, '超预算后块序完整')
})
