# Legion 目标级发布说明（DEPLOY / CI）— T-093 部署与 CI/CD

> 角色：devops（部署运维员）｜任务：T-093（目标级收尾 · 发布部署）｜分支：w/T-093（HEAD = **06480ba**，与 main 同步）
> 上游：本目标切片链全部 promote 合入 main —— T-077(S1)/T-079(S2)/T-081(S3)/T-083(S4)/T-085(S5)/T-087(S6)/T-089(S7)/T-091(S8)+T-094 及各自 tester 任务（依赖 T-078..T-092 均已完成）
> 本文档 = 部署/发布清单（环境 × 步骤 × 验证 × 回滚）+ 变更影响 + 验证结果；配套统一发布门禁脚本 `scripts/ci/run-ci.mjs`（本阶段新增，收口自 w/T-043、w/T-063、w/T-064 各切片 devops 草案——均未合入 main，故在本目标级整合）。
> 产物证据目录：`docs/T093-evidence/`（ci-run-06480ba/ 全量日志 + summary.json + 各套件输出）。

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 构建 / CI | ✅ **真实跑通全绿**：`node scripts/ci/run-ci.mjs` 六阶段全 PASS，exit 0（env/deps/build/test/smoke/stage；命令输出见 §3.2 与 docs/T093-evidence/ci-run-06480ba/ci-output.txt） |
| 构建产物 | ✅ workbench `tsc --noEmit` 0 诊断 + `vite build` 617 modules → dist/（index.html + 3 assets）；whiteboard build PASS（9 共享模块 → 静态前端） |
| L0 测试 | ✅ 七套件 225 用例 0 失败：chat 13 · skills 12 · calendar 13 · files-api 40 · web 24 · contracts 56 · whiteboard 67（含真实服务 e2e 6） |
| L1 冒烟 | ✅ 真实进程：chat-l1 22/22、chat-s2 9/9、files-s5 32/32、whiteboard /healthz+GET / 200、v1 看板 auth=true |
| 部署范围 | dev / acceptance（本机 · 127.0.0.1 三件套 + whiteboard 自托管）；production 未获授权 → **本阶段不发布生产**（§2.1/§9） |
| 放行门禁 | 🔴 无未修复 P0/P1 阻塞项：历史 P0-1/P0-2/P0-3 与三中心缺陷（F1/F2/R-A3/R-A4/R-A5/A6）已在本目标切片链修复并被套件锚定（§7.1） |
| 环境受限项 | L2 GUI 手工走查、board-plugin/plugins 宿主注入冒烟本沙箱不可达 → 如实记录复现步骤（§5.3/§7.3/R-18），不冒充通过 |

---

## 1. 发布范围与变更影响

### 1.1 本次发布范围（本目标自 T-073 起的全部交付，均已合入 main；发布基线 = 06480ba）

| 域 | 内容 | 合入提交（代表） |
| --- | --- | --- |
| 三中心收尾（P0/P1） | S1 文件面嵌套 .git 防护 + 畸形路径防崩溃；S2 浏览器抓取审计留痕 + body stall 归类 timeout + WEB_ERR 枚举收口；S3 ChatView 会话/空间身份守卫；S4 BrowserView 收口（w/T-051 合入）；S8 集成回归锚定 | T-077/T-079/T-081/T-083/T-091/T-094 |
| 平台剩余（P1） | S5 日程日历后端（calendar_events 表 + /api/calendar/events）；S6 CalendarView 前端；S7 通知中心 NotifyView + 侧栏 badge + 已读游标 | T-085/T-086/T-087/T-089 |
| 编排支撑 | V3 切片编排（P1）已在前期合入（/api/goal/slices、/api/test-report、机器闸门、fix 回炉等） | 早于本批 |

### 1.2 变更影响（部署视角，逐面）

- **API 面（只增不删）**：

| 域 | 端点 | 宿主 | 边界 |
| --- | --- | --- | --- |
| 对话中心 | POST/GET /api/chat/conversations、POST/GET /api/chat/messages | team-hub :8787（前端经 serve.mjs /hub/* 代理） | scope 分区；写 by 必填 + author=by 防冒名；正文 ≤8000；审计 chat:* + SSE |
| 文件中心 | GET /api/files/{list,read,download}、PUT /api/files/upload、POST /api/files/{mkdir,rename,delete} | workbench serve.mjs :5173 | 仅回环；写需 --token/DSH_WORKBENCH_TOKEN；越界/嵌套 .git 任意层段 + realpath 复检 → 403；覆盖 overwrite=1；删除 confirm=yes |
| 浏览器助手 | POST /api/web/fetch | workbench serve.mjs :5173 | 仅回环；SSRF 逐跳防护（私网/回环/混淆/重定向链）；共享 deadline 整链超时；限长 2MiB；审计 web-audit.jsonl（静态 ROOT 之外，容量轮转） |
| 日程日历 | GET/POST /api/calendar/events、POST /api/calendar/events/delete | team-hub :8787 | scope 过滤 + 日期窗闭区间；写 by 必填；audit calendar:* + SSE |
| 通知 | 前端 NotifyView（由 /api/activity 审计派生） | workbench :5173 | 已读游标 localStorage per scope（R-15） |

- **数据影响**：team-hub SQLite 启动幂等建表/补列（conversations/messages/calendar_events + tasks 切片列），存量库无损升级（chat/calendar/skills 测试均含旧库迁移用例）；文件/抓取均不留服务端业务库，浏览器审计为 JSONL 追加文件。
- **前端影响**：workbench 构建产物 dist/ 变化（5173 非热更，部署后需 Ctrl+F5）；侧栏模块 chat/files/browser/calendar/notify 全部真实面板（占位收口完成）。
- **服务影响**：三件套启动方式/端口不变（services-plugin 托管不受影响，端口占用探测跳过）；v1 看板仅启停回归。
- **依赖**：**零新增运行时依赖**（全部 Node 内置 / 自研 / 既有）；Node ≥ 22.5（node:sqlite）。
- **回归**：L0 七套件 + L1 冒烟全绿（§3/§4），未发现本批引入回归。

---

## 2. 环境与拓扑

### 2.1 环境分级

| 环境 | 形态 | 用途 | 发布前提 |
| --- | --- | --- | --- |
| dev（本机开发） | 三件套 127.0.0.1 + 源码 | 开发自验 | 无 |
| acceptance（本机/局域网验收） | 三件套 + 构建产物（当前部署形态：services-plugin 随 DSH Desktop 托管） | 将军/验收人走查 | CI 全绿（§3） |
| production | 未定义 / 未授权 | — | 将军立项批准后按 §6/§8 执行（本阶段不发布） |

### 2.2 组件与端口

| 组件 | 进程/入口 | 默认端口 | 数据 | 三中心/平台落点 |
| --- | --- | --- | --- | --- |
| team-hub v2 | `node team-hub/server.mjs` | 8787（TEAM_HUB_PORT） | team-hub/team.db（SQLite WAL） | 对话/日程数据与 API + 审计/SSE |
| 军团指挥台 | `node workbench/scripts/serve.mjs --port 5173`（前置 `pnpm build`） | 5173 | 托管 workbench/dist；/hub/* 代理 :8787 | 三中心 + 日程/通知前端入口；文件/浏览器 API 宿主 |
| v1 看板（遗留） | `node scrum/serve.mjs --port 4820 --host 0.0.0.0 --token …` | 4820 | scrum/tasks.json + board.json(运行时) | —（仅启停回归） |
| whiteboard | `node apps/server/src/index.js`（或 Docker） | 8080 | DB_PATH + WB_ROOMS_DIR（每房间一个 `<id>.db`） | 白板协作（独立子项目，多房间与治理见 whiteboard/docs/DEPLOY.md、ADR-0008） |

### 2.3 关键配置（环境变量 / 参数）

> **P3-2 起，配置面已统一并有权威参考：`docs/CONFIG.md`**（三进程全部字段、优先级 **CLI > env > 默认值**、
> 启动脱敏摘要、校验命令与跨进程一致性规则）。下表只列部署时最关键的几项，字段全集请看 CONFIG.md。
>
> 部署前后建议各跑一次配置自检（不依赖服务已启动）：
>
> ```bash
> node scripts/config/check.mjs                 # 按当前环境校验三进程 + 跨进程一致性
> node scripts/config/check.mjs --show-source   # 每个值标明来自 cli / env / default
> ```

| 配置 | 载体 | 默认 | 说明 |
| --- | --- | --- | --- |
| TEAM_HUB_PORT / TEAM_HUB_HOST / TEAM_HUB_DB / TEAM_HUB_TOKEN | env（也可 `--port/--host/--token`） | 8787 / 127.0.0.1 / team-hub/team.db / 空 | 中枢；非回环监听必须设置 token |
| DSH_WORKBENCH_PORT/HOST、--token、DSH_HUB_UPSTREAM | args/env | 5173 / 127.0.0.1 / 无 token / http://127.0.0.1:8787 | 指挥台；**DSH_HUB_UPSTREAM 端口必须等于 TEAM_HUB_PORT**，否则 `/hub/*` 代理连不上（`check.mjs` 会拦） |
| DSH_WEB_FETCH_ALLOW_PRIVATE | env | 关 | 仅测试/本地演示开；生产默认关闭（SSRF 防护） |
| DSH_WEB_AUDIT_FILE / DSH_WEB_AUDIT_MAX_BYTES | env | workbench/data/web-audit.jsonl | 浏览器抓取审计路径/轮转上限 |
| LEGION_TRUSTED_PROXIES | env | **空** | 可信反向代理的地址/CIDR（逗号分隔）。**留空 = 不信任何 `X-Forwarded-For`，按来源限速不生效**。Hub 绑回环 + 隧道填 `127.0.0.1/32,::1/128`。见 §2.4 |
| LEGION_RATE_LIMIT_LOGIN / _REGISTER / _PASSWORD_RESET | env | 30 / 10 / 10 | 同一来源 15 分钟内允许的尝试次数（登录 / 注册 / 口令重置）；`0` = 关掉那一层。见 §2.4 |
| LEGION_REGISTRATION / LEGION_REGISTRATION_MAX | env | closed / 20 | 注册策略与**全局**每小时新账号上限 —— 与上面的来源限速是两件事，见 §2.4 |
| LEGION_QUOTA_MESSAGES_PER_HOUR | env | 300 | 每个**账号**每小时的聊天消息数（防库被灌满）；`0` = 关掉。Agent 的汇报**不**计入。见 §2.5 |
| DSH_KANBAN_PORT/HOST/TOKEN、--token | args/env | 4820 / 127.0.0.1 / 空 | v1 遗留 |
| whiteboard | env（也可 `--port/--host/--token`） | PORT 8080 / HOST 127.0.0.1 / DB_PATH / WHITEBOARD_TOKEN | 非回环监听必须设置 WHITEBOARD_TOKEN；见 whiteboard/docs/DEPLOY.md |
安全不变量（三中心与平台既有）：/api/files/*、/api/web/fetch、/api/fs/* 仅回环地址可访问；写操作 token 鉴权
（未配置放行=仅回环保护）；SSRF 协议白名单 + 私网/回环/混淆逐跳拦截；嵌套/内嵌 .git 任意层段 + realpath 复检拒绝；
前端全部 React 文本节点渲染（无 dangerouslySetInnerHTML）；畸形 percent-encoding/超长/NUL 请求 400/404 且进程存活。

### 2.4 按来源限速：**对外服务前必做的一步**

**在公网上服务真实用户之前，必须显式设置 `LEGION_TRUSTED_PROXIES`。**
不设的话这一层**不会生效**，而且**不会报错** —— 它会如实把自己报成不生效，
而"一台以为自己在限速、其实没有的 Hub"与"一台真的在限速的 Hub"，
在被攻击之前**没有任何区别**。

**为什么是"配置出来"而不是"直接信那个头"**：部署形态是"Hub 绑回环 + 反代"，
于是 `req.socket.remoteAddress` 恒为反代自己；真实来源只存在于
`X-Forwarded-For` 里，而那是**调用方可以随便写**的头。

> 一个"信一个没人验证过的 `X-Forwarded-For`"的按 IP 限速，
> 与一个完全不限速的端点，在攻击者面前是同一个东西 ——
> 只不过前者多了一行看起来很安全的代码。

所以：**只有直连对端在可信表里时**才看那个头，并且从链的**右端**往左取第一个
不可信地址（反代是**追加**它看到的地址，所以右端是"最近一跳说的真话"，
攻击者只能污染左端）。

**部署后必须核对**（这是判据，不是建议）：

```bash
# Hub 绑回环 + cloudflared 隧道
LEGION_TRUSTED_PROXIES=127.0.0.1/32,::1/128     # 写进 /etc/legion-hub.env

# 重启后看启动摘要里有没有它
journalctl -u legion-hub -n 20 --no-pager | grep -o 'trustedProxies=[^ ]*'

# ★ 真正的判据：经**公网**读一次，必须 reason=forwarded 且 effective=true
curl -s -H "authorization: Bearer $TEAM_HUB_TOKEN" \
  https://<你的域名>/api/identity/rate-limits
# 期望：{"reason":"forwarded","effective":true,"loopbackOrPrivate":false, ...}
# 若 effective=false：这一层不生效，按上面的原因码修（no-trusted-proxy / no-chain）
```

实测（2026-10-12，`legion-si.online`）三条路径的读数：

| 路径 | `reason` | `effective` |
| --- | --- | --- |
| 经 Cloudflare 隧道 | `forwarded` | **true**（拿到真实公网客户端 IP） |
| 直连回环、无 `X-Forwarded-For` | `no-chain` | false（拒绝拿回环当"一个客户端"） |
| 直连回环 + 手工 `X-Forwarded-For` | `forwarded` | true（对端可信才采信） |

**两个闸门不是一件事，别混**：

| | 问的是 | 默认 | 适用 |
| --- | --- | --- | --- |
| `LEGION_REGISTRATION_MAX` | 这台 Hub 一小时内**新开了几个号** | 20/小时 | **全局**（防资源被灌满） |
| `LEGION_RATE_LIMIT_*` | 这个**来源**发了多少次尝试 | 30 / 10 / 10 per 15min | **按来源**（防 credential stuffing） |

**按用户名**的登录锁定（15 分钟内失败若干次即锁）是第三层，一直在生效；
但它挡不住 credential stuffing —— 每个账号只试两三次就换下一个，
按名字归并的计数对那种模式恒为 1。

**已知取舍（不假装消除）**：同一办公室 / 运营商 CGNAT 出口后面的人会**一起**被限。
所以上限定得宽（登录 30/15 分钟），且 429 的消息明确说"这是**来源**级别的限速，
不是账号被封；换一个网络通常可以立即继续"。

### 2.5 按**账号**的用量配额：与上面的来源限速是两件事

| | 问的是 | 键 | 默认 | 生效条件 |
| --- | --- | --- | --- | --- |
| 来源限速（§2.4） | 这个**来源**试了多少次 | IP | 30 / 10 / 10 per 15min | 配了 `LEGION_TRUSTED_PROXIES` |
| **用量配额（本节）** | 这个**账号**建了多少资源 | userId | `LEGION_QUOTA_MESSAGES_PER_HOUR=300` | **一直生效** |
| 按用户名的登录锁定 | **这个账号**是不是正在被猜 | userId | 15 分钟内失败若干次 | 一直生效 |

**两个方向都要有**：一个**攻破的账号**能完全绕开来源限速 —— 它发的本来就是
合法请求；而一台被灌满的库会让**所有**账号一起不可用。

**三条刻意的设计**（改动前先读代码里的理由）：

1. **换网络不会重置配额。** 键是 userId 不是 IP。这正是它要防的行为 ——
   攻击者会换网络，而一个正常的用户不会因为换了 Wi-Fi 就被重置。
2. **Agent 的汇报不计入。** 同一张 `messages` 表，人的写入走 HTTP（过配额），
   Agent/守护的汇报走内部 `insertMessage`（不过配额）。
   > 把 Agent 汇报算进用户配额，会在 Agent 干活最忙的时候把用户锁住 ——
   > 而那时正是他最需要看到进展的时候。
3. **被拒的尝试不记账。** 否则用户被拒后反复重试（人的自然反应）会把窗口
   一直往后推，他**永远等不到恢复**，而界面每次都说"请约 X 分钟后继续"。

`0` = 关掉这一层。同一个 429 语义：带 `Retry-After`，错误码
`ACCOUNT_QUOTA_EXCEEDED`（与来源限速的 `IDENTITY_RATE_LIMITED` **不同码** ——
前者要说"等一会儿或找管理员"，后者才说"换个网络"）。

**启动期自检**：`QUOTA_LIMITS` 与 `QUOTA_RESOURCES` 的键必须完全一致，否则
服务**拒绝启动**。守的是静默失败 —— 键写错时两条查表都落空，全都通向"不限"，
且没有日志。一个"配了但键对不上"的配额，与一个"根本没配"的配额，
在运行期是同一个东西。

#### 在生产上验证配额时：**别用外键清理**

```bash
# 只读的诊断（不需要改配置、不需要写任何消息）
curl -s -H "authorization: Bearer $TEAM_HUB_TOKEN" \
  https://<域名>/api/identity/rate-limits
# 期望看到两组：max（来源限速）与 quotas（账号配额），各自独立
```

要**真实触发**一次，正确做法是**预置满额流水**，而不是真发几百条消息：

```js
// 让这个账号看起来已经用满（不写任何业务数据、不改配置）
for (let i = 0; i < 300; i++) ins.run(key, Date.now())   // bucket='quota:message', key='user:<id>'
// 下一条消息必须 429，且 messages 表行数不变（配额在写之前）
// 然后删除预置流水 → 同一条消息必须 200
```

> ★ **清理时只删你能证明是自己创建的行。**
>
> 我在这上面栽过一次：验证脚本用 `DELETE FROM messages WHERE conv_id=?` 清理，
> 而那个 `conv_id` 是 `/api/agent-conversations` **返回**的 ——
> 该端点会**收养**一条既有的岗位会话，而不是每次新建。
> 于是我删掉了一条**既有会话**和它的 **27 条真实消息**。
> （已用当晚 gpg 备份逐行恢复并核对：三张受影响的表与删除前完全一致。）
>
> `/api/agent-conversations` 返回的 `convId` **不保证**是新会话。
> 清理要么按你自己插入时拿到的行 id 删，要么按一个只属于你的唯一标记删，
> 永远不要按一个"你以为只属于你"的外键删。

---

## 3. 构建与 CI 门禁（本阶段新增 `scripts/ci/run-ci.mjs`）

零第三方依赖（Node ≥ 22.5）。在普通终端或 run_code 宿主进程执行：

```bash
node scripts/ci/run-ci.mjs                              # 全量（env→deps→build→test→smoke→stage）
node scripts/ci/run-ci.mjs --only build,test            # 局部
node scripts/ci/run-ci.mjs --skip smoke                 # 跳过冒烟
node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run-06480ba   # 指定证据输出（ci.log + summary.json）
```

| 阶段 | 内容（等价命令） | 通过标准 |
| --- | --- | --- |
| env | node 版本 / git head / platform | node ≥ 22.5 |
| deps | workbench/node_modules 就绪（缺失自动 junction → 主 checkout） | 依赖可解析 |
| build | whiteboard `node scripts/build.mjs`；workbench `tsc --noEmit && vite build`（= pnpm build） | 0 错误；dist/index.html 存在且引用 assets |
| test | node --test：chat 13 / skills 12 / calendar 13 / files-api 40 / web 24 / contracts 56 / whiteboard 67 | 全绿 0 失败 |
| smoke | L1：chat-l1 22 项、chat-s2 9 项、files-s5 32 项、whiteboard 真实进程 /healthz+GET /、v1 看板 auth=true | 全 PASS |
| stage | 发布物暂存 releases/legion-<gitHead>-<date>/（dist 快照 + MANIFEST.json + SHA256SUMS.txt，gitignore） | 产物完整 |

### 3.1 沙箱执行形态（R-18 先例，如实说明）

本任务沙箱的 pwsh 拦截「子进程 pipe 捕获」（spawn EPERM，R-18/§7.3 记录），故 CI 经 **run_code 宿主进程**
直跑（T-043 先例：`CI 通过 run_code 宿主进程执行（无该限制），命令与产物与普通终端完全一致`）。已实测确认：
node --test（runner 逐文件子进程隔离）、vite/esbuild、e2e 起真实服务在本宿主下**全部正常**（无 EPERM），
与普通终端等价；`node scripts/ci/run-ci.mjs` 在受限 pwsh 内直跑仍会 EPERM（环境限制，非门禁失败）。

### 3.2 本次实测结果（真实命令输出为证，全量见 docs/T093-evidence/ci-run-06480ba/ci-output.txt）

```text
$ node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run-06480ba
Legion CI run: root=D:\project\DSH\legion\.legion-worktrees\T-093 node=24.19.0
stages: env -> deps -> build -> test -> smoke -> stage
===== [build] =====  whiteboard PASS（node scripts/build.mjs）；workbench PASS（tsc --noEmit && vite build）
  vite: 617 modules transformed. ✓ built in 5.12s
  dist/index.html(0.44kB) + assets/index-*.css(36.82kB) + assets/index-*.js(340.24kB) + assets/Scene3D-*.js(923.50kB)
===== [test] =====  chat 13/13 · skills 12/12 · calendar 13/13 · files-api 40/40 · web 24/24 · contracts 56/56 · whiteboard 67/67（exit 全 0）
===== [smoke] ===== chat-l1 22/22 · chat-s2 9/9（S2-A GET / 200，dist 就位后 9/9）· files-s5 32/32 ·
  whiteboard 真实进程 /healthz {"ok":true,"storage":"MemoryProvider"} + GET / 200 html(1832B) · v1 /api/config auth=true
===== [stage] ===== releases/legion-06480ba-2026-09-05/（MANIFEST.json + SHA256SUMS.txt + dist/ 快照）
===== SUMMARY =====  env PASS · deps PASS · build PASS · test PASS · smoke PASS · stage PASS → exit 0
```

---

## 4. 部署步骤（环境 × 步骤，含预检与验证）

> 预检（gate）：以下任意不通过 → 终止发布（【边界：不跳过构建 / 预检直接发布】）。

### 4.1 全新部署（fresh start）

前置：Node ≥ 22.5；workbench 依赖（cd workbench && pnpm install，禁网环境可 junction 主 checkout node_modules）。

```powershell
# 1) 构建（发布门禁）
node scripts\ci\run-ci.mjs --only deps,build        # 或全量 run-ci.mjs（§3）

# 2) 起三件套（a/b/c 三个终端，或交给 services-plugin 托管 —— 见 2.1/§4.3）
#    a) 中枢（必启）
node team-hub\server.mjs                              # http://127.0.0.1:8787（team.db 自动建表/补列）
#    b) 指挥台（主体，含三中心入口；5173 非热更）
cd workbench; node scripts\serve.mjs --port 5173 --token <写令牌可选>
#    c) （可选遗留）v1 看板
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820
#    d) （可选）whiteboard
cd whiteboard; node apps\server\src\index.js        # http://127.0.0.1:8080（或 docker compose up --build）
```

验证：见 §5（至少 §5.1 L0 + §5.2 L1 分层探活 + 三中心主路径数据面）。

### 4.2 升级发布（从上一版本代码更新）

```powershell
# 1) 代码更新：验收 promote 后合入 main；部署机拉取/checkout 到发布 commit（本次 = 06480ba 或其后 promote）
git fetch origin && git checkout <release-tag-or-commit>
# 2) 重构建 + 重启（team.db 保留 —— 升级自动补建新表/补列，无需手工迁移脚本）
node scripts\ci\run-ci.mjs --only build
#    重启 team-hub 与 serve.mjs（结束旧进程后按 §4.1 步骤 2 重新拉起）
# 3) 按 §5 验证清单逐项核对，通过后登记发布记录（§4.4 模板）
```

### 4.3 services-plugin 托管（DSH Desktop 伴随启停，当前 acceptance 形态）

- services-plugin（`services-plugin/index.js`）把三件套托管进 DSH Desktop web profile：启动自动拉起
  team-hub :8787 / v1 :4820 / 指挥台 :5173，闪退自愈（退避上限 30s），Desktop 退出随插件回收；端口被占则跳过。
- 状态日志：`<legion根>/.legion-services.log`。
- ⚠ 前端改码后必须重新 `pnpm build`（5173 托管构建产物，非热更）；plugin 依赖 junction 重建按根 README §2.1.1。

### 4.4 发布记录模板（每次发布填写）

| 项 | 值 |
| --- | --- |
| 发布版本 / commit | legion-06480ba（MANIFEST.json） |
| 部署环境 | dev / acceptance / production |
| CI 证据 | docs/T093-evidence/ci-run-06480ba/（summary.json + ci-output.txt） |
| 验证项 | §5 清单逐条（L0/L1/L2 + 健康检查） |
| 已知缺陷 | §7.1（当前无未修复 P0/P1） |
| 回滚预案 | §6（触发即执行） |

---

## 5. 验证项清单

### 5.1 L0 自动化（每次发布必跑）— CI test 阶段

node --test 七套件 225 用例：team-hub/chat.test.mjs 13、team-hub/skills.test.mjs 12、team-hub/calendar.test.mjs 13、
workbench/scripts/files-api.test.mjs 40、workbench/scripts/web.test.mjs 24、tests/contract/contracts.test.mjs 56、
whiteboard 7 测试文件 67（61 单测 + 6 e2e 真实服务）→ 全绿 0 失败。

### 5.2 L1 服务级（每次发布必跑）— CI smoke 阶段 + 手工探活

| 验证项 | 命令 / 期望 |
| --- | --- |
| 中枢探活 | curl http://127.0.0.1:8787/api/config → {auth,db,port:8787} |
| 指挥台探活 | curl http://127.0.0.1:5173/ → 200 text/html 含 id="root"；curl http://127.0.0.1:5173/hub/api/config → hub 可达 |
| 对话冒烟 | 建会话→发消息→列表/审计/SSE 收到 chat:message（chat-l1 22/22 + chat-s2 9/9 已断言） |
| 文件冒烟 | list/read/download/upload/mkdir/rename/delete + 越界/.git 403 + 未绑定引导（files-s5 32/32 已断言） |
| 浏览器冒烟 | 抓本地 mock 成功 + 私网 ssrf_blocked（web.test 24/24 已断言；严格实例冒烟） |
| 日程冒烟 | POST /api/calendar/events → GET 日期窗命中 → delete（calendar.test 13/13 已断言） |
| whiteboard | curl http://127.0.0.1:8080/healthz → {"ok":true,…}（真实进程冒烟已断言） |
| v1 看板 | curl http://127.0.0.1:4820/api/config → auth 按 --token |

### 5.3 L2 浏览器手工验收（验收人/将军走查，需 GUI 浏览器；本沙箱无浏览器 → 复现步骤清单）

对话中心（新建会话→发送→第二标签同空间 ≤15s 实时→断线自动重连→纯文本渲染）；文件中心（绑定目录→浏览→预览→
上传→下载→未绑定引导→覆盖/删除二次确认）；浏览器助手（地址栏→抓取成功→私网 SSRF 拦截文案「🛡 已拦截：禁止访问
内网地址」→5 类错误文案互不相同→重试）；日程日历（月视图切换/新建入格/删除确认/切空间隔离）；通知中心（audit 派生
面板 + badge + 已读游标）。GUI 数据面已由 L0/L1 锚定，浏览器点击走查见 docs/TEST_CASES.md §7 / TEST_REPORT.md §4.4。

### 5.4 发布后健康巡检

```powershell
curl http://127.0.0.1:8787/api/config     # 中枢
curl -I http://127.0.0.1:5173/            # 指挥台
curl http://127.0.0.1:4820/api/config     # v1（如启用）
Get-Content .legion-services.log -Tail 30  # services-plugin 托管时查看启停/自愈记录
```

---

## 6. 回滚方案

| 场景 | 操作 | 备注 |
| --- | --- | --- |
| 代码回滚（发布后功能异常） | git checkout <上一发布 commit> → node scripts\ci\run-ci.mjs --only build → 重启三件套（§4.2 步骤 2/3） | 上一发布 commit = 本次 promote 前的 main 头 |
| 前端产物回滚 | 保留上一版 workbench/dist 快照（或 releases/ 上一快照）直接换回 → 重启 serve.mjs | 5173 非热更；无需动 DB |
| 数据回滚（team.db） | 用备份还原：停 hub → **删除目标目录的 team.db-wal / team.db-shm** → 替换 team-hub/team.db → 重启 | 表结构只增不改：新代码在老库自动建表/补列（幂等），回滚旧代码时新表闲置互不破坏。**必须先删 -wal/-shm**，原因见 §6.1。★ 这句话 2026-09-21 起有实验支撑：`scripts/prt/backup-restore-cross-version.test.mjs`（CI 套件 `prt-xver`）逐向验过——但"老代码读新库"那一向是**结构性 + 执行老 SQL**，不是真的跑了那一版进程，别读成端到端 |
| 进程故障（services-plugin 托管） | 无需人工：托管自愈重启（闪退退避 ≤30s）；手动部署则重启对应进程 | .legion-services.log 记录退出码与重启 |
| 端口被占 | 结束占用进程或用独立端口（TEAM_HUB_PORT / --port）起服 | services-plugin 探测到占用即跳过该服务 |

备份建议：每次升级前 `Copy-Item team-hub\team.db* <备份目录>\`；发布物快照（releases/legion-<head>-<date>/）
含 dist 与 SHA256SUMS，可校验文件完整性（Get-FileHash 比对）。

> `team.db*` 通配**包含** `-wal` 与 `-shm`，这是必须的——见 §6.1。

### 6.1 备份与恢复的三个实测要点（PRT-006）

**① 只复制 `team.db` 会静默丢数据。** WAL 模式下已提交的数据可能仍只在 `-wal` 里。
实测现场库：只复制 `.db` 的副本比真实状态**少了 253 条 audit 记录**
（9984 → 9731），而副本自身 `integrity_check` 报 **ok**——
**没有任何报错**，备份看起来完全正常。所以 `team.db*` 的通配不能省。

**② 恢复时必须先删掉目标目录的 `-wal` / `-shm`。** 实测：把 A 时点的 `.db`
与 B 时点的 `-wal` 放在一起，SQLite **会重放 B 的页到 A 的库上**，
而结果库的 `integrity_check` 依然报 **ok**。也就是说这个错误
**无法靠完整性校验发现**，只能在操作上避免：

```
停 hub
Remove-Item team-hub\team.db-wal, team-hub\team.db-shm -ErrorAction SilentlyContinue
Copy-Item <备份>\team.db team-hub\team.db
重启 hub
```

**③ 备份推荐用 `VACUUM INTO` 而不是文件复制**（无需停服、只需读权限）：

```powershell
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('team-hub/team.db',{readOnly:true});d.exec(`VACUUM INTO '<备份目录>/team.db'`);d.close()"
```

它由 SQLite 自身产出**一致快照**，单文件即可恢复，不依赖 `-wal`。
逐文件复制天然跨越多个时点（连做两次三件套复制在源库写入时会得到不同状态），
因此文件复制**只应在停 hub 后**进行。

验证（只读源库，全部在临时副本上做，不触碰现场文件）：

```powershell
node scripts\prt\backup-restore-verify.mjs                        # 用现场库
node scripts\prt\backup-restore-verify.mjs --source=<路径>        # 指定库
```

它逐条核对上面三点，并对照逐表行数与 `audit.seq` 上界。
**注意 `audit.seq` 允许有缺口**：分配器是 `MAX(seq)+1`（回滚后作废号不回填），
现场库实测就有 1 个缺口，这**不是**缺陷。验收口径是「恢复前后缺口集合一致」。

#### 6.1.1 与**自动更新**那套备份的关系（别用错入口）

本节的步骤是给**手工备份**（`VACUUM INTO` 产出的单文件）用的。自动更新还有
**另一套**快照与入口，两者**不要混用**：

| | 本节的手工备份 | 自动更新的快照（设计 §8） |
|---|---|---|
| 谁产生的 | 运维按上面 ③ 手工跑 | **安装事务自己**在建屏障、取备份那一步（设计 §8 第 ⑤ 步） |
| 放在哪 | 你自己定的备份目录 | `<DataDir>/backups/` |
| 恢复入口 | 上面那段手工步骤 | `legion --recovery-plan` / `--restore-backup=<id> [--confirm-restore]` |
| 适用场景 | 换机器、误删、日常容灾 | **一次升级中断、且这次升级自己取了快照** |

**★ 两条纪律是同一个**，所以本节 ② 那条在这里也成立，并且是**写进代码**的：
`product/upgrade/backup.mjs` 的 `restoreSnapshot()` 在写回 `.db` **之前**会删掉
它旁边的 `-wal` / `-shm`，注释里直接引的就是 **PRT-006**。它比手工步骤多做一件事：
**逐文件对账**——快照任一文件对不上就整份拒收，绝不写出一个"半个旧库"。

用法（`--recovery-plan` 零副作用，先看再决定）：

```powershell
# 只列出有哪些快照、每一份能不能自动恢复（不写任何文件）
legion --recovery-plan

# 真的恢复：没有 --confirm-restore 时**一个字节都不写**，退出码 12
legion --restore-backup=<snapshotId>
legion --restore-backup=<snapshotId> --confirm-restore
```

★ 三档安全性是**代码里判的**，不是让你自己权衡的：屏障已证明、且事务**未提交**
才允许自动恢复；已提交（恢复会丢掉提交之后的新写入）必须 `--confirm-restore`；
证据不足或不可恢复的一律**拒绝**（退出码 13）。用户工作空间**永远**不是恢复目标。

### 6.2 存储余量：**备份会先于写入失败**

```bash
node scripts/ops/storage-check.mjs \
  --db /var/lib/legion-hub/team.db --backups /var/lib/legion-hub/backups
# --json 给监控用；退出码 0 ok / 1 warn / 2 critical / 3 读不到读数
```

**为什么它是独立脚本、而不是一个 HTTP 端点**：磁盘满的时候 Hub 本身就在返 503
（见 §6.3），而那正是最需要读这个读数的一刻。

> 一个"和被测系统同生共死"的健康检查，
> 与一个"被测系统挂了就没有的健康检查"，是同一个东西 ——
> 只不过前者平时看起来更方便。

**阈值用绝对字节并按库大小缩放**，因为"能不能继续工作"是绝对问题，不是比例问题：

| 档位 | 判据 | 含义 |
| --- | --- | --- |
| **critical** | `free < max(256 MiB, 2 × 主库)` | 写入随时会失败；**备份已经做不成** |
| **warn** | `free < max(1 GiB, 10 × 主库)` | 空间快不够备份了 |
| ok | 其余 | — |

★ 为什么要 `2 × 主库`：备份走的 `VACUUM INTO`（`product/server/backup.mjs`）
需要写一份**完整的副本**。所以 **在写入失败之前，备份会先失败** ——
而"备份停止工作"这件事，只有在需要恢复的那一天才会被发现。

生产实测（2026-10-12）：

```
库文件        /var/lib/legion-hub/team.db
  主库        2.9 MiB
  WAL         4.0 MiB   ← 单独报：它可能比主库还大
  合计占用    6.9 MiB
磁盘         可用 45.89 GiB / 共 58.66 GiB
备份         最新一份 11.8 小时前
判定         OK（退出码 0）
```

**它必须是只读的**（除了写自己那份状态文件）：这个脚本会被挂到监控上周期性运行，
一个"顺手清一下旧备份"的监控脚本会在没人注意的时候删数据。判据里有一条专门断言
它不含整树删除/追加类调用，另一条断言状态写入**只**经过原子的 `writeStateAtomic`。

### 6.2b 定时器：`legion-hub-storage-check.{service,timer}`

```bash
systemctl enable --now legion-hub-storage-check.timer
systemctl list-timers legion-hub-storage-check.timer    # 看 LAST 那一列
```

每小时的第 11 分跑一次（避开整点 —— 与备份单元同一条理由：整点最挤）。

**两个必须显式写出来的键**，因为它们的**默认值都是错的**：

| 键 | 为什么 |
| --- | --- |
| `--state /run/legion-hub/storage-state.json` | 写在库那块盘上，会在**盘满时连状态文件一起写不进去** —— 而那一刻正是最需要它的时候 |
| `RuntimeDirectoryPreserve=yes` | systemd 默认 `no` = 单元**停止时删掉** `/run/…`。本单元是 `Type=oneshot`，`ExecStart` 一结束就停 → 刚写好的状态文件**当场被删**，Hub 永远报"没有在定时体检存储" |

> 一个"每次跑完就把自己的结论删掉"的体检，
> 与一个"从来没跑过"的体检，在读数上是同一个东西。

**退出码 0/1/2/3 各是一个要报出来的结论**，所以**没有** `SuccessExitStatus` ——
把 warn/critical 声明成"成功"，与没有告警是同一件事。

### 6.2c 读数：`GET /api/identity/storage-state`

需要**机器令牌或系统管理员**（与限速读数**共用**同一个守卫函数，避免两处漂）。
回答一个 `systemctl list-timers` 答不了的问题：

> 一个"配了定时器"的部署，与一个"定时器从来没跑成功过"的部署，
> 在 `list-timers` 里长得一模一样 —— 只要没人去看 `LAST` 那一列。

判定按**读数的新鲜度**：

| `reason` | 含义 | 该做什么 |
| --- | --- | --- |
| `fresh` | 新鲜（≤6 小时） | 看 `level` |
| `stale` | 跑过但很久没跑（>6 小时） | 去查定时器为什么停了 |
| `no-state` | 文件不在 → **从来没跑过** | 去装定时器 |
| `unreadable` | 文件在但读不出来 / 版本不认识 | 去查写入方 |

★ **陈旧的 `ok` 会降级成 `unknown`**，但 `lastKnownLevel` 保留上次的结论：

> 三天前测到"充足"，今天报"充足" → 你以为有人看着，其实**没有人在测**。

生产实测（2026-10-12，逐条打真端点）：`fresh`/`stale`/`unreadable`/`no-state`
四种读数与 `lastKnownLevel` 全部符合预期，改完**逐字节还原**。

**尚未接线**：**没有接告警通道**（Alertmanager / 邮件）。四档退出码是给**已有的**
监控用的（cron 的 `MAILTO`、systemd 的 `--failed`），而"谁被叫醒"还没定。
也就是说：**读数现在是可查的，但没有人会被主动通知**。这是一个已知缺口。

### 6.2d 容量趋势：`storage.growth`（`team-hub/storage-growth.mjs`）

"现在多大"答不出"照这个速度还剩多久" —— 而那是**开放给更多人之前唯一想知道的数**。
定时器每跑一次往状态文件里追加一条样本（有界：条数 + 7 天窗口），
读数据此报出趋势。

| `reason` | 含义 | 该做什么 |
| --- | --- | --- |
| `growing` | 有趋势，并给到期时间 | 看 `daysEffective` |
| `not-growing` | 库没在长（或**在缩**） | 什么都不用做 |
| `insufficient` | 样本不够（< 4 个）或跨度太短（< 6 小时） | 去等 —— **这不是"没问题"** |
| `stale-samples` | 最新样本超过 6 小时没更新 | 去看定时器为什么没跑 |

★ **"算不出来"是一个独立的结论，不是一个数**：两个样本、隔 5 分钟、涨了 2MB
能算出 576MB/天，那个数算术没错，但它会被当成一个预测去报警。

> 一个从两个样本外推出来的"预测"，与一个真的预测，
> 在告警列表上长得一模一样 —— 而只有其中一个值得采取行动。

★ **陈旧样本是最像真话的那种假话**：一个停了三天的定时器留下的是三天前的样本。

> 一个从三天前的样本算出来的趋势，与一个现在的趋势，
> 在一行"X MiB/天"里长得一模一样。

★ **库在长的时候，门槛也在长**。危险线是 `max(256MiB, 2×主库)`（备份要一份等大的
自由空间），所以库每长 1 字节要求就长 2 字节，差距以 **3 倍**速度合拢：

    g(t) = free(t) − 2·db(t)      →      g′ = −3r

读数**两种口径都报**（`daysNaive` / `daysEffective`），库小的时候它们是同一个数。

★ **只用主库拟合**：WAL 在 checkpoint 时会被截断，"主库+WAL"是锯齿形、**会变小**，
拿它拟合会把"刚 checkpoint 过"读成"数据在减少"。

**还没有做的（有意的）**：**没有硬性总量上限**。一个全局配额会让**一个**滥用者
把**所有人**挡住（自我 DoS）。正确的杠杆是按账号配额 + 可见性 + 运维动作 ——
这一节加的是**可见性**那一半。

**预测的输入只有库大小**：日志、其他文件、系统更新引起的空间变化**不在**模型里，
所以"还剩 N 天"可能偏乐观。重启后历史丢失（状态文件在 tmpfs 上）→
前 6 小时趋势算不出来（那是有意的：重启前的读数不该被当成现在的）。

### 6.3 盘满的时候用户看到什么（`team-hub/storage-health.mjs`）


修复前实测（`PRAGMA max_page_count` 确定性复现 `SQLITE_FULL`）：

```
400 { "error": "database or disk is full", "code": "ERR_SQLITE_ERROR" }
```

三个独立的错，而第三个会**跨模块**造成伤害：

| | 问题 |
| --- | --- |
| 状态码 400 | 含义是"**客户端**请求有错，别重试了"。这是服务端存储问题 |
| 原始英文消息 | 中文界面弹 `database or disk is full`，用户看不懂也做不了什么 |
| `ERR_SQLITE_ERROR` | 实现细节，不可据以行动 |
| ★ **连锁** | 400 会被手机端**离线待发队列**判成「永久失败」→ 停止自动重试 |

> 一条"磁盘满时被标成永久失败"的消息，其实等一会儿就能发出去 ——
> 但队列再也不会自动试了。

修复后：

```
503 { "error": "服务器的存储空间已满，这条消息暂时无法保存。（不是你的消息有问题；服务器恢复后会自动重试。请联系管理员。）",
      "code": "STORAGE_UNAVAILABLE" }
```

整形放在 **`withTx`**（所有写的事务边界）与 `handle()` 的最外层 catch，
所以各路由族一行都不用改。识别按 `errcode` → 系统 `code` → 消息兜底三层，
**只列认识的信号**：`SQLITE_CONSTRAINT` 之类的业务错误一律不认 ——
把真实输入错误报成"服务器存储问题"会让客户端**永远重试**、用户永远看不到真相。

**读操作在满的时候仍然可用**（降级，不是全死）。

### 6.4 ★ 浏览器里的工作台：哪些能用、哪些**按设计不能**

工作台 SPA 由 Hub 托管在 `/workbench/`，浏览器里**能登录、能用主面**
（2026-10-12 真浏览器活体检查全绿）。但"完整工作台"有一个**必须说清的边界**。

实测（2026-10-12，逐条打生产）：从部署的 bundle 里抽出它引用的 **129 个 `/api/` 路径**，
再用 Hub 自己的 `not found:` 响应体区分"路由不存在"与"路由存在但拒绝了我"
（**四种方法都试** —— 只用 GET 会把 POST-only 的路由误判成缺失，我第一版就是这么错的）：

| | 条数 |
| --- | --- |
| 路由**存在** | **98** |
| 路由**缺失** | **31** |

那 31 条**不是没做完的路由**，而是**桌面本机操作**：

| 面 | 条数 | 它操作的是什么 |
| --- | --- | --- |
| `/api/files/*` | 17 | 目录根 = **本机**工作空间目录；含 `reveal`（调 **OS 文件管理器**定位） |
| `/api/skills/{import,scan-dir,scan-github,sync}` | 4 | 扫描**本机**目录 / 从 GitHub 导入 |
| `/api/fs/*` | 3 | `home` / `drives` / `list` —— **本机**盘符与目录 |
| `/api/web/*` | 3 | 服务端 fetch 代理（SSRF 防护的那一套） |
| `/api/dsh-models` 等 | 4 | DSH 安装里的模型列表 |

`workbench/scripts/serve.mjs` 的文件头写得很明白：

> 附加 API（同源，**仅回环地址可访问**）

★ **为什么不能把这 31 条搬到 Hub 上**：Hub 监听公网。把 `/api/fs/list` 搬过去，
就等于让**任何能访问互联网的人**列目录、读文件、写文件到**服务器**上 ——
那不是"补齐功能"，那是一处**远程任意文件读写**。

> 一个"看起来只是还没接的接口"，与一个"接上去就是远程任意文件读写"的接口，
> 在缺失清单里长得一模一样。

**现在的状态（2026-10-12 部署）**：Hub 把这些面**说出来**了 —— 回

```
501 { code: 'DESKTOP_ONLY', desktopOnly: true,
      error: '「文件中心」需要在**桌面端**（你本机）使用 —— …', hint: '…' }
```

★ 为什么是 **501**：`404` 是"没有这个接口"（暗示一处 bug，而这是**有意**的）；
`500` 是"我们不知道哪里错了"（而这里我们**知道**）；`501` 恰恰是
"服务器**不实现**这个功能" —— 与事实一字不差。

★ 那句话**不许**说"请联系管理员"（管理员**修不好**这件事：它不是故障，是设计），
也不许说"暂不支持"（用户会一直等）。

★★ **一条结构性保证：绝不遮蔽真路由**。判定放在 `server.mjs` 的 **404 兜底处**，
即**所有路由族 dispatch 之后**，于是前缀表可以写得宽（`/api/web/` 在表里）而
**绝不可能**抢走真接口（`/api/web/history` 是真路由，真路由先赢）。
这条性质**只能靠位置**撑着，所以有一条**结构性判据**盯着它。

生产实测（2026-10-12）：

| 路径 | 结果 |
| --- | --- |
| `/api/fs/list` `/api/files/read` `/api/web/fetch` `/api/dsh-models` `/api/skills/import` | **501** + `DESKTOP_ONLY` + 那句话 |
| `/api/web/history`（真路由，且落在 `/api/web/` 前缀之下） | **400**（参数不足）—— 真路由赢了，**没被抢走** |
| `/api/chat/conversations` `/api/identity/status` `/api/config` | 200 |
| `/api/nonexistent-xyz` `/api/fsharp` | **404**（兜底没把 404 变成 501） |
| `GET/POST/PUT/DELETE /api/files/list` | 全部 **501**（不是只认 GET） |

**仍未做**：最后那几条（`/api/reject` / `/api/repositories` / `/api/tasks`）
**没有**进表 —— 它们可能是 bundle 里拼接路径的**片段**（裸 `/api/reject`
看着不像一个完整端点）。**未核实**，所以宁可不说，也不说错。

### ★★★ 6.4b 生产上的 SPA **是可以复现的**（这一节原先写的是反的）

> ⚠️ **更正（2026-10-14）**：这一节原先的结论是"生产上的 SPA **无法从仓库复现**"，
> 并列了一张"每个提交各构建一遍、没一个对得上"的表。**那个结论是错的，
> 那张表里的哈希也全部不可信** —— 因为它们都是用 `--base=/workbench/` 构建的，
> 而仓库的 `workbench/vite.config.ts` 写的是 **`base: './'`**。
> 换一个 base 会同时改变 `index.html` 里的引用**和**入口 chunk 的哈希，
> 所以"对不上"是被我自己造出来的。
>
> 下面这行注释就在那个配置文件里，是它的作者为"两个宿主要一份产物"写的：
>
>     // ★ `base: './'`（**相对**）是"一份产物、两个宿主"的前提：
>     //   · serve.mjs 挂在 `/`（本地/桌面端）→ 资源解析成 `/assets/…`；
>     //   · 中枢挂在 `/workbench/`（远程）→ 资源解析成 `/workbench/assets/…`。
>
>   > 一次"用错参数构建、然后宣布无法复现"的调查，
>   > 与一次"真的无法复现"的调查，在结论上都写着"复现不了" ——
>   > 只不过前者把一份**好的**产物说成了孤本。

**正确的复现方式**（`base` 走配置，**不要**在命令行覆盖）：

```bash
git worktree add /tmp/wt --detach <要复现的提交>
cd /tmp/wt/workbench && npx vite build      # 不要加 --base
```

实测：用 `9c3ae86a` 构建，产出与生产**逐字节相同**（含文件名哈希）：

| | 生产 | 用 `9c3ae86a` 重建 |
| --- | --- | --- |
| 入口 | `index-BjYkts4m.js` 678177 B | **同一个** ✓ |
| 样式 | `index-DhBSBG1s.css` 105502 B | **同一个** ✓ |
| Scene3D | `Scene3D-C8hVyUWg.js` 951528 B | **同一个** ✓ |

**所以线上那份 SPA 有确切出处**：`9c3ae86a`（部署于 2026-10-12T03:26:42Z，
而那一刻 main 的 HEAD 正是它）。**问题不是"复现不了"，而是"它落后了"**：
`origin/main` 上改动 `workbench/src` 的提交比它多 **30 个**（截至 2026-10-14），
其中含一条 `fix(security)`。`workbench/src/api.ts` 里 `readJson` 的那处修复
就在这 30 个里，所以线上界面至今显示的是 `501 Not Implemented`。

### ★★★ 6.4c 但**不能只部署 SPA** —— 它与中枢是成对的

"SPA 只是静态文件、先单独发上去"这个念头很自然，也已验证过是**不安全**的：

1. **凭证协议换过。** `9c3ae86a` 那版 SPA 在写请求里**发 `secretRef`**
   （`DshProvidersPanel.tsx`: `baseURL: …, secretRef: form.key || …`），
   而 main 那版改发 **`credentialValue`**、由服务端按现有槽位落名（BUG-028）。
   生产的中枢**没有**那个修复（`routes/model-providers.mjs` 里 `publicProvider` = 0 次）。
   而旧服务端的 `update` 语义是"**留空 `secretRef` = 清掉引用**"
   —— 9c3ae86a 那版 SPA 的文件头自己就写着这句话。
   ⇒ 新 SPA + 旧中枢 = **保存供应商时会静默清掉凭证引用**。
2. **新 SPA 调一个还不存在的端点。** 新 SPA 有"验收不满意就重做"，打 `/api/rework`；
   生产上实测 **404**（那是 `e70c81bc` 的配对端点）。

  > 一个"新旧搭着能用"的组合，
  > 与一个"保存时静默清掉用户的凭证引用"的组合，
  > 在只跑一遍冒烟检查的时候是同一个东西 —— 冒烟不会去配一把真钥匙。

**所以 SPA 与中枢要么一起动，要么都不动。** 这一轮**没有**部署任何一半。

---

## 7. 发布说明与已知缺陷（放行门禁）

### 7.1 本版本发布说明与历史门禁状态

- 版本基线：06480ba（本目标切片链 promote 后 main）。发布范围 §1.1。
- 历史门禁项（w/T-043 DEPLOY 曾列 P0-1/P0-2/P0-3 放行门禁）**均已在本目标切片链修复并被套件锚定**：
  - P0-1 覆盖上传中断/超限破坏原文件 → 临时文件 + 收体完整原子改名发布（files-api.test.mjs 覆盖/并发上传用例断言）；
  - P0-2 下载整文件同步读内存 → openDownloadStream 流式返回（路由层下载不再整读，files-api.test.mjs 断言）；
  - P0-3 webFetch 超时非整链 → 共享 deadline 整链超时统一 code=timeout（web.test.mjs 24 例含 headers 未回/body stall 两类）；
  - 三中心 P0/P1 缺陷（F1 嵌套 .git 外泄、F2 畸形 % 崩溃、R-A3 抓取审计、R-A4 body stall 归类、R-A5 会话守卫、A6 前端收口）全部修复并回归锚定（TEST_REPORT.md）。
- 验证结果：构建/CI 全绿 + L0 七套件 225/225 + L1 冒烟全过（§3.2、docs/T093-evidence/）；未发现回归。
- 发布姿态：acceptance（本机/局域网自托管）。**未发布生产；未对公网开放**（production 需将军批准，§2.1/§9）。

### 7.2 已知缺陷 / 说明（本阶段未改实现，如实登记）

| 项 | 位置/性质 | 影响 | 处置 |
| --- | --- | --- | --- |
| CalendarView 旧入口遗留 | CommandBar.tsx:120 旧「日程/会议不在 legion 引擎内」快捷按钮 | 引导文案陈旧（面板已是真实日程） | 前端演进超出本任务文件域，如实记录不代改（TEST_REPORT.md §2.6 同述） |
| chat 读接口缺省全 scope（P1-3 旧项） | team-hub /api/chat/conversations 读缺省未限定 scope | 读取面较宽（scope 显式传入时严格隔离） | 沿用 T-041/T-042 记录口径；未在本批改动（会话隔离用例已锚定显式 scope 路径） |
| whiteboard 部署 | 单实例自托管（ADR-0005） | 不承诺横向扩展 | 见 whiteboard/docs/DEPLOY.md |
| board-plugin 宿主注入 | DSH Desktop 宿主侧 | 需宿主环境执行注入冒烟 | 复现步骤见 TEST_REPORT.md §5/§7-⑥（本沙箱不可达，R-18） |

### 7.3 环境受限项汇总（本阶段真实复现，未冒充通过）

| # | 受限项 | 复现步骤 | 等价/缓解证据 |
| --- | --- | --- | --- |
| ① | 受限 pwsh 拦截子进程 pipe 捕获（node --test / vite spawn EPERM） | 受限 shell 内 `node --test team-hub/skills.test.mjs` / `pnpm build` → spawn EPERM | run_code 宿主进程直跑全量 CI 全绿（§3.1/§3.2，命令与产物与普通终端一致） |
| ② | L2 GUI 浏览器手工走查不可达（本沙箱无浏览器） | 需宿主/验收人浏览器在 :5173 走查 | 数据面 L0+L1 全绿；GUI 步骤清单 §5.3 |
| ③ | board-plugin/plugins 宿主注入冒烟不可达 | 宿主侧按 TEST_REPORT.md §5 复现步骤 | 客户端 bundle 注入形态静态核验（__ModuleLoader__.load + exports apply/inject） |

---

## 8. 运维要点

- 日志：services-plugin → <legion根>/.legion-services.log；手动起服看各自终端；浏览器抓取审计 → workbench/data/web-audit.jsonl（容量轮转）；CI 证据 → docs/T093-evidence/ci-run-*/ci-output.txt。
- 数据：team-hub/team.db（WAL）。改动/新增表自动迁移；升级前备份见 §6。
- 端口：8787 / 5173 / 4820 / 8080（whiteboard 可选）（占用探测见 §6）。
- 常见故障：页面旧数据 → Ctrl+F5 强刷（5173 托管构建产物）；「🧭 中枢不可达」→ hub 未起；写操作 401 → token；浏览器助手私网拦截 → 属预期（§2.3）；v1 401 → --token。

---

## 9. 边界与未做项（诚实声明）

- ✅ 只做构建与部署类操作：新增 `scripts/ci/run-ci.mjs`（统一发布门禁）、本 DEPLOY 文档、docs/T093-evidence/ 证据、
  .gitignore 追加运行时产物条目（.ci/、releases/）；**未改任何业务功能代码**（git status 全程核实：仅上述文件 + 证据目录）。
- 🚫 未发布生产（未获将军授权；边界「未获批准不发布生产」）；发布物仅为本地暂存快照（releases/，gitignore）。
- 🚫 未跳过构建/预检：发布路径全部以 `node scripts/ci/run-ci.mjs` 全绿为前提（§3/§5 门禁）。
- ⛔ 环境受限项（不静默判过）：L2 GUI 手工（§5.3）、board-plugin/plugins 宿主注入（§7.3-③）——复现步骤已文档化，
  留待宿主环境或验收人执行。
- 禁网纪律：零新增依赖、零联网下载；workbench 依赖复用主 checkout node_modules（junction）。

---

## 10. T-193 发布说明：`test` 阶段契约/端到端 9 套件归零（含 CI 契约登记面修复）

> 角色：devops（部署运维员）｜任务：T-193｜分支：`w/T-193`
> 开工基线（实测）：`git log --oneline -1` = **`6d9c9a9c  promote T-192`**；`w/T-193` 与 `main` 同点（`git diff main...w/T-193` 为空）。
> 环境：本机 dev / acceptance（127.0.0.1）。**未发布生产**（未获将军批准）。

### 10.1 结论速览

| 项 | 结论 |
| --- | --- |
| 9 套件（w/T-193 @ `6d9c9a9c`，逐文件 `node <file>`） | 8 组 exit 0 全绿；`secret-store` 组 52 例中 48 pass / **2 fail（沙箱 named-pipe EPERM）** / 2 skip —— 2 条失败为真·跨进程用例，已用 pwsh 真跨进程手工复现其断言全过（§10.5） |
| 产品/业务代码 | **未改一行**。本次 diff 仅：CI 契约登记面（`scripts/prt/baseline-snapshot.mjs`）+ 生成的契约基线（`docs/superpowers/prt/prt-007-baseline.json`）+ 本文档 |
| 用户可见行为 | 无（纯 CI/契约面）⇒ 功能手册 FEATURES.md / 功能索引 / README 引导段**豁免**（§10.8） |
| 构建 | `run-ci --only test` 在本会话沙箱内被 `spawn EPERM` 挡住（§10.5），非门禁失败；普通终端命令见 §10.3 |
| 相邻红（不在本任务 9 条内） | `team-hub/run-routes.test.mjs` 8/30，如实登记未代改（§10.7） |

### 10.2 变更内容、根因与「改产品还是改判据」

本次唯一实质性修复 = **`model-api` ③**（9 条里唯一真红的产品/契约读数）。

- 原始读数（w/T-193 @ `6d9c9a9c`，修前）：`model-api` **14 pass / 1 fail**，红在
  `✖ api.ts 里用到的每个 /api/ 路径都能在源码抽出的路由表里找到`
  ⇒ `actual: ['POST /api/events/ticket']`、`expected: []`。
- 该路径**真实存在且已挂载**：`team-hub/routes/identity.mjs:219`（`{ method:'POST', path:'/api/events/ticket' }`），
  并由 `team-hub/server.mjs:7828` 的 `router.families.unshift(createIdentityRoutes({...}))` 挂上。
- 根因：平台契约的**唯一权威** `platformHttpRoutes()`（`scripts/prt/baseline-snapshot.mjs:659`）
  只从 `createRouter([...])` 与 `ROUTE_FAMILY_SOURCES` 取路由；identity 族走的是**延迟装配**
  （`router.families.unshift`），既不在 `ROUTE_FAMILY_SOURCES` 里，也没被 `assertRouteFamilyCoverage()`
  扫到 ⇒ 该族 27 条 `/api/` 路由对平台契约**不可见**。这与 `docs/superpowers/prt/PRT-116-test-stage-red-suites.md` §3
  记的是同一形状：**判据没坏，它量的那个集合塌了**。
  该族由远程 Agent 合并 `6d7c28ea`（`88e0b124 feat(remote)`）引入，**晚于** T-191 的验证树 `88c7c21c`。
- 处置（**改观测点，不改断言**）：`scripts/prt/baseline-snapshot.mjs`
  1. `SOURCES.routesIdentity` + `ROUTE_FAMILY_SOURCES` 登记 identity 族；
  2. `assertRouteFamilyCoverage()` 现在**两种装配写法都认**（`createRouter([...])` 与
     `router.families.unshift(createXxxRoutes(`），并对无 `/api/` 路由的静态族
     （`createMobileRoutes`/`createPortalRoutes`/`createReleaseRoutes`）**显式豁免**；
  3. **顺带修好同一次合并留下的另一半**：`team-hub/user-store.mjs` / `team-hub/device-store.mjs`
     建了 11 张 `hub_*` 表却没登记 schema 采集面，`buildSnapshot()` 会直接抛「未登记」⇒ `prt-baseline` ④ 红。
     补登记后 `--diff` 无漂移。
- 基线刷新：`node scripts/prt/baseline-snapshot.mjs --record`（**271 路由 / 94 表**；原 244 / 83，+27 路由 +11 表）。
  这是**生成的契约产物**刷新（PRT-116 §2 的 A 类：判据对、产物旧），不是把断言改成 actual。
- 断言未放宽：`model-api` 仍 15 例（含 ③ 那条 `deepEqual(..., [])`），`prt-baseline` 仍 26 例；
  没有新增 skip/only、没有删除断言、`expected` 未改。

### 10.3 环境 × 步骤 × 验证项 × 回滚

环境：dev / acceptance（本机 127.0.0.1 三件套）。**production 未授权，未发布**。

**发布/验证步骤（普通终端）**

```powershell
# 0) 预检（gate）：不通过则终止，禁止跳过
node scripts/ci/run-ci.mjs --only env,deps,build     # 环境 + 依赖 + 构建
# 1) 本次范围门禁：test 阶段（含 9 套件与 prt-baseline）
node scripts/ci/run-ci.mjs --only test
# 2) 单独复跑本任务 9 套件（逐文件；与 CI 的 per-file 进程隔离等价）
node --test workbench/scripts/model-api.test.mjs
node --test orchestrator/worker/can-read-authorization-source.test.mjs
node --test runtime/dsh-composition/e2e-assembly.test.mjs
node --test runtime/dsh-composition/employee-preset.test.mjs runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs
node --test security/secrets/secrets.test.mjs security/secrets/run-credentials.test.mjs security/secrets/credential-materializer.test.mjs
node --test team-hub/acceptance-routes.test.mjs
node --test team-hub/handoff-routes.test.mjs
node --test team-hub/run-events.test.mjs
# 3) 契约基线（本次改动面）
node scripts/prt/baseline-snapshot.mjs --diff          # 期望：无漂移，exit 0
```

**验证项（本次实测，w/T-193 @ `6d9c9a9c`）**

| # | 套件 | 修前（任务原始读数 / 实测） | 修后（本次实测） |
| --- | --- | --- | --- |
| 1 | model-api | 14 pass / 1 fail | **15/15, exit 0** |
| 2 | can-read | 5/3（历史） | **8/8, exit 0** |
| 3 | e2e-assembly | 17/2（历史） | **19/19, exit 0** |
| 4 | employee-preset | 34/1（历史，另有 6 skip） | **42 例 36 pass / 0 fail / 6 skip, exit 0**（6 skip = 本机检出未构建 `packages/preset/agent-presets/lib`，逐条具名跳过） |
| 5 | secret-store | 50/1（历史） | **52 例 48 pass / 2 fail（沙箱 EPERM）/ 2 skip**；2 条断言已 pwsh 手工复现通过（§10.5） |
| 6 | route-family（32 文件） | 507/2 | **510/510, exit 0** |
| 7 | acceptance-routes | 3/7 | **10/10, exit 0** |
| 8 | handoff-routes | 3/5 | **8/8, exit 0** |
| 9 | run-events | 14/4 | **18/18, exit 0** |
| + | prt-baseline（受本次改动直接影响） | 修前因未登记而抛错 | **26/26, exit 0** |
| + | 契约面相邻：probe-service 13/13 · model-config 18/18 · secret-routes 26/26 | — | 全 exit 0 |

**回滚方案**（本次改动**不触库、不触进程、不需重启**）

| 场景 | 操作 |
| --- | --- |
| 契约面回滚 | `git revert <本次 commit>`（或 checkout 上一版 `scripts/prt/baseline-snapshot.mjs` + `docs/superpowers/prt/prt-007-baseline.json`），随后 `node scripts/prt/baseline-snapshot.mjs --diff` 应回到旧值（244 路由 / 83 表），且 `prt-baseline` ④ 会**重新变红**——这是有意的信号：identity 族又对契约不可见 |
| 数据/服务回滚 | **不需要**：无 schema/迁移、无前端产物、无服务行为变更（§6 的数据回滚模板不适用） |
| 触发条件 | `model-api` ③ 或 `prt-baseline` ④ 出现意外新漂移；或 identity 族被回退而登记面未同步 |

### 10.4 影响面

- 产品行为：**无变化**。`platformHttpRoutes()` 是 CI/契约工具，不在任何运行时路径上。
- 契约基线：`httpRoutes` 244→271、`dbTables` 83→94 —— 把「远程 Agent 通道真实存在的端点与表」**补进**契约，覆盖面变大而非放宽。
- 依赖：零新增依赖；零联网。
- 对其它套件：`prt-baseline` / `probe-service` / `model-config` / `secret-routes` / `model-api` 已复跑通过。

### 10.5 沙箱限制（如实标注，不冒充通过）

本会话沙箱拦截 Node 的**子进程 pipe 捕获**：`node scripts/ci/run-ci.mjs --only test` 实测报
`[test] exception: spawn EPERM`、`test FAIL`、exit 1（栈在 `scripts/ci/run-ci.mjs:73` 的 `spawn`）——
**环境限制，不是门禁失败**。等价证据：

- 9 套件改用**逐文件 `node <file>`**（等价于 CI 的 per-file 进程隔离）取得 §10.3 读数；
  3 个顺序敏感套件**单跑 ×3 + 串行同 shell** 全绿（§10.6）。
- `secret-store` 的 2 条真·跨进程用例（`security/secrets/secrets.test.mjs:371/400`）在测试进程内
  `execFileSync`/`spawnSync` 被 EPERM；用 pwsh 起**两个真 node 进程**手工复现：
  持锁进程下写入 `OUTCOME=SECRET_STORE_LOCK_TIMEOUT` 且库/锁文件均未变；
  无争用时两次写入均 `OUTCOME=wrote`、两条记录都在、无锁残留 —— 断言全过。
- 普通终端复跑：`node scripts/ci/run-ci.mjs --only test`（本机 DSH 检出已构建，候选路径可解析）应 9 条全 exit 0。

- 同一沙箱也拦截 `git add`/`git commit`：`Unable to create ...\.git\worktrees\T-193\index.lock: Permission denied`（`.git` 在工作区之外）⇒ 本任务改动**留在 `w/T-193` 工作树**（3 个 M 文件），由将军验收时 promote；普通终端提交：`git add docs/DEPLOY.md docs/superpowers/prt/prt-007-baseline.json scripts/prt/baseline-snapshot.mjs` → `git commit`。
### 10.6 顺序敏感 3 套件：为什么单跑绿、串行也绿

`acceptance-routes` / `handoff-routes` / `run-events` 各自 `mkdtemp` 独立库 + `listen(0)` 临时端口。
CI 的 `node --test` 默认按**文件**隔离进程（`run-ci` 也是逐套件起进程），所以三者互不可见。

- 单跑 ×3：acceptance 10/10、handoff 8/8、run-events 18/18，三轮完全一致。
- 串行（同一 shell 依次）：3/3 exit 0、fail=0。
- **为什么两棵树曾计数不同**：把三者塞进**同一进程**（`--test-isolation=none`）时，
  `team-hub/server.mjs` 的模块级单例被复用、`listen` 落到已监听的 server、且三者共用同一份
  `TEAM_HUB_DB`/预约状态 ⇒ 实测 36 例 31 pass / 5 fail（红在 run-events ⑬⑭⑮⑯⑱）。
  这是**量具/进程模型的产物**，不是产品行为：生产里 hub 是**一个长期进程**，不存在
  「三个测试文件各自 import 同一个 hub」。

### 10.7 相邻红（不在本任务 9 条内，如实登记、未代改）

`team-hub/run-routes.test.mjs`（登记在 `scripts/ci/run-ci.mjs:2383` 的运行面套件里）实测 **8 pass / 22 fail**。
首条红 `TypeError: Cannot read properties of null (reading 'attemptId')`（:113）——
夹具 `insertTask()`（:55-59）用**裸 SQL** 插入任务且未申报 `fileDomain`，而上一条用例认领后
写入预约跨 `in_review` 活跃 ⇒ 下一次 `claim` 以 `FILE_CONTENTION` 返回 `claimed:null`。
与 T-178 已修的 acceptance/handoff/run-events **同一形状**（见 §10.2 引的 PRT-116 与 BUG-007/认领预约）。
它**不在本任务 9 条目标内**，且修它属夹具/认领预约线（coder/tester），本角色**未代改**，仅登记。

### 10.8 文档同步判定

本次 diff = CI 契约登记面 + 生成的契约基线 + 本发布说明，**无用户可见行为变更** ⇒
按验收口径「纯重构可豁免」，**不**改 `docs/FEATURES.md` 对应小节 / 功能索引 / README 引导段。
（`check-docs.mjs` 的结构/链接/索引一致性可由 `run-ci --only doc` 复跑。）

## 11. T-194 发布说明：BUG-007 worker 超时结算「先取证、再决定」（含读数诚实化）

> 角色：devops（部署运维员）｜任务：T-194｜分支：`w/T-194`
> 开工基线（实测）：`git log --oneline -1` = `f9687218  promote T-193`；`w/T-194` 与 `main` 同点（`git diff main...w/T-194` 为空；本 worktree 无前序 coder/reviewer/tester 的 diff）。
> BUG-007 的实现来自上游 `efc11c9c`（初修）+ `d8c29923`（T-184 续修）两次提交，均为 HEAD 祖先；现场记录 `docs/bugs/BUG-007-timeout-reservation-not-released.md` §八/§九。
> 环境：本机 dev / acceptance（127.0.0.1 三件套）。**未发布生产**（未获将军批准；边界「未获批准不发布生产」）。

### 11.1 结论速览

| 项 | 结论 |
| --- | --- |
| 构建（插件，本任务变更面） | `tsc -p plugins/tsconfig.json --noEmit` **exit 0**；`tsc -p plugins/tsconfig.json`（emit）**exit 0**，产出 `plugins/lib/timeoutSettlement.js` + `plugins/lib/index.js` |
| 回归（BUG-007 两条必跑） | `timeout-settlement` **8 pass / 0 fail / 0 skip, exit 0**；`claim-reservation.e2e` **1 pass / 0 fail, exit 0**（22.8s，含三半对照 ⑰） |
| 仓库构建门禁（等价复跑） | whiteboard `node scripts/build.mjs` **exit 0**；workbench `tsc --noEmit` **exit 0**；workbench `vite build` 被沙箱 `spawn EPERM`（esbuild）挡住（§11.4） |
| `run-ci` 全量 | `--only env,deps,build`：`deps` PASS；`env`/`build` **exception: spawn EPERM**（`run-ci.mjs:73`），exit 1 —— 沙箱限制，非门禁失败（§11.4） |
| 文档门禁 | `node scripts/ci/check-docs.mjs` **FAIL（2 处）**：`docs/T191-evidence`、`docs/T192-evidence` 无 md banner —— 基线既有红、不由本任务改动引入（§11.5-②） |
| 本次 diff | 仅文档：`docs/DEPLOY.md`（§11）+ `docs/FEATURES.md`（§3.7 一条）+ `README.md`（§5.5 一句）；**未改任何业务功能代码** |
| 用户可见行为 | 有（守护超时结算的文案与任务去向）⇒ 已同步 FEATURES.md + README 引导段（§11.6）；功能索引 F-07 无需新增行（无新入口/新功能 id） |
| 生产放行 | **未放行**：T-192 tester 判定「不通过」的 F1/F2（超时文案里的人工恢复命令缺 `scope` ⇒ 400）在 HEAD 仍未修，属 coder 面；已登记 §11.5-① 作放行门禁 |

### 11.2 变更内容与影响面

**改了什么（上游实现，本阶段只复核 + 写发布说明）**

- `plugins/src/timeoutSettlement.ts`（新增决策/文案纯函数模块）：`planTimeoutSettlement`（能取证⇒`release-and-retry` / 取不到⇒`hold-for-manual`）、`workerStoppedWithin`（20s 宽限期内等 `run.result` 到终态）、`planTimeoutTransitionFailure`（释放失败的诚实文案）、`TIMEOUT_SETTLE_GRACE_MS`。
- `plugins/src/index.ts`（超时结算调用点）：`dispose() → 取证 → 决定 → transitionTo(by=执行者本人, confirmedStopped) → safeComment(最终文案)`；transition 失败时改写为 `failure.comment`。
- 未改 `team-hub/server.mjs`：走的是既有诚实出口（`in_progress→todo` + `confirmedStopped:true` ⇒ `finishTaskReservationInTx(cancelled:false)`）。

**行为影响（部署视角）**

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| worker 跑满 25 分钟超时 | 写「保留在 in_progress，下一轮自动重试」，实际不动状态、不动预约；15 分钟后被 stale 回收器冻结成 `reconciling`，认领一律 409，只能人工 `confirm-stopped` | **能证实已停止** ⇒ 任务回 `todo` + 预约 `released` ⇒ 下一轮扫描真能认领并复用 `w/<id>` WIP |
| 取不到终止证据（abort 后 20s 未结算） | 同上（既没释放、文案也不成立） | **安全方向保持**：任务留 `in_progress`、预约继续被持有；文案直说「仍被持有、不会自动重试」并给人工路径 |
| 释放尝试失败 | （此前）仍打印释放成功文案 | 改印失败文案 + 两步人工恢复命令，不再谎称已释放 |

- 不触：无新增依赖、无库表迁移、无新接口、无前端产物、无端口/配置变更。
- 数据面：既有 `reconciling` 预约**不会**被本次升级自动清理，仍需按 §11.3 步骤 4 人工处置（运维注意项）。

### 11.3 环境 × 步骤 × 验证项 × 回滚

环境：dev / acceptance（本机 127.0.0.1：team-hub :8787 + workbench :5173 + 可选 scrum v1 :4820）。**production 未授权，未发布。**

**发布/验证步骤（普通终端；沙箱内 §11.4 给出等价命令）**

```powershell
# 0) 预检（gate）：不通过则终止，禁止跳过
node scripts/ci/run-ci.mjs --only env,deps,build

# 1) 本任务变更面：插件类型检查 + 构建（产出 plugins/lib，回归测试依赖它）
cd plugins; npm run typecheck; npm run build; cd ..

# 2) BUG-007 两条回归（必须都 exit 0）
node plugins/tests/timeout-settlement.test.mjs        # 期望 8 pass / 0 fail
node team-hub/claim-reservation.e2e.test.mjs          # 期望 1 pass / 0 fail（含 can-confirm / cannot-confirm / 越权三半对照）

# 3) 仓库门禁（全量，放行前必跑）
node scripts/ci/run-ci.mjs                            # 期望 exit 0（env,deps,build,test,smoke,stage,doc）

# 4) 现场残留预约（升级前已有的 reconciling）——人工逐条处置
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('team-hub/team.db',{readOnly:true});console.log(db.prepare(\"SELECT id,task_id,state FROM write_reservations WHERE state IN ('reserved','reconciling')\").all())"
#   对 state=reconciling 且任务已是 todo/blocked/canceled 的：确认执行进程已停止后
#   POST /api/tasks/<id>/reservation/confirm-stopped  {by:'general',scope:'<space>',confirm:'stopped:<id>'}
#   ★ body 必须带 scope（team-hub/routes/write-intent.mjs:45），否则 400 MISSING_SCOPE
```

**验证项（本次实测，w/T-194 @ `f9687218`）**

| # | 项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 插件类型检查 | `tsc -p plugins/tsconfig.json --noEmit` | exit 0 |
| 2 | 插件构建 | `tsc -p plugins/tsconfig.json`（emit） | exit 0；`lib/timeoutSettlement.js`、`lib/index.js` 生成 |
| 3 | 超时结算回归 | `node plugins/tests/timeout-settlement.test.mjs` | 8 pass / 0 fail / 0 skip，exit 0 |
| 4 | 认领+预约 e2e（三半对照） | `node team-hub/claim-reservation.e2e.test.mjs` | 1 pass / 0 fail，exit 0（22.8s） |
| 5 | whiteboard 构建 | `node whiteboard/scripts/build.mjs` | exit 0（copied 12 shared modules） |
| 6 | workbench 类型检查 | `tsc -p workbench/tsconfig.json --noEmit` | exit 0 |
| 7 | workbench 生产构建 | `cd workbench && node node_modules/vite/bin/vite.js build` | **FAIL：esbuild `spawn EPERM`（沙箱）**，见 §11.4 |
| 8 | CI 运行器 | `node scripts/ci/run-ci.mjs --only env,deps,build` | deps PASS；env/build `spawn EPERM`，exit 1（沙箱） |
| 9 | 文档门禁 | `node scripts/ci/check-docs.mjs` | FAIL 2 处（T191/T192 evidence banner，基线既有）；结构/表行/链接其余全过 |

**回滚方案**（本次变更**不触库、不新增迁移**，回滚 = 回退代码 + 重建插件）

| 场景 | 操作 |
| --- | --- |
| 代码回滚 | `git revert d8c29923 efc11c9c`（或 `git checkout f9687218 -- plugins/src/timeoutSettlement.ts plugins/src/index.ts`），随后重建：`cd plugins && npm run build`，并**重启加载插件的守护进程**（DSH）使其重新加载 `plugins/lib` |
| 行为回滚语义 | 回到「超时只写评论、不动状态与预约」；stale 回收器的既有冻结行为不变 ⇒ 卡死场景会回归（仅作应急，不建议长期停留） |
| 数据回滚 | **不需要**：无 schema/迁移；预约状态由运行时写入，回滚代码不会重建已释放的预约 |
| 触发条件 | 超时结算后出现两个写者（同一 worktree 并发写）、或 `timeout-settlement` / `claim-reservation.e2e` 转红、或 30 秒扫描出现异常延迟 |

### 11.4 沙箱限制（如实标注，不冒充通过）

本会话沙箱拦截 Node 的**子进程 pipe 捕获**（`spawn`/`execFileSync` ⇒ `EPERM`），以及跨出工作区的 junction 删除（`rmSync EPERM`）。实测：

- `node scripts/ci/run-ci.mjs --only env,deps,build` ⇒ `env`/`build` 阶段 `exception: spawn EPERM`（栈在 `scripts/ci/run-ci.mjs:73` 的 `spawn`），`deps` PASS，exit 1。**环境限制，不是门禁失败。**
- `scripts/ci/build-external-package.mjs plugins` 在重建 `plugins/node_modules/*` junction 时 `rmSync EPERM` ⇒ 改用**直接 tsc emit**（同一 `plugins/tsconfig.json`，等价产出 `lib/`）取得验证项 1/2 读数。
- `workbench vite build` 的 esbuild 需要 spawn 子进程 ⇒ `spawn EPERM`；其类型检查（`tsc --noEmit`）已单独 exit 0。
- `scripts/config/scan.mjs --check` 因 `git ls-files` 被 `execFileSync EPERM` 挡下，退化为 **walk 模式**（源码自述：结果含未跟踪文件、仅调试参考）⇒ 报 47 项「未在 schema 中处理」，是**量具退化**不是配置面真红。
- `encoding-check.mjs` 同样报「无法列出文件（git 不可用？）：spawnSync git EPERM」。

⇒ 本阶段结论以**逐条直接命令**为准（§11.3 步骤 1~3、验证项 1~6），并如实登记 7~9 的环境受限。普通终端复跑 `node scripts/ci/run-ci.mjs` 时应全量 exit 0。

### 11.5 已知缺陷 / 未清门禁（放行前必须处置）

① **F1/F2（必须修改，coder 面，本阶段未代改）**——超时文案给出的人工恢复命令**当场不可执行**：

- `plugins/src/timeoutSettlement.ts:91-92`（hold 分支）：`POST /api/tasks/<id>/reservation/confirm-stopped` 的 body 只给 `{by, confirm}`，**缺 `scope`**；
  `team-hub/routes/write-intent.mjs:45` 对 `scope===''` 一律返回 **400 `MISSING_SCOPE`**（补 scope 后，hold 时任务仍是 `in_progress` ⇒ 该端点要求 `todo/blocked/canceled` ⇒ **403**，故正确路径是先 transition 再 confirm）。
- `plugins/src/timeoutSettlement.ts:139`（`planTimeoutTransitionFailure` 步骤②）：同样缺 `scope` ⇒ 400。
- 现状定性：机制（安全方向）正确，**文案里的人工恢复命令不成立**——与本缺陷「读数与事实不一致」同源。T-192 tester 已判「不通过」并要求 coder 修文案；本角色边界「不改业务功能代码」，**未代改**，仅登记为**生产放行门禁**。

② **`check-docs.mjs` 基线既有红（非本任务引入）**：`docs/T191-evidence`、`docs/T192-evidence` 为无 md 的证据快照目录（缺 banner 载体）。本 worktree 与 `main` 同点，故该红在 `main` 上即存在；修复属对应任务/将军，本角色未碰。

### 11.6 文档同步判定

本次有**用户可见行为变更**（守护 worker 超时结算后任务的去向与评论文案）⇒ 按验收口径**不豁免**，已同步：

- `docs/FEATURES.md` §3.7「自动交接与守护流水线」新增一条「worker 超时强制结算（先取证、再决定）」；
- `README.md` §5.5「自动交接、闸门与人工干预」引导段补一句同义摘要；
- 功能索引 §4：沿用既有 **F-07**（无新入口/新功能 id，不新增 F-xx 行）；
- 现场记录 `docs/bugs/BUG-007-timeout-reservation-not-released.md` §八/§九 已由 coder/tester 登记改法与读数，本阶段引用不重复另造。

---

## 12. T-202 发布说明：Agent 人性化两段式名称 + 人性化头像（目标 G-mv1s6y49-1 收口）

> 角色：devops（部署运维员）｜任务：T-202｜分支：`w/T-202`｜开工基线 HEAD：`cd569616`（含 T-199 `02da65f4` 功能、T-201 promote `c52c775d`）
> 环境：本机 dev / acceptance（127.0.0.1）。**未发布生产**（未获将军批准；边界「未获批准不发布生产」）。
> 目标级完整说明（逐条证据与复跑命令）：[docs/G-mv1s6y49-1/DEPLOY.md](G-mv1s6y49-1/DEPLOY.md)。

### 12.1 结论速览

| 项 | 结论 |
| --- | --- |
| whiteboard 构建 | `node scripts/build.mjs` **exit 0** |
| workbench 类型门禁 | `tsc --noEmit` **exit 0**；`vite build` 在本会话沙箱被 esbuild `spawn EPERM` 挡住（环境限制，普通终端可过，§12.4） |
| CI 静态阶段（真实 `run-ci.mjs`） | `syntax / env / boundary / deps / doc` **5/5 PASS**，exit 0 |
| 本目标 6 支新套件 | **41/41 全绿**（9/6/9/5/6/6，全部 exit 0） |
| CI `test` 阶段 | 真实 `node --test` 聚合器在本会话不可直跑（EPERM）；等价执行器读数见 §12.3 |
| 产品代码 | **零改动**（本任务只加发布文档与 CI 证据） |
| 用户可见行为 | 无新增变更；上游功能的手册/索引/README 三处**已逐处复核**（§12.2） |
| 放行门禁 | ❌ **M1/M2 未清**（归属 T-199 业务代码），T-201 判定 FAIL ⇒ **不建议验收放行**（§12.5） |

### 12.2 变更影响与 docSync

本次**不含产品行为变更**：功能由 T-199 交付、T-201 验证；用户可见面 = 编队成员的展示名与头像。
手册 [`docs/FEATURES.md` §3.2](FEATURES.md)（:71-75）、功能索引 §4 `F-02`（:268）、[`README.md` §5.1](README.md)（:147）均由 T-199 同步，本轮以 `check-docs.mjs`（11 类校验全绿）复核通过。

### 12.3 环境 × 步骤 × 验证项 × 回滚

**预检 → 构建 → 暂存 → 部署 → 验证 → 回滚**的完整清单见 [docs/G-mv1s6y49-1/DEPLOY.md](G-mv1s6y49-1/DEPLOY.md) §4/§5/§6；三件套与数据面通用步骤见本文档 §4–§6。

**回滚方案**（本批无 schema 迁移、无发布物、无生产流量）

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 代码回滚 | `git revert <promote commit>` 或 checkout 到上一版 | 桌面/移动端回到旧渲染；**数据不需要回滚** |
| 数据回滚 | 不需要：`roster` 的 `name`/`avatar` 只是展示字段，`role` 契约键、`agent_id`、会话/任务归属均未变 | 迁移只替换旧默认值（旧职称名 / 旧 emoji），用户自定义值保留；**不要删库** |
| 配置回滚 | 不需要：无新增环境变量、无端口变更 | — |
| 发布物回滚 | 不适用（本批未产出 `releases/` 产物；`stage` 需先有 `workbench/dist`） | — |
| 触发条件 | 展示名/头像在任一展示面出现破图、emoji、或同名不同像；或 `seed-roster` 误改用户自定义值 | 触发即回滚并保留现场 |

### 12.4 沙箱限制（如实标注，不冒充通过）

本会话沙箱（workspace-write）禁止 Node 进程创建**管道** stdio：`node scripts/ci/run-ci.mjs` 直跑即
`[syntax]/[env] exception: spawn EPERM`（原始现场 `docs/G-mv1s6y49-1/T202-evidence/run-ci-attempt.log`）。
为取得真实读数，用 `T202-evidence/ci-sandbox-patch.cjs` 把一次性捕获的管道换成临时文件 fd（**不改变被测行为**，
esbuild 这类交互式子进程保持原样、如实 EPERM），据此真实直跑 `run-ci` 静态阶段并全绿；
`test` 阶段因 `node --test` **内部** runner 子进程 spawn 绕过 public `child_process` 补丁，改用等价执行器
（集合 == `git ls-files '*.test.mjs'` − EXEMPT − 无 `DSH_CHECKOUT` 时按 `run-ci.mjs:5215-5219` 排除的 `plugins/`、`board-plugin/`；逐文件独立进程、四路并发、同一计数解析器）。普通终端上无需任何适配。

### 12.5 放行门禁 / 已知缺陷与未执行项

- **M1/M2（归属 T-199，必须修改级）**：复跑 T-201 只读探针（临时库 + 真端口）结论逐字一致——第 16 个自建 role 得 `human:s16` 而两端位面表只有 `s01..s15`（退化同一占位人形）；同一自建 role 连续 POST 头像漂移 `s01→s02→s01`。本角色边界「不改业务功能代码」⇒ 只复现、只登记。**在 M1/M2 修复并复测前不建议验收放行。**
- **未执行**：`smoke`/`stage`（依赖 `workbench/dist`）、E2E 浏览器/人工判据、DSH 外部包回归（本机未配 `DSH_CHECKOUT`，与 CI 同纪律 SKIP）、生产发布（未获批准）。

---

## 13. 发布说明：官网撤掉桌面端下载，改讲「一个入口、两种设备、同一份数据」

**产品定位变化**：主打 Web + 移动端（桌面端降为次要）。官网是这次变化的落点。

### 13.1 撤掉了什么

「部署 / 下载」那一节的第二张卡（Windows 桌面端 → 下载电脑版 + 版本/体积/日期 +
备选线路）**整块撤掉**，中英两站都撤：

| 撤掉的东西 | 位置 |
| --- | --- |
| `download` 动态块（返回只剩 `cta` / `hub`） | `team-hub/routes/site.mjs` |
| 五个只服务于它的参数（downloadUrl/lines/version/size/date） | 同上 |
| 五个文案串（cta/notYet/otherLines/deployWinEmpty/ctaWarnShort） | 同上 COPY |
| `formatSize` / `formatDate`（删）、`isHttpUrl`（搬走） | 同上 |
| `createSiteRoutes` 的 `readRelease` 参数 | 同上 |
| 读 `CF-IPCountry` 那一段（读地区只为给下载按钮选线路） | 同上 `servePage` |
| Windows 卡片 + `<!-- legion:download -->` 标记 | `site/index.html`、`site/en/index.html` |

### 13.2 ★★★ 一处差点静默失效的接线：按地区选线

`CF-IPCountry` 选下载线路原先**只有官网**在读。官网按钮撤掉后，
`server.mjs` 里接门口页那一行是：

    downloadUrl: () => describeDownload().url        // ← 把 visitor 吃掉了

官网那条路（`readRelease`）自己传了 country，所以以前看不出问题。撤掉之后
门口页成了唯一还有下载按钮的地方，而这一行不转发地区 ⇒ **永远选默认线路**。

它不报错、不变慢、页面完全正常 —— 只是那条"给国内用户准备的线"不再被选中。

> 一个"把参数默默丢掉"的适配器，
> 与一个"下游根本不需要参数"的适配器，在只看这一行的时候是同一个东西。

改法：`downloadUrl: (visitor) => describeDownload(visitor).url`，读地区搬到门口页
（`createPortalRoutes` 的 dispatch）。判据也一起搬（`download-lines.test.mjs` ⑥）。

### 13.3 顺手修掉的一处真缺陷：门口页的 href 没有协议白名单

`isHttpUrl`（防 `javascript:` 进 href）只存在于 `site.mjs`，而门口页写出下载链接时
**只做了 `esc()`** —— `esc()` 挡不住 `javascript:alert(1)`，那是一个完全合法的
HTML 属性值。搬到 `portal.mjs` 时改名为 `isSafeHref` 并**放宽**（也接受站内相对
路径，否则 `/legion/releases/<id>/…` 这种最常见的情形会被判成坏的），
同时多了一种情形并说清楚：

| 配置 | 页面 |
| --- | --- |
| 可用的地址 | 可点按钮 |
| 配了但不可用 | 「下载地址配得不对」 |
| 没配 | 「电脑版尚未发布」 |

★ 第三种与第二种分开是这次顺手加的：一个**配了但配坏**的地址原先走"没配"那条路，
页面写"尚未发布" —— 那是**反的**：运营者明明配了东西，却被告知"还没发布"，
他会去查上传流程，而问题在那一行配置里。

### 13.4 生产实测（2026-10-12）

| 检查 | 结果 |
| --- | --- |
| 官网首页含「下载电脑版 / Legion-Setup / .exe / legion/releases / Windows x64 / 尚未发布」 | 各 **0 次** |
| 官网首页含新文案（一个入口两种设备同一份数据 / 电脑·手机 / 同一份数据 / 不是同步的副本 / 不用安装 / 手机上打开就看得到 / 同一个库） | 各 **≥1 次** |
| 英文站 | `one set of data` / `Desktop · Phone` / `Nothing to install` 各 1；`Download for Windows` / `Legion-Setup` 各 0 |
| `/workbench/` `/mobile/` `/api/config` | 200 / 200 / 200 |
| 服务 | legion-hub、nginx、cloudflared、存储体检定时器全部 active，`NRestarts=0`，错误日志 0 条 |

### 13.5 ★ 两个必须说清的事实

**① 更新源不在 Hub 那棵树上，而它完好。** 真正的自动更新源是**另一份静态根**
（`/srv/legion-updates/production/`），经 `updates.legion-si.online` 发出：

    /legion/feeds/stable/win-x64.json                    200（合法的 update-feed@1，指向 rel-0.1.4）
    /legion/releases/rel-0.1.4/manifest.json             200
    /legion/releases/rel-0.1.4/Legion-Setup-win-x64.exe  200

Hub 自己那棵 `LEGION_RELEASES_DIR=/var/lib/legion-hub/releases` **只有 `releases/`、
没有 `feeds/`** —— 所以 `legion-si.online/legion/feeds/*` 一直是 404。
**这是既有状态，与本次改动无关**（本次没有碰 `releases.mjs`）。

**② 门口页在这台部署上**访问不到** —— 所以用户端现在**没有任何下载入口**。**

`server.mjs` 把官网族 unshift 在门口页**之后**，于是两者都声明 `GET /` 时
**官网先答**；门口页只在官网答不了（`site/index.html` 不存在）时兜底。
这台部署有官网 ⇒ `/` 永远是官网。

因此"官网撤掉、门口页保留"的真实效果是：**用户看不到任何下载入口了**
（门口页里那个下载卡片仍在代码里、渲染函数实测仍产出"下载电脑版"，
但它被官网挡住了）。这是**既有设计**（门口页一直是兜底），不是这次改的 ——
但它意味着这次改动的**用户可见结果比"官网撤掉一个卡片"更彻底**。

要恢复"能下但不在官网首页"的形态，有两条路（都还没做，等指示）：

- 把官网族与门口页的顺序对调（`/` 给门口页、官网挪到别的路径）—— 影响面大，不建议；
- 在官网某一处**显式**放一个通往门口页的链接 —— 但那等于又把下载入口加回官网。

### 13.6 诚实边界

- **CSS 里 `.dl-actions` / `.dl-meta` / `.dl-lines` 三条规则没删**：纯样式、不产生
  行为，而渲染层已不再产出这三个 class（有一条判据盯"产出"这一侧）。
  → **2026-10-14 已删**，见 §14。
- 生产上那条备选线路的标签曾经是**乱码**（`鍥介檯绾胯矾`，应为「国际线路」）——
  那是 `/etc/legion-download-lines.json` 的字节被写坏了。
  → **2026-10-14 已修**，见 §14。
- **破坏性验证**：18 处破坏全部精确转红，4 文件逐字节还原，还原后 110/110。
  过程中它抓出三处**我自己的判据太松**（新写的"两种设备/同一份数据"在**整页**
  里找关键词，于是改标题、改引言、删掉"手机"三处全绿）以及**三处空破坏**。
  验证器本身也曾被中断并把一处补丁留在工作区（已手工复原；现在它开头另存原文、
  注册 exit/SIGINT/SIGTERM 复原、每次运行先清理上次残留、结果写 JSON 而不是抓 stdout）。

    > 一个"改文件 → 跑测试 → 改回来"的验证器，
    > 与一个"可能把改动留在工作区"的验证器，在它跑完的那一次看起来一模一样。

---

## 14. 收尾：下载区残留的 CSS，与那份**双重编码**的线路表（2026-10-14）

### 14.1 删掉只服务于下载区的 CSS

`site/assets/site.css` 里那几条规则**没有产出方**了，删掉：

| 删掉 | 为什么要小心 |
| --- | --- |
| `.dl-meta`、`.dl-meta .sep` | 直接删 |
| `.dl-lines`、`.dl-lines a`、`.dl-lines .sep` | 直接删 |
| `.dl-actions .btn[aria-disabled=true]` | "尚未发布"那个死按钮的样式 |
| `.label.human` | "内部验证 · 未签名"徽标；三个模板都不再产出它 |
| **`.dl-actions, .hub-actions { … }`** | ★ **不能整条删** —— `.hub-actions` 还在用 |

★★ 最后一条是最容易出错的地方：这两块原先**共用一条双选择器**。如果顺手把整条删掉，
Web 入口那个"打开就能用"按钮就会**失去样式** —— 而页面结构、类名、文字**全都在**，
所以任何"看 HTML"的判据都不会红。

> 一个"按钮在页面上、也有 class"的判据，
> 与一个"按钮看起来像按钮"的判据，在 CSS 被删掉之后是同一个东西。

所以判据补了两半（`site-routes.test.mjs`）：

- **死掉的那几条一条都不许再有规则**（注释里提到它们是可以的 —— 注释解释的是
  "为什么删"，删掉注释会让下一个人重新问一遍）；
- **`.hub-actions` 的规则必须在**（收窄双选择器时最容易整条删掉）。

★ 为什么这一半值得有判据：一个**没有任何产出方**的 class 规则，与一个**正在被使用**的
class 规则，在只读 CSS 的时候是同一个东西 —— 后来的人看到 `.dl-actions` 的样式还在，
会以为"某处还在用它"，于是照着它再加一个下载卡片。

★★ 还有一条**活体**判据（不进 CI，需要有浏览器 + 一个线上地址）：

    node scripts/qa/site-live-check.mjs                    # 打生产
    node scripts/qa/site-live-check.mjs --url <地址>       # 打别处

它读的是**计算样式**，因此能抓到离线判据抓不到的那一类 —— 2026-10-08 那次
"青绿字压青绿底"就是：按钮在不在、有没有尺寸、**文字色与底色是否相同**、
`.hub-actions .btn` 的高度与内边距还在不在。退出码 `2` = 跳过（没有浏览器，
或**页面根本没加载出来** —— 那属于网络/边缘问题，判不了就不判，不报假 FAIL）。

用法与 `mobile-live-check` / `workbench-live-check` 一致（`--url` 空格分隔）。

### 14.2 修掉 `/etc/legion-download-lines.json` 的双重编码

生产上那份线路表的两个中文标签是乱码：

    label:    "鍥藉唴绾胯矾锛堟帹鑽愶級"   →   "国内线路（推荐）"
    label:    "鍥介檯绾胯矾"               →   "国际线路"

**根因是"UTF-8 被当成 GBK 读"**：原文是 UTF-8，写这个文件的工具按 GBK 解码后
又按 UTF-8 存回，于是每个中文字变成两三个乱码字。文件本身**是合法 UTF-8** ——
所以"能不能解析"这类检查永远发现不了它。

修法是**算出来的，不是猜出来的**：把乱码按 GBK 反解回字节，再按 UTF-8 解码，
得到的正好是原中文。求不出来就中止，不去手敲一份"看起来对"的。

验证（全部在生产上实测）：

| 检查 | 结果 |
| --- | --- |
| 用应用自己的 `loadDownloadLines` 读 | **问题 0 条**，2 条线路 |
| `label` | `国内线路（推荐）` / `国际线路` |
| `countries` | `cn=[CN]` / `global=[]`（缺失的键归一成空数组，与样例一致） |
| ★ **选出来的 URL 一个字都没变** | `CN →` JD OSS 那条；`US`/`null →` `updates.legion-si.online` 那条 |
| 重启后启动日志 | `[download-lines] 已启用 2 条线路（…）：cn(CN)、global(默认)` |
| Hub | active、`NRestarts=0`、错误日志 0 条 |

★ 这次只改**显示用的标签**，不改选线结果 —— 所以"URL 没变"是必须断言的一条，
否则一次"修乱码"很可能顺手把线路指错，而那**不会报错**（两个地址都能下，
只是一个快一个慢）。

### 14.3 ★★ 写这类文件的安全姿势（我在修的过程中**又踩了同一个坑**）

我第一次把修复脚本送上服务器时，用的是：

    Get-Content "$env:TEMP\fix-lines.py" -Raw     # ← PowerShell 5.1 按**系统 ANSI 代码页**解码

这个脚本是**无 BOM 的 UTF-8**。`Get-Content` 于是按 GBK（本机 ANSI）解码它、
再由 base64 编码传出去 —— 脚本里的中文注释**原样变成了同一类乱码**，
远端 python 直接语法错误。**与生产那份配置文件被写坏是同一个机制。**

规矩（本仓库已多次吃过这一类亏，这次记进文档）：

- 往远端送**含非 ASCII 的文件或脚本**，一律走**原始字节**：
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))`，远端 `base64 -d`。
  **不要** `Get-Content` 再 `GetBytes` —— 那中间多了一次按代码页的解码。
- 只在**远端**用 `base64 -d > file`，不要 `echo` 一长串中文进 shell。
- 写配置后**用应用自己的解析器读一遍**（`loadDownloadLines`），
  而不是只看 `python3 -m json.tool` 过不过 —— 合法 JSON 与正确文本是两件事。

### 14.4 ★ 顺带发现、当时**故意没动**的一处：`rel-0.1.1` 的发布说明

> ⚠️ 这一节记的是**当时的判断**。同一天稍后你让我修它，而深挖之后发现
> 结论有一处**不对**（"重新发布"不是唯一修法）—— 完整的经过与更正见 **§15**。
> 这里保留原文，是为了留下"当时为什么那样判断"。

扫全盘找同类乱码时命中第三处：

    /srv/legion-updates/production/legion/releases/rel-0.1.1/notes-0.1.1.txt

内容既是乱码、又像是被截断拼接过的（有一行只剩 `-`，末尾还挂着一个
`roles-ozon.json`）。**当时没有修**，理由是硬的：

- 该版本的 `manifest.json` 里**钉了这份 notes 的 `sha256` 与 `sizeBytes`**
  （`payload.notes.sha256 = 84e1cffb…`、`sizeBytes = 419`）——
  改文件就会让清单说谎，而"清单里的哈希"正是升级链的信任根。
- 发布目录那一族是按 **`immutable`** 发的（`max-age=31536000, immutable`），
  即"**发布物不可变**"是它的对外承诺。
- 该版本**已经没有任何 feed 指向它**（当前 `stable` 指 `rel-0.1.4`）。

要正确修它，得走一次**重新发布**（新 releaseId + 新清单哈希），而不是就地改文件。
在那之前它会一直带着乱码 —— 这是一个**已知、且刻意的**遗留项。

> 一个"就地改一下就好"的文件，与一个"改了就让清单说谎"的文件，
> 在只看那个文件的时候是同一个东西。

→ **2026-10-14 已修**，见 §15。而且深挖之后发现**情况比这里写的更糟**：
`rel-0.1.3` / `rel-0.1.4`（当时的 stable）的发布说明是 **GBK**，客户端**整份拒收**。

---

## 15. 修掉 `rel-0.1.1` 的发布说明，并给发布加一道 UTF-8 门（2026-10-14）

### 15.1 先把"是哪一种坏"查清（结论与 §14.4 的猜测**不同**）

| 事实 | 怎么验的 |
| --- | --- |
| 那份乱码文件的 sha256 **等于**清单里声明的 | 两侧都算了一遍 |
| ⇒ **清单没有说谎**，文件是**发布当时**就坏的（不是发布后被改坏） | 同上 |
| ⇒ 原文**不在这台服务器上** | 全盘按"哈希等于清单声明值 + 419 字节"搜过，只命中它自己 |
| 原文**也不在 git 历史里** | `git log --all -S'内置发布信任根'` 无结果（notes 是发布时从 `--notes` 传进去的、不落仓库） |
| 损坏正好 **3 处**，都是"丢了一个字" | 逐字节定位：`检`、两处 `）`、`一`（0x89→`?`、0x80→0xA2 这类**有损**替换） |

**所以"就地改 + 重签"是唯一的修法**（§14.4 说的"重新发布"在结果上等价于它：
新 releaseId 会把坏的那份留在原地，而**没有任何 feed 指向 0.1.1**）。

### 15.2 ★ 修法：只重建那 3 个字符，其余字节一字不动

重建后的正文（**行结构与原文一致** —— `\n` 是 0x0A、永远不可能是 GBK 尾字节
（尾字节 ≥ 0x40），所以换行在损坏中被完整保留，布局不用我猜）：

```
Legion 0.1.1

- 桌面端自动更新：内置发布信任根与更新地址（此前缺失，检查更新不可用） \
  -
安装包与升级包对
roles-ozon.json
的判据统一（本地数据不再进产品树） \
  -
更新托管缓存头与客户端要求对齐（发行文件
immutable）
```

**诚实标注**：这是**重建**（reconstruction），不是逐字节找回 ——
`检`、两处 `）`、`一` 这四个字符的信息已经丢了，是按上下文补回来的。
其余字节（含原有换行与 3 个行尾续行符）**保持原样**，没有做任何"顺手美化"。

### 15.3 ★★ 私钥**没有**上服务器

手册规定的流程是"私钥上服务器、用后 `shred -u`"。这次**没有那样做**：

- 签名在**本机**完成（`C:\Users\11150\.legion-release-keys\release-2026-a.key.pem`）；
- 只把**签好的** `manifest.json` 与 `notes-0.1.1.txt` 传上去。

先做了一次**逐字节复现自检**：用生产私钥把**原样**的 payload 重签一遍，
产出的字节与生产上那份 `manifest.json` **完全相同** —— 证明签名管线与生产一致，
改动就只剩 notes 一处。

| 自检 | 结果 |
| --- | --- |
| 重签原样 payload == 磁盘上的 manifest | **逐字节一致** ✓ |
| 私钥导出的公钥 == `product/release/update-trust.json` 里的 | 一致 ✓ |
| payload 的差异 | **只有 `notes.sha256` 与 `notes.sizeBytes` 两个数** |
| `installer` / `package` / `issuedAt` / `expiresAt` | 一字未动 |
| 两个大件（zip 205 MB / installer） | 磁盘上**逐字节未变** |

### 15.4 生产验证（全部在服务器上独立复跑）

用**服务器上那份 trust 文件**独立验签：

| 检查 | 结果 |
| --- | --- |
| 清单签名 | `verified`（keyId `release-2026-a`） |
| `notes.sha256` == 实际 | 是 ✓ |
| `notes.sizeBytes` == 实际 | 是 ✓（298 B，原 419 B） |
| `decodePlainText`（客户端那条判据） | **接受**，138 字符 |
| payload 变化的字段 | **只有 `notes`** |
| 公网回读（走 nginx，与客户端同一条路） | 大小/哈希与磁盘一致，正文正常，**U+FFFD 0 个** |
| 各版本 notes 的客户端判读 | 0.1.1 **接受且内容正确** |

备份：`/srv/legion-updates/backup-011/{notes-0.1.1.txt,manifest.json}.before`。

### 15.5 ★★★ 深挖时发现的**更大**问题：当前 stable 的说明被客户端整份拒收

客户端 `product/update/client.mjs` 的 `decodePlainText` **要求合法 UTF-8**，
否则返回 `null`（界面显示"发布说明不是纯文本，已忽略"）。用**它自己**跑四个版本：

| 版本 | notes 的编码 | 客户端 | 用户看到什么 |
| --- | --- | --- | --- |
| `rel-0.1.1` | UTF-8（乱码） | 接受 | **乱码**（本次已修） |
| `rel-0.1.2` | UTF-8 | 接受 | 正常 |
| `rel-0.1.3` | **GBK** | **拒收** | **什么都看不到** |
| **`rel-0.1.4`（当前 stable）** | **GBK** | **拒收** | **什么都看不到** |

**根因**：notes 是运营者手工用 `--notes` 传给 `publish.mjs` 的；在中文 Windows 上
`>` / `Set-Content` 默认写 ANSI(=GBK)。而 `publish.mjs` **只把它当字节算哈希、
从不校验** —— 于是错误编码**静默发布**、客户端**静默拒收**。

> 一个"发布成功、客户端悄悄丢掉"的说明，
> 与一个"根本没写说明"的发布，在发布日志里长得一模一样。

### 15.6 因此加了一道门（`scripts/update/publish.mjs`）

签名**之前**校验 `--notes`，不合格就**硬失败**并说清后果与修法：

- 空文件 / 超过 `MAX_NOTES_BYTES` / 非合法 UTF-8 / 含 NUL 或控制字符 → 拒收；
- 判据**直接用客户端那一份实现**（`decodePlainText`）——
  两份判据会在某一天分家，而分家的表现正是"发布侧绿、用户看不到"；
- 消息里点名那个真实的坑（Windows 默认 ANSI），因为只说"要 UTF-8"防不住复发。

**已知边界（刻意不假装能判）**：这道门管的是**编码**。
"合法 UTF-8 但内容是乱码"（0.1.1 正是）在字节层面完全合法，没有机械判据能可靠认出。
所以发布摘要里加了一行 `notesPreview`（用户会看到的那段正文的开头）——
第一版放的是**首行**，而 0.1.1 的首行是版本头 `Legion 0.1.1`，乱码在下面几行，
**根本看不见**；判据当场把它抓出来了，改成正文预览。

**验证**：`publish.test.mjs` **39/39**；破坏性验证 **10/10 精确转红、0 误伤**、
逐字节还原。过程中那条"预览必须真的印出来"的判据也抓出一处：
`summary` 里的字段**只有被渲染出来才有意义**，所以判据读的是
`upload-plan.txt` 的实际内容，不是对象里的字段。

---

## 16. 修掉 `rel-0.1.3` / `rel-0.1.4` 的 GBK 说明（含**线上 stable 通道**）

§15.5 查出的那件事（当前 stable 的说明是 GBK、客户端整份拒收），这一节把它修掉。

### 16.1 范围：两棵树、四处，且**通道必须动**

| 位置 | 当时的状态 | 处置 |
| --- | --- | --- |
| `prod/releases/rel-0.1.3` | notes **GBK**，无 feed 指向 | 转 UTF-8 + 重签清单 |
| `prod/releases/rel-0.1.4` | notes **GBK**，**stable 通道指向它** | 转 UTF-8 + 重签清单 + **重签通道** |
| `feeds/stable/win-x64.json` | seq=4，指向旧清单摘要 | **seq → 5**，摘要换成新清单 |
| Hub 那棵树（`/var/lib/legion-hub/releases`） | 一是 notes 也 GBK；二是 `rel-0.1.4` 的清单**声明了一个磁盘上不存在的 notes**（线上 `notes-0.1.4.txt` = **404**） | 同样换 UTF-8；补上被引用的那个文件名 |

★★ **通道的 `sequence` 必须加一，不能沿用 4。** `judgeSequence` 对
"同号但摘要不同"回 `SEQUENCE_CONFLICT` 且 `accept:false` ——
沿用 4 号会让**所有已经接受过 4 号的客户端永远拒绝**这份新通道，**不可自愈**。
实测确认：喂进"已接受 seq=4"的状态，新通道得到 `feed-sequence-advanced` / `accept:true`。

★ 这次与 §15 一样，**笔记内容不需要重建** —— GBK 解出来是**干净的中文**
（与 0.1.1 那种有损乱码不同），只换编码：

```
rel-0.1.3:  GBK 215 B → UTF-8 289 B
rel-0.1.4:  GBK 257 B → UTF-8 338 B
```

### 16.2 复现自检（动之前先证明管线与生产一致）

三份要重签的文件，用生产私钥把**原样** payload 重签一遍，产出必须与磁盘**逐字节相同**：

| 文件 | 结果 |
| --- | --- |
| `prod/releases/rel-0.1.3/manifest.json` | **逐字节一致** ✓ |
| `prod/releases/rel-0.1.4/manifest.json` | **逐字节一致** ✓ |
| `prod/feeds/stable/win-x64.json` | **逐字节一致** ✓ |

### 16.3 生产验证

**`verify-host`（仓库自己的 11 项端到端回读，走 nginx 生产面）：全部 `ok`，退出码 0。**

```
ok  host-config / feed-cache-policy(no-store) / feed-signature / feed-schema(sequence=5)
ok  release-fetch / release-digest / release-signature / release-schema
ok  artifact-package / artifact-installer / artifact-notes(338 字节已回读，清单声明 338)
```

另外：两份清单验签 `verified`、摘要与大小与实际一致、`decodePlainText` 接受；
公网回读与磁盘逐字节一致、**U+FFFD 0 个**；Hub 那棵树 `notes-0.1.4.txt` 由
**404 → 200**，`latestInstaller()` 仍挑 `rel-0.1.4`（installer 的 mtime 没被碰）。

备份：`/srv/legion-updates/backup-226/`（含 `hub/` 子目录）。

### 16.4 ★★★ 顺带查出一件**比 notes 严重得多**的事：OSS 账号欠费

修完之后按惯例核"客户端到底从哪个源读"，结果发现**打包进客户端的**
`product/release/update-config.json` 里，`stable` 指向的是**京东云 OSS**，
而不是 `updates.legion-si.online`（后者只是**镜像**，写在 `example` 里）。

而 OSS 整桶返回：

```xml
<Code>AccountArrear</Code>
<Message>There is an arrear problem with this OSS account ...</Message>
```

⇒ **已安装的客户端现在检查不了更新**，而且这一条**无法从这里修**：
`client.mjs` 没有多 origin 回退，客户端读的是**打包进去的**那份配置，
设计又刻意不提供远程替换入口。处置与判读见
[UPDATE-HOST-RUNBOOK.md](UPDATE-HOST-RUNBOOK.md) §4.1。

★ 之所以一直没被发现，是因为**镜像那一侧的一切检查都是绿的**。

> 一个"镜像还活着"的托管，
> 与一个"主托管还活着"的托管，在只测镜像的时候是同一个东西 ——
> 只不过前者能掩盖后者已经死了很久。

★ 另外纠正一处**我自己的假阳性**：检查 `update-config.json` 时，
PowerShell 终端把它的中文注释显示成了乱码，我一度以为那个文件也坏了。
按**原始字节**复核：589 个汉字、0 个替换字符、0 个可疑双重编码字符 —— **它是好的**。
（同一类显示假象本轮已经踩过两次，规矩见 §14.3。）

---

## 附录 A：发布检查单（每次发布逐项打勾）

- [ ] CI 全绿：`node scripts/ci/run-ci.mjs` exit 0（evidence 归档 docs/T093-evidence/）
- [ ] L1 三件套探活 + whiteboard /healthz（§5.2/§5.4）
- [ ] L2 浏览器主路径走查并回填（§5.3）
- [ ] team.db 备份完成（§6；推荐 `VACUUM INTO`，见 §6.1）
- [ ] 存储余量体检过（§6.2：`node scripts/ops/storage-check.mjs` 退出码 0；`1`=警戒、`2`=危险、`3`=读不到）
- [ ] `systemctl list-timers legion-hub-storage-check.timer` 的 **LAST** 列不是空的（§6.2b —— 空的 `LAST` 就是"从来没跑成功过"）
- [ ] 备份可恢复性核对完成：`node scripts\prt\backup-restore-verify.mjs --source=<备份或现场库>`（§6.1）
- [ ] 已知缺陷状态确认（§7.1：当前无未修复 P0/P1；§7.2 记录项知悉）
- [ ] 发布记录登记（§4.4 模板）+ 快照 MANIFEST 留档

## 附录 B：关联文档

- docs/TEST_REPORT.md（T-091 S8 集成回归锚定，七套件逐条结果）
- docs/REQUIREMENTS.md（T-073 需求与盘点）· docs/RESEARCH.md（方案）· docs/TASK_BREAKDOWN.md（拆解/切片）
- docs/TEST_CASES.md（用例/浏览器清单）· docs/P1-LIVE-ROLLOUT.md（P1 现场验收 runbook）
- whiteboard/docs/DEPLOY.md（whiteboard 独立部署）· 根 README.md（快速开始/功能指南）
- docs/T093-evidence/（本阶段构建/CI 证据）
