<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 3：第三族（chat / 对话中心）—— 第一次用**生成器**搬运

> 业主 2026-09-20 裁决：「乙：按一片一次对拍开工」，照 `PRT-315` 先例逐片提取。
> 硬约束（`spec :1282`）：**每片能独立对拍与回滚**。
> 切片 1 = `slice-01-routing-seam-rules.md`（`db8e2cc`）；切片 2 = `slice-02-permissions-family.md`（`3aec3cd`）。

## 0. 这一族是最大的一族，而且搬完它就"住满一个命名空间"

`server.mjs` 的这一段内部自带 **5 个小节**（会话与消息 / 附件 / 健康 / AI 回复），
共 **13 条**路由、131 行——是仅剩各族里最大的一族。它们的路径前缀是同一个 `/api/chat/`。

搬完这一片之后，**整个 `/api/chat/*` 命名空间只在模块里存在**，`server.mjs` 里不再有
chat 路由（`handle` 里同前缀残留实测 **0**）。

> 一个"把某前缀的路由搬走一半"的切片，与一个"搬完整个前缀"的切片，
> 在只搬了一半的那些天里是同一个东西——只不过前者会让下一个读代码的人
> 在两个地方各找一遍同一条路由。

## 1. 判据一：把"逐字保真"从**事后验证**改成**构造**

切片 1/2 是我手抄函数体，再靠对拍脚本事后验证。这一片换了做法：
`.worktrees/_prt-handoff/gen-chat-routes.mjs` **从原文件读出函数体直接生成模块**。

> 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。

生成器自己踩了两个坑，都留档，因为两次都长得像"整族路由丢了"：

1. **按注释文本定位边界**：`// ── 对话中心（chat）` 在 `server.mjs` 里出现 **3 次**
   （L1418 建表 DDL / L3075 DAO / L8364 REST 路由）。第一版取到 L1418，
   解析出 **0 条路由**、生成一个 71 行的空模块，而 **`node --check` 照样通过**。
   修法：先在 `handle()` 区间内定位。
   > 一个按注释文本定位边界的生成器，与一个"搬了错的区间"的提交，
   > 在 `node --check` 通过时是同一个东西——只不过前者搬的是建表 DDL。
2. **从"已经被搬空"的文件里再生成一次**：改完 EOL 后重跑，工作区的 `server.mjs`
   已经没有 chat 段了，于是又生成一个空模块。修法：源头改为 `git show <ref>:server.mjs`
   （ref = 搬走之前的那次提交）。
   > 一个从"已经被搬空"的文件里再生成一次的脚本，
   > 与一个把整族路由删掉的提交，在生成日志上是同一个读数——
   > 除非它自己声明该从哪个历史版本读。

另：输出模块强制 **LF**，与 `routes/rules.mjs`、`routes/permissions.mjs` 一致
（生成器的输入是 CRLF 的 `server.mjs`，若把 eol 带进输出，同目录下会出现两种行尾）。

## 2. 判据一（续）：对拍脚本本身也修了两处**太弱**的地方

`.worktrees/_prt-handoff/pair-routes.mjs` 这次通用化到三族，过程中它自己出了三个错：

| 症状 | 真相 |
| --- | --- |
| permissions 报"模块多声明了 1 条" | 旧侧正则要求 `===` 前有空格，而 `path.startsWith(` 没有；且 `startsWith` 形式有**两个**右括号 |
| chat 报"模块多声明了 9 条" | 取块方式是"注释到下一个注释"，而 chat 段**内部有 5 个小节注释** ⇒ 只取到第 4 条 |
| （上一片遗留） | "实质行"只查 `modTrims.includes(line)`——**集合成员**判定：一行出现两次、或顺序打乱，它照样绿 |

第三处是**真漏洞**，已改为**按位置**逐条比对函数体（`old[i].body` ↔ `mod[i].body`）。取块方式也从
注释边界改成**路径前缀**——那也正是"一族"的定义。

> 一个"每一行都在文件里出现过"的对拍，与一个"函数体逐行相同"的对拍，
> 在路由被搬错顺序、或某一行被复制到另一条路由里时，是同一个东西。

三族最终读数：旧 `if` 逐条对应（含方法、等值·前缀、**顺序**）2/2、5/5、13/13；
体**按位置**逐行相同 ✔ 全部；同前缀残留 0；工厂均已装进 `createRouter`；
`dispatch` 调用点 3 处。

## 3. 判据二：破验第一轮 **1/8**，而 8 条里有**三类**不同的原因

用既有 `chat.test.mjs` 当探测器（8 条变异）。第一轮只咬住 1 条。
逐条查清之后，漏网的 7 条**不是同一件事**——把三类混成一句"覆盖率不够"是错的：

| 类别 | 条数 | 具体 |
| --- | --- | --- |
| ① **真的没人问过** | 3 | `GET /messages` 的缺省 limit、`GET /reply-settings` 的 scope 合法性、`GET /conversations` 的 scope 过滤（本文件此前 HTTP 面一次都没发过这三条） |
| ② **路由护栏与 DAO 校验重复** ⇒ 观测等价 | 3 | `listMessages` / `listAwaitingReplies` 自己用**同样的话**校验 conv/scope/sinceMsgId（`server.mjs` L3206 / L3288 / L3291） |
| ③ **本 hub 里不可观测** | 1 | `PUT /attachments` 的鉴权：`authorized()` 在 `TOKEN === ''` 时**恒真**（L4712），而本套件不设 token |

> 一句"覆盖率不够"会把上面三类说成同一件事；
> 而它们的修法完全不同（补用例 / 什么都不用做 / 换一个配了 token 的 hub）。

★ 类别 ② 尤其要注意：**"没变红"不能直接推出"等价"**。这三条是我逐条读 DAO 最后 40 行
才确认的；其中 `getReplySettings` 恰好相反——它对非法 scope **不报错而是静默回落 default**（L3225），
所以路由层那道校验是**承重的**，去掉它会让 `?scope=BAD!!` 200 地读到 default 空间的设置。

## 4. 判据二（续）：补 9 条**缝上契约**，破验 8/8

`team-hub/chat.test.mjs` 末尾追加（**不新建文件**——理由同切片 2：`git ls-files "*.test.mjs"`
的条数被 `boundary-facts` 的 `handover-tracked-suites` 钉着）：

| # | 判据 |
| --- | --- |
| ① | 13 条路由**每一条**接到正确依赖：正向 1 次 + **反向**其他 DAO 一个都不许被碰（防两条路由接到同一 DAO） |
| ② | 方法/路径不匹配 ⇒ 返回 `false`（控制权交回 if 链），等值路由不吞前缀 |
| ③ | `GET /messages` 缺省 `limit=50`、`before=undefined`；显式参数透传 |
| ④ | `GET /reply-settings` 非法 scope 在**路由层** 400（DAO 会静默回落 default ⇒ 这道校验承重） |
| ⑤ | `GET /conversations` scope 透传；不带时是 `undefined` 而非 `''` |
| ⑥ | `PUT /attachments` 未授权 ⇒ 401，且**不读体、不上传、不清理** |
| ⑦ | `GET /messages` 缺 conv 拦在**路由层**（不是靠 DAO 兜底） |
| ⑧ | 上传顺序与参数：authorized → 清理 → 读体 → 上传 |
| ⑨ | `GET /replies` 六种非法入参**都在路由层** 400 且**不进 DAO**（用永不抛错的桩 DAO 把"拦在哪一层"钉住） |

42 → **51/51**；破验 **8/8 咬住、0 漏网**；逐字节还原后复绿。

★ 判据 ① 的豁免要**双向**核对：`PUT /attachments` 有意先跑一次孤儿清理
（原文 L8408 注释），所以它被登记为合法副作用——并且断言那次调用**确实发生了**，
否则 `also` 会退化成一张永久豁免的白名单。

★ 判据 ⑨ 是第一轮"漏网 2 条"的正解：那 2 条**确实**观测等价，所以不能靠"让它变红"来修；
改成断言语义本身（护栏在哪一层）之后，桩 DAO 不抛错 ⇒ 唯一能产生 400 的只有路由。

## 5. 判据三：全量回归

`team-hub/` 下所有 import 了 `server.mjs` 的套件：
**51 个 / 788 例 / 788 pass / 0 fail**（切片 2 时 779，+9 = 本片新增的缝上契约）。

## 6. 规模（同一套计数逻辑，前后都量）

| 量 | 切片 1 后 | 切片 2 后 | 切片 3 后 | Δ（本片） |
| --- | --- | --- | --- | --- |
| `server.mjs` 行数 | 9218 | 9201 | **9081** | **−120** |
| `handle()` 行数 | 4210 | 4187 | **4059** | **−128** |
| `handle` 里路由条件 | 186 | 181 | **168** | **−13**（正好一族） |
| `router.dispatch` 调用点 | 1 | 2 | **3** | +1 |
| 装配的路由族 | 1 | 2 | **3** | +1 |

累计相对原始 `server.mjs`（9221 行）：**−140 行**。

## 7. 两处**连带修复**（不是本片功能，但不修门禁就红）

1. **`scripts/prt/baseline-snapshot.test.mjs` 判据 ⑨ 的夹具写死了"哪个族还没登记"。**
   切片 1 写它时拿 `createChatRoutes` 当"未登记"的例子；本片 chat 真的登记了，
   夹具于是从"未登记的族"变成"已登记的族"，**它罚的是正确的行为**。
   已改为从一个确定不存在的名字推出。
   > 一个把"哪个族还没登记"写进夹具的用例，与一个假设"注册表永不变化"的用例，是同一个东西。
2. **`docs/superpowers/prt/PRT-PROGRESS.md` 里 PRT-611 那行的 `server.mjs:1735` 被行号漂移甩空。**
   该引用写于 `b37d390`，当时 L1735 = `const operation = normalizeOperation(input)`（在 `checkPermission` 体内）；
   它上方多次插入后那一行现在是 **L2351**，而 L1735 成了空行 ⇒ 并发会话新写的
   `ledger-line-citations-resolve` 判据红了。已按**同一行代码**改指 L2351。
   > 一个用行号指路的引用，与一个它所指的那行代码，只要中间插进任何东西，
   > 就不再是同一个东西——而插进东西的正是提取工作本身。

## 8. 门禁

九道门禁 **9/9 `exit=0`**；`baseline-snapshot` **25/25**、`boundary-facts` **44/44**、
`intervention-coverage` **16/16**。

切片 1 的教训第二次生效：本片在 `--record` **之前**先登记第三族，
于是 `--check` 只报 `~ 源文件已变更`、**无任何 `- 路由:` 行**。
基线仍 **188** 条路由（三片前后同数），13 条 chat 路由齐全，
`ROUTE_FAMILY_SOURCES` 三个模块哈希齐全。

## 9. 这一片**没有**做（免得下一片以为做完了）

| 没做 | 为什么 |
| --- | --- |
| 域逻辑（`listConversations` / `postMessage` / `listMessages` / `uploadChatAttachment` / `chatHealth` / `getReplySettings` / `listAwaitingReplies` / `postAiReply` … 及 `CHAT_ATTACH_MAX_BYTES`）仍在 `server.mjs` | 本片只搬**路由** |
| 其余 **168** 条路由条件仍在 `handle()`；`handle` 仍 **4059 行** | 一片一族 |
| **`authorized()` 在无 token 时恒真** 这件事本身 | 那是既有设计（回环部署），不是本片引入；但它意味着"读面鉴权"在默认部署下**不可观测** |
| 远程监听 + token 下 chat 路由真的 401 | 需要另起一个带 `TEAM_HUB_HOST=0.0.0.0` + token 的 hub（与 `read-auth.test.mjs` 同形），**未做** |
| `handle` 里剩下的**最大一块**：`runtime` 段 26 条、跨度 2498 行（分散） | 它不内聚，不适合照本片的"整段搬"做法 |

## 10. 可复核判据

```bash
cd <repo>
node --test team-hub/chat.test.mjs                    # 51/51（42 既有 + 9 新）
node .worktrees/_prt-handoff/pair-routes.mjs          # 三族逐字对拍（按位置）
node .worktrees/_prt-handoff/mutate-slice3.mjs        # 破验 8/8
node .worktrees/_prt-handoff/gen-chat-routes.mjs      # 生成器可重跑（源头是 git ref）
node scripts/prt/baseline-snapshot.mjs --check        # 无漂移
```
