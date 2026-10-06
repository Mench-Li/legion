# Legion 远程 Agent 通道 · 服务器冒烟验收

部署完成后跑这个，确认入口、鉴权与远程通道都还活着。

```bash
# 在开发机上（需要 SSH 私钥与已配对的 node-config.json）
bash product/server/smoke.sh
```

它做四件事并逐项打印读数：

1. 把当前 HEAD 部署到服务器（解包 + 重启 `legion-hub`）。
2. **服务器本机**自检：HTTPS 443 上的能力发现 / 手机页 / 静态资源 / CA 下载各是多少，
   无令牌的业务读端点是否 401，**80 端口上既有的 `legion-updates` 站点是否仍然 200**。
3. **公网**自检：同样几条走公网 IP。
4. 起本机 Node 跑一条端到端任务，打印 `node.log` 与 `node:*` 审计。

## 为什么第 2 步里那条"既有站点"检查不能省

实测踩过：一开始 Hub 在 80 与 443 都开了入口，而 80 端口上既有的
`legion-updates` 站点用的也是这个裸 IP 作 `server_name`。两个站点抢同一个名字时
nginx 只让其中一个生效，结果把既有站点的 `/healthz` 从 200 变成了 **401**——
新入口**悄悄打掉了一个已经在跑的服务**。所以 Hub 现在只占 443，而这条检查
就是防止它被改回去。

## 前置条件

- `~/.ssh/legion.pem`（或你自己的服务器私钥），把脚本顶部的 `SSH` 变量指过去。
- 服务器上已有 `/srv/legion-hub/app`、`/etc/legion-hub.env` 与
  `/srv/legion-hub/_acceptance-helper.mjs`（建任务/读状态的服务器侧助手）。
- 本机 `/tmp/legion-node/node-config.json`（由 `entry.mjs pair` 生成）与
  `/tmp/legion-ca.crt`（自签 CA，供 `NODE_EXTRA_CA_CERTS` 用）。

## 已知：远端路径到不了 `Running`

冒烟里那条端到端任务会走到 `BuildingContext` 然后**按设计停手**
（阶段被 Hub 拒绝 → 本机不再硬跑 → 按 `cancelled` 收尾）。
原因见实施计划 §6.1「尚未打通：上下文快照」——`BuildingContext → Running`
要求先有一份真实组装出来的上下文快照落库，而远端 Node 还没接上下文组装。
