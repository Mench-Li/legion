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

**为什么不用 QUIC**（实测，同一个 44.9KB 的精简看板）：
QUIC 下 10.8s / 51.6s（抖动大），http2 下 1.4s / 3.3s / 4.2s。
本机出站 QUIC（UDP 7844）探测到 region2 不通，钉 QUIC 会反复重试 ⇒ 抖动。
**结论：这台机器上 http2 更稳**（`protocol: http2`）。

**自启为什么用启动文件夹而不是服务**：`cloudflared service install` 与
`schtasks /create /sc onlogon` 在这台机器上**都要管理员**（实测 Access is denied）；
启动文件夹是用户级的，不需要提权。VBS 是为了**不弹黑窗口**（`Run(..., 0, False)`）。
若想"开机即起、不依赖登录"，用管理员执行一次：

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' service install
```

（那就该把启动文件夹里那个 .vbs 删掉，免得两份实例。）

## 4d. ★ 这条路的**稳定性**要如实知道（实测）

同一台机器、同一条隧道、同一个请求，实测（2026-10-10）：

| 观测 | 值 |
| --- | --- |
| 本机中枢生成响应 | **100–213ms**（中枢一点都不慢） |
| 隧道上的小请求 | 1.0s ~ 22s（抖动极大） |
| 隧道上的手机首屏（页面+看板+智能体） | 15.3s / 37.5s / 71.9s，**有一轮三个请求全部 60s 超时** |
| 隧道注册的 Cloudflare 边缘 | lax08 / lax10 / lax13（**洛杉矶**） |

也就是说：**功能是通的，但这条跨境隧道的延迟很不稳定**。原因在链路，不在中枢也不在手机。
若"手机操控"要当日常通道用，建议换**私有网**（下面第 8 节）。

## 5. 手机上怎么用

1. 手机浏览器打开 `https://home.legion-si.online/mobile/`（若用私有网，换成对应地址）。
2. 用第 3 步建的账号登录（PWA 会自动调 `/api/identity/refresh`；SSE 用一次性票据）。
3. 选工作空间与 Agent → 在输入框里说话：
   - 想**派活** ⇒ 用「派任务」（`intent: create_task`）→ 生成一条 `todo` 任务 →
     本机守护下一轮认领并派 worker；
   - 想**追问/回答** ⇒ 直接发消息（`intent: ask` / `answer_question`）；
   - 任务详情里的验收/打回/评论按角色权限走。

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
