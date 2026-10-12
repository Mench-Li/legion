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

### ★★ 6.4b 一个必须记下的事：生产上的 SPA **无法从仓库复现**

部署里的 `/workbench/` 产物是 `assets/index-BjYkts4m.js`。为了知道"重建它会不会
连带带上别的改动"，我把动过 `workbench/src` 的提交**各自构建了一遍**：

| 来源 | 产出的 bundle |
| --- | --- |
| `f9a1b4b3` | `index-ClRLzxPM.js` |
| `260cc742` | `index-MNOx9ITs.js` |
| `833546e7` | `index-CdCnA807.js` |
| `2c67dfb6` | `index-CVFe7rHD.js` |
| `ca7589c9`（该目录的最后一个提交） | `index-SGdYgfb7.js` |
| `origin/main`（41ee12f3） | `index-SGdYgfb7.js` |
| **生产上的** | **`index-BjYkts4m.js`** ← 没有一个候选对得上 |

换 `--base=/workbench/` 也不对（产出 `index-BTUIzIla.js`）；产物里没有绝对路径。

> **结论：部署里的那份 SPA 不是从当前历史里的任何提交构建的。**

后果很实际：**下一次重建会把若干提交的前端改动一起带上** ——
而它们的后端配对未经验证。所以这一轮**没有**部署重建的 SPA（那是"假验证"）。

`workbench/src/api.ts` 里 `readJson` 的那处修复（让它保留后端的
`code`/`error`/`hint`，而不是只抛 `statusText`）**已经在源码里、`tsc --noEmit` 通过**，
但**没有部署** —— 它会随下一次**有出处的** SPA 发布一起生效。

在那之前，浏览器里的界面显示的是 `501 Not Implemented`
（比 `not found` 好，但还不是那句中文）。

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
