# PRT-504：模型连通性与能力测试

**对应 spec**：§6.6 第 402 行（连通性、模型可用性和能力验证）、§6.7 第 423 行（`SECRET_UNAVAILABLE` 与 `AUTH_FAILED` 不得混为一类）
**交付物**：
- `runtime/contracts/model-probe.mjs` —— 失败分类、判定与缓存策略（纯函数，无 I/O）
- `runtime/probe/index.mjs` —— 探测执行器（transport 与凭证解析**双注入**）
- `runtime/probe/http.mjs` —— 真实 HTTP transport（`/v1/models`）+ 能力证据提取
- `runtime/contracts/index.mjs` / `index.d.mts` —— 契约出口与类型
- 套件 `model-probe`（**18 例**）、`probe`（**22 例**）、`probe-http`（**19 例**，起真 HTTP 服务）

---

## 1. spec 原文与落地

> 连通性、模型可用性和能力验证。

这是三件不同的事，回答的问题完全不同：

| 问题 | 谁回答 | 判定依据 |
| --- | --- | --- |
| 能不能把包送到对端？ | `ENDPOINT_UNREACHABLE` / `TLS_FAILED` / `TIMEOUT` | DNS / TCP / TLS / 响应 |
| 对端认不认这把钥匙、认不认这个模型 id？ | `AUTH_FAILED` / `MODEL_NOT_FOUND` | HTTP 401/403、清单里有没有这个 id |
| 这个模型能不能做这次任务要它做的事？ | `CAPABILITY_MISSING` | 响应里**有证据**的能力 vs `requiredCapabilities` |

**把它们合成一个"可不可用"的布尔值会造成两类具体故障：**

1. 一次 TCP 握手成功被当成"模型可用"，于是真实的运行在**第一次推理**时才失败
   ——那时已经认领了任务、烧掉一次尝试，而错误出现在运行日志里，不在配置页上。
2. 一个连得上、认得钥匙、但**不支持 tools** 的模型被判定为可用，于是整条依赖
   工具调用的运行会在中途崩，而配置页显示"通过"。

> `SECRET_UNAVAILABLE` 表示本地凭证库或账户问题，`AUTH_FAILED` 表示供应商拒绝已成功解析的凭证，两者不得混为一类。

两者的**修复动作完全不同**：

| 码 | 含义 | 下一动作 |
| --- | --- | --- |
| `SECRET_UNAVAILABLE` | 钥匙可能就在这台机器上，只是解不开（DPAPI 换了用户、keyring 损坏、ACL 变了） | 查本机密钥库。**不要**去供应商控制台换钥匙 |
| `AUTH_FAILED` | 钥匙**成功解析**了，供应商明确拒绝 | 换钥匙或查权限。本机密钥库是好的 |

混成一类的代价很具体：运维拿着"鉴权失败"去供应商控制台轮换一把**好**钥匙，
而真实原因是本机 DPAPI 换了账户作用域——新钥匙同样解不开，而"解不开"这个
线索被一次无关的轮换掩盖了。

代码里这条纪律落在**结构**上，不落在注释上：

```js
try {
  credential = await resolveSecret(profile.secretRef, profile)
} catch (err) {
  return { observed: { ok: false, code: 'SECRET_UNAVAILABLE', ... } }   // 本地问题
}
// ...只有解析成功之后才去敲供应商的门
const raw = await transport({ profile, credential })
// transport 拿到 401 → classifyHttpStatus(401) = 'AUTH_FAILED'          // 供应商拒绝
```

**解不开钥匙时根本不发请求**（有用例断言 `transport.calls.length === 0`）。
少敲一次供应商的门只是顺带的好处；真正的理由是：一旦发出去了，那次 401
就会成为一条"鉴权失败"的证据，而它其实什么都没证明。

---

## 2. 五条判定

### ① 处置类别决定下一动作，而不是具体码

```js
PROBE_CODE_CLASS = {
  SECRET_UNAVAILABLE: 'fail-closed',   // 停下，让人处理。不许绕过、不许重试
  SECRET_REF_MISSING: 'config',        // 改配置
  AUTH_FAILED:        'config',
  TLS_FAILED:         'config',        // 证书重试一百次也一样
  MODEL_NOT_FOUND:    'config',
  BAD_RESPONSE:       'config',
  CAPABILITY_MISSING: 'config',
  ENDPOINT_UNREACHABLE: 'transient',   // 稍后重试有意义
  RATE_LIMITED:       'transient',
  PROVIDER_ERROR:     'transient',
  TIMEOUT:            'transient',
  UNCLASSIFIED:       'unknown',       // 不许当可用，也不许静默重试
}
```

**TLS 刻意不是 transient。** 归成 transient 会让调用方去重试一个永远失败的
东西；而它真正的含义是本机信任链或中间人，值得有人看一眼。

**未知码 → `unknown`，不默认成 transient。** 默认成 transient 会让一个没人
想过的失败被静默重试，而重试是把一次可诊断的故障变成一串噪声的最快方式。
类别映射与码集合**一一对应**（有用例断言），缺键会让
`PROBE_CODE_CLASS[code]` 是 `undefined`，而 `undefined` 在判断里通常是 falsy。

### ② 主动取消不是失败分类

```js
classifyFailure({ kind: 'abort' }) // → null，不是失败码
```

把取消硬塞进某个码，会让一次正常取消在审计里看起来像连通性事故。
取消**不进缓存**（一次取消不该让接下来的探测被跳过），判定结果仍是 `ok: false`
（取消不是可用的证明），但带 `cancelled: true` 让调用方分得开。

### ③ 能力必须**有据可依**，没有证据就什么都不说

供应商的 `/v1/models` 响应大多数**根本不报能力**。这时唯一诚实的答案是
"没有证据"——返回空表，而不是一份猜测。

猜的代价是双向的：猜错成"支持 tools"会让依赖工具调用的运行在半途崩；
猜错成"不支持"会让一个本来能用的模型被排除在候选链之外。**两种都比"不知道"
更糟**，因为"不知道"至少会让调用方去问一次知道的人。

因此 `capabilitiesFromModelRecord` 只提取响应里**明确写了**的东西，每条都有
可追溯的来源：

| 证据 | 能力 |
| --- | --- |
| 出现在模型清单里 | `chat` |
| `supported_parameters` 含 `tools` / `response_format` / `reasoning` | `tools` / `json` / `reasoning` |
| `architecture.input_modalities` 含 `image` | `vision` |
| `context_length >= 100_000` | `long-context` |

未知的 `supported_parameters` 条目**忽略**（不猜）。能力集是封闭的
（`chat / tools / vision / json / long-context / reasoning`）——开放集合会让
"要求了某个能力"与"供应商报的能力"无法比较（拼写不同就永远不匹配，
而界面看起来两边都写了）。

**能力声明必须严格为 `true`。** 供应商常写 `"tools": "yes"` / `1` / `"true"`；
都放行会让一个其实不支持的模型被选进链。未声明的能力**不在**对象里
（不是 `false`）："没声明"与"声明为否"在诊断上必须能分开。

### ④ 判定顺序：观测失败时**不去看能力**

```js
if (observed.ok !== true) → 直接失败，带上它的码
else if (缺能力)          → CAPABILITY_MISSING
else                     → OK
```

顺序是刻意的：一个连不上的模型"具不具备 tools"没有意义，报"缺 tools"会把
真正的问题（连不上）盖掉。

### ⑤ 缓存：成功长、失败短，且按**配置指纹**分桶

```js
PROBE_TTL_MS = 5 * 60 * 1000           // 成功
NEGATIVE_PROBE_TTL_MS = 30 * 1000      // 失败，刻意短
```

对称缓存会带来一个具体的坏体验：11:00 供应商抖了一下，探测失败并被缓存一小时；
11:05 供应商恢复了，而配置页在整个小时内持续显示"连不上"，用户于是去改一个
根本没问题的 endpoint。失败缓存的意义只是"别让一个坏配置把探测按钮打成
DDoS"——30 秒足够，不需要一小时。

**指纹（`probeFingerprint`）回答"这份判定是针对哪一套配置做的"**，取
provider / model / endpoint / runtimeType / secretRef **的名字** / reasoningEffort。
少了它就会出现：给模型 A 探测成功，然后把档案改成模型 B（同一个 id），
于是界面拿着 A 的"通过"给 B 用——**一次从未发生过的成功变成了一条可用性证明**。

指纹**不含密钥值**（档案里本来也没有），但含 `secretRef` 的**名字**：
从"有凭证"改成"无凭证"必须让缓存失效。

时钟倒流（`nowMs < probedAtMs`）按**不新鲜**处理：一份"来自未来"的缓存没有
可信的年龄，继续用它等于拿未知年龄的判定下判断。

**缓存有界**（默认 200 条，LRU 淘汰）：配置页反复试不同 endpoint 不该无上限
撑大内存。

---

## 3. 为什么用"列模型"而不是"发一次推理"

两种都验证得了连通性与鉴权，但代价差一个数量级：

- 列模型（`GET {endpoint}/v1/models`）—— 几乎不花钱，通常 < 1s；
- 最小推理 —— 按 token 计费，且会把一次真实生成记进供应商侧用量。

配置页上的"测试连接"是用户会**反复点**的按钮。让它每次点都花钱，结果一定是
没人敢点——**而一个没人敢点的验证按钮等于没有验证**。真正要花钱的能力验证
（工具调用能否真的跑通）属于真实运行，不在配置页里做。

---

## 4. 为什么 transport 与凭证解析都是注入点

```js
createModelProbe({ transport, resolveSecret, clock, ttlMs, negativeTtlMs, maxEntries })
```

- `transport` 注入 → 测试用假 transport 就能覆盖**全部**失败分类
  （401/403/404/429/5xx/连不上/TLS/超时/主动取消），**不需要网络**。
- `resolveSecret` 注入 → 契约 §6.7 要求"Runtime 在获得授权后按需解析密钥"，
  所以执行器**从不自己读密钥库**：它只知道有一个函数能把 `secretRef` 换成
  一次性凭证。这让"密钥从哪来"可以独立演进（DPAPI / Credential Manager /
  未来的 ACL 方案），也让本模块的测试里**根本不存在真实密钥**。

两处都**必需**（`transport` 缺失时构造直接抛 TypeError）：没有它就无法真的问
一次，而**"没问过"绝不能被当成"可用"**。

假 transport 全绿只证明"分类对"，不证明"真 transport 能把真实响应归一化成
正确的 `{kind, status}`"。所以另有一组用例起**真的本机 HTTP 服务**：
`{kind:'http', status:401}` 与 `fetch` 实际拿到的 401 之间隔着响应解析、
重定向、正文读取这些步骤，每一步都能把码搞错。

---

## 5. 凭证的三条结构保证

1. **凭证不进判定、不进缓存、不进诊断。** 凭证在局部作用域里传进
   `transport`，出来时只剩码与耗时。有用例把整个判定与 `inspect()` 序列化后，
   用真实密钥字面量**与仓库自己的 `findPlaintextSecrets`** 双重检查。
2. **解析失败的原始 message 不外带。** 密钥库异常里可能带着被解密的片段、
   路径或账户名（如 `account=DESKTOP\alice`、密文 base64）。只保留
   `name/code` 这类类别信息——诊断价值由"哪一类失败"提供，而不是由原文提供。
3. **失败响应正文不读。** 部分供应商会把被提交的凭证回显在错误正文里，
   而这份观测最终会进诊断。分类只需要状态码，所以只取状态码。

---

## 6. 抓到的问题（全部先验过会变红）

这一批的实现一次通过，但**测试本身**抓到了四个错误，其中两个是我的测试写错、
两个是真实的设计缺陷：

### ① 我的断言索引错了对象（测试缺陷）

`capabilitiesFromModelRecord` 返回 `{capabilities, evidence}`，而我在四条断言里
写的是 `capabilitiesFromModelRecord(rec)['long-context']` —— 少了 `.capabilities`。
值永远 `undefined`，断言永远失败。**这类"测试写错了"和"代码坏了"在输出上完全
一样**；定位它的方法是在断言旁边把同一个表达式 `console.log` 出来，于是两种
可能立刻分开。

### ② 假 transport 把"抛异常"与"返回观测"混了起来（测试缺陷）

我的测试助手把 `{code:'ENOTFOUND'}` 当成"返回的观测结果"而不是"抛出的异常"，
于是 `normalizeTransportError` 那条路径**根本没被测到**——而它是
`ENDPOINT_UNREACHABLE` / `TLS_FAILED` / `TIMEOUT` 全部分类的唯一入口。

修法是收紧助手约定：**返回值里有 `kind` 的才算观测，其余一律抛出**——
因为真实 transport 就是这么做的（连不上时它不会"返回一个连不上"，它抛）。

### ③ TTL 边界断言写反（测试缺陷）

`isProbeFresh` 用严格小于，所以"正好到期"已经算不新鲜。我原本断言它仍命中
缓存。这正是那条边界的**意图**（恰好到期的判定不该继续被当成新鲜的），
所以修的是断言，不是代码。

### ④ `fetchImpl: null` 的行为与断言不符（真实语义问题）

`fetchImpl ?? globalThis.fetch` 把 `null` 当成"没提供"而回落到全局 fetch。
这是**有意**的（`null` 的含义是"没提供"，不是"提供一个空的"），但我的断言
要求它抛错。真正危险的失败模式不是"传了 null"，而是**运行环境根本没有
fetch**——所以用例改成临时删掉 `globalThis.fetch` 再断言构造失败。

---

## 7. 八条判定的"变红"验证

用 `break-probe.mjs` 逐条改坏源码、跑对应套件、确认变红、再还原：

| 改坏的东西 | 变红 |
| --- | --- |
| 把"本地密钥库解不开"报成 `AUTH_FAILED` | ✔ |
| 能力声明接受模糊真值（`"yes"` / `1` / `"true"` 都算具备） | ✔ |
| 未知码默认成 `transient` | ✔ |
| TLS 失败归成 `transient` | ✔ |
| 成功与失败用同一 TTL | ✔ |
| 指纹不含配置（给 A 探的成功被 B 继承） | ✔ |
| 模型清单里没有也判成功 | ✔ |
| 能力凭空产生（没有证据也报 `chat`） | ✔ |

---

## 8. 未交付

- **没有接到配置页上。** 本批交付的是探测的完整实现，但 Workbench 的
  "测试连接"按钮、以及 team-hub 侧的探测路由都**还没有**。也就是说：
  spec 那条"连通性、模型可用性和能力验证"目前还只是**可被调用**，
  不是**已被调用**。界面属于 PRT-507。
- **探测路由没有落在 team-hub 上。** 这是**有意**的：探测要解密钥，而 spec
  §6.7 说"Runtime 在获得授权后按需解析密钥"、team-hub 只保存 `secretRef`。
  所以探测属于 Runtime 侧；team-hub 若要暴露它，应当**委托**给 Runtime 的
  适配器，而不是自己读密钥库。这条委托线未接（属 PRT-505/509）。
- **`createHttpTransport` 只实现了 OpenAI 兼容的 `/v1/models`。** 其它供应商
  （Anthropic / Gemini 原生协议）需要各自的 transport。协议差异被隔离在
  transport 这一层，所以新增一个不影响分类与判定。
- **能力发现依赖响应自报。** 大多数供应商不报能力，于是"要求 tools"的探测
  会得到 `CAPABILITY_MISSING`——**这是正确的**（没有证据就不能说具备），
  但产品上需要一条人工声明能力的路径来补。`ModelProfile` 的字段是封闭的
  （PRT-501，未知字段拒绝），所以那条路径需要一个**独立的**存储，
  不能在档案里加一个 `capabilities` 字段。
- **`validateProfile`（DSH 适配器）仍然不探测。** 它现在明确写着
  "不真的调用模型：验证只回答「配置是否可用」"。这句话本身是对的，但它意味着
  适配器层与模型层的"可用"是两个不同的判断，二者**尚未打通**。
- **`requiredCapabilities` 没有来源。** 判定支持它，但员工/岗位/任务配置里
  目前没有任何地方声明"这次需要 tools"。在它接上之前，实际调用应当传空数组
  （即只验连通与可用性）。
- **没有熔断。** 连续失败不会让探测退避；一个挂掉的供应商会被每次点击重新
  探一遍。失败 TTL 是当前唯一的保护。
- **没有把探测结果记进审计。** 探测是一次对外调用（配置页的"测试"），
  但目前只在内存里留了 `attempts` 计数，没有落库。配置页要显示
  "上次测试于何时、结果如何"就需要它（PRT-507）。

---

## 9. 复跑方式

```bash
node --test runtime/contracts/model-probe.test.mjs   # 18 例，纯分类与判定
node --test runtime/probe/probe.test.mjs             # 22 例，假 transport
node --test runtime/probe/http.test.mjs              # 19 例，起真 HTTP 服务
node scripts/ci/run-ci.mjs --only test               # 全套
```
