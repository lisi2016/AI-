# 补测：T-17 白名单导入预校验 / T-18 课表导入预校验
$ErrorActionPreference = 'Continue'
$OUT = '.playwright-cli'
$BASE = 'http://8.138.41.74/admin/'
$WL = (Resolve-Path 'deploy\test-students.csv').Path
$TK = (Resolve-Path 'deploy\test-cadres.csv').Path

function PW { param([Parameter(ValueFromRemainingArguments = $true)] $A) & playwright-cli '-s=admin6' @A 2>&1 }
function Snap { param([string]$Name) PW 'snapshot' '--filename' "$OUT/$Name.yml" | Out-Null; Start-Sleep -Milliseconds 700; return (Get-Content "$OUT/$Name.yml" -Encoding UTF8) }
function RefOf { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -First 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }
function RefLast { param($Snap, [string]$Pattern) $m = ($Snap | Select-String -Pattern $Pattern | Select-Object -Last 1); if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null } }

function TestType {
    param([string]$TabText, [string]$Csv, [string]$Name, [string]$Label)
    Write-Output ("===== $Name  $Label =====")
    $s = Snap "$Name-tab"
    $tabRef = RefOf $s ("generic \[ref=([^\]]+)\] \[cursor=pointer\]: " + [regex]::Escape($TabText))
    if (-not $tabRef) { $tabRef = RefLast $s ("\[ref=([^\]]+)\] \[cursor=pointer\]: " + [regex]::Escape($TabText)) }
    Write-Output ("  类型 Tab ref=" + $tabRef)
    if (-not $tabRef) { Write-Output '  ⚠ 未找到类型 Tab'; return }
    PW 'click' $tabRef | Out-Null
    Start-Sleep -Seconds 2
    $s2 = Snap "$Name-pick"
    $dzRef = RefOf $s2 'generic \[ref=([^\]]+)\]: 把 CSV 文件拖到这里'
    Write-Output ("  拖拽区 ref=" + $dzRef + " → 上传 " + (Split-Path $Csv -Leaf))
    PW 'click' $dzRef | Out-Null
    Start-Sleep -Seconds 1
    PW 'upload' $Csv | Select-Object -First 2 | Out-Null
    Start-Sleep -Seconds 4
    $s3 = Snap "$Name-result"
    $raw = ($s3 -join "`n")
    Write-Output ('  预校验结果出现: ' + $raw.Contains('预校验结果'))
    $s3 | Select-String -Pattern '总行数|可导入行数|错误行数|全部行校验通过|第 \d+ 行|不存在|不匹配' | Select-Object -First 6 | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) }
    Write-Output ''
}

Write-Output '===== 打开浏览器并登录 ====='
PW 'open' '--headed' '--persistent' $BASE | Select-Object -First 2 | Out-Null
Start-Sleep -Seconds 3
$s = Snap 'w_login'
PW 'fill' (RefOf $s 'textbox "工号 / 学号".*\[ref=([^\]]+)\]') 'ADMIN001' | Out-Null
PW 'fill' (RefOf $s 'textbox "密码".*\[ref=([^\]]+)\]') '123456' | Out-Null
PW 'click' (RefOf $s 'button "登 录".*\[ref=([^\]]+)\]') | Out-Null
Start-Sleep -Seconds 3
Write-Output ('  登录成功: ' + (((Snap 'w_after') -join "`n").Contains('课时确认后台')))

PW 'goto' "$BASE#/import" | Out-Null
Start-Sleep -Seconds 2

TestType '学生名单' $WL 't21' '学生名单导入预校验'
TestType '班干部授权' $TK 't22' '班干部授权导入预校验'
