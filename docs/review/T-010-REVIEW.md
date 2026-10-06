# T-010 代码审查报告：验收脚本派发的占位任务（「手机派任务 → 电脑认领」链路探针）

> 角色：reviewer（代码审查）｜任务：T-010｜审查对象分支：`w/T-010`
> 本 worktree HEAD = `096716039e3106f1376a6dafddd97b99ec9066f0`（= `main`，即 `promote T-008`）
> 纪律：本报告只出结论与证据，**不替人改代码**；每条结论都附可复跑命令或源码位置。
> 用途说明：这不是「给一段实现找茬」，而是**审查这次编码阶段到底交付了什么**，并对本任务锚定的产品链路（手机派单 → 认领）做一次独立代码审查。

---

## 0. 必须先说清的事实：本 worktree 没有编码 diff

| 判据 | 命令 | 读数 |
| --- | --- | --- |
| 分支 | `git rev-parse --abbrev-ref HEAD` | `w/T-010` |
| 与 main 的差集 | `git log --oneline main..HEAD` | **空** |
| 工作树 | `git status --short --untracked-files=all` | **空**（无被跟踪改动、无未跟踪文件） |
| 分支位移史 | `git reflog show w/T-010` | 仅一条：`09671603 w/T-010@{0}: branch: Created from HEAD` |
| 三分支指针 | `git rev-parse HEAD main w/T-010` | 三者同为 `09671603…` |
| worktree 目录 | `Get-Item .` | 创建于 **23:53:31**（= 建支时刻），工作树内被跟踪源码无任何晚于检出时刻的写入 |
| 基线到 HEAD 的提交 | `git log --oneline fcbfaf18..HEAD --stat` | 只有 T-006/T-007/T-008 的 promote（全部是 `docs/` 证据/审查文档），**无任何产品代码改动** |

**结论：编码阶段（coder）在 `w/T-010` 上未产生任何提交与任何工作树改动。本任务没有可逐行审查的 diff。**

按团队经验 **exp-t092「回归复跑先查上游验证防空转」** 判型：本任务是`验收脚本派发的占位任务`，且正文与 **T-006 逐字相同**（见 §1），属**同批回归锚定复跑**。故本报告 = ①如实记录「零交付」；②按 exp-t092 在**当前 HEAD** 上独立复跑验收面（§3）；③对本任务锚定的产品链路做真实代码审查（§4，这是与 T-006 那份 coder 证据不同的增量）。

---

## 1. 任务正文的认定：它是什么、它不是什么

**它是**：`product/server/verify-phone.mjs:214` 里那段真实部署验收脚本第 ⑬ 步发出的探针文本。

```js
// product/server/verify-phone.mjs:211-218
const sent = await call('POST', '/api/agent-messages', {
  body: {
    conv: c.json.convId, scope: SPACE, by: 'phone-verify',
    body: `验收脚本派的任务 ${new Date().toISOString()}`, intent: 'create_task',
    clientRequestId: `verify-task-${Date.now()}`,
  },
  token: access,
})
```

第 ⑬ 步的注释（`verify-phone.mjs:201-204`）写明它是「**手机派任务真的能被电脑领走**（整个产品的主标题动作）」。所以它**天然只有一个时间戳正文，没有功能需求**——这是设计如此，不是需求丢失。

**它不是什么（一个容易误判的点）**：它**不是** T-007/T-008 那条「空格截断」缺陷的受害者。T-007/T-008 走的是 `verify-experience.sh` 经 SSH shell 切词的路径；本任务走的是 `verify-phone.mjs` 的 **JSON API** 路径，正文里的空格与毫秒时间戳**原样保留**（本任务派单正文即 `验收脚本派的任务 2026-10-06T09:27:24.549Z`，与模板逐字一致）。两类任务的症状相似（都只有一个残缺/空洞的标题），根因不同：**T-007/T-008 是文本被丢，T-010 是文本本来就空洞**。

**它还与 T-006 逐字相同**：`docs/T006-evidence/README.md:11` 记录 T-006 的标题与描述为「`验收脚本派的任务 2026-10-06T09:27:24.549Z`」——与本任务派单正文**连毫秒时间戳都完全一致**。一次**新**的 `verify-phone.mjs` 运行会用 `new Date().toISOString()` 生成**新**时间戳；逐字相同 ⇒ 这不是一次新的验收运行，而是**同一张探针卡被重复建卡 / 重复派发**（或同一验收事件被二次审查）。这本身就是 §4 R2 的实证。

---

## 2. 验收标准逐条对照

本任务（reviewer）的验收标准是审查角色的通用标准，逐条如下：

| 标准 | 结果 | 依据 |
| --- | --- | --- |
| 对照验收标准与编码规范逐条审查，每条结论有依据 | ✅ | §0~§4，每条附命令读数或「文件:行」 |
| 给出问题清单：严重度 + 位置 + 修改建议 | ✅ | §4 R1–R6 |
| 明确区分「必须修改」与「建议优化」 | ✅ | §5 |
| （隐含）审查对象确有编码改动可供逐行审查 | ❌ **不成立** | §0：`w/T-010` 零 diff，coder 无提交亦无「复用 T-006 交付」的说明 → 见 R3 |
| （仓库纪律）真实验证：typecheck / build / test 至少跑其一 | ✅ | §3：13 套件 143/143 全绿、两个 typecheck exit 0 |
| （仓库纪律）问题不虚构、不只看格式 | ✅ | §4 全部结论均可复跑/可对照源码 |

---

## 3. 独立复跑读数（exp-t092 第 3 步；本 worktree，HEAD `09671603`，Node v24.19.0）

按 `.legion/delivery.json` 声明的全部 **13 条**验证命令、以声明 argv 逐条真跑：

| # | id | tests | pass | fail | exit |
| --- | --- | --- | --- | --- | --- |
| 1 | path-domain | 9 | 9 | 0 | 0 |
| 2 | repo-identity | 7 | 7 | 0 | 0 |
| 3 | write-intent-store | 25 | 25 | 0 | 0 |
| 4 | claim-policy | 39 | 39 | 0 | 0 |
| 5 | git-plumbing | 8 | 8 | 0 | 0 |
| 6 | delivery-store | 12 | 12 | 0 | 0 |
| 7 | integration-worker | 9 | 9 | 0 | 0 |
| 8 | write-intent-routes | 7 | 7 | 0 | 0 |
| 9 | delivery-routes | 4 | 4 | 0 | 0 |
| 10 | metrics | 3 | 3 | 0 | 0 |
| 11 | write-eligibility | 8 | 8 | 0 | 0 |
| 12 | legacy-convergence | 6 | 6 | 0 | 0 |
| 13 | delivery-ui | 6 | 6 | 0 | 0 |
| | **合计** | **143** | **143** | **0** | **全 0** |

类型检查（与 T-006 同口径）：

| 命令 | 结果 | exit |
| --- | --- | --- |
| `node <dsh>/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit` | 无诊断输出 | 0 |
| `node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit` | 无诊断输出 | 0 |

> 口径：沙箱内 `node --test` 会因测试运行器以管道 stdio 派生子进程而 `spawn EPERM`；本仓套件是「每文件一进程、入口即自跑 node:test」的形状，直跑 `node <file>` 与 CI 语义等价（与 `docs/TEST_REPORT.md`、T-006 证据既有口径一致）。本任务结论不依赖该差异：**13/13 套件 exit 0、143/143 用例 pass**。

对照上游：`docs/T006-evidence/README.md` §4 在基线 `fcbfaf18` 上同样是 **143 pass / 0 fail**。本任务在更后的 HEAD `09671603` 复跑得到**同数**，且 `fcbfaf18..HEAD` 无产品代码改动 ⇒ **无回归、无新增增量**。

---

## 4. 问题清单（严重度 + 位置 + 修改建议）

### R1【必须修改 · 高】验收探针在真实看板上建**持久、无标记、无回收**的任务，直接流入正式派工链

- **位置**：
  - 建任务：`product/server/verify-phone.mjs:205-219`（`body` 见 §1，`intent: 'create_task'`）。
  - 落库变成任务：`team-hub/agent-conversations.mjs:232`
    ```js
    createdTask = createTask({ by: input.by, scope: a.scope, role: a.role,
      title: body.slice(0, 200), description: body, status: 'todo' })
    ```
    即**任务标题 = 消息正文**，正文是「验收脚本派的任务 <时间戳>」，于是看板上就出现一张标题为时间戳的 `todo` 任务。
  - 回收：**没有**。`grep -n "taskId|cancel|transition|delete" product/server/verify-phone.mjs` 只命中 `:183` 的 `reader.cancel()`（那是取消 SSE 读流），**全脚本没有任何一处**把建出来的 `taskId` 转成 `canceled/done`、也没有任何 `probe`/`探针` 标记。
- **事实链**：探针任务落成 `status: 'todo'` ⇒ 符合认领闸门，会被守护当作**正式工作**领走并派给 coder/reviewer。现场证据：T-006 的派单正文就是这段探针文本（`docs/T006-evidence/README.md:11`），本任务 T-010 同样是它（§1）。**一张自动生成的占位任务，实打实地消耗了 coder 与 reviewer 的整轮工作**。
- **影响**：
  1. 每次真实部署验收都会在**生产空间**留一张无意义 `todo`，无上限累积；
  2. 下游无法从标题/正文区分「探针」与「真需求」，于是一律派工 → 空转；
  3. 还会**反噬探针自身的断言**：上一次探针残留成 `in_review/in_progress` 时，本次第 ⑬₂ 条会走 `skip`（见 R4）。
- **修改建议（三选一即可，推荐 1+2）**：
  1. **打标记**：探针正文/标题加机器可辨前缀，如 `[验收探针·请勿派工] 验收脚本派的任务 <ts>`，并让派工侧（或 `createTask` 调用处额外字段）能识别跳过；
  2. **自回收**：断言完成后调用已存在的 `POST /api/transition`（路由见 `team-hub/routes/task-lifecycle.mjs:166-181`）把该探针任务置 `canceled`；
  3. **隔离**：探针改打一个专用一次性 scope，验证完连同 scope 丢弃。
- **严重度理由**：这是本任务「零交付 + 空转」的**上游根因级缺陷**——不修，则每一次端到端验收都会复制出下一张占位卡，症状会在 coder/reviewer 两侧反复出现。

### R2【必须修改 · 中】探针的幂等键每次运行都不同，且无去重/回收 ⇒ 同一验收事件被重复建卡、重复派发

- **位置**：`product/server/verify-phone.mjs:215` 的 `clientRequestId: verify-task-${Date.now()}`；幂等实现 `team-hub/agent-conversations.mjs:148-158`（`once(scope, actor, requestId, …)` 以 `(scope, by, clientRequestId)` 为键去重）。
- **事实**：每次运行都生成**新键**，故 `once()` **永不命中**，必然新建任务；再叠加 R1 的无回收 ⇒ 任务逐次线性累积。
- **重复的实证**：T-006 与 T-010 的正文**逐字相同（含毫秒时间戳 `2026-10-06T09:27:24.549Z`）**。新一跑必然生成新时间戳，逐字相同说明这是**同一 payload 被重复建卡/重复派发**。同一脚本还在正文与 requestId 上用了**两个独立的时钟**（`new Date().toISOString()` 与 `Date.now()`），两者可互相矛盾、也可能在同一毫秒内碰撞（`IDEMPOTENCY_CONFLICT` 只在 payload 不同时触发）。
- **修改建议**：明确探针的意图后二选一——
  - 「一次验收一张探针卡」⇒ 用**稳定键**（如 `phone-verify-${SPACE}-${yyyymmddhh}`），让重复运行幂等落到同一张卡，再配 R1 的回收；
  - 「每次运行都要一张新卡」⇒ 保留唯一键，但**必须**配 R1 的回收与标记。
  同时把正文时间戳与 requestId 统一取自**同一个**时间变量，消除两钟不一致。

### R3【必须修改 · 中（流程/输入缺口）】本任务编码阶段零交付，且未说明「复用上游」

- **位置**：`w/T-010` 分支本身（§0 全部读数：`git log main..HEAD` 空、工作树空、reflog 仅 `branch: Created from HEAD`、目录创建时刻 = 建支时刻）。
- **事实**：探针任务本就没有功能需求（§1），coder 因而不可能、也不需要产出实现；但 coder **既没有提交任何东西，也没有留下「本任务无可交付 / 复用 T-006 交付」的说明**，于是在机器读数上与「coder 静默失败」完全同形。这与 T-007/T-008 的 R3 是同一形态。
- **影响**：验收无法回答「T-010 自己交付了什么」；本报告只能通过重建上游（exp-t092）来判定其验收面。
- **修改建议**：
  - (a) 若接受复用，请将军在本任务卡登记「占位探针任务，复用 T-006 交付与验证（T-006 证据已入库）」并据此关单；
  - (b) 若要求消除空转，须**先修 R1/R2**（否则下一次验收仍会造出同样的占位卡）；
  - (c) 无论走哪条，§3 的 143/143 已证明当前 HEAD 验收面无回归。

### R4【建议优化 · 中】第 ⑬₂ 条（主标题动作）会**系统性降级为 skip 且 exit 0**，且探针自身会加剧该降级

- **位置**：`product/server/verify-phone.mjs:248-269`。当认领失败、且看板上存在任一 `in_review/in_progress` 任务时，走 `skip('⑬₂ …', …)`；而 `skip` 不计入失败、**不改退出码**（`:305-313`）。
- **事实**：探针自己刚建了一张 `todo`；同一空间里只要有**任何**任务在验收中，这条「派任务可被认领」的主断言就变成 `○ 不适用`。R1 意味着探针卡会持续残留（T-006 就曾走到 `in_review`），于是「这条最该验的断言」在真实环境里大概率常年不验、而报告仍报绿。
- **修改建议**：注释里「在空队列上跑这条才有分辨率」是合理的，但应把这份无分辨率的**读数**显式暴露：例如统计「连续 N 次验收 ⑬₂ 均为 skip」并入失败/告警，或在检测到占用时按 `verify-phone` 可用的空窗做有上限重试。至少别让「主标题动作没被验到」与「验过了」在只看颜色的报告里同形。

### R5【建议优化 · 低】探针任务的生命周期在契约测试与部署验收之间口径不一、且无文档

- **位置**：契约层同款断言 `team-hub/mobile-api-contract.test.mjs:346-397`（⑯）与部署层 `product/server/verify-phone.mjs:205-273`（⑬）。
- **事实**：两者都「建任务 → 认领 → release 归还」，但**都不处理建出来的任务本身**（契约测试因为跑临时库而无害，部署脚本跑真实库就有害）。同一动作在两层的收尾语义没有被写下来，读者容易以为「契约测试不管，说明不用管」。
- **修改建议**：在 `verify-phone.mjs` 第 ⑬ 步补一段注释，写明探针任务的生命周期契约（谁建、谁回收、回收不了时留什么标记），并让契约测试与部署脚本采用同一口径（推荐都回收；契约测试可断言「探针任务最终为 canceled」以把这个口径钉住）。

### R6【建议优化 · 低（已知缺陷复核，非新发现）】`_phone-act.mjs:48` 仍静默丢弃多余参数

- **位置**：`product/server/_phone-act.mjs:48` `const [cmd, arg] = process.argv.slice(2)`，`:50-58` 只把 `arg` 当消息体。
- **事实**：这是 **T-007/T-008 报告 R1 已经指出的同一处缺陷**（手机下发文本被空格切词后只取第一个词），本任务复核**仍然成立**（同一条 `[cmd, arg]` 解构未变）。列在此处只为「本次确实复核过」，不重复主张修复路径（以 T-007/T-008 报告为准）。
- **修改建议**：见 `docs/review/T-007-REVIEW.md` R1 / `docs/review/T-008-REVIEW.md` R1，同一处一起修即可，避免重复改两遍。

---

## 5. 必须修改 vs 建议优化

**必须修改（3 项）：**

- **R1** 验收探针在真实看板建**无标记、无回收**的持久任务 → 占位卡流入正式派工链、空转 worker（本任务空转的上游根因）。
- **R2** 探针幂等键随每次运行变化 + 无回收 ⇒ 任务线性累积，且**同一验收事件已被重复建卡/派发**（T-006 与 T-010 正文逐字相同）。
- **R3** `w/T-010` 零 diff 且无「复用上游」说明 ⇒ 验收输入缺口，需将军拍板关单口径。

**建议优化（3 项）：**

- **R4** 主标题动作断言（⑬₂）可被 skip 且 exit 0，探针自身会加剧该降级。
- **R5** 探针任务生命周期在契约测试与部署验收之间口径不一、无文档。
- **R6** `_phone-act.mjs:48` argv 截断（T-007/T-008 已报，本次复核仍成立，不重复主张）。

---

## 6. 与既有报告的关系（去重说明）

- **T-006**（coder，`aae4542a`）：判为同一占位任务，按 exp-t092 复跑 13 套件，未审源码。本报告在其基础上**新增了源码层审查**（R1/R2/R4/R5 均为 T-006 未覆盖的产品代码问题），并复现了同一验收面（143/143）。
- **T-007 / T-008**（reviewer）：锚定的是 T-004 的 `tests/e2e-acceptance/`（greet）交付物，其 R1 是 `verify-experience.sh` 空格截断。本任务锚定的是**另一条链路**（`verify-phone.mjs` 第 ⑬ 步），正文未截断（§1），故 R1 不落在本任务上；仅 `_phone-act.mjs:48` 这一处共用代码重叠，已在 R6 标注「以 T-007/T-008 为准」。
- **建议将军**：把 T-006/T-010 视为**同一探针缺陷的两个样本**（T-010 的正文即 T-006 的正文），修复 R1/R2 时以本报告的源码定位为准；关单 T-010 时按 R3(a) 登记「复用 T-006 交付」。

---

## 7. 环境与边界（如实标注）

1. 沙箱对管道 stdio 的 `spawn` 返回 `EPERM`，故测试按仓库既有口径直跑 `node <file>`（与 CI 断言结果等价，§3 已说明）。
2. 权威看板数据不在本 worktree：`D:/project/DSH/legion/scrum/board.json` = `{"tasks":{}}`，`tasks.json` 不存在。故 T-010 的卡片状态无法本机读取；§1 的「与 T-006 逐字相同」依据的是本任务派单正文与 `docs/T006-evidence/README.md:11` 的入库记录。
3. 本报告**未修改任何产品代码或测试代码**，唯一落盘产物是 `docs/review/T-010-REVIEW.md`；未联网、未 push、未调用任何 `taskctl`/看板写接口。

---

## 8. 总体结论

**就「被审查交付物」而言：本任务无可审查的编码 diff；就本任务锚定的产品链路而言：功能实测健康，但探针机制本身有必须修改的缺陷。**

- **事实**：`w/T-010` 零 diff（分支与 `main` 同点 `09671603`、工作树干净、reflog 无位移、目录创建时刻 = 建支时刻）；`fcbfaf18..HEAD` 只有文档类 promote，无产品代码改动。
- **验证**：13 条声明验证命令 **143/143 pass、0 fail、exit 全 0**；两个 typecheck exit 0；对照 T-006 基线同数 ⇒ **无回归、无新增增量**。
- **必须修改**：① 验收探针建持久无标记任务、无回收（占位卡流入派工链 → 空转）；② 幂等键每次变化 + 无回收 ⇒ 任务累积、同一验收事件重复建卡（T-006/T-010 正文逐字相同）；③ 零交付且无复用说明，需将军拍板关单口径。
- **建议优化**：主标题动作断言可被静默 skip；探针生命周期口径无文档；`_phone-act.mjs:48` 截断（已知，复核仍成立）。

---

## 9. 关键证据落点

| 结论 | 证据 |
| --- | --- |
| `w/T-010` 无 diff | `git log --oneline main..HEAD`（空）；`git status --short -uall`（空）；`git reflog show w/T-010`（仅 `branch: Created from HEAD`）；`git rev-parse HEAD main w/T-010` 三点同值；`Get-Item .` CreationTime=23:53:31 |
| 基线到 HEAD 无产品改动 | `git log --oneline fcbfaf18..HEAD --stat` → 仅 `docs/review/T-00{7,8}-REVIEW.md`、`docs/T006-evidence/*` |
| 探针来源与模板 | `product/server/verify-phone.mjs:201-219`（`:214` body、`:215` requestId） |
| 探针落成任务 | `team-hub/agent-conversations.mjs:217-234`（`:232` `title: body.slice(0,200), status:'todo'`） |
| 无回收 | `grep "taskId|cancel|transition|delete" product/server/verify-phone.mjs` → 仅 `:183 reader.cancel()`；无 `/api/transition` 调用 |
| 幂等键 | `team-hub/agent-conversations.mjs:148-158`（`once(scope, actor, requestId)`） |
| 可回收路由存在 | `team-hub/routes/task-lifecycle.mjs:166-181`（`POST /api/transition`） |
| ⑬₂ 可 skip 且不改退出码 | `product/server/verify-phone.mjs:248-269`、`:305-313` |
| 契约层同款 | `team-hub/mobile-api-contract.test.mjs:346-397`（⑯） |
| T-006 与 T-010 正文相同 | `docs/T006-evidence/README.md:11` ↔ 本任务派单正文 `验收脚本派的任务 2026-10-06T09:27:24.549Z` |
| 验收面全绿 | §3：13 套件 143/143、exit 全 0；两 typecheck exit 0；`.legion/delivery.json` 为命令清单 |
| 已知截断缺陷 | `product/server/_phone-act.mjs:48`（T-007 R1 / T-008 R1） |
