# T-173 round2 证据：逐文件直跑 L0 套件（run-ci test 阶段在本会话沙箱因 symlink EPERM 不可用）
$ws = 'D:/project/DSH/legion/.legion-worktrees/T-173'
$dst = "$ws/.ci-main"
$out = "$ws/docs/G-mujfc9vi-1/T173-evidence/round2/02-suites.txt"
$env:GIT_DIR = 'D:/project/DSH/legion/.git'
$env:GIT_WORK_TREE = $dst
$env:GIT_INDEX_FILE = "$ws/.ci-main-index"
$env:NODE_OPTIONS = "--require $ws/docs/G-mujfc9vi-1/T173-evidence/sandbox-pipe-shim.cjs"
Set-Location $dst

$suites = @(
  'packages/shared/test/path-domain.test.mjs',
  'packages/shared/test/repo-identity.test.mjs',
  'team-hub/write-intent-store.test.mjs',
  'team-hub/claim-policy.test.mjs',
  'team-hub/git-plumbing.test.mjs',
  'team-hub/delivery-store.test.mjs',
  'team-hub/integration-worker.test.mjs',
  'team-hub/integration-runner.test.mjs',
  'team-hub/write-intent-routes.test.mjs',
  'team-hub/delivery-routes.test.mjs',
  'team-hub/metrics.test.mjs',
  'plugins/tests/write-eligibility.test.mjs',
  'plugins/tests/legacy-convergence.test.mjs',
  'workbench/scripts/delivery-ui.test.mjs',
  'scripts/config/config.test.mjs',
  'team-hub/run-store.test.mjs',
  'team-hub/schema-util.test.mjs',
  'team-hub/members-routes.test.mjs',
  'team-hub/create-routes.test.mjs',
  'team-hub/chat.test.mjs',
  'team-hub/task-lifecycle-routes.test.mjs'
)

$lines = New-Object System.Collections.Generic.List[string]
$totalPass = 0; $totalFail = 0; $suitesOk = 0; $suitesBad = 0
foreach ($s in $suites) {
  $raw = & node $s 2>&1
  $code = $LASTEXITCODE
  $text = ($raw | Out-String)
  $pass = 0; $fail = 0
  foreach ($m in [regex]::Matches($text, "# pass (\d+)")) { $pass += [int]$m.Groups[1].Value }
  foreach ($m in [regex]::Matches($text, "# fail (\d+)")) { $fail += [int]$m.Groups[1].Value }
  $totalPass += $pass; $totalFail += $fail
  if ($code -eq 0 -and $fail -eq 0) { $suitesOk++ } else { $suitesBad++ }
  $lines.Add(('{0,-52} exit={1,-3} pass={2,-4} fail={3}' -f $s, $code, $pass, $fail))
  if ($code -ne 0) { $lines.Add("  ---- tail ----"); foreach ($t in ($text.Trim().Split([char]10) | Select-Object -Last 12)) { $lines.Add("  " + $t.TrimEnd()) } }
}
$lines.Add("")
$lines.Add("合计：套件 $($suites.Count) 个（绿 $suitesOk / 红 $suitesBad）；pass=$totalPass fail=$totalFail")
$lines.Add("root=$dst githead=$(git rev-parse --short HEAD) node=$((node --version))")
$lines | Set-Content -Path $out -Encoding utf8
Write-Output ($lines -join [char]10)