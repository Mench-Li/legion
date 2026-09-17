$ErrorActionPreference = 'Continue'
$root = (Get-Location).Path
$feat = 'docs\FEATURES.md'
$read = 'README.md'
$featBak = Join-Path $root 'scratch\t117-r3-bak\FEATURES.md.bak'
$readBak = Join-Path $root 'scratch\t117-r3-bak\README.md.bak'
New-Item -ItemType Directory -Force -Path (Split-Path $featBak) | Out-Null
Copy-Item $feat $featBak -Force
Copy-Item $read $readBak -Force

function Run-Check {
  $o = node scripts\ci\check-docs.mjs 2>&1 | Out-String
  Write-Host $o.Trim()
  Write-Host ('exit=' + $LASTEXITCODE)
}

Write-Host '=== [TC-S3-02 POS] real CRLF checkout ==='
Run-Check

Write-Host ''
Write-Host '=== [TC-S3-05 NEG] FEATURES bad inline anchor #no-such-heading-xyz ==='
$t = Get-Content $feat -Raw -Encoding UTF8
$t = $t -replace '#no-such-heading-xyz', ''
$t = $t + [Environment]::NewLine + "[bad-link](#no-such-heading-xyz)"
[IO.File]::WriteAllText((Join-Path $root $feat), $t, [Text.Encoding]::UTF8)
Run-Check
Copy-Item $featBak $feat -Force
Write-Host '--- after restore ---'
Run-Check

Write-Host ''
Write-Host '=== [TC-S3-06 NEG] index row F-01 with 4 cols ==='
$fl = Get-Content $feat -Encoding UTF8
$fl = $fl | ForEach-Object { if ($_ -match '^F-01 ') { 'F-01 | x | y | z' } else { $_ } }
[IO.File]::WriteAllLines((Join-Path $root $feat), $fl, [Text.Encoding]::UTF8)
Run-Check
Copy-Item $featBak $feat -Force
Write-Host '--- after restore ---'
Run-Check

Write-Host ''
Write-Host '=== [TC-S3-07 NEG] README dead cross anchor #nope-bad-anchor-r3 ==='
$t2 = Get-Content $read -Raw -Encoding UTF8
$t2 = $t2 + [Environment]::NewLine + "[see](docs/FEATURES.md#nope-bad-anchor-r3)"
[IO.File]::WriteAllText((Join-Path $root $read), $t2, [Text.Encoding]::UTF8)
Run-Check
Copy-Item $readBak $read -Force
Write-Host '--- after restore ---'
Run-Check

Write-Host ''
Write-Host '=== git residue check (expect empty) ==='
$g = git status --porcelain -- README.md docs/FEATURES.md 2>&1 | Out-String
Write-Host $g.Trim()