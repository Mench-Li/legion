// runtime/dsh-composition/whitelist-wiring.test.mjs
//
// ★★★ 岗位白名单（PRT-603）的**生产路径**：环境里那份许可 → 端口 → 真桥。
//
// `whitelist-port.test.mjs`（17 例）钉的是**端口自己**；`employee-manifest.test.mjs`
// （20 例）钉的是 `permitsTool()` 的每一条规则；这一份钉的是**它们接起来之后**
// 那件事 —— 用的是真端口（从环境键造出来的那一个）、真 `permitsTool`
// （端口内部调它）、真桥（`createEnforcementBridge`）。
//
// ## 这一份为什么必须存在（第 21 轮留下的那格读数）
//
// 第 21 轮量到的失效模式是：桥交给端口的是**执行面（DSH）名**，而唯一的产出者
// `permitsTool()` 读的是 **Legion 能力名**，两个空间**结构上不相交** ⇒
// 同一份 permit，喂 Legion 名**放行**、喂 DSH 名**一个都不放行**
// （拒因从 `risk-above-ceiling` 挪到 `unknown-tool-not-named`，**还是拒**）。
// 于是"把这一格点亮"曾经被记为**会得到一个全拒的强制面**。
//
// 第 27 条裁决（用 Legion 名 + 加一层映射）落地的就是 `whitelist-port.mjs`。
// ⇒ 本套件是那一处裁决的**生产路径验收点**：它要证明的不只是"端口放行/拒绝正确"，
//   而是"**DSH 名进来、Legion 名被判定**"这条路真的走通了。
//
//   > 一个"两侧各自都有自己的用例、而中间那层词汇表没人量过"的强制面，
//   > 与一个"词汇表没接上、于是它拒掉一切"的强制面，
//   > 在两侧用例都绿的时候是同一个读数。
//
// ★ 正对照的纪律（本仓库被咬过多次）：① 里桥的 `decide` **自己说 allow**，
//   所以那一条 `deny` **只可能**来自白名单；② 里同一份投影换清单能翻面，
//   证明读的是清单而不是常量；⑤ 里"没配"走的是放行，而不是全拒 ——
//   这三条各自挡掉一种"判据恒真/恒假"的假绿。
//
// ★ 本套件**不**碰"那份许可从哪来"：它**只**声明"环境里有它、并且它是 Legion 名"
//   这个前提。前提本身在生产里今天**没有产出者**（见 §5 第 14 / 27 条），
//   那是一条**裁决**，不是本套件能替产品回答的。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEnforcementBridge } from './tool-request.mjs'
import {
  WHITELIST_PORT_ENV_KEY,
  WHITELIST_PORT_STATES,
  whitelistPortFromEnv,
} from './whitelist-port.mjs'
import { MANIFEST_CODES } from './employee-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', '..', rel), 'utf8')

/** 进程级上下文（与每一次 Run 的覆盖无关，本条不测身份）。 */
const PROC_CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.read', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})

/** 一份许可 —— **Legion 能力名**，与 `permitsTool()` 的输入空间一致。 */
const permitOf = (over = {}) => ({
  version: 'legion/employee-manifest@1',
  employeeId: 'e-1', role: 'reader', displayName: '只读岗',
  unattended: false,
  allowedTools: ['read-file'],
  allowedCapabilities: ['file:read'],
  maxRisk: 'low',
  workspaceRoot: null,
  ...over,
})

const envWith = (permit) => ({ [WHITELIST_PORT_ENV_KEY]: JSON.stringify(permit) })

/**
 * 真桥 + 从环境造出来的真端口（组合根那一行的同一处调用）。
 *
 * ★ `decide` 默认**说 allow**：这样本套件里任何一次 `deny`
 *   都只可能出自白名单那一格（不然策略拒绝与白名单拒绝在读数上同形）。
 */
function bridgeFor(permit, { decide = () => ({ kind: 'allow' }) } = {}) {
  const built = whitelistPortFromEnv({ env: permit === null ? {} : envWith(permit) })
  const bridge = createEnforcementBridge({
    context: PROC_CTX,
    decide,
    whitelist: built.port,
  })
  return { bridge, built }
}

/** 执行面（DSH）名的调用 —— `name` 就是 `read` / `write` / `bash`。 */
const execOf = (name, args = {}, callId = 'c-1') => ({
  name, callId, arguments: args, agent: { id: 'agent-1' },
})

const drive = (bridge, exec) => bridge.preExecute(exec).then((d) => d)

// ★ `callId` **每次都不同**：生产里 DSH 给每一次调用一个自己的 callId，
//   而"同一个 callId 的第二份请求"是另一件事（见 ⑦）。
const READ = execOf('read', { path: 'C:/work/a.txt' }, 'c-read-1')
const WRITE = execOf('write', { path: 'C:/work/a.txt', mode: 'w' }, 'c-write-1')

// ══════════════════════════════════════════════════════════════════════════
// ① ★★★ 生产路径：DSH 名进来 ⇒ 放行 / 按**能力**拒
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 真端口 + 真桥：Legion 名许可下 `read` 放行、`write` 被拒（而策略自己说 allow）', async () => {
  const { bridge, built } = bridgeFor(permitOf())
  assert.equal(built.state, WHITELIST_PORT_STATES.CONFIGURED,
    `端口没配起来：${built.reason}`)

  const ok = await drive(bridge, READ)
  assert.equal(ok.kind, 'allow',
    `只读许可下 read 竟然被拒了：${JSON.stringify(ok)} —— ` +
    '若拒因是 unknown-tool-not-named，说明**词汇表层没接上**（第 21 轮那个失效模式）')

  const bad = await drive(bridge, WRITE)
  assert.equal(bad.kind, 'deny')
  // ★ 拒绝必须**看得出是白名单拒的**：岗位清单与策略规则是两处不同的配置，
  //   值班的人要能分清该改哪一个（`tool-request.mjs:996` 那句注释的判据）。
  assert.match(bad.reason, /岗位白名单拒绝/, `拒因没写明是白名单：${bad.reason}`)
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 词汇表层**在链路里**：判定用的是 Legion 名，不是 DSH 名
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 拒绝的理由里带着**翻译后的 Legion 名**，且拒因不是「未知工具」', async () => {
  const { bridge } = bridgeFor(permitOf())
  const bad = await drive(bridge, WRITE)

  // 端口把 `translated.legionTool` 拼进了理由（`whitelist-port.mjs:315`）。
  assert.match(bad.reason, /write-file/,
    `拒因里没有 Legion 名 ⇒ 翻译那一步没走（${bad.reason}）`)

  // ★★★ 这一条正对着第 21 轮量到的那个失效模式：喂 DSH 名时
  //   `permitsTool` 会说"这个工具没被具名"（`unknown-tool-not-named`）——
  //   因为 `write` 不是 Legion 词表里的名字。今天它应当说**能力不够**。
  assert.equal(bad.reason.includes(MANIFEST_CODES.UNKNOWN_TOOL_NOT_NAMED), false,
    '★ 还是「未知工具」——那说明端口拿 DSH 名直接问了 `permitsTool`，' +
    '第 27 条那层映射没生效（这正是"接上去得到一个全拒的强制面"那个形状）')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ ★★ 正对照：它读的是**清单**，不是常量
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★ 同一份投影，换一份许可就能翻面（证明判据读的是清单）', async () => {
  const readOnly = await bridgeFor(permitOf())
  const permissive = await bridgeFor(permitOf({
    allowedTools: ['read-file', 'write-file'],
    allowedCapabilities: ['file:read', 'file:write'],
    maxRisk: 'high',
  }))

  assert.equal((await drive(readOnly.bridge, WRITE)).kind, 'deny')
  assert.equal((await drive(permissive.bridge, WRITE)).kind, 'allow',
    '★ 正对照失败：给了写权限的许可也拒 ⇒ 上面的"拒"什么也证明不了')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★★ 一对多：没有裁决 ⇒ 具名拒绝并**列出候选**；有裁决 ⇒ 能判
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★★ `bash` 是一对多：没裁决时**列出候选**，裁决后按裁决判', async () => {
  // （a）没有裁决：`LEGION_TOOL_ROUTING` 的反推在 `bash` 上是多条 ⇒ 不许猜
  const undecided = await bridgeFor(permitOf({
    allowedTools: ['git-status'], maxRisk: 'high',
  }))
  const v1 = await drive(undecided.bridge, execOf('bash', { command: ['git', 'status'] }, 'c-bash-1'))
  assert.equal(v1.kind, 'deny')
  assert.match(v1.reason, /候选|candidate/i,
    `歧义拒绝没有列出候选，值班的人无从裁决：${v1.reason}`)

  // （b）装配期给了裁决：判给低风险的 `git-status` ⇒ 许可里有它 ⇒ 放行
  const decidedStatus = await bridgeFor(permitOf({
    allowedTools: ['git-status'], maxRisk: 'high', toolNameDecisions: { bash: 'git-status' },
  }))
  const v2 = await drive(decidedStatus.bridge, execOf('bash', { command: ['git', 'status'] }, 'c-bash-2'))
  assert.equal(v2.kind, 'allow',
    `裁决把 bash 判给了 git-status、而许可里有 git-status，却还是拒：${v2.reason}`)

  // （c）★ 反方向：判给高风险的 `git-push` ⇒ 许可里没有它 ⇒ **必须拒**
  //     （少了这一条，"裁决生效"与"裁决被忽略、一律放行"就分不出来）
  const decidedPush = await bridgeFor(permitOf({
    allowedTools: ['git-status'], maxRisk: 'high', toolNameDecisions: { bash: 'git-push' },
  }))
  const v3 = await drive(decidedPush.bridge, execOf('bash', { command: ['git', 'push'] }, 'c-bash-3'))
  assert.equal(v3.kind, 'deny', '判给 git-push 而许可里没有它，竟然放行了')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 缺席：**没配 ≠ 全拒**（而这正是它必须由组合根显式处置的原因）
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★ 环境里没有那个键 ⇒ state=absent、端口为 null，而桥**放行**', async () => {
  const { bridge, built } = bridgeFor(null)
  assert.equal(built.state, WHITELIST_PORT_STATES.ABSENT)
  assert.equal(built.port, null, '缺席时端口必须是 null（不是"拒绝一切"的那个函数）')

  const v = await drive(bridge, WRITE)
  assert.equal(v.kind, 'allow',
    '★ 端口为 null 时桥那一段**根本不进入** ⇒ 放行。' +
    '若这里变成 deny，那是"没配"被实现成了"全拒"——两者在用户眼里都是"工具坏了"')

  // ★ 而"缺席"这条读数必须**说得出口**：`enforcementSurfaces()` 那一格是 false，
  //   组合根要显式处置它（PRT-603 的缺口就是这样被记下来的）。
  assert.match(built.reason, /LEGION_EMPLOYEE_PERMIT|不进入|放行/)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★★ 组合根那一个注入点：许可来自**环境**，不是凭空造的
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★ `root-row.mjs` 注入的是**环境造出来的**端口，不是一份编的许可', () => {
  const src = read('runtime/dsh-composition/plugins/root-row.mjs')

  // 端口从环境造：`whitelistPortFromEnv({ env: effectiveEnv })`
  assert.match(src, /whitelistPortFromEnv\s*\(/,
    '组合根不再从环境造端口了 —— 请重读 PRT-253 §3：' +
    '"不发明任何默认值、替身或暂时放行"')

  // 注入点是那一行，而且注入的是 `whitelist.port`
  assert.match(src, /whitelist:\s*whitelist\.port/,
    '★ 组合根的 `whitelist` 注入点变了。若它变成了一份**写死的许可**，' +
    '那条路径就是"凭空造一份范围表"（PRT-253 §3 明令禁止）——' +
    '它会让"没人给这个端口值"与"岗位白名单生效了"在读数上同形')

  // 而那份许可**只**从这一个键来（不是第二个键、也不是常量）
  const port = read('runtime/dsh-composition/whitelist-port.mjs')
  assert.match(port, /WHITELIST_PORT_ENV_KEY\s*=\s*'LEGION_EMPLOYEE_PERMIT'/)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ ★★★ 复用 `callId` **不能**洗白一次拒绝（第 118 轮第十轮量到并修掉的缺陷）
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★★ 同一个 `callId` 的第二份**不同**请求：拒绝，而不是替它复用第一份的判决', async () => {
  const { bridge } = bridgeFor(permitOf())
  const REUSED = 'c-reused'

  const first = await drive(bridge, execOf('read', { path: 'C:/work/a.txt' }, REUSED))
  assert.equal(first.kind, 'allow', '正例不通，那下面的"拒"什么也证明不了')

  // ★★★ 这条就是缺陷本身：同一个 callId 换成 `write`。
  //   修之前它**放行**（桥拿第一份 `read` 的投影判了第二次调用）。
  const second = await drive(bridge, execOf('write', { path: 'C:/work/a.txt', mode: 'w' }, REUSED))
  assert.equal(second.kind, 'deny',
    '★ 复用 callId 洗白了一次拒绝 —— 一次放行变成了那个 callId 的永久通行证。' +
    '`byCallId` 那条缓存**命中时必须核对身份**（工具名 + 规范化后的参数），' +
    '不是"callId 相同就是同一次调用"')
  assert.match(second.reason, /另一次调用|callId/,
    `拒因必须说出是"callId 被复用了"，否则值班的人只会看到一条它看不懂的白名单拒绝：${second.reason}`)

  // ★ 而且这件事要留成**矛盾读数**（前端已有 `assertNoContradiction` 在读它）：
  //   同一个 callId 上出现两份不同请求，本身就是一条该被看见的记录。
  const contradictions = bridge.contradictions()
  assert.ok(contradictions.some((c) => c.code === 'tool-request-call-id-reused'),
    `没有留下矛盾读数：${JSON.stringify(contradictions)}`)

  // ★ 参数被换（工具名相同）也要拦住：`read` 允许读的路径不能顺带允许另一条。
  const third = await drive(bridge, execOf('read', { path: 'C:/Windows/System32/config' }, REUSED))
  assert.equal(third.kind, 'deny', '同一个 callId 换了参数竟然放行')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ ★★ 正对照：**真的重试**（同 callId、同工具、同参数）仍然命中缓存
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★ 真的重试不被 ⑦ 误伤：同 callId + 同工具 + 同参数仍然放行', async () => {
  const { bridge } = bridgeFor(permitOf())
  const RETRY = 'c-retry'
  const exec = execOf('read', { path: 'C:/work/a.txt' }, RETRY)

  assert.equal((await drive(bridge, exec)).kind, 'allow')
  assert.equal((await drive(bridge, exec)).kind, 'allow',
    '★ 同一次调用的重试被拒了 —— 那是把 ⑦ 的判据做成了"凡复用 callId 一律拒"。' +
    '`byCallId` 存在的理由正是"同一次调用不重复问人"')
  assert.deepEqual(bridge.contradictions(), [],
    '真重试留下了矛盾读数 —— 判据把"重试"与"矛盾"混成了一件')
})
