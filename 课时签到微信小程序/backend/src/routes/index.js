'use strict';
/**
 * /api/v1 统一挂载点
 */
const express = require('express');
const u = require('../util');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const { ok, wrap } = require('../http');
const { CODES } = require('../errors');

const router = express.Router();

// ---------------------------------------------------------------- 健康检查（/health 与 /api/v1/health 都可用）
function healthPayload() {
  const chain = audit.verifyChain();
  return {
    status: 'ok',
    service: 'kcsq-backend',
    name: '课堂课时确认与学时统计 · 后端服务',
    version: '0.1.0',
    node: process.version,
    devMode: u.DEV_MODE,
    timezone: 'Asia/Shanghai',
    now: u.isoNow(),
    today: u.dateOnly(),
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: u.DATA_DIR,
    counts: {
      users: store.all('users').length,
      depts: store.all('depts').length,
      classes: store.all('classes').length,
      courseTasks: store.all('course_tasks').length,
      classCourses: store.all('class_courses').length,
      periodRecords: store.all('period_records').length,
      signatures: store.all('signatures').length,
      auditLogs: store.all('audit_logs').length,
    },
    auditChain: { ok: chain.ok, total: chain.total, brokenAt: chain.brokenAt || null },
  };
}

router.get('/health', wrap(function (req, res) { return ok(res, healthPayload()); }));

// ---------------------------------------------------------------- 接口索引（浏览器直接打开 /api/v1/ 时给出说明，而不是 404）
router.get('/', wrap(function (req, res) {
  return ok(res, {
    service: 'kcsq-backend',
    name: '课堂课时确认与学时统计 · 后端服务',
    version: '0.1.0',
    apiPrefix: '/api/v1',
    health: '/api/v1/health',
    docs: 'backend/README.md · docs/miniapp/api-contract.md',
    now: u.isoNow(),
    devMode: u.DEV_MODE,
    groups: {
      '认证与绑定': [
        'POST /auth/login（小程序 code 分支 / Web 后台 no+password 分支）',
        'POST /auth/bind（DEV_MODE=0 必须带 bindTicket，且请求体 openid 必须与票据一致：票据缺失/无效/过期 40101、openid 不匹配 40301；DEV_MODE=1 可直传 openid，但传了票据同样必须有效且一致）',
        'GET /auth/me',
        'POST /auth/logout',
        'POST /auth/unbind（需登录：解绑本人微信，仅清 openid，不删档案、不动历史课时数据；返回前先注销当前 token）',
        'POST /auth/unbind-self（**未登录可用**：换微信后登不进去时的自助解绑；入参 {no, realName}，白名单+姓名完全一致，否则 40301；同 no 24h ≤2 次、同 IP 1h ≤5 次，超限 40001）',
        'POST /auth/password（修改本人密码）',
      ],
      '动态确认码': [
        'POST /code/generate（班干部/管理员；返回 codeId + code(6 位数字口令) + qrPayload(A 通道 kcsq://code/<codeId>) + qrUrl(兼容别名) + expireAt/ttl，默认 60 秒）',
        'POST /code/verify（教师；入参三选一 {codeId} | {code} 6 位口令 | {qrContent} 扫码内容；解析失败/查不到 40401，过期 41001，已消费 41002。**若该码是课时会话码**，额外返回 sessionId/session/sessionInfo（本次课时信息），否则回退为原「返回课表任务」行为）',
      ],
      '班级课程清单（新增）': [
        'GET /classes?deptId=&keyword=&classId=&status=&page=&pageSize=（教学班列表：班干部=本班；教师=全部；院系管理员=本院系；教务处=全部；deptName 由 t_dept 关联。供后台「新增课程清单」下拉选班：先取 classId 再 POST /class-courses）',
        'GET /class-courses?classId=&keyword=&status=&term=&weekday=&page=&pageSize=（班干部=本班；教师=可按班查询；院系管理员=本院系；教务处=全部）',
        'GET /class-courses/today?date=YYYY-MM-DD（按该日期的星期带出当天课程）',
        'GET /class-courses/{id}',
        'POST /class-courses（班干部/管理员；必填 courseName、teacherName；可选 weekday/section/place/hours/term；长度与敏感词校验）',
        'PUT /class-courses/{id}（部分字段更新，不可改教学班）',
        'DELETE /class-courses/{id}（软删除 → status=archived）',
      ],
      '课时会话（新增：班干部发起 + 教师确认）': [
        'POST /sessions（班干部/管理员；入参 {courseId?, courseName, teacherName, teacherNo?, classId?, teachDate, section?, place?, hours?, note?, absentCount?, absentNames?, discipline?, summary?}；返回 sessionId + 6 位口令 + qrPayload + 60 秒 TTL）',
        'POST /sessions/{id}/code（二维码过期后刷新动态码）',
        'GET /sessions?date=&status=&from=&to=&classId=&courseId=&tempAdjusted=&nameMismatch=&page=&pageSize=',
        'GET /sessions/{id}（详情 + 证据 + 最近留痕）',
        'POST /sessions/{id}/confirm（任课教师确认；可带 {codeId}|{code}|{qrContent} 消费动态码；重复确认 41002/42201；确认人≠实际授课人仍成功并置 confirm_name_mismatch）',
      ],
      '授课任务': ['GET /tasks?date=', 'GET /tasks/week', 'GET /tasks/{id}'],
      '课时记录（旧流程，全部保留以兼容历史数据与旧客户端）': ['POST /records（教师发起）', 'GET /records（summary 同时含：hours、byStatus=受 status= 筛选的计数、statusTotals=不受 status= 筛选的 8 状态角标计数，按角色可见范围统计）', 'GET /records/{id}（证据四项：签名图/确认时间/设备/动态码）', 'POST /records/{id}/sign', 'POST /records/{id}/reject', 'POST /records/{id}/revoke', 'POST /records/{id}/urge', 'POST /records/expire-job'],
      '补签与申诉': ['POST /makeup', 'GET /makeup', 'POST /makeup/{id}/approve', 'POST /makeup/{id}/reject', 'POST /appeal', 'GET /appeal', 'POST /appeal/{id}/approve', 'POST /appeal/{id}/reject'],
      '统计看板': ['GET /stats/overview', 'GET /stats/by-dept', 'GET /stats/by-teacher', 'GET /stats/by-course', 'GET /stats/trend'],
      '导入导出': ['POST /export/records', 'POST /export/stats', 'GET /export/history（后台导出任务列表）', 'GET /export/{jobId}',
        'POST /import/precheck（导入预校验 dry-run）', 'POST /import/depts（院系主数据）', 'POST /import/classes（教学班主数据）', 'POST /import/tasks', 'POST /import/students', 'POST /import/whitelist', 'POST /import/cadres',
        'GET /import/history（后台导入历史）', 'GET /import/{jobId}', 'POST /import/{jobId}/rollback（快照回滚，仅教务处）', 'GET /import/template（?data=1 导出当前院系/教学班主数据，带 ID 可改名后重新导入）'],
      '配置日志文件': ['GET /config', 'PUT /config（含敏感词表与自由文本长度上限）', 'GET /logs', 'GET /logs/verify', 'POST /files/signature', 'GET /files/{id}'],
    },
    adminWeb: '/admin/ （教务处 Web 管理后台静态页，见 docs/miniapp/admin-web-spec.md）',
    codeChannels: {
      A: '真二维码（应用内扫码）：POST /code/generate 返回 qrPayload = kcsq://code/<codeId>；小程序端用自带的纯 JS 编码器渲染成 canvas 二维码；教师扫码后 POST /code/verify 传 {qrContent}',
      B: '6 位数字口令（手输兜底）：POST /code/generate 返回 code（6 位数字，在当前有效且未消费的码中唯一）；教师手输后 POST /code/verify 传 {code}',
      same: '两条通道最终都解析到同一个 codeId，共用 60 秒 TTL 与"一次性消费"规则；过期 41001、重复使用 41002、解析失败/查不到 40401',
    },
    compliance: {
      location: '本服务不采集定位/位置信息：POST /records 与 POST /records/{id}/sign 均不读取 location/latitude/longitude/locationDenied（传入即忽略，不报错），响应中也不含位置字段；t_signature 的 latitude/longitude/location_denied 列仅为兼容历史数据保留，新写入固定为 null',
      evidenceItems: ['签名图', '确认时间', '设备', '动态码'],
      freeText: '教师/班干部填写的自由文本（授课摘要 summary、缺勤姓名 absentNames、补签理由、申诉理由、拒绝原因 reason、备注 note）做长度校验 + 敏感词检测：命中敏感词返回 40001「内容包含敏感词：xxx」并写审计日志（text.sensitive.blocked），超长/必填为空同样返回 40001',
      configKeys: ['sensitive_words', 'max_summary_len', 'max_absent_names_len', 'max_reason_len'],
      defaultLimits: { max_summary_len: 500, max_absent_names_len: 300, max_reason_len: 500 },
    },
    binding: {
      endpoint: 'POST /auth/bind',
      devMode0: '生产（DEV_MODE=0）：必须提供有效且未过期的 bindTicket（由 /auth/login 未绑定时下发，30 分钟有效）；请求体若同时传 openid，必须与票据内 openid 一致',
      devMode1: '开发（DEV_MODE=1）：允许直接传 openid 联调；但只要传了 bindTicket，同样必须校验其有效性与 openid 一致性',
      errors: {
        40101: 'bindTicket 缺失 / 无效 / 已过期（生产环境不接受仅凭 openid 绑定）',
        40301: '请求体 openid 与 bindTicket 内的 openid 不一致（疑似伪造他人 openid）',
      },
      audit: '被拒绝的绑定请求写操作日志 auth.bind.reject（含 reason：missing_ticket / invalid_ticket / openid_mismatch）',
    },
    selfUnbind: {
      endpoints: ['POST /auth/unbind（需登录，解绑本人）', 'POST /auth/unbind-self（未登录，换微信自救）'],
      semantics: '两个接口都**只解除登录绑定**（users[].openid 置空）：不删除用户档案，不改动任何历史课时/统计/审计数据；解绑后该工号/学号可被其它微信重新绑定。/auth/unbind 返回前先注销当前 token（解绑即下线）。',
      weakCredential: 'POST /auth/unbind-self 的凭证是**弱凭证**：白名单内的 工号/学号 + 真实姓名（二者必须完全一致）。因此该接口不返回多余信息、不区分「工号不存在」与「姓名不符」（同为 40301，防探测）。',
      rateLimit: {
        sameNo: '同一 no 24 小时内最多 2 次（超限 40001）',
        sameIp: '同一 IP 1 小时内最多 5 次（超限 40001）',
        store: '计数与新表 data/unbind_requests.json（store 表 unbind_requests），仅保留最近 7 天记录并带条数上限，避免无限增长',
        counting: '放行后进入业务处理的请求（成功 + 姓名不符被拒）都计数；已被限流拒绝的请求不再重复计数，避免攻击者刷请求延长他人等待窗口',
      },
      audit: '成功与失败均写操作日志 auth.unbind.self（记 no、realName、IP、设备、是否确有绑定、是否放行与原因）；已登录解绑写 auth.unbind（记 no、realName、原 openid 前缀脱敏）',
      hardening: '生产环境建议在弱凭证之上再叠加一层强凭证：短信验证码 / 学校统一认证（CAS·企业微信）/ 企业微信扫码，并配合网关级限流与教务处人工兜底；IP 维度限流依赖 X-Forwarded-For，反向代理必须覆写该头，否则可被伪造绕过',
      location: '两个接口都不采集定位/位置信息',
    },
    note: '本服务为 JSON API：除登录外均需请求头 Authorization: Bearer <token>。直接用浏览器打开本页仅用于查看索引说明。',
    businessFlow: {
      summary: '业务流程已简化：班干部维护班级课程清单（长期保留）→ 每次上课从清单选择/带出并允许临时调整 → 出示 60 秒动态码 → 任课教师扫码看到本次课时信息后点「确认」→ 课时完成。不再手写签名、不走审批。',
      endpoints: ['GET/POST /class-courses', 'GET /class-courses/today', 'POST /sessions', 'POST /sessions/{id}/code', 'GET /sessions', 'GET /sessions/{id}', 'POST /sessions/{id}/confirm'],
      verifyEntry: 'POST /code/verify：课时会话码返回 sessionId + session（本次课时信息）；旧课表码回退为原「返回课表任务」行为',
      hoursAttribution: '统计与教师「我的学时」按**实际授课人**（teacher_name，有 teacher_id 时优先用 id）归属；概览新增 tempAdjustedCount / nameMismatchCount / sessionCount',
      removed: ['调课记录', '停课记录', '审批流'],
      kept: ['动态码 60 秒一次性', '操作留痕与审计哈希链', '旧接口（/records、签名、补签申诉）全部保留'],
    },
  });
}));

// ---------------------------------------------------------------- 业务路由
router.use(require('./auth.routes'));    // A 认证与绑定 / B 动态码
router.use(require('./records.routes')); // C 授课任务 / D 课时记录
router.use(require('./reviews.routes')); // E 补签与申诉
router.use(require('./admin.routes'));   // F 统计 / G 导出 / H 导入 / I 配置·日志·文件
router.use(require('./classcourses.routes')); // J 班级课程清单（班干部录入一次、长期保留）
router.use(require('./classes.routes'));      // L 教学班列表（后台新增课程清单时选班用）
router.use(require('./sessions.routes'));     // K 课时会话（班干部发起 + 教师扫码确认）

module.exports = { router, healthPayload };
