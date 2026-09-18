# PRT-214（五）：员工 agent preset —— agent 平面那一半

> 前四批把 **host 平面**做完了（hard floor、pre-execute、approval answerer、preset 表）。
> 本批做 spec §6.9 那张归属表的第二行：**Legion 员工 agent preset**。

---

## 1. 它在哪张表里

spec §6.9 line 486–489：

| 组件 | 所属平面 | 内容 |
|---|---|---|
| Legion DSH 组合补丁层 | host 组合 / profile 层 | ToolGuard hard floor、`tools/pre-execute` 策略 listener、approval answerer、permission preset 表 |
| **Legion 员工 agent preset** | **agent 平面，按 session 挂载** | **岗位工具集、persona、提示段、skill 引用** |

补丁层那一半由 `legion-host.patch.yml` 承载，本批补上另一半：
把一份**员工清单**渲染成一个 DSH 认得的 preset 目录。

```
<presetRoot>/<presetId>/agent.cordis.yml
<presetRoot>/<presetId>/preset.yml
```

| 文件 | 内容 |
| --- | --- |
| `runtime/dsh-composition/employee-preset.mjs` | 新增：工具路由表、授权覆盖推导、渲染、安装 |
| `runtime/dsh-composition/employee-preset.test.mjs` | 新增：**28 例** |

---

## 2. ★ 为什么工具行必须**由授权推导**

它的失败模式与强制面**相反**。强制面坏掉是"该拦的没拦"（吓人、可见）；
员工 preset 坏掉是"**该有的工具没有**"——而这件事**不报错**：

- **写多了** → 员工拿到清单外的工具，运行期被强制面按 grant 拒掉。
  *看起来*安全，但"一个被拒了三次的员工"与"一个没被授予这个工具的员工"
  在读数上不同，排查的人会去查权限，真因却在 preset 里多了一行。
- **写少了** → 员工干不了活。**这个更坏**，因为它静默。

> 一个"清单给了权限、preset 没给工具"的 preset，
> 与一个"这个岗位本来就没有这个权限"的 preset，在模型那里是同一个东西——
> 只不过前者会让一次本该成功的工作变成一句"**我做不到**"。

所以行是从 `grant` 推导的，而且清单里**每一项都要有一个交代**。
`coverageOf()` 对每个被授予的工具给出三种状态之一：

| 状态 | 含义 | 是否装行 |
| --- | --- | --- |
| `covered` | DSH 随部署分发的 preset 行能提供它 | ✅ 装 |
| `hosted` | 由 **Legion 宿主平面**注册（`read-secret` / `send-message` / `mcp-invoke` …） | ❌ 不装 |
| `unknown` | 登记表里都不认识 | **渲染失败** |

`hosted` 是 spec §6.9 那条平面规则的直接后果：跨 session 的能力归 host，
员工 preset 只承载**岗位能力**。

---

## 3. ★ 包名是**读出来的**，不是猜的

每一个 `provides` 都来自 `DSH_CHECKOUT` 里的源码：

| 包 | 提供的工具 | 依据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-fs` | `read` `write` `edit` `read_image` | `packages/fs/tool-fs/src/*.ts` 的 `name:` |
| `@deepseek-ai/dsh-tool-fs-search` | `glob` `grep` | 同上 |
| `@deepseek-ai/dsh-tool-bash` | `bash` | 同上 |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` | 同上 |
| `@deepseek-ai/dsh-tool-web` | `web_fetch` `web_search` | 同上 |

用例里有一条**逐字比对**：我们用的每个包名都必须出现在随部署分发的
`standard` preset 里。凭记忆写包名的后果不是报错，而是在 DSH 挂载时报
`Cannot find package`——那时它已经是"部署起不来"，不是"渲染错了"。

### 3.1 ⚠️ 平台门必须互补

`tool-bash` 与 `tool-pwsh` 各自带 `disabled: !!js ...`。
不生成这一行的后果不是报错，而是**装了一个跑不起来的东西**。
用例断言两条表达式**不相等**——同向会让两个平台各少一半 shell。

---

## 4. ★ 四条平面红线（全部在渲染期拒绝）

1. **强制面字段**（`hardFloor` / `denyTools` / `approval` / `sandbox` / `preExecute` / `answerer` …）
   → spec §6.9 line 493。`一个能写这些字段的清单就是一个能给自己发权限的清单。`
2. **名字像强制面组件的提示段行**（`pre-execute` / `tool-guard` / `approval` / `permission` / `hard-floor`）
   → 同上。preset 按 session 挂载且**可被 shadow**，把安全下限放进去等于让它取决于
   当前 session 恰好挂了哪个 preset。
3. **会发布服务的行却没有 `isolate` realm** → 第二个 session 挂载时在 root realm 撞名。
   （见 skill `editing-cordis-compositions` 的 realm 规则。）
4. **与随部署分发的 preset 撞名**（`standard` / `ptc` / `minimal` / `cordis`）
   → spec §6.9 line 496。**渲染期和安装期各拦一次**——安装期拦的是"有人手工造了个
   `id: 'standard'` 的假 preset 对象直接调安装器"。

---

## 5. ★ 三条实测抓出来的真问题

### 5.1 有一个行"声明了却永远装不上"

第一版 `read-file` 只路由到 `tool-fs`，于是 **`tool-fs-search` 没有任何工具能到达它**——
表里声明了，产出的 preset 里永远不会出现它。

> 一个"声明了却永远装不上"的行，
> 与一个"根本不在表里"的行，在产出的 preset 上是同一个东西——
> 只不过前者会让读表的人以为 `glob`/`grep` 已经给了员工。

修法：`read-file` 路由到 `tool-fs + tool-fs-search`，并加一条**可达性不变量**
`assertEveryRowReachable()`；配套一条用例喂**故意断链表**进去，证明它不是恒真的。

### 5.2 ★ 表头随输入顺序变 → 伪变更

第一版表头按 `grant.allowedTools` 的顺序输出，于是同一份授权、只是清单里工具名换了顺序，
就渲染出**不同的文件**。

> 一个"行序固定但表头随输入顺序变"的渲染器，
> 与一个"每次渲染都产生一次伪变更"的渲染器，是同一个东西——
> 只不过前者会让代码评审里出现一条没有实际内容的 diff。

修法：表头与行序用**同一个**依据（字典序），让"逐字节相同"对整份文件成立。

### 5.3 为准确起见：`@` 开头必须加引号

我的用例一开始把 `@deepseek-ai/dsh-tool-fs` 归进"不该加引号"。
**那是我错**：`@` 是 YAML 的保留指示符，不能作为 plain scalar 的开头——
而随部署分发的 `standard` preset 也正是给它加了引号
（`name: '@deepseek-ai/dsh-tool-fs'`）。那是**基准**，不是巧合。

---

## 6. 验证

### 6.1 断验证 7/7，逐字节还原

| 探针 | 弄坏什么 | 结果 |
| --- | --- | --- |
| ① | 未覆盖的工具从"失败"降级成"静默丢掉" | ✅ 红 |
| ② | 强制面字段不再拦截 | ✅ 红 |
| ③ | 撞名不再拦（能覆盖 `standard`） | ✅ 红 |
| ④ | id 校验放宽（目录名可带斜杠/大写） | ✅ 红 |
| ⑤ | 引号判定退化成"只对看起来危险的加" | ✅ 红 |
| ⑥ | 表头不再排序（伪变更） | ✅ 红 |
| ⑦ | 安装器不再拒绝写随部署分发的目录 | ✅ 红 |

### 6.2 真 DSH loader（不是自己抄的 schema）

用例用 DSH 自己的 `entryListSchema` + 真 js-yaml 解析生成的 preset
（与 `agent-presets/src/discovery.ts:236` 同一条路径），并断言：

- 顶层是数组；
- 行 id 序列正确；
- `disabled` 被读成**表达式对象** `{__jsExpr: "process.platform === 'win32'"}`，
  而不是字符串——那证明 `!!js` 真的被当成表达式，平台门会生效。

### 6.3 全量

`employee-preset` **28/28**；七道门禁全 PASS；全量 CI **9 阶段全 PASS**，
`test` **168 套件 / 4531 用例 / 0 fail**（`.ci/prt-214e/`）。

---

## 7. ⚠️ 诚实边界

1. **没有做 `standingKeyFor` 挂载验证。** skill 说那是"组合真的能不能挂上"的判据。
   它需要把 preset 装进**用户 preset 根**并让宿主侧的 roster 去挂——
   那是对**用户环境**的写操作，而且要在你这个会话里做。
   **本批只证明了"DSH 的 loader 能解析"，没有证明"它挂得上"。**
   > 一个"schema 解析通过"的 preset，
   > 与一个"真的能挂上"的 preset，在解析器那里是同一个东西——
   > 只不过前者会在一行包名解析不到时，于部署启动时才失败。
2. **`installEmployeePreset()` 没有生产调用方。** 它目前只有用例在调。
   生产里的写入方是 Launcher（PRT-257）。
3. **没有员工清单的权威来源。** 谁产出 `manifest`、从哪读，属于 PRT-4xx 那一批。
4. **员工 preset 与补丁层从未一起装进任何 profile。** 补丁层那边同样如此
   （见前四批的边界说明）——两者的"实现完成"都还没有一个部署把它们接起来。

**PRT-214 仍是 🟡**，但这已经不是"实现没写完"：四行强制面 + preset 表 +

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*
员工 preset 渲染器都在。剩下的是**把它们接进一次真实的部署**，
那属于 PRT-257（Launcher 首次安装 / 应用自检 / 修复入口）。
