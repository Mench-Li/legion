# PRT-505 后半 / spec §6.7：凭证管理的**写**入口

> 本文记录的是「新增 / 更新 / 轮换 / 删除」这四条动作的落地。
> 读路径早已接上（`runtime/probe/secret-resolver.mjs` → `store.get`），
> 而写路径此前**零生产调用方**——本文的主体就是那件事及其两个后果。

## 1. 落地前的事实

`security/secrets/store.mjs` 的 `put` / `rotate` / `remove` 有实现、有套件、有文档，
但整个仓库里没有任何生产代码调用过它们，也没有任何 HTTP 路由。验证方式：

```
git grep -n "putSecret|store.put|\.rotate(" -- "*.mjs" "*.ts" \
  | Select-String -NotMatch "\.test\.mjs|security/secrets/store"
→ 无命中
git grep -n "api/secret" -- team-hub/
→ 无命中
```

于是 `secretRef` 只能指向**别人放进去的东西**（手写的文件、DSH 的凭证文件），
而 spec §6.7 要求的「新增/更新/轮换/删除写审计记录（不含密文）」
——四个动作**一个都发不出来**。

> 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。

连带的一处死锁：`team-hub/probe-service.mjs:39` 写着

> 提供一个 `invalidate()` 由轮换/修改凭证的路径调用

而 `git grep -n "probeServiceInstance|invalidate" -- team-hub/` 只匹配到它自己的定义。
**两条线一直在互相等**：失效等写路径，写路径不存在。

## 2. 本次新增

| 文件 | 作用 |
| --- | --- |
| `team-hub/secret-admin.mjs` | 管理面：`describe` / `list` / `put` / `rotate` / `remove` |
| `team-hub/secret-admin.test.mjs` | 管理面契约，24 例 |
| `team-hub/secret-routes.test.mjs` | HTTP 契约 + 接线，15 例 |
| `team-hub/server.mjs` | 5 条路由 + `createHubSecretAdmin` 接线 |

### 路由（**字面量**写法，见 §6）

| 方法 | 路径 | 动作 |
| --- | --- | --- |
| GET | `/api/secrets/status` | 自检状态（**只有计数，没有引用名**） |
| GET | `/api/secrets` | 列出引用与元数据（管理读，显式认证） |
| POST | `/api/secrets` | 新增 / 更新（引用已存在即更新） |
| POST | `/api/secrets/<ref>/rotate` | 轮换：名不变、值替换 |
| DELETE | `/api/secrets/<ref>` | 删除（**幂等**） |

平台契约路由数 131 → **136**。

## 3. 写路径引入的两个**新**问题

这两个在读路径上都不存在，所以此前没有人遇到过。

### ① 每一次写入都会重置文件权限

`fileBackend.writeAll` 走的是「写临时文件 + rename」：

```
mkdirSync(dirname, {recursive:true}) → writeFileSync(tmp, {mode:0o600}) → renameSync(tmp, file)
```

POSIX 上 `mode:0o600` 有效。**Windows 上 `mode` 基本被忽略**，新文件的 ACE
继承自目录。于是：`openProductSecrets` 在打开时把权限收紧成「仅所有者可读」，
然后**每一次写入**都用一个新文件替换掉它——**那次加固就没了**。

**处置**：`reverifyAcl()` 在**每一次**写入之后重新打开并核验，
而不是只在打开时核验一次。规则：任何一次写入都可能把保护重置，那就每次都查。

### ② 全新安装上，第一次写入**必然**发生在「文件还不存在」之后

`openProductSecrets` 刻意不对不存在的文件加固（`ACL_NOT_CREATED`：对着不存在的
路径跑 `icacls /grant` 只会失败并留下一条假告警）。这个取舍在只读时是对的，
可是写路径恰好就是**创建**这个文件的那一步：

```
启动 → 打开密钥库（文件不存在 → 不加固）→ 用户录入第一把钥匙 → 文件诞生
                                                                    ↑ 从没被加固过
```

**处置**：与 ① 同一条——写完文件就存在了，重新核验会真的去加固它。

### 核验失败时的语义

写入成功、但重新核验没通过时，**不把写入报成失败**（凭证已经在库里了，
报失败会让用户以为要重做一遍），但必须同时给出：

- `aclVerified: false`
- `acl`：真实的 ACL 结论（不是笼统的 `false`）
- `aclNote`：核验本身抛错时的说明

> 没核验过绝不能看起来像已确认安全。

## 4. 三条纪律

### A. 打不开就 fail closed，没有降级开关

`requireProtected: true` 在 `secret-admin.mjs` 里**写死**。

读路径上明文后端只是让人看到不该看的东西；写路径上它会**把用户的真实密钥
明文落盘**。明文后端不会报错、只会静默地不安全，所以这里不退化成「先存着」。

### B. 响应里永远没有值，错误里也没有

返回的是 `freezeMeta` 的产物（`ref` / `purpose` / `scheme` / 时间戳）。
`list()` 走**白名单投影**，不是透传后端整行。
错误由 `SecretStoreError`（上下文白名单 `ref`/`platform`/`cause`）或本模块的
`adminError` 构造；默认分支**不展开 `e.message`**——保护器（DPAPI）与文件后端
都在密钥库外面，它们异常文本的措辞由别人的代码决定。

`describe()` **只给计数、不给引用名**：它的结果会被显示与记录，而引用名能画出
「这台机器配了哪些供应商」（与 `product/secrets.mjs` ④ 同一条纪律）。
`list()` 是唯一返回引用名的出口，因为管理界面必须能列出「有哪些」。

### C. 写成功之后必须让探测缓存失效

`onCredentialsChanged` → `probeService().invalidate()`。
缓存键里含凭证版本，但「密钥库这个**文件**被换了」只有写路径知道。
不失效的后果是具体的：轮换完密钥、界面点「测试连接」，拿到的还是
**用旧钥匙得出的旧结论**——而它看起来完全像一次新的验证。

**失效放在核验之后**：核验自己会重新打开密钥库，先失效再核验等于白失效一次。

## 5. 接缝为什么写在这里

`createHubSecretAdmin` 被导出，且**默认参数就是生产值**：

```js
export function createHubSecretAdmin({
  env = process.env,
  getProbeService = () => probeServiceInstance,   // ← 生产就是这一行
  ...
})
```

第一版把接线写在 `server.mjs` 的三行访问器里：

```js
probeInvalidate: () => (probeServiceInstance === null ? 0 : probeService().invalidate()),
```

问题不是"难看"，是**没有任何用例覆盖得到那三行**——用例只能验一个被整体替换掉的
回调，把那一行改成 `null`、或者干脆删掉，全部用例照样绿。
破验证的第一轮把这个暴露了出来：13 条探针里有 6 条**不咬**。

> 一个没有证据的接线，与一根没接的线，在「能不能用」上是同一个答案。

改成注入**探测服务实例**之后，接线本身落在被覆盖的函数里，用例只替换那个对象，
「接线断掉」才会真的红。

同一处纪律：`team-hub` 的 `owner` 也曾经观测不到。
所有用例都注入假的 `openSecrets`，而 `owner` 只对**真实**的
`openProductSecrets` 有意义——于是把生产那行改成 `owner: null` 没有任何用例会红。
补法是在注入函数里**记录它收到的实参**（那是真实实现必须拿到的东西），
于是「拿不到账户名就给 null」与「域必须一起拼」两件事都有了证据。

## 6. 路由必须用字面量写

`scripts/prt/baseline-snapshot.mjs` 的 `findOpaqueRouteGuards` 会**拒绝**
用常量做路径守卫的路由，因为抽取正则只认字符串字面量——漏掉一条端点却报
「与基线一致」是最坏的输出。所以：

```js
if (req.method === 'POST' && path.startsWith('/api/secrets/') && path.endsWith('/rotate')) {
  const rawRef = path.slice('/api/secrets/'.length, path.length - '/rotate'.length)
```

顺序上这四条必须放在其它 `startsWith` 守卫**之前**，否则 `.../rotate` 会被
当成一个引用名解析过去。

## 7. 错误码到 HTTP 的映射

| 内部码 | HTTP | 理由 |
| --- | --- | --- |
| `SECRET_REF_INVALID` / `SECRET_VALUE_EMPTY` | 400 | 调用方写错了请求（**配置错误先于状态检查**） |
| `SECRET_NOT_FOUND` | 404 | 轮换一个没录入过的引用 = 没有可轮换的对象 |
| `SECRET_ADMIN_STORE_UNAVAILABLE` | 503 | 「现在没法提供这项服务」，**不是**「没有这把钥匙」 |
| `SECRET_STORE_*` | 503 | 存储层不可用 |
| 未登记的内部码 | 503 | **不猜**状态码，宁可说"服务不可用" |
| `MISSING_PARAM` / `BAD_ID_ENCODING` | 400 | 路由层，先于管理面 |

**删除是唯一的例外**：删一个不存在的引用返回 `removed: false`（**幂等**），不是 404。
删除的意图是「让它不存在」，而它已经不存在了。
轮换不同——轮换一个不存在的引用没有任何可轮换的对象，那是错误。

`SECRET_UNAVAILABLE`（本地存储/账户问题）与 `AUTH_FAILED`（供应商拒绝了
解析出来的凭证）**不合并**：说成前者会让用户去查供应商状态，说成后者会让他
去重录一把好端端的钥匙。两个方向都是错的。

## 8. 破验证

13 条探针，13 条有效变红（`_prt-handoff/break-secrets.json`）。
第一轮只有 7 条咬，剩下 6 条**都是探针本身的问题**，逐条记在这里：

| 探针 | 为什么不咬 | 处置 |
| --- | --- | --- |
| ⑯② `list` 透传整行 | 真实后端行字段与投影**完全一样** | 夹具加一个多给字段的后端 |
| ⑯③ 错误带 `message` | `SecretStoreError` 上下文本身是白名单，没值可带 | 改瞄**默认分支**，夹具让后端异常带值 |
| ⑯⑨ 失败也失效 | 用例只走 `rotate` 的失败分支，探针打在 `put` 上 | 补 `put` 的失败路径 |
| ⑯⑩ 不传 `owner` | owner 只对真实 `openProductSecrets` 有意义，用例全注入假的 | 在注入函数里记录实参 |
| ⑯⑪ 失效抛错当失败 | 瞄准的 server 侧 catch **是冗余的**（内层先兜住） | 改瞄 `secret-admin.mjs` 里真正的规则 |
| ⑯⑬ 列引用名 | 探针读 `__refs`，而那个字段**不存在** → 永远空数组 | 改成真的去 `list()` |

⑯③ 与 ⑯⑪ 的处置还改动了实现：`server.mjs` 侧的 catch 收窄成只兜
**访问器自己抛**，`invalidate()` 的异常交给 `secret-admin.mjs` 兜——
「失效失败不能把写入报成失败」这条规则只写一处。两处都写的话，
外层那个先兜住，内层就变成一段永不执行的死代码，而它看起来像一道防线。

## 9. 还没有的（与它为什么不是本任务的遗漏）

- **UI 入口**：`ModelConfigModal.tsx` 仍硬编码 `MODEL_OPTIONS`，
  没有任何界面调用这 5 条路由。功能可用（HTTP 面完整），但没有按钮。
  这是 PRT-507 的 UI 一半。
- **`/api/secrets` 的 ACL 复核结果**：`list` 返回 `aclVerified`，
  但没有任何消费者据此拒绝操作。
- **首次录入的引导**：新装机器上不可能有 `secretRef`，而 UI 不会告诉用户
  「先去录一把」。
