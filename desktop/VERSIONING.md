# 桌面端版本管理

> 这份文档回答三个问题：**版本号放在哪**、**每次打包怎么定它**、**哪里会出错**。
>
> 对应的工具：`scripts/release/version.mjs`（`check` / `show` / `bump`）。
> 对应的门禁：`scripts/ci/run-ci.mjs` 的 `test` 阶段里那条「桌面端版本号自洽」。

## 一、版本号住在哪（两个载体，各管一件事）

| 载体 | 字段 | 它决定什么 |
| --- | --- | --- |
| `desktop/package.json` | `version` | **安装包文件名**。`desktop/scripts/build.mjs` 的 `artifactName` 是 `Legion-${version}-internal-${arch}-setup.exe` |
| `product/release/runtime-manifest.json` | `productVersion`、`legionVersion` | **发布清单**。`desktop/scripts/stage.mjs` 读它作为 `release`，写进 `desktop-release.json` |

第三个值是**每次发行时**给的，不写在这两个文件里：

| 位置 | 值 | 谁给 |
| --- | --- | --- |
| `releases/<id>/manifest.json` | `productVersion` | `node scripts/update/publish.mjs --product-version …` |

`desktop/scripts/update-payload.mjs` 会**强制**载荷里的 `productVersion` 与本次发行的声明一致，不一致报 `payload-version-mismatch`。

## 二、每次打包怎么定（跑一条命令）

```bash
# 看现在是什么版本、以及每个字段的来源
node scripts/release/version.mjs show

# 手动指定（推荐，默认方式）
node scripts/release/version.mjs bump --to 0.2.0

# 从上游 DSH 派生：取 dshVersion 的 major.minor，patch 归零
node scripts/release/version.mjs bump --from-dsh --dsh 0.8.3     # → 0.8.0

# 先看看会改什么，不落盘
node scripts/release/version.mjs bump --to 0.2.0 --dry-run

# 检查两处是否一致（CI 里跑的就是这一条）
node scripts/release/version.mjs check
```

`bump` 做的是**一处输入 → 同时改两处**，并且走**生产的清单组装器**
（`buildVersionManifest`）来校验新清单——所以"改版本"和"发版本"用同一套判据，
包括补丁层版本的交叉验证。

### 打包全流程

```bash
cd desktop
pnpm run prepare:payload      # 装 DSH 载荷（按 runtime-manifest 的 dshVersion）
pnpm run prepare:node         # 内置 Node 24.19.0
pnpm run prepare:git
pnpm run stage                # 组装 + 写 desktop-release.json
pnpm run dist                 # → desktop/dist/Legion-<version>-internal-x64-setup.exe
pnpm run update:payload -- --product-version <version>   # 造升级 ZIP
```

版本号要在 `stage` **之前**改好——`stage.mjs` 一旦跑过，`desktop-release.json`
里记的就是当时那个值。

## 三、哪里会出错

### 陷阱 1：两处都语法合法，却各说各话

两个载体是**互相独立**的 JSON 字段，没有任何东西天然强制它们相等。只改一处的
**表现**是"安装包叫 0.2.0、清单里写着 0.1.0"——两个文件都能被各自的读者读出来，
不会报任何错。

线上实测（2026-10-10）就是这个形态：

```
r-2026-10-06_0.1.0   装机包 204,582,159 字节
r-2026-10-07_0.1.0   装机包 204,641,180 字节   ← 不同构建、不同字节
两次的 productVersion 都是 0.1.0
```

两次发布的**字节不同**，而版本号**没变**，区分只能靠 `releaseId` 里的日期。而设计稿
§4 对 `releaseId` 的要求恰是「同版本不同字节也必须使用不同 releaseId」——也就是说
这个形态**被设计预见过**，只是此前没有机器判据把它钉住。

> 一个"版本号没变、字节变了"的发布，
> 与一个"版本号变了"的发布，在升级判据（`upgradeWindow` / `supportedFromVersions`）
> 眼里是同一个东西——只不过前者会让用户装到一个他以为已经装过的版本。

**现在有判据了**：`run-ci.mjs` 的 `test` 阶段会跑 `checkVersions()` 读**真的那两个
文件**，不一致就 FAIL。选在门禁里跑而不是只放在用例里，是因为用例用的是**夹具**
（临时目录）——那证明的是"这套机制存在"，而门禁证明的是"这台仓库现在自洽"。

### 陷阱 2：清单"改得出来"但"装不进去"

`renderVersionManifest()` 的注释写着「渲染成**能直接落盘**的文本」，但它的产物
**过不了**它自己用的那个生产校验器：

```
buildVersionManifest(...)  → ok = true
renderVersionManifest(...) → 能 JSON.parse、八个 spec 字段齐全
validateManifest(那份产物) → ok = false
  manifest-field-missing: manifestFormat
```

根因：渲染器只渲染 `fieldSources` 里的**八个 spec 字段**，而 `manifestFormat` 按注释
是"格式标记、不算 §9.1 的字段"，于是没被写出去。而"合法 JSON"与"能被消费的清单"
是两个问题。

> 一个"渲染得出来、也 JSON.parse 得回来"的清单，
> 与一个"装的时候真的会被接受"的清单，在渲染器自己的用例里是同一个东西——
> 只不过前者的绿来自只断言了"是合法 JSON"，而消费者问的是另一个问题。

**已修**，并补上了缺的那条判据：`runtime-manifest.test.mjs` 里做**往返**
（渲染 → `JSON.parse` → 生产校验器必须通过）。

### 陷阱 3：`dshVersion` 与补丁层要成对

`runtime-manifest.json` 里 `dshVersion` 与 `dshCompositionPatchVersion` 是**成对**的：
后者由 `runtime/dsh-composition/patch-layer.mjs` 声明，组装器会做交叉验证。
`bump --dsh <版本>` 会同时改 `dshVersion`；补丁层版本**不要手改**——
它是从代码常量读出来的。

## 四、版本号的来源（`show` 会把它打出来）

八个 §9.1 字段里，**三个**能从仓库常量推出来，**五个**只能由发布决定：

| 字段 | 来源 |
| --- | --- |
| `dshCompositionPatchVersion` | 推出来：`runtime/dsh-composition/patch-layer.mjs` |
| `runtimeContractVersion` | 推出来：`runtime/contracts/adapter.mjs` |
| `packProtocolVersion` | 推出来：`runtime/packs/manifest.mjs` |
| `productVersion` / `legionVersion` | **发布决定**（本工具的 `bump` 写它们） |
| `dshVersion` | **发布决定**（这一版支持哪个 DSH） |
| `schemaVersion` | **发布决定** |
| `channel` | **发布决定**（`internal` / `canary` / `stable`） |

> 一份编出来的清单比没有清单更坏——安装器会照着它去锁一个具体版本，
> 而那个版本从来没有人决定过。所以 `buildVersionManifest` 对缺的字段
> **具名拒绝**（`RUNTIME_MANIFEST_FIELD_UNDECIDED`），不给默认值。

## 五、改坏了怎么查

```bash
node scripts/release/version.mjs show      # 两个载体现在的值 + 每个字段的来源
node scripts/release/version.mjs check     # 只回答"自洽吗"
git diff desktop/package.json product/release/runtime-manifest.json
```

`bump` 会**先**用生产组装器校验新清单，校验不过就**不落盘**；改完还会立刻
复核一次。所以一次成功的 `bump` 不会留下半改状态。

## 六、破坏性验证

```bash
node scripts/qa/version-probes.mjs
```

8 条探针，覆盖"只改一处""dry-run 落盘""绕开组装器""派生规则写错"，以及
**把陷阱 2 那个真 bug 改回去**。每条都要同时满足：改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃。
