# PRT-501：ModelProfile 数据模型与 API

**对应 spec**：§6.6（Model Configuration）、§6.7（Secret Store）
**交付物**：
- `team-hub/model-store.mjs` —— 仓储（CAS、墓碑、审计脱敏守卫）
- `team-hub/server.mjs` —— 6 条路由（`GET/POST /api/model-profiles`、`GET/PATCH/PUT/DELETE /api/model-profiles/<id>`）
- `runtime/contracts/model.mjs` —— **修正**密钥判据（见 §6）
- 套件 `model-store`（20 例）、`model-routes`（14 例）、`contract`（+1 回归例）
- `scripts/prt/baseline-snapshot.mjs` —— **修正**表清单的采集范围（见 §7）

---

## 1. 校验只有一处

写入路径复用 `runtime/contracts/model.mjs` 的 `validateProfile`（PRT-102 交付的）。
API 层**不**再写一遍校验。

理由不是"避免重复劳动"：重复的后果是**两处判据会漂移**，而漂移的那一次就是把明文
密钥写进库的那一次。`validateProfile` 已经覆盖三层：

| 判据 | 拦住什么 |
| --- | --- |
| 未知字段拒绝 | 密钥搭便车（`apiKey: '...'` 这种自造字段） |
| 键名/值形态 | `sk-…`、`AKIA…`、`ghp_…`、JWT、`user:pass@host` |
| `endpoint` 内嵌凭证 | `https://user:pass@api.example.com` |

`runtime/contracts/model.mjs` 的注释里已经写明这条纪律：
「靠评审纪律守不住，必须让写入路径直接拒绝」。

---

## 2. 读出去的东西不含 `secretRef`

`toModelDescriptor` 连**引用名**都不给，只给 `hasCredential: true|false`。

引用名也是可枚举的攻击面：知道引用名就离猜到密钥库里的条目更近一步，而它没有
必要出现在界面上。`model-routes.test.mjs` 在**序列化后的原始响应字节**上断言
这一点——在解析出来的对象上断言是不够的，因为 `JSON.stringify` 会把
`undefined` 字段丢掉，于是一个"字段名写错所以过滤没生效"的实现也能通过。

列表接口同理：`GET /api/model-profiles` 的整个响应体里不得出现引用名。

---

## 3. 更新用 `version` 做 CAS

```
POST   /api/model-profiles            → 建，version = 1
PATCH  /api/model-profiles/<id>       → 改，**必须**带 version，成功后 version + 1
DELETE /api/model-profiles/<id>       → 立墓碑，**必须**带 version
```

**不给 `version` 一律拒绝（400 `VERSION_REQUIRED`），不默认成"最后一版"。**

默认成最后一版时，两个界面同时保存会静默覆盖，而两边都显示成功。配置类的
lost update 尤其难查——用户只会觉得"我改的东西自己变回去了"，而没有任何报错
指向那个方向。

冲突时返回 **409 + `currentVersion`**：

```json
{ "ok": false, "code": "VERSION_CONFLICT", "currentVersion": 2, "statusCode": 409 }
```

带上当前版本是必须的。不带的话调用方只能反复盲试，而"重新读取后再改"这件事
就变成了猜。

`server.mjs` 的 `handleRun` 因此多透出一个字段：

```js
currentVersion: e?.currentVersion,
```

---

## 4. 删除是墓碑，不是物理删除

一次 Run 会记下 `modelProfileRef`。硬删除会让历史记录指向一个查不到的
东西——"当时用的哪个模型"就永远答不上来了。这与 §6.6
「后续价格表更新不得重算历史 `usage_records`」是同一条纪律。

墓碑带来三件必须分开的事：

| 情形 | 状态码 | 码 |
| --- | --- | --- |
| 没有这个 id | 404 | `PROFILE_NOT_FOUND` |
| 有，但已删除 | 409 | `PROFILE_DELETED` |
| 有，且还在 | 200 | — |

**混成一个 404 会让「删掉再用同名建」看起来像一次干净的首次创建。**
因此建档案时同名墓碑同样被拒：

```
POST /api/model-profiles  { profile: { id: 'p-local', model: 'attacker-model' } }
→ 409 PROFILE_DELETED「模型档案 p-local 曾被删除，不能重用同名 id
   （历史记录里那个引用会指向另一个模型）」
```

保留 `resolveForHistory(id)`：给它一个可能已被删除的 id，它回答"它当时是什么"。
这条路径**同样**不泄露引用名。

---

## 5. 审计：非敏感事实 + 写入前守卫

每条写操作留一条审计，但载荷只有**非敏感**事实：

```js
{ provider, model, hasCredential, fields: [...], credentialChanged }   // update
{ provider, model, hasCredential, fields: [...] }                      // create
{ tombstone: true, version }                                           // delete
```

没有值，没有 endpoint 全文（可能含内网主机名），**也没有引用名**。
`model-routes.test.mjs` 在库的原始字节上验：`very-secret-ref` 不得出现。

还有一道守卫，它在写入器**之前**：

```js
function audit({ action, id, detail, actor }) {
  assertAuditClean({ action, id, detail })   // 含疑似明文密钥 → 抛，什么都不写
  if (typeof writeAudit !== 'function') return
  writeAudit({ action, id, detail, actor })
}
```

**不脱敏后照写**：脱敏逻辑漏一处就等于把密钥永久留在库里。拒绝写入是 fail closed，
且失败立刻可见。

`assertAuditClean` 是导出的，尽管走公开 API 时它**不可达**（`validateProfile`
先挡住了所有密钥形态）。理由：一条永远走不到、也从没被验过的防线等于没有防线。
直接调它，才能证明它确实会拒——以及它兜的是"以后有人给审计 payload 加字段"的那一天。

---

## 6. 抓到的真实缺陷：`limits.maxTokens` 被判成"明文密钥"

写 `model-store.test.mjs` 时基线档案用的是：

```js
limits: { maxTokens: 4096 }
```

结果被 `validateProfile` 拒绝：

```
检测到疑似明文密钥：$.limits.maxTokens。只允许保存 secretRef 引用
```

那里一个密钥都没有。

根因在 `findPlaintextSecrets` 的键名启发式：

```js
// 旧
if (SECRET_LIKE_KEY_RE.test(k) && v !== null && v !== undefined && v !== '') {
```

它只看**键名**，从不看值是不是字符串。而 `SECRET_LIKE_KEY_RE` 含 `token`，
于是 `maxTokens`、`tokenLimit`、`maxOutputTokens` 全部命中。

后果不是一个误报，而是**任何带 token 限额的模型档案根本写不进去**——
而报错说"检测到疑似明文密钥"，把人送去查一个不存在的事故。

修法（`runtime/contracts/model.mjs`）：

```js
// 新：值是**字符串**才算候选
if (SECRET_LIKE_KEY_RE.test(k) && typeof v === 'string' && v !== '') {
```

「值是字符串」不是放宽，是修正：密钥永远是字符串，而限额是数字。
递归仍在下面照常进行，因此不变量还在——同一个键名装字符串密钥照旧被拒：

```js
limits: { maxTokens: 'sk-abcdefghijklmnopqrstuvwxyz' }   // 仍被拒
limits: { token: { apiKey: 'sk-abc…' } }                 // 仍被拒（递归到深处）
```

**为什么一直没被发现**：`team-hub` 既有的模型写入路径（`agent_models`）只有
`provider`/`model` 两列，没有任何调用方传 `limits`。这个缺陷一直躺在
"没人走过的那条路"上。

回归例已入 `runtime/contracts/contract.test.mjs`，并**验过它会变红**：
把判据退回旧写法，该例立刻失败（`检测到疑似明文密钥：$.limits.maxTokens,
$.limits.tokenLimit`）；恢复后 44/44 通过。

---

## 7. 抓到的第二个真实缺陷：契约基线看不见运行面建的表

刷 PRT-007 基线时注意到 `数据表 22` **没变**——我明明新加了一张 `model_profiles`。

根因：

```js
// scripts/prt/baseline-snapshot.mjs
dbTables: extractTables(server),        // 只扫 team-hub/server.mjs
```

而 `run_attempts` / `run_attempt_events` / `run_validations` / `run_handoffs`
在 `run-store.mjs` 里建，`model_profiles` 在 `model-store.mjs` 里建。
**这五张表对契约基线完全不可见**：`--check` 报"无漂移"，而真实 schema 已经
多了五张表。

一个看不见某类变更的棘轮比没有棘轮更坏——它给出"已核对过"的错觉。

修法是显式列出**所有**声明 schema 的模块（不是 glob：glob 会漏掉新文件，
而漏掉的那次同样是静默的）：

```js
const SCHEMA_SOURCES = ['server', 'runStore', 'modelStore']
```

修正后立刻显出五张表：

```
+ 数据表: model_profiles
+ 数据表: run_attempt_events
+ 数据表: run_attempts
+ 数据表: run_handoffs
+ 数据表: run_validations
```

基线由 **101 路由 / 22 表** 变为 **107 路由 / 27 表**。新增的 5 张表**不是**本次
新增的——它们是 PRT-301/307/308 就建好的，只是一直没被基线看见。

---

## 8. 抓到的第三个真实缺陷：正则路由对契约基线不可见

第一次写 `/api/model-profiles/<id>` 用的是：

```js
const m = /^\/api\/model-profiles\/(.+)$/.exec(path)
```

`extractRoutes` 只认四种形态：`path === '…'`、`path.startsWith('…')`，
以及它们与 `req.method === '…'` 的两种先后顺序。**正则 exec 不在其中。**

于是那三条路由（GET/PATCH/DELETE）在基线的 diff 里根本不出现——
它们可以不经评审地增删。这一条恰好被我自己撞上（diff 只显示 2 条而不是 6 条），
否则会一直躺着。

修法是照既有形态写：

```js
if (req.method === 'PATCH' && path.startsWith('/api/model-profiles/')) {
```

**不是为了风格统一**：写在同一个 `path.startsWith` 分支里判断 method
（哪怕语义完全一样）同样会漏，因为抽取规则要求两者相邻且路径是字面量。
修正后 6 条路由全部出现在 diff 里。

---

## 9. 测试策略

`model-store.test.mjs`（20 例，内存库）问两件失败形态很安静的事：

- **明文密钥会不会进库**——写进去了不报错，它只是安静地留在库里、备份里、导出里。
  判据因此不是"我们记得不写"，而是"写不进去"（并断言被拒时库里不留行）。
- **改动会不会被静默覆盖**——并发保存时两边都显示成功，而其中一方的改动消失了。
  用 CAS 的三个版本号序列验真挡。

`model-routes.test.mjs`（14 例，独立进程 + 真 HTTP）补上只有真实请求才暴露的三件事：

- 在**序列化后的原始字节**上验"没有密钥"；
- 状态码区分「调用方传错」（400）与「数据状态冲突」（409）——
  混起来会把运维送去查错的地方；
- URL 解码：`p%2Denc%2Done` 必须解到 `p-enc-one`。

独立进程与自己的库是必要的，不是洁癖：这一组反复建/删档案，共用库会让别的
路由测试受残留档案影响，而那种影响看起来像"随机的 409"。

---

## 10. 未交付

- **PRT-502 岗位模型绑定与 fallback**：`employee_model_bindings`（岗位 → 档案 +
  fallback 顺序 + perRunBudget）尚无任何实现。本批只交付档案本身。
- **PRT-504 连通性与能力测试**：`runtime/contracts/model.mjs` 有
  `validationResult()` 的形态定义，但**没有**任何真实探测实现。
  `internalGet(id)` 已经为它留好出口（含 `secretRef`，仅仓储内部可达）。
- **PRT-505 接线**：`security/secrets/` 的 DPAPI 实现没有生产调用方。
  `secretRef` 目前只是一个被校验形态、被存进库、被挡在对外读取之外的**字符串**；
  没有任何代码去解析它。因此"密钥只注入需要它的执行进程"这条 spec 要求
  尚未落地。
- **PRT-507 Workbench 模型设置页面**：无 UI。API 已就绪。
- **PRT-508 导入导出排除密钥**：无导出实现。`toModelDescriptor` 是它的正确
  起点（导出即 descriptor 列表）。
- **`limits` 的语义未定义**：仓储只校验"正整数"，不解释 `maxTokens` /
  `tokenLimit` 各自约束什么。PRT-503/511 需要定义它。
- **墓碑会累积**：没有任何清理策略。删掉的档案永久留行。
- **`scope` 固定为 `'*'`**：模型档案被当作跨空间的产品级配置。
  若将来需要"某空间专用模型"，审计的 scope 语义要重新设计。
- **`whiteboard/` 的表不在基线内**：它是独立遗留应用，不属于 team-hub 平台契约。
  这是**判断**而不是疏漏，但值得写下来。

---

## 11. 复跑方式

```bash
node --test team-hub/model-store.test.mjs        # 20 例，内存库
node --test team-hub/model-routes.test.mjs       # 14 例，真 HTTP
node --test runtime/contracts/contract.test.mjs  # 44 例（含密钥判据回归）
node scripts/prt/baseline-snapshot.mjs --check   # 平台契约基线
node scripts/ci/run-ci.mjs --only test           # 全套
```
