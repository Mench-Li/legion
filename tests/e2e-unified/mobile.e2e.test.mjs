/**
 * mobile.e2e.test.mjs — 腿 1：**真浏览器（移动仿真）→ 真 Hub**（T-195）。
 *
 * ## 这一条腿补的是什么
 *
 * 仓库里已有四层手机端验证，各自都对，但**没有一层真的执行 `app.mjs`**：
 *
 * | 已有 | 证明什么 | 证明不了什么 |
 * | --- | --- | --- |
 * | `workbench/mobile/*.test.mjs` | 判定层纯函数（看板列、时间线合并、刷新循环） | 页面有没有把这些函数接上去 |
 * | `team-hub/mobile-api-contract.test.mjs` | 按 `app.mjs` 的顺序打真实 HTTP，字段名对得上 | 字段对了，但**不是页面自己发的请求** |
 * | `team-hub/mobile-routes.test.mjs` | 静态资源可达、路径安全、缓存头 | 页面加载后能不能用 |
 * | `workbench/scripts/mobile-board-parity.test.mjs` | 源码扫描（文案/常量一致） | 运行时行为 |
 *
 * `team-hub/mobile-api-contract.test.mjs:6-15` **自己写明了这个边界**：
 * 它按字段名核对，但页面本身没有被执行过。
 *
 *   > 一个"照着前端代码的顺序手工发的请求"，
 *   > 与一个"前端真的发出来的请求"，在接口契约上是同一个东西——
 *   > 只不过前者在"用户点下去有没有反应"这件事上什么都没说。
 *
 * 所以本文件用**真 Chrome 的移动仿真**（390×844、DPR 3、五点触控、移动 UA）
 * 打开真的 `workbench/mobile/`，用真触屏事件驱动，并把结论落到**服务端回读**上。
 *
 * ## 全部选择器都是核对过的，不是猜的
 *
 * 下面的 id 逐条来自 `workbench/mobile/index.html` 与 `app.mjs`：
 * `#login-name` / `#login-password`（index.html:156-157）、`#btn-login`（:160）、
 * `#screen-login` / `#main` / `#composer`（:153/168/180）、
 * `#agent-select`（:184）、`#composer-input`（:188）、`#btn-send`（:189）、
 * `#intents button[data-intent]`（app.mjs:452）、`#tab-tasks`（:149）、`#timeline`（:171）；
 * 存储键 `legion.mobile.access`（app.mjs:52，sessionStorage）与
 * `legion.mobile.agent` / `legion.mobile.scope`（:54-55，localStorage）。
 *
 *   > 一个"选择器写错了所以什么都没点到"的用例，
 *   > 与一个"页面真的坏了"的用例，在红/绿这一列上长得一模一样——
 *   > 只不过前者会让人去改一个本来就是对的页面。
 *
 * ## 判据纪律
 *
 * 每条断言都问"**服务端能不能看到**"，而不是"DOM 上有没有那行字"。
 * DOM 断言只在它本身就是产品行为时使用（例如状态条显示已连接）。
 *
 * 运行：`node --test tests/e2e-unified/mobile.e2e.test.mjs`
 * 无浏览器时整组 SKIP（不伪绿）。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { call, openMobilePage, probeBrowser, seedWorld, startHub } from './harness.mjs'

/** 访问令牌的存储键（app.mjs:52）。写死在这里是**故意的**：它变了这一套就该红。 */
const ACCESS_KEY = 'legion.mobile.access'

const probe = probeBrowser()
const describeBrowser = probe ? describe : describe.skip
if (!probe) {
  console.log('[skip] 未找到可用浏览器（Edge/Chrome），腿 1 跳过。设置 DSH_E2E_BROWSER=<路径> 可指定。')
}

/** 页面里当前存的访问令牌。 */
const accessOf = (page) => page.evaluate((k) => sessionStorage.getItem(k), ACCESS_KEY)

describeBrowser('腿 1 · 移动端（真浏览器移动仿真 → 真 Hub）', () => {
  let hub
  let world
  let session

  before(async () => {
    hub = await startHub({ remoteAuth: true })
    world = await seedWorld(hub)
    session = await openMobilePage()
    assert.ok(session, '浏览器应可用')
    await session.page.goto(`${hub.base}/mobile/`)
  })

  after(async () => {
    if (session) await session.close()
    if (hub) await hub.close()
  })

  it('① 移动仿真真的生效（三个开关各自的读数都被验到）', async () => {
    // ★ 这条断言集合是**量出来的**，不是凑的。
    //
    // 第一版只断言 `innerWidth/dpr/maxTouchPoints/UA/pointer:coarse` 五项，
    // 注释写着"四项一起才算移动仿真"。破坏性验证 P1（把
    // `setDeviceMetricsOverride` 的 `mobile: this.mobile` 改成 `mobile: false`）
    // **没有让它变红** —— 因为那五项里没有一项由 `mobile` 这个标志位控制。
    //
    // 实测（同一页面、逐个开关切换后读值）：
    //
    // | CDP 调用 | 它真正控制的读数 |
    // | --- | --- |
    // | `setDeviceMetricsOverride({ mobile })` | `screen.width/height`（390×844，关掉就回落成宿主的 800×600） |
    // | `setDeviceMetricsOverride({ width, height, deviceScaleFactor })` | `innerWidth`、`devicePixelRatio` |
    // | `setTouchEmulationEnabled({ maxTouchPoints })` | `navigator.maxTouchPoints`、`(pointer: coarse)` |
    //
    //   > 一组"看起来在验移动仿真"、却没有任何一项能被仿真开关改变的断言，
    //   > 与一组"验的是别的三个开关"的断言，在绿这一列上是同一个东西——
    //   > 只不过前者会让人以为"移动端这一块有人守着"。
    const facts = await session.page.evaluate(() => ({
      // 设备度量（width/height/DPR）
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      // `mobile` 标志位
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      // 触屏
      maxTouchPoints: navigator.maxTouchPoints,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      hoverNone: window.matchMedia('(hover: none)').matches,
      // UA
      mobileUa: /Mobile/.test(navigator.userAgent),
    }))

    // ① 设备度量：由 setDeviceMetricsOverride 的 width/height/DPR 决定。
    assert.equal(facts.innerWidth, 390, '移动视口宽度应为 390')
    assert.equal(facts.dpr, 3, 'DPR 应为 3')
    // ② `mobile` 标志位：只有它会把 screen 换成被仿真的那台设备。
    //    这一条是 P1 之后补的——没有它，把 mobile 关掉整条用例照样绿。
    assert.equal(facts.screenWidth, 390, 'screen.width 应是仿真设备的宽度（mobile 标志位为真的证据）')
    assert.equal(facts.screenHeight, 844, 'screen.height 应是仿真设备的高度')
    // ③ 触屏：由 setTouchEmulationEnabled 决定。
    assert.equal(facts.maxTouchPoints, 5, '触点数应为 5')
    assert.equal(facts.coarse, true, '指针应为 coarse（触屏）')
    assert.equal(facts.hoverNone, true, '触屏设备不应有 hover')
    // ④ UA。
    assert.equal(facts.mobileUa, true, 'UA 应含 Mobile')
  })

  it('② app.mjs 真的执行完了（登录页被渲染，且无未捕获异常）', async () => {
    const { page } = session
    // 登录页的可见性是**脚本跑完**的产物：HTML 里 `#screen-login` 没有 hidden，
    // 但 app.mjs 会按能力发现的结果改写标题与提示（renderAuth）。
    await page.waitFor(() => document.querySelector('#btn-login') !== null, { timeoutMs: 8000, label: '登录按钮' })
    const title = await page.text('#auth-title')
    assert.ok(title && title.length > 0, `登录页标题应被脚本写入，实际 ${JSON.stringify(title)}`)
    // 移动端最典型的故障是白屏，而白屏的根因就是未捕获异常——这一条不能省。
    assert.deepEqual(page.pageErrors, [], `页面不应有未捕获异常：${JSON.stringify(page.pageErrors)}`)
  })

  it('③ 真实触屏事件能到达页面（先证明这条链本身有效）', async () => {
    const { page } = session
    // 装一个探针按钮，用 tap() 打它。**没有这一步**，后面"点了按钮没反应"
    // 就分不清是页面坏了、还是触屏事件根本没送到。
    await page.evaluate(() => {
      const b = document.createElement('button')
      b.id = 'e2e-touch-probe'
      b.style.cssText = 'position:fixed;top:0;left:0;width:80px;height:40px;z-index:99999'
      b.textContent = 'probe'
      window.__e2eTouch = 0
      b.addEventListener('touchstart', () => { window.__e2eTouch += 1 })
      document.body.appendChild(b)
    })
    await page.tap('#e2e-touch-probe')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(await page.evaluate(() => window.__e2eTouch), 1, '真实触屏轻点应触发一次 touchstart')
    await page.evaluate(() => { document.querySelector('#e2e-touch-probe')?.remove() })
  })

  it('④ 用页面自己的表单登录，且 Hub 里真的是这个用户', async () => {
    const { page } = session
    await page.tapFill('#login-name', world.name)
    await page.tapFill('#login-password', world.password)
    await page.tap('#btn-login')

    // 判据落在**服务端**：拿页面自己存下的令牌去问 Hub "我是谁"。
    // 只断言"页面上出现了主界面"是不够的——那可能只是前端把 token 存了就当登录成功。
    //
    // ⚠️ `waitFor` 的谓词是被**序列化**后送进页面的（`cdp.mjs` 的 `evaluate`），
    //    所以它**不能捕获外部变量**：键名必须写成字面量。写成 `(k) => …(k)` 加第三个参数
    //    是无效的（`waitFor` 不给谓词传参），会静默地永远取不到值。
    const token = await page.waitFor(
      () => sessionStorage.getItem('legion.mobile.access') || null,
      { timeoutMs: 15_000, label: '登录后应存下访问令牌' },
    )
    assert.ok(token, '页面应存下访问令牌')
    assert.equal(token, await accessOf(page), '取到的令牌应与页面存的一致')
    const me = await call(hub.base, 'GET', '/api/identity/me', { token })
    assert.equal(me.status, 200, `令牌应有效：${me.text.slice(0, 200)}`)
    assert.equal(me.json.user.name, world.name, 'Hub 里应是同一个用户')
  })

  it('⑤ Agent 列表由 Hub 填充（带服务端对照）', async () => {
    const { page } = session
    const n = await page.waitFor(
      () => document.querySelectorAll('#agent-select option').length, { timeoutMs: 15_000, label: 'Agent 选项' },
    )
    assert.ok(n >= 2, `应至少有 general 与 coder 两个 Agent，实际 ${n}`)

    const api = await call(hub.base, 'GET', `/api/agents?scope=${world.scope}`, { token: await accessOf(page) })
    assert.equal(api.status, 200, `Hub Agent 读接口应放行：${api.text.slice(0, 200)}`)
    assert.equal(api.json.agents.length, n, '页面里的 Agent 数应与 Hub 返回的一致')
  })

  it('⑥ 派单：Hub 看板上真的多出一条任务（闭环的起点）', async () => {
    const { page } = session
    const token = await accessOf(page)
    const marker = `e2e-mobile-${Date.now()}`

    // ★ 先**选 Agent**——这一步不能省，而且它不是形式。
    //
    // `openConversation()`（app.mjs:565-566）有两道守卫：`state.agentId` 非 null，
    // 且它**属于当前空间**；不满足就**静默 return**（连 warn 都没有）。
    // 于是 `state.convId` 保持 null，而 `send()` 在 app.mjs:719 会以
    // 「还没有选中 Agent」打回。首次登录时 localStorage 里没有 agentId，
    // 所以"用户必须先选一个人"是真实产品流程，不是测试的额外步骤。
    const agentId = await page.waitFor(
      () => document.querySelector('#agent-select')?.options?.[0]?.value || null,
      { timeoutMs: 10_000, label: 'Agent 下拉应有可选项' },
    )
    await page.evaluate(() => {
      const sel = document.querySelector('#agent-select')
      sel.selectedIndex = 0
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 等**会话真的建起来**——`state.convId` 是 `send()` 的前置条件（app.mjs:719），
    // 而它是页面的内部状态，读不到。所以判据取它**在 Hub 侧留下的后果**：
    // `openConversation()` 会 `POST /api/agent-conversations`，
    // 那条记录落在 `agent_conversation_bindings` 上。
    //
    // 为什么要费这个劲而不是 `sleep(1000)`：睡多久都是猜的。
    // 猜短了在慢机器上红（"产品坏了"），猜长了每次白等。
    //
    //   > 一个"睡够 1 秒就假定会话建好了"的用例，
    //   > 与一个"真的等到了那条会话"的用例，在快机器上是同一个东西——
    //   > 只不过前者在慢机器上会变成一个看起来像产品缺陷的红。
    const convReady = await (async () => {
      const deadline = Date.now() + 15_000
      const q = hub.db.prepare('SELECT conv_id FROM agent_conversation_bindings WHERE agent_id = ?')
      for (;;) {
        const row = q.get(agentId)
        if (row) return row.conv_id
        if (Date.now() > deadline) return null
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
    assert.ok(convReady !== null, `选中 Agent 后 Hub 里应出现该 Agent 的会话绑定（agentId=${agentId}）`)

    // 意图 chip → 填输入框 → 点发送，全程真实触屏。
    await page.tap('#intents button[data-intent="create_task"]')
    await page.tapFill('#composer-input', marker)
    await page.tap('#btn-send')

    // 失败时把页面**自己**说的理由带出来——否则"没出现任务"与"按钮点空了"
    // 在断言输出里长得一样。
    const pageSays = await page.evaluate(() => ({
      error: document.querySelector('#login-error')?.classList.contains('hidden') === false
        ? document.querySelector('#login-error').textContent : null,
      notice: document.querySelector('#login-notice')?.classList.contains('hidden') === false
        ? document.querySelector('#login-notice').textContent : null,
      agentId: localStorage.getItem('legion.mobile.agent'),
      scope: localStorage.getItem('legion.mobile.scope'),
    }))

    // ★ 关键判据：任务出现在 **Hub**，而不是只出现在 DOM。
    // 只断言"卡片渲染出来了"的用例，在一个"只把消息塞进本地数组"的实现上照样是绿的。
    //
    // ⚠️ `/api/board` 返回的是**顶层数组**（实测：`[{"id":"T-001",…}]`），
    //    不是 `{tasks:[…]}`。第一版按对象解构，于是 `flat` 恒为空、
    //    断言恒红——看起来像"派单没生效"，其实是用例自己读错了响应形状。
    //    这正是仓库反复记过的"探针自身的错误伪装成判据的缺陷"，故两种形状都收。
    const flattenBoard = (raw) => {
      if (Array.isArray(raw)) return raw
      return [
        ...(raw?.tasks ?? []),
        ...(raw?.columns ?? []).flatMap((c) => c.tasks ?? []),
        ...(raw?.groups ?? []).flatMap((g) => g.tasks ?? []),
      ]
    }

    const found = await (async () => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const board = await call(hub.base, 'GET', `/api/board?scope=${world.scope}`, { token })
        const hit = flattenBoard(board.json).find((t) => JSON.stringify(t).includes(marker))
        if (hit) return hit
        if (Date.now() > deadline) return null
        await new Promise((r) => setTimeout(r, 500))
      }
    })()
    assert.ok(
      found,
      `派单后 Hub 看板上应出现该任务（标记 ${marker}）；`
      + `页面选中 agentId=${JSON.stringify(pageSays.agentId)} scope=${JSON.stringify(pageSays.scope)}`
      + ` 页面提示=${JSON.stringify(pageSays.notice)} 页面错误=${JSON.stringify(pageSays.error)}`,
    )

    // 顺带钉住"消息也真的进了会话"——派单是"消息 + 任务"，不是只有任务。
    //
    // ⚠️ 会话 id 取自 **Hub 的绑定表**（正是页面自己 `openConversation()` 建的那条），
    //    不是从任务对象上取。第一版写 `found.convId`——那个字段在任务上**不存在**，
    //    于是请求变成 `conv=` 并拿到 400，看起来像"读接口坏了"。
    const msgs = await call(hub.base, 'GET',
      `/api/chat/messages?scope=${world.scope}&conv=${convReady}&limit=200`, { token })
    assert.equal(msgs.status, 200, `会话读接口应可用：${msgs.text.slice(0, 200)}`)
    assert.ok(
      JSON.stringify(msgs.json).includes(marker),
      '派单的那条消息应出现在该会话里（消息与任务都落地才叫"派单"）',
    )
  })
})
