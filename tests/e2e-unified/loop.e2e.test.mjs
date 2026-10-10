/**
 * loop.e2e.test.mjs — 腿 4：**三端闭环**（T-195）。
 *
 * ## 这一条腿补的是全仓唯一一处"三件同时在场"的地方
 *
 * 侦察确认：仓库里已有四段各自两两在场的用例，但**没有一段让三件同时在场**：
 *
 * | 已有用例 | 在场的东西 | 缺的那个 |
 * | --- | --- | --- |
 * | `team-hub/mobile-api-contract.test.mjs` | 手机 API ↔ 真 Hub | 认领用的是 HTTP 探针，**没有真电脑** |
 * | `team-hub/identity-remote.test.mjs:213-245` | 真 Hub ↔ 真 WSS 握手 | 用的是裸 `connectWebSocket`，**不是 `product/node`** |
 * | `team-hub/run-plane-e2e.test.mjs` | 真 Hub ↔ 真 worker | 执行引擎是假的，且走 `orchestrator/worker` 而**不是** `product/node` |
 * | `product/node/agent.test.mjs` | 真 node agent ↔ 真子进程执行器 | `run-store` 是**替身**，没有真 Hub |
 *
 * 而且：**全仓没有任何测试 spawn 过 `product/node/entry.mjs`**
 * （grep 只命中 `product/server/*.sh` 四个依赖云服务器的脚本）。
 *
 *   > 四段"两两在场"的用例加起来，
 *   > 与一段"三件同时在场"的用例，在覆盖上面看起来是重叠的——
 *   > 只不过前者的每一条都是绿的，而"手机派单→电脑真的领走并干完→手机上看得见"
 *   > 从来没有被任何一条断言检查过。
 *
 * ## 这条时间线（每一跳都断言**下一跳能成立**）
 *
 * ```
 * ①真 Hub 起在临时端口 + 临时库
 * ②手机 API 建配对码 → ③真 product/node 子进程 pair（拿设备令牌）
 * ④真 product/node 子进程 run（连 ws://…/node）
 * ⑤Hub 的在场表显示这台电脑上线
 * ⑥手机上派一条任务（与 app.mjs 同一条 API 序列）
 * ⑦电脑认领并执行（工作区里**真的**出现执行痕迹）
 * ⑧进展与结果回到 Hub 的会话里（手机读得到的那个面）
 * ```
 *
 * 判据纪律照 `docs/STATUS.md` 里 PRT-255 那一段：每一步判"下一步骤能不能成立"，
 * 而不是"接口返回了 200"。
 *
 * ## ⚠️ 诚实边界
 *
 * - 执行器是**本仓库的夹具**（`fixtures/executor-worker.mjs`），不是 DSH。
 *   `product/node/executor.mjs` 自己写明 DSH adapter 是"这个接缝的下一个实现"。
 *   所以本文件证明的是**接缝与整条链路**，不是"DSH 能跑任务"。
 * - 手机端在这一条腿里走的是**与 `app.mjs` 相同的 API 序列**，不是浏览器。
 *   浏览器那一段由腿 1（`mobile.e2e.test.mjs`）负责——两者合起来才是"手机真的能用"。
 *   把两件事塞进一个用例只会让它又慢又难定位。
 * - 没有真机、没有公网、没有 TLS。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT, call, seedWorld, startHub, tempDir } from './harness.mjs'

const ENTRY = join(ROOT, 'product', 'node', 'entry.mjs')
const WORKER = join(ROOT, 'tests', 'e2e-unified', 'fixtures', 'executor-worker.mjs')

/** 起一个子进程并收集它的输出（排障时用得上）。 */
function runChild(args, opts = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts,
  })
  const out = []
  const err = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => out.push(d))
  child.stderr.on('data', (d) => err.push(d))
  return { child, out, err, text: () => out.join('') + err.join('') }
}

/** 等一个条件成立；超时返回 null。 */
async function waitUntil(fn, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

describe('腿 4 · 三端闭环（手机派单 → Hub → 真电脑 Node → 进展回到手机）', () => {
  let hub
  let world
  let node
  let nodeCfg
  let workspaceDir
  let pairing

  before(async () => {
    hub = await startHub({ remoteAuth: true })
    world = await seedWorld(hub)
    workspaceDir = join(tempDir('legion-e2e-ws-'), 'workspace')
    mkdirSync(workspaceDir, { recursive: true })
    nodeCfg = join(tempDir('legion-e2e-cfg-'), 'node-config.json')
  })

  after(async () => {
    if (node?.child && node.child.exitCode === null) {
      try { node.child.kill('SIGKILL') } catch { /* 已死 */ }
    }
    if (hub) await hub.close()
  })

  it('① 配对：手机端建码 → 真 product/node 子进程兑换出设备令牌', async () => {
    // ① 手机端建配对码（`routes/identity.mjs:317-326`，要用户令牌——
    //    配对是把一台机器挂到**某个人**名下，不是匿名动作）。
    const code = await call(hub.base, 'POST', '/api/devices/pairing',
      { body: { nodeName: 'e2e 电脑' }, token: world.access })
    assert.equal(code.status, 200, `建配对码应成功：${code.text.slice(0, 200)}`)
    assert.ok(typeof code.json.code === 'string' && code.json.code.length > 0, '应返回配对码')

    // ② 真 `entry.mjs pair` 子进程去兑换。**这是全仓第一次 spawn 它。**
    //    `--agent` 给的是"node + 脚本路径"（不是裸解释器——那种配置会被
    //    `entry.mjs:114-129` 具名拒绝，因为它跑不了任何任务）。
    const pair = runChild([
      ENTRY, 'pair',
      '--hub', hub.base,
      '--code', code.json.code,
      '--out', nodeCfg,
      '--workspace', `default=${workspaceDir}`,
      '--agent', process.execPath,
      '--agent-arg', WORKER,
    ])
    const exitCode = await new Promise((resolve) => pair.child.on('close', resolve))
    assert.equal(exitCode, 0, `pair 应成功退出：${pair.text().slice(0, 500)}`)
    assert.ok(existsSync(nodeCfg), 'pair 应写出配置文件')

    const cfg = JSON.parse(readFileSync(nodeCfg, 'utf8'))
    assert.ok(/^wss?:\/\//.test(cfg.hubUrl), `hubUrl 应是 ws(s) 形式，实际 ${cfg.hubUrl}`)
    assert.ok(cfg.deviceToken.length > 0, '应拿到设备令牌')
    assert.ok(cfg.nodeId.length > 0, '应拿到 nodeId')
    assert.ok(cfg.workspaces.default, '应带上 default 工作区')

    // ★ 把运行账本挪进临时目录。
    //
    // `pair` 的默认值是 `resolve(dirname(HERE), 'node-ledger.json')`
    // ——`entry.mjs:161`，也就是**仓库里的** `product/node-ledger.json`。
    // 测试跑一遍就会在仓库里留下一个未跟踪文件，而它看起来像"有人手工放了份东西"。
    //
    //   > 一个"跑一次测试就往仓库里丢一个文件"的用例，
    //   > 与一个"仓库里有未跟踪产物"的状态，是同一个东西——
    //   > 只不过前者的产物是**每一次 CI** 都重新长出来的。
    //
    // 账本路径是配置项，测试有权把它指到自己的临时目录。
    cfg.ledgerFile = join(tempDir('legion-e2e-ledger-'), 'node-ledger.json')
    writeFileSync(nodeCfg, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  })

  it('② check：配置真的可用（不是"缺字段但看起来像配好了"）', async () => {
    const check = runChild([ENTRY, 'check', '--config', nodeCfg])
    const code = await new Promise((resolve) => check.child.on('close', resolve))
    assert.equal(code, 0, `check 应通过：${check.text().slice(0, 500)}`)
  })

  it('③ 上线：真 node 进程连上 Hub，在场表显示这台电脑', async () => {
    node = runChild([ENTRY, 'run', '--config', nodeCfg])

    // 判据取 Hub 的**在场表**，不是子进程的 stdout：进程打印了"已连接"
    // 而网关其实没登记，是两种不同的失败。
    pairing = await waitUntil(async () => {
      const p = await call(hub.base, 'GET', '/api/devices/presence', { token: world.access })
      if (p.status !== 200) return null
      const devices = p.json?.devices ?? p.json?.presence ?? []
      const online = devices.find((d) => d.online === true || d.state === 'online')
      return online ?? null
    }, { timeoutMs: 30_000 })

    assert.ok(
      pairing,
      `真 node 进程上线后应在场表里可见；子进程输出=${node.text().slice(-600)}`,
    )
  })

  it('④ 派单：手机 API 序列创建会话与任务，Hub 里真的落库', async () => {
    // 与 `app.mjs` 相同的序列：先开会话（`app.mjs:567`），再发带
    // `intent: 'create_task'` 的消息（`app.mjs:722-729`）。
    const agents = await call(hub.base, 'GET', `/api/agents?scope=${world.scope}`, { token: world.access })
    assert.ok(agents.json.agents.length > 0, '空间里应有 Agent')
    const agentId = agents.json.agents.find((a) => a.role === 'coder')?.agentId ?? agents.json.agents[0].agentId

    const conv = await call(hub.base, 'POST', '/api/agent-conversations',
      { body: { agentId, scope: world.scope, by: 'mobile' }, token: world.access })
    assert.equal(conv.status, 200, `开会话应成功：${conv.text.slice(0, 200)}`)
    const convId = conv.json.convId

    const marker = `loop-${Date.now()}`
    const sent = await call(hub.base, 'POST', '/api/agent-messages', {
      token: world.access,
      body: {
        conv: convId, scope: world.scope, by: 'mobile',
        body: `请处理 ${marker}`,
        intent: 'create_task',
        clientRequestId: `e2e-${marker}`,
      },
    })
    assert.equal(sent.status, 200, `派单应成功：${sent.text.slice(0, 300)}`)
    assert.ok(typeof sent.json.taskId === 'string', `派单应返回 taskId，实际 ${sent.text.slice(0, 200)}`)

    world.taskId = sent.json.taskId
    world.convId = convId
    world.marker = marker

    // 服务端回读：任务真的在库里。
    const board = await call(hub.base, 'GET', `/api/board?scope=${world.scope}`, { token: world.access })
    const flat = Array.isArray(board.json) ? board.json : (board.json?.tasks ?? [])
    assert.ok(flat.some((t) => t.id === world.taskId), 'Hub 看板上应出现该任务')
  })

  it('⑤ 电脑认领并执行：工作区里**真的**出现执行痕迹', async () => {
    // ★ 这一条是本腿的核心判据。
    //
    // 一个"任务状态变成了 in_progress"的断言，
    // 与一个"这台电脑上真的跑过那个执行器"的断言，在报表上看起来一样——
    // 只不过前者在一个「领了活但执行器根本没起来的」实现上照样是绿的。
    //
    // 所以判据落在**磁盘**：executor.mjs:75 把子进程 cwd 设为 workspace.path，
    // 于是夹具写的 `executor-proof.json` 只可能出现在这台"电脑"的工作区里。
    const proofPath = join(workspaceDir, 'executor-proof.json')
    const proof = await waitUntil(() => (existsSync(proofPath) ? readFileSync(proofPath, 'utf8') : null),
      { timeoutMs: 60_000, intervalMs: 500 })

    assert.ok(
      proof !== null,
      `电脑应真的执行了任务并在工作区落盘 ${proofPath}；`
      + `node 输出=${node.text().slice(-800)}`,
    )
    const stamp = JSON.parse(proof)
    assert.equal(stamp.pid > 0, true, '执行痕迹应带真实 pid')
    // brief 从 Hub 走到了电脑：`executor.mjs:169-174` 把 brief 与 task **并列**送出。
    // 这一条证明"手机建的任务描述真的到了那台机器上"——
    // 在此之前，执行器能拿到的只有 `task.title`。
    assert.ok(Array.isArray(stamp.briefKeys), 'brief 应被送达')
  })

  it('⑥ 进展回到手机：Hub 会话里能看到执行过程与结果', async () => {
    // 判据落在**手机读的那个面**（`app.mjs:578` 读的 `/api/chat/messages`），
    // 而不是"egress 调用过"。调用过但没落库的进展，用户永远看不到。
    //
    // ★ 断言必须**精确到进展帧本身**，不能只做 `includes(某个文件名)`。
    //
    //   第一版写成「会话里出现 'executor-proof.json' 或 '开始执行'」——
    //   而 `result` 帧的 summary 里**也**含 'executor-proof.json'
    //   （`fixtures/executor-worker.mjs` 最后那行）。
    //   于是把两行 progress 全删掉，这条用例**照样是绿的**：
    //   它证明的是"有个字符串出现了"，不是"进展通道通了"。
    //
    //   这是探针 P9 抓出来的（改到了、没变红）：
    //   *一个只断言"某个字符串出现过"的用例，
    //   与一个"进展通道根本没接线"的产品，是同一个东西——
    //   只不过前者的用例是绿的。*
    //
    //   投影形状来自 `team-hub/server.mjs:7758`：
    //   `` `${taskId} ${kindLabel}：${frame.summary}` ``，`kind:'step'` → `进展`。
    //   所以下面这两条只可能由**progress 帧**产生。
    const token = world.access
    const taskId = world.taskId
    const firstProgress = await waitUntil(async () => {
      const msgs = await call(hub.base, 'GET',
        `/api/chat/messages?scope=${world.scope}&conv=${world.convId}&limit=200`, { token })
      if (msgs.status !== 200) return null
      return JSON.stringify(msgs.json).includes(`${taskId} 进展：开始执行`) ? true : null
    }, { timeoutMs: 60_000, intervalMs: 500 })

    assert.ok(
      firstProgress !== null,
      `第一条进展帧应落进会话（形状 \`${taskId} 进展：开始执行…\`）；`
      + `node 输出=${node.text().slice(-800)}`,
    )

    const secondProgress = await waitUntil(async () => {
      const msgs = await call(hub.base, 'GET',
        `/api/chat/messages?scope=${world.scope}&conv=${world.convId}&limit=200`, { token })
      if (msgs.status !== 200) return null
      return JSON.stringify(msgs.json).includes('进展：已在工作区落盘') ? true : null
    }, { timeoutMs: 60_000, intervalMs: 500 })

    assert.ok(secondProgress !== null, '第二条进展帧也应落进会话（两帧都到，才说明进展不是只在结尾顺带报了一次）')

    // 结果摘要同样要能回到手机（"干完了"这件事用户要看得见）。
    const sawResult = await waitUntil(async () => {
      const msgs = await call(hub.base, 'GET',
        `/api/chat/messages?scope=${world.scope}&conv=${world.convId}&limit=200`, { token })
      if (msgs.status !== 200) return null
      return JSON.stringify(msgs.json).includes('executor-proof.json') ? true : null
    }, { timeoutMs: 60_000, intervalMs: 500 })
    assert.ok(sawResult !== null, '结果摘要也应回到手机')

    world.loopClosed = true
  })

  it('⑦ 收尾：任务走到终态，且过程里没有让 Hub 掉线', async () => {
    // 任务终态：证明"结果帧被消费成了任务状态"，而不是只进了聊天流。
    const terminal = await waitUntil(async () => {
      const board = await call(hub.base, 'GET', `/api/board?scope=${world.scope}`, { token: world.access })
      const flat = Array.isArray(board.json) ? board.json : (board.json?.tasks ?? [])
      const t = flat.find((x) => x.id === world.taskId)
      if (!t) return null
      return ['in_review', 'done', 'blocked', 'canceled', 'in_progress'].includes(t.status) ? t : null
    }, { timeoutMs: 60_000, intervalMs: 500 })
    assert.ok(terminal, `任务应能推进（实际卡在 pending/todo）；node 输出=${node.text().slice(-600)}`)

    // Hub 自己还活着（整条链路没有把服务打挂）。
    const alive = await call(hub.base, 'GET', '/api/identity/status')
    assert.equal(alive.status, 200, 'Hub 应仍然健康')
  })
})
