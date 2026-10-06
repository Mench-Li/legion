#!/usr/bin/env bash
# product/server/setup-ip-entry.sh
# ============================================================================
# 用**公网 IP** 做入口（域名备案通过前的过渡方案）
#
# ## 只开 443，**不**开 80 —— 两个原因
#
# ① 80 端口上已经有 `legion-updates` 站点，servername 也是这个裸 IP。
#    两个站点在同一个端口上抢同一个 server_name，nginx 只让其中一个生效
#    （并打印 `conflicting server name`），实测是把既有站点的 /healthz
#    从 200 变成 401 —— 也就是说**新入口会悄悄打掉一个已经在跑的服务**。
#    不动既有站点是硬约束，所以这里只占 443。
#
# ② 顺带去掉了一个更坏的东西：明文 HTTP 入口。只开 80 在功能上"完全可用"，
#    而那正是危险之处——登录口令与会话令牌会明文过网，且没有任何提示。
#    只提供 HTTPS（哪怕是自签）意味着**流量始终是加密的**，
#    用户要付出的只是一次性的"信任这张证书"。
#
# ## 它提供什么、不提供什么
#
# 提供：加密传输（自签 CA 签发）、PWA 可安装（装上 CA 之后）、
#       零配置可访问（浏览器点一次"继续前往"）。
# 不提供：浏览器默认信任。手机需要装一次本脚本导出的 CA（`/legion-ca.crt`）。
#
# ## 与备案的关系
#
# 裸 IP 不受"未备案域名"拦截（实测：`Host: <IP>` 请求正常，而 `Host: <域名>`
# 返回 403 `Server: JDTP`）。这是过渡手段：备案通过后应改用域名 + 可信证书，
# 那时浏览器的"不受信任"提示与 PWA 的安装限制都会消失。
# ============================================================================
set -euo pipefail

IP="${LEGION_PUBLIC_IP:-117.72.146.36}"
UPSTREAM_PORT="${LEGION_HUB_PORT:-8787}"
CERT_DIR="${LEGION_CERT_DIR:-/etc/legion-hub/certs}"
CA_DIR="${LEGION_CA_DIR:-/etc/legion-hub/ca}"
# nginx 以非特权用户运行，而 /etc/legion-hub 是 0700 —— 把要**公开下载**的
# CA 证书放这里，否则表现为下载 403（实测过：403 + text/html）。
PUBLIC_DIR="${LEGION_PUBLIC_DIR:-/var/www/legion-public}"
SITE="/etc/nginx/sites-available/legion-hub-ip"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }

# ── ① 自签 CA 与服务器证书（不存在才生成）───────────────────────────────────
#
# 造一个**自己的 CA** 再签服务器证书，而不是直接给服务器签一张自签证书：
# 前者只需在手机上装一次 CA，之后换 IP/换域名重签都不用再装。
install -d -m 0755 "$CA_DIR" "$CERT_DIR" "$PUBLIC_DIR"
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

# 供手机下载的公开副本（0644，放在真正可读的目录）。
install -m 0644 "$CA_DIR/ca.crt" "$PUBLIC_DIR/legion-ca.crt"

# ── ② nginx 站点（独立文件，不动既有站点；**只占 443**）─────────────────────
cat > "$SITE" <<NGINX
# Legion Hub 入口（公网 IP 过渡方案，由 setup-ip-entry.sh 生成）
#
# ★ 刻意**不**监听 80：那个端口上的 legion-updates 站点用的是同一个裸 IP
#   作 server_name，两个站点抢同一个名字会让其中之一静默失效（实测会把
#   /healthz 从 200 变成 401）。域名备案通过后改用域名站点，删掉本文件即可回滚。

server {
    # ★ 用 listen ... http2 而不是 http2 on;（后者需要 nginx >= 1.25.1，
    #   本机是 1.24.0）。旧写法在 1.25+ 上仍有效（只有 deprecation 警告），
    #   所以它是**跨版本**的那个选择。
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $IP;

    ssl_certificate     $CERT_DIR/server.crt;
    ssl_certificate_key $CERT_DIR/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    # 不发 HSTS：自签证书阶段发 HSTS 会让"用户手动信任一次"变得更麻烦
    # （浏览器会把证书错误变成不可绕过）。
    add_header X-Content-Type-Options nosniff always;
    server_tokens off;

    # CA 证书带头下载：手机装一次，之后 HTTPS 不再报警、PWA 可安装。
    location = /legion-ca.crt {
        alias $PUBLIC_DIR/legion-ca.crt;
        default_type application/x-x509-ca-cert;
        add_header Content-Disposition "attachment; filename=legion-ca.crt" always;
    }

    include /etc/nginx/snippets/legion-hub-proxy.conf;
}
NGINX

# 反代片段（幂等；与 setup-tls.sh 共用同一个文件）
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

echo "--- 本机 HTTPS ---"
curl -sk --max-time 8 -o /dev/null -w 'https(ip)=%{http_code}\n' "https://127.0.0.1/api/identity/status" -H "Host: $IP" || true
echo "--- 无令牌的业务读端点必须 401 ---"
curl -sk --max-time 8 -o /dev/null -w 'board(no token)=%{http_code}\n' "https://127.0.0.1/api/board?scope=software" -H "Host: $IP" || true
echo "--- 手机页面与 CA 下载 ---"
curl -sk --max-time 8 -o /dev/null -w 'mobile=%{http_code} type=%{content_type}\n' "https://127.0.0.1/mobile/" -H "Host: $IP" || true
curl -sk --max-time 8 -o /dev/null -w 'ca=%{http_code} type=%{content_type}\n' "https://127.0.0.1/legion-ca.crt" -H "Host: $IP" || true
echo "--- ★ 既有站点不能被影响（80 端口应仍由 legion-updates 应答）---"
curl -s --max-time 8 -o /dev/null -w 'healthz(80)=%{http_code}\n' "http://127.0.0.1/healthz" -H "Host: $IP" || true
echo
echo "手机访问：https://$IP/mobile/"
echo "先在手机浏览器打开 https://$IP/legion-ca.crt 装一次证书（iOS：设置→已下载描述文件→安装→关于本机→证书信任设置）"
