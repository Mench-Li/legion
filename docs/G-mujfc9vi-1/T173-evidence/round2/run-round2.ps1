# T-173 round2 证据采集（在 main@3f1fce2e 的干净提取树 .ci-main 上执行；普通终端可原样复跑）
$ws = 'D:/project/DSH/legion/.legion-worktrees/T-173'
$dst = "$ws/.ci-main"
$ev = "$ws/docs/G-mujfc9vi-1/T173-evidence/round2"
$shim = "$ws/docs/G-mujfc9vi-1/T173-evidence/sandbox-pipe-shim.cjs"
$env:GIT_DIR = "D:/project/DSH/legion/.git"; $env:GIT_WORK_TREE = $dst; $env:GIT_INDEX_FILE = "$ws/.ci-main-index"
$env:NODE_OPTIONS = "--require $shim"
Set-Location $dst

$o = New-Object System.Collections.Generic.List[string]
function Cap($title, $sb) {
  $script:o.Add(""); $script:o.Add("===== $title =====")
  foreach ($l in $sb) { $script:o.Add($l) }
}

# 1) config scan --check（干净 3f1fce2e）
$scan = & node scripts/config/scan.mjs --check 2>&1
Cap "node scripts/config/scan.mjs --check   [root=$dst githead=$(git rev-parse --short HEAD)] exit=$LASTEXITCODE" $scan

# 2) 其余 env 子检查
$sync = & node scripts/config/sync.mjs --check 2>&1
Cap "node scripts/config/sync.mjs --check exit=$LASTEXITCODE" $sync
$fx = & node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict --quiet 2>&1
Cap "node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict --quiet exit=$LASTEXITCODE" $fx

# 3) boundary
$b = & node scripts/ci/dsh-boundary.mjs 2>&1
Cap "node scripts/ci/dsh-boundary.mjs exit=$LASTEXITCODE" $b
$bp = & node scripts/ci/dsh-pin-drift.mjs 2>&1
Cap "node scripts/ci/dsh-pin-drift.mjs exit=$LASTEXITCODE" $bp

# 4) build：whiteboard + workbench tsc（paths 映射替代 tsconfig）
$wb = & node whiteboard/scripts/build.mjs 2>&1
Cap "node whiteboard/scripts/build.mjs exit=$LASTEXITCODE" $wb
Set-Location "$dst/workbench"
$tsc = & node "D:/project/DSH/legion/workbench/node_modules/typescript/bin/tsc" -p "$ev/tsconfig.workbench-main.json" --noEmit 2>&1
Cap "node <main>/workbench/node_modules/typescript/bin/tsc -p ../../docs/G-mujfc9vi-1/T173-evidence/round2/tsconfig.workbench-main.json --noEmit exit=$LASTEXITCODE （0 行输出=0 诊断）" $tsc
Set-Location $dst

$o | Set-Content -Path "$ev/03-gates-build.txt" -Encoding utf8
Write-Output "wrote 03-gates-build.txt"

# 5) 交付配置自检（delivery.json 是否被它自己服务的校验器接受）
$dv = & node "$ev/probe-delivery.mjs" $dst 2>&1
$dv | Set-Content -Path "$ev/04-delivery-config.txt" -Encoding utf8
Write-Output "--- 04-delivery-config.txt ---"
$dv

# 6) 主工作树（脏树）对照：scan
Remove-Item Env:GIT_DIR -ErrorAction SilentlyContinue; Remove-Item Env:GIT_WORK_TREE -ErrorAction SilentlyContinue; Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
Set-Location "D:/project/DSH/legion"
$ms = & node scripts/config/scan.mjs --check 2>&1
$hdr = @("main 工作树（脏树，另一会话在制品）：node scripts/config/scan.mjs --check exit=$LASTEXITCODE", "指纹：$(git status --porcelain | Measure-Object -Line | Select-Object -ExpandProperty Lines) 项 status 条目；head=$(git rev-parse --short HEAD)")
($hdr + $ms) | Set-Content -Path "$ev/05-scan-mainworktree.txt" -Encoding utf8
Write-Output "--- 05 main worktree scan tail ---"
$ms | Select-String -Pattern "scan:|未声明|未处理" | Select-Object -First 4