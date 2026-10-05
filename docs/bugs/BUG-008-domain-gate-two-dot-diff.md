# BUG-008｜文件域闸门用两点 diff，把"主分支的新增"算成"切片越域"——合规交付被误拦

> 发现于 2026-10-05 排查 T-178/T-179「一直在工作中但 main 里没动」。
> **已修复**：闸门改为三点 diff（`main...w/<id>`）。修复点在 `plugins/src/index.ts` 的
> `changedFilesOfBranch()`，判定逻辑抽到 `plugins/src/branchScope.ts` 以便单测。

## 1. 现象

T-178 / T-179 的 worker 都跑完了并把任务推进到 `in_review`，但**合入 main 被机器闸门拦下**：

```
⛔ 文件域越界（合入被机器闸门拦截）：以下改动超出本切片声明文件域
   【workbench/, security/, orchestrator/, team-hub/, runtime/】
   → docs/bugs/BUG-006-contention-path-divergence.md, docs/bugs/BUG-006-live-ab.mjs
   改动保留在分支 w/T-178，未合入主分支。请将军裁决…
```

而这两条任务的实际改动**完全在各自声明的域内**：

| 切片 | 自己的提交 | 自己改的文件 | 闸门报出的越域文件 |
| --- | --- | --- | --- |
| `w/T-178` | `6bcbcc7e` | **11 个，全在域内** | 2 个 —— `docs/bugs/BUG-006-*.md`、`BUG-006-live-ab.mjs` |
| `w/T-179` | **0 个**（HEAD 就是自己的基线 `d2957edf`） | **0 个** | **14 个** —— 全是 main 新增的 |

## 2. 根因：两点 diff

`plugins/src/index.ts` 原来的实现：

```js
const diff = await runGit(root, ['diff', '--name-only', headRef, `w/${t.id}`])
//                                                  ^^^^^^^^^^^^^^^^^^^^ 两点 = A..B
```

- `A..B`（两点）= **两棵树当前的差异**。主分支在切片飞行期间新增/修改的文件，会出现在这个清单里。
- `A...B`（三点）= `merge-base(A,B)..B`，即**只算 B 自己**从共同祖先之后的改动。

所以闸门把「别人在 main 上新加的文件」当成了「这条切片改的域外文件」。

**为什么这个错误方向特别坏**：它**随主分支的活动量增加而更容易触发** ——
越多人正常往 main 合东西，越容易被误判。而拦截的代价是整条交付停在 `in_review` 等人工，
且**症状与原因距离很远**（一个字符串里少一个点，表现为"任务跑完了但什么都没落地"）。

**我造成的那部分**：排查期间我把 BUG-006 的证据合进了 main（`e31ce007`、`9380e0fe`），
恰好落在 T-178/T-179 的飞行窗口里，于是成了那"多出来的 2 个 / 14 个"。
正确做法是三点法 —— 见 §4。

## 3. 判据

```bash
node --experimental-strip-types --test plugins/tests/branch-scope.test.mjs   # 4 例
```

一层钉 refspec 形状，一层用**真实 git 仓库**复现两种语义：

| 用例 | 断言 |
| --- | --- |
| ① refspec 形状 | 必须是 `main...w/<id>`；两点形态不许出现 |
| ② 主分支飞行期间新增文件 | 三点法**只**给出切片自己的文件；显式断言别人合进 main 的那个文件**不在**清单里（并先断言两点法确实会把它算进来 —— 证明这个用例真能复现缺陷） |
| ③ 真实越域仍抓得到 | 切片自己改了域外文件时，三点法**仍然**把那个文件列出来 |
| ④ 0 提交的切片 | 清单**为空**，不是"主分支的全部新增" |

**反向验证**：把 refspec 改回两点 ⇒ **4/4 变红**；还原即 4/4 绿。

**真实场景复核**（修复后在主检出上直接验）：

```
$ git diff --name-only "main...w/T-178"      # 11 个，全在域内
$ git diff --name-only "main..w/T-178"       # 13 个 —— 多出 docs/bugs/BUG-006-*.md（正是误报来源）
```

## 4. 修法

新增 `plugins/src/branchScope.ts`：

```ts
export function branchOwnChangesRefspec(mainRef: string, branch: string): string {
  return `${mainRef}...${branch}`   // 三点：只算分支自己的改动
}
```

`index.ts` 改为 `runGit(root, ['diff', '--name-only', branchOwnChangesRefspec(headRef, \`w/${t.id}\`)])`。

把它抽成纯函数而不是内联写死，是因为**这个判定的全部内容就是"两个点还是三个点"**，
而错了的症状出现在很远的地方（交付停在 in_review）。抽出来之后测试可以直接钉住它，
并配真实 git 的行为用例 —— 与 BUG-007 把结算决策抽成 `timeoutSettlement.ts` 同一手法。

**没有放宽任何判据**：真实越域（切片自己改了域外文件）三点法一样抓得到（用例 ③ 钉着）。

## 5. 边界

- **本修复要宿主重启才生效**：闸门运行在宿主内的守护插件里（`plugins/lib`）。
  在它生效之前，被误拦的切片可以用 §6 的机械办法放行（那与判据无关，只是让两点 diff 变干净）。
- **没有改闸门的域匹配规则**（`outsideDomainFiles` 的前缀匹配、`SHARED_WRITE_PREFIXES`）：
  本次只修"看哪些文件"，不动"哪些文件算允许"。
- **暴露出的另一个独立问题**（不属于本 Bug，另案）：`w/T-179` 声明的文件域是 `scratch/`，
  而 `scratch/` 在 `.gitignore` 里 —— **一个声明域是 gitignored 目录的切片，产出永远交付不了**。
  这属于任务配置/派工面的问题，需要单独处置。

## 6. 修复生效前，被误拦的切片怎么放行（机械办法）

判据修好要等宿主重启；在那之前，**让两点 diff 变干净**即可绕过误报 —— 与判据无关：

```bash
# 把主分支合进切片分支 → 两点 diff 里不再出现"主分支新增的文件"
git -C <repoRoot> merge --no-ff main w/T-178      # 或在该切片的 worktree 里 merge main
# 之后闸门再看 w/T-178，只会看到它自己那 11 个域内文件
git -C <repoRoot> diff --name-only main w/T-178   # 应当只剩切片自己的改动
```

注意两点：

- 这是**绕过判据**，不是修判据。修判据的那一半（三点 diff）必须一起做，否则下次别的主分支活动
  会把另一个切片再拦一次 —— 而且**越正常干活越容易被拦**。
- 对**0 提交**的切片（如 `w/T-179`）这个办法什么都不解决：它没有可交付的改动，
  两点 diff 里那 14 个文件全是主分支的。它需要的是"重派并把产出写到被跟踪的路径"。
