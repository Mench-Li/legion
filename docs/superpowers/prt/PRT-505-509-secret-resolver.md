# PRT-505 / PRT-509：密钥库的生产调用方、轮换自动失效与泄漏断言

**对应 spec**：§6.7（密钥：按需解析、fail closed、不得进入提示词/日志/异常/审计/诊断包/能力包；`SECRET_UNAVAILABLE` 与 `AUTH_FAILED` 不得混为一类）
**承接**：PRT-505 此前的状态是「**尚无生产调用方**」，PRT-509 是「跨账户与 ACL 加固未做」
**交付物**：
- `runtime/probe/secret-resolver.mjs` —— `security/secrets/` 的**第一个也是唯一的生产调用方**
- `runtime/probe/secret-resolver.test.mjs` —— **21 例**
- `runtime/contracts/model-probe.mjs` —— `probeFingerprint` 增加 `credentialVersion`
- `runtime/probe/index.mjs` —— `createModelProbe({ credentialVersionOf })`

---

## 1. 为什么这一步是必需的

`security/secrets/` 此前是一个完整实现，有 DPAPI 往返实测、fail-closed、
六条出口脱敏，和一组 9 例的套件——**但没有任何生产代码调用它**。

**一份没人用的密钥库等于没有密钥库。** 更具体地说：PRT-504 的探测执行器
需要一个 `resolveSecret`，而在本批之前那个位置是空的。没有它，
"模型连通性与能力验证"这条链路的最后一环（"钥匙从哪来"）没有实现。

---

## 2. `SECRET_UNAVAILABLE` ≠ `AUTH_FAILED`，落在结构上

spec §6.7 把这两类失败明确分开：

| 码 | 含义 | 下一动作 |
| --- | --- | --- |
| `SECRET_UNAVAILABLE` | 本地凭证库/账户问题，取不到明文 | 查本机密钥库。**不要**去供应商控制台换钥匙 |
| `AUTH_FAILED` | 供应商拒绝一个**已经成功解析**的凭证 | 换钥匙或查权限。本机密钥库是好的 |

本模块的实现方式让这条纪律**不可能写错**：它只抛 `SecretStoreError`，
而 `RUNTIME_CODE_FOR` 把全部内部码收敛到 `SECRET_UNAVAILABLE`。
也就是说——

> **本模块的任何异常都只意味着"本机取不到明文"。**

供应商拒绝是 transport 拿到 401 之后的事，在本模块**之外**。
这里没有第二个出口，所以不存在"顺手报成 AUTH_FAILED"的可能。

配套的结构性保证：**解不开钥匙时根本不发请求**（用例断言
`transport.calls.length === 0`）。一旦发出去了，那次 401 就会成为一条
"鉴权失败"的证据，而它其实什么都没证明。

---

## 3. 三条纪律落在结构上

### ① 明文后端在**构造时**就被拒绝

```js
if (requireProtected === true) assertProtectedStore(store, { allowedSchemes })
```

生产环境用 `memoryBackend` 或 `nullProtector` 就等于把密钥明文落盘，
而这**不会报错、只会静默地不安全**。

关键是**失败发生的时刻**：如果等到第一次真要用密钥时才发现，那个错误会
落在**一次运行中间**，而用户不会把它读成"我的密钥库没加密"——他会读成
"这次运行失败了"。构造时的失败才指向正确的结论。

放开保护是允许的（`requireProtected: false`），但那是一个**要说出来**的选择。

### ② 不缓存明文

spec §6.7 要求「Runtime 在获得授权后**按需**解析密钥」。缓存会让明文在进程里
活过很多次运行，**而每一次运行都是一个新的授权边界**。所以每次调用都真的
去解一次。

### ③ 底层异常被收敛，不原样带出 message

密钥库的异常里可能出现被解密的片段、文件路径、Windows 账户名，或者后端命令的
stderr 正文。只保留 `name`/`code` 这类**结构**信息：

```js
const cause = `${err.name ?? 'Error'}${err.code === undefined ? '' : `/${err.code}`}`
```

**诊断价值由"哪一类失败"提供，不由原文提供。** 有用例直接构造一个 message 里带
`account=DESKTOP\alice` 和 `C:\Users\alice\AppData\creds.bin` 的异常，
断言这两样都不出现在最终错误里，而 `Error` 这个类型信息保留。

---

## 4. 本批最有价值的一条：轮换让探测缓存**自动**失效

### 问题

PRT-504 的探测缓存按 `probeFingerprint(profile)` 分桶。我原先的实现在注释里
写的是：

> 刻意**不含 secretRef 的值**——引用名会随轮换改变，但轮换**不应**让一次刚刚
> 完成的探测失效（轮换后必须重新探测的判断由 PRT-509 的轮换流程负责）。

**这句话是错的**，而且错的方式很典型。轮换的**定义**就是"引用名不变、值变了"。
引用名不变 → 指纹不变 → 缓存命中 → 判定不重来。于是：

- 坏钥匙换成好钥匙 → 配置页在 TTL 内**仍然显示"鉴权失败"**；
- **好钥匙换成坏钥匙 → 界面显示"通过"，而真实的运行会失败。**

反方向更糟：它把一次可用性证明给了一把已经不能用的钥匙。

而"由 PRT-509 的轮换流程负责"是一个**不存在且容易被忘记**的责任。
这正是那条纪律的又一个实例：

> **一道看不见某类变化的大门，比没有大门更坏。**

### 修法

密钥元数据里有 `rotatedAt`/`updatedAt`，**它们是只读元数据，不需要解密**。
把它取出来进指纹：

```js
// runtime/contracts/model-probe.mjs
probeFingerprint(profile, { credentialVersion })   // 版本进指纹
```

```js
// runtime/probe/index.mjs
createModelProbe({ credentialVersionOf })          // 每次 probe 自动取
```

关键是 `credentialVersionOf` 在**执行器内部**被自动调用，
而不是要求每个调用点自己记得传。**调用点的纪律必然会被忘记；
内建的纪律不会。**

### 版本取不到时给**唯一值**，不是空串

```js
return v === null || v === undefined || v === ''
  ? `unknown:${versionUnknownNonce += 1}`
  : String(v)
```

两种错法的代价不对称：

| 做法 | 后果 |
| --- | --- |
| 给唯一值 | 缓存必然不命中 → 真的探一次（多花一次请求，**结果正确**） |
| 给空串 | "版本未知"的两次探测互相命中 → **可能拿旧钥匙的判定回答新钥匙的问题** |

而且这里的失败**不中断探测**：元数据读不到通常意味着密钥库本身有问题，
那件事会由紧随其后的 `resolveSecret` 报成 `SECRET_UNAVAILABLE`
——那才是这条链路上唯一该报的错。这里只负责不让缓存骗人。

---

## 5. 抓到的问题

### ① 我自己的注释里那句错误的设计理由（见 §4）

这条不是"代码与注释不符"，而是**注释把错误的设计说成了刻意的选择**。
它之所以值得记，是因为它读起来很有道理：把责任交给另一个模块、
并说明"那个模块会负责"。一句写得像是有意的设计说明，比一句没写注释更危险。

### ② 用非法 base64 造"损坏的密文"，而它根本不会损坏

我原来的用例这样造损坏：

```js
await backend.write('legion/broken', { blob: 'enc:not-valid-base64!!!', meta })
```

`Buffer.from(x, 'base64')` **会静默忽略非法字符而不抛**。于是"损坏"没有发生，
`unprotect` 正常返回一段垃圾，用例断言的 `assert.rejects` 对着一个成功的调用——
**"Missing expected rejection"**。

改用完全不属于本方案形状的 blob（`not-a-protected-blob`）。

这类错误与 §6 里的其它几条是同一个家族：**一个测不到东西的用例，
和一个正确的实现，在输出上完全一样。**

---

## 6. 五条判定的"变红"验证

`break-resolver.mjs`：

| 改坏的东西 | 变红 |
| --- | --- |
| 构造时不验保护方案（明文后端被当成真实密钥库） | ✔ |
| 原样带出底层异常 message（路径/账户名/密文片段） | ✔（2 例红） |
| 无凭证的档案被当成错误（本地模型跑不了） | ✔ |
| 凭证版本不进指纹（轮换后继续用旧判定） | ✔（**5 例红**） |
| 版本取不到时空串（"版本未知"的两次探测互相命中缓存） | ✔ |

外加既有的 PRT-504 套件（59 例）**无回归**。

---

## 7. 未交付

- **没有接到真实的 Runtime 启动路径上。** `createSecretResolver` 存在、
  被测试覆盖、能被调用，但 `orchestrator/worker/` 与
  `runtime/adapters/dsh/` 还没有把它装起来——也就是说，**真实的运行目前
  仍然不解析密钥**。这与 PRT-503/510/511 文档 §10 里"账本尚未接进
  orchestrator/worker"是同一类缺口，都属 PRT-253/254。
- **`$DSH_HOME/.credentials.yaml` 的收敛未做**（属 PRT-257）。现在这个仓库里
  存在**两条**凭证路径：DSH 自己的 `.credentials.yaml` 和 Legion 的
  受保护密钥库。两者还没有对账，"哪一个是权威"没有答案。
- **没有真实的 Windows 端到端验证。** 本批的用例全部用内存后端 + 假 protector。
  真实 DPAPI 的往返已有 `secret-store` 套件的实测覆盖，但
  "真实 DPAPI + `createSecretResolver` + 真实探测"这条完整链路**没有跑过**。
- **跨账户与 ACL 加固仍未做**（PRT-509 原定范围）。具体指：密钥库文件放在
  哪里、目录 ACL 该是什么、多用户机器上如何避免另一个用户读到密文文件本身
  （密文是 DPAPI 保护的，理论上换用户解不开，但**文件可读性本身**没有加固）。
  `fileBackend` 也没有检查文件权限。
- **轮换没有版本历史的保留。** `rotate` 覆盖同一个槽位，`rotatedAt` 只有一个。
  所以"轮换之前那把钥匙是什么时候用的、影响了哪些历史运行"无法回答。
  而 `rotatedAt` 一旦被覆盖，一次轮换之后再轮换，**前一版的版本值消失了**
  ——如果某次探测恰好缓存在第一次轮换的版本上，第二次轮换后指纹会变成新的
  值，缓存仍然会失效，所以行为是对的；但审计上无法区分"轮换了几次"。
- **删除没有软删除/宽限期。** `store.remove` 直接删掉记录。一次误删会让所有
  引用它的档案立刻变成 `SECRET_UNAVAILABLE`，而"密钥被删了"与"密钥库坏了"
  在码上是同一个（都是 `SECRET_UNAVAILABLE`），只能靠内部码区分
  （`SECRET_NOT_FOUND` vs `SECRET_STORE_UNREADABLE`）——
  而**对外收敛后两者一样**，所以调用方分不出来。
- **`credentialVersionOf` 每次都读一次元数据。** 于是每次探测（含缓存命中）
  都多一次文件读。这在正确性上是必要的，但高频探测时值得一层短 TTL 的
  元数据缓存（**不能缓存明文，但缓存版本号是安全的**）。
- **`purpose` 字段没有被利用。** 密钥元数据支持 `purpose`，审计事件里也带它，
  但没有地方按用途限定"这次运行可以用哪些密钥"。spec 的授权模型（§6.7
  "获得授权后按需解析"）里，"授权"目前**完全没有实现**——任何能调用解析器的
  代码都能拿到任意引用名的明文。
- **没有最后的兜底扫描。** spec §3.1 说密钥不得进入提示词/正文/日志/导出证据/
  能力包。本批证明了**解析链路**不漏（在序列化字节上验），但
  "能力包"与"提示词"这两条出口还没有对应的检查。

---

## 8. 复跑方式

```bash
node --test runtime/probe/secret-resolver.test.mjs   # 21 例
node --test runtime/contracts/model-probe.test.mjs   # 18 例（含版本进指纹）
node --test runtime/probe/probe.test.mjs             # 22 例
node --test runtime/probe/http.test.mjs              # 19 例
node scripts/ci/run-ci.mjs --only test               # 全套
```
