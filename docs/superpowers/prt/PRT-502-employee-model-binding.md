# PRT-502：岗位模型绑定与 fallback

**对应 spec**：§6.6（Model Configuration 的 `EmployeeModelBinding`）、§6.7（冻结时点）
**交付物**：
- `orchestrator/model-binding/index.mjs` —— **纯**解析逻辑（候选链 + 理由）
- `team-hub/binding-store.mjs` —— 仓储（`employee_model_bindings`）
- `team-hub/server.mjs` —— 5 条路由
- 套件 `model-binding`（18 例）、`binding-store`（16 例）、`binding-routes`（10 例）
- `scripts/prt/baseline-snapshot.mjs` —— **修正**表清单采集范围 + 覆盖率门禁

---

## 1. 这个模块要回答的唯一问题

> 「这条任务用的是哪个模型，为什么是它？」

它必须**可回答**，因为换模型会同时改变三件事：**成本、质量、以及数据去了哪**。
三件都不可见时，一次"用错了模型"的运行在事后完全没有痕迹——它能跑完、
能出结果、看起来正常。

进度表在 PRT-502 那一行留了一句话：「旧路径实测**按岗位模型未生效**
（`gf001-run.mjs` 的 `modelDrift`）」。也就是说，这个问题在旧路径上**确实
发生过**，而且是被一个专门的偏差检测探针抓出来的，不是靠人去读日志。

因此本批把"解释"做成一等产物：解析返回的不是一个模型，而是一条**带理由的链**。

---

## 2. 四条判定

### ① 主档案解析不出来 = 绑定不可用，**不允许 fallback 悄悄顶替**

fallback 存在的意义是"主档案**运行时**连不上"，不是"配置写错了替我兜住"。

让 fallback 悄悄顶替的后果是：`primaryProfile` **一直是错的**，而每一次运行
都在用一个没人选过的模型——而且没有任何报错。这与 §6.6
「不得在未获用户批准时自动切换到更昂贵模型」是同一条纪律：模型换了而没人批准过。

```js
const r = resolveModelChain({ binding, profiles })
r.ok                  // false
r.code                // 'PRIMARY_UNRESOLVED'
r.message             // 「…**不自动降级到 fallback**——fallback 是为"运行时连不上"
                      //   准备的，不是为"配置写错了"准备的…」
r.chain               // ['p-b']  ← 备用仍被解析出来（诊断要看得到）
r.chain[0].role       // 'fallback'  ← **不**被改写成 primary
```

备用仍然出现在 `chain` 里：诊断面板要能回答"本来会用什么"。但它的 `role`
保持 `fallback`——把角色改写成 `primary` 会让"这个岗位的主档案是哪个"
这个问题在事后无法回答。

**写入时也验**：`upsert` 会先按当前档案试解析一次，主档案不可用直接 409。
等到运行时才发现 `primaryProfile` 打错了，那次运行已经认领了任务、烧掉一次
尝试，而错误出现在**运行日志**里——不是在"保存配置"这个动作上，后者才是
真正能改的地方。

### ② 不可用的备用 = "跳过 + 理由"，不是错误

备用档案被下线是正常运维动作。但**必须报出来**：链短了一位，意味着真实的
容错余量比配置上看起来少一位。

```
skipped: [
  { id: 'p-nope', role: 'fallback', order: 2, code: 'PROFILE_NOT_FOUND', message: '…' },
  { id: 'p-c',    role: 'fallback', order: 3, code: 'PROFILE_DELETED',    message: '…' },
]
```

**"不存在"与"已下线"必须分开报**：前者去查是不是 id 打错了，后者去找谁把它
下线的。混成一个码，运维的动作就有一半是错的。

`order` 保留原位置：运维要知道"第 3 位那个不可用"，而不是"少了一个"。

### ③ 链是有序且去重的

同一个档案在一次解析里出现两次（主档案也在 fallback 列表里）会让"重试"变成
**对着同一个模型重试**——那不是容错，是把一次瞬时故障变成两次同样的失败。

去重并如实报告：

```js
skipped: [{ id: 'p-main', code: 'PROFILE_DUPLICATE',
            message: '…重试同一个模型不是容错，而是把一次瞬时故障变成两次同样的失败' }]
```

### ④ 解析结果里没有密钥，也没有引用名的值

只有 `hasCredential: true|false`。与 PRT-501 的 `toModelDescriptor` 同一条纪律。
用例在**序列化后的原始响应字节**上断言——在解析出来的对象上断言不够，
`JSON.stringify` 会把 `undefined` 字段丢掉。

---

## 3. 形状错误用异常，配置问题用返回值

这条分界是刻意的：

| 情形 | 表达 | 理由 |
| --- | --- | --- |
| `binding` 不是对象 | **抛** `BindingError` | 调用方的代码错 |
| `fallbackProfiles` 不是数组 | **抛** | 写错的结构不能被读成"没有备用" |
| `profiles` 类型不对 | **抛** | 调用方的代码错 |
| 主档案不可用 | 返回 `ok:false` + 码 | 这条岗位的**配置**有问题，是可诊断的正常情形 |
| 备用不可用 | 返回 `skipped` | 正常运维结果 |
| 预算形态不对 | 返回 `ok:false` + 码 | 配置问题 |

混成一种会让**真正的代码错**被当成一条正常的配置诊断埋在日志里——
而配置诊断是"过一会儿有人会去看"的东西。

---

## 4. `perRunBudget`：只做形态校验，但必须严格

执行（原子预留、结算、取消、Unknown Outcome 锁定）是 PRT-503/510。本批只校验形态，
而形态校验必须严格，因为**一个坏掉的预算对象在 PRT-503 落地后会直接变成
"预算没有上限"**——一条静默的、花钱的失败。

```
{ maxCst: 5 }              → 拒绝（未知字段；拼错的字段被忽略等于没有上限）
{ maxCost: 5 }             → 拒绝（金额脱离币种不构成上限）
{ maxCost: -1 }            → 拒绝
{ maxTokens: Infinity }    → 拒绝
{ maxCost: 2.5, currency: 'USD', maxTokens: 100000 }  → 通过
null / undefined           → 通过，表示"没有预算"
```

未知字段**拒绝而不是忽略**这一条尤其重要：`maxCst` 被静默忽略后，配置界面上
看起来配了预算，而实际没有上限。

---

## 5. 冻结时点：`chainSnapshot`

spec §6.7：「密钥轮换只影响轮换后创建的 Run」。在这里的对应物是：一次 Run
启动时把当时排好的链**记下来**。

```
{ employeeRole, ok, code, order: [{id, role}], skipped: [{id, code}], perRunBudget }
```

**只存 id 与角色顺序，不存 provider/model 的值。** 那些值会随档案改动而变，
存下来会变成两份互相矛盾的真相；id + 顺序足以在事后按时间线还原。

拿现在的配置去反推三个月前那次运行用了什么模型，答案一定是错的。

---

## 6. 仓储：三条与纯逻辑不同的关注点

### ① 坏掉的持久化数据不许被当成"没有"

`fallback_profiles_json` 读不回来时，**不能**当成"没有备用"：配置上写着三位备用，
实际只有一位——而这个差别只在主档案真的连不上时才显形。那时容错已经用掉了，
而没有任何地方说过"余量少了一位"。

```js
r.ok      // false
r.message // 「…绑定数据读不出来（fallbackProfiles）：不能当成"没有备用"继续——
          //   那会让容错余量静默归零」
```

### ② 解析**不缓存**

缓存会让"档案下线了但解析还在返回它"持续存在，而这段时长取决于缓存策略——
一个"改了配置但不生效、过一会儿又生效"的现象。这条路径不在热路上（每次 Run
开始解析一次），没有理由为它引入一个时间窗。

有用例专验这一点：改一次档案数组，下一次解析必须立刻反映。

### ③ 绑定物理删除，档案墓碑——这个不对称是**有意的**

档案会被历史 Run 引用（所以要留墓碑，PRT-501）；绑定不会被——绑定只是
"现在该用哪个"，历史 Run 记的是解析出来的**顺序快照**，不是绑定本身。

---

## 7. 抓到的真实缺陷：异常逃到兜底处理器变成 500

解析路由最初是这样写的：

```js
const scope = url.searchParams.get('scope')
const role = url.searchParams.get('role')
const r = bindingStore.resolve(scope, role)   // 缺 role 时 requireKey 抛 ROLE_REQUIRED
```

这个分支**没有**包在 `handleRun` 里（`handleRun` 会把 `e.statusCode` 映射出去），
于是异常逃到外层兜底处理器 → **500**。

后果不是"状态码不好看"：调用方少传一个参数，报成了"服务端出错"。运维会去查
服务端日志，而真正要做的是补上参数。

修法是**显式验参数**：

```js
if (role === null || role.trim() === '') {
  json(res, 400, { ok: false, code: 'ROLE_REQUIRED', error: '…没有岗位就没有"该用哪个模型"的主语' })
  return
}
```

这与 PRT-308 的 `next-post` 那次是同一条教训：**用异常表达正常的流程控制，
会让状态码失去意义。**

---

## 8. 抓到的第二个真实缺陷：新的建表模块又一次对基线不可见

PRT-501 修过一次——`dbTables` 只扫 `server.mjs`，于是运行面建的五张表对契约
基线完全不可见。

这一次加了 `binding-store.mjs` 的新表，记录基线时发现 **`数据表` 仍是 27**。
同一个缺陷、换了个模块，**立刻又发生了一次**。

这说明单纯"把列表补全"不够：**"记得更新列表"这件事本身需要门禁**。

于是加了覆盖率检查（`baseline-snapshot.test.mjs` 的例 ⑤）：

1. 遍历所有可能放 schema 的目录（`team-hub` / `orchestrator` / `runtime` /
   `security` / `product`），找出含 `CREATE TABLE IF NOT EXISTS` 的**非测试**源文件；
2. 逐个断言它们在 `SCHEMA_SOURCE_PATHS` 里；
3. **反向也查**：登记了却不再建表的文件要报出来——列表老化会让下一个人以为
   它被覆盖了。

错误信息直接给出该怎么做：

```
这些文件建表但未登记进 SCHEMA_SOURCES：它们的表对平台契约基线不可见。
请在 scripts/prt/baseline-snapshot.mjs 的 SCHEMA_SOURCES 里加上它们。
```

**验过会变红**：把 `'bindingStore'` 从数组里注释掉，例 ⑤ 与例 ④ 立刻失败。

修完后基线由 **107 路由 / 27 表** 变为 **112 路由 / 28 表**。

---

## 9. 路由

```
GET    /api/model-bindings                    ?scope= 可选，按 scope 过滤
POST   /api/model-bindings                    建或整体替换
GET    /api/model-bindings/resolve            ?scope=&role= 「该依次用哪些，为什么」
GET    /api/model-bindings/<scope>/<role>     绑定本体
DELETE /api/model-bindings/<scope>/<role>     删（物理）
```

`/resolve` **必须**排在前缀块之前：`/api/model-bindings/resolve` 也满足
`startsWith('/api/model-bindings/')`，前缀块会把 `resolve` 当成一个 scope 名。
有用例专验这一点。

`<scope>/<role>` 两段**分别**解码：整段解码会把 scope 里被编码的 `/` 也解出来，
于是切错位置——看起来像"绑到了别的岗位"。

状态码三分：

| 情形 | 码 |
| --- | --- |
| 少传参数 / 路径段数不对 | 400 |
| `(scope, role)` 没有绑定 | 404 |
| 引用的档案不存在或已下线 | 409 |

---

## 10. 未交付

- **没有接到真实执行路径上。** 这一批交付的是"绑定与解析"，而
  `runtime/adapters/dsh/` 目前仍然从**别处**取模型，不查 `employee_model_bindings`。
  也就是说：进度表里 `modelDrift` 那个现象，在**运行面**还没有被这条链修掉。
  接线属于 PRT-253/254（DSH 适配器的模型来源）。
- **PRT-504 连通性测试**：`chain` 里的是"按配置应该依次尝试的候选"，
  **不是"已验证可用"**。两者混为一谈会让"配置齐全"看起来像"能跑"。
- **fallback 的运行时切换未实现**：本批只排出顺序，没有任何代码在主档案
  运行时失败后真的去试下一个。那需要先有 PRT-504（区分"连不上"与"模型拒绝"）。
- **`perRunBudget` 未被执行**：PRT-503/510。
- **平台默认模型未定义**：绑定不存在时 `resolve` 返回
  `BINDING_NOT_FOUND`，由调用方决定默认是什么——本模块不替它编一个。
  但"平台默认"目前**没有**任何实现。
- **岗位名没有校验**：`employeeRole` 只要求非空字符串，不校验它是否真的是
  某个已存在的岗位。一个拼错的岗位名会安静地建出一条永远不会被用到的绑定。
- **没有迁移**：旧路径的 `agent_models(scope, role, provider, model)` 与本表
  并存，两者互不同步。收敛属于 PRT-506。
- **批量解析未提供**：一次 Run 可能涉及多个岗位（流水线），目前要逐个调。
- **`chainSnapshot` 没有被任何运行记录写入**：它是"冻结时点"的正确形状，
  但还没有人调用它——要等到运行面真的按绑定选模型。

---

## 11. 复跑方式

```bash
node --test orchestrator/model-binding/model-binding.test.mjs  # 18 例，纯函数
node --test team-hub/binding-store.test.mjs                    # 16 例，内存库
node --test team-hub/binding-routes.test.mjs                   # 10 例，真 HTTP
node --test scripts/prt/baseline-snapshot.test.mjs             # 17 例（含 schema 采集覆盖率）
node scripts/ci/run-ci.mjs --only test                         # 全套
```
