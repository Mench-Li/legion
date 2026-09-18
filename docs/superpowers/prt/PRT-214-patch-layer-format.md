# PRT-214：补丁层的格式——让 DSH 真的能读它

> spec §6.8 / Appendix A：Legion 通过产品自己的 **profile 层**注入 host 组合补丁，
> 而不是替换 DSH 随部署分发的 preset 安装。

本文记录的是 PRT-214 的第一件事，也是此前被误报为"已就绪"的那件事：
**`legion-host.patch.yml` 根本不是一份 DSH 能加载的文件。**

---

## 1. 结论先说：三处硬伤

用 DSH 自己的解析器读它（`js-yaml` + `entryListSchema`），实测：

| # | 此前生成的样子 | DSH 实际会怎样 |
| --- | --- | --- |
| ① | 顶层是**映射**（`patch:` / `permission:`） | `parsePatchList` 直接抛：`must be a top-level YAML array of entries` |
| ② | `insert: after:tools` —— insert 是**字符串** | `applyEntryPatches` 对它调 `.forEach` → TypeError |
| ③ | `plane: host` | **不报错**，静默忽略（`PatchOptions` 有索引签名） |

第 ③ 条最危险：另外两条至少会响，而它连响都不响。

> 一个会被静默忽略的字段，与一个不存在的字段，
> 在组合树上没有任何区别——只不过前者的文件里写着它。

## 2. 为什么仓库里的用例看不见

`composition.test.mjs` 当时断言的是：

```js
assert.equal(onDisk, renderPatchYaml(), 'YAML 是生成物；手工编辑或忘记重新生成都会在这里被抓住')
```

这个断言**是真的**，也一直是绿的。它证明的是「生成物与自己的声明一致」。

> 一个"与自己的声明完全一致"的补丁层，
> 与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
> 只不过前者的用例是绿的，而它从未被任何解析器读过。

一份自洽的、格式全错的 YAML：仓库里没有任何一处会让**解析器**去看它。

## 3. ★ 坑中之坑：`insert` 与 `id` 同时出现

修格式时我第一版把每一行渲染成：

```yaml
- id: legion-enforcement-hard-floor      # ← Legion 自己的行 id
  insert:
    - name: "file:///x.js"
```

看起来完全正常。实测（真 `applyEntryPatches`）却是：

```
patch insert: entry "legion-enforcement-hard-floor" not found
```

**DSH 对 `insert` + `id` 的解释不是"给这次插入取个 id"**，而是
「把这些项插进 **`id` 那一行**的 config 数组」，要求那一行**已经存在**且是
`group: true`。三种形状实测对照：

| 形状 | 语义 | 靶子要求 | 打不中时 |
| --- | --- | --- | --- |
| `{ insert: [...] }` | 追加到**根** | 无 | — |
| `{ id, config }` | **替换**那一行的整个 config | 该行已存在 | `patch: entry "X" not found` |
| `{ id, insert: [...] }` | 插进那一行的 **config 数组** | 该行已存在**且是 group** | `patch insert: entry "X" not found` / `is not a group` |

三种都**不抛**，只 warn-and-skip。

> 一个"能被 DSH 接受、然后被 warn-and-skip 掉"的补丁行，
> 与一个"从未被写进补丁层"的补丁行，在组合树里长得一模一样——
> 只不过前者的文件看起来是装好的。

所以新增行一律走**第一种**（与 DSH 自己的
`packages/bundle/base/cordis.patch.yml` 同一个形状：一个 `- insert:` 顶层项装下全部行）。

### 3.1 顺带一个结论：`mount.after` 不存在

声明里的 `mount: { anchor: 'insert', after: 'tools' }` 带着"插在 `tools` 之后"的意图。
**DSH 没有 `after` 字段**，而且行顺序**不携带加载语义**——base bundle 的注释写明
`activation is service-availability driven`。

把它字面翻译成 `{ id: 'tools', insert: [...] }` 就是上表第三种，而 `tools` 不是 group
→ `is not a group` → 又是静默失效。所以 `after` 只作为**阅读提示**留在声明里，绝不进文件。

## 4. 交付

### 4.1 `runtime/dsh-composition/patch-format.mjs`（新增）

一个**生成器 + 形状检查器**。它不是 YAML 解析器；判据取自 DSH 的
`PatchOptions` 定义（`cordis-plugin-include/lib/types/index.d.ts`，逐字抄进
`PATCH_OPTIONS_KEYS`）与 `parsePatchList` 的实际断言。

它拦下 9 类问题，其中 4 类是"DSH 不会报错"的那种：

| 码 | 为什么必须有 |
| --- | --- |
| `NOT_AN_ARRAY` | DSH 直接抛 |
| `INSERT_NOT_ARRAY` | DSH 对它 `.forEach` |
| `INSERT_WITH_TARGET_ID` | 见 §3，静默跳过 |
| `INSERT_ENTRY_NO_NAME` | 静默跳过 |
| `CONFIG_NOT_OBJECT` | patch-over 没法替换 |
| `ENTRY_NOT_OBJECT` / `INSERT_ENTRY_NOT_OBJECT` | 结构不成立 |
| `UNKNOWN_KEY` | **DSH 静默忽略** |
| `ROW_MODULE_MISSING` | 模块不存在 → 造出来也是空壳 |

生成器侧，**字符串一律印成双引号标量**（`JSON.stringify`）：

```js
export function scalarOf(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  ...
}
```

不做"看起来危险才加引号"的判断：

> 一个"只在看起来危险时才加引号"的生成器，
> 与一个"该加的时候恰好没加"的生成器，在它漏的那一天之前是同一个东西。

而且双引号标量**永远不会**被当成 tag，于是 DSH 补丁文件支持的 `!!js` 表达式
这一整类注入，是靠**结构**（没有路径能产出裸标量）关掉的，不是靠一个判据。

### 4.2 `render.mjs` 重写

只负责"把声明翻成文档、再印成文本"。可加载性判定搬去 `patch-format.mjs`——
**"能造出来"与"能加载"不能是两件事**，那正是这道缝本身。

新增 `renderPatchReport()`：返回 `{text, renderedRowIds, declaredRowIds, unbuildable, complete}`。
CLI 在不完整时**打到 stderr 并 exit 3**。

此前"这一层不完整"只写在注释里，而注释不会被任何判据读。
现在它是返回值：**调用方必须面对它**。

### 4.3 `patch-layer.mjs` 加 `module` 字段

每一行**显式**记下自己的模块，`null` 表示"还不存在"。这让"PRT-214 没做完"
变成一件**机械可查**的事，而不是一句散文。

三个 enforcement 行现在都是 `null`，于是它们**刻意不写进补丁文件**：
一个 insert 项没有可加载的 `name` 时 DSH 对它是 warn-and-skip，
写进去就是"看起来装好了"。**缺行比假行好**——缺行会被 `reconcilePatchLayer()`
报成 `ROW_MISSING`，启动自检仍然拒绝注册（fail closed）。

### 4.4 一个新的套件与两个修正

- `patch-format.test.mjs`（**19 例**）：形状检查逐条 + 生成器 + 组装器。
  其中一条断言**每个拒绝码都够得着**——一个写了却永远触发不了的分支，
  与一个不存在的分支，在"它到底拦住了什么"上是同一个东西。
- `patch-loadable.test.mjs`（**8 例**，**条件套件**）：跑**真 DSH 管线**。
  真 `js-yaml` + 真 `entryListSchema` + 真 `applyEntryPatches`，
  而且 base 不是手编的——先应用 **DSH 自己的 base bundle 补丁**（84 行），
  再叠 Legion 这一层。这正是 profile 层在运行时的真实位置。
  没有 `DSH_CHECKOUT` 时**逐条 SKIP**（摘要里留下 `skipped: N`）。
- `composition.test.mjs` 两条修正，见下。

## 5. ★ 修正：一条恒真的危险档位检查

原来那条"没有任何 sandbox 取值是 danger-full-access"用的是：

```js
const sandboxValues = [...text.matchAll(/^\s*sandbox:\s*(\S+)\s*$/gm)].map((m) => m[1])
assert.ok(sandboxValues.every((v) => v !== 'danger-full-access'))
```

生成器给所有字符串加引号之后，`(\S+)` 拿到的是 `"workspace-write"`（**带引号**），
它与 `'danger-full-access'` 永远不相等——**这个断言变成恒真**，
连真的写成 `sandbox: "danger-full-access"` 也拦不住。

> 一个"因为值带了引号而永远不相等"的危险档位检查，
> 与一个"根本没有这个检查"的补丁层，在用例上是同一个东西。

已修为去掉引号再比，并补一条"取值不得为空串"。

另一条修正是把「所有声明行的 id 都出现在文本里」改成「**文档里实际有的行**
出现在文本里」，而"哪些行没进文档"由新用例盯死。

## 6. 验证

- 用**真 js-yaml + 真 schema + 真 applyEntryPatches**端到端跑通：
  base bundle 84 行、0 警告 → Legion 层 **0 警告** → `permission` 行的 presets
  被替换为 `legion-attended` / `legion-unattended`，DSH 默认的 `danger-full-access`
  档位**消失**。
- 并带**对照**：会静默失效的三种形状**真的**会被 warn-and-skip
  （否则"零警告"是一个恒不报警的读数）。对照里"行根本没被插进去"是被断言过的。
- 还验证了**模块齐备时**插入路径真的能把三个 enforcement 行插进树里：
  三个模块现在还不存在，但生成器会不会正确插入必须现在就被证明，
  否则等模块写好的那天，我们只是在**同一个从未跑过的插入路径**上填了名字。
- 六道门禁全 PASS；全量 CI 见 `docs/STATUS.md`。

## 7. ⚠️ 诚实边界：**PRT-214 仍是 🟡**

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*

本批修好的是**格式与可加载性**——一份以前根本读不了的文件，现在能被真管线读了。
但**这一层仍然是空的**：

- **三个 enforcement 插件模块不存在**：`hard-floor`、`pre-execute`、
  `approval-answerer` 三行都需要一个在 DSH 进程内被加载的 Cordis 插件模块。
  它们现在 `module: null`，因此**不在补丁文件里**。
  于是补丁层目前只做一件事：替换 permission preset 表。
- **强制面因此没有挂上**：`reconcilePatchLayer()` 会报三条 `ROW_MISSING`，
  启动自检拒绝注册——这是**有意的** fail closed。
- **补丁层从未真的被注入过任何 profile**：本批验证的是"这份文件能被 DSH 的
  解析与打补丁逻辑正确消费"，**不是**"它已经被某个 profile 加载"。
  profile 层是 `patchReload: 'live'`，写入会立刻改变**正在运行**的强制面——
  所以落盘动作仍然只由 CLI 的显式 `--write` 触发，不藏在一个顺手的函数里。
- **员工 agent preset 那一半尚未开始**：`EMPLOYEE_PRESET_CONTRACT` 还是纯声明。

因此前一条进展里"声明 + 生成物 `legion-host.patch.yml` 已就绪"这句话是**错的**：
生成物当时不可加载。现在这句话才成立，但"就绪"仅指**格式**，不指内容。

### 顺带记一条待办（过程改进）

`scripts/ci/run-ci.mjs` 没有任何门禁解析它。改坏它会让**整条 CI 无法运行**，
而那 6 道门禁**全部照旧绿灯**：

> 一个"改坏了 CI 运行器、而门禁全绿"的提交，
> 与一个"改坏了 CI 运行器、并且被拦下"的提交，在门禁日志上长得一模一样。

本轮又踩了一次（同一处插入手法第三次吃掉下一个块的 `{`）。
纪律是每次编辑后 `node --check`；**结构性的修法**（把
`node --check scripts/ci/*.mjs` 变成一道门禁）尚未落地，记在这里。
