<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（commit `22ae3a25`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/DEPLOY.md](../../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T204-evidence —— T-204（方案搜索）的复现证据

本目录是 T-204 在【方案搜索】阶段的**只读**证据：枚举「软件流水线空间里还没换上头像的 Agent」，
并实测「哪些令牌真的会换脸、哪些看起来会、其实不会」。

## 怎么跑

```
node docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs
```

- 需要 Node >= 22（用内置 node:sqlite；本仓实测 Node v24.19.0）。
- **只读**：DatabaseSync readOnly: true；不联网、不写库、不调任何 HTTP 接口。
- 输出与 probe-output.txt 逐行一致（后者是该脚本在本机的一次真实输出，供无 Node 环境时核对）。

## 它测出什么（结论已写进 RESEARCH.md）

| # | 事实 | 在 RESEARCH.md 的位置 |
| --- | --- | --- |
| 1 | software 空间 /api/roster 会返回 4 条「外部执行者」条目（soldier-a / soldier-b / general / soldier-auto），其 avatar 由 team-hub/routes/team-views.mjs:119 硬编码为 '⚙️' | §2.1 |
| 2 | 全库 roster 24 行、0 行非法令牌 ⇒ 缺口 100% 落在这类条目（另有一条同类：ozon/soldier-market） | §2.1 |
| 3 | 图片资产 20 个 key **全部在用**（20/20）⇒ 「再给几个身份各配一张不重复的照片」在现资产下不可能 | §2.4 |
| 4 | 位面表 40 个 key 的特征签名两两不同；其中 **s11..s15 空闲**（可达 100% 未占用） | §2.4 |
| 5 | renderAvatar('human:general') 与 renderAvatar('') **完全相同** ⇒ 「合法令牌但未登记 key」在界面上等于什么都没做 | §2.2 |
| 6 | renderAvatar('human:s11') 与占位人形**不同** ⇒ 空闲位面真的会换脸 | §2.2 |

## 边界

- 这是**证据**不是实现：本目录不含任何产品代码变更。
- 脚本读的是运行时库 D:/project/DSH/legion/team-hub/team.db（只读）。库会随时间变化，
  输出里的库 mtime 与条目清单只代表采样时刻；复跑脚本即可得到当时的真实值。
