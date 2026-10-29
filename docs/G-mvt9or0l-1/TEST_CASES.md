# 账号管理（基础信息与账号信息）—— 测试用例与验收判定

> 任务：**T-223**（测试用例设计 / 构验）｜所属目标：**G-mvt9or0l-1**（software · active · chain）
> 上游需求：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-220，sha256=`8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f`）
> 上游方案：[RESEARCH.md](./RESEARCH.md)（T-221，sha256=`57965f3cbc8f4eb9648d28a84cd4f4105c8ab83746a96490f3824f8787b80851`）
> 上游拆解：[TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-222，sha256=`7a4aa13d2e779caec94b4b49cc744cc6b01ce758b2d3ed400103780533f7e65d`）
> 评估基线：本 worktree HEAD `294392ff8d9eb57f8f48d54dd65244fb695060c9`；Node **v24.19.0**
> 下游：T-224（编码，物化测试文件）→ T-225（审查）→ T-226（测试，**执行**本文件用例）→ T-227（部署）
> **边界声明**：本阶段只做**用例设计与判定口径**——不执行用例（执行是 T-226 的职责）、不写业务实现代码、不调用 taskctl/看板写接口、不 push、不联网。文中的命令是交给 T-224/T-226 的**执行清单**，不是本轮已执行结果；不允许把「未运行」写成「通过」。

---

## 0. 交接核对与本阶段边界

### 0.1 上游交接已逐字节核对（不可替换）

| 上游产物 | 派工登记 sha256 | 本 worktree 实测（`git show <commit>:<path>` 再 `sha256sum`） | 结论 |
| --- | --- | --- | --- |
| `docs/G-mvt9or0l-1/REQUIREMENTS.md`（T-220） | `8e5197be…9f7c7f` | `8e5197be34d40b52ae2ea18ca051a6d78e3a6ad39b4af0c8867358dded9f7c7f` | ✅ 一致 |
| `docs/G-mvt9or0l-1/RESEARCH.md`（T-221） | `57965f3c…7b80851` | `57965f3cbc8f4eb9648d28a84cd4f4105c8ab83746a96490f3824f8787b80851` | ✅ 一致 |
| `docs/G-mvt9or0l-1/TASK_BREAKDOWN.md`（T-222） | `7a4aa13d…7e65d` | `7a4aa13d2e779caec94b4b49cc744cc6b01ce758b2d3ed400103780533f7e65d` | ✅ 一致 |

历史评论为「（无）」，没有将军退回意见需要处理。

### 0.2 本阶段做了什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 把 REQUIREMENTS §9.1 的 AC-01–AC-16 逐条翻译成带前置 / 步骤 / 期望 / 通过判据的用例 | 不执行任何用例（T-226 执行并写 `TEST_REPORT.md`） |
| 为每条用例指定**可复现的执行层**（仓储 / HTTP / 纯函数 / 源码结构 / 手工走查）与建议测试名 | 不写业务实现代码 |
| 给出关键业务规则的正向 + 反向成对用例 | 不创建 T-224 文件域内的测试文件（见下） |
| 给出可直接粘贴到 T-224 测试文件中的代码骨架（附录 7） | 不改上游冻结文档（REQUIREMENTS / RESEARCH / TASK_BREAKDOWN 的 sha256 已登记） |
| 给出全量回归命令矩阵与证据记录模板 | 不在 live `team.db` 上做写操作 |

**为什么不在本阶段创建测试文件**：TASK_BREAKDOWN §5 把 `team-hub/identity-profile-store.test.mjs`、`team-hub/identity-profile.test.mjs`、`workbench/scripts/account-profile.test.mjs`、`workbench/scripts/account-page.test.mjs` 明确划给 S1–S4（T-224 的文件域），并规定「文件域 = 唯一写入许可」（RK-E3）。本阶段若抢先创建，会与 T-224 在同一路径上互相覆盖。因此「能落成测试代码的尽量一并写出」以**附录 7 的可粘贴骨架 + 每条的精确断言**交付，由 T-224 原样物化；这不降低判据强度，用例编号与测试名一一对应。

### 0.3 角色与状态口径

- **T-224（编码）**：按附录骨架物化 4 个新测试文件；必须让新增套件与既有套件全绿。
- **T-225（审查）**：核对用例与实现是否一一对应，重点查「用例被删/被改弱」。
- **T-226（测试）**：执行本文件全部 P0 用例，逐条记录 `PASS / FAIL / BLOCKED`，写入 `docs/G-mvt9or0l-1/TEST_REPORT.md`。
- 状态口径（严格）：
  - **PASS**：该用例的全部期望都真实成立，且证据可复读（命令输出、响应样例、截图、DOM 走查记录）。
  - **FAIL**：任一期望不成立。
  - **BLOCKED**：因环境缺失（无 `workbench/node_modules`、无浏览器、无第二个浏览器 profile、无管理员/普通账号）无法执行。**BLOCKED 不是 PASS**，必须写明原因与补齐方式。
  - **N/A**：该用例在当前实现形态下不适用（例如未知字段校验落在路由层而 store 层不接收原始 body）。N/A 必须写明「由哪条用例等价覆盖」。

---

## 1. 用例组织

### 1.1 执行层（与 TASK_BREAKDOWN 的切片一一对应）

| 层 | 载体 | 对应切片 | 新/旧测试文件 | 能证明什么 |
| --- | --- | --- | --- | --- |
| **L1 仓储与迁移** | `node:sqlite` 内存库 + 与 `server.mjs` 同形 `withTx`（仿 `team-hub/user-store.test.mjs:26-63`） | S1 | 新增 `team-hub/identity-profile-store.test.mjs` | 默认回退、校验边界、事务/审计、迁移幂等、INSERT 路径不回归 |
| **L2 HTTP 契约** | 临时 `TEAM_HUB_DB` + `import server.mjs` + `listen(0)` + `fetch`（仿 `team-hub/identity-remote.test.mjs:1-32`） | S2 | 新增 `team-hub/identity-profile.test.mjs` | `/me` 追加式兼容、`/profile` 契约、401/403/400 具名码、越权与停用 |
| **L3 前端 API 与纯函数** | `ts.transpileModule` 直跑 TS（仿 `workbench/scripts/external-avatar-parity.test.mjs:1-30`） | S3 | 新增 `workbench/scripts/account-profile.test.mjs` | 校验与服务端同批输入同结果、计数口径、401 单飞重放源码断言 |
| **L4 账号页结构** | 源码扫描 + `react-dom/server`（仿 `workbench/scripts/identity-gate.test.mjs`，无 jsdom） | S4 | 新增 `workbench/scripts/account-page.test.mjs`；改 `identity-gate.test.mjs` | 七区块顺序、独立错误态、本机模式不渲染、非管理员不请求、无障碍属性 |
| **L5 手工走查** | 真实浏览器 + 真实 Hub（普通 / 管理员 / 本机模式三类身份；两个浏览器 profile） | T-226 | 无（走查记录 + 截图） | 键盘、读屏、真实会话、断网、视觉布局——这些 L1–L4 无法证明 |

> 边界：L1–L4 全绿**不能**宣称页面可用（REQUIREMENTS §9.4）；AC-01/AC-07/AC-08/AC-09/AC-11 的最终判定必须包含 L5 证据。

### 1.2 编号与测试名约定

- 编号：`TC-S1-xx` / `TC-S2-xx` / `TC-S3-xx` / `TC-S4-xx` / `TC-M-xx`（手工）/ `TC-P1-xx`（P1，非阻塞）/ `TC-R-xx`（回归命令）。
- **每个自动化用例的 `it()` / `test()` 标题必须以编号开头**，例如 `it('TC-S1-22 65 字符被拒且不写库', ...)`。这样可单条执行：
  ```bash
  node --test team-hub/identity-profile-store.test.mjs --test-name-pattern='TC-S1-22'
  ```
- 手工用例在 `TEST_REPORT.md` 中按编号登记结果与证据路径。

### 1.3 P0 / P1

- **P0（必须全绿才可交付）**：`TC-S1-*`、`TC-S2-*`、`TC-S3-*`、`TC-S4-*`、`TC-M-01`–`TC-M-30`、`TC-R-01`–`TC-R-14` 中标记 P0 的项。
- **P1（不阻塞 P0，未完成必须登记）**：`TC-P1-*`。P1 不通过时**不得**在 `TEST_REPORT.md` / `docs/FEATURES.md` 伪装成完成（REQUIREMENTS A10、§9.1）。

---

## 2. 测试基线与夹具

### 2.1 账号矩阵（L1/L2/L5 共用口径）

| 代号 | 用户名（登录名） | 口令 | 系统角色 | displayName 初始 | 用途 |
| --- | --- | --- | --- | --- | --- |
| A-admin | `owner` | `owner-password` | `admin` | 无（回退 `owner`） | 管理员区、越权对照、`/users` |
| A-member | `小兵` | `soldier-password` | `none` | 无（回退 `小兵`） | 普通用户主路径、显示名编辑 |
| A-member2 | `小卒` | `pawn-password` | `none` | 无（回退 `小卒`） | 跨用户写、同名消歧 |
| A-disabled | `停用兵` | `disabled-password` | `none` | 无 | 停用后登录/刷新/旧令牌 |
| A-legacy | `旧数据兵` | `legacy-password` | `none` | **`display_name` 列为 NULL** | 旧数据回退（必须真造旧行，不看代码默认值） |
| A-same1 / A-same2 | `同名甲` / `同名乙` | 各自口令 | `none` | 都设为 `同名` | 显示名非唯一与「显示名（用户名）」消歧 |

会话矩阵：同一用户开两个登录（`label: '浏览器A'`、`label: '浏览器B'`），分别记 `tokenA` / `tokenB` 与 `sessionIdA` / `sessionIdB`，用于「撤销其它、保留当前」的正反用例。

### 2.2 L1 夹具（内存库）

```js
// 与 team-hub/user-store.test.mjs:26-63 同形；必须带 spaces 表。
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT);
         INSERT INTO spaces (id, name) VALUES ('default', '默认空间');`)
let depth = 0
const withTx = (mutate) => { /* BEGIN IMMEDIATE + SAVEPOINT 嵌套，见既有夹具 */ }
const auditLog = []
const audit = (actor, scope, action, taskId, detail) => auditLog.push({ actor, scope, action, detail })
const store = createUserStore({ db, withTx, clock: () => clock.now, key: KEY, audit })
```

- **旧数据行必须手工构造**：先按**旧七列**建 `hub_users`、插入 `A-legacy`，再调用 `createUserStore(...)` 触发 `ensureColumn`。这样才能真正覆盖「旧库补列 → 读取回退」链路（REQUIREMENTS §9.4 明确禁止只看代码默认值）。
- 口令哈希用导出的 `hashPassword()` 预先生成；不要复用其他套件的临时库。

### 2.3 L2 夹具（真实 HTTP）

```js
process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
process.env.TEAM_HUB_HOST = '127.0.0.1'
process.env.TEAM_HUB_TOKEN = HUB_TOKEN
process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
process.env.LEGION_REMOTE_AUTH = '1'
mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
mod.db.prepare("INSERT OR IGNORE INTO spaces (id, name) VALUES ('default', '默认空间')").run()
```

- 引导管理员：`POST /api/identity/bootstrap`，`Authorization: Bearer <HUB_TOKEN>`，体 `{name:'owner', password:'owner-password'}`。
- 登录：`POST /api/identity/login`，体 `{name, password, label}`；响应含 `accessToken` / `refreshToken` / `sessionId`。
- 建普通成员：管理员 `POST /api/identity/invites {space:'default', role:'member'}` → 拿 `code` → `POST /api/identity/invites/accept {code, name, password}`。
- 停用：管理员 `POST /api/identity/users/disable {userId, disabled:true}`。
- **过期访问令牌**：登录后直接 `UPDATE hub_user_sessions SET access_expires_at_ms=? WHERE id=?` 把该会话的访问有效期改到过去（测试库允许），再请求 → `IDENTITY_TOKEN_EXPIRED`。
- 全程只用 `mkdtempSync` 临时库，**不碰 live `team.db`**（REQUIREMENTS §12.4、LEGION 纪律）。

### 2.4 L5 浏览器夹具

- 两个独立浏览器 profile（或一个普通窗口 + 一个隐私窗口），各自登录同一账号，用 `label` 区分。
- 三类身份各走一遍：普通成员（A-member）、系统管理员（A-admin）、本机机器令牌模式（不启用远程身份）。
- 断网用 DevTools Network → Offline；读屏用系统自带读屏（VoiceOver / NVDA / Narrator 任一）。
- 窄屏按桌面窗口最小宽度（workbench 既有最小宽度）验证不横向溢出。

---

## 3. 验收标准 → 用例追踪矩阵（通过 / 失败判据）

| AC | 需求 | 优先级 | 承接用例 | 通过判据（全部成立才 PASS） | 失败判据（任一成立即 FAIL） |
| --- | --- | --- | --- | --- | --- |
| AC-01 入口与信息架构 | R-01 | P0 | TC-S4-01…09、TC-M-01…03、TC-M-16、TC-M-18、TC-M-22 | `settings-connections` 路由 id 不变；有会话时七区块齐全且顺序正确；本机模式无账号区；非管理员无管理区 | 路由 id/hash 改变；缺区块；本机模式出现账号/退出入口；非管理员看到管理区 |
| AC-02 账号信息总览 | R-03 | P0 | TC-S2-01…05、TC-S3-10…15、TC-S4-04、TC-M-01…02、TC-M-19 | 字段齐全且与 `/me`+`/sessions`+`/devices` 读数一致；缺失显示「—/未知」；失败显示错误不显示 0/空 | 任一字段与接口不一致；失败被显示成 0/空/「正常」；编造默认值 |
| AC-03 显示名默认与回退 | R-02 | P0 | TC-S1-01…05、TC-S2-03、TC-S3-06、TC-M-01 | 无 displayName 的旧账号（真旧行）显示名回退用户名，不空白、不报错 | 显示空白；显示 `null`/`undefined`；报错；回退到非用户名的值 |
| AC-04 显示名保存持久化 | R-02 | P0 | TC-S1-10…15、TC-S2-10…14、TC-S3-08、TC-S4-18、TC-M-04…06 | 保存后当前页立即生效；刷新、重新登录、另一浏览器均为新值；用户名/会话/角色/审计归属不变 | 任一处仍旧值；用户名被改；会话被撤销；角色变化 |
| AC-05 显示名校验 | R-02/R-08 | P0 | TC-S1-20…33、TC-S2-20…33、TC-S3-01…05、TC-M-08 | 空/全空白/65/控制字符/换行/未知字段/非对象/非法 JSON 全部 400 `IDENTITY_INVALID_INPUT`；无写库；无部分更新；1 与 64 通过 | 任一非法输入被接受；写库发生；错误码不是 `IDENTITY_INVALID_INPUT`；合法边界被拒 |
| AC-06 显示名非唯一与消歧 | R-02 | P0 | TC-S1-13、TC-S2-14、TC-S2-47、TC-S4-08、TC-M-29 | 两个用户同名均成功；管理员列表同时可见显示名与用户名 | 第二个同名被拒（`NAME_TAKEN` 等）；列表只剩一个名字无法区分 |
| AC-07 改口令 | R-04 | P0 | TC-R-02、TC-R-05、TC-M-10、TC-M-11 | 成功：其它会话 100% 撤销、当前保留、返回撤销数；失败：无副作用；错误码正确 | 当前会话被误撤销；其它会话仍有效；错误口令返回 200；失败后口令或会话被改 |
| AC-08 会话列表与撤销 | R-05 | P0 | TC-S2-43、TC-M-12、TC-M-13 | 当前标记正确；撤销后该会话下一次请求 401；失败不移除列表项 | 当前会话可被撤销按钮点掉；撤销失败仍显示成功/移除；被撤会话仍可请求 |
| AC-09 退出登录 | R-06 | P0 | TC-M-25…27、TC-S4-09、TC-M-18 | 本地凭据清除并回登录屏；断网也清除；后退/刷新不能回已登录界面；本机模式无按钮 | 本地凭据残留；后退能回；本机模式出现按钮 |
| AC-10 越权与停用 | R-07 | P0 | TC-S1-43/44、TC-S2-32/40…48、TC-S4-10、TC-M-17 | 跨用户写全部 400/403 且数据未变；非管理员 `/users` 403；停用账号不能登录/刷新/用旧令牌 | 任一越权成功；数据变化；停用账号仍能访问；错误码不具名 |
| AC-11 加载/空/错误/无障碍 | R-09 | P0 | TC-S3-20…24、TC-S4-11…17/20…22、TC-M-19…24、TC-M-30 | 有加载/空/错误/重试；401 自动续期；键盘可完成；状态可播报；不溢出 | 空白/卡死；401 被显示成「读取失败」；键盘不可达；无播报；横向溢出 |
| AC-12 回归 | R-10 | P0 | TC-R-01…14 | 全部命令 exit 0（skip 需登记原因）；既有行为不变 | 任一既有套件红；手机端契约红；构建失败 |
| AC-13 P1 头像 | R-11 | P1 | TC-P1-01…06 | 合法令牌持久化；非法拒绝；不写 roster；无破图 | 非法落库；写入 roster；破图/emoji 回退 |
| AC-14 P1 显示名传播 | R-12 | P1 | TC-P1-07、TC-P1-08 | 当前用户展示面用显示名；登录/审计仍用用户名 | 审计 actor 变成显示名；登录名被替换 |
| AC-15 P1 最近登录 | R-13 | P1 | TC-P1-09…12 | 最近 5 条状态正确；无编造 IP/地理；已撤销不计活跃 | 编造字段；状态错误；已撤销计入活跃 |
| AC-16 文档 | R-10 | P0 | TC-R-14、TC-DOC-01…04（见 §4.7） | FEATURES/README 的入口、字段、可改/不可改、边界与实际一致 | 文档写「用户名可改」、漏掉 P1 未完成说明、入口链接失效 |

---

## 4. 用例明细

> 说明：每行都是一条可独立判定的用例。`类型` 取值：正常 / 边界 / 异常 / 越权 / 兼容 / 回归。所有 L1–L4 用例的期望都是**断言级**；L5 用例给出「看什么、怎么算通过」。
>
> **控制字符记法**：本文件统一用 `U+XXXX` 表示字符码位，例如 U+0000（NUL）、U+001F（单元分隔符）、U+007F（DEL）、U+000A（换行）、U+000D（回车）。这样文档里不会出现不可见字符，复制到测试代码时也不会被编辑器吞掉。

### 4.1 L1 仓储与迁移（S1，`team-hub/identity-profile-store.test.mjs`）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-S1-01 | 兼容 | 旧七列 `hub_users` 表 + A-legacy 行（`display_name` 列不存在） | 用该库 `createUserStore()`；读 `listUsers()` | `display_name` 列被补上；A-legacy 的 `displayName === '旧数据兵'`；无异常 |
| TC-S1-02 | 边界 | 同一旧库 | 连续两次 `createUserStore()` | 两次都不抛错；`PRAGMA table_info(hub_users)` 中 `display_name` 恰好 1 列 |
| TC-S1-03 | 兼容 | 新库，A-legacy 的 `display_name` 为 `NULL` | 读投影 | `displayName === name` |
| TC-S1-04 | 边界 | `display_name` 分别为 `''`、`'   '`、制表符串 | 读投影 | 三者都回退 `name`，不得返回空白 |
| TC-S1-05 | 正常 | 新库 | `bootstrapOwner` / `acceptInvite` / `register` 各建一个用户 | 三个用户的 `displayName` 均等于各自用户名 |
| TC-S1-06 | 正常 | 新库 | 读投影 | `avatar === ''`（P0 契约先稳定） |
| TC-S1-07 | 兼容 | 旧库 + 旧行 | 迁移后对比 `name` / `name_key` | 两者逐字节不变 |
| TC-S1-08 | 回归 | 源码 | `grep -c "INSERT INTO hub_users VALUES" team-hub/user-store.mjs` | 输出 `0`；且引导 / 邀请接受 / 自助注册三条路在 L1 各有一条成功用例 |
| TC-S1-10 | 正常 | A-member | `updateProfile({userId, displayName:'Alice'})`；用同一 db 新建一个 store 实例再读 | 返回值 `displayName === 'Alice'`；新实例读到的也是 `'Alice'`（真持久化） |
| TC-S1-11 | 正常 | A-member | `updateProfile({displayName:'  Alice  '})` | 存的是 `'Alice'`（去首尾空白）；返回值 `'Alice'` |
| TC-S1-12 | 正常 | A-member | 依次保存 `'Alice'`、`'Bob'` | 第一次返回 `'Alice'`，第二次返回 `'Bob'`；最终读数为 `'Bob'`（后写覆盖） |
| TC-S1-13 | 正常 | A-same1 / A-same2 | 两人都保存 `'同名'` | 两次都成功；`listUsers()` 两行 `displayName` 都是 `'同名'`（非唯一） |
| TC-S1-14 | 正常 | A-member | 保存前后对比 `name` / `name_key` | 完全不变 |
| TC-S1-15 | 正常 | A-member 已有空间角色与会话 | 保存前后对比 `password_hash`、`disabled_at_ms`、`system_role`、`hub_space_roles` 行、`hub_user_sessions` 行 | 全部不变；只有 `hub_users.display_name` 变化 |
| TC-S1-20 | 边界 | A-member | 保存 `'A'`（长度 1） | store 不抛错；读回 `'A'` |
| TC-S1-21 | 边界 | A-member | 保存 64 个 `'A'` | 成功；读回长度 64 |
| TC-S1-22 | 边界 | A-member，原值 `'旧显示名'` | 保存 65 个 `'A'` | 抛 `IDENTITY_INVALID_INPUT`；读回仍 `'旧显示名'` |
| TC-S1-23 | 异常 | 同上 | 保存 `''` | `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-24 | 异常 | 同上 | 保存 `'   '`、两个制表符 | `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-25 | 异常 | 同上 | 保存含 U+0000 的字符串（`'Ali' + U+0000 + 'ce'`） | `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-26 | 异常 | 同上 | 保存含 U+001F 的字符串 | `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-27 | 异常 | 同上 | 保存含 U+007F 的字符串 | `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-28 | 异常 | 同上 | 保存含 U+000A 的字符串（`'Ali' + U+000A + 'ce'`） | `IDENTITY_INVALID_INPUT`（**不得**因 trim 只去掉首尾而放行内部换行） |
| TC-S1-29 | 异常 | 同上 | 保存含 U+000D + U+000A、以及仅 U+000D 的字符串 | 均 `IDENTITY_INVALID_INPUT` |
| TC-S1-30 | 异常 | 同上 | 依次传 `null`、`undefined`、`42`、`true`、`{}`、`['a']` | 全部 `IDENTITY_INVALID_INPUT`；读回原值 |
| TC-S1-31 | 边界 | A-member | 保存 32 个 emoji（UTF-16 长度 64）；再保存 33 个 emoji（长度 66）；再保存 64 个汉字 | 第一个成功；第二个 `IDENTITY_INVALID_INPUT`；第三个成功（口径 = `String.length`，与用户名校验一致） |
| TC-S1-32 | 异常 | A-member，原值固定 | 对 TC-S1-22…31 的每个拒绝输入后立即读库 | 每一次 `display_name` 都与调用前相同（逐条断言，不得只在最后断言一次） |
| TC-S1-33 | 异常 | A-member | 捕获抛出的错误 | `error instanceof IdentityError` 且 `code === 'IDENTITY_INVALID_INPUT'` |
| TC-S1-40 | 正常 | A-member，注入 `auditLog` | 保存 `'Alice'` | 新增一条 `{action:'identity:profile-update', scope:'global'}`；`detail.fields` 深等于 `['displayName']`；含旧值与新值 |
| TC-S1-41 | 异常 | 同上 | `JSON.stringify(auditLog)` | 不含口令、访问令牌、刷新令牌、`password_hash`、`scrypt$` |
| TC-S1-42 | 异常 | `audit` 回调**抛错** | 保存 `'Alice'` | 调用整体抛错；事务回滚：`display_name` 仍为原值、`password_hash` 不变、`hub_user_sessions` 无变化 |
| TC-S1-43 | 越权 | A-disabled（`disabled_at_ms` 非空） | 直接调 `updateProfile` | 抛 `IDENTITY_FORBIDDEN`（403）；行不变 |
| TC-S1-44 | 异常 | 无 | `updateProfile({userId:'user-不存在', displayName:'x'})` | 抛 `IDENTITY_USER_NOT_FOUND`（404） |
| TC-S1-45 | 异常 | 见备注 | 传未知字段 / 非对象（若 store 暴露原始 body 校验） | `IDENTITY_INVALID_INPUT`；**若 L1 不接收原始 body（只收 `{userId, displayName}`），记 N/A 并注明由 TC-S2-27…32 等价覆盖** |
| TC-S1-50 | 边界 | A-member | 模拟两个并发保存（同一 db 串行调用两次不同值；若 store 支持真并发则用 `Promise.all`） | 不出现半写；最终值为后写者；两次返回均为各自事务内的最终值 |
| TC-S1-51 | 异常 | A-member | 对 100 条随机非法输入（控制字符/超长/空白/非字符串）逐个调用 | 全部拒绝；`display_name` 始终等于原值 |
| TC-S1-52 | 兼容 | 旧库同时含会话、邀请、空间角色行 | 迁移后读这些表 | 行数与内容不变（迁移只加列） |

> S1 命令：`node --test team-hub/identity-profile-store.test.mjs`（exit 0）；回归另跑 `node --test team-hub/user-store.test.mjs`、`node --test team-hub/identity-registration.test.mjs`、`node --test team-hub/account-quota.test.mjs`。

### 4.2 L2 HTTP 契约（S2，`team-hub/identity-profile.test.mjs`）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-S2-01 | 兼容 | A-member 已登录 | `GET /api/identity/me` | 200；`user.userId` 为 string、`user.name === '小兵'`、`roles` 为数组、`systemRole ∈ {'admin','none'}`；旧字段名与类型不变 |
| TC-S2-02 | 正常 | 同上 | 同上 | 追加字段齐全且类型正确：`displayName` string、`avatar` string、`createdAt` 可被 `Date.parse`、`disabled` boolean |
| TC-S2-03 | 兼容 | A-legacy（`display_name` NULL） | `GET /me` | `user.displayName === '旧数据兵'`；不空白、不 `null` |
| TC-S2-04 | 异常 | 任意登录用户 | `JSON.stringify(响应体)` | 不含 `password_hash`、`name_key`、`accessToken`、`refreshToken`、`scrypt$` |
| TC-S2-05 | 异常 | 无 Authorization | `GET /me` | 401；`code === 'IDENTITY_TOKEN_MISSING'`；`{ok:false}` |
| TC-S2-06 | 异常 | `Authorization: Bearer not-a-token` | `GET /me` | 401；`code === 'IDENTITY_TOKEN_MALFORMED'` |
| TC-S2-07 | 异常 | 用另一个 key 签发的同形令牌 | `GET /me` | 401；`code === 'IDENTITY_TOKEN_BAD_SIGNATURE'` |
| TC-S2-08 | 异常 | 登录后把该会话 `access_expires_at_ms` 改到过去 | `GET /me` | 401；`code === 'IDENTITY_TOKEN_EXPIRED'` |
| TC-S2-09 | 异常 | 撤销 tokenA 对应会话后 | 用 tokenA `GET /me` | 401；`code === 'IDENTITY_SESSION_REVOKED'` |
| TC-S2-10 | 正常 | A-member | `POST /api/identity/profile {displayName:'Alice'}` | 200；`ok:true`；`user.userId/name/displayName/avatar/createdAt/disabled` 齐全；`displayName === 'Alice'`；`name` 仍 `'小兵'` |
| TC-S2-11 | 正常 | A-member | 提交 `'  Alice  '` | 200；返回 `'Alice'`；随后 `GET /me` 也是 `'Alice'` |
| TC-S2-12 | 正常 | A-member | 连续提交 `'Alice'`、`'Bob'` | 两次 200；第二次返回 `'Bob'`；`GET /me` 为 `'Bob'` |
| TC-S2-13 | 正常 | A-member | 提交 `'Alice'` 后 `GET /me` | 两次响应的 `userId/name/displayName/createdAt/disabled` 一致 |
| TC-S2-14 | 正常 | A-same1 / A-same2 | 两人分别提交 `'同名'` | 两次都 200；`GET /users`（管理员）两行都含 `displayName:'同名'` 且各自 `name` 不同 |
| TC-S2-20 | 异常 | A-member | 提交 `{}`（缺 `displayName`） | 400；`code === 'IDENTITY_INVALID_INPUT'`；`GET /me` 不变 |
| TC-S2-21 | 异常 | 同上 | 提交空白字符串值 | 400 `IDENTITY_INVALID_INPUT`；不变 |
| TC-S2-22 | 异常 | 同上 | 提交全空格字符串 | 400；不变 |
| TC-S2-23 | 异常 | 同上 | 提交 65 个字符 | 400；不变 |
| TC-S2-24 | 异常 | 同上 | 提交含 U+0000 的字符串 | 400；不变 |
| TC-S2-25 | 异常 | 同上 | 提交含 U+000A 的字符串 | 400；不变 |
| TC-S2-26 | 异常 | 同上 | 提交 `{displayName: 42}` / `null` / `{}` / `[]` | 全部 400；不变 |
| TC-S2-27 | 异常 | A-member | 请求体依次为 `null`、`[]`、`"x"`、`42`、`true` | 全部 400 `IDENTITY_INVALID_INPUT`；**不得**是 `IDENTITY_REQUEST_FAILED`/`MISSING_PARAM` |
| TC-S2-28 | 异常 | A-member | 发送非法 JSON 文本（如 `{displayName:`） | 400 `IDENTITY_INVALID_INPUT`（路由必须捕获 `readBody` 的解析错误并映射） |
| TC-S2-29 | 越权 | A-member | 提交 `{displayName:'Alice', userId:'<A-member2 的 userId>'}` | 400 `IDENTITY_INVALID_INPUT`；A-member 与 A-member2 的 `displayName` 都未变；审计无新增 |
| TC-S2-30 | 越权 | A-member | 提交 `{displayName:'Alice', name:'hacker'}` | 400；本人 `name` 仍 `'小兵'`；用 `'小兵'` 仍能登录 |
| TC-S2-31 | 异常 | A-member | 提交 `{displayName:'Alice', password:'x'}` | 400；旧口令仍能登录 |
| TC-S2-32 | 越权 | A-member / A-member2 | 查看 A-member2 当前 `displayName`；以 A-member 令牌提交仅含 `displayName` 的请求（无其他 userId） | 200 且只改 A-member；A-member2 的行逐字段未变（**三件套：请求 + 响应 + 数据未变**） |
| TC-S2-33 | 异常 | A-member，原值固定 | 对 TC-S2-20…31 每条失败后 `GET /me` | 每次 `displayName` 都等于失败前值（逐条断言） |
| TC-S2-40 | 异常 | 无 Authorization | `POST /profile {displayName:'x'}` | 401 `IDENTITY_TOKEN_MISSING`；目标用户未变 |
| TC-S2-41 | 异常 | 畸形令牌 | `POST /profile` | 401 `IDENTITY_TOKEN_MALFORMED` |
| TC-S2-42 | 异常 | 错签名令牌 | `POST /profile` | 401 `IDENTITY_TOKEN_BAD_SIGNATURE` |
| TC-S2-43 | 异常 | 访问令牌过期（改库） | `POST /profile` | 401 `IDENTITY_TOKEN_EXPIRED`；未写入 |
| TC-S2-44 | 异常 | 会话已撤销 | `POST /profile` | 401 `IDENTITY_SESSION_REVOKED`；未写入 |
| TC-S2-45 | 越权 | 管理员停用 A-member 后 | ① 用停用前的旧访问令牌 `GET /me`；② 用旧口令登录；③ 用旧 refreshToken 刷新 | ① 401 `IDENTITY_SESSION_REVOKED`；② 401 `IDENTITY_INVALID_CREDENTIALS`；③ 401 且 `code === 'IDENTITY_SESSION_REVOKED'`；三处都不得成功 |
| TC-S2-46 | 越权 | A-member（非管理员） | `GET /api/identity/users` | 403 `IDENTITY_FORBIDDEN`；响应不含任何用户数据 |
| TC-S2-47 | 正常 | A-admin | `GET /api/identity/users` | 200；每行同时有 `displayName` 与 `name`（供 TC-M-29 消歧） |
| TC-S2-48 | 兼容 | A-admin / A-member | 两者分别 `GET /me` | `systemRole` 分别为 `'admin'` / `'none'`；其余字段形状一致 |
| TC-S2-50 | 兼容 | A-member | 只读旧四字段并忽略新字段，模拟旧客户端 | 旧客户端路径不报错（`user.userId`/`user.name`/`roles`/`systemRole` 均存在且类型不变） |
| TC-S2-51 | 正常 | A-member | 成功与失败各一次 | 成功 `{ok:true,...}`；失败 `{ok:false, code, error}`；`content-type` 为 JSON；`error` 为可读中文、不含堆栈/HTML |
| TC-S2-52 | 异常 | A-member | 失败请求前后统计 `audit` 行数 | 失败请求**不新增** `identity:profile-update` 审计行 |
| TC-S2-53 | 正常 | A-member 有两个活跃会话 | 保存显示名前后 `GET /sessions` | 活跃会话数与各自 `revoked` 状态不变（资料更新不撤会话） |
| TC-S2-54 | 正常 | A-member | 保存显示名后检查登录 | 旧口令仍能登录（资料更新不改口令） |
| TC-S2-55 | 正常 | A-member | `POST /profile {displayName:'Alice'}` 后 `GET /devices` | 设备列表与更新前一致（资料更新不碰设备） |

> S2 命令：`node --test team-hub/identity-profile.test.mjs`（exit 0）；回归 `node --test team-hub/identity-remote.test.mjs`。

### 4.3 L3 前端 API 与纯函数（S3，`workbench/scripts/account-profile.test.mjs`）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-S3-01 | 正常 | `validateDisplayName` 已导出 | 输入 `'Alice'`、`'  Alice  '` | 分别返回 `{ok:true,value:'Alice'}` |
| TC-S3-02 | 边界 | 同上 | 输入 1 字符、64 字符 | 均 `ok:true`；64 字符值原样保留 |
| TC-S3-03 | 边界 | 同上 | 输入 65 字符、32 个 emoji、33 个 emoji、64 个汉字 | 65 与 33 emoji 返回 `ok:false`；32 emoji 与 64 汉字返回 `ok:true`（与 TC-S1-31 同结果） |
| TC-S3-04 | 异常 | 同上 | 输入 `''`、`'   '`、含 U+0000 的字符串、含 U+000A 的字符串、含 U+007F 的字符串、非字符串 | 全部 `ok:false`，且 `message` 为可读中文 |
| TC-S3-05 | 兼容 | 同一批输入 | 对 TC-S1-20…31 的输入集合逐项比较前端与服务端结论 | 每一项「通过/拒绝」完全一致（两侧同一批输入、同一结论；服务端为准） |
| TC-S3-06 | 兼容 | 构造 `/me` 响应 `{user:{userId,name}}`（无 displayName/avatar） | `fetchMe` 投影 | `displayName === name`；`avatar === ''`；不抛错 |
| TC-S3-07 | 正常 | 构造含全部新字段的 `/me` 响应 | `fetchMe` | 新字段原样透传；`roles/systemRole` 缺省时分别为 `[]`/`'none'` |
| TC-S3-08 | 正常 | 模拟 `POST /profile` 返回 `{ok:true,user:{...}}` | `updateProfile({displayName:'Alice'})` | 请求路径为 `/api/identity/profile`、method POST、体只含 `displayName`、带用户访问令牌；返回 `MeInfo['user']` |
| TC-S3-09 | 异常 | 模拟 400 `{ok:false,code:'IDENTITY_INVALID_INPUT',error:'...'}` | `updateProfile` | 抛 `IdentityRequestError`，`code === 'IDENTITY_INVALID_INPUT'`、`status === 400` |
| TC-S3-10 | 正常 | sessions 含 2 条未撤销 + 2 条 `revoked:true` | `accountSummary(me, sessions, devices)` | `activeSessionCount === 2` |
| TC-S3-11 | 边界 | sessions 中一条未撤销但 `refreshExpiresAt` 已过期 | `accountSummary` | 仍计入活跃（R-03：活跃 = 未撤销；「已过期」是 P1 展示态，不是 P0 计数口径） |
| TC-S3-12 | 正常 | devices：本用户 2 台未撤销 + 1 台已撤销 + 他人 3 台；`me.userId` 为本用户 | `accountSummary` | `deviceCount === 2`（排除 revoked、按 `userId` 过滤） |
| TC-S3-13 | 边界 | 管理员看到的 devices 全是他人设备 | `accountSummary` | `deviceCount === 0`（不得用 `devices.length` 冒充） |
| TC-S3-14 | 异常 | sessions 读取失败、devices 成功 | 容器/摘要函数输入 | 设备数与设备区块仍可用；互不置空（对应 TC-S4-11） |
| TC-S3-15 | 边界 | `formatCreatedAt('2026-10-29T08:00:00.000Z')`；非法 ISO；`null` | 调用 | 合法 ISO 返回非空本地时间文本；非法/缺失返回「—」/「未知」且不抛错 |
| TC-S3-20 | 正常 | 桩：首次 `fetchMe` 返回 401 `IDENTITY_TOKEN_EXPIRED`，`recoverSession()` 成功，第二次返回 200 | 调用 `fetchMe` | `recoverSession` 恰好被调用 1 次；原请求恰好重放 1 次；最终返回 200 数据 |
| TC-S3-21 | 异常 | 桩：`changePassword` 返回 401 `IDENTITY_WRONG_PASSWORD` | 调用 `changePassword` | **不调用** `recoverSession`；错误原样抛给 UI（不得被当成令牌过期） |
| TC-S3-22 | 异常 | 源码扫描 | 检查重放包装 | 重放条件显式排除 `/api/identity/refresh` 与 `/api/identity/login`；不会递归刷新 |
| TC-S3-23 | 异常 | 无刷新凭据（`getRefreshToken()` 为空） | 401 场景 | 不发起刷新；错误原样返回（`recoverSession` 返回 false） |
| TC-S3-24 | 边界 | 桩：10 路并发 401 | 同时调用 `fetchMe` | 刷新只发生 1 次（单飞），其余复用同一 Promise；成功后 10 路全部 200 |
| TC-S3-25 | 兼容 | 类型扫描 | `DeviceRow` 定义 | 含可选 `userId?: string`；不影响既有字段 |

> S3 命令：`node --test workbench/scripts/account-profile.test.mjs`（exit 0）与 `pnpm --dir workbench build`（exit 0）。

### 4.4 L4 账号页结构（S4，`workbench/scripts/account-page.test.mjs` + `identity-gate.test.mjs`）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-S4-01 | 正常 | 读 `AccountPanel.tsx` | 找到七个区块标题的 `indexOf` | 顺序严格递增：账号摘要 → 基础信息 → 账号信息 → 账号安全 → 登录中的设备 → 执行设备 → 账号管理 |
| TC-S4-02 | 正常 | 同上 | 扫描摘要区 | 同时渲染 `me.displayName` 与 `me.name`；`systemRole` 有文字（系统管理员/普通成员） |
| TC-S4-03 | 正常 | 同上 | 扫描基础信息区 | 用户名旁有「登录名，不可修改」文字；用户名输入框不存在或 `disabled`/`readOnly` |
| TC-S4-04 | 正常 | 同上 | 扫描账号信息区 | 出现：用户 ID、注册时间、账号状态、空间角色、当前会话、活跃会话数、执行设备数 |
| TC-S4-05 | 正常 | 同上 | 扫描账号安全区 | 同时含改口令表单与退出登录按钮 |
| TC-S4-06 | 正常 | 同上 | 扫描会话列表 | 当前会话显示「这台（现在）」；非当前会话才有「退出这台」按钮 |
| TC-S4-07 | 正常 | 读 `DevicePanel.tsx` | 扫描函数名 | `makeCode` / `rotate` / `revoke` 都在（配对 / 换令牌 / 撤销不因重组被删） |
| TC-S4-08 | 正常 | 读 `AccountPanel.tsx` | 扫描管理员区 | 管理员区被 `me?.systemRole === 'admin'` 条件包裹；用户列表渲染同时含 displayName 与 name |
| TC-S4-09 | 正常 | 源码 | 扫描本机模式判据 | `const active = hasSession()` 与 `if (!active && loaded) return null` 仍存在（identity-gate ⑦⑩ 语义不减少） |
| TC-S4-10 | 越权 | 源码 | 统计 `listUsers(` 调用点 | 只在 `info.systemRole === 'admin'` 分支内调用；无无条件调用 |
| TC-S4-11 | 异常 | 源码 | 扫描三路读取 | `Promise.allSettled`（或等价的三路独立错误捕获）；每区块有独立错误文案与「重试」按钮；一路失败不清空其他 |
| TC-S4-12 | 正常 | 源码/SSR | 初次加载分支 | 有明确加载文案/骨架；`me === null && !loaded` 时不渲染空表单 |
| TC-S4-13 | 正常 | 源码/SSR | 空数据渲染 | 无会话 / 无执行设备 / 未加入空间各有独立空态文案 |
| TC-S4-14 | 异常 | 源码 | 搜索 `dangerouslySetInnerHTML` | `AccountPanel.tsx` 中为 0；显示名以 `{me.displayName}` 纯文本渲染 |
| TC-S4-15 | 正常 | 源码 | 搜索播报区 | 保存/撤销结果经 `role="status"` 或 `aria-live` 播报 |
| TC-S4-16 | 正常 | 源码 | 搜索表单控件 | 显示名输入有可见 `<label htmlFor>`；保存/撤销/退出按钮有可访问名（文字或 `aria-label`） |
| TC-S4-17 | 正常 | 源码 | 搜索忙碌态 | 保存/撤销/退出按钮在 `busy` 时 `disabled`；保存函数有防重复提交保护 |
| TC-S4-18 | 正常 | 源码 | 搜索保存回填 | 保存成功后以服务端返回的 `user.displayName` 回填，而非仅用本地草稿 |
| TC-S4-19 | 正常 | 源码 | 搜索撤销按钮条件 | 当前会话分支不渲染撤销按钮（与 identity-gate ⑨ 等价） |
| TC-S4-20 | 边界 | 读 `index.css` | 搜索账号页新增类 | 长文本有 `overflow-wrap`/`word-break`/`min-width:0` 类规则，长显示名不撑破布局 |
| TC-S4-21 | 正常 | 源码 | 搜索状态文案 | 「正常/已停用」「这台/其它」「在线/离线/还没连过」均为文字，不只靠颜色 |
| TC-S4-22 | 正常 | 读 `WorkspaceSettings.tsx` | 统计挂载 | `AccountPanel` 只挂一次；`settings-connections` 路由 id/hash 不变；页面标题可变 |
| TC-S4-23 | 兼容 | 读 `DevicePanel.tsx` | 检查 props 签名 | 未传 `devices` 时仍自取（向后兼容）；传入时使用容器数据 |
| TC-S4-24 | 回归 | 读 `identity-gate.test.mjs` | 运行该套件 | 全套（①–⑲）通过；其中 ⑦⑧⑨⑩⑪⑫⑬⑭⑱ 与本目标直接相关，一条不得减少；⑱ 锚点可等价更新，但「非管理员不拉用户列表」语义不得删 |

> S4 命令：`node --test workbench/scripts/identity-gate.test.mjs`、`node --test workbench/scripts/account-page.test.mjs`、`pnpm --dir workbench build`，均 exit 0。

### 4.5 L5 手工走查（T-226，写入 `TEST_REPORT.md`）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-M-01 | 正常 | A-member 登录，Hub 启用身份体系 | 设置 → 连接与令牌（或「账号与连接」） | 一眼看到显示名、用户名、用户 ID、系统角色、空间角色、注册时间、账号状态；与接口读数逐项一致 |
| TC-M-02 | 正常 | A-admin 登录 | 同上 | 同上，且最下方出现「账号管理」区 |
| TC-M-03 | 正常 | 本机机器令牌模式（无用户会话） | 打开设置页 | 只看到中枢地址/写操作令牌；**无**账号摘要、基础信息、安全、会话、设备、管理员区 |
| TC-M-04 | 正常 | A-member 在账号页 | 编辑显示名 `小兵` → `Alice（产品）` → 保存 | 页面立即显示新值，无需整页刷新；用户名仍显示 `小兵` |
| TC-M-05 | 正常 | 承接 M-04 | 刷新页面；退出后重新登录；另一浏览器登录 | 三处显示名均为 `Alice（产品）`；会话与空间角色不变 |
| TC-M-06 | 正常 | 承接 M-04 | 退出，用 `小兵` + 原口令登录 | 登录成功（显示名不参与登录）；显示名仍为新值 |
| TC-M-07 | 正常 | 账号页编辑态 | 修改草稿后点「取消」 | 输入框恢复为 `me.displayName`；未发出写请求 |
| TC-M-08 | 边界 | 账号页编辑态 | 输入空、全空白、65 字符、粘贴含换行文本 | 客户端先给可读提示；若强行提交，服务端仍 400；显示名不变 |
| TC-M-09 | 边界 | 账号页编辑态 | 快速双击「保存」 | 只发出 1 次写请求；按钮在请求中禁用；结果只播报一次 |
| TC-M-10 | 异常 | A-member，两个会话 | 改口令：当前口令填错 | 提示「当前口令不正确」；不退出登录；其它会话仍有效 |
| TC-M-11 | 正常 | A-member，浏览器A + 浏览器B | 在 A 改口令成功 | 提示「已退出 N 个其它登录」；B 下一次操作回登录屏；A 仍在使用 |
| TC-M-12 | 正常 | A-member，两个会话 | 在 A 撤销「浏览器B」会话 | B 从列表消失；B 下一次请求 401 并回登录屏；A 不受影响 |
| TC-M-13 | 异常 | 承接 M-12 | 断网后撤销另一会话 | 不显示成功；该项仍在列表；恢复网络后可重试 |
| TC-M-14 | 正常 | A-member | 执行设备区生成配对码 → 另一台电脑配对 → 撤销 | 行为与改造前一致；在线/离线/还没连过三态文字正确 |
| TC-M-15 | 正常 | 同时有登录会话与执行设备 | 撤销一个登录会话 | 执行设备列表不变；反之撤销设备不影响登录会话 |
| TC-M-16 | 越权 | A-member 登录 | 查看页面与网络面板 | 无「账号管理」区；**未发出** `GET /api/identity/users` 请求（不得先请求再吞 403） |
| TC-M-17 | 越权 | A-member 令牌 + 命令行/浏览器控制台 | ① 调 `/api/identity/users`；② 调 `/profile` 并带 A-member2 的 `userId`；③ 撤销 A-member2 的会话 | ① 403；② 400；③ 403；三件套「请求 + 响应 code + 数据未变」齐全 |
| TC-M-18 | 正常 | 本机模式 | 查看设置页 | 无「退出登录」按钮；不出现「账号」字样入口 |
| TC-M-19 | 异常 | 已登录，DevTools Offline | 打开账号页 | 页不空白；失败区块显示「读取失败」+「重试」；其他区块可读；恢复网络点重试后成功 |
| TC-M-20 | 异常 | 访问令牌人工置为过期（15 分钟）或删除访问令牌但保留刷新凭据 | 打开账号页 | 自动单飞刷新并重试；**不**显示「账号读取失败/令牌过期」；刷新失败才回登录屏 |
| TC-M-21 | 正常 | 账号页 | 只用键盘：进入页 → 编辑显示名 → 保存 → 改口令 → 撤销会话 → 退出登录 | 全流程可完成；Tab 顺序合理；焦点环可见 |
| TC-M-22 | 正常 | 账号页 | 开读屏，执行保存与撤销 | 保存成功/失败、撤销结果被播报；区块标题与表单标签可读 |
| TC-M-23 | 边界 | 同账号显示名设为 64 字符；设备名设为长名 | 窗口缩到桌面最小宽度 | 不横向溢出、不遮挡按钮；长文本换行 |
| TC-M-24 | 正常 | 账号页 | 走完 J1–J5，看控制台 | 0 个未捕获异常、0 条 `console.error` |
| TC-M-25 | 正常 | A-member 登录 | 点「退出登录」 | 回到登录屏；`sessionStorage` 访问令牌与 `localStorage` 刷新凭据均被清除 |
| TC-M-26 | 异常 | A-member 登录，断网 | 点「退出登录」 | 即使请求失败，本地凭据仍被清除并回登录屏 |
| TC-M-27 | 正常 | 承接 M-25 | 浏览器后退/刷新 | 不能回到已登录界面；必须重新输入口令 |
| TC-M-28 | 回归 | 手机端 PWA | 打开手机端 | 仍是 Agent / 任务两个视图；无「我的/账号」页；现有退出登录可用 |
| TC-M-29 | 回归 | A-admin，两个同名显示名用户 | 管理员用户列表 | 显示「显示名（用户名）」可区分两人；邀请码、重置码流程与改造前一致 |
| TC-M-30 | 正常 | 首次进入账号页（冷启动） | 观察加载过程 | 先显示明确加载文案/骨架，不先渲染空表单再跳变；不闪「空白」 |

### 4.6 P1 用例（非阻塞，未完成须登记）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-P1-01 | 正常 | P1-S1 已实现 | 选择内置 `human:<key>` 头像并保存 | 200；刷新/重新登录后保持 |
| TC-P1-02 | 异常 | 同上 | 提交非法令牌、emoji、任意 URL、HTML | 全部 400 `IDENTITY_INVALID_INPUT`；不落库；不破图 |
| TC-P1-03 | 边界 | 同上 | 清空头像 | 回落确定性默认占位（显示名首字/中性占位），不是空白框 |
| TC-P1-04 | 正常 | 同上 | 保存后刷新、另一浏览器 | 头像一致 |
| TC-P1-05 | 越权 | 同上 | `grep -rn "roster"` 新代码；查 roster 行 | 无写入 roster 的路径；Agent 头像行逐字节不变 |
| TC-P1-06 | 兼容 | 同上 | `node --test workbench/scripts/account-avatar-parity.test.mjs` | 服务端白名单与 `workbench/src/avatar/slots.ts` 40 键逐项相等 |
| TC-P1-07 | 正常 | P1-S2 已实现 | 改显示名后走查当前用户展示面 | 账号摘要/账号信息/对话中「我」的标识使用 displayName |
| TC-P1-08 | 异常 | 同上 | 查看登录页、审计 actor、管理员列表 | 仍使用用户名；API `by`/`author`/`actor` 字段值不变 |
| TC-P1-09 | 正常 | P1-S3 已实现 | 登录/撤销/退出后查看最近登录 | 最多 5 条；含设备标签、创建时间、最近使用、状态 |
| TC-P1-10 | 边界 | 同上 | 构造 current/active/revoked/expired 四种状态 | 四种状态文字正确且不只靠颜色 |
| TC-P1-11 | 边界 | 同上 | 撤销一条后看活跃会话数 | 已撤销记录不计入活跃数 |
| TC-P1-12 | 异常 | 同上 | 扫描 DOM/接口 | 不出现 IP、地理位置、浏览器指纹等未存储字段 |

### 4.7 文档用例（AC-16）

| 编号 | 类型 | 前置条件 | 步骤 | 期望结果 / 通过判据 |
| --- | --- | --- | --- | --- |
| TC-DOC-01 | 正常 | S5 已改 `docs/FEATURES.md` | 阅读账号管理条目正文（≥5 行，含「入口」或「操作」） | 写明入口、显示名可改、用户名不可改、会话与执行设备的区别、管理员边界 |
| TC-DOC-02 | 正常 | S5 已改 `README.md` | 点击新增入口链接 | 锚点存在、可跳转到 FEATURES 对应标题；无大段重复 |
| TC-DOC-03 | 正常 | 手机端注释已改 | `grep -c "登录用户名" workbench/mobile/app.mjs` | 输出 ≥ 1；注释不再声称 `name` 可改 |
| TC-DOC-04 | 正常 | P1 未完成（若适用） | 阅读 FEATURES / TEST_REPORT | P1 未完成项被明确登记，未伪装成 P0 完成 |

---

## 5. 关键业务规则：正向 / 反向成对用例

| 规则 | 正向用例 | 反向用例 | 判定要点 |
| --- | --- | --- | --- |
| 显示名可改、用户名不可改（R-02） | TC-S1-10、TC-S2-10、TC-M-04 | TC-S2-30（带 `name` 字段）、TC-M-06（登录仍用用户名） | 改显示名成功；任何改用户名的尝试被拒且 `name` 不变 |
| 显示名默认回退用户名（R-02） | TC-S1-03、TC-S2-03、TC-M-01 | TC-S1-04（空串/空白也不得空白显示） | 旧数据永远显示非空名字 |
| 显示名校验（R-02/R-08） | TC-S1-20/21、TC-S2-10 | TC-S1-22…31、TC-S2-20…28、TC-S3-04 | 1 与 64 通过；其余非法输入 400 且不写库 |
| 显示名非唯一（R-02） | TC-S1-13、TC-S2-14、TC-M-29 | —（唯一性属于用户名；反向是「不被误判为 NAME_TAKEN」） | 同名允许；列表可消歧 |
| 资料更新只作用本人（R-07） | TC-S2-10、TC-S2-32 | TC-S2-29/30、TC-M-17 | 请求体 userId 不改变目标；他人数据逐字段未变 |
| 改口令踢其它、留当前（R-04） | TC-M-11、TC-R-02（既有套件） | TC-M-10、TC-R-02 中「原口令错误 401」 | 成功后其它会话 100% 失效；失败无副作用 |
| 会话撤销只撤本人、当前不可撤（R-05） | TC-M-12、TC-S2-43（被撤会话 401） | TC-M-13（失败不移除）、TC-M-17③（撤他人 403）、TC-S4-06/19 | 三件套齐全；当前会话不被误撤 |
| 退出登录清本地（R-06） | TC-M-25、TC-M-27 | TC-M-26（断网仍清）、TC-M-18（本机无按钮） | 任何网络结果下本地凭据都清除 |
| 停用账号不可用（R-07） | TC-S2-45（三路全拒）、TC-S1-43 | —（反向即「停用后任何一路成功」） | 登录 / 刷新 / 旧令牌 / 资料写全部失败 |
| `/me` 追加式兼容（R-10） | TC-S2-01、TC-S2-50 | TC-S2-04（不泄露敏感字段） | 旧字段名与类型不变；新字段只增不改 |
| 账号头像不混用 roster（P1/R-11） | TC-P1-01、TC-P1-06 | TC-P1-05（不写 roster）、TC-P1-02（非法值拒绝） | 两套头像命名空间互不写入 |

---

## 6. 执行命令、证据与判定汇总

### 6.1 命令矩阵（T-224 物化后，T-226 在仓库根逐条执行）

| 编号 | 命令 | 优先级 | 期望 | 对应用例 |
| --- | --- | --- | --- | --- |
| TC-R-01 | `node --test team-hub/user-store.test.mjs` | P0 | exit 0 | 回归（S1 改动面） |
| TC-R-02 | `node --test team-hub/identity-registration.test.mjs` | P0 | exit 0 | AC-07、AC-12 |
| TC-R-03 | `node --test team-hub/identity-registration-limit.test.mjs` | P0 | exit 0 | AC-12 |
| TC-R-04 | `node --test team-hub/identity-rate-limit.test.mjs` | P0 | exit 0 | AC-12 |
| TC-R-05 | `node --test team-hub/identity-remote.test.mjs` | P0 | exit 0 | AC-08、AC-12 |
| TC-R-06 | `node --test team-hub/account-quota.test.mjs` | P0 | exit 0 | AC-12 |
| TC-R-07 | `node --test team-hub/mobile-api-contract.test.mjs` | P0 | exit 0 | 手机端兼容（AC-12） |
| TC-R-08 | `node --test team-hub/identity-profile-store.test.mjs` | P0 | exit 0 | TC-S1-* |
| TC-R-09 | `node --test team-hub/identity-profile.test.mjs` | P0 | exit 0 | TC-S2-* |
| TC-R-10 | `pnpm --dir workbench build` | P0 | exit 0（`tsc --noEmit` 后 `vite build`） | TC-S3/S4 |
| TC-R-11 | `node --test workbench/scripts/identity-gate.test.mjs` | P0 | exit 0（全套，含 ⑦–⑲） | TC-S4-24 |
| TC-R-12 | `node --test workbench/scripts/account-profile.test.mjs` | P0 | exit 0 | TC-S3-* |
| TC-R-13 | `node --test workbench/scripts/account-page.test.mjs` | P0 | exit 0 | TC-S4-* |
| TC-R-14 | `node scripts/ci/check-docs.mjs` | P0 | **README.md 与 docs/FEATURES.md 的 FAIL 行为 0**（相对改动前基线零新增） | AC-16 |

补充口径：

- 命令前先记录**改动前基线**（同样命令的 exit code）。任何「改动前就红」的套件必须在 `TEST_REPORT.md` 归属原因，不得算作本次回归失败；任何「改动后新增红」必须定位到本目标改动。
- `pnpm --dir workbench build` 若因 worktree 缺 `node_modules` 失败：记 **BLOCKED**，写明 `workbench/node_modules` 不存在，**不得联网安装**（RK-9 / LEGION.md）。
- `check-docs` 对 `docs/G-*/` 的 banner 规则存在**预存红**（RK-E1）：只比较 README/FEATURES 的 FAIL 行，不为让脚本全绿去改上游冻结文档或其他目标目录。
- 单条复跑：`node --test <file> --test-name-pattern='TC-S1-22'`。

### 6.2 `TEST_REPORT.md` 证据记录模板

| 字段 | 内容要求 |
| --- | --- |
| 用例编号 | `TC-S1-22` 等 |
| 结果 | `PASS / FAIL / BLOCKED / N/A` |
| 执行的命令 | 精确到可复读，例如 `node --test team-hub/identity-profile-store.test.mjs --test-name-pattern='TC-S1-22'` |
| 输出要点 | exit code + 关键断言行；失败时贴前 20 行错误 |
| 证据路径/截图 | 截图、响应 JSON（脱敏）、DOM 走查记录 |
| 备注 | skip/blocked 原因；N/A 的等价覆盖用例 |

量化门槛（REQUIREMENTS §9.3）在报告末尾汇总：显示名非法输入 0 接受、跨用户写 0 成功、非管理员越权读 0 成功、会话撤销 0 误伤当前、旧数据 100% 回退、回归全 exit 0、敏感信息 0 处。

### 6.3 越权证据三件套格式（强制）

每条越权用例（TC-S2-29/30/32/40…46、TC-M-17）必须同时给出：

1. **请求**：method + path + 关键请求体（脱敏）；
2. **响应**：HTTP 状态 + 具名 `code`；
3. **数据未变**：操作前后目标行的逐字段对比（`displayName`、`name`、`password_hash` 以哈希形式、`disabled_at_ms`、`role` 行）。

只给「前端没显示按钮」不算通过（REQUIREMENTS §9.4）。

---

## 7. 测试代码骨架（供 T-224 直接物化）

> 以下片段只是**骨架**：断言已写成可判定的形状，T-224 按各切片文件域落地，T-226 原样执行。所有 test 名以用例编号开头。骨架中的 `update` / `readDisplayName` / `makeLegacyStore` 等辅助函数由 T-224 按 §2.2 夹具补齐。

### 7.1 `team-hub/identity-profile-store.test.mjs`（S1）

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { IDENTITY_CODES, IdentityError, createUserStore, hashPassword } from './user-store.mjs'

const KEY = 'test-signing-key-0123456789'
const INVALID = IDENTITY_CODES.INVALID_INPUT

function makeLegacyStore({ audit } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hub_users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, disabled_at_ms INTEGER,
    system_role TEXT NOT NULL DEFAULT 'none');
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT);`)
  let depth = 0
  const withTx = (mutate) => { /* BEGIN IMMEDIATE + SAVEPOINT，复制既有夹具 */ }
  const store = createUserStore({ db, withTx, clock: () => Date.now(), key: KEY, audit: audit ?? (() => {}) })
  return { db, store, withTx }
}

const codeOf = async (fn) => {
  try { await fn(); return null } catch (e) { return e instanceof IdentityError ? e.code : `UNEXPECTED:${e.message}` }
}

describe('账号资料仓储', () => {
  it('TC-S1-01 旧库补列后读取回退用户名', async () => {
    const { db, store } = makeLegacyStore()
    const hash = await hashPassword('legacy-password')
    db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)')
      .run('user-legacy', '旧数据兵', '旧数据兵', hash, Date.now(), 'none')
    const row = store.listUsers().find((u) => u.userId === 'user-legacy')
    assert.equal(row.displayName, '旧数据兵')
    assert.equal(row.avatar, '')
  })

  it('TC-S1-22 65 字符被拒且不写库', async () => {
    /* 前置：建 A-member 并保存 '旧显示名' */
    assert.equal(await codeOf(() => update({ displayName: 'A'.repeat(65) })), INVALID)
    assert.equal(readDisplayName(), '旧显示名')
  })

  it('TC-S1-31 长度口径是 UTF-16 code unit', async () => {
    assert.equal(await codeOf(() => update({ displayName: '😀'.repeat(32) })), null)
    assert.equal(await codeOf(() => update({ displayName: '😀'.repeat(33) })), INVALID)
  })

  it('TC-S1-42 审计失败时整体回滚', async () => {
    const { db, store } = makeLegacyStore({ audit: () => { throw new Error('audit down') } })
    /* 建用户 → 断言抛错 → display_name 与 password_hash 均未变 */
  })

  it('TC-S1-08 三处位置式 INSERT 已改显式列名', () => {
    const src = readFileSync(new URL('./user-store.mjs', import.meta.url), 'utf8')
    assert.equal((src.match(/INSERT INTO hub_users VALUES/g) ?? []).length, 0)
  })
})
```

### 7.2 `team-hub/identity-profile.test.mjs`（S2）

```js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-profile-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
let mod, base, adminToken, memberToken, memberId

const call = async (method, path, { body, token } = {}) => {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const get = (p, o) => call('GET', p, o)
const post = (p, b, o) => call('POST', p, { body: b, ...o })

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
  process.env.LEGION_REMOTE_AUTH = '1'
  mod = await import('./server.mjs')
  await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${mod.server.address().port}`
  mod.db.prepare("INSERT OR IGNORE INTO spaces (id, name) VALUES ('default', '默认空间')").run()
  await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password' }, { token: HUB_TOKEN })
  adminToken = (await post('/api/identity/login', { name: 'owner', password: 'owner-password' })).json.accessToken
  const invite = (await post('/api/identity/invites', { space: 'default', role: 'member' }, { token: adminToken })).json.code
  const reg = await post('/api/identity/invites/accept', { code: invite, name: '小兵', password: 'soldier-password' })
  memberId = reg.json.userId
  memberToken = (await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })).json.accessToken
})

after(() => { /* close server/db，rm tmpRoot（见既有夹具） */ })

describe('账号资料 HTTP 契约', () => {
  it('TC-S2-01 /me 旧字段名与类型不变', async () => {
    const r = await get('/api/identity/me', { token: memberToken })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.user.userId, 'string')
    assert.equal(r.json.user.name, '小兵')
    assert.ok(Array.isArray(r.json.roles))
    assert.ok(['admin', 'none'].includes(r.json.systemRole))
  })

  it('TC-S2-28 非法 JSON 映射为 IDENTITY_INVALID_INPUT', async () => {
    const res = await fetch(base + '/api/identity/profile', {
      method: 'POST',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
      body: '{displayName:',
    })
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.equal(body.code, 'IDENTITY_INVALID_INPUT')
  })

  it('TC-S2-32 请求体 userId 不改变目标且他人数据未变', async () => {
    const before = (await get('/api/identity/me', { token: adminToken })).json.user.displayName
    const r = await post('/api/identity/profile', { displayName: 'x', userId: 'user-other' }, { token: memberToken })
    assert.equal(r.status, 400)
    assert.equal((await get('/api/identity/me', { token: adminToken })).json.user.displayName, before)
  })
})
```

### 7.3 `workbench/scripts/account-profile.test.mjs`（S3）

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const load = (p) => {
  const src = readFileSync(new URL(p, import.meta.url), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

describe('显示名校验与账号摘要', () => {
  it('TC-S3-05 与服务端同一批输入同结论', async () => {
    const { validateDisplayName } = await load('../../src/accountProfile.ts')
    const cases = [
      ['A', true], ['A'.repeat(64), true], ['A'.repeat(65), false],
      ['', false], ['   ', false], ['a' + String.fromCharCode(0) + 'b', false], ['a' + String.fromCharCode(10) + 'b', false],
    ]
    for (const [input, ok] of cases) assert.equal(validateDisplayName(input).ok, ok, JSON.stringify(input))
  })

  it('TC-S3-12 执行设备数按 userId 过滤且排除已撤销', async () => {
    const { accountSummary } = await load('../../src/accountProfile.ts')
    const me = { userId: 'u1' }
    const devices = [
      { userId: 'u1', revoked: false }, { userId: 'u1', revoked: false },
      { userId: 'u1', revoked: true }, { userId: 'u2', revoked: false },
    ]
    assert.equal(accountSummary(me, { rows: [] }, devices).deviceCount, 2)
  })

  it('TC-S3-20 401 过期只重放一次', () => {
    const src = readFileSync(new URL('../../src/identity.ts', import.meta.url), 'utf8')
    assert.match(src, /IDENTITY_TOKEN_EXPIRED/)
    assert.match(src, /recoverSession\(\)/)
    assert.doesNotMatch(src, /if \(.*401.*\)[^]*?recoverSession\(\)[^]*?recoverSession\(\)/) // 只重放一次
  })
})
```

### 7.4 `workbench/scripts/account-page.test.mjs`（S4）

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const panel = read('../../src/components/AccountPanel.tsx')
const device = read('../../src/components/DevicePanel.tsx')
const settings = read('../../src/components/WorkspaceSettings.tsx')

describe('账号页结构', () => {
  it('TC-S4-01 七区块顺序齐全', () => {
    const titles = ['账号摘要', '基础信息', '账号信息', '账号安全', '登录中的设备', '执行设备', '账号管理']
    const idx = titles.map((t) => panel.indexOf(t))
    idx.forEach((i, n) => assert.ok(i >= 0, `缺 ${titles[n]}`))
    assert.deepEqual([...idx].sort((a, b) => a - b), idx)
  })

  it('TC-S4-09 本机机器令牌模式整块不渲染', () => {
    assert.match(panel, /const active = hasSession\(\)/)
    assert.match(panel, /if \(!active && loaded\) return null/)
  })

  it('TC-S4-10 非管理员不请求用户列表', () => {
    const m = /if \(info\.systemRole === 'admin'\)[^]*?listUsers|listUsers[^]*?systemRole === 'admin'/.exec(panel)
    assert.ok(m, 'listUsers 必须在管理员分支内')
  })

  it('TC-S4-14 显示名以纯文本渲染', () => {
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML/)
    assert.match(panel, /\{me\?*\.displayName\}|\{me\.displayName\}/)
  })

  it('TC-S4-15 结果经 aria-live 播报', () => {
    assert.match(panel, /role="status"|aria-live/)
  })
})
```

---

## 8. 覆盖自查（逐条对应本任务验收标准）

| 本任务验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 用例覆盖 主路径 + 边界 + 异常，每条含 前置条件 / 步骤 / 期望结果 | §4.1–§4.7 全部用例表；每条五列齐备 | ✅ 正常/边界/异常/越权/兼容/回归六类；P0 自动化 125 条 + 手工 30 条 + 回归 14 条 |
| 验收标准被用例化：有明确的通过 / 失败判据 | §3 AC 追踪矩阵（通过判据 + 失败判据两列）、每条用例「期望结果 / 通过判据」、§6 状态口径 | ✅ 16 条 AC 全部映射；PASS/FAIL/BLOCKED/N/A 口径明确，BLOCKED 不算 PASS |
| 关键业务规则同时有正向与反向用例 | §5 成对表（显示名、用户名不可改、非唯一、越权、改口令、撤会话、退出、停用、`/me` 兼容、头像隔离） | ✅ 11 组规则逐组给出正反用例编号 |
| 边界：把验收标准逐条翻译成可执行用例 | §3、§4、§6.1 命令矩阵 | ✅ 每条自动化用例都有落点文件、测试名、命令 |
| 边界：不执行用例 | §0.2、§6 | ✅ 本轮未运行 `node --test`/`pnpm build`；命令交 T-226 |
| 边界：不写业务实现代码 | 全文 | ✅ 未改任何产品代码；附录仅为测试骨架 |
| 处理历史评论 | §0.1 | ✅ 派工为「（无）」 |

---

## 9. 变更记录

| 版本 | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| v1 | 2026-10-29 | 测试用例（构验） | 首版：基于已校验的 REQUIREMENTS / RESEARCH / TASK_BREAKDOWN，把 AC-01–AC-16 落成 L1–L5 五层用例（S1 仓储 37 条、S2 HTTP 43 条、S3 纯函数 21 条、S4 结构 24 条、手工 30 条、P1 12 条、文档 4 条、回归 14 条，合计 185 条），给出正反成对规则表、通过/失败判据、越权三件套格式、证据模板与可直接物化的测试骨架；明确本阶段不执行、不写实现、不创建 T-224 文件域内的测试文件。 |

---

> **本文件到此为止。** T-224 按 §7 骨架物化测试文件；T-226 按 §4/§6 执行并逐条登记；任何用例被删改弱，必须在 `TEST_REPORT.md` 说明理由并由 T-225 复核。
