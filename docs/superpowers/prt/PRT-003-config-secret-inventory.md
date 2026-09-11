# PRT-003 配置与密钥来源清单

**对应**：`PRT-003`
**机器清单**：[`prt-001-003-inventory.json`](./prt-001-003-inventory.json)（本文件是它的人读副本；两者冲突时以 JSON 为准）
**采集方式**：`node scripts/prt/topology-inventory.mjs --record`

> 本清单**只登记键名与拥有者，不登记任何值**。它会进版本库，把疑似密钥的值写进去
> 等于把问题放大一次。

---

## 1. 配置面总览

| 进程 | Schema | 已声明字段 | 真实读取 env 键 |
| --- | --- | --- | --- |
| team-hub | `team-hub/config-schema.mjs` | 12 | 见 JSON |
| workbench | `workbench/scripts/config-schema.mjs` | 22 | 见 JSON |
| whiteboard | `whiteboard/apps/server/src/config-schema.mjs` | 22 | 见 JSON |
| plugins | `plugins/config-schema.mjs` | 6 | 见 JSON |
| board-plugin | `board-plugin/config-schema.mjs` | 1 | 见 JSON |
| services-plugin | `services-plugin/config-schema.mjs` | 3 | 见 JSON |

合计 30 个真实 env 读取点。

---

## 2. 声明缺口：**0**

spec §6.10 要求「所有环境变量必须在配置 Schema 中声明」。**当前这项要求已经满足**：

- `scripts/config/scan.mjs --check` PASS（全部读取点与疑似字面量均已处理；
  97 个疑似字面量全部落在声明、前缀或 `nonEnvLiterals` 内）
- 本清单的 `declarationGaps` 为**空数组**

这是一条**正面结论**，值得记下来：P3-2 统一配置系统已经把这条差距关掉了，
PRT 不需要为此再做工作。单测里有一条断言锁住它——缺口一旦出现就红。

> 那条断言红的时候，正确做法是**先把缺口写进 spec §6.10 的差距清单**，
> 而不是放宽断言。

---

## 3. 密钥来源清单

### 3.1 敏感字段与拥有者

| 敏感字段 | 拥有者 | 用途 |
| --- | --- | --- |
| `TEAM_HUB_TOKEN` | team-hub、workbench、board-plugin、services-plugin | hub 读接口鉴权；**四个进程必须同值** |
| `DSH_WORKBENCH_TOKEN` | workbench | 指挥台自身鉴权 |
| `WHITEBOARD_TOKEN` | whiteboard | 白板鉴权 |

`TEAM_HUB_TOKEN` 是唯一被多进程共享的密钥，也是唯一有跨进程一致性要求的：

- team-hub 用它校验请求；
- workbench 用它调 hub 读接口（P2-2 权限模型）；
- board-plugin 用它取看板数据；
- services-plugin 在 spawn 子进程时把它**注入**给 team-hub 与 workbench。

`services-plugin/config-schema.mjs` 记的优先级是
**`composition.config.teamHubToken` > 环境变量 > 空**。
「空」是合法值（表示不鉴权），这正是本地开发默认能直接跑起来的原因——
但也意味着**忘了配 token 不会有任何报错**，只是鉴权静默关闭。

### 3.2 明文落盘：仓库内 **0 处**；但 DSH_HOME 下有 1 处

**仓库扫描结果：没有任何明文凭证文件被跟踪。**

被检查的模式包括 `.credentials*`、`.env`、`.env.*`、`credentials.{json,yaml}`、
`secrets.{json,yaml}`；测试夹具（`scripts/config/fixtures/good.env` / `bad.env`）
被显式排除——它们是**故意构造的样例**，不是真实凭证。

**但清单只扫仓库，而模型凭证不在仓库里。** 实测 `$DSH_HOME`（`~/.dsh`）布局：

| 路径 | 内容 |
| --- | --- |
| `.credentials.yaml` | **凭证存储**：顶层键 `version` / `refs` / `records` |
| `settings.yaml` | 产品设置 |
| `profiles/` | DSH profile（含 `node_modules` 与组合层） |
| `.agent-presets/` | 各 agent preset |
| `sessions/`、`attachments/`、`skills/`、`storages/`、`kb-recall/` | 会话、附件、技能、存储 |
| `super-injector/` | 守护日志 |

两条结论：

1. **`secretRef` 机制已经存在**，不必重新发明。`.credentials.yaml` 是
   `refs` → `records` 的引用式存储，正是 spec §6.7 与 `runtime/contracts/model.mjs`
   的 `ModelProfile.secretRef` 所指的东西。PRT-505 应**复用**它，把
   「token 只经 `secretRef`」作为硬约束，而不是另建一套密钥库。
2. **它落在 `$DSH_HOME`，不在安装目录内**——位置是对的。这反过来说明
   PRT-001 §2.1 那四项目录越界（`TEAM_HUB_DB` 等）是**产品自己**的默认值问题，
   不是 DSH 的：同一个 DSH_HOME 布局里，模型凭证的位置是恰当的。

> 本清单的 `plaintextOnDisk` 字段**只覆盖仓库**，这是有意的：清单会进版本库，
> 而 DSH_HOME 是机器本地路径。上表由人工核对写入手读文档，`findPlaintextCredentials()`
> 不扫描 DSH_HOME，避免把机器本地状态混进可 diff 的基线。

因此 PRT-505 的迁移输入中，**「明文密钥落盘」这一项当前为空**。
这不代表以后不会有：`services-plugin` 的 token 优先级允许把 token 写进
composition `config`，而 composition 是 YAML 文件（实测该字段当前为空串，见 PRT-010 §2.4）。
PRT-505 落地时应把「token 只经 `secretRef`，不得写进 composition 正文」作为硬约束，
并复用 `runtime/contracts/model.mjs` 的 `findPlaintextSecrets()` 做写入路径门禁
（该函数已能识别字段名形态、密钥值形态与 URL 内嵌凭证三类）。

### 3.3 跨进程一致性风险

`TEAM_HUB_TOKEN` 的四个持有者靠**各自的环境变量**取值，没有单一真相源。
`services-plugin` 会把同一个值注入给它启动的两个进程，但：

- `board-plugin` 由宿主加载，**不经过 services-plugin**，需宿主另行注入；
- 手动启动 team-hub / workbench 时，两者可能拿到不同的值。

表现是「配置看起来对，但部分接口 401」。`docs/CONFIG.md` 已记录三进程字段清单，
PRT-505 应考虑把 token 收敛到单一来源（`secretRef` + 启动时解析），
而不是四个进程各自读环境变量。

---

## 4. 读取点扫描的口径

复用 `scripts/config/scan.mjs`（**不重写第二份 env 正则**）。

> 为什么必须复用：若本工具自带一份实现，两份会漂移，漂移的表现是
> **「本清单说没有缺口、`scan --check` 说有缺口」——两份都不可信**。
> 「哪些 env 被真实读取」只应有一个权威实现。

该扫描器已处理的两个真实陷阱（记录在它的注释里，此处不重复实现）：

1. **注释里的 `process.env.X` 不算读取点**——P3-4 实测 `plugins/src/config.ts`
   注释中那句 `Number(process.env.X || 默认值)` 曾让主检出多出未声明键 `X`。
2. **必须按字符状态机剥离注释，不能 `text.replace(/\/\/.*$/gm,'')`**——仓库里到处是
   `'http://127.0.0.1:8787'` 这类字面量，粗暴替换会把**同一行后面的真实读取
   一起吃掉**（假阴性比假阳性更危险）。

---

## 5. 复现

```bash
node scripts/config/scan.mjs --check                        # 声明缺口门禁
node scripts/config/check.mjs --process=team-hub            # 单进程配置面
node scripts/prt/topology-inventory.mjs --record            # 刷新清单
node --test scripts/prt/topology-inventory.test.mjs
```

---

## 6. 已知未覆盖

- **未逐项核对默认值与 `docs/CONFIG.md` 的一致性**。本清单取 Schema 的
  `default`，文档另有表述；两者不一致时以 Schema 为准（它是运行期实际生效的）。
- **未采集真实部署的配置快照**。清单是**声明面**，不是「某台机器上实际设了什么」。
  后者属部署验证，PRT-009 的进程采样只覆盖了就绪耗时。
- **未覆盖 composition 正文中的配置**。`services-plugin` 的 `config.teamHubToken`
  等来自 DSH composition，其解析与分层属 PRT-010。
