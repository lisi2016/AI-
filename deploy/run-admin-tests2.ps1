# 补测：补签审核 / 申诉处理（playwright-cli）
$ErrorActionPreference = 'Continue'
$OUT = '.playwright-cli'
$BASE = 'http://8.138.41.74/admin/'

function PW { param([Parameter(ValueFromRemainingArguments = $true)] $A) & playwright-cli '-s=admin' @A 2>&1 }
function Snap { param([string]$Name) PW 'snapshot' '--filename' "$OUT/$Name.yml" | Out-Null; Start-Sleep -Milliseconds 600; return (Get-Content "$OUT/$Name.yml" -Encoding UTF8) }
function RefOf { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -First 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }

Write-Output '===== 重新登录 ====='
PW 'goto' $BASE | Out-Null
Start-Sleep -Seconds 2
$s = Snap 'x_login'
$noRef  = RefOf $s 'textbox "工号 / 学号".*\[ref=([^\]]+)\]'
$pwdRef = RefOf $s 'textbox "密码".*\[ref=([^\]]+)\]'
$btnRef = RefOf $s 'button "登 录".*\[ref=([^\]]+)\]'
Write-Output ("  refs: no=$noRef pwd=$pwdRef btn=$btnRef")
if ($noRef -and $pwdRef -and $btnRef) {
    PW 'fill' $noRef 'ADMIN001' | Out-Null
    PW 'fill' $pwdRef '123456' | Out-Null
    PW 'click' $btnRef | Out-Null
    Start-Sleep -Seconds 3
    $s2 = Snap 'x_afterlogin'
    Write-Output ('  登录成功: ' + (($s2 -join "`n").Contains('课时确认后台')))
} else { Write-Output '  ⚠ 未取到登录控件 ref'; exit 1 }

Write-Output ''
Write-Output '===== T-12 补签审核 ====='
PW 'goto' "$BASE#/makeup" | Out-Null
Start-Sleep -Seconds 2
$t12 = Snap 't12_makeup'
$raw12 = ($t12 -join "`n")
Write-Output ('  页面含"补签审核": ' + $raw12.Contains('补签审核'))
$t12 | Select-String -Pattern 'heading "|button "|columnheader |generic \[ref=[^\]]+\]: (待|已|全部)' | Select-Object -First 16 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }

Write-Output ''
Write-Output '===== T-13 申诉处理 ====='
PW 'goto' "$BASE#/appeal" | Out-Null
Start-Sleep -Seconds 2
$t13 = Snap 't13_appeal'
$raw13 = ($t13 -join "`n")
Write-Output ('  页面含"申诉处理": ' + $raw13.Contains('申诉处理'))
$t13 | Select-String -Pattern 'heading "|button "|columnheader ' | Select-Object -First 16 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }
