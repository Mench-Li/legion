# T-208 代码审查报告：外部执行者（soldier-*/general）头像补齐

> 角色：reviewer（代码审查 · 鉴微）｜任务：T-208｜所属目标：G-mv7kzgnu-1（software · chain）｜依赖上游：T-207（coder，已 done）
> 审查对象：T-207 提交 `b8f66e64`，合入 main 的合并提交 `7613e949`（本 worktree 分支 `w/T-208` HEAD 即该合并）
> 审查方式：只读代码 + 独立复跑 + 真实库离线探针；**全程不替人改代码**（唯一写盘 = 本报告）
> 落盘路径：`docs/review/T-208-REVIEW.md`（per-task 独立文件，不写公共 `docs/REVIEW.md`）
> 上游依据：`docs/G-mv7kzgnu-1/REQUIREMENTS.md`（T-203，R-1~R-11 / AC-R*）· `docs/G-mv7kzgnu-1/TASK_BREAKDOWN.md`（T-205，冻结契约 + 切片 S1~S5）· `docs/G-mv7kzgnu-1/TEST_CASES.md`（T-206）

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| P0 门槛（M-1~M-5、M-7） | ✅ 全部满足（有独立复跑 + 真实库探针证据，见 §2） |
| **必须修改（阻塞项）** | **0 项** |
| 建议优化 | 10 项（O-01~O-10），其中 O-01/O-02/O-03 值得在 T-209/T-210 与后续目标显式跟踪 |
| 越界/纪律 | ✅ 未发现越界；改动仅落在 `team-hub/**`、`workbench/src/**`、`workbench/scripts/**`、`scripts/ci/run-ci.mjs`、文档；无 `git push`、无 taskctl、无新增依赖、未落库 |
| 第二套视觉表（C3） | ✅ 未发现：`external-agents.ts` 只有 name→token，颜色/形状仍单一来源 `slots.ts` |

一句话：**这是一次范围克制、契约忠实的实现；P0 门槛全部达成，没有必须返工的缺陷。** 下面第 5 节列出的都是"可以不阻塞合入、但应记录/后续处理"的点，其中最重要的一条是 R-8 兜底在备用池被占满的空间恒失效（T-205 已把它降为"默认不满足"，属已知让步而非 T-207 缺陷）。

---

## 1. 审查范围与方法

- **服务端** `team-hub/agent-avatars.mjs`（新增 `EXTERNAL_AVATAR_TOKENS` / `externalAvatarFor`）、`team-hub/routes/team-views.mjs`（`/api/roster` 投影改造）。
- **客户端** `workbench/src/avatar/external-agents.ts`（新增镜像表）、`workbench/src/avatar/index.ts`、`Sidebar.tsx`、`WorkspaceNavigation.tsx`、`SkillsPanel.tsx`。
- **测试** `team-hub/team-views-routes.test.mjs`、`workbench/scripts/external-avatar-parity.test.mjs`（新）、`agent-avatar-surfaces.test.mjs`、`agent-avatar-settings.test.mjs`、`scripts/ci/run-ci.mjs` 登记。
- **文档** `README.md`、`docs/FEATURES.md`、`workbench/README.md`、`docs/G-mv7kzgnu-1/REQUIREMENTS.md`（banner）。
- 方法：`git show b8f66e64` 逐文件读 diff → 读落地源码与位面/资产表 → 复跑受影响套件与 typecheck + 文档门禁 → 用**真实 `team-hub/team.db` 快照**离线复算 `/api/roster` 投影（探针脚本用后即删，未入库）。

---

## 2. 独立验证证据（命令与结果）

| # | 命令 | 结果 |
| --- | --- | --- |
| E1 | `node workbench/scripts/external-avatar-parity.test.mjs` | tests 5 / **pass 5 / fail 0** |
| E2 | `node team-hub/team-views-routes.test.mjs` | tests 20 / **pass 20 / fail 0**（含改写后的 ⑥、新增 ⑥c/⑥d/⑥e） |
| E3 | `node workbench/scripts/agent-avatar-surfaces.test.mjs` | tests 9 / **pass 9 / fail 0**；`agent-avatar-settings.test.mjs` tests 8 / **pass 8 / fail 0** |
| E4 | `cd workbench; node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| E5 | `node workbench/mobile/avatar-parity.test.mjs` / `avatar-photo.test.mjs` / `agent-avatar.test.mjs` | 6 / 10 / 12 例，**fail 0**（移动端镜像与位面表未回归） |
| E6 | `node team-hub/scripts/migrate-avatars.test.mjs` / `seed-roster.test.mjs` | 7 / 6 例，**fail 0**（内编分配与迁移口径不回归） |
| E7 | `node scripts/ci/evidence-banner.mjs --check` | PASS（87 个证据快照目录均带 banner） |
| E8 | `node scripts/ci/check-docs.mjs` | PASS（11 类校验全绿） |
| E9 | 真实库离线探针（`team.db` 只读，复刻 `team-views.mjs:74-129` 逻辑 + 真实 `externalAvatarFor` + 移动端 `resolveSlot`） | **software rows=12 / invalid=0 / distinctAvatars=12**，4 条外部条目 `general=s11、soldier-a=s12、soldier-b=s13、soldier-auto=s14`；`ozon` soldier-market=s15，invalid=0；全库 29 行 **INVALID 0** |
| E10 | `git show --stat b8f66e64`、`git status --short` | 16 文件 / +349-16；审查结束后 worktree 干净（临时探针已删） |

E9 的关键性：它**不是**在测试夹具上跑，而是在真实数据上验证 M-1/M-2/M-3/M-4，直接回答了"软件流水线空间那 4 个 Agent 到底换没换上头像"。

---

## 3. 验收标准逐条对照

### 3.1 成功标准 M-1~M-7

| 编号 | 判据 | 结论 | 依据 |
| --- | --- | --- | --- |
| M-1 覆盖 | software 12 条全满足 R-1（非法=0），其中 4 条外部为本次新增 | ✅ | E9：invalid=0；4 条外部令牌 s11~s14 非 placeholder |
| M-2 无非法令牌 | `/api/roster` 全空间非法计数=0 | ✅ | E9：29/29 通过 `isAvatarToken && resolveSlot!==null` |
| M-3 唯一可辨 | software 12 条令牌/位面去重仍 12；4 条不占内编 key | ✅ | E9 distinctAvatars=12；E1 TC-S2-03 断言 5 个 key 不在 `BUILTIN_ROLE_KEYS` 且互异 |
| M-4 稳定 | 冻结表 + 纯函数 + 排序遍历 ⇒ 重复请求/重启恒定；内编与 ozon 令牌不变 | ✅ | `agent-avatars.mjs:75-91` 无随机/时钟；E2 ⑥d 断言"同 name 同集合恒同""与 usedTokens 顺序无关"；本次未写库 |
| M-5 一致 | general 在 S1/S2/S3 同令牌；外部在 S1/S4/S5/S7 走同一 roster 令牌 | ✅（S6 按 D-4 不联动，已记录） | 两端表 deepEqual（E1 TC-S2-01）+ 侧栏/左轨/技能标签都取 `externalAvatarToken('general')=human:s11`；S6 3D 见 §5 观察项 |
| M-6 无副作用 | 除 avatar 外字段不变；agentCount / role 集合 / 归属不变 | ✅ | 改动只在两个**读出口**，无 `UPDATE/INSERT`；未动 `agent-intake`/`seed`；E6 通过 |
| M-7 无破图 | 非法/缺失令牌落确定性占位；外部走矢量无图片 404 面 | ✅ | `AgentAvatar.tsx:221-243` 未改；s11~s15 在 `photo-assets.ts` 无图 ⇒ 天然走矢量，无破图路径 |

### 3.2 需求 R-1~R-11（逐条）

| 需求 | 结论 | 依据 / 说明 |
| --- | --- | --- |
| R-1 判据 | ✅ | `isAvatarToken`（`agent-avatars.mjs:16-20`）+ `resolveSlot`（`slots.ts:89-94`）双判；测试显式用 `human:general` 假绿反例（E1 TC-S2-02）钉住"格式合法但无位面" |
| R-2 4 条外部获头像 | ✅ | E9；`team-views.mjs:126` 改用 `externalAvatarFor`，`'⚙️'` 硬编码已删 |
| R-3 general 三面一致 | ✅ | `Sidebar.tsx:178`、`WorkspaceNavigation.tsx:46` 均取同一常量 → s11；与目录 general 条目同源 |
| R-4 唯一可区分 | ✅ | 冻结表 s11~s15 两两不同；E9 software 12 去重=12；s11~s15 未被任何 roster 行占用（真实库核验） |
| R-5 确定性 | ✅ | 纯函数；排序遍历（`team-views.mjs:125`）；无 `Math.random/Date.now/fetch`（E2 ⑥e 源码扫描） |
| R-6 全展示面一致 | ✅（S6/S7 按既定范围处理） | S1/S4/S5 从 roster 取令牌；S7 移动端由服务端令牌 + `mobile/avatar.mjs` 同位面（E5 parity）；S6 3D 按 D-4 不联动 |
| R-7 读出口不产非法令牌 | ⚠️ 部分（见 O-01） | `/api/roster` 已收敛（:117/:126 双路都只投影合法令牌）；`/api/agents`（`read-models.mjs:256-259`）**未归一化**，靠真实库恰好干净过关 —— 非本 diff 引入 |
| R-8 后续新增自动获头像 | ⚠️ 默认不满足（见 O-02，T-205 已登记为已知让步） | 兜底池被冻结表占去 s11~s15，只剩 s01~s10；实测 ozon roster 已用满 s01~s10 ⇒ 该空间未登记名字恒返回 `''` |
| R-9 无不可见副作用 | ✅ | 无写库；未新增身份键；前端 key 仍是 `scope+role` |
| R-10 回退降级 | ✅ | 空串/非法 → `PLACEHOLDER_SLOT`；外部走矢量（无 404 面） |
| R-11 其它空间 | ✅ | E9：ozon soldier-market 也拿到 s15，全库非法=0（D-3 取"纳入"） |

---

## 4. 编码规范与工作区纪律审查

- **边界与错误处理**：`externalAvatarFor` 对非字符串 / 空名 / 池满返回 `''`（`agent-avatars.mjs:76-89`），E2 ⑥d 覆盖 `''/null/undefined` 与 emoji 入参；`usedTokens` 逐项经 `isAvatarToken` 过滤。✅
- **命名**：`EXTERNAL_AVATAR_TOKENS` / `EXTERNAL_AGENT_AVATARS` / `externalAvatarFor` / `externalAvatarToken` 语义清晰、两端命名对称。✅
- **测试覆盖**：新增套件已登记进 `scripts/ci/run-ci.mjs:2042`（否则"写了不跑"）；**含假绿反例**（`human:general` 必须 `resolveSlot===null`），这一点值得肯定 —— 它防的正是本仓库反复踩的"格式合法即通过"。✅
- **工作区纪律**：提交只含 T-207 文件域；无 `git add -A` 夹带；无跨 worktree 改动；E10 显示审查前后 worktree 干净。✅
- **依赖/离线**：`workbench/package.json` dependencies 仍恰好 5 个，无新增；无出网。✅
- **文档同步**：README / docs/FEATURES / workbench/README 口径改为"外部执行者也拿 human:<key> 人形令牌"；旧"⚙️ xxx · 执行中"说法已清零；E7/E8 门禁 PASS。✅

---

## 5. 问题清单

> 按严重度分级：**高**=阻塞验收；**中**=可能造成错误结论或后续返工，应记录/排期；**低**=一致性/健壮性/可维护性。

### 5.1 必须修改（阻塞项）

**无。** 本目标是"补齐已有展示面的身份头像 + 不破坏既有语义"，T-207 的实现与 T-205 冻结契约逐字一致，P0 门槛（M-1~M-5、M-7）与 R-1/R-2/R-3/R-4/R-5/R-9/R-10 均有可复现证据（§2）。没有发现正确性缺陷或契约违背，故不虚构返工要求。

> 若将军要把 R-8 的兜底容量也纳入本目标门槛，则 O-02 会升级为阻塞项 —— 但它属**上游已裁决的范围问题**（T-205 §6 明确记为"默认不满足 / 需扩容 s16..s24，超出方案 A 默认，待将军裁决"），不应记在 T-207 头上。

### 5.2 建议优化

| 编号 | 严重度 | 位置 | 问题 | 修改建议 |
| --- | --- | --- | --- | --- |
| **O-01** | 中 | `team-hub/routes/read-models.mjs:256-259`；`team-hub/server.mjs:1447` | `/api/agents` 直接透传 `roster.avatar`，没有像 `/api/roster` 那样做"非法 ⇒ 空串"归一化；而列 DEFAULT 仍是 `'🤖'`。R-7 的目标是"**所有**读出口只出合法令牌或空串"，当前只是真实库恰好 0 非法（E9 核验 24 行全 `human:*`）而无事。**非本 diff 引入。** | 与 `team-views.mjs:117` 同口径：`avatar: isAvatarToken(r.avatar) ? r.avatar.trim() : ''`；或在报告里显式声明 `/api/agents` 不在本目标范围（R-7 背景只点名 team-views:119）。 |
| **O-02** | 中 | `team-hub/agent-avatars.mjs:83-89` | R-8/AC-R8-1 的字面要求（任何 scope 新出现的 `tasks.soldier` 都拿到合法令牌）在默认方案下**不成立**：冻结表占去 s11~s15，兜底只剩 s01~s10，而实测 ozon 的 10 个内编已用满 s01~s10 ⇒ ozon 下未登记名字恒 `''`。当前真实数据 5 个外部全命中冻结表，故 M-1/M-2 不受影响。 | 保持现状可以，但**不得沉默**：在 T-209/T-210 报告与后续目标登记"无脸外部身份的空间"；若要真正满足 AC-R8-1，需按 T-205 记录的扩容路线同步 4 处（`slots.ts` 的 SPARE_KEYS、`mobile/avatar.mjs`、`agent-avatar.test.mjs` 的 SPARES、`avatar-parity.test.mjs` 的 40 断言）。 |
| **O-03** | 中 | `team-hub/agent-avatars.mjs:79-80`（冻结分支）× `agent-avatars.mjs:101-104`（`allocateAvatarToken`） | 冻结分支**先于** `usedTokens` 过滤返回，且 `allocateAvatarToken` 从 s01 起扫描（上界 s99）会分配 s11~s15。当前 s11~s15 未被任何 roster 行占用所以不触发；一旦某空间自建岗位增长到占用 s11~s15，`general` 等冻结身份会与 roster 行**同脸**，函数无法自救。 | 二选一即可：① `allocateAvatarToken` 跳过 `EXTERNAL_FROZEN_TOKENS` 占用的 key；② `externalAvatarFor` 冻结分支发现 `usedTokens` 已含该令牌时退到兜底。另建议给这条加一条"冻结 vs 已占用"的回归断言。 |
| **O-04** | 低 | `workbench/src/avatar/avatar.css:21-31` vs `workbench/src/index.css:196-205`（`.user-avatar`）与 `workbench/src/workspace.css`（`.workspace-user`） | 两个新头像容器**不在** `avatar.css` 的"填满徽章 + 按徽章圆角裁切"容器清单里，且保留了文字头像时代的死样式（`font-size/font-weight/color/background`）。目前靠 `.agent-avatar-svg/-img { border-radius: inherit }` 才圆得起来（未做浏览器渲染级验证，故列低）。 | 把 `.user-avatar` / `.workspace-user` 加进 `avatar.css:21` 的容器选择器清单，并清掉死样式，避免"两套圆角策略"长期并存。 |
| **O-05** | 低 | `workbench/src/components/WorkspaceNavigation.tsx:46` + `workbench/src/avatar/AgentAvatar.tsx:178` | 改前该 `span` 的文本是「管」（可读作"空间管理员"）；改后只剩 `<svg role="img" aria-label="成员头像">`，读屏语义从"管理员"退化为"成员头像"。 | 给 `span` 加 `aria-label="空间管理员"`，或对该纯装饰场景让头像 `aria-hidden`。 |
| **O-06** | 低 | `workbench/scripts/agent-avatar-surfaces.test.mjs:62`（非贪婪到首个 `</div>`）与 `:70`（`.workspace-user` 到 `<AgentAvatar` 距离 ≤160 字符） | 源码扫描正则对格式/换行敏感：一行被格式化工具折行或属性增多就可能**假红**，换错节点则可能**假绿**。 | 用更稳的锚点（解析到 `</span>` 配对、或抽出 `className` 到组件的结构断言），或把距离上限改为"同一 JSX 元素内"。 |
| **O-07** | 低 | `team-hub/team-views-routes.test.mjs`（用例 ⑥，`ext.avatar === '' \|\| isAvatarToken(ext.avatar)`） | 该夹具所在空间备用池是空的，实际应拿到合法令牌，却允许空串 —— 断言弱于 AC-R8-1，无法区分"兜底正常工作"与"直接放弃"。 | 让 ⑥ 断言非空且合法；空串只保留在 ⑥d 的"池满"夹具里。 |
| **O-08** | 低 | `workbench/scripts/external-avatar-parity.test.mjs:26-30` | 套件 import 了 `SERVER`，但只用于 TC-S2-01 的**表**比对；服务端 `externalAvatarFor` 的兜底行为不在本套件覆盖内（由 `team-views-routes.test.mjs` 覆盖）。"表相等"与"分配函数行为相等"是两件事，未来只改服务端兜底而表不动时 parity 套件不会红。 | 补一条：对未登记名字，两端函数返回一致（当前都应为 `''`）；或加注释明确分工。 |
| **O-09** | 低 | `workbench/src/components/Sidebar.tsx:4-5`、`WorkspaceNavigation.tsx:8` | 同一模块用了两条导入路径（`../avatar` 与 `../avatar/external-agents`），而 `workbench/src/avatar/index.ts:6` 已经二次导出 `externalAvatarToken`。 | 统一从 `../avatar` 导入，保持组件层对 barrel 的单一入口。 |
| **O-10** | 低 | `docs/STATUS.md:24-27` | T-199 先例把 6 个新增套件逐一登记；T-207 新增第 7 个套件（`external-avatar-parity`）并已登记进 `run-ci.mjs`，但 STATUS.md 无对应记录。 | 补一行新套件登记（非阻塞；headline 基线本就滞后）。 |

### 5.3 观察项（非问题，供下游知情）

1. **外部条目在响应数组中的顺序变了**：由 `bySoldier` 插入序改为按身份名排序（`team-views.mjs:125`）。这是为满足 AC-R5-1（分配与任务插入顺序无关）的有意修复；AC-R9-1 约束的是字段而非数组顺序，故不构成回归。
2. **未登记名字的令牌会随"同空间其它未登记名字"的增删而漂移**（FNV 取模的分母是动态候选集）。AC-R5-1 只要求"同一数据重复请求恒定"，当前满足；但不要把它当成"跨数据版本恒定"。已由 O-02 的容量说明覆盖。
3. 提交信息与 diff 一致，无夸大（核对 16 个文件的实际改动）。✅

---

## 6. 边界与越界声明

- ✅ 本报告只**读**代码与仓库、只**写** `docs/review/T-208-REVIEW.md`；未修改任何实现/测试/文档产物，未调用 `taskctl` / `task_*` / 看板写接口，未 `git push`，未联网、未安装依赖。
- ✅ 真实库探针用的是只读连接（`readOnly: true`），临时脚本 `probe-t208.mjs` 用后即删；审查结束时 `git status --short` 除本报告外无其它改动。
- ✅ 未触碰 `docs/G-mv1s6y49-1/`（上一目标的目录，其 `TEST_CASES.md:181` 的 TC-S3-07 旧口径由本目标的 T-206 用例显式推翻，符合范围边界）。

---

## 7. 给下游的建议

- **T-209 tester**：按 T-205 §6 的五组复跑，其中「连续 3 次请求 + 重启一致」与「其它空间令牌逐条不变」建议直接用本报告 §2 E9 的真实库探针口径；R-8 的"池满"路径要按 AC-R8-1 的**非必过**口径记录，不要判成回归。
- **T-210 devops**：部署后强刷 / 清 Service Worker（`workbench/mobile/sw.js` 非代码资源 cacheFirst）；核对 `workbench/dist` 构建产物含新逻辑。
- **后续目标（如将军愿意）**：把 O-02（备用池扩容到 s16..s24）与 O-01（`/api/agents` 归一化）合成一个小目标处理，二者都不大，但都关乎"R-7/R-8 的字面承诺"。

---

## 8. 审查结论

**通过（无必须修改项）。** T-207 对 G-mv7kzgnu-1 的实现：范围克制（只动两个读出口 + 三个展示面 + 一张镜像表）、契约忠实（`human:s11..s15` 冻结表两端 deepEqual）、证据自洽（P0 判据在真实库上 invalid=0、12/12 唯一）。10 项建议优化均为健壮性/一致性/可维护性改进，建议随后续小目标处理，不阻塞本目标进入测试与部署阶段。
