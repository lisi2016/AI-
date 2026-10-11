# 课堂课时确认与学时统计 · 后端服务

依据 `docs/miniapp/api-contract.md`（接口契约 v0.1）实现的**后端服务**，与微信小程序前端 `miniprogram/utils/api.js` 的 `/api/v1/*` 接口一一对应。

- 技术栈：**Node.js 18+ / Express**，JSON 文件持久化（零数据库依赖）
- 接口前缀：`/api/v1`
- 默认端口：`8081`
- 统一响应：`{ "code": 0, "msg": "ok", "data": {}, "traceId": "..." }`；错误码见契约第八节

---

## 一、快速开始

```bash
npm install          # 安装依赖（国内可加 --registry=https://registry.npmmirror.com）
npm start            # 或 node server.js
```

启动后：

- 健康检查：`GET http://127.0.0.1:8081/health`（含各表记录数、审计哈希链状态）
- 接口文档：本文档 + `../docs/miniapp/api-contract.md`
- 首次启动会**自动写入演示种子数据**（院系/教学班/教师/班干部/授课任务/**班级课程清单**/演示课时记录）

重置演示数据：

```bash
npm run reset        # 清空 data/*.json，下次启动重新生成种子
```

---

## 二、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8081` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DEV_MODE` | `1` | `1`=不调用微信 `code2Session`（用 code 生成稳定 mock openid，便于无小程序联调）；`0`=调用真实微信接口（需 `WX_APPID`/`WX_APPSECRET`）|
| `WX_APPID` | — | 小程序 AppID（仅 `DEV_MODE=0` 时需要）|
| `WX_APPSECRET` | — | 小程序 AppSecret，**只放服务端，禁止写入代码/仓库/日志** |
| `DATA_DIR` | `./data` | 数据目录 |
| `TOKEN_SECRET` | `dev-token-secret-change-me` | **登录令牌签名密钥 —— 生产必须改成随机长串** |
| `CODE_SECRET` | `dev-code-secret-change-me` | **动态码签名密钥 —— 生产必须改成随机长串** |
| `INTERNAL_JOB_TOKEN` | 空 | 内部定时任务（如 `/records/expire-job`）调用令牌 |
| `TOKEN_TTL_SECONDS` | `604800` | 登录令牌有效期（7 天）|
| `TERM` | `2026-2027-1` | 默认学期 |

---

## 三、目录结构

```
backend/
├── server.js               # 入口：中间件、路由挂载、/admin 静态托管、定时过期任务
├── src/
│   ├── util.js             # 环境变量、时间（Asia/Shanghai）、ID、哈希等
│   ├── store.js            # JSON 文件存储（原子写 + 退出落盘）
│   ├── seed.js             # 演示种子数据
│   ├── auth.js             # 微信登录/绑定/令牌/RBAC
│   ├── webauth.js          # 【新增】Web 后台账号密码：SHA-256 摘要 + 5 次失败锁定 15 分钟
│   ├── records.js          # 课时记录核心：状态机、校验、签名、补签、动态码、实际授课人归属
│   ├── classcourses.js     # 【新增】班级课程清单：CRUD + 按星期带出 + 角色范围 + 软删除
│   ├── sessions.js         # 【新增】课时会话：班干部发起 / 刷新动态码 / 教师确认 / 会话查询
│   ├── freetext.js         # 【新增】自由文本合规公共实现（长度 + 敏感词，records/classcourses/sessions 共用）
│   ├── textfilter.js       # 【新增】自由文本合规：长度校验 + 敏感词检测（内置通用中文敏感词表，零依赖）
│   ├── stats.js            # 统计口径（仅 done/makeup 计入学时；按实际授课人归属）
│   ├── audit.js            # 操作日志（SHA-256 哈希链，可检测篡改）
│   ├── io.js               # 导入/导出（CSV）+ 导入预校验 + 导入前快照/回滚
│   ├── view.js             # 响应视图（字段快照、脱敏）
│   ├── errors.js / http.js # 错误码、响应封装、幂等、traceId、访问日志
│   └── routes/             # auth / records / reviews / admin / classcourses / sessions 路由
├── public/admin/           # 【新增】教务处 Web 管理后台（纯静态，无构建、无前端依赖）
│   ├── index.html          # 外壳：登录页 + 左侧菜单 + 面包屑 + hash 路由
│   ├── css/admin.css
│   └── js/                 # api.js / ui.js / app.js / pages/*.js
├── tools/                  # 自测脚本（smoke-test / rule-test / bind-security-test / admin-web-selftest / session-flow-test / …）
│   └── screenshots/        # 后台页面自测截图（产物，可删）
└── data/                   # 运行数据（首次启动自动生成；已 gitignore）
```

---

## 四、接口清单（`/api/v1`）

| 分组 | 接口 |
|---|---|
| 认证 | `POST /auth/login`（小程序 `code` 分支 / **Web 后台 `no`+`password` 分支**）、`POST /auth/bind`、`GET /auth/me`、`POST /auth/logout`、**`POST /auth/unbind`（自助解绑本人微信）**、**`POST /auth/unbind-self`（未登录自助解绑 / 换绑）**、**`POST /auth/password`** |
| 动态码 | `POST /code/generate`（返回 6 位口令 + 二维码载荷）、`POST /code/verify`（`{codeId}` / `{code}` / `{qrContent}` 三选一；**课时会话码额外返回本次课时信息**） |
| **教学班列表（新增）** | `GET /classes`（供后台「新增课程清单」选班：先取 `classId`，再 `POST /class-courses`） |
| **班级课程清单（新增）** | `GET /class-courses`、`GET /class-courses/today`、`GET /class-courses/{id}`、`POST /class-courses`、`PUT /class-courses/{id}`、`DELETE /class-courses/{id}` |
| **课时会话（新增）** | `POST /sessions`、`POST /sessions/{id}/code`、`GET /sessions`、`GET /sessions/{id}`、`POST /sessions/{id}/confirm` |
| 授课任务 | `GET /tasks?date=`、`GET /tasks/week`、`GET /tasks/{id}` |
| 课时记录 | `POST /records`、`GET /records`、`GET /records/{id}`、`POST /records/{id}/sign`、`/reject`、`/revoke`、`/urge`、`POST /records/expire-job` |
| 补签申诉 | `POST /makeup`、`GET /makeup`、`GET /makeup/{id}`、`POST /makeup/{id}/approve|reject`、`POST /appeal`、`GET /appeal`、`POST /appeal/{id}/approve|reject` |
| 统计 | `GET /stats/overview`、`/stats/by-dept`、`/stats/by-teacher`、`/stats/by-course`、`/stats/trend` |
| 导入导出 | `POST /export/records|stats`、**`GET /export/history`**、`GET /export/{jobId}`、**`POST /import/precheck`**、`POST /import/depts|classes|tasks|students|whitelist|cadres`、**`GET /import/history`**、`GET /import/{jobId}`、**`POST /import/{jobId}/rollback`**、`GET /import/template`（`?data=1` 可导出主数据含 ID） |
| 配置日志文件 | `GET|PUT /config`、`GET /logs`、**`GET /logs/verify`**、`POST /files/signature`、`GET /files/{id}` |
| 探活 | `GET /health` |

> 加粗项为支撑 Web 管理后台新增的接口，新增接口均为纯增量。
>
> **本次合规改造带来的接口行为变化**（详见下方「签名证据（四项）与不采集定位」「自由文本合规」两节）：
> 1. `GET /records/{id}` 的 `evidence` 由五项改为**四项**，不再返回 `location` / `latitude` / `longitude` / `locationDenied`；`shapeRecord` 同样不再输出这四个字段。
> 2. `POST /records` 的 `location` / `locationDenied` 与 `POST /records/{id}/sign` 的 `latitude` / `longitude` / `locationDenied` 变为**被忽略的兼容入参**（传入不报错）。
> 3. 自由文本命中敏感词由「打码后入库 + warnings」改为**直接 `40001` 拦截**（`record.create` 的 `warnings` 固定为空数组，保持字段存在以免破坏客户端解析）。
> 4. `PUT /config` 新增 `sensitive_words` / `max_summary_len` / `max_absent_names_len` / `max_reason_len`（旧键 `max_summary_length` 仍可提交，服务启动时会自动迁移到 `max_summary_len`）。
>
> **本次安全修复与统计口径修复带来的接口变化**（详见下方「绑定安全（bindTicket 强制校验）」「记录列表各状态角标（statusTotals）」两节）：
> 5. `POST /auth/bind` **不再接受仅凭请求体 `openid` 绑定**：`DEV_MODE=0` 时必须提供有效且未过期的 `bindTicket`，且请求体 `openid`（若传）必须与票据一致（票据缺失/无效/过期 → `40101`，openid 不一致 → `40301`）。
> 6. `GET /records` 的 `summary` **新增 `statusTotals`**（不受 `status=` 筛选影响的 8 状态计数，按角色可见范围统计）；原有 `byStatus`（受筛选影响）与 `hours` **语义不变**，纯增量、向后兼容。
>
> **本次「自助解绑 / 换绑」带来的接口与行为变化**（详见下方「自助解绑 / 换绑」一节）：
> 7. 新增 `POST /auth/unbind`（需登录，解绑本人）与 `POST /auth/unbind-self`（未登录可用，用于"换了新微信、登不进去"），两个接口均为**纯增量**；`POST /auth/bind`、登录与其它接口的请求/响应结构**完全不变**。
> 8. 令牌 payload 新增绑定世代 `ep`（`users[].auth_epoch`，缺省 0），`currentUser` 增加世代校验：**解绑会把该工号此前签发的所有令牌一并作废**（否则"旧微信"手里的未过期 token 仍能以该工号身份操作）。老令牌无 `ep` → 按 0 处理，与从未解绑的用户一致，**向后兼容**。
> 9. 新增数据表 `data/unbind_requests.json`（`store` 表 `unbind_requests`），用于 `POST /auth/unbind-self` 的频率限制与留痕。

**核心校验**（服务端强制执行，契约"必须做的校验"）：
唯一性（同教师+课程+教学班+日期+节次仅一条有效）、**提交人 ≠ 签字人**、签字人须在教学班授权名单内、上课日期不得为未来、状态机流转、动态码 60 秒过期且一次性消费、按角色越权拦截、**绑定必须凭 bindTicket（生产环境不接受裸 openid）**。

### 绑定安全（bindTicket 强制校验）

`POST /auth/bind` 的 `openid` 获取规则（修复前：请求体只要带 `openid` 就能绑定，可伪造任意 openid 抢占他人工号/学号）：

| 环境 | 是否必须带 `bindTicket` | 请求体 `openid` 的作用 |
|---|---|---|
| `DEV_MODE=0`（生产） | **必须**，且必须未过期（`/auth/login` 未绑定时下发，30 分钟有效） | 仅用于与票据内 openid 比对；**必须一致**，且不能单独作为绑定凭据 |
| `DEV_MODE=1`（开发） | 可不带（保留无小程序联调路径） | 不带票据时可直接作为 openid 使用；**一旦传了 `bindTicket`，就必须校验票据有效性与一致性** |

错误语义：

| 场景 | 错误码 | 说明 |
|---|---|---|
| 未传 `bindTicket`（`DEV_MODE=0`） | `40101` | 提示必须先经 `/auth/login` 获取票据，明确拒绝"仅凭 openid 绑定" |
| `bindTicket` 无效 / 被篡改 / 已过期 | `40101` | 提示票据无效或已过期，需重新登录获取 |
| 请求体 `openid` 与票据内 openid 不一致 | `40301` | 明示票据 openid 与请求体 openid（均为前缀脱敏展示），禁止用他人 openid 绑定 |

- 上述被拒绝的请求写入操作日志 `auth.bind.reject`（`after.reason` 为 `missing_ticket` / `invalid_ticket` / `openid_mismatch`），可用 `GET /logs?action=auth.bind.reject` 追溯。
- 成功路径的响应结构（`{token, tokenType, expiresAt, needBind, role, user}`）与白名单校验逻辑（工号/学号 + 姓名 + 角色 + 教学班）**完全不变**。

### 自助解绑 / 换绑（`POST /auth/unbind` · `POST /auth/unbind-self`）

**背景**：一个工号/学号只能绑定一个微信。老师换手机 / 换微信后原本必须找教务处人工解绑。现改为小程序自助，分两条通道：

| 场景 | 接口 | 是否需要登录 | 小程序入口 |
|---|---|---|---|
| **旧微信还能登录**（换手机、想把工号挪到另一个微信） | `POST /auth/unbind` | **需要**（凭 token 识别本人） | 「我的」页 →「解绑当前微信」 |
| **旧微信登不进去**（换了新微信 / 微信被封 / 卸载重装后收不到原登录态） | `POST /auth/unbind-self` | **不需要**（弱凭证 + 频率限制） | 绑定页失败提示区的「自助解绑并重新绑定」 |

两条通道的语义**严格限定为"解除登录绑定"**：
- 清空 `users[].openid`（同时清空恒为空的 `unionid`），使该工号/学号可被其它微信重新绑定；
- **不删除**用户档案（`users` 行保留，`id` / 姓名 / 工号 / 状态不变）；
- **不改动**任何历史课时、课时记录、统计与审计数据（`period_records`、`audit_logs` 逐条不变）；
- **不采集定位**：两个接口都不读取、不返回任何位置字段（`location` / `latitude` / `longitude` 均不出现）。

#### （1）`POST /auth/unbind`（需登录，解绑本人）

```bash
curl -X POST http://127.0.0.1:8081/api/v1/auth/unbind -H "Authorization: Bearer <token>"
```
```json
{ "code": 0, "msg": "ok", "traceId": "…",
  "data": { "ok": true, "no": "2010032", "realName": "唐瑞明", "unbound": true,
            "hint": "解绑成功：当前令牌已失效；该工号/学号可被其它微信重新绑定，历史课时数据不受影响" } }
```

- **调用返回前先注销当前 token**（`auth.revokeToken`），并把该用户的绑定世代 `auth_epoch +1` → 该工号**此前签发的所有令牌**同时失效（含"旧微信"手里那张），避免解绑后旧设备继续以该工号身份操作。
- 审计：`auth.unbind`，`after = { no, realName, openidPrefix }`，其中 `openidPrefix` 为**原 openid 前 8 位 + 长度**的脱敏形式（不写完整标识）。
- 未登录调用 → `40101`；再次用已失效令牌调用 → `40101`。

#### （2）`POST /auth/unbind-self`（未登录可用）

```bash
curl -X POST http://127.0.0.1:8081/api/v1/auth/unbind-self \
  -H "Content-Type: application/json" -H "X-Device: iPhone" \
  -d '{"no":"2010032","realName":"唐瑞明"}'
```
```json
{ "code": 0, "msg": "ok", "traceId": "…",
  "data": { "ok": true, "no": "2010032", "realName": "唐瑞明", "hadBinding": true } }
```

- 入参 `{ no, realName }`（`no` 支持**工号或学号**，也接受别名 `staffNo` / `studentNo` / `name`）。
- 校验：`no` 必须在白名单内（`whitelist.status = 'active'`）且 `real_name` 与 `no` **完全一致**；否则 `40301`。
  - 「不在白名单」与「姓名不符」返回**同一条提示**（仅回显用户自己提交的工号），避免该接口被用来探测工号是否存在。
  - 姓名不符时**不做任何解绑**（openid 原样保留）。
- 幂等：该工号本就没有绑定 → 仍然成功，返回 `hadBinding: false`。
- 审计：`auth.unbind.self`（**成功、姓名不符、限流三种情况都写**），`after = { no, realName, ip, device, hadBinding, allowed, reason, openidPrefix? }`。
- 接口索引页（`GET /api/v1/`）的 `selfUnbind` 字段同步给出上述安全说明，便于运维核对。

#### （3）频率限制（必须实现的部分）

| 维度 | 上限 | 窗口 | 计数口径 |
|---|---|---|---|
| 同一 `no` | **2 次** | 24 小时 | 进入业务处理的请求（**成功 + 姓名不符被拒**都计数） |
| 同一 IP | **5 次** | 1 小时 | 同上 |

- 超限 → `40001`，`msg` 明确且可操作：
  - `该工号/学号今日自助解绑次数已达上限（同一工号 24 小时 内最多 2 次），请联系教务处解绑`
  - `当前网络自助解绑次数已达上限（同一 IP 1 小时 内最多 5 次），请稍后再试或联系教务处解绑`
- **已被限流直接拒绝的请求不再重复计数**：否则攻击者连续刷请求就能把受害者的等待窗口无限往后推。
- 计数与留痕落在新表 **`data/unbind_requests.json`**（`store` 表 `unbind_requests`），字段：

  | 字段 | 说明 |
  |---|---|
  | `id` | `UB` + 8 位自增序号（`_meta.json` 计数器） |
  | `no` / `real_name` | 请求提交的工号/学号与姓名（姓名不符时记录的是**提交值**，便于追溯爆破尝试） |
  | `ip` / `device` | 客户端 IP（`X-Forwarded-For` 优先，与审计同口径）与 `X-Device`/UA |
  | `had_binding` | 解绑前是否确有绑定（姓名不符等未执行的请求为 `false`） |
  | `allowed` / `reason` | 是否放行 / 原因（`ok`、`name_mismatch`、`not_in_whitelist`） |
  | `created_at` / `created_at_ms` | 落库时间（窗口统计用毫秒值） |

- **保留策略**：仅保留最近 **7 天**的记录（`RETENTION_MS`），另有 `MAX_RECORDS = 5000` 条上限兜底，避免文件无限增长。
- 限额常量集中在 `src/unbind.js` 的 `LIMITS`（`{ no: {max:2, windowMs:24h}, ip: {max:5, windowMs:1h} }`），自测直接引用，避免文档与实现漂移。

#### （4）安全设计说明（弱凭证的风险与缓解）

`POST /auth/unbind-self` 是**未登录**接口，凭证只可能是"工号/学号 + 姓名"这类**弱凭证**（工号常出现在课表/公示里，姓名也不算秘密）。风险与已实现的缓解措施：

| 风险 | 缓解措施（已实现） |
|---|---|
| 猜姓名批量解绑他人微信（拒绝服务 / 抢占绑定） | 姓名必须与白名单**完全一致**才执行解绑；失败尝试同样计数 → 每个工号每 24 小时最多试 2 次，每 IP 每小时最多 5 次 |
| 通过响应差异探测某工号是否存在 / 姓名是否为某人 | 「不在白名单」与「姓名不符」返回**同一条 `40301` 提示与同一个 HTTP 状态码**，不返回白名单姓名，不返回额外信息 |
| 解绑后旧微信仍持有效令牌继续操作 | 解绑把 `auth_epoch +1`，`currentUser` 校验世代 → **该工号此前签发的所有令牌立即失效**（`40101`，提示"微信绑定已变更"）；同时调用方令牌被显式 `revokeToken` |
| 恶意解绑他人微信（无凭证也知道工号+姓名） | 频率限制 + **审计留痕**（IP/设备/姓名/时间/是否确有绑定全部记录，可用 `GET /logs?action=auth.unbind.self` 追溯与告警） |
| IP 维度限流被伪造 `X-Forwarded-For` 绕过 | 见下方"生产加固建议"：反向代理必须**覆写**该头；生产建议同时在网关层限流 |
| 解绑本身是"低危但不可逆"的动作 | 两个接口都只解除绑定，**不动任何业务数据**；UI 侧（小程序）强制二次确认，并明确提示"历史课时数据不受影响" |

**生产加固建议（本次未实现，属于后续增强项）**：
1. 在弱凭证之上**再叠加一层强凭证**：短信验证码 / 学校统一认证（CAS、企业微信、钉钉）/ 企业微信扫码；可在 `/config` 增加开关，默认关闭以便平滑上线。
2. 网关层（Nginx / 云 WAF）对 `/auth/unbind-self` 做单 IP 与全局限流；Nginx 反代必须 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` **覆写**该头（当前实现的 IP 维度限制依赖它）。
3. 对"同一 IP 短时间命中多个不同工号"的模式做告警（`auth.unbind.self` 已记录全部要素，可直接在后台日志页筛）。
4. 保留教务处人工解绑兜底入口（`users.openid` 置空即可，与本次实现同一字段）。

#### （5）小程序端（自助换绑闭环）

- 「我的」页新增「解绑当前微信」：`wx.showModal` 二次确认 → `POST /auth/unbind` → `session.clearSession()` → 提示并回首页绑定引导。
- 绑定页在**绑定失败且 `msg` 命中「已被其他微信绑定」**时，错误区显示「自助解绑并重新绑定」：弹窗展示将解绑的工号 + 姓名（要求确认姓名无误）→ `POST /auth/unbind-self` → **成功后自动重试一次绑定**（`wx.login` → `/auth/login` → `/auth/bind`）→ 成功即回首页。
- 解绑接口返回的频率 / 校验错误**原样展示 `msg`** 并附可操作建议（稍后再试、联系教务处、核对姓名）。
- `useMock = true`（离线演示）时，`utils/mock-unbind.js` 提供**同口径**的 mock 语义（`hadBinding`、`40301`、`40001` 限流），零网络请求。

### 记录列表各状态角标（statusTotals）

`GET /records` 的 `summary` 现在同时给出两套计数：

| 字段 | 是否受 `status=` 影响 | 口径 | 用途 |
|---|---|---|---|
| `hours` | 是 | 当前筛选结果中 `done` / `makeup` 的学时合计 | 现有页面文案（不变） |
| `byStatus` | 是 | 当前筛选结果内各状态条数（缺省状态不出现） | 兼容旧前端（**语义不变**） |
| `statusTotals` | **否** | 当前用户**可见范围**内的各状态条数，固定返回全部 8 种状态（`draft` / `wait` / `done` / `rejected` / `expired` / `appealing` / `makeup` / `revoked`，无记录为 `0`） | 标签/角标「各状态数量」 |

- 可见范围与列表权限一致：教师=本人记录；班干部=`signer_id` 为本人（**且不受"默认可见状态"收窄影响**，8 种状态全给）；院系管理员=本院系；教务处=全部。
- 其余非 `status` 的筛选条件（`from` / `to` / `teacherId` / `classId` / `term` / `keyword` 等）仍会生效，保证角标与列表范围一致。
- 典型场景：前端切到 `status=wait` 时，`byStatus` 只剩 `{wait:n}`，而 `statusTotals.wait` / `statusTotals.done` / … 仍然各有其值，可直接渲染"待确认 3 / 已确认 12 / 已过期 2"。

### 动态确认码：A 真二维码 + B 6 位数字口令（双通道）

班干部出示动态码 → 教师**扫码（A）**或**手输 6 位口令（B）** → 教师填信息提交 → 班干部核对签名。两条通道最终都解析到**同一个 `codeId`**，共用 60 秒 TTL 与「一次性消费」规则。

**`POST /code/generate`**（班干部 / 管理员）响应新增字段：

| 字段 | 说明 |
|---|---|
| `code` | **6 位数字口令**（`000000`–`999999`，允许前导零）。生成时在**当前有效且未消费**的码中保证唯一，冲突自动重试（最多 200 次） |
| `codeLength` | 固定 `6`，便于前端做输入位数校验 |
| `qrPayload` | 二维码要编码的字符串，形如 `kcsq://code/CD00000012` |
| `qrUrl` | `qrPayload` 的**兼容别名**（历史前端读该字段） |
| `channels` | `{ qr: {payload, hint}, code: {value, hint} }`，给前端直接渲染两条通道提示 |
| `codeId` / `expireAt` / `expireAtMs` / `ttl` / `sign` / `className` / `cadre` | 与旧版本一致（`ttl` 默认 60 秒） |

**`POST /code/verify`**（教师）入参三选一：

| 入参 | 场景 | 说明 |
|---|---|---|
| `{ "qrContent": "kcsq://code/CD00000012" }` | A 扫码发起 | 支持 `kcsq://code/<codeId>`、历史载荷 `kcsq://confirm?codeId=..&sign=..&exp=..`、任意带 `codeId` 查询参数的 URL；扫码内容为裸 codeId / 裸 6 位口令时同样可解析 |
| `{ "code": "042317" }` | B 手输口令 | 6 位数字口令，按「未消费的码」查最新一条 |
| `{ "codeId": "CD00000012" }` | 调试 / 直传 | 也可用旧写法 `{ "code": "CD00000012" }`（非 6 位数字时按 codeId 兼容处理） |

响应新增 `verifyBy`（`codeId` / `code` / `qrContent`）与 `channel`（`codeId` / `code` / `qr`，即"用哪条通道核验的"），其余结构不变（班干部身份 + 该班当日授课任务列表）。

错误码保持不变：解析失败或查不到 → `40401`；过期 → `41001`；已消费 → `41002`（消费发生在 `POST /records`，`verify` 本身不消费）。

> 审计：`code.generate` 日志记录 `passCode` 与 `qrPayload`，`code.verify` 日志记录本次使用的通道，便于事后追溯"谁签发的口令/二维码、教师走的哪条通道"。
> 二维码图片**由前端渲染**（小程序 `miniprogram/utils/qrcode.js` 纯 JS 编码器，零依赖），服务端只下发载荷字符串，不下发图片、不需新增依赖。

### 证据四项与「不采集定位」

- **新流程（班干部发起 + 教师扫码确认）证据四项 = 动态码 / 确认人 / 确认时间 / 设备**：由 `GET /sessions/{id}` 的 `session.evidence` 返回（`evidence.labels = ['动态码','确认人','确认时间','设备']`，取值字段 `codeId` / `confirmedName`(+`confirmedRole`) / `confirmedAt` / `device`(+`ip`)，另有 `nameMismatch` 标记确认人≠实际授课人）。管理后台课时明细/补签/申诉详情抽屉按此四项渲染，**不渲染签名图、不展示定位**。
- **旧流程兼容**：`GET /records/{id}` 的 `evidence` 仍固定为**四项**：**签名图 / 确认时间 / 设备 / 动态码**（`evidence.count = 4`，`evidence.labels = ['签名图','确认时间','设备','动态码']`）——这是历史数据与旧客户端的兼容契约，保持不变。
- **本服务不采集定位/位置信息**：`POST /records` 与 `POST /records/{id}/sign` 都不读取 `location` / `latitude` / `longitude` / `locationDenied`（客户端若仍传入 → **忽略且不报错**，向后兼容）；所有响应中也不再出现 `location` / `latitude` / `longitude` / `locationDenied` 字段。
- `t_signature` 表的 `latitude` / `longitude` / `location_denied` 三列**仅为兼容历史数据保留**，新写入固定为 `null`（种子数据同样为空）。
- 隐私合规：历史数据中若仍存有精确坐标，可按需一次性清理（本服务不再读取、不再返回，故不影响业务）：
  `node -e "const fs=require('fs'),p='data/signatures.json';const a=JSON.parse(fs.readFileSync(p,'utf8'));a.forEach(s=>{s.latitude=null;s.longitude=null;s.location_denied=null;});fs.writeFileSync(p,JSON.stringify(a,null,2));console.log('已清空 '+a.length+' 条签名行的位置字段')"`

### 自由文本合规（契约第六节第 6 条）

教师/班干部填写的自由文本统一走 `src/textfilter.js`：**长度校验 + 敏感词检测**，命中即返回 `40001` 且**不落库**，同时写操作日志（audit）。

| 字段 | 入参 | 长度上限配置项 | 默认上限 | 必填 |
|---|---|---|---|---|
| 授课摘要 | `summary` | `max_summary_len` | 500 字符 | 否 |
| 缺勤姓名 | `absentNames` | `max_absent_names_len` | 300 字符 | 否 |
| 补签理由 / 申诉理由 / 拒绝原因 / 撤销原因 | `reason` | `max_reason_len` | 500 字符 | 补签/申诉/拒绝必填 |
| 备注 / 审核意见 | `note` | `max_reason_len` | 500 字符 | 驳回补签/申诉时必填 |

- 长度按 **Unicode 码点**计算（中文与 emoji 各算 1 个字符），**不做静默截断**。
- **命中敏感词**：`40001`，`msg` 形如 `内容包含敏感词：代签、包过（授课摘要），请修改后重新提交`；`data.details` 含 `{field, label, reason:'sensitive', hits:[...]}`。
- **超长 / 必填为空**：同样 `40001`，提示形如 `授课摘要过长：当前 501 字符，最多 500 字符`、`拒绝原因不能为空，请填写后重新提交`。
- 审计日志：敏感词命中写 `text.sensitive.blocked`，长度/空值问题写 `text.invalid.blocked`（`targetId` 为字段名，`detail` 为完整提示），可用 `GET /logs?action=text.sensitive.blocked` 追溯被拦截的提交。
- 拦截发生在**落库之前**：被拦截的请求不会产生记录、不会消费动态码、也不会改变原记录状态。
- 内置词表为通用中文敏感词表（69 条，覆盖代签/作弊、违规代办、赌博毒品、恐怖邪教、色情低俗、辱骂等），**可由 `PUT /config` 的 `sensitive_words` 整体覆盖**（逗号/顿号分隔，留空 = 不启用敏感词过滤），保存后**立即生效**（无需重启）。

---

## 四之二、业务流程简化：班级课程清单 + 课时会话（班干部发起 · 教师扫码确认）

> 本版把原「教师填写发起 → 班干部签名」改为**学生（班干部/学委）驱动 + 教师仅扫码确认**的轻流程：
> **班干部录入一次课程清单（长期保留）→ 每次上课从清单带出 → 允许临时调整（无需审批）→ 出示 60 秒动态码 → 任课教师扫码看到本次课时信息 → 点一下「确认」→ 该次课时完成。**
> 不再手写签名、不填表；学时按**实际授课人**统计。
>
> **取消**：调课记录、停课记录、审批流程。**保留**：动态码 60 秒一次性、操作留痕（审计哈希链）、旧接口全部可用（历史数据与旧客户端零迁移）。

### 4.2.1 新增数据表 `data/class_courses.json`（班级课程清单）

| 字段 | 说明 |
|---|---|
| `id` | `CR` + 8 位序号 |
| `class_id` / `class_name` / `dept_id` | 教学班与院系（快照） |
| `course_name` | 课程名称（必填，≤60 字符，过敏感词） |
| `teacher_name` | 授课老师（必填，≤30 字符，过敏感词） |
| `teacher_no` | 工号（可空，便于按工号匹配实际授课人） |
| `weekday` | 1–7，**可空**（空 = 未排课） |
| `section` / `start_time` / `end_time` | 节次与起止时间（按内置节次表自动补全） |
| `place` | 上课地点（可空，≤60 字符，过敏感词） |
| `hours` | 学时（0–100，默认 2） |
| `term` | 学期（默认取 `/config` 的 `term`） |
| `status` | `active` / `archived`（**软删除**） |
| `created_by` / `created_at` / `updated_at` | 留痕 |

### 4.2.2 `t_period_record` 扩展字段（课时会话，保持旧数据兼容）

| 字段 | 说明 |
|---|---|
| `origin` | `session` = 班干部发起（旧数据无此字段；`initiator_id` 非空同样按会话处理） |
| `course_id` | 关联课程清单（可空） |
| `teacher_name` / `teacher_no` / `teacher_id` | **实际授课人**（`teacher_id` 在姓名/工号能匹配到系统内教师时自动回填） |
| `initiator_id` / `initiator_name` / `initiator_duty` | 发起人（班干部） |
| `is_temp_adjusted` | 本次是否临时调整（0/1） |
| `confirmed_by` / `confirmed_name` / `confirmed_at` / `confirmed_role` | 教师确认信息 |
| `confirm_ip` / `confirm_device` | 确认时的设备/IP 留痕 |
| `confirm_name_mismatch` | 确认人姓名 ≠ 实际授课人（0/1，代课情形，**仍然成功**） |
| 状态机 | `wait`（待教师确认）→ `done`（教师确认）；沿用 `expired`（当天 24 点未确认）/ `revoked`，并按需支持旧状态 |

### 4.2.3 接口清单与请求/响应示例

所有接口均需 `Authorization: Bearer <token>`；响应统一 `{code, msg, data, traceId}`。

#### （1）教学班列表 —— `GET /classes`

`POST /class-courses` 必须带 `classId`，因此后台需要先取教学班列表才能录入第一条课程。

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/classes?deptId=&keyword=&classId=&status=&page=&pageSize=` | 班干部=**仅本班**；教师=**全部**（可按班/院系/关键字收窄）；院系管理员=**本院系**；教务处=全部 |

- 数据取自 `t_class`（`data/classes.json`），`deptName` 由 `t_dept` 关联；`status` 默认 `active`，`status=all` 查全部。
- 返回 `{ list: [{ id, classId, name, className, grade, deptId, deptName, advisor, status, cadreCount, studentCount }], total, page, pageSize }`；
  `id` 与 `classId` 同值，直接作为 `POST /class-courses` 的 `classId` 传入。
- `cadreCount` / `studentCount` 为该班 active 班干部数 / 学生数（便于后台核对选对班级）。
- 越权：班干部带 `classId` 查别班 → `40301`；非四种角色 → `40301`。

```http
GET /api/v1/classes?deptId=D00000001&keyword=护理&page=1&pageSize=20
```

```json
{ "code": 0, "msg": "ok", "data": {
  "list": [{ "id": "C00000001", "classId": "C00000001", "name": "2025级护理3班", "className": "2025级护理3班",
             "grade": "2025", "deptId": "D00000001", "deptName": "护理学院", "advisor": "唐瑞明",
             "status": "active", "cadreCount": 2, "studentCount": 28 }],
  "total": 1, "page": 1, "pageSize": 20
}, "traceId": "…" }
```

#### （2）班级课程清单

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/class-courses?classId=&keyword=&status=&term=&weekday=&page=&pageSize=` | 班干部=本班；教师=可按班查询；院系管理员=本院系；教务处=全部 |
| `GET` | `/class-courses/today?date=YYYY-MM-DD[&classId=]` | 同上（按该日期的星期带出当天课程） |
| `GET` | `/class-courses/{id}` | 同上 |
| `POST` | `/class-courses` | 班干部（**仅本班**）/ 院系管理员（本院系）/ 教务处 |
| `PUT` | `/class-courses/{id}` | 同上（部分字段更新；**不可改教学班**） |
| `DELETE` | `/class-courses/{id}` | 同上（软删除 → `status='archived'`；重复删除 `42201`） |

```http
POST /api/v1/class-courses
{ "courseName": "信息技术", "teacherName": "唐瑞明", "weekday": 3, "section": "1-2",
  "place": "实训楼A302", "hours": 2 }
```

```json
{ "code": 0, "msg": "ok", "data": {
  "id": "CR00000001", "classCourseId": "CR00000001",
  "classId": "C00000001", "className": "2025级护理3班", "deptId": "D00000001", "deptName": "护理学院",
  "courseName": "信息技术", "teacherName": "唐瑞明", "teacherNo": "2010032",
  "weekday": 3, "weekdayText": "周三", "section": "1-2",
  "startTime": "08:00", "endTime": "09:40", "time": "08:00–09:40",
  "place": "实训楼A302", "hours": 2, "term": "2026-2027-1",
  "status": "active", "statusText": "使用中", "archived": false,
  "createdBy": "U00000009", "createdByName": "张一鸣", "createdAt": "2026-09-27T17:00:00+08:00", "updatedAt": "…"
}, "traceId": "…" }
```

`GET /class-courses/today?date=2026-09-23` → `data = { date, weekday, weekdayText, total, list:[…] }`（`weekday` 为该日期的星期，`list` 只含该星期有课的课程）。

#### （3）课时会话

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/sessions` | 班干部（本班）/ 院系管理员（本院系）/ 教务处 | 发起一次课时并签发 60 秒动态码 |
| `POST` | `/sessions/{id}/code` | 同上（发起人 / 本班 active 班干部 / 本院系管理员 / 教务处） | 二维码过期后刷新（仅 `wait` 可刷新，否则 `42201`） |
| `GET` | `/sessions?date=&status=&from=&to=&classId=&courseId=&teacherName=&tempAdjusted=&nameMismatch=&page=&pageSize=` | 班干部=本班；教师=本人为实际授课人或本人确认过；院系管理员=本院系；教务处=全部 | 列表 + `summary.hours` / `byStatus` / `statusTotals`（8 状态角标）|
| `GET` | `/sessions/{id}` | 同上 + 教师可看仍 `wait` 的会话 | 详情：课程、实际授课人、班级、节次、地点、发起人、确认信息、证据、最近留痕 |
| `POST` | `/sessions/{id}/confirm` | 教师 / 院系管理员（本院系）/ 教务处 | 教师确认：消费动态码 → `status='done'` |

```http
POST /api/v1/sessions
{ "courseId": "CR00000001", "courseName": "信息技术", "teacherName": "唐瑞明",
  "teachDate": "2026-09-23", "section": "1-2", "place": "实训楼A302", "hours": 2,
  "summary": "第 3 章 数据库基础", "absentCount": 1, "absentNames": "李思琪", "discipline": "good" }
```

```json
{ "code": 0, "msg": "ok", "data": {
  "sessionId": "R00000031",
  "codeId": "CD00000012", "code": "042317", "codeLength": 6,
  "qrPayload": "kcsq://code/CD00000012", "qrUrl": "kcsq://code/CD00000012",
  "sign": "…", "expireAt": "2026-09-23T10:06:00+08:00", "expireAtMs": 1790000000000, "ttl": 60,
  "adopted": false,
  "channels": { "qr": { "payload": "kcsq://code/CD00000012", "hint": "任课教师用「扫码」扫描此二维码" },
                "code": { "value": "042317", "hint": "任课教师也可手输这 6 位数字口令" } },
  "session": { "sessionId": "R00000031", "courseId": "CR00000001", "courseName": "信息技术",
               "teacherName": "唐瑞明", "teacherId": "U00000001", "className": "2025级护理3班",
               "teachDate": "2026-09-23", "section": "1-2", "place": "实训楼A302", "hours": 2,
               "status": "wait", "statusText": "待教师确认", "isTempAdjusted": false,
               "initiatorId": "U00000009", "initiatorName": "张一鸣", "initiatorDuty": "学委",
               "canConfirm": true, "canRefreshCode": true, "…": "…" }
}, "traceId": "…" }
```

- **校验**：`teachDate` 不得为未来（`40001`）；班干部只能为本班发起（`40301`）；班干部/管理员角色限制（教师调用 `40301`）；`courseName`/`teacherName` 必填且过敏感词/长度校验（`40001`）；同 `class_id + teach_date + section + teacher_name` 重复 → **`40901`**（`data.details.existingId`/`existingSessionId`）。
- **无课表也能发起**：清单里没有这门课、课表里也没有，同样可以发起（不算临时调整）。
- **不再硬拦截星期**：与课程清单/课表星期不符时记 `is_temp_adjusted=true`（不报错）。
- **兼容升级**：若冲突行是旧流程遗留的 `wait` 记录（无 `initiator_id`），`POST /sessions` 会把它**升级为会话**（同一 `id`，`adopted: true`），不重复建行。

```http
POST /api/v1/sessions/R00000031/confirm
{ "codeId": "CD00000012" }
```

```json
{ "code": 0, "msg": "ok", "data": {
  "ok": true, "sessionId": "R00000031", "status": "done", "counted": true,
  "nameMismatch": false, "codeConsumed": "CD00000012",
  "confirmedBy": "U00000001", "confirmedName": "唐瑞明", "confirmedAt": "2026-09-23T10:05:12+08:00",
  "confirmedRole": "teacher", "teacherName": "唐瑞明",
  "msg": "已确认本次课时", "session": { "…": "…" }
}, "traceId": "…" }
```

- 入参可带 `{codeId}` / `{code}`（6 位口令）/ `{qrContent}`（扫码内容）三选一，用于消费动态码；不带则默认消费该会话最新有效码。
- **一次性消费**：码已用 → `41002`；码过期 → `41001`；码属于别的会话 → `40001`；会话已确认（不带码）→ `42201`。
- **确认人 ≠ 实际授课人**：置 `confirm_name_mismatch=true` 但**仍然成功**（代课老师也能确认），可用 `GET /sessions?nameMismatch=true` 筛选提醒。

#### （4）`POST /code/verify` 行为变化（向后兼容）

| 情形 | 返回 |
|---|---|
| 动态码是**课时会话码**（`codes.session_id` 非空） | `isSession: true` + `sessionId` + `session` / `sessionInfo`（课程名/实际授课人/班级/日期/节次/地点/发起人）+ `canConfirm` + `confirmEndpoint`；兼容字段 `cadre`/`classId`/`className`/`tasks`(空数组)/`myTasks` 仍在 |
| 旧课表码（`session_id` 为空） | **原行为不变**：`isSession: false` + 班干部身份 + 该班当日授课任务列表 |

#### （5）统计口径：按**实际授课人**

- `GET /stats/overview` / `by-dept` / `by-teacher` / `by-course` / `trend` 全部改为按**实际授课人**（`teacher_name`，有 `teacher_id` 时优先用 id）归属；教师端「我的学时」同样按实际授课人。
- 学时只计 `done` / `makeup`；去重规则：有 `task_id` 按 `task_id+日期+节次`（合班课程不重复累加），无 `task_id` 的会话按 `教学班+课程+实际授课人+日期+节次`。
- 非系统内教师（外聘/外院，`teacher_id` 为空）**按姓名单独成行**，`registered: false`；同名系统内教师存在时自动按 id 归并（不丢学时）。`by-teacher.totalHours` 与 `overview.confirmedHours` 始终一致。
- `GET /stats/overview` 新增：`tempAdjustedCount`（临时调整次数）、`nameMismatchCount`（确认人≠实际授课人）、`sessionCount` / `sessionDoneCount`（班干部发起的课时数）。
- `GET /stats/by-dept` 按**实际授课人所属院系**归属（找不到教师档案时回退教学班院系），应计学时同样按教师院系推算。

#### （6）导出列变化：课时明细表头 **18 → 21 列**（`POST /export/records`）

`EXPORT_HEADERS` 列顺序固定，**不因筛选条件变化而缺列**；本次补齐新流程三列，并把「签字人」列名改为「发起人（学委）」：

| # | 列名 | 取值 | 说明 |
|---|---|---|---|
| 0–10 | 学期 / 教师姓名 / 工号 / 院系 / 课程 / 教学班 / 上课日期 / 节次 / 应计学时 / 状态 / 是否补签 | 同旧版 | 「教师姓名」= **实际授课人** |
| 11 | ~~签字人~~ → **发起人（学委）** | `signer_name` | 新流程中 `signer_*` 同步为发起人（班干部/学委），旧流程为签字人 |
| 12–13 | 签字人职务 / 是否现场指定 | `signer_duty` / `signer_is_adhoc` | 列名保持不变（仅第 11 列改名，避免破坏既有列序约定） |
| **14** | **确认人** | `confirmed_name` | 新流程：教师确认人姓名；旧流程数据为空 |
| **15** | **是否临时调整** | `is_temp_adjusted` → 是/否 | 新流程（`origin='session'` 或有发起人）恒有值；旧流程数据为空 |
| **16** | **确认人与实际授课人不符** | `confirm_name_mismatch` → 是/否 | 同上；代课情形为「是」但本次课时仍有效 |
| 17–20 | 确认时间 / 缺勤人数 / 缺勤姓名 / 课堂纪律 | 同旧版 | |

- 「旧流程数据输出空」的判定与视图层 `sessionId` 口径一致：`origin === 'session'` 或 `initiator_id` 非空即为新流程。
- 导出仍不含签名图 URL 列、不含任何定位信息。
- `POST /export/stats` 的「全校概览」段同步新增 `临时调整` / `姓名不符` 两列（与 `GET /stats/overview` 的 `tempAdjustedCount` / `nameMismatchCount` 同源）；分教师 / 分院系 / 分课程三段的归属口径本来就是**实际授课人**，无需变更。

### 4.2.4 权限矩阵（新增接口）

| 能力 | 班干部 | 教师 | 院系管理员 | 教务处 |
|---|---|---|---|---|
| 教学班列表（`GET /classes`） | 本班 | 全部（只读） | 本院系 | 全部 |
| 课程清单 读 | 本班 | 任意班（只读） | 本院系 | 全部 |
| 课程清单 写 | 本班 | ✗ | 本院系 | 全部 |
| 发起课时 / 刷新动态码 | 本班 | ✗ | 本院系 | 全部 |
| 扫码核验（`/code/verify`） | — | ✔ | ✔ | ✔ |
| 确认课时（`/sessions/{id}/confirm`） | ✗ | ✔（含代课） | 本院系 | ✔ |
| 会话列表/详情 | 本班 | 本人实际授课或本人确认过（`wait` 会话可读） | 本院系 | 全部 |

### 4.2.5 兼容与未做

- **旧接口一律保留**：`POST /records`、`POST /records/{id}/sign|reject|revoke|urge`、补签/申诉、导出导入全部不删；会话就是 `t_period_record` 的一行，因此旧列表/详情/导出/审计都能读到它（`GET /records` 的 `statusTotals` 仍固定 8 状态）。
- 会话若匹配到课表任务会自动写 `task_id`，旧 `GET /tasks?date=` 会把它展示为「已发起/待确认」。
- `deadline_at`：当天发起的课时沿用「当天 24 点」；**补录历史课时不设时限**（避免被每日 00:05 过期任务置 `expired` 后无法再确认）。
- 未做（可后续按需补）：
  - 课程清单的 CSV 导入类型、归档课程的一键恢复接口、教学班（`t_class`）的新增/维护接口（本次只补了查询列表 `GET /classes`）；
  - **后台页面同步**（本次仅后端）：`public/admin/js/pages/export.js` 与 `records.js` 的导出提示文案仍写「固定 18 列」「三列后端暂未提供」，需前端改为 **21 列**并补上「确认人 / 是否临时调整 / 确认人与实际授课人不符」三列说明；`tools/admin-web-simplified-selftest.js` 中「`export.js` 标注 18 列」这一条前端源码静态断言同属待前端同步后更新（该脚本第 10 节的**后端**导出表头断言已同步为 21 列）。

---

## 五、教务处 Web 管理后台（`/admin`）

- 访问：`http://<host>:<port>/admin/`（Nginx 可把 `/admin` 反代到本服务；直接访问 `/admin` 会由静态中间件补尾斜杠或返回首页）
- 形态：**纯静态**，原生 HTML/CSS/JS，**无构建工具、无前端 npm 依赖**；左侧一级菜单 + 顶部面包屑；优先适配 1366×768 以上桌面
- 登录：工号/学号 + 密码 + 记住登录；**仅 `dept_admin` / `admin` 角色可登录**，其它角色返回 `40301`
- 密码：存储为用户记录 `password_hash`（SHA-256 摘要，明文不落库不入日志）；服务启动时为缺失该字段的用户补齐默认密码 `123456`；登录后可在右上角「修改密码」调用 `POST /auth/password`
- 失败锁定：连续 5 次密码错误锁定 15 分钟，记录落盘 `data/login_attempts.json`；锁定期间返回明确提示（HTTP 403）
- 鉴权：token 存 `localStorage`（未勾选「记住登录」时存 `sessionStorage`），所有请求带 `Authorization: Bearer <token>`；收到 `40101` 自动回登录页
- 签名图：用 `fetch` 带 token 拉 `GET /files/{id}` 转 `blob` 显示（接口需鉴权，不能直接 `<img src>`），支持放大与下载

### 页面 ↔ 接口对应

| 页面 | 路由 | 主要接口 |
|---|---|---|
| 登录页 | `#/login`（默认） | `POST /auth/login`、`GET /auth/me` |
| 学时统计看板 P0★ | `#/dashboard` | `/stats/overview`、`/stats/by-dept`、`/stats/trend`、`/stats/by-teacher`、`GET /records`（明细联动）、`POST /export/stats` |
| 课时明细 P0★ | `#/records` | `GET /records`、`GET /records/{id}`、`GET /files/{id}`、`GET /logs?targetId=`、`POST /export/records` |
| 补签审核 P0★ | `#/makeup` | `GET /makeup`、`GET /makeup/{id}`、`GET /records/{id}`、`POST /makeup/{id}/approve|reject` |
| 申诉处理 P0★ | `#/appeal` | `GET /appeal`、`GET /records/{id}`、`POST /appeal/{id}/approve|reject` |
| 数据导入中心 P0★ | `#/import` | `GET /import/template`、`POST /import/precheck`、`POST /import/{type}`、`GET /import/history`、`POST /import/{jobId}/rollback`、`GET /files/*` |
| 报表导出中心 P0★ | `#/export` | `POST /export/records|stats`、`GET /export/history`、`GET /export/{jobId}`、`GET /files/*` |
| 规则配置 P1 | `#/config` | `GET /config`、`PUT /config`（仅教务处可改，院系管理员只读；含敏感词表与三个长度上限） |
| 操作日志 P1 | `#/logs` | `GET /logs`、`GET /logs/verify` |

> 课时明细 / 补签审核 / 申诉处理的详情抽屉统一展示**新流程证据四项**（动态码 / 确认人 / 确认时间 / 设备），**不渲染签名图、不展示任何定位信息**；旧流程记录的历史签名图仅作为历史附件可读（`GET /files/{id}` 需鉴权），不再进入证据区。

### 接口自测（rule-test / smoke-test / bind-security-test / session-flow-test）

```bash
# 领域规则单测：不起服务，直接用业务层断言（临时数据目录，不污染 data/）
node tools/rule-test.js          # 111 项通过 / 0 项失败
# 含第 10 节「记录列表统计口径」：statusTotals 不受 status= 影响 + 四种角色的可见范围

# 绑定安全专项（DEV_MODE=0 生产模式）：进程内启动随机端口实例 + 独立临时 DATA_DIR，跑完自动清理
node tools/bind-security-test.js # 27 项通过 / 0 项失败
# 覆盖：无票据 → 40101（且不落任何 openid）；票据篡改/过期 → 40101；
#      openid 与票据不一致 → 40301；有效且一致 → 成功；白名单校验不变；auth.bind.reject 审计留痕

# 业务流程简化专项（班级课程清单 + 课时会话）：进程内启动随机端口实例 + 独立临时 DATA_DIR，跑完自动清理
node tools/session-flow-test.js  # 192 项通过 / 0 项失败
# 覆盖：课程清单 CRUD/权限/软删除/today 按星期带出；POST /sessions（无课表可发起、未来日期 40001、
#      重复 40901、6 位口令 + qrPayload）；/code/verify 返回课时信息（旧课表码回退）；
#      教师 confirm → done + 确认信息落库 + 动态码消费 + 重复确认 41002/42201；
#      确认人≠实际授课人 → confirm_name_mismatch 仍成功；统计按实际授课人（by-teacher 数字核对）；
#      临时调整 is_temp_adjusted；刷新动态码；确认时限；旧流程 wait 记录升级为会话；审计哈希链完整；
#      GET /classes 四种角色可见范围 + deptId/keyword/classId 筛选 + 「先选班再 POST /class-courses」串联；
#      导出新增三列（确认人 / 是否临时调整 / 确认人与实际授课人不符）新流程有值、旧流程为空

# 端到端 HTTP 自测：需先启动服务（建议独立端口 + 独立 DATA_DIR）
PORT=8099 DATA_DIR=/tmp/kcsq-smoke node server.js          # 终端 1
BASE=http://127.0.0.1:8099 DATA_DIR=/tmp/kcsq-smoke node tools/smoke-test.js   # 终端 2
# 327 项通过 / 0 项失败
# 其中第 11 节核对导出 21 列表头（「签字人」→「发起人（学委）」+ 新增三列）与旧流程数据三列为空

# 自助解绑 / 换绑专项（DEV_MODE=1）：进程内启动随机端口实例 + 独立临时 DATA_DIR，跑完自动清理
node tools/unbind-test.js        # 73 项通过 / 0 项失败
# 覆盖：POST /auth/unbind（需登录）解绑 → 档案保留 + openid 置空 + 原 token 立即失效 →
#      同一工号可被新微信重新绑定（且未走开发模式覆盖分支，证明绑定槽位真的释放）；
#      解绑前后 /records、/sessions 与内存库计数逐一核对不变（历史课时/审计数据不动）；
#      unbind-self 弱凭证（姓名不符 40301 且**不做任何解绑**、工号不存在与姓名不符同提示防探测）、
#      幂等 hadBinding=false、学号路径；频率限制（同 no 第 3 次 40001、同 IP 第 6 次 40001、换 IP 可用、
#      被限流的请求不重复计数）；新表 data/unbind_requests.json 字段与 7 天保留策略；
#      审计 auth.unbind / auth.unbind.self（no/realName/IP/设备/是否确有绑定）+ 哈希链完整；不采集定位

# 一键跑（会清空 data/*.json 并占用 8081，请勿在生产库上执行）
pwsh -File tools/selftest.ps1
```

> **动态码 A+B 双通道**在测试中的覆盖点（`smoke-test.js` 第 3、4b 节；`rule-test.js` 第 7 节）：
> `generate` 返回的 `code` 为**恰好 6 位数字**且有效未消费的码之间**互不重复**、`qrPayload === kcsq://code/<codeId>` 且与兼容别名 `qrUrl` 一致；
> `verify` 按 `{codeId}` / `{code}`（口令）/ `{qrContent}`（扫码内容，含历史载荷 `kcsq://confirm?codeId=..`）三条通道都能核验到**同一个 codeId**；
> 解析失败/不存在的口令 → `40401`，过期 → `41001`，已消费 → `41002`（三条通道语义一致），三种入参全缺失 → `40001`。

> **本次两项修复**在测试中的覆盖点：
> `smoke-test.js` 第 1 节（开发模式下篡改 `bindTicket` → `40101`、`openid` 与票据不一致 → `40301`、不带票据仍可直传 openid）；
> `bind-security-test.js`（生产模式 `DEV_MODE=0` 全流程）；`smoke-test.js` 第 7 节 + `rule-test.js` 第 10 节（`statusTotals` 8 状态、切 `status=wait` 不变、教师/班干部/院系管理员/教务处四种可见范围逐一核对）。

> **自助解绑 / 换绑**在测试中的覆盖点：`bind-security-test.js` 第 8 节（生产模式 `DEV_MODE=0`：解绑后 `auth_epoch +1`、
> 原令牌 40101、解绑后仍不接受裸 openid、新票据可重新绑定同一工号、unbind-self 弱凭证 40301/幂等/限流/审计），
> 以及 `tools/unbind-test.js`（开发模式全流程，含限流边界与历史数据不变）。

> 小程序端自测（二维码编码器结构+反解校验 / 扫码与口令解析 / 页面链路 wx 桩 / 记录页角标走 `statusTotals`）在仓库根目录：
> `cd .. && node tools/miniapp-selftest.js`（92 项通过 / 0 项失败）与 `node tools/miniapp-auth-selftest.js`（136 项通过 / 0 项失败），不需要微信开发者工具。
> 自助解绑专项：`node tools/miniapp-unbind-selftest.js`（65 项通过 / 0 项失败）——「我的」页解绑链路（二次确认 / 成功后清会话回引导 / 失败不清会话 / 40101 收尾）
> 与绑定页「自助解绑并重新绑定」链路（入口只在命中「已被其他微信绑定」时出现、弹窗显示工号+姓名、成功后自动重试一次绑定、限流与姓名不符 msg 原样展示且不发起重试），以及 `useMock=true` 下的 mock 解绑语义。

### 后台自测

```bash
# 1. 启动后端（建议独立端口，避免与在跑的服务冲突）
PORT=8091 DEV_MODE=1 node server.js

# 2. 另开终端执行后台自测（139 项断言：登录/角色限制/失败锁定/静态托管/看板/明细（新流程证据四项
#    + GET /classes 选班 + 旧流程兼容）/自由文本合规（敏感词拦截 40001 + 长度限制 + 审计留痕）/
#    补签申诉全链路/导入预校验+回滚/导出创建与下载（21 列表头 + 新增三列）/配置读写/日志哈希链/修改密码）
node tools/admin-web-selftest.js
# 或：npm run selftest:admin

# 3. 浏览器打开 http://127.0.0.1:8091/admin/ ，用 ADMIN001 / 123456 登录

# 4. 可选：业务流程简化适配自测（登录 + 会话/课程清单/统计新口径 + 后台前端源码静态检查；
#    SELFTEST_EXPORT=1 时额外核对导出 21 列表头）
SELFTEST_BASE=http://127.0.0.1:8091 SELFTEST_EXPORT=1 node tools/admin-web-simplified-selftest.js
# 60 项通过 / 0 项失败
```

> 脚本默认访问 `http://127.0.0.1:8091`，可用 `SELFTEST_BASE` 环境变量覆盖（刻意不使用 `BASE`，避免与宿主环境变量冲突）；数据目录可用 `DATA_DIR` 指向独立目录。
> **注意：`SELFTEST_BASE` 与 `DATA_DIR` 必须同时指向同一套实例**——脚本会直接读取 `DATA_DIR/dev-login-tokens.json` 复用"已绑定工号"的令牌；
> 若只给了 `SELFTEST_BASE` 而 `DATA_DIR` 落在别的实例（例如在跑的 8081 的 `backend/data/`），令牌签名密钥不匹配 → 教师令牌 40101，5B 节补签/申诉链路会连锁失败。
> 锁定策略验证使用一次性专用账号（形如 `TESTLOCKxxxxxx`），不会锁死演示账号；重置 `data/*.json` 后可从零复现全部断言。
> 第 4 节会新建 1 条课时会话并确认，用于核对**新流程证据四项（动态码 / 确认人 / 确认时间 / 设备）**，并核对 `GET /classes` 选班链路；
> 若该工号 `2010032` 已被前置自测（`smoke-test`）用另一个微信绑定，脚本会断言「同工号重复绑定 → 40301」并复用 DEV_MODE 落盘令牌继续跑（与 `smoke-test` 的 `loginAs` 回退同一约定），因此**建议按 rule-test → smoke-test → admin-web-selftest 的顺序执行**。
> 最近一次通过的输出留档：`tools/admin-web-selftest.result.txt`（139 项通过 / 0 项失败）。

---

## 六、演示账号（种子数据）

绑定方式：`POST /api/v1/auth/login` 拿到 `openid`/`bindTicket` → `POST /api/v1/auth/bind`，入参 `{bindTicket, openid, role, no, realName}`（`DEV_MODE=1` 下用任意 `code` 即可，且可省略 `bindTicket` 直接传 `openid`；**`DEV_MODE=0` 生产环境必须带 `bindTicket` 且 `openid` 与之一致**，见第四节「绑定安全」）。

| 角色 | 工号/学号 | 姓名 | Web 后台 | 说明 |
|---|---|---|---|---|
| 教师 | `2010032` | 唐瑞明 | ✗（40301） | 有周三/周一课程 |
| 教师 | `2011045` | 李慧 | ✗（40301） | |
| 教师 | `2012088` | 王强 | ✗（40301） | |
| 班干部 | `2025030117` | 张一鸣 | ✗（40301） | 教学班 C00000001 |
| 院系管理员 | `2017001` | 孙主任 | ✔ | 补签审核（限本院系）；密码 `123456` |
| 教务处 | `ADMIN001` | 教务处 | ✔ | 全校统计/申诉/导入导出/配置；密码 `123456` |

> - 一个工号/学号只能绑定一个微信（重复绑定返回 `40301`）。
> - **换绑无需再找教务处**：旧微信还能登录 → 「我的」页「解绑当前微信」（`POST /auth/unbind`）；已登不进去 → 绑定页「自助解绑并重新绑定」（`POST /auth/unbind-self`，弱凭证 + 频率限制）。详见第四节「自助解绑 / 换绑」。
> - **演示账号的 Web 密码统一为 `123456`**（SHA-256 摘要存于用户记录 `password_hash`），首次登录后请立即修改。
> - 请求体含 `code` → 走小程序分支；不含 `code` 而含 `{no, password}` → 走 Web 后台分支。

---

## 七、生产部署

```bash
# systemd 单元（/etc/systemd/system/attendance.service）
[Service]
WorkingDirectory=/opt/apps/attendance
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8081
Environment=DEV_MODE=0
Environment=WX_APPID=wx...
Environment=WX_APPSECRET=...        # 只放服务端
Environment=TOKEN_SECRET=<随机长串>
Environment=CODE_SECRET=<随机长串>
```

- **HTTPS 与备案**：微信小程序真机要求 `request` 域名为**已备案 HTTPS**。需把域名解析到服务器，在 Nginx 配置 HTTPS（可用 certbot 免费证书），并在微信公众平台"服务器域名"中配置该域名。
- **Nginx 反代**：`/api/v1/` 与 `/admin` → `http://127.0.0.1:8081`（本仓库部署示例见服务器 `/etc/nginx/sites-available/apps`）。
- **小程序接入**：在 `miniprogram/app.js` 中设 `globalData.useMock = false`、`globalData.apiBase = 'https://你的已备案域名'`。

---

## 八、安全注意

1. **AppSecret / TOKEN_SECRET / CODE_SECRET 只存服务端**，用环境变量注入；默认值为演示用，**生产必须替换**。
2. **绑定必须凭 `bindTicket`**：`DEV_MODE=0` 下 `POST /auth/bind` 只认有效且未过期的 `bindTicket`，且请求体 `openid` 必须与票据一致（缺失/过期 `40101`、不一致 `40301`）；被拒绝的尝试写 `auth.bind.reject` 审计日志。**切勿在生产环境用 `DEV_MODE=1` 上线**（该模式下允许直接传 `openid` 联调）。
3. 签名图不公开访问，需鉴权经 `GET /files/{id}` 读取；签名证据固定四项（签名图 / 确认时间 / 设备 / 动态码）。
4. **不采集定位/位置信息**：相关入参一律忽略，响应不含位置字段，`t_signature` 的位置列仅为兼容历史数据保留且新数据为 `null`（故无需隐私指引中的定位授权申报；历史坐标可按第四节「不采集定位」小节的一次性命令清理）。
5. 教师/班干部填写的自由文本（摘要、缺勤姓名、理由、备注）做**长度校验 + 敏感词过滤**（契约六.6）：命中即 `40001` 拦截并写 `text.sensitive.blocked` 审计日志，词表与长度上限由 `/config` 维护。
6. 操作日志写入 SHA-256 哈希链（`prev_hash`→`hash`），可检测篡改；`/health` 会返回链校验状态。
7. 导出文件含个人信息，下载链接短期有效并记录导出日志。
8. **Web 后台口令**：当前按需求以 SHA-256 摘要存储（零新增依赖）。生产建议替换为 bcrypt/argon2 + 随机盐（改动点集中在 `src/webauth.js` 的 `hashPassword`/`verifyPassword`），并启用 HTTPS。
9. **自助解绑是弱凭证接口**：`POST /auth/unbind-self` 未登录可用，凭证只有"白名单工号/学号 + 真实姓名"。因此**必须**保留已实现的频率限制（同一工号 24h ≤2 次、同一 IP 1h ≤5 次，计数落在 `data/unbind_requests.json`）与审计留痕（`auth.unbind.self`，含 IP/设备/姓名/是否确有绑定）；接口不区分"工号不存在"与"姓名不符"（同为 `40301`），避免被用于探测。
   - 生产建议**再叠加一层强凭证**：短信验证码 / 学校统一认证（CAS、企业微信）/ 企业微信扫码，并用网关层限流；Nginx 反代必须 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` **覆写**该头（IP 维度限流依赖它，否则可被伪造绕过）。
   - 解绑会把该用户的绑定世代 `auth_epoch +1`，使该工号**此前签发的所有令牌**立即失效（旧微信即使还持有未过期 token 也无法继续操作）；两个接口都只解除登录绑定，**不影响**任何历史课时/统计/审计数据。
10. **密码/令牌与绑定变更**：`currentUser` 会校验令牌内的绑定世代 `ep` 与 `users[].auth_epoch` 是否一致；老令牌（无 `ep`）按 0 处理，与从未解绑过的账号一致，**向后兼容**。若通过后台直接改用户的 `openid`（绕过这两个解绑接口），旧令牌不会自动失效，需按第 9 条的逻辑同时递增 `auth_epoch`（或让用户重新登录）。

---

## 九、说明

- 本后端为**依据接口契约的实现**，覆盖契约 A–I 全部接口分组；导入/导出采用 CSV（契约允许 `csv|xlsx`，Excel 可后续扩展）。
- **业务流程已按最新需求简化为「班干部维护课程清单 → 每次上课带出 → 出示 60 秒动态码 → 任课教师扫码点确认」**，学时按实际授课人统计；详见第四节之二。旧流程接口全部保留，历史数据与旧客户端零迁移。
- 首次启动自动种子演示数据，正式使用前请 `npm run reset` 清空并导入学校真实数据（`/import/*`）。
- 教务处 Web 管理后台见第五节；实现规格对应 `docs/miniapp/admin-web-spec.md`。
- **升级提示**：已运行过旧版本的数据目录不会自动回填课程清单，`data/class_courses.json` 会按空表初始化（可用 `/class-courses` 录入，或删除该文件后由班干部重新录入）；删除 `data/*.json` 重新启动则按新种子（含 8 条课程清单）生成。
