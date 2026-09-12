# PRT-254：per-user 数据目录与 Secret Store 最小闭环

**对应 spec**：§6.7（密钥只经 `secretRef`、按需解析、fail closed）、§6.10（首次运行初始化）、§6.11（产品配置与目录）
**承接**：本文补的是被**连续三份文档**记录为未交付的那个缺口——「**尚无生产调用方**」
**交付物**：
- `product/secrets.mjs` —— 密钥库的**产品接线**（打开 → 保护判定 → ACL → 解析器 → 自检）
- `product/secrets.test.mjs` —— **23 例**
- `product/paths.mjs` —— 新增 `secretsFile` 角色与三条位置诊断
- `product/config-schema.mjs` —— 声明 `LEGION_SECRETS_FILE`

---

## 1. 这一步补的是什么

`security/secrets/`（PRT-505）与 `runtime/probe/secret-resolver.mjs`（PRT-505/509）
都是完整实现、都有用例覆盖，但**没有任何生产代码把它们装起来**。
三份文档的"未交付"里都写着同一句话：

> **尚无生产调用方。**

**一份没人用的密钥库等于没有密钥库。** 本模块是那根线：

```
resolveLayout() → layout.secretsFile → createProductSecretStore → createSecretResolver → 启动自检
```

---

## 2. 决定一：密钥库**不在 DataDir 内**

默认落在 `<产品家目录>/secrets/credentials.json`，与 `dataDir` 是**兄弟**关系。

这不是洁癖，是结构性的。DataDir 是「备份、恢复、诊断包导出、整目录拷贝」
处理的那**一个**目录。密钥库一旦落在里面，任何将来「把 DataDir 打个包」的功能
都会**顺手**把它带出去——而 spec §3.1 明确要求密钥不得进入**导出证据**与**能力包**。

把它放在 DataDir 之外，这类泄漏就从「需要每个人每次都记得」
变成「结构上做不到」：

> **一道看不见某类变化的大门，比没有大门更坏。**
> 反过来也成立：**一道不需要人记住的大门，才真的守得住。**

因此 `product/paths.mjs` 新增三条 `error` 级诊断，把这条口径做成结构化判定：

| 码 | 为什么是错的 |
| --- | --- |
| `SECRETS_INSIDE_DATA_DIR` | 备份/诊断包导出会把它带走 |
| `SECRETS_INSIDE_INSTALL_DIR` | 升级会替换这个目录；而密钥库是**机器与账户绑定**的（DPAPI），换机器换账户都解不开，既不该被升级覆盖、也不该随程序分发 |
| `SECRETS_INSIDE_CACHE_DIR` | 缓存被定义为「可安全删除」，而删掉密钥库之后已录入的密钥**无法找回** |

`openProductSecrets` 会**自己再判一次**（`assertSecretsPlacement`），
而不是只信调用方：这个判定很便宜，而漏掉它的代价是密钥被备份带走或被缓存清理删掉。
位置不合法时**连库都不打开**（`store: null`）。

---

## 3. 决定二：明文后端 fail closed，但把「放开」做成一次**说出来的**选择

生产环境用 `memoryBackend` / `nullProtector` 等于把密钥明文落盘，而它
**不会报错、只会静默地不安全**。所以 `requireProtected` 默认为 `true`，
明文后端直接判 `SECRETS_STORE_UNPROTECTED`。

但开发机上"只想看一眼界面"是合理需求。所以放开是允许的
（`requireProtected: false`），**而错误文案里直接写出这句话怎么写**：

```
密钥库后端未提供受保护存储（scheme=plaintext）：明文后端不会报错、只会静默地不安全，
不得用于真实密钥。若只是本机开发查看界面，请显式传 requireProtected: false。
```

一个让人猜不到怎么放开的门禁，最后会被人绕过；一个写清怎么放开的门禁，
至少让绕过成为**一个被记录下来的决定**。

---

## 4. 决定三：自检返回结果，**不抛**

「这台机器上的密钥库能不能用」是要**显示给人看**的，不是要中断启动的流程。
所以 `openProductSecrets` 在打不开、缺保护、位置非法时**全部返回结果对象**，
是否阻止启动由调用方决定。

这与本项目已经在用的那条分界一致：

> **形状错误抛出，配置问题返回值。**

`storeFactory` 抛出的异常被收敛，且**不原样带出 `message`**：
密钥库异常里可能出现被解密的片段、文件路径、Windows 账户名或后端 stderr 正文。
只保留 `err.name` 这个结构信息，诊断价值由"哪一类失败"提供，不由原文提供。
有用例直接构造一个 message 里带 `C:\Users\bob\secret.bin` 的异常，
断言 `bob` 和 `secret.bin` 都不出现、而 `Error` 保留。

---

## 5. 决定四：本模块**不读 `process.env`**

与 `product/paths.mjs` 同一条纪律：环境变量由调用方（Launcher）读取并显式传入。理由：

1. 本模块可对 win32/posix 两套语义同时做用例（否则路径判定只在一处被测过）；
2. 配置面的读取点收敛到一处，只在那一个文件里声明。

具体到 ACL 的 `owner`：它在 Windows 上是 `DOMAIN\user`，**而这个值不能猜**。
猜错主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"（fail open）。
所以 `owner` 是显式入参，**不给就不加固**，并把"没加固"如实报出来。

（实现过程中我最初写了一个从 `process.env.USERNAME`/`USERDOMAIN` 拼 owner 的
`ownerHint()`，配置面门禁当场报出三个未声明 env 键。那不只是声明问题——
它同时违反了上面两条理由，而且它正在**猜一个不能猜的值**。改成显式入参。）

---

## 6. 抓到的问题

### ① ACL 检查不传 `owner`，一份干净的 ACL 被永远判成"越权"

`icacls` 的输出**不标出**哪个主体是所有者。我最初写的是：

```js
const aclBefore = await inspectFileAcl({ file: path, platform, run })
```

于是**真所有者被当成越权主体**，一份干净的 ACL 永远显示"越权"。

方向是 fail closed（不会漏报真问题），所以看起来"没问题"。
但它的真实代价是：**这个提示很快会被所有人忽略**——一个永远在报错的警告
与没有警告是同一件事。

### ② 上面那个缺陷一开始**被加固路径掩盖了**

修好之后我做了"变红验证"，把 `owner` 从第一次检查里去掉——**结果仍然全绿**。
原因是加固会把事情补回来：

```
检查判越权 → 加固（带 owner）→ 复验通过 → aclVerified: true → 用例通过
```

行为上"最后是对的"，但代价是**每一次启动都会去改一遍文件权限**
（Windows 上四条 `icacls`、POSIX 上一次 `chmod`），而改权限不是只读操作。

我加了一条用例把它钉住：**本来就干净的 ACL 不得触发加固**
（断言 `hardened === null` 且没有任何 `/inheritance:r` / `chmod` 命令）。
这条用例的通用形式值得记：

> **一个"反正最后是对的"的实现，会掩盖它多做了一件不该做的事。**

### ③ 测试自身的两处错误

- `assert.equal(findPlaintextSecrets(...), [])` —— 数组按引用比较，永远是 `false`。
  报错信息里 `actual` 与 `expected` **都是 `[]`**，但断言失败。改成 `deepEqual`。
- "给了 owner 时加固被调用"这条用例，加固前后返回**同一份干净的 ACL**。
  于是干净之后根本不触发加固，而 `assert.ok(icacls.some(a => a.includes('/inheritance:r')))`
  是对着一次**根本没发生**的加固通过的。改成有状态的 runner（加固前不干净、
  加固后才干净），并断言 `aclBefore.ok === false` 与 `aclVerified === true` 两端。

  这与本项目已经记过的另一条是同一个家族：
  > **一个测不到东西的用例，和一个正确的实现，在输出上完全一样。**

---

## 7. 六条判定的"变红"验证

`break-254.mjs`：

| 改坏的东西 | 变红 |
| --- | --- |
| 密钥库默认落在 DataDir 内 | ✔（**16 例红**） |
| 明文后端被当成可用密钥库 | ✔（2 例红） |
| ACL 检查不传 `owner` | ✔（加用例后 1 例红） |
| ACL 状态不进文案（"未验证"看起来像"已确认安全"） | ✔（2 例红） |
| 原样带出底层异常 message | ✔ |
| 自检结果不再冻结 | ✔ |

---

## 8. 未交付

- **Launcher 还没有调用 `openProductSecrets`。** 本模块是那根线，但**线的一端
  还没插上**：`product/launcher/` 里没有任何地方打开密钥库、也没有把自检结果
  显示给用户。也就是说，"密钥库能不能用"今天仍然不会被任何启动流程回答。
  接线位置是 PRT-257（Launcher 负责安装/自检/修复）。
- **`owner` 没有来源。** 本模块要求显式传入，而当前的调用方（如果有）
  没有地方拿到它。Launcher 需要自己读 `USERNAME`/`USERDOMAIN`
  并在**它自己的** `config-schema` 里声明（那才是它该出现的地方）。
  换句话说：**默认情况下加固不会发生**，只会被报成"未加固"。
- **主机之间的差异未处理。** 密钥库是机器+账户绑定的（DPAPI）。
  把它从一台机器拷到另一台，表现是 `SECRET_DECRYPT_FAILED`，
  而文案指向"换了 Windows 账户或用另一台机器复制了密钥库文件"。
  **没有任何机制阻止这次拷贝**，也没有"这台机器的库是新的"这样的标记。
- **`LEGION_SECRETS_FILE` 允许把库指到任意路径**，包括网络盘。
  位置判定只覆盖"在产品家目录/数据目录/缓存目录/安装目录"这几种相对关系，
  而网络盘上的 DPAPI 文件**在别的机器上解不开**，且延迟与可用性都不可控。
  没有对此的检查。
- **密钥库没有并发保护。** `fileBackend` 的写入是
  `mkdirSync` → 写临时文件 → `renameSync`，原子替换是有的，
  但**两个进程同时打开同一个库**（Launcher 与 worker）时的读-改-写竞争没有处理。
  spec §6.7 说"Runtime 在获得授权后按需解析密钥"，而多个 Runtime 同时存在
  是正常形态。
- **没有与 `$DSH_HOME/.credentials.yaml` 对账。** spec 附录 A.2 第 2 条要求
  「复用 `$DSH_HOME/.credentials.yaml`，**不要另建密钥库**」——本模块恰恰是
  **另建**的那一个。上一份文档（`PRT-509-file-acl-hardening.md` §9）已把这个
  张力完整记录并给出两条候选路线，**并指出它需要产品决策"哪一个是权威"**。
  本模块的处置是：**不擅自合并、不假装张力不存在**，把它继续留在那里，
  并在此**再次**记为当前最大的一处未交付。
- **`count` 用的是 `store.list()`**，在条目很多时会把全部元数据读进内存。
  当前没有分页，也没有上限。
- **自检没有缓存。** 每次调用 `openProductSecrets` 都会重新读一次 ACL
  （Windows 上是一次 `icacls` 子进程）。启动时一次是合理的，
  但如果每次运行都调一次，就会变成一个可观测的开销。
- **`SPEC/PRODUCT` 的"一键启动"没有验证过。** PRT-254 的原文包含
  「一键启动」，而本批只做了密钥库这一半；"从零到能跑"的端到端
  验证（安装 → 初始化 → 打开密钥库 → 录入凭证 → 探测通过）**没有做过**。

---

## 9. 复跑方式

```bash
node --test product/secrets.test.mjs      # 23 例
node --test product/paths.test.mjs        # 18 例，无回归
node --test product/init.test.mjs product/config.test.mjs
node scripts/ci/run-ci.mjs --only test    # 全套
```
