// scripts/probes/mutate.mjs —— 破坏性验证（未跟踪）。
// 每条改动都必须让**指定的**用例变红；不变红说明那条判据是摆设。
// 用 try/finally 保证源码一定被还原。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const SUITE = 'orchestrator/worker/run-inputs.test.mjs'

const MUTATIONS = [
  {
    id: '① 只在 ok===true 时采纳 inputs → 改成"有 inputs 就用"',
    file: 'orchestrator/worker/executor.mjs',
    from: "const supplied = runInputs !== null && typeof runInputs === 'object' && runInputs.ok === true",
    to: "const supplied = runInputs !== null && typeof runInputs === 'object' && true",
    expect: '⑪',
  },
  {
    id: '② 取链首（不检查 role===primary）→ 备用会顶班',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "if (id === null || chainRole !== 'primary') {",
    to: "if (id === null) {",
    expect: '⑭',
  },
  {
    id: '③ 主档案解析失败也照用 → fallback 悄悄顶替',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "  if (resolution.ok !== true) {",
    to: "  if (false) {",
    expect: '⑬',
  },
  {
    id: '④ 原地执行也返回槽位目录 → 隔离退化成原地',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "  if (workspace.kind === 'in-place') return clean(projectDir)",
    to: "  if (workspace.kind === 'in-place') return clean(workspace.slotDir)",
    expect: '⑥',
  },
  {
    id: '⑤ 反向控制：`tagStage` 只转发一个参数 → 运行输入根本到不了 execute',
    file: 'orchestrator/worker/main.mjs',
    from: 'const tagStage = (stageName, fn) => async (...args) => {',
    to: 'const tagStage = (stageName, fn) => async (onlyLease) => {',
    also: { from: 'return await fn(...args)', to: 'return await fn(onlyLease)' },
    expect: '㉔',
  },
  {
    id: '⑥ 反向控制：丢掉 prepareWorkspace 的结果 → workdir 没有权威来源',
    file: 'orchestrator/worker/main.mjs',
    from: 'const workspaceDetail = workspaceStep.detail ?? null',
    to: 'const workspaceDetail = null',
    expect: '㉔',
  },
  {
    id: '⑦ 生产入口不再交出模型端口',
    file: 'product/orchestrator/worker.mjs',
    from: '  modelProfileRefFor,\n})',
    to: '})',
    expect: '㉒',
  },
  {
    id: '⑧ 模型解析回落成"平台默认"（不给 job 岗位也能跑）',
    file: 'orchestrator/worker/run-inputs.mjs',
    from: "    const role = clean(res?.body?.role)\n    if (role === null) {",
    to: "    const role = clean(res?.body?.role) ?? 'coder'\n    if (false) {",
    expect: '⑳',
  },
  {
    id: '⑨ Launcher 不再注入项目目录（宿主环境里配了也传不下去）',
    file: 'product/launcher/launcher.mjs',
    from: "        out.LEGION_WORKSPACE_DIR = layout.workspaceDir",
    to: "        void layout.workspaceDir",
    expect: '①b′',
    suite: 'product/launcher/runtime-contract-wiring.test.mjs',
    pattern: 'Launcher 把',
  },
  {
    id: '⑩ 项目目录不再声明在 worker 的 envNames 里',
    file: 'product/process-manifest.mjs',
    from: "      'LEGION_WORKSPACE_DIR',\n    ]),",
    to: "    ]),",
    expect: '①b′',
    suite: 'product/launcher/runtime-contract-wiring.test.mjs',
    pattern: 'Launcher 把',
  },
  // ── PRT-214 缺口②：授权身份按 Run 生效 ─────────────────────────────────
  {
    id: '⑪ 桥不再把身份覆盖叠进投影（回到进程级身份）',
    file: 'runtime/dsh-composition/tool-request.mjs',
    from: 'if (overlay === undefined || overlay === null) return context',
    to: 'if (overlay === undefined || overlay === null) return context\n    return context',
    expect: '⑬',
    suite: 'runtime/dsh-composition/run-identity.test.mjs',
  },
  {
    id: '⑫ 叠加白名单被绕开（overlay 整个摊开，actor 也能进）',
    file: 'runtime/dsh-composition/tool-request.mjs',
    from: 'return applyIdentityOverlay(context, overlay)',
    to: 'return { ...context, ...overlay }',
    expect: '⑱',
    suite: 'runtime/dsh-composition/run-identity.test.mjs',
  },
  {
    id: '⑬ 载荷接受 `actor`（审计归属变成请求方自填）',
    file: 'runtime/contracts/run-identity.mjs',
    from: "export const RUN_IDENTITY_PAYLOAD_KEYS = Object.freeze(['version', 'scope', 'taskId', 'cwd'])",
    to: "export const RUN_IDENTITY_PAYLOAD_KEYS = Object.freeze(['version', 'scope', 'taskId', 'cwd', 'actor'])",
    expect: '②',
    suite: 'runtime/dsh-composition/run-identity.test.mjs',
  },
  {
    id: '⑭ 没有 agent 时也去猜一份覆盖（不返回 undefined）',
    file: 'runtime/dsh-composition/run-identity.mjs',
    from: 'if (agent === undefined || agent === null || typeof agent !== \'object\') return undefined',
    to: 'if (agent === undefined || agent === null || typeof agent !== \'object\') return {}',
    expect: '⑫',
    suite: 'runtime/dsh-composition/run-identity.test.mjs',
  },
  {
    id: '⑮ 装载期自检：absent 也给一份 overlay（"没人给"与"给的就是进程级"混成一个读数）',
    file: 'runtime/dsh-composition/run-identity.mjs',
    from: '    overlay: reading.overlay,\n  })\n}',
    to: '    overlay: reading.overlay ?? Object.freeze({}),\n  })\n}',
    expect: '⑥',
    suite: 'runtime/dsh-composition/run-identity.test.mjs',
  },
  {
    id: '⑯ 生产者造不出 scope 时干脆不挂（回落成安静的错标）',
    // ★ 锚点必须在**生产者自己**身上，不能锚在 `execute()` 里那一行赋值上：
    //   `deriveRunIdentityCarrier` 有自己的用例（㉗），而 `execute()` 那一行只有在
    //   起一次真执行的用例里才跑得到。锚错了地方就会得到一条"没咬住"的记录——
    //   那是**坏验据**，因为它读起来像"这条性质没被守住"，实际只是靶子不在射程里。
    file: 'orchestrator/worker/executor.mjs',
    from: '    request: Object.freeze({ ...request, [RUN_IDENTITY_WIRE_FIELD]: payload }),',
    to: '    request: Object.freeze(scope === null ? request : { ...request, [RUN_IDENTITY_WIRE_FIELD]: payload }),',
    expect: '㉗',
    suite: 'orchestrator/worker/run-inputs.test.mjs',
  },
  {
    id: '⑰ 安装点对坏身份载荷不再拒绝（回落成进程级照跑）',
    file: 'runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs',
    from: '        if (identityInstallation.state === RUN_IDENTITY_STATES.REFUSED) {',
    to: '        if (false) {',
    expect: '身份',
    suite: 'runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs',
    pattern: '身份',
  },
  // ── PRT-251 续：ports.runtime 到达 DSH ─────────────────────────────────
  {
    id: '⑱ runtime 不再声明 `portArgv`（端口回不到 DSH，回到本缺口）',
    file: 'product/process-manifest.mjs',
    from: "    portArgv: Object.freeze(['--port']),\n",
    to: '',
    expect: '①d',
    suite: 'product/launcher/runtime-contract-wiring.test.mjs',
  },
  {
    id: '⑲ 端口段插到 `extras` **前面**（--patch 落进 app 段、覆盖层静默消失）',
    // ★ 锚点必须是**配置入口那一支**（runtime 走的是它）：文件里有两处同样的
    //   拼接，一处给 node-file、一处给 configured。锚错了会变异出一个没人跑的
    //   分支，于是得到一条读起来像证据的空跑。
    file: 'product/process-manifest.mjs',
    from: 'args: Object.freeze([...configured.args, ...args, ...extras, ...effectiveValueArgs, ...effectiveBoolArgs]),',
    to: 'args: Object.freeze([...configured.args, ...args, ...effectiveValueArgs, ...effectiveBoolArgs, ...extras]),',
    expect: '端口进 argv',
    suite: 'product/process-manifest.test.mjs',
  },
  {
    id: '⑳ 两处都给了端口却不报冲突（靠 argv 顺序决出胜负）',
    file: 'product/process-manifest.mjs',
    from: '          diagnostics.push(diag(\'error\', family.code, spec.key,',
    to: '          if (false) diagnostics.push(diag(\'error\', family.code, spec.key,',
    expect: '两处都给了端口',
    suite: 'product/process-manifest.test.mjs',
  },
  // ── PRT-251 续 ④：旧数据接管（安装目录 → DataDir）──────────────────────
  {
    id: '㉑ SQLite 退化成**朴素文件拷贝**（静默丢掉 WAL 里已提交的行）',
    // ★ 这一条是整批里最要紧的一次变红：它复现的是"拷了主文件、丢了 WAL"
    //   那个形状——新库**能打开、能查询、schema 齐全**，只是少了几十行。
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: "    const outcome = item.kind === ADOPTION_KINDS.SQLITE\n      ? snapshotSqlite({ source, target, openDatabase: opener })\n      : copyTree({ source, target, fs: fs ?? undefined })",
    to: "    const outcome = item.kind === ADOPTION_KINDS.SQLITE\n      ? (() => { try { copyFileSync(source, target); return { ok: true, code: null, message: null } } catch (e) { return { ok: false, code: 'ADOPTION_COPY_FAILED', message: String(e) } } })()\n      : copyTree({ source, target, fs: fs ?? undefined })",
    expect: '真 SQLite + 真 WAL',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  // ★ ㉒㉓㉔ 的 `expect` 是**文件名**，不是某条用例名——这不是偷懒，是读数如此：
  //   这三处的性质同时被**两层**守着，而先动的是**装载期自检**
  //   （`legacy-data-adoption.mjs` 末尾的 `ADOPTION_CHECKED = selfCheckAdoption()`），
  //   它在 `import` 那一刻就抛，于是 `node --test` 报的红实体是**文件本身**。
  //
  //   一个"装载期就拒绝"的模块，与一个"装载成功、运行时才判错"的模块，
  //   在变红清单上是同一个东西吗？不——前者的红发生在**任何用例跑之前**。
  //   所以这里如实记成文件名，而不是把 `expect` 放宽到"随便红一条就算咬住"
  //   （那样会把"整个文件加载失败"也算成一次成功的破坏性验证）。
  //
  //   之所以敢这么记：这三条性质**同时**被用例独立守着（③ 断 `nothing.ok === true`、
  //   ③ 断 `ALREADY`、④ 断 `TARGET_INSIDE_INSTALL`）。删掉自检之后，
  //   逐条把 `expect` 改回用例名就会看到它们照样变红。
  {
    id: '㉒ 目标已存在时也照拷（幂等没了，用户改过的库被覆盖）',
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: '    if (exists(target)) {\n      items.push(verdictOf(item, ADOPTION_CODES.TARGET_EXISTS,',
    to: '    if (false) {\n      items.push(verdictOf(item, ADOPTION_CODES.TARGET_EXISTS,',
    expect: 'legacy-data-adoption.test.mjs',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㉓ 「没有来源」被判成拒绝（新装机起不来）',
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: "        `安装目录里没有 ${item.fragment}，无需接管。`, { state: ADOPTION_STATES.NOTHING }))",
    to: "        `安装目录里没有 ${item.fragment}，无需接管。`))",
    expect: 'legacy-data-adoption.test.mjs',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㉔ 关掉「目标不得落在安装目录内」这条不变量',
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: '    if (isPathInside(layout.installDir, target, platform)) {',
    to: '    if (false) {',
    expect: 'legacy-data-adoption.test.mjs',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㉕ Launcher 在接不成时**只记诊断、照常启动**（界面空着，④原样重演）',
    file: 'product/launcher/launcher.mjs',
    from: "      const adoption = await this.adoptLegacyData({ processes: includedKeys })\n      if (adoption.ok !== true) {",
    to: "      const adoption = await this.adoptLegacyData({ processes: includedKeys })\n      if (false) {",
    expect: '有旧数据却接不成就',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㉖ 快照后不校验（坏库被当成接管成功）',
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: '      const verify = verifySqlite({ target, openDatabase: opener })',
    to: '      const verify = { ok: true, message: null }',
    expect: '验不过',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  // ── PRT-251 续 ③ §4 + ④ 范围：stdout 就绪判据 / 接管按启动范围 ──────────
  {
    id: '㉛ stdout 判据退化成"有那一行就算"（不比对端口）',
    // ★ 这一条验的是「`--port` 真的到达了它」那半条链。
    //   去掉端口比对之后，一个**没接住端口**的 DSH 也会被判成就绪——
    //   而它可能正听着别人的端口。
    file: 'product/launcher/readiness.mjs',
    from: "    if (plannedPort !== null && plannedPort !== 0 && reportedPort !== null\n      && String(reportedPort) !== String(plannedPort)) {",
    to: "    if (false) {",
    expect: '报告的端口与计划不符',
    suite: 'product/launcher/readiness.test.mjs',
  },
  {
    id: '㉜ 匹配到的**整行**塞进读数（启动令牌随诊断/状态/诊断包外泄）',
    // `redactText()` 的「URL 内嵌凭证」只认 `user:pass@`，**不认 `?token=`**，
    // 所以凭证保护只能来自"我们根本不把那一行带出来"。
    file: 'product/launcher/readiness.mjs',
    from: "    return result(null, { identity: [`stdout:/${pattern}/`], port: reportedPort, matchedPattern: pattern })",
    to: "    return result(null, { identity: [`stdout:/${pattern}/`], port: reportedPort, matchedPattern: pattern, line })",
    expect: '启动令牌',
    suite: 'product/launcher/readiness.test.mjs',
  },
  {
    id: '㉝ `clear()` 变成空操作（重启后上一代那一行仍然算数）',
    file: 'product/launcher/readiness.mjs',
    from: "        if (id.startsWith(`${key}\\u0000`)) streams.delete(id)",
    to: '        if (false) streams.delete(id)',
    expect: '不认上一代的那一行',
    suite: 'product/launcher/readiness.test.mjs',
  },
  {
    id: '㉟ Launcher 的 spawn 循环**不再**清行缓冲（这一格只有源级钉子守得住）',
    file: 'product/launcher/launcher.mjs',
    from: '          outputLines.clear(proc.key)\n',
    to: '',
    expect: '每次 spawn 之前',
    suite: 'product/launcher/readiness.test.mjs',
  },
  {
    id: '㉞ `--include` 的范围不再交给接管（试运行会烧掉唯一一次快照）',
    file: 'product/launcher/launcher.mjs',
    from: '      const adoption = await this.adoptLegacyData({ processes: includedKeys })',
    to: '      const adoption = await this.adoptLegacyData()',
    expect: '以 runtime 为启动范围时',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㊱ 接管忽略 `processes`（受限启动照样把别人的库接走）',
    file: 'product/launcher/legacy-data-adoption.mjs',
    from: '    if (scope !== null && !scope.has(process)) continue',
    to: '    if (false) continue',
    expect: '只放行范围内的进程',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㊲ 受限那一次也写进记忆化（全量启动读到空读数 ⇒ 库永远接不进来）',
    file: 'product/launcher/launcher.mjs',
    from: '      if (!scoped) adoptionReading = reading',
    to: '      adoptionReading = reading',
    // ★ `expect` 是**用例名**的子串，而用例名里写着 `**不许**污染全量读数`
    //   ——markdown 的粗体标记把"不许"和"污染"隔开了。
    //   原来写 `不许污染全量读数` 因此恒不匹配：用例**确实**红了，
    //   而 harness 报的是"没咬住"。一个把"红了"读成"没红"的判据，
    //   比没有判据更坏——它会让人去改一个本来正确的实现。
    expect: '污染全量读数',
    suite: 'product/launcher/legacy-data-adoption.test.mjs',
  },
  {
    id: '㊳ 清单里 runtime 的 `expectMatch` 写成**编译不过**的正则',
    // 一条编译不过的判据与一条"永远不可能满足"的判据是同一个东西：
    // 进程永远起不来，而清单看起来是完整的。
    file: 'product/process-manifest.mjs',
    from: "      expectMatch: '^dsh web:\\\\s+(https?://\\\\S+)',",
    to: "      expectMatch: '^dsh web:(https?://\\\\S+',",
    // ★ 又一次踩同一个坑：`expect` 比的是**用例名**，而"编译不过"是
    //   **断言消息**。上面那次 ㊲ 已经因为同样的原因误报过一次"没咬住"。
    //   这里如实指向用例名——判据本身是好的，是这句配置写错了。
    expect: '清单声明',
    suite: 'product/process-manifest.test.mjs',
  },
  // ─────────────────── PRT-251 续批：app 段的另外两面 ───────────────────
  {
    id: '㊴ runtime 不再声明 `boolArgv`（Launcher 拉起的 runtime 自己弹浏览器）',
    file: 'product/process-manifest.mjs',
    from: "    boolArgv: Object.freeze(['--no-open']),",
    to: '',
    // ★ 期望指向**端到端**那条（真 start() + 真 spawn 出来的 argv），不是清单用例：
    //   「清单里少了这个字段」与「生产 argv 里少了这个开关」是两件事，
    //   而后者才是用户会看到的东西。清单用例也会红，但端到端那条更硬。
    expect: 'Launcher 的命令来自 current.json',
    suite: 'product/launcher/runtime-resolve.test.mjs',
  },
  {
    id: '㊵ 把**开关**也按值旗标处理（用户自己写了 --no-open 就拒绝启动）',
    file: 'product/process-manifest.mjs',
    from: '        const effectiveBoolArgs = boolArgs.filter((flag) => !configured.args.includes(flag))',
    to: "        const effectiveBoolArgs = boolArgs.filter((flag) => { if (configured.args.includes(flag)) { diagnostics.push(diag('error', 'PORT_AUTHORITY_CONFLICT', spec.key, '开关重复了')); return false } return true })",
    // ★ 这一格断的是本批最容易写错的地方：两个**值**来源＝两个答案 ⇒ 必须阻塞；
    //   重复一个**开关**＝同一个断言说两遍 ⇒ 跳过。把开关按值处理，
    //   等于因为用户写了一句"不要开浏览器"就**拒绝启动**——而那条命令正是产品想要的。
    expect: '而不是报冲突',
    suite: 'product/process-manifest.test.mjs',
  },
  {
    id: '㊶ 开关旗标总是追加（不跳过 ⇒ argv 里出现两次）',
    file: 'product/process-manifest.mjs',
    from: '        const effectiveBoolArgs = boolArgs.filter((flag) => !configured.args.includes(flag))',
    to: '        const effectiveBoolArgs = boolArgs',
    // 同一条用例的另一面：这条验的是"跳过"这个动作本身，
    // 上一条验的是"跳过而不是报错"。两件事，各有各的错法。
    expect: '而不是报冲突',
    suite: 'product/process-manifest.test.mjs',
  },
  {
    id: '㊷ runtime 不再声明 `hostArgv`（清单的 host 与真正 bind 的脱钩）',
    file: 'product/process-manifest.mjs',
    from: "    hostArgv: Object.freeze(['--host']),",
    to: '',
    expect: '端口进 argv',
    suite: 'product/process-manifest.test.mjs',
  },
  {
    id: '㊸ `boolArgv` 写成**带值**的形态（DSH 会把那个值当成位置参数）',
    file: 'product/process-manifest.mjs',
    from: "    boolArgv: Object.freeze(['--no-open']),",
    to: "    boolArgv: Object.freeze(['--no-open', 'true']),",
    // ★ 这一条只有"零参数"那条断言看得出来：带值之后 argv 里**仍然**"包含
    //   `--no-open`"，于是所有用 `includes()` 写的用例全部照绿。
    expect: '零参数',
    suite: 'product/process-manifest.test.mjs',
  },
  {
    id: '㊹ 清单契约版本留在 `1`（加了字段却宣称结构没变）',
    file: 'product/process-manifest.mjs',
    from: 'export const PROCESS_MANIFEST_VERSION = 2',
    to: 'export const PROCESS_MANIFEST_VERSION = 1',
    expect: '清单契约版本被钉住',
    suite: 'product/process-manifest.test.mjs',
  },
]

function run(suite = SUITE, pattern = null) {
  // ★ `pattern` 不是可选的装饰：`runtime-contract-wiring.test.mjs` 的十条用例
  //   每条都起**真子进程**（Launcher + worker + 若干探针），跑满一遍要十几分钟。
  //   而本文件要做十次"变异 → 跑 → 还原"，全量跑完远超任何合理的等待窗口
  //   （实测：一条 ⑩ 就让整个 harness 卡在 20 分钟以上被杀）。
  //   用 `--test-name-pattern` 把它收到那一条上，代价从"分钟"降到"秒"。
  //
  //   *一个因为太慢而跑不完的破坏性验证，
  //   与一个没写的破坏性验证，在"有没有证据"这件事上是同一个东西。*
  const args = ['--test', suite]
  if (pattern !== null) args.push(`--test-name-pattern=${pattern}`)
  try {
    const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 })
    return { failed: [], output: out }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1])
    return { failed: [...new Set(failed)], output: out }
  }
}

// ★ `MUTATE_ONLY`：按 id 前缀收一个子集（逗号分隔），并**跳过**那条以 SUITE 为靶的
//   全量基线与还原跑。它存在是因为 SUITE（`runtime-contract-wiring.test.mjs`）
//   每条用例都起真子进程，跑满一遍要十几分钟——而 PRT-214 缺口② 那几条变异的靶子
//   全在自己的套件里，既不需要也不该付那份代价。
//
//   *一个因为太慢而跑不完的破坏性验证，
//   与一个没写的破坏性验证，在"有没有证据"这件事上是同一个东西。*
const ONLY = (process.env.MUTATE_ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
const selected = ONLY.length === 0 ? MUTATIONS : MUTATIONS.filter((m) => ONLY.some((p) => m.id.startsWith(p)))

const baseline = ONLY.length > 0
  ? { failed: [], output: '' }
  : run()
console.log(ONLY.length > 0
  ? `基线：跳过全量 SUITE（MUTATE_ONLY=${ONLY.join(',')}）；每条变异自带套件`
  : `基线：${baseline.failed.length === 0 ? '全绿' : `红 ${baseline.failed.length} 条 —— ${baseline.failed.join(' / ')}`}`)
if (baseline.failed.length > 0) process.exit(1)

let ok = 0
for (const m0 of selected) {
  let m = m0
  const path = `${ROOT}${m.file}`
  const original = readFileSync(path, 'utf8')
  try {
    if (!original.includes(m.from)) {
      // 工作区是 CRLF（Windows core.autocrlf），锚点里的 `\n` 要跟着换。
      const nl = original.includes('\r\n') ? '\r\n' : '\n'
      m = { ...m, from: m.from.replace(/\n/g, nl), to: m.to.replace(/\n/g, nl),
        ...(m.also ? { also: { from: m.also.from.replace(/\n/g, nl), to: m.also.to.replace(/\n/g, nl) } } : {}) }
    }
    if (!original.includes(m.from)) { console.log(`⚠ ${m.id}：锚点没找到，跳过（${m.file}）`); continue }
    let mutated = original.replace(m.from, m.to)
    if (m.also) {
      if (!mutated.includes(m.also.from)) { console.log(`⚠ ${m.id}：第二锚点没找到，跳过`); continue }
      mutated = mutated.replace(m.also.from, m.also.to)
    }
    writeFileSync(path, mutated)
    const r = run(m.suite ?? SUITE, m.pattern ?? null)
    const bit = r.failed.some((n) => n.includes(m.expect))
    console.log(`${bit ? '✔' : '✖ 没咬住'} ${m.id}  → 期望 ${m.expect} 变红；实际红 ${r.failed.length} 条${r.failed.length ? `：${r.failed.slice(0, 6).join(' / ')}` : ''}`)
    if (bit) ok += 1
  } finally {
    writeFileSync(path, original)
  }
}
console.log(`\n破坏性验证：${ok}/${selected.length} 条咬住`)
if (ONLY.length > 0) process.exit(ok === selected.length ? 0 : 1)
const after = run()
console.log(`还原后：${after.failed.length === 0 ? '全绿' : `仍红 ${after.failed.length} 条 —— ${after.failed.join(' / ')}`}`)
