# PRT-257 / PRT-254：密钥库自检接进启动流程

> 结论：`product/launcher/secrets-check.mjs` 把 PRT-254 的 `openProductSecrets`
> 接到 `preflight()` 上；同时补上了一个**空了一截的接线**——ACL 检查在生产里
> 从来没有 runner，于是整套 PRT-509 实现每次真实检查都只说"没查过"。
> 新增 26 例相关用例，全部门禁通过。

---

## 1. 这次要解决的问题

PRT-254 的文档把这样一条记成"未交付"：

> Launcher 还没有调用 `openProductSecrets`。

**线的一端还没插上。** 本次把它插上，并且顺带发现了线**中间**的问题（见 §4）。

---

## 2. 核心判断：什么该**阻止启动**，什么只该**提醒**

这条分界很容易搞错，而两种错法的代价**不对称**：

- 该阻止却只提醒 → 启动成功，然后"静默地不安全"（明文写密钥、密钥进备份）
- 该提醒却阻止 → **用户被锁在门外**：他正是要打开界面去修这个问题，而界面起不来了

所以判据是：

> **阻止启动的，是"启动本身会制造新的危险"；
> 只提醒的，是"现在就不工作"——那不该阻止启动，
> 因为修它的地方（Workbench）也在被启动的东西里。**

按这条分界：

| 情况 | 等级 | 为什么 |
| --- | --- | --- |
| 明文后端 | **error** | 启动后任何一次录入都会把密钥**明文写盘**——危险是启动制造的 |
| 密钥库落在 DataDir/InstallDir/CacheDir | **error** | 结构性：备份会带走它、升级会替换它、缓存清理会删掉它 |
| 打不开（损坏/读不到） | warn | 现在不工作，但**不制造新危险**；用户需要界面去修 |
| ACL 过宽 | warn | 危险是**已经存在**的，不是启动制造的；且修它需要先能起来 |
| ACL 查不出来 | warn | 同上 |
| 平台不支持受保护存储 | warn | 这台机器上云模型用不了，但产品本身该能起 |
| 文件还没创建 | **无告警** | 见 §3 |

排期上，密钥库自检排在**端口检查之后**：端口冲突是"起不来"，
而密钥库的问题里只有两类是"不许起"——先报更硬的那个。

---

## 3. 新装机器上"永远不对的告警"

密钥库文件要到**第一次写入密钥**时才存在。所以全新安装上启动自检**永远**
会碰到"文件不存在"。

第一版实现把它归成了 `ACL_UNVERIFIABLE`，于是：

```
[warn] SECRETS_ACL_UNVERIFIABLE：密钥库文件访问控制未验证：icacls 返回 1 且无输出
       （文件可能不存在或不可读）。**未验证**不等于通过。
```

它**说得不对**——没有文件，就没有暴露面。而这条告警会在每一台新机器的
每一次启动上出现。按本项目已经记过的那条：

> **一条永远不对的告警，和没有告警，是同一件事。**

用户会学会忽略它；于是当文件**真的**变得可被别的账户读到时，
那一条同样被忽略。

所以 `ACL_CODES` 里新增了独立的状态：

```js
NOT_CREATED: 'ACL_NOT_CREATED'
```

它与 `UNVERIFIABLE` 的关系：

| | `ok` | 含义 | 启动告警 |
| --- | --- | --- | --- |
| `ACL_NOT_CREATED` | `false` | 还没有文件，**没什么可保护的** | 无 |
| `ACL_UNVERIFIABLE` | `false` | 文件在，但**不知道它安不安全** | **有** |

**两者都是 `ok: false`**——"还没有文件"同样不等于"检查通过"。
区别只在调用方怎么处理，而这条区别被 `aclExists` 显式带出去：

```js
aclVerified: acl.code === 'ACL_OK',
aclExists:   acl.code !== 'ACL_NOT_CREATED',   // false 有**两种**原因，必须能分开
```

---

## 4. 更严重的问题：整套 ACL 检查在生产里是**死代码**

把自检接上之后，真实链路冒烟给出的第一条输出是：

```
[warn] SECRETS_ACL_UNVERIFIABLE：…没有 icacls runner，无法确认访问控制…
```

**`inspectFileAcl` 在没有 runner 时如实报 `ACL_NO_RUNNER`——那是对的。**
问题在于：`product/secrets.mjs` 写的是 `run: run ?? undefined`，
而**没有任何生产代码会传 `run`**。

于是 PRT-509 的整套实现、22 条用例、文档全都在，
而**每一次真实检查都只说"没查过"**。

这是"尚无生产调用方"的**更深一层**：

> 功能有了、接线也有了，**而线中间那一截是空的**。

而且它是**安静地**空的——界面上"未验证"看着很像"已检查过、没问题"。

### 修法

真实 runner 落到 `security/secrets/acl.mjs` 的 `createSystemRunner()`，
由 `product/secrets.mjs` **默认使用**：

```js
const aclRun = run ?? createSystemRunner()
```

用例仍然注入假 runner（不碰真实文件系统与真实 ACL），
而"默认那一条真的会执行"由一条**刻意不传 `run`** 的用例锁住。

### 修完之后的真实输出

在一台真实的 Windows 机器上（临时目录）：

```
文件不存在时 code = ACL_NOT_CREATED | exists = false
文件存在后   code = ACL_TOO_PERMISSIVE | offenders =
  ["Amench\CodexSandboxUsers","S-1-5-21-...-928322546","AMENCH\11150"]
```

**这才是信号。** 它认出了本机沙箱账户，并把它们点了名。

---

## 5. 抓到的问题

| # | 问题 | 怎么发现的 |
| --- | --- | --- |
| ① | 把"文件还没创建"归成"未验证" → 新装机器上永远误报 | 真实链路冒烟（§4 那条输出的前半段） |
| ② | ACL 检查在生产里**没有 runner** → 整套是死代码 | 同上，修 ① 之后才露出来 |
| ③ | `ACL_TOO_PERMISSIVE` 被塌成 `ACL_UNVERIFIABLE` | 用例"ACL 过宽 → warn"当场变红 |
| ④ | 自检整个崩了时多叠一条"ACL 未验证"（噪音稀释真信息） | 用例"自检本身抛异常"断言"恰好一条"变红 |
| ⑤ | `createSystemRunner` 没从 `security/secrets/index.mjs` 导出 | 模块加载直接报 `does not provide an export` |
| ⑥ | 三条新用例的 plan 阶段没限定范围 → 走到 `ENTRY_UNRESOLVED` | 用例当场变红 |
| ⑦ | 三条新用例用了默认端口 8787 → 走到 `PORT_IN_USE` | 用例当场变红 |

⑥⑦ 值得单记：它们**不是产品缺陷，是用例没搭好台**。
但两者的表现都是"密钥库那段代码没被执行到"，与 ② 的现象一模一样。
**"没走到那一步"和"那一步是对的"，在输出上完全一样**——所以用例必须
让前置条件成立，否则它会以"通过"的样子掩盖一个空调用。

---

## 6. 变红验证

每一条判断都用"改坏它 → 必须变红"验过：

```
基线 fail = 0
✔ 变红  fail=2  明文后端降级为 warn（启动后静默地把密钥明文写盘）
✔ 变红  fail=3  密钥库位置不合法降级为 warn（结构性问题被放过）
✔ 变红  fail=4  打不开升级为 error（用户被锁在门外，连修的地方都进不去）
✔ 变红  fail=2  ACL 过宽被塌成"未验证"（已确认的越权看起来像没查到）
✔ 变红  fail=3  ACL 状态不报（"没查过"静默地看起来像"是安全的"）
✔ 变红  fail=3  preflight 完全不做密钥库自检（PRT-257 的接线被拔掉）
✔ 变红  fail=3  把 NOT_CREATED 塌成 UNVERIFIABLE（永远误报）
✔ 变红  fail=1  ACL 默认没有真实 runner（整套检查在生产里永远只说"没查过"）
✔ 变红  fail=2  把"文件在、而且很宽"也静默掉（真实的越权被放过）
```

最后一条的两个方向都要红：**新装机器上安静**（不误报）
与**文件真在且很宽时出声**（不漏报）是**两条相反**的断言，
少了任何一条，另一个方向就会在下次改动里悄悄失守。

---

## 7. 未交付

- **`owner` 仍然没有来源。** `hardenFileAcl` 需要显式 `owner`，而启动路径
  拿不到它（`product/secrets.mjs` 刻意不读 `process.env`，也不猜主体）。
  后果：**加固默认不发生**。真实输出里 `offenders` 包含 `AMENCH\11150`
  （就是当前用户）正说明了这一点——没有 owner，真所有者也会被算成越权主体。
  这是 fail closed 方向（不会漏报），但会让"越权"提示变成常驻噪音。
  下一步要么由 Launcher 显式取一次 `whoami`（并把它当作**用户输入**校验），
  要么改判据让"所有者是谁"由 `icacls` 的另一种形式给出。
- **密钥库文件的并发写没有保护**（Launcher 与 worker 的读-改-写）。
- **跨机器复制没有防护**（DPAPI 绑机器，但文件本身可以带走）。
- **`LEGION_SECRETS_FILE` 指向网络盘未被检查。**
- **`count` 用的是无界 `store.list()`。**
- **与 `$DSH_HOME/.credentials.yaml` 的关系仍未定**——spec 附录 A.2 要求复用，
  需要一次产品决策（见 `PRT-509-file-acl-hardening.md` §9）。
- **"一键启动"端到端仍未验证过**（缺 `runtime.command`，plan 阶段即失败）。

---

## 8. 复跑方式

```bash
node --test product/launcher/secrets-check.test.mjs    # 17 例
node --test product/secrets.test.mjs                   # 25 例
node --test security/secrets/acl.test.mjs              # 26 例
node --test product/launcher/launcher.test.mjs         # 15 例（含 4 条接线用例）
node scripts/ci/run-ci.mjs --only test                 # 全套
```
