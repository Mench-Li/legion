# T-093 部署与 CI/CD —— 证据目录

> 任务：T-093（devops，发布部署/目标级收尾）｜分支：w/T-093｜HEAD = **06480ba**（与 main 同步，全部交付切片已 promote 合入）
> 运行时：node v24.19.0（node:sqlite）｜pnpm 11.7.0（deps 复用 junction）
> 范围：只做构建/部署类操作；未发布生产（未获批准）；未改业务功能代码。

## 本目录内容

| 文件 | 内容 | 关键输出 |
| --- | --- | --- |
| ci-run-06480ba/ci-output.txt | 全量 CI 六阶段原始输出（完整，含 SUMMARY；= ci.log 副本，*.log 不入库故复制为 .txt） | env/deps/build/test/smoke/stage **全 PASS，exit 0** |
| ci-run-06480ba/summary.json | 六阶段机器可读汇总（failed=0） | env 76ms · deps 2ms · build 10173ms · test 13565ms · smoke 6690ms · stage 92ms |
| 01-chat.txt | L0 chat（对话中心契约） | 13/13 |
| 02-skills.txt | L0 skills（共享技能回归） | 12/12 |
| 03-calendar.txt | L0 calendar（日程日历契约） | 13/13 |
| 04-files-api.txt | L0 files-api（文件中心契约） | 40/40 |
| 05-web.txt | L0 web（浏览器助手契约） | 24/24 |
| 06-contracts.txt | L0 contracts（平台契约基线） | 56/56 |

whiteboard 67/67（7 测试文件：shared 26+8+7、server 7+6+7、e2e 6 真实服务）与全部 L1 冒烟
（chat-l1 22/22、chat-s2 9/9、files-s5 32/32、whiteboard 真实进程 /healthz+GET / 200、v1 /api/config auth=true）
见 ci-output.txt 内 [build]/[test]/[smoke] 段。发布物暂存（releases/legion-06480ba-2026-09-05/：dist + MANIFEST.json +
SHA256SUMS.txt）为 gitignore 运行时产物，不入库（见 [stage] 段）。

## 验证命令（可复跑）

```bash
# 全量发布门禁（本目录产物即以下命令输出）
node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run-06480ba
# 分套件（等价 L0）
node --test team-hub/chat.test.mjs team-hub/skills.test.mjs team-hub/calendar.test.mjs
node --test workbench/scripts/files-api.test.mjs workbench/scripts/web.test.mjs
node --test tests/contract/contracts.test.mjs
node --test whiteboard/packages/shared/test/*.test.mjs whiteboard/apps/server/test/*.test.mjs
# L1
node team-hub/chat-l1-smoke.mjs && node workbench/scripts/chat-s2-smoke.mjs && node workbench/scripts/files-s5-smoke.mjs
```

## 环境边界说明（R-18，如实记录）

- 本沙箱 pwsh 拦截「子进程 pipe 捕获」（spawn EPERM，R-18 先例），故 CI 经 run_code 宿主进程直跑
  （T-043 同法：命令与产物与普通终端一致，见 docs/DEPLOY.md §3.1）。tsc/vite/esbuild/node --test 在本宿主下全部正常。
- workbench/node_modules 为 junction → 主 checkout（复用既有安装，禁网零下载）；产物 dist/、releases/、.ci/、
  *.log 均为运行时产物（.gitignore）。
- L2 GUI 手工走查与 board-plugin/plugins 宿主注入冒烟本沙箱不可达 → 复现步骤见 docs/DEPLOY.md §5.3/§7.3，不冒充通过。
