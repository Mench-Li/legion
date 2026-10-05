# BUG-010｜异常拦截停在 `in_review` 之后**没有接回流水线的指引**——下游环被静默跳过

> 发现于 2026-10-05，起点是将军的一句质疑：**「啥时候代码需要我人来验收了？不是有专门的 Agent 进行 review 验收嘛」**。
> 那一问是对的：T-178 本该自动流转到 reviewer，它停住只是因为文件域闸门（且那是 BUG-008 的误报）。

## 0. 先把"谁验收"这件事说准

设计在 `plugins/src/index.ts` 的文件头，逐字：

```
 *  流水线中间阶段自动合入并推进 done；流水线最终阶段自动合入并收官 done
 *    （部署不需将军验收，2026-09-08 T-126 现场裁决：将军已授权整条流水线）；
 *  人工闸门岗（gate，如 requirement/researcher）与人工派活的非流水线单角色任务 → 停 in_review 等将军。
 * done 的两种入口：将军拖拽验收（gate/单角色/异常在 in_review 的任务），或守护自动收官。
```

software 流水线的 8 环与闸门标记（实测 `GET /api/pipeline?scope=software`）：

| 环 | requirement | researcher | breaker | test-designer | coder | reviewer | tester | devops |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gate` | **true** | **true** | false | false | false | false | false | false |

派下一环的动作是 `handoff.advancePipeline()`，注释称它是「**阶段 → 阶段」的唯一出口**」。
它**真的在跑**，历史留痕：`T-050 coder → T-057 reviewer`、`T-060 reviewer → T-065 tester`、
`T-062 tester → T-067 devops`（这些任务的 `goalId` 都是空 —— 即人工派活也一样自动接）。

**所以"人工派活的非流水线单角色任务"指的是角色不在流水线上的那些**（role=null 之类），
不是"人工派的 coder/tester 任务"。T-178 是 coder、`stage.next=reviewer` ⇒ 本该自动合入 + 自动派 reviewer。

## 1. 缺陷

域拦截那条路（`index.ts` 的域闸门分支）做完 `transitionTo(t.id, 'in_review')` 就 **`return`** ——
它绕过了下面的 `advanceTo` + `advancePipeline`。而事后补救的"**4. 流水线 done 补流转**"扫单：

```ts
// 4. 流水线 done 补流转：将军人工合入/验收后手动 done 的中间阶段任务 → 创建下一角色任务（幂等：已有后继则跳过）
for (const t of tasks.filter(x => x.status === 'done' && stageOf(x) !== undefined)) await handoff.advancePipeline(t)
```

**只处理 `status === 'done'` 的任务。** 于是完整的坏路径是：

1. 闸门把任务停在 `in_review`，评论说「手动合入 `w/<id>`」或「丢弃」；
2. 人照做——**合入 main**；
3. 任务仍在 `in_review` ⇒ 补流转扫单看不到它 ⇒ **下一环（reviewer/tester）永远不会被派**；
4. 没有任何读数会说话：链看起来"走完了"，任务的评论说"改动保留在分支"（而其实已经合入了）。

实测（2026-10-05）：**T-178 的代码进了 main，但代码审查那一环被静默跳过**，
而它本来会像 T-050→T-057 那样自动接上 reviewer。

> ★ 这条缺陷的形状是「**指令漏了最后一步**」：闸门本身设计正确（要人裁决），
> 但它教人的操作**不完整**，而缺失的那一步恰好是整条链能不能继续的唯一开关。
> 一个漏了一步的操作说明，与一个没写的功能，在"人会怎么做"这件事上是同一个东西。

## 2. 修法

### 2.1 把恢复路径写全（`index.ts` 的闸门评论）

评论改为显式的两步，并写明为什么第二步不能省：

```
⛔ 文件域越界（合入被机器闸门拦截）：…
请将军裁决：
· **可接受** → 在评论里说明后手动合入（git -C <root> merge --no-ff w/<id>），
  **然后把本任务推进到 done**（界面「✓ 验收通过」；或 POST /api/transition {id:"<id>",to:"done"}）。
  ★ 这一步不能省：本任务停在这个状态时不会自动流转，**只有推进 done 之后，
    守护的「流水线 done 补流转」才会派出下一环（reviewer）**；漏掉它 = 下游被静默跳过。
· **不可接受** → worktree remove --force <dir> && git branch -D w/<id> 丢弃后重新派工。
```

`activity('domain-block', …)` 与 `log(…)` 也各补一句「下游 X 环暂停，待将军裁决并推进 done」——
让审计与日志都能看出"这条是被拦下的、链还没走完"。

### 2.2 给停摆一个**可见读数**（既有扫单之后，只读、不改状态）

新增（紧挨着"4. 补流转"那段）：

```ts
for (const t of tasks.filter(x => x.status === 'in_review' && stageOf(x) !== undefined)) {
  const sigStage = stageOf(t)
  if (!sigStage || sigStage.next == null || sigStage.gate === true) continue   // 闸门岗合法停在这里
  const anc = await runGit(workspace.repoRootFor(), ['merge-base', '--is-ancestor', `w/${t.id}`, 'HEAD'])
  if (anc.code === 0) log(`${t.id} ⚠ 停在 in_review 但分支 w/${t.id} 已并入 HEAD —— 下游「${sigStage.next}」环不会被派（补流转扫单只看 done）。请推进 done：…`)
}
```

判据是**五项**的与：**停在 `in_review`** + **角色有下一环** + **不是人工闸门岗**
+ **分支自己确实改过东西** + **分支已并入 HEAD**。
倒数第二项是关键：正常流转的任务分支会被 `autoPromote` 删掉（`branch -D w/<id>`），
所以这个组合只会在"已合入、却没推进 done"时成立。

### 2.3 上线后的订正：零改动的分支不许报停摆（T-179）

首版只有四项（缺"分支自己改过东西"）。**上线后第一轮就误报了**，实测日志：

```
T-179 ⚠ 停在 in_review 但分支 w/T-179 已并入 HEAD —— 下游「devops」环不会被派…
```

这是**空洞命中**。为什么必然发生：`git merge-base --is-ancestor` 问的是"HEAD 是否包含该提交"——
而 `w/T-179` **一个提交都没有**（HEAD 就是它自己的基线）⇒ 它天然是自己的祖先 ⇒ ancestor 恒真：

```bash
$ git diff --name-only main...w/T-179      # → 0 个文件
$ git log --oneline main...w/T-179         # → 无提交
$ git merge-base --is-ancestor w/T-179 HEAD; echo $?   # → 0（真）
```

于是**每一个"零改动的判定型任务"**（分析、调研、结论 —— 产出是评论而不是文件）都会每轮报一次假停摆，
而"推进 done"对它不会派出任何真活。忘掉这条的代价不是漏报，是**噪音淹没真信号**：
真停摆和假停摆长得一模一样。

订正就是把 BUG-008 的 `changedFilesOfBranch`（**三点** refspec，理由见 `./branchScope.ts`）
拿来当这个前置闸门，并放在 `--is-ancestor` **之前**（零改动分支连那次 git 调用都不必付）：

```ts
const own = await changedFilesOfBranch(t)
if (own.length === 0) continue
const anc = await runGit(workspace.repoRootFor(), ['merge-base', '--is-ancestor', `w/${t.id}`, 'HEAD'])
```

> 这条订正是"**先上线、再看读数**"抓出来的，不是设计时想出来的 —— 首版写的时候
> ancestor 看起来"只会在已合入时成立"，而 T-179 这个 0 提交的分支证明它还有第二种成立方式。
> 这与 BUG-009-a 同形（探测器问错了问题）：判据的**失败方向**比判据本身更容易想漏。

**这一段刻意只读**：它报告问题，不替人决定。替人推进 done 会把"等人工裁决"变成"自动放行" ——
那正是闸门存在的理由。

## 3. 判据

```bash
node --test plugins/tests/pipeline-resume-guidance.test.mjs   # 5 例（源码判据）
```

| 用例 | 断言 |
| --- | --- |
| ① | 闸门**评论本身**（切到紧随其后的 `transitionTo` 为止）必须含「推进 done」与"为什么" |
| ② | 必须存在"停在 in_review 但分支已并入 HEAD"的判定与根因文案（`补流转扫单只看 done`） |
| ③ | 必须排除 `sigStage.gate === true` 与 `next == null`（否则给闸门岗每轮报假警告） |
| ④ | 那段读数必须**只读**：块内不许出现 `transitionTo(` / `advancePipeline(` |
| ⑤ | 必须有 `own.length === 0` 的前置闸门，且在 `--is-ancestor` **之前**（T-179 现场） |

**反向验证**（全部实测变红）：
① 去掉评论里所有"推进 done"指引；② 删掉根因文案；③ 不排除闸门岗；④ 在读数里顺手加一次 `transitionTo`；
⑤ 删掉 `if (own.length === 0) continue`，或把它挪到 `--is-ancestor` 之后。还原即 5/5 绿。

> 用例 ⑤ 的两次变异是分开做的（删闸门 / 挪顺序），因为它们是**两种不同的错**：
> 删掉是"假停摆照报"，挪后是"多付一次 git 而假停摆仍报"。一个断言只钉住其中一个就不够。

### 3.1 两处自我订正（都发生在写这条记录的过程中）

1. **我先前断言"没有任何扫单会给已 done 但缺后继的任务补派"是错的。** 扫单在 `index.ts:3666`，
   而且**每轮都在跑** —— 日志里满屏的「流水线流转跳过：目标 G-… 已 done」就是它。
   真实缺陷比我说的小得多，也精确得多：**不是缺扫单，是缺"推 done"那一步的指引**。
2. **用例 ① 的第一版太弱**：它从评论处切固定 2000 字符，把评论**之后**的 `log(...)` 行也框了进来，
   而那行同样含"推进 done" ⇒ 把评论里的指引全删掉，用例照样绿。改成切到紧随其后的
   `await transitionTo(...)` 为止，边界与断言的东西对齐后，变异才测得出来。
   （一个"切片范围比断言对象大"的源码判据，会把缺陷放过 —— 与 BUG-009 的假绿同形。）
3. **停摆判据的第一版有四条、只有四条**（§2.3）。它在宿主重启后的**第一轮就误报 T-179**——
   一个 0 提交的分支天然是 HEAD 的祖先。这条错在设计时不可见，只在读数里可见。

## 4. 边界

- **要宿主重启才生效**：闸门评论与停摆读数都在宿主内的 `plugins/lib` 里。
- **没有做**：不替人自动推进 done（理由见 §2.2）；不解析评论里的"可接受"来自动合入
  （那会把一次人工裁决变成一次字符串匹配）。
- **本条与 BUG-008 的关系**：BUG-008 修的是"闸门误报"，本条修的是"误报/真报之后人怎么把链接回去"。
  两条合起来才让 T-178 这类情形不再需要人：误报不再发生；万一真报，指引也完整。
