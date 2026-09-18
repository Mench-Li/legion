# PRT-257（续）：把强制面**真的**交给 DSH Runtime —— `--patch` 覆盖层接线

> 前几批把 Launcher（进程清单 / 白名单注入 / 就绪判据 / 监督退避 / 应用自检与修复）
> 做完了，也把 DSH 侧的 `bootstrapDshRuntime`（自检 → 注册端口）做完了。
> 本批补的是这两者与 DSH 之间**唯一还缺的那一截接线**。

---

## 1. 缺的是哪一截

`legion-host.patch.yml` 早就有了，而且早就被证明"DSH 读得懂"——
`patch-loadable.test.mjs` 用真 DSH 管线验过：叠在真 base bundle 上**零警告**，
`permission` 行的 preset 表被**真的替换**。

但**没有任何东西把它交给一个 DSH 进程**：

| 环节 | 状态（本批之前） |
| --- | --- |
| `legion-host.patch.yml` 存在且可加载 | ✅ |
| hard-floor 插件能拦住工具调用 | ✅（`enforcement-plugin.test.mjs`） |
| Launcher 拼 `runtime` 命令行 | ✅ 但 `argsTemplate: []`，只用 `runtime.command` |
| `materializeProcessPlan` 的 `extraArgs` 口子 | ✅ 存在，**但没人往里放东西** |
| **那份补丁层的实际作用范围** | ❌ **零个部署**——包括本机这一个 |

> 一个"写好了、也验证过能被加载"的补丁层，
> 与一个"从未被交给任何进程"的补丁层，在运行的部署上是同一个东西——
> 只不过前者的用例是绿的。

---

## 2. ★ 为什么是 `--patch`，而不是 profile 自己的 `cordis.patch.yml`

DSH 的组合顺序（profile 根的 `cordis.yml` 文件头自己写着，
`args.ts` 的 `--patch <path>  extra patch-list overlay applied after the profile layer` 同样）：

```
bundle 层  →  profile 的 cordis.patch.yml  →  --patch 覆盖层（最高优先级）
```

profile 的 `cordis.patch.yml` **属于用户**——那是他 `dsh plugin add` 之后手改的那一份，
也是产品升级时最不该被覆盖的一份。把强制面写进去，等于
"用户下一次编辑自己的 profile 时，可以把安全下限顺手删掉"。

> 一个"能被用户在同一次编辑里删掉"的强制面，
> 与一个"根本没有强制面"的部署，在事故复盘里是同一个东西——
> 只不过前者的配置文件里曾经写着它。

`--patch` 覆盖层在最高优先级、由**启动方**逐次给出、且不落进用户的 profile。

---

## 3. 交付

| 文件 | 内容 |
| --- | --- |
| `product/launcher/dsh-overlay.mjs` | 新增：`resolveDshOverlay()` / `overlayArgsFor()` / `overlayRelpathOf()` |
| `product/launcher/dsh-overlay.test.mjs` | 新增：**17 例** |
| `product/launcher/launcher.mjs` | 把解析结果经 `extraArgs` 交给 runtime 进程；诊断并入 `planDiagnostics` |
| `product/launcher/cli.mjs` | 配置 → Launcher 选项 |
| `product/config.mjs` | 新配置键 `runtime.enforcementOverlay`（boolean，**默认 true**） |
| `product/config-schema.mjs` | 4 个诊断码登记 |
| `product/launcher/index.mjs` | 导出新模块 |

启动路径现在是：

```
loadProductConfig → launcherInputFromConfig → cli.mjs
  → createLauncher → resolveDshOverlay → materializeProcessPlan(extraArgs)
  → runtime argv = dsh <用户配的> --patch <安装目录>/runtime/dsh-composition/legion-host.patch.yml
```

---

## 4. ★ 三条判据

### 4.1 默认装上；关掉必须是一次**说出来的**决定

`runtime.enforcementOverlay` 默认 `true`。关掉不被禁止，但会留下一条 `warn`
把它记下来，而且文案里直接写出怎么开回来——与 `product/secrets.mjs` 里
"明文后端 fail closed，但错误文案写出 `requireProtected: false` 怎么写"同一条取舍。

> 一个让人猜不到怎么关掉的门禁最后会被人绕过；
> 一个写清怎么关掉的门禁，至少让绕过成为一个被记录下来的决定。

### 4.2 打开但文件不在 → **阻塞启动**（唯一会拦的分支）

这是本模块唯一拦启动的情形，理由是这一层**被要求装上却没装上**。
只报 warn 然后照常启动，得到的就是一个"看起来装了强制面"的运行时——
比一个明确起不来的运行时危险得多。而且此时**不给 `--patch`**：
给了的话 DSH 会在启动那一刻自己报一个不提"补丁层"的错，排障会从 Runtime 开始找。

### 4.3 判序：关掉时**不**报"文件不在"

反过来的话，一个"故意不装、而且本来也没这文件"的部署会收到两条诊断，
其中一条会让人去查安装完整性——而真因是用户自己关掉了。

> 一个错的诊断，比没有诊断更坏。

---

## 5. 验证

### 5.1 ★★★ 真 DSH CLI 吃下了 Launcher 拼出的 argv

这是"接上了"的**唯一**直接证据：不是我们算出了 argv，而是**别人吃下了它**。

用一个**隔离的 `DSH_HOME`**（绝不碰用户在跑的 `web` profile），
`--dump-config` 打印组合树：

```
legion 行命中: ["legion-enforcement-hard-floor"]
模块被解析成:   file:///D:/project/DSH/legion/.worktrees/prt-runtime/runtime/dsh-composition/plugins/hard-floor.mjs
```

相对模块名 `./plugins/hard-floor.mjs` 被 DSH 的 `anchorInsertedPluginNames`
**锚定到补丁文件所在目录**，并转成 `file://` URL——这条被逐字符断言。

**对照组**：不带 `--patch` 时组合树里**没有**任何 Legion 行；
把路径指向一个不存在的文件时，DSH **自己报错、退出码非 0**。
没有这个对照，"exit 0"什么也证明不了。

### 5.2 断验证 9/9，逐字节还原

| 探针 | 弄坏什么 | 结果 |
| --- | --- | --- |
| ① | **接线断掉**：Launcher 不再把覆盖层交给 runtime | ✅ 红（2 条，含真 DSH 那条） |
| ② | 缺文件时不再阻塞 | ✅ 红（3 条） |
| ③ | 关掉时不再留 warn（静默关掉） | ✅ 红（3 条） |
| ④ | 判序反过来：关掉时也去报"文件不在" | ✅ 红（**只红那一条**） |
| ⑤ | 诊断丢掉 `process` 键（范围排除时降不了级） | ✅ 红（3 条） |
| ⑥ | 补丁路径写成相对形式 | ✅ 红（6 条） |
| ⑦ | 相对路径字面量漂移 | ✅ 红（6 条） |
| ⑧ | 配置键不再被读出来（写了不生效） | ✅ 红（1 条） |
| ⑨ | `overlayArgsFor` 对垃圾输入抛错 | ✅ 红（1 条） |

★ 探针 ④ 第一版把 `io.exists` 改成恒 false，红了 5 条**别的**用例，
而"判序"那一条**没有红**（因为 `enabled === false` 仍然先返回）。

> 一个"把很多东西一起弄坏"的探针，
> 与一个"真的咬住了那一条判据"的探针，在 `fail > 0` 这个读数上是同一个东西——
> 只不过前者证明了任何事。

改成精确地改判序（让 disabled 分支多要求"安装目录存在"）后，**只有那一条**红。

### 5.3 全量

`dsh-overlay` **17/17**；七道门禁全 PASS；全量 CI **9 阶段全 PASS**，
`test` **168 套件 / 4548 用例 / 0 fail**（`.ci/prt-257e/`）。
（套件数没变是因为 `dsh-overlay.test.mjs` 并进了既有的 `product-launcher` 那一组：
它 17 条里只有 2 条需要 DSH_CHECKOUT，没理由为它单开一个几乎恒在的组。
`product-launcher` 于是从 82 条变成 99 条。）

---

## 6. ⚠️ 诚实边界（重要）

1. **这一批让补丁层进了组合树，但没有让它"生效"到"能拦住一次工具调用"。**
   组合树里有 `legion-enforcement-hard-floor` 这一行，只说明 DSH 会去 `import()`
   那个模块并把它作为一个插件行挂上。**没有**在真实 DSH 进程里观察过
   "一次越界的工具调用被它拒掉"——那需要一个真的跑起来、带模型与工具调用的部署。
   （插件本身的行为由 `enforcement-plugin.test.mjs` 对着**真 ToolRuntime** 验过，10/10。）

   > 一个"组合树里有这一行"的读数，
   > 与一个"这一行真的拦住了东西"的读数，在 `--dump-config` 的输出里是同一个东西——
   > 只不过前者会在某次真实执行里，第一次发现自己没生效。

2. **补丁层仍不完整，启动自检仍会拒绝。** `PATCH_LAYER_ROWS` 里
   `pre-execute` 与 `approval-answerer` 两行仍是 `module: null`，而且**只能**是——
   这两个模块刻意**没有默认导出**（它们需要运行期配置，见 `PRE_EXECUTE_NEEDS_RUNTIME_CONFIG`），
   所以它们**不能**作为补丁行加载。本批实测确认了这一点：
   `hard-floor.mjs` 的 `default` 是 object，另两个都是 `undefined`。
   它们只能由 `assembleEnforcement()` 在进程内挂载，而那个函数**仍无生产调用方**。

3. **`bootstrapDshRuntime()` 仍无生产调用方。** 本批接的是"补丁层 → DSH 进程"，
   不是"自检 → 注册端口"。后者的入口在 DSH 进程内，而 Legion 目前不掌控
   那个进程的启动脚本（`runtime.command` 是用户配的）。
   因此"强制面未生效时禁止自动执行"这条保证**仍然没有被行使过**。

4. **没有在真实部署上验证过。** 上面那次真 DSH 调用用的是隔离的 `DSH_HOME`
   与一个空 bundle 的临时 profile。用户实际在跑的那个 `web` profile
   （`bundles: [dsh-base, dsh-web-app]`）**没有被碰过**——也因此，
   `permission` 那一条 `patch-over` 在真实 profile 上的效果本批没有新证据，
   它依赖的是 `patch-loadable.test.mjs` 早先对着真 base bundle 的验证。

5. **`runtime.enforcementOverlay: false` 的部署会安静地少一层强制面。**
   有一条 warn，但 warn 不是门禁。这是刻意的（4.1），但它意味着
   "Legion 一定装了强制面"这句话对**默认配置**成立，不是对**所有配置**成立。

**PRT-257 仍是 🟡。** 本批把"补丁层从未被交给任何进程"这一条从清单上划掉了；

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*
剩下的是第 2、3、5 条——**需要掌控 DSH 进程的启动**，那是 Launcher 与
用户配置的边界，不是再加一个模块能解决的。
