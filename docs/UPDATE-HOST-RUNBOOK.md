# 更新托管与发布 —— 操作手册

> 目标：**把一版新程序发到用户手上，并让已经装了的客户端自己升上去。**
> 形态：构建在本机；发行文件同时放**两处**托管；客户端只认其中一处。
> 相关模块：`product/update/`（协议）、`scripts/update/`（发布工具）、
> `product/release/update-config.json`（客户端读的地址）。

## 0. 这套东西在哪 —— 五处地址，四处在用

| 用途 | 地址 / 路径 | 谁在用它 |
| --- | --- | --- |
| **客户端更新**（stable / canary） | `https://legion-releases.s3.cn-north-1.jdcloud-oss.com/legion` | **装了 App 的客户端**（读打包进去的 `update-config.json`） |
| 同一份内容的镜像 | `https://updates.legion-si.online/legion` | 手动验证；OSS 出问题时改 `update-config.json` 切回来 |
| internal 通道 | `http://117.72.146.36/test/legion` | 内部预演（明文 HTTP，故该通道显式 `allowInsecureHttp`） |
| 网站下载按钮的两条线路 | `/etc/legion-download-lines.json` 里的 URL | 官网访客（按 `CF-IPCountry` 选线路） |
| 门口页兜底 | `/var/lib/legion-hub/releases`（`LEGION_RELEASES_DIR`） | 线路表缺席时才用（Hub 自己托管） |

服务器上的落盘位置：

    OSS        桶 legion-releases（cn-north-1），对象前缀 legion/
    nginx      /srv/legion-updates/production/legion   ← updates.legion-si.online
               /srv/legion-updates/test/legion         ← 117.72.146.36
    Hub        /var/lib/legion-hub/releases            ← 门口页
    网站       legion-si.online（Hub :8787 经 cloudflared 隧道）

  ★ **`update-config.json` 里的 origin 才是客户端真正去的地方。**
    nginx 那份是镜像，改它不会改变已装客户端的行为。

## 1. ★ 缓存头：一个值被两边夹着，动之前先读这一节

客户端（`product/update/transport.mjs` 的 `evaluateResponse()`）对**每一次取件**
都校验响应头：

| 路径 | 要求 | 判据的严格程度 |
| --- | --- | --- |
| `feeds/**` | **恰好**是 `no-store` | `no-cache, max-age=600, no-store` **不合格**（字符串上含 no-store，但中间层仍可能留副本） |
| `releases/**` | **含** `immutable` | 只查这一个词；不查 `public`，也不查 `max-age` 的数值 |

对应的常量在 `product/update/host.mjs`：

    FEED_CACHE_CONTROL    = 'no-store'
    RELEASE_CACHE_CONTROL = 'max-age=31536000, immutable'   ← 27 字符

  ⚠️ **为什么不是常见的 `public, max-age=31536000, immutable`（35 字符）**：
    **京东云 OSS 的 `Cache-Control` 上限是 30 个字符**，超过直接拒收：

        ✖ HTTP 400：InvalidArgument: Cache-Control too long. size = 35

    实测边界（逐字符二分）：27/28/29/30 通过，**31 起被拒**。
    而客户端只要求含 `immutable` —— 所以取了同时满足两边的 27 字符版本。
    **不要把 `public` 加回来**（加了就 35 字符，OSS 会拒）。

  > 一个"在某一个托管上能用的缓存头"，
  > 与一个"在客户端与所有托管上都成立"的缓存头，
  > 在 nginx 的响应里是同一个东西——只不过前者在换托管的那一天会被拒，
  > 而拒绝信息只说"太长"，不说"客户端其实只要求一个词"。

### 1.1 nginx 侧：改配置要**重新生成**，不要手改

`/etc/nginx/sites-available/legion-updates` 由 `scripts/update/host-config.mjs`
生成（它是缓存头的消费者，值为上面的常量）：

```bash
cd /srv/legion-hub/app
node scripts/update/host-config.mjs --tree production \
  --server-name updates.legion-si.online \
  --tls-cert /etc/legion-updates/certs/fullchain.pem \
  --tls-key  /etc/legion-updates/certs/privkey.pem > /tmp/ng-prod.conf
node scripts/update/host-config.mjs --tree test \
  --server-name 117.72.146.36 --listen 80 > /tmp/ng-test.conf

cat /tmp/ng-prod.conf > /tmp/ng-final.conf
echo '' >> /tmp/ng-final.conf           # 两段之间留一个空行（纯格式）
cat /tmp/ng-test.conf >> /tmp/ng-final.conf

diff -u /etc/nginx/sites-available/legion-updates /tmp/ng-final.conf   # ★ 先看差异再动

cp -a /etc/nginx/sites-available/legion-updates \
      /tmp/legion-updates.bak-$(date +%Y%m%d-%H%M%S)                   # 备份
cp /tmp/ng-final.conf /etc/nginx/sites-available/legion-updates
nginx -t || { echo '语法不通过 —— 从备份还原'
              cp -a "$(ls -1t /tmp/legion-updates.bak-* | head -1)" /etc/nginx/sites-available/legion-updates
              exit 1; }
systemctl reload nginx
```

  ⚠️ `reload` 之后**第一次读到旧值不一定是配置没生效** —— 旧 worker 可能还在服务
    （实测踩过：`nginx -T` 已显示新值，而响应头还是旧的）。等一两秒再读，或
    `systemctl restart nginx`。

### 1.2 OSS 侧：缓存头是**对象元数据**，上传时设

对象存储不会替你加头。上传器从**对象键**派生：

```bash
node scripts/update/oss-put.mjs --bucket legion-releases --region cn-north-1 \
  --key legion/releases/rel-0.1.3/manifest.json \
  --file <本地文件> --object-prefix legion --public-read
```

`--object-prefix legion` 是**必须**的：键是 `legion/feeds/...`，而
`expectedCacheControl()` 要的是树内相对路径 `feeds/...`。前缀对不上时工具**拒绝**
而不是猜 —— 猜错的方向是"通道清单被当成发行文件"（发成 `immutable` 而客户端要
`no-store`），而那只在客户端那一侧报错。

  ⚠️ 缓存头改了要**重新上传**（元数据是 PUT 那一刻定下的）。

## 2. 发一版：五步

### 2.0 先决条件（一次性的）

| 项 | 位置 |
| --- | --- |
| 发布私钥 | `%USERPROFILE%\.legion-release-keys\release-2026-a.key.pem`（**仓库外**，`.gitignore` 有 `*.key.pem`） |
| 发布公钥 | `product/release/update-trust.json`（随产品树进包，必须提交） |
| 客户端地址 | `product/release/update-config.json`（必须提交） |
| OSS 凭据 | 环境变量 `JD_OSS_ACCESS_KEY` / `JD_OSS_SECRET_KEY` |

  ★ 私钥**只在发布时**上服务器，用 `chmod 600` + 用后 `shred -u`。
    不要放进仓库、不要写进脚本、不要留在 `/tmp`。

### 2.1 版本号（两处必须相等）

```powershell
node scripts/release/version.mjs check            # 先看现状
node scripts/release/version.mjs bump --to 0.1.4  # 同时改两处
```

  ★ 改完要**提交**。曾经发生过"发布时改了版本号但忘了提交"，
    于是 `main` 描述的是一个**已经没人装得到**的版本，而 CI 全绿
    （它只比对仓库内那两处）。

### 2.2 构建（安装包 + 程序树）

```powershell
cd desktop
$env:LEGION_VENDOR_SOURCE = '<物化过的 vendor 目录>'   # 见 2.2.1
node scripts/stage.mjs
node scripts/build.mjs
```

产物：

    desktop/dist/Legion-Setup-win-x64.exe                  ← 安装包（约 205 MB）
    .desktop-build/stage-<ts>/resources/legion/            ← 程序树（安装树的 installRoot）

#### 2.2.1 `LEGION_VENDOR_SOURCE`：pnpm 布局的产物

`stage.mjs` 用 `inventoryTree()` **拒绝符号链接**，而 pnpm 的顶层依赖全是
junction。所以那 10 个 vendor 包（`@electron/asar` 及其依赖）必须**物化**：

  ⚠️ **不要就地物化 `desktop/node_modules`** —— pnpm 靠"每个包看见自己那一份
    版本"避免冲突，拍平会破坏它。实测踩到：

        Error: Cannot find module 'brace-expansion'
        requireStack: node_modules/minimatch/dist/commonjs/index.js   ← 被拍平成 v10
                      node_modules/@electron/asar/lib/asar.js

    正确做法：在**仓库外**按 asar 期望的形状（`@electron/asar/node_modules/
    {minimatch,glob,…}` 与根下并列）复制一份，再用 `LEGION_VENDOR_SOURCE` 指过去。

#### 2.2.2 ★ 安装包必须叫 `Legion-Setup-win-x64.exe`

门口页的 `latestInstaller()` 是**按文件名找**的（`team-hub/routes/releases.mjs`）。
名字由 `desktop/scripts/artifact-name.mjs` 提供（单一真源），并由
`desktop/scripts/artifact-name.test.mjs` 用**实调 `latestInstaller()`** 钉住。

  ⚠️ 曾经叫 `Legion-${version}-internal-${arch}-setup.exe` —— 通道名被硬编码进
    产物，而且消费侧找不到它，门口页于是永远显示"尚未发布"。

### 2.3 造升级载荷（**排除 vendor**）

```powershell
# 程序树 = stage 的 resources/legion，但**去掉 vendor**
robocopy <stage>\resources\legion $env:TEMP\payload /E /COPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP /XD vendor

node scripts/update/publish.mjs `
  --package-root $env:TEMP\payload `
  --installer desktop\dist\Legion-Setup-win-x64.exe `
  --notes <notes.txt> `
  --product-manifest $env:TEMP\payload\product\release\runtime-manifest.json `
  --product-version 0.1.4 --from-versions "0.1.0,0.1.1,0.1.2,0.1.3" `
  --channel stable --release-id rel-0.1.4 `
  --key-id release-2026-a `
  --private-key "$env:USERPROFILE\.legion-release-keys\release-2026-a.key.pem" `
  --sequence 4 --issued-at <ISO> --expires-at <ISO> `
  --dsh-patch-bindings "0.1.5-rc.2:1" `
  --target production --out .\dist\update
```

  ★ **为什么去掉 vendor**：`update-payload.mjs` 按设计**禁止** `node_modules`。
    升级载荷解到 `resources/legion/versions/<版本>/`，而 vendor 属于**安装包提供的
    共享部分** `resources/legion/vendor/archive`（`bundled-runtime.mjs` 从
    `bundleRoot/legion/vendor` 读它，与 `versions/` 同级）。
    带上去的话发布器会直接拒：`载荷里出现了不该被打进升级包的东西：vendor/archive/node_modules`。

  ★ `--target test|production` **必填**（刻意没有默认值：默认成生产树时，
    测试通道的发布会生成一份指向生产目录的上传指令）。

  ★ `--from-versions` **不能为空**，且**不能包含目标版本自身**
    （协议只验证 N-1 → N）。所以"把当前版本当作通道基线发布"是不可表达的 ——
    必须发一个**新**版本。

  ★ `--sequence` 必须**递增**；客户端用它防回滚。

### 2.4 铺到两处托管

```bash
# nginx 生产面
cp -a <out>/immutable/. /srv/legion-updates/production/legion/
cp -a <out>/channel/.   /srv/legion-updates/production/legion/
chmod -R a+rX /srv/legion-updates

# OSS（逐个对象，缓存头由 --object-prefix 派生）
for rel in $(cd <out> && find channel immutable -type f | sort); do
  case "$rel" in channel/*) k="${rel#channel/}";; immutable/*) k="${rel#immutable/}";; esac
  node scripts/update/oss-put.mjs --bucket legion-releases --region cn-north-1 \
    --key "legion/$k" --file "<out>/$rel" --object-prefix legion --public-read
done
```

  ★ 各版本的 `releases/<releaseId>/` **不可覆盖**（长缓存的前提）。
    只有 `feeds/<channel>/win-x64.json` 会被覆盖。

### 2.5 回读验证（**必做**）

```bash
node scripts/update/verify-host.mjs \
  --origin https://legion-releases.s3.cn-north-1.jdcloud-oss.com \
  --prefix /legion --channel stable --trust /tmp/legion-trust.json
# internal 通道加 --origin http://117.72.146.36 --prefix /test/legion --channel internal --allow-insecure-http
```

11 项：`host-config` / `feed-cache-policy` / `feed-signature` / `feed-schema` /
`release-fetch` / **`release-digest`（通道声明 == 回读）** / `release-signature` /
`release-schema` / `artifact-{package,installer,notes}`。

  ⚠️ 这项**偶尔会因网络抖动报 FAIL**（实测三次连跑：全 ok / 两项 FAIL / 全 ok）。
    失败时先重跑一次再判断，并用 curl 直接取那个 URL 对照。

## 3. 下载页（官网那两条线路）

链接来自 `/etc/legion-download-lines.json`（**只在 Hub 启动时读一次**，改完要重启）：

```bash
cp -a /etc/legion-download-lines.json /etc/legion-download-lines.json.bak-$(date +%Y%m%d-%H%M%S)
# 改两条 url 指向新的 releases/<releaseId>/Legion-Setup-win-x64.exe
node --input-type=module -e '
import { loadDownloadLines, selectDownloadLine } from "/srv/legion-hub/app/team-hub/download-lines.mjs"
const r = loadDownloadLines("/etc/legion-download-lines.json")
console.log("ok =", r.problems.length === 0, "| 线路数 =", r.lines.length)
for (const c of ["CN", "US", null]) { const s = selectDownloadLine(r.lines, { country: c }); console.log(c, "→", s.featured?.id) }
'
systemctl restart legion-hub
```

  ★ 门口页显示的**版本号**来自 `releases/<releaseId>/manifest.json` 的
    `productVersion`，而磁盘上躺着**两种形状**的清单（旧的扁平、新的签名信封）。
    `team-hub/routes/releases.mjs` 的 `normalizeReleaseManifest()` 负责归一 ——
    它缺席过一次，表现为"页面版本号永远停在环境变量 `LEGION_DESKTOP_VERSION`"。

  ★ 门口页的**兜底路径**是 `LEGION_RELEASES_DIR`（`/var/lib/legion-hub/releases`）。
    线路表非空时它不参与选路，但要把新版放进那里、并保持该目录的 mtime 最新
    （`latestInstaller()` 按 mtime 挑）。

## 4. 已知的坑（都踩过）

| 坑 | 表现 | 处置 |
| --- | --- | --- |
| **Smart App Control 拦截未签名安装包** | `was blocked by your organization's Device Guard policy`；electron-builder 报 `spawn UNKNOWN` | 见 §5 |
| `reload` 后仍读到旧头 | 响应头是旧值而 `nginx -T` 是新值 | 旧 worker；等一两秒或 `restart` |
| `sites-available` 里的陈旧 `.bak` | 它们声明**同名 server_name**；一旦被 `ln -s` 就与正式站点打架 | 已移到 `/root/nginx-sites-backup/`；不要再放回去 |
| OSS 对象级 ACL 无效 | `--public-read` 上传返回 200，匿名读仍 403 | 公开读只能在**建桶时**设（`--create-bucket --public-read`） |
| `Cache-Control` 超 30 字符 | `400 InvalidArgument: Cache-Control too long` | 用 `RELEASE_CACHE_CONTROL`（27 字符），别加 `public` |
| 安装包与升级包对 `roles-ozon.json` 判据不一致 | 造载荷时报 `payload-forbidden-entry` | 已统一到 `payload-filter.mjs` 的 `isShippableRootRoleFile()` |
| `prepare-nsis.mjs` 找不到 `app-builder-lib` | `ERR_MODULE_NOT_FOUND` | pnpm 默认布局把传递依赖留在 `.pnpm`；需 `node-linker=hoisted` 或物化 |
| 测速：Cloudflare 前置很慢 | 境内实测 0–0.63 MB/s（OSS 1.28–1.70 MB/s） | 更新通道走 OSS；nginx 那份留作镜像 |

## 5. ★★ Smart App Control：现在**装不了、也构建不了**

2026-10-10 实测（本机，Windows 11 Home）：

    Get-AuthenticodeSignature desktop\dist\Legion-Setup-win-x64.exe → NotSigned
    CodeIntegrity 事件 id 3077/3118（SAC 拦截）**自 17:05:16 起首次出现**
    （此前只有非拦截的 3033/3089）

后果有两层：

1. **构建不了**：electron-builder 会**运行**它刚生成的中间安装包来提取卸载器
   （`WineVm.execWine` 在 win32 上直接 `exec` 那个文件）。SAC 拒绝执行 ⇒
   `spawn UNKNOWN`，`dist` 失败、留下一个 367 KB 的中间产物。
   没有任何受支持的配置能跳过这一步。
2. **装了也跑不起来**：SAC 强制状态下**未签名的安装包无法运行**
   （用 `cmd /c` 与 PowerShell 都试过；连已构建好的旧安装包也被拒）。
   这意味着**任何开了 SAC 的 Windows 11 用户都装不上**。

  ⚠️ 构建日志里那一行行 `signing with signtool.exe` **是误导** ——
    它只是改图标/版本资源，实际**没有签名**。判断签名只信
    `Get-AuthenticodeSignature`。

三条出路（需要机器管理员决定，都不是脚本能做的）：

| 出路 | 代价 |
| --- | --- |
| 关掉 Smart App Control（Windows 安全中心 → 应用和浏览器控制） | 需要管理员 + 重启；微软说关闭是**单向**的（要重新开启得重置系统） |
| 用**真实的代码签名证书**给安装包签名 | 这是长期正解 —— 也顺带解决"用户装了 SAC 就装不上" |
| 在一台没有 SAC 的机器上构建 | 构建与验证都要在那台机器上做 |

## 6. 排障速查

```bash
# 客户端到底在哪取件
grep -o '"origin"[^,]*' <installRoot>/product/release/update-config.json

# 通道清单指向哪一版（含验签）
node --input-type=module -e '
import { readFileSync } from "node:fs"
import { verifyEnvelope, ENVELOPE_FORMATS, createTrustStore } from "/srv/legion-hub/app/product/update/envelope.mjs"
const store = createTrustStore(JSON.parse(readFileSync("/tmp/legion-trust.json","utf8")).keys)
const r = await fetch("https://legion-releases.s3.cn-north-1.jdcloud-oss.com/legion/feeds/stable/win-x64.json")
const v = verifyEnvelope(Buffer.from(await r.arrayBuffer()), { trust: store, expectedFormat: ENVELOPE_FORMATS.FEED })
console.log(v.ok, v.payload?.releaseId, v.payload?.productVersion, "seq=" + v.payload?.sequence)'

# 三处托管一起核
#   OSS           --origin https://legion-releases.s3.cn-north-1.jdcloud-oss.com --prefix /legion
#   nginx/CF      --origin https://updates.legion-si.online                        --prefix /legion
#   internal      --origin http://117.72.146.36 --prefix /test/legion --allow-insecure-http

# 官网页面实际给出的链接与版本号
curl -s -H 'CF-IPCountry: CN' https://legion-si.online/ | grep -oE 'href="[^"]*(Legion|Setup)[^"]*"'
curl -s -H 'CF-IPCountry: CN' https://legion-si.online/ | grep -oE '0\.1\.[0-9]+' | sort -u
```

## 7. 这套东西的「为什么」住在哪

| 决定 | 出处 |
| --- | --- |
| 缓存头两个值、路径形状判据 | `product/update/host.mjs`（`expectedCacheControl` / `evaluateResponse`） |
| 签名信封、信任表 | `product/update/envelope.mjs` |
| 防回滚（sequence） | `product/update/feed.mjs`（`judgeSequence`） |
| 谁能升到谁（`supportedFromVersions`） | `product/update/release.mjs`、`product/update/semver.mjs` |
| 安装包文件名 | `desktop/scripts/artifact-name.mjs` |
| 哪些文件能进包 | `desktop/scripts/payload-filter.mjs` |
| 版本号两处必须相等 | `scripts/release/version.mjs`（门禁在 `scripts/ci/run-ci.mjs`） |
| SigV4 上传器与缓存头派生 | `scripts/update/oss-put.mjs` |
| nginx 配置生成 | `scripts/update/host-config.mjs` |
