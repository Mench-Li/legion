# BUG-043：Codex 子代理只会说 `product-error`，把四个不同的真因说成同一句话

## 现象

T-249 / T-265 / T-273 / T-289 / T-297 五次 Codex 审查，全部在 15–18 秒内失败，诊断永远只有一句：

```
worker 未完成（error）；
provider 诊断：Product subagent failure (product: Codex; stage: turn; category: product-error)
```

同一句话背后，实际是四个完全不同的原因（我逐个剥了四层才拆开）：

| # | 真实原因 | 怎么发现的 |
| --- | --- | --- |
| 1 | 代理没起（7897 不通） | 手工 `Test-NetConnection` + 经代理请求 `api.openai.com` |
| 2 | profile 把模型钉成 `gpt-6.1-sol`，该账号不支持 | `codex exec` 直接返回 `400 model_not_found` |
| 3 | `permissionMode` 改错 → 节点上报的权限档与冻结工具 `codex-workspace-write` 不匹配 | 认领时报"未报告相符的 provider 能力/权限模式" |
| 4 | **adapter 自带 `@openai/codex@0.153.4`**，它不认识新模型 `gpt-6-luna` | `npm view` + 手工 app-server JSON-RPC 全流程对照 |

第 4 条才是最终真因：adapter（`@deepseek-ai/dsh-subagent-codex@0.2.1-rc.5`）依赖 `@openai/codex@0.153.4`，**不用全局 CLI**。用它起 `app-server` 时 `thread/start` 带 model 被服务端拒（400 `model_not_found`），adapter 把 `badRequest` 一律归成 `product-error`，原文被吞掉。

## 根因（两处，都在诊断信息上）

1. `codexErrorInfo` 的 `badRequest` / `threadRollbackFailed` / `other` 三种都映射成同一个 `category: "product-error"`，**不带原文、不带 http 状态**；
2. adapter 固定依赖一个旧版 `@openai/codex`，与账号可用模型脱节，而这一点在诊断里完全不可见。

> 一条"什么都可能是"的诊断，
> 与没有诊断，在排查时是同一个东西——区别只是前者让人以为自己在缩小范围。

## 修复

- **二进制对齐**（已落地）：profile `pnpm-workspace.yaml` 加
  ```yaml
  overrides:
    '@openai/codex': 0.162.1
  ```
  重装 bundle 后 adapter 用上 0.162.1（profile 内 `@openai/codex` = 0.162.1，adapter 不再有嵌套 0.153.4）。
- **模型对齐**（已落地）：profile `subagent-codex.config.model: gpt-6-luna`（账号实测可用），`~/.codex/config.toml` 与 `$CODEX_HOME/config.toml` 同步。
- **诊断**（未做，建议）：adapter 把 `badRequest` 的原始 `message`/`httpStatus` 带进诊断文本；`product-error` 只作为兜底分类。

## 验证

修复后连跑三轮真实审查，全部 `state=completed`：

| 任务 | 用时 | 结论 |
| --- | --- | --- |
| T-305 | 244s | 发现 2 项必须修改 |
| T-309 | 205s | 未通过（1 项 P2） |
| T-311 | 212s | **通过** |

## 遗留

- Codex 在审查环节是**只读沙箱**，写不了 `docs/review/<id>-REVIEW.md`，只能把结论写进 attempt 的 `summary`/`evidence`。于是审查环节会停在 `in_review` 等收口（本次靠人工 `in_review → done`）。要让审查环节自动流转，需要给 review 阶段一个可写的工作区，或允许"无文档但 findings 为空即通过"。
