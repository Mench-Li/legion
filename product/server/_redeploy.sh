#!/usr/bin/env bash
# 一次性：把新代码解到 app 目录并重启 Hub（幂等）。
set -euo pipefail
test -f /tmp/legion-remote2.tar.gz
rm -rf /srv/legion-hub/app.new
mkdir -p /srv/legion-hub/app.new
tar -xzf /tmp/legion-remote2.tar.gz -C /srv/legion-hub/app.new
# 确认关键文件在
test -f /srv/legion-hub/app.new/team-hub/routes/mobile.mjs
test -f /srv/legion-hub/app.new/workbench/mobile/index.html
rsync -a --delete /srv/legion-hub/app.new/ /srv/legion-hub/app/ 2>/dev/null || {
  rm -rf /srv/legion-hub/app
  mv /srv/legion-hub/app.new /srv/legion-hub/app
}
rm -rf /srv/legion-hub/app.new
systemctl restart legion-hub
sleep 4
systemctl is-active legion-hub
echo "--- 手机页面（应 200，且类型 text/html）---"
curl -s -o /dev/null -w 'mobile=%{http_code} type=%{content_type}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/mobile/
echo "--- 静态资源 ---"
curl -s -o /dev/null -w 'app.mjs=%{http_code} type=%{content_type}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/mobile/app.mjs
curl -s -o /dev/null -w 'manifest=%{http_code}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/mobile/manifest.webmanifest
curl -s -o /dev/null -w 'icon=%{http_code}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/mobile/icon-192.png
echo "--- 鉴定：API 仍然要令牌 ---"
curl -s -o /dev/null -w 'board(no token)=%{http_code}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/api/board?scope=software
curl -s -o /dev/null -w 'status(public)=%{http_code}\n' --max-time 8 -H 'Host: 117.72.146.36' http://127.0.0.1/api/identity/status
