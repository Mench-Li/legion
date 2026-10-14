<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（commit `22ae3a25`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-204 方案研究：为软件流水线空间仍未换头像的 Agent（soldier-* 与 general）选取头像

> 阶段：方案搜索（researcher）｜任务：T-204（[auto-goal]，所属目标 G-mv7kzgnu-1 · software · chain）
> 上游需求：[docs/G-mv7kzgnu-1/REQUIREMENTS.md](./REQUIREMENTS.md)（T-203 产出，commit `7c04b9cf`）→ **本文件** → 下游 T-205 breaker（TASK_BREAKDOWN.md）→ T-206 test-designer → T-207 coder → T-208 reviewer → T-209 tester → T-210 devops
> 评估基线：w/T-204 worktree HEAD `22ae3a25`（2026-10-14）；运行时 Node v24.19.0 / git 2.55.0.windows.5（本 worktree 实测）
> **边界声明**：本阶段只做调研与选型对比，**不写实现、不改任何代码**、不调用 taskctl / 看板写接口、不 push。文中所有「落点建议」是给 T-205/T-207 的输入，**不是已落地的实现**。
> **联网口径**：LEGION.md 禁止联网下载依赖 ⇒ 本文件**不含任何网络来源**。全部依据 = 本仓库 file:line（A 级）+ 只读数据库/渲染实测（A 级）+ 既有测试断言（A 级）+ 仓库内既有文档（B 级）+ 上游目标/任务记录（C 级）。**本阶段未引用任何外部库或许可数据**，理由见 §1；这不影响「新引入依赖逐项说明影响」（§7 的结论是：本方案零新增依赖，且给出若要补图时的资产影响）。

## 0. 结论速览（TL;DR）

**推荐：方案 A —— 「投影层令牌映射」：只改服务端读出口，把外部执行者条目的硬编码 `'⚙️'` 换成由**静态映射表**分到**空闲备用位面**（`s11..s15`）的合法令牌；不动 roster、不动位面表、零新增依赖、零新增图片资产、零出网。**

一句话依据：这几个「没换头像的 Agent」**不是 roster 成员**，而是 `/api/roster` 由 `tasks.soldier` 现场合成的**外部执行者条目**，其 avatar 被硬编码为 `'⚙️'`（非法令牌）⇒ 全部落到**同一张**灰阶占位人形；而「给他们各配一张照片」在现有资产下**做不到**：20 张图片 key 已被 20 个在用令牌**占满**（§2.4 实测），且 `avatar-photo.test.mjs` 判据 ⑦ 断言「两行不许指向同一张原图」——**复用也不行**。于是「选取头像」在现约束下只剩两条真正可走的路：**矢量**（方案 A，今天就能做完）或**补图**（方案 B，需要将军提供新图片）。

| 关键决策 | 推荐 | 主要备选 | 取舍理由（要点） | 位置 |
| --- | --- | --- | --- | --- |
| 数据落点 | **投影层修复**（不落 roster 行） | 落 roster 行 | 上游 ⚖️D-1 倾向；落行会连锁改成员计数 / 3D 人数 / 全局目录，并要为「人类将军」与 2026-08 的历史死名字造 AI 员工身份 | §4.1 / §6.1 |
| 身份 → 位面的分配机制 | **静态映射表**（构造性唯一） | 哈希派生 / 动态池分配 | 「唯一、确定」必须是可断言的，而不是概率性的；且不能被「当前占用了哪些 key」这一集合的变化牵着走 | §4.2 / §6.2 |
| 头像内容（矢量 vs 照片） | **矢量**（空闲位面 `s11..s15`） | 将军补图（方案 B） | 图片池 20/20 已占满 + 禁止复用同一原图；矢量离线自足、今日可落地，且**已有一位同类先例**（`ozon/soldier-sourcing` 就落矢量） | §4.3 / §6.3 |
| general 的头像 | 独立位面（`s11`），与 8 个内编岗位都不同 | 与 AI 员工同款、不作区分 | 上游 R-3 / AC-R3-3 要求与内编可区分；是否需要「人类/守护」附加标识见 ❓O-1 | §6.4 |
| 未登记的新外部执行者（R-8） | 静态表优先 + 未命中按 FNV-1a(name) 在**空闲池**确定性探测；池满 → 空串（占位语义） | 只补已点名的 4 个，不做兜底 | 上游 R-8 是 P1；FNV-1a 在 `workbench/src/scene/sceneState.ts:49-53` 已有现成实现（零新增依赖） | §6.5 |
| 备用池是否扩容 | **不扩容**（用现成的 `s11..s15`） | 扩到 `s16..s24` | 扩容要同时改桌面位面表 + 移动端镜像 + 两份测试常量（4 处），而收益只覆盖「未来新增」；先不扩，池满走占位 | §6.6 |
| S8 技能授权标签 | **纳入** | 显式声明不纳入 | 上游 ⚖️D-5 倾向纳入；成本是复用同一张「名字→令牌」表，不新增头像来源 | §6.7 |

## 1. 研究方法与证据分级

| 级别 | 含义 | 本文件用法 |
| --- | --- | --- |
| **A** | 本 worktree **实测可复现**（命令 + file:line + 只读数据库查询 + 渲染实测 + 既有测试断言） | 现状枚举、供给盘点、约束清单、反例 |
| **B** | 仓库内既有的**文档/契约**（`docs/FEATURES.md`、`workbench/README.md`、`docs/superpowers/specs/`、上一目标 `docs/G-mv1s6y49-1/`） | 口径承接与历史决策 |
| **C** | 上游**目标/任务记录**（goal `G-mv7kzgnu-1`、T-203 产出 REQUIREMENTS.md） | 需求边界与待答问题 |
| **D** | 厂商自述 / 营销页 | **本文件 0 条**：禁联网纪律下不抓取、不引用 |

方法：

1. 逐条读上游 REQUIREMENTS.md 的 R-1~R-11、AC、⚖️D-1~D-5、❓O-1~O-6，抽出明确留给 researcher 的 5 个问题（§1.1）。
2. 在**只读**信道上复算 `/api/roster` 的合成逻辑（`team-hub/routes/team-views.mjs:74-120`）对 `team-hub/team.db` 跑一遍，得到与实现同源的枚举（脚本与输出见 `T204-evidence/`）。
3. 直接 import 移动端渲染器 `workbench/mobile/avatar.mjs` 实测「令牌 → 是否真的换了脸」，而不是读源码猜（它与桌面位面表由 `avatar-parity.test.mjs` 逐 key 锁死，结论对桌面同样成立）。
4. 把「看起来可行的做法」逐条撞既有判据（§3），**留下真的能过的那几种**。
5. 关键外部事实**逐条附 file:line 与复现命令**（§10）；无法独立复核的观感/授权问题写成风险（§9），不写成结论。

### 1.1 上游留给 researcher 的 5 个问题（本文件的回答位置）

| # | 上游问题（REQUIREMENTS.md §9「给 T-204 researcher」） | 本文件回答 |
| --- | --- | --- |
| (a) | 外部执行者 → 令牌的分配机制（哈希派生 vs 备用池 vs 独立前缀），如何与 roster 备用池不撞（RK-1） | §4.2 + §6.2 |
| (b) | 是否落 roster 行（⚖️D-1）及其副作用清单 | §4.1 + §6.1（含副作用逐项实测锚点） |
| (c) | general 的独立位面 / 图片来源 | §6.4（矢量）与 §4.3 路径 P1（照片） |
| (d) | 4 个头像用矢量还是图片（❓O-2；图片只剩 20 张已用 21 令牌，RK-5） | §2.4 + §4.3 + §6.3 |
| (e) | S8 技能授权标签的补头像方式（⚖️D-5） | §6.7 |

### 1.2 本阶段实跑的命令与结果（证据快照）

| 命令 | 结果 |
| --- | --- |
| `node docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs` | 输出 53 行；重跑与 `T204-evidence/probe-output.txt` **逐行一致**（除首行库 mtime） |
| `node workbench/scripts/agent-avatar.test.mjs` | **12/12 pass**（含 TC-S1-02 唯一、TC-S1-04 确定性、TC-S1-10 依赖零新增） |
| `node workbench/scripts/avatar-photo.test.mjs` | **10/10 pass**（含 ③ 两端逐字节、⑦ 来源唯一） |
| `node workbench/mobile/avatar-parity.test.mjs` | **6/6 pass**（位面表两端逐 key 一致） |
| `node workbench/scripts/agent-avatar-surfaces.test.mjs` | **5/5 pass**（桌面展示面单一来源） |
| `node workbench/scripts/agent-avatar-settings.test.mjs` | **6/6 pass** |
| `node team-hub/team-views-routes.test.mjs` | **17/17 pass** —— 其中第 ⑥ 条（`:128-140`）**当前是绿的**，正因为它把 `ext.avatar === '⚙️'` 固化成期望（即 §8.2 的 E1） |
| `node scripts/ci/check-docs.mjs` | **PASS**（11 类校验全绿：表格行形状 16665 行 0 异常、evidence banner 覆盖完整、README/FEATURES/STATUS 一致） |
| `node scripts/ci/encoding-check.mjs --all` | **未能运行**：该脚本用 `spawnSync git` 取文件清单，在本会话的 Windows 沙箱下报 `EPERM`（工具的既定边界，非本文件的问题）。改以**直接读取**校验本阶段新增的 4 个文件：无 NUL 字节、无 U+FFFD、无 BOM |

## 2. 现状基线实测（证据级别 A）

> 复现：`node docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs`（只读 `team.db`；不联网、不写库、不调 HTTP）。完整输出见 `docs/G-mv7kzgnu-1/T204-evidence/probe-output.txt`。

### 2.1 目标对象枚举（与上游 §2.1 **独立复算，结论一致**）

| scope | roster 行 | roster 非法令牌 | 外部执行者条目 | 渲染结果 |
| --- | --- | --- | --- | --- |
| software | 8 | 0 | **4**：`soldier-a` / `soldier-b` / `general` / `soldier-auto` | 4 条**同一张**灰阶占位人形 |
| ozon | 10 | 0 | 1：`soldier-market` | 同一张灰阶占位人形 |
| gf001 | 3 | 0 | 0 | — |
| default | 3 | 0 | 0 | — |

- 全库 roster 24 行、**0 行**非法令牌 ⇒ 缺口 100% 落在「外部执行者条目」这一类（与上游 §2.1 一致）。
- 这些条目的 avatar 来自 `team-hub/routes/team-views.mjs:119`：`summarize(soldier, soldier + ' · 执行中', list, '', '⚙️', true)` —— **硬编码 `'⚙️'`**。
- 另有 **S2 侧栏底部用户卡**：`workbench/src/components/Sidebar.tsx:174-180` 的 `<div className="user-avatar">⚙</div>` + `name=general / role=空间管理员`；以及 **S3 左轨徽标** `workspace/src/components/WorkspaceNavigation.tsx:45` 的文字「管」。它们不是 Agent 条目，但**都显示 general**（上游 R-3 要求两处一致）。

### 2.2 为什么这 4 条是「同一张脸」——渲染链路逐跳

| 跳 | 位置 | 事实 |
| --- | --- | --- |
| ① 服务端合成 | `team-hub/routes/team-views.mjs:118-120` | 外部执行者条目 avatar 固定 `'⚙️'` |
| ② 令牌校验 | `team-hub/agent-avatars.mjs:16` | `/^human:[a-z0-9][a-z0-9-]*$/` ⇒ `'⚙️'` **不是**合法令牌 |
| ③ 客户端解析 | `workbench/src/avatar/slots.ts:86-94` | `resolveSlot('⚙️')` ⇒ `null` |
| ④ 回退 | `workbench/src/avatar/AgentAvatar.tsx:223` → `slots.ts:76-84` | `?? PLACEHOLDER_SLOT` ⇒ **全局唯一**的灰阶人形 |
| ⑤ 图片路 | `workbench/src/avatar/photo-assets.ts:31-50` | `photoFileFor('placeholder')` ⇒ `null`（占位没有配图）⇒ 落矢量 |

**两条实测反例（本阶段新发现，直接决定候选方案的边界）**：

| 反例 | 实测 | 含义 |
| --- | --- | --- |
| `renderAvatar('human:general', 32) === renderAvatar('', 32)` | **true** | `human:general` **语法上是合法令牌**（过第 ② 跳），但位面表里没有 `general` 这个 key ⇒ 仍然落同一张占位人形。**「写了一个看起来很合理的令牌」与「什么都没做」在界面上是同一样东西** |
| `renderAvatar('human:s11', 32) === renderAvatar('', 32)` | **false** | 已登记的空闲位面 `s11` 渲染出的是一张**真的不一样**的人形 ⇒ 方案 A 的落点有效 |

> 这条反例必须在 T-206 的用例里钉住：R-1 判据是「合法令牌 **且** `resolveSlot(avatar) !== null`」，只看前者会把 `human:general` 判成已换头像。

### 2.3 展示面复核（对上游 §2.3 的独立核对）

上游列出的 S1–S8 我逐条复核，**全部属实**（行号一致）；补充两点：

| # | 展示面 | 位置 | 复核结论 |
| --- | --- | --- | --- |
| S1 | 侧栏 Agent 目录行 | `WorkspaceNavigation.tsx:63` | 属实（`<AgentAvatar token={a.avatar}>`） |
| S2 | 侧栏底部用户卡（general） | `Sidebar.tsx:174-180` | 属实（硬编码字符 `⚙`） |
| S3 | 左轨「空间管理员」徽标 | `WorkspaceNavigation.tsx:45` | 属实（文字「管」） |
| S4 | Agent 工作区头部 | `AgentWorkspace.tsx:112` | 属实 |
| S5 | 场景 Agent 列表 | `SceneAgentList.tsx:13-20` | 属实 |
| S6 | 3D 场景人物 | `Employee3D.tsx:50,100,117` | 属实（external 统一 `#586879` 灰人；`:117` 已有「临时」标识先例） |
| S7 | 移动端 chip / picker | `workbench/mobile/app.mjs:541-563` | 属实；但见下 |
| S8 | 技能授权标签 | `SkillsPanel.tsx:316-320,546,681,793` | 属实（目录查不到 `a` ⇒ 整块不渲染头像） |

**S7 的一处口径修正（本阶段实测，影响验收面）**：移动端取数走 `/api/agents?scope=`（`workbench/mobile/app.mjs:792`），而 `/api/agents` **只投影 roster 表**（`team-hub/routes/read-models.mjs:256`），**不含外部执行者** ⇒ 这 4 个身份**根本不会出现在移动端成员列表里**。它们只出现在桌面（S1/S4/S5/S6）与 S8。⇒ T-206 的「移动端一致性」用例应针对**位面 parity**（桌面 vs 移动端渲染同一 `token` 得同一张脸），而不是针对这 4 条的移动端展示。

### 2.4 供给盘点：这才是「选取头像」真正的约束（A 级实测）

| 供给 | 容量 | 已用 | 空闲 | 证据 |
| --- | --- | --- | --- | --- |
| 图片资产（`photo-assets.ts`） | **20** 个 key | **20 / 20**（软件 8 + default 3 + `s01..s09` 9） | **0** | `workbench/src/avatar/photo-assets.ts:31-50`；probe 输出「被 roster 实际使用的图片 key = 20 / 20」 |
| 位面 key（矢量人形） | **40**（25 岗位 + `s01..s15`） | 25 岗位中在用 8（software）+3（default）+`reviewer`·`s01..s10`… 共 10 个备用 key | **`s11..s15`（5 个）** | `workbench/src/avatar/slots.ts:13-22,60-70`；probe 输出 |

- **图片池已占满**：20 张图对应 20 个在用 key，且 `s10`（`ozon/soldier-sourcing`）已经在回落矢量。⇒ 想给这 4 个身份各配一张**照片**，必须**新增图片**。
- **复用现有照片被两条判据挡住**：`workbench/scripts/avatar-photo.test.mjs` ⑦「20 张图应当对应 20 个不同的原图（防止复制粘贴时把两行写成同一张）」+ 本轮 AC-R4-1「软件空间内两两不同」。⇒ 「把某张图挪给他们用」要么红、要么同空间两张一样的脸。
- **矢量池有 5 个真空闲**：`s11..s15` 未被任何 scope 占用；40 个位面的特征签名两两不同（`assertSlotTable()` 在模块加载期自检，实测 40/40）。
- **空闲位面确实是「人形」**：它们是同一套参数化人形（肤色/发色/发型/上衣/配饰/底色），与其余 35 个位面同一画风；可用仓库自带工具肉眼定稿：`node workbench/scripts/render-avatar-sheet.mjs --only=s11,s12,s13,s14,s15`（该工具的存在理由正是「画风只能靠眼睛定稿」，见 `workbench/scripts/render-avatar-sheet.mjs:8-18`）。

### 2.5 一个会被忽略的既有约定：仓库内**没有** WebP 派生工具链

| 事实 | 证据 |
| --- | --- |
| 20 张 256px WebP 是**派生产物**，但仓库里没有生成它们的脚本 | `grep webp scripts/` ⇒ 0 个转换脚本；`photo-assets.ts` 注释只记「1254px PNG → 256px WebP q82」，未记命令 |
| PATH 上没有 ffmpeg / ImageMagick（本机实测） | `Get-Command ffmpeg/magick` ⇒ 无 |
| 任何 package.json 都没有图像库 | `grep sharp/pngjs/jimp… *package.json` ⇒ 0 命中 |
| 原图**不入库**（42.6 MB 被 .gitignore 挡掉） | `.gitignore:4-16`（`assets/agent-avatars/`） |

⇒ **方案 B（补图）不是「把图放进目录」那么简单**：还缺一个「可重现的派生步骤」。这条在本文件里作为方案 B 的成本项（§4.3 P1）与风险（§9 RK-B1）明确写出，避免下游把它当成一行改动。

## 3. 决定「可选空间」的硬约束（每条都有判据，不是风格偏好）

> 这一节是本文件的核心：它把「看起来有很多种做法」收敛成「只有这几种真的能过门禁」。

| # | 约束 | 判据 / 证据 | 对方案的硬性影响 |
| --- | --- | --- | --- |
| C1 | **禁联网、禁新增运行时依赖** | LEGION.md；`workbench/scripts/agent-avatar.test.mjs:276-279`（TC-S1-10 断言 dependencies 恰好 5 个） | 不能引图像库 / 头像库 / 哈希库；不能用 HTTP API |
| C2 | **头像不得依赖外部资源** | `agent-avatar.test.mjs:230-241`（TC-S1-09 外链黑名单）；`avatar-photo.test.mjs:129-138` | 只能用同源相对路径与内联图形 |
| C3 | **单一头像来源**：不得有第二套「视觉」表 | `agent-avatar-surfaces.test.mjs:19-27`（TC-S4-03/05）、`agent-avatar-settings.test.mjs:33-38`（TC-S5-06）查 `AVATARS=` / `AVATAR_CHOICES` 形态 | 允许新增「名字→令牌」的**映射**（它不定义任何颜色/形状），但**不允许**新增第二套画法/配色表 |
| C4 | **位面表规模被断言钉死** | `agent-avatar.test.mjs:142-148`（keys.length == 25 + 15）、`workbench/mobile/avatar-parity.test.mjs:44`（== 40） | 若「独立前缀 / 新 key 家族」要加 key，必须同步改桌面表 + 移动端镜像 + 2 份测试常量（4 处） |
| C5 | **两端逐项一致**（桌面 / 移动端镜像） | `avatar-photo.test.mjs:85-92`（④ key 集合与文件名）、`:76-83`（③ 逐字节）、`:94-101`（⑤ 无孤儿图） | 任何新增资产/表都要双份落盘并登记，否则「桌面有、手机裂」 |
| C6 | **资产来源唯一**：两行不许指向同一张原图 | `avatar-photo.test.mjs:116-127`（⑦） | **复用现有照片**这条捷径被直接判红 |
| C7 | **唯一 / 可区分** | `agent-avatar.test.mjs:123-127`（TC-S1-02 25 岗两两不同）；`slots.ts:97-112`（`assertSlotTable` 全 40 个两两不同，构造性） | 4 个新身份不能与 8 个内编角色同 key、同图 |
| C8 | **确定性、无随机/时钟/网络** | `agent-avatar.test.mjs:159-165`（TC-S1-04）；`slots.ts:5-9` | 分配必须由**名字**决定，不能由请求顺序/时间/集合顺序决定 |
| C9 | **身份红线**：name/avatar 不生成身份 | `docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:81`；`agent-avatar.test.mjs:281-285`（TC-S1-12） | 不能把 avatar 用作 key/唯一约束；不能靠 avatar 区分多实例 |
| C10 | 用户裁决（上一目标，目标上下文 v1） | goal `G-mv1s6y49-1` contextVersion=1：「创建时自动生成头像（无需配置）；必须是拟人头像、不能是 emoji；范围包含所有、含后续自建」 | 拟人是底线；emoji 不算；**后续自建**要能自动覆盖 ⇒ 呼应 R-8 |

## 4. 候选方案

方案由**两个正交决定**组合而成，先拆开、再组合——否则「对比」会变成把两件事混在一起谈。

### 4.1 决定一：数据落点（3 选 1）

| 落点 | 形态 | 优点 | 缺点 / 成本 | 结论 |
| --- | --- | --- | --- | --- |
| **L1 投影层修复** | 只改 `team-views.mjs:119`，让 `/api/roster` 的 external 条目带上合法令牌；不动任何表 | 副作用面最小：`/api/spaces.agentCount`（`read-models.mjs:196-201` 只数 roster）、3D 人数、`/api/agents` 目录、任务归属**全部不变**（AC-R9-1/2/4） | 令牌仍是「实时合成」的，不落库 ⇒ 必须保证纯函数确定性 | **推荐**（= 上游 ⚖️D-1 倾向） |
| L2 入编 roster 行 | 为每个外部身份 `INSERT` 一条 roster 行 | 一次到位；之后走既有入编分配与展示链路 | 连锁副作用：成员数 8→12（`read-models.mjs:200`）、侧栏分组计数（`WorkspaceNavigation.tsx:62` 数的是 roster 条数）、3D 人数、`SpaceOverview.tsx:25` 的 `!external` 过滤、全局目录 `/api/agents`；且要给**人类将军**和 2026-08 的**历史死名字** `soldier-a/b` 造「AI 员工身份」——与 C9 身份红线及上一目标的对象边界冲突；还会干扰 `rosterRoles` 判定（`team-views.mjs:80`）从而**改变任务归属的呈现类**（external → 内编） | **否决** |
| L3 客户端专用表 | 只在 workbench 里放一张「名字→头像」表 | 不碰服务端 | 与 C3 抢边（第三方审查会问「这是不是第二套头像来源」）；服务端 `/api/roster` 仍返回非法令牌（R-7 落空）；S8/移动端各自为政 | **否决**（作为 L1 的**补充**才成立，见 §6.7） |

### 4.2 决定二：身份 → 位面的分配机制（3 选 1）

| 机制 | 形态 | 优点 | 缺点 / 成本 | 结论 |
| --- | --- | --- | --- | --- |
| **T1 静态映射表** | `soldier-a→human:s12`、`soldier-b→human:s13`、`soldier-auto→human:s14`、`general→human:s11`、`soldier-market→human:s15`（表落 `team-hub/agent-avatars.mjs`，与 `builtinAvatarFor` 同形） | **构造性唯一**（可断言，不靠概率）；只由名字决定 ⇒ 跨请求/重启/两端恒定（C8）；不碰已用 key ⇒ AC-R4-3（其它空间令牌逐条不变）**天然满足**；不改位面表 ⇒ C4 不受影响；零依赖/零资产 | 新增外部执行者要补一行（用 §6.5 的兜底规则缓解）；`s11..s15` 是矢量 ⇒ 与 8 张照片混排（观感问题，见 §9 RK-A1） | **推荐** |
| T2 哈希派生 | `index = FNV-1a(name) % 40` 或 `% 5`（空闲池） | 零维护，新名字自动有 | **碰撞是概率性的**，而 C7/AC-R4-2 要求「不落在 8 个内编 key 上、彼此不同」⇒ 必须重试/探测；一探测，映射就依赖「当前占用集合」，集合一变（新成员/新外部名）**已有身份会换脸**（C8 只在固定集合下成立）；只在 5 个空闲位面里取模则第 6 个身份必然撞或落占位 | **仅作兜底**（§6.5），不作主口径 |
| T3 动态池分配（复用 `allocateAvatarToken` 思路） | 「该 scope 最小未占用 `sNN`」 | 与既有入编分配口径一致；自动覆盖新名字 | `allocateAvatarToken` **只扫 roster 行**（`agent-avatars.mjs:28-40`）⇒ 与 roster 的 `sNN` 分配**会撞**（上游 RK-1 已指出）；分配结果依赖「外部名字集合与顺序」⇒ 新外部执行者出现可能让既有身份换脸 | **否决** |

### 4.3 决定三：头像内容 —— 矢量 vs 照片（**这是本题真正的分叉**）

| 路径 | 形态 | 优点 | 缺点 / 成本 | 结论 |
| --- | --- | --- | --- | --- |
| **V 矢量（方案 A）** | 用空闲位面 `s11..s15` | 今天就能做完；零新增依赖/资产；离线自足；确定性；**已有同类先例**（`s10` 就落矢量，`FEATURES.md:77` 明写「有图用图、没图用矢量」）；测试面小 | 与 8 张照片**不同质**（观感差异）；5 个空闲位面是硬上限（已点名 5 个身份刚好用满） | **推荐（默认落地）** |
| P1 补图（方案 B） | 将军提供 N 张新图 → 派生 256px WebP → 双份落盘 → 登记进两端资产表 | 唯一能达成「与其余 8 个**同质**（照片脸）」的路；满足 AC-R3-2 一类人工判据最稳 | 需要**将军供图**（外部输入）；**缺可重现的派生步骤**（§2.5：无 ffmpeg/magick、无脚本、图像库 0）⇒ 要么新增工具（违反 C1/TC-S1-10）要么提交不可复现的产物；还要处理素材**授权/肖像**（§9 RK-B2）；每张约 8 KB（体积可忽略） | **升级路径**（将军若要求照片同质时才走） |
| P2 复用现有 20 张之一 | 把某张已用图再指给新 key | 零新资产、照片同质 | **被 C6 直接判红**（两行同一原图）；即便放宽，同空间会出现两张同样的脸（违 C7/AC-R4-1） | **否决** |
| P3 派生变体（裁剪/镜像/调色） | 从原图生成「新」图 | 看起来能绕开 C6 | Node 无 WebP 编解码、仓库无图像工具链 ⇒ 需要新增依赖（红 C1）或不可复现产物；且**还是同一张脸**（换裁切）⇒ 仍违 C7 精神 | **否决** |

### 4.4 组合出的候选方案

| 方案 | 组合 | 一句话 | 适用条件 | 落地成本（相对） |
| --- | --- | --- | --- | --- |
| **A（推荐）** | L1 + T1 + V | 投影层把 external 的 `'⚙️'` 换成分到空闲位面的合法令牌 | 默认；将军接受「矢量人形=已换头像」 | 低 |
| **B** | L1 + T1 + P1 | 同上，但位面 key 改成**为将军新提供的图片**留的位置 | 将军要求「与其余 8 个一样的照片」 | 中（含外部输入与派生工具链缺口） |
| C | L1 + T1 + P2 | 用现有图复用 | —— | —— |
| D | L1 + T2 + V | 哈希派生替代静态表 | 需要「零维护覆盖任意新名字」且接受概率性 | 低，但风险高 |

> 方案 C 因 C6 直接不可行（不是「不推荐」而是「会红」）；方案 D 的「零维护」诱惑很大，代价是唯一性/稳定性只能概率保证——**这正是上一目标已经用「静态表可证唯一」否掉过的形态**（`docs/G-mv1s6y49-1/RESEARCH.md` §0 决策表：「由 hash(role) 生成特征（否决：碰撞是概率性的）」）。本文件沿用同一取舍。

## 5. 对比矩阵（优劣 / 成本 / 风险）

| 维度 | 方案 A（L1+T1+V） | 方案 B（L1+T1+P1） | 方案 D（L1+T2+V） | 方案 L2（入编） |
| --- | --- | --- | --- | --- |
| 满足 R-2（4 条有合法且命中位面的令牌） | ✅ | ✅ | ✅（大概率） | ✅ |
| 满足 R-4 / AC-R4-1（空间内两两不同） | ✅ 构造性 | ✅ 构造性 | ⚠️ 概率性 + 依赖集合 | ✅ |
| 满足 AC-R4-3（其它空间令牌不变） | ✅ 天然 | ✅ | ⚠️ 探测可能改动其它分配 | ⚠️ 会新增行 |
| 满足 R-5（确定性/重启一致） | ✅ | ✅ | ⚠️ 集合变化即漂移 | ✅ |
| 满足 R-8（后续自建自动覆盖） | ⚠️ 需兜底规则（§6.5） | ⚠️ 同 A，且新图也是人工 | ✅ 天然 | ✅ |
| 满足 R-9（无不可见副作用） | ✅ | ✅ | ✅ | ❌ 成员计数/3D/目录连锁 |
| 与其余 8 个内编「同质」（人工判据 AC-R3-2 一类） | ⚠️ 矢量 vs 照片 | ✅ 照片 | ⚠️ | ⚠️ |
| 离线自足 / 零新增依赖（C1） | ✅ | ⚠️ 需要可重现派生（当前缺） | ✅ | ✅ |
| 一次落地成本 | 低 | 中 | 低 | 高 |
| 长期维护成本 | 低（表随身份增长） | 低 | 低（但需信概率） | 中（多一套成员生命周期） |
| 主要风险 | 观感差异 | 授权 + 派生工具链缺口 | 撞脸/漂移 | 身份语义与计数副作用 |
| **综合** | **推荐** | **升级路径** | 备选（仅在要求零维护时） | 否决 |

## 6. 推荐与理由（含每个子决定的默认值）

**总推荐：方案 A（L1 + T1 + V）**。理由按优先级：

1. **它解决的是真实缺口**：唯一仍在产出非法令牌的地方是 `team-views.mjs:119`（全库 roster 0 行非法，实测）⇒ 改一处读出口即可让 4 条（乃至 5 条）合法命中位面，正面回答上游 R-2/R-7。
2. **它是唯一在现有约束下「今天就能做完且不欠债」的形态**：零依赖（C1）、零资产（C5）、不改位面表（C4）、不碰 roster（R-9）、确定性可断言（C7/C8）。
3. **它不排除升级**：若将军要照片同质，方案 B 只是在同一张静态表上把目标从「空闲位面」换成「新图片 key」——落点与分配机制不变，增量是**资产**而不是架构。
4. **反过来先做 B 的风险更高**：B 需要将军供图 + 一个当前**不存在**的可重现派生步骤（§2.5）⇒ 会把这个小目标变成「先补工具链」。

### 6.1 数据落点 = L1（投影层），不落 roster

沿用上游 ⚖️D-1 倾向。副作用清单（供 T-208 逐条对照说「不变」）：`/api/spaces.agentCount`、`/api/agents` 的 role 集合、侧栏分组计数、3D 场景人数、`SpaceOverview` 的 `!external` 过滤、`tasks.soldier`/`tasks.role` 值。

### 6.2 分配机制 = T1 静态表（表落服务端唯一分配者）

- 落点：`team-hub/agent-avatars.mjs`（已有 `BUILTIN_ROLE_KEYS` / `builtinAvatarFor` / `allocateAvatarToken`，新增一个同形函数即可），由 `team-views.mjs:119` 调用（该文件**已经** import 了 `isAvatarToken`，见 `:37`，不新增模块依赖）。
- 建议默认映射（与上游 ❓O-1 的「可区分」一致）：

| 身份 | 令牌 | 位面 | 依据 |
| --- | --- | --- | --- |
| `general` | `human:s11` | `s11` | 将军本人（人类）：独立位面，与 8 个内编都不同（AC-R3-3） |
| `soldier-a` | `human:s12` | `s12` | 历史一次性士兵名（T-001） |
| `soldier-b` | `human:s13` | `s13` | 历史一次性士兵名（T-002） |
| `soldier-auto` | `human:s14` | `s14` | 执行守护的写者身份（`TaskDetailModal.tsx:309-312` 认它作守护） |
| `soldier-market`（ozon，P1） | `human:s15` | `s15` | 上游 R-11；`scrum/daemon.json` 的 pipeline 里有 `soldier-market` 阶段而 roster 无该行 ⇒ 同一个洞的另一处实例 |

> 该表只覆盖「已点名」的 5 个身份；**顺序无关**（表不依赖任何集合），所以谁先出现在任务里都不影响结果。

### 6.3 内容 = V 矢量（并把「为什么不是照片」写成可核对的理由）

图片池 20/20 占满（§2.4）+ C6 禁止复用 ⇒ 「4 个身份各得一张不重复的照片」在现资产下**不成立**。矢量不是「退而求其次」的临时方案：仓库已有同类先例（`s10`）且 `docs/FEATURES.md:77` 已把「有图用图、没图用矢量」写进产品手册。若将军坚持照片，走方案 B，且**必须先解决§2.5 的派生工具链缺口**。

### 6.4 general 的独立位面与「要不要区分人类」

默认：`general → s11`（独立位面即满足 AC-R3-3）。是否额外加「人类/守护」视觉标识（如 3D 里 external 的黄色「临时」标识先例 `Employee3D.tsx:117`）留 ❓O-1，默认**不加**（避免与「四身份各一张脸」的验收互相干扰）。

### 6.5 R-8 兜底规则（未登记的新外部执行者）

默认规则（两级）：

1. **静态表命中** → 用表中令牌（已点名身份永不漂移）；
2. **未命中** → 按 `FNV-1a(name)`（现成实现：`workbench/src/scene/sceneState.ts:49-53`，零依赖）在**空闲备用位面**里按确定顺序线性探测；**池满** → 返回 `''`（沿用上游 AC-R7-2 的「空串=占位」语义，不返回非法字符串）。

为什么不让它参与主口径：探测结果依赖「当前占用集合」，集合一变大就可能漂移（T2/T3 的问题）。**已点名身份走第 1 级，因此完全不受此影响**——这正是「静态表 + 兜底」比「纯哈希」稳的地方。

### 6.6 备用池暂不扩容

扩容（`s16..s24`）要同时改：`workbench/src/avatar/slots.ts`、`workbench/mobile/avatar.mjs`、`workbench/scripts/agent-avatar.test.mjs` 的 SPARES、`workbench/mobile/avatar-parity.test.mjs` 的 40 断言（4 处），而收益只覆盖「未来新增」。默认先不扩；若将军同时选方案 B（补图），扩容应与之同批做。

### 6.7 S8（技能授权标签）与 general 客户端面

- **S8**：`SkillsPanel.tsx:546,681,793` 只有在 `a`（来自 `/api/agents` 目录）存在时才渲染头像 ⇒ 需要一条**客户端也能用**的「名字→令牌」解析。默认**纳入**（上游 ⚖️D-5 倾向）。
- **S2/S3（用户卡 / 左轨徽标）**：令牌来源有两条路——(i) 从 `/api/roster` 的 `general` 条目取（一致性天然成立，但一旦没有 soldier=general 的任务，条目就消失）；(ii) 客户端常量。默认 (ii) 更稳，但**必须与 `team-hub/agent-avatars.mjs` 的同一张表逐项一致**（沿用仓库既有的「镜像 + parity 断言」惯例：`slots.ts ↔ mobile/avatar.mjs` 由 `avatar-parity.test.mjs` 锁死）。**这不是「第二套头像来源」**（C3 禁的是第二套**视觉**表；一张「名字→令牌」映射不定义任何颜色/形状）——但这条边界要在 T-206 的用例里显式钉住，否则 reviewer 会（正确地）怀疑它。

## 7. 新引入技术 / 依赖逐项影响（许可 / 维护 / 学习成本 / 生态）

| 引入项 | 许可 | 维护 | 学习成本 | 生态 / 风险 |
| --- | --- | --- | --- | --- |
| **方案 A**：`team-hub/agent-avatars.mjs` 新增一个静态映射函数 + 一处调用 | **自有代码，无第三方许可**（不新增依赖；TC-S1-10 的 5 个依赖断言不变） | 自持；新增身份补一行（可由 R-8 兜底自动覆盖） | 低：与同文件既有的 `builtinAvatarFor/allocateAvatarToken` 同形 | 无供应链面；风险集中在「观感」（§9 RK-A1）与「表与 R-8 兜底的边界」（§6.5） |
| 方案 A：客户端 general 常量 / S8 解析 | 自有代码 | 自持；需 parity 断言防两端漂移 | 低（沿用既有镜像+parity 先例） | 无 |
| 方案 A：新增测试用例（唯一性、确定性、无非法令牌、不落 roster） | 自有代码 | 随既有 4 个头像套件维护（`agent-avatar` / `surfaces` / `settings` / `avatar-photo` + `avatar-parity`） | 低（`node:test` 直跑，无 jsdom） | 无 |
| **方案 B（若将军选）**：新增图片资产 | **将军提供的图片**：授权/肖像归谁需将军确认（§9 RK-B2）；**不得**从网上下载（C1） | 需要可重现的派生步骤（当前**缺**，§2.5） | 中：要同时改两端资产表 + 双份落盘 + `from/sha256` 留痕 | 每张 ~8 KB，体积可忽略；但「原图不入库、派生物入库」的关系必须登记清楚 |
| 方案 B：派生工具链（若要做成可重现） | 若新增 Node 图像库 ⇒ 违反 C1（TC-S1-10 会红）；若沿用本机外部工具 ⇒ 不可复现 | —— | 中 | **这是方案 B 真正的成本，而不是图片本身** |

**没有任何外部库进入本方案**，因此「许可/维护/学习成本/生态」这一节的结论是：**许可面零变化、供应链零新增**；唯一需要留意的许可是**将军自己提供的新图片**（方案 B）。

## 8. 落点与切片建议（给 T-205 breaker / T-206 / T-207 / T-208 / T-209 / T-210）

### 8.1 文件域建议（互不重叠）

| 切片 | 文件域 | 内容 | 备注 |
| --- | --- | --- | --- |
| ① 服务端令牌与投影 | `team-hub/agent-avatars.mjs`、`team-hub/routes/team-views.mjs` | 静态表 + 未命中兜底 + `:119` 调用改为取令牌 | 与 ② 无文件重叠；R-4/R-5/R-7 的判据落在这里 |
| ② 客户端 general 面 + S8 | `workbench/src/components/Sidebar.tsx`、`WorkspaceNavigation.tsx`（S3）、`SkillsPanel.tsx`、以及放「名字→令牌」常量的位置（建议 `workbench/src/avatar/` 内，与位面表同源） | S2/S3 图形头像 + S8 可选纳入 | 若常量放客户端 ⇒ 必须与 ① 加 parity 断言 |
| ③ 测试 | `team-hub/team-views-routes.test.mjs`、`workbench/scripts/agent-avatar*.test.mjs` 或新增套件 | 见 §8.2 | **③ 依赖 ① 的令牌形态**，需在 ① 冻结后写 |
| ④ 文档同步 | `workbench/README.md`、`docs/FEATURES.md` | 见 §8.4 | 与 ① ② 不冲突 |

### 8.2 两个「必须显式处理」的既有锚点（本阶段实测发现）

| # | 锚点 | 现状 | 为什么必须在拆解里点名 |
| --- | --- | --- | --- |
| **E1** | `team-hub/team-views-routes.test.mjs:137`：`assert.equal(ext.avatar, '⚙️')` | **可执行测试**把现状固化成了期望 | ① 一改就会红。上游 RK-7 只提到了**文档**里的固化（`docs/G-mv1s6y49-1/TEST_CASES.md:181`），没提到**代码测试**里的这一条。这条测试同时是 R-8 的天然用例（它造的是未登记名字 `solo-soldier`）⇒ 应当**改写期望**而不是删除 |
| **E2** | `docs/G-mv7kzgnu-1/REQUIREMENTS.md`（T-203 产出）**缺少历史快照 banner** | `scripts/ci/check-docs.mjs:209-255` 要求 `docs/` 下 `/^G-/` 或 `/-evidence$/` 目录的**每个顶层 `.md`** 都带 `<!-- evidence-banner:start -->` | 本目录匹配 `/^G-/` ⇒ 缺 banner 会让 doc 门禁判红。**这不是本任务的文件**（T-203 的产物，且已在 main），建议由 T-210 devops 用仓库自带工具统一补齐：`node scripts/ci/evidence-banner.mjs`（幂等）。本任务只保证**自己新增的文档**带 banner |

### 8.3 给 T-206 test-designer 的判据来源（可直接转用例）

- 上游 M-1~M-7 与 AC-R1-1/2/3、AC-R2-1/2/3/4、AC-R3-1/2/3、AC-R4-1/2/3、AC-R5-1/2/3/4、AC-R6-1/2/4、AC-R7-1/2/3、AC-R9-1/2/3/4、AC-R10-1/2/3。
- 本文件新增/强化的判据：§2.2 的「合法令牌但无位面 = 占位」反例（防「只看令牌格式」的假绿）；§2.3 的移动端口径修正（用 parity 用例而不是移动端展示用例）；§4.2 的「其它空间令牌逐条不变」；§6.5 的未登记名字兜底与池满降级。
- **必须显式改写**：E1（代码测试）与 `docs/G-mv1s6y49-1/TEST_CASES.md:181`（文档口径，不属本工作区 ⇒ 只在**本目录**写新口径，见上游 §5.1-7）。

### 8.4 给 T-207 / T-208 / T-209 / T-210 的要点

- **T-207 coder**：按 §6 的默认值落地；不要用哈希做主口径；不要动 `role` 机器键、`agent_registry`、`appearanceSeed`、`Employee3D` 调色板。
- **T-208 reviewer 必查**：AC-R4-2（不与内编撞位面）、AC-R7-1（读出口无非法令牌）、AC-R9-2（成员计数不变）、AC-R5-3（纯函数无随机/时钟）、C3（是否偷偷新增了第二套**视觉**表）。
- **T-209 tester**：验收含「§2 枚举脚本复跑（不满足 = 0）」「连续 3 次请求 + 重启后令牌不变」「桌面与移动端同位面 parity」「未登记名字仍拿到头像（R-8）」「其它空间令牌逐条不变」。
- **T-210 devops**：部署后提示**强刷 / 清 Service Worker**（`workbench/mobile/sw.js` 对非代码资源走 cacheFirst，旧页面会残留）；并用仓库工具补齐 E2 的 banner。
- **T-205 breaker**：③ 测试切片必须在 ① 冻结令牌形态后写（否则用例会照着错的令牌写）。

### 8.5 文档同步点（本阶段实测的既有漂移）

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| `workbench/README.md:83` | 「头像为 `human:<role>` 令牌，由 `workbench/src/avatar/` 的参数化人形内联 SVG 确定性渲染（**零图片资源**、非 emoji）」 | **已过期**：2026-10-13 起已有 20 张图片资产（`FEATURES.md:77` 与 `photo-assets.ts` 都记了）。实现阶段顺手更正 |
| `workbench/README.md:86` | 「未入编队但认领了该空间任务的执行者…以「⚙️ xxx · 执行中」合流展示」 | 本轮若改口径，这句要与 `docs/FEATURES.md:78` 一起更新 |
| `docs/FEATURES.md:78` | 同上（`⚙️` 口径） | 同上 |

## 9. 风险与不确定项

| 编号 | 风险 / 不确定 | 影响 | 缓解 / 归属 |
| --- | --- | --- | --- |
| **RK-A1** | 方案 A 是**矢量**人形，与 8 张照片混排；「算不算换上头像」有主观成分（上游术语表已把「矢量人形」定义为算，但将军可能按观感判） | 验收争议 | 先用仓库自带对照图工具肉眼定稿：`node workbench/scripts/render-avatar-sheet.mjs --only=s11,s12,s13,s14,s15`；若将军不接受，走方案 B（❓O-2） |
| **RK-A2** | 5 个空闲位面是**硬上限**；若将军要求「所有后续自建执行者都各不相同」且同时补图，池会不够 | 后续撞脸或被迫扩容 | §6.6 扩容与方案 B 同批做；未扩容前池满走空串降级并在响应里可辨 |
| **RK-A3** | `human:general` 这类「合法但无位面」的令牌会被误判成「已换头像」 | 假绿：功能没生效而验收通过 | §2.2 反例写进用例（R-1 判据必须是「合法 **且** 命中位面」） |
| **RK-A4** | `soldier-auto` 是守护身份、`general` 是人类；给它们普通员工脸可能造成身份误解 | 语义误导 | 默认按 goal 原句给头像；是否加区分标识见 ❓O-1 |
| **RK-A5** | 这些条目是 `done` 任务推导出来的却显示「· 执行中」（`team-views.mjs:119` 固定文案） | 用户对「为什么他们还在」产生新疑问 | 上游 ⚖️D-2 已判「不在本目标做」，另立 bug；本文件不夹带 |
| **RK-A6** | 客户端 general 常量与 `team-hub` 表形成两处真源 | 两端不一致（一个改了一个没改） | §6.7：必须加 parity 断言（既有 `avatar-parity.test.mjs` 先例） |
| **RK-B1** | 方案 B 缺**可重现的 WebP 派生步骤**（无 ffmpeg/magick、无脚本、无图像库） | 「补图」被低估成一行改动 | §2.5 先补工具链或明确接受一次性产物；否则不要把 B 排进本轮 |
| **RK-B2** | 方案 B 的新图片**授权/肖像**归谁 | 法务不确定 | 由将军确认来源与授权；登记进 `photo-assets.ts` 的 `from` 字段（既有留痕机制） |

### 9.1 ❓ 待将军确认（不阻塞本阶段；不臆断）

| 编号 | 问题 | 本文件的默认（不回答则按此推进） |
| --- | --- | --- |
| ❓O-1 | 这 4 个身份（尤其 `general`）要不要与 8 个内编 AI 员工**视觉上区分**（人类 / 守护标识）？ | 默认**不区分**，只保证位面不同（满足 AC-R3-3） |
| ❓O-2 | 接受**矢量人形**作为这 4 个身份的「头像」，还是必须与其余 8 个一样是**照片**？ | 默认**接受矢量**（方案 A）；若必须照片 ⇒ 走方案 B，需要将军提供图片 |
| ❓O-3 | 范围只算 software 的 4 条，还是连 `ozon/soldier-market`（同类缺口第 5 条）一起算？ | 默认**一起覆盖**（同一段代码，成本近零；上游 ⚖️D-3 倾向「实现统一覆盖、验收门槛只算 software」） |

## 10. 引用来源（可查证）

**A 级：本 worktree 实测（file:line + 复现命令）**

- 复现脚本与输出：`docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs`、`docs/G-mv7kzgnu-1/T204-evidence/probe-output.txt`（只读 `team-hub/team.db`；Node v24.19.0）。
- 服务端：`team-hub/routes/team-views.mjs:37,74-84,112-120`、`team-hub/agent-avatars.mjs:13-18,22-40,59-101`、`team-hub/routes/read-models.mjs:192-201,250-264`、`team-hub/routes/agent-intake.mjs:82-92`、`team-hub/scripts/seed-roster.mjs:109-116`。
- 桌面：`workbench/src/avatar/AgentAvatar.tsx:221-243`、`workbench/src/avatar/slots.ts:5-22,60-112`、`workbench/src/avatar/photo-assets.ts:11-21,30-50,54-64`、`workbench/src/avatar/types.ts:28-42`、`workbench/src/components/WorkspaceNavigation.tsx:45,58-63`、`workbench/src/components/Sidebar.tsx:134,174-180`、`workbench/src/components/AgentWorkspace.tsx:112`、`workbench/src/components/SceneAgentList.tsx:13-20`、`workbench/src/components/Employee3D.tsx:50,100,117`、`workbench/src/components/SkillsPanel.tsx:316-320,546,681,793`、`workbench/src/scene/sceneState.ts:49-53,63-77`、`workbench/src/components/SpaceOverview.tsx:25`、`workbench/src/components/TaskDetailModal.tsx:307-312`、`workbench/src/api.ts:864`、`workbench/src/index.css:196-206`。
- 移动端：`workbench/mobile/avatar.mjs:1-10,11-30,39-66,96-114,197-207`、`workbench/mobile/app.mjs:541-563,792`。
- 测试与门禁：`workbench/scripts/agent-avatar.test.mjs:108-127,142-165,230-241,276-285`、`workbench/scripts/avatar-photo.test.mjs:64-101,103-127,129-148`、`workbench/scripts/agent-avatar-surfaces.test.mjs:19-27`、`workbench/scripts/agent-avatar-settings.test.mjs:33-38`、`workbench/mobile/avatar-parity.test.mjs:42-48`、`team-hub/team-views-routes.test.mjs:128-140`（E1）、`scripts/ci/check-docs.mjs:209-255`（E2）、`scripts/ci/evidence-banner.mjs:11-13,85-96`、`scripts/ci/encoding-check.mjs:18-30,46-70`。
- 工具与约定：`workbench/scripts/render-avatar-sheet.mjs:8-29,49-60`、`.gitignore:4-16`。

**B 级：仓库既有文档**

- `docs/FEATURES.md:71-78`（头像口径、迁移命令、对照图）、`workbench/README.md:82-86,93`（展示名/头像/外部执行者口径；:83 已过期，见 §8.5）、`docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:79-83`（身份红线）、`docs/G-mv1s6y49-1/RESEARCH.md`（上一目标的选型与「静态表可证唯一」取舍）、`docs/G-mv1s6y49-1/TEST_CASES.md:181`（TC-S3-07 把 `'⚙️'` 固化为期望 —— 本目标推翻该口径，但**不改该文件**）。

**C 级：上游目标 / 任务记录**

- 目标 `G-mv7kzgnu-1`（objective、contextVersion=0、docsDir=`docs/G-mv7kzgnu-1`）；T-203 产出 `docs/G-mv7kzgnu-1/REQUIREMENTS.md`（commit `7c04b9cf`，2026-10-14 12:14:51 +0800，已在 main）；姊妹目标 `G-mv1s6y49-1` 的将军裁决（contextVersion=1）。

## 11. 本阶段自检（逐条对应任务验收标准）

| 任务验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 方案覆盖需求要点，给出 ≥2 个候选方案对比（优缺点 / 成本 / 风险） | §4（3 个正交决定 + 组合出 A/B/C/D 四个方案）+ §5 对比矩阵（12 维度） | ✅ 4 个候选、12 维度；并逐条映射上游 R-1~R-11 与 ⚖️D/❓O |
| 有明确推荐与理由，依据为真实可查的来源并注明引用 | §0 + §6（推荐 A 的 4 条理由）+ §10（A 级 file:line + 复现命令；B/C 级文档与 commit） | ✅ 每条结论可回溯到 file:line 或可复现命令；**明确标注本阶段无外部来源**（禁联网） |
| 新引入的技术 / 依赖逐项说明影响（许可 / 维护 / 学习成本 / 生态） | §7（方案 A 的 4 项、方案 B 的 2 项逐项四维） | ✅ 结论：许可零变化、供应链零新增；方案 B 的唯一许可点 = 将军提供的新图片 |
| 方案结论可直接支撑后续任务拆解 | §8（文件域 4 切片 + 2 个必改锚点 E1/E2 + 判据来源 + 文档同步点）+ §6 逐项默认值 | ✅ 含 2 条上游未记录、会影响拆解规模的实测发现（E1 可执行测试钉点、E2 banner 缺口） |
| 边界：只调研不实现、不改代码 | 全文 | ✅ 未改任何代码/配置；改动仅限本目标文档目录 `docs/G-mv7kzgnu-1/`（RESEARCH.md + T204-evidence/） |
| 不做无依据的潮流方案 / 不编造数据 | §1（证据分级，D 级 0 条）+ §4.4（沿用上一目标已否决过的哈希形态并说明理由） | ✅ 所有数字都来自实测或 file:line；未引任何厂商对比页 |
| 不确定项列为风险与备选方案 | §5（方案 B/D 作为备选）+ §9（RK-A1~A6、RK-B1/B2）+ §9.1（❓O-1~O-3） | ✅ 观感、授权、派生工具链、客户端两处真源均为显式风险/待确认 |

> 说明：本文件在 **w/T-204 的独立 worktree** 内产出，基线 `22ae3a25`；上游 REQUIREMENTS.md 位于 main 的 `7c04b9cf`（本 worktree 分支尚未包含该提交，故以 commit 引用而非本地路径阅读）。本文件被 promote 后与上游文档同目录共存，互不覆盖。
