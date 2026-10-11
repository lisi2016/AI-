# 课时确认后端自测入口（Windows PowerShell）
#
# 用法：
#   pwsh -File tools/selftest.ps1
#
# 行为：
#   1) 释放 8081 端口上的旧 node 进程
#   2) 清空 backend/data/*.json（下次启动会重新写入演示种子数据）
#   3) npm install（若 node_modules 不存在）
#   4) 启动 node server.js 并等待 /health 就绪
#   5) 运行 tools/rule-test.js（领域规则单测，不依赖服务）
#      与 tools/smoke-test.js（HTTP 端到端自测，契约 A–I 全覆盖）
#   6) 打印结果并关闭服务进程

param(
  [int]$Port = 8081,
  [switch]$KeepServer
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Set-Location $root

function Stop-PortProcess([int]$p) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Write-Host "  - 已结束占用 $p 端口的进程 PID $($c.OwningProcess)" }
    catch { Write-Warning "  - 无法结束 PID $($c.OwningProcess)：$($_.Exception.Message)" }
  }
}

Write-Host '=== 课时确认后端自测 ===' -ForegroundColor Cyan
Write-Host '[1/6] 释放端口并清理数据'
Stop-PortProcess $Port
if (Test-Path (Join-Path $root 'data')) {
  Get-ChildItem (Join-Path $root 'data') -Filter '*.json' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $root 'data\exports') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $root 'data\uploads') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
Write-Host '  - data/*.json 已清空（启动时重新写入种子数据）'

Write-Host '[2/6] 检查依赖'
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  npm install --no-audit --no-fund
} else {
  Write-Host '  - node_modules 已存在，跳过 npm install'
}

Write-Host '[3/6] 领域规则单测（不依赖 HTTP 服务）'
$ruleLog = Join-Path $env:TEMP 'kcsq-rule-test.log'
& node (Join-Path $here 'rule-test.js') 2>&1 | Tee-Object -FilePath $ruleLog | Select-Object -Last 8
$ruleExit = $LASTEXITCODE

Write-Host '[4/6] 启动服务'
$env:PORT = "$Port"
$outLog = Join-Path $env:TEMP 'kcsq-selftest-server.log'
$errLog = Join-Path $env:TEMP 'kcsq-selftest-server.err.log'
$proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 400
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($h.code -eq 0) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  Write-Host '  ✗ 服务启动失败，错误日志：' -ForegroundColor Red
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 30
  if (-not $KeepServer -and $proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}
Write-Host "  - 服务就绪：http://127.0.0.1:$Port  (PID $($proc.Id))，今天 $($h.data.today)"

Write-Host '[5/6] HTTP 端到端自测（契约 A–I）'
$env:BASE = "http://127.0.0.1:$Port"
$smokeLog = Join-Path $env:TEMP 'kcsq-smoke-test.log'
& node (Join-Path $here 'smoke-test.js') 2>&1 | Tee-Object -FilePath $smokeLog | Select-Object -Last 25
$smokeExit = $LASTEXITCODE

Write-Host '[6/6] 结果汇总'
Write-Host "  领域规则单测 exit=$ruleExit 日志：$ruleLog"
Write-Host "  HTTP 端到端自测 exit=$smokeExit 日志：$smokeLog"
Write-Host "  服务日志：$outLog"

if (-not $KeepServer) {
  Stop-PortProcess $Port
  Write-Host '  - 已关闭测试服务'
} else {
  Write-Host "  - 服务保持运行（--KeepServer）：http://127.0.0.1:$Port"
}

if ($ruleExit -ne 0 -or $smokeExit -ne 0) {
  Write-Host '自测未全部通过' -ForegroundColor Red
  exit 1
}
Write-Host '自测全部通过' -ForegroundColor Green
exit 0
