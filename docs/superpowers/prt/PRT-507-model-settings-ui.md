# 模型设置页：把**入口**补上

> `workbench/src/api.ts` 的 `/api/secrets` 客户端 + `workbench/src/modelSettingsUi.ts`（面板状态纯逻辑）
> + 五个面板组件（档案 / 绑定 / 配置搬家 / 凭证库 + 原有的快速分配）
> + `workbench/scripts/model-settings-ui.test.mjs`（**58 例**）与扩展后的 `workbench/scripts/model-api.test.mjs`（**15 例**）。
>
> 前一轮（`PRT-507-model-config-client-layer.md`）补的是**界面到服务端之间的那一层**，
> 并在它的「未交付」里自己写下了第一条：**「React 组件仍未接」**。这一轮接的就是它。

---

## 1. 缺口的具体形态

前一轮结束时，`api.ts` 已经能把六件事都发出去，而 `ModelConfigModal.tsx` 仍然只有
一个硬编码的 `MODEL_OPTIONS` 列表加一个 per-agent 快捷选择框。

同一轮里还有第二处，形态更刺眼：**凭证管理的写路径**。

`security/secrets/`（PRT-505）有完整实现、有套件；`team-hub/secret-admin.mjs` 写了
五条路由（状态 / 列表 / 新增 / 轮换 / 删除），文件头第一句话就是
「`store.put` / `rotate` / `remove` 在整个仓库里**零生产调用方**」。而它自己修好了
服务端那一半——`workbench/src/api.ts` 里 `/api/secrets` **一次都没出现过**。

> 功能在、测试在、文档在，**没有入口**。
> 而"一个功能没有入口"与"这个功能不存在"，对用户来说是同一件事。

这一轮补的是**同一个真空的另外半边**：客户端函数 + 界面。

### 交付清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 客户端 | `workbench/src/api.ts` | 5 个 `/api/secrets` 函数（状态/列表/新增/轮换/删除）+ `probeModelProfile` 的返回类型 |
| 纯逻辑 | `workbench/src/modelSettingsUi.ts` | 读取三态、探测输入的归一、凭证行/回执/错误、自检三态、配置包计划、解析链适配 |
| 组件 | `ModelConfigModal.tsx` | 五个页签的外壳；「快速分配」原样保留（未回归） |
| | `ModelProfilesPanel.tsx` | 档案 CRUD + 测试连接 + 字段级错误 |
| | `ModelBindingsPanel.tsx` | `(scope, 岗位) → 主档案 + fallback`、解析链 |
| | `ModelTransferPanel.tsx` | 迁移（预演→执行）+ 配置包导出/导入（预演→执行） |
| | `SecretVaultPanel.tsx` | 密钥库自检 + 增 / 轮换 / 删 |
| | `settingsBits.tsx` | 共享的 `Notice` / `StateBox` / `ProbeChip`（颜色语义只定一次） |
| 测试 | `model-settings-ui.test.mjs` | 58 例；`model-api.test.mjs` 扩到 15 例（含 `/api/secrets` 交叉校验） |

### 交付清单之外的一处改动

`ModelProfilesPanel.tsx` 上原有的那句「留空 = 不改动本机引用」**是反的**，
本轮改掉了（详见 §3⑧）。这是这轮唯一一处改动既有产品文案的地方，
也是唯一一处"实现照着一个错误的产品说法写、而套件能拦住"的演示。

---

## 2. 为什么再开一个纯逻辑模块（`modelSettingsUi.ts`），而不是塞进 `modelSettings.ts`

`modelSettings.ts` 的输入是**已经拿到的东西**：一条探测判定、一条档案行、一份计划。
它回答"这个东西长什么样"，它守的纪律是**「没探测过」≠「探测失败」**。

新模块的输入是**还没拿到的东西**：一次异步读取、一个抛出来的错误、一份写回执。
它回答"现在到底是哪一种情况"，它守的纪律是**「读不出来」≠「是空的」**。

两条纪律的**方向是相反的**，而且第二条更危险，因为空状态是**可操作**的：

> 用户看到"你还没有任何凭证"，会照着提示重新录入一遍钥匙。而真相是密钥库打不开，
> 录进去的每一次都会失败。于是一次故障被"修复"成了很多次徒劳的动作，现场也被搅乱了。

把两者放进一个文件、一个套件，标题就只能写"模型设置的纯逻辑"——而**两条纪律会互相稀释**。
所以分开，并在两个文件头各写各的那一条。

分类逻辑**没有**在这里复制：`probeViewFrom` 的判定分支直接交给 `probeBadge`，
`migrationPlanView` 直接把计划交给 `importPlanView`，`resolutionView` 直接把链交给 `chainView`。
新模块只做两件事：**把 HTTP 层的事实翻译成那两个函数认识的形状**，以及
**把"还没有结果"与"结果是坏消息"分开**。

---

## 3. 被钉住的六处误读

每一条都能在用例里对应到**确切的判别值**（不是 `includes`，不是"它失败了"）。

### ① 「读不出来」≠「是空的」

`AsyncState<T>` 是一个三态判别联合（`loading` / `ready` / `failed`）。`collectionView`
的四个分支互不重叠，其中 `ready` 且为空是**唯一**能说"你还没有"的分支。

用例除了断言两个"kind"各自正确，还断言它们**不同**，并且两份文案**不许互相串门**
（故障视图里不出现空状态提示，空状态里不出现"读不出来"）。

### ② 503 的**线上形状里根本没有 `unavailable` 字段**

这是本轮最值钱的一条发现。

`probe-service.mjs` 内部用 `unavailable: true` 表达"这次没有探测过"
（`model-settings.test.mjs` 正是这么喂它的），但 `server.mjs` 在 503 分支里只把
`message` 与 `code` 放进错误体——`handleRun` 的 catch 认 `error`/`code`/`field`…，
**不认 `unavailable`**。

也就是说：**HTTP 层收不到那个判别字段**。调用方不可能按 `unavailable` 分支，
只能按 `status === 503` 分类。前一轮的纯逻辑套件全绿、后端套件全绿，而这一环在两者之间。

`probeViewFrom({ error })` 就是补这一环的：503 → 灰色"未测试"（**不发失败分类**，
那时没有分类可言）；非 503 → 交给 `probeBadge`，缺分类时按 `unknown` 处理
（"别乱重试"，而不是猜成 `transient`）。

另外：认不出的 503 也走"未测试"，但详情里**明说**这个码不在已知集合内——
一个沉默的降级等于把"我们没归类"记成"它就是这样"。

### ③ 后端加了码、前端还是笼统提示 ⇒ 那条码等于没加

`panelErrorFrom(e)` 的 `field`/`candidates` **只从原始响应体读**（PRT-252 的契约），
非中枢错误（`ECONNREFUSED`）一律 `null`——**不假装**它有结构。

界面上：出错的输入框加红边（`.set-input.invalid`），`hint` 作为"下一步"单独一行，
`candidates` 变成可点的候选（`suggestCandidates`）。凭证面则更进一步：
每个后端码映射到一个 `kind`，而 `kind` 决定**下一步动作**。
其中最关键的一对是相反方向：

* `SECRET_ADMIN_STORE_UNAVAILABLE`（503）→「**不要**重新录入一把其实好端端躺在本机的钥匙」
* `SECRET_NOT_FOUND`（404）→「改用「新增凭证」把它建出来」

用例断言这两个 `action` 文案**不同**，且各自不出现对方的引导语。

### ④ 删除是幂等的，轮换不是

`remove` 一个不存在的引用回 `removed: false`——**这是幂等达成，不是失败**：
删除的意图是"让它不存在"，而它已经不存在了。把它渲染成红色失败，用户会重试一次注定同样结果的删除。
而**轮换**一个不存在的引用是 404（没有任何可轮换的对象）。

用例还钉住了第三态：响应里**没有** `removed` 字段时，不能并进"本来就不存在"——
「不知道」与「本来就不存在」的标题必须不同。

### ⑤ 权限核验的两种 `false`

`product/secrets.mjs` 把 `aclExists` 单独回出来，就是为了区分：

* `aclVerified:false` + `aclExists:false` → 全新安装还没建文件，**没什么可保护的**（`muted`，不是告警）
* `aclVerified:false` + `aclExists:true` → 文件在，但没能确认它只有所有者可读（`warn`）

用例断言两者的 `tone` 不同。把前者画成黄色会让人去查一个不存在的问题。

### ⑥ `keep` 策略下"零冲突"不等于"都导入了"

配置包计划里 `keptLocal` 与 `conflicts` **相加**才是"包里有但没进去"的总数：
`keep` 会把冲突转成 `skip`，于是 `conflicts` 归零。只报 `conflicts` 时，
`keep` 策略看起来是"零冲突、全成功"，而实际一条都没导入。
用例断言 `keptLocal:3` 的计划**必须**说出来，且**不许**说"可以导入"。

### ⑦ 一个安静的字段名错配（解析链）

`GET /api/model-bindings/resolve` 给的是 `chain:[{id,…}]` + `skipped:[{id, code, message}]`，
而 `chainView` 认的是 `{profileId, displayName, skipped, reason}`。

直接把 `chain`/`skipped` 丢给 `chainView` 会怎样：可用项靠同名的 `displayName` 侥幸撑住标签、
但备注全空；**被跳过的那一项两个字段名都不对**，于是渲染成「（未知档案）」且没有原因
——而它恰恰是用户最需要看到的那条（"我的备用模型为什么不生效"）。不报错、不崩，只安静地少一样东西。

用例把这一点钉成"**不映射就错**"：同一份输入，`chainView(raw.skipped)[0].label`
是 `（未知档案）`、`note` 是 `null`，而 `resolutionView(raw).entries` 里那条是真实 id + 服务端给的原因。

### ⑧ **「留空 = 不改动引用」是反的**（本轮唯一一处改动既有文案的地方）

原先档案面板上写着一句：

> 编辑时**不会**预填 secretRef（列表里的 descriptor 不含引用名）。**留空 = 不改动本机引用**；要换引用请直接填新的引用名。

这句话的前半句是真的（descriptor 确实不含引用名），后半句**是反的**。服务端的真实语义：

```js
// runtime/contracts/model.mjs · validateProfile
let secretRef = null
if (profile.secretRef !== undefined && profile.secretRef !== null && profile.secretRef !== '') { … }

// team-hub/model-store.mjs · update
`UPDATE model_profiles SET … secret_ref=? …`
```

请求体里不带 `secretRef` ⇒ 落库的是 `null` ⇒ **引用被删掉**。留空不是"保持原样"。

**而这行字错在最坏的方向上**：它把一次销毁包装成一次无害的保存。
用户照着它做（改个显示名 → 保存），得到的是"档案看起来配好了、运行时取不到凭证"。
它不是把一件事显示错了，而是**引导用户去销毁一个东西**——
而这类错在本页没有任何自动防线：`tsc` 不看文案，构建不看语义，服务端只会忠实地执行 `null`。

叠加上"descriptor 不含引用名"这条刻意设计，后果更硬：
**编辑框永远预填不出来**，因此只要用户没记住引用名并重新敲一遍，任何一次保存都会清掉它。

改法（判定与文案都放进纯逻辑，可被用例钉住）：

| 情况 | `clearsCredential` | 默认拦保存 | tone |
| --- | --- | --- | --- |
| 有凭证 + 留空 | **true** | **是**（须勾"我确认要清掉…"） | warn |
| 有凭证 + 填了引用名 | false | 否（文案说"**替换**"） | muted |
| 没有凭证 + 留空 | false | 否（本来就没有，谈不上清掉） | muted |

第三种情况刻意**不**弹确认框：每一次新建都要先勾一个毫无损失的框，会把确认框训练成无脑点击，
于是真正该停下来看的那一次也会被顺手勾掉。用例断言三句文案**互不相同**、
`needsExplicitClear` 三个值恰为 `[true, false, false]`。

用例还断言这句文案里**不出现「不改动」**；「保持原样」只允许以被否定的形式出现
（断言用 `不是[「"']?保持原样` 而不是 `includes('保持原样')`——
后者会把否定句也判成违规，而"一条会给出错误结论的断言比没有断言更坏"）。
把实现换回原来那句话，套件**一次红 4 条**（见 §4.2 的注入 D）。

---

## 4. 验证

### 4.1 套件

```
node --test --experimental-strip-types workbench/scripts/model-settings-ui.test.mjs
    ℹ tests 58   ℹ suites 12   ℹ pass 58   ℹ fail 0
node --test --experimental-strip-types workbench/scripts/model-api.test.mjs
    ℹ tests 15   ℹ pass 15   ℹ fail 0
三个套件一起跑（含未改动的 model-settings）
    ℹ tests 110   ℹ suites 22   ℹ pass 110   ℹ fail 0
```

### 4.2 变红验证（两组，共 14 条红）

测试能失败才算测试。

**第一组：同时注入三处退化，一次复跑。**

```
基线               fail=0
注入 A（failed 分支被短路 → 读不出来落进"是空的"）  fail=4
注入 B（去掉 503 分支 → 没探测过被当成探测失败）    fail=3
注入 C（secretRowView 改成展开整行 → 值可能漏出）   fail=3
合计 fail=10（test 计数 52 不变）
```

具体变红的是：`① 读取三态` 全组 4 条、`② 探测` 的 3 条、`③ 凭证行` 的 3 条。
三处退化**各自**都能让对应的那一组红——说明这三条纪律不是靠"断言存在"撑着的。

（注：注入 C 那 3 条里包含「喂一条带 `value` 的输入，整个视图里不含那个值」——
它是这轮唯一一处直接防"密钥上屏"的用例。）

**第二组：把 §3⑧ 那句原始文案改回去。**

```
注入 D（`secretRefEditView` 有凭证 + 留空时改回「留空 = 不改动本机引用」，               fail=4
        并把 clearsCredential/needsExplicitClear 置回 false）
  变红：有凭证+留空→会清掉 / 文案不许说"不改动" / 纯空白等于留空 / 三种组合互不相同
```

这一组是本轮**唯一**一次"实现照着一个错误的产品说法写、而套件能拦住"的演示。

### 4.3 ★ 复核者用**自己的**探针量出的一处弱点（已补）

上面那 14 条红是**实现者自己**的变红验证。按本项目的纪律，
实现者的自证不算独立证据，所以复核者另跑了一套**独立**的锚点探针
（`prt402-breakverify.mjs`，本批 +10 条 ⑦①~⑦⑩），第一轮得 **1 条无效 + 1 条没咬住**：

* **⑦⑦ 无效**——锚点缩进写错了两格（`    if (r.removed !== true)` vs 实际的
  `  if (r.removed !== true)`）。*一个找不到锚点的探针会被判"无效"而不是"咬住"，
  这正是它该有的处置——否则"我改了但源码一个字没变"会伪装成一次成功的验证。*
* **⑦④ 没咬住，而这是一处**真的弱点**：把 `PROBE_UNAVAILABLE_CODES` 整张表清空
  （每个**已知**的"没探测过"码都被加上那句「这个码不在已知的"没探测过"集合里」），
  套件**全绿（fail=0）**。

  原因是那张表的**肯定分支从来没有被断言过**：已有的三条断言是
  `tone === 'muted'` / `label === '未测试'` / `detail` 里**没有"分类"**——
  而那句附注一个字都不碰。

  危害不是文案丑：那句话的用途是**标记没归类的码**，
  挂在已经归好类的码上时，读的人会以为这一类需要额外处置。
  这与"把认识的当成不认识的"是同一类误读，只是方向相反。

  > 一张"只有否定分支被断言过"的表，
  > 与一张空表，在报告上是同一个读数——只不过前者看起来是有人在守的。

  补法是加一条**肯定**断言：已知的"没探测过"码**不许**出现那句附注。
  补完之后 ⑦④ 咬住。

第二轮：**163/163 咬住、0 无效、0 没咬住、逐字节还原、工作区无污染**。

### 4.4 构建与门禁

```
cd workbench && pnpm build        # tsc --noEmit && vite build → PASS（639 modules，built in 7.71s）
node scripts/ci/ci-syntax.mjs     # PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet   # PASS（1876 个文本文件）
node scripts/ci/check-docs.mjs    # PASS（10 类校验项全绿）
DSH_CHECKOUT=… node scripts/config/scan.mjs --check # PASS（529 个疑似字面量）
```

扫描器**确实扫到了**新文件：`workbench/src/modelSettingsUi.ts` 出现在
`UNCLASSIFIED` 的命中列表里（该项此前已在 `workbench/scripts/config-schema.mjs`
的 `nonEnvLiterals` 中登记，本轮**没有新增**任何字面量声明——
新代码里所有后端码都写成对象字面量的**键**（不带引号），因此不构成疑似 env 字面量）。

---

## 5. 诚实边界

以下每一条都是**当前的实情**，不是"以后再说"。写在这里是因为：
一个错误的功能会让用例变红，而一条错误的边界会被直接相信。

### 5.1 没有浏览器级测试

**没有 DOM 测试、没有点击测试、没有 jsdom / React Testing Library**（零新依赖是硬约束）。
这一轮验证的是：纯逻辑（58 例）+ 类型检查（`tsc --noEmit`）+ 构建（`vite build`）。

由此产生的确切后果，逐条说清：

* **"按钮真的接到了那个函数上"没有任何用例断言。** 接错到另一个**存在且类型相同**的
  函数上，`tsc` 不会报，也没有测试会红。接错到不存在的函数上才会被 `tsc` 拦住。
* **面板的渲染分支没有被执行过。** `list.kind === 'ready' && list.data.map(...)` 这类
  条件渲染是逻辑的"消费者"，而它们本身只被类型检查过。
* **`api.ts` 那五个函数的请求形状有测试**（方法/路径/体/编码 + 交叉校验），
  但**面板传进去的参数**（哪个 ref、哪个 policy）只在类型层面被检查。

### 5.2 哪些是只读的

* 「配置包**导出**」是只读的（`GET /api/config-bundle`）。
* 「快速分配」页**只能读 + 写 per-agent 模型**，没有"重新读取"按钮：读失败时会显示
  一条明确的错误（"这不等于全都是平台默认"），但要重试只能关掉窗口再打开。
* 其余四个面板都是读 + 写（每处写操作都能失败，且失败**就地**渲染具体到码/字段/下一步）。

### 5.3 后端支持、但界面**没有**接的

* **岗位绑定的 `perRunBudget`**：契约支持（`validatePerRunBudget`），界面没有编辑入口。
* **档案的 `limits`（maxTokens / tokenLimit）**：`MODEL_PROFILE_FIELDS` 允许，界面没接。
* **探测的 `requiredCapabilities`**：客户端函数支持，界面固定传 `[]`。
* **迁移计划的 `needsAttention` 明细**：服务端逐条给了（哪个档案缺 endpoint / 凭证），
  界面只显示服务端给的 `summary` 句子（含计数）+ `importPlanView` 的 `refused` 行明细。
  也就是说：**"缺 endpoint 的档案是哪几个"在界面上看不出来**。
* **配置包计划的 `actions` 明细**：只渲染 `summary` 的计数，没有逐条列表。
* **配置包的 `skipped`（迁移里"按原样保留"的项）**：服务端返回数组，界面只计数。
* **没有文件下载 / 上传**：导入导出走 textarea 复制粘贴（避免引入 File API 与新的测试面）。
* **不能选择操作者**：`actor` 固定为 `'general'`（与 `api.ts` 的 `hubPost` 默认 `by` 一致）。
  界面没有"以谁的身份操作"这一项。

### 5.4 后端**不**支持的（因此界面也没有）

* 没有"批量轮换"或"重命名引用"的路由。
* 没有按引用名反查"哪些档案在用它"的路由——所以删除引用时界面**只能提示**
  "用了它的档案会在运行时取不到凭证"，无法列出是哪些。服务端同样不做这个检查。
* **档案的 descriptor 不给 `secretRef`**（PRT-501 的刻意设计，只给 `hasCredential`）。
  后果必须说清：**档案页看不出某条档案指向哪个引用名**。这是安全取舍，不是缺陷，
  但它意味着用户无法从界面核对"档案 X 用的是哪把钥匙"——只能去档案的编辑框里重新填一遍。
  同理，编辑档案时 `secretRef` 输入框**不预填**；而按 §3⑧，留空**会清掉引用**，
  所以有凭证的档案默认拦住保存、要求显式确认。**这是"拦一道"，不是"解决"**：
  真正舒服的做法需要后端多给一个"引用名存在性"之外的读面（比如"这条档案的引用与我输入的一致吗"），
  而那个读面目前不存在，本轮也没有为它加路由。

### 5.5 明确的取舍

* **`MODEL_OPTIONS` 保留**（没有被档案列表替换）。理由：「快速分配」写的是**老的**
  `POST /api/models`（`{provider, model}` 对），而档案是 `{profileId}` 的世界。
  两者不是同一件事，`MODEL_OPTIONS` 在档案那条线上**不构成判据**。
  换掉它会把一个能用的下拉框换成一条不同的写路径，而"角色 → 档案 id"由「岗位绑定」页负责。
  （`AgentTasksModal.tsx` 也仍在用它，所以它本来也不会因为这一页而消失。）
* **`hubGet` 的读路径仍会把结构化错误压成一句字符串**（`readJson`：
  `${status} ${statusText}`）。本轮只为**凭证状态/列表**改用
  `hubRequest('GET', …)`（那里的码是用户能行动的：密钥库打不开）。
  `fetchModelProfiles` 等仍走 `hubGet`。实测影响有限——`GET /api/model-profiles`
  的成功路径是 `json(res, 200, …)`，没有具名失败的出口，所以那条路上丢的是
  传输层的 `statusText`，不是业务码。但**这是一个已知缺口**，不是"已经处理干净"。
* **凭证面板不显示值的任何形式**：响应里根本没有值（`freezeMeta` 的产物），
  所以界面上不存在"显示成星号的密钥"。代价是：**界面无法确认"存进去的到底是什么"**，
  只能通过"测试连接"或一次真实运行来验证。
* 没有做加载骨架屏、乐观更新、分页、i18n。

---

## 6. 复跑方式

```bash
node --test --experimental-strip-types workbench/scripts/model-settings.test.mjs
node --test --experimental-strip-types workbench/scripts/model-settings-ui.test.mjs
node --test --experimental-strip-types workbench/scripts/model-api.test.mjs
cd workbench && pnpm build
DSH_CHECKOUT=<deepseek-harness 检出> node scripts/config/scan.mjs --check
```

`run-ci.mjs` 里已登记 `model-settings-ui`（`nodeArgs: ['--experimental-strip-types']`），
与既有的 `model-settings` / `model-api` 相邻。
