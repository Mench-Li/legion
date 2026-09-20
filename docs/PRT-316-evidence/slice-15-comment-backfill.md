<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 15：把切片 8～13 丢掉的 **32 行注释**逐字补回

- 切片：15（**不动路由**；纯追加，零行为变化）
- 提交：见 `git log`（`docs(PRT-316 切片 15)`）
- 由来：切片 14 新加的判据 `check-region-lines.mjs` 当场量出了这件事

## 一、这件事是怎么被发现的

切片 14 的族（usage）第一次出现"**说明不止一段**"，于是追问：
**逐字对拍到底守住了什么？** 答案是：**只守住路由的体**。
一族里凡**不属于任何一条路由的体**的东西 —— 段首说明、**子段说明**、族级分隔符 ——
对拍**全都够不着**，而接线脚本会把整个区间**删掉**。

> 一条"路由体逐字相同"的判据，与一条"原件一行都没丢"的判据，
> 在原件里除了路由体没有别的东西的时候是同一个东西。

于是写了新判据：用与接线脚本**同一套**区间算法算出"会被删掉的区间"，
逐行核对每一非空行都必须在产物模块里找得到
（先排除两类**故意**不在产物里的行：路由**条件行**、每条路由体**末尾那个 `return`**）。

**跑第一次就翻出来了**：

| 族 | 丢注释 | 丢代码 |
| --- | --- | --- |
| experience | **11** | 0 |
| tool-calls | **10** | 0 |
| model-profiles | **7** | 0 |
| connectors | **4** | 0 |
| rules / permissions / calendar / secrets / automation / packs / role-packs | 0 | 0 |
| chat / compaction（切片 1～5） | 3 / 10 | 0 |
| **合计（切片 8～13）** | **32** | **0** |

★ **代码行十四族全部零丢失** —— 逐字对拍确实守住了它守的那部分。
丢的**全是注释**，而注释里装的正是"为什么这样写"。

★★★ 其中 **model-profiles 那 7 行是切片 13（我自己上一片）丢的**，
内容是"probe 的位置必须在下面那批 `startsWith` **之前**，否则
`/api/model-profiles/p1/probe` 会被当成 `id = "p1/probe"` 去查档案，
然后以一个**完全指向错误方向**的 404 结束" ——
一句只有这个仓库才知道的、关于**顺序**的推理，而它当时只留在 git 历史里。

切片 1～5（chat 3、compaction 10）是**另一个**原因：那时生成器还没有"搬注释"的能力
（切片 6 才加的）。判据把它们标成"已知偏差"。

## 二、怎么补的（纪律：不许手抄）

1. **注释文本从 git 里取** —— 在原文区间里按同一套算法定位那些丢掉的运行段，
   逐行取出。手抄一遍就不再是"逐字"了。
2. **落在哪条路由之上也是推导的** —— 原文里每段注释**紧贴**的那条 `if` 条件行，
   解析出 `(method, match, path, suffix)`，再在模块里找**同一条**条目。
3. **插在条目的 `{` 之上**，用该条目的缩进；一次插入，顺序按原文。
4. **纯追加** —— 一个既有的非空行都不动、不删、不改（脚本只做 `splice` 插入）。

结果：

| 族 | 补回 | 落在哪条路由之上 |
| --- | --- | --- |
| experience | 11 | `POST /api/experience/drafts/<id>/settle` |
| tool-calls | 7 + 3 | `GET /api/tool-calls/evidence` + `GET /api/tool-calls/repair` |
| model-profiles | 7 | `POST /api/model-profiles/<id>/probe` |
| connectors | 4 | `POST /api/connectors/<id>/incidents` |

★ 落点复核过（不是只看判据通过就收工）：注释紧贴在各自条目之上，读起来与原文同构。

## 三、★★★ 顺手订正一条被我记错很久的事实：路由模块**不都是 LF**

补回脚本第一版有个守卫 `if (raw.includes('\r')) throw new Error('不是纯 LF')`，
**它响了** —— 而它响得对：

| 换行 | 族模块 |
| --- | --- |
| **CRLF（6 个）** | automation、calendar、compaction、experience、packs、secrets |
| **LF（8 个）** | chat、connectors、model-profiles、permissions、role-packs、rules、tool-calls、usage |

我此前一直记着"`team-hub/routes/*.mjs` 全是 LF"—— **是错的**。
原因是 `core.autocrlf=true` 且仓库没有 `.gitattributes`：
我按 LF 写进去，之后被 git 碰过一次（commit/checkout）就变回 CRLF 了。

> 一条"这个目录是 LF"的判据，与一条"这个文件此刻是 LF"的判据，
> 在我上次看它之后 git 没再碰过它的时候是同一个东西。

如果那个守卫不存在，脚本会按 LF 拼进 CRLF 文件 ⇒ **混合换行**，
而 `node --check` 会通过、`includes('\r\n')` 也会通过（前面那些行都是 CRLF）——
这正是**切片 13** 栽过的那个形状。

**修法**：脚本改成**逐个文件探换行**（`NL = raw.includes('\r\n') ? '\r\n' : '\n'`），
断言没有**裸 LF**、没有 `\r\r\n`，写完再断言一次。
⇒ 教训写在这里：**判据要探事实，不要读我的记忆。**

## 四、判据

| 判据 | 结果 |
| --- | --- |
| 四个模块 `node --check` | ✅ 全过 |
| 十四族逐字对拍 ① ② ③ ⑤ | ✅ 全过（注释在体的**外面**，判据不受影响，也不该受影响） |
| 被删区间逐行核对 | ✅ **切片 6 起一行都没丢**（切片 1～5 仍标为已知偏差） |
| 基线漂移的形状 | ✅ **只有那 4 个模块**的源文件哈希变了，**路由条数一条没变** |
| 基线读数 | `httpRoutes` 仍 **188**；**73 已搬 + 115 剩余 = 188**；`sources` 仍 32 |
| `baseline-snapshot.test.mjs` | 25/25 |
| 九道门禁 | **9/9** |
| 全量回归 | **51 套件 / 889 例 / 889 pass / 0 fail**（与切片 14 同数 —— 本片不新增用例，也不该新增） |

★ 基线漂移**只报"源文件已变更"、不报路由变化**，这本身就是"契约没动"的证据 ——
一条"我有意改了注释"的说法，与一个"契约真的没动"的状态，
在没有独立读数的时候是同一个东西。

## 五、本片**没有**做

- **零行为变化**：没有改一行代码，没有动一条路由，没有改任何断言。
- 切片 1～5 丢失的注释（chat **3**、compaction **10**）**未补** ——
  那时生成器没有搬注释的能力，补它们要重新逐段判定落点，属**另一片**。
- 其余 **115** 条路由条件仍在 `handle()`。

## 六、复现命令

```powershell
node .worktrees/_prt-handoff/check-region-lines.mjs        # 先量出丢了什么
node .worktrees/_prt-handoff/anchor-dropped-comments.mjs   # 每段原本紧贴哪一行
node .worktrees/_prt-handoff/backfill-comments.mjs         # 逐字补回
node .worktrees/_prt-handoff/check-region-lines.mjs        # 应为 0
node .worktrees/_prt-handoff/pair-routes.mjs
node scripts/prt/baseline-snapshot.mjs --record
```
