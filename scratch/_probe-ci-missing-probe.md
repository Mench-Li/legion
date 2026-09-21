# 实测记录：CI 的 `doc` 阶段在"探针文件缺失"时会怎样

日期：2026-09-21　执行：本会话

## 起因

给 `run-ci.mjs` 的 `doc` 阶段加了阶段 3 闸门读数之后，我在注释里写下这样一句：

> 判「读不到」（退出码 2）是一件要人看的事……两种情况都**如实打进 detail**。

写完这句我意识到：**我并没有真的试过让它读不到**。于是把探针文件改名跑一次。

## 做法

```powershell
Move-Item scripts/prt/hot-file-churn.mjs scripts/prt/hot-file-churn.mjs.off
node scripts/ci/run-ci.mjs --only doc
Move-Item scripts/prt/hot-file-churn.mjs.off scripts/prt/hot-file-churn.mjs   # 立刻还原
```

## 读数

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'D:\project\DSH\legion\scripts\prt\hot-file-churn.mjs'
  imported from D:\project\DSH\legion\scripts\ci\run-ci.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
Node.js v24.19.0
```

**进程在加载期就死了**，`doc` 阶段一个字都没打出来，`--only doc` 也拦不住。

## 结论：我注释里那句话是**错的**

`run-ci.mjs` 顶部有 `import { CHURN_EXIT } from '../prt/hot-file-churn.mjs'`，
所以探针文件缺失是 Node 的**模块解析失败**，发生在任何 `try`/分支之前。
退出码 2 覆盖的是"探针**跑起来之后**报告读不到"（非 git 仓库、HEAD 解不开），
**不覆盖**"探针文件不存在"。

> 一个"我写了分支，所以坏掉时会被记录下来"的印象，
> 与一个"坏掉时进程根本起不来"的事实，
> 在我没有真的去删一次文件的时候是同一个东西。

## 处置：保留行为，订正说法

这个行为**不改**——静态 import 换来的是"退出码常量不可能与探针漂开"，
而那正是破验 M6/M7 守着的东西。探针文件缺失属于"仓库坏了"，
让 CI 硬停比打一行告警更对。

已把这条边界写进 `scripts/ci/run-ci.mjs` 那段注释（★ 实测后订正那一条），
免得下一个人把退出码 2 当成"覆盖了探针缺失"。

## 残留检查

```
=== restored: True ===
```

改名当场还原；`hot-file-churn.mjs` 与快照逐字节相同（已核）。
