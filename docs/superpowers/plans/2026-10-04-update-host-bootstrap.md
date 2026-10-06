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

