# PRT-509（续）：密钥库文件的访问控制加固

**对应 spec**：§6.7（密钥 fail closed、不进入提示词/日志/异常/审计/诊断包）
**承接**：本文补齐 PRT-505/509 文档 §7 里明确列为未交付的
「**跨账户与 ACL 加固仍未做**」
**交付物**：
- `security/secrets/acl.mjs` —— Windows `icacls` / POSIX `mode` 的读与加固
- `security/secrets/acl.test.mjs` —— **22 例**（关键用例用**本机 `icacls` 的真实输出**）
- `security/secrets/index.mjs` —— 出口

---

## 1. 为什么密文受保护还不够

DPAPI 保护的是**内容**，不是**文件**。另一个 Windows 账户仍然可以：

1. **复制这个文件带走**——离线暴力、塞进工单、放进备份、发给同事；
2. **看到里面有哪些引用名**——`refs` 的 key 是明文的，能画出
   "这台机器配了哪些供应商、几条通道"；
3. **反复触发解密失败**，把"某个东西存在"变成一个可观测的信号。

所以文件本身必须**只有所有者可读**。

---

## 2. 「查不出来」必须与「查出来是安全的」分开

DSH 自己的 `credentials-local` 在这一点上做得很清楚，注释原文：

> POSIX only: Windows has no mode to inspect — its ACLs are not expressible
> here — so the check is **skipped rather than faked**.

这条纪律必须继承。但它留下一个缺口：**本产品的主平台就是 Windows**
（PRT-505 的标题就是 Windows Secret Store），而"跳过"在这里等于
"Windows 上从不检查"。

Windows 的 ACL **是可查的**——`icacls` 就是它的机制。所以本模块不跳过，
而是真的去读，并且把三种结果**分开**：

| 结果 | 含义 |
| --- | --- |
| `ACL_OK` | 只有所有者（+ 系统必需主体）可访问 |
| `ACL_TOO_PERMISSIVE` | 查出来了，别人也能读 → 明确拒绝，并点名是谁 |
| `ACL_UNVERIFIABLE` | **查不出来**（`icacls` 不存在/输出看不懂/平台未知） |

第三种**绝不等同于第一种**：

> 一条"查不出来就当通过"的检查，比没有检查更坏——它会让人相信一件
> 没被验证过的事。

代码里这条落在**返回值**上：没有 runner 时返回 `ACL_NO_RUNNER`（`ok:false`），
而不是 `ok:true, skipped:true`。"跳过"这个状态在本模块里**根本不存在**。

---

## 3. 本机真实输出就是一个不安全样本

这台机器上对一个临时文件的 `icacls` 实测输出：

```
C:\Users\11150\AppData\Local\Temp\f.json Amench\CodexSandboxUsers:(I)(M)
                                         S-1-5-21-3329393448-...-928322546:(I)(M)
                                         NT AUTHORITY\SYSTEM:(I)(F)
                                         BUILTIN\Administrators:(I)(F)
                                         AMENCH\11150:(I)(F)
```

两个非所有者主体有 **Modify**：一个沙箱组 `Amench\CodexSandboxUsers`，
和一个**未解析的 SID**。后者特别值得注意——一个连名字都没解析出来的主体
同样是真实主体，把它当作"看不懂的行"跳过就等于漏掉一次越权。

这份真实输出直接成了测试夹具。**用真实输出而不是我构造的样本**，是因为构造
样本时我会不自觉地按"我以为的输出格式"写，而解析器的错法恰在格式的细节里。
事实上这一条夹具**当场抓出了我实现里的两个 bug**（见 §4）。

---

## 4. 真实数据当场抓出的两个 bug

### ① 按空白切 token 会切断含空格的主体名

`NT AUTHORITY\SYSTEM` 被切成 `NT` 和 `AUTHORITY\SYSTEM`。
最直接的后果是**系统必需主体认不出来**，于是干净的 ACL 会被误判为越权
（fail closed，还算安全）；但在有 `allowedExtra` 的场景下，
一个含空格的主体名会被完整地当成"未允许的主体"——**判定依据是错的**。

修法：**先剥掉文件路径**（`icacls` 把它打印在第一行，与第一个 ACE 之间只隔
一个空格），然后按"到 `:(...)` 为止、且不含括号"的形态匹配。
括号只出现在权限组里，所以这个约束足以把主体名与权限串分开。

### ② `grantsAccess` 把已经抽好的权限字母**又抽了一遍**

`evaluateWindowsPrincipals` 传的是 `p.access`（已经是 `'M'` 这样的字母），
而 `grantsAccess` 内部又去做 `accessLettersOf('M')` —— 而 `'M'` 里没有括号，
于是返回空串，`/[FMRXWD]/.test('')` 永远是 `false`。

**结果是每一个主体都被跳过、检查永远通过。**

这个 bug 的隐蔽之处在于它**不报错**：`ok:true`、`offenders:[]`，
看起来像"这个文件的 ACL 很干净"。如果我只用手写的干净样本测试，
它永远不会被发现——因为一个永远返回 `ok:true` 的实现，在所有干净样本上都是对的。

**只有"不安全的输入必须报不安全"这条用例能抓住它。**

而这两条 bug 是同一个夹具（本机真实 `icacls` 输出）一次性抓出来的。

### ③ 权限串有多个括号组

`(I)(M)` / `(OI)(CI)(F)`。只取第一组会把继承标记 `I` 当成权限字母，
而 `I` 不是权限——于是**每一条继承来的 ACE 都会被判成授权**。
继承状态必须单独判断，因为它决定"这条 ACE 是文件自己的还是父目录给的"，
而继承来的 ACE 恰恰是最需要警惕的那类：文件自己没授权，父目录给了 `Users`，
效果完全一样。

---

## 5. 判定：谁允许出现在密钥库的 ACL 里

允许的主体只有三类：

- **所有者**（由调用方传入——`icacls` 的输出**不标出**哪个主体是所有者）；
- `NT AUTHORITY\SYSTEM`
- `BUILTIN\Administrators`

后两个不是"我们信任它们"，而是**操作系统要求**它们在场：没有它们，
文件会变成连系统维护都做不了的状态。而管理员本来就等价于所有者权限
——挡管理员不是 ACL 能做的事（那要靠 EFS/DPAPI 的账户绑定，正是内容保护
负责的部分）。

判据因此是：**除了所有者和这几个必需主体，别人一律不许有权限。**
特别地 `BUILTIN\Users`、`Everyone`、`Authenticated Users` 都在拒绝之列
——**它们才是"多用户机器上另一个用户能读到"的真正原因**。

关于所有者参数给错：`icacls` 不标出所有者，所以那是调用方的责任。给错时
真所有者会被当成越权主体。**失误方向是 fail closed**，可以接受，
而且有一条用例专门钉住它。

---

## 6. 加固：先断继承，再授权，然后**复验**

顺序不能反：

1. `icacls <file> /inheritance:r` —— 断开继承；
2. `icacls <file> /grant:r <owner>:(F)` —— 授予所有者；
3. 保留 `SYSTEM` / `Administrators`。

只加权限不删继承，父目录给的 `Users` 授权仍然在，而我们刚刚"设置"过一次权限
——**那种"操作成功了但结果没变"最容易被误认为加固已完成**。

同样地，命令返回 0 **不等于**加固完成。所以每一步之后都重新读一次 ACL 做复验；
复验不通过则整体判失败（`加固后复验未通过：…`）。

不知道所有者时**一个命令都不发**并直接失败：

> 猜一个主体去授权等于把权限给错人。

---

## 7. 抓到的问题（全部先验过会变红 / 或用例当场变红）

| 问题 | 怎么发现的 |
| --- | --- |
| 按空白切 token 切断 `NT AUTHORITY\SYSTEM` | 真实 `icacls` 输出夹具 |
| `grantsAccess` 双重抽取 → **检查永远通过** | 真实输出夹具 + "不安全必须报不安全"用例 |
| `(I)` 被当成权限字母 | 真实输出夹具（`(I)(M)` 形态） |
| 测试自身把所有者名写错（`alice` vs `11150`） | 用例变红，确认是测试错而非代码错 |

---

## 8. 未交付

- **还没有接到启动路径上。** `inspectFileAcl` / `hardenFileAcl` 已从
  `security/secrets/index.mjs` 出口，但**没有一处启动代码调用它们**。
  也就是说：今天没有人会因为密钥库文件权限过宽而被拦下。
  这与本批反复出现的"尚无生产调用方"是同一类缺口，
  真正的接线位置是 PRT-253/254（Runtime 启动与适配器装配）。
- **`fileBackend` 自己不检查权限。** 它只负责读写文件；ACL 是外挂的一步。
  更彻底的写法是 `fileBackend` 在**创建**文件时就带上正确的 ACL
  （而不是创建完之后再去收紧）——后者之间有一个短暂窗口，文件是宽权限的。
- **没有对真实密钥库文件跑过。** 端到端用例用的是临时目录里的一个空文件。
  真实 `$DSH_HOME` 下那个文件的实际 ACL 没有被检查过。
- **`ACL_TOO_PERMISSIVE` 不会被自动修复。** `hardenFileAcl` 存在但需要调用方
  主动调用；`inspectFileAcl` 判越权时**不会**顺手加固。这是刻意的
  （改权限是副作用，应当是一个明确的动作），但也就意味着"检测到了"与
  "修好了"之间需要有人接线。
- **没有与 DSH 的 `.credentials.yaml` 对账。** spec 附录 A.2 第 2 条明确写着
  「`PRT-505` 应**复用它，不要另建密钥库**」，而 DSH 的
  `credentials-local` 已经实现了 `assertOwnerOnly`（POSIX）与
  `assertOwnerOnly` 的 Windows 跳过。本模块补上了 Windows 那一半，
  但**两个密钥库仍然并存**：DSH 的 `.credentials.yaml`
  （`refs` + `records` 两个键空间，明文）与 Legion 的 DPAPI 受保护库。
  这是当前最大的一处未交付，详见 §9。
- **`S-1-5-21-...` 这类未解析 SID 只能被"点名"，不能被解析成友好名称。**
  诊断信息里会出现裸 SID。可读性上值得再做一步
  （`icacls /T` 或 `wmic` 反查），但不影响判定正确性。

---

## 9. 关于「不要另建密钥库」这条 spec 指令（重要）

spec 附录 A.2 第 2 条：

> `$DSH_HOME/.credentials.yaml` 不在安装目录内，且其 `{version, refs, records}`
> 结构正是 `secretRef` 所指的既有机制 → **`PRT-505` 应复用它，不要另建密钥库**。

本批对此做了实际核对，结论是**这条指令与 Legion 既有的 DPAPI 实现之间有真实张力**：

**支持复用的证据（本批实测）：**

1. DSH 的 `CredentialKey` 语法是 `<scope>/<id>`，而 Legion 的 `SECRET_REF_RE`
   强制的正是"恰好两段"——**两种引用名语法是相容的**（DSH 注释说明了为什么
   `records` 用 `/` 而 `refs` 不用：让两个键空间永不碰撞）。
2. DSH 的 `credentials-local` 已经做了 `assertOwnerOnly`（POSIX），
   这正是 PRT-509 要的那件事——**"复用"在这里确实是真的复用**。
3. DSH 的 `records:` 键空间就是为"LLM 适配器按 provider route key 存凭证"
   设计的，与 `ModelProfile.secretRef` 的用途**完全吻合**。

**反对直接复用的证据（本批实测）：**

1. **它是明文的。** 本机实测 `.credentials.yaml` 里
   `refs:` 里的值是**明文**的（形如 `{ DEEPSEEK_API_KEY: sk-... }`） ——
   值直接就是明文。Legion 用 DPAPI 加密是**更强**的保护，
   而复用会把保护等级降到明文。
2. **Legion 有零第三方依赖纪律，而 DSH 用 `yaml` 包解析它。**
   要读 `.credentials.yaml` 就得自己写一个 YAML 解析器——而 YAML 的
   边角（锚点、多行标量、引号规则、重复键）是出了名的容易解析错，
   而**解析错一个凭证文件是安全事件**。

**所以本批的处置是：不擅自改掉既有实现，也不假装张力不存在，
而是把它如实记录为 PRT-505 未交付的最大一项**，并给出两条候选路线：

- **路线 A（读桥）**：Legion 的 DPAPI 库保持为**权威**（写路径唯一），
  但增加一个**只读**的 DSH `.credentials.yaml` 解析器作为回退来源。
  好处是已经配好的 DSH 凭证不必重录；代价是要写 YAML 解析器。
- **路线 B（迁移）**：提供一次性迁移，把 `.credentials.yaml` 里需要的值
  搬进 DPAPI 库，然后不再读它。好处是不必实现 YAML 的长期维护面
  （只支持 DSH 实际写出的那个子集）；代价是迁移后两个文件不再同步。

**两条路线都需要产品决策**（"哪一个是权威"），因此不适合由实现者单方面决定。
这属于本批**明确升级**的问题，而不是"做完了但没写在文档里"的遗漏。

---

## 10. 复跑方式

```bash
node --test security/secrets/acl.test.mjs          # 22 例（含真实 icacls 端到端）
node --test security/secrets/secrets.test.mjs      # 9 例，无回归
node scripts/ci/run-ci.mjs --only test             # 全套
```
