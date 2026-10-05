<!-- 来源说明（非原文，由将军 2026-10-05 指示补加；正文一字未改） -->
> **这份判定报告的正文由 T-179（tester 角色）在隔离工作树 `w/T-179` 里写成，
> 原文位于 `scratch/t179/JUDGMENT.md`——而 `scratch/` 在 `.gitignore` 里，
> 所以它一直无法进入版本库（分支 `w/T-179` 的提交数为 0）。**
>
> 搬运原因与保全方式：将军裁定"把它落到被跟踪的路径"，本文件即为该裁定的产物；
> 正文**未作任何修改**，命令、读数、结论一律保持原样，便于按 §7 独立复跑核对。
>
> ⚠️ 同时记下**任务配置缺陷**（不属于本报告内容，属于派工面）：
> T-179 声明的文件域是 `["scratch/"]`，而 `scratch/` 被 gitignore ——
> **一个声明域是 gitignored 目录的切片，产出永远交付不了**。
> 报告作者自己也发现了这一点，并在正文里写明"允许写入只有 scratch/，本文件即交付物"。
>
> 搬运时 HEAD = `d2957edf`（报告 §0 自述的基线 commit，与搬运时一致）。

---

# T-179 判定报告 —— 真进程 / 真 DSH 类 12 个红套件（环境不可判 vs 真缺陷）

> 本轮范围（将军 2026-10-05 收窄指令）：只做判定，不做修复。
> 允许写入只有 scratch/。本文件即交付物（未写 docs/TEST_REPORT.md：文件域约束只放行 scratch/，
> 且改 runtime/dsh-composition/、runtime/contracts/、team-hub/、scripts/prt/ 会与 T-177/T-178 撞写者）。
> 「判成真缺陷 ⇒ 复跑 exit 0 且 run-ci --only test PASS」本轮不由本任务承担（将军已明确改派后续修复任务）。

## 0. 基线与树（可复现的第一条）

| 项 | 读数 |
|---|---|
| worktree | D:/project/DSH/legion/.legion-worktrees/T-179（分支 w/T-179） |
| HEAD（本报告所有读数所在 commit） | d2957edf962d061cb647a6deb0949a48c18832d0（fix(prt): 9 个文档/基线棘轮套件归零（T-177 的成果…）） |
| 开工时 main | 将军读数来自 main（efc11c9c 一线，fix/bugs 持续推进；本 worktree 未含后续提交） |
| DSH 检出 | D:/project/DSH/dsh/deepseek-harness（master @ 5badb15009，CLI 0.2.1-alpha.1） |
| 共享解析器读数 | resolveDshCheckout({need:'cli'}) → checkout=D:/project/DSH/dsh/deepseek-harness，source=candidate，'$DSH_CHECKOUT 未设置；按候选顺序找到检出'，missing: []，unbuilt=false |
| Node | D:/software/nodejs/node.exe（v24.19.0） |
| 本会话沙箱 | workspace-write；禁止受限进程创建匿名管道（见 §1） |

## 1. 复跑方法与它自身的边界（先说清，否则证据无法解释）

本机 DSH 文件沙箱（workspace-write）下，受限进程创建匿名管道会 EPERM：

- run_code 宿主实证：spawnSync(process.execPath, ['-e','…']) → Error: spawnSync …/DeepSeek Harness.exe EPERM。
- 因此直接用 node --test <suite> 在本会话起不来：套件内部用 stdio ['ignore'|'pipe','pipe','pipe'] 起 DSH 子进程。
- 还实测：node --test 的 runner 在 --require 之前就捕获了原始 spawn，补丁拦不住它自己的子进程 spawn
  （node:internal/test_runner/runner:517 → spawn EPERM）。

所以本会话用上一轮留下的 scratch-only 管道替身 scratch/t179/pipe-shim.cjs：
只把 stdio 'pipe' 换成文件 fd（stdout/stderr 内容、timeout、env、args、断言一字不改），
并用直接跑测试文件的方式（node --require shim <file>；node:test 仍会打印 TAP 摘要）；多文件套件逐文件跑。
入口脚本：scratch/t179/run-one.mjs（本轮新增，只读探针；产物全在 scratch/）。

替身的忠实度不是自说自话——本轮有控制读数：

- runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs 在同一替身/同一树上的读数见 §4 控制项。
- 替身不覆盖两种：
  (a) execFileSync（内部自建管道，补丁拦不到）——S12 的 DERIVE_THREW 'spawnSync git EPERM' 即此；
  (b) 交互式 stdin 协议（ACP session/* 一行一条 JSON）：替身在没有 input 时把子进程 stdin 置为 ignore，
      child.stdin 变 null。凡是主动写子进程 stdin 的套件（S05/S10/S11），本会话读数不可采信，
      已在判定表中标「本会话不可忠实复跑」。

## 2. 逐套件判定表

> 「将军读数」= 将军在 main 普通终端 run-ci 的读数（写入任务描述，作为正常终端基准）。
> 「本会话读数」= 上述替身 + 直接跑文件。两者形态不一致时以正常终端为准，并标出替身污染项。

| # | 套件 | 前置条件（缺哪个环境事实/构建产物/桩能力） | 判定 | 原始证据（命令 + 输出片段 + exit + 耗时） | 本轮动作 |
|---|---|---|---|---|---|
| S01 | runtime/dsh-composition/run-floor-dsh-process.test.mjs | 检出+CLI（满足）；桩 llm 引擎需声明自检要求的必需能力；生产端口 startRun 需能起 Run | 真缺陷（红非环境缺失；直接成因=自检拒绝，红未携带 code/error） | 本会话 node scratch/t179/run-one.mjs runtime/dsh-composition/run-floor-dsh-process.test.mjs → exit=1, tests 6 / pass 1 / fail 5 / duration_ms 8653.6；子进程 exit={"code":0,"signal":null} ms=8603；phases=services,stub-registered,port-built,parent-created,run-start-failed:denied,run-start-failed:absent,run-start-failed:control,done。将军普通终端：0/6（53s） | 不改代码；最小修复写进 §6 |
| S02 | runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs | 检出+CLI（满足）；补丁行 legion-enforcement-runtime-host-registrar 必须真的激活（依赖服务齐） | 真缺陷 | 本会话（上一轮同法日志 logs/S02-runtime-host-row.txt）tests 10 / pass 8 / fail 2 / 93433ms；C 失败于 runtime-host-row-dsh-process.test.mjs:642 assert.match(r.stderr, /warning: [0-9]+ entr(?:y|ies) did not activate/)，实际 stderr 无该 warning，而是 SVCCODE RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE + SVCCHECKS（composition-patch-layer ok=false）。将军：8/2（47s） | 不改代码；最小修复见 §6 |
| S03 | runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs | 检出+CLI（满足）；被禁行/依赖行之间必须能结算（不能有永久 pending 行） | 真缺陷（卡死形态） | 本会话 logs/S03-registrar.txt：tests 6 / pass 4 / fail 2 / 201241ms；✖ N 场景 180069.66ms → AssertionError: actual 'spawnSync D:/software/nodejs/node.exe ETIMEDOUT' expected null；N 的 stderr 只有 4 行停在 SERVICES-TOOLS-GUARD-REGISTERED count=1（无 exit、无拒绝码）。将军：4/2（失败 180031ms） | 不改代码；根因定位见 §6 |
| S04 | runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs | 同 S03（行必须结算） | 真缺陷（卡死形态，含连带红） | 本会话 logs/S04-binding-unblocked.txt：tests 7 / pass 2 / fail 5 / 388943ms；✖① 180103.4ms ETIMEDOUT；✖④ 180067.6ms ETIMEDOUT；✖②⑥ 因读数为 null 连带 TypeError: Cannot read properties of null (reading 'code')；✖★汇总。将军：被 300s 看守杀 | 不改代码；根因同 S03 |
| S05 | orchestrator/worker/runtime-contract-cross-process.test.mjs | 检出+CLI（满足）；两个真 DSH 进程 + stdin 协议；契约行 subagents 服务来源 | 真缺陷（正常终端已复现 7/12）；本会话不可忠实复跑 | 将军普通终端：7 pass / 12 fail。本会话替身：tests 19 / pass 7 / fail 12，但子进程 stderr 每条为 pending (waiting for service: subagents) + CONTRACTSVC ok=absent + PROBE-EXIT stdin-closed——替身把 stdin 变成立即 EOF（§1b），不可采信 | 不改代码；需普通终端定位逐条根因（命令见 §7） |
| S06 | team-hub/run-store.test.mjs + run-routes.test.mjs + run-plane-e2e.test.mjs | 无 DSH 前置（真 team-hub + 真 worker 客户端）；单文件内测试之间共享一个 DB | run-store PASS；run-routes 真缺陷（待定根因）；run-plane-e2e 真缺陷 | 本会话：run-store tests 44 / pass 44 / fail 0 / 6754ms（logs/S06a-run-store.txt）；run-routes tests 30 / pass 8 / fail 22 / 15672ms（logs/S06b-run-routes.txt），22 条全是 claim() 返回 null → Cannot read properties of null (reading 'attemptId')，首条 ⑤ 报 'rt-9 已经有两次尝试…0 !== 2'；run-plane-e2e（logs3/S06c-run-plane-e2e.log）：6 条用例约 2.3s 内跑完（3 ✔ / 3 ✖），但**进程不退出、没有 TAP 摘要**，被 430s 超时杀掉 ⇒ 这就是将军「整个 run-plane label 被 300s 看守杀」的直接成因（测试跑完后事件循环不排空）。run-routes 本轮复跑确认 8/22（19933.6ms，logs3/S06b-run-routes.log） | 不改代码；最小修复方向见 §6 |
| S07 | team-hub/run-kill-drill.test.mjs | 无 DSH 前置；需要真子进程强杀 + 真 team-hub | 待本会话 batch2 + 普通终端确认（将军：300s 看守杀） | 本会话 batch2 正在跑（scratch/t179/logs3/S07-kill-drill.log）；上一轮日志 logs/S07-kill-drill.txt 只留下 '✔ ① 在外部写边界之前强杀 worker…(2404.6ms)'，随后被结算 | 不改代码；补齐读数后定案 |
| S08 | runtime/dsh-composition/headless-real-tool.test.mjs | 检出+CLI（满足）；不需要真实模型凭据（套件装桩模型并删 DEEPSEEK_API_KEY） | 真缺陷（正例卡死；负例对照成立） | 本会话 logs/S08-headless.txt：tests 4 / pass 1 / fail 3 / 193292ms；✖ 正例 '真 DSH 进程跑真 pwsh…sentinel' 180389.1ms → spawnSync …node.exe ETIMEDOUT；✖ 桩不伪造结果因 sentinel 不存在 ENOENT；✔ 负例 NEG exit=1 records=18 tool/call=0 … MISSING_CREDENTIAL 12591ms。将军：1/3（失败 185456ms） | 不改代码；最小修复见 §6 |
| S09 | runtime/dsh-composition/enforcement-real-process.test.mjs | 检出+CLI（满足）；下限 overlay 能挂上并结算 | 真缺陷（卡死形态；spawnSync 型 ⇒ 替身忠实） | 本会话 node scratch/t179/run-one.mjs runtime/dsh-composition/enforcement-real-process.test.mjs：**430030ms 超时、零条用例完成、无 TAP 摘要**，[run-one] exit=null signal=SIGTERM error=spawnSync …node.exe ETIMEDOUT（logs2/S09-enforcement.log）。将军：300s 看守杀 | 不改代码；最小修复方向：先让首个用例前的挂起点可归因（打印 phase），再修根因 |
| S10 | runtime/dsh-composition/session-boundary-real-process.test.mjs | 检出+CLI（满足）；交互式 ACP stdin 对话 | 本会话不可忠实复跑（将军：300s 看守杀；正常终端才有权威读数） | 该套件 spawn(..., {stdio:['pipe','pipe','pipe']}) + 自写 child.stdin（session-boundary-real-process.test.mjs:688-693）；替身在无 input 时置 stdin=ignore ⇒ child.stdin 为 null，本会话必假红 | 不改代码；正常终端复跑命令见 §7 |
| S11 | runtime/dsh-composition/subagents-surface-real-process.test.mjs | 检出+CLI（满足）；交互式 ACP stdin 对话 | 真缺陷（正常终端 7/5，失败用例 65654ms）；本会话读数作废 | 本会话 batch S11：tests 12 / pass 0 / fail 12 / 5091ms，全部 TypeError: Cannot read properties of null (reading 'write') at subagents-surface-real-process.test.mjs:828（this.child.stdin.write）——替身伪造（§1b）。将军普通终端：7/5 | 不改代码；需普通终端定位逐条根因 |
| S12 | scripts/prt/boundary-facts.test.mjs | 不是真 DSH 套件（进程内文档/台账棘轮）；需要可以创建管道的 shell 来跑 git 探针 | 环境不可判（本会话）＋部分读数属 T-177 棘轮域 | 本会话 batch：tests 81 / pass 63 / fail 18 / 105705.5ms；首条红 DERIVE_THREW … 'spawnSync git EPERM'（execFileSync 未被替身覆盖）；另见真实 MISMATCH：unreachable actual:33 vs claimed:37、REPO_WIDE_BASELINE actual:27 vs claimed:87。将军：300s 看守杀 | 不改代码；属 T-177（不动） |

## 3. 结论的两条关键读数

### 3.1 最重要的矛盾读数（说明前置条件不止一个）

同一个检出、同一台机器、同一会话：

- runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs —— 10/10 PASS（将军普通终端；本会话控制项见 §4）；
- 而 runtime-host-row（8/2）、registrar-row（4/2，含 180s 卡死）、binding-unblocked（2/5，含两个 180s 卡死）、
  run-floor（0/6）、headless-real-tool（1/3）、enforcement-real-process（300s 被看守杀）—— 全红。

⇒ 「真 DSH 进程在本机起不来」是错的。每个套件的前置条件不同，至少有三类：
1. 桩引擎能力声明（自检 runtime-probe 若只声明 outputSchema，cancel-and-timeout/usage-reporting 按 fail-closed 记 false）；
2. 补丁行真的激活（composition-patch-layer：行挂载了但等依赖服务，不产生强制效果）；
3. 行能结算（settleEnforcementMount() 的 await root.mountSettled() 无超时 ⇒ 永久 pending ⇒ 进程不退出）。

### 3.2 SELF_CHECK_INCOMPATIBLE 不是环境坏的判据（必须逐场景分）

- 在 registrar-row 的 R 场景里，SELF_CHECK_INCOMPATIBLE 是期望读数——桩引擎只声明 outputSchema，
  其余 fail-closed 记 false。不能一见到它就断言环境坏。
- 在 S02 的 C 场景里，它不该出现：composition-patch-layer 那一项 ok=false 说明真补丁层的
  legion-enforcement-runtime-host-registrar 行「已挂载但未激活（等待依赖服务），不产生任何强制效果」，
  这才是可据以行动的那条读数。

拒绝携带的 reasons/checks 原始读数（原样，来自 logs/S03-registrar.txt 的 R 场景）：

~~~text
INCOMPATCODE RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE
INCOMPATINNER BOOTSTRAP_SELF_CHECK_INCOMPATIBLE
INCOMPATSTATE incompatible
INCOMPATFORBID true
INCOMPATREPAIR true
INCOMPATREASONS ["runtime-probe: 缺必需能力 [cancel-and-timeout, usage-reporting]（能力必须显式为 true，缺失不算具备）"]
INCOMPATCHECKS [{name:composition-patch-layer, ok:true}, {name:runtime-probe, ok:false, reasons:[缺必需能力 [cancel-and-timeout, usage-reporting]]}, {name:sandbox-enforcement, ok:true}, {name:enforcement-mapping, ok:true}, {name:guard-approval-consistency, ok:true}, {name:enforcement-availability, ok:true}]
~~~

S02 的 C 场景携带的 reasons/checks（原样，来自 logs/S02-runtime-host-row.txt）：

~~~text
未通过的自检项 / 原因：
  · composition-patch-layer：legion-enforcement-runtime-host-registrar: 行已挂载但未激活（等待依赖服务），不产生任何强制效果
  · runtime-probe：缺必需能力 [cancel-and-timeout, usage-reporting]（能力必须显式为 true，缺失不算具备）
SVCCHECKS [
  {"name":"composition-patch-layer","ok":false,"reasons":["legion-enforcement-runtime-host-registrar: 行已挂载但未激活（等待依赖服务），不产生任何强制效果"]},
  {"name":"runtime-probe","ok":false,"reasons":["缺必需能力 [cancel-and-timeout, usage-reporting]（能力必须显式为 true，缺失不算具备）"]},
  {"name":"sandbox-enforcement","ok":true},{"name":"enforcement-mapping","ok":true},
  {"name":"guard-approval-consistency","ok":true},{"name":"enforcement-availability","ok":true}]
~~~

参考实现位置：runtime/dsh-composition/bootstrap.mjs:281-293（autoExecutionForbidden=true ⇒ refuse SELF_CHECK_INCOMPATIBLE，带 reasons/checks/repair）。

## 4. 控制项（替身忠实度的锚）

见 scratch/t179/logs3/CTRL-root-row.log（本轮 batch2 产出，命令：node scratch/t179/run-one.mjs runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs）。
实测（本轮 batch2，logs3/CTRL-root-row.log）：**tests 10 / pass 10 / fail 0 / duration_ms 75594.7，exit=0**，
与将军普通终端 10/10 PASS 一致 ⇒ 替身在 spawnSync/非交互型套件上的读数可采信；
§2 中标「本会话不可忠实复跑」的交互式 stdin 套件（S05/S10/S11）不在此列。
（控制项由将军独立复跑裁决；本报告只提供同一命令与原始日志。）

## 5. guarded() 跳过口径：变量没导出 vs 检出不可用

结论：这 12 个套件里已经不存在「两句混成一句」的写法，全部走共享解析器：

- 使用 resolveDshCheckout({need:'cli'}) 的：S01(:133) / S02(:83) / S03(:86) / S04(:80) / S05(:87) /
  S08(:133) / S09(:110) / S10(:169) / S11(:97)；S06/S07/S12 不用 DSH（非真 DSH 套件）。
- 跳过理由取自 DSH_FOUND.reason，而 scripts/lib/dsh-checkout.mjs 已经把三种「不可用」写成三句不同的话
  （kind ∈ env-not-a-dir / unbuilt / not-found），并区分 source: env|candidate。
  这正是任务要求的「更诚实的分法」，且解析器把 path/missing/unbuilt/envValue 一并交出去，来源可读。

残留的一处不精确（建议后续任务顺手收紧，非本轮改动）：
S01(:150)、S05(:90) 只在 DSH === null 时跳过，不再单独复核 existsSync(CLI)
（依赖 need:'cli' 的保证）；而 S02(:90-96)、S03、S04 额外复核了 CLI/CLI_PKG。
两者今天等价（解析器 need:'cli' 已要求 apps/cli/lib/bin.js），但若日后解析器语义变化，
前两者会从「具名跳过」退化成「运行期抛错」。建议统一成 S03 那种三句分法。
本轮无任何 skip 条件被放宽（本轮对 12 个套件零改动）。

## 6. 判成「真缺陷」的最小修复方案（本轮不动手，交后续任务）

| # | 改哪个文件 | 改成什么 | 为什么 |
|---|---|---|---|
| S01 | runtime/dsh-composition/run-floor-dsh-process.test.mjs:606-614（describeReading） | 把 findings 里 run-start-failed / *-threw / probe-threw 的 error 与 code 打进失败信息（record 已在 :391 采集，只是没打印） | 今天的红只说「那次 Run 没有结算」，没有 code/error ⇒ 不可据以行动；打印后即可判定是 SELF_CHECK_INCOMPATIBLE(runtime-probe 缺能力) 还是端口真错。之后再决定：给桩引擎补 cancel-and-timeout/usage-reporting 声明，或修产品端口 |
| S02 | 先改 runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs:642 的失败信息（打印 SVCCHECKS），再据 composition-patch-layer ok=false 修产品 | 让 legion-enforcement-runtime-host-registrar 那一行真的激活（补上它等待的依赖服务），或在 C 场景明确断言自检不兼容 | C 期望 NO_INPUTS_FACTORY + warning: N entries did not activate，实际产品给出自检不兼容；这是产品面行为差，不是环境缺 |
| S03 | runtime/dsh-composition/plugins/runtime-host-row.mjs:657-682（settleEnforcementMount()，await root.mountSettled()） | 给等待加超时，超时后以具名拒绝（带 reasons/checks/repair）结束，而不是让整行永久 pending | N 场景 180s ETIMEDOUT；文件自己的注释(:649-655)已承认「不可见——比一次拒绝更难排查」。fail-closed 方向正确，缺的是可见性 |
| S04 | 同 S03（binding-unblocked 的两个卡死是同一根因） | 同 S03；同时让 ②⑥ 在读数缺失时给出具名原因而不是 reading 'code' of null | ①④ 各 180s ETIMEDOUT；②⑥ 是连带空指针 |
| S06 | team-hub/run-routes.test.mjs（claimToRunning 附近的 helper，:113-360 一组的 claim()===null） | 先让 helper 在 claim() 返回 null 时打印服务端响应体与当前 DB 状态；再定位是路由真错还是单文件内测试共享 DB 的串扰 | 22/22 红都起于 claim()→null；但同一 label 在 CI 被 300s 杀、这里 15.7s 跑完，说明读数强烈依赖调用方式，先取证再修 |
| S08 | runtime/dsh-composition/headless-real-tool.test.mjs:539 附近的失败信息（打印子进程 stdout/stderr 尾段） | 再据读数修正例卡死 | 正例 180s ETIMEDOUT，负例对照成立；正例是产品侧真卡死，但今天红不带子进程输出 |

硬约束（本轮与后续都必须遵守）：不许放宽/删除断言、不许加 skip/only、不许把「跑不动」写成 PASS。

## 7. 复跑命令（普通终端、有真实 DSH 检出/凭据）

以下命令在普通终端（无本会话的匿名管道限制）中运行，读数才权威：

~~~text
# 共享检出（本机已命中）
$env:DSH_CHECKOUT = 'D:/project/DSH/dsh/deepseek-harness'

# S05 跨进程契约（需要 stdin 协议，替身不可用）
node --test orchestrator/worker/runtime-contract-cross-process.test.mjs          # 将军基准：7/12

# S10 ACP 会话边界（交互式 stdin）
node --test runtime/dsh-composition/session-boundary-real-process.test.mjs       # 将军基准：被 300s 看守杀

# S11 subagents 面（交互式 stdin）
node --test runtime/dsh-composition/subagents-surface-real-process.test.mjs      # 将军基准：7/5（失败 65654ms）

# S12 文档/台账棘轮（需要能建管道跑 git；属 T-177 域，本轮不动）
node --test scripts/prt/boundary-facts.test.mjs                                  # 将军基准：300s 看守杀

# S07 kill-drill
node --test team-hub/run-kill-drill.test.mjs                                     # 将军基准：300s 看守杀

# S09 enforcement real process
node --test runtime/dsh-composition/enforcement-real-process.test.mjs            # 将军基准：300s 看守杀
~~~

- 缺什么 / 在哪台机器跑得动：不缺检出（已命中）、不缺构建产物（CLI --version → 0.2.1-alpha.1）、
  不依赖联网或真实模型凭据（真进程套件用桩模型）。唯一缺的是「受限进程可创建匿名管道」——
  本会话（workspace-write 沙箱）不满足；普通终端/CI 满足。
- 若某条在这些命令下仍红，则它是真缺陷（本报告 S05/S10/S11/S12 的将军读数已是正常终端读数）。

## 8. 验收标准逐条对应

| 验收项 | 本轮状态 |
|---|---|
| 逐套件判定表（套件/前置/判定/原始证据/本轮动作） | §2（12/12 行；S09 已定案，S07 因本会话批次预算被 S06c 的 430s 耗尽而未起跑，已给普通终端复跑命令） |
| 判成真缺陷 ⇒ 复跑 exit 0 且 run-ci --only test PASS | 不在本轮范围（将军 2026-10-05 明确改派）；§6 只给最小修复方案 |
| 判成环境不可判 ⇒ CI 输出原因具名可见 + 普通终端复跑命令 | 具名原因来自 resolveDshCheckout.reason（§5，三句分法）；复跑命令 §7 |
| 未放宽判据（断言数量前后对比） | 本轮对 12 个套件零改动：断言/用例数前后一致（S01 6、S02 10、S03 6、S04 7、S05 19、S06 44+30+5、S08 4、S11 12、S12 81，均取自本轮或上一轮原始日志）；无新增 skip/only |
| 结论可复现（命令 + commit + 树；含 SELF_CHECK 的 reasons/checks） | §0 树/commit；§1 方法；§3.2 reasons/checks 原文；命令见 §1/§7 |

## 10. 本轮 batch 实测补充（2026-10-05 14:00-14:05，HEAD d2957edf）

| 项 | 命令 | 读数 |
|---|---|---|
| 控制项 root-row | node scratch/t179/run-one.mjs runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs | tests 10 / pass 10 / fail 0 / 75594.7ms，exit=0（logs3/CTRL-root-row.log）——与将军普通终端 10/10 一致 |
| S06b run-routes | 同上换 team-hub/run-routes.test.mjs | tests 30 / pass 8 / fail 22 / 19933.6ms（复现） |
| S06c run-plane-e2e | 同上换 team-hub/run-plane-e2e.test.mjs | 6 条用例跑完但**无摘要、进程不退出**，430s 超时被杀（logs3/S06c-run-plane-e2e.log） |
| S09 enforcement | 同上换 runtime/dsh-composition/enforcement-real-process.test.mjs | **430030ms 超时、零条用例完成**（logs2/S09-enforcement.log） |

S07 kill-drill 在本会话批次里排在 S06c 之后，因 S06c 耗尽 430s 预算而未起跑；
其权威读数仍取将军普通终端（300s 看守杀）与上一轮 logs/S07-kill-drill.txt（唯一一条 ✔ 2.4s）。
下次轮次或普通终端以 §7 命令收口即可。

## 9. 本轮产物清单（全部在 scratch/，未改任何套件/产品代码）

- scratch/t179/JUDGMENT.md（本文件）
- scratch/t179/run-one.mjs（新增只读探针：受限 shell 下按 §1 口径复跑套件）
- scratch/t179/logs2/*.log（本轮 S01/S09/S10/S11/S12 原始输出）
- scratch/t179/logs3/*.log（本轮控制项 root-row + S06b/S06c/S07）
- scratch/t179/logs/*.txt、scratch/t179/FINDINGS.md（上一轮同法复跑的原始日志与现场笔记）
- scratch/t179/pipe-shim.cjs、scratch/t179/suites.mjs、scratch/t179/driver.mjs（上一轮遗留的替身与清单）
