# Legion Hub 备份与恢复

## 每天自动备份（systemd timer）

```bash
# 服务器上
# ★ `-o/-g` 不能省：备份以非 root 用户（systemd unit 里是 legion-hub）运行，
#   目录属于 root 时它会以 SQLite 的 "unable to open database" 失败——
#   那句话读起来像"库坏了"，真实原因是权限。
install -d -m 0700 -o legion-hub -g legion-hub /var/lib/legion-hub/backups
# ★ 口令文件同理要属于备份用户，否则 gpg 之前的可读性检查就会拒。
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40 > /etc/legion-hub/backup.passphrase
chmod 600 /etc/legion-hub/backup.passphrase
chown legion-hub:legion-hub /etc/legion-hub/backup.passphrase

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

## 异地存放

备份目录 `/var/lib/legion-hub/backups` 仍在同一块盘上——**盘坏了一起没**。
把这个目录同步到别处是运营者的事（`rclone` / `scp` / 对象存储），
本仓库不假定任何一种。至少每月做一次：把最新备份拷到别处，并**在那台机器上**
跑一次 `restore-drill.sh`（在目标环境验证，而不是在源环境）。
