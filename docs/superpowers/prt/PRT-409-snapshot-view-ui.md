# PRT-409（最后一件）：上下文快照查看界面

> spec line 897：「`PRT-409`：持久化快照并支持查看和导出。」
> 阶段 4 完成标准：「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因。」

持久化、查看读取路由、导出、保留策略与墓碑都已交付。
本文记录**界面**——原文三件缺口里的最后一件。

---

## 1. 这一屏要回答的问题

它不是"把一份 JSON 显示出来"，而是"**让我相信屏幕上这一份就是模型当时看到的**"。

所以布局上最要紧的三件事都不是排版问题，而是**可信度**问题：

| # | 要求 | 不说出来会怎样 |
| --- | --- | --- |
| ① | 验证结论是**三态** | "没验过"与"验过了通过"长得一样 = 把未经校验的展示伪装成校验过的 |
| ② | **三本账**必须显式说出来 | 一份**截断过的**快照只显示正文，用户会以为模型读完了全文 |
| ③ | 被清掉的快照是**单独一屏** | "存在过但被清掉"与"你查错了 id"在屏幕上长得一样 |

全部判定抽进 `workbench/src/snapshotView.ts` 的纯函数，用 `node --test` 钉住；
`workbench/src/components/SnapshotView.tsx` 只负责取数与渲染。
这与 `browserUi.ts` / `filesUi.ts` / `notify.ts` 的形状一致。

---

## 2. ★ 验证三态

`?verify=1` 的响应里有 `verification: {ok, storedHash, recomputedHash}`。

```ts
verifyVerdict(detail) → 'ok' | 'mismatch' | 'unverified'
```

`verification` 缺席时给 **`unverified`**，不是 `ok`：

> 一个"没验过"的快照，与一个"验过了且通过"的快照，
> 在只显示一个绿色对勾的界面上是同一个东西——
> 只不过前者会让用户以为有人检查过。

还有一条更锋利的：**`ok: true` 但两个哈希字段互相矛盾时仍然判 `mismatch`**。

> 一个"结论说通过、而证据字段互相矛盾"的结果，不能按通过处理。

`snapshotPath()` **永远**带上 `verify=1`，不做成可选参数：

> 一个"默认不验、想看才验"的查看界面会让绝大多数人看到的是**未被校验过**的内容，
> 而界面上没有任何东西提示这一点。

---

## 3. ★★ 三本账住在 `snapshot.*` 里——这是实测出来的

**这是本批最有价值的一条发现。**

`GET /api/context-snapshots/:id?verify=1` 的顶层只有**计数**
（`candidateCount` / `includedCount` / `excludedCount` / `truncationCount`），
而 `excluded` / `truncations` / `redactions` / `segments` / `finalText`
全部住在 **`snapshot.*`** 里。

第一版模块从**顶层**读账本，于是 `Array.isArray(undefined)` → `[]` → "排除 0"。
后果是**方向性**的：

> 一个"从错误的层级读账本、于是永远读到 `undefined`"的界面，
> 与一个"这份快照确实没有排除任何来源"的界面，长得一模一样——
> 只不过前者会在一次越权过滤之后，向用户显示"来源已完整清点"。

所以分两层防线：

1. `ledgersOf(detail)` 只认 `snapshot.*` 一层，**不偷偷回落到顶层**；
2. 它区分**"键在且是空数组"**与**"键根本不在"**，后者报 `contractBroken`，
   界面上显示"账本读不到：屏幕上显示的 0 是**读错了地方**"。

用例里有一条专门钉住这个位置：先断言顶层 `d.excluded === undefined`，
再断言越权过滤在界面上显示为**排除 1**而不是 0。

### 3.1 守恒与"部分包含"

```ts
balanced      = candidateCount === includedCount + excludedCount
partial       = truncationCount > 0 || budgetTrimmed
contractBroken = 三本账的键不在
```

`balanced` **单独算出来并显示**，而不是只把三个数字并排——
守恒断言是 PRT-407 的核心不变量，而**看的人是不会有意识去做这个加法的**。

`partial` 是"部分包含"这第三种状态：整份进了 / 整份没进 / **进了一部分**。
只看 `includedCount` 会把第三种读成第一种。

### 3.2 未知的排除理由必须看得出来

`unknownReasons()` 把界面不认识的 `reason` 挑出来并在界面上说出来：

> 一个新的、可能很重要的排除理由（比如"这份来源被策略禁止外发"），
> 在回落到"其他原因"的界面上与一句废话等价。

有一条用例把界面理由表与后端 `EXCLUSION_REASONS` **逐一对齐**
（数量也必须相等——界面不该自己发明后端没有的理由）。

---

## 4. ★★ 三态必须在**样式上也**分得开

组件第一版写：

```tsx
className={verdict === 'ok' ? 'ok' : verdict === 'mismatch' ? 'err' : 'warn'}
```

而本仓库的 `index.css` 里**没有**独立的 `.ok` / `.warn` / `.err`——
只有 `.toast.err`、`.state-box .err` 这类复合选择器。
于是三个状态渲染出来**是同一个样子**。

> 一个"算出了三种状态、而它们共用一套灰底"的界面，
> 与一个"只算了一种状态"的界面，对用户是同一个东西——
> 只不过前者的代码里写着 `verdict === 'mismatch'`。

修法：新增 `.snapshot-view .snap-verdict.ok/.warn/.err`（**各有不同的底色与左边框**）
与 `.snap-note.warn/.err`，并加三条用例：

1. 三个类的 CSS 规则都存在；
2. 三条规则**两两不同**（"校验通过"与"哈希对不上"不能长成一样）；
3. 每条都有自己的 `background` 与 `border-left-color`，而不是只改文字。

外加一条：**组件里不许再用裸 `.ok` / `.warn` / `.err`**——
裸 class 在本仓库没有独立定义，会渲染成无样式。

---

## 5. ★ 410 不是"没找到"

`readSnapshotResponse(status, body)` 归一出**四屏**：
`list` / `detail` / `purged` / `missing`。

`410` 一律归成 `purged`，**即便 body 里的 `code` 写着 `CONTEXT_NOT_FOUND`**：

> 一个被中间层改写过的 `code` 不该让界面把 410 当成"没有"。

反过来也钉住：`404` 就是 `missing`。

墓碑缺失（410 但没带 `tombstone`）**仍然不降级成 `missing`**：

> 墓碑缺失是后端的问题，而"存在过"这个事实由**状态码**确认了。

`tombstoneText()` 必须说出真正的后果——「**这次的输入已经无法还原**」，
而不只是"已清理"。用例断言这句话在、且墓碑里没有正文。

---

## 6. ★ 组件不许自己重算哈希

有一条用例禁止 `SnapshotView.tsx` 里出现 `createHash` / `subtle.digest` / `sha256(`：

> 一个在前端重算哈希的实现会造出第二个事实来源，
> 而它与后端不一致时，界面不知道该信谁。

界面只**呈现并区分**后端给的两个哈希是否相同。

另有一条用例逐个确认模块的导出（`verifyVerdict` / `ledgerView` / `ledgersOf` /
`segmentViews` / `textPreview` / `unknownReasons` / `tombstoneText` / `countsText` /
`listRows` / `screenFor` / `exportPath`）在组件里**有调用点**：

> 一个"写好了判定、没接进界面"的模块，与一个"没写过"的模块，
> 对用户是同一个东西。

---

## 7. 其它判定

- **分段有洞要算出来**：`segmentViews()` 按 `from` 排序后求相邻缺口。
  有洞意味着那些字符**不属于任何来源**，而它们确实被发给了模型。
- **`countsText` 必须显示 `everRecorded`**：
  > 一个"清理之后总数下降了"的报表，与一个"证据悄悄丢了"的报表，
  > 在只看一个数字的人眼里是同一个东西。
- **`retentionView().bounded`**：不设上限与"有上限但恰好没超"的
  `purgeCount` 都是 0，数字完全相同——而它们意味着完全不同的未来。
- **`bytesText` 用字节**：与保留策略同一条纪律（中文 1:3），
  界面上显示字符数会让人以为一份 3 MB 的快照只有 1 MB。
- **`listRows` 的"⚠ 缺哈希"标记**：
  > 一份没有哈希的列表项在界面上与一份有哈希的看起来一样，
  > 而前者无法用于任何比对。
- **正文预览截断时说清楚**（显示前 N 字符 / 全文 M 字符），
  不让预览看起来是全文。

---

## 8. 接线

| 位置 | 改动 |
| --- | --- |
| `workbench/src/snapshotView.ts` | 新增（纯判定层） |
| `workbench/src/components/SnapshotView.tsx` | 新增（组件，含详情面板） |
| `workbench/src/components/Sidebar.tsx` | 新增导航项 `snapshots`（🧾 上下文快照） |
| `workbench/src/App.tsx` | 路由到 `<SnapshotView scope hubMode />` |
| `workbench/src/index.css` | 新增三态样式 |
| `workbench/scripts/snapshot-view.test.mjs` | 新增（**33 例**） |
| `scripts/ci/run-ci.mjs` | 注册套件 |

---

## 9. 验证

- 新增套件 `snapshot-view`（**33 例**，**起一个真的 hub**）。
- `npx tsc --noEmit` 通过；`npx vite build` 通过（`dist/` 未跟踪，由 CI build 阶段生成）。
- 六道门禁全 PASS；全量 CI 见 `docs/STATUS.md`。

### ★ 为什么这套件必须起真 hub

本模块的全部工作就是"拿 hub 给的响应决定屏幕上显示什么"，而
状态码、字段名、410 的形状、**三本账放在哪一层**，只能由真 hub 回答。

> 一个用假 hub 喂出来的「界面已验证」，
> 与一个从没发过那次请求的「界面已验证」，是同一个东西，
> 只不过前者的用例数是完整的。

§3 那条"住在 `snapshot.*` 里"的发现就是这个选择换来的：
用一个我**以为**对的假响应去喂，这条永远不会红。

---

## 10. ⚠️ 诚实边界

- **PRT-409 至此三件齐了**（持久化查看 / 导出 / 保留策略 / 界面），
  但仍有下面这些真缺口，所以它按项目口径不算"功能已完结"。
- **本批没有定时任务执行保留策略**：界面能**预览**计划、能**手动**执行，
  但没有任何调度在跑。「有策略但没人执行」与「没有策略」在磁盘用量上是同一个东西。
- **界面只能手动执行清理吗？** 不能——本批的界面是**只读查看**，
  没有接 `POST /api/context-snapshots/purge`。删除是一件需要在
  有明确确认流程的地方做的事，本批不做，以免"查看界面里有一个删除按钮"。
- **不做权限检查**：与 hub 现有读路由一致的本机回环信任模型。
- **分段的洞只报数量**，不指出洞里的字符是什么（那需要重新对齐
  `finalText` 与分段的偏移，而偏移的权威在后端）。
- **前端不重算哈希**，所以后端如果同时在两端出错，界面看不出来。
- **`workbench/dist` 是构建产物**（未跟踪），本批没有改动它的构建配置。
