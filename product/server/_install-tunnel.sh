#!/usr/bin/env bash
# 一次性：把隧道 token 落到服务器（0600），然后跑 setup-tunnel.sh。
# token 从 stdin 读，不放进命令行（命令行会被 ps 看到）。
set -euo pipefail
install -d -m 0700 /etc/legion-hub
cat > /etc/legion-hub/tunnel.token
chmod 600 /etc/legion-hub/tunnel.token
wc -c < /etc/legion-hub/tunnel.token
bash /srv/legion-hub/setup-tunnel.sh
