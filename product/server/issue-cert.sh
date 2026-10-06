#!/usr/bin/env bash
# product/server/issue-cert.sh
# ============================================================================
# 用 **TLS-ALPN-01（443）** 签证书，而不是 HTTP-01（80）。
#
# ## 为什么必须换挑战方式（实测结论）
#
# 这台服务器在中国境内的云厂商（京东云）。实测：
#
#   · `curl http://117.72.146.36.sslip.io/...` 从公网返回 **403**，
#     响应头是 `Server: JDTP`，正文是一段"网页禁止访问"的跳转脚本；
#   · 同一个路径从服务器本机带同样的 Host 头请求，nginx 正常返回 200；
#   · 同一时刻用 `Host: 117.72.146.36`（裸 IP）请求 80 端口，nginx 正常应答；
#   · 443 端口没有任何中间层（未监听时是连接被拒绝，而不是被代理接管）。
#
# 三条合起来说明：拦截发生在 **80 端口的、以未备案域名为 Host 的** 请求上。
# 证书签发因此不能用 HTTP-01（它要求 CA 从公网访问 80 端口上的一个路径），
# 而 TLS-ALPN-01 走 443，实测这条路上没有中间层。
#
# ## 必须如实告知的边界
#
# `sslip.io` 这类域名**无法完成 ICP 备案**，而"境内服务器上的网站需备案"是运营者
# 面对的合规要求。本脚本只是让技术链路在**当前**拦截策略下可用；它不改变合规状态。
# 更稳的做法是自有已备案域名，或把入口移到境外节点 —— 两者都需要另行决定。
# ============================================================================
set -euo pipefail

DOMAIN="${LEGION_DOMAIN:-117.72.146.36.sslip.io}"
ACME_DIR="${ACME_HOME:-/root/.acme.sh}"
CERT_DIR="${LEGION_CERT_DIR:-/etc/legion-hub/certs}"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq socat >/dev/null 2>&1 || true

if [ ! -x "$ACME_DIR/acme.sh" ]; then
  if [ -d "$ACME_DIR" ]; then mv "$ACME_DIR" "$ACME_DIR.bak.$(date +%s)"; fi
  curl -fsSL https://get.acme.sh -o /tmp/get-acme.sh
  sh /tmp/get-acme.sh >/dev/null 2>&1 || true
fi
test -x "$ACME_DIR/acme.sh" || { echo "acme.sh 安装失败" >&2; exit 1; }

# 443 必须空闲：TLS-ALPN 校验期间 acme.sh 要自己占用它。
if ss -ltn | grep -q ':443 '; then
  echo "443 已被占用，TLS-ALPN 校验无法进行：$(ss -ltnp | grep ':443 ' | head -1)" >&2
  exit 1
fi

# 默认 CA 换成 Let's Encrypt（acme.sh 默认 ZeroSSL 需要邮箱注册）。
"$ACME_DIR/acme.sh" --set-default-ca --server letsencrypt >/dev/null

if [ ! -d "$ACME_DIR/$DOMAIN" ]; then
  echo "--- 用 TLS-ALPN-01 在 443 上校验并签发 ---"
  "$ACME_DIR/acme.sh" --issue --alpn -d "$DOMAIN" --server letsencrypt --keylength ec-256
else
  echo "$DOMAIN 已有证书；如需强制重签请先删除 $ACME_DIR/$DOMAIN"
fi

install -d -m 0755 "$CERT_DIR"
# `--install-cert` 是 acme.sh 维护证书副本的方式，renew 时会自动更新这里。
"$ACME_DIR/acme.sh" --install-cert -d "$DOMAIN" --ecc \
  --key-file       "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd      "systemctl reload nginx || true"

# 自动续期：acme.sh 安装时已注册 cron；这里补一条显式 ensure。
"$ACME_DIR/acme.sh" --install-cronjob >/dev/null 2>&1 || true

echo "--- 证书信息 ---"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName
echo "--- 续期演练 ---"
"$ACME_DIR/acme.sh" --renew -d "$DOMAIN" --ecc --force --dry-run 2>&1 | tail -3 || true
