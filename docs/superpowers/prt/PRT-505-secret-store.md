# PRT-505 本机密钥库（Windows 当前用户作用域 DPAPI）

**对应**：`PRT-505`（最小闭环）、`PRT-258` 第四份契约
**实现**：`security/secrets/`（`ref.mjs` / `errors.mjs` / `dpapi.mjs` / `store.mjs` / `index.mjs` / `index.d.mts`）
**用例**：`security/secrets/secrets.test.mjs`（9 例，含 **1 例真实 DPAPI 往返**），CI 套件 `secret-store`
**上游输入**：`PRT-003-config-secret-inventory.md` §3（`$DSH_HOME/.credentials.yaml` 已是 `refs → records` 引用式存储；仓库内明文凭证 0 处）

---

## 1. 交付了什么

spec §6.7 的六条硬约束，逐条落成**结构**而不是文档约定：

| 约束（spec §6.7） | 落地形式 |
| --- | --- |
| team-hub 只保存 `secretRef`，不保存明文 | `put()` 只返回元数据；`fileBackend` 落盘的 `records[].blob` 是密文 |
| Runtime 在获得授权后按需解析密钥 | `get()` 是**唯一**的明文出口，且必须显式传引用 |
| 密钥只注入需要它的执行进程和工具 | 不做全局单例、不读 `process.env`、不缓存 |
| 提示词/日志/异常/审计/诊断包不得含密钥 | `list()` / `describe()` / `toJSON()` / `toString()` / 审计载荷 / 错误对象**六条出口各自受约束** |
| 新增、更新、轮换、删除写不含密文的审计 | `onAudit` 载荷走**白名单**（`action`/`ref`/`at`/`purpose`），多一个字段直接抛错 |
| 无法访问或解密时 fail closed | 全部抛 `SecretStoreError`，**不返回空串或 undefined** |

### 分层

```
backend    只负责 blob 的读写与列举（memoryBackend / fileBackend）
protector  只负责 明文 <-> blob（nullProtector / createDpapiProtector / createProtector）
store      组合两者：引用校验、元数据、审计白名单、fail-closed
```

「存哪里」与「怎么保护」是两个正交的问题。揉进一个后端的后果是
「用内存后端测文件后端的原子写」做不到，而且「保护方案」会变成后端的隐藏属性——
于是「这个库到底受不受保护」只能靠读代码回答。

---

## 2. 三条**不会抛异常**的失败，各有一条用例守着

### ① 元数据接口成为泄漏点

`list()` / `toJSON()` / 审计事件 / 错误对象都是「顺手」会带上原文的地方：

- `JSON.stringify(store)` 不会报错，只会把密钥写进日志；
- 审计事件里的密文**长度**也是信息；
- 异常对象会进异常上报与诊断包。

修法不是「小心一点」，而是把它们各自关掉：`toJSON()` 显式返回脱敏结构；
审计回调对白名单外的键**抛错**（不是过滤——过滤会让「有人加了个字段」这件事
静默通过）；`SecretStoreError` 的 `cause` 只保留结构信息，长十六进制串与常见
密钥前缀一律擦成 `<redacted>`。

### ② 受保护后端不可用时退化为明文

`assertProtectedStore()` 把「明文后端」判成 `SECRET_STORE_UNPROTECTED`
（对外收敛为 `SECRET_UNAVAILABLE`）。非 Windows 上 `createDpapiProtector()` 直接抛错、
`probeDpapi()` 返回 `available: false`——**不退化**。

理由：退化会让「密钥受保护」这句话在部分机器上悄悄失效，
而失效的那台恰恰是配置最特殊的那个（没有 PowerShell、换了账户、从别的机器复制了库）。

### ③ 引用名可以穿越目录

引用名会成为密钥库里的记录键（也可能被用作文件名或日志字段）。
除字符集外额外禁止空段与 `..`：`a//b`、`a/../b`、`../x` 全部拒绝。
非法引用**抛错**而不是返回原值——静默接受会产出「写进库但永远读不出来」的记录。

---

## 3. 真实 DPAPI 往返（不是「调用了我自己的函数」）

用例 `真实 DPAPI 往返（当前用户作用域）` 做四件事，各自都是别的测法证明不了的：

1. **落盘文件里不含明文** —— 用假加解密函数时这条恒真，无意义；用真实 DPAPI 才有内容。
2. **新实例（模拟重启）用同一 Windows 用户能解出原值** —— 证明密文确实是
   「当前用户作用域可解」，而不是被某次进程状态锁住。
3. **换掉 blob 后必须 fail closed** —— 且错误文本里既不得有明文，也不得回显 blob 原文。
4. **非 Windows 上抛 `SECRET_STORE_UNSUPPORTED_PLATFORM`** —— 覆盖「平台不支持」这条路，
   它在开发机上永远不会自然发生。

**明文只经 stdin**：既不做命令行参数（同机进程可见），也不做环境变量
（会进继承环境与崩溃转储）。`protectValue` / `unprotectValue` 全程
`spawnSync` 管道，Node 侧立即消费，不落中间文件。

`ConvertTo-SecureString` **不带 `-Key`** 时就是当前用户作用域 DPAPI。
带 `-Key` 的形式是 AES + 自管密钥——那不是 DPAPI，也不解决「密钥放哪里」。

---

## 4. 本批次**未交付**的部分（不得当成已完成）

- **`$DSH_HOME/.credentials.yaml` 的复用尚未接线。** PRT-003 §3.2 的结论是
  「复用既有机制，不要另建密钥库」，而本批次交付的是**同形的引用式存储 + 受保护后端**，
  不是对那个文件的读写。落点选谁（读 DSH 的 yaml / 产品自持 JSON）取决于
  PRT-011 路线 C 的最终落地形态，属 `PRT-257`。
- **没有任何生产调用方。** 目前只有自己的用例驱动它——「有用例」不等于「已生效」。
  接线点有两个：`PRT-501`（ModelProfile 数据模型）与 `PRT-254`（一键启动）。
- **`AUTH_FAILED` 与 `SECRET_UNAVAILABLE` 的分离只做了一半。** 本模块只产出后者；
  前者属 Runtime 适配层（供应商拒绝一个已成功解析的凭证），在 `PRT-207/206`。
- **没有密钥复杂度/长度策略。** 本批次只拒绝空值。弱密钥检测需要各供应商的格式知识，
  属 `PRT-504`（模型连通性与能力测试）。
- **轮换不影响在途 Run，这一条是设计而非实现。** spec §6.7 要求在途 Run
  保持其启动时解析到进程内的短生命周期凭证；本模块**不缓存**，因此这条
  由「调用方在 Run 开始时取一次」保证，需要 `PRT-301` 落地后才能验证。
- **未做文件级 ACL 加固**（Windows 上依赖 DPAPI 的账户绑定 + 文件权限继承）。
  跨账户/跨机器的攻击面分析属 `PRT-509`。

---

## 5. 复现

```powershell
cd D:\project\DSH\legion\.worktrees\prt-runtime
node --test security/secrets/secrets.test.mjs     # 9 例（含真实 DPAPI 往返）
node scripts/ci/dsh-boundary.mjs --check          # security/ 属 must-be-zero：执行面依赖 0
node scripts/ci/run-ci.mjs --only test --out .ci/prt-505
```

`security/` 在 `scripts/ci/dsh-boundary.mjs` 里属于 `mustBeZeroPrefixes`：
本批次六个文件对执行面依赖为 **0 处**，基线仍是 3 文件 / 26 处。
