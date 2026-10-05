#!/usr/bin/env bash
# product/server/setup-ip-entry.sh
# ============================================================================
# 用**公网 IP** 做入口（备案通过前的过渡方案）
#
# ## 它提供什么、不提供什么 —— 请读完再决定用哪个端口
#
# 同时开两个入口：
#
#   http://<IP>/mobile/    —— 明文。**零配置**，手机上打开就能用。
#                             但登录口令与会话令牌会以明文经过公网。
#                             只应在你信任的网络下短时使用。
#   https://<IP>/mobile/   —— 自签证书。**加密**，浏览器会报"证书不受信任"，
#                             手机上需要装一次本脚本导出的 CA 才不再报警
#                             （装完之后 PWA 也能安装）。
#
# ## 为什么必须说清楚这件事
#
# 一个只开 80 的入口在功能上"完全可用"——这正是危险之处：没有人会注意到口令
# 正在明文过网。所以本脚本不把明文当默认方案，而是把两个入口都摆出来，
# 让选择是一个**显式**动作。
#
# ## 备案との関係 / 与备案的关系
#
# 用**裸 IP** 不受"未备案域名"拦截（实测：`Host: <IP>` 请求 80 端口正常，
# 而 `Host: <域名>` 会返回 403 `Server: JDTP`）。这是过渡手段。
# 备案通过后应改回域名 + 可信证书（Cloudflare 或 Let's Encrypt），
# 那时 PWA 的"可安装"与浏览器的"安全"提示都会恢复正常。
# ============================================================================
set -euo pipefail

IP="${LEGION_PUBLIC_IP:-117.72.146.36}"
UPSTREAM_PORT="${LEGION_HUB_PORT:-8787}"
CERT_DIR="${LEGION_CERT_DIR:-/etc/legion-hub/certs}"
CA_DIR="${LEGION_CA_DIR:-/etc/legion-hub/ca}"
SITE="/etc/nginx/sites-available/legion-hub-ip"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }

# ── ① 自签 CA 与服务器证书（不存在才生成）───────────────────────────────────
#
# 造一个**自己的 CA** 再签服务器证书，而不是直接给服务器签一张自签证书：
# 前者只需在手机上装一次 CA，之后换 IP/换域名重签都不用再装；后者每次都要重装。
install -d -m 0755 "$CA_DIR" "$CERT_DIR"
if [ ! -f "$CA_DIR/ca.crt" ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout "$CA_DIR/ca.key" -out "$CA_DIR/ca.crt" \
    -subj "/CN=Legion Local CA/O=Legion" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  chmod 600 "$CA_DIR/ca.key"
  echo "已生成本地 CA：$CA_DIR/ca.crt"
fi

if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$CERT_DIR/server.key" -out /tmp/legion-server.csr \
    -subj "/CN=$IP/O=Legion" >/dev/null 2>&1
  # SAN 必须带 IP：现代浏览器不再看 CN，只看 SAN。
  cat > /tmp/legion-server.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1
EXT
  openssl x509 -req -in /tmp/legion-server.csr -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -CAcreateserial -out "$CERT_DIR/server.crt" -days 825 -sha256 \
    -extfile /tmp/legion-server.ext >/dev/null 2>&1
  chmod 600 "$CERT_DIR/server.key"
  rm -f /tmp/legion-server.csr /tmp/legion-server.ext
  echo "已签发服务器证书：$CERT_DIR/server.crt"
fi

# ── ② nginx 站点（独立文件，不动既有站点）───────────────────────────────────
cat > "$SITE" <<NGINX
# Legion Hub 入口（公网 IP 过渡方案，由 setup-ip-entry.sh 生成）
#
# 裸 IP 不受"未备案域名"拦截；域名备案通过后改用 setup-tls.sh 的域名站点，
# 删掉本文件即可回滚。

server {
    listen 80;
    listen [::]:80;
    server_name $IP;

    # 明文入口。**仅过渡期使用**：口令与令牌会明文过网。
    add_header X-Content-Type-Options nosniff always;
    server_tokens off;

    # CA 证书带头下载（在 80 上提供，因为它只是一张公开证书，
    # 而 HTTPS 此时还是不受信任状态）。
    location = /legion-ca.crt {
        alias $CA_DIR/ca.crt;
        default_type application/x-x509-ca-cert;
        add_header Content-Disposition "attachment; filename=legion-ca.crt" always;
    }

    include /etc/nginx/snippets/legion-hub-proxy.conf;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $IP;

    ssl_certificate     $CERT_DIR/server.crt;
    ssl_certificate_key $CERT_DIR/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    # 自签证书 + 现代浏览器：不需要 HSTS（会把手动信任弄得更麻烦）。
    add_header X-Content-Type-Options nosniff always;
    server_tokens off;

    location = /legion-ca.crt {
        alias $CA_DIR/ca.crt;
        default_type application/x-x509-ca-cert;
        add_header Content-Disposition "attachment; filename=legion-ca.crt" always;
    }

    include /etc/nginx/snippets/legion-hub-proxy.conf;
}
NGINX

# 反代片段（幂等：与 setup-tls.sh 共用同一个片段文件）
install -d -m 0755 /etc/nginx/snippets
cat > /etc/nginx/snippets/legion-hub-proxy.conf <<'PROXY'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 12m;

# Node 通道：WebSocket 升级逐跳透传；读超时必须放宽（默认 60s 会把靠心跳
# 活着的空闲连接每分钟左右断一次）。
location = /node {
    proxy_pass http://127.0.0.1:__PORT__;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# 事件流（SSE）：必须关缓冲，否则事件会攒在 nginx 里，手机上的进展延迟出现，
# 而服务端日志一切正常。
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

ln -sf "$SITE" /etc/nginx/sites-enabled/legion-hub-ip

# ── ③ 自检并生效 ────────────────────────────────────────────────────────────
nginx -t
systemctl reload nginx
sleep 1

echo "--- 本机 HTTPS（自签，仍应能连上）---"
curl -sk --max-time 8 -o /dev/null -w 'https(ip)=%{http_code}\n' "https://127.0.0.1/api/identity/status" -H "Host: $IP" || true
echo "--- 本机 HTTP ---"
curl -s --max-time 8 -o /dev/null -w 'http(ip)=%{http_code}\n' "http://127.0.0.1/api/identity/status" -H "Host: $IP" || true
echo "--- 无令牌的业务读端点必须 401 ---"
curl -s --max-time 8 -o /dev/null -w 'board(no token)=%{http_code}\n' "http://127.0.0.1/api/board?scope=software" -H "Host: $IP" || true
echo "--- 手机页面 ---"
curl -s --max-time 8 -o /dev/null -w 'mobile=%{http_code}\n' "http://127.0.0.1/mobile/" -H "Host: $IP" || true
echo
echo "CA 证书可从这里下载（手机上装一次即可让 HTTPS 不再报警）："
echo "  http://$IP/legion-ca.crt"
