#!/usr/bin/env bash
# 用真实 Chrome（headless）打开手机页，把渲染后的 DOM 与浏览器控制台倒出来。
#
# 为什么要有这一步：接口契约用例能证明"字段名对得上"，但它们**不执行 app.mjs**。
# 一个在浏览器里一加载就抛异常的页面，在那些用例下是全绿的——
# 而用户看到的是一片空白。
#
#   > "接口全通"与"页面能打开"是两种不同的坏法，而它们都表现为"手机上什么都没有"。
set -uo pipefail

URL="${1:-https://legion-si.online/mobile/}"
OUT=.pwa-check
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

test -x "$CHROME" || { echo "找不到 Chrome：$CHROME" >&2; exit 1; }
mkdir -p "$OUT"

echo "① 渲染后的 DOM（等 8 秒，让登录页/脚本跑起来）"
"$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=8000 \
  --dump-dom "$URL" > "$OUT/dom.html" 2>"$OUT/chrome.log"
echo "   字节数：$(wc -c < "$OUT/dom.html")"

echo
echo "② 关键结构是否还在（整片消失 = 脚本把 DOM 弄坏了）"
for id in screen-login login-name login-password btn-login login-error main timeline composer; do
  if grep -q "id=\"$id\"" "$OUT/dom.html"; then echo "   ✔ #$id"; else echo "   ✖ #$id 丢失"; fi
done

echo
echo "③ 脚本有没有真的跑起来（登录页应被显示；main() 会调 refreshStatus）"
# 初始：screen-login 可见；main() 跑完后它会保持可见（未登录）。
if grep -q 'id="screen-login"' "$OUT/dom.html"; then
  echo "   ✔ 登录屏在 DOM 里"
fi
# 页面标题由 app.mjs 在登录后改写为「Legion · 用户名」；未登录时应仍是初始标题。
title=$(grep -o '<title>[^<]*</title>' "$OUT/dom.html" | head -1)
echo "   标题：$title"

echo
echo "④ 浏览器控制台（有 JS 异常会出现在这里）"
if [ -s "$OUT/chrome.log" ]; then
  grep -iE "error|uncaught|exception|failed" "$OUT/chrome.log" | head -10 | sed 's/^/   /' || echo "   （无 error 关键字）"
else
  echo "   （stderr 为空）"
fi

echo
echo "⑤ 网络失败（资源 404 会让页面缺件）"
grep -iE "404|net::|Failed to load" "$OUT/chrome.log" | head -8 | sed 's/^/   /' || echo "   （无资源加载失败）"
