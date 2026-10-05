# Legion Hub 服务器部署手册

远程 Agent 通道的服务器侧部署。设计依据：
[个人服务器、个人电脑与手机协同架构设计](../../docs/superpowers/specs/2026-10-02-legion-server-pc-mobile-agent-architecture.md)，
实施计划：[2026-10-04-legion-server-pc-mobile-agent-implementation.md](../../docs/superpowers/plans/2026-10-04-legion-server-pc-mobile-agent-implementation.md)。

## 拓扑

```
手机 PWA ──HTTPS/SSE──┐
桌面浏览器 ──HTTPS/SSE──┤
                        ├── Cloudflare（TLS 终止）── 隧道（服务器主动出站）
电脑 Node ──出站 WSS────┘                                    │
                                                     Legion Hub (127.0.0.1:8787)
                                                            │
                                                    SQLite + 审计 + 投递记账
```

Hub **只绑回环**，不对公网监听。入口由 Cloudflare 提供，连接器由服务器主动向外建立
（不需要放行任何入站端口）。

## 为什么是隧道而不是直接反代（实测结论）

本机所在云厂商对**未备案域名**做了两层拦截，实测如下：

| 探测 | 结果 |
| --- | --- |
| `curl http://<域名>/...` 从公网 | **403**，`Server: JDTP`，正文是"网页禁止访问"的跳转脚本 |
| 同一路径从服务器本机带同样 Host | nginx 正常 200 |
| `Host: <裸 IP>` 请求 80 端口 | nginx 正常应答 |
| 443 端口普通 TLS（带域名 SNI） | **正常**，无中间层 |
| 443 端口 TLS-ALPN 校验（`acme-tls/1`） | **连接被重置** |

于是两条主流的证书校验都走不通：HTTP-01 要 CA 从公网访问 80 端口上的路径（被 403），
TLS-ALPN-01 走 443 但被重置。

**必须如实说明的边界**：`sslip.io` 这类域名无法完成 ICP 备案，而境内服务器上的网站
需备案是运营者的合规义务。隧道只是让技术链路在当前的拦截策略下可用，**不改变合规状态**。
长期方案是自有已备案域名，或把入口移到境外节点。

## 部署步骤

按顺序执行，每步都可单独回滚。

### ① 放代码

```bash
# 开发机
git archive --format=tar.gz -o /tmp/legion.tar.gz HEAD
scp /tmp/legion.tar.gz root@<服务器>:/tmp/
# 服务器
mkdir -p /srv/legion-hub/app
tar -xzf /tmp/legion.tar.gz -C /srv/legion-hub/app
```

### ② 装 Hub（幂等）

```bash
bash product/server/bootstrap-hub.sh
```

做四件事：建系统用户 `legion-hub` 与数据目录 `/var/lib/legion-hub`；
生成两份密钥到 `/etc/legion-hub.env`（0600，**已存在则保留**）；装 systemd 单元；
只绑回环。

> **密钥只生成一次**。换掉 `LEGION_IDENTITY_KEY` 会让全部用户会话与设备令牌立即失效。
> 脚本因此不做"每次重新生成"。

自检会打印 `/api/identity/status`、监听面（应只有 `127.0.0.1`）、以及
"无令牌 401 / 有机器令牌 200"两个读数。

### ③ 建 TLS 入口

**先完成 Cloudflare 侧**（见下节），拿到隧道 token，然后：

```bash
install -d -m 0700 /etc/legion-hub
printf '%s' '<隧道 token>' > /etc/legion-hub/tunnel.token
chmod 600 /etc/legion-hub/tunnel.token
bash product/server/setup-tunnel.sh
```

脚本从 `/usr/local/bin` 装 cloudflared（**不走官方 apt 源**：实测该源在本机网络下超时）、
装 systemd 服务、并提示"同一隧道不要有第二个连接器"。

**隧道面板里的 Service 端口必须是 `127.0.0.1:8787`**（Hub 的端口）。
填成别的（例如面板默认的 `3000`）时，公网会返回 **502**，而服务器日志里是：

```
Unable to reach the origin service ... dial tcp 127.0.0.1:3000: connect: connection refused
```

`setup-ip-entry.sh` 里有一段**只为 3000 而存在**的 nginx origin 别名——
如果你不想改面板，它能让 `localhost:3000` 也能用。把面板改成 `127.0.0.1:8787`
之后，删掉那段 `listen 3000` 的 server 块即可（两个入口同时存在迟早会有人问
"3000 是什么"）。

### ④ 初始化第一个账号

库为空时，用 Hub 机器令牌建第一个**系统管理员**：

```bash
source /etc/legion-hub.env
curl -X POST -H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"你的用户名","password":"至少8位"}' \
  http://127.0.0.1:8787/api/identity/bootstrap
```

之后所有账号都通过**邀请**产生（在设计文档里这叫多用户/邀请制）。
普通用户不能自助注册。

### ④′ 两步必须做，否则手机上是空的

**这两步都不是可选的**，而它们的缺失表现为"登录成功但什么都没有"——
用户会以为是网络或 App 的问题。

**（a）给账号一个空间角色。** 引导出来的管理员是**系统管理员**，
而系统角色管的是"造邀请 / 停用账号"，**不是**"看所有数据"：

```bash
T=<登录拿到的访问令牌>
U=<你的 userId>
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d "{\"userId\":\"$U\",\"space\":\"default\",\"role\":\"owner\"}" \
  http://127.0.0.1:8787/api/identity/roles/grant
```

不做这一步，读任何空间都会拿到 `403 SPACE_FORBIDDEN`。

**（b）装一个流程包，让空间里**有 Agent**。** 新库里 `roster` 与 `spaces` 都是空的，
而手机端"选择 Agent"那一列读的正是 `roster` 同步出来的 `agent_registry`：

```bash
# 仓库里带了一份最小可用包（需求澄清 → 编码实现 → 代码审查）
node -e 'const fs=require("fs");const pack=JSON.parse(fs.readFileSync("/srv/legion-hub/first-space.pack.json","utf8"));fs.writeFileSync("/tmp/pack.json",JSON.stringify({by:"general",pack}))'
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d @/tmp/pack.json http://127.0.0.1:8787/api/workflow-packs/preview   # 先看它要改什么
curl -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d @/tmp/pack.json http://127.0.0.1:8787/api/workflow-packs/install
```

装包会**原子地**建出空间、编队（`roster`）与流水线阶段；3 秒内的对账周期把
`roster` 同步进 `agent_registry`，手机端随即看到 Agent。

> 装包的请求体是 `{ by, pack }` 的**包装**，不是把 `by` 塞进包里——
> 包里多一个键会被 `WORKFLOW_PACK_MANIFEST_INVALID` 拒掉（校验是白名单）。

### ⑤ 电脑配对

在手机上登录 → 设备页生成配对码 → 在电脑上：

```bash
node product/node/entry.mjs pair --hub https://<你的域名> --code <配对码> --out node-config.json
# 补 workspaces 与 agent.command/args，然后：
node product/node/entry.mjs check --config node-config.json
node product/node/entry.mjs run   --config node-config.json
```

## Cloudflare 侧（需要人工在面板操作）

1. 域名（本例 `legion-si.online`）的**服务商 NS 改成 Cloudflare 给的两个 NS**，
   等生效（`nslookup -type=NS <域名> 1.1.1.1` 应回 `*.ns.cloudflare.com`）。
2. Cloudflare 面板 → Zero Trust → Networks → Tunnels → 建隧道。
3. **Public Hostnames** 加一条：
   - Subdomain: `hub`，Domain: `legion-si.online`
   - Service: `HTTP` → `127.0.0.1:8787`
4. 复制隧道 token，用于上面第 ③ 步。

> **第 3 步是必需的**，不是可选的优化：只用 token 起连接器时 Cloudflare 侧没有任何
> 入口规则，日志会出现 `No ingress rules were defined ... will return 503`，
> 表现为"隧道连着但域名打不开"。

> **不要在两台机器上用同一个 token 起连接器**。同一个隧道的多个连接器会被负载均衡，
> 而其中一台没有 Hub，表现为**间歇性 502**。要移除多余的连接器：
> `cloudflared service uninstall`。

### 排障：公网**间歇性** 404 / 502

**症状**：同一个 URL 有时 200、有时 404，且 404 的响应体是 Hub 的
`{"error":"not found: /api/..."}`。最容易误导人的一点是**部分端点一直是好的**
（例如 `/api/board`），于是"服务挂了"被排除，而问题其实在"有两个不同的服务在答"。

**根因**：隧道有**两个连接器**，Cloudflare 按请求轮流送到两边。其中一台的
`127.0.0.1:<port>` 后面是**另一个 Hub**（通常是开发机上那份旧构建），
它没有新加的端点 → 那些请求 404，而老端点照常 200。

实测踩过：运营者按早期步骤在自己电脑上跑了
`cloudflared.exe service install <token>`，于是 PC 与服务端各有一个连接器；
PC 上恰好也跑着一个 Legion Hub（旧构建），于是
`/api/identity/*` 与 `/mobile/` 间歇 404，而 `/api/board` 一直正常。

**判别方法**（一条命令就能定性）：

```bash
# 两台机器上分别跑，比较同一路径的状态码
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/identity/status
```

两边不一致（例如服务器 200、电脑 404）就说明**公网上有两个 origin 在答**。

**修法**：只保留**一台**连接器。留服务端那台，把多余的卸掉：

```bash
# Windows（需管理员）
cloudflared.exe service uninstall

# Linux
cloudflared service uninstall
```

> 连接器必须跑在**Hub 所在的那台机器**上——它转发到 `127.0.0.1:8787`，
> 而那个端口在别的机器上指的是别的东西（或什么都没有）。

## 验证清单

| 项 | 命令 | 期望 |
| --- | --- | --- |
| Hub 只在回环 | `ss -ltnp \| grep 8787` | 只有 `127.0.0.1:8787` |
| 能力发现 | `curl https://<域名>/api/identity/status` | `ok:true`，`remoteAuthRequired:true` |
| 远程门禁 | `curl -o /dev/null -w '%{http_code}' https://<域名>/api/board?scope=software` | `401` |
| 手机页面 | `curl -I https://<域名>/mobile/` | `200` + `text/html` |
| 证书可信 | `curl -sI https://<域名>/ \| head -1` | 无 `-k` 也能通 |
| Node 通道 | 电脑上 `entry.mjs run` | 日志 `已注册：协议 v1` |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TEAM_HUB_HOST` | `127.0.0.1` | **保持回环**。非回环时 `server.mjs` 会强制要求 token |
| `TEAM_HUB_PORT` | `8787` | |
| `TEAM_HUB_DB` | `team-hub/team.db` | 生产放数据目录 |
| `TEAM_HUB_TOKEN` | 空 | 机器级令牌（桌面/守护/看板/运维） |
| `LEGION_IDENTITY_KEY` | 空 | 用户与设备令牌签名密钥。**留空 = 关闭远程通道**（路由不注册、网关不挂） |
| `LEGION_REMOTE_AUTH` | 空 | 设 `1` 启用远程门禁。**反代部署必须开** |
| `LEGION_NODE_CLAIM_SCOPE` | 空 | 限定 Node 认领的空间 |

`LEGION_REMOTE_AUTH` 为什么必须显式开：`server.mjs` 里既有的读面门禁条件的是
"**非回环**监听 + 配了 token"，而反代部署下 Hub 绑的正是回环——那条门禁不会生效，
本地开发用的开放读端点会原样暴露到公网。

## 回滚

| 要回到 | 做法 |
| --- | --- |
| 关掉公网入口 | `cloudflared service uninstall`（Hub 与数据不受影响） |
| 关掉 Hub | `systemctl disable --now legion-hub` |
| 关掉远程通道但保留 Hub | 从 `/etc/legion-hub.env` 删掉 `LEGION_IDENTITY_KEY` 后重启；路由与网关都不再注册 |
| 完全清理 | 上面三条 + 删 `/var/lib/legion-hub`、`/etc/legion-hub.env`、`/etc/systemd/system/legion-hub.service` |

数据目录与既有 nginx 站点（`default` / `legion-updates`）互相独立，回滚不会影响它们。

## 运维

- **单一监督者**：只用 systemd。**不要**再用 PM2/nohup 起第二个 Hub——
  两个进程写同一个 SQLite 会以 `audit.seq` 唯一约束冲突的形式表现出来。
- 备份：`sqlite3 team.db ".backup '/path/backup.db'"`（WAL 下不要直接拷文件）。
  真正在用的是 `backup.mjs`（`VACUUM INTO` 一致快照 + 读回验证 + gpg 加密，
  `legion-hub-backup.timer` 每天 03:17），以及把它同步到异地的 `offsite.mjs`
  （`legion-hub-offsite.timer` 每天 03:47）——见 [BACKUP.md](BACKUP.md)。
- 健康：`/api/identity/status`（免鉴权）；`systemctl status legion-hub`。
- 日志：`journalctl -u legion-hub -f`。日志**不含**令牌与密钥原文。
- 证书：Cloudflare 自动续期，服务器上没有需要续的证书。

## 与既有部署的关系

`legion-updates`（桌面自动更新的文件托管）是**另一个独立站点**，与本手册无关；
两者不共用目录、不共用 nginx 站点文件，可分别上下线。
