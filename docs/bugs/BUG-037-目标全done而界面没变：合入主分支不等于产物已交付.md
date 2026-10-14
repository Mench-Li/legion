# BUG-037：目标全 done，用户"还是没有头像" —— 合入主分支 ≠ 用户看到的东西变了

> 状态：**已修**（代码 + 判据）；**需要重启宿主**才能让守护加载新产物（`plugins/lib` 是编译产物）
> 影响面：`plugins/src/index.ts` 的 `autoPromote`（两条自动合入通道）/ 新增 `plugins/src/artifactDelivery.ts`
> 症状：**每一层读数都是绿的** —— 合并成功、任务 done、目标 done、套件全绿，而界面没变

## 0. 将军原话与现场

> 「软件流水线空间仍然有几个 Agent 没有换上头像，几个 soldier 和 general，为他们选取头像；
>  **目标任务都已经完成，但是实际上并没有赋予头像**」

现场（`team.db`）：

```
G-mv7kzgnu-1 [software] done   11:59 发布 → 13:23 收尾
  T-203 需求  done   T-204 方案  done   T-205 拆解  done   T-206 用例  done
  T-207 编码  done   T-208 审查  done   T-209 测试  done   T-210 部署  done
```

八个阶段全绿，目标自动 settle 成 done。而将军看到的是「没头像」。

## 1. 现场取证：三层都"对"，唯独用户看不到

### ① 服务端其实是对的，而且是活的

```
GET http://127.0.0.1:5173/hub/api/roster?scope=software   → 200
general      avatar=human:s11   external=true
soldier-a    avatar=human:s12   external=true
soldier-b    avatar=human:s13   external=true
soldier-auto avatar=human:s14   external=true
（另 8 个内置岗位 requirement…devops 全有令牌）
```

改之前这里返回的是**硬编码的齿轮**（这就是"没头像"的来源）：

```js
// team-hub/routes/team-views.mjs（b8f66e64 之前）
for (const [soldier, list] of bySoldier) {
  agents.push(summarize(soldier, `${soldier} · 执行中`, list, '', '⚙️', true))
}
```

T-207 已把它改成 `EXTERNAL_AVATAR_TOKENS` 冻结表 + 确定性兜底。

### ② 真正没到位的是**前端产物**

| | 时间 |
| --- | --- |
| `workbench/dist` 构建 | **12:17:59** |
| 客户端源码改动（侧栏用户卡的 `⚙`、左轨的「管」、技能授权标签） | **12:51:50** |

`workbench/dist` 落后源码 **34 分钟**。而运行中的指挥台
（`workbench/scripts/serve.mjs`，:5173）读的**正是 `workbench/dist`** ⇒ 它继续发 12:17 的旧包，
所以界面上那三处**仍然是齿轮和「管」字** —— 那正是"general 没头像"。

### ③ 部署阶段撞上了构建失败，而它没有拦住任何东西

T-210 自己的证据（`docs/G-mv7kzgnu-1/T210-evidence/build-vite.txt`）：

```
# workbench: vite build
# EXIT=1
Error: spawn EPERM   (esbuild 起子进程被沙箱挡住)
```

它的处置是：CI 走 `--only syntax,boundary,deps,doc`（**把 build 阶段排除掉**）+ 一个只打
服务端 HTTP 的 `deploy-smoke`。于是构建失败没有产生任何红，T-207…T-210 全部 done。

## 2. 根因

**两条各自都"合理"的规则，合起来把"交付"这件事漏掉了：**

1. `dist/` 是 **gitignored** 的构建产物 ⇒ `git merge --no-ff w/T-207` 只搬源码，
   产物一个字节都过不去；
2. 没有任何机器闸门要求"构建通过" ⇒ 构建失败只是一条**证据**，不是一次**未完成的交付**。

而 `autoPromote`（`plugins/src/index.ts`）做完 merge 就认为交付完成：

```ts
const merge = await runGit(workspace.repoRootFor(), ['merge', '--no-ff', `w/${taskId}`, ...])
if (merge.code !== 0) { ...abort...; return false }
await runGit(workspace.repoRootFor(), ['worktree', 'remove', '--force', dir])
await runGit(workspace.repoRootFor(), ['branch', '-D', `w/${taskId}`])
return true          // ← 到这里为止，"合入"就被当成了"交付"
```

> 一个「源码已合入主分支」的读数，与一个「用户看到的东西已经变了」的读数，
> 在**没有人重建产物**的时候长得完全一样 —— 而后者才是交付的定义。

### 这不是第一次

同一天上午，指挥台的「按目标筛选」也是同一个形状（源码在、产物旧）：将军先看见"没变化"，
人工重建之后才看见。当时被当成一次偶发，现在看是**结构性**的。

## 3. 修法

### ① 合入之后必须**在主工作区**重建受影响的产物

新增 `plugins/src/artifactDelivery.ts`：

- `appsToRebuild(changedPaths)`（纯函数）：按本次合入的路径决定要重建哪些 app
  （`workbench` / `whiteboard`，与 `run-ci` 的 build 阶段同一批）；
- `rebuildMergedArtifacts({ repoRoot, changedPaths })`：在**主工作区**跑各 app 的
  `npm run build`，带超时与输出尾部。

`autoPromote` 在 merge 成功后调它（交付前先 `rev-parse HEAD`，交付后用
`git diff --name-only <before> HEAD` 算改动清单）。

**为什么必须由守护做、而不是 worker**：

- worker 跑在受限沙箱里 —— 上面的 `spawn EPERM` **就是**那个沙箱，它构建不了；
- 就算构建成功，它是在自己的 worktree 里构建的，产物同样回不到主工作区。
- 守护跑在宿主进程里、在主工作区里，而且**它才是那个做 merge 的人**：
  谁产生"主分支前进"这件事，谁就要负责让用户的界面跟上。

### ② 重建失败 = **交付未完成**，不许推进 done

`autoPromote` 的返回值从 `boolean` 改成三分：

```ts
type PromoteOutcome =
  | { ok: true }
  | { ok: false; kind: 'merge';    detail: string }   // 源码还在 w/<id>，改动没丢
  | { ok: false; kind: 'artifact'; detail: string; receipt: ArtifactBuildReceipt }
```

两个调用点（流水线中间阶段、devops 收官）按 `kind` 分流：

- `merge` → 原来那段"请人工解冲突"的提示（逐字不变）；
- `artifact` → 新的 `artifactFailureComment(...)`：**源码已在 main、界面仍是旧的、
  给出可复现命令、说清"重建成功后再推进 done"**，并停在 `in_review`。

★ **devops 收官那一步也照此处理**：原来"部署类终态免将军验收"会直接 `advanceTo(done)`，
现在"免验收"的前提是**产物真的交付了** —— 否则就是本次这个现场（目标 done、将军看不到变化）。

### 已知边界（不假装覆盖）

- 本模块只重建**静态前端产物**。**服务端/守护进程内的代码要重启才生效**
  （BUG-036 是同一类），这里不做、也不能做"重启宿主"。
  ⇒ 本修复本身也要**重启宿主**才生效（`plugins/lib` 是编译产物）。
- 判据按路径决定要不要重建，**宁可多建一次**：多建只花时间（~25s），
  漏建就是本 BUG 本身。所以 `workbench/mobile/**` 这种其实不必构建的改动也会触发一次。
- `git diff --name-only` 只列被跟踪文件，而 `dist/` 早已 gitignore ⇒ 产物路径本该不出现在
  改动清单里；`NON_SOURCE_SEGMENTS` 那一层是兜底，故意只排除 **app 第一层**目录
  （嵌套的 `dist` 仍算源码 —— 两种判错的代价不对称）。

## 4. 判据（`plugins/tests/artifact-delivery.test.mjs`，15 例）

| 层 | 守什么 |
| --- | --- |
| ① 判据 | 哪些路径触发重建（源码触发 / 文档与后端不触发 / app 第一层产物不触发 / 反斜杠与 `./` 前缀 / 空值不炸） |
| ② 行为 | 无目标时**不起**构建进程；成功 ⇒ `ok`；失败/超时/起不来 ⇒ **`ok:false` 且带输出尾部**；缺 `scripts.build`、目录不在 ⇒ 失败并点名 |
| ③ 文案 | 失败评论必须说清四件事：源码在 main / 界面仍是旧的 / 怎么复现 / 别推进 done |
| ④ 接线 | `autoPromote` 真的调了重建；**两个调用点都按 `kind` 分流到 in_review**；旧 boolean 契约不许还在 |

第 ④ 层是刻意的：底层对而没接上，与底层错是同一个结果（`reject-path` 那一批的教训）。

## 5. 验证

```
# 判据（新）
node --experimental-strip-types --test plugins/tests/artifact-delivery.test.mjs   → 15/15 pass

# 编译
node scripts/ci/build-external-package.mjs plugins                                → exit 0

# 回归（对着基线跑，不是拍脑袋）
基线（stash 掉本次改动后重建 lib）：tests 512 / pass 482 / fail 30
本次改动：                          tests 527 / pass 498 / fail 29
  ⇒ 新增 15 例全过，**零回归**；那 29~30 个失败是环境性的
    （要真起 worker 子进程，本沙箱里起不来），基线上同样失败、数量随环境波动。
```

## 6. 现场处置（2026-10-14，主工作区）

- 在**主工作区**重建了 `workbench/dist`（13:48:32），线上 `assets/index-BA2TSihL.js`
  实测含 `general:"human:s11" … "soldier-market":"human:s15"`；
- 把接口响应喂给客户端 `resolveSlot` 逐项解析：**12/12 唯一真人形、0 回落占位**；
- 头像相关套件（`external-avatar-parity` / `agent-avatar-surfaces` / `agent-avatar-settings` /
  `avatar-photo` / `team-views-routes`）**52/52 通过**。

**遗留**：`s11..s15` 在照片资产表里**没有照片**（照片只覆盖 11 个内置岗位 + `s01..s09`，
原图也只有 20 张且已全部占满）⇒ 这 4 个外部执行者走**矢量人形**，与其余 8 个的**写实照片**
风格不一致。将军已决定自行提供 5 张图，按 `avatar-photo` 流程入库给 `s11..s15`（另行处理）。
