# 课时签到管理后台 · 主流程自动化测试（playwright-cli）
# 用法： pwsh -File deploy\run-admin-tests.ps1
$ErrorActionPreference = 'Continue'
$OUT = '.playwright-cli'
New-Item -ItemType Directory -Force -Path $OUT | Out-Null
$BASE = 'http://8.138.41.74/admin/'
$results = @()

function PW { param([Parameter(ValueFromRemainingArguments = $true)] $A) & playwright-cli '-s=admin' @A 2>&1 }

function Snap {
    param([string]$Name)
    PW 'snapshot' '--filename' "$OUT/$Name.yml" | Select-Object -First 3 | Out-Null
    Start-Sleep -Milliseconds 500
    $p = Join-Path $OUT "$Name.yml"
    if (Test-Path $p) { return (Get-Content $p -Encoding UTF8) } else { return @() }
}

function Visit {
    param([string]$Hash, [string]$Name, [string]$ExpectHeading)
    Write-Output "===== $Name  →  #/$Hash ====="
    PW 'goto' "$BASE#$Hash" | Select-Object -First 2 | Out-Null
    Start-Sleep -Seconds 2
    $snap = Snap $Name
    $h2 = ($snap | Select-String -Pattern 'heading "([^"]+)" \[level=2\]' | Select-Object -First 1)
    $title = if ($h2) { $h2.Matches[0].Groups[1].Value } else { '(未取到)' }
    $raw = ($snap -join "`n")
    $ok = $raw.Contains($ExpectHeading)
    Write-Output ("  页面标题: $title   期望包含: $ExpectHeading   → " + $(if ($ok) { 'PASS' } else { 'FAIL' }))
    $script:results += [pscustomobject]@{ Name = $Name; Title = $title; Pass = $ok }
    return $snap
}

function Evidence {
    param($Snap, [string]$Label, [string[]]$Patterns, [int]$Max = 4)
    Write-Output "  [$Label]"
    foreach ($p in $Patterns) {
        $hit = ($Snap | Select-String -Pattern $p | Select-Object -First $Max)
        if ($hit) { $hit | ForEach-Object { Write-Output ('    · ' + $_.Line.Trim()) } }
        else { Write-Output ('    · (未找到: ' + $p + ')') }
    }
}

# ---------------------------------------------------------------- T-05 ~ T-10
$s05 = Visit 'records' 't05_records' '课时明细'
Evidence $s05 '列表列头' @('columnheader') 6

$s06 = Visit 'courses' 't06_courses' '课程清单'
Evidence $s06 '课程数据' @('cell "', 'columnheader') 6

$s07 = Visit 'import' 't07_import' '数据导入'
Evidence $s07 '导入类型/按钮' @('tab "', 'button "', 'heading "') 10

$s08 = Visit 'export' 't08_export' '导出'
Evidence $s08 '导出表单/说明' @('button "', 'combobox', '21 列|固定') 8

$s09 = Visit 'config' 't09_config' '规则配置'
Evidence $s09 '配置项' @('button "', 'textbox|spinbutton|combobox') 8

$s10 = Visit 'logs' 't10_logs' '操作日志'
Evidence $s10 '日志内容' @('columnheader', 'button "') 8

# ---------------------------------------------------------------- T-11 退出登录
Write-Output '===== T-11 退出登录 ====='
$s10b = Snap 't11_before'
$logoutRef = ($s10b | Select-String -Pattern 'button "退出" \[ref=(e\d+)\]' | Select-Object -Last 1)
if ($logoutRef) {
    $ref = $logoutRef.Matches[0].Groups[1].Value
    Write-Output "  点击右上角「退出」(ref=$ref)"
    PW 'click' $ref | Select-Object -First 2 | Out-Null
    Start-Sleep -Seconds 1
    $s11a = Snap 't11_confirm'
    $okRef = ($s11a | Select-String -Pattern 'button "退出" \[ref=(e\d+)\]' | Select-Object -Last 1)
    if ($okRef) {
        $ref2 = $okRef.Matches[0].Groups[1].Value
        Write-Output "  点击确认弹窗「退出」(ref=$ref2)"
        PW 'click' $ref2 | Select-Object -First 2 | Out-Null
        Start-Sleep -Seconds 2
    } else { Write-Output '  ⚠ 未找到确认按钮' }
    $s11b = Snap 't11_after'
    $raw11 = ($s11b -join "`n")
    $backToLogin = $raw11.Contains('教务处管理后台') -and $raw11.Contains('工号 / 学号')
    Write-Output ("  是否回到登录页: " + $(if ($backToLogin) { 'PASS' } else { 'FAIL' }))
    $script:results += [pscustomobject]@{ Name = 't11_logout'; Title = '退出登录'; Pass = $backToLogin }
    # 刷新后仍在登录页
    PW 'goto' $BASE | Select-Object -First 2 | Out-Null
    Start-Sleep -Seconds 2
    $s11c = Snap 't11_reload'
    $stillLogin = (($s11c -join "`n").Contains('工号 / 学号'))
    Write-Output ("  刷新后仍在登录页: " + $(if ($stillLogin) { 'PASS' } else { 'FAIL' }))
    $script:results += [pscustomobject]@{ Name = 't11b_reload'; Title = '刷新仍在登录页'; Pass = $stillLogin }
} else {
    Write-Output '  ⚠ 未找到「退出」按钮'
}

# ---------------------------------------------------------------- 汇总
Write-Output ''
Write-Output '================ 汇总 ================'
$pass = ($results | Where-Object { $_.Pass }).Count
$results | ForEach-Object { Write-Output ('  ' + $(if ($_.Pass) { 'PASS' } else { 'FAIL' }) + '  ' + $_.Name + '  (' + $_.Title + ')') }
Write-Output ("  合计: 通过 " + $pass + ' / ' + $results.Count)
