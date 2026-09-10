# STASH-WIP-AUDIT —— 本地 7 个 stash 的 WIP 恢复审计

> 审计对象：仓库本地 `stash@{0}`..`stash@{6}`（7 个）
> 审计基线：`main` = `445e4f2`（与 `origin/main` 一致）
> 审计日期：2026-09-10
> 结论：**无功能增量可回收**；7 个 stash 的功能改动在当前 `main` 中均已有（或以更完整的实现取代），另有个别条目属运行时状态而非源码。7 个 stash 全部保留未 drop。

本文件是本次「恢复 stash WIP」动作的事实记录：先证明哪些内容**真的**不在 `main`，再说明为何最终没有把任何 stash 合入。目的是让后来者不必重跑这轮取证，也能核对结论。

---

## 1. 背景

一次「提交并推送本地领先的内容并合并到主分支」的请求触发了本次审计。当时的事实核查显示：

- `main` 与 `origin/main` **完全同步**（均为 `445e4f2`，`git rev-list --left-right --count origin/main...main` = `0 0`），`main` 上没有任何本地领先的提交可推。
- 唯一真正「本地领先」的文件是未跟踪的 `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`（已单独提交，见 `5b0a0bb`）。
- 另有 7 个 stash 与一批 worktree 分支。工作树分支经核对均无领先内容（`fix/scrum-worker-blocked-resume` 与其远程 0/0，`codex/*` 已被 `main` 包含，`w/T-*` 为已过期/已推的旧任务分支）。

因此本审计只针对 7 个 stash：它们**是否包含未落地的功能工作**。

## 2. 判据与方法

判定「可回收」的必要条件：该 stash 的改动包含**当前 `main` 中不存在的功能语义**。为此使用 4 类证据，逐条交叉验证，不以「stash 未 drop」或「文件不同」作为结论依据：

1. **三路合并模拟** —— `git merge-tree --write-tree --merge-base=<stash>^ main <stash>`，得到「把该 stash 应用到当前 main」的结果树与冲突清单。（注意：冲突文件会写入冲突标记，故其结果树的 numstat **不能**直接当作新增量。）
2. **逆应用检测** —— 对每个被触摸文件取增量补丁，在 `main` 的独立工作树上执行 `git apply -R --check`。可逆应用成功 ⇒ 该增量已完整存在于 `main`。
3. **逐行存在性比对** —— 仅取该 stash **自己新增**的非空行（`git diff -U0 <stash>^ <stash>`），检查每一行是否已出现在 `main` 的同名文件中，给出精确的「残余行数」。
4. **功能等价核查** —— 对残余行逐个 grep `main` 中的对应实现位置（函数/端点/类型/标签表），确认同一语义是否已由**更好的实现**承载。

第 3 步的结果（各 stash 残余行合计 372 行）是本次审计的关键：它把「文件整体看起来差很多」的大数字，收敛为少量真正待判定的行，再由第 4 步逐条归零。

## 3. 总览

| stash | 对象 SHA | 创建时间 | 基线 | 规模 | 残余行 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `stash@{0}` | `e1ed4d1` | 09-10 11:16 | `fcbc1bd` | +32/-11 | 4 | 已落地（仅注释措辞差异，main 为更新版本） |
| `stash@{1}` | `34648ef` | 09-10 11:10 | `78d4d2d` | +234/-18 | 35 | 已落地（分片上传四端点与总上限均已在 main；残余为旧版注释） |
| `stash@{2}` | `c1637d7` | 09-08 13:50 | `3757151` | +356/-4 | 18 | 已落地（草稿晋升链路已在 main） |
| `stash@{3}` | `a571f72` | 09-07 14:35 | `cba1fb7` | +917/-120 | 63 | 已落地（舞台文档路径、中止退避、聊天状态、智能体选择器均已在 main） |
| `stash@{4}` | `9864d9d` | 09-06 14:10 | `e0e529f` | +1276/-127 | 211 | 已被取代（内联目标行被 `GoalsBoard.tsx` 取代；通知口径迁至 `notify.ts`） |
| `stash@{5}` | `63cb344` | 09-05 12:58 | `0b853ad` | +5/-5 | — | 不回收：运行时状态文件（非源码） |
| `stash@{6}` | `f8afb1f` | 09-05 12:39 | `51e476e` | +45/-6 | 41 | 已被取代（中枢单源 KPI 由 `displayBoard` + `statusCounts` 实现） |

7 个 stash 的基线提交**全部是 `main` 的祖先**（逐条 `git merge-base --is-ancestor` 为真），因此这不是分叉合并，而是 `main` 自身历史上遗留的、未提交的工作树快照。

**关键结构事实：7 个 stash 不是累进的，而是互斥变体。** 按时间顺序最早的 `stash@{6}`（09-05）带 `fromMission`/`hubStats`，而更晚的 `stash@{4}`（09-06）、`stash@{3}`（09-07）反而没有；`CenterPanel.tsx` 在 7 个快照中存在 **273 / 297 / 312 / 509** 行四种互斥形态。因此它们不存在「依次叠加」的可能，任何按序套用的做法都会互相覆盖。

## 4. 逐条明细

### 4.1 `stash@{0}` —— 已落地

- 唯一文件 `workbench/scripts/serve.mjs`（+32/-11）。与 `main` 的同名文件逐字节比对**仅差 4 行，且 4 行全部是注释措辞**（`main` 侧为更新后的文案）。
- 依据：`git diff main:workbench/scripts/serve.mjs 'stash@{0}:workbench/scripts/serve.mjs'` 只输出 3 个注释 hunk；两个版本行数均为 1939。

### 4.2 `stash@{1}` —— 已落地

- 唯一文件 `workbench/scripts/serve.mjs`（+234/-18），残余 35 行全是文档注释与旧版说明。
- 依据：分片上传/断点续传功能在 `main` 中完整存在 —— `UPLOAD_MAX_SIZE`（`workbench/scripts/serve.mjs:695`）、四个端点定义（`:680-688`）、路由绑定（`:1660`）、实现（`:1797` init / `:1803` chunk / `:1819` complete / `:1832` abort）；写入策略 `ask/skip/rename` 与冲突决策在 `:414`、`:452`。
- 该 stash 的基线（`78d4d2d`）早于 `stash@{0}` 的基线（`fcbc1bd`），其文件为 1608 行而 `main` 为 1939 行：**按原样套用会让 `serve.mjs` 回退 331 行**。

### 4.3 `stash@{2}` —— 已落地

- 文件 `plugins/src/index.ts`（残余 18 行）、`plugins/src/norms.ts`（逆应用成功）。
- 依据：草稿晋升链路在 `main` 中已具备 —— `buildPromotePrompt`（`plugins/src/index.ts:45`）、`promotedTo` 状态字段（`:1206`）。

### 4.4 `stash@{3}` —— 已落地

- 文件 8 个（+917/-120），残余 63 行。
- 依据：
  - `plugins/src/index.ts`：残余 4 行（`resolveStageDocPaths` / 「worker 未完成/派工失败」退避计数与纠错分支）已在 `main:447`、`main:556`。
  - `workbench/src/components/ChatView.tsx`：残余 5 行（`awaiting` / `replied` / 「✓ AI 已回复」）已在 `main:698`、`main:675`、`main:704`。
  - `workbench/src/components/SkillsPanel.tsx`：残余 54 行（可搜索智能体选择器 `agent-picker`）已在 `main:725`、`main:2`。
  - `plugins/tests/artifact-register.test.mjs`、`plugins/tests/worker-regression.test.mjs`、`workbench/src/components/RulesPanel.tsx`、`workbench/src/index.css`：逆应用检测**全部成功**（增量已完整在 `main`）。
  - `workbench/src/App.tsx`：残余 1 行，为注释。

### 4.5 `stash@{4}` —— 已被取代

- 文件 15 个（+1276/-127），残余 211 行，是 7 个 stash 中最大的一块，但仍属**被取代的早期迭代**：
  - `workbench/src/components/CenterPanel.tsx`（残余 173 行）：该 stash 把目标行 `GoalRow` **内联**进 `CenterPanel`；`main` 已抽出独立组件 `workbench/src/components/GoalsBoard.tsx`（407 行），并完整覆盖同一能力 —— 目标级上下文编辑与版本（`GoalsBoard.tsx:287`、`:221`）、per-goal 活动流（`:207`、`:304`）、状态文案与动作标签表（`:12`、`:25`）。该文件在 `stash@{4}` 中**不存在**，即内联写法是它的前身。
  - `workbench/src/components/NotifyView.tsx`（残余 5 行）与 `workbench/src/api.ts`（残余 3 行）：目标生命周期动作 `goal:pause/resume/done/cancel/context` 在 `main` 中**已存在**，只是迁到了 `workbench/src/notify.ts`（白名单 `:56`、优先级 `:68`/`:70`、标签表 `:90-94`），且 `GoalsBoard.tsx:28-32` 另有一份。服务端确实会发出这些动作（`team-hub/server.mjs:923`、`:986`、`:1010`），与前端口径一致。
  - `team-hub/server.mjs`（残余 19 行）：`publishGoalRecord`（`main:943`）、`docsDir`（`main:27`）、审计 `goalId` 字段均已存在。
  - `roles.json`（残余 1 行）：`"artifact": "docs/REQUIREMENTS.md"` 已在 `main:11`。
  - `workbench/src/App.tsx`（残余 1 行）：`onGoalStatus`/`onSaveContext` 透传已在 `main:492`。
  - `README.md`（残余 8 行）：该 stash 想补写的多目标/目标级文档说明，`main` 已在 `README.md:285-300`（§6.3 目标级文档）与 `README.md:324` 记载 —— 属重复文档。
  - `workbench/src/index.css`、`workbench/src/types.ts`、`TaskDetailModal.tsx`、`GoalModal.tsx`、`CommandBar.tsx`、`HubSchedulerModal.tsx`、`docs/ORCHESTRATION-V3.md`：逆应用检测全部成功。

### 4.6 `stash@{5}` —— 不回收（运行时状态）

- 唯一文件 `scrum/daemon.json`，在 `main` 中**不存在**（`git cat-file -e main:scrum/daemon.json` 失败），即该文件已移出版本控制。
- 其内容为守护运行时状态：`workerTimeoutMs` / `staleMinutes` 阈值，以及 `inbox`（5→7）、`lastSweepAt`（`2026-09-04T02:39:55.163Z` → `2026-09-05T04:58:31.834Z`）、`uptimeMs`（3394002 → 106719）等**当时**的计数器。
- 判定：提交它等于把某次运行时快照写入版本库，且会覆盖调参习惯，不属于「功能 WIP」。**不建议回收。**

### 4.7 `stash@{6}` —— 已被取代

- 文件 2 个（+45/-6），残余 41 行。
- 该 stash 想做的是「中枢模式数字单源」：给 `KpiBar` 增加 `hubStats` 属性，由各岗位 hub mission 计数聚合；并在 `CenterPanel` 用本空间 missions 兜底推导编队（`fromMission`）。
- 依据：`main` 已用另一种实现达成同一目标且更彻底 —— `workbench/src/App.tsx:441-442` 引入 `displayBoard`（中枢模式下 `boardFromHubTasks([])`），`:446` 将其交给 `KpiBar`，`workbench/src/components/KpiBar.tsx:54` 用 `statusCounts` 取数。因此 `main` 的 `KpiBar` **没有也无法接受 `hubStats` 属性**：该残余代码按原样移植会直接编译失败（TS2322），需要改写而非套用。`CenterPanel` 的 `missions` 兜底同理未采用，`main` 在 hub 模式已由 `displayBoard` 消除 v1 board 数字串台。

## 5. 未回收项与理由

| 项 | 处置 | 理由 |
| --- | --- | --- |
| 7 个 stash 的全部代码增量 | 不回收 | 逐条核查后均在 `main` 中已有等价或更完整实现（第 4 节） |
| `stash@{5}` 的 `scrum/daemon.json` | 不回收 | 运行时状态文件，非源码 |
| 7 个 stash 本体 | **保留**（未 drop） | 可追溯；如需复核可按下方命令复跑 |

## 6. 复现命令

```bash
# 0) 基线
git rev-parse main                 # 期望 445e4f208904fde5733dc3bbf07070de40426ae9

# 1) 基线均为 main 祖先（非分叉）
for i in 0 1 2 3 4 5 6; do git merge-base --is-ancestor "stash@{$i}^" main && echo "stash@{$i} ancestor=true"; done

# 2) 三路合并模拟：把某个 stash 应用到当前 main 会发生什么
git merge-tree --write-tree --merge-base='stash@{4}^' main 'stash@{4}'

# 3) 逆应用检测：对每个被触摸文件判断增量是否已在 main 中
git worktree add --detach .probe main
for f in $(git diff --name-only 'stash@{4}^' 'stash@{4}'); do
  git diff --output=/tmp/p.patch 'stash@{4}^' 'stash@{4}' -- "$f"
  git -C .probe apply -R --check --whitespace=nowarn /tmp/p.patch && echo "ALREADY-IN-MAIN $f"
done
git worktree remove .probe --force

# 4) 逐行存在性比对：列出该 stash 新增行中「不在 main」的行
git diff -U0 'stash@{6}^' 'stash@{6}' -- workbench/src/App.tsx \
  | grep '^+' | grep -v '^+++' | sed 's/^+//' | sort -u > /tmp/added.txt
git show main:workbench/src/App.tsx | sort -u > /tmp/main.txt
comm -23 /tmp/added.txt /tmp/main.txt     # 仍不在 main 中的新增行
```

## 7. 处置建议

1. 7 个 stash 保留现状即可，不必 drop：其内容已无可回收价值，但保留成本为零且便于日后核对。
2. 若确要清理，建议先在本文件记录结论后再 `git stash drop`，避免同一份取证被重复执行。
3. 本轮唯一进库的内容是 `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`（建议稿）与本审计文件；**无任何源码改动**。
