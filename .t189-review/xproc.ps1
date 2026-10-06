$ErrorActionPreference="Continue"
Set-Location "D:\project\DSH\legion\.legion-worktrees\T-189"
$dir = Join-Path $env:TEMP ("t189x-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# ---- test 1: parent holds lock, child must time out ----
$file = Join-Path $dir "secrets.json"
$s = node .t189-review/xproc-setup.mjs $file
$before = Get-Content $file -Raw
Set-Content -Path ($file + ".lock") -Value "parent-holds-it" -NoNewline -Encoding ascii
$out = (node .t189-review/xproc-child.mjs $file "legion/child" 40) -join "`n"
$after = Get-Content $file -Raw
$lock = Get-Content ($file + ".lock") -Raw
"TEST1 setup=$s out=$out fileUnchanged=$($before -eq $after) lockUnchanged=$($lock -eq "parent-holds-it")"
# ---- test 2: two sequential child writes, no contention ----
$file2 = Join-Path $dir "secrets2.json"
$o1 = (node .t189-review/xproc-child.mjs $file2 "legion/p1" 2000) -join "`n"
$o2 = (node .t189-review/xproc-child.mjs $file2 "legion/p2" 2000) -join "`n"
$data = Get-Content $file2 -Raw | ConvertFrom-Json
$has = ($null -ne $data.records."legion/p1") -and ($null -ne $data.records."legion/p2")
$lockLeft = Test-Path ($file2 + ".lock")
"TEST2 o1=$o1 o2=$o2 bothRecords=$has lockLeft=$lockLeft"
Remove-Item -Recurse -Force $dir