#!/usr/bin/env bash
set -euo pipefail

# Run as root on the approved Ubuntu host. This creates an empty file host,
# not an unsigned release feed or a desktop update implementation.
test "$(id -u)" -eq 0
if test -e /etc/nginx/sites-enabled/legion-updates; then
  echo 'Existing legion-updates site: inspect before running bootstrap again.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx
install -d -m 0755 /srv/legion-updates
for environment in test production; do
  install -d -m 0755 "/srv/legion-updates/$environment/legion/feeds" "/srv/legion-updates/$environment/legion/releases"
done
cat > /etc/nginx/sites-available/legion-updates <<'NGINX'
server {
    listen 80;
    server_name 117.72.146.36;
    root /srv/legion-updates;
    autoindex off;
    server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    location = /healthz {
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        return 200 "legion-update-host: ready\n";
    }
    location ~ ^/(test|production)/legion/feeds/ {
        limit_except GET { deny all; }
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options nosniff always;
        try_files $uri =404;
    }
    location ~ ^/(test|production)/legion/releases/ {
        limit_except GET { deny all; }
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff always;
        try_files $uri =404;
    }
    location / { return 404; }
}
NGINX
ln -s /etc/nginx/sites-available/legion-updates /etc/nginx/sites-enabled/legion-updates
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx
curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 1 -H 'Host: 117.72.146.36' http://127.0.0.1/healthz
test "$(curl --silent -o /dev/null -w '%{http_code}' -H 'Host: 117.72.146.36' http://127.0.0.1/production/legion/feeds/missing.json)" = 404
echo 'Bootstrap verified locally; no releases have been published.'
