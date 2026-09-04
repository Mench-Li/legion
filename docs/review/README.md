# 审查报告归档（per-task）

每个审查任务（reviewer）独立产出一份审查报告，文件名带任务 ID，**避免并行审查互相覆盖同一文件造成合入冲突**：

- `T-054-REVIEW.md` — T-054（reviewer，S3 审查）
- `T-055-REVIEW.md` — T-055（reviewer，S1 审查）

## 约定（审查 worker 提示词见 `roles.json` reviewer 岗位）

- 审查报告写到 **`docs/review/<任务ID>-REVIEW.md`**（任务 ID 形如 `T-0xx`，见任务标题/上下文）；
- 历史遗留的公共文件 `docs/REVIEW.md` 已按此约定归档拆分（其内容 = T-054 报告），不再使用公共路径；
- 其余岗位的公共产物（如 `docs/DEPLOY.md`、`docs/REQUIREMENTS.md`）若需并行，同样建议按任务分文件或串行化。
