# 京东云更新文件托管部署计划

> 执行方式：当前会话顺序执行；不启动子代理。

目标：在已授权服务器上部署更新文件托管基础，验证公网可达；不发布未经签名的版本清单。

依据：[自动更新设计](../specs/2026-10-02-legion-desktop-auto-update-design.md)。

范围：117.72.146.36，Ubuntu 24.04.2，使用现有 SSH 密钥；无域名。此阶段只部署 Nginx 与空发布目录。客户端、签名发布协议、上传工具和升级事务分别实施。

## 步骤

- [x] 验证 root 密钥登录、系统与磁盘、现有监听端口。
- [x] 安装发行版 Nginx；配置单独站点，不覆盖其他业务站点。
- [x] 建立 `/srv/legion-updates/{test,production}/legion/{feeds,releases}`。
- [x] 配置健康检查 `/healthz`；关闭目录索引，只允许 GET/HEAD，清单禁止缓存，发布文件缓存一年。
- [x] 运行 `nginx -t`，启用服务；初次 reload 后本机请求遇到旧 worker 返回 404，后续公网测试已验证新配置生效。
- [x] 从开发电脑验证公网 HTTP：健康检查 200，缺失清单 404，响应带 no-store；80 端口可达。
- [x] 记录实际结果及后续 HTTPS、签名发布和客户端接入边界。

## 执行结果

2026-10-04：密钥登录成功；Nginx 1.24.0 已安装并启用。`http://117.72.146.36/healthz` 返回 `legion-update-host: ready`。未发布任何版本、安装包或生产清单，未配置 HTTPS。第一次脚本验证因 reload 生效延迟返回失败；随后独立公网检查通过。脚本已加入有界重试，尚未在新空白机器重跑。

后续仍需：正式 HTTPS 入口、签名发行与上传工具、桌面检查/下载/安装实现，以及设计要求的升级恢复验收。本次只完成云端文件托管基础。

HTTP 测试不授权正式更新；正式环境必须使用可信 HTTPS。没有域名时不把自签证书或关闭证书验证作为正式方案。此部署不变更 SSH 认证、不修改云防火墙、不发布业务数据。

## 后续：正式 HTTPS 入口（2026-10-06 侦察）

第 25 行那句「后续仍需：正式 HTTPS 入口」在本轮被具体化。下面是**实测**结论，
而不是推断——它们决定了唯一可行的签发方式。

### 三条实测事实

**① 80 端口上，以域名作 Host 的请求会被云厂商拦掉。**

```
Host: 117.72.146.36            → 200  Server: nginx     ← 裸 IP 正常
Host: updates.legion-si.online → 403  Server: JDTP      ← ★ 被拦
Host: legion-si.online         → 403  Server: JDTP      ← ★ 被拦
Host: 117.72.146.36.sslip.io   → 403  Server: JDTP      ← ★ 被拦
```

★ 这一条直接否掉了 **HTTP-01 挑战**（`certbot --nginx` 走的就是它）：CA 必须能从
公网访问 80 端口上的 `/.well-known/acme-challenge/…`，而那条路会被拦成 403。

> `product/server/issue-cert.sh` 里已经记录过同一个现象，并因此改用
> **TLS-ALPN-01（443）**。这份记录在更新主机上同样成立。

**② 443 端口上没有这层拦截**（带域名 Host 能连通到源站，只是证书自签不受信）。

**③ `legion-si.online` 是 **hub** 的入口，不能拿来当更新树的入口。**

它走 Cloudflare → `cloudflared` 隧道 → **直接到 hub 应用**，**完全绕过 nginx**：

```
cloudflared: 127.0.0.1:43344 → 127.0.0.1:8787
             127.0.0.1:54476 → 127.0.0.1:8787
```

旁证：nginx 访问日志里 `legion-si` 匹配 **0 行**；`/healthz` 在那个域名上返回
**401 `WWW-Authenticate: Bearer realm="legion-hub"`**（hub 给的），而不是更新站的 200。

> ★★ 同一条实测还带来一个**有用的**推论：**停 nginx 不会影响
> `legion-si.online`**（隧道绕过它）。受影响的只有裸 IP / sslip 那两个过渡入口。
> 这让"短暂停 nginx 换取 TLS-ALPN 校验"成为可接受的方案。

### 因此：更新树需要**自己的**域名

建议 `updates.legion-si.online`（当前不存在，已确认）。**不能**复用
`legion-si.online` 的根路径：那个域名整条路径归 hub，而且它绕过 nginx——
在 nginx 上加 `/legion/` 对它**完全没有效果**。

### 签发方式（两条都可行，取决于能否提供 Cloudflare 凭据）

| 方案 | 需要什么 | 续期 | 停机 |
|---|---|---|---|
| **DNS-01（推荐）** | 一个有 `Zone:DNS:Edit` 的 Cloudflare API token | 全自动 | **零** |
| **TLS-ALPN-01** | 不需要凭据；443 在校验期间必须空闲 | 每次续期重复"停 nginx → 校验 → 起 nginx" | 约 10 秒（只影响裸 IP/sslip 入口） |

★ 为什么推荐 DNS-01：`legion-si.online` 的 DNS 本来就在 Cloudflare，而
**DNS-01 不需要任何端口可达** —— 它因此同时绕开了事实①（80 被拦）与
事实②带来的停机问题。代价是交出一个能改 DNS 的凭据。

### 步骤

1. **Cloudflare 加一条记录**：`updates.legion-si.online` A → `117.72.146.36`，
   **必须「仅 DNS」灰云**（要走 CF 代理就该改隧道 ingress，而不是加这条记录）。
2. 在更新主机上签发证书（DNS-01 或 TLS-ALPN-01，见上表）。
   证书落点建议 `/etc/legion-updates/certs/{fullchain.pem,privkey.pem}`。
3. 在 nginx 上加一个 **443 server 块**，`server_name updates.legion-si.online`，
   复用现有 `legion-updates` 站点的 `root` 与三段 location（清单 `no-store`、
   发布文件 `immutable`、`/healthz`、其余 404）。80 端口保留并加一条 301 跳转。
4. **回读验证**（设计 §9 line 198 要求公开回读核对字节与签名）：
   `node scripts/update/verify-host.mjs --origin https://updates.legion-si.online --prefix /legion …`
   ★ 必须**不加** `--allow-insecure-http`，且**不关闭**证书校验——那正是
   第 27 行禁止的做法。
5. 把新的 origin 填进发行配置，并把 `publish.mjs` 的 `UPLOAD_TARGETS` 从裸 IP
   改成域名（届时 `--allow-insecure-http` 那条例外路径就只剩测试树在用）。

### 仍未做

- 上述第 1 步需要有人在 Cloudflare 控制台加记录；第 2 步需要一个 Cloudflare
  API token（若选 DNS-01）。★ 这两件事都**还没有做**，因此
  `https://updates.legion-si.online` 目前**不存在**，正式 HTTPS 入口仍然缺失。
- ★★ 另有一处与更新无关但值得尽快处理的运维风险：`cloudflared.service` 的
  `ExecStart` 指向 `--token-file /etc/cloudflared/token`，而**该文件不存在**。
  隧道进程现在跑着，但**一旦重启（或机器重启）就会失败**——届时
  `legion-si.online` 会整体下线。建议从 Cloudflare 控制台重新导出那份 token。

### 待执行的完整命令（DNS-01，选定方案）

★ 下面这段是本轮选定路径的**逐条命令**，等 Cloudflare token 到位后执行。
它的每一步都对应上面的一条实测事实，所以不是通用模板。

★★ **实际执行时这条路径的"直连"部分被证伪了**（见下面的执行结果）：DNS-01 与
证书那两步**照此执行并成功**，但灰云 A 记录那条走不通——最终改成了隧道。
保留这段是因为它记录了**当时的推理**，以及"证书这一半是独立可用的"。

```bash
# ── ① 用 token 建 A 记录（灰云 = 不代理，让客户端直连 443）──
#   ★ 为什么必须灰云：这条路径要的就是"客户端直接到 117.72.146.36:443"。
#     设成橙云会让流量回到 Cloudflare，而那需要隧道 ingress（另一条路），
#     并且在 nginx 上加的任何 location 都**不会生效**（见事实③）。
CF_TOKEN_FILE=/root/.legion-cf-token          # 只在主机上，不进仓库
ZONE_ID=$(curl -sS -H "Authorization: Bearer $CF_TOKEN_FILE" \
  'https://api.cloudflare.com/client/v4/zones?name=legion-si.online' | jq -r '.result[0].id')
curl -sS -X POST -H "Authorization: Bearer $(cat $CF_TOKEN_FILE)" \
  -H 'content-type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  --data '{"type":"A","name":"updates.legion-si.online","content":"117.72.146.36",
           "ttl":300,"proxied":false}'

# ── ② 用 acme.sh 的 DNS-01 签发（**不需要任何端口可达**）──
#   ★ 这一条是选定 DNS-01 的全部理由：它同时绕开了
#     事实①（80 被拦，HTTP-01 不可用）与事实②带来的停机问题。
export CF_Token="$(cat $CF_TOKEN_FILE)"
apt-get install -y -qq socat jq >/dev/null 2>&1 || true
ACME=/root/.acme.sh/acme.sh
$ACME --set-default-ca --server letsencrypt
$ACME --issue --dns dns_cf -d updates.legion-si.online --keylength ec-256
install -d -m 0755 /etc/legion-updates/certs
$ACME --install-cert -d updates.legion-si.online --ecc \
  --key-file       /etc/legion-updates/certs/privkey.pem \
  --fullchain-file /etc/legion-updates/certs/fullchain.pem \
  --reloadcmd      'systemctl reload nginx || true'
$ACME --install-cronjob >/dev/null 2>&1 || true

# ── ③ nginx：443 上加一个 server 块，**不改**现有 legion-updates(80) ──
#   三段 location 直接照抄 legion-updates：清单 no-store、发布文件 immutable、
#   /healthz、其余 404。80 端口那条保留并改成 301（自签/裸 IP 过渡仍在用）。
#   → 见下面「nginx 443 站点」一节

# ── ④ 回读验证（设计 §9 line 198）：**不关闭**证书校验 ──
node scripts/update/verify-host.mjs \
  --origin https://updates.legion-si.online --prefix /legion --channel stable
```

**nginx 443 站点**（加在 `/etc/nginx/sites-available/legion-updates` 里，
与现有 80 的 `server` 块并列；★ 不新建文件，避免两个站点抢同一个
`server_name` —— `legion-hub-ip` 的注释记录过那次实测事故）：

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name updates.legion-si.online;

    ssl_certificate     /etc/legion-updates/certs/fullchain.pem;
    ssl_certificate_key /etc/legion-updates/certs/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    # ★ 这一次**可以**发 HSTS：证书是可信的，不存在"用户手动信任一次"的
    #   问题（`legion-hub-ip` 那边不发 HSTS 正是因为它在自签阶段）。
    add_header Strict-Transport-Security "max-age=31536000" always;

    root /srv/legion-updates;
    autoindex off;
    server_tokens off;
    add_header X-Content-Type-Options nosniff always;

    location = /healthz {
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        return 200 "legion-update-host: ready\n";
    }
    location ~ ^/(test|production)/legion/feeds/ {
        limit_except GET { deny all; }
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options nosniff always;
        try_files $uri =404;
    }
    location ~ ^/(test|production)/legion/releases/ {
        limit_except GET { deny all; }
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff always;
        try_files $uri =404;
    }
    location / { return 404; }
}

# 80 端口那条改成跳转（保留 listeners，让 sslip/IP 的旧引用不至于 404 得莫名其妙）
server {
    listen 80;
    server_name updates.legion-si.online 117.72.146.36;
    location = /healthz { return 200 "legion-update-host: ready\n"; }
    location / { return 301 https://updates.legion-si.online$request_uri; }
}
```

---

## 执行结果（2026-10-06/07）：域名的可信 HTTPS 入口

本节记录**实际做完的事**与一个**推翻了原计划的实测结论**。

### 做完的事

| # | 动作 | 结果 |
|---|---|---|
| 1 | Cloudflare 建 A 记录 `updates.legion-si.online` → `117.72.146.36`（灰云） | ✓ 1.1.1.1 / 8.8.8.8 均解析到该 IP |
| 2 | `acme.sh` 用 **DNS-01（dns_cf）** 签证书 | ✓ `CN=updates.legion-si.online`，Let's Encrypt YE2，至 **2027-01-04**；SAN 正确 |
| 3 | 装证书到 `/etc/legion-updates/certs/` + 装续期 cron | ✓ 下次续期 **2026-12-05**（按 ARI 窗口） |
| 4 | nginx 站点配置**改用仓库生成器**重新生成并落盘 | ✓ `nginx -t` 通过，reload 成功（旧配置已备份为 `legion-updates.bak.20261007-000143`） |
| 5 | 源站侧回读（`--resolve` 到 127.0.0.1） | ✓ 见下表 |

**源站侧回读**（引导计划第 4 步的四条判据 + 缓存策略）：

| 判据 | 结果 |
|---|---|
| `/legion/feeds/…`（**生产前缀**） | **200** ← 修好了（见下节） |
| 通道清单 `Cache-Control` | `no-store` ✓ |
| 发行文件 `Cache-Control` | `public, max-age=31536000, immutable` ✓ |
| GET / HEAD / POST | 200 / 200 / **403** ✓ |
| 目录索引 | 404 ✓ |
| 证书校验（**不加** `-k`） | `tls_verify=0` ✓ |

★ 第 4 步用的是 `scripts/update/host-config.mjs`（仓库里的生成器），**不是**手写配置。
它从 `UPLOAD_TARGETS` 的磁盘根与 URL 前缀、以及 `host.mjs` 的两个缓存常量**推**出
配置；生产树不给 `--tls-cert` 时它会**具名拒绝**（`host-config-tls-required`）。
★ 顺带修掉了它注释里记着的那处不一致（见下节）。

### ★★★ 实测结论：**灰云直连在这个源站上不可能工作（ICP 备案拦截）**

原计划（方案 B）是"灰云 A 记录 + 源站 Let's Encrypt 证书，客户端直连 443"。
**这条路径被实测否掉了。**

同一个源站 IP，逐个换 TLS 的 SNI：

| SNI | 结果 |
|---|---|
| `www.baidu.com` / `qq.com` / `www.taobao.com` | **握手成功** ← 都**已备案** |
| `example.com` / `github.com` | **ECONNRESET** ← 都**未备案** |
| `updates.legion-si.online` / `legion-si.online` | **ECONNRESET** ← 都**未备案** |

而**同一个域名打到 Cloudflare 边缘就成功**（`104.21.75.194` + SNI
`legion-si.online` → 握手通过）。80 端口上的对应现象早已记过：域名 Host →
`403 Server: JDTP`，裸 IP Host → `200 nginx`。

三条合起来说明：**京东云在源站边界按 SNI 里的域名做备案校验**——
未备案域名指向境内 IP 时，TLS 握手被 reset、HTTP 被 403。

★ 两个必须说清的边界：

1. **这不是缺陷，是合规约束。** 与 `product/server/issue-cert.sh` 里记的
   「`sslip.io` 这类域名无法完成 ICP 备案……它不改变合规状态」是同一件事，
   只是那次只发现在 80 端口上。
2. **从主机自身回环测不出来。** 从主机连自己的公网 IP 时流量不经过
   那道边界（实测该路径下带 SNI 正常、`tls_verify=0`）。**所以"从主机测通了"
   不能证明客户端可用**——这一次差点因此误判。
   > 一次"从服务器自己测通"的成功，不能证明"从外面进来"能成功。

### 因此剩余的唯一可行路径：**Cloudflare 隧道**（与 hub 相同）

`legion-si.online`（hub）现在就是这么工作的：客户端 → Cloudflare → `cloudflared`
隧道 → `127.0.0.1:8787`。隧道是**服务器主动向外**建的连接，因此不经过那道
入站边界，也就没有备案问题。

**为什么不能用"橙云 A 记录 + CF 回源"**：那种模式下 Cloudflare 边缘会带
`SNI=updates.legion-si.online` 回源到境内 IP，**同样会撞上备案校验**。

**要做的（需要隧道权限，当前 token 没有）**：

1. 在 Cloudflare 控制台 → Zero Trust → Networks → Tunnels → 选那条既有隧道
   （id `81dba534-2221-4107-bd9b-ebdc8468bd67`）→ **Public Hostname** 加一条：
   - Hostname: `updates.legion-si.online`
   - Service: **`https://localhost:443`**（用我们刚签的那张真证书）
   - ★ 不要指向 `http://localhost:80`：那个 server 块是 **301 跳转**，
     经隧道会变成**无限重定向**。
2. 该操作会自动把 DNS 记录改成指向隧道的**代理 CNAME**；
   若提示冲突，先删掉那条灰云 A 记录（已备案之后再改回来）。
3. 之后把 `update-config.example.json` 的 stable/canary `origin` 填成
   `https://updates.legion-si.online`，`prefix` 保持 `/legion`。

★ 我刚用的那个 Cloudflare token 只有 `Zone:DNS:Edit` + `Zone:Read`，
**改不了隧道配置**（`/accounts/…/cfd_tunnel` 返回 Authentication error）。
要让我全做完，需要一个带 `Account → Cloudflare Tunnel → Edit` 的 token；
否则上面第 1 步请你在控制台点一下。

### 顺带修掉的一处不一致：生产前缀 `/legion` 在托管上 404

`host-config.mjs` 的注释早就记着这个缺口，本轮在真机上**复现并修掉**：

```
（修之前，用探针文件实证）
/legion/feeds/__probe.json              → 404   ← UPLOAD_TARGETS 声明的**生产**前缀
/production/legion/feeds/__probe.json   → 200   ← 文件真的在这里
磁盘 /srv/legion-updates/legion/…       → 不存在（nginx 会映射到这里）
磁盘 /srv/legion-updates/production/legion/… → 存在
```

原因是托管上那份配置是**测试期手写**的：`root /srv/legion-updates` +
`location ~ ^/(test|production)/legion/`。而生成器的做法是给每棵树各自的
`root`（生产树 `root /srv/legion-updates/production`），于是 URI `/legion/feeds/x`
落到 `/srv/legion-updates/production/legion/feeds/x` —— 正确。

> 两个各自都对的东西，可以在**接缝处**对不上——
> 而接缝处没有测试时，它会在第一次真发布时才说话。

★ 这次落盘还带来一处**收紧**：旧配置在明文 HTTP 上同时暴露
`/production/legion/…`；新配置里 80 只服务**测试树**，
`/production/legion/feeds/…` 现在返回 **404**（已实测）。

### 仍未做

- 上面那条隧道 Public Hostname（需要权限，见上）。
- ★★ 与更新无关但值得尽快处理：`cloudflared.service` 的 `ExecStart` 指向
  `--token-file /etc/cloudflared/token`，而**该文件不存在**。隧道进程现在跑着，
  但**一旦重启（或机器重启）就会失败**——届时 `legion-si.online` 会整体下线。
- 若希望**彻底摆脱 Cloudflare 依赖**（灰云直连），唯一的路是给该域名做
  **ICP 备案**；备案通过后，本轮已经建好的 A 记录 + Let's Encrypt 证书 + nginx
  443 站点**就是**正确形态，不需要重做。

---

## 执行结果（2026-10-07）：改走**隧道**，入口已上线

拿到带 `Account → Cloudflare Tunnel → Edit` 的 token 之后，按最终结论做完了。

### 做完的事

| # | 动作 | 结果 |
|---|---|---|
| 1 | 读隧道配置（**先只读**，确认不破坏 hub） | 版本 2：`legion-si.online → http://127.0.0.1:8787` + catch-all 404 |
| 2 | 备份隧道配置到 `$TEMP\tunnel-config-backup-v2.json` | ✓ |
| 3 | 在 catch-all **之前**插入一条 ingress | ✓ 版本 3 |
| 4 | DNS：删掉灰云 A，改成**代理 CNAME** → 隧道 | ✓ 与 hub 同一条隧道 |
| 5 | 从主机验证端到端 | ✓ `https://updates.legion-si.online/healthz` → **200 `tls=0`** |
| 6 | 从公网验证（强制 CF 边缘 IP） | ✓ 200 `tls=0`，IPv6 也 200 |

**新增的那条 ingress**（配置的其余部分逐字保留）：

```
2) updates.legion-si.online
     service          = https://localhost:443
     originRequest    = { originServerName: "updates.legion-si.online" }
```

★ `originServerName` 是**必需**的，不是可选美化：443 上还有 `legion-hub-ip`
那个自签站点，不给 SNI 的话 cloudflared 会连到它、证书校验失败。
给了 SNI 才会命中我们那个 `server_name updates.legion-si.online` 的块，
从而用上刚签的 Let's Encrypt 证书。

★ 边缘证书**不需要另签**：zone 的 Universal SSL 证书（`CN=legion-si.online`，
覆盖 `*.legion-si.online`）已经涵盖新主机名。

**公网回读**（真实 DNS、真实证书、经 CF 边缘 → 隧道 → nginx）：

| 判据 | 结果 |
|---|---|
| `/healthz` | **200** `tls_verify=0`，HTTP/2 |
| `/legion/feeds/…`（生产前缀） | **200**，`Cache-Control: no-store`，`cf-cache=DYNAMIC` |
| `/legion/releases/…` | **200**，`Cache-Control: public, max-age=31536000, immutable` |
| GET / HEAD / POST / PUT / DELETE | 200 / 200 / **403** / **403** / **403** |
| 目录索引 / 其它路径 | **404** |
| 明文 `http://` | **301 → https** ✓ |

★ 内容确实来自我们的树（探针文件 `{"probe":"feed"}` 原样取回，探针已清理）。

### ★★★ 顺带修掉一个部署形态相关的真缺陷（生成器）

**症状**：`http://updates.legion-si.online/healthz` 返回 **200 与真正的内容**，
而不是跳转。

**原因**：生成器只在「监听 80 的那个块」里放 `return 301`。而入口是隧道时，
cloudflared **固定连 443**，80 上的请求根本不会落到那个块上——它把**原始协议**
放在 `X-Forwarded-Proto` 里。实测：

```
明文请求 → xfp=http     ← 修之前这里返回 200 与清单内容
TLS 请求 → xfp=https
```

> 于是「80 上不服务任何内容」这句话，在**实际部署的那个形态**下是假的。

**为什么不是洁癖**：设计 §4 写着 stable 上的 HTTP 意味着中间人可以把客户端
「引到一个只提供**旧版**清单的托管」——签名挡得住伪造，挡不住这种降级。

**修法**（在生成器里，所以可复现）：443 内容块里加一条**同义**判据

```nginx
if ($http_x_forwarded_proto = "http") {
    return 301 https://$host$request_uri;
}
```

两种部署形态各只会走到其中一处，所以**两条都要在**。
`if` 里只放 `return`（nginx 明确保证这一种用法在 server 上下文里安全）。

**判据**（`host-config.test.mjs`，+1）：443 块里必须有守卫、守卫必须排在
内容 location **之前**、必须属于 443 块、80 块的跳转仍在，外加正对照
（一段只有 80 块跳转的旧形态必须被判为"缺守卫"）。

**修后实测**：

```
http://…/healthz              → 301
http://…/legion/feeds/x.json  → 301
https://…/healthz             → 200  （没把好的挡掉）
跟随跳转                       → 200
裸 IP 测试树                   → 200  （未受影响）
hub 域名                       → 401  （未受影响）
```

### ★ 一个差点造成误判的观察点问题

在本地机器上，`updates.legion-si.online` 一直 `ECONNRESET`，而
`legion-si.online` 正常。看起来像"新域名没配好"。实际原因是**本机 DNS 缓存**
还留着**已删除的灰云 A 记录**：

```
getaddrinfo → 117.72.146.36, 2606:4700:3030::ac43:b4e4, …
               ↑ 依旧 IP，命中 ICP reset，且不会回落到后面的 Cloudflare 地址
```

`ipconfig /flushdns` 也没清掉它（缓存可能在上游解析器）。

> 一个"解析器还留着旧地址"的本地状态，看起来完全像"服务端坏了"。
> 从**第二个观察点**（更新主机本身）一看就分开了。

### 仍未做

- 把 `update-config.example.json` 的 stable/canary `origin` 填成
  `https://updates.legion-si.online`（`prefix` 保持 `/legion`）——
  ★ 这一步**还没做**，目前示例里仍是 `https://updates.example.com`。
- 建议在 Cloudflare 打开 **Always Use HTTPS**（SSL/TLS → Edge Certificates）：
  那是边缘层的同一条判据，比源站层更早生效。本轮只做了源站层（因为
  token 没有 `Zone Settings:Edit`）。
- ★★ `cloudflared.service` 的 `/etc/cloudflared/token` **仍然不存在**——
  这次改动让 `legion-si.online`（hub）与 `updates.legion-si.online` **都**依赖
  这条隧道，所以那个风险比之前更大了。请尽快从控制台重新导出 token。
- ★ Cloudflare API token 现在存在主机 `/root/.legion-cf-token`（`0600`，
  acme.sh 续期要用，它把 `CF_Token` 也写进了 `/root/.acme.sh/account.conf`）。
  **拿到那台机器就等于拿到这个 token**，建议在信任边界变化时轮换它。
- 灰云直连（彻底不依赖 Cloudflare）仍只差 **ICP 备案**；
  备案之后删掉代理 CNAME、恢复那条灰云 A 记录即可（记录字段已存档）。




