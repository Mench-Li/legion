<#
  legion-up.ps1 —— Legion 一键独立启动（Product Launcher 的薄包装）

  它只做"每次启动都要手动做一遍"的几件事，别的一律交给 Launcher 本身：
    ① 挑端口：默认 8787 / 5173 / 3080 / 8080 被占（例如正在跑的 DSH Desktop 那套）
       就自动往上找空闲端口，不再要求人手工避让；
    ② 缺 DSH 运行时：体检报 ENTRY_UNRESOLVED 时自动跑一次
       `--runtime-install`（会联网跑 npm；用 -NoInstall 可只提示不装）；
    ③ 把 `--check` 与启动合成一条命令；`-Url` 顺手取回反向拉起的 DSH 地址。

  用法：
    .\scripts\legion-up.ps1                 # 一键起（前台常驻，Ctrl+C 停全部）
    .\scripts\legion-up.ps1 -Check          # 只体检，不启动任何进程
    .\scripts\legion-up.ps1 -Url            # 另一窗口：打印反向拉起的 DSH 地址（含 token）
    .\scripts\legion-up.ps1 -RuntimePort 3081 -HubPort 8788 -WorkbenchPort 5174
    .\scripts\legion-up.ps1 -RuntimeCommand "node D:\some\dsh\lib\bin.js --profile web"  # 自带 DSH
    .\scripts\legion-up.ps1 -Tray           # 挂系统托盘图标（默认不挂，方便在终端看日志）

  本脚本**不改任何现有文件**，只调用 product/launcher/cli.mjs。
  关白板请改产品配置：%LOCALAPPDATA%\Legion\data\product.config.json
    { "components": { "whiteboard": { "enabled": false } } }

  实现注记（踩过的坑）：参数字符串一律用 "$k=$v" 插值拼，**不要**写
  @('a=' + $x, 'b=' + $y) —— PowerShell 里逗号比加号结合得更紧，
  那样写出来的是一个"用空格连起来的单个字符串"，会整条当作一个 argv 传给子进程。
#>
[CmdletBinding()]
param(
  [string]$Workspace = '',
  [int]$RuntimePort = 0,
  [int]$HubPort = 0,
  [int]$WorkbenchPort = 0,
  [int]$WhiteboardPort = 0,
  [string]$RuntimeCommand = '',
  [switch]$Check,
  [switch]$Url,
  [switch]$NoInstall,
  [switch]$Tray
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo 'product\launcher\cli.mjs'
$legionHome = Join-Path $env:LOCALAPPDATA 'Legion'
$configPath = Join-Path $legionHome 'data\product.config.json'

if (-not (Test-Path $cli)) { throw "找不到 Launcher：$cli" }
if ($Workspace -eq '') { $Workspace = Split-Path -Parent $repo }   # 默认 = 仓库的父目录

function Test-PortFree([int]$Port) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch { return $false } finally { if ($listener) { $listener.Stop() } }
}

# 0 = 用产品默认端口；被占则向上找（最多试 20 个），并把"换了端口"说出来。
function Select-Port([int]$Preferred, [int]$Wanted, [string]$Label) {
  if ($Wanted -gt 0) { return $Wanted }
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-PortFree ($Preferred + $i)) {
      $port = $Preferred + $i
      if ($port -ne $Preferred) { Write-Host "  · $Label 默认端口 $Preferred 被占，改用 $port" }
      return $port
    }
  }
  throw "找不到空闲端口：$Label（从 $Preferred 试了 20 个）"
}

# 从 Launcher 抓下来的那行 stdout 里取 DSH 地址，并确认那个端口现在真的有人在听
# —— 只读日志而不看进程，会把上一次运行留下的 token 当成"这次的地址"报出来。
function Get-DshUrl {
  $log = Join-Path $legionHome 'log\runtime.stdout.log'
  if (-not (Test-Path $log)) { return $null }
  $line = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($null -eq $line) { return $null }
  # 取**最后一条**：日志是追加的，上一次运行那一行还留在文件里
  #（实测同一文件里出现两行、两个不同 token；取第一条会把过期 token 报成"这次的地址"）。
  $all = [regex]::Matches($line, 'https?://\S+')
  if ($all.Count -eq 0) { return $null }
  $url = $all[$all.Count - 1].Value
  $pm = [regex]::Match($url, ':(\d+)/')
  if ($pm.Success) {
    $port = [int]$pm.Groups[1].Value
    if (Test-PortFree $port) { return $null }   # 没人监听 = 这条地址已过期
  }
  return $url
}

if ($Url) {
  $u = Get-DshUrl
  if ($null -eq $u) {
    Write-Host "没读到**当前存活**的 DSH 地址（$legionHome\log\runtime.stdout.log）。"
    Write-Host '产品可能没在跑，或它还没就绪（就绪行是整棵 Loader 结算完之后才打出来的）。'
    exit 1
  }
  Write-Host '反向拉起的 DSH 地址（整条含 token，直接贴浏览器）：'
  Write-Host "  $u"
  exit 0
}

$runtimePort = Select-Port 3080 $RuntimePort 'runtime(DSH)'
$hubPort     = Select-Port 8787 $HubPort     'team-hub'
$wbPort      = Select-Port 5173 $WorkbenchPort 'workbench'
$whitePort   = Select-Port 8080 $WhiteboardPort 'whiteboard'

$baseArgs = @(
  "--workspace=$Workspace",
  "--port.runtime=$runtimePort",
  "--port.team-hub=$hubPort",
  "--port.workbench=$wbPort",
  "--port.whiteboard=$whitePort"
)
if ($RuntimeCommand -ne '') { $baseArgs += "--runtime-command=$RuntimeCommand" }

Write-Host 'Legion 独立启动'
Write-Host "  仓库    $repo"
Write-Host "  工作区  $Workspace"
Write-Host "  端口    hub=$hubPort  workbench=$wbPort  runtime(DSH)=$runtimePort  whiteboard=$whitePort"
Write-Host ''

$pre = (& node $cli --check @baseArgs 2>&1 | Out-String)
$preCode = $LASTEXITCODE

if ($preCode -ne 0) {
  Write-Host $pre.TrimEnd()

  # 「没装 DSH」的具名信号：runtime 入口由配置提供而当前没有值/指针缺失。
  if ($pre -match 'ENTRY_UNRESOLVED') {
    if ($NoInstall) {
      Write-Host ''
      Write-Host '缺 DSH 运行时。-NoInstall 已给，所以只提示不装。两条路选一条：'
      Write-Host '  ① 装到 Legion 自己的数据目录（需要联网 + npm）：'
      Write-Host "     node product\launcher\cli.mjs --runtime-install --workspace=$Workspace"
      Write-Host '  ② 指向一份已有的 DSH（不必装进 Legion）：'
      Write-Host '     .\scripts\legion-up.ps1 -RuntimeCommand "node D:\path\to\dsh\lib\bin.js --profile web"'
      exit 4
    }
    Write-Host ''
    Write-Host '缺 DSH 运行时 —— 先装它（联网跑 npm install；版本由产品清单精确锁定，不由人挑）'
    & node $cli --runtime-install "--workspace=$Workspace"
    if ($LASTEXITCODE -ne 0) { Write-Host "运行时安装未完成（退出码 $LASTEXITCODE）"; exit $LASTEXITCODE }
    Write-Host ''
    $pre = (& node $cli --check @baseArgs 2>&1 | Out-String)
    $preCode = $LASTEXITCODE
    if ($preCode -ne 0) { Write-Host $pre.TrimEnd(); exit $preCode }
  }
  elseif ($pre -match 'ENFORCEMENT_IDENTITY_MISSING') {
    # 干净机器上还没写过产品配置时必然撞上这一条：强制面要 actor/scope/action。
    Write-Host ''
    Write-Host "干净机器还差一步：把 Legion 身份写进产品配置 $configPath 的 runtime.env"
    Write-Host '（这三项只能由人给，产品不许编默认值；改完再跑一次本脚本）'
    Write-Host '  "runtime": { "command": "", "env": {'
    Write-Host '      "LEGION_ACTOR": "owner:<你的名字>", "LEGION_SCOPE": "software", "LEGION_ENFORCEMENT_ACTION": "employee-run" } }'
    exit 4
  }
  else {
    exit $preCode
  }
}

Write-Host '✔ 启动前体检通过'
if ($Check) { exit 0 }

Write-Host ''
Write-Host '启动中（前台常驻；Ctrl+C 停止全部组件）。就绪后另开一个窗口取 DSH 地址：'
Write-Host '  .\scripts\legion-up.ps1 -Url'
Write-Host ''

$startArgs = $baseArgs
if (-not $Tray) { $startArgs += '--no-tray' }

& node $cli @startArgs
exit $LASTEXITCODE
