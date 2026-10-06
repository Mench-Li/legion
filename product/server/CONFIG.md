# Legion Hub 服务器配置手册

本文是 **Hub 部署到服务器之后要配什么**的单一入口。部署步骤见 [README.md](README.md)，
备份与异地见 [BACKUP.md](BACKUP.md)。安装包签名见 [签名](../../desktop/SIGNING.md)。

配置只有**一个**注入点：systemd 单元的 `EnvironmentFile=/etc/legion-hub.env`
（由 `bootstrap-hub.sh` 写出，见 README 的「② 装 Hub」）。本文所有变量都写在那里。

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/legion-hub.env   # 文件本身 0600
sudo systemctl restart legion-hub
systemctl show legion-hub -p EnvironmentFiles      # 确认真的加载了
```

> **不要把密钥写进 systemd 单元的 `Environment=`。**
> 单元文件是 0644，而 `Environment=` 在 `systemctl show` 与 journal 里都读得到。
> `EnvironmentFile` 指的那个文件才是 0600 的。

---

## 一、最小可用配置

一份能跑起来的 `/etc/legion-hub.env`（**照着抄之前先看第二节**——`IDENTITY_KEY`
一旦定下来就不该再换）：

```bash
TEAM_HUB_HOST=127.0.0.1
TEAM_HUB_PORT=8787
TEAM_HUB_DB=/var/lib/legion-hub/team.db
TEAM_HUB_TOKEN=<48 字符随机串>
LEGION_IDENTITY_KEY=<至少 16 字符的随机串>
LEGION_REMOTE_AUTH=1
```

生成两个密钥：

```bash
openssl rand -base64 36 | tr -d '/+=' | head -c 48   # → TEAM_HUB_TOKEN
openssl rand -base64 48 | tr -d '/+=' | head -c 64   # → LEGION_IDENTITY_KEY
```

---

## 二、★ 三个开关，一条链（最容易配错的地方）

远程能力不是**一个**开关，是**三个**，而且是有顺序的：

```text
LEGION_IDENTITY_KEY 长度 ≥ 16
        │
        ▼
REMOTE_AGENT_ENABLED  ← 整个远程族**注册/不注册**
        │  （身份路由、设备管理、Node 网关全部在内）
        ▼
LEGION_REMOTE_AUTH=1
        │
        ▼
REMOTE_AUTH_ENABLED   ← 远程**读面门禁**（无令牌的 /api/* 一律 401）
```

三条各自会怎么坏，都是**静默**的：

| 配错 | 现象 |
| --- | --- |
| `LEGION_IDENTITY_KEY` 空或 < 16 字符 | 整个远程族**不存在**：`/api/identity/*` 404、设备配不上对、手机连不上。**启动日志里没有任何抱怨** |
| 有 `IDENTITY_KEY` 但没设 `LEGION_REMOTE_AUTH=1` | 身份能登，但**读面门禁不开**——任何人不带令牌就能读 `/api/board` 之类。这是**暴露**，不是故障 |
| 两个都设了、但 `TEAM_HUB_HOST` 不是回环 | 启动直接抛 `TEAM_HUB_TOKEN 必须配置`（见下） |

> `IDENTITY_KEY` 短于 16 字符时不是"降级"，是**整条远程通道消失**。
> 而这个失败在启动时完全看不出来——直到有人去配对电脑。

所以：**配完立刻用第三节那三条命令验一遍**，不要靠"应该没问题"。

### 非回环监听是硬门

`validateSecurityConfig()` 在**启动时**检查：

```text
TEAM_HUB_HOST 非回环 && TEAM_HUB_TOKEN 为空  →  抛错，拒绝启动
```

这是刻意的：一个没有鉴权、监听 `0.0.0.0` 的 Hub，等于把整台机器的任务池
交给同网段所有人。它**拒绝启动**而不是打个警告，因为警告没人看。

本方案里 Hub 应当始终绑 `127.0.0.1`，由反向代理/隧道对外——见 README 的
「为什么是隧道而不是直接反代」。

---

## 三、配完之后的验收（三条命令）

```bash
# ① 远程族在不在（这条不过 = IDENTITY_KEY 没生效）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/identity/status
#   期望 200。404 就是远程族没注册。

# ② 门禁开没开（这条返回 200 = 你的读面是公开的）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/board
#   期望 401。

# ③ 机器令牌能不能过（这条不过 = TEAM_HUB_TOKEN 不对）
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TEAM_HUB_TOKEN" \
  http://127.0.0.1:8787/api/board
#   期望 200（或 200/403 取决于空间角色）。
```

公网侧再跑一次完整验收（照手机端经历的那一串，21 项）：

```bash
LEGION_PW_FILE=/etc/legion-hub/first-admin-password.txt \
  node product/server/verify-phone.mjs https://<你的域名>
```

---

## 四、全部变量

### 4.1 监听、鉴权、存储

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TEAM_HUB_HOST` | `127.0.0.1` | **保持回环**。非回环是硬门（见第二节） |
| `TEAM_HUB_PORT` | `8787` | 与反向代理/隧道里的目标端口**必须一致** |
| `TEAM_HUB_TOKEN` | *(空)* | **机器令牌**：本机组件、桌面启动器、迁移脚本用。`sensitive` |
| `TEAM_HUB_DB` | `team-hub/team.db` | 上服务器时改成 `/var/lib/legion-hub/team.db` |

### 4.2 远程 Agent 通道

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LEGION_IDENTITY_KEY` | *(空)* | **用户/设备令牌的 HMAC 签名密钥**，≥16 字符。留空 = 关闭整条远程通道。`sensitive` |
| `LEGION_REMOTE_AUTH` | *(空)* | 设 `1` 才开门禁。Hub 绑回环 + 反代**必须**设 |
| `LEGION_NODE_CLAIM_SCOPE` | *(空)* | Node 网关认领任务时限定到某个空间。留空 = 不限。**单机部署建议限定** |
| `LEGION_REGISTRATION` | `closed` | 注册策略：`closed` / `invite` / `open`（见 4.4） |
| `LEGION_REGISTRATION_MAX` | `20` | 自助注册速率上限（每小时新开账号数）。`0` = 关掉闸门。仅 `open` 生效 |
| `LEGION_APPROVAL_TTL_MS` | `900000` | 审批 TTL（15 分钟）。到点自动 deny 并把 Attempt 判为 blocked |

### 4.3 下载与发布

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LEGION_RELEASES_DIR` | *(空)* | 发布目录（含 `feeds/` 与 `releases/`）。留空 = 不托管，`/legion/*` 落 404 |
| `LEGION_DOWNLOAD_URL` | *(空)* | 门口页的下载地址。**显式配置优先**；没配就从 `RELEASES_DIR` 里现找最新那份安装包 |
| `LEGION_DESKTOP_VERSION` | *(空)* | 只用于门口页展示版本号 |

### 4.4 `LEGION_REGISTRATION` 的三种取值

| 值 | 谁能进来 | 后果 |
| --- | --- | --- |
| `closed`（**默认**） | 只有拿到邀请码的人 | 手机上不出现「注册新账号」 |
| `invite` | 自助注册，但必须填邀请码 | 出现注册入口 + 邀请码输入框 |
| `open` | 任何人 | **公网部署请三思**：配合 `REGISTRATION_MAX` 限速 |

> 默认 `closed` 是刻意的：一个默认开放的注册端点，与一个"忘了设策略"的部署，
> 在出事那天是同一个东西——只是没人会去查一个一直好好的开关。

### 4.5 对话与附件

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHAT_ATTACH_MAX_BYTES` | `10485760` | 单附件上限（10 MB） |
| `CHAT_ATTACH_MAX_PER_MSG` | `3` | 每条消息附件数 |
| `CHAT_ATTACH_BLACKLIST_EXT` | 见 `config-schema.mjs` | 附件扩展名黑名单（逗号分隔） |
| `CHAT_ATTACH_STAGED_TTL_MS` | `86400000` | staged 孤儿清理阈值 |
| `CHAT_ATTACH_TTL_MS` | `604800000` | 已发送附件过期清理（7 天） |
| `CHAT_REPLY_TIMEOUT_MS` | `120000` | AI 回复等待超时 |
| `MAX_RULES_LEN` | `3000` | 规范文本长度上限 |

### 4.6 本机组件互指

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LEGION_HUB_URL` | `http://127.0.0.1:8787` | 本机 worker / 服务插件去找 Hub 的地址。**只有本机组件读它** |
| `LEGION_TOKENIZER_DIR` | *(空)* | 精确 tokenizer 词表目录。留空 = 用保守估算器（**不是错误**） |

### 4.7 备份与异地

备份那两个单元各有自己的 env（见 [BACKUP.md](BACKUP.md)）：

| 文件 | 变量 | 说明 |
| --- | --- | --- |
| `/etc/legion-hub/offsite.env` | `LEGION_OFFSITE_REMOTE` | rclone 远端，形如 `remote:path` |
| 同上 | `LEGION_OFFSITE_KEEP` | 远端保留份数（默认 3） |

口令文件 `/var/lib/legion-hub/backup.passphrase` **绝不上传**——`offsite.mjs`
会在它落在上传目录里时拒绝执行。

---

## 五、密钥轮换的后果（换之前先读）

| 换掉 | 会发生什么 |
| --- | --- |
| `TEAM_HUB_TOKEN` | 本机组件与脚本要用新值；**用户的登录不受影响**（那是另一套） |
| `LEGION_IDENTITY_KEY` | ★ **全部用户会话 + 全部设备令牌立即失效**。所有人都要重新登录，每台电脑都要重新配对。换之前先让用户知道 |
| SQLite 库 | 用户的**口令哈希**在里面。库还在 = 口令照旧 |

> 换 `IDENTITY_KEY` 不是"重启一下"，它是**把所有人踢下线**。
> 这条在 `bootstrap-hub.sh` 里也写着——那一行是防手滑的。

---

## 六、常见配错

| 症状 | 多半是 |
| --- | --- |
| `/api/identity/*` 全 404 | `LEGION_IDENTITY_KEY` 空或 < 16 字符 |
| 不带令牌能读业务数据 | 忘了 `LEGION_REMOTE_AUTH=1` |
| 手机页面打开了，但登录后什么都看不到 | 这台 Hub 还没装空间/编队（README 的「④′ 两步必须做」） |
| 手机上不出现「注册新账号」 | `LEGION_REGISTRATION` 还是默认的 `closed` |
| 门口页写「电脑版尚未发布」 | 没配 `LEGION_DOWNLOAD_URL`，且 `LEGION_RELEASES_DIR` 里没有安装包 |
| 门口页下载按钮 404 | `LEGION_RELEASES_DIR` 指对了，但目录里没有 `releases/<id>/Legion-Setup-win-x64.exe` |
| 启动直接抛「TEAM_HUB_TOKEN 必须配置」 | `TEAM_HUB_HOST` 不是回环却没给机器令牌 |
| 隧道通了但公网 502 | 隧道面板里的目标端口与 `TEAM_HUB_PORT` 不一致（README 有这条排障实录） |

---

## 七、不属于这台服务器的配置

- **电脑（Node）侧**：配对码、设备令牌、工作区绑定——都在桌面端的设置里，
  由「连接与令牌 → 执行设备」生成（见 [README](README.md) 的「⑤ 电脑配对」）。
- **手机侧**：没有配置，打开门口页给的地址即可。
- **安装包签名**：见 [desktop/SIGNING.md](../../desktop/SIGNING.md)。
