# T-210 devops 部署/构建验证脚本（非产品代码）——把各门禁的真实输出落到 T210-evidence/
# 用法：pwsh -File docs/G-mv7kzgnu-1/T210-evidence/run-deploy-verify.ps1
$ErrorActionPreference = 'Continue'
$ev = Join-Path (Get-Location) 'docs/G-mv7kzgnu-1/T210-evidence'

# 1) 类型门禁
Push-Location workbench
$o = node node_modules/typescript/bin/tsc --noEmit 2>&1
$code = $LASTEXITCODE
Pop-Location
@("# workbench: node node_modules/typescript/bin/tsc --noEmit", "# EXIT=$code", "# stdout/stderr:") | Set-Content -Path (Join-Path $ev 'build-tsc.txt') -Encoding utf8
$o | Add-Content -Path (Join-Path $ev 'build-tsc.txt') -Encoding utf8
Write-Host "TSC EXIT=$code"

# 2) 前端构建（本沙箱预期 esbuild spawn EPERM）
Push-Location workbench
$v = node node_modules/vite/bin/vite.js build 2>&1
$vcode = $LASTEXITCODE
Pop-Location
@("# workbench: node node_modules/vite/bin/vite.js build", "# EXIT=$vcode", "# output:") | Set-Content -Path (Join-Path $ev 'build-vite.txt') -Encoding utf8
$v | Add-Content -Path (Join-Path $ev 'build-vite.txt') -Encoding utf8
Write-Host "VITE EXIT=$vcode"

# 3) 部署冒烟（只读 live 库快照 + 真 HTTP）
$d = node docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs --out docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.json 2>&1
$dcode = $LASTEXITCODE
Write-Host "SMOKE EXIT=$dcode"
$d | Select-Object -Last 40

# 4) 文档门禁
$c = node scripts/ci/check-docs.mjs 2>&1
$ccode = $LASTEXITCODE
@("# node scripts/ci/check-docs.mjs", "# EXIT=$ccode", "# output:") | Set-Content -Path (Join-Path $ev 'ci-check-docs.txt') -Encoding utf8
$c | Add-Content -Path (Join-Path $ev 'ci-check-docs.txt') -Encoding utf8
Write-Host "CHECKDOCS EXIT=$ccode"
$c | Select-Object -Last 8
