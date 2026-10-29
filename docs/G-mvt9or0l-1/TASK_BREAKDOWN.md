# 账号管理（基础信息与账号信息）—— 任务拆解（并行切片）

> 任务：**T-222**（任务拆解 / 破阵）｜所属目标：**G-mvt9or0l-1**（software · active · chain）
> 上游需求：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-220，sha256=`8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f`）
> 上游方案：[RESEARCH.md](./RESEARCH.md)（T-221，sha256=`57965f3cbc8f4eb9648d28a84cd4f4105c8ab83746a96490f3824f8787b80851`）
> 评估基线：**w/T-222 HEAD `60965a78ec9f7ea42f08f1b7e38064d31bd3c350`**（2026-10-29）
> 下游：T-223（测试用例）→ T-224（编码）→ T-225（审查）→ T-226（测试）→ T-227（部署）
> **边界声明**：本阶段只做**拆解**——不写实现、不改任何产品代码、不调用 taskctl/看板写接口、不 push、不联网。文中所有「要点」都是给 T-224 的输入，**不是已落地实现**。
> 历史评论：派工信息为「（无）」，没有将军退回意见需要处理。

---

## 0. 结论速览

**P0（R-01–R-10）拆成 5 个文件域零交叉的垂直切片；P1（R-11–R-13）以「后备切片」形式完整定义但不进机器派工小节。**

| 要点 | 结论 |
| --- | --- |
| 切片数量 | **5 个 P0 切片**（S1–S5），每个 ≈ 一个士兵一轮可完成并独立验收 |
| 文件域交叉 | **0 处**：`grep` 全部 16 个路径，每个文件只属于一个切片（见 §6） |
| 并行形态 | 第 1 波 **S1 ∥ S3**；第 2 波 **S2**；第 3 波 **S4**；第 4 波 **S5**（见 §4） |
| 循环依赖 | **0**（DAG，见 §4） |
| 需求覆盖 | R-01–R-10 全部落到切片；R-11–R-13 落到 P1 后备；R-14 是「不做」清单，不产生任务（见 §4.3） |
| 验收口径 | 每个切片都有**命令 + 期望**；不可自动化的部分明确归 T-226 手工走查，不留「应该没问题」 |
| 方案结论 | 沿用 RESEARCH 方案 A（现有 identity 栈内追加式扩展 + 账号页区块化重组，零新增依赖）；本文件只在**拆解层**做 3 处调整，已逐条登记（§1.4） |

---

## 1. 拆解依据、口径与边界

### 1.1 上游交接已校验（不可替换）

| 上游产物 | 派工登记 sha256 | 本 worktree 实际核对 | 结论 |
| --- | --- | --- | --- |
| `docs/G-mvt9or0l-1/REQUIREMENTS.md`（T-220） | `8e5197be…9f7c7f` | `git show fe163283:docs/G-mvt9or0l-1/REQUIREMENTS.md \| sha256sum` → `8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f` | ✅ 逐字节一致 |
| `docs/G-mvt9or0l-1/RESEARCH.md`（T-221） | `57965f3c…7b80851` | `git show 1a98ace5:docs/G-mvt9or0l-1/RESEARCH.md \| sha256sum` → `57965f3cbc8f4eb9648d28a84cd4f4105c8ab83746a96490f3824f8787b80851` | ✅ 逐字节一致 |
| 工作区文件（CRLF） | — | `sha256sum docs/G-mvt9or0l-1/*.md` 得 `f9cd9241…` / `ccf6e688…` | 差异来自 `core.autocrlf=true` 的换行转换，**内容未替换** |

**结论**：本文件只消费上述两个版本；不引用任何其他目标的同名阶段文档。

### 1.2 本轮实测基线（只读命令，可复读）

| 项 | 实测值 | 命令 |
| --- | --- | --- |
| HEAD | `60965a78ec9f7ea42f08f1b7e38064d31bd3c350` | `git rev-parse HEAD` |
| Node | v24.19.0 | `node --version` |
| workbench 依赖 | **已安装**（`workbench/node_modules` 存在） | `ls workbench/` |
| 工作区状态 | `git status --short` 无输出（干净，无 WIP 提交） | `git status --short` |
| 账号相关新文件是否已存在 | `workbench/src/accountProfile.ts`、`workbench/scripts/account-profile.test.mjs`、`team-hub/identity-profile.test.mjs` **均不存在** | `ls workbench/src/*account* workbench/scripts/*account* team-hub/*profile*`（只命中 `team-hub/profile-derivation.mjs`，是模型档案域，与本目标无关） |
| 指纹文件（本切片不得改） | `team-hub/user-store.mjs`、`team-hub/routes/identity.mjs`、`workbench/src/identity.ts`、`AccountPanel.tsx`、`DevicePanel.tsx`、`WorkspaceSettings.tsx`、`index.css`、`identity-gate.test.mjs`、`docs/FEATURES.md`、`README.md`、`workbench/mobile/app.mjs` **均存在** | `ls` |

> **能力声明**：本阶段**不能**执行 `node scripts/...`、`pnpm ...`、`node --test ...`（权限层拒绝 unattended approval，返回 “cannot request human approval”）。可执行并可复读的只有 `git` / `ls` / `sha256sum` / `grep`。因此本文件不含任何运行时读数；§7 的每条命令都是交给 T-224/T-226 **真实执行**的清单，不是本轮已执行结果。**不得把「未运行」当成「通过」。**

### 1.3 拆解原则（本轮实际使用的 6 条）

1. **一个切片 = 一个可独立验收的垂直单元**：能单独跑命令判定绿/红，不要求读者自己拼证据。
2. **文件域零交叉**：同一文件只写进一个切片的第三段；这是并行派工的唯一依据，也是合并冲突的唯一边界。
3. **契约先行**：字段名、错误码、状态码在 REQUIREMENTS §7.3/§7.4 已冻结，因此前端切片可以不等后端合并就按契约开工（见 §1.4 差异 ②）。
4. **P0 / P1 分开**：P1 不得阻塞 P0（需求 §12.1、A10），因此 P1 不占用本轮机器派工位（见 §6）。
5. **每条验收都能落到命令 + 期望**；确实只能人工判断的（视觉/键盘/读屏）明确交给 T-226 手工走查并写进 TEST_REPORT。
6. **不新增依赖、不新增构建步骤**（`docs/DEPLOY.md:49`、需求 R-10）：切片的验收命令只用仓库已有的 `node --test` / `pnpm --dir workbench build` / `check-docs`。

### 1.4 与 RESEARCH §8 的三处拆解层差异（逐条登记，不改方案结论）

| # | RESEARCH §8 的建议 | 本拆解 | 理由 |
| --- | --- | --- | --- |
| ① | S2→S3「前端类型与错误码跟随服务端契约」列为**硬依赖** | S3 与 S1/S2 **并行**（第 1 波） | 契约已在 REQUIREMENTS §7.3/§7.4 冻结（字段名、状态码、错误码全给定），S3 消费的是**文档**而不是 S2 的合并结果；并行不改变任何接口语义。若 S2 实现中确需改字段名，属于需求级变更，必须回 REQUIREMENTS 改版本，届时 S3 同步。 |
| ② | 测试文件 `identity-profile.test.mjs` 同时承载仓储与 HTTP 用例 | 拆成两个文件：`team-hub/identity-profile-store.test.mjs`（S1）+ `team-hub/identity-profile.test.mjs`（S2） | 同一文件若跨两个切片，两轮 worker 会在同一测试文件上互相覆盖；拆开后每个切片都能独立跑绿。 |
| ③ | 8 个切片全部平铺为派工切片（含 P1 三项） | P0 五项进 `## slices`；P1 三项写进 §6「后备切片」，P0 全绿后另行登记 | P1 的全部文件（`user-store.mjs`、`routes/identity.mjs`、`AccountPanel.tsx`、`identity.ts`…）**必然**与 P0 切片重叠；若同批注册，P1 worker 会与 P0 抢同一批文件，并违反 A10「P1 不得在 P0 全绿前开工」。后备切片已备齐四要素（文件域/验收/blockedBy/工作量），登记即可开工。 |

> 三处差异都在**拆解层**（谁来改、何时改、测试放哪），不改变需求的语义、不改变 RESEARCH 的方案 A 结论、不改变任何接口契约。

---

## slices

- S1 | 服务端数据与仓储：display_name 追加列与 updateProfile | team-hub/user-store.mjs, team-hub/identity-profile-store.test.mjs | `node --test team-hub/identity-profile-store.test.mjs` exit 0（旧数据回退用户名、trim、1 与 64 边界通过、65 字符拒绝、C0 控制字符与换行拒绝、未知字段与非对象请求拒绝、后写覆盖返回最终值、审计 identity:profile-update 与资料同事务、旧库 ensureColumn 补列幂等、停用账号拒绝写入）；`node --test team-hub/user-store.test.mjs` exit 0（0 回归）；`grep -c "INSERT INTO hub_users VALUES" team-hub/user-store.mjs` 输出 0（3 处位置式 INSERT 已改显式列名）
- S2 | 服务端 HTTP 契约：/me 追加字段与 POST /api/identity/profile | team-hub/routes/identity.mjs, team-hub/identity-profile.test.mjs | `node --test team-hub/identity-profile.test.mjs` exit 0（/me 的 userId 与 name 名字与类型不变且新增 displayName/avatar/createdAt/disabled、profile 返回 200 并以服务端最终值回填、400 IDENTITY_INVALID_INPUT 覆盖未知字段与非对象与非法 JSON 与缺字段、401 具名码齐全、请求体里的 userId 不改变目标且数据未变、非管理员 GET /users 返回 403、停用账号携带旧令牌请求返回 401）；`node --test team-hub/identity-remote.test.mjs` exit 0
- S3 | 前端身份 API 与账号纯函数 | workbench/src/identity.ts, workbench/src/accountProfile.ts, workbench/scripts/account-profile.test.mjs | `node --test workbench/scripts/account-profile.test.mjs` exit 0（显示名校验与服务端同一批输入同结果、旧数据投影回退用户名、活跃会话数排除 revoked、执行设备数按 userId 过滤、identity.ts 的 401 单飞重放与 IDENTITY_WRONG_PASSWORD 不触发刷新的源码断言）；`pnpm --dir workbench build` exit 0（tsc --noEmit + vite build）
- S4 | 账号页 UI 重组：区块化容器与执行设备归位 | workbench/src/components/AccountPanel.tsx, workbench/src/components/DevicePanel.tsx, workbench/src/components/WorkspaceSettings.tsx, workbench/src/index.css, workbench/scripts/identity-gate.test.mjs, workbench/scripts/account-page.test.mjs | `node --test workbench/scripts/identity-gate.test.mjs` exit 0（⑦⑧⑨⑩⑪⑫⑬⑭⑱ 逐条仍绿，⑱ 的锚点按新结构等价更新）；`node --test workbench/scripts/account-page.test.mjs` exit 0（七区块顺序齐全、区块独立错误态与重试、本机机器令牌模式整块不渲染、非管理员不渲染账号管理区且不请求 /users、用户名标注登录名不可修改、显示名纯文本渲染、结果经 aria-live 播报、当前会话无撤销按钮）；`pnpm --dir workbench build` exit 0
- S5 | 文档、手机端注释口径与全量回归 | docs/FEATURES.md, README.md, workbench/mobile/app.mjs | `node scripts/ci/check-docs.mjs` 的 FAIL 行中不出现 README.md 与 docs/FEATURES.md（相对改动前基线零新增）；`node --test team-hub/mobile-api-contract.test.mjs` exit 0；`grep -c "登录用户名" workbench/mobile/app.mjs` 输出大于等于 1（name 的注释口径已改为登录用户名、不可修改）；需求 §9.2 的全部命令逐条 exit 0 并在证据里登记命令与输出要点

---

## 2. 切片总表（人读：依赖 / 工作量 / 完成定义）

| 切片 | 标题 | blockedBy | 工作量估计 | 完成 = 什么 | 对应需求 / AC |
| --- | --- | --- | --- | --- | --- |
| S1 | 服务端数据与仓储 | 无（只消费已冻结的需求契约） | **L，4–6 h**（1 轮） | 服务端能独立读写 displayName：追加列幂等、旧数据回退、校验与错误码具名、审计与资料同事务、3 处位置式 INSERT 改显式列名、store 测试全绿 | R-02、R-08；AC-03、AC-04（数据面）、AC-05 |
| S2 | 服务端 HTTP 契约 | S1（需要 store 的投影与 updateProfile） | **M，2–3 h** | HTTP 层与需求 §7.3/§7.4 逐字段一致；越权、停用、非法 JSON、未知字段的「请求 + 响应 code + 数据未变」三件套齐备 | R-03（服务端读数）、R-07、R-08；AC-02、AC-04、AC-05、AC-10 |
| S3 | 前端身份 API 与账号纯函数 | 无（契约已冻结，可与 S1/S2 并行） | **M，3–4 h** | `MeInfo` 扩展、`updateProfile`、`accountProfile.ts` 校验与投影/计数纯函数、401 单飞重放就位；纯函数测试与 typecheck 绿 | R-02、R-03（计数口径）、R-08、R-09（401）；AC-02、AC-04、AC-05、AC-11（会话恢复部分） |
| S4 | 账号页 UI 重组 | S3（import 其导出）；S2（契约已冻结，可先按文档写） | **L，5–7 h** | 账号页七区块齐全且顺序正确；加载/空/错误/重试/忙碌/播报可用；本机模式整块不渲染；非管理员不请求管理员数据；既有 identity-gate 守卫不回归 | R-01、R-04、R-05、R-06、R-07、R-09；AC-01、AC-07、AC-08、AC-09、AC-11 |
| S5 | 文档、手机端注释与回归 | S1、S2、S3、S4 | **M，2–3 h** | FEATURES/README 与实现一致；手机端 name 注释口径修正；§9.2 全量回归有逐条读数（exit code + 输出要点） | R-10；AC-12、AC-16 |

> 工作量口径：以「一个士兵一轮（一次会话）」为上限。S1/S4 是 L 级但都在一轮内；若实际超出，**不拆新切片**，而是在报告里说明并申请下一轮（避免临时新增文件域）。

---

## 3. 依赖与并行关系

### 3.1 波次图（无环）

```text
第 1 波：  S1（服务端数据）        S3（前端 API + 纯函数）
              │                      │
              ▼                      │
第 2 波：  S2（HTTP 契约）            │
              │                      │
              └──────────┬───────────┘
                         ▼
第 3 波：              S4（账号页 UI）
                         │
                         ▼
第 4 波：              S5（文档 + 回归）
```

- **S1 与 S3 可完全并行**：一个改 `team-hub/`，一个改 `workbench/src/`，文件域不相交，输入都是已冻结的契约文档。
- **S2 依赖 S1**：`/me` 的投影与 `updateProfile` 在 store 层；S2 的 HTTP 用例直接调用它们。
- **S4 依赖 S3**：`AccountPanel` 要 `import { updateProfile }`、`AccountPageState` 与计数纯函数；`DeviceRow.userId` 也由 S3 补。
- **S5 最后**：文档与回归必须基于真实行为；先跑基线再跑改动后，diff 出「新增失败」。

### 3.2 为什么不是「全部串行」也不是「全部并行」

- 串行（RESEARCH §8 的原始链）会把「前端纯函数 + 源码扫描」这类**不需要后端就能验**的活压到后面，浪费一个完整轮次。
- 全部并行会让 S4 依赖 S3 的导出、S5 依赖全部行为，出现「先写 UI 再补 API」的返工。
- 因此取中间形态：**唯一的两条真依赖（S1→S2、S3→S4）保留，其余并行**。

### 3.3 需求 → 切片覆盖表（无遗漏）

| 需求 | 承接切片 | 说明 |
| --- | --- | --- |
| R-01 信息架构与入口 | S4 | 七区块顺序、路由 id 不变、本机模式不渲染 |
| R-02 显示名 | S1（存储与校验）、S2（写接口）、S3（客户端 API 与校验纯函数）、S4（编辑 UI） | 四层各管一段，验收各自可独立跑 |
| R-03 账号信息总览 | S3（计数与投影口径）、S4（展示与缺失值/错误态） | 服务端不新增聚合端点（RESEARCH §4.2 否决 B 的聚合方案） |
| R-04 改口令 | S4（保留语义、集中到「账号安全」） | 服务端不改；AC-07 由 T-226 走查 + 既有测试兜底 |
| R-05 登录会话 | S4（保留列表与撤销） | 同上 |
| R-06 退出登录 | S4 | 同上 |
| R-07 权限与自我边界 | S2（服务端强制）、S4（不渲染/不请求） | 服务端是唯一安全边界 |
| R-08 校验与错误契约 | S1、S2、S3 | store 校验 → 路由映射 → 前端按 code 分支 |
| R-09 加载/空/错误/无障碍 | S3（401 单飞重放）、S4（区块态与播报） | 无 jsdom，交互部分交 T-226 走查 |
| R-10 回归与兼容 | S2（追加式字段）、S5（全量回归与文档） | `/me` 旧字段名字与类型不变 |
| R-11 头像（P1） | §7 后备 P1-S1 | 不进本轮派工 |
| R-12 显示名传播（P1） | §7 后备 P1-S2 | 同上 |
| R-13 最近登录（P1） | §7 后备 P1-S3 | 同上 |
| R-14 后续候选（P2） | **不产生任务** | 需求已明确不做；若要做必须另立目标 |

---

## 4. 切片开工卡（下游拿到即可开工）

### 4.1 S1 服务端数据与仓储

- **允许改的文件**：`team-hub/user-store.mjs`（改）、`team-hub/identity-profile-store.test.mjs`（新增）。
  - `team-hub/schema-util.mjs` **只 import 不改**（`ensureColumn` 已有，见 `:65-90`）。
- **关键输入**（来自 RESEARCH §7.1–§7.4 的实测行号）：
  - 建表：`user-store.mjs:239-243`（`hub_users` 七列，无 display_name）。
  - 位置式 INSERT 三处：`:358`（引导 owner）、`:409`（接受邀请）、`:1088`（自助注册）——**这是本切片第一件事**，见 §8 RK-M1。
  - 投影：`publicUser` `:327-332`、`listUsers` `:1231-1235`；读取都是 `SELECT *`（`:322`、`:802`、`:1232`），新列自动带上。
  - 审计：`record` `:311-314`（**吞异常**）；改口令的严格事务范例 `:1179-1202`。
  - 校验口径：`validateName` `:153-158`（trim + ≤64，UTF-16 code unit）。
  - 错误码表：`IDENTITY_CODES` `:72-102`（`INVALID_INPUT`、`USER_NOT_FOUND`、`SESSION_REVOKED` 等已存在，**不新增枚举**）。
- **要点**：
  1. 建表语句加 `display_name TEXT`；老库用 `ensureColumn(db, 'hub_users', 'display_name', 'TEXT')` 补列（幂等/并发安全）。
  2. 三处位置式 INSERT 改**显式列名**（同时兼容新库与老库；不依赖 SQLite 的隐式列数语义）。
  3. 投影回退：`displayName: (row.display_name ?? '').trim() || row.name`；`avatar` 固定 `''`（P0 契约先稳）。
  4. 新增 `updateProfile({ userId, displayName, by, audit })`（名字可调，语义固定）：
     - 输入必须是 `string`；**先**查 C0（U+0000–U+001F、U+007F，含换行）→ `INVALID_INPUT`；再 `trim()`；长度 1–64；
     - 只更新 `display_name`，**不碰** `name`/`name_key`/`password_hash`/`disabled_at_ms`/`system_role`/`hub_space_roles`；
     - 一个 `withTx` 内完成「读旧值 → 更新 → 审计 → 返回最终行」；审计动作 `identity:profile-update`，detail `{ fields: ['displayName'], from, to }`；**不记录**口令/令牌/哈希；
     - 审计必须**严格**（本路径不吞异常，失败整事务回滚）——只对本路径严格，不改其他动作的 best-effort 语义（RK-A1）；
     - 停用账号：`requireUser` 后若 `disabled_at_ms !== null` → `SESSION_REVOKED`（与 `/me` 的停用语义一致）。
  5. 导出清单（`:1250-1271`）追加 `updateProfile`。
- **禁止**：不新增表（否决 RESEARCH §4.2 B）、不加 `NOT NULL`、不改 `validateName`、不改口令/会话/邀请/设备任何路径。
- **验收**：见 `## slices` S1 行；另外 `node --test team-hub/identity-registration.test.mjs` 与 `node --test team-hub/account-quota.test.mjs` 必须仍 exit 0（注册/引导走 INSERT 路径，是本切片最直接的回归面）。
- **完成定义**：上述命令全绿，且 `grep -c "INSERT INTO hub_users VALUES"` 为 0；store 测试覆盖「旧库无列 → 补列 → 读取回退用户名」的完整链路。

### 4.2 S2 服务端 HTTP 契约

- **允许改的文件**：`team-hub/routes/identity.mjs`（改）、`team-hub/identity-profile.test.mjs`（新增）。
- **关键输入**：
  - `/me` 现状 `identity.mjs:397-407`；`withUser` `:239-265`；错误映射 `:31-35`。
  - `requireString` 缺参数抛 `MISSING_PARAM`（`server.mjs:7793-7799`）——**不能用**它做本接口校验（R-08 要求 `IDENTITY_INVALID_INPUT`）。
  - `readBody` 的非法 JSON 变成普通 `Error`（`server.mjs:7706-7716`）——本路由要捕获并映射。
  - 测试夹具：`identity-remote.test.mjs:1-32`（临时 `TEAM_HUB_DB` + `import server.mjs` + `listen(0)` + `fetch`）。
- **要点**：
  1. `GET /api/identity/me`：保留 `user.userId` / `user.name` / `roles` / `systemRole` 的名字与类型；追加 `displayName`/`avatar`/`createdAt`/`disabled`（复用 `publicUser` 的字段语义，读的是同一行）。
  2. 新增 `POST /api/identity/profile`：
     - `withUser` 解析 userId（请求体里的 `userId`/`name`/`nameKey`/`password` 一律按**未知字段**拒绝→ 400 `IDENTITY_INVALID_INPUT`）；
     - 请求体必须普通对象；允许键集合 P0 = `{displayName}`；缺字段→ 400；
     - 200 返回 `{ ok:true, user:{ userId, name, displayName, avatar, createdAt, disabled } }`，值取服务端最终行（后写覆盖）。
  3. **停用账号**：`withUser` 已拒绝停用账号的访问令牌（`SESSION_REVOKED`）——用例要钉住，不要重复实现鉴权。
- **禁止**：不新增聚合端点（RESEARCH §4.2 否决）；不改 `/users`、`/sessions`、`/password`、`/devices`；不在路由里做业务校验的第二份实现（校验只在 store，路由只做「形状 + 白名单 + 错误映射」）。
- **验收**：见 `## slices` S2 行。越权用例必须给出「请求 + 响应 code + 数据未变」三件套（需求 §9.4）。
- **完成定义**：HTTP 用例覆盖 §7.3/§7.4 的每个字段与每个错误码；`identity-remote.test.mjs` 不回归；用临时库，**不碰 live `team.db`**。

### 4.3 S3 前端身份 API 与账号纯函数

- **允许改的文件**：`workbench/src/identity.ts`（改）、`workbench/src/accountProfile.ts`（新增）、`workbench/scripts/account-profile.test.mjs`（新增）。
- **关键输入**：
  - `MeInfo` `identity.ts:57-62`；`fetchMe` `:281-289`（**目前不调用 `recoverSession()`**）；单飞恢复 `:262-279`；存储键 `:33-38`。
  - `DeviceRow` `:388-397`（服务端实际返回 `userId`，`device-store.mjs:208`，类型里没有）。
  - 纯函数测试范式：`workbench/scripts/external-avatar-parity.test.mjs:1-30`（`ts.transpileModule` 直跑 TS，零新增依赖）。
- **要点**：
  1. `MeInfo` 追加 `displayName`/`avatar`/`createdAt`/`disabled`（保留原字段）；`fetchMe` 做投影，`displayName` 缺失时回退 `name`（前端兜底，**以服务端为准**）。
  2. 新增 `updateProfile({ displayName }): Promise<MeInfo['user']>`，按 `IdentityRequestError.code` 分支。
  3. 新增 `workbench/src/accountProfile.ts`：
     - `validateDisplayName(input): { ok: true, value } | { ok: false, message }`（与服务端同一批规则：先 C0、再 trim、1–64）；
     - `accountSummary(me, sessions, devices)`：活跃会话数 = `revoked !== true` 的数量；执行设备数 = `!revoked && userId === me.userId` 的数量（**管理员 `/devices` 返回全部**，RK-C1）；
     - `formatCreatedAt(iso)` 或等价投影（本地时区展示，原始 ISO 保留）。
  4. **401 单飞重放**：只在身份读/资料写上做**窄条件**重放——`code ∈ {IDENTITY_TOKEN_EXPIRED, IDENTITY_TOKEN_MISSING}` 且存在刷新凭据 → `await recoverSession()` → 重放一次；**排除** `/api/identity/refresh` 与 `/api/identity/login`；**不得**把 `IDENTITY_WRONG_PASSWORD`（401）当过期去刷新（R-04）。
  5. `DeviceRow` 追加可选 `userId?: string`。
- **禁止**：不改 `api.ts`（`fetchWithSessionRetry` 已存在，账号页走 identity.ts 自己的包装）；不改任何组件；不引入校验库（RESEARCH §4.5 否决 zod/valibot）。
- **验收**：见 `## slices` S3 行。纯函数测试必须与服务端用例用**同一批输入**（空、全空白、64、65、字面 U+0000、换行、`<img onerror>`），两侧结论一致。
- **完成定义**：`node --test workbench/scripts/account-profile.test.mjs` 绿 + `pnpm --dir workbench build` 绿；`identity.ts` 的导出面足够 S4 直接 import，不需要 S4 回改本切片文件。

### 4.4 S4 账号页 UI 重组

- **允许改的文件**：`workbench/src/components/AccountPanel.tsx`（改）、`DevicePanel.tsx`（改）、`WorkspaceSettings.tsx`（改）、`workbench/src/index.css`（改）、`workbench/scripts/identity-gate.test.mjs`（改）、`workbench/scripts/account-page.test.mjs`（新增）。
- **关键输入**：
  - 现状面板 `AccountPanel.tsx:34-63`（读取与克制）、`:116-221`（六节渲染）；`DevicePanel.tsx:35-54`、`:85-151`；挂载 `WorkspaceSettings.tsx:21-24`。
  - 既有结构守卫 `workbench/scripts/identity-gate.test.mjs`（⑦⑧⑨⑩⑪⑫⑬⑭⑱ 必须继续守；⑱ 的锚点可等价更新，**不得删掉这条语义**）。
  - 样式落点：`index.css`（`settings-card`/`settings-session-row`/`settings-runtime-status` 已在 `:3744-3759`；**不要**改压缩长行的 `workspace.css`）。
- **要点**：
  1. `AccountPanel` 变成容器：`Promise.allSettled([fetchMe(), listSessions(), listDevices()])`；每路失败只影响对应区块，错误态带「重试」，不清空其它路（R-01 §最后一条）。
  2. 区块顺序：账号摘要 → 基础信息（显示名编辑）→ 账号信息 → 账号安全（改口令 + 退出登录）→ 登录中的设备 → 执行设备（`DevicePanel` 保留全部动作）→ 账号管理（仅 `systemRole === 'admin'`）。
  3. 用户名标注「登录名，不可修改」；显示名默认值来自服务端投影；保存后用**服务端返回值**回填，不用本地草稿。
  4. 本机机器令牌模式（`!hasSession()`）整块不渲染——判据与现有 `const active = hasSession()`、`if (!active && loaded) return null` 同源。
  5. 非管理员**不调用** `/users`（沿用 `AccountPanel.tsx:53-55` 的克制；identity-gate ⑱ 守着这条）。
  6. 无障碍：可见 `<label>`、忙碌禁用防重复、页内 `role="status" aria-live="polite"` 播报保存/撤销结果（不改全局 `Toast.tsx`）；状态不用颜色单独表达；长显示名不撑破布局。
  7. `WorkspaceSettings` 只挂 `AccountPanel`（内部含 `DevicePanel`），避免同页重复挂载；`settings-connections` 路由 id 与 hash 不变（标题可改）。
- **禁止**：不改 `identity.ts`/`accountProfile.ts`（S3 的域）；不改移动端 IA；不改 `roster`/Agent 头像；不引入组件库/CSS 框架。
- **验收**：见 `## slices` S4 行。`account-page.test.mjs` 用源码扫描 + `react-dom/server`（仓库已有范式，无 jsdom）断言结构与文案；真实交互（键盘、读屏、双浏览器会话）交 T-226 走查。
- **完成定义**：三条命令绿；identity-gate 的 18 条断言一条不少（更新锚点要在提交说明里逐条写明「哪条、为什么、语义等价性」）。

### 4.5 S5 文档、手机端注释与全量回归

- **允许改的文件**：`docs/FEATURES.md`（改）、`README.md`（改）、`workbench/mobile/app.mjs`（**仅注释**）。
- **关键输入**：
  - FEATURES 索引形状：`F-23 | 手机端 PWA… | 3.22 … | 手机浏览器… | 已上线`（`docs/FEATURES.md:349-356`），每行 5 列、状态枚举合法、锚点必须是真实标题、正文 ≥5 行且含「入口」或「操作」（`scripts/ci/check-docs.mjs:6-9`）。
  - README 互链形状：`docs/FEATURES.md#<锚点>`（`README.md:22,93,139` 等）。
  - 手机端口径漂移：`workbench/mobile/app.mjs:232-240` 把 `name` 注释成「显示名、可以改」，与本目标「用户名不可改」冲突（RK-M3）。
- **要点**：
  1. FEATURES 增加 F-24「账号与登录管理」（标题/锚点/入口/状态按实际；状态建议「迭代中」或「已上线」，与实现一致），正文写清：入口路径、显示名可改/用户名不可改、会话与执行设备的区别、管理员能力边界、P1 项未完成的登记口径。
  2. README 只加一行入口，不复制大段细节（check-docs 第 5 项：≥3 行逐字重复块 = 0）。
  3. `mobile/app.mjs:232-240` 注释改为「`name` 是登录用户名，不可修改；显示名是 `displayName`」，**不改任何逻辑**（手机端 IA 不变，A6）。
  4. 回归：按团队技能「回归复跑先查上游验证防空转」——先读 T-221/RESEARCH 的基线读数，若某套件上游已登记则可直接引用不重复造；本轮变更相关套件必须真跑并登记。
- **禁止**：不改 `docs/G-mvt9or0l-1/REQUIREMENTS.md` / `RESEARCH.md`（冻结的上游交接物，改了就破坏 sha256）；不改手机端视图/逻辑；不改其他目标目录文档。
- **验收**：见 `## slices` S5 行 + §7 全量命令。
- **完成定义**：文档与实现逐条对得上（入口、字段、可改/不可改、边界）；§7 每条命令有 exit code 与输出要点；任何 skip 必须写明原因（缺依赖/无浏览器/无探针账号），不得用「未运行」冒充「通过」。

---

## 5. 文件域归属总表（每个文件只属于一个切片）

| 文件 | 所属切片 | 动作 | 说明 |
| --- | --- | --- | --- |
| `team-hub/user-store.mjs` | S1 | 改 | 追加列/投影/updateProfile/严格审计/3 处 INSERT 改显式列名 |
| `team-hub/identity-profile-store.test.mjs` | S1 | 新增 | 仓储与迁移用例（内存库夹具，仿 `user-store.test.mjs:26-63`） |
| `team-hub/routes/identity.mjs` | S2 | 改 | `/me` 追加字段 + `POST /api/identity/profile` |
| `team-hub/identity-profile.test.mjs` | S2 | 新增 | 真实 HTTP 用例（临时 DB + `listen(0)`，仿 `identity-remote.test.mjs:1-32`） |
| `workbench/src/identity.ts` | S3 | 改 | `MeInfo` 扩展、`updateProfile`、401 单飞重放、`DeviceRow.userId` |
| `workbench/src/accountProfile.ts` | S3 | 新增 | 显示名校验、账号摘要/计数/时间投影纯函数 |
| `workbench/scripts/account-profile.test.mjs` | S3 | 新增 | 纯函数边界 + 投影/计数 + identity.ts 401 源码断言 |
| `workbench/src/components/AccountPanel.tsx` | S4 | 改 | 容器 + 七区块重组 |
| `workbench/src/components/DevicePanel.tsx` | S4 | 改 | 保留全部动作；可接受 `devices`/`onReload` props（未传时自取，向后兼容） |
| `workbench/src/components/WorkspaceSettings.tsx` | S4 | 改 | 只挂 `AccountPanel`，路由 id 不变 |
| `workbench/src/index.css` | S4 | 改 | 账号页新增样式（不动 `workspace.css`） |
| `workbench/scripts/identity-gate.test.mjs` | S4 | 改 | 18 条既有守卫按新结构等价更新，语义不得减少 |
| `workbench/scripts/account-page.test.mjs` | S4 | 新增 | 账号页结构/文案/无障碍源码断言 |
| `docs/FEATURES.md` | S5 | 改 | 新增 F-24 与正文 |
| `README.md` | S5 | 改 | 一行入口 |
| `workbench/mobile/app.mjs` | S5 | 改（仅注释） | 修正 `name` 的口径漂移 |

**明确不碰（任何切片都不得写）**

| 路径 | 理由 |
| --- | --- |
| `team-hub/schema-util.mjs` | S1 只 import `ensureColumn`，该原语的并发/幂等语义已由 `approval-binding.test.mjs:537-545` 钉住 |
| `team-hub/agent-avatars.mjs`、`workbench/src/avatar/**` | Agent/roster 头像域（T-195）；账号头像只在 P1 用**独立字段与白名单** |
| `team-hub/roster*`、任何编队/成员配置 | 需求 §5.2 明令不写 `roster` |
| `workbench/src/components/Toast.tsx` | P0 用页内 `aria-live`，不动全局 Toast |
| `workbench/mobile/**` 的视图与逻辑 | 手机端 IA 不变（A6）；S5 只改注释 |
| `docs/G-mvt9or0l-1/REQUIREMENTS.md`、`RESEARCH.md` | 冻结的上游交接物（sha256 已登记） |
| `docs/` 下其他目标目录、仓库根同名阶段文档 | 会与他人合入冲突 |

---

## 6. P1 后备切片（本轮不注册，P0 全绿后另行登记）

> 为什么不在 `## slices` 里：P1 的全部文件（`user-store.mjs`、`routes/identity.mjs`、`AccountPanel.tsx`、`index.css`、`identity.ts`）**必然**与 P0 切片重叠。若同批注册，P1 worker 会与 P0 抢同一批文件；而需求 A10 明确「P1 不得在 P0 全绿前开工」。因此把 P1 写成**四要素齐备的后备切片**：P0 全绿（S1–S4 的验收命令全绿）后，按下面表格原样登记即可派工。
>
> P1 未完成时必须在 `TEST_REPORT.md` 登记为后续，**不得**在 FEATURES/报告中伪装成 P0 完成（需求 §9.1、§12.3）。

| 后备切片 | 内容 | 文件域（登记时原样写入） | blockedBy | 工作量 | 验收（命令 + 期望） |
| --- | --- | --- | --- | --- | --- |
| P1-S1 | 账号头像：`human:<key>` 白名单选择器（不做上传） | `team-hub/user-store.mjs`, `team-hub/routes/identity.mjs`, `team-hub/account-avatars.mjs`, `team-hub/identity-profile-store.test.mjs`, `team-hub/identity-profile.test.mjs`, `workbench/src/accountProfile.ts`, `workbench/scripts/account-profile.test.mjs`, `workbench/src/components/AccountPanel.tsx`, `workbench/src/index.css`, `workbench/scripts/account-avatar-parity.test.mjs` | P0 全绿（S1–S4） | M–L，4–6 h | `node --test team-hub/identity-profile-store.test.mjs` 与 `node --test team-hub/identity-profile.test.mjs` exit 0（合法令牌持久化、非法令牌/emoji/URL/HTML 一律 400、空值=默认占位）；`node --test workbench/scripts/account-avatar-parity.test.mjs` exit 0（服务端白名单与 `workbench/src/avatar/slots.ts` 40 键逐项相等）；`grep -rn "roster" team-hub/account-avatars.mjs workbench/src/accountProfile.ts` 无写入 roster 的路径 |
| P1-S2 | 显示名在「当前用户」展示面传播（登录/审计/用户列表仍用用户名） | `workbench/src/components/AccountPanel.tsx`, `workbench/mobile/app.mjs`, `workbench/scripts/account-page.test.mjs` | P0 全绿；在 P1-S1 之后（同改 AccountPanel.tsx，串行） | S，1–2 h | `node --test workbench/scripts/account-page.test.mjs` exit 0（当前用户展示面用 displayName；登录页/审计 actor 仍用 name）；`node --test team-hub/mobile-api-contract.test.mjs` exit 0（手机端展示字段改动不破坏契约） |
| P1-S3 | 最近登录记录（最近 5 条，含已撤销/过期状态） | `workbench/src/components/AccountPanel.tsx`, `workbench/src/identity.ts`, `workbench/scripts/account-profile.test.mjs`, `workbench/scripts/account-page.test.mjs` | P0 全绿；可与 P1-S2 串行 | S–M，2–3 h | `node --test workbench/scripts/account-profile.test.mjs` exit 0（状态派生：当前/活跃/已撤销/已过期；已撤销不计入活跃数）；`node --test workbench/scripts/account-page.test.mjs` exit 0（最多 5 条、无 IP/地理/指纹字段） |

> P1 三者的文件域**互相重叠**（都改 `AccountPanel.tsx`）：登记时按 P1-S1 → P1-S2 → P1-S3 的顺序串行，不要同批并行。

---

## 7. 全局验收与回归命令（T-224 / T-226 在仓库根执行）

```bash
# 1) 既有身份/用户/会话/配额套件（回归面）
node --test team-hub/user-store.test.mjs
node --test team-hub/identity-registration.test.mjs
node --test team-hub/identity-registration-limit.test.mjs
node --test team-hub/identity-rate-limit.test.mjs
node --test team-hub/identity-remote.test.mjs
node --test team-hub/account-quota.test.mjs
node --test team-hub/mobile-api-contract.test.mjs

# 2) 新增服务端套件（S1 / S2 物化）
node --test team-hub/identity-profile-store.test.mjs
node --test team-hub/identity-profile.test.mjs

# 3) 桌面端类型检查 + 生产构建（tsc --noEmit && vite build）
pnpm --dir workbench build

# 4) 前端结构/纯函数套件（S3 / S4 物化）
node --test workbench/scripts/identity-gate.test.mjs
node --test workbench/scripts/account-profile.test.mjs
node --test workbench/scripts/account-page.test.mjs

# 5) 文档门禁（改了 README/FEATURES 时）
node scripts/ci/check-docs.mjs
```

期望与口径：

| 命令组 | 期望 | 备注 |
| --- | --- | --- |
| 1) 既有 7 套 | 全部 **exit 0** | 任一套红即为回归，必须定位到本目标改动 |
| 2) 新增 2 套 | 全部 **exit 0** | 用临时 DB / 内存库；**不在 live `team.db` 上写** |
| 3) 构建 | **exit 0** | `workbench/node_modules` 本 worktree 实测存在；若下游 worktree 缺失，按 RK-9 记为 blocked，**不得联网安装** |
| 4) 前端 3 套 | 全部 **exit 0** | 无 jsdom；真实交互（键盘/读屏/双浏览器）由 T-226 手工走查并截图 |
| 5) 文档门禁 | **README.md 与 docs/FEATURES.md 的 FAIL 行为 0**（相对改动前基线零新增） | 见 RK-E1：该脚本当前对 `docs/G-*/` 的历史 banner 规则存在**预存红**，不在本目标文件域内，不要为了让脚本全绿去改别的目标的文档 |

**手工走查（T-226，三类身份各一遍）**：普通成员 / 系统管理员 / 本机机器令牌模式，覆盖 J1–J5（登录 → 账号页读数 → 改显示名 → 刷新与重登 → 改口令 → 踢会话 → 退出 → 本机模式无账号区）。

---

## 8. 风险与环境前置（交给下游的「别踩」清单）

| 编号 | 风险 | 影响 | 归属与处置 |
| --- | --- | --- | --- |
| RK-M1 | SQLite 位置式 `INSERT INTO hub_users VALUES(...)` 在加列后的行为**本阶段未实测**（无法执行 node） | 高：引导/邀请/注册全挂 | S1 **第一件事**用内存库实测；无论结果如何，统一改**显式列名**（同时兼容新旧库） |
| RK-M2 | `ALTER TABLE ADD COLUMN` 在老库/双进程启动下的并发 | 中高：重复列/迁移失败 | 只用 `ensureColumn`（`schema-util.mjs:65-90`），不手写 PRAGMA+ALTER |
| RK-A1 | 现有 `record` 吞审计异常，R-08 要求「资料已改但审计未写」不出现 | 中：验收争议 | S1 的 `updateProfile` 用严格审计路径（不吞异常），其它动作语义不动 |
| RK-C1 | 管理员 `/devices` 返回**全部**设备（`routes/identity.mjs:585-592`） | 中：执行设备数虚高 | S3 计数按 `d.userId === me.userId` 过滤；`DeviceRow` 补 `userId` |
| RK-C2 | `/sessions` 返回含已撤销会话（`user-store.mjs:943-955`） | 中：活跃数算错 | S3 用 `revoked !== true` 计数；P1-S3 展示时显式区分状态 |
| RK-U1 | `identity.ts` 目前不调用 `recoverSession()`（`:281-289`） | 中：账号页把「令牌过期」显示成「读取失败」 | S3 的窄条件重放（仅 `TOKEN_EXPIRED`/`TOKEN_MISSING`，排除 refresh/login，不吞 `WRONG_PASSWORD`） |
| RK-U3 | 无 jsdom/渲染器 | 中：交互难以自动断言 | 前端用源码扫描 + `react-dom/server`；真实交互交 T-226 |
| RK-M3 | 手机端注释把 `name` 说成「显示名、可以改」 | 中：文档/行为漂移 | S5 修正注释（`mobile/app.mjs:232-240`），不改逻辑 |
| RK-9 | 下游 worktree 可能没有 `workbench/node_modules` | 中：无法 typecheck/build，假绿 | 先检查再跑；缺失时**如实登记 blocked**，不联网安装（LEGION.md 禁令） |
| RK-E1 | 按静态阅读，`check-docs` 的「证据快照目录 banner」规则（`scripts/ci/check-docs.mjs:209-255`）会把 `docs/G-mvt9or0l-1/*.md` 判红——本目录匹配 `^G-`，而三份 md 都没写该 banner（本阶段未能执行脚本，属按规则推断） | 中：文档门禁假红，掩盖真问题 | 只对比 README/FEATURES 的 FAIL 行；**不**改上游冻结文档、不给活动目标目录加「历史快照」banner（会误导下游把交接文档当过期） |
| RK-E2 | 本轮无法执行 node/pnpm（权限层拒绝），本文件不含运行时读数 | 中：误以为已验证 | §7 是交给 T-224/T-226 执行的真实清单；证据必须带命令 + exit code |
| RK-E3 | 文件域 = 唯一写入许可 | 高：越域文件在交付时被标红 | 需要新增文件时，先在报告里申请并把新路径登记到对应切片；不在切片内偷偷加文件 |

---

## 9. 本阶段自检（逐条对应任务验收标准）

| 验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 把需求 / 方案拆成可独立认领、可独立验收的子任务 | §0、§2、§4、`## slices` | ✅ 5 个 P0 切片，每个都能单独跑命令判绿；P1 三项以备后切片形式完整定义 |
| 每个子任务带：验收标准 + 依赖关系（blockedBy）+ 工作量估计 | §2（blockedBy、工作量）、`## slices`（验收命令与期望）、§4（逐片开工卡） | ✅ 三要素齐备；P1 同口径（§6） |
| 每个子任务有「完成 = 什么」的可测口径，不留不可验收的黑盒 | §2「完成 = 什么」列、§4 各片「完成定义」 | ✅ 全部落到命令 + 期望；仅视觉/键盘/读屏类明确交 T-226 走查并登记 |
| 任务顺序 / 并行关系明确，无循环依赖、无遗漏 | §3（波次图 + 需求覆盖表） | ✅ DAG 无环；R-01–R-10 全覆盖；R-11–R-13 → §6；R-14 明确不产生任务 |
| 边界：子任务粒度以「一个士兵一轮可完成并验收」为准 | §2 工作量列、§4 | ✅ 最大 L（4–7 h）；超出时申请下一轮而不临时加切片 |
| 边界：为每个子任务写下验收要点，让下游拿到即可开工 | §4 各片「关键输入 / 要点 / 禁止 / 验收 / 完成定义」 | ✅ 每条要点都指到 file:line（来自 RESEARCH 的实测引用） |
| 边界：不直接写实现 | 全文 | ✅ 未改任何产品代码；只新增本文件；未联网、未 push |
| 边界：不改变需求语义与方案结论 | §1.4 | ✅ 只在拆解层做 3 处调整（并行化、测试文件拆分、P1 不注册），逐条登记理由 |
| 边界：不拆出无法验收的悬空任务 | §2、§4、§7 | ✅ 无「后续再定」式任务；P1 后备切片也带完整验收命令 |
| 处理历史评论 | 文首 | ✅ 派工信息为「（无）」，无退回意见 |

---

## 10. 变更记录

| 版本 | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| v1 | 2026-10-29 | 任务拆解（破阵） | 首版：基于 `60965a78` 与已校验的 REQUIREMENTS/RESEARCH，拆出 5 个文件域零交叉的 P0 切片（S1 数据仓储 / S2 HTTP 契约 / S3 前端 API 与纯函数 / S4 账号页 UI / S5 文档与回归），给出波次 DAG、逐片开工卡、文件域归属总表、P1 三项后备切片、全量回归命令与 12 项风险处置；登记与 RESEARCH §8 的 3 处拆解层差异。 |

---

> **本文件到此为止。** 下游 T-223/T-224 只能在本文件 + REQUIREMENTS + RESEARCH 的交集内开工；若发现某切片必须改动本文件未列出的文件，先回 T-222 更新切片，不在实现阶段自行扩大文件域。
