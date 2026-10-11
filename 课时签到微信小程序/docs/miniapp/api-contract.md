# 课时确认系统 · 后端接口契约

- 版本：v0.1（草案，随首版开发同步修订）
- 日期：2026-09-27
- 技术栈：**中立**。任何能处理 HTTP + JSON + 关系型数据库的技术栈均可实现（Java / .NET / Node / Python / PHP 不限）
- 配套文档：`docs/miniapp/admin-web-spec.md`（Web 后台页面规格）
- 前端对应实现：`miniprogram/utils/api.js`（mock 与真实接口在此切换）

---

## 一、总体约定

### 1.1 传输

| 项 | 约定 |
|---|---|
| 协议 | HTTPS（微信小程序强制，域名必须已备案） |
| 前缀 | `/api/v1` |
| 编码 | UTF-8，`Content-Type: application/json` |
| 文件上传 | `multipart/form-data`，单独接口 |
| 时间 | ISO 8601 字符串，时区 `Asia/Shanghai`，例 `2026-09-27T10:05:00+08:00` |
| 金额 | 本项目不涉及 |
| 幂等 | 所有写操作接受 `Idempotency-Key` 请求头（客户端生成 UUID），服务端 24 小时内同 Key 返回首次结果 |

### 1.2 统一响应结构

```json
{
  "code": 0,
  "msg": "ok",
  "data": {},
  "traceId": "a1b2c3d4"
}
```

`code = 0` 为成功，非 0 见第九节错误码。分页数据统一放在 `data` 里：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "list": [],
    "total": 128,
    "page": 1,
    "pageSize": 20
  }
}
```

### 1.3 认证

1. 小程序端 `wx.login()` 取 `code` → 调 `POST /auth/login`
2. 服务端用 **AppSecret** 调微信 `code2Session` 换 `openid`（**AppSecret 只存在于服务端，绝不下发前端**）
3. 已绑定工号/学号 → 返回 `token`（JWT，有效期 7 天）；未绑定 → 返回 `needBind: true`，前端走绑定流程
4. 后续请求头：`Authorization: Bearer <token>`
5. 白名单校验：绑定时比对 `t_whitelist`（工号/学号 + 姓名），不一致拒绝绑定

### 1.4 权限模型（RBAC 简化版）

| 角色 | 取值 | 能力边界 |
|---|---|---|
| 教师 | `teacher` | 只能操作本人授课任务与本人记录 |
| 班干部 | `cadre` | 只能确认本人被授权教学班的记录 |
| 院系管理员 | `dept_admin` | 本院系统计、补签审核 |
| 教务处 | `admin` | 全校统计、申诉处理、导入、配置、导出 |

服务端必须逐条校验**：不能只靠前端隐藏按钮**。任何越权返回 `403`。

---

## 二、数据模型（表结构）

> 类型描述与具体数据库无关，SQLite 用 TEXT/INTEGER，MySQL 用 VARCHAR/BIGINT 对应即可。

### 2.1 t_user 用户

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigint PK | |
| openid | varchar(64) UNIQUE | 微信标识 |
| unionid | varchar(64) | 可空 |
| role | varchar(20) | teacher / cadre / dept_admin / admin |
| real_name | varchar(50) | 真实姓名 |
| staff_no | varchar(32) | 工号（教师） |
| student_no | varchar(32) | 学号（班干部） |
| dept_id | bigint | 所属院系 |
| class_id | bigint | 所属教学班（班干部必填） |
| phone | varchar(20) | 可空 |
| status | varchar(10) | active / disabled |
| created_at / updated_at | datetime | |

### 2.2 t_dept 院系、t_class 教学班

`t_dept(id, name, code, parent_id)`
`t_class(id, name, grade, dept_id, advisor, status)`

### 2.3 t_class_cadre 班干部授权（对应"学委优先、请假时他人顶上"）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigint PK | |
| class_id | bigint | |
| user_id | bigint | |
| duty | varchar(20) | 学委 / 班长 / 副班长 |
| priority | int | 1 = 学委（默认签字人），数字越大优先级越低 |
| status | varchar(10) | active / leave（请假） |
| start_at / end_at | datetime | 授权有效期 |

> 规则：默认取 `status='active'` 且 `priority` 最小的记录作为签字人；教师现场改选他人时，只能在本表 `active` 名单内选，生成记录标记 `signer_is_adhoc=1`，由教务处事后审核。

### 2.4 t_course_task 授课任务（课表）

| 字段 | 说明 |
|---|---|
| id | |
| term | 学期，如 `2026-2027-1` |
| teacher_id | |
| course_code / course_name | |
| class_id | 教学班 |
| weekday | 1–7 |
| section | 节次，如 `1-2` |
| start_time / end_time | `08:00` / `09:40` |
| place | 教室 |
| weeks | 上课周次，如 `1-16` |
| hours | 应计学时 |
| coef | 学时系数（默认 1.0，可在配置表覆盖） |
| source | `import` / `manual` |

### 2.5 t_period_record 课时记录（核心表）

| 字段 | 说明 |
|---|---|
| id | |
| task_id | 关联授课任务 |
| teacher_id / course_name / class_id | 冗余快照，课表变动不影响历史记录 |
| teach_date | 上课日期 |
| section / start_time / end_time / place | |
| hours | 应计学时（快照） |
| status | draft / wait / done / rejected / expired / appealing / makeup / revoked |
| absent_count | 缺勤人数 |
| absent_names | 缺勤姓名原始文本 |
| discipline | good / normal / bad |
| summary | 授课摘要 |
| signer_id / signer_name / signer_duty | 签字人 |
| signer_is_adhoc | 0/1，1 = 教师现场指定，需教务处事后审核 |
| code_id | 发起时使用的动态码 ID |
| confirmed_at | 签名确认时间 |
| deadline_at | 确认截止（当天 24:00） |
| makeup_id / appeal_id | 关联补签/申诉 |
| note | 备注（拒绝原因、撤销原因等） |
| created_at / updated_at | |

### 2.6 t_signature 签名证据

| 字段 | 说明 |
|---|---|
| id | |
| record_id | |
| signer_id | |
| image_url | 签名图存储路径（对象存储或服务器文件） |
| signed_at | |
| device_info | 设备型号字符串 |
| code_id | 动态码 |
| ip | 可空 |
| image_hash | 图片 SHA-256，用于防篡改校验 |

> **不采集定位**（决策 15）：本系统不申请 `wx.getLocation`，签名证据为四项——**签名图 / 确认时间 / 设备 / 动态码**。历史数据中的位置字段仅作兼容保留，新数据一律为 NULL。

### 2.7 t_absent 缺勤明细

`id, record_id, raw_name, matched_student_id（可空）, match_status（matched/unmatched/ambiguous）`

> 手输姓名会有错字与重名，服务端尽力匹配 `t_student`，匹配不上的保留原文并标 `unmatched`，导出时原样输出。

### 2.8 t_makeup_apply 补签、t_appeal 申诉

`t_makeup_apply(id, record_id, applicant_id, reason, evidence_urls, status(pending/approved/rejected), reviewer_id, reviewed_at, review_note)`
`t_appeal(id, record_id, applicant_id, reason, status, reviewer_id, reviewed_at, review_note)`

### 2.9 t_audit_log 操作日志（要求留存 5 年）

`id, actor_id, actor_role, action, target_type, target_id, before_json, after_json, ip, device, created_at, prev_hash, hash`

> 防篡改：`hash = SHA256(prev_hash + 本条内容)` 形成链，定期将链头写入只追加存储。至少做到「可检测篡改」。

### 2.10 t_config 规则配置

`id, key, value, updated_by, updated_at`
关键 key：`hours_coef_theory` / `hours_coef_practice` / `confirm_deadline_hour`（默认 24）/ `code_ttl_seconds`（默认 60）/ `makeup_approver_role`（默认 dept_admin）/ `appeal_approver_role`（默认 admin）

### 2.11 t_import_job 导入任务

`id, type(tasks/students/whitelist/cadres), file_url, status, total_rows, success_rows, fail_rows, error_report_url, operator_id, created_at, finished_at`

### 2.12 t_whitelist 工号学号白名单

`id, no, real_name, role, dept_id, class_id, status`

---

## 三、接口清单

### A. 认证与绑定

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 入参 `{code}`；已绑定返回 token+用户信息，未绑定返回 `needBind:true` + openid + bindTicket |
| POST | `/auth/bind` | 入参 `{openid, role, no, realName}`；校验白名单，绑定成功返回 token。生产（DEV_MODE=0）必须带有效 `bindTicket` 且 openid 必须与票据一致 |
| GET | `/auth/me` | 返回当前用户、角色、授权班级 |
| POST | `/auth/logout` | 失效 token（不清除绑定关系）|
| POST | `/auth/unbind` | **自助解绑（需登录）**：解除当前微信与工号的绑定，**不动任何历史课时/统计/审计数据**；成功后当前 token 立即失效。返回 `{ok,no,realName,unbound:true}` |
| POST | `/auth/unbind-self` | **自助解绑（未登录，换微信自救）**：入参 `{no, realName}`；白名单 + 姓名完全一致，否则 `40301`（"不在白名单"与"姓名不符"同提示，防探测）；幂等（未绑定 → `hadBinding:false`）。**频率限制**：同一工号 24h ≤ 2 次、同一 IP 1h ≤ 5 次（失败尝试同样计数），超限 `40001` |

### B. 动态确认码（教师扫码入口）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/code/generate` | 班干部调用；返回 `{codeId, code, codeLength, qrPayload, qrUrl, expireAt, expireAtMs, ttl, channels, cadre, className, sign}`；其中 **`code` 为 6 位数字口令**（在当前有效未消费的码中唯一）、**`qrPayload` = `kcsq://code/<codeId>`**（`qrUrl` 为兼容别名）；**服务端 60 秒过期**，码值另含 HMAC 签名防伪造 |
| POST | `/code/verify` | 教师**扫码或输口令**后调用；入参**三选一**：`{qrContent}`（扫码原文）/ `{code}`（6 位口令）/ `{codeId}`；返回班干部身份 + 该班当日授课任务列表，并回显 `verifyBy`/`channel`；过期返回 `41001`、已消费 `41002`、无效 `40401` |

> 防代签：码必须由服务端签发并带时间戳签名，截图复用在 60 秒后失效；同一 `codeId` 只能被消费一次。

### C. 授课任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tasks?date=2026-09-27` | 教师本人当日授课任务 |
| GET | `/tasks/week?week=4&term=` | 本周课表 |
| GET | `/tasks/{id}` | 详情 |

### D. 课时记录（核心）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/records` | teacher | 发起确认，入参含 `codeId, taskId, teachDate, absentCount, absentNames, discipline, summary, signerId`（**不采集定位**，若客户端传入 location 字段将被忽略）；**服务端校验教师不能给自己签**（提交人 ≠ 签字人），返回记录 `status=wait` |
| GET | `/records?status=&from=&to=&page=&pageSize=` | 按角色 | 列表；教师只看本人，班干部只看待自己确认的 |
| GET | `/records/{id}` | 相关人 | 详情 + 证据四项（签名图 URL、确认时间、设备、动态码） |
| POST | `/records/{id}/sign` | cadre | 上传签名图（multipart）+ 设备；置 `status=done`，写 `t_signature` |
| POST | `/records/{id}/reject` | cadre | 入参 `{reason}`，必填；置 `status=rejected` |
| POST | `/records/{id}/revoke` | teacher | 撤销，置 `status=revoked` |
| POST | `/records/{id}/urge` | teacher | 提醒签字人（记录日志，后续接订阅消息） |
| POST | `/records/expire-job` | 内部定时任务 | 每日 00:05 将超期 `wait` 批量置 `expired` |

**服务端必须做的校验**：
1. 唯一性：同一 `teacher_id + course + class_id + teach_date + section` 只允许一条 `status != revoked` 的记录
2. 提交人 ≠ 签字人（需求 5.2，硬性）
3. 签字人必须在该教学班 `t_class_cadre` 的 active 名单内
4. `teach_date` 不得为未来日期
5. 状态机：只允许 `wait → done/rejected/expired/revoked`，`done` 不可再改（除撤销与申诉）

### E. 补签与申诉

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/makeup` | teacher | 对 `expired/rejected` 记录发起补签，附原因与证据 |
| GET | `/makeup?status=pending` | dept_admin / admin | 待审列表 |
| POST | `/makeup/{id}/approve` | dept_admin | 通过后原记录置 `makeup` |
| POST | `/makeup/{id}/reject` | dept_admin | 驳回，原因必填 |
| POST | `/appeal` | teacher | 对 `rejected` 记录申诉 |
| POST | `/appeal/{id}/approve` / `/appeal/{id}/reject` | admin | 申诉处理 |

### F. 统计（教务处看板）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats/overview?term=&from=&to=` | 全校：已确认学时、待确认数、过期数、异常数 |
| GET | `/stats/by-dept?term=` | 分院系学时（含完成率） |
| GET | `/stats/by-teacher?deptId=&page=` | 分教师学时排行与明细 |
| GET | `/stats/by-course?term=` | 分课程 |
| GET | `/stats/trend?from=&to=&granularity=week` | 趋势 |

> **统计口径（硬性）**：仅 `status IN (done, makeup)` 计入正式学时；`makeup` 在报表中单独标注列；合班课程按 `task_id` 统计，不按班级重复累加。

### G. 导出（教务处优先级最高项）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/export/records` | 入参筛选条件 + `format=xlsx|csv`；**异步**，返回 `jobId` |
| GET | `/export/{jobId}` | 查询进度；完成后返回 `downloadUrl`（有效期 1 小时，需鉴权） |
| POST | `/export/stats` | 统计报表导出 |

导出表头固定为：学期 / 教师姓名 / 工号 / 院系 / 课程 / 教学班 / 上课日期 / 节次 / 应计学时 / 状态 / 是否补签 / 签字人 / 签字人职务 / 是否现场指定 / 确认时间 / 缺勤人数 / 缺勤姓名 / 课堂纪律。

### H. 基础数据导入（教务处优先级最高项）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/import/tasks` | 课表 Excel；模板列：学期\|工号\|教师姓名\|课程代码\|课程名称\|教学班\|星期\|节次\|开始\|结束\|地点\|周次\|学时 |
| POST | `/import/students` | 学生名单；列：学号\|姓名\|教学班 |
| POST | `/import/whitelist` | 工号学号白名单；列：工号/学号\|姓名\|角色\|院系\|教学班 |
| POST | `/import/cadres` | 班干部授权；列：教学班\|学号\|姓名\|职务\|优先级 |
| GET | `/import/{jobId}` | 导入进度与失败行报告下载 |
| GET | `/import/template?type=` | 下载标准模板 |

导入必须**先校验后落库**，输出逐行错误报告（第几行、什么错），不允许部分脏数据静默入库。

### I. 配置、日志、文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / PUT | `/config` | 学时系数、确认时限、动态码有效期、审批层级 |
| GET | `/logs?targetId=&action=&from=&to=` | 操作日志查询 |
| POST | `/files/signature` | 签名图上传，返回 `url`；限制 < 2MB，仅 png/jpg |
| GET | `/files/{id}` | 文件读取（需鉴权，签名图不得公开访问） |

---

## 四、状态机

```
draft ──提交──> wait ──班干部签名──> done
                 │
                 ├──班干部拒绝──> rejected ──教师申诉──> appealing ──教务处处理──> done / rejected
                 ├──超当天24点──> expired ──教师补签──> (审批) ──> makeup
                 └──教师撤销──> revoked
```

| 转换 | 触发者 | 服务端校验 |
|---|---|---|
| draft → wait | teacher | 提交人 ≠ 签字人；唯一性；节次属于该教师课表 |
| wait → done | cadre | 签字人在授权名单内；签名图非空；未超 deadline |
| wait → rejected | cadre | reason 必填 |
| wait → expired | 定时任务 | `now > deadline_at` |
| rejected → appealing | teacher | 同一记录申诉次数上限（建议 1 次/记录） |
| expired → makeup | teacher → dept_admin 审批 | 补签理由必填 |
| 任意 → revoked | teacher（本人）/ admin | 不可恢复，写日志 |

---

## 五、字段映射（前端 mock → 后端契约）

前端 `utils/mock.js` 与 `store.js` 目前用的字段，接入后端时的对应关系：

| 前端字段 | 后端字段 | 备注 |
|---|---|---|
| `id` | `id` | 前端 `R<timestamp>` → 后端 bigint |
| `courseName` / `className` | `course_name` / 关联 `class_id` | 后端以 class_id 为准，名称做快照 |
| `date` `09-27` | `teach_date` | 前端短格式 → 后端完整日期 |
| `section` / `time` / `place` | 同名 | |
| `hours` | `hours` | 前端默认 2 |
| `status` | `status` | 8 态一致，取值字符串一致 |
| `absentCount` / `absentNames` | 同名 | 后端额外做姓名匹配 |
| `discipline` | `discipline` | good/normal/bad |
| `signerName` / `signerDuty` / `signerIsAdHoc` | `signer_name` / `signer_duty` / `signer_is_adhoc` | |
| `signature` | `t_signature.image_url` | 前端是本地路径，后端是 URL |
| `device` | `t_signature.device_info` | |
| ~~`location` / `locationDenied`~~ | ~~`t_signature.latitude/longitude`~~ | **已移除**（决策 15，不再采集定位）|
| `codeId` | `code_id` | |
| `deadline` | `deadline_at` | |

---

## 六、安全与合规要求

1. **AppSecret 只在服务端**，通过环境变量或密钥管理服务注入，禁止写入代码、配置、仓库、日志（参见 `docs/miniapp/security-notes.md`）
2. 所有接口鉴权，越权返回 403，**权限校验在服务端**
3. 签名图不得公开访问，URL 需带鉴权或短期签名
4. **不采集定位**（决策 15）：系统不申请 `wx.getLocation`，不做位置隐私申报；课时真实性依赖"动态码 + 班干部手写签名 + 操作留痕"三重证据
5. 数据留存 ≥ 5 年；每日增量备份、每周全量备份，备份加密
6. **教师填写的自由文本**（授课摘要、缺勤姓名、补签/申诉理由、拒绝原因、备注）**必须做敏感词过滤与长度限制**：命中敏感词返回 `40001` 并写明命中词，同时写操作日志；长度上限默认 摘要 ≤ 500、缺勤姓名 ≤ 300、理由/备注 ≤ 500（敏感词表与阈值可经 `/config` 配置）
7. 导出文件含个人信息，下载链接短期有效、记录导出日志
8. 日志防篡改至少做到可检测（哈希链）

---

## 七、非功能要求

| 项 | 要求 |
|---|---|
| 并发 | 扫码发起的高峰在一个班 50 人规模的量级，动态码接口 QPS 按 200 设计即可 |
| 响应 | 列表/统计 < 1s，导出异步 |
| 幂等 | 写操作支持 `Idempotency-Key`，防重复提交产生两条记录 |
| 可观测 | 每请求带 `traceId`，记入日志 |
| 降级 | 网络失败时前端可本地暂存草稿，恢复后补交（不涉及定位）|

---

## 八、错误码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 40001 | 参数错误 |
| 40101 | 未登录 / token 失效 |
| 40301 | 越权 |
| 40302 | 教师不能确认本人课时（违反需求 5.2） |
| 40401 | 资源不存在 |
| 40901 | 重复记录（唯一性冲突） |
| 41001 | 动态码已过期 |
| 41002 | 动态码已被使用 |
| 42201 | 状态不允许该操作（状态机校验失败） |
| 42202 | 签字人不在授权名单内 |
| 50001 | 服务端错误 |
| 50002 | 第三方（微信接口）调用失败 |

---

## 九、前端接入方式

`miniprogram/utils/api.js` 提供统一出口，页面不直接写 URL：

```js
var api = require('../../utils/api.js');
api.getRecords({ status: 'wait' }).then(function (data) { ... });
```

切换真实后端只需两步：
1. `app.globalData.useMock = false`
2. 在 `app.globalData.apiBase` 填入学校已备案 HTTPS 域名（如 `https://kcsq.cswszyxy.cn`）

在此之前，`api.js` 全部走本地 mock，界面与流程可完整演示。

---

## 十、业务流程简化（v0.2 新增，落实决策 18）

原流程「教师填表发起 → 班干部手写签名」（第三节 D 组）**保留可用**（历史数据与旧客户端），但**新流程**改为**班干部驱动 + 教师扫码确认**：

```
班干部录入课程清单（一次，长期保留）
  → 上课时从清单带出信息（可临时调整实际授课人/节次/地点）
  → 发起课时会话并出示动态二维码（A 码 + B 6 位口令，60 秒）
  → 任课老师扫码或输口令 → 看到本次课时信息 → 点「确认」
  → 该次课时完成；学时按【实际授课人】归属
```

**取消**：调课记录、停课记录、审批流（不做审批）。

### 10.1 新增接口：班级课程清单（J 组）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/class-courses?classId=&keyword=&status=&term=&weekday=&page=&pageSize=` | 班干部=本班；教师=按班查；院系管理员=本院系；教务处=全部 | `status` 默认 `active`，可 `archived`/`all` |
| GET | `/class-courses/today?date=YYYY-MM-DD[&classId=]` | 同上 | 按该日期星期带出当天课程 |
| GET | `/class-courses/{id}` | 同上 | 详情 |
| POST | `/class-courses` | 班干部（本班）/院系管理员/教务处 | 必填 `courseName`、`teacherName`；可选 `weekday/section/place/hours` |
| PUT | `/class-courses/{id}` | 同上 | 部分字段；`classId` 不可改 |
| DELETE | `/class-courses/{id}` | 同上 | **软删除**（`status='archived'`），重复删除 42201 |

字段：`id, classId, className, deptId, deptName, courseName, teacherName, teacherNo, weekday, weekdayText, section, startTime, endTime, time, place, hours, term, status, createdBy, createdByName, createdAt, updatedAt`
返回含角标口径 `summary:{total, active, archived}`。

### 10.2 新增接口：课时会话（K 组）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/sessions` | 班干部（本班）/院系管理员/教务处 | **学委发起**：`{courseId?, courseName, teacherName, teachDate, section?, place?, hours?, note?, absentCount?, absentNames?, discipline?, summary?}` → 返回 `sessionId` + `codeId` + **`code`(6位口令)** + **`qrPayload`**(`kcsq://code/<codeId>`) + `ttl`(60) + `session` |
| POST | `/sessions/{id}/code` | 发起人/本班班干部/院系管理员/教务处 | **刷新动态码**（同会话换新码，仅 `wait` 可刷新） |
| GET | `/sessions?date=&status=&from=&to=&classId=&courseId=&teacherName=&courseName=&tempAdjusted=&nameMismatch=&page=&pageSize=` | 班干部=本班；教师=本人为实际授课人或本人确认过；院系管理员=本院系；教务处=全部 | 列表；`summary` 含 `hours/byStatus/statusTotals/tempAdjustedCount/nameMismatchCount` |
| GET | `/sessions/{id}` | 同上 | 详情：`session` + `course` 快照 + `teacher` + `initiator` + `confirmer` + `code` + `auditTail` |
| POST | `/sessions/{id}/confirm` | **教师**（含代课）/院系管理员/教务处 | **教师确认**：可带 `{codeId}|{code}|{qrContent}` 三选一 → 置 `status='done'`、记录 `confirmedBy/confirmedName/confirmedAt/confirmedRole`、**消费该动态码** |

### 10.3 `/code/verify` 扩展（向后兼容）

- **会话码**（`codes.session_id` 非空）→ 返回 `isSession:true` + `sessionId` + `sessionInfo`（课程名/实际授课人/班级/日期/节次/地点/发起人）+ `canConfirm` + `confirmEndpoint`
- **旧课表码** → 原行为不变（`isSession:false` + `tasks[]`）

### 10.4 关键规则

| 项 | 规则 |
|---|---|
| 星期约束 | **不再硬校验** `teachDate` 与课表星期一致；不符只记 `isTempAdjusted=true`；**无课表也能发起** |
| 唯一性 | 同 `class_id + teach_date + section + teacher_name`（非 revoked）→ **40901** |
| 课时归属 | 统计（overview/by-dept/by-teacher/by-course/trend）与教师"我的学时"**一律按实际授课人**；非系统内教师单独成行（`registered:false`）不丢学时 |
| 临时调整 | 发起时改 `teacherName/section/place` → `isTempAdjusted=true`，不需审批 |
| 姓名不符 | 确认人姓名 ≠ 实际授课人 → `confirmNameMismatch=true`，**仍算确认成功**（代课老师可确认），后台可筛选 |
| 证据 | 由"签名图/位置"五项改为**四项：动态码 / 确认人 / 确认时间 / 设备** |
| 动态码 | 60 秒 TTL、**一次性消费**、A（二维码）+ B（6 位口令）双通道 |
| 补录 | 补录历史课时**不设** `deadline_at`，避免被 00:05 过期任务置为 `expired` |

> 完整请求/响应示例见 `backend/README.md` 第「四之二 业务流程简化」节。
