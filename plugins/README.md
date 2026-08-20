# @dsh-external/dsh-scrum-worker

军团士兵轮询守护：定时扫看板，认领 todo、读上下文派工、提交 in_review；退回纠错；blocked 解阻续做

由 dsh-super-injector dev_scaffold_plugin 生成。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```
