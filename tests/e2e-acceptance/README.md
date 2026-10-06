# e2e-acceptance —— 端到端验收演示（T-004）

本目录是任务 **T-004**「端到端验收：请写一个 greet 函数并跑一次测试」的交付物，
用于验证「手机下发任务 → Hub 派工 → 电脑 Node 执行 → 产出与证据回传」这条链路。

## 契约

| 输入 | 输出 |
| --- | --- |
| `greet('Ada')` | `Hello, Ada!` |

契约与仓库既有 greet 验收夹具一致（`tests/p13-fixture/real-codex-implementation-rework.mjs`）：
名字按**逐字**拼接、不加额外标点。

## 运行

```powershell
# 语法检查（Node 解析器，不执行代码）
node --check tests/e2e-acceptance/greet.mjs
node --check tests/e2e-acceptance/greet.test.mjs

# 用例：普通终端
node --test tests/e2e-acceptance/greet.test.mjs

# 用例：DSH 受限沙箱内（默认测试运行器要 fork 子进程，管道被沙箱拒绝 => spawn EPERM；
# --test-isolation=none 让运行器在**当前进程**里跑，无子进程，因此可直跑）
node --test --test-isolation=none tests/e2e-acceptance/greet.test.mjs
```

预期：5 个用例全部通过，`pass 5 / fail 0`、退出码 0。

> 沙箱说明沿用 `scripts/ci/run-ci.mjs` 文件头的既有结论：pwsh/受限 shell 拦截子进程管道捕获
> （`spawn EPERM`），这**不是用例失败**；单进程 `--test-isolation=none` 或普通终端均可直跑。

## 边界

- 纯计算、零第三方依赖、无网络与文件 I/O。
- 仅测试与演示，不改变 Legion 平台任何用户可见行为（因此无需 docSync 到 `docs/FEATURES.md`）。
