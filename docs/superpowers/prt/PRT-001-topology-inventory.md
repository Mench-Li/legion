# PRT-001 进程 / 组件 / 数据拓扑清单

**对应**：`PRT-001`
**机器清单**：[`prt-001-003-inventory.json`](./prt-001-003-inventory.json)（本文件是它的人读副本；两者冲突时以 JSON 为准）
**采集方式**：`node scripts/prt/topology-inventory.mjs --record`

---

## 1. 进程拓扑

| 进程 | 入口 | 端口 | 就绪判据 | 托管关系 | 协议 |
| --- | --- | --- | --- | --- | --- |
| **team-hub** | `team-hub/server.mjs` | `TEAM_HUB_PORT`=8787 | tcp-connect | services-plugin（Desktop）或手动；**端口已占用则跳过启动** | HTTP + SSE |
| **workbench** | `workbench/scripts/serve.mjs` | `DSH_WORKBENCH_PORT`=5173 | tcp-connect | services-plugin（Desktop）或手动 | HTTP（静态资源 + 调 hub 读接口） |
| **whiteboard** | `whiteboard/apps/server/src/index.js` | `PORT`=8080 | tcp-connect | **手动 / 独立子项目**（services-plugin 不托管） | HTTP + WebSocket |
| **plugins** | `plugins/src/index.ts`（宿主 composition 挂载） | 无 | 不适用（进程内插件） | DSH 宿主（cordis composition 行） | 进程内 |
| **board-plugin** | `board-plugin/src/index.ts`（宿主 iframe 面板） | 无 | 不适用（进程内插件） | DSH 宿主 | 进程内 |
| **services-plugin** | `services-plugin/index.js` | 无 | 不适用（自身即监管者） | DSH 宿主；**它再托管 team-hub 与 workbench** | 进程内 + spawn |

### 1.1 三处容易搞错的地方

1. **services-plugin 只托管两个进程**，不是三个。`whiteboard` 是独立子项目，
   由人工或白板自己的脚本启动。把它算进「三进程托管」会导致部署验证漏测。
2. **端口已占用则跳过启动**（`tcpOpen(port)` 为真即 `跳过启动`）。这是有意的
   「采纳已有服务」语义，不是缺陷；但它意味着**启动成功 ≠ 该进程由我拉起**。
   排查「为什么改动没生效」时先确认在监听的是不是你以为的那个进程。
3. **进程内插件没有就绪判据**。`plugins` 与 `board-plugin` 由宿主在导入期挂载，
   「是否就绪」等价于「宿主是否成功加载了它」——诊断入口是 `p13-host-injection`，
   而不是探测端口。

### 1.2 就绪判据统一为 tcp-connect

三个真实进程都用 TCP 可连接作为就绪判据（`services-plugin` 的 `tcpOpen`、
`baseline-measure.mjs` 的 `waitForPort`）。**不是**「进程未退出」——进程活着但
HTTP 未监听是最常见的假就绪，用它当判据会得到一个漂亮但无意义的数字。

---

## 2. 数据拓扑

| 数据 | 路径（默认） | 归属 | 说明 |
| --- | --- | --- | --- |
| team-hub 库 | `team-hub/team.db` | **InstallDir（越界）** | 由 `TEAM_HUB_DB` 覆盖；`team-hub/.gitignore` 的 `*.db` 使其不被提交 |
| 聊天附件 | `<库目录>/uploads/` | **InstallDir（越界）** | 与库同基（决策 E1 / S3-R3） |
| 白板库 | `apps/server/data/whiteboard.db` | **InstallDir（越界）** | `DB_PATH` |
| 白板房间 | `apps/server/data/rooms` | **InstallDir（越界）** | `WB_ROOMS_DIR` |
| 白板审计 | `apps/server/data` | **InstallDir（越界）** | `WB_AUDIT_DIR` |
| 服务日志 | `<legionDir>/.legion-services.log` | **InstallDir（越界）** | `services-plugin` 写入 |
| 测试证据 | `scratch/**`、`.tmp-l1db/**` | InstallDir | **已被 git 跟踪**（见 §2.2） |

### 2.1 越界写入是当前最实在的一条

清单里 **4 个 path 类字段的默认值都落在仓库/安装目录内**：

```
TEAM_HUB_DB      = team-hub/team.db
DB_PATH          = apps/server/data/whiteboard.db
WB_ROOMS_DIR     = apps/server/data/rooms
WB_AUDIT_DIR     = apps/server/data
```

这不是洁癖问题。spec §11 要求产品数据落在 `DataDir`，而**安装目录会被升级覆盖**：
数据写进去，轻则升级后用户数据消失，重则升级因目录非空而失败。
PRT-505（密钥/数据迁移）与 PRT-257（Launcher）必须以这份清单为输入，
把默认值改到 `DataDir`，并保留显式覆盖能力。

### 2.2 仓库里已有 46 个被跟踪的数据产物

`git ls-files` 命中 45 个 `.db`/`.db-shm`/`.db-wal` 加 1 个 uploads 相关路径，全部来自：

- `scratch/t117-round*-**/`——T-117 轮的测试证据快照（含一层**递归嵌套**：
  `scratch/t117-round3-final-snapshot/scratch-t117-r2/scratch-t117-r2/...`）
- `.tmp-l1db/t.db`——**仓库根下的未清理临时目录**，且**未被 .gitignore 覆盖**

两点值得记下：

1. **临时目录进了版本库**。`.tmp-l1db/` 是调试残留，`git check-ignore` 对它无输出
   （即不被忽略）。它会随每次 `git clone` 分发，也会在下次生成时被 `git add -A` 重新加入。
   清理它属于仓库卫生，不是 PRT 的设计问题，但**PRT-505 做数据迁移时应顺手清掉**。
2. **测试证据快照里带的是 SQLite 库**。它们由测试构造，理论上不含真实数据；
   但「理论上」不是保证。它们体积小（合计约 128 KB），风险有限，
   仍是**产品数据出现在安装目录**这一模式的现成例子。
   若确认无需保留，删掉即可；若需保留，应改为在 evidence 文档里记录**如何重建**，
   而不是把库本体提交进去。

> 本次**未**执行任何清理动作。清理由你决定：这份清单只做归因，不动数据。

---

## 3. 组件（进程内）

| 组件 | 位置 | 形态 |
| --- | --- | --- |
| `plugins`（scrum-worker / mediator） | `plugins/src/` | DSH 宿主插件，**唯一导入 DSH 执行面包的源文件** |
| `board-plugin` | `board-plugin/src/` | 宿主 iframe 看板面板 |
| `services-plugin` | `services-plugin/` | 服务托管：spawn + tcp 探活 + 退出重启 |
| `permission-engine` | `team-hub/permission-engine.mjs` | 纯函数权限判定（5 个模式） |
| Runtime Contract | `runtime/contracts/` | 新增；对 DSH 依赖为零 |

---

## 4. 复现

```bash
node scripts/prt/topology-inventory.mjs --record   # 刷新清单
node scripts/prt/topology-inventory.mjs --diff     # 查漂移
node --test scripts/prt/topology-inventory.test.mjs
```

---

## 5. 已知未覆盖

- **未采集运行时真实拓扑**：本清单是**静态**的（源码 + 配置 Schema），没有
  「此刻哪些进程真的在跑、内存多少、端口被谁占用」的运行时快照。
  后者属 PRT-009 的 `peak-resource` 待采集项。
- **未覆盖 `whiteboard` 的完整配置面**：它有自己的 `config-schema.mjs` 并已纳入，
  但它是独立子项目，其部署方式（谁启动、几个实例）未在本清单确认。
- **未记录 DSH 宿主侧的 composition 行**：`plugins` 与 `board-plugin` 的挂载细节
  属 PRT-010（组合基线），不在此重复。
