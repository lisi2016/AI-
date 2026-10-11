# 关键接口 curl 演示脚本（Windows PowerShell，使用系统自带 curl.exe）
#
# 用法：
#   1) 另开终端启动服务：npm start
#   2) pwsh -File tools/curl-demo.ps1          # 默认 http://127.0.0.1:8081
#      pwsh -File tools/curl-demo.ps1 -Base http://127.0.0.1:8081
#
# 覆盖：health → login → bind(白名单) → tasks → code/generate → code/verify
#       → records(POST) → records/{id}/sign(multipart) → records/{id} → stats/overview
#       → 硬性校验（提交人=签字人被拒 / 非法状态流转被拒）
# 输出即为 curl 命令与返回结果，可直接粘贴到报告里作为证据。

param(
  [string]$Base = 'http://127.0.0.1:8081'
)

$ErrorActionPreference = 'Continue'
$api = "$Base/api/v1"
$stamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()

function Show([string]$title, [string]$cmd) {
  Write-Host ''
  Write-Host ('#' * 78) -ForegroundColor DarkGray
  Write-Host "# $title" -ForegroundColor Cyan
  Write-Host "# $cmd" -ForegroundColor DarkGray
  Write-Host ('#' * 78) -ForegroundColor DarkGray
}

function Json([string]$title, [string]$method, [string]$url, [string]$token, [string]$body) {
  $cmd = "curl -s -X $method `"$url`" -H `"Content-Type: application/json`""
  if ($token) { $cmd += " -H `"Authorization: Bearer $token`"" }
  if ($body) { $cmd += " -d '$body'" }
  Show $title $cmd
  $args = @('-s', '-X', $method, $url, '-H', 'Content-Type: application/json')
  if ($token) { $args += @('-H', "Authorization: Bearer $token") }
  if ($body) { $args += @('-d', $body) }
  $out = & curl.exe @args
  $out | Write-Output
  return ($out | ConvertFrom-Json)
}

# ---------------------------------------------------------------- 0 健康检查
$h = Json 'health 健康检查' 'GET' "$Base/health" '' ''
$today = $h.data.today
Write-Host "# → 服务 ok，today=$today，Node $($h.data.node)，DEV_MODE=$($h.data.devMode)，审计链 ok=$($h.data.auditChain.ok)" -ForegroundColor Yellow

# ---------------------------------------------------------------- 1 登录
$l1 = Json '1) 教师登录（DEV_MODE：code 任意，生成稳定 mock openid）' 'POST' "$api/auth/login" '' '{"code":"curl-teacher"}'
$openid = $l1.data.openid
if ($l1.data.needBind) {
  $b1 = Json '2) 教师绑定工号（白名单校验）' 'POST' "$api/auth/bind" '' ('{"openid":"' + $openid + '","role":"teacher","no":"2010032","realName":"唐瑞明"}')
  $teacherToken = $b1.data.token
} else {
  $teacherToken = $l1.data.token
  Write-Host '# → 已绑定，直接复用 token' -ForegroundColor Yellow
}
Write-Host "# → teacherToken = $($teacherToken.Substring(0, [Math]::Min(40, $teacherToken.Length)))…" -ForegroundColor Yellow

$l2 = Json '3) 班干部登录并绑定学号' 'POST' "$api/auth/login" '' '{"code":"curl-cadre"}'
$b2 = Json '4) 班干部绑定（张一鸣 / 2025030117）' 'POST' "$api/auth/bind" '' ('{"openid":"' + $l2.data.openid + '","role":"cadre","no":"2025030117","realName":"张一鸣"}')
$cadreToken = $b2.data.token

$l3 = Json '5) 教务处登录并绑定' 'POST' "$api/auth/login" '' '{"code":"curl-admin"}'
$b3 = Json '6) 教务处绑定（ADMIN001）' 'POST' "$api/auth/bind" '' ('{"openid":"' + $l3.data.openid + '","role":"admin","no":"ADMIN001","realName":"教务处"}')
$adminToken = $b3.data.token

$me = Json '7) GET /auth/me' 'GET' "$api/auth/me" $teacherToken ''
Write-Host "# → $($me.data.user.name) / $($me.data.user.dept) / role=$($me.data.role)" -ForegroundColor Yellow

# ---------------------------------------------------------------- 2 课表
$week = Json '8) GET /tasks/week 本周课表' 'GET' "$api/tasks/week" $teacherToken ''
Write-Host "# → 本周 $($week.data.monday)~$($week.data.sunday)，共 $($week.data.total) 条 / $($week.data.totalHours) 学时" -ForegroundColor Yellow

# 找一条「过去 + 无记录」的任务用于演示
$target = $null
$targetDate = ''
$wd = $week.data.week
for ($back = 1; $back -le 8 -and -not $target; $back++) {
  $w = Json "9.$back) GET /tasks/week?week=$($wd - $back)" 'GET' "$api/tasks/week?week=$($wd - $back)" $teacherToken '' 
  foreach ($t in $w.data.list) { if (-not $t.recordId) { $target = $t; $targetDate = $t.fullDate; break } }
}
Write-Host "# → 选定演示任务 $($target.courseName) / $($target.className) / $($target.section) / $targetDate" -ForegroundColor Yellow

# ---------------------------------------------------------------- 3 动态码
$gen = Json '10) POST /code/generate（班干部签发 60 秒动态码）' 'POST' "$api/code/generate" $cadreToken '{}'
$codeId = $gen.data.codeId
Write-Host "# → codeId=$codeId ttl=$($gen.data.ttl) expireAt=$($gen.data.expireAt)" -ForegroundColor Yellow

$ver = Json '11) POST /code/verify（教师扫码核验）' 'POST' "$api/code/verify" $teacherToken ('{"codeId":"' + $codeId + '"}')
Write-Host "# → 班干部 $($ver.data.cadre.duty) $($ver.data.cadre.name)，该班当日任务 $($ver.data.tasks.Count) 条" -ForegroundColor Yellow

# ---------------------------------------------------------------- 4 硬性校验
$self = Json '12) 【硬性校验】教师把自己指定为签字人 → 期望 40302' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"' + $targetDate + '","absentCount":0,"signerName":"唐瑞明"}')
Write-Host "# → code=$($self.code) msg=$($self.msg)" -ForegroundColor Yellow

$future = Json '13) 【参数校验】teachDate 为未来日期 → 期望 40001' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"2027-01-01","absentCount":0,"signerId":"' + $me.data.user.id + '"}')
Write-Host "# → code=$($future.code) msg=$($future.msg)" -ForegroundColor Yellow

# 合规校验：自由文本敏感词拦截（命中即 40001，且不消费动态码、写审计日志）
$sens = Json '13.5) 【合规校验】授课摘要含敏感词 → 期望 40001' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"' + $targetDate + '","absentCount":0,"signerId":"' + $b2.data.user.id + '","summary":"本次课存在代签情况"}')
Write-Host "# → code=$($sens.code) msg=$($sens.msg)" -ForegroundColor Yellow
$overLen = Json '13.6) 【合规校验】授课摘要超过 500 字符 → 期望 40001' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"' + $targetDate + '","absentCount":0,"signerId":"' + $b2.data.user.id + '","summary":"' + ('好' * 501) + '"}')
Write-Host "# → code=$($overLen.code) msg=$($overLen.msg)" -ForegroundColor Yellow

# ---------------------------------------------------------------- 5 正常发起
$rec = Json '14) POST /records 正常发起（状态 wait；不采集定位）' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"' + $targetDate + '","absentCount":1,"absentNames":"李思琪","discipline":"good","summary":"curl 演示授课摘要","signerId":"' + $b2.data.user.id + '","device":"curl-demo"}')
$recId = $rec.data.id
Write-Host "# → 记录 $recId 状态 $($rec.data.status) deadline $($rec.data.deadlineAt) 签字人 $($rec.data.signerName)" -ForegroundColor Yellow

$dup = Json '15) 【唯一性】重复发起同一节次 → 期望 40901' 'POST' "$api/records" $teacherToken ('{"codeId":"' + $codeId + '","taskId":"' + $target.id + '","teachDate":"' + $targetDate + '","absentCount":0,"signerId":"' + $b2.data.user.id + '"}')
Write-Host "# → code=$($dup.code) msg=$($dup.msg)" -ForegroundColor Yellow

# ---------------------------------------------------------------- 6 签名（multipart）
$png = Join-Path $env:TEMP 'kcsq-curl-sign.png'
[IO.File]::WriteAllBytes($png, [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + (New-Object byte[] 64) + [byte[]](0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82))
$signCmd = "curl -s -X POST `"$api/records/$recId/sign`" -H `"Authorization: Bearer <cadreToken>`" -F `"signature=@$png`" -F `"device=curl-demo iPhone`""
Show '16) POST /records/{id}/sign（multipart 字段名 signature；不采集定位）' $signCmd
$signOut = & curl.exe -s -X POST "$api/records/$recId/sign" -H "Authorization: Bearer $cadreToken" -F "signature=@$png" -F "device=curl-demo iPhone"
$signOut | Write-Output
$sign = $signOut | ConvertFrom-Json
Write-Host "# → 状态 $($sign.data.status) 确认时间 $($sign.data.confirmedAt) 签名图 $($sign.data.signature) 图片hash $($sign.data.signatureHash.Substring(0,16))…" -ForegroundColor Yellow

# ---------------------------------------------------------------- 7 详情 + 证据
$detail = Json '17) GET /records/{id}（详情 + 签名证据四项）' 'GET' "$api/records/$recId" $teacherToken ''
Write-Host "# → 状态 $($detail.data.statusText)，签名图 $($detail.data.evidence.signatureUrl)，设备 $($detail.data.evidence.device)，动态码 $($detail.data.evidence.codeId)（证据 count=$($detail.data.evidence.count)，无位置字段）" -ForegroundColor Yellow

$imgCmd = "curl -s -o sign_from_api.png -w '%{http_code} %{content_type}' `"$Base$($detail.data.evidence.signatureUrl)`" -H `"Authorization: Bearer <teacherToken>`""
Show '18) GET /files/{id} 带鉴权读取签名图' $imgCmd
$imgCode = & curl.exe -s -o "$env:TEMP\kcsq-sign-downloaded.png" -w '%{http_code} %{content_type}' "$Base$($detail.data.evidence.signatureUrl)" -H "Authorization: Bearer $teacherToken"
Write-Host "# → HTTP $imgCode（不带 token 时为 401）" -ForegroundColor Yellow

$noTok = & curl.exe -s -o NUL -w '%{http_code}' "$Base$($detail.data.evidence.signatureUrl)"
Write-Host "# → 无 token 访问签名图：HTTP $noTok" -ForegroundColor Yellow

# ---------------------------------------------------------------- 8 非法状态流转
$reject = Json '19) 【非法状态流转】对已 done 的记录再拒绝 → 期望 42201' 'POST' "$api/records/$recId/reject" $cadreToken '{"reason":"想改主意"}'
Write-Host "# → code=$($reject.code) msg=$($reject.msg)" -ForegroundColor Yellow

$revoke = Json '20) POST /records/{id}/revoke（教师撤销，任意状态 → revoked）' 'POST' "$api/records/$recId/revoke" $teacherToken '{"reason":"curl 演示撤销"}'
Write-Host "# → 状态 $($revoke.data.status)" -ForegroundColor Yellow

# ---------------------------------------------------------------- 9 统计
$ov = Json '21) GET /stats/overview' 'GET' "$api/stats/overview" $adminToken ''
Write-Host "# → 已确认学时 $($ov.data.confirmedHours)（其中补签 $($ov.data.makeupHours)）/ 待确认 $($ov.data.waiting) / 过期 $($ov.data.expired) / 异常 $($ov.data.abnormal) / 应计 $($ov.data.expectedHours) / 完成率 $($ov.data.completionRate)%" -ForegroundColor Yellow

$dept = Json '22) GET /stats/by-dept' 'GET' "$api/stats/by-dept" $adminToken ''
Write-Host "# → $(($dept.data.list | ForEach-Object { $_.name + ':' + $_.hours + 'h/' + $_.percent + '%' }) -join '  ')" -ForegroundColor Yellow

# ---------------------------------------------------------------- 10 导出
$ex = Json '23) POST /export/records（异步导出，返回 jobId）' 'POST' "$api/export/records" $adminToken '{"format":"csv"}'
Start-Sleep -Milliseconds 500
$job = Json '24) GET /export/{jobId}' 'GET' "$api/export/$($ex.data.jobId)" $adminToken ''
Write-Host "# → 状态 $($job.data.status)，$($job.data.successRows) 行，下载 $($job.data.downloadUrl)" -ForegroundColor Yellow
Write-Host "# 用浏览器直接打开：$Base$($job.data.downloadUrl)" -ForegroundColor Yellow

Write-Host ''
Write-Host '演示完成。以上每段「# curl ...」即为可复制的原始命令，下一行即为真实返回。' -ForegroundColor Green
