# 手机远程操控这台电脑的任务 —— 操作手册

> 目标：**人不在电脑前时，用手机看任务、派任务、回答问题。**
> 形态：中枢（唯一真相）留在这台电脑上；手机经一条**入口**连到它。
> 相关缺陷与理由：[BUG-018](./bugs/BUG-018-手机操控电脑缺的是入口.md)

## 0. 为什么中枢留在电脑上（而不是搬到服务器）

守护生产的东西**全在这台机器的文件系统上**：`.legion-worktrees/` 隔离仓库、git 提交、
跑测试、写证据。守护在远端等于让一个看不到你代码的人替你改代码。
所以：**中枢 + 守护都在本机；手机只是多一个"看同一张表"的窗口。**

## 1. 三个开关（一起设，缺一条都得到坏状态）

写在 profile `~/.dsh/profiles/desktop/cordis.patch.yml` 的服务插件段：

```yaml
- name: '@dsh-external/dsh-legion-services'
  config:
    legionDir: 'D:/project/DSH/legion'
    teamHubToken: '<48 位随机 hex>'        # 机器令牌：留空 ⇒ 中枢对任何写请求都放行
    teamHubIdentityKey: '<64 位随机 hex>'  # 手机面总开关：>=16 字符才开；留空 ⇒ /mobile 是 404
    teamHubRemoteAuth: '1'                 # 读面也要求登录；只设令牌保护不到读面
```

同时守护要用**同一把** `teamHubToken`（否则它自己会被 401 挡住）：

```yaml
- name: '@dsh-external/dsh-scrum-worker'
  config:
    hubToken: '<与上面逐字相同>'
```

生成密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # identityKey
```

★ **顺序**：改完 → **重启宿主** → 确认 `/mobile` 与身份系统起来了 → **再开隧道**。
反过来的那段窗口里，中枢是公开且无鉴权的（`TOKEN === '' → authorized() 返回 true`）。

## 2. 验证本机一侧（开隧道之前）

```powershell
# ① 中枢启动日志应出现 identityKey=(已设置) 之类的读数
Select-String -Path D:\project\DSH\legion\.legion-services.log -Pattern 'identityKey' | Select-Object -Last 2

# ② 手机面是否已托管（应 200 + HTML；未开时是 404）
Invoke-WebRequest http://127.0.0.1:8787/mobile/ -UseBasicParsing | Select-Object StatusCode

# ③ 身份系统是否在（应返回 ready/bootstrapped 之类的布尔）
Invoke-WebRequest http://127.0.0.1:8787/api/identity/status -UseBasicParsing | Select-Object -ExpandProperty Content

# ④ 本地面板仍要能读（这条是 BUG-018 修的那个洞）
Invoke-WebRequest http://127.0.0.1:5173/hub/api/config -UseBasicParsing | Select-Object StatusCode
```

## 3. 建立第一个账号（只需一次）

库为空时用 bootstrap 建将军账号。**中枢绑回环时从本机调用**（此时带机器令牌即可）：

```powershell
$tok = '<teamHubToken>'
$body = @{ username = 'general'; password = '<你的口令>'; name = '将军' } | ConvertTo-Json
Invoke-WebRequest http://127.0.0.1:8787/api/identity/bootstrap -Method POST `
  -Headers @{ authorization = "Bearer $tok"; 'content-type' = 'application/json' } `
  -Body $body -UseBasicParsing | Select-Object -ExpandProperty Content
```

（`/api/identity/status` 会说它是否已经初始化过；已初始化时 bootstrap 会拒绝，属正常。）

## 4. 入口：两种形态

### 4a. 临时隧道（零配置，适合先跑通）

本机已装 `cloudflared`。这条命令给一个随机的 `https://*.trycloudflare.com` 地址：

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

- 好处：**不需要账号、不需要 DNS、不改任何服务器**，几十秒就能在手机上验证。
- 代价：地址每次重启都变；断线要重开；不适合长期。

### 4b. 固定域名（自己的 Cloudflare 域名）

```powershell
# ① 授权（会打开浏览器，需要你在 Cloudflare 里点一次）
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel login

# ② 建隧道并记下 ID
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel create legion-home

# ③ 加一条 DNS（用你域名的一个**子域**，不动现有站点）
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel route dns legion-home home.<你的域名>

# ④ 跑起来
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel run legion-home --url http://127.0.0.1:8787
```

★ 用**子域**是为了不动现有服务：`legion-si.online` 上跑着另一个中枢（那台库是空的），
这里只是新增一条 `home.<域名>` 记录指向这台电脑。**不需要 SSH 到那台服务器。**

## 4c. 本机**已经这样配好了**（2026-10-10 实际落地的形态）

```
隧道     legion-home        id de285451-cce3-4de5-a171-56c810a65e5c
入口     https://home.legion-si.online/mobile/
指向     http://127.0.0.1:8787（本机中枢）
配置     C:\Users\<你>\.cloudflared\config.yml
自启     C:\Users\<你>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\legion-home-tunnel.vbs
```

`config.yml` 的要点（照抄即可）：

```yaml
tunnel: de285451-cce3-4de5-a171-56c810a65e5c
credentials-file: C:/Users/<你>/.cloudflared/de285451-cce3-4de5-a171-56c810a65e5c.json
protocol: http2            # ★ 见下面"为什么不用 QUIC"
ingress:
  - hostname: home.legion-si.online
    service: http://127.0.0.1:8787
  - service: http_status:404
```

**为什么不是 QUIC**（实测，同一个 44.9KB 的精简看板）：
QUIC 下 10.8s / 51.6s（抖动大），http2 下 1.4s / 3.3s / 4.2s。
本机出站 QUIC（UDP 7844）到 region2 不通，钉 QUIC 会反复重试 ⇒ 忽快忽慢。

**为什么钉 IPv4**（`edge-ip-version: "4"`）：日志里隧道连的是 **IPv6 边缘**
（`2606:4700:...`），而这台机器的 IPv6 明显不稳 —— QUIC 预检在 region2 失败、
Node 的连接也总是先试 IPv6 再超时（实测报错里前两个候选地址都是 IPv6）。
钉 IPv4 之后隧道连的是 `198.41.x.x:7844`。
排查这类问题的顺序值得记下来：**先看隧道连的是哪一族地址，再看协议。**

**自启为什么用启动文件夹而不是服务**：`cloudflared service install` 与
`schtasks /create /sc onlogon` 在这台机器上**都要管理员**（实测 Access is denied）；
启动文件夹是用户级的，不需要提权。VBS 是为了**不弹黑窗口**（`Run(..., 0, False)`）。
若想"开机即起、不依赖登录"，用管理员执行一次：

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' service install
```

（那就该把启动文件夹里那个 .vbs 删掉，免得两份实例。）

## 4d. ★ 这条路的**稳定性**要如实知道（实测）

同一台机器、同一条隧道，实测（2026-10-10，三个阶段的调优）：

| 观测 | 调优前（QUIC + IPv6） | 调优后（http2 + IPv4） |
| --- | --- | --- |
| 本机中枢生成响应 | 100–213ms | 100–213ms（**中枢一直都不慢**） |
| 隧道上的小请求 | 1.0s ~ 22s | 0.6s ~ 12s（**偶发连接超时**，重试即过） |
| 手机首屏（页面+看板+智能体） | 15.3s / 37.5s / 71.9s，**有一轮三个请求全部 60s 超时** | **4.9s / 7.1s / 7.8s** |
| 隧道落到的边缘 | lax08 / lax10 / lax13（**洛杉矶**） | 同（区域没变，只是换了 IP 族） |

结论：**能用，但这条跨境隧道仍会偶发几十秒卡住**（隧道边缘连接轮换时）。
原因在链路，不在中枢也不在手机。若"手机操控"要当日常通道用，建议换**私有网**（第 8 节）。

★ **一个把自己也骗进去过的坑**：`legion-si.online/mobile/` 是**另一台机器上的另一个实例**
（手机页 10527 字节 vs 本机 10332；它的 `/api/identity/status` 从本机实测**连接超时**）。
在那个地址上用本机的账号登录必然失败 —— 而报错看起来像"口令错"。
**认地址的办法**：本机入口只有 `home.legion-si.online`（多一个子域）。

## 5. 手机上怎么用

1. 手机浏览器打开 **`https://home.legion-si.online/mobile/`**
   （★ 不是 `legion-si.online` —— 那是另一台实例）。
   若以前把旧地址"添加到主屏幕"，删掉那个图标，从新地址重新添加。
2. 用第 3 步建的账号登录（PWA 会自动调 `/api/identity/refresh`；SSE 用一次性票据）。
3. 选工作空间与 Agent → 在输入框里说话：
   - 想**派活** ⇒ 用「派任务」（`intent: create_task`）→ 生成一条 `todo` 任务 →
     本机守护下一轮认领并派 worker；
   - 想**追问/回答** ⇒ 直接发消息（`intent: ask` / `answer_question`）；
   - 任务详情里的验收/打回/评论按角色权限走。

### 5b. 提醒（BUG-021）—— 手机不再需要你主动去看

**手机端会在底部弹一条**（输入区正上方），说清"哪个任务、要你做什么"：

```
⏳ T-196 待你验收（方案研究员）
```

点它直接跳到那条任务。只在**需要你动手**的事上弹（进入「待验收」「受阻」、拦截、转派、
测试报告、目标发布/收尾）；开工、进度、产物登记这些不弹 —— 一个什么都弹的提醒等于没有提醒。

**首次打开会补告最近 6 小时内等你的事**（你没用过这个提醒、或换了手机时）。
语义是"你刚才大概不在"，不是"这台机器上曾经发生过什么"。

**想让它在页面不在前台时也叫你**：点顶栏那个「🔔」授权（只需一次）。
三条纪律：绝不自动请求授权 · 只在页面不可见时才发 · 点了回到窗口。

边界（要如实知道）：

| 情形 | 能不能收到 |
| --- | --- |
| 手机开着这个页面（前台） | ✅ 底部弹框 |
| 手机开着这个页面（切到别的 App / 锁屏，页面还活着） | ✅ 已授权时发系统通知 |
| 页面被彻底关掉（划掉标签 / 杀掉浏览器） | ❌ **收不到** —— 那要 Web Push（未做，见 BUG-021 §6） |

**看不到新提醒时先做这两件事**：① 页面下拉刷新一次（Service Worker 的代码走网络优先，
刷新即取新版本）；② 确认登录的空间就是有任务的那个（提醒按空间隔离，切空间换一把游标）。

### 5c. 断网时发的消息不会丢（离线待发队列）

**断网时按发送**，消息不再消失 —— 它进待发队列，界面上说清楚有几条在等：

```
1 条待发
断网中，连上网络后会自动发出。
```

点「查看」能展开每条的**原文**，并逐条删掉。回到线上（或点「重试」）会
**按顺序**自动发出，发完告诉你"已发出去 N 条"。

**为什么它敢自动重发**：每条在**入队时**就拿到了一个幂等键
（`clientRequestId`），重放时原样复用；服务端按
`(scope, actor, clientRequestId)` 去重，所以重发永远不会变成第二条消息。

**哪一条不能排队 —— 「追加要求」**：

> `ask` 晚三小时问，只是答案晚；
> `feedback` 晚三小时问，改的是**另一次**运行。

「追加要求」的语义绑定在**哪一次执行**上（它自己写着"下一次执行时生效"）。
离线三小时后重放，那条要求会落到一个已经跑完并结算的任务上，而你在离线时
看不到"下一次执行"是哪一次。所以它**不入队**，而是**把原文留在输入框里**
并说明原因 —— 回到线上你自己按一次发送，那时你看得见是给哪条任务加的。

**登录屏上也会说一声**：离线重开页面会停在登录屏，而那时最该确认的就是
"我打的字还在吗"。所以登录屏上有一条只读提示（没有按钮 —— 那时按什么都没用）：

```
你还有 1 条消息没发出去（存在这台设备上，登录并连上网络后会自动发出）。
```

**手机上永久丢掉这些字的唯一情形**：在浏览器里清了本站数据
（队列存在 `localStorage` 的 `legion.mobile.outbox`）。它不在服务端，
所以换一台设备看不到 —— 那是有意的：它是一条**这条设备还没发出去**的消息。

边界（要如实知道）：

| 情形 | 行为 |
| --- | --- |
| 断网时发送（询问 / 派任务） | ✅ 进队列，联网后自动发出 |
| 断网时发送（追加要求） | ⚠️ **不入队**，原文留在输入框并说明原因 |
| 服务端明确拒绝（400/403/404…） | ⚠️ **留在队列里**标成"发不出去"并附原因，由你改或删 —— **不自动重试、也不替你删掉** |
| 队列满（50 条） | ⚠️ **拒绝新的入队**并说明（绝不丢掉最旧的那条） |
| 队列里等太久的 | ⚠️ 标出"最早的一条已经等了约 N 分钟" —— 免得你把一个迟到的回答当成现在的状态 |
| 离线**读**（打开看历史对话 / 看板） | ✅ 见 §5d（但看板只留 1 小时） |
| 在登录屏上退出登录 | ⚠️ 队列**不清**（清掉等于静默删掉你打的字） |

### 5d. 断网时还能看到上次的对话与看板（离线读）

打开应用时**没有网**，你仍然能看到**上次连上时看到的**对话与任务清单 ——
但屏幕上会明确说清它有多旧：

```
离线 · 这是 3 小时前的消息
这是上次连上时看到的对话，可以读，但不能当作现在的状态。
```

看板那一条措辞更重（红边），因为它说的是另一件事：

```
离线 · 看板是 25 分钟前的
任务状态会变，照着过期的看板做决定可能做错。连上网络再确认一次。
```

**为什么两种东西的期限差这么多**，这是本节最要紧的一条：

| | 留多久 | 为什么 |
| --- | --- | --- |
| 对话**消息** | 7 天 | 它是**文本**：三天前那句话，三天后还是那句话。只会变旧，**不会变错** |
| 任务**看板** | **1 小时** | 它是**状态**：三天前显示「进行中」的任务，今天可能早已完成、被取消、或卡住了。**它会变错** |

> 显示一句三小时前的话，只是晚了一点；
> 显示一个三天前的任务状态，是让用户**照着一个不存在的世界行动**。

所以看板超过一小时就**直接不显示**（宁可空着）—— 一个过期的看板比一个空的看板更坏。

**缓存是按账号隔离的**：键里带你的用户 id，所以换一个账号登录**看不到**上一个账号
的缓存。而**退出登录会把整份读缓存清掉**（与待发队列**故意相反** ——
队列里是你自己打的字，读缓存里是服务端的数据，不能让下一个人在共享设备上看到）。

边界（要如实知道）：

| 情形 | 行为 |
| --- | --- |
| 离线打开、上次连上在 1 小时内 | ✅ 消息与看板都显示，并标出年龄 |
| 离线打开、上次连上在 1 小时～7 天之间 | ⚠️ **只有消息**显示；看板当作没有（空的） |
| 离线打开、上次连上超过 7 天 | ❌ 什么都不显示（缓存已过期） |
| 切换账号 | ✅ 看不到上一个账号的缓存（键里带用户 id） |
| 退出登录 | ✅ 读缓存**清掉**（队列保留） |
| 离线看**附件内容 / 图片** | ❌ 不缓存 —— 历史附件离线打不开 |
| 缓存落在哪 | `localStorage`，**不加密**。拿到这台设备浏览器的人能读到（与 refresh 令牌同样的暴露面） |


## 6. 回滚

| 要退回的状态 | 怎么做 |
| --- | --- |
| 关掉手机面（/mobile 变回 404） | 删掉 `teamHubIdentityKey`（或置空）→ 重启宿主 |
| 只保留本机、不要登录门禁 | 把 `teamHubRemoteAuth` 置空 → 重启宿主 |
| 完全回到加令牌之前 | profile 里删掉这三个键、守护 `hubToken` 置空 → 重启宿主 |
| 关隧道 | 停掉 `cloudflared` 进程 + 删掉启动文件夹里的 `legion-home-tunnel.vbs` |
| 关掉固定入口（DNS 那一层） | Cloudflare 后台删掉 `home.legion-si.online` 那条 CNAME（**别动** `legion-si.online` 与 `updates.*`） |

profile 每次改动前的备份在同目录 `.bak-mobile-*`。

## 7. 已知边界（要如实知道）

1. **读面靠 `remoteAuth`，不靠 token**：中枢始终绑回环，`readAuthRequired()` 因此是假；
   `remoteAuth=1` 那套才要求登录。**两者一起**才是完整的。
2. **`scope` 在 POST body 里时不做空间级授权**（门禁读不到 body）——源码里已登记为未完成的接线。
3. **隧道是公网可达的**：谁拿到地址谁能打开登录页（数据仍要登录）。
   要更严的话，长期方案是 Cloudflare Access，或改用私有网（第 8 节）。
4. **手机端的"派 AI 执行"按钮那条通道**（`exec_requests`）与守护**仍未接线**（见 BUG-016 §7）——
   手机派活走的是 `intent: create_task` 这条，它**是通的**。
5. **响应体积**：完整看板响应实测 **4071.6KB**（其中 `patches` 3498KB、`comments` 211KB）。
   手机端因此走 `?compact=1`（实测 **44.9KB**，缩小 90.8 倍，见 BUG-020）。
   若哪天手机又变慢，先量这个体积——它是这种问题的第一嫌疑。

## 8. 若要把"手机操控"当日常通道：换私有网

第 4d 节的实测说明：**跨境的 Cloudflare 隧道延迟不稳定**（15s–72s，偶发 60s 超时）。
中枢本身很快（100–213ms），所以瓶颈在链路。要稳定，换一条不依赖公共边缘的路：

| 方案 | 需要什么 | 特点 |
| --- | --- | --- |
| **Tailscale**（推荐） | 电脑装一次（**要管理员**）、手机装 App、两边登同一账号 | 私有网；能打洞就直连（延迟接近局域网），打不通走 DERP 中继；地址固定（`https://<机器名>.<tailnet>.ts.net`） |
| WireGuard 自建 | 一台有公网 IP 的机器 + 两边配置 | 全自控，但要自己维护 |
| 国内中转（frp 等） | 一台**国内线路**的服务器 | 延迟最低，但要有那台机器 |

Tailscale 落地到本方案的改法：把 `cloudflared` 关掉（或留着双通道），
在中枢前面用 `tailscale serve https / http://127.0.0.1:8787`；手机访问
`https://<机器名>.<tailnet>.ts.net/mobile/`。**其余配置（令牌/身份/门禁）一个字都不用改** ——
因为换的只是"链路"，中枢还是那个中枢。
