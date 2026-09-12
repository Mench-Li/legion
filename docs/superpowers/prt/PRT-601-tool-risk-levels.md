# PRT-601 工具能力描述与风险等级

> spec 阶段 6：「未批准高风险写操作为零；改变已批准操作的任一关键字段后无法继续执行。」
>
> `runtime/dsh-composition/tool-capability.mjs`（新增），套件 `tool-capability`（39 例）。

## 1. 唯一真正要紧的那条纪律

**风险等级不能由工具作者说了算。**

一张「每个工具自己填一个风险等级」的登记表，失效方式是很具体的：一个会删文件的
工具把自己的等级填成 `low`，于是它被自动放行；一个会往外部 API 写数据的工具
填成 `low`，于是在无人值守的夜里被自动放行。

没有谁在撒谎——填表的人真的觉得「这就是个小工具」。

> 一个允许工具把自己的风险等级**填低**的登记表，
> 与一个「所有工具都是低风险」的登记表，是同一个东西。

## 2. 所以声明分两层，只有一层可以被填低

| 层 | 内容 | 谁说了算 |
| --- | --- | --- |
| `capabilities` | **结构化的事实**：会读文件、会执行命令、会往外部写、会删东西 | 不允许"我觉得"，就是一组枚举 |
| `declaredRisk` | 作者的建议值 | **只能往上抬，不能往下压** |

**有效风险 = `max(declaredRisk, riskFloorOf(capabilities))`。**

声明低于下限时**不抛错，而是照下限执行并留一条 `riskRaised` 记录**。理由：
抛错会让一个第一方工具在启动时把整个产品带崩，而这份不一致本身并不危险
（照下限走是安全的）——但它必须**可见**，否则没人会去改。

内置表里有**两条**故意声明得比下限低的条目（`delete-file` 声明 `high`、
`post-external-api` 声明 `high`，下限都是 `critical`）。它们不是装饰：它们让
「抬升」这条路径在真实数据上**确实是活的**——一张从来没有触发过抬升的登记表，
证明不了抬升是活的。

## 3. 第二条纪律：不认识的工具默认最严

一个没在登记表里的工具名，是一个「我不知道它会干什么」的工具。把它当成
「没有风险声明」从而放行，与直接放行一切未知工具没有区别。

> 一个「没在登记表里」的工具被当成「没有风险声明」，
> 与一个「所有未知工具都自动放行」的强制面，是同一个东西。

所以 `resolveTool()` 对未登记的工具返回 `critical` + `requiresApproval: true`，
且 `known: false`。`UNKNOWN_TOOL_RISK` **不是** `low`。

**返回形状与已知工具完全一致**——这样调用方不需要为「未知」写第二条分支，
而一条只为未知工具存在的分支，正是最容易忘记写的那一条。

## 4. 能力种类：16 项，每一项带四个结构化事实

`riskFloor` / `direction` / `externalEffect` / `irreversible` / `hardFloor`。

三条硬底线能力与 `team-hub/permission-engine.mjs` 的 `isHardFloor` **是同三个**：
`file:delete`、`repo:push`、`credential:write`。两处各写一份硬底线名单，
与「某一条路径上硬底线失效」是同一个东西。

同一族内**写不弱于读**：`file:read` < `file:write`、`repo:read` < `repo:write`、
`network:read` < `network:write`、`external-api:read` < `external-api:write`、
`credential:read` < `credential:write`。有专门的用例逐对断言这一点
（PRT-606 要区分的正是 `external-api` 那一对）。

几条值得说明的下限判断：

- `command:exec` / `process:spawn` = `high`：一条命令能做的事没有上界。
- `mcp:call` = `high`：MCP 服务器的能力对我们是不透明的，我们只知道「它在那边干了点什么」。
- `external-api:write` = `critical` 且 `irreversible`：写外部 API 可能让别人真的付钱/发货/
  发消息，而且**这个动作在我们这边没有回滚**。
- `message:send` = `high` + `irreversible`：发出去的话收不回来。
- `network:read` = `medium`：数据**进来**，不改变外部世界，但会带进不受控的内容。

## 5. 空能力声明被拒绝

「什么也不做」的工具与「我们不知道它做什么」的工具，在登记表上长得一样。
所以不允许空声明，逼作者把能力写出来。`riskFloorOf(['weird:magic'])` 返回
`critical` 而不是 `low`——不认识的能力不能被当成安全能力。

## 6. 加载时自检，以及它两次被"改良"

`assertCatalogConsistent()` 在加载时检查两件事：每一条都能通过校验；没有哪一条的
`risk` 低于它的能力下限。

第二项在「由 `describeTool` 生成」的前提下**恒真**。但恒真的检查不是没有价值：
它拦的是**有人把 `TOOL_CATALOG` 换成一份手写的、没走生成器的表**。

做成可注入的参数，是为了让用例能喂一份**故意填低**的表进来，验它真的会拦：

> 一个只能对「当前恰好正确的那份输入」作答的校验，
> 与一个恒真的校验，在「它能不能发现错误」上同形。

### 两次「瞄不准」，都是把断言指向了一个信息上为空的东西

**第一次**：导出 `TOOL_CATALOG_CHECKED` 作为「自检跑过」的证据。探针把
`...assertCatalogConsistent()` 换成写死的 `ok: true` —— **没咬**，因为证据里还带着
`checkedNames` 与现算的 `floors`。更深一层的原因是：`ok` 的值**完全由
`TOOL_CATALOG` 决定**，而那张表本身已经被别的用例直接验过了——所以「把结论写死」
这条路径在信息上是空的。

处置：改瞄这段自检**唯一真正拦得住的东西**——有人绕过 `describeTool` 手写一张
填低的表。那时加载时自检必须在 **import 阶段就抛**，于是这个文件的每一条用例都会红。

**第二次**：探针把快照里的 `risk` 换成 `riskFloor` —— **没咬**。原因是内置表里
每一条的 `declaredRisk` 都等于它的下限（两条抬升条目的生效值也正好等于下限），
所以 `risk` 与 `riskFloor` 在**当前这份表上恒等**，两者互换是语义空操作。
这是「分支在当前数据上不可观测」，不是用例太宽。

处置：改瞄同一张快照里**确实会分叉**的字段——把 `requiresApproval` 写死成
`false`（`delete-file` 等硬底线工具本该是 `true`）。同时把「快照不比真表更松」
那条从 `>=` 加强成**逐项相等**（`>=` 在两者相等时恒真，挡不住"系统性地更松"）。

## 7. 变红验证：28 处，28 处红

重点：★★ 风险不再抬升（填 low 就按 low 放行）/ ★ 抬升方向反了 /
★ `maxRisk` 取更松的 / ★★ 未登记工具按 `low` 兜底 / ★ 未登记不需要审批 /
★ 不认识的能力判 `low` / ★★ 硬底线不再是硬底线（`file:delete`、`repo:push`）/
★ `external-api:write` 与读同档 / ★ `command:exec` 降成 `low` /
★ 一致性检查恒返回 ok / ★★ 有人手写一张填低的表 / ★ 快照把 `requiresApproval`
写死成 false。

## 8. ⚠️ 本批**没有**解决的事

- **没有接进任何执行路径**。本模块只产出**声明**；`ToolGuard` / `pre-execute` /
  审批箱都还没有读它。PRT-602（Enforcement Bridge）与 PRT-612（固定映射）
  才是把它接到强制面上的那两步。**不要读成「高风险工具已经拦住了」。**
- **`TOOL_CATALOG` 是内置的静态表**，没有从 `EmployeeManifest` 读白名单
  （那是 PRT-603），也没有 MCP 工具的动态注册。
- **`RISK_RANK` 只在本模块内使用**；`permission-engine.mjs` 的
  `isHardFloor` 仍是独立的一份实现，两者目前只有**同一个动作名集合**这一层
  一致性，且由用例断言——没有做到代码级共享。
- **`toolCatalogSnapshot()` 没有接进任何 `--json` 出口。**
- **`externalEffectPossible` 是"这个工具**可能**有外部副作用"，不是"这一次调用
  确实有"**。判定一次具体调用的方向需要看参数（PRT-606）。
- 平台契约不变：**路由 136 / 数据表 32 / 任务状态 7（20 条迁移）/ 目标状态 4 /
  权限模式 5**，本次**没有新增任何 HTTP 面，也没有动基线快照覆盖的文件**。
