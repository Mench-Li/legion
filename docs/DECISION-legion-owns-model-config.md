# DECISION｜Legion 拥有模型配置，DSH 的配置由它**派生**

> 裁决：将军 2026-10-09。起因是 BUG-014 的第二层 —— 我修成"让用户去登 DSH"，
> 被将军一句话否掉：**「我最终是反向包 DSH 的……配置直接入库，用户感知不到是 DSH才对」**。
> 那份修法是**方向错**，不是在错的方向上修得不够。

## 1. 目标（用可感知的行为写）

用户在**指挥台**里增删改模型供应商与密钥 → 保存 → **引擎立刻用新的**。
全程**没有跳转、没有登录页、没有 DSH 字样**。DSH 是这个产品里的一个部件，不是用户要去的地方。

## 2. 现状：今天有**两份**真相，而且都比对的

| | 存在哪 | 谁在用 | 谁写它 |
| --- | --- | --- | --- |
| Legion 的模型档案 | `team-hub/team.db` 的 `model_profiles`（provider+model 粒度）+ `agent_models` 岗位绑定 | 岗位派工、`/api/chat/health` 的解析链 | 指挥台 → `POST /api/model-profiles`（已存在） |
| Legion 的密钥 | team-hub 的 **DPAPI 保护库**（`security/secrets/store.mjs`） | `model/api-key`（产品自有引用名） | `POST /api/secrets`（已存在） |
| **DSH 的活配置** | `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai.providers` + `agent-default-model` | **引擎真正读的那一份** | 人手改 / DSH 自己的设置页 |
| **DSH 的密钥** | `$DSH_HOME/.credentials.yaml`（`refs` 与 `records` 两个键空间） | 引擎 | 人手改 / `credential-materializer.mjs`（仅 Run 期 `model/api-key`） |

**BUG-001 → BUG-004 → BUG-014 这一串，本质是同一件事的不同侧面**：两份真相在"谁说了算"上从来没有定过，
于是每一次都靠人工把一边对齐到另一边（BUG-004 §4 就是一次手工对齐）。

## 3. 方向：**单向**，Legion → DSH

```
指挥台（Legion 的 UI，用户只看到这个）
   │ 写
   ▼
Legion 的库：team.db model_profiles / agent_models ＋ DPAPI 密钥库      ← 唯一真相
   │ 物化（进程内，无 HTTP/无 cookie/无登录）
   ▼
DSH 的活配置：ctx.settings.mutate(llm-pi-ai) ＋ ctx.credentials.set()   ← 派生，随时可重建
   │ 读
   ▼
引擎（真正发模型请求的那一段）
```

**反向的那条路（DSH → Legion）只允许出现在两个地方**：一次性**导入**（§5 P1）与**影子对账**（§5 P2）。
除此之外，DSH 的文件被谁手改了，物化器下一轮就把它收敛回来 —— 这正是"唯一真相"的含义。

## 4. 为什么**不**手写 `cordis.patch.yml` / `.credentials.yaml`

那两份文件**各有自己的唯一正确写入口**：

| 目标 | 正确入口 | 证据 |
| --- | --- | --- |
| `llm-pi-ai` 的 providers | `ctx.settings.mutate(ns, ops, expectedRevision)` | `packages/settings/settings/src/index.ts:367`（带 schema 校验、乐观锁 revision、分层合并） |
| 模型密钥 | `ctx.credentials.set(ref, value)` / `unset(ref)` | `credentials/credentials/src/index.ts:201/209`（`modifyRecord` 是唯一写路径，理由写在 `:166`） |
| 目录与实时模型 | `ctx.llm`（`listProviders` / `listModels` / `resolveModelInfo`） | `api/session-controller/src/catalog.ts` 用的就是它 |

绕过它们直接改文件 = **在本仓最忌讳的地方开第二份真相**（层级/patch 合并/schema 全部要自己重实现一遍，
而 DSH 一升级就会分叉）。而上面这三个服务**在 legion-services 里是进程内直连的** ——
`legion-services` 就是宿主里的一个插件（`inject = ['webServer']`），它不需要 DSH 的会话，也不需要 HTTP。

> BUG-014 修的 `/api/dsh-models` 桥（转发到 DSH **已鉴权**的 `/api`）从根上就是错的传输方式：
> 它假设了"进去的唯一办法是走 DSH 的公开 API"。**进程内直连一直是可用的，只是没人用。**

## 5. 分四段实施（每段可独立验收；**危险动作放最后**）

> **进度**：**P0 ✅**（`8b48a60c`）· **P1 ✅**（见 §10）· **P2 ✅**（见 §11）· **P3 ✅**（见 §13，**默认关**）· P4 待做。

### P0 拆掉错的方向（小）
- 删 `GET /api/dsh-models/connect`、面板的「连接 DSH 服务」按钮、`DSH_MODELS_LOGIN_URL`（legion-services / config-schema 两处）。
- **保留** BUG-014 的 `dsh-models-base`（同源相对路径 + 网络层具名文案）—— 它修的是另一个真缺陷。
- 记一份订正：这两轮的错法（在错误的传输方式上加固）连同新方向一起写进文档。

### P1 导入现状（**只读 DSH**，不写）
- 用 `ctx.settings.describe({redactSecrets:true})` + `ctx.llm` 把 DSH 里**活着**的供应商与型号读出来，
  导入 Legion 的 `model_profiles`（含 `endpoint` / limits）。
- 密钥：只登记**引用名**与"是否已配置"，**不读值、不搬运**（值留在 DSH 那份里，P3 再谈是否迁）。
- 验收：导入后 Legion 侧"能看到的供应商/型号集合" == DSH 侧"活着的集合"（逐条比对，可复跑）。

### P2 影子物化（**只报告，不写**）
- 物化器算出 `desired`（从 Legion 库）与 `actual`（`ctx.settings.describe`）的 **diff**，写一行审计：
  `新增 N / 修改 M / **将被删除 K**`。
- **必须连续 N 轮 diff 为空**才允许进 P3。这一段的唯一目的：把"接管会删掉什么"先看见。
- 验收：diff 报告与人工核对一致；且它**一个字节都没写**（用例钉住：影子模式下调用的 mutate 次数 = 0）。

### P3 接管写入（**这一段开始不可逆**）
- `settings.mutate('llm-pi-ai', ops, revision)` 写 providers；`ctx.credentials.set` 写密钥。
- **写后自证**：立刻用 `ctx.llm.listProviders()` / `settings.describe()` 回读，断言读回来
  **逐字等于**要写的那一份；证不出来就报错并回滚（与 `credential-materializer.mjs` 同一条纪律：
  判据不是"我写进去了"，而是"**读者读回来了**"）。
- 删除策略：Legion 里删掉的供应商，物化时 `unset`；但**带墓碑**（`model_profiles.deleted_at_ms` 已有），
  避免"误删一个还在用的"变成不可恢复。

### P4 收敛兜底（**让它自愈**）
- 宿主启动时收敛一次（有人手改过 DSH 文件 ⇒ 拉回来）；
- 低频周期收敛（如 5 分钟）作为兜底。
- 与 BUG-012 同一条纪律：**收敛器必须只在差异存在时写**，且每一轮把"改了什么/为什么"记一行，
  否则它就是下一次"静默改配置"的来源。

## 6. 缺的那一块：Legion 侧没有 **provider 实体**

今天 Legion 的 `model_profiles` 是 **(provider, model)** 粒度（BUG-004 登记了 3 行 fjd-ds 的三个型号），
而 DSH 的 `llm-pi-ai.providers.<id>` 是一个**供应商实体**，带 `api` / `baseURL` / `models[]`。

所以物化的映射是 **分组**：`model_profiles` 按 `provider` 分组 → 一个 DSH provider 条目。
这要求同组各行的 `endpoint` / 协议**一致**——今天没有东西保证这一点。

**建议（P1 一并做）**：新增 `model_providers` 表（provider / display_name / api / base_url / secret_ref），
`model_profiles.provider` 引用它；`api` 协议与 `base_url` 从"每行都有"上移到"每个供应商一份"。
这是把散落的隐含约束变成显式实体的那一步，也是"目录"这个概念第一次在 Legion 里有了名字。

## 7. 验收判据（可复跑，逐段）

| 段 | 判据 |
| --- | --- |
| P0 | `connect` 路由与登录按钮在仓库里 0 命中；`dsh-models-base` 仍 5/5 绿 |
| P1 | 一条只读比对脚本：Legion 侧集合 == DSH 侧活集合（逐条，含 endpoint 与 limits） |
| P2 | 影子 diff 报告 + 用例断言"影子模式 0 次写" |
| P3 | **写后回读逐字相等**（新增/修改/删除/密钥各一条）；证不出来必须回滚 |
| P4 | 启动收敛幂等（连续两次收敛，第二次 0 次写）；手改 DSH 后下一轮被拉回 |

## 8. 边界与不做什么

- **不碰 DSH 的其它命名空间**：只写 `llm-pi-ai`（+ 需要时 `agent-default-model`），别的一律只读。
- **不搬密钥值**进 team.db：那是普通 SQLite，会被备份/复制（BUG-013 里刚见过 34 MB 的 `.bak`
  差点被打进公开安装包）。值走 DPAPI 库，物化时取出即用。
- **不做"双向同步"**：DSH 侧被外部改动，处置是**收敛回来**，不是合并。合并需要一个三方 diff 的语义，
  而那个语义今天不存在、也不该在这一步发明。
- **不删 `credential-materializer.mjs`**：它服务的是**Run 期**的 `model/api-key`，与本条（目录/供应商）
  是两件正交的事；本条只复用它的**纪律**（真读者回读比对）。

## 9. 我在这条线上已经犯过的两次同类错（记下来，因为它解释了这个决定为什么必须由人下）

1. BUG-014 第一版：把桥接层的**地址**修对了（真缺陷），但没问"这条桥本身该不该存在"。
2. BUG-014 第二版：在**错误的传输方式**上又加了一层（登录跳转），把方向错当成层数不够。

两次都是"在给定的那层里把活干好"，而不是"先问这一层对不对"。
**判据：动手之前先答一句"用户最终看到的是什么"。** 这一条如果早问，两轮都不会发生。

## 10. P1 实施记录（2026-10-09）

### 10.1 新增了什么

| 位置 | 内容 |
| --- | --- |
| `team-hub/provider-store.mjs` | `model_providers` 表 + 仓储：`list` / `get` / `isEmpty` / `importSnapshot` |
| `team-hub/routes/model-providers.mjs` | `GET /api/model-providers`（只读目录）· `POST /api/model-providers/import`（幂等导入） |
| `services-plugin/index.js` | `readDshProviderSnapshot(ctx)`（宿主进程内只读 DSH 活目录）· `maybeBootstrapProviderImport(...)`（**只在 Legion 目录为空时**导一次） |
| 判据 | `team-hub/model-providers-routes.test.mjs`（11 例）· `services-plugin/provider-import.test.mjs`（7 例） |
| 基线登记 | `ROUTE_FAMILY_SOURCES` + `SCHEMA_SOURCES` 各补一条 —— **不登记就是一个"门禁一声不吭、而它的路由/表不存在"的形状** |

### 10.2 快照怎么读出来的（P1 的只读那一半）

在**宿主进程内**（`legion-services` 就是宿主里的插件）：

```
"活着"   以 ctx.llm.listProviders() 为准（引擎真正认得的供应商）
"细节"   从 ctx.settings.describe({redactSecrets:true}) 的已声明配置里取 api / baseURL / apiKeyEnv
"型号"   从 ctx.llm.listModels(id) 取（来自引擎，不来自配置文件）
"配没配" 只问 ctx.credentials.describe(ref).configured —— **永不读值**
```

两条容易做错、各有用例钉住的规则：

- **活着但没声明的供应商也要收进来**（细节留 `null`）。否则一个引擎认得的供应商会因为
  "配置文件里没写"而从目录里消失 —— 而"引擎认得它"才是要紧的事实。
- **三个服务一律 `ctx.get` 软取**：缺席 ⇒ 返回空 + 原因，**绝不抛**。
  把"宿主没这个服务"变成"整个插件 pending ⇒ team-hub 与指挥台都不启动"，
  是这条链上后果最大的一种错（我自己在 BUG-014 第二版踩过一次，见 §9 与护栏用例）。

### 10.3 引导导入为什么"只在空的时候"

这是 §3 那条方向纪律的执行点：

```
空目录   → 读 DSH → POST /api/model-providers/import   （一次性导入）
非空     → 只 GET，**一次写都不发**                      （Legion 已经是真相）
```

反过来说：如果每轮启动都拿 DSH 的现状覆盖 Legion，那么"有人手改了 DSH 文件"就会
静默变成"Legion 也跟着改了"—— 那时 Legion 不再是真相，而**没有任何读数会说话**。
用例 ⑤ 直接断言"非空时只允许一次 GET，不许有 POST"。

### 10.4 判据与反向验证

| 套件 | 例数 | 结果 |
| --- | --- | --- |
| `team-hub/model-providers-routes.test.mjs` | 11 | 全绿（真实 HTTP + 真实 SQLite） |
| `services-plugin/provider-import.test.mjs` | 7 | 全绿（假 ctx / 假 fetch） |

**反向验证 13/13 全部实测变红**（每条不变量各有一个变异）：

| 变异 | 结果 |
| --- | --- |
| M1 幂等失效（每次都推进 version） | 红 ①/①b |
| M2 导入改成"用快照替换整张表" | 红 ②（并连带 ①/⑥） |
| M3 未知字段改成忽略（静默收下带 `apiKey` 的请求） | 红 ③ |
| M4 `secretRef` 不再校验形状 | 红 ④ |
| M5 型号白名单静默丢弃（不报名字） | 红 ⑤ |
| M6 墓碑行当成"新建" | 红 ⑥ |
| M7 重复 id 不拒绝 | 红 ⑩ |
| M8 用 `credentials.resolve()` 读值 | 红 ② |
| M9 活着但没声明的被丢掉 | 红 ③/④/⑤ |
| M10 服务缺席时抛错 | 红 ④/⑥ |
| M11 非空也照样导入（方向纪律失效） | 红 ⑤ |
| M12 请求不带令牌 | 红 ⑤b |
| M13 中枢不可达时抛错 | 红 ⑥ |

**门禁**：`ci-syntax` / `scan` / `check-docs` / `encoding` / `doc-table` 全绿。
`prt-baseline` 仍为 **2 红，与 main 相同** —— 原因是**别人的** `createSiteRoutes`
没有登记进 `ROUTE_FAMILY_SOURCES`（不是本段引入；本段把我自己的族与表都登记了，
所以我的新增对基线可见，没有加重新漂移）。

### 10.5 活体验收（待一次宿主重启）

`services-plugin` 是宿主插件，所以这一段**必须在重启后**才算真的验过。重启后期的读数：

| 看哪里 | 期望 |
| --- | --- |
| `.legion-services.log` | 出现 `供应商引导导入：新增 N / 更新 0 / 未变 0（来自 DSH 现状；N 个供应商）` |
| `GET :8787/api/model-providers` | 供应商集合 == DSH 侧活着的集合（**含 `svea-ds`** —— §4 量到的那个：DSH 有而 Legion 没有） |
| 再重启一次 | 日志变成 `Legion 目录**已非空** → 不导入`（这是方向纪律生效的正面读数） |
| `team.db` 的 `model_providers` | 只出现引用名（如 `FJD_DS_API_KEY`），**没有任何密钥值** |

**这一段是 P2 的输入**：P2 的影子对账要拿这份目录与 DSH 现状做 diff，先看见"接管会删掉什么"。

## 11. P2 实施记录（2026-10-09）：影子物化 —— 只报告，不写

### 11.1 新增了什么

| 位置 | 内容 |
| --- | --- |
| `services-plugin/materialize-plan.mjs` | **纯函数**：`normalizeForCompare` / `planMaterialization` / `describeMaterializationPlan` / `changedFields`。没有 ctx、没有网络、没有时钟 |
| `services-plugin/shadow-materialize.mjs` | 执行那一半：读 Legion 目录（经中枢 API）+ 读 DSH 快照 → 出计划 → 记一行。**只碰读方法** |
| `services-plugin/dsh-snapshot.mjs` | 从 `index.js` **搬出来**的 `readDshProviderSnapshot`（理由见 11.4） |
| 判据 | `services-plugin/shadow-materialize.test.mjs`（11 例） |
| 接线 | `index.js` 在 P1 引导导入之后跑一次影子对账，并把"本轮有无差异"记成显式读数 |

### 11.2 它守的三件事（每件都是"在别处会被读成没事"的那种）

**① 它真的一个字节都没写。** 这一条的文字版谁都会写（"P2 只报告"），
而**只有探针能让它可验**：夹具把 `settings.mutate` / `credentials.set` / `credentials.unset`
换成"一被调用就记名 + 抛"的探针 ⇒ 任何一次误写立刻红。
它的价值不只在这一段：**P3 落地时同样这套探针也会红**，除非那时**有意**把这条改成"允许写"——
那时它是一次该被看见的改动，而不是一个静默的漂移。

**② "接管会删掉"的那几条必须被点名。** 这是 P2 存在的唯一理由。
`planMaterialization` 的 `delete` 集合、以及渲染行里的 `**接管会删掉**：<id…>` 都在守它。
一条只报"新增/修改"的影子对账，与一条**看得见删除**的影子对账，在"我今天不想删任何东西"的日子里
是同一个读数 —— 而那正是最危险的那种巧合。

**③ 读不到 DSH 现状时不许说 `clean`。** 两侧都空会让 diff 干净，
于是"读失败"会伪装成"完全一致" —— 而"完全一致"正是"接管后什么都不用改"这个结论的来源。
这正是本仓反复出现的那一族错（BUG-009-a 的探测器、BUG-010 的假停摆、P1 的幂等读数）。

### 11.3 ★ 实施中发现并修掉的一个**真缺陷**：`readOk`

第一版我用一个字符串启发式判断读失败：

```
actualReadOk = !(snap.providers.length === 0 && snap.reason !== '')
```

它在"宿主没有 `llm` 服务"时正确，但在**"宿主读成功、就是零个供应商"**时也判成读失败 ——
因为那两件事在返回形状上是**同一个空数组**。是我自己的用例 ⑨ 把它逼出来的
（"宿主说没有供应商"与"读不出来"必须分得开）。

修法是给读者加一个显式字段：

```
{ providers, readOk, reason }
   no llm service  → { providers: [], readOk: false, reason: '宿主没有 llm 服务' }
   llm 说零个供应商 → { providers: [], readOk: true,  reason: '宿主当前没有任何可用供应商' }
```

> 一个"用别的字段去**推断**读没读到"的判据，
> 与一个"读者自己说读没读到"的判据，在两边都不为空的时候长得一模一样。

连带修掉 P1 日志里的一处措辞：`readOk: true` 且零个供应商时不再说"读不出"，
而是明说"这是**读到了、就是空**，不是读失败" —— 两个事实在日志里也得分得开。

### 11.4 ★ 顺手拆掉的一个循环导入

`readDshProviderSnapshot` 本来住在 `index.js` 里，而 P2 也要用它 ⇒
`index.js ↔ shadow-materialize.mjs` 成了**循环导入**。那次能跑（ESM 活绑定 + 调用发生在两模块都求值完之后），
但它属于"今天能跑、失败方式取决于谁先被加载"的结构。搬到 `dsh-snapshot.mjs` 后依赖图是单向的：

```
index.js → shadow-materialize.mjs → { dsh-snapshot.mjs, materialize-plan.mjs }
index.js → dsh-snapshot.mjs        （并 re-export，保持 P1 的用例与导入路径不变）
```

> 一个"两个模块互相 import、但调用发生在求值之后"的循环，
> 与一个"没有循环"的依赖图，在今天的运行结果上是同一个东西 ——
> 只不过前者的失败方式取决于**谁先被加载**。

### 11.5 判据、反向验证与全链活体读数

| 套件 | 例数 | 结果 |
| --- | --- | --- |
| `services-plugin/shadow-materialize.test.mjs` | 11 | 全绿 |

**反向验证 9/9 全部实测变红**：

| 变异 | 结果 |
| --- | --- |
| M1 ★ 影子模式真的去写（加一次 `settings.mutate`） | 红 ⑦/⑧/⑨/⑪（探针记名） |
| M2 ★ 用"数组空不空"判断读失败（丢掉 `readOk`） | 红 ⑨ |
| M3 ★ 不报"要删的"（`remove` 恒为空） | 红 ④/⑤/⑧ |
| M4 两侧字段不映射（`secretRef` 不认成 `apiKeyEnv`） | 红 ①/②/③/⑥ |
| M5 型号比较对顺序敏感 | 红 ② |
| M6 读数行里不点名要删的 id | 红 ④ |
| M7 输入模态不排序（`[text,image]` ≠ `[image,text]`） | 红 ② |
| M8 差异不指明字段（`update` 只留 id） | 红 ③ |
| M9 缺凭证不报 | 红 ⑥ |

**全链活体读数**（真实 `cordis.patch.yml` 的声明 → 临时库 → 真实 HTTP → 影子对账）：

```
1) P1 导入      → 200 { created: 2, updated: 0, unchanged: 0 }
2) P2 对账      → 新增 0 / 修改 0 / 删除 0 / 未变 2（clean=true）
                  写探针被碰过吗：没有（影子模式确实只读）
3) 反向（DSH 侧多一个 ghost-ds）
                → 新增 0 / 修改 0 / 删除 1 / 未变 2（clean=false）；**接管会删掉**：ghost-ds
                  写探针被碰过吗：没有
```

第 2 步就是 P1 → P2 的**闭环读数**：P1 把 DSH 的现状收进来之后，P2 看到的差异是**零**。
如果跳过 P1 直接接 P3，第 3 步那个形状（`ghost-ds` / 真实的 `svea-ds`）就会在第一次运行时**被删掉**。

### 11.6 P3 的放行条件（现在还**不放行**）

- 现在每次宿主启动只对账**一次**，所以"连续多轮无差异"这个条件**还没有被满足**——
  跑一次 clean 只能证明"此刻一致"。要拿到"连续 N 轮"，需要 P4 的周期对账（如每 5 分钟一次），
  或在几次真实重启后由日志人工确认。
- 除"无差异"之外，P3 还需要**写入侧**的判据：写后用真读者回读逐字相等、否则回滚
  （§5 P3）。那一段的代码与判据都还没写。
- 因此当前状态是：**P3 未放行**，DSH 的活配置**一个字节都还没被 Legion 改过**。

## 12. P3 的设计与一个必须先定的分叉（2026-10-09，**代码未写**）

### 12.1 供应商那一半（`ctx.settings.mutate`）没有分叉

`plan` 的三个集合各自翻译成一条 ops：

| plan | ops |
| --- | --- |
| `create` / `update` | `[{ op: 'set', path: ['providers', id], value: { displayName, api, baseURL, apiKeyEnv, models } }]` |
| `delete` | `[{ op: 'unset', path: ['providers', id] }]` |
| 凭证 | 不走 settings，见 12.2 |

外加 §5 那条纪律：**写后必须用真读者回读**（`settings.describe()` + `llm.listProviders()`），
逐字等于要写的那一份；证不出来就回滚并报错。
判据不是"我写进去了"，而是"**读者读回来了**"（与 `credential-materializer.mjs` 同一条）。

### 12.2 ★ 凭证那一半有一个分叉：值怎么从 Legion 的库到宿主进程

实测：team-hub **没有任何"取明文值"的路由**
（`routes/secrets.mjs` 只有 `GET /status`、`GET /api/secrets`（列表，仅元数据）、`POST`（写入/轮换）、`DELETE`）。
也就是说"让插件经 HTTP 向中枢要密钥值"这条路**今天不存在**。

于是有两个选择：

| | 做法 | 代价 |
| --- | --- | --- |
| **(a) 在宿主进程内直读 DPAPI 库**（推荐） | 插件 import `security/secrets/store.mjs` 的 `createProductSecretStore` + 布局解析，按引用名读出值，直接交给 `ctx.credentials.set` | 需要拿到 `layout.secretsFile`（`secret-admin.mjs` 已有解析逻辑）；插件与密钥库必须是同一 Windows 用户（**是**：都是这个桌面会话里起来的进程） |
| (b) 给中枢加一条"取值"路由 | `GET /api/secrets/<ref>/value`，令牌 + 仅本机 | **新增一条明文出网面**：任何能访问 :8787 且拿到令牌的东西都能取走全部密钥 |

**我选 (a)**，理由是它**不新增任何明文传输面**：

> 一个"密钥值经过一次 HTTP 响应、只是那条路由做了鉴权"的设计，
> 与一个"密钥值从不离开进程内存"的设计，在**今天**的安全姿态上是同一档 ——
> 区别在**明天**：前者会在某一次"顺手加个调试端点""顺手把日志级别调高"里漏出去。

而且 (a) 复用产品自己的受保护库（`createProductSecretStore` = 文件后端 + DPAPI，
`assertProtectedStore` 默认只放行 `dpapi-user`），不是另开一条读法。

### 12.3 P3 的开关必须是**显式**的，且默认关

P3 是这条链上唯一不可逆的一段（会 `unset` 掉 DSH 里 Legion 没有的供应商）。
因此它的启用必须是配置里一个**显式**的布尔（默认 `false`），而不是"代码写完就生效"：

- 默认关：物化器只算不做，行为与 P2 完全相同（可用例钉住：开关关时写探针一次都不被碰）；
- 打开：需要一次重启（宿主要重新读配置），并且**打开的动作本身要留痕**（日志明说"接管已开启"）。

### 12.4 这一轮的结论

- P0 ✅ / P1 ✅ / P2 ✅ 都已合入并推送。
- **P3 未开始**：上面 12.2 的分叉需要记录在案（本轮已记），12.3 的开关设计要在写代码时一并落地。
- P3 的放行条件（连续多轮无差异）仍未被满足 —— 需要 P4 的周期对账，
  或在几次真实重启后由日志人工确认。

## 13. P3 实施记录（2026-10-09）：接管写入 —— 门、写、回读、回滚

### 13.1 新增了什么

| 位置 | 内容 |
| --- | --- |
| `services-plugin/materialize-ops.mjs` | **纯函数**：计划 → ops（逐叶子）+ 逆 ops + `expectedResidual` / `verifyResidual` |
| `services-plugin/materializer.mjs` | 四步：门 → 写 → **写后回读重新出计划** → 证不出来就回滚 |
| `services-plugin/legion-secrets.mjs` | 从 Legion 的受保护库按引用名取**值**（宿主进程内，不经 HTTP） |
| 接线 | `index.js` 在影子对账之后调用；两道门都来自配置（**默认关**） |
| 判据 | `materializer.test.mjs`（19 例）· `legion-secrets.test.mjs`（6 例） |

### 13.2 两道门，都默认关

```
applyModelConfig         （LSH_APPLY_MODEL_CONFIG / LEGION_APPLY_MODEL_CONFIG）      默认 false
applyModelConfigDeletes  （…_DELETES）                                               默认 false
```

**为什么门是必需的**：这是整条链上唯一不可逆的一段（会 unset 掉 DSH 里 Legion 没有的供应商）。
"能写"与"在写"之间必须隔着一个**显式**动作，而不是"代码写完就生效"。
用例 ⑦b 专门钉"**不传 `enabled` 也等同于关**"——"没写就是开"是最坏的一种默认。

**删除为什么是第二道门**：整块 unset 的逆操作只能还原"读者看得见的叶子"
（`dsh-snapshot.mjs` 是白名单读者）。别人放进那块里的未知字段**还原不了**。
所以默认只报告、不执行；门开了才真删（用例 ⑮/⑯ 各钉一侧）。

### 13.3 验收 = **写后由真读者重新出计划**

判据不是"mutate 被调过"，也不是"写者按自己的理解比了一遍"，而是：

```
写 → 用 P2 的同一个读者重读 DSH → 用 P2 的同一个函数重新出计划 → 剩下的差异必须**恰好**
     是我们有意跳过的那几条（跳过的删除 / Legion 里没有值的凭证）
```

> 一个"写者按自己的理解验自己"的验收，
> 与一个"读者按界面同一条判据验"的验收，在写入正确时是同一个读数。

★ 这里有个非显然但很要紧的点：验收**不能**用"绝对干净"。
跳过删除时 `delete > 0` 永远成立 ⇒ 每次都判失败 ⇒ 每次都回滚，而日志上看起来像"DSH 不听话"。
所以判据是"残余差异恰好等于有意跳过的那几条"（`expectedResidual` + `verifyResidual`，用例 ⑤）。

### 13.4 ★ 实施中发现并修掉的三个**真缺陷**

**① 凭证状态从供应商快照推断 ⇒ 同一个问题前后两次答案不同。**
第一版用 `readDshProviderSnapshot` 的 `credentialConfigured` 判断"要不要写凭证"。
那个字段只对**已经存在**的供应商有意义：一条**还没建**的供应商在快照里没有条目 ⇒
取不到 ⇒ 被当成"已配" ⇒ 写之前不要求凭证、写完之后又要求 ⇒
**写进去、回读不通过、然后回滚**（实测 P3 用例 ⑧⑨ 全红）。

> 一个"从邻近的字段推断凭证状态"的判据，
> 与一个"直接问凭证服务"的判据，在供应商都已经存在时是同一个读数。

修法：`readCredentialState()` 直接问 `ctx.credentials.describe(ref)`（引用名是**全局**的，
不按 provider 存放），写前写后各问一次，两侧用同一份权威读数。

**② `expectedResidual` 读 `.length` ⇒ 判据永远失败。** 它收的是**个数**，
写成 `credentialRefsLeft.length` 在调用方传数字时得到 `undefined`，而 `undefined !== 0`
⇒ 每次都判失败、每次都回滚（日志写着"仍缺凭证 1 个（期望 undefined）"）。

**③ `wrote` 报成了"走到了写入这一段"，而不是"真的发出了写"。**
在"有凭证要补、而 Legion 里没值可补"那条路径上什么都没写，却报 `wrote: true` ——
而"这轮写过没有"是人判断"接管有没有生效"的唯一依据。修法与新增用例 ⑱（尾部那段）。

### 13.5 值那一半：宿主进程内直读，不经 HTTP

`legion-secrets.mjs` 复用**产品自己的**受保护打开路径
（`product/paths.mjs` 的 `resolveLayout` + `product/secrets.mjs` 的 `openProductSecrets`，
`requireProtected: true` 写死），按引用名 `store.get(ref)`。

**取不到一律返回 `null`，绝不返回空串** —— 调用方把空串当成"有一把空钥匙"写进 DSH，
会**毁掉**一把正在用的真钥匙（用例 ② 用四种"取不到"逐一钉住；M6 变异实测变红）。

这也解释了 P1 引导导入之后的常态：**引用名收进来了、值仍留在 DSH 那边继续工作** ——
Legion 里没有值 ⇒ 物化时不动 DSH 的凭证 ⇒ 模型照常可用。

### 13.6 判据与反向验证

| 套件 | 例数 | 结果 |
| --- | --- | --- |
| `materializer.test.mjs` | 19 | 全绿（假宿主的 `mutate` **真的会改自己的状态**，读者再真的读它） |
| `legion-secrets.test.mjs` | 6 | 全绿 |
| P1+P2+P3 合计 | **61** | 全绿 |

**反向验证 12/12 全部实测变红**：门失效（M1，靠新增的 ⑦b）· 整块覆盖（M2，连带 11 例红）·
删除门失效（M3）· 写后不验（M4）· 不通过也不回滚（M5）· 写空串当凭证（M6）·
取不到值仍写（M7）· `requireProtected` 不传（M8）· 凭证状态从快照推断（M9，4 例）·
残余差异读 `.length`（M10，7 例）· `wrote` 恒真（M11，靠新增的 ⑱）· 读不到现状照样写（M12）。

★ 其中 **M1 与 M11 第一次跑时"没被咬住"** —— 那不是变异写坏了，而是**我的用例有缺口**：
⑦ 显式传了 `enabled: false`（没验默认值）、⑫ 走的是"提前返回"那条路（没验尾部）。
补了 ⑦b 与 ⑱ 之后两条都被咬住。**一个"没被变异咬住"的读数，先怀疑用例，再怀疑变异。**

### 13.7 P4 的衔接（下一步）

- 现在每次启动对账/物化**一次**。要满足"连续多轮无差异"，需要 P4 的**周期**对账
  （如每 5 分钟），或几次真实重启后由日志人工确认。
- P4 还要做**启动收敛兜底**：有人手改了 DSH 文件 ⇒ 下一轮把它拉回来
  （这正是 §3 那条"收敛而不是合并"的落地），并沿用同一条纪律：**只在差异存在时写**，
  每轮把"改了什么/为什么"记一行。
- 与 BUG-012 同一条：收敛器必须能被"连续两轮 0 次写"验幂等。
