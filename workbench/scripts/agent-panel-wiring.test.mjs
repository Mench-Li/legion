import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// C2 的**接线**判据（与 `model-config.test.mjs` 的 `routeAssemblySource()` 同一手法：
// 读源码断言接线还在）。为什么这类断言在这里必须存在：
//
//   `AgentConversationPanel` 上一次的死法**不是**逻辑错，而是：
//     · 全仓没有任何 import（没人挂载它）；
//     · 它用的 CSS 类（`.agent-conversation` / `.agent-chat-feed` / …）在样式表里一个都没有。
//   两件都不会让 tsc / 构建 / 任何既有测试变红 —— 它会一直"绿"着，直到有人打开界面发现是空白。
//   所以这里把两条都钉住：**必须被挂载** + **用到每个类都必须有样式**。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const PANEL = 'workbench/src/components/AgentConversationPanel.tsx'
const WORKSPACE = 'workbench/src/components/AgentWorkspace.tsx'
const CHAT = 'workbench/src/components/ChatView.tsx'

/** 抽出 TSX 里所有 `className="..."` / `className={`...`}` 里的**静态**类名（模板串只取字面片段）。 */
function classNamesIn(source) {
  const out = new Set()
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = m[1] ?? m[2] ?? ''
    // 模板串里的 ${...} 表达式取不到值，按空白切开后只收形如 foo-bar 的片段
    for (const token of raw.split(/[\s${}?:'"`]+/)) {
      if (/^[a-z][a-z0-9-]*$/.test(token)) out.add(token)
    }
  }
  return out
}

test('★ 死代码复活判据①：AgentConversationPanel 必须真的被挂载（上次它死于"全仓没人 import"）', () => {
  const ws = read(WORKSPACE)
  assert.match(ws, /import\s*\{[^}]*AgentConversationPanel[^}]*\}\s*from\s*'\.\/AgentConversationPanel'/,
    'AgentWorkspace 必须 import 这个面板，否则它又变回死代码')
  assert.match(ws, /<AgentConversationPanel\b/, '仅有 import 不算挂载：必须真的渲染它')
})

test('★ 死代码复活判据②：面板用到的每个样式类都必须在样式表里有定义（上次它们一个都没有）', () => {
  const css = read('workbench/src/index.css') + read('workbench/src/workspace.css')
  const used = classNamesIn(read(PANEL))
  // 只检查本组件自己的命名空间；通用类（btn/tag/chip…）由全局样式负责，不在这里判。
  const mine = [...used].filter(c => c.startsWith('agent-'))
  assert.ok(mine.length >= 8, `从面板里只抽到 ${mine.length} 个 agent-* 类，抽样逻辑可能失效`)
  const missing = mine.filter(c => !new RegExp(`\\.${c}(?![a-z0-9-])`).test(css))
  assert.deepEqual(missing, [],
    `这些类没有样式定义：${missing.join(', ')} —— 界面会是一片没有排版的裸文字（这正是它当初"看起来是坏"的原因）`)
})

test('★ 意图选择与控制抽屉的类也必须都有样式（同一个死法）', () => {
  const css = read('workbench/src/index.css') + read('workbench/src/workspace.css')
  const used = new Set([
    ...classNamesIn(read(CHAT)),
    ...classNamesIn(read(WORKSPACE)),
    ...classNamesIn(read(PANEL)),
  ])
  const mine = [...used].filter(c => c.startsWith('chat-intent-') || c.startsWith('agent-panel-') || c === 'agent-drawer-tabs')
  // 下界只是防"抽样逻辑悄悄失效"（正则改坏时会返回 0 个却全绿），不是要求有多少个类。
  assert.ok(mine.length >= 8, `只抽到 ${mine.length} 个新类，抽样逻辑可能失效`)
  const missing = mine.filter(c => !new RegExp(`\\.${c}(?![a-z0-9-])`).test(css))
  assert.deepEqual(missing, [], `这些新类没有样式定义：${missing.join(', ')}`)
  // 两个修饰态各自有独立含义（读取失败 / 正在回答），必须有样式，否则状态看不出来
  assert.match(css, /\.chat-intent-bar\.error\b/, '读取失败的提示条要有独立样式')
  assert.match(css, /\.chat-intent-bar\.answering\b/, '「正在回答待决策」要有独立样式（用户要能看出这条提交去哪儿了）')
})

test('★ 面板**不是**第二个聊天界面：没有输入框、没有发送按钮', () => {
  const panel = read(PANEL)
  assert.equal(/<textarea/.test(panel), false,
    '面板里不许再出现输入框——修法 C 的方向是一个 (空间, 岗位) 一条主对话，两套输入框等于把两条会话搬到界面上')
  assert.equal(/<input/.test(panel), false, '面板不是聊天界面，不该有输入控件')
  assert.equal(/发送|提交中/.test(panel), false, '面板不该有发送按钮；那属于 ChatView')
})

test('★ 控制命令只走 /api/agent-commands，且调用点唯一（不许在别处另起一套）', () => {
  const api = read('workbench/src/api.ts')
  assert.match(api, /export function postAgentCommand/, 'api.ts 必须导出 postAgentCommand')
  const ws = read(WORKSPACE)
  assert.match(ws, /postAgentCommand\(/, 'AgentWorkspace 是控制命令的唯一调用点')
  for (const f of [PANEL, CHAT]) {
    assert.equal(/postAgentCommand\(/.test(read(f)), false,
      `${f} 不该自己发控制命令：控制参数必须有唯一来源（两份可能不一致的执行身份会把命令打到错的那一轮）`)
  }
  // 四个动作都要接上（少一个就是"有一个按钮永远不出现"）
  for (const t of ['hold_task', 'release_hold', 'stop_run', 'resume_with_feedback']) {
    assert.match(read(PANEL), new RegExp(`'${t}'`), `控制命令 ${t} 没有接线`)
  }
})

test('★ 岗位对话的发送必须经过 planAgentSend（路由规则不许在组件里重写一遍）', () => {
  const chat = read(CHAT)
  assert.match(chat, /planAgentSend\(/, 'ChatView 必须用 planAgentSend 决定走哪条通道')
  assert.match(chat, /postAgentMessage\(/, '结构化消息要发到 /api/agent-messages')
  assert.match(chat, /postChatMessage\(/, '询问仍走聊天通道（附件与 AI 回复管道在那边）')
})

test('★ 意图下拉里出现"追问"以外的后果说明（不是裸术语）', () => {
  const chat = read(CHAT)
  assert.match(chat, /追加要求（下一轮生效）/, '选项要写后果：用户不需要知道 feedback 这个术语')
  assert.match(chat, /新建任务/, '新建任务要可选')
})

test('样式表存在且面板类落在浅色工作区样式里（不是暗色主题那份）', () => {
  assert.ok(existsSync(join(ROOT, 'workbench/src/workspace.css')), 'workspace.css 必须存在')
  const wsCss = read('workbench/src/workspace.css')
  assert.match(wsCss, /\.agent-panel-task-controls\b/, '控制按钮的样式应在 workspace.css（浅色工作区）里')
})
