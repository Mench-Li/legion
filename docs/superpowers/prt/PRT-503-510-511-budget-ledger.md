# PRT-503 / PRT-510 / PRT-511：单次运行预算、原子账本与冻结价目表

**对应 spec**：§6.6 第 406 行（单次运行预算的完整流程）、第 408 行（费用记录冻结与算价纪律）
**交付物**：
- `runtime/contracts/price-table.mjs` —— **带版本**的价目表（PRT-511）
- `team-hub/budget-ledger.mjs` —— 原子预留 / 结算 / 取消 / 未知结果锁定 + 价目表登记处（PRT-503 / PRT-510 / PRT-511）
- `team-hub/server.mjs` —— 10 条路由
- 套件 `price-table`（19 例）、`budget-ledger`（38 例）、`budget-routes`（17 例）
- `scripts/config/scan.mjs` —— **修正**：git-tracked 模式下的"假绿"（见 §8）

---

## 1. spec 原文与逐句落地

> 商业 Alpha 只承诺单次运行预算：**运行前原子预留最大预算**，**运行中采集实际 usage**，
> **达到硬上限时请求取消**，**终态后按实际使用结算并释放余额**。
> 若**取消后结果未知，预留保持锁定直到恢复或人工处置**。

| spec 分句 | 落地 |
| --- | --- |
| 原子预留最大预算 | `reserve()`：`BEGIN IMMEDIATE` + `attempt_id` 主键；预留金额是 **maxCost**，不是估算值 |
| 运行中采集实际 usage | `observe()`：累计快照 → 超限则置 `cancel-requested` 并返回 `{cancel:true, kind:'budget-exceeded'}` |
| 达到硬上限时请求取消 | 账本**只请求**，不自己取消（它不知道 Run 的生命周期） |
| 终态后按实际使用结算并释放 | `settle({outcome:'known'})` → `spentAmount = 实际`，`heldAmount` 归零 |
| 结果未知保持锁定 | `settle({outcome:'unknown'})` → `locked`，**不写任何实际金额** |
| 直到恢复或人工处置 | `resolveLocked({disposition})` 是 `locked` 的**唯一**出口 |

> 费用记录必须**冻结** `priceTableVersion`、币种、模型计价单位、生效时间和运行时估算结果。
> 后续价格表更新**不得重算历史** `usage_records`。预算超限默认取消当前 Run 并将 Attempt
> 标为 `BUDGET_EXCEEDED`，**不得在未获用户批准时自动切换到更昂贵模型**。

| spec 分句 | 落地 |
| --- | --- |
| 冻结五个字段 | `usage_records` 每次写入都带全部五个；`frozenEstimate()` 产出 |
| 后续更新不得重算历史 | 价目表**不可变 + 版本只增不改**；结算**按预留时冻结的版本**取表（见 §4） |
| 超限将 Attempt 标为 `BUDGET_EXCEEDED` | `cancelReason = 'budget-exceeded:6>5'`；`EFFECT` 由调用方落到 Attempt |
| 不得自动切到更贵模型 | `maySwitchModel()` / `canSwitchModel()`（见 §5） |

---

## 2. 为什么这一批要三件事一起做

spec 把它们写成三条（503 策略 / 510 原子性 / 511 价格冻结），但它们**共享同一个不可分割的判定**：

> 一次运行的费用，在这个 Attempt 上，是按**哪一版价**算出来的？

如果先做 503（预算判定）而不做 511（版本冻结），预算判定就只能用"当前价"——
于是**涨价会追溯地改变已经发生的运行的超支判定**。这不是一个可以靠"以后再补"的东西：
它会写进历史记录，而历史记录一旦写错就没法回头核对。

同理，如果不做 510 的原子性，503 的"预留"只是记账，两个进程同时预留同一个 Attempt
会各记一笔，于是余额被占两次。

**因此这一批按"钱"的完整生命周期一次交付**：定价 → 预留 → 采集 → 取消 → 结算/锁定 → 对账。

---

## 3. 五条判定

### ① 预留键是 attemptId；重复预留幂等，但**参数不一致必须拒绝**

重试预留是正常动作（网络抖动、进程重启），所以同 `attemptId` 同参数必须是幂等的。

但参数不一致时拒绝：

```
Attempt att:T-1:1 已有预留（5 USD / cheap），本次请求是 100 USD / cheap：
预留上限可以被修改，但必须是一次显式动作，不能靠重新预留悄悄替换
```

上限**可以**被改——但不能"顺便"被改。悄悄接受意味着有人把上限从 10 元改成 1000 元
而没有留下任何痕迹，而账本的全部意义就是留有痕迹。

### ② 结算只认**冻结的**价目表版本

```
const table = priceTableFor(r.priceTableVersion)   // 冻结的版本
if (table === null) throw PRICE_TABLE_GONE          // **不**回退到现价
```

取不到那张表时**拒绝结算**，而不是用现价重算：

> 价目表 pt-A（生效于 1700000000000）已取不到，无法结算 Attempt …：
> **不得改用现价重算**——spec 明确禁止后续价格表更新重算历史 usage_records；
> 请恢复该版本价目表或走人工处置

算不出实际金额时也**不能结算成 0**：那会把"不知道花了多少"变成一笔免费运行。

### ③ 结果未知 → `locked`，**不结算**；`locked` 只能人工解开

```
settle({outcome:'unknown'})  → state='locked', spentAmount=null, 余额仍被占住
settle({outcome:'known'})    → 409 RESERVATION_LOCKED
```

`spentAmount` 保持 `null`（不是 0）：写入任何数字都等于宣称"算清了"，
而事实是不知道。`locked` **仍然占用余额**（它属于 `HOLDING_STATES`）。

`resolveLocked()` 要求显式的 `disposition`（`release` / `settle`）与 `actor`：

- `release`：人工判定"这笔没花出去" → 按 0 结算并释放；
- `settle`：人工给出实际用量 → 走正常结算。

### ④ 超支**如实报出，不裁剪**，而且**仍然可以结算**

```
reservedAmount = 5, 实际 = 12  →  spentAmount = 12, overrunAmount = 7
```

拒绝结算只会让账本与事实脱节；裁剪成 0 更糟——它把一次超支变成一次"刚好花满"，
于是超支永远学不到。

### ⑤ 没有预算 = 显式的 `unbounded`

未配置预算时不建预留，并返回 `budgetState: 'unbounded'`。**这件事必须可见**：
否则"没配预算"和"预算闸门在工作"从外面看完全一样。

已预留的 Attempt 不能再说自己"没有预算"——那会静默解除上限。

---

## 4. "冻结"是结构性的，不是一条纪律

`price_tables` 表里，版本是主键并且**不可覆盖**：

```
POST /api/price-tables  {version:'pt-A', ...}   → 200
POST /api/price-tables  {version:'pt-A', ...}   → 409 PRICE_TABLE_IMMUTABLE
```

于是"改价"这个动作在类型上只能是"发布新版本"。历史记录引用的是旧版本对象，
它们**不会变**——不是因为没人去改，而是因为没有可改的东西。

`createPriceTable` 也强制要求 `version` / `currency` / `effectiveAtMs`：
一张没有版本、没有生效时间的价目表**构造不出来**，因此无法被冻结进记录，
也就无法在事后被解释。

端到端用例（`budget-ledger.test.mjs` 例 ⑫）：发布 v1 → 预留 → 发布 v2（涨价 100 倍）
→ 结算**仍按 v1**（1 而不是 100），且两条 `usage_records` 都冻结着 `pt-A`。

---

## 5. 不得自动切到更昂贵模型

```
canSwitchModel({priceTable, from:'cheap', to:'dear', ...})
  → {allowed:false, code:'MORE_EXPENSIVE_NEEDS_APPROVAL',
     message:'切到 dear 更贵（1 → 10 USD，多 9）：不得在未获用户批准时自动切换到更昂贵模型'}
```

三条规则：

1. 更便宜或同价 → **允许**（省钱不需要批准）；
2. 更贵且无批准 → **拒绝**，并说清贵多少；
3. **任一侧未定价 → 拒绝。**

第 3 条是刻意的：不知道贵多少时放行，等于把"我查不清"当成"应该没问题"，
而代价是真实的钱。正确动作是去补价目表，不是让运行继续。
`approved: true` **不能**替代定价。

这条判定在账本层也记审计（允许与被拒都记）：换模型是花钱的动作。

---

## 6. 状态机是全定义的

```js
RESERVATION_TRANSITIONS = {
  reserved:          ['cancel-requested','cancelled','settled','locked'],
  'cancel-requested':['cancelled','settled','locked'],
  cancelled:         ['settled','locked'],
  locked:            ['settled','cancelled'],   // 只能由恢复/人工处置到达
  settled:           [],                        // 终态
}
```

**每个状态都有键**，哪怕是空数组。缺键会让 `TRANSITIONS[x]` 是 `undefined`，
于是 `.includes()` 抛异常——而那会被当成代码缺陷，掩盖"这个状态我根本没想过"。

有一条用例断言 `Object.keys(TRANSITIONS)` 与 `RESERVATION_STATES` **一一对应**，
且转移目标都在集合内。

---

## 7. 抓到五个真实缺陷

### ① `createPriceTable` 忘了 import，而 `catch { return null }` 把它吞了

`budget-ledger.mjs` 的价目表登记处第一版写的是：

```js
try { return createPriceTable({...}) } catch { return null }
```

`createPriceTable` **没在 import 列表里**，于是 `ReferenceError` 被吞成 `null`，
`publish` 报"写入后复读失败"，而 `get` 对任何版本都返回 `null` ——
结算于是报 `PRICE_TABLE_GONE`，**运维会去查价目表，而真实原因是一行没写的 import**。

修法是**只吞数据错**：

```js
} catch (e) {
  if (e instanceof PriceError) return null   // 存进去的数据不合法 → 当作取不到
  throw e                                     // 代码缺陷 → 不许伪装成数据问题
}
```

### ② 数据损坏可以绕过"版本不可覆盖"

同一处的存在性检查第一版用的是 `get()`：

```js
if (get(table.version) !== null) throw PRICE_TABLE_IMMUTABLE
```

`get()` 把"没有这一行"与"这一行的 JSON 坏了"**都**返回 `null`。于是：
**先把 v1 的 `models_json` 弄坏，就能用 publish 覆盖 v1** —— 而 v1 正是历史费用
记录引用的那一版。绕过之后，历史记录会对着另一个价格算。

这是"用有损视图做存在性判断"的又一个实例：判断"有没有"必须问"有没有"，
不能问"能不能读出来"。修法是直接 `SELECT 1 FROM price_tables WHERE version = ?`。

有用例（⑪）先损坏 v1 再尝试覆盖，断言仍是 409。

### ③ `JSON.stringify(undefined)` 返回 `undefined`，于是审计插入炸在参数 7

账本的无预算分支最初写 `audit({action:'budget.unbounded', attemptId, scope, taskId})`
—— 没传 `detail`。`server.mjs` 的 `audit()` 做 `JSON.stringify(detail)`，
而 **`JSON.stringify(undefined)` 返回的是 `undefined` 而不是字符串**，
绑到 SQLite 参数 7 时抛：

> `Provided value cannot be bound to SQLite parameter 7.`

于是一个"某处少传了一个可选字段"的错误，以一条 SQLite 绑定错误的形式出现在
完全无关的层，且**报的是 400**（"你的请求不对"），而请求本身没错。

修法两处：账本补上 `detail: {}`；`audit()` 改成 `JSON.stringify(detail ?? null)`。
`?? null` 不是多余的防御——审计字段是**诊断**，不该让真实业务操作失败；
但它也不能被静默丢掉，所以落 `null`（"没有诊断载荷"）而不是省略这一列。

### ④ 路由把参数校验排在状态检查之后

`POST /api/runtime/budget/reserve` 第一版先查价目表，再让账本校验 `attemptId`。
于是一个**没传 `attemptId`** 的请求得到：

> 409 `PRICE_TABLE_GONE`：没有价目表版本 undefined：有预算就必须有价目表…

调用方会去发布一张价目表，而真正要做的是补上参数。

**参数校验必须排在状态检查之前**：400（改请求）与 409（改状态）指向完全不同的动作，
顺序错了就是把人送去修一个不存在的问题。

顺带修了 `handleRun` 的字段透传：拒绝里带的 `state` / `lockReason` / `fromAmount` /
`toAmount` / `currency` 原本被丢掉，于是"The 状态是 settled，不是 locked"这句话
只剩"状态不符"。CAS/状态拒绝**必须带上真实当前值**，否则调用方只能猜自己现在
是什么状态——而这正是幂等重放最常见的失败原因。

### ⑤ 路由撞名把 PRT-309 的读面变成了死代码

费用账本最初用了 `GET /api/runtime/budget`，而这条路径**已经被 PRT-309 的
重试预算占用**。于是先写的那条不可达，`run-plane` 的两个用例（例 ⑥ 例 ⑨）
开始报 `Cannot read properties of undefined (reading 'attemptsUsed')`。

**这是全套 CI 抓到的，不是单测抓到的**：费用账本自己的 17 个用例全绿
（它们打的是新的那条路由），基线也报"无漂移"（`Set` 去重）。详见 §9.1。

---

## 8. 门禁修复：`scan --check` 在提交前**假绿**

这一批还修了一条门禁自身的缺陷，因为它**刚刚骗过我一次**。

`scripts/config/scan.mjs` 的扫描模式是 `git-tracked`。它早就知道自己有这个盲区，
注释里甚至记着上一次事故：

> 实测：P3-4 的 `plugins/src/config.ts` 在提交前未被扫描，提交后同一份代码立刻
> 多出一个未声明键。
> 这里把「有几个文件没被扫」如实报出来……（不判失败：未跟踪文件本就不算配置面）

那个"不判失败"的选择**就是漏洞**。`scan --check` 报 PASS 的含义本来应该是
"配置面没问题"，而它实际的含义只是"**已经提交的那部分**没问题"。

PRT-502 实测后果：`orchestrator/model-binding/index.mjs` 提交前未跟踪，
`scan --check` 报 **PASS（285 字面量）**；提交后同一份文件立刻冒出
**12 个未处理字面量**。也就是说这条门禁在**最需要它的时刻**（提交前）
覆盖不到**它该管的对象**。

修法：新增 `pendingFiles()`（`git ls-files --others --exclude-standard`）——
即 `git add -A` 会带走的那批文件。非空时 `--check` **判失败**：

```
scan: FAIL —— 1 个文件已写好但未被扫描（未纳入版本控制且未被 .gitignore 忽略）：
  - team-hub:team-hub/budget-ledger.mjs
  git-tracked 模式下这些文件不在配置面里。请 `git add` 后重跑，
  否则这条门禁报的是「已提交的部分没问题」，而不是「你要提交的东西没问题」。
```

与 `trackedFiles()` 的差别很重要：后者只知道"在不在索引里"，因此 `team-hub/lib/index.js`
这类**被忽略的构建产物**也算"未跟踪"，而真正危险的是"新建的源文件还没 `git add`"。
`--others --exclude-standard` 恰好给出这一批。

**验过会变红**：`git reset HEAD team-hub/budget-ledger.mjs` 后门禁立刻 FAIL。

---

## 9. 路由

```
POST   /api/runtime/run-budget/reserve           运行前原子预留（无预算 → unbounded）
POST   /api/runtime/run-budget/observe           采集用量；超硬上限 → 请求取消
POST   /api/runtime/run-budget/settle            outcome=known 结算 / unknown 锁定
POST   /api/runtime/run-budget/resolve           人工处置（locked 的唯一出口）
GET    /api/runtime/run-budget                   ?scope= &state= 过滤 + held 汇总
GET    /api/runtime/run-budget/<attemptId>       预留本体 + 追加式用量历史
POST   /api/price-tables                         发布（同版本 → 409）
GET    /api/price-tables                         版本列表
GET    /api/price-tables/<version>               单版本
POST   /api/runtime/run-budget/may-switch-model  能否切到另一个模型
```

前缀是 **`run-budget`** 而不是 `budget`：`GET /api/runtime/budget` 归
**重试预算**（PRT-309：这条任务还能自动重试几次）。两个不同的"budget"
在 URL 上必须分开，原因见 §9.1。

`att:T-1:1` 含冒号，必须百分号编码；这条路由**整段解码**（路径里只有一段），
与绑定的 `<scope>/<role>` 按段解码不同。

状态码三分：**400**（参数不对）/ **404**（根本没有这笔预留）/ **409**（状态不符）。

### 9.1 路由撞名：一条门禁看不见的遮蔽

费用账本最初确实用了 `/api/runtime/budget`。后果：

- 先写的重试预算读面（`run-plane-e2e.test.mjs` 例 ⑥ 与例 ⑨）**永久返回错误结构**
  ——字段从 `budget.attemptsUsed` 变成 `reservations`，读面报
  `Cannot read properties of undefined (reading 'attemptsUsed')`；
- 而 `prt-007-baseline.json` **看不出任何变化**。

第二条才是真正的问题。`extractRoutes` 返回的是 `Set`，重复的路由被**静默合并**：

```js
routes.add(`${method} ${path}`)   // 第二次 add 是空操作
```

于是"新增了一条与既有路由同名的路由"在 `--check` 的 diff 里完全不可见，
而先写的那条已经成了**不可达的死代码**。基线清单里
`GET /api/runtime/budget` 仍然只出现一次，`--check` 报"无漂移"。

修法两步：

1. 新增 `extractRouteOccurrences()`，**带出现次数**返回（不再用 `Set` 记账），
   并加门禁用例 ⑥：任何 `count > 1` 的路由直接判失败，报错文案说清
   "后写的那条会遮蔽先写的，先写的那条成为死代码"。
   用例自带一个合成样本断言抽取器**真的能看见重复**（否则门禁会假绿）。
2. 费用账本改用 `/api/runtime/run-budget`，`GET /api/runtime/budget` 还原给重试预算。

这又是一条**「门禁看不见某类变化」**：它看得见"路由集合变了"，看不见
"路由被写了两次"。而后者正是最危险的那种——它同时造成功能失效与台账正常。

---

## 10. 未交付

- **没有接到运行面上。** 这批交付的是账本与判定的完整实现，但
  `orchestrator/worker/` 与 `runtime/adapters/dsh/` **还没有**在 Run 开始时调
  `reserve()`、运行中调 `observe()`、终态调 `settle()`。也就是说：spec 那条
  "运行前原子预留"目前还只是**可被调用**，不是**已被调用**。
  接线属于 PRT-253/254（适配器的模型来源与 Run 生命周期）。
- **Attempt 上没有 `BUDGET_EXCEEDED` 状态。** 账本把 `kind: 'budget-exceeded'`
  返回给调用方，但 `orchestrator/state-machine/` 目前没有这个终态或失败分类的
  写入路径。spec 要求"将 Attempt 标为 `BUDGET_EXCEEDED`"。
- **`observe()` 是累计快照语义，不是增量。** 调用方必须传累计 token 数。
  增量语义需要另一套对账（每次调用追加一条 usage 并求和），未实现。
- **每日总预算与组织级账本未实现**——spec 明确延后，`heldAmount()` 是它的形状基础。
- **`perRunBudget.maxTokens` 未被执行**：`checkBudget()` 在 `usage.mjs` 里有，
  但账本只按金额预留。token 上限需要单独的计数器。
- **价目表没有加载入口。** `POST /api/price-tables` 是唯一写入路径；没有从配置文件
  或内置表加载的机制，也没有价格核对。真实价格是运维输入，本模块**刻意不自造**任何价格
  （`PRICE_TABLE_UNSET` 是合法默认值）。
- **`maySwitchModel` 没有被 fallback 链调用。** PRT-502 排出的候选链与这里的
  择价判定还没有接起来。
- **`resolveLocked` 没有恢复路径。** spec 说"直到**恢复**或人工处置"，
  目前只有人工处置；自动恢复（PRT-301 的 recovery 扫描）未接。
- **`usage_records` 没有对账读面。** 只有按 Attempt 的 `usageOf()`；
  没有"某个 scope 在某个时间段花了多少"的聚合。

---

## 11. 复跑方式

```bash
node --test runtime/contracts/price-table.test.mjs   # 19 例，纯函数
node --test team-hub/budget-ledger.test.mjs          # 38 例，内存库
node --test team-hub/budget-routes.test.mjs          # 17 例，真 HTTP
node --test scripts/prt/baseline-snapshot.test.mjs   # 17 例（含 schema 采集覆盖率）
node scripts/config/scan.mjs --check                 # 含"提交前假绿"门禁
node scripts/ci/run-ci.mjs --only test               # 全套
```
