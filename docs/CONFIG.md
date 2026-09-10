# 统一配置系统（P3-2）

本文是 legion 三个**活跃进程**配置面的权威参考：优先级、字段清单、校验命令与脱敏规则。
如果你是来「查某个环境变量叫什么、默认多少、能不能用 CLI 覆盖」，看第 3 节的表格即可。

- 覆盖范围：`team-hub`（团队中枢数据面）、`workbench`（军团指挥台宿主）、`whiteboard`（协作白板，独立子项目）。
- 不在范围：`scrum`（已退役，仅在 schema 登记状态，不改代码）、DSH 宿主与两个插件（`board-plugin` / `services-plugin`，其配置由 DSH 宿主 composition 管理，见 `.dsh/` 与部署说明）。

---

## 1. 设计取舍（一句话各一条）

| 决策 | 内容 | 原因 |
| --- | --- | --- |
| 不引入配置文件 | 环境变量与 CLI 仍是**唯一注入面**，运行时语义零变更 | P3-2 的目标是「让配置可见、可校验、可脱敏」，不是换一套配置机制；换机制在活跃部署上风险不成比例 |
| 优先级固定 | **CLI > 环境变量 > 默认值**，永不反向 | 现状就是这个语义（三进程原本各自实现），统一的是表达而不是行为 |
| 非法值不静默回退 | 类型/范围/枚举不合格 → 报错并 `exit 1`；只有「未设置」才回退默认 | 「拼错端口号导致服务起在别处」比启动失败更难排查 |
| 脱敏是引擎职责 | `sensitive` 字段只以 `***` 或 `***(N 位)` 出现；摘要、JSON、日志共用同一路径 | 脱敏逻辑一旦分散，迟早有一处漏 |
| schema 必须与代码同步 | `scripts/config/scan.mjs --check` 要求每个 env 读取点都在 schema 中声明 | 否则「统一 schema」会随着代码演进变成一份过期文档 |
| 白板用同步副本 | 根引擎 + 白板副本，逐字节校验 | 白板 Docker 构建上下文是 `whiteboard/`，无法 import 仓库根代码；详见第 5 节 |

## 2. 优先级与来源可追溯

```
CLI 参数        node workbench/scripts/serve.mjs --port 5273
  ↓ 覆盖
环境变量        DSH_WORKBENCH_PORT=5273
  ↓ 覆盖
schema 默认值   5173
```

解析结果带 `sources`，因此可以回答「这个值从哪来」：

```bash
node scripts/config/check.mjs --show-source --process=workbench
```

```
  DSH_WORKBENCH_PORT               5173                          [default]  监听端口（生产实例默认 5173）
```

`check.mjs` 的 `--json` 输出也带 `sources` 与 `warnings`，便于 CI 与诊断脚本消费。

## 3. 字段清单

### 3.1 team-hub（`team-hub/config-schema.mjs`，12 项）

| 环境变量 | CLI | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `TEAM_HUB_PORT` | `--port` | int | `8787` | 监听端口 |
| `TEAM_HUB_HOST` | `--host` | string | `127.0.0.1` | 监听地址；非回环必须配 token |
| `TEAM_HUB_TOKEN` | `--token` | string（secret） | 空 | 读写鉴权 token |
| `TEAM_HUB_DB` | — | path | `team-hub/team.db` | SQLite 库（WAL）；附件落在同目录 `uploads/` |
| `CHAT_ATTACH_MAX_BYTES` | — | int | `10485760` | 单附件大小上限 |
| `CHAT_ATTACH_MAX_PER_MSG` | — | int | `3` | 每条消息附件数上限 |
| `CHAT_ATTACH_BLACKLIST_EXT` | — | csv | `exe,dll,bin,…`（20 项） | 附件扩展名黑名单 |
| `CHAT_ATTACH_STAGED_TTL_MS` | — | int | `86400000` | staged 孤儿清理阈值 |
| `CHAT_ATTACH_TTL_MS` | — | int | `604800000` | sent 附件过期清理 |
| `CHAT_REPLY_TIMEOUT_MS` | — | int | `120000` | AI 回复等待超时 |
| `MAX_RULES_LEN` | — | int | `3000` | 规范内容长度上限 |
| `LEGION_HUB_URL` | — | string | `http://127.0.0.1:8787` | `scripts/seed-pipeline.mjs` 写入目标 |

### 3.2 workbench（`workbench/scripts/config-schema.mjs`，21 项）

| 环境变量 | CLI | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `DSH_WORKBENCH_PORT` | `--port` | int | `5173` | 监听端口 |
| `DSH_WORKBENCH_HOST` | `--host` | string | `127.0.0.1` | 监听地址 |
| `DSH_WORKBENCH_TOKEN` | `--token` | string（secret） | 空 | 写操作鉴权；空 = 只读部署（写接口拒绝） |
| `TEAM_HUB_TOKEN` | — | string（secret） | 空 | 调 hub 读接口用；**与 team-hub 同一个变量** |
| `DSH_HUB_UPSTREAM` | — | string | `http://127.0.0.1:8787` | `/hub/*` 反向代理目标 |
| `DSH_WORKBENCH_ROOT` | — | path | 空 = `workbench/dist` | 静态产物根 |
| `DSH_WORKBENCH_SPACES_JSON` | — | path | 空 | 空间定义 JSON（默认内置） |
| `DSH_WORKBENCH_MAX_UPLOAD` | — | int | `67108864` | 单文件上传上限 |
| `DSH_WORKBENCH_MAX_UPLOAD_TOTAL` | — | int | `1073741824` | 分片上传总上限 |
| `DSH_WORKBENCH_CHUNK_SIZE` | — | int | `4194304` | 建议分片大小 |
| `DSH_WEB_FETCH_ALLOW_PRIVATE` | — | bool | `false` | 允许抓私网（仅测试） |
| `DSH_WEB_CACHE_TTL_MS` | — | int | `300000` | 抓取缓存 TTL（进程内） |
| `DSH_WEB_CACHE_MAX` | — | int | `200` | 抓取缓存条目上限 |
| `DSH_WEB_QUOTA_SPACE_RPM` | — | int | `30` | 单空间每分钟抓取数 |
| `DSH_WEB_QUOTA_CONCURRENCY` | — | int | `3` | 单空间并发抓取数 |
| `DSH_WEB_QUOTA_HOST_RPM` | — | int | `30` | 单 host 每分钟抓取数 |
| `DSH_WEB_QUOTA_DAILY_BYTES` | — | int | `209715200` | 单空间每日抓取字节 |
| `DSH_WEB_AUDIT_FILE` | — | path | 空 = `data/web-audit.jsonl` | 抓取审计文件 |
| `DSH_WEB_AUDIT_MAX_BYTES` | — | int | `5242880` | 审计轮转阈值 |
| `DSH_WEB_SHOT_ENABLE` | — | bool | `false` | 启用截图（需本机浏览器） |
| `DSH_WEB_SHOT_BROWSER` | — | path | 空 = 自动探测 | 浏览器可执行文件 |
| `DSH_WEB_SHOT_DIR` | — | path | 空 = `data/web-shots` | 截图输出目录 |

> `DSH_WEB_URL` **不是** workbench 的配置：它是 DSH 宿主表示 Web GUI 地址的变量，与 `DSH_WEB_*`
> 前缀撞名。已在 schema 的 `foreignEnv` 中登记，`check.mjs` 不会把它误报成拼写错误。

### 3.3 whiteboard（`whiteboard/apps/server/src/config-schema.mjs`，21 项）

| 环境变量 | CLI | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `PORT` | `--port` | int | `8080` | 监听端口 |
| `HOST` | `--host` | string | `127.0.0.1` | 监听地址；非回环必须配 token |
| `WHITEBOARD_TOKEN` | `--token` | string（secret） | 空 | 全局 token（未单独声明的房间用它） |
| `TTL_MS` | — | int | `10000` | presence 陈旧判定 |
| `DB_PATH` | — | path | `apps/server/data/whiteboard.db` | 兼容库路径；`:memory:` 时房间也走内存 |
| `WB_ROOMS_DIR` | — | path | `apps/server/data/rooms` | 每房间一个 `<roomId>.db` |
| `WB_AUDIT_DIR` | — | path | `apps/server/data` | 审计 JSONL 目录 |
| `WB_IN_MEMORY` | — | bool | `false` | 强制房间走内存 |
| `WHITEBOARD_ROOMS` | — | string（部分脱敏） | 空 | 房间声明 `roomId:token:role,…` |
| `WB_CONTROL_OPEN` | — | bool | `false` | 控制面对非回环开放 |
| `WB_ROOM_IDLE_MS` | — | int | `300000` | 房间空闲关闭阈值 |
| `WB_MAX_ROOMS` | — | int | `50` | 同时打开房间数上限 |
| `WB_MAX_CONNECTIONS` | — | int | `200` | 全服连接数上限 |
| `WB_MAX_CONNECTIONS_PER_ROOM` | — | int | `50` | 单房间连接上限 |
| `WB_MAX_CONNECTIONS_PER_IP` | — | int | `50` | 单 IP 连接上限（≥ 单房间上限） |
| `WB_MAX_MESSAGE_BYTES` | — | int | `262144` | 单消息字节上限（超限 1009） |
| `WB_MAX_OPS_PER_MESSAGE` | — | int | `200` | 单消息 op 数上限（超限 1008） |
| `WB_MESSAGE_RATE_PER_SEC` | — | int | `120` | 令牌补充速率 |
| `WB_MESSAGE_BURST` | — | int | `240` | 令牌桶容量 |
| `WB_RATE_STRIKES` | — | int | `20` | 窗口内累计丢弃达此值才断开 |
| `BENCH_CLIENTS` / `BENCH_OPS` | — | int | `20` / `20` | 压测脚本参数 |

## 4. 校验命令

```bash
# 全量：三进程 schema 校验 + 脱敏摘要 + 跨进程一致性（按当前 shell 的真实环境变量）
node scripts/config/check.mjs

# 只看某个进程 / 看来源 / 机器可读
node scripts/config/check.mjs --process=whiteboard
node scripts/config/check.mjs --show-source
node scripts/config/check.mjs --json

# 用一份文件描述配置（key=value），并**忽略**当前 shell 的环境变量
# （CI 与「按文档复核」用；--isolated-env 消除宿主会话变量的干扰）
node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict

# 配置面自洽检查（CI env 阶段执行的三项）
node scripts/config/scan.mjs --check    # 每个 env 读取点都已在 schema 中声明
node scripts/config/sync.mjs --check    # 白板副本与根引擎逐字节一致
```

退出码：`0` 无 error（`--strict` 下还要求无 warning）；`1` 有 error 或 strict 违规；`2` 用法错误。

### 跨进程一致性规则（`scripts/config/cross-checks.mjs`）

单进程 schema 管不到的事故都在这里拦：

| code | 级别 | 触发条件 |
| --- | --- | --- |
| `port_conflict` | error | 两进程监听同一端口 |
| `hub_upstream_port_mismatch` | error | workbench 的 `DSH_HUB_UPSTREAM` 端口 ≠ team-hub 的 `TEAM_HUB_PORT` |
| `hub_upstream_unparsable` | warning | 上游地址无法解析端口 |
| `hub_token_missing_in_workbench` | error | hub 配了 token，workbench 没配 `TEAM_HUB_TOKEN` |
| `hub_token_mismatch` | error | 两进程的 token 不一致（分别在不同 shell 启动时才会发生） |
| `hub_token_unused` | warning | workbench 配了 token，但 hub 未开鉴权 |
| `exposed_without_token` | error | host 非回环却没配 token（两服务自己也会拒绝启动，这里提前报） |
| `static_root_missing` | warning | workbench 静态产物目录不存在（进程照常起，用户侧才 404 —— P3-1 实测坑） |
| `db_inside_rooms_dir` | warning | 白板 `DB_PATH` 落在 `WB_ROOMS_DIR` 之内 |
| `workbench_token_unset` | warning | 未配写 token（只读部署属预期，故只提示） |

## 5. 引擎位置与白板的同步副本

```
packages/shared/src/config.mjs                      ← 唯一实现（引擎）
  ├─ team-hub/config-schema.mjs                     import ../packages/shared/…
  ├─ workbench/scripts/config-schema.mjs            import ../../packages/shared/…
  └─ whiteboard/apps/server/src/config-schema.mjs   import ../../../packages/shared/…（副本）
        └─ whiteboard/packages/shared/src/config.mjs  ← 同步副本（scripts/config/sync.mjs 生成）
```

白板的 `Dockerfile` 构建上下文是 `whiteboard/`，只 `COPY package.json packages apps scripts`，
**无法**引用仓库根的 `packages/shared`。为了让白板保持独立可部署，同时不出现两份脱敏实现
（分叉会直接把 token 打进日志），采用「单一实现 + 同步副本 + 逐字节校验」：

```bash
node scripts/config/sync.mjs           # 更新副本
node scripts/config/sync.mjs --check   # CI env 阶段校验一致性
```

> 直接编辑 `whiteboard/packages/shared/src/config.mjs` 会被 `sync --check` 拦下——请改根实现后重新同步。

## 6. 启动摘要（脱敏）

三个进程在监听前都会打印一行脱敏后的最终配置：

```
[config] team-hub port=8787 host=127.0.0.1 token=***(26 位) dbFile=… attachMaxBytes=10485760 … dbFile=…
[config] whiteboard port=18080 host=127.0.0.1 token=***(21 位) ttlMs=10000 dbPath=… rooms=main:***:rw … roomsDir=… auditDir=…
[config] workbench port=18173 host=127.0.0.1 token=***(17 位) teamHubToken=(未设置) hubUpstream=http://127.0.0.1:8787 … staticRoot=…/workbench/dist
```

规则：

- `sensitive: true` 的字段只显示 `***(N 位)` 或 `(未设置)`——**能看出「配没配」，看不出「配了什么」**，长度提示也便于确认部署是否漏配。
- 复合值走字段级 `redact` 钩子：`WHITEBOARD_ROOMS=main:room-token:rw` 打印为 `main:***:rw`（保留房间与角色，隐去房间 token）。
- 摘要与 `--json` 输出共用同一脱敏路径，不存在「有个口子没脱敏」的分支。
- 非法值在打印摘要**之前**就已报错退出，因此摘要永远代表「确实生效」的配置。

## 7. 新增配置项的正确姿势

1. 在对应进程的 `config-schema.mjs` 里加一个字段（`key` / `env` / `type` / `default` / `doc`，密钥记得 `sensitive: true`）。
2. 若该键是**核心项**（host/port/token/路径等影响启动的），在进程入口改成走 `loadConfig()` 的解析结果；其余功能键保持原样读取即可，但**必须在 schema 中声明**。
3. 跑 `node scripts/config/scan.mjs --check`——它会告诉你哪个读取点漏登记了。
4. 跑 `node scripts/config/check.mjs` 确认摘要与跨进程规则仍自洽。
5. 单测里的「默认值漂移」用例会把你写的 `default` 与代码里的真实默认值比对：**两侧不一致就会失败**，这正是防止 schema 变成过期文档的机制。

## 8. 已知边界

- **只覆盖活跃三进程**：`scrum`（已退役）与两个 DSH 插件不在本体系内。
- **不做运行时热更新**：配置在进程启动时解析一次；改配置需重启进程。
- **不校验语义可达性**：`DSH_HUB_UPSTREAM` 指向的 hub 是否真的在跑，只有连上去才知道——`check.mjs` 只做配置面一致性，不发网络请求（因此可安全地在离线环境运行）。
- **`check.mjs` 默认读当前 shell 环境**：在 DSH 会话内直接跑会把宿主的 `TEAM_HUB_PORT` / `DSH_WEB_URL` 一起算进来，可能出现「真实但与本机会话相关」的告警；用 `--isolated-env --env-file=…` 复核。
- **token 一致性规则在单份环境里无法触发**：两个进程读同一个 `TEAM_HUB_TOKEN`，只有分别在不同 shell 配置启动时才可能不一致；这属于真实故障场景，规则的单元测试用两份构造配置覆盖。
- **白板副本是本仓库特有的折衷**：若将来白板 Docker 上下文改为仓库根，或白板抽出为独立仓库，应改为直接引用/发包，并删除副本与 `sync.mjs`。
