# 补测：T-16 院系导入（确认导入）+ 回滚
$ErrorActionPreference = 'Continue'
$OUT = '.playwright-cli'
$BASE = 'http://8.138.41.74/admin/'
$CSV = (Resolve-Path 'deploy\test-depts.csv').Path

function PW { param([Parameter(ValueFromRemainingArguments = $true)] $A) & playwright-cli '-s=admin3' @A 2>&1 }
function Snap { param([string]$Name) PW 'snapshot' '--filename' "$OUT/$Name.yml" | Out-Null; Start-Sleep -Milliseconds 700; return (Get-Content "$OUT/$Name.yml" -Encoding UTF8) }
function RefOf { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -First 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }
function RefLast { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -Last 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }

Write-Output '===== 打开浏览器并登录 ====='
PW 'open' '--headed' '--persistent' $BASE | Select-Object -First 2 | Out-Null
Start-Sleep -Seconds 3
$s = Snap 'z_login'
PW 'fill' (RefOf $s 'textbox "工号 / 学号".*\[ref=([^\]]+)\]') 'ADMIN001' | Out-Null
PW 'fill' (RefOf $s 'textbox "密码".*\[ref=([^\]]+)\]') '123456' | Out-Null
PW 'click' (RefOf $s 'button "登 录".*\[ref=([^\]]+)\]') | Out-Null
Start-Sleep -Seconds 3
Write-Output ('  登录成功: ' + (((Snap 'z_after') -join "`n").Contains('课时确认后台')))

Write-Output ''
Write-Output '===== T-16 院系导入：上传 → 预校验 → 确认导入 ====='
PW 'goto' "$BASE#/import" | Out-Null
Start-Sleep -Seconds 2
$s1 = Snap 't16_step1'
$dzRef = RefOf $s1 'generic \[ref=([^\]]+)\]: 把 CSV 文件拖到这里'
Write-Output ('  拖拽区 ref=' + $dzRef + ' → 点击并上传 ' + (Split-Path $CSV -Leaf))
PW 'click' $dzRef | Out-Null
Start-Sleep -Seconds 1
PW 'upload' $CSV | Select-Object -First 2 | Out-Null
Start-Sleep -Seconds 4

$s2 = Snap 't16_step2'
$raw2 = ($s2 -join "`n")
Write-Output ('  预校验结果出现: ' + $raw2.Contains('预校验结果'))
$s2 | Select-String -Pattern '总行数|可导入行数|错误行数|全部行校验通过' | Select-Object -First 4 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }

$commitRef = RefOf $s2 'button "确认导入".*\[ref=([^\]]+)\]'
Write-Output ('  确认导入 ref=' + $commitRef)
PW 'click' $commitRef | Out-Null
Start-Sleep -Seconds 5

$s3 = Snap 't16_step3'
$raw3 = ($s3 -join "`n")
Write-Output ('  导入成功提示: ' + ($raw3 -match '导入成功|成功导入'))
$s3 | Select-String -Pattern '导入成功|成功|已回滚|回滚本次导入|测试学院|depts' | Select-Object -First 8 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }

Write-Output ''
Write-Output '===== T-16b 回滚本次导入 ====='
$rbRef = RefLast $s3 'button "回滚本次导入" \[ref=([^\]]+)\]'
if (-not $rbRef) {
    PW 'goto' "$BASE#/import" | Out-Null; Start-Sleep -Seconds 3
    $s3 = Snap 't16_step3b'
    $rbRef = RefLast $s3 'button "回滚本次导入" \[ref=([^\]]+)\]'
}
Write-Output ('  回滚按钮 ref=' + $rbRef)
if ($rbRef) {
    PW 'click' $rbRef | Out-Null
    Start-Sleep -Seconds 1
    $s4 = Snap 't16_step4'
    $okRef = RefLast $s4 'button "(确定|确认|回滚)".*\[ref=([^\]]+)\]'
    $okRef = RefLast $s4 '\[ref=([^\]]+)\] \[cursor=pointer\]: (确定|回滚)'
    Write-Output ('  确认按钮 ref=' + $okRef)
    if ($okRef) { PW 'click' $okRef | Out-Null; Start-Sleep -Seconds 4 } else { Write-Output '  ⚠ 未找到确认按钮，查看弹窗内容'; $s4 | Select-Object -Last 10 | ForEach-Object { Write-Output ('    ' + $_.Trim()) } }
    PW 'goto' "$BASE#/import" | Out-Null; Start-Sleep -Seconds 3
    $s5 = Snap 't16_step5'
    $raw5 = ($s5 -join "`n")
    Write-Output ('  出现"已回滚": ' + $raw5.Contains('已回滚'))
    $s5 | Select-String -Pattern '已回滚|回滚本次导入|测试学院' | Select-Object -First 6 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }
} else { Write-Output '  ⚠ 未找到回滚按钮' }
