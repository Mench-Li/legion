# PRT-901 / PRT-902：第三方组件清单、SBOM 与商业分发条件

**spec**：§10 line 745（安全与商业发布要求）
**状态**：✅ 已交付（PRT-902 的 DSH 侧部分除外，见 §6）
**证据**：`.ci/prt-901/`

---

## 1 一句话

把"SBOM 覆盖完整"从**一句声明**变成**一个能在假磁盘上被打破的判据**。

---

## 2 这个任务真正的坑：报表会不会漏东西

本仓库**没有根 package.json**。依赖分散在 7 个 workspace 清单里：

```
.skills-cache/main/teamai-cli-main / board-plugin / plugins
services-plugin / team-hub / whiteboard / workbench
```

而其中一份属于一棵**被跟踪的 vendored 第三方源码树**——`.skills-cache/` 下 499 个文件。

### 2.1 ★ 我的第一版注释写错了，必须记下来

我最初写的是"只读 package.json 的 SBOM 会**整棵漏掉**这棵树"。**这是错的**：
那棵树**恰好带了** `package.json`（MIT，15 运行时依赖 + 10 开发依赖），
所以只读清单的 SBOM **会**扫到它。

真正会漏的是另外两种：

- **没有清单的 vendored 代码**（拷进来的代码常常没有 `package.json`）；
- 落在 `SCAN_SKIP_DIRS` 里的目录下的源码树——`docs/` 与 `scratch/` 都被跳过，
  而本仓库的 `docs/T042-evidence/` 里**确实**放了别的项目的采集副本。

> 一个「从各 workspace 的 package.json 依赖生成的 SBOM」，
> 与一个「只覆盖了"恰好带清单的那些"第三方代码」的 SBOM，是同一个东西——
> 只不过前者看起来是完整的。

所以判据**两个来源都收**：清单里声明的依赖，加上调用方**注入**的
磁盘 vendored 树。而"哪些目录算 vendored"**不能从清单推出来**，必须由调用方给——
否则本模块就只是在复述那几张清单，用例也没法在假磁盘上验证"多了一棵没有清单的树"。

### 2.2 ★ 第二个坑：真实仓库上跑出来的重复计数

`.skills-cache/main/teamai-cli-main` 既是一棵 vendored 树、**又**有一份清单。
第一版两处各记一个组件，于是 `distributionReport` 把同一个 MIT 组件数成了
`permissive: 2`：

> 一个「同一份代码在报表里出现两次、于是'覆盖了 2 个宽松许可组件'」的 SBOM，
> 与一个「其实只有 1 个」的 SBOM，是同一个东西——只不过前者让人以为覆盖面更大。

**这是我在真实仓库上跑 `probe-inventory.mjs` 才发现的**——注入式的单元用例
全部是绿的，因为它们喂的假磁盘里 vendored 树恰好都没有清单。

修复：vendored 树不再以 `workspace` 身份出现，但它的**依赖**仍然要收
（依赖与它以什么身份出现无关）。`permissive: 2 → 1`。

### 2.3 ★ 第三个坑：把"没读到"报成"没有"是一次夸大

43 个依赖的许可写在**它们自己的** `package.json` 里，而依赖树不在磁盘上。
第一版把它们全部报成"没有 license 字段——分发条件未知"。

那是**夸大**：

> 一个「把"没读到"报成"没有"」的合规报表，
> 与一个「把每个未知都报成一个缺口」的报表，是同一个东西——
> 只不过前者会让人去修一个不存在的问题。

修复：`distributionTerms` 对 `kind === 'dependency'` 报"许可**尚未读取**"，
对 workspace/vendored 报"**没有** license 字段"。**结论相同、原因不同**——
用例断言的就是这一点（`verdict` 相等、`reason` 必须不同）。

`private: true` 的 workspace 同理：它不随产品分发，分发条件不适用。
把它和"未知"混成一个会让真正的未知被淹掉。

### 2.4 ★ 第四个坑：`installedPrefixes` 缺席 ≠ 空数组

我自己的用例把这一条打红了。第一版签名是 `installedPrefixes = []`，
于是"**没去看**磁盘"与"**看了**、磁盘上什么都没有"被合并：

> 一个「没给磁盘信息就跳过核对」的 SBOM，
> 与一个「核对过、没有任何不一致」的 SBOM，是同一个东西——
> 只不过前者从来没核对过。

修复：参数默认值去掉，只有 `!== undefined` 才核对。
这与 PRT-614 里 `legacyHighRiskTools`、`schedulers`、`selfCheck` 三处
"缺失 ≠ 空"是同一条纪律。

---

## 3 交付

### 3.1 `product/compliance/inventory.mjs`（判据，20 例）

| 导出 | 作用 |
| --- | --- |
| `collectManifests(root, io)` | 收集清单，**io 可注入**；坏清单标 `null` 而非丢弃 |
| `buildSbom({root, manifests, vendoredTrees, installedPrefixes})` | SBOM，两个来源 |
| `assertInventoryComplete(sbom)` | 覆盖面判据，报**路径**不只报个数 |
| `distributionTerms(component)` | 单个组件的分发条件 |
| `distributionReport(sbom)` | 全局分发条件报告 |
| `LICENSE_TERMS` / `DISTRIBUTION_VERDICTS` | 已知许可表 / 四级判定 |
| `INVENTORY_FINDINGS` | 4 个 finding 码 |
| `SBOM_VERSION` | `legion/sbom@1` |

`DISTRIBUTION_VERDICTS = ['permissive', 'copyleft', 'unknown', 'restricted']`。

**★ `unknown` 不是 `permissive`**：名单之外的许可一律 `unknown`，
而不是"看起来像 MIT 就当 MIT"。`clear` 仅在**没有** unknown/restricted 时为 true。

### 3.2 `scripts/prt/sbom.mjs`（生产入口，10 例）

```
node scripts/prt/sbom.mjs [--json] [--write <dir>] [--check]
```

- `discoverVendoredTrees(root, io)` — **在磁盘上找** vendored 树，io 可注入；
  两层（`.skills-cache/<owner>/<repo>`）与一层（`vendor/<name>`）都收，
  **没有清单的树也收**（`hasAnyFile` 回退）。
- `--check` 退出 1 当**完整性不 ok 或分发条件有 blocker**——
  两种不同的失败都该拦住发布。
- 报表**按码归并**再打印：一棵 vendored 树的 20 条未安装依赖是同一件事的
  20 次重复，会把真正的发现淹掉。
  > 一份长得像日志的报表，与一份没人看的报表，是同一个东西。

### 3.3 真实仓库读数

```
第三方组件清单 legion/sbom@1
清单根（7）：.skills-cache/main/teamai-cli-main / board-plugin / plugins
             / services-plugin / team-hub / whiteboard / workbench

组件：声明依赖 43 / vendored 源码树 1
完整性：✔ 覆盖两个来源
  [inventory-declared-not-installed] ×20  .skills-cache/main/teamai-cli-main/package.json

商业分发条件：
  permissive  1
  copyleft    0
  unknown     43
  restricted  0
  可分发：否（有 blocker）
```

`--check` 退出 **1**（当前状态，正确）。

---

## 4 验证

| 项 | 结果 |
| --- | --- |
| `product/compliance/inventory.test.mjs` | **20 例全绿** |
| `scripts/prt/sbom.test.mjs` | **10 例全绿** |
| 六道门禁 | 全绿 |

用例**不**断言仓库当前数值（那会在仓库正常演进时变红、却证明不了判据在不在），
而是断言**报表的形状**：两个来源都 > 0、同一棵树只出现一次、
`unknown` 与 `permissive` 分开计数、同码发现被归并、
`verdict` 相同但 `reason` 不同、缺席与空数组行为不同。

---

## 5 计数上的一个必要说明

`declaredCount = 43` 里包含那棵 vendored 树自己的 25 个依赖
（15 运行时 + 10 开发）。这不是重复计数——它们是真实声明过的依赖，
只是没有被安装。`declared-not-installed` ×20 说的正是这件事。

---

## 6 ⚠️ 诚实边界

1. **本模块不读依赖树。** 所以 43 个依赖的许可**全部**是 `unknown`。
   这是**准确的**读数，不是完成态：要得到真实结论必须实际安装依赖树
   （`node_modules`）后重跑。当前 `--check` 会（正确地）退出 1。

2. **PRT-902 的 DSH 侧未覆盖。** spec 说的是"确认 **DSH** 及所有依赖的商业使用
   与分发条件"。DSH 不在本仓库的扫描面上，本模块**看不到它**。
   PRT-011 已确认 DSH 为 MIT，但那是**另一批的结论**，不是本模块算出来的。
   完整覆盖需要把 DSH checkout 的清单纳入扫描面。

3. **没有校验签名或来源。** spec line 744（"安装包、升级清单和下载产物需要完整性
   校验"）属于 PRT-803/804，不在本批。本模块只做清点与许可判定。

4. **不是标准 SBOM 格式。** 输出是自有格式 `legion/sbom@1`，**不是** SPDX 或
   CycloneDX。若客户或法务要求标准格式，需要一层转换（字段已足够：name /
   version / license / path / kind）。

5. **`SCAN_SKIP_DIRS` 会跳过 `docs/`。** 这是有意的（`docs/` 里多为文档），
   但它意味着 `docs/T042-evidence/` 下的采集副本**不会**被清点。
   若那些副本随产品分发，本模块会漏掉它们。**这是一条已知的、未被判据覆盖的缺口。**

6. **"随产品分发"这个边界是人为设定的**（`VENDORED_ROOTS` 三项 + 跳过名单）。
   本模块无法判断某个目录里的代码到底会不会被装进安装包——
   那是打包流程（PRT-803）的事实，不是清单能推出来的。
