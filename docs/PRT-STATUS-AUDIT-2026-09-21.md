# 七条台账行的独立复核（2026-09-21）

> **这份文件只做一件事**：把一份递过来的状态表（7 条）逐句拿去和仓库对，
> 看那几句话**今天还成不成立**。第 9 节记的是复核之后**按要紧程度做的修复**。

- **复核基线**：`HEAD` 在复核期间被**另一个会话**推进过（`5ae4268` 2026-09-21 11:33 → `5cd44ab` 15:00）。
  凡是随 `HEAD` 移动的量（`hot-file-churn` 的窗口），下面一律标注**读数时刻**，不写成结论。
- **复核时刻**：2026-09-21
- **权威台账**：`docs/superpowers/prt/PRT-PROGRESS.md`（该文件自称"PRT 实施到哪一步"的唯一入口）
- **状态口径**（台账 `:8-15`）：✅ 已完成 · 🟡 部分 · ⬜ 未开始 · ⏸ 需外部输入（代码侧无法单独关闭）

---

## 0. 结论

| 条目 | 递过来的状态 | 台账实测 | 复核判定 |
| --- | --- | --- | --- |
| PRT-214 | 🟡 | **✅**（`:68`，`2967119` 前的 🟡→✅ 见行内、`98554a0` 接线） | **目标那句话已不成立**（`run-floor-permissions-missing` 不再是每次 Run 都发生） |
| PRT-509 | 🟡 + 三个残留 | **✅**（`:163`，业主裁定） | **三个残留逐一已关**：②有生产默认调用点、③有真 DSH 进程读数、①是已裁定的平台边界 |
| PRT-253 | ⏸「需真实额度；你已决定不花」 | **⏸**（`:77`） | 状态对，**阻塞事实过期**：额度已花掉且已验，剩下的是平台 |
| PRT-009 | 🟡（peak-resource 等 PRT-011） | **⏸**（`:33`） | 状态口径不同；**"取决于 PRT-011"是过期前置**（该裁决 2026-09-11 就做完了） |
| PRT-256 | ⏸ 需真实外部用户 | **⏸**（`:80`） | ✅ 一致 |
| PRT-910 | ⏸ 需真实用户项目 | **⏸**（`:241`） | ✅ 一致 |
| PRT-316 | ⬜ 排期阻塞，还差 8 天，hot-file-churn 报"可安排开工" | **✅**（`:131`，`2967119` 本项 🟡→✅） | **三处都不成立**：状态、天数、闸门读数 |

一句话：**7 条里有 4 条的阻塞事实在 HEAD 上已经过期，且其中两条是偏保守方向的过期**
（*一个"缺口还在"的批评，与一个"接线早断了、每次 Run 都当场停下"的读数，
在只读旧证据的时候是同一个东西*）。

---

## 1. PRT-214：被否掉的是"没有生产来源 ⇒ 每次 Run 都停下"

递过来的那句是「`RunRequest.permissions` 全产品没有任何生产来源（`claim()` 只回 8 个键），
于是**每一次** Run 都在派发前以 `run-floor-permissions-missing` 停下」。

### 1.1 端到端（本机复跑，exit=0）

```
node --test team-hub/run-plane-e2e.test.mjs          → 20 pass / 0 fail
  ✔ ⑧ ★★★★★ 清单行 → `claim()`：租约**真的带上了**这次 Run 的权限档位
  ✔ ⑧ ★★★★★ 端到端：清单里的 `git-push` 一路变成 guard **真的拒掉**的 `bash`/`pwsh`
  ✔ ⑧ ★★★★  没有清单的岗位：租约上**没有**权限字段，而且它 ≠ "什么都不能干"
  ✔ ⑧ ★★★★  认不出来的 `approvalPolicy`：具名拒绝，**不猜**是哪个档位
  ✔ ⑧ ★★★   策略**缺省** → 有人值守（更严的那个），不是无人值守
```

### 1.2 静态接线（两处，都在 HEAD）

- 控制面：`team-hub/server.mjs:494` 生产注入 `resolveRunPermissions`
  （读 `tasks.role` → `contextPlanStore().readEmployeeManifest({scope, role})`）。
- 执行面：`orchestrator/worker/executor.mjs:1084`
  `permissions: lease.permissions ?? permissionsFromLease(lease) ?? UNSUPPLIED_PERMISSIONS`。

### 1.3 "只回 8 个键"是**分叉的一边**，不是全局事实

`orchestrator/worker/can-read-authorization-source.test.mjs:76-78` 的 `CLAIMED_LEASE_KEYS`
**恰好 8 个键**；该文件 ①②③④ 刻意跑**没接线**的 store——它证明的是
"档位**不会自己长出来**"，这正是"为什么必须显式接线"的证据；同文件 ⑤ 跑接了线的那个，
结论恰好相反。两半都必须留着。

### 1.4 这条订正**早已经落地**，不是本复核新发现

| 提交 | 日期 | 做了什么 |
| --- | --- | --- |
| `98554a0` | 2026-09-16 | 权限档位在 `claim()` 那一刻有了生产来源 |
| `ee4af6a` | 2026-09-18 | 订正两处**偏保守方向**的过期读数（`claim() 只回 8 个键 ⇒ 每一个 Run 都停下`） |

`ee4af6a` 自己的理由与本复核同形：*一个偏保守方向的过期读数比一个偏乐观的更难被发现，
因为它读起来像有人在谨慎。*

### 1.5 真正的残留（**不是**递过来那条）

- `deniedTools` 上了租约、**消费点仍留空**（`98554a0` 自述："可观测、不放大冲击面"，
  并明说外推到政策禁令需要**裁决**而不是顺手接线）——这一点台账行内展开过。
- 按 Run 安装 hard floor 的那条缝目前仍在**未提交的工作树**里
  （`runtime/dsh-composition/plugins/runtime-host-row*.mjs` 为 `M`）。

---

## 2. PRT-509：三个残留逐条对上

递过来的三个残留：① win32 `0600` 不可证；② 生产默认句柄工厂只有注入式覆盖；
③ 这条证明的是"提供方读得到"而非"一个真 DSH 进程启动时解析了它"。

| 残留 | 实测读数 | 出处 |
| --- | --- | --- |
| ② 生产默认句柄工厂 | **有生产默认调用点**：`product/launcher/run-credential-materialization.mjs:288` 定义 `resolveDshBaseBundlePatchPath({runtimeCommand, requireFn})`，`:527` 是本模块的生产调用 | 源码 |
| ③ 真 DSH 进程解析 | **本机复跑通过**：`node --test product/launcher/run-credential-dsh-process.test.mjs` → 1 pass / 0 fail，读数 `宿主进程耗时 8.0s（收场 natural，退出码 0，预算 240s）` | 实测 |
| ① win32 `0600` | 台账/`docs/STATUS.md` 记为**永久平台边界**（业主裁定），与 `sandbox-enforcement=partial` 同类 ⇒ 不是交付缺口 | `docs/STATUS.md:13277` 附近 |

台账行 `:163` 已被业主裁定为 **✅**，口径是"②③ 各自有具名关闭物与破验、① 是已裁定的边界"。

---

## 3. PRT-253：状态对，**阻塞事实换了**

递过来的是「需真实模型额度；你已决定不花」。台账行尾（`:77`）写的是：

- 额度**已经花掉**，而且花在**能证伪**的地方：`dsh --profile headless "… PONG"`
  → `exit=0`、9.2s、输出 `PONG`；判据是那把密钥**只可能**来自 `$DSH_HOME/.credentials.yaml`
  （该 provider 的键名 `CUSTOM_DS_API_KEY` 在 Process / User / Machine 三个作用域全空）。
- 于是「额度已不再是阻塞，剩下的是平台」：`docs/STATUS.md` §4 第 15 条
  （Windows 上不会有自动执行）。
- 本行状态 **🟡 → ⏸** 的依据**不是**新读数，而是它和 PRT-009 卡在**同一句**台账原话上。

⚠️ 覆盖面边界（台账自己保留的）：真额度那一次量到的是**凭证解析 → 真实模型回答**，
**不是** Legion 全链路（worker → Runtime 契约 → DSH → 模型）。

---

## 4. PRT-009：**"取决于 PRT-011 裁决"是一句过期前置**

- **PRT-011 早在 2026-09-11 就裁决为路线 C**
  （`docs/superpowers/prt/PRT-011-dsh-distribution-decision.md:4`）⇒ 那句前置条件**不复存在**。
  `docs/PRT-009-evidence/verify-evidence.md:191` **自己就写着**"原句…**已过期**"。
  *一个已经解除的前置条件留在阻塞理由里，会让这一项看起来在等一个早已不存在的决定。*
- **费用 ✅ 有出处**：`$0.045086 USD` 由 `scripts/prt/baseline-measure.mjs --pending`
  从 GF-001 证据文件的模型与 token × **记录的价目表**重算（三段独立复算：
  planner `$0.025958` + implementer `$0.007607` + reviewer `$0.011521`）；
  ⚠️ 它是**估算不是账单**（`verify-evidence.md` §4/§5 分开写着，勿合并成一句"还缺数据"）。
- **`peak-resource` 已从"采不到"变成"两处都采得到"**：
  - 进程**整个生命周期**那一半：`product/launcher/peak-resource.mjs`，经
    `product/launcher/supervisor.mjs` 接在那台**长驻 DSH Runtime 进程**上；
  - **每 Run 一个窗口**那一半：`orchestrator/worker/run-peak-resource.mjs`，接在
    `product/orchestrator/worker.mjs`（全产品唯一一处 executor 诞生点）。
  - 仍缺的是「每次 Run 真的印出一行」这个**观测本身**（要一次真实 Legion 部署）。
- 台账行 `:33` 的状态是 **⏸**（不是 🟡），行尾口径："缺的是**真实部署上一次 Run 的基线数值**"。

---

## 5. PRT-316：状态、天数、闸门读数**三处都对不上**

递过来的是「⬜ 排期阻塞：`PRT-909-release-checklist.md:63` 把"一个发布周期"定为 14 天，
`0db37af` = 2026-09-10 ⇒ 最早 2026-09-24 开工（还有 8 天）。评审闸门已通过，
hot-file-churn 已报"可安排开工"」。

### 5.1 前半句（周期与基准）是对的

- `docs/superpowers/prt/PRT-909-release-checklist.md:63`：「默认有效期 **14 天**（一个发布周期）」✅
- `0db37af` = **2026-09-10 17:10**（"启动期并发两个真实缺陷"），且是 HEAD 的祖先 ✅

### 5.2 天数对不上

2026-09-10 + 14 天 = **2026-09-24**。今天 **2026-09-21** ⇒ **还差 3 天**。
"还有 8 天"对应的是更早的一天（08 天 ⇒ 约 2026-09-16）。

### 5.3 ★ 闸门自己的复算现在**不通过**

```
node scripts/prt/hot-file-churn.mjs        （exit=0）
  team-hub/server.mjs  第 1–40 个提交 11/40，历史峰值 17/40
  判定：最近 40 个提交中热点文件被触及 11 次（阈值 ≤2），历史峰值 17
    → **未降温**：在途功能仍在改这两个文件，阶段 3 应推迟
```

对照 spec `:1277` 的原话是「两个热点文件最近 40 个提交仅被触及 **1 / 2** 次，
日更节奏已降温」——那是**旧快照**。⇒「评审闸门已通过」「hot-file-churn 已报可安排开工」
两句在 HEAD 上**都不成立**。

⚠️ 顺带一条形状：`hot-file-churn.mjs` 判"未降温"时**退出码仍是 0**。
*一个"无论判定是哪一侧都返回同一个退出码"的工具，与一个"通过了"的工具，
在被只看退出码的流水线读到时是同一个东西。*

### 5.4 而工作已经大量落地

`docs/PRT-316-evidence/` 有 **51 个切片** + 收尾守卫；台账行 `:131` 的口径是
**188 = 186 已搬 + 2 裁定不搬**（不是"还剩 2 条没做"），状态经业主裁定 **🟡 → ✅**
（`2967119`，2026-09-21 08:43）。⇒ 把本项记成"⬜ 还没开工"与仓库现状相反。

---

## 6. PRT-256 / PRT-910：与递过来的一致

台账 `:80`「PRT-256 设计伙伴独立完成真实低风险任务 | ⏸ | 需真实外部用户」、
`:241`「PRT-910 内部与金丝雀真实项目验证 | ⏸ | 需真实用户项目」。
两条都属"代码侧无法单独关闭"，本机没有可做的动作，**复核无异议**。

---

## 7. 附：本复核顺带量到的一条红（与上面 7 条无关）

复核当时，`scripts/prt/boundary-facts.mjs` 在**当时的工作树**上 `FAIL（参与比对 30/30，红 1）`：

```
✖ ledger-line-citations-resolve
    ✖ 产物是 "server.mjs:2375（这一行是空的，或只有收尾符——引用指的地方没有内容：\"}\"）"
```

引用方是台账 PRT-611 行等多处；成因是**引文坐标被后续提交漂移**（该处现在只剩收尾符），
不是被引代码坏了。

★ **收尾时的读数变了，按事实订正**：复核结束时该红**已被消除**——
`node scripts/prt/boundary-facts.mjs` 报 `PASS（参与比对 30/30，红 0）`，
消除它的是**另一个会话**的提交（`git status` 里那份 `boundary-facts.mjs` 的在制品已落库），
**不是本复核**。⇒ 这条留在这里是作为"复核过程中的一次读数"，不是当前状态。

---

## 8. 复核之后按要紧程度做的修复

按"会不会让下一个人照着一个**反的**读数做决定"排序，只动了两处：

### 8.1 工具：`scripts/prt/hot-file-churn.mjs`（闸门不再自相矛盾）

| 改动 | 为什么 |
| --- | --- |
| 新 `--strict`：判定「未降温」⇒ 退出码 **2**；默认仍 **0** | 原来的形状是*一个"无论判定是哪一侧都返回同一个退出码"的工具，与一个"通过了"的工具，在被只看 `exit 0` 的读者读到时是同一个东西*。默认不改成"未降温即非 0"，是因为未降温是探针的**正常输出**，而 CI 里那条 `prt-churn` 跑的是单测——真仓降温与否不该让 CI 变红 |
| 新空读数守卫：`files` 一个都没量到 ⇒ `ok:false`、**不判定** | `Math.max(...[], 0)` 恰好是 `0`，而 `0 <= 2` ⇒ 会把"什么都不知道"印成**「已降温、可安排开工」** |
| 文件头补"退出码"一节 | 把上面这条形状写在该看的地方，而不是只留在提交信息里 |

**钉住它的用例**（`scripts/prt/hot-file-churn.test.mjs`，**18 → 21**）：
⑤ 空读数不判定（真夹具仓库）、⑥ `--strict` 跟随判定且与文字结论不分叉、⑦ 判定**公式本身**对着夹具钉住（最近窗口 0 次⇒降温 / 3 次⇒未降温）。

★ ⑦ 是**破验逼出来的**：⑥ 只钉"退出码是否跟随 `verdict.cooled`"，而它读的是同一个 `collectChurn`——把 `cooled` 改成恒 `true` 时两侧一起漂、⑥ **照样通过**。
> 一条"报告与判定一致"的断言，与一条"判定本身是对的"的断言，在判定被写死成某一侧的时候是同一个东西——只不过前者的两侧会一起漂。

**破验**（`scratch/_mutate-r114-churn.mjs`）：M1 空读数守卫失效 / M2 `--strict` 失效 / M3 判定恒已降温 ⇒ **3/3 咬住**，且**逐字节还原**。

### 8.2 文档：让"可安排开工"不再从两处读出来

- 台账 `PRT-316` 行（`docs/superpowers/prt/PRT-PROGRESS.md`）：追加 `2026-09-21 复核订正` 块——
  重量读数（`recentMax` **10/40**、历史峰值 17/40、判定**未降温**、退出码 2）、
  以及"把 `exit 0` 当闸门已过"这条**形状错误**的自我订正。
  **不改该行的 ✅**：`:1283` 的 Program 级停止条件优先于排期，闸门恢复与否都不改变"阶段 3 应推迟"。
- spec `:1277`（`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md`）：
  那一格是快照，就地标注"已不能照字面读"、给出重量命令与 `--strict` 的用法。
  ⇒ 阶段 3 是否可开工，**以 A.5 第 3 条为准**。

**没有动**（有意）：7 条台账行的**状态格**、`docs/STATUS.md`、
`PRT-HUMAN-INTERVENTION-2026-09-20.md`（正在被另一会话追加，按纪律不碰）。

### 8.3 门禁读数（改完复跑）

```
node scripts/prt/hot-file-churn.test.mjs   → 21/21 pass
node scripts/prt/boundary-facts.mjs        → PASS 30/30，红 0
node scripts/prt/progress-check.mjs        → exit 0
node scripts/ci/check-docs.mjs             → PASS（11 类校验项全绿）
node scripts/prt/spec-progress.mjs         → exit 0
node scripts/ci/encoding-check.mjs         → PASS
```

### 8.4 第二轮：把闸门读数接进 CI、并关掉 PRT-006 的跨版本缺口（2026-09-21 晚）

§8.1 修好的是**探针自己**；这一轮修的是"**读数到不了该看的人手里**"，
以及 §0 提到的那条遗留缺口。

#### 8.4.1 退出码不再合并（`--strict`：未降温 ⇒ 3，读不到 ⇒ 2）

第一版把两者都给了 `2`。那正好是 §8.1 要防的那类错的重演：

> 一个"闸门读不到"的读数，与一个"闸门读到了、判定不该开工"的读数，
> 在只看退出码的调用方眼里是同一个东西——只不过前者要修的是探针，后者要修的是排期。

现在 **0 = 已降温 / 2 = 读不到 / 3 = 未降温（仅 `--strict`）**，
并且三种码来自一个**具名**导出 `CHURN_EXIT`，`main()` 与 CI 都不许再写裸数字。

#### 8.4.2 探针多打一行机器可读结论

```
CHURN_VERDICT cooled=false recentMax=10/40 historicalPeak=17/40 head=d8dcb4d
```

因为 CI 此前只能去**猜中文措辞**（匹配「已降温」/「未降温」）——
*一个靠匹配中文措辞判断机器状态的调用方，会在这句话被改写的那天静默失准*。

#### 8.4.3 读数接进了 CI 的 `doc` 阶段（**记录，不判红**）

实测输出（`node scripts/ci/run-ci.mjs --only doc`）：

```
阶段 3 闸门（hot-file-churn --strict）exit=3
  CHURN_VERDICT cooled=false recentMax=10/40 historicalPeak=17/40 head=d8dcb4d
  ⇒ 未降温：阶段 3 应推迟（按 spec A.5 第 3 条，Program 级停止条件优先）

[doc] -> PASS (4528ms)
```

三处刻意的取舍：

1. **不参与 `ok`**：未降温是探针的**正常输出**，真当失败会让每个在途提交把 CI 变红。
2. **读不到（2）也不拦**：那条线现在没人在守，悄悄变门禁会让别人的提交莫名其妙地红。
3. ★ **"读不到"这个码不覆盖"探针文件缺失"**——我实测过：把探针文件改名后
   `run-ci.mjs` 顶部那句静态 `import` 在**加载期**就 `ERR_MODULE_NOT_FOUND`，
   整个 CI 当场死掉，detail 一个字都打不出来。我原先注释里把这条说成
   "读不到 ⇒ 如实报进 detail"，**那句话是错的**，已订正。
   行为保留（静态 import 换来"退出码常量不可能与探针漂开"，正是破验 M6/M7 守的东西）。
   实测记录见 `scratch/_probe-ci-missing-probe.md`。

#### 8.4.4 PRT-006 跨版本恢复：缺口已关

`docs/PRT-006-evidence/backup-restore-evidence.md` §5 此前自己写着
「**未验证跨版本恢复**……本次未对该声明做实验」，守的是一句**没有任何实验支撑的声明**：

> 表结构只增不改：新代码在老库自动建表/补列（幂等），回滚旧代码时新表闲置互不破坏。
> —— `docs/DEPLOY.md` §6 回滚表

新增 `scripts/prt/backup-restore-cross-version.test.mjs`（CI 套件 `prt-xver`，**11 例**），
夹具形状取自**真实历史**：`f53404e`（2026-08-25）那一版 `team-hub/server.mjs` 只有
`tasks`/`members`/`audit` **三张表**，今天 **50 张**。

| 方向 | 判据 | 读数 |
| --- | --- | --- |
| 夹具出处 | 那个提交真的只有三张表；INSERT 列清单与历史逐字一致 | ✔ |
| 新代码读老库（前滚） | 老数据逐行不丢 / 新表新列建补 / **补上来的列可空或有默认** / 新代码写得进去 | ✔ |
| 前滚（破坏性迁移） | `goal` 表 DROP+重建**行数不丢**、形状升级、且**幂等**（第二次打开不重建） | ✔ |
| 老代码读新库（回滚） | 老代码写过的列都还在 / **三条老 INSERT 从历史源码抠出来真的跑一遍** / 老表无触发器 | ✔ |

⚠️ **边界如实保留**：回滚那一向**没有真的去跑那一版 `server.mjs`**——它没有 `isMain` 守卫
（import 会直接监听端口），且 `ROOT = <所在目录>/..` 从临时目录跑会算错。
所以它是**结构性 + 执行老 SQL** 的验证，不是"跑了一遍老代码"；
**别把绿色的 `prt-xver` 读成"回滚已经端到端验过了"**（该边界已同时写进套件文件头与证据文档）。

#### 8.4.5 第二轮的门禁读数（改完复跑）

```
node --test scripts/prt/hot-file-churn.test.mjs                    → 24/24 pass
node scratch/_mutate-r115-churn.mjs                                → 6/6 咬住，逐字节还原
node --test scripts/prt/backup-restore-cross-version.test.mjs      → 11/11 pass
node scratch/_mutate-r116-xver.mjs                                 → 5/5 咬住，逐字节还原
node scripts/ci/run-ci.mjs --only doc                              → PASS，闸门读数已入 detail
node scripts/prt/boundary-facts.mjs                                → PASS 30/30，红 0
node scripts/prt/progress-check.mjs / spec-progress.mjs            → exit 0 / exit 0
node scripts/ci/check-docs.mjs / encoding-check.mjs                → PASS / PASS
```

破验另记一条**可证等价**（不计缺口）：去掉 `tasks.status` 的 `DEFAULT 'backlog'`
不产生行为差异——新老代码的两条 tasks INSERT **都显式写了 `status`**。

---

## 9. 复现命令

```powershell
git log -1 --format='%h %ci %s'                      # 基线（★ 会动）
node --test team-hub/run-plane-e2e.test.mjs          # PRT-214 四跳
node --test orchestrator/worker/can-read-authorization-source.test.mjs team-hub/run-floor.test.mjs
node --test product/launcher/run-credential-dsh-process.test.mjs   # PRT-509 ③
node scripts/prt/hot-file-churn.mjs --strict         # PRT-316 闸门（未降温 ⇒ 3 / 读不到 ⇒ 2）
node --test scripts/prt/hot-file-churn.test.mjs      # ⑤⑥⑦⑧⑨⑩
node scratch/_mutate-r115-churn.mjs                  # 破验 6/6
node scripts/ci/run-ci.mjs --only doc                # 闸门读数进 CI detail
node --test scripts/prt/backup-restore-cross-version.test.mjs      # PRT-006 跨版本 11 例
node scratch/_mutate-r116-xver.mjs                   # 破验 5/5
node scripts/prt/boundary-facts.mjs                  # 引文坐标
git log --oneline -S "resolveRunPermissions" -- team-hub/server.mjs team-hub/run-store.mjs
```
