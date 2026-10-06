# T-009 代码审查报告：端到端验收「请写一个 greet 函数并跑一次测试」

> 角色：reviewer（代码审查）｜任务：T-009｜worktree 分支 `w/T-009`｜HEAD = `3b623afe`（= `main`）
> 纪律：本报告只出结论与证据，**不替人改代码**；每条结论都附可复跑命令或源码位置。
> **输入缺口**：本任务的派单标题与描述都被截断为「端到端验收：请写一个」（根因与复现见 §4 R1）。下方验收标准按本批唯一可考的完整表述 `product/server/verify-experience.sh:55` 重建，**不是逐字引用**（原 spec 已随 R1 丢失）。
> **与 T-007 的关系**：本 worktree 的 HEAD 提交就是 `promote T-007`，`docs/review/T-007-REVIEW.md` 在本分支内。T-007 与 T-009 由同一脚本（`verify-experience.sh`）下发、目标同一个交付物 `tests/e2e-acceptance/*`；T-007 提出的 R1/R2 在本 HEAD 上**仍未被修复**（§4 逐条复核）。

---

## 0. 必须先说清的事实：本 worktree 没有编码 diff

| 判据 | 命令 | 读数 |
| --- | --- | --- |
| 分支 | `git branch --show-current` | `w/T-009` |
| 与 main 的差集 | `git log --oneline main..HEAD` | **空** |
| 工作树 | `git status --short --untracked-files=all` | **空**（无被跟踪改动、无未跟踪文件） |
| 分支位移史 | `git reflog show w/T-009` | 仅一条 `3b623afe w/T-009@{0}: branch: Created from HEAD` |
| 三点同址 | `git rev-parse HEAD main w/T-009` | 三者均为 `3b623afead1f9b2df8e481ef9f007ea77eb3aed5` |
| HEAD 提交内容 | `git show --stat HEAD` | 仅 `docs/review/T-007-REVIEW.md | 211 +`（即 T-007 的审查报告） |
| 交付物源头 | `git log --oneline -3 -- tests/e2e-acceptance` | 仅 `09140411`（T-004），无 T-009 提交 |

**结论：编码阶段（coder）在 `w/T-009` 上未产生任何提交、任何工作树改动。** 本任务没有可逐行审查的 diff。

实现本任务目标的交付物是 **`09140411`（T-004）**，已随 `fcbfaf18 promote T-004` 进入 main，也是当前树里的 `tests/e2e-acceptance/{README.md,greet.mjs,greet.test.mjs}`（3 个文件、共 85 行）。

因此本报告审查两个对象，并明确区分：

1. **实际被审查的产品代码** = 当前树里的 `tests/e2e-acceptance/*`（与 `verify-experience.sh:55` 下发的「写一个 greet 函数并跑一次测试」逐字对应）。
2. **本任务自身的 diff** = 空（如实记录，作为 §4 R3 的输入缺口）。

> 参考团队经验 **exp-t092**：收到「切片/集成回归锚定 / 同批复跑」类任务时，先核对目标是否已被上游交付并验证，避免多轮 worker 空转。本条正命中该形态——T-004 已交付、T-008/T-007 已复跑，T-009 未改任何源码。

---

## 1. 验收标准逐条对照

> T-009 的验收标准在派单中只剩「端到端验收：请写一个」。下面按 `product/server/verify-experience.sh:55` 与 T-004 交付物 README 重建可考标准，并逐条对照。每条结论都给出依据。

### 标准 1：存在 `greet` 函数，且契约与仓库既有夹具一致

- 实现：`tests/e2e-acceptance/greet.mjs:18-20`
  ```js
  export function greet(name) { return `Hello, ${name}!` }
  ```
- 权威契约：`tests/p13-fixture/real-codex-implementation-rework.mjs:34`「Define greet(name) to return exactly `Hello, ${name}!`; this is the authoritative contract」，`:143` 同类要求。
- 交付物 README 声明（`README.md:10-13`）与实现、夹具**三处一致**。**成立。**

### 标准 2：跑一次测试，并给出可复跑的证据

- 用例文件 `tests/e2e-acceptance/greet.test.mjs` 共 5 条；本 worktree 独立复跑 **5 pass / 0 fail / exit 0**（见 §2）。
- README:15-33 给出的复跑命令与沙箱说明与实测一致。**成立。**

### 标准 3（编码规范）：零新增依赖、不动用户可见行为、文档同步

- 新增文件只 `import` `node:test` / `node:assert/strict`，无第三方依赖、无 I/O、无网络；`git show --stat 09140411` 显示仅新增 3 个文件、零既有文件修改。**成立。**
- `README.md:35-38` 声明「纯计算、不改变 Legion 平台用户可见行为、因此无需 docSync」与该改动实际影响一致。**成立。**

### 标准 4（编码规范·本仓硬规则）：新测试必须登记进 CI 套件

- 硬规则：`scripts/ci/run-ci.mjs:1487`「每个测试文件都必须显式登记：未登记 = 不存在的断言」；判据实现 `:4642-4714`；合入判定 `:4772 ok: allOk && !listingIncomplete`。
- `tests/e2e-acceptance/greet.test.mjs` **未被任何套件登记**（实证见 §4 R2）。**不成立 —— 必须修改。**

### 标准 5（审查角色）：问题清单含严重度/位置/建议，并区分「必须修改 / 建议优化」

- 见 §4、§5。**成立。**

---

## 2. 独立复跑读数（本 worktree，HEAD `3b623afe`）

| 项目 | 命令 | 读数 |
| --- | --- | --- |
| 语法检查 | `node --check tests/e2e-acceptance/greet.mjs` | exit 0 |
| 语法检查 | `node --check tests/e2e-acceptance/greet.test.mjs` | exit 0 |
| 用例（受限沙箱内同进程直跑） | `node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs` | `tests 5 / pass 5 / fail 0 / skipped 0`，**exit 0** |
| 已跟踪文件 | `git ls-files tests/e2e-acceptance` | `README.md`、`greet.mjs`、`greet.test.mjs`（3 个） |
| 未登记自查 | `grep "e2e-acceptance" scripts/ci/run-ci.mjs` | **0 命中** |
| 派单截断复现 | 探针（源码见 R1）同 `_phone-act.mjs:48` 取参，**不加引号**传入完整标题 | `{"cmd":"create","arg":"端到端验收：请写一个","argv":[…,"create","端到端验收：请写一个","greet","函数并跑一次测试"]}` |

普通终端可复跑：`node --test tests/e2e-acceptance/greet.test.mjs`。

---

## 3. 审查方法（做了什么 / 没做什么）

- **真读了**：`tests/e2e-acceptance/*`（3 个文件全文）、契约夹具 `tests/p13-fixture/real-codex-implementation-rework.mjs:28-39`、CI 登记闸门 `scripts/ci/run-ci.mjs:1480-1493 / 4636-4776`、下发脚本 `product/server/verify-experience.sh:13-55` 与接收端 `product/server/_phone-act.mjs:40-64`、上一轮 `docs/review/T-007-REVIEW.md` 全文。
- **真跑了**：`node --check` ×2、`node --test --test-isolation=none` ×1、argv 截断复现 ×2（`-e` 模式 + 文件模式不加引号）、`git log/status/reflog/rev-parse/ls-files` 若干（读数见 §0/§2）。
- **没做**：**没有修改任何产品代码或测试代码**；未 push；未联网；未调用 `taskctl` 或任何看板写接口。本报告是本任务唯一落盘产物。

---

## 4. 问题清单（严重度 + 位置 + 修改建议）

### R1【必须修改·高】手机下发文本按空格截断 —— 本条任务自己的派单就是受害现场

- 位置：
  - 发送端 `product/server/verify-experience.sh:18`
    ```sh
    phone() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_phone-act.mjs $*" 2>&1; }
    ```
    调用点 `:55`：`OUT="$(phone create "端到端验收：请写一个 greet 函数并跑一次测试")"`。`$*` **未加引号**，整段又被包在 SSH 命令的双引号里，标题中的空格在远端 shell 处被重新切词。
  - 接收端 `product/server/_phone-act.mjs:48`：`const [cmd, arg] = process.argv.slice(2)`；`:50-54` 只把 `arg` 当消息体（`intent=create_task`）。**第 3 个及之后的词被静默丢弃。**
- 复现（本 worktree 实跑；探针 2 行、取参逻辑与 `_phone-act.mjs:48` 逐字相同，标题**不加引号**以模拟远端 shell 切词后的 argv）：
  ```js
  // 探针 argv-probe.mjs
  const [cmd, arg] = process.argv.slice(2)
  console.log(JSON.stringify({ cmd, arg, argv: process.argv }))
  ```
  ```text
  > node argv-probe.mjs create 端到端验收：请写一个 greet 函数并跑一次测试
  {"cmd":"create","arg":"端到端验收：请写一个","argv":[…,"create","端到端验收：请写一个","greet","函数并跑一次测试"]}
  ```
  `arg`（即任务标题/描述）取到的逐字就是 **「端到端验收：请写一个」** —— 与 T-009 派单进来的标题/描述完全一致。这直接解释了为什么 coder 拿到的是一个没有具体交付物的残缺 spec（“请写一个”后面没了），最可能的后果就是 §0 的“零 diff”。
- 建议（发送端、接收端都要修，只修一侧仍会丢词）：
  1. 接收端更稳：`_phone-act.mjs:48` 改为 `const [cmd, ...rest] = process.argv.slice(2); const arg = rest.join(' ')`，对切词免疫。
  2. 发送端别依赖 `$*`：用 `printf '%q'` 转义后再拼 SSH 命令，或把文本经 stdin / heredoc / 单条 JSON 传给远端，避免 shell 层切词与引号嵌套。
  3. 补一条回归判据（本仓风格：把口子钉死）：断言「含空格/中文标点的文本经手机入口后，任务标题逐字保留」。
- 严重度理由：它是**本条任务派单被截断的根因**，且同一脚本承担“服务器/电脑/手机端到端验收”的演示职责 —— 每次真实验收下发都会截断，会持续误导下游（T-006/T-007/T-009 已连续三次是同一形态）。

### R2【必须修改·高】新增测试文件未登记进 CI 套件，`test` 阶段完备性门禁必然 FAIL

- 位置：`tests/e2e-acceptance/greet.test.mjs`（`09140411` 引入，当前为 git 已跟踪）；判据在 `scripts/ci/run-ci.mjs:4642-4714`，硬规则注释在 `:1487`，合入判定在 `:4772`。
- 事实链（本 worktree 全部可复核）：
  1. 门禁取全仓已跟踪测试：`run-ci.mjs:4693` → `git ls-files '*.test.mjs'`。本文件在列（§2 `git ls-files` 读数）。
  2. 门禁只认“被某个套件 `suites` 逐文件列出”或“落在 `conditionalDirs` / `conditionalFiles` / `EXEMPT`”的文件（`:4695-4699`）。
  3. `grep "e2e-acceptance" scripts/ci/run-ci.mjs` → **0 命中**；顶层 `tests/` **没有整目录 glob**，所有 `tests/*` 都逐个列举（`:1200` dsh-checkout、`:1454-1456` contract 三件、`:4523` p13-fixture、`:4527` tests/browser），`EXEMPT` 表（`:4643-4647`）里也没有它。
  4. ⇒ 该路径**必然**进入 `missing`（`:4695`），`listingIncomplete=true`（`:4704`），`test` 阶段 FAIL（`:4772`）。
- 影响：这正是本仓反复吃过的形态（`run-ci.mjs:4627-4638` 长注释：「一个写好了但没登记的文件 = 一条不存在的断言，而且更糟——读代码的人会以为它被守着」）。该文件是本批交付**新增**的未登记文件。
- 建议：在 `run-ci.mjs` 的 `suites` 里登记，例如
  ```js
  { label: 'e2e-acceptance（端到端验收演示：greet 契约逐字 + 边界）', files: ['tests/e2e-acceptance/greet.test.mjs'], cwd: ROOT },
  ```
  若它确实不该进仓库测试面，则必须进 `EXEMPT`（`:4643-4647`）并**写明理由**；但本文件可执行且实测全绿（§2），按仓库纪律应**登记**而非豁免。
- 复核上一轮：T-007 已提出同一项（`docs/review/T-007-REVIEW.md` R2），到 T-009 的 HEAD `3b623afe` 仍**未修**（`grep` 仍 0 命中）。

### R3【必须修改·中（流程/输入缺口）】本任务编码阶段零交付：`w/T-009` 没有 diff

- 位置：`w/T-009` 分支本身（§0 全部读数：`git log main..HEAD` 空、工作树空、reflog 仅“Created from HEAD”、三点同址 `3b623afe`）。
- 事实：任务目标「写一个 greet 函数并跑一次测试」在 **T-004（`09140411`）已交付并 promote 进 main**，所以 T-009 “无事可做”是可能的；但 coder **既没有提交任何东西，也没有留下“复用 T-004 交付”的说明**，于是本任务在机器读数上与“coder 静默失败”完全同形。
- 影响：验收无法回答“T-009 自己到底交付了什么”。这不属于代码缺陷，但属于**验收输入缺口**。
- 建议：(a) 若接受复用，请将军在本任务卡上明确登记“复用 T-004 交付（`09140411`）”并据此关单；(b) 若要求 T-009 自身产出，则须先修 R1（否则 coder 仍只能拿到截断 spec），再由 coder 真实提交并附测试证据；(c) 无论哪条，本报告 §1 的标准 1/2/3 对该交付物**均已实测满足**。

### R4【建议优化·低】README 把“单元测试”说成“验证整条链路”，超出产物能力

- 位置：`tests/e2e-acceptance/README.md:3-4`「…用于验证『手机下发任务 → Hub 派工 → 电脑 Node 执行 → 产出与证据回传』这条链路」。
- 事实：该目录里唯一的判据是 `greet()` 的纯函数单测（无 Hub / 无 Node / 无消息往返）；真正跑那条链路的是 `product/server/verify-experience.sh`。把两者混为一谈，会让读者以为 `node --test tests/e2e-acceptance/greet.test.mjs` 绿了就代表端到端通。
- 建议：改成两句话——「本目录是**被下发任务的交付物样例**（纯函数 + 单测）；链路的端到端验证在 `product/server/verify-experience.sh`」；或补一条真正走链路的 e2e 判据（与 R7 合并处理）。

### R5【建议优化·低】`greet` 无输入校验，用例也没覆盖非字符串/空值方向

- 位置：`tests/e2e-acceptance/greet.mjs:12-20`（JSDoc 声明“调用方保证为字符串”，实现不做任何校验）；`greet.test.mjs` 只有空字符串 `''` 一条边界（`:21-23`）。
- 事实：`greet(undefined)` / `greet(null)` / `greet(123)` 会分别产出 `Hello, undefined!` / `Hello, null!` / `Hello, 123!` 而不报错。演示纯函数可以接受这一取舍，但应是**被用例钉住的取舍**。
- 建议：要么在 JSDoc 里显式写明这三种输入的行为并各补一条断言，要么加 `if (typeof name !== 'string') throw new TypeError(...)` 并测。二选一即可。

### R6【建议优化·低】第 5 条用例是弱断言，且与前 4 条重复度高

- 位置：`tests/e2e-acceptance/greet.test.mjs:25-27` `assert.equal(typeof greet('Ada'), 'string')`。
- 事实：前 4 条用 `assert.equal` 已蕴含“返回字符串”，这条单独存在只会稀释断言密度。
- 建议：换成一条真正的边界（例如 R5 里挑一个非字符串输入方向），而不是再断言一次类型。

### R7【建议优化·低】命名与仓库 e2e 约定不一致：`greet.test.mjs` 其实是单测

- 位置：`tests/e2e-acceptance/greet.test.mjs`。
- 事实：本仓把真端到端用例命名为 `*.e2e.test.mjs`（`team-hub/claim-reservation.e2e.test.mjs`、`team-hub/delivery-submit.e2e.test.mjs`、`tests/browser/whiteboard-ui.e2e.test.mjs`、`whiteboard/apps/server/test/governance.e2e.test.mjs`）。本文件叫 `greet.test.mjs` 却在 `e2e-acceptance` 目录、README 又谈“端到端”——三者口径不一。
- 建议：若维持为纯函数单测，让 README/目录名如实（见 R4）；若要保留“端到端验收演示”语义，就改成 `*.e2e.test.mjs` 并至少覆盖一次“下发文本 → 任务标题/证据”的可观测面（可顺带覆盖 R1 的截断回归）。

### R8【建议优化·低·附带发现】`run-ci.mjs` 里的行号自引用已漂移

- 位置：`scripts/ci/run-ci.mjs:1487` 注释写「本文件 4568 行的完备性检查会拦」，而该完备性检查实际在 `:4642-4714`。
- 事实：这是一处**与 T-004/T-009 无关的既有注释漂移**，仅在按 R2 修登记时会被读到；引用错行号会把改登记的人引到错误位置。
- 建议：修 R2 时顺手把 `:1487` 的“4568 行”改成实际行号或去掉行号（改用“本文件的完备性检查”这种不写死行号的指法）。

---

## 5. 必须修改 vs 建议优化

- **必须修改（2 项代码/机制 + 1 项流程）：**
  - **R1** 手机下发文本被空格截断（`verify-experience.sh:18` + `_phone-act.mjs:48`）——本条任务的 spec 即被它截断，是根因级缺陷。
  - **R2** `tests/e2e-acceptance/greet.test.mjs` 未登记进 CI 套件——按 `run-ci.mjs:4693-4714/4772` 判据必然使 `test` 阶段 FAIL，违反 `:1487` 硬规则。
  - **R3** `w/T-009` 零 diff——流程/输入缺口，需将军拍板「复用 T-004 交付」还是「要求 coder 重做」，并先修 R1。
- **建议优化（5 项）：** R4（README 越界表述）、R5（`greet` 输入契约未钉）、R6（弱断言）、R7（命名/口径不一致）、R8（CI 注释行号漂移）。

---

## 6. 环境限制（如实标注）

1. 本会话沙箱对 `spawn`（管道捕获）返回 `EPERM`，故 `node --test` 采用 `--test-isolation=none` 同进程直跑；这与 CI 单文件单进程的语义在**断言结果**上等价，已在 §2 记录。
2. 权威任务看板数据（本任务的 T-009 记录）**不在本仓**：`scrum/tasks.json` 在本 worktree 与主工作区均不存在（`scrum/board.json` 仅 `{"tasks":{}}`）；本机 `team-hub/team.db` 是 `scope=software` 的旧库，其 `tasks` 表里 **没有 T-009 记录**（最新一条为 `T-194`，2026-10-06T07:28Z，早于本任务的 15:48Z 派工），权威库是 `verify-experience.sh` 指向的远端 `root@117.72.146.36:/var/lib/legion-hub/team.db`。因此 §1 的验收标准是从下发脚本与 T-004 交付物**重建**的，不是逐字引用（原 spec 已随 R1 丢失）。
3. 未联网、未 push、未调用任何 `taskctl`/看板写接口。
4. 上一轮 T-007 报告（`docs/review/T-007-REVIEW.md`）记录过“本报告未能提交”（worktree git 元数据写入被拒）；本轮的落盘/提交状态见文末“办结说明”。

---

## 7. 总体结论

**有条件通过 —— 就“被审查交付物”而言功能正确、测试实测全绿；但有两处必须修改，且其中 R1 正是本条任务派单被截断的根因。**

- **事实层面**：`w/T-009` 没有编码 diff（分支与 `main` 同点 `3b623afe`、工作树干净、reflog 无位移）；实现该任务目标的是 `09140411`（T-004），已在 main。
- **被审查交付物层面**：`greet` 契约与既有夹具一致；`node --check` ×2 exit 0；`node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs` = **5 pass / 0 fail / exit 0**；零新依赖、不动用户可见行为、文档同步判断成立。
- **必须修改层面**：① 手机入口按空格截断文本（本任务 spec 的丢失原因，已连续影响 T-006/T-007/T-009）；② 新测试未登记 → `test` 阶段完备性门禁必然 FAIL；③ `w/T-009` 零交付需将军明确处置。
- **建议优化层面**：README 越界表述、`greet` 非字符串输入契约未钉、弱断言、命名口径不一致、CI 注释行号漂移。

---

## 附：本报告的关键证据落点

| 结论 | 证据 |
| --- | --- |
| `w/T-009` 无 diff | `git log --oneline main..HEAD` 空；`git status --short --untracked-files=all` 空；`git reflog show w/T-009` 仅 `branch: Created from HEAD`；`git rev-parse HEAD main w/T-009` 三者同址 `3b623afe` |
| 实现该目标的是 T-004 | `git show --stat HEAD` 仅 `docs/review/T-007-REVIEW.md`；`git log -1 -- tests/e2e-acceptance` = `09140411`；`fcbfaf18 promote T-004` |
| 契约一致 | `tests/e2e-acceptance/greet.mjs:18-20` ↔ `tests/p13-fixture/real-codex-implementation-rework.mjs:34` |
| 测试实测 | `node --check` ×2 exit 0；`node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs` → 5 pass / 0 fail / exit 0（§2） |
| R1 截断根因 | `product/server/verify-experience.sh:18/55`；`product/server/_phone-act.mjs:48-54`；探针（源码见 R1）不加引号复现输出 `arg="端到端验收：请写一个"`，与派单逐字一致 |
| R2 未登记 | `scripts/ci/run-ci.mjs:1487`、`:4642-4714`（`git ls-files` 在 `:4693`）、`:4772`；`grep "e2e-acceptance" run-ci.mjs` = 0；`tests/` 无整目录 glob（`:1200/1454-1456/4523/4527`）；`EXEMPT` 表 `:4643-4647` 无它 |
| R4/R5/R6/R7/R8 | `tests/e2e-acceptance/README.md:3-4`；`greet.mjs:12-20`；`greet.test.mjs:21-23/25-27`；`team-hub/claim-reservation.e2e.test.mjs` 等具名约定；`run-ci.mjs:1487` 注释 vs `:4642` |

---

## 办结说明（本报告的落盘与提交）

- 报告落盘：`docs/review/T-009-REVIEW.md`（本文件，内容完整）。
- 本任务为审查角色，**未改任何产品代码/测试代码**；`git status --short` 中除本报告外无其它改动。
- **本报告在本会话内未能提交**：沙箱拒绝对 worktree 的 git 元数据写入，`git add docs/review/T-009-REVIEW.md` 报
  ```text
  fatal: Unable to create 'D:/project/DSH/legion/.git/worktrees/T-009/index.lock': Permission denied
  ```
  （exit 128；与 T-007 的 `docs/review/T-007-REVIEW.md:180-186` 记录同一形态）。文件已落盘，`git status` 显示为未跟踪 `?? docs/review/T-009-REVIEW.md`。
- 普通终端补提交命令：
  ```powershell
  git add docs/review/T-009-REVIEW.md
  git commit -m "T-009 审查报告（reviewer）" -- docs/review/T-009-REVIEW.md
  ```
