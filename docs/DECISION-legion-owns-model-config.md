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

> **进度**：**P0 ✅**（`8b48a60c`）· **P1 ✅**（见 §10）· P2 / P3 / P4 待做。

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
