#!/usr/bin/env bash
# 一次性诊断：443 到底是"没有监听"还是"被云防火墙挡住"。
# 分别在服务器上起/停一个 443 监听，从公网各连一次，对比结果。
set -euo pipefail

echo "=== 服务器侧：先确认没有任何东西监听 443 ==="
ss -ltn | grep ':443 ' || echo "(443 未监听)"

echo
echo "=== 起一个最小 TLS 监听在 443（用 openssl s_server，10 秒）==="
(openssl req -x509 -newkey rsa:2048 -keyout /tmp/probe.key -out /tmp/probe.crt -days 1 -nodes -subj "/CN=probe" >/dev/null 2>&1
 timeout 40 openssl s_server -accept 443 -cert /tmp/probe.crt -key /tmp/probe.key -quiet >/dev/null 2>&1 &)
sleep 2
ss -ltn | grep ':443 ' && echo "(服务器上 443 已在监听)" || echo "(!) 监听没起来"
echo "本机自连（应当成功）："
timeout 5 openssl s_client -connect 127.0.0.1:443 -servername 117.72.146.36.sslip.io </dev/null 2>&1 | grep -E "CONNECTED|subject=|verify error" | head -3 || true

echo
echo "=== 监听保持 40 秒；窗口期内从公网分别测三种连法 ==="
echo "  A 裸 TCP   : bash -c 'cat </dev/null >/dev/tcp/IP/443'"
echo "  B 无 SNI   : openssl s_client -connect IP:443"
echo "  C 带 SNI   : openssl s_client -connect IP:443 -servername 117.72.146.36.sslip.io"
wait || true
