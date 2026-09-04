# T-062 证据目录

本目录为 T-062（S4 upload / mkdir / rename / delete + token 鉴权 + confirm）测试执行的真实命令输出证据。

| 文件 | 内容 |
| --- | --- |
| 01-filesapi.txt | node files-api.test.mjs —— files-api 契约（S3 只读面 + S4 写面）34/34 通过（含 TC-S4-01..17） |
| 02-web.txt | node web.test.mjs —— S6 web-fetch 回归 12/12 通过 |
| 03-l1-smoke.txt | 独立 serve.mjs --port 4843 --token tk + curl：TC-S4-13 鉴权矩阵、S4 写契约、写路径逃逸抽样 |
| 04-f1-f2-probes.txt | 复现共享 serve.mjs 既有缺陷 F1（嵌套 .git 元数据外泄）/ F2（非法 % 路径崩溃进程） |

复现命令要点（详见各文件）：
- 契约：node workbench/scripts/files-api.test.mjs；node workbench/scripts/web.test.mjs
- L1：DSH_WORKBENCH_SPACES_JSON='[{"id":"fx","localDir":"<temp>",...}]'；node workbench/scripts/serve.mjs --port 4843 --host 127.0.0.1 --token tk
- F2：curl.exe "http://127.0.0.1:4843/api/files%zz" → 进程 exit 1（URIError: URI malformed @ serve.mjs:944）
- F1：curl.exe ".../api/files/read?scope=fx&path=subrepo/.git/config" → 200（应 403）
