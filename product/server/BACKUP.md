# Legion Hub 备份与恢复

## 每天自动备份（systemd timer）

```bash
# 服务器上
# ★ `-o/-g` 不能省：备份以非 root 用户（systemd unit 里是 legion-hub）运行，
#   目录属于 root 时它会以 SQLite 的 "unable to open database" 失败——
#   那句话读起来像"库坏了"，真实原因是权限。
install -d -m 0700 -o legion-hub -g legion-hub /var/lib/legion-hub/backups
# ★ 口令放在**数据目录**里，不放 /etc/legion-hub/。
#   原因实测过：/etc/legion-hub 是 0700 root，而备份以 legion-hub 运行——
#   它连 stat 都做不到，脚本会报"口令文件不存在"，而人会去找一个其实存在的文件
#   （`existsSync` 把 EACCES 吞成了 false）。
#   数据目录本来就是 0700 legion-hub，口令放这里既够隐蔽也够得着。
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40 > /var/lib/legion-hub/backup.passphrase
chmod 600 /var/lib/legion-hub/backup.passphrase
chown legion-hub:legion-hub /var/lib/legion-hub/backup.passphrase

cp /srv/legion-hub/app/product/server/legion-hub-backup.service /etc/systemd/system/
cp /srv/legion-hub/app/product/server/legion-hub-backup.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now legion-hub-backup.timer
systemctl start legion-hub-backup.service   # 立刻验一次，别等明天
systemctl list-timers legion-hub-backup.timer
```

## 为什么**不能**直接 `cp team.db`

实测这台服务器的读数：主库 **1.1 MB**、`team.db-wal` **4.2 MB**。
也就是说**大部分最近写入还在 WAL 里**。只拷主库会得到一个
「能打开、少数据」的备份——它不报错，等你去恢复的那一刻才发现最近的任务、
消息、进展都没了。

> 一个"拷完不报错"的备份，与一个"真的完整"的备份，
> 在只看文件大小的时候是同一个东西。

所以用 SQLite 自己的 `VACUUM INTO`：它把**包括 WAL 在内**的一致快照写成
一个单独文件（没有 WAL、没有 shm），而且可以在库正被写的时候跑。

## 为什么备份写完要立刻读回来

写出来但读不回去的备份，与没有备份，在出事那天是同一个东西。
`backup.mjs` 每次都做：`PRAGMA integrity_check` + 12 张关键表是否存在 + 行数。
不通过就把文件删掉并**返回非零**（让 systemd 记一次失败），而不是留下一个
看起来像备份的东西。

## 恢复演练

```bash
bash /srv/legion-hub/app/product/server/restore-drill.sh
# 或不给参数：自动挑最近一份
bash /srv/legion-hub/app/product/server/restore-drill.sh <备份文件> /etc/legion-hub/backup.passphrase
```

它刻意在**另一个目录**恢复，并用**真实 `server.mjs`** 起一次 Hub 去读它——
"文件能打开"不是"恢复"的定义。它还断言**关联**没断
（会话绑定 / 消息不得指向不存在的会话）。演练目录结束即清理：
演练不该留下第二份生产数据。

实测通过（2026-10-05）：解密 → 1.2 MB → 18 任务 / 15 尝试 / 40 运行事件 /
8 上下文快照 / 179 审计 / 1 用户 / 1 设备；断链 0 条；真实 Hub 起来后读得到
`T-001` 的验收标准。

## 口令保管的边界（必须如实说）

口令文件默认与备份在**同一台机器**上。脚本会在两者同目录时**明确警告**：
这挡的是"备份文件本身外泄"，**挡不住"主机被攻陷"**。

真正的异地保护要求把口令存到**别处**（密码管理器、另一台机器）并单独保管。
在做到那一步之前，异地的那份备份与这里的是同一个信任级别。

## 异地存放（rclone）

备份目录 `/var/lib/legion-hub/backups` 仍在同一块盘上——**盘坏了一起没**。
所以另有一层：`offsite.mjs` 把最新几份加密备份同步到 rclone 远端。

### 配置

```bash
# 1) 在 legion-hub 用户下配远端（★ 用 root 的身份跑 rclone config 会把配置写进
#    /root/.config，而服务单元以 legion-hub 跑、还带 ProtectHome=true，读不到）
install -d -m 0700 -o legion-hub -g legion-hub /var/lib/legion-hub
sudo -u legion-hub RCLONE_CONFIG=/var/lib/legion-hub/rclone.conf \
  rclone config create legion-offsite sftp host=<你的备份机> user=<用户> key_file=<私钥>
sudo -u legion-hub RCLONE_CONFIG=/var/lib/legion-hub/rclone.conf rclone lsd legion-offsite:

# 2) 告诉服务单元用哪个远端
install -d -m 0700 -o legion-hub -g legion-hub /etc/legion-hub
cat > /etc/legion-hub/offsite.env <<'EOF'
LEGION_OFFSITE_REMOTE=legion-offsite:legion-hub
LEGION_OFFSITE_KEEP=3
EOF
chmod 600 /etc/legion-hub/offsite.env && chown legion-hub:legion-hub /etc/legion-hub/offsite.env

# 3) 先手动跑一次（别等明天）
sudo -u legion-hub RCLONE_CONFIG=/var/lib/legion-hub/rclone.conf \
  node /srv/legion-hub/app/product/server/offsite.mjs \
    --dir /var/lib/legion-hub/backups \
    --remote legion-offsite:legion-hub \
    --passphrase-file /var/lib/legion-hub/backup.passphrase \
    --keep 3

# 4) 装定时器
cp /srv/legion-hub/app/product/server/legion-hub-offsite.service /etc/systemd/system/
cp /srv/legion-hub/app/product/server/legion-hub-offsite.timer   /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now legion-hub-offsite.timer
```

### 为什么每次都要**拉回来验一遍**

`rclone copy` 退出码 0、远端列表里有那个文件、大小也对得上——这些**都不代表**能恢复。
所以 `offsite.mjs` 每轮都做完整条恢复链：**拉回来 → 比 sha256 → gpg 解密 →
用真实 SQLite 打开 → `integrity_check` + 12 张关键表核对**。

> 一个"上传成功但取不回来"的异地备份，与没有异地备份，在出事那天是同一个东西——
> 而它的表现与成功一模一样，所以**只有真去读一次**才能分辨。

下载一份 1.2 MB 的代价，换的是"异地那份真的能恢复"这句话有依据。

### 三条不许越过的线（脚本会**拒绝执行**，不是靠文档提醒）

| 线 | 为什么 |
| --- | --- |
| 只传 `team-*.db.gpg`（白名单），**不**做目录同步 | `rclone sync` 会把同目录里任何东西一起带走，包括将来某天有人放进来的明文库或凭据文件 |
| 口令文件在 `--dir` 里 → 拒绝 | 传了口令，异地的加密就等于没有加密——**而它看起来仍然是个 `.gpg` 文件**，不会自己暴露 |
| `--remote` 必须是 `remote:path` | 本机路径不是异地。盘坏了一起没，而它会看起来像已经做了异地。真要本地路径（演练）必须显式 `--allow-local` |

另外两条判据：**最新那一份是明文**就拒绝（说明今天的备份没加密；旧明文不受影响，
否则开启加密之前的遗留会**永久**挡住异地备份）；**最新那一份超过 26 小时**
就拒绝（备份单元失败后同步会把旧文件传过去并报成功，于是异地多一份"看起来是
今天的"备份）。

### 在**目标环境**演练，而不是在源环境

```bash
# 从远端取最新一份，走同一条恢复链（解密 → 打开 → 真实 server.mjs 起来读）
bash /srv/legion-hub/app/product/server/restore-drill.sh --from-remote legion-offsite:legion-hub
```

本地那份能恢复**不代表**远端那份也能——它们之间差着上传、差着远端的存储语义。
`--from-remote` 就是用来把那句话证伪的。

### 仍要如实说的边界

口令文件仍在**服务器本机**（`/var/lib/legion-hub/backup.passphrase`），它**不**上传。
所以异地那份的加密挡的是"远端存储被单独攻陷"，**挡不住"服务器本身被攻陷"**——
那时攻击者同时拿到库和口令。要真正跨过这条线，口令必须存在**别处**
（密码管理器、另一台机器），并且恢复流程要从那里取。

`rclone.conf` 同样在数据目录里（含远端凭据），边界与口令相同。
