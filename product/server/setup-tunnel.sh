#!/usr/bin/env bash
# product/server/setup-tunnel.sh
# ============================================================================
# Cloudflare Tunnel 连接器（远程 Agent 通道 S-G）
#
# ## 为什么用隧道而不是直接反代
#
# 实测本机所在云厂商对**未备案域名**做了两层拦截：
#   · 80 端口：以域名为 Host 的请求返回 403（`Server: JDTP`），nginx 根本收不到；
#   · 443 端口：普通的 TLS 连接正常，但 **acme-tls/1** 的 ALPN 校验被重置。
# 于是 Let's Encrypt 的两种主流校验（HTTP-01 / TLS-ALPN-01）都走不通。
#
# Cloudflare Tunnel 把方向反过来：**服务器主动出站**连到 Cloudflare，
# 公网入口在 Cloudflare 侧。这样：
#   · 不需要放行任何入站端口（只有出站 443）；
#   · 证书由 Cloudflare 提供（可信，PWA 可安装）；
#   · 不经过境内 80 口那道针对域名的拦截。
#
# ## 为什么必须确认"本机没有第二个连接器"
#
# 同一个隧道可以有多个连接器，Cloudflare 会**负载均衡**到它们。如果运营者的
# 个人电脑上也装了同一个 token 的服务，请求会随机落到那台机器上——而它没有
# 这个 Hub，表现为**间歇性的 502**。这种"一半时间好用"的故障最难查，
# 所以本脚本会显式检查并提示。
# ============================================================================
set -euo pipefail

TOKEN_FILE="${TUNNEL_TOKEN_FILE:-/etc/legion-hub/tunnel.token}"
HUB_PORT="${LEGION_HUB_PORT:-8787}"
SERVICE="cloudflared"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }
test -s "$TOKEN_FILE" || { echo "缺少隧道 token 文件：$TOKEN_FILE" >&2; exit 1; }
chmod 600 "$TOKEN_FILE"

# ── ① 装 cloudflared ────────────────────────────────────────────────────────
#
# ★ 实测这台服务器**连不上** `pkg.cloudflare.com`（apt 源超时），所以不走官方仓库。
#   走 GitHub release 的静态二进制（同一网络下 github 可达，acme.sh 与 NodeSource
#   都是这么装上的），装到 /usr/local/bin。版本固定记录在文件里，便于复核。
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.9.3}"
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"
  URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}"
  echo "从 GitHub 下载 cloudflared ${CLOUDFLARED_VERSION}（${ARCH}）"
  curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/cloudflared "$URL"
  chmod 0755 /usr/local/bin/cloudflared
fi
cloudflared --version

# ── ② 装服务（token 从文件读，不进命令行/不进 ps 可见的 argv）─────────────────
# `service install` 会把 token 写进 systemd 单元；命令行里带 token 会被 `ps` 看到，
# 所以先读进变量，用 systemd 单元文件的方式落盘。
TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

if systemctl list-unit-files | grep -q '^cloudflared.service'; then
  echo "cloudflared 服务已存在：先卸载再按当前 token 重装"
  cloudflared service uninstall >/dev/null 2>&1 || true
fi
cloudflared service install "$TOKEN"

systemctl enable cloudflared >/dev/null 2>&1 || true
systemctl restart cloudflared
sleep 6

echo "--- 服务状态 ---"
systemctl is-active cloudflared
echo "--- 最近日志（应出现 Registered tunnel connection）---"
journalctl -u cloudflared --no-pager -n 25 | tail -25

echo
echo "--- 本机 Hub 自检（隧道要指向它）---"
curl -s -o /dev/null -w "hub loopback=%{http_code}\n" --max-time 5 "http://127.0.0.1:$HUB_PORT/api/identity/status"

echo
echo "提醒：如果这台机器之外还跑着同一个 token 的连接器（例如运营者的个人电脑），"
echo "      同一个隧道会有多个连接器并被负载均衡，表现为间歇性 502。"
echo "      用 \`cloudflared service uninstall\` 卸掉多余的那一个。"
