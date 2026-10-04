# run-suites.ps1 — 直接跑 L0 套件（T-173 部署阶段证据，见 DEPLOY.md §7）
# 说明：run-ci test 阶段的 team-hub 外部包构建需要 junction/符号链接，被沙箱拦（EPERM），
# 故本轮改为**逐文件直跑**（每文件独立 Node 进程，与 `node --test <单文件>` 的隔离语义一致），
# 并用 sandbox-pipe-shim.cjs 让套件里 spawn/spawnSync 的子进程仍能被捕获。
# 输出统一 UTF-8 无 BOM（[IO.File]::AppendAllText），避免 PS 5.1 默认编码把证据写成非 UTF-8。
$ErrorActionPreference = 'Continue'
$shim = (Resolve-Path (Join-Path $PSScriptRoot 'sandbox-pipe-shim.cjs')).Path
$env:NODE_OPTIONS = "--require $shim"
$log = Join-Path $PSScriptRoot '02-suites.txt'
if (Test-Path $log) { Remove-Item $log -Force }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Log([string]$text) { [System.IO.File]::AppendAllText($log, $text + "`r`n", $utf8) }
$suites = @(
  @('node','packages/shared/test/path-domain.test.mjs'),
  @('node','packages/shared/test/repo-identity.test.mjs'),
  @('node','team-hub/write-intent-store.test.mjs'),
  @('node','team-hub/claim-policy.test.mjs'),
  @('node','team-hub/git-plumbing.test.mjs'),
  @('node','team-hub/delivery-store.test.mjs'),
  @('node','team-hub/integration-worker.test.mjs'),
  @('node','team-hub/write-intent-routes.test.mjs'),
  @('node','team-hub/delivery-routes.test.mjs'),
  @('node','team-hub/metrics.test.mjs'),
  @('node','--experimental-strip-types','plugins/tests/write-eligibility.test.mjs'),
  @('node','--experimental-strip-types','plugins/tests/legacy-convergence.test.mjs'),
  @('node','--experimental-strip-types','workbench/scripts/delivery-ui.test.mjs'),
  @('node','team-hub/run-store.test.mjs'),
  @('node','team-hub/schema-util.test.mjs'),
  @('node','team-hub/members-routes.test.mjs'),
  @('node','team-hub/create-routes.test.mjs'),
  @('node','team-hub/chat.test.mjs'),
  @('node','team-hub/task-lifecycle-routes.test.mjs')
)
foreach ($c in $suites) {
  $label = ($c -join ' ')
  $exe = $c[0]
  $rest = @()
  if ($c.Length -gt 1) { $rest = $c[1..($c.Length-1)] }
  $out = & $exe @rest 2>&1 | Out-String
  $code = $LASTEXITCODE
  Write-Log "===== `$ $label [exit=$code] ====="
  Write-Log $out
  Write-Output "$label -> exit=$code"
}
