# BUG-038：DeepSeek V4 子代理启动被未声明的 effort 拒绝

## 现象

T-212 的 DSH 原生 `spawn` 已成功创建子会话，但会话立即以 `UNSUPPORTED_REASONING_EFFORT` 退出，模型没有收到请求，token 计数为 0。

## 根因

T-212 冻结的通用模型档案值为 `reasoningEffort=medium`。第一次兼容修复将它改写为 `low`，但桌面 DSH 当前 provider 模型目录没有为 `fjd-ds/deepseek-v4-flash-openai` 声明 reasoning effort；因此 `low` 同样被拒绝。不能从其他 DeepSeek 接口或版本推断该路由的可用档位。

## 修复

对 DSH 模型目录未声明 effort 的 DeepSeek V4 路由，省略 `agentOptions.reasoningEffort`，让 DSH 采用该模型自己的默认值。派工活动明确记录该兼容处理，不更改任务中的冻结模型快照。

## 验证

- `node --test runtime/contracts/agent-model-selection.test.mjs`：4/4 通过；新增判据确认 `medium` 不再被替换成未经目录声明的 `low`，而是省略。
- `node scripts/ci/build-external-package.mjs plugins`：通过。
- 需要将本修复合入 `main`、重建 DSH 实际加载的 Legion provider bundle、重启 DSH，再观察 T-212 子会话是否有非零模型调用记录。
