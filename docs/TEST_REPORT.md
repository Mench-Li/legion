# T-011 测试执行报告（tester）——端到端验收「请写一个 greet 函数并跑一次测试」

> 角色：测试执行（tester）｜任务：T-011（隔离 worktree `w/T-011`）｜上游：T-004（coder 交付）→ T-007（reviewer 审查）
> 被测基线：**本 worktree HEAD = `c87f4c71`**（`git rev-list --count main..HEAD` = 0、`git status --short` 除本任务证据目录外为空）⇒ 本 worktree 无编码 diff；
> 实现本任务目标的是上游 **T-004 的 `09140411`**（`tests/e2e-acceptance/`，已在 main）。
>
> **结论速览：整体判定「不通过（全绿未达成）」。**
> - **交付物用例全绿**：`greet` 契约用例 **5/5 pass / 0 fail / exit 0**（两种跑法各一次）；`node --check` ×2 exit 0；边界探针 10 项契约成立；零新增依赖。
> - **仓库 `test` 阶段完备性门禁红（F1）**：`git ls-files '*.test.mjs'` 的 547 个文件里，有 **2 个挂了却没有任何套件执行它们** ——
>   `desktop/scripts/payload-filter.test.mjs`、`team-hub/site-routes.test.mjs`。按 `run-ci.mjs:5106-5115 + :5183` 的判据，`listingIncomplete=true` ⇒ `test` 阶段 FAIL。
>   二者本地实跑分别 **6/6**、**47/47** 全绿，是「写好了、没人跑」的同一形态（正是 T-007 的 **R2** 的复发，只是换了两个文件）。
> - **T-007 的 R1/R2 就「本交付物」而言本轮实测已闭合**：`greet.test.mjs` 已在 `run-ci.mjs:933-934` 登记（R2 解法）；手机下发截断已由 `daea3313` 修（R1），本轮用真替身 Hub 复现：**全文 `端到端验收：请写一个 greet 函数并跑一次测试` 逐字到达 body**。
> - 另有 `product/server/phone-act.test.mjs` 的 3/4 用例在本沙箱被 `spawn EPERM` 挡住（**环境边界，非产品缺陷**，已用不依赖 spawn 的真子进程逐条复现产品行为）。

---

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| 执行机 | Windows，DSH 文件沙箱 `workspace-write`、禁网、审批关闭 |
| Node / npm | `v24.19.0` / `11.17.0` |
| 被测树 | `.legion-worktrees/T-011`，`w/T-011` @ `c87f4c71`（= `main`，零编码 diff） |
| 交付物 | `tests/e2e-acceptance/{greet.mjs,greet.test.mjs,README.md}`（T-004 `09140411`） |
| 执行口径 | 沙箱内 `node --test <file>` 的默认隔离要 fork 子进程 ⇒ **`Error: spawn EPERM`（exit 1）**。故用 `--test-isolation=none` 同进程直跑，另用 `node <file>` 直跑交叉验证（两者断言结果一致） |
| 证据目录 | `docs/T011-evidence/`（00~05 原始日志 + 3 个探针/复刻脚本） |
| 上游核对 | 参考团队经验 **exp-t092**「回归复跑先查上游验证防空转」：T-004 已交付实现、T-007 已审查；但本轮**有新增验证增量**（CI 门禁现状 + R1 活链路），故不是空转 |

### 1.1 关于本任务派单被截断（为什么 spec 只有「端到端验收：请写一个」）

这不是笔误：下发脚本旧写法把参数经 `ssh <host> "… $*"` 拼串，远端 shell 再按空格分词，`_phone-act.mjs` 旧的 `argv.slice(2)` 只取前两个 ⇒ 标题在**第一个空格**处被截断。
T-007 的 **R1** 已定位并修复（`daea3313`，2026-10-07）：发送端 `product/server/verify-experience.sh:28-32` 改成**逐个 base64**，接收端 `product/server/_phone-act.mjs:43+79-87` 加 `--b64` 解码 + **网络之前**的参数校验。本轮已独立复现（§2 用例 7/8）。

## 2. 用例执行矩阵（跑在 `w/T-011` @ `c87f4c71`）

| # | 用例 / 命令 | 实际结果 | exit | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `node --check tests/e2e-acceptance/greet.mjs` | 无输出 | **0** | `01-greet.log` |
| 2 | `node --check tests/e2e-acceptance/greet.test.mjs` | 无输出 | **0** | `01-greet.log` |
| 3 | `node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs` | **tests 5 / pass 5 / fail 0 / skipped 0** | **0** | `01-greet.log` |
| 4 | `node tests/e2e-acceptance/greet.test.mjs`（直跑交叉验证） | **5 / 5 / 0** | **0** | `01-greet.log` |
| 5 | 边界探针 `node docs/T011-evidence/boundary-probe.mjs` | 10 项契约成立；非字符串输入不抛（见 §4 R-Risk） | **0** | `05-boundary.log` |
| 6 | **CI 套件清单完备性**（忠实复刻）`node docs/T011-evidence/ci-completeness-check.mjs` | **missing = 2** ⇒ 判定 FAIL | **1** | `03-ci-completeness.log` |
| 7 | R1 直探针：坏 base64 `node product/server/_phone-act.mjs --b64 '@@@@' <b64>` | `--b64 的第 1 个参数解出来是空的`，**未触网** | **2** | `02-phone-transport.log` |
| 8 | R1 活链路：替身 Hub（`stub-hub.mjs`）捕获 `_phone-act.mjs` 的 body | body = **全文** `端到端验收：请写一个 greet 函数并跑一次测试` | 见注 | `02-phone-transport.log` + `_captured-body.json` |
| 9 | 对照（旧写法无 `--b64`，多词被切成 4 段） | body = `AAA`（在第一个空格截断） | 见注 | `02-phone-transport.log` |
| 10 | `node --test --test-isolation=none product/server/phone-act.test.mjs` | 1 pass / 3 fail（**全部为 spawn EPERM**，见 §4 E1） | 1 | 报告 §4 E1 |
| 11 | 未登记文件仍可跑：`desktop/scripts/payload-filter.test.mjs` | **tests 6 / pass 6 / fail 0** | **0** | `04-unregistered-tests.log` |
| 12 | 未登记文件仍可跑：`team-hub/site-routes.test.mjs` | **tests 47 / pass 47 / fail 0** | **0** | `04-unregistered-tests.log` |
| 13 | `node --test tests/e2e-acceptance/greet.test.mjs`（默认隔离，仅证沙箱边界） | `Error: spawn EPERM` | 1 | `00-environment.log` |

> 注：用例 8/9 的 Node 进程在打印正确 JSON 之后，于沙箱内退出时触发 libuv 的 `Assertion failed: … uv_handle_closing`（退出码 `-1073740791`）。这是**沙箱下 Node 关闭期的环境伪影**——JSON 输出与替身 Hub 捕获的 body 均已正确落盘，产品行为判据以捕获到的 body 为准。
>
> 用例 6 为何是「复刻」而非真跑：`run-ci.mjs` 执行套件与 `exec('git', …)` 都走 `spawn` 管道，本沙箱一律 `EPERM`（用例 13 实证），故 `node scripts/ci/run-ci.mjs --only test` 在本沙箱不可运行。复刻脚本 `docs/T011-evidence/ci-completeness-check.mjs` 逐行对应 `run-ci.mjs:5054-5125/5183`，并已把「注释里提到的路径」排除（避免把注释当登记）。

## 3. 验收标准逐条对应

### 标准 1：按用例实际执行并记录（环境 / 步骤 / 实际结果 / 日志证据）✅

见 §1、§2：13 条命令全部真跑，原始输出落 `docs/T011-evidence/00~05*.log`；探针与复刻脚本一并入库，可无网复跑。

### 标准 2：全绿才判定通过；有失败给出复现步骤与归属 ❌（F1）

- 交付物层：**全绿**（5/5、exit 0，两种跑法一致）。
- 仓库 `test` 阶段层：**不完备门禁 FAIL**（§4 F1：2 个已跟踪测试文件无归属）。按验收口径「全绿才判定通过」，**整体不通过**。
- 另有环境边界项 E1（不属产品缺陷，不计入失败，但如实登记）。

### 标准 3：说明回归范围与结论 ✅

见 §5。

## 4. 失败项（复现步骤 + 实际输出 + 归属）

### F1【必须处置·门禁红】2 个已跟踪测试文件没有任何套件执行 ⇒ `test` 阶段完备性门禁 FAIL

- **判据位置**：`scripts/ci/run-ci.mjs`
  - `:5104` `const tracked = await exec('git', ['ls-files', '*.test.mjs'], …)`
  - `:5066-5071` `listed = 每个 suite 的 files 按各自 cwd 归一成仓库相对路径`
  - `:5080` `conditionalDirs = ['plugins/tests/','board-plugin/tests/']`；`:5100-5103` `conditionalFiles`；`:5054-5058` `EXEMPT`
  - `:5106-5110` `missing = tracked - listed - conditionalDirs - conditionalFiles - EXEMPT`
  - `:5111-5115` `missing.length > 0 ⇒ listingIncomplete = true`；`:5183` `ok: allOk && !listingIncomplete`
- **复现步骤**（普通终端可用真命令；沙箱内用复刻）：
  1. 生成全仓测试清单：`git ls-files '*.test.mjs'`（本轮 = **547** 个）；
  2. 真门禁（普通终端）：`node scripts/ci/run-ci.mjs --only test`，看 `套件清单完备性` 一行；
  3. 本沙箱内等价复刻：`node docs/T011-evidence/ci-completeness-check.mjs`（先由 `git ls-files` 写入 `_tracked-tests.txt`）。
- **实际输出**（`03-ci-completeness.log`，exit 1）：

  ```text
  HEAD tracked *.test.mjs      = 547
  listed（去注释后字面量 + 动态） = 512
  missing                      = 2
    MISSING  desktop/scripts/payload-filter.test.mjs
    MISSING  team-hub/site-routes.test.mjs
  tests/e2e-acceptance/greet.test.mjs 有归属?  true
  => 判定：FAIL（listingIncomplete=true ⇒ test 阶段红）
  ```

- **反证（不是「跑不起来」）**：两个文件都被 `git ls-files` 跟踪、都本地实跑全绿（`04-unregistered-tests.log`：**6/6**、**47/47**，各 exit 0），且 `grep -n "payload-filter\|site-routes" scripts/ci/run-ci.mjs` = **0 命中**；`desktop` 套件只逐条列了 `desktop/main.test.mjs`、`desktop/scripts/update-payload.test.mjs`、`desktop/scripts/platform-filter.test.mjs`（`:601/620/694`），恰好漏了同目录的 `payload-filter.test.mjs`。
- **引入提交**：
  - `desktop/scripts/payload-filter.test.mjs` ← `f621052a`（2026-10-07，`fix(desktop): 三个 34 MB 的数据库备份差点被打进公开安装包`）；
  - `team-hub/site-routes.test.mjs` ← `af0f7809`（2026-10-08，`feat(site): 官网 —— 根路径从「门口页」升级为一页正式官网`）。
  - 两者都**晚于** `c1bac79f`（2026-10-07 一次性补登记 56 个文件）⇒ 是「同类缺陷的复发」，不是旧账。
- **归属**：`scripts/ci/run-ci.mjs` 的 `suites` 登记表缺这两条（**不是** `greet` 交付物引入，也**不是** `tests/e2e-acceptance` 的问题）。按仓库纪律，`greet.test.mjs` 一类可执行且能过的文件应**登记**而非豁免；同理这两条应补登记（或按 `:5054` EXEMPT 并写明理由）。本角色只报告，不代改。

### E1【环境边界·非产品缺陷】`phone-act.test.mjs` 3/4 用例被沙箱 `spawn EPERM` 挡住

- `node --test --test-isolation=none product/server/phone-act.test.mjs`：**1 pass / 3 fail**，`fail` 的实际值均为 `status = null`（`spawnSync` 返回 `error.code = 'EPERM'`），stdout 为空：
  - ✖ 「解不开的 base64 当场具名退出」：期望 exit 2，实际 `null`；
  - ✖ 「正确的 base64 过得去参数这一关」：实际输出 `''`，匹配不到 `/fetch|bad port/`；
  - ✖ 「不带 --b64 的老写法仍可用」：同上，实际输出 `''`；
  - ✔ 「带空格的参数经 base64 往返逐字不变」（纯计算，不 spawn）。
- **独立复现（绕开 spawn，跑真子进程）**见 `02-phone-transport.log`：用例 7 得到 `EXIT_BAD=2` 与具名消息且未触网；用例 8/9 都前进到网络（`bad port`）——与套件三条期望逐条一致。
- 结论：**测试文件的期望是对的、产品行为也是对的**，红的只是「沙箱不允许 Node 用管道捕获子进程输出」这一条环境约束。按仓库先例（T-191/T-192/R-18）如实登记，不计入产品失败。

### R-Risk【建议项·不计入失败】reviewer T-007 的 R4~R7 复核

| 项 | 本轮实测 | 是否失败 |
| --- | --- | --- |
| R5 `greet` 无输入校验 | `greet(undefined) → "Hello, undefined!"`、`null → "Hello, null!"`、`123 → "Hello, 123!"`，均不抛（JSDoc 声明「调用方保证字符串」） | 不失败（契约未要求），但**取舍未被用例钉住** |
| R6 第 5 条弱断言 | `assert.equal(typeof greet('Ada'), 'string')` 与前 4 条重复 | 不失败，建议换成真边界 |
| R4 README 口径 | `README.md:3-4` 把纯函数单测说成验证整条链路 | 不失败（文档口径） |
| R7 命名 | `greet.test.mjs` 是单测却在 `e2e-acceptance` 目录 | 不失败（命名） |

## 5. 回归范围与结论

### 5.1 回归范围（为什么是这三块）

本交付物（T-004 `09140411`）**只新增 3 个文件、零既有文件修改、零第三方依赖、纯函数**（`git show 09140411 --stat`），因此：

1. **交付物自身**：`tests/e2e-acceptance/greet.test.mjs`（5 例）+ 契约夹具一致性。→ 全绿。
2. **CI 登记面**（T-007 R2 的直接落点）：`run-ci.mjs` 的 `suites` 是否给这个新文件一个归属。→ `greet.test.mjs` 已登记（`:933-934`）；但同一张表整体不完备 ⇒ 门禁红（F1）。
3. **R1 活链路**（本任务 spec 被截断的根因）：`verify-experience.sh` → `ssh` → `_phone-act.mjs` 的参数保真。→ 已修并复现通过。

未做（并说明理由）：未跑 `run-ci.mjs` 全量 `test` 阶段（沙箱 `spawn EPERM`，§2 用例 13 实证）；未起真手机/真 Hub（禁网、无宿主）。这两条的替代表征已分别给出（复刻判定 + 替身 Hub 捕获）。

### 5.2 结论

1. **greet 交付物：通过。** `node --check` ×2 exit 0；5 条用例 5/5（两种跑法）exit 0；边界探针 10 项契约成立（名字逐字、含空格、中文、空串、换行、前后空白、长文本）；零新增依赖。
2. **T-007 的 R1：本轮确认为「已修」**（`daea3313`，HEAD 祖先）。真替身 Hub 捕获到 `body` = **全文**；旧写法对照捕获到 `body` = `AAA`——截断机制与修复同时被钉住。
3. **T-007 的 R2：就 `greet.test.mjs` 而言已闭合**（`run-ci.mjs:933-934` 有登记）。**但完备性门禁整体仍红**：另有两个测试文件（F1）无归属 ⇒ `test` 阶段 FAIL。
4. **整体判定：不通过（全绿未达成）**，红点 = F1，归属 `scripts/ci/run-ci.mjs` 的 `suites` 登记表（引入者 `f621052a`、`af0f7809`），与 `greet` 交付物无关。**没有虚报通过**：所有红/绿均来自可复跑命令与原始日志。
5. 流程/输入缺口未消：本任务派单文本仍是截断后的 `端到端验收：请写一个`（R1 的传输层已修，但**存量派单文本不会自动补齐**）；且 `w/T-011` 相对 main **零编码 diff**，与 T-007 的 R3 同形——本报告即本任务唯一交付物。

## 6. 环境边界（如实标注，不是产品缺陷）

- 沙箱内 Node 以**管道 stdio** 派生子进程一律 `EPERM`（`00-environment.log` 实证：`spawnSync.status = null, error.code = 'EPERM'`）。因此：`node --test` 默认隔离、`run-ci.mjs` 的 `spawn` 与 `exec('git')`、`phone-act.test.mjs` 的 `spawnSync` 都无法在本会话内运行；已分别用 `--test-isolation=none`、复刻判定、直跑真子进程替代，并在证据里标明替代关系（`00-environment.log` 另收 `execSync('git --version') → EPERM`，即 `run-ci.mjs` 的 `exec('git', …)` 同样不可用）。
- 本机 **禁网**：真 Hub / 真手机链路不可达。R1 的活链路验证使用 **`127.0.0.1` 替身 Hub**（`stub-hub.mjs`），只替身网络那一层，被调用的是**真实**的 `_phone-act.mjs`。
- 未联网、未 push、未调用任何 `taskctl`/看板写接口。

## 7. 复跑命令（普通终端）

```powershell
# 交付物用例（应 5/5、exit 0）
node --check tests/e2e-acceptance/greet.mjs
node --check tests/e2e-acceptance/greet.test.mjs
node --test tests/e2e-acceptance/greet.test.mjs          # 普通终端
node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs   # 受限沙箱

# 边界探针（应 10 项契约成立）
node docs/T011-evidence/boundary-probe.mjs

# F1 复现：完备性门禁（普通终端直接跑真门禁；本沙箱用复刻）
git ls-files '*.test.mjs' > docs/T011-evidence/_tracked-tests.txt
node docs/T011-evidence/ci-completeness-check.mjs         # 期望 exit 1、missing=2
node scripts/ci/run-ci.mjs --only test                    # 普通终端：看「套件清单完备性」一行

# 未登记文件本身是绿的（反证：缺的是登记，不是用例）
node --test --test-isolation=none desktop/scripts/payload-filter.test.mjs   # 6/6
node --test --test-isolation=none team-hub/site-routes.test.mjs             # 47/47

# R1 直探针（坏参数当场退出；新的 base64 路径前进到网络）
node product/server/_phone-act.mjs --b64 '@@@@' <b64>
```

## 附：证据落点

| 结论 | 证据 |
| --- | --- |
| 交付物 5/5、syntax exit 0 | `docs/T011-evidence/01-greet.log` |
| 边界/输入契约读数 | `docs/T011-evidence/05-boundary.log`、`boundary-probe.mjs` |
| F1 门禁红（missing=2） | `docs/T011-evidence/03-ci-completeness.log`、`ci-completeness-check.mjs` |
| 未登记文件实跑全绿 | `docs/T011-evidence/04-unregistered-tests.log` |
| R1 修复被独立复现（全文到达 body） | `docs/T011-evidence/02-phone-transport.log`、`_captured-body.json`、`stub-hub.mjs` |
| 环境/注册核对 | `docs/T011-evidence/00-environment.log`（含 `run-ci.mjs:933-934` 登记行、EPERM 实证、HEAD/干净树读数） |

> 未入库说明：按回执纪律，本角色只落盘、`git add`/`commit` 未执行（diff 由守护自动捕获并记录到任务）；本报告与 `docs/T011-evidence/` 留在 `w/T-011`，由将军验收后 promote；**未 push、未动 taskctl**。
