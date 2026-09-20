<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 2：第二族（permissions / 审批箱）+ 缝上契约

> 业主 2026-09-20 裁决：走 `docs/review/PRT-PRE-REFACTOR-CANDIDATES.md:140` 的
> 「或按「一个切片一次对拍」做」，照 `PRT-315` 先例逐片提取。
> 硬约束（`spec :1282`）：**每片能独立对拍与回滚**，不允许一次性重写两个大文件。
> 切片 1 = `docs/PRT-316-evidence/slice-01-routing-seam-rules.md`（提交 `db8e2cc`）。

## 0. 为什么第二族挑它，而不是挑"更小的那个"

因为这一族**正是 PRT-316 存在的原因**。`docs/PRT-212-evidence/verify-evidence.md:122`：

> 真实审批箱接线 —— 需要 PRT-316 先把 team-hub 的**路由层**提取出来；
> 现在直连会把新代码**焊死在 `server.mjs`** 上。

「审批箱」的读写两端就是本族的 `GET /api/permissions/inbox` 与 `POST /api/permissions/decide`。
挑更小的一族只是少搬几行；挑这一族才让 PRT-212 下一步**有地方落脚**。

## 1. 改动

| 文件 | 角色 |
| --- | --- |
| `team-hub/routes/permissions.mjs`（新增，约 130 行） | 第二族：5 条路由，依赖全部注入、**零注入改写** |
| `team-hub/server.mjs` | 三处：+1 行 import、+6 行装配、26 行路由块 → 3 行 `dispatch` |
| `team-hub/approval-port.test.mjs` | **+4 例缝上契约**（23 → 27） |
| `scripts/prt/baseline-snapshot.mjs` | `ROUTE_FAMILY_SOURCES` 登记第二族 |

一行代码的规模对比（同一套计数逻辑，前后都量）：

| 量 | 切片 1 后 | 切片 2 后 | Δ |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 9218 | **9201** | **−17** |
| `handle()` 行数 | 4210 | **4187** | **−23** |
| `handle` 里路由条件 | 186 | **181** | **−5**（正好一族） |
| `router.dispatch` 调用点 | 1 | **2** | +1 |
| 装配的路由族 | rules | **rules + permissions** | +1 |

累计相对原始 `server.mjs`（9221 行）：**−20 行**。

## 2. 判据一：逐字对拍（通用化）

切片 1 的对拍脚本写死了 rules。本片把它**通用化**为
`.worktrees/_prt-handoff/pair-routes.mjs`（按族配置 `ref` 与 `module`），两族一起跑：

| 项 | rules | permissions |
| --- | --- | --- |
| 旧 `if` 条件 ↔ 模块声明（含方法/等值·前缀/**顺序**） | ✔ 2/2 | ✔ 5/5 |
| 函数体逐行**字面**相同（忽略缩进） | ✔ 7/7 行 | ✔ 10/10 行 |
| `server.mjs` 里无副本 | ✔ 0 残留 | ✔ 0 残留 |
| 工厂已装进 `createRouter` | ✔ | ✔ |

★ 通用化时**先踩了自己两个坑**，都留档，因为它们与"路由被丢了"长得一样：

1. 旧侧正则写成 `path (===|...)`（要求 `===` 前有空格），而
   `path.startsWith(` **没有**那个空格 ⇒ rules 的 GET 一条都匹配不到，
   读数是"声明式表少了一条"，真相是"正则少认了一种写法"。
2. 新侧本来用正则去猜模块里的 `method:`/`path:` 声明，`[\s\S]{0,200}` 的窗口
   撑不住权限族的长函数体 ⇒ 少报 2 条。

修法是**不再用正则猜新侧**：直接 `import` 模块、调工厂（注入桩）、读它真正产出的
`routes` 表。

> 一个用正则去猜"声明长什么样"的对拍，与一个"路由真的被搬丢了"的提交，
> 在读数上是同一个东西——只不过前者会把每一种没料到的书写方式都报成一次丢失。

## 3. 判据二：破验 —— 第一轮 **1/6**，而这暴露了 4 处**既有**覆盖缺口

用**既有** `approval-port.test.mjs` 当探测器（6 条变异）：

| # | 变异 | 第一轮 | 补判据后 |
| --- | --- | --- | --- |
| P1 | inbox 去掉 `authorized` 门禁 | ✖ 没咬住 | ✔ |
| P2 | inbox 忽略 `scope` 参数 | ✖ 没咬住 | ✔ |
| P3 | `decide` 不落库 | ✔ 咬住 | ✔ |
| P4 | `check` 丢失 `actor` 回退 | ✖ 没咬住 | ✔ |
| P5 | 前缀路由退化成等值比较 | ✖ 没咬住 | ✔ |
| P6 | 删除路由切片长度写错 | ✖ 没咬住 | ✔ |

逐条查过全仓，**不是"我的变异等价"，是"从来没人问过"**：

| 行为 | 全仓覆盖 |
| --- | --- |
| `DELETE /api/permissions/rules/<id>`（带 id 的前缀路由） | **0 个套件** |
| `GET /api/permissions/inbox?scope=` | **0 个套件** |
| `POST /api/permissions/check` 不带 `actor` | 没有套件走过那条回退 |

> 一个"所有用例都绿"的路由族，与一个"有一半行为从来没人问过"的路由族，
> 在测试报告上是同一个读数。

★ 另外记一条**探测器的选择**问题：`team-hub/permissions.test.mjs` 名字最像，
但它 `import` 之后**直接调 DAO**（`mod.upsertPermissionRule(...)`），全文 0 处
`/api/permissions` 字符串——**路由接线错了它照样绿**。

## 4. 补的 4 条判据打在**缝**上

`team-hub/approval-port.test.mjs` 末尾追加（**不新建文件**）：

- ① inbox 鉴权来自注入的 `authorized`（取掉必须 401，且**不许读审批箱**）+ 反面控制
- ② inbox 的 `scope` 透传，不带时必须是 `null` 而不是空串
- ③ `check` 缺 `actor` 回落成 `by`；显式给了就不许被覆盖
- ④ 带 id 的删除是**前缀**路由：id 逐字传出、不吃掉 `POST rules`、方法不匹配不命中

**为什么打在缝上而不是再起一个 hub**：本片改动引入的正是缝——"路由把注入的依赖
用对了没有"。既有 23 例仍在**真 hub** 上验"hub 会怎么答"，两层互补。

**为什么追加而不是新建文件**（这一条是刻意的）：新建 `*.test.mjs` 会改变
`git ls-files "*.test.mjs"` 的条数，而那个数被 `boundary-facts` 的
`handover-tracked-suites` 钉着——**另一会话正在同一处工作**。

补后破验 **6/6 咬住、0 漏网**，逐字节还原后复绿（`approval-port.test.mjs` 27/27）。

### 4.1 写这 4 条时自己踩的两个坑（留档）

1. **把查询串当成 `path` 传**：`dispatch(..., '/api/permissions/inbox?scope=x')`。
   真实 `handle()` 传的是 `url.pathname`。夹带 `?scope=` 会让**等值路由匹配不上**
   ⇒ 读数是"scope 没透传"，真相是"路由根本没被调用"。
2. **断言"成功时 `sent` 为空"**：成功路径**也会**调 `json`（200）。
   要断言的是"没有 401"，不是"没有响应"。

## 5. 判据三：全量回归

`team-hub/` 下所有 import 了 `server.mjs` 的套件：**51 个 / 779 例 / 779 pass / 0 fail**
（切片 1 时为 775，+4 = 本片新增的缝上契约）。

## 6. 门禁：切片 1 的教训**确实生效了**

切片 1 时 `baseline-snapshot --check` 把搬走的 rules 两条报成**被删除**。
本片在 `--record` **之前**先登记第二族，于是 `--check` 只报
`~ 源文件已变更（需人工确认是否为契约变化）：team-hub/server.mjs`，
**没有任何 `- 路由:` 行**。

★ 而且这是**逐名登记**的价值：`assertRouteFamilyCoverage()` 以 `server.mjs` 的
`createRouter([...])` 装配处为权威，本片加了第二个 `createXxxRoutes(` 之后，
**忘了登记就会红**——本条判据在切片 1 写下的那一刻就为这一片准备好了。

复验：`--record` 后 `--check` 无漂移；基线里 **188** 条路由（与切片 1 前后同数），
permissions 五条齐全，`sources` 含 `team-hub/routes/permissions.mjs` 哈希。

## 7. 这一片**没有**做（免得下一片以为做完了）

| 没做 | 为什么 |
| --- | --- |
| 域逻辑 `checkPermission` / `decidePermission` / `listPermissionInbox` / `upsertPermissionRule` / `deletePermissionRule` / `permissionRequestView` / `sweepApprovals*` 仍在 `server.mjs`（L2295-2760） | 本片只搬**路由** |
| 其余 **181** 条路由条件仍在 `handle()`；`handle` 仍是 **4187 行** | 一片一族 |
| **真实审批箱接线**（PRT-212 那条依赖） | 缝已就位、这一族已落位，但接线本身是 PRT-212 的工作 |
| `approval-port.test.mjs` 里 P1 只覆盖"注入的 `authorized` 被用了没有" | **不是**"远程监听 + token 下 inbox 真的 401"——那需要 `TEAM_HUB_HOST=0.0.0.0` + token 起另一个 hub（与 `read-auth.test.mjs` 同形，两个 server 实例在同一套件里），**未做** |

## 8. 可复核判据

```bash
cd <repo>
node --test team-hub/approval-port.test.mjs          # 27/27（23 既有 + 4 新）
node --test team-hub/approval-registrar-row.test.mjs # 6/6
node --test team-hub/permissions.test.mjs            # 5/5（DAO 层，不覆盖路由）
node scripts/prt/baseline-snapshot.mjs --check       # 无漂移
node .worktrees/_prt-handoff/pair-routes.mjs         # 逐字对拍（两族）
node .worktrees/_prt-handoff/mutate-slice2.mjs       # 破验 6/6
```

九道门禁 **9/9 `exit=0`**；`boundary-facts` 44/44、`baseline-snapshot` 25/25、
`intervention-coverage` 16/16。
