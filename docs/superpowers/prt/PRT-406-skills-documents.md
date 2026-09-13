# PRT-406　接入已发布 Skills 与显式文档

> 状态：✅ 完成（2026-09-13）
> 依赖：PRT-401（候选来源）、PRT-402~405（其余来源族）、PRT-408（来源清单）、PRT-412（不可信来源不得改变审批策略）
> 对应 spec：§6.5「上下文来源」中的 `skill` 与 `document` 两族

---

## 0. 这条任务原本卡在哪

进度行里有一条**自己写下的**未交付：

> 没有产品侧调用点去传 `skillTrust`/`documentTrust`，
> **运维安装的 skill 目前也被当外部内容**。这是保守的一侧，但是个真缺口。

"保守的一侧"这个说法是对的，也是**误导的**。它读起来像一次审慎的取舍，
实际上它是靠一件别的事换来的：

**`origin` 这个字段此前在库里根本不存在。**

于是"运维安装的系统内容"与"成员登记的外部内容"在数据上**本来就分不开**。
没有可传的值，也就无所谓"传不传"。整条任务因此不是一个"补一个参数"的活，
而是要把这两类内容**先变成可区分的数据**，再让可信性判定**逐条**发生。

> 一个"因为分不开所以一律按外部内容处理"的系统，
> 与一个"压根没打算区分"的系统，在每一条内容都来自成员时是同一个东西——
> 只不过前者会让那个缺口看起来像一次**安全取舍**。

第二条缺口更直白：`documents` 一直是硬编码的 `[]`，
因为 hub 上**没有文档的读端点**。来源清单里那一格如实写着 `not-attempted`，
外加一句"hub 上没有显式文档的读端点"。那句话是真的。

---

## 1. 交付了什么

### 1.1 `origin`：谁把它放进来的（hub 写死，客户端改不动）

`skills` 与 `documents` 两张表各有一列 `origin`：

| 取值 | 含义 | 写入路径 |
|---|---|---|
| `'member'`（默认） | 团队成员登记 / 从仓库读来的 → **外部内容** | `POST /api/skills/register`、`POST /api/documents` |
| `'operator'` | 运维安装 → **系统内容** | `installSkill()` / `installDocument()`（本机 CLI，不经 HTTP） |

**两条写入路径各自硬编码一个值，谁都不读 `input.origin`。**

这不是风格问题，是这条功能的**安全前提**。如果 `origin` 来自请求体：

```
成员 → POST /api/skills/register { origin: 'operator' } → 系统内容
```

任何拿得到 token 的人都能把自己的技能**升格成系统指示**，
而下游的可信性判定正是按这个字段做的。

> 一个"由提交者声明自己可信"的来源字段，
> 与一个"任何人都可以自称可信"的字段，在没人恶意提交的时候是同一个东西——
> 只不过前者会把**信任这件事，交给被信任的那一方去填**。

默认值取 `'member'`（不可信那一侧）也是刻意的：迁移前就存在的那些 skill
都是成员登记的，把"老数据"默认成系统内容等于用一次迁移给全部历史内容升格。

### 1.2 为什么"运维安装"是 CLI，不是一条路由

`team-hub/scripts/install-skill.mjs`：

```
node team-hub/scripts/install-skill.mjs --skill    <file.json>
node team-hub/scripts/install-skill.mjs --document <file.json>
```

做成路由的话，任何 token 持有者都能调用它，于是"运维安装"这个名字
就成了一句谁都能说的话——而它正是"系统内容"的**唯一依据**。

> 一个"任何 token 持有者都能说自己是在安装系统内容"的入口，
> 与一个"系统内容由部署者写入"的入口，在没人滥用的时候是同一个东西——
> 只不过前者会让"系统内容"这个身份，变成一句**客户端自己填的声明**。

"运维安装"这件事的真实边界是**文件系统**，不是 HTTP token。
能跑这个脚本的人，本来就能直接改数据库。

装进来的东西直接 `published`：运维装进来的**已经是他审过的**，
再走一遍复审队列只会让人以为"运维的安装也需要另一个成员批准"。

CLI 还有一条刻意的严格性：**带 BOM 的 JSON 文件直接报错，不静默剥离**。
带 BOM 的文件多半是被人用记事本或 PowerShell `Set-Content -Encoding UTF8`
存出来的，那意味着这个文件**曾被别的工具改过**；静默吃掉 BOM 会把这个信号抹掉。

### 1.3 逐条判定：`trustForOrigin` 与 `trustOfPublishedItem`

`runtime/context/sources.mjs` 导出两个**不同**的函数：

| 函数 | 投影 | 用途 |
|---|---|---|
| `trustForOrigin(origin)` | `'operator' \| 'member' \| …` → 可信性 | 判定**规则**本身 |
| `trustOfPublishedItem(item)` | 条目对象 → 可信性 | 传给 `publishedSources` / `collectCandidates` 的**适配器** |

`publishedSources` 的 `trust` 参数现在接受**函数**（也仍接受单值），
按条目逐个求值并**逐条校验**返回值；判定返回怪值时**抛错**，
不默认成 untrusted：

> 一个"悄悄往安全一侧倒"的兜底，
> 与一个"把这件事说出来"的抛错，在兜底永远不倒错的时候
> 是同一个东西——只不过前者会让一个真 bug 看起来像一次正常判定。

`collectCandidates` 的缺省就是 `trustOfPublishedItem`，所以
`loadSources` 的输出（含 `skills` / `documents` 两条**带 `origin`** 的数组）
直接喂进去即可，两类来源在**同一次调用**里各拿各的可信性。

### 1.4 显式文档的数据面（新）

| 面 | 内容 |
|---|---|
| 表 | `documents(id, title, path, body, scope, origin, version, sha256, createdAt, updatedAt)` |
| DAO | `listDocuments` / `registerDocument` / `getDocument` / `deleteDocument` / `installDocument` |
| 路由 | `GET /api/documents`、`POST /api/documents`、`POST /api/documents/delete` |
| 装载器 | `sources-loader.mjs` 真的去读 `/api/documents`，`documents` 不再是 `[]` |
| 清单 | `documents` 那一格由 `outcomeFor()` 算出（`read` / `read-empty` / `read-failed`） |
| 覆盖账 | `/api/documents` 进 `availability().consumed` |

与 `skills` 的**刻意不同**：

- **没有状态机**。skill 走「登记 → 复审 → 发布」，因为它会被员工当指令执行；
  文档是**参考资料**，登记即生效。给它加一道复审队列只会让人以为
  "文档也需要批准"——而审批的真实边界是 ToolGuard 与权限栈，不是这张表。
- **正文随条目返回**。文档的全部用处就是它的正文。正文进上下文是一个
  **预算**决定，所以截断发生在装配侧并记理由，而不是在这里悄悄砍掉。
- **预算更紧**（`maxDocuments: 20` vs `maxSkills: 50`）：技能条目只是一个
  prompt 引用，文档的每一条都**带着正文**，同样的条数对 token 预算的压力差一个量级。
- **删除是幂等的**（不存在时返回 `deleted:false`，不抛 404）。
- 审计 detail **不带正文**，只记 `bodyBytes`：审计是"谁改了什么"的记录，
  把 body 塞进去等于给每一份文档另存一份全文（还包括被删掉的那些）。

### 1.5 来源清单的 detail 报**来源构成**，不只报条数

`originBreakdown()` / `originsPhrase()`：`skills` 与 `documents` 的清单
detail 现在形如「读了：2 条运维安装的（系统内容）+ 5 条成员登记的（外部内容）」。

只报条数的话，`count: 3` 无法回答"这 3 条里有没有运维安装的"，
而那一件事恰恰决定了它们在上下文里是系统内容还是外部内容。

> 一个"只报条数"的清单，
> 与一个"报条数、但那些条数的身份无从查起"的清单，在两种来源同数时
> 是同一个东西——只不过前者会让人以为已经清点过了。

**计数用的是 `trustForOrigin`，不是 `it.origin === 'operator'`。**
两处判断迟早分叉，而分叉之后"清单里说系统内容几条"与
"装配器按系统内容处理几条"会不一致——那种不一致**没有任何用例会发现**，
因为两边的读数各自都是自洽的。

---

## 2. 本批**真的踩到**的坑（值得单独记）

### 2.1 传错投影函数：每条都静默落到 untrusted

第一版把 `trustForOrigin`（origin → 可信性）当逐条判定函数
（条目 → 可信性）传给了 `publishedSources`。收到整个条目对象时：

```
trustForOrigin({ id, name, origin: 'operator', … })
  → ({…} === 'operator') → false → untrusted   ← 每一条
```

它**不抛错**，方向还在安全的一侧，所以这不是漏洞——是**功能没生效**。

> 一个"传错了投影函数"的接线，
> 与一个"逐条判定确实生效了"的接线，在**没有任何一条是系统内容**的时候
> 是同一个东西——只不过前者会让"运维安装的内容按外部内容处理"
> 这件事，看起来像一次**保守的取舍**，而不是一次接线错误。

它唯一的可观测形态是"**没有任何一条是 trusted**"，所以只有**肯定性**断言
（"某一条**是** 可信的"）能发现它。一整套"不可信的就是不可信"的否定断言会全绿。

修复方式不是把 `trustForOrigin` 写成"能同时吃两种入参"，而是**新增一个
名字明确的适配器** `trustOfPublishedItem`，并在测试里钉住
"两种传法**必须**给出不同结果"。

### 2.2 探针 ㉛ 第一次没咬住 —— 它揭开的是一个真实覆盖缺口

把装载器的 `skillTrust` 改成 `trustForOrigin` 后，`sources-loader.test.mjs`
**一片绿**。原因不是探针写错，而是那一套**只盯清单**（读了没有、几条），
**没有任何断言在看可信性**。

于是补了一条端到端用例（真 hub + 真路由 + 真装配），支点是一条肯定断言。
补完之后同一个探针 `fail=1`。

> 一个"只断言不可信的就是不可信"的测试套件，
> 与一个"判定函数被整体降级成 untrusted"的实现，
> 是同一个东西——只不过前者会让这次降级**永远是绿的**。

### 2.3 `sources-loader.test.mjs` 里原有的一个用例**红了，而且红得对**

`★★★ "没去读"与"读了但没有"在清单里分得开` 用 `documents` 当
"没去读"的例子（当时它确实没有读端点）。加了端点之后：

```
actual: 'read-empty'   expected: 'not-attempted'
```

红得对——**"hub 上没有显式文档的读端点"这句话过期了**。

> 一个把"还没做"当作例子的用例，会在那个功能做完的那天变成一条假话，
> 而它红得越晚，越可能被人当成"用例写错了"去改期望而不是改事实。

处理方式是把例子换成**确实仍然没有端点**的来源族（工作区状态是本机目录，
不属于 hub），而不是把期望改成 `read-empty` 了事。

### 2.4 探针锚点被自己的改动弄失效（⑥③）

`documents` 那一格从硬编码 `NOT_ATTEMPTED` 变成 `outcomeFor(...)` 算出来的，
而探针 ⑥③ 的锚点还是老文本 → **锚点未找到 → 探针静默变成"无效"**。

锚点找不到时探针**不报错**，这一点和"这段代码没有用例在守"在报告里长得一样。
所以每次改动被探针指着的代码，都要回头确认那些锚点还在。

### 2.5 一个手误：`edit` 时把相邻行一起删了

本次会话里发生过两次：`old_string` 只写了锚点行，而 `new_string` 里漏抄了
紧随其后的一行（`ensureColumn('tasks','expiresAt',…)`、`grantSkill` 的
`const merged = …`）。两次都靠 `git diff | Select-String '^-[^-]'`
（只看删除行）发现并还原。

教训：**改大文件时，检查删除行比检查新增行更能发现手误**——
新增行总能在 diff 里被看见，而被顺手删掉的那一行不会。

---

## 3. 诚实边界（本批**没有**做到的）

1. **`origin` 不含内容哈希。** 改内容会 bump `version`，但把一份运维安装的
   文档改写成成员版本（或反之）需要显式调用对应的写路径。同 `id` 的
   "先成员登记、后运维安装"会让 `origin` 变成 `'operator'`（有断言钉住）。
2. **没有 origin 的审计流水。** `document:register` / `document:delete`
   进审计，但没有一条独立记录说"这次把 origin 从 member 改成了 operator"。
3. **运维安装没有签名校验。** CLI 只验 JSON 形状与 id 格式；
   "这份文件真的来自运维"这件事落在文件系统权限上，产品层不验。
4. **文档没有版本历史。** 只有当前行，改了就覆盖；`version` 单调递增，
   但拿不回旧正文。
5. **文档没有删除审计的正文快照。** 审计记 `title` / `version`，
   不记正文——这是刻意的（§1.4），但意味着**误删之后内容找不回来**。
6. **`maxDocuments`（20）与 `maxSkills`（50）是按条数截断的**，
   不是按字节。一份超长文档仍然会占满预算——截断发生在装配侧，
   而这里只保证"不去读第 21 份"。
7. **`origin` 只有两个取值。** 从仓库同步来的 skill（`/api/skill-source`）
   走的是登记路径，因此是 `'member'`。如果将来要区分"从仓库来的"与
   "本成员手写的"，需要新增取值——而 `trustForOrigin` 的判定方向
   （只认 `operator`）保证新增取值**不会静默获得可信身份**。
8. **`LEGION_TOKENIZER_DIR` 那一类"读一次就定"的接线不适用于本批**，
   但 `documents` 的表是在模块加载时建的——与本项目其余表一致，
   没有迁移版本号。
9. **`/api/documents` 的 GET 没有鉴权**（与 `/api/skills` 同口径：
   读面鉴权整体由 `readAuthRequired()` 那一道闸门管，不在这里重复）。
   `origin` 是服务端写死的字段，所以读面暴露它不构成提权。

---

## 4. 断验证

83 个探针全部咬住，0 无效，0 没咬住，源码**逐字节还原**通过。

本批新增 14 个（㉑~㉞）：

| 探针 | 改什么 | 读数 |
|---|---|---|
| ㉑ | `trustForOrigin` 改成"不是 member 就可信" | fail=2 |
| ㉒ | `trustOfPublishedItem` 投影错（拿条目当 origin） | fail=4 |
| ㉓ | 判定返回怪值时默认 untrusted（静默降级） | fail=1 |
| ㉔ | `registerSkill` 采纳 `body.origin` | fail=3 |
| ㉕ | `installSkill` 的 UPDATE 忘带 `origin='operator'` | fail=1 |
| ㉖ | `registerDocument` 采纳 `body.origin` | fail=2 |
| ㉗ | 文档同内容也 bump version | fail=1 |
| ㉘ | 文档 scope 过滤失效 | fail=1 |
| ㉙ | 文档 title/body 都空也放行 | fail=1 |
| ㉚ | 文档 id 不校验 | fail=1 |
| ㉛ | 装载器传错投影函数（生产侧） | fail=1（**第一版 fail=0，补用例后才咬住**） |
| ㉜ | 装载器不再读 `/api/documents` | fail=1 |
| ㉝ | `documents` 清单读数又写成 not-attempted | fail=33 |
| ㉞ | `consumed` 里删掉 `/api/documents` | fail=1 |

其中 ㉕ 钉的是"**先占 id**"这条路：`installSkill` 的 UPDATE 若忘了带
`origin='operator'`，那么"先把 id 占住、等运维来装"会让那次安装**静默地保持
member**——而安装命令的输出仍然会打印 `origin=operator`（它读的是返回值）。

> 一个"UPDATE 忘了带 origin"的实现，
> 与一个"运维安装确实生效了"的实现，在没人先占 id 的时候
> 是同一个东西——只不过前者会让一次系统内容的安装
> **看起来成功了**，而那条内容仍然是外部内容。
