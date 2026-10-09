# BUG-013｜`main` 与 `origin/main` 分叉 5 / 159 —— 而那 5 个提交是远程已有提交的**逐字副本**

> 发现于 2026-10-09，起点是将军的一句问话：**「领先的 5 个提交是什么，落后的直接从远程仓库同步」**。
> 结论比问题简单：那 5 个的**独有内容是零** —— 同一份文档在两条线上各写了一遍。
> 顺带在远程那条线上量到第二处真实缺陷（`check-docs` 自带 3 处失败），一并修掉。

## 0. 现场（全部是读数，不是推断）

```
$ git rev-list --left-right --count origin/main...HEAD
159     5
$ git merge-base HEAD origin/main
d99083e1 fix(portal): 发了一份新版本，首页还在发旧版 —— 而且**没有一个地方会报错**   (2026-10-07 14:41)
$ git log -1 --format='%h %ci %s'
508a5892 2026-10-07 16:35:37 +0800 docs(release): `canRead` **留档不实施** …
$ git log -1 --format='%h %ci %s' origin/main
1f92227c 2026-10-09 12:54:27 +0800 feat(site): 收起产品演示、数字人换真实 3D 场景…
```

本地那 5 个提交**没有被推到任何远程分支**（`git branch -r --contains 508a5892` 为空），
而远程那条线已经往前走了 159 个提交（site / portal / desktop / 手机端等别的工作流）。

## 1. 那 5 个提交是什么

全部是 `docs(release)`，全部只改**同一个文件**：`docs/release/legion-desktop-executor-gap.md`（15106 B）。
内容是一份调查记录 —— 从"量出 `no-executor` 的拒绝码"到"`canRead` 的三个候选"到"留档不实施"，
5 步渐进编辑。**没有一个提交碰代码。**

| 提交 | 时间 | 摘要 |
| --- | --- | --- |
| `b9b28fe8` | 15:49:30 | 先把是哪个拒绝码量出来，再谈修 |
| `9b8dcafe` | 15:56:34 | 根因量出来了：是 `canRead` 没人给 |
| `1474dbc7` | 16:05:02 | `canRead` 的三个候选 |
| `6c94d2ef` | 16:24:07 | 两条执行路径 |
| `508a5892` | 16:35:37 | 留档不实施 |

## 2. 定性：**它们是远程已有提交的逐字副本**

远程那条线上有**另外 5 个提交，提交信息逐字相同**：

| 本地 | 远程孪生 | 远程时间 | 时间差 |
| --- | --- | --- | --- |
| `b9b28fe8` | `1771578a` | 15:50:33 | +63 s |
| `9b8dcafe` | `e4bfdcfa` | 15:56:53 | +19 s |
| `1474dbc7` | `314af606` | 16:05:33 | +31 s |
| `6c94d2ef` | `4e5531b3` | 16:24:37 | +30 s |
| `508a5892` | `344a84f9` | 16:36:09 | +32 s |

三重证明（每一条都独立成立）：

```bash
# ① 补丁逐字节等价：五对 patch-id 全部相同
$ git show 508a5892 | git patch-id --stable
$ git show 344a84f9 | git patch-id --stable          # 同一个 id

# ② 最终文件内容相同（blob 同一）
$ git rev-parse HEAD:docs/release/legion-desktop-executor-gap.md
8114d65264a5daaa5f08f892645ab4c9678816b4
$ git rev-parse origin/main:docs/release/legion-desktop-executor-gap.md
8114d65264a5daaa5f08f892645ab4c9678816b4

# ③ 两侧对该文件没有差异
$ git diff --stat HEAD origin/main -- docs/release/legion-desktop-executor-gap.md
（空）
```

⇒ **本地这 5 个提交的独有内容是零。** 所以"该保留哪一版"这个问题**不存在**：
远程那版就是同一份东西，而且晚了 20–60 秒 —— 是后写的一版。

## 3. 缺陷的形状（本条真正值得记的东西）

**「落后 N 个提交」这个读数，不区分下面两件事：**

| 形态 | 含义 | 正确处置 |
| --- | --- | --- |
| 我们有**别的东西** | 真分歧：两侧各自有对方没有的工作 | 需要人判断怎么合（可能要合并、可能要放弃一边） |
| 我们有**副本** | 同一份内容在两侧各写了一遍 | 直接对齐远程即可，**零内容损失** |

而 `git status` 给出的那句 `Your branch and 'origin/main' have diverged, and have 5 and 159 different commits each`
**对这两种形态是同一句话**。这一次是副本，所以按第二种处置；
但如果当时按第一种处置（做一次合并），历史里就会多出 5 个内容重复的提交 —— 而**永远不会有人发现它们重复**，
因为它们的提交信息不同（hash 不同、时间不同），只有 patch-id 说得清。

    > 一个"我有 5 个提交而远程没有"的读数，
    > 与一个"远程早就有了这 5 个改动"的事实，在 `git status` 里是同一句话 ——
    > 只不过前者的正确处置是合并，后者是丢弃，而丢弃看起来像"我丢了工作"。
    > **判据是 patch-id，不是提交数量。**

### 3.1 副本是怎么产生的（只报读数，不指控）

同一文件、同一作者、两条线、5 对提交、时间差 19–63 秒。最可能的成因是**同一次会话在两条线上各提交了一遍**
（例如先在某个工作区提交、随后又在另一处重做了一遍，或一次 rebase/cherry-pick 产生了新 hash）。
本条**不声称**具体成因 —— 审计表里没有"为什么"，只有"做了什么"，而这个区别是与 BUG-011 §1.4 同一条纪律。

## 4. 处置（已实施）：直接对齐远程

```bash
git fetch origin
git reset --hard origin/main      # 见 §4.1：这一步会覆盖已跟踪文件的本地改动，必须先保全
```

结果：`HEAD == origin/main == 1f92227c`，`git rev-list --left-right --count origin/main...HEAD` = `0 0`
—— **没有任何需要推送的东西**。这是因为那 5 个是副本，deviation 本来就不该到达远程；对齐之后本地与远程完全相同。

`fix/bugs` 工作区原本也坐在那 5 个副本上（`508a5892`），同样对齐到了 `1f92227c`。

### 4.1 ★ 在主工作区做 `reset --hard` 的安全前提（本次逐条做到）

主工作区当时有**另外两个工作流未提交的改动**：

```
 M docs/SINGLE-ENTRY-BOOT.md
 M services-plugin/index.js
```

而 `docs/SINGLE-ENTRY-BOOT.md` 正是 `LEGION.md` 里记着的、**上一次被误回退过**的那个文件
（"另一次清理文档 banner 时用了宽路径回退，把另一个会话未提交的一处文档改动一起回退掉了"）。
所以这次不是"小心一点"，而是**先证明再动手**：

| 步 | 动作 | 证据 |
| --- | --- | --- |
| ① | 确认这两个文件**不在**同步的改动集里 | `git diff --name-only HEAD origin/main` 的 118 个文件里没有它们 ⇒ `reset` 不会与它们的改动冲突，还原后也必然一致 |
| ② | 备份这两个文件，核对 SHA256 | 备份一致 = True（两个都） |
| ③ | 记录工作区 diff 指纹 | `git diff -- <两个文件> \| git patch-id --stable` → `de1ffe49898b92c1…` |
| ④ | `git reset --hard origin/main` | — |
| ⑤ | 原样还原，**再核对同一个指纹** | 还原后 patch-id 仍是 `de1ffe49898b92c1…` ⇒ 逐字节一致 |
| ⑥ | 事后核对影响面 | `git diff --name-only origin/main` **只有那两个文件**；未跟踪文件一个没少（`reset --hard` 不碰未跟踪） |

    > `reset --hard` 与 `git clean` 的区别，
    > 与"我只回退了已跟踪的文件"和"我把别人的改动删了"之间的区别，是同一条界线 ——
    > 而这条界线只有**事后核对**才看得见。

**一条容易误读的读数**：未跟踪文件数在同步前后从 25 变成 24。追下去是
`docs/superpowers/plans/2026-10-04-update-host-bootstrap.md` 在同步后**变成已跟踪**了
（远程自己的提交 `1bca9e2b` 把它收了进来），文件一直在盘上。**不是丢了，是被人收编了。**

### 4.2 运行中的服务不受影响

`plugins/lib/`、`workbench/dist/` 都是 gitignore 的，`team-hub/team.db` 不被跟踪
⇒ `reset --hard` 动不到宿主正在用的东西（已核对：`plugins/lib/index.js` 的 mtime 未变）。

## 5. 顺带量到的第二处缺陷（已修）：远程那条线自带 doc 红灯

对齐远程之后跑门禁，**`check-docs` 是红的 —— 而且不是我引入的**：

| 门禁 | 结果 |
| --- | --- |
| ci-syntax | PASS（248 个脚本） |
| config scan --check | PASS（1590 个疑似字面量） |
| config check | PASS（error 0，warning 1） |
| encoding-check | PASS（2754 个文件） |
| doc-table-integrity | PASS 10/10 |
| **check-docs** | **FAIL（3 处）** |

```
docs/T006-evidence/README.md   缺历史 banner   ← 远程 aae4542a
docs/T191-evidence             目录无 md       ← 远程 2442b786
docs/T192-evidence             目录无 md       ← 远程 0235040c
```

**归因是干净的**：我相对 `origin/main` 的全部差异只有那两个未提交文件，与这三个路径不相干。
所以这 3 处是远程自己的提交留下的 —— T-191/T-192 两个测试任务**只提交了 `.mjs` 探针，没提交证据 README**，
而 `check-docs` 要求每个证据快照目录都有 banner 载体（README）。
`run-ci` 的 doc 阶段因此会判红。

**修法用的是仓库自带脚本**（纯新增，不编造证据）：

```bash
node scripts/ci/evidence-banner.mjs
#   已处理 新增标注=1 新建 README=2 已存在=76
#   + README.md  docs/T191-evidence
#   + README.md  docs/T192-evidence
#   ~ banner     docs/T006-evidence/README.md
node scripts/ci/evidence-banner.mjs --check
#   PASS（79 个证据快照目录的文档均已历史标注）
```

两个新建的 README 只有 banner + 一句"本目录为遗留证据目录，当前无文档"——
**没有替 T-191/T-192 补写任何证据**（那是它们自己的产物，不属于本条）。

    > banner 记录的是**基线提交与日期**（`2442b786` / 2026-10-06），
    > 而不是"这个目录里有什么结论" —— 前者机器可核对，后者只能编。
    > 一个脚本会替你写的东西与一个脚本会替你**编**的东西，差别就在这里。

## 6. 判据

| 判据 | 结果 |
| --- | --- |
| `git rev-list --left-right --count origin/main...HEAD` | `0 0` |
| `git diff --name-only origin/main` | 只有那两个未提交文件（别人在工作） |
| 那两个文件的 diff patch-id（同步前 vs 同步后） | 相同（`de1ffe49898b92c1…`） |
| `evidence-banner.mjs --check` | PASS（79/79） |
| `check-docs.mjs` | PASS（11 类校验项全绿） |
| `encoding-check.mjs` | PASS |
| `doc-table-integrity.test.mjs` | 10/10 |

**反向验证**：修复前 `--check` 报 `FAIL（3 个目录缺 banner / 已覆盖 76）`、`check-docs` 报 3 处具体路径；
修复后两者都 PASS。同一套命令、同一个仓库，前后两个读数都在本文里。

## 7. 边界

- **本条不改那 5 个副本的内容**：它们与远程逐字相同，改动等于重写别人的文档。
- **本条不推那 5 个副本**：对齐之后它们是"从未存在过"的本地历史，仍可在 `git reflog` 里找到
  （`508a5892` 是 reset 前的 `HEAD@{1}`）。
- **本条不动 `w/T-195` 工作区**：它停在 `508a5892`（那 5 个副本的顶点），有自己的未提交改动
  （`scripts/e2e/cdp.mjs`）——那是另一个任务的活。**只是它的基线因此少了一层**：
  由于那 5 个是副本，它基于哪条线在内容上没有差别。
- **本条不判定副本的成因**（见 §3.1）。
- **留在桌上的问题**：`w/T-195` 与 `w/T-173`/`w/T-174` 这些任务工作区各自停在不同提交上，
  而"从哪条线开工作区"这件事今天没有判据 —— 本条只记下这次的实际后果（零影响，因为副本），
  **不声称**下一次也会零影响（如果那时两侧内容真的不同，就是一次真分歧）。
