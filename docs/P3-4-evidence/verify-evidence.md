<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P3-4 插件配置面统一 · 验证证据

**切片**：P3-4 插件配置面统一（把 `plugins/` 等三个 DSH 插件族**从进程环境读取**的配置纳入统一配置体系；收口
`CHAT_CTX_BUDGET_CHARS` 的「单变量双语义双默认值」；补齐 `chatContext` 绕过 env 的硬编码）
**日期**：2026-09-10
**代码位置**：
`plugins/config-schema.mjs`（新）、`plugins/config-schema.d.mts`（新）、`plugins/src/config.ts`（新）、
`plugins/src/{spaceDigest,chatResponder,norms,chatContext,index}.ts`（接线）、
`board-plugin/config-schema.mjs`（新）、`services-plugin/config-schema.mjs`（新）、
`packages/shared/src/config.mjs`（引擎：`rules` / `injects` 两个可声明块）、`packages/shared/src/config.d.mts`（新，类型面）、
`whiteboard/packages/shared/src/config.mjs`（同步副本，`sync.mjs` 生成）、
`scripts/config/{scan,check,cross-checks}.mjs`、`scripts/config/fixtures/{good,bad}.env`、
`team-hub/config-schema.mjs`（登记 `CHAT_CTX_*` 为外来变量）
**参考手册**：`docs/CONFIG.md` §3.4–3.6、§4、§6、§8
**测试**：`plugins/tests/config.test.mjs`（8 例，新）、`scripts/config/config.test.mjs`（27 → 34 例）、
`tests/p13-fixture/p13-host-injection.test.mjs`（7 → 8 例，新增真实宿主侧断言）

---

## 1. 交付内容与验证方式

| 子项 | 实现 | 验证 |
| --- | --- | --- |
| ① plugins 纳入统一配置 | `plugins/config-schema.mjs` 声明 6 项（`CHAT_CTX_BUDGET_CHARS` / `CHAT_CTX_DIGEST_BUDGET_CHARS` / `CHAT_CTX_FILE_CAP_CHARS` / `NORMS_GLOBAL_MAX` / `NORMS_SPACE_MAX` / `NORMS_TOTAL_MAX`）；`plugins/src/config.ts` 一次性解析并暴露值/sources/诊断/脱敏摘要；四个消费模块改读 `pluginConfig.*` | 单测 8 例（默认值漂移、env 覆盖、非法值降级、规则告警、JSON 形态）；`scan --check` 把 plugins 纳入（`plugins/src` 直接 env 读取点 = 0）；真实宿主注入下日志出现摘要行（§3.3） |
| ② 双语义收口（T-124 S4） | 总预算 = `CHAT_CTX_BUDGET_CHARS`（8000，`chatResponder`）；摘要子预算 = **新变量** `CHAT_CTX_DIGEST_BUDGET_CHARS`（4000，`spaceDigest`/`chatContext`）；头注释 / README §9.2 / FEATURES / CONFIG 口径同步 | 单测：只改总预算时摘要子预算保持 4000；摘要长度实测（`CHAT_CTX_DIGEST_BUDGET_CHARS=200` → 摘要 < 400 字符，默认 → > 3000）——**证明 `chatContext` 不再是硬编码 4000** |
| ③ 插件族配置面可见 | `board-plugin`（`TEAM_HUB_TOKEN`）与 `services-plugin`（`TEAM_HUB_HOST`/`TEAM_HUB_TOKEN`/`DSH_HUB_UPSTREAM`）各加 schema；扫描器新增「别名环境对象」识别（`baseEnv.NAME`） | 单测断言 `baseEnv.*` 三处读取点被扫出（改造前**完全不可见**）；`scan --check` 6 个配置面全绿 |
| ④ 跨进程规则 | 新增 `services_inject_overrides_env`（托管启动注入的端口/上游与环境解析值不一致）、`plugin_hub_token_unset`；schema 增加进程内 `rules` 与 `injects` 两个可声明块 | 单测 2 例（构造两份配置触发/不触发）；`check.mjs` 10 → 12 条跨进程规则；bad 夹具实测报出 `services_inject_overrides_env` |
| ⑤ 门禁与文档 | CI env 阶段 scan/sync/check 自动覆盖新 schema；`docs/CONFIG.md` 新增 §3.4–3.6 与边界；`README.md` §9.2 表格修正；`STATUS.md`、`REMAINING-TASKS.md`（候选 #4 关闭）、`FEATURES.md`、`docs/review/T-124-REVIEW.md` S4 同步 | `node scripts/config/scan.mjs --check`、`sync.mjs --check`、`check.mjs --env-file=…good.env --isolated-env --strict` 三项 PASS（§3.1） |
| ⑥ 扫描器修复（**合并到 main 后才发现**，见 §2.7） | `scan.mjs` 剥注释后再提取读取点（字符串内的 `//` 不误伤同一行读取）；未跟踪文件在输出里显式提示；`services-plugin` schema 把 `TEAM_HUB_PORT`/`DSH_WORKBENCH_PORT` 列入 `nonEnvLiterals`（注入目标名，不是读取点） | 单测新增 1 例（注释不算读取点、字符串里的 `//` 不吃掉同行读取、解构不受影响、疑似字面量仍可见）+ 断言扫描文件数 ≥10（防「空集合假绿」）；`scan --check` 在 main 上 PASS |

## 2. 关键设计决策与取舍

1. **为什么插件不该「非法即退出」**：P3-2 的纪律是「非法值报错退出」，但插件跑在 **DSH 宿主进程内**——
   `process.exit` / 模块加载期 throw 等于连带杀掉宿主（P3-2 已在 CI 上实测过 import 期 exit 的破坏力）。
   因此插件族采用**大声降级**：非法字段回退 schema 默认值，同时在守护日志打印
   `配置非法（已回退默认值）：…`，且摘要里该字段的来源仍是 `default`（不会被误读成「你配的值生效了」）。
   这是唯一一处与三进程口径不同的地方，已写进 `docs/CONFIG.md` §1/§6/§8。
2. **为什么拆变量而不是统一默认值**：`CHAT_CTX_BUDGET_CHARS` 在文档与 `chatResponder` 里都是「总预算 8000」，
   只有 `spaceDigest` 把它当「摘要子预算 4000」。改默认值会**同时改变两处真实行为**；拆变量则把两个语义分开，
   默认行为零变化（4000 / 8000 保持不变），旧行为（让摘要跟随总预算）用「两个变量设同一个值」即可恢复。
3. **为什么给插件做 `.d.mts` 而不是复制引擎**：`plugins` 是 TS，`rootDir=src`，直接 import 兄弟目录的 `.mjs` 会报
   TS7016。仓库既有先例是 `.mjs` + 同名 `.d.mts` 配对（`artifact-policy`），照此给引擎补 `config.d.mts`，
   比「复制一份引擎」少一份会分叉的实现（白板的副本是 Docker 构建上下文所迫，插件没有这个约束）。
   部署侧依赖与 `board-plugin` 相同的前提：profile 里 `@dsh-external/*` 必须是**指向本仓源码的 junction**
   （否则 `plugins/lib/*.js` 的相对路径找不到 `packages/shared`）——这条前提 `STATUS.md` §1 已有硬性要求。
4. **`injects`：只有把「谁覆盖了谁」写进模型，校验结论才不会与现场相反**：托管启动的 team-hub **不读**
   `TEAM_HUB_PORT`，端口来自 `legion-services` 的 composition 配置项（缺省 8787）。单进程 schema 只会如实报告
   「环境里是 9000」，而现场实际在 8787 —— 新增的 `services_inject_overrides_env` 正是把这两个事实摆在一起。
5. **board-plugin / services-plugin 只做声明与校验，不改运行时**：它们的读取点只有 1 个和 3 个，且 token 主要来自
   composition；把运行时接到引擎上收益有限、风险不小（board-plugin 的 hub token 有一个 composition 回落层需要重构）。
   边界已明确写进 `docs/CONFIG.md` §8。
6. **扫描器识别 `baseEnv.NAME`**：services-plugin 用 `const baseEnv = { ...process.env }` 再读 `baseEnv.TEAM_HUB_TOKEN`，
   直接扫描**完全看不到**这些读取点——与 P3-2 那批 `envBytes(name, def)` 是同一类盲区。新增规则只在接收者以 `Env`
   结尾时生效，避免误伤普通对象属性。
7. **「在未提交的工作树上跑门禁」会给出假绿（实测教训）**：`scan.mjs` 的扫描范围是 **git 跟踪的文件**，
   而 P3-4 的新文件（`plugins/src/config.ts` 等）在提交前是未跟踪的 → 扫描器直接跳过它们 → 本地 `scan --check`
   与 config 套件都是绿的。合并到 main（文件已被跟踪）后立刻暴露两个真问题：① 注释里那句
   `Number(process.env.X || 默认值)` 被当成读取点，报出根本不存在的未声明键 `X`；②
   `services-plugin/config-schema.mjs` 里作为**注入目标名**出现的 `TEAM_HUB_PORT` / `DSH_WORKBENCH_PORT`
   被要求「声明或排除」。两处都已修（§1 第 ⑥ 行），并把教训固化进测试：新断言要求
   `scanProcess('plugins').filesScanned >= 10`——空集合只有在「确实扫到了文件」时才能当证据。

## 3. 复跑命令与实测输出

### 3.1 CI env 阶段的三项配置自检

```bash
cd D:\project\DSH\legion
node scripts/config/scan.mjs --check
node scripts/config/sync.mjs --check
node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict
node scripts/config/check.mjs --env-file=scripts/config/fixtures/bad.env --isolated-env
```

实测（原文照抄）：

```
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 91 个疑似字面量）
sync: PASS（白板副本与根实现一致）
config check: PASS（error 0，warning 0，strict）
config check: FAIL（error 6，warning 8）   ← bad 夹具：含 NORMS_GLOBAL_MAX 非法值 + 两条预算规则违规
```

`scan` 的六个配置面里，插件族的部分：

```
=== plugins：士兵守护插件族（plugins/：scrum-worker / mediator） ===
  直接读取 env 键 0 个；疑似 env 字面量 0 个          ← 改造后全部经引擎，不再散读
=== board-plugin：Scrum 看板插件 ===
  TEAM_HUB_TOKEN ×1
=== services-plugin：服务托管插件 ===
  DSH_HUB_UPSTREAM ×1 / TEAM_HUB_HOST ×1 / TEAM_HUB_TOKEN ×1   ← baseEnv.* 别名读取（新增识别）
```

### 3.2 bad 夹具里的两条新结论（原文照抄）

```
  ⚠ [ctx_digest_over_total] 摘要子预算 CHAT_CTX_DIGEST_BUDGET_CHARS=5000 大于总预算 CHAT_CTX_BUDGET_CHARS=1000…
  ⚠ [ctx_file_cap_over_total] 单块上限 CHAT_CTX_FILE_CAP_CHARS=4000 大于总预算 CHAT_CTX_BUDGET_CHARS=1000…
  ⚠ [services_inject_overrides_env] team-hub 由 services-plugin 托管启动时会注入 TEAM_HUB_PORT=8787，
    与环境解析值 5173 不一致：托管实例实际生效的是注入值
```

### 3.3 真实宿主注入下的守护日志（P3-4 新增断言）

`tests/p13-fixture/p13-host-injection.test.mjs` 用例 ①b 在**真实 DSH 宿主**（隔离 `$DSH_HOME` + 真实 loader +
三插件 junction）里启动守护后，直接读守护自己的日志文件断言这一行：

```
[2026-09-10T…] [config] plugins chatCtxBudgetChars=8000(default) chatCtxDigestBudgetChars=4000(default) chatCtxFileCapChars=4000(default) normsGlobalMax=3000(default) normsSpaceMax=4000(default) normsTotalMax=7000(default)（全部取默认值）
```

同一用例还断言「无非法配置时不得出现 `配置非法（已回退默认值）` 行」——即「大声降级」只在真出错时发声。

### 3.4 全量门禁

```powershell
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci\p3-4-final
```

实测：`env` PASS（含 config scan/sync/check 三项）、`test` PASS **38 套件 / 943 用例**
（`plugins` 185、`config` 36、`p13-host-injection` 8；上一轮基线 926 例 —— 本次 +17 例全部是新增断言，
无既有用例被删除或放宽）、`doc` PASS（文档新鲜度 + 证据快照 banner 覆盖，55 个快照目录）。
逐套件数字与 `docs/STATUS.md` §2 表格一致（同一份 `.ci/<run>/summary.json`）。
本次 `test` 阶段耗时 380s（同内容的另一次运行 171s）——差异来自机器上并行的 node 任务，不是测试变慢。

> 运行环境备注（如实登记）：在**未提交的 worktree** 上跑 `--only test` 需要 `workbench/node_modules`
> （`doc-render` 套件依赖 `react-dom`），而该目录由 `--only deps` 阶段创建、`--only test` 会跳过。
> worktree 里没有它时，缺件会表现为 `doc-render` 直接 `ERR_MODULE_NOT_FOUND`（第一次全量运行就是这么失败的）。
> 这不是本切片引入的缺陷，已用目录 junction 指向主检出解决；`deps` 阶段本身未改动。

## 4. 已知边界（诚实登记）

1. **插件的主配置面仍是宿主 composition**：`config:` 块里的 `role` / `intervalMs` / `maxWorkers` / `hubUrl` /
   `scope` / `rolesFile`… 本切片**没有**搬到 env/schema（也不该搬）：它们需要按空间分别取值，而 env 是进程级的。
   `check.mjs` 看不到这层，只能靠部署核对。
2. **`board-plugin` / `services-plugin` 未接运行时**：只做声明 + 扫描覆盖 + 跨进程校验（见 §2.5）。
3. **`services-plugin` 的 composition 覆盖不可见**：若 `legion-services` 的 `config.teamHubToken` 与环境的
   `TEAM_HUB_TOKEN` 不同，孪生规则的结论会与实际注入值不一致——env 面无法看到 composition。
4. **不支持热更新**：插件配置在模块加载期解析一次；改 env 必须重启 DSH 宿主（与三进程口径一致）。
5. **`CHAT_CTX_DIGEST_BUDGET_CHARS` 是行为变更点**：给 `CHAT_CTX_BUDGET_CHARS` 设了非默认值、又依赖
   「摘要子预算跟着一起变」的部署需要显式设置新变量（默认值路径行为不变：4000 / 8000）。
   本机与部署环境实测均**未设置**任何 `CHAT_CTX_*`（进程/用户/机器三级环境变量与 `cordis.patch.yml` 均为空），
   因此对现状是行为等价的重构。
6. **`check.mjs` 仍不发网络请求**：它只做配置面一致性，插件是否真的用上了这些预算仍需现场日志（§3.3 那条摘要行）
   来确认。
