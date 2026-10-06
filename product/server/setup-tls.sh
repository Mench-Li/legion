#!/usr/bin/env bash
# product/server/setup-tls.sh
# ============================================================================
# Legion Hub 的 nginx + Let's Encrypt 入口（远程 Agent 通道 S-G）
#
# ## 为什么用 sslip.io 而不是自签证书
#
# PWA 需要**可信** HTTPS：不仅是"能装"，Service Worker 在不可信证书下根本不注册，
# 而手机上的"信任自签 CA"是一个用户会被反复要求重做、且很容易在换手机后忘记的动作。
# `117.72.146.36.sslip.io` 解析到该 IP（已在服务器与本机实测），
# 于是可以在**没有自有域名**的前提下签一张被浏览器信任的证书。
#
# ## 不做的事
#
# 不改既有站点（`default` / `legion-updates`），不改 SSH，不开防火墙。
# 本脚本只新增一个独立站点文件；删掉它即可完整回滚 TLS 入口。
#
# ## 为什么手写 443 块而不是 `certbot --nginx`
#
# `--nginx` 会自动改写站点文件。在这个机器上有别的业务站点，而"证书插件按自己的
# 理解重写了某一段"是一件事后很难复核的事。用 `certonly --webroot` 只取证书，
# 配置由本脚本显式写出：改了什么，就在这个文件里。
# ============================================================================
set -euo pipefail

DOMAIN="${LEGION_DOMAIN:-117.72.146.36.sslip.io}"
UPSTREAM_PORT="${LEGION_HUB_PORT:-8787}"
ACME_WEBROOT="${LEGION_ACME_WEBROOT:-/var/www/legion-acme}"
SITE="/etc/nginx/sites-available/legion-hub"
EMAIL="${LEGION_ACME_EMAIL:-}"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }

install -d -m 0755 "$ACME_WEBROOT/.well-known/acme-challenge"

# ── ① 先只开 80：ACME 挑战 + 反代（证书还没签下来时也要能用） ────────────────
cat > "$SITE" <<NGINX
# Legion Hub 入口（由 product/server/setup-tls.sh 生成）
#
# 只暴露 443；80 仅用于 ACME 挑战与跳转。Hub 自己绑 127.0.0.1，不经公网。
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root $ACME_WEBROOT; }

$(if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then cat <<'REDIR'
    location / { return 301 https://$host$request_uri; }
REDIR
else cat <<'PROXY'
    include /etc/nginx/snippets/legion-hub-proxy.conf;
PROXY
fi)
}

$(if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then cat <<SSLBLOCK
server {
    # 见 setup-ip-entry.sh 中同处的说明：这里用 listen ... http2 而不是
    # http2 on;（后者需要 nginx >= 1.25.1，本机是 1.24.0）。
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    server_tokens off;

    include /etc/nginx/snippets/legion-hub-proxy.conf;
}
SSLBLOCK
fi)
NGINX

# 反代片段单独成文件：两处（80 无证书时、443）共用同一段，
# 分写两份一定会漂移，而漂移的地方正是 WebSocket/SSE 那两个特殊块。
cat > /etc/nginx/snippets/legion-hub-proxy.conf <<'PROXY'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 12m;

# Node 通道：WebSocket 升级必须逐跳透传，且读超时不能是默认的 60s
# ——一条空闲的 Node 连接靠心跳活着，60s 断开会表现为"节点每分钟左右掉线一次"。
location = /node {
    proxy_pass http://127.0.0.1:__PORT__;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# 事件流（SSE）：关缓冲，否则事件会攒在 nginx 里直到某个大小才吐出去，
# 表现出来是"手机上的进展要等很久才出现"，而服务端日志一切正常。
location = /api/events {
    proxy_pass http://127.0.0.1:__PORT__;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    gzip off;
}

location / {
    proxy_pass http://127.0.0.1:__PORT__;
    proxy_read_timeout 300s;
}
PROXY
sed -i "s/__PORT__/$UPSTREAM_PORT/g" /etc/nginx/snippets/legion-hub-proxy.conf

ln -sf "$SITE" /etc/nginx/sites-enabled/legion-hub

# ── ② 自检 + 生效 ───────────────────────────────────────────────────────────
nginx -t
mkdir -p /etc/nginx/snippets
systemctl reload nginx
sleep 1

# ── ③ 签证书（只在还没有时）─────────────────────────────────────────────────
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  CERTBOT_ARGS=(certonly --webroot -w "$ACME_WEBROOT" -d "$DOMAIN" --agree-tos --no-eff-email --non-interactive)
  if [ -n "$EMAIL" ]; then CERTBOT_ARGS+=(--email "$EMAIL"); else CERTBOT_ARGS+=(--register-unsafely-without-email); fi
  certbot "${CERTBOT_ARGS[@]}"
  # 用带证书的版本改写站点，再 reload。
  "$0"
  exit 0
fi

# ── ④ 公网验收 ──────────────────────────────────────────────────────────────
echo "--- 本机 HTTPS ---"
curl -sS --max-time 10 -o /dev/null -w 'https status=%{http_code} verify=%{ssl_verify_result}\n' "https://$DOMAIN/api/identity/status" || true
curl -sS --max-time 10 "https://$DOMAIN/api/identity/status" || true
echo
echo "--- 无令牌的业务读端点必须 401（经公网也一样）---"
curl -sS --max-time 10 -o /dev/null -w 'board(no token)=%{http_code}\n' "https://$DOMAIN/api/board?scope=software" || true
echo "--- 80 应跳转到 443 ---"
curl -sS --max-time 10 -o /dev/null -w 'http status=%{http_code} location=%{redirect_url}\n' "http://$DOMAIN/api/identity/status" || true
echo "--- 证书续期演练（dry-run）---"
certbot renew --dry-run 2>&1 | tail -3
