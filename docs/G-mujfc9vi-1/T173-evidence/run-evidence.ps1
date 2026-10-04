# run-evidence.ps1 — 生成 T-173 证据文件（01-build / 03-gates / 04-gap-checks）
# 本脚本只在被同一沙箱限制的会话里跑；普通终端直接跑 run-ci.mjs 即可，不需要它。
$ErrorActionPreference = 'Continue'
$shim = (Resolve-Path (Join-Path $PSScriptRoot 'sandbox-pipe-shim.cjs')).Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
function W([string]$file, [string]$t) { [System.IO.File]::AppendAllText($file, $t + "`r`n", $utf8) }
$b = Join-Path $PSScriptRoot '01-build.txt'
$g = Join-Path $PSScriptRoot '03-gates.txt'
$c = Join-Path $PSScriptRoot '04-gap-checks.txt'
foreach ($f in @($b, $g, $c)) { if (Test-Path $f) { Remove-Item $f -Force } }
$tsc = 'D:\project\DSH\legion\workbench\node_modules\typescript\bin\tsc'
$esb = 'D:/project/DSH/legion/workbench/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'

# ============ 01-build.txt ============
W $b '# T-173 构建证据（devops）'
W $b ('# 环境：node ' + (node --version) + ' / ' + (git --version) + ' / root=' + (Get-Location).Path)
W $b ''
W $b '## 1) whiteboard build（零依赖 node 脚本）'
$o = & node whiteboard/scripts/build.mjs 2>&1 | Out-String
W $b ('$ node whiteboard/scripts/build.mjs   -> exit=' + $LASTEXITCODE)
W $b $o.TrimEnd()
W $b ''
W $b '## 2) workbench tsc --noEmit（= pnpm build 的第一半）'
W $b '# 本工作树无 node_modules 且沙箱禁 junction/符号链接，故用 tsconfig.workbench-typecheck.json'
W $b '# 把裸模块 paths 映射到主 checkout 的 .pnpm 真实目录（编译器选项与 workbench/tsconfig.json 一致）。'
$o = & node $tsc -p docs/G-mujfc9vi-1/T173-evidence/tsconfig.workbench-typecheck.json --noEmit 2>&1 | Out-String
$errs = @($o -split "`n" | Where-Object { $_ -match 'error TS' })
W $b ('$ node <main>/workbench/node_modules/typescript/bin/tsc -p docs/G-mujfc9vi-1/T173-evidence/tsconfig.workbench-typecheck.json --noEmit   -> exit=' + $LASTEXITCODE + '  diagnostics=' + $errs.Count)
if ($o.Trim().Length -gt 0) { W $b $o.TrimEnd() }
W $b ''
W $b '## 3) vite build 的前置 esbuild 服务（本会话沙箱不可用）'
$code = "const e=require('$esb');try{const r=e.transformSync('const x=1',{loader:'js'});console.log('esbuild OK bytes='+r.code.length)}catch(err){console.log('esbuild FAIL '+err.message.split(String.fromCharCode(10))[0])}"
W $b '# 3a) 原样（esbuild 以 stdio:pipe 启动长驻服务）'
$env:NODE_OPTIONS = ''
$o = & node -e $code 2>&1 | Out-String
W $b ('$ node -e "<esbuild.transformSync>"   -> ' + $o.Trim())
W $b '# 3b) 套 sandbox-pipe-shim（pipe -> 临时文件 fd；esbuild 需要双向 stdio，不适用）'
$env:NODE_OPTIONS = "--require $shim"
$o = & node -e $code 2>&1 | Out-String
W $b ('$ NODE_OPTIONS="--require sandbox-pipe-shim.cjs" node -e "<esbuild.transformSync>"   -> ' + $o.Trim())
W $b '=> 结论：vite build 依赖 esbuild 长驻服务的 stdio 管道，本会话沙箱下无法启动；构建证据到 tsc 为止。'

# ============ 03-gates.txt ============
W $g '# T-173 门禁证据（devops）'
W $g ('# 环境：node ' + (node --version) + ' / root=' + (Get-Location).Path)
W $g ''
W $g '## 1) 脚本语法门禁 ci-syntax.mjs（守 scripts/ 全部 .mjs）'
$o = & node scripts/ci/ci-syntax.mjs 2>&1 | Out-String
W $g ('$ node scripts/ci/ci-syntax.mjs   -> exit=' + $LASTEXITCODE)
W $g (($o -split "`n" | Select-Object -Last 3) -join "`r`n")
W $g ''
W $g '## 2) 编码门禁 encoding-check.mjs --quiet'
$o = & node scripts/ci/encoding-check.mjs --quiet 2>&1 | Out-String
W $g ('$ node scripts/ci/encoding-check.mjs --quiet   -> exit=' + $LASTEXITCODE)
W $g (($o -split "`n" | Select-Object -Last 2) -join "`r`n")
W $g ''
W $g '## 3) 配置读取点门禁 config/scan.mjs --check（env 阶段）'
$o = & node scripts/config/scan.mjs --check 2>&1 | Out-String
W $g ('$ node scripts/config/scan.mjs --check   -> exit=' + $LASTEXITCODE)
W $g (($o -split "`n" | Where-Object { $_ -match '✖ ' }) -join "`r`n")
W $g (($o -split "`n" | Select-Object -Last 1) -join "`r`n")
W $g ''
W $g '## 4) DSH 执行面边界棘轮 dsh-boundary.mjs（boundary 阶段）'
$o = & node scripts/ci/dsh-boundary.mjs 2>&1 | Out-String
W $g ('$ node scripts/ci/dsh-boundary.mjs   -> exit=' + $LASTEXITCODE)
W $g (($o -split "`n" | Select-Object -Last 3) -join "`r`n")
W $g ''
W $g '## 5) 文档新鲜度门禁 check-docs.mjs（doc 阶段）'
$o = & node scripts/ci/check-docs.mjs 2>&1 | Out-String
W $g ('$ node scripts/ci/check-docs.mjs   -> exit=' + $LASTEXITCODE)
W $g (($o -split "`n" | Select-Object -Last 3) -join "`r`n")
W $g ''
W $g '完整 run-ci 输出见 ci-run/ci.log 与 ci-run/summary.json（syntax/boundary/doc PASS，env FAIL）。'

# ============ 04-gap-checks.txt ============
W $c '# T-173 生产接线与配置缺口核对（devops 复核上游 T-172 结论）'
W $c ''
W $c '## A) 新增治理 API 是否有生产消费者（排除测试与文档）'
$o = & git grep -n -e claimWithReservation -e selectEligibleCandidate -e createIntegrationWorker -e enqueueIntegration -- ':!*.test.*' ':!docs/*' 2>&1 | Out-String
W $c '$ git grep -n -e claimWithReservation -e selectEligibleCandidate -e createIntegrationWorker -e enqueueIntegration -- ":!*.test.*" ":!docs/*"'
W $c $o.TrimEnd()
W $c ''
W $c '## B) .legion/delivery.json 是否通过 team-hub 校验（S3 verify-config）'
$o = & node -e "import('./team-hub/verify-config.mjs').then(m=>{const r=m.loadDeliveryConfig(process.cwd());console.log('ok='+r.ok);console.log('errors='+JSON.stringify(r.errors))})" 2>&1 | Out-String
W $c $o.TrimEnd()
W $c ''
W $c '## C) 集成模式开关的读取点'
$o = & git grep -n LEGION_INTEGRATION_MODE -- ':!docs/*' 2>&1 | Out-String
W $c $o.TrimEnd()
W $c ''
W $c '## D) 任务行序列化是否带调度/交付字段（T-172 F10 复核）'
$o = & git grep -n -e scheduling_state -e delivery_state -- 'team-hub/*.mjs' 2>&1 | Out-String
W $c $o.TrimEnd()
Write-Output 'evidence written'
