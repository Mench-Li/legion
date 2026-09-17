# PRT-509 路线 A′：DSH 凭证文件的**只读**读桥

状态：已交付（实现 + 用例 + 本文档）。
本文件回答的是 `PRT-509-file-acl-hardening.md` §9 里那条被明确升级的问题：
「两个密钥库并存，没有与 `$DSH_HOME/.credentials.yaml` 对账」。

---

## 0. 一句话

**Legion 的 DPAPI 密钥库仍然是唯一的权威写入路径；DSH 的
`$DSH_HOME/.credentials.yaml` 被当作一个只读回退来源接在后面，只认 DSH
自己写出的那个确切子集，其余整份拒绝，并且每一次解析都说得清是哪一边回答的。**

没有写回、没有迁移、没有同步、没有猜。

---

## 1. 为什么是"只读回退"，不是"复用"，也不是"迁移"

spec 附录 A.2 第 2 条写着「`PRT-505` 应**复用它，不要另建密钥库**」。
`PRT-509-file-acl-hardening.md` §9 记下了这句话与既有实现之间的真实张力，
并给出两条候选路线。本批选的是**路线 A 的一个收紧形态（A′）**，理由是：

| 方案 | 为什么不选 / 为什么选 |
| --- | --- |
| B：一次性迁移进 DPAPI | 迁移之后两个文件不再同步；而"迁移过一次"这件事本身没有地方可查。更根本的是：**它会改写 DSH 的文件**，而那个文件的所有者是另一个程序 |
| A：让 DSH 文件成为**写**路径之一（真复用） | 保护等级从 DPAPI 降到明文（那个文件里 `refs:` 的值就是明文）。这正好是 PRT-509 要防的事 |
| **A′：只读回退，Legion 库优先**（选它） | 已经配好的 DSH 凭证不必重录；同时**保护等级没有下降**——回退只在"Legion 库里没有这条"时发生，从不覆盖一条已有的受保护记录 |

### 为什么"回退"这件事必须有出处

两个来源都能回答、而结果不带出处，就是"我轮换的那把钥匙没生效"的起点：
用户在 Legion 里换掉了值，运行却仍然拿着 DSH 文件里的旧值，而**一切看起来都正常**。

所以解析的返回值带 `source`：

| `source` | 含义 |
| --- | --- |
| `legion-store` | Legion 自己的 DPAPI 库回答的（第一顺位） |
| `dsh-credentials-file` | DSH 的文件回答的（只在库里没有这条时） |

### 优先级（被用例钉住，不是"实现细节"）

```
① 引用名为空 / 未给出  →  null（本地模型，不需要凭证；两个来源都不碰）
② Legion 的库里有这条  →  用它，**一次都不去问回退来源**
③ 库里"没有这条"        →  问回退来源
④ 库里"有这条但取不出来" →  **不回退**，报 SECRET_DECRYPT_FAILED
⑤ 两个来源都没有        →  仍然是那一条 SECRET_NOT_FOUND
```

**③ 与 ④ 的分界是这一整套里最重要的一条。** 只有 `SECRET_NOT_FOUND`
才回退。"解不开"（换了 Windows 账户）、"库坏了"、"引用名非法"都**不**回退
——那不是"没有"，那是"有但取不出来"，而回退等于把保护等级从 DPAPI
**静默**降到明文。用户换了账户之后应该看到"解不开"，而不是"从别处读到了一把旧钥匙"。

用例：`runtime/probe/secret-resolver.test.mjs` ⑦ 组的
「库里"解不开"时**不**回退」，断言 `asked === 0`。

---

## 2. 认识的确切子集（**必须逐字**）

这一节就是"DSH 自己写出来的形状"。判据不是"YAML 支持什么"，
而是"`Document.toString()` 会输出什么"（实测：`probe-dsh-scalars.mjs`）。

### 2.1 文件层

| 形状 | 判定 |
| --- | --- |
| 空文件 / 只有注释与空行 | **接受**，空库 |
| CRLF 行尾 | **接受**（Windows 上的常态） |
| 孤立 CR（`\r` 后面不是 `\n`） | 拒绝 `UNSAFE_CHARACTER` |
| 单文件 > 1 MiB | 拒绝 `TOO_LARGE` |
| 制表符（**任何位置**） | 拒绝 `TAB_INDENT` |
| 缩进不是 2 的倍数 | 拒绝 `BAD_INDENT` |
| 缩进是 4 空格（合法 YAML，但不是 DSH 写出来的形状） | 拒绝 `BAD_INDENT` |

### 2.2 结构

```yaml
version: 1                      # 必须存在、必须是数字 1（1.0 也算，因为 1.0 == 1）
refs:                           # 可选；POSIX 标识符 → 非空字符串
  DEEPSEEK_API_KEY: sk-...
records:                        # 可选；<scope>/<id> → 带 tag 的记录
  deepseek/main:
    kind: api-key               # api-key: key?/env? 都可以省略
    key: sk-...
    env:
      DEEPSEEK_API_KEY: sk-...
  legion/g:
    kind: grant
    payload:                    # 必填，任意 JSON 值（映射/序列/标量/null）
      a: 1
```

| 约束 | 依据 |
| --- | --- |
| 根必须是映射；**一行 `~` / `null` 例外**（DSH 用 `?? {}` 兜住） | DSH `parseCredentialsDocument` |
| 顶层键**恰好**允许 `version` / `refs` / `records` | 同上 |
| `version` 必须是数字 `1` | `DOCUMENT_VERSION = 1` |
| 非空文档缺 `version` → 拒绝（**不**当空库） | 那是 pre-release 的扁平布局 |
| `refs` 键：`/^[A-Za-z_][A-Za-z0-9_]*$/` | DSH `REF_PATTERN` |
| `refs` 值：必须是非空字符串 | DSH `parseCredentialsDocument` |
| `records` 键：**恰好两段**，每段 `/^[a-z][a-z0-9-]*$/` | DSH `parseCredentialKey` + `KEY_SEGMENT_PATTERN` |
| `api-key`：只允许 `kind`/`key`/`env`；`key` 与 `env` 都可省略 | DSH 记录文法 |
| `env` 名：`REF_PATTERN`；`env` 值：非空字符串 | 同上 |
| `grant`：只允许 `kind`/`payload`；`payload` **必填** | 同上 |
| 重复键（任何一层） | 拒绝 `DUPLICATE_KEY`（DSH 用 `uniqueKeys: true`，解析器直接报错） |

### 2.3 标量

- 只接受**单行普通标量**。
- 首字符必须是 `[A-Za-z0-9._~+=/]` 之一。YAML 的 c-indicator
  （`- ? : , [ ] { } # & * ! | > ' " % @ \``）在首位会改变这一行的**结构**
  （而不只是值），所以一个都不允许打头。
- 其余字符允许 `[A-Za-z0-9._+\-/=~:@,# ]`（**空格是内容**：`a  b` 就是两个空格）。
- 首尾空白按 YAML 规则折掉。
- 按 **YAML 1.2 core** 分类：`~`/`null`/`true`/`false`/整数/浮点数被识别为
  非字符串类型（于是 `refs` 的值若是它们 → `REF_VALUE_NOT_STRING`）；
  其余一律当字符串。
  - 于是 `yes` / `no` / `on` / `off` / `y` / `n` / `1_000` / `2026-01-01` /
    `.x` / `=x` / `+x` / `abc:def` / `a#b` / `a,b` / `a[b` / `x\y`
    **都是字符串**（与 YAML 1.2 core 一致，DSH 也这么读）。
  - 而 `42` / `1.5` / `1e3` / `0x1f` / `0o17` / `true` / `null` / `~` /
    `.inf` / `.nan` / `{}` / `[]` **不是字符串** → 拒绝。
- 行内注释：`#` 前面是空格（或行首）时才是注释起点。`A: sk-x # rotated`
  的值是 `sk-x`。反过来 `a#b` 是一个完整标量。

---

## 3. 拒绝清单（fail closed）

**任何一份不在上面那个子集内的文件都被整份拒绝** —— 不是跳过那一行、
不是截断、不是近似理解。文件里只有凭证：猜错一个标量不是"少读一条"，
是"读出一个用户没存进去的值"，而它会被拿去发一次真实的请求。

> 一个猜错的凭证解析器与一个正确的凭证解析器，
> 在返回值上完全一样，直到那把钥匙属于别人。

40 个具名拒绝码（`DSH_CREDENTIALS_CODES`），全部以
`DSH_CREDENTIALS_` 开头、全部映射到对外的 `SECRET_UNAVAILABLE`：

| 层 | 码 |
| --- | --- |
| 文件 | `UNREADABLE` `TOO_LARGE` |
| 词法 | `TAB_INDENT` `BAD_INDENT` `DIRECTIVE` `DOCUMENT_MARKER` `ANCHOR` `ALIAS` `TAG` `BLOCK_SCALAR` `FLOW_STYLE` `QUOTED_SCALAR` `UNSAFE_CHARACTER` `BAD_ENTRY` `INLINE_MAPPING` `MIXED_BLOCK` `DUPLICATE_KEY` `TRAILING_CONTENT` |
| 结构 | `ROOT_NOT_MAPPING` `ROOT_IS_SEQUENCE` `NO_VERSION` `BAD_VERSION` `UNKNOWN_TOP_KEY` `SECTION_NOT_MAPPING` `REF_KEY_INVALID` `REF_VALUE_MISSING` `REF_VALUE_NOT_STRING` `RECORD_KEY_INVALID` `RECORD_NOT_MAPPING` `RECORD_NO_KIND` `RECORD_UNKNOWN_KIND` `RECORD_UNKNOWN_FIELD` `GRANT_PAYLOAD_MISSING` `API_KEY_VALUE_INVALID` `ENV_NOT_MAPPING` `ENV_NAME_INVALID` `ENV_VALUE_INVALID` `PAYLOAD_NOT_JSON` |
| 寻址 | `RECORD_NOT_A_STRING` `RECORD_VALUE_AMBIGUOUS` |

**为什么码要这么细。** 一个笼统的"解析失败"会让
「换一种写法就好了」与「这个文件根本不是 DSH 写的」看起来一模一样。
**从句法上就说得出口的那一类**必须说得出口——否则用户只能靠猜。
逐码共用一段处置文案（`DSH_CREDENTIALS_HINT`），因为处置是同一件事：
改文件写法，或把值录进 Legion 自己的库。

**"寻址"那两个不是解析错误**，是"这一条存在、但它读不出一把字符串钥匙"：

- `RECORD_NOT_A_STRING`：`grant` 记录的 `payload` 是一个 JSON 值。把 JSON
  序列化成字符串当凭证用，等于给供应商发一段 JSON —— 那不是猜，那是编。
- `RECORD_VALUE_AMBIGUOUS`：`api-key` 既没有 `key`、`env` 又不恰好一条。
  **挑一条（比如字典序第一条）就是编一个用户没选过的凭证。**

---

## 4. 四个读数**不得**被塌成一个值

这是本批最容易做错、而错了之后最难发现的地方。读取器把"读不出一个值"
拆成四种互不相等的读数：

| 读数 | 何时 | `get()` | `explain().reason` |
| --- | --- | --- | --- |
| 文件**不在** | `DSH_HOME` 指到一个没有 `.credentials.yaml` 的目录 | `null` | `no-file` |
| 文件在、**读不出来** | 权限 / 磁盘 / 句柄 | 抛 `DSH_CREDENTIALS_UNREADABLE` | 抛 |
| 文件在、**读不懂** | 不在上面那个子集内 | 抛那个具名解析码 | 抛 |
| 文件里**没有这一条** | 解析成功、查不到 | `null` | `absent` |
| 这条**不可寻址** | Legion 引用名在 DSH 里不可能存在 | `null` | `not-addressable` |

`inspect()` 给文件层的四态：`absent` / `loaded` / `unrecognized` / `unreadable`。

- **"没接过"与"接了但文件不在"也是两件事**：前者 `inspect()` 根本不会被调，
  `openProductSecrets` 返回 `fallback: null`；后者返回 `{state:'absent'}`
  （`product/secrets.test.mjs` ⑦ 第一条）。
- **`unrecognized` 与 `unreadable` 必须不同码**，理由与 ACL 那一对
  （`ACL_TOO_PERMISSIVE` / `ACL_VERIFIABLE`）逐字同构：一个要用户去改文件
  写法，一个要用户去查权限/磁盘。塌成一个，用户会去查一个并不存在的权限问题。
- **`not-addressable` 与 `absent` 必须不同**：把前者说成后者，用户会去 DSH 里
  找一个**不可能存在**的记录。

### 启动诊断

| `state` | 诊断 | 为什么 |
| --- | --- | --- |
| `absent` | **无** | 从没用过 DSH 的 Models 页时就是这个形状，是常态 |
| `loaded` | **无** | 读得懂就没什么可说的 |
| `unrecognized` | `warn` | 文件在、要用户动手 |
| `unreadable` | `warn` | 文件在、要用户动手 |

两种都是 **warn，绝不 error**：回退来源是**附带的便利**，Legion 自己的库
仍然是唯一权威的写入路径，也是第一顺位。把它判成 error 会让一个附属功能
把用户锁在门外——而他正是要打开界面去修这个问题。

同理，`absent` 不能报成告警：那会在**每一台**没用过 DSH 的机器上、
**每一次**启动时出现，而它每次都说得不对。
（一条永远不对的告警，与没有告警，是同一件事。）

---

## 5. 诊断里没有值

- 错误只带 **code、key 名、行号**；不带值、不带路径、不带源码片段。
  DSH 自己的 `describeYamlError` 也是这个纪律（只留 code 与行列号，
  因为那一行就是密钥）。
- 读取器**刻意不接文件名参数**：Legion 的密钥诊断不带路径
  （路径里可能出现账户名），而这一层的错误会被显示、被导出、被附进工单。
  它给的是行号。DSH 自己会打印文件名，本模块不跟。
- 底层 `fs` 错误的 `message` 被丢掉，只保留 `errno`（`EACCES` 这类）。
- `inspect()`/`explain()`/`describe()` 的输出里没有值——
  `product/secrets.test.mjs` ⑦ 用 `sk-from-dsh-file-DO-NOT-LEAK` 在
  **真文件**上验过一遍。
- `onResolve` 回调收到的仍然只有元数据（外加 `source`）。

---

## 6. 模块位置与"谁来读 `DSH_HOME`"

### 6.1 读取器放在 `security/secrets/dsh-credentials.mjs`

理由是它属于**密钥层**：

- 它只读一份凭证文档，失败码是密钥库失败码（`SecretStoreError`）；
- 它的规矩是密钥层的规矩（fail closed、不猜、诊断里没有值）；
- 放进 `runtime/` 会让"哪一种文件算凭证库"这件事分散到两个平面。

### 6.2 诚实边界：`security/` **不是**被扫描的进程

`scripts/config/scan.mjs` 的 `PROCESSES` 只有
team-hub / workbench / whiteboard / plugins / board-plugin / services-plugin /
product / orchestrator；`scripts/config/check.mjs` 的 `SCHEMA_FILES` 也没有
`security/` 这一项。

后果要说清楚：

- `security/secrets/dsh-credentials.mjs` 里那 40 个 SCREAMING_SNAKE_CASE
  字面量**不会**被 `scan --check` 检查是否登记到 `nonEnvLiterals`；
- **`runtime/` 也一样不被扫描**（只有 `runtime/probe` 之下的 `secret-resolver.mjs`
  会因为我改了它而受 `product` 那一侧的字面量规则间接影响吗？不会——
  `runtime/` 根本不在 `PROCESSES` 里）。
- 也就是说：**这个新模块逃避了一条本项目对 `product/` 与 `team-hub/`
  强制执行的纪律。** 这是选择 `security/` 的真实代价，不是"没有影响"。
- 缓解措施只有一条，而且是弱的：本模块的字面量全部集中在
  `DSH_CREDENTIALS_CODES` 一个 frozen 对象里，`dsh-credentials.test.mjs`
  有一条用例断言它们是 40 个互不重复、且都带 `DSH_CREDENTIALS_` 前缀的值。
  这**不等于** `scan --check` 的覆盖。
- 我**没有**改 `scan.mjs` 或 `check.mjs` 去把 `security/` 纳入扫描：
  那会改变全仓库的配置面判定，属于另一个批次的范围。

### 6.3 `DSH_HOME` 只在 Launcher CLI 读一次

`DSH_HOME` 此前在 Legion 的产品代码里**一次都没被读过**——它只是
`product/config-schema.mjs` 的 `CHILD_ENV_NAMES` 里一个"注入给子进程的变量名"。

路线 A′ 让 `product/launcher/cli.mjs` 的 `dshCredentialsFileFrom(env)` 成为
**唯一**的读取点（与既有的 `osHomeFacts(env)` 同一处纪律：产品代码只在这一层
碰操作系统/宿主的家目录事实），然后：

```
cli.mjs  --dshCredentialsFile-->  launcher options
         --dshCredentialsFile-->  createLauncher({dshCredentialsFile})
         --dshCredentialsFile-->  runSecretsCheck({dshCredentialsFile})
         --dshCredentialsFile-->  openProductSecrets({dshCredentialsFile})
         --fallback source----->  createSecretResolver({fallback})
```

- `DSH_HOME` 已设 → `join(DSH_HOME, '.credentials.yaml')`；
- `DSH_HOME` 未设，或 `--no-dsh-credentials` → `null` = 不接。

**不猜路径**：不因为 `USERPROFILE`/`HOME` 存在就去翻 `~/.dsh`。
猜路径会读完**另一个账户**留下的、当前用户并不知道存在的凭证文件。
（用例：`product/launcher/cli.test.mjs` 的「DSH_HOME 决定回退来源的路径；
未设就是 null（不猜路径）」。）

**`--no-dsh-credentials` 是刻意的**：读一个属于另一个程序的、里面全是明文的
文件，应当是一个可以被拒绝的动作。

**`DSH_HOME` 同时登记进了 `product/config-schema.mjs` 的 `foreignEnv`**，
不只留在 `CHILD_ENV_NAMES` 里——那一份的理由写着"本进程从不读它们"，
而这句话现在不成立了。`scan --check` 只看字面量有没有登记、看不出理由漂了没有，
所以理由必须挪到看得见的地方。

### 6.4 `team-hub` **故意不动**

`team-hub/probe-service.mjs` 与 `team-hub/server.mjs` 也调用
`openProductSecrets`，但它们没有 `DSH_HOME` 的来源，而且
`scripts/ci/dsh-boundary.mjs` 的执行面基线不接受新的 DSH 耦合。
它们走缺省（`dshCredentialsFile: null`）→ 不接回退来源 → 行为与这一批之前逐字相同。

---

## 7. 与 DSH 自己的解析器交叉核对（**本次运行了**）

`security/secrets/dsh-credentials.test.mjs` 的第 ⑥ 组会把同一批夹具
喂给 **DSH 真实的** `parseCredentialsDocument`
（`packages/credentials/credentials-local/lib/index.js`），并且：

1. **本读取器接受的 ⇒ DSH 一定也接受，且解析结果逐字段相同**
   （子集关系被逐条验证，不是声明）；
2. 拒绝清单里每一条都标注了 DSH 是 `refuse` 还是 `accept`，并**逐条断言**；
3. 有一份**"我们拒绝、DSH 接受"的从严清单**，被逐字钉住——
   清单变了就红，那是要人来看的信号。

**本次是否运行：运行了。** 触发条件是环境变量
`DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'`；本机该检出存在且
`credentials-local/lib/index.js` 已构建，因此 ⑥ 组 164 例全部真跑，
`skipped 0`。没有配置 `DSH_CHECKOUT` 时 ⑥ 组**逐条 skip** 并留下一条
说明用的通过用例（跑不了就不算跑过，不伪造通过）。

### 从严清单（夹具实测，共 15 条）

这些是 **Legion 拒绝、DSH 接受** 的形状。它们全部是 YAML 的词法/缩进特性，
没有一条涉及文件的结构语义：

1. `refs` 段的键被引号包住
2. 制表符出现在注释行里
3. 缩进不是 2 的倍数
4. 缩进 4（不是 DSH 写出来的那种）
5. 值以 c-indicator 开头（`A: -x`）
6. 文档指令 `%YAML`
7. 文档开始标记 `---`
8. 文档结束标记 `...`
9. 锚点 `&`
10. 标签 `!!str`
11. 多行标量（字面块 `|`）
12. 多行标量（折叠块 `>`）
13. 单引号标量
14. 双引号标量
15. 序列项从行内开始一个映射（`- k: v`）

**这份清单是"夹具里被实测到的那些"，不是"存在差异的所有形状"。**
第 5 条是一个**类别**的样本：`- ? : , @` 等 c-indicator 开头的标量在 YAML 里
仍是普通标量（DSH 会读成字符串），而本读取器一律拒绝。逐一把它们列成夹具
只会让表变长、不会让边界变清楚——**完整的边界是规则**（§2.3 的首字符集合），
夹具只是它的抽样。★ 那条用例断言的是"**这一批夹具里**我们拒绝、DSH 接受的
集合恰好是这 15 个名字"：夹具表动了它就红。

**为什么刻意从严。** 每一条都要求读取器判断"这个符号到底是内容还是结构"，
而判错的方向是**读出一个错误的值**（不是"少读一条"）。第 2 条（注释行里的
制表符）是最能说明问题的一条：DSH 只在**缩进位**报 `TAB_AS_INDENT`，
于是 `\t# 注释` 这一行 DSH 接受、我拒绝——我为此放弃了一点点精确性，
换来的是一条不需要证明的规则（"制表符在任何位置都拒绝"）。

**方向性保证。** 这条边界只可能是"我们更严"，不可能反过来：
如果哪一天出现"本读取器接受、DSH 拒绝"，⑥ 组第 1 条会红。

### 漂移风险（诚实说）

本读取器是**手写的**（零第三方依赖，不能 import DSH 的 `yaml`），
而 DSH 用 `yaml` 包。**DSH 一旦扩写它写出的子集，这里必须跟着改**，
否则一份新的合法文件会被整份拒绝（fail closed：会坏，但不会读错）。
⑥ 组是唯一能发现这件事的东西，而它要求本机的 DSH 检出**已构建**
（`lib/index.js` 存在）。在没配 `DSH_CHECKOUT` 的机器上，这个漂移
**不会被发现**。

---

## 8. 诚实边界

1. **本模块只覆盖 DSH 写出的那个子集。** 它不是 YAML 解析器，
   也不打算成为。DSH 换个写法（哪怕仍然合法）就会整份拒绝。
2. **`security/` 与 `runtime/` 都不在 `scan.mjs` 的进程清单里**（§6.2），
   所以这个新模块的 40 个拒绝码**不受**那条"必须登记进 `nonEnvLiterals`"
   的检查约束。这是真实的覆盖缺口，我没有顺手改 `scan.mjs` 去填它。
3. **`credentialVersionOf` 对 DSH 来源用的是文件 `mtime`。** DSH 不存每条记录的
   时间戳，所以这个"版本"是**过粗**而不是过细：任何一个条目的改动都会让
   所有 DSH 来源的缓存失效。方向是安全的（宁可多探一次）。
   而如果回退来源不提供 `describe()`，版本是 `null` → 缓存**永不命中**。
4. **`records` 里 `env` 恰好一条时用它。** 这是本批做的一个**判断**，
   不是从 DSH 抄来的：DSH 不定义"一个 api-key 记录该解析出哪个字符串"，
   它的消费方（LLM 适配器）按 `env` 名去取。我选了"恰好一条时唯一确定，
   多条则拒绝"，因为另一个选项（挑一条）会编出一个用户没选过的凭证。
   **这个选择值得被 review。**
5. **`version: 1.0` 被接受**（因为 YAML 里 `1.0 == 1`，DSH 也接受）。
   这是刻意的对齐，不是疏忽。
6. **`ROOT_IS_SEQUENCE` 与 `ROOT_NOT_MAPPING` 分开**：DSH 对两者都报
   `must be a mapping`（一次 `TypeError`）。我拆成两条，因为"根是序列"
   通常意味着**指错了文件**（比如指到了一个 `cordis.yml`），而"根是标量"
   意味着文件被截断了。两者下一步动作不同。
7. **没有端到端的产品级走查。** 我验的是接线（`launcherOptionsFrom` →
   `createLauncher` → `runSecretsCheck` → `openProductSecrets` → resolver）
   与各层单测，**没有**真的跑一次 `legion --wizard` 去配一个模型、
   让 `$DSH_HOME/.credentials.yaml` 回答一次真实请求。那需要一台配好了
   真实 DSH 凭证的机器，而本批不许碰操作员的真实 `DSH_HOME`。
8. **没有在 Linux/macOS 上跑过。** 本机是 Windows；`security/` 的 ACL 那一半
   按平台分支，本模块本身不按平台分支（只读一个文件），但这一点是推理，
   不是实测。
9. **`DSH_CREDENTIALS_HINT` 的文案是逐码共用的。** 40 个码共用一段处置指引。
   好处是不会漂；代价是它说不出"这一次具体该改哪一行"——那由 `code` 与
   行号回答。
10. **`RUNTIME_CODE_FOR` 没有逐个登记这 40 个码。** 它们走默认分支得到
    `SECRET_UNAVAILABLE`，这正是对的。但这也意味着**将来若有一个 DSH 拒绝码
    不该映射成 `SECRET_UNAVAILABLE`，登记表不会提醒任何人**——
    只有 `DSH_CREDENTIALS_CODE_PREFIX` 那个前缀判断在管这件事。

---

## 9. 我自己不确定 / 猜过的地方

- **§8.4 的 `env` 取值规则**：我选了"恰好一条"，但"多条时挑第一条"或
  "按 profile 里的 `envName` 选"都是合理设计。DSH 没有规定，
  所以我是在**替它决定**。
- **§8.2 的 `security/` 位置**：另一个可选位置是 `runtime/`。
  两者都不被扫描，所以这个选择对 `scan --check` 是中性的；
  选 `security/` 是因为失败码与纪律都属于密钥层。如果 reviewer 认为
  "读别人的文件"更该属于 runtime 的适配面，这是可以搬的。
- **`--no-dsh-credentials` 的默认值**：我做成了"默认读"（只要 `DSH_HOME` 已设）。
  另一个更保守的默认是"默认不读，要显式打开"。选"默认读"是因为 `DSH_HOME`
  已设本身就是用户在用 DSH 的信号；但**如果产品认为读一个明文文件需要
  事前同意，这个默认值要反过来。**
- **1 MiB 的上限**：取值是拍的。凭证文件是几十行的东西，
  这个数字只是为了让"指错了一个巨大文件"以具名码失败，而不是性能考量。
- **行号进错误**：我判断行号不构成泄漏（它不指向内容），但
  `security/secrets/acl.mjs` 里连路径都刻意不带。这是**比既有纪律松一格**的
  一个决定，值得 reviewer 看一眼。

---

## 10. 交付物与怎么自己跑一遍

### 文件

| 文件 | 作用 |
| --- | --- |
| `security/secrets/dsh-credentials.mjs` | **新**：只读子集读取器（纯函数解析 + 文件层来源） |
| `security/secrets/dsh-credentials.test.mjs` | **新**：164 例；含 ⑥ 组与 DSH 真解析器的交叉核对 |
| `security/secrets/errors.mjs` | 加 `DSH_CREDENTIALS_CODE_PREFIX` 与共用的处置文案 |
| `security/secrets/index.mjs` | 导出新模块 |
| `runtime/probe/secret-resolver.mjs` | 加 `fallback` + `resolveCredential()`（带 `source`） |
| `runtime/probe/secret-resolver.test.mjs` | 加 ⑦ 组（回退与出处，13 例） |
| `product/secrets.mjs` | 接 `dshCredentialsFile` / `dshCredentialsIo`，结果加 `fallback` |
| `product/secrets.test.mjs` | 加 ⑦ 组（接线与优先级，9 例） |
| `product/launcher/cli.mjs` | `dshCredentialsFileFrom(env)` + `--no-dsh-credentials` |
| `product/launcher/cli.test.mjs` | 加 2 例（路径解析与显式关闭） |
| `product/launcher/launcher.mjs` | 把路径透传给自检 |
| `product/launcher/secrets-check.mjs` | `fallbackDiagnostic()` + 两条诊断码 |
| `product/launcher/secrets-check.test.mjs` | 加 7 例 |
| `product/config-schema.mjs` | `DSH_HOME` 进 `foreignEnv`；两条诊断码进 `nonEnvLiterals` |
| `docs/superpowers/prt/PRT-509-file-acl-hardening.md` | 更正 §9 的「恰好两段」，加 §9.1 |
| `docs/superpowers/prt/PRT-509-dsh-credentials-read-bridge.md` | **新**：本文档 |

### 命令

```powershell
# 读取器的完整套件（含与 DSH 真解析器的交叉核对）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node --test security/secrets/dsh-credentials.test.mjs

# 不配 DSH_CHECKOUT 时 ⑥ 组逐条 skip（跑不了就不算跑过）
Remove-Item Env:\DSH_CHECKOUT
node --test security/secrets/dsh-credentials.test.mjs

# 受影响的既有套件
node --test "security/secrets/*.test.mjs" "runtime/probe/*.test.mjs" "product/secrets.test.mjs"
node --test product/launcher/cli.test.mjs product/launcher/secrets-check.test.mjs

# 关卡
git add -A
node scripts/config/scan.mjs --check
node scripts/ci/ci-syntax.mjs
node scripts/ci/encoding-check.mjs --all --quiet
node scripts/ci/check-docs.mjs
node scripts/ci/dsh-boundary.mjs --check
```

### 已知的待办（交给集成者）

**已登记（2026-09-17）**：`security/secrets/dsh-credentials.test.mjs` 现在在
`run-ci.mjs` 的 `stageTest().suites` 里（label 为
`dsh-credentials（PRT-509 A′：只读子集读取器 + 与 DSH 真解析器的交叉核对）`），
`套件清单完备` 现在报「**305 个 `*.test.mjs` 全部有归属**」。
原先"刻意没改 `run-ci.mjs`"的那个理由（另一个 agent 正在并发编辑它）已经不成立——
那一批已经合进 `main`。

---

## 11. 缺口 ② 与 ③ 的收口（2026-09-17）

本批把 PRT-509 留下的三个缺口里**两个可动的**关上；第三个（win32 `0600`）原样留着。

### 11.1 缺口 ②：默认分支从「写在模块里」变成「真的有人走过」

`product/launcher/run-credential-materialization.mjs` 里 `productRunCredentialOpener()`
的默认分支（`await import('../secrets.mjs')` + `openProductSecrets(...)`）此前**没有**
任何用例走过：三条注入式用例**全部**传 `openSecrets`。

> 一个"默认实现写在模块里"的分支，与一个"真的有人走过"的分支，
> 在注入式用例上是同一个读数——只不过前者的用例是绿的，
> 而那条 `await import` 从来没有被任何一次运行求值过。

**实测**：把那两行换成一句 `throw`，**19 条仍然全绿、只有新加的那条红**。

新用例（`run-credential-materialization.test.mjs` 里 ★★★ 那条）**不注入任何东西**：
真动态 import、真 `openProductSecrets`、真 `createProductSecretStore`（真 DPAPI + 真 `icacls`）、
真 `openRunCredentials()`。值先按**真实写入路径**写进 Legion 自己的受保护库，再从默认分支读回；
反向对照是"库里没有的引用必须 `held() === false`"（否则它没在读那个库）。
真实 DPAPI 不可用时**显式 skip**，不把"没走到"伪装成绿。

### 11.2 缺口 ③：判据从「我们那个类读得到」挪到「真进程读到了」

原 ★★★★★ 那条是**进程内**的：手工 `new Context()` 再造 DSH 的 `LocalCredentialProvider`。
它排除了"我们自己再解析一遍 YAML"，但**绕过了两样真东西**：

1. **DSH 的 profile 装载。** `--patch` 覆盖层必须在 base bundle 层与 profile 层**之后**
   按 id 命中 `credentials` 那一行；没命中时 DSH 是 **warn-and-skip**，
   而"文件写好了、覆盖层也写好了"在那种情况下**逐字成立**。
2. **`$DSH_HOME` 与启动顺序。** 提供方是在树挂载期装载并首次读文件的。

新增 `product/launcher/run-credential-dsh-process.test.mjs`：真 `apps/cli` 入口、真 profile、
真 `--patch` 覆盖层、真 `dsh-credentials-local`，读数由**挂进那棵树**的探针
（`product/launcher/fixtures/prt509-credentials-probe.mjs`）写回。四条判据：

| 判据 | 它堵的那条假绿 |
| --- | --- |
| `configured === true` | "进程起来了"不等于"读到了" |
| **`source === 'file'`** | 值可能是**继承的环境变量**里来的——那种情况下提供方照样答得出来，而文件根本没被读过 |
| `valueSha256` 相等 | "读到了某个字符串"不等于"读到了材料化时那一把" |
| `otherResolved === false` | 反向对照：Legion 的引用名**不是** DSH 的寻址名 |

**反向对照实测**：把覆盖层换成空补丁表 `[]`，真进程**仍然**起来、探针**仍然**挂上，
而读数是 `{configured:false, source:null, valueSha256:null}`——因为此时 DSH 读的是它自己那份
不存在的 `$DSH_HOME/.credentials.yaml`。这条反例证明用例验的是"覆盖层有没有被这棵树吃进去"，
而不是"DSH 能不能起来"。

探针写的是 **sha256、长度与 `source`，不是值**：一条把密钥写进日志的探针，会在下一次有人贴
日志时变成一次泄漏；而它要回答的问题用 sha256 就答完了。整条用例的值也不入断言。
探针的参数走**组合行的 `config`**（`apply(ctx, config)`）而不是进程环境——否则那把测试的引线
要登记进 `product/config-schema.mjs`，而那份 schema 的用途是"这个产品认哪些环境变量"，
不是"今天哪个夹具需要几个旋钮"。

### 11.3 仍未关的那一条（措辞与理由不变）

`win32 0600 不可证`：`security/secrets/credential-materializer.test.mjs` 里那条**显式 skip**
并写明理由（Windows 上 Node 的 chmod 只影响只读位、`stat().mode` 不反映 POSIX 权限位），
而机制那一半——chmod 在 rename **之前**——在所有平台上都数得出来。
**够不到就说够不到**，不把它算进"已关的三条"里。

### 11.4 怎么自己跑一遍

```bash
# 缺口 ② 的默认分支（要真实 DPAPI；非 Windows/受限环境会显式 skip）
node --test product/launcher/run-credential-materialization.test.mjs

# 缺口 ③ 的真进程（要 DSH_CHECKOUT 且有构建好的 CLI；起一个真宿主约 7–25s）
DSH_CHECKOUT=/path/to/deepseek-harness node --test product/launcher/run-credential-dsh-process.test.mjs
```

两条都已登记进 `scripts/ci/run-ci.mjs` 的 `stageTest().suites`
（前者在 `product-launcher` 那一条的多文件列表里）。

> **与 §8.7 的关系**：那里说"**没有端到端的产品级走查**"（没跑 `legion --wizard`、
> 没让 `$DSH_HOME/.credentials.yaml` 回答一次真实请求）。§11.2 把其中**一半**补上了——
> 现在有一个**真 DSH 进程**在启动期真的读到了材料化的那份文件；
> 但"经向导配置 + 回答一次真实模型请求"仍然**没有**验过，§8.7 那句话依然成立。
