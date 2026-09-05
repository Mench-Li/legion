# T-094 证据 —— 【切片 S2 修复·第1轮】TC-S2-06 / TC-S2-10（serve.mjs 浏览器后端）

修复任务回炉（T-080 失败切片第 1 轮）。根因修复 + 真实命令回归，未改任何测试预期掩盖失败。

## 根因
- TC-S2-06（P0，5xx body stall 误归类 http_500）：serve.mjs 5xx 分支
  `readBodyLimited(...).catch(() => Buffer.alloc(0))` 把 abort/body-stall 抛出的 WEB_ERR.TIMEOUT 吞成空 Buffer，
  回落为 `{code:'http_500'}` envelope + http_500 审计行（R-A4 的「2xx stall→timeout」未覆盖 5xx 错误体读取路径）。
- TC-S2-10（P1，参数级 invalid_url 落审计行）：handleWebApi 对每次 POST 无条件 appendWebAudit；
  webFetch 参数级 INVALID_URL（url 缺失/非字符串/空白/无法解析）也被留痕——违反「未发起实际抓取不产生审计行」判据。

## 修复（仅 workbench/scripts/serve.mjs + web.test.mjs，属本切片文件域）
1. 新增 `readBodyBestEffort()`：body「尽力读」只放行非中止性读失败降级为空 Buffer，
   abort/body-stall 的 TIMEOUT（e.code===WEB_ERR.TIMEOUT）继续上抛 → 5xx（`status>=400` 错误体读取）与
   非文本降级（readBodyLimited(res,0)）两条 catch 路径都改走它；2xx 成功正文读取本就走 `readBodyLimited` 直抛，语义不变。
2. webFetch 参数级失败抛错时打 `e.paramLevel=true`（url 缺失/非字符串/空白 与 URL 无法解析两处 INVALID_URL）；
   handleWebApi catch 到 paramLevel → 直接回 200-envelope `{ok:false,code:invalid_url}` 且**不 appendWebAudit**。
   ssrf_blocked/protocol_blocked/redirect 等「发起后的拦截」仍留痕（TC-S2-02 语义，不回归）。
3. 同步更新 serve.mjs 顶部 API 文档注释；web.test.mjs 增加夹具 /stall5xx + TC-S2-06/10 回归用例 3 个。

## 验证（真实命令，均本机执行）
| 文件 | 命令 | 结果 |
|---|---|---|
| 01-repro-prefix-inproc.txt | 修复前 `node docs/T094-evidence/l1-s2-regress.mjs inproc` | P1 code=http_500(期望 timeout) FAIL×2；P2 审计+2 行(期望 0) FAIL×1（复现） |
| 03-suite-web.txt | `node workbench/scripts/web.test.mjs` | tests 24 / pass 24 / fail 0（含新增 TC-S2-06、TC-S2-10×2） |
| 04-suite-filesapi.txt | `node workbench/scripts/files-api.test.mjs` | tests 40 / pass 40 / fail 0（serve.mjs 读面未回归） |
| 05-probe-inproc.txt | `node docs/T094-evidence/l1-s2-regress.mjs inproc` | P1 code=timeout、审计 code=timeout status=500；P2 审计+0；CTRL /ok 留痕 PASS，failures=0 exit=0 |
| 06-realclient.txt | 真实进程：`node workbench/scripts/serve.mjs --port 56123`（env DSH_WEB_FETCH_ALLOW_PRIVATE=1 + DSH_WEB_AUDIT_FILE）+ `l1-s2-regress.mjs client` | 同上全 PASS，failures=0 exit=0 |
| 07-serve-real.log | 同上真实 serve.mjs 控制台 | 仅 2 行 web-audit：stall5xx(code=timeout,status=500) + /ok(code=ok)；P2 两次 invalid_url POST 零审计行 |
| tmp-audit/l1-s2-real.jsonl | 真实进程落盘审计 | 同上 2 行（时间戳/url/finalUrl/status/ms 齐） |

## 验收对照
- 复现并定位根因：01-repro-prefix-inproc.txt（P1/P2 双失败复现，输出与 T-080 报告一致）
- 修复根因：serve.mjs diff（见任务卡片），未改测试预期；web.test.mjs 新增的是「回归用例」，断言即验收标准原文语义
- 真实命令回归：复现(01) → 修复 → 复测(03/04/05/06/07) 全绿，命令与输出要点见上表与各 txt

## 边界说明
- 仅改 serve.mjs 与 web.test.mjs（T-076:S2 文件域）+ 新增 docs/T094-evidence/* 证据文件；未触碰其他域代码。
- 未改 /api/web/fetch 的 H-1「200-envelope」现状语义（参数错误仍回 HTTP 200 + ok:false envelope，TC-S2-10 文档亦如此描述）。
