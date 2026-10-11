# 补测：T-14 创建导出任务 / T-15 数据导入预校验
$ErrorActionPreference = 'Continue'
$OUT = '.playwright-cli'
$BASE = 'http://8.138.41.74/admin/'
$CSV = (Resolve-Path 'deploy\test-depts.csv').Path

function PW { param([Parameter(ValueFromRemainingArguments = $true)] $A) & playwright-cli '-s=admin2' @A 2>&1 }
function Snap { param([string]$Name) PW 'snapshot' '--filename' "$OUT/$Name.yml" | Out-Null; Start-Sleep -Milliseconds 600; return (Get-Content "$OUT/$Name.yml" -Encoding UTF8) }
function RefOf { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -First 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }

Write-Output '===== 打开浏览器并登录 ====='
PW 'open' '--headed' '--persistent' $BASE | Select-Object -First 3 | Out-Null
Start-Sleep -Seconds 3
$s = Snap 'y_login'
$noRef = RefOf $s 'textbox "工号 / 学号".*\[ref=([^\]]+)\]'
$pwdRef = RefOf $s 'textbox "密码".*\[ref=([^\]]+)\]'
$btnRef = RefOf $s 'button "登 录".*\[ref=([^\]]+)\]'
PW 'fill' $noRef 'ADMIN001' | Out-Null
PW 'fill' $pwdRef '123456' | Out-Null
PW 'click' $btnRef | Out-Null
Start-Sleep -Seconds 3
Write-Output ('  登录成功: ' + (((Snap 'y_after') -join "`n").Contains('课时确认后台')))

Write-Output ''
Write-Output '===== T-14 报表导出中心：创建导出任务 ====='
PW 'goto' "$BASE#/export" | Out-Null
Start-Sleep -Seconds 2
$before = Snap 't14_before'
$dlBefore = ($before | Select-String -Pattern 'button "下载 ' ).Count
Write-Output ("  创建前：任务列表可下载文件 " + $dlBefore + ' 个')
PW 'click' '#x-create' | Out-Null
Start-Sleep -Seconds 3
$after = Snap 't14_after'
$dlAfter = ($after | Select-String -Pattern 'button "下载 ').Count
$raw14 = ($after -join "`n")
Write-Output ("  创建后：任务列表可下载文件 " + $dlAfter + ' 个')
Write-Output ('  页面出现"排队中|生成中|完成"等状态: ' + ($raw14 -match '排队中|生成中|完成'))
$after | Select-String -Pattern 'button "下载 |排队中|生成中|完成|失败' | Select-Object -First 6 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }

Write-Output ''
Write-Output '===== T-15 数据导入中心：上传 CSV 并预校验 ====='
PW 'goto' "$BASE#/import" | Out-Null
Start-Sleep -Seconds 2
Write-Output ('  上传文件: ' + $CSV)
PW 'upload' $CSV | Select-Object -First 3 | Out-Null
Start-Sleep -Seconds 4
$pre = Snap 't15_precheck'
$raw15 = ($pre -join "`n")
Write-Output ('  出现"预校验结果": ' + $raw15.Contains('预校验结果'))
Write-Output ('  出现"确认导入"按钮: ' + $raw15.Contains('确认导入'))
$pre | Select-String -Pattern '预校验|总行数|可导入|错误|确认导入|有效行|CSV|文件' | Select-Object -First 14 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }
