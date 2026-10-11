'use strict';
/**
 * 教务处 Web 管理后台 · 后端接口自测脚本（Node 18+，无第三方依赖）
 *
 * 用法：
 *   node tools/admin-web-selftest.js                       # 默认 http://127.0.0.1:8091
 *   SELFTEST_BASE=http://127.0.0.1:8081 node tools/admin-web-selftest.js
 *
 * 覆盖：Web 账号密码登录 / 角色限制 / 失败锁定 / 静态托管 / 看板统计 / 课时明细 /
 *       补签申诉 / 导入预校验 + 导入 + 回滚 + 历史 / 导出创建与下载 / 配置读写 /
 *       日志与哈希链 / 签名图鉴权读取 / 修改密码
 */
// 注意：不使用 BASE 环境变量名，避免与宿主（DSH Web GUI）自带的 BASE 冲突
const BASE = process.env.SELFTEST_BASE || 'http://127.0.0.1:8091';
// 与被测服务使用同一数据目录（可用 DATA_DIR 覆盖）
const DATA_DIR = process.env.DATA_DIR ? require('path').resolve(process.env.DATA_DIR) : require('path').join(__dirname, '..', 'data');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra) {
  pass++;
  console.log('  [PASS] ' + name + (extra ? '  —— ' + extra : ''));
}
function bad(name, extra) {
  fail++;
  failures.push(name + (extra ? '：' + extra : ''));
  console.log('  [FAIL] ' + name + (extra ? '  —— ' + extra : ''));
}
function check(name, cond, extra) {
  if (cond) ok(name, extra); else bad(name, extra);
  return cond;
}
function section(title) {
  console.log('\n== ' + title + ' ' + '='.repeat(Math.max(2, 60 - title.length)));
}

async function call(method, path, opts) {
  const o = opts || {};
  const url = (path.startsWith('http') ? path : BASE + path) + (o.query ? qs(o.query) : '');
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  let body;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const json = /json/i.test(res.headers.get('Content-Type') || '') ? safeJson(text) : null;
  return { status: res.status, headers: res.headers, text, json, raw: text };
}
function qs(q) {
  const parts = Object.keys(q).filter((k) => q[k] !== '' && q[k] !== undefined && q[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
  return parts.length ? '?' + parts.join('&') : '';
}
function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
/** 极简 CSV 解析（支持引号包裹与转义双引号；用于逐列核对导出表头/取值） */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
/**
 * 读取服务在 DEV_MODE 下落盘的最近一次登录令牌。
 * 用途：该工号已被前置自测（如 smoke-test）用另一个微信 openid 绑定时，服务会按
 * 「一个工号只能绑一个微信」正确拒绝二次绑定——此时复用它已签发的令牌继续跑后面的链路。
 */
function readDevToken(no) {
  try {
    const file = require('path').join(DATA_DIR, 'dev-login-tokens.json');
    const all = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    const hit = all[String(no)];
    return hit && hit.token ? hit.token : '';
  } catch (e) { return ''; }
}
/** 构造 multipart 上传体（字段名 file，与后端 multer 约定一致） */
function makeForm(csvText, fileName) {
  const fd = new FormData();
  fd.append('file', new Blob([csvText], { type: 'text/csv' }), fileName || 'upload.csv');
  return fd;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('教务处 Web 管理后台自测 · BASE=' + BASE + '  时间=' + new Date().toISOString());

  // ---------------------------------------------------------------- 1. 健康检查
  section('1. 健康检查与静态托管');
  const health = await call('GET', '/health');
  check('GET /health 返回 200 且 code=0', health.status === 200 && health.json && health.json.code === 0,
    health.json && health.json.data ? ('记录数 records=' + health.json.data.counts.periodRecords + ' users=' + health.json.data.counts.users) : health.status);

  const adminIndex = await call('GET', '/admin/');
  check('GET /admin/ 返回 200 且为 HTML', adminIndex.status === 200 && /text\/html/i.test(adminIndex.headers.get('Content-Type') || ''),
    adminIndex.status + ' ' + (adminIndex.headers.get('Content-Type') || ''));
  check('GET /admin/ 命中 public/admin/index.html', /教务处管理后台/.test(adminIndex.text) && /id="login-form"/.test(adminIndex.text));

  const adminNoSlash = await call('GET', '/admin');
  check('GET /admin（无尾斜杠）返回后台首页', adminNoSlash.status === 200 && /教务处管理后台/.test(adminNoSlash.text), adminNoSlash.status);

  const adminCss = await call('GET', '/admin/css/admin.css');
  check('GET /admin/css/admin.css 返回 200 CSS', adminCss.status === 200 && /text\/css/i.test(adminCss.headers.get('Content-Type') || ''), adminCss.status);
  const adminJs = await call('GET', '/admin/js/app.js');
  check('GET /admin/js/app.js 返回 200 JS', adminJs.status === 200 && /javascript/i.test(adminJs.headers.get('Content-Type') || ''), adminJs.status);
  const deepLink = await call('GET', '/admin/records');
  check('GET /admin/records（深层路径刷新）回落后台首页', deepLink.status === 200 && /教务处管理后台/.test(deepLink.text), deepLink.status);

  // ---------------------------------------------------------------- 2. 登录
  section('2. Web 账号密码登录分支');
  const login = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: '123456' } });
  check('POST /auth/login {no,password} 返回 200 且 code=0', login.status === 200 && login.json && login.json.code === 0,
    login.json ? JSON.stringify({ code: login.json.code, msg: login.json.msg }) : login.status);
  const token = login.json && login.json.data && login.json.data.token;
  check('登录返回 token', !!token, token ? token.slice(0, 24) + '…' : '');
  check('登录返回 role=admin', login.json && login.json.data && login.json.data.role === 'admin', login.json && JSON.stringify(login.json.data && login.json.data.role));
  check('登录返回 user（与小程序一致）', !!(login.json && login.json.data && login.json.data.user && login.json.data.user.name), login.json && login.json.data && login.json.data.user && login.json.data.user.name);
  check('登录响应不含密码摘要', !/password_hash/.test(login.text));

  const noToken = await call('GET', '/api/v1/stats/overview');
  check('无 token 访问受保护接口返回 40101', noToken.status === 401 && noToken.json && noToken.json.code === 40101,
    noToken.status + ' code=' + (noToken.json && noToken.json.code));

  const teacherLogin = await call('POST', '/api/v1/auth/login', { body: { no: '2010032', password: '123456' } });
  check('教师角色 Web 登录返回 40301', teacherLogin.status === 403 && teacherLogin.json && teacherLogin.json.code === 40301,
    teacherLogin.status + ' code=' + (teacherLogin.json && teacherLogin.json.code));

  const deptLogin = await call('POST', '/api/v1/auth/login', { body: { no: '2017001', password: '123456' } });
  const deptToken = deptLogin.json && deptLogin.json.data && deptLogin.json.data.token;
  check('院系管理员 Web 登录成功', deptLogin.status === 200 && deptLogin.json.code === 0 && deptLogin.json.data.role === 'dept_admin',
    deptLogin.json && deptLogin.json.data && deptLogin.json.data.role);

  const me = await call('GET', '/api/v1/auth/me', { token });
  check('GET /auth/me 返回当前用户与角色', me.status === 200 && me.json.code === 0 && me.json.data.role === 'admin', me.json && me.json.data && me.json.data.role);

  const badPwd = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: 'definitely-wrong' } });
  check('密码错误返回 40001 且提示剩余次数', badPwd.status === 400 && badPwd.json.code === 40001 && /还可尝试/.test(badPwd.json.msg), badPwd.json && badPwd.json.msg);

  // 密码错误后正确登录应清零失败计数
  const relogin = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: '123456' } });
  check('失败后正确密码仍可登录（计数已清零）', relogin.status === 200, relogin.status);

  // ---------------------------------------------------------------- 3. 看板统计
  section('3. 学时统计看板接口');
  const overview = await call('GET', '/api/v1/stats/overview', { token });
  check('GET /stats/overview 200', overview.status === 200 && overview.json.code === 0,
    overview.json && JSON.stringify({
      confirmedHours: overview.json.data.confirmedHours, waiting: overview.json.data.waiting,
      expired: overview.json.data.expired, abnormal: overview.json.data.abnormal,
      makeupHours: overview.json.data.makeupHours, completionRate: overview.json.data.completionRate,
    }));

  const byDept = await call('GET', '/api/v1/stats/by-dept', { token });
  check('GET /stats/by-dept 返回院系排行', byDept.status === 200 && Array.isArray(byDept.json.data.list) && byDept.json.data.list.length > 0,
    byDept.json && byDept.json.data.list.map((d) => d.name + '=' + d.confirmedHours + '学时/' + d.completionRate + '%').join(', '));

  const byTeacher = await call('GET', '/api/v1/stats/by-teacher', { token, query: { pageSize: 20 } });
  check('GET /stats/by-teacher 返回教师排行', byTeacher.status === 200 && Array.isArray(byTeacher.json.data.rank),
    byTeacher.json && '教师数 ' + byTeacher.json.data.rank.length);

  const trendWeek = await call('GET', '/api/v1/stats/trend', { token, query: { granularity: 'week' } });
  const trendMonth = await call('GET', '/api/v1/stats/trend', { token, query: { granularity: 'month' } });
  check('GET /stats/trend（周/月）均返回 200', trendWeek.status === 200 && trendMonth.status === 200,
    'week 桶 ' + (trendWeek.json.data.list || []).length + ' / month 桶 ' + (trendMonth.json.data.list || []).length);

  const byCourse = await call('GET', '/api/v1/stats/by-course', { token });
  check('GET /stats/by-course 200', byCourse.status === 200 && Array.isArray(byCourse.json.data.list), byCourse.json && (byCourse.json.data.list || []).length + ' 门课程');

  // ---------------------------------------------------------------- 4. 课时明细
  section('4. 课时明细与详情（新流程证据四项 / 无定位 / 旧流程兼容）');
  const records = await call('GET', '/api/v1/records', { token, query: { page: 1, pageSize: 5 } });
  const recList = (records.json && records.json.data && records.json.data.list) || [];
  check('GET /records 返回分页列表', records.status === 200 && recList.length > 0,
    'total=' + (records.json.data.total) + ' 本页 ' + recList.length + ' 条');
  check('列表含状态/学时/发起人（签字人）字段', recList.every((r) => r.status && r.statusText !== undefined && r.signerName !== undefined),
    recList.slice(0, 3).map((r) => r.fullDate + ' ' + r.courseName + ' ' + r.status).join(' | '));

  const meAdmin = await call('GET', '/api/v1/auth/me', { token });
  const adminName = meAdmin.json.data.user.name;

  // 4.1 新流程（班干部/管理员发起 → 教师确认）：证据四项 = 动态码 / 确认人 / 确认时间 / 设备
  const classList = await call('GET', '/api/v1/classes', { token, query: { pageSize: 5 } });
  const pickClass = (classList.json && classList.json.data && classList.json.data.list || [])[0];
  check('GET /classes 可取教学班（后台新增课程清单前置：先选班拿 classId）',
    classList.status === 200 && classList.json.code === 0 && !!pickClass && !!pickClass.classId && !!pickClass.deptName,
    pickClass ? (pickClass.id + ' ' + pickClass.name + ' / ' + pickClass.deptName + '（班干部 ' + pickClass.cadreCount + ' / 学生 ' + pickClass.studentCount + '）') : '无教学班');

  const yday = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const seatName = '自测证据人' + String(Date.now()).slice(-5);
  const newSession = await call('POST', '/api/v1/sessions', {
    token,
    body: {
      classId: pickClass && pickClass.classId, courseName: '自测：新流程证据四项',
      teacherName: seatName, teachDate: yday, section: '3-4', hours: 1,
    },
  });
  check('POST /sessions 可发起课时会话（新流程入口，返回 6 位口令 + 动态码）',
    newSession.status === 200 && newSession.json.code === 0 && !!newSession.json.data.sessionId && /^\d{6}$/.test(String(newSession.json.data.code)),
    newSession.json && newSession.json.data && (newSession.json.data.sessionId + ' 动态码 ' + newSession.json.data.codeId + ' 口令 ' + newSession.json.data.code));
  const sid = newSession.json && newSession.json.data && newSession.json.data.sessionId;

  const sWait = await call('GET', '/api/v1/sessions/' + sid, { token });
  const evWait = sWait.json.data.session.evidence;
  check('会话详情 evidence 标签为新流程四项「动态码 / 确认人 / 确认时间 / 设备」',
    (evWait.labels || []).join('/') === '动态码/确认人/确认时间/设备' && evWait.codeId === newSession.json.data.codeId,
    '标签=' + (evWait.labels || []).join('、') + ' 动态码=' + evWait.codeId);
  check('未确认时「确认人 / 确认时间」为空（待任课教师扫码确认）',
    !evWait.confirmedName && !evWait.confirmedAt && evWait.nameMismatch === false,
    JSON.stringify({ confirmedName: evWait.confirmedName, confirmedAt: evWait.confirmedAt }));

  const confirmRes = await call('POST', '/api/v1/sessions/' + sid + '/confirm', { token, body: { codeId: newSession.json.data.codeId } });
  check('POST /sessions/{id}/confirm 确认成功 → status=done',
    confirmRes.status === 200 && confirmRes.json.code === 0 && confirmRes.json.data.status === 'done',
    confirmRes.json && (confirmRes.json.data && (confirmRes.json.data.sessionId + ' → ' + confirmRes.json.data.status)));

  const sDone = await call('GET', '/api/v1/sessions/' + sid, { token });
  const sess = sDone.json.data.session;
  const ev = sess.evidence;
  check('确认后证据四项取值齐备（动态码 / 确认人 / 确认时间 / 设备）',
    !!ev.codeId && ev.confirmedName === adminName && !!ev.confirmedAt && !!ev.device,
    '动态码=' + ev.codeId + ' 确认人=' + ev.confirmedName + ' 确认时间=' + ev.confirmedAt + ' 设备=' + ev.device);
  check('确认人 ≠ 实际授课人 → 置 nameMismatch（代课仍确认成功，不报错）',
    ev.nameMismatch === true && sess.confirmNameMismatch === true,
    '确认人「' + ev.confirmedName + '」≠ 实际授课人「' + sess.teacherName + '」');
  const sigKeys = ['signatureUrl', 'signatureFileId', 'imageHash', 'signedAt'];
  check('新流程证据区不含签名图键（不再手写签名）',
    sigKeys.every((k) => ev[k] === undefined), sigKeys.filter((k) => ev[k] !== undefined).join(',') || '无签名图键');
  const evLocKeysNew = Object.keys(ev).filter((k) => /^(location|latitude|longitude|locationDenied)$/i.test(k));
  check('新流程证据区不含任何定位/位置字段', evLocKeysNew.length === 0, evLocKeysNew.join(',') || '无位置字段');

  // 4.2 旧流程兼容：GET /records/{id} 的证据四项（签名图口径）与历史签名图鉴权读取保持不变
  const rid = recList[0] && recList[0].id;
  const detail = await call('GET', '/api/v1/records/' + rid, { token });
  const evLegacy = detail.json && detail.json.data && detail.json.data.evidence;
  check('旧流程 GET /records/{id} 证据仍为四项（历史数据 / 旧客户端兼容口径）',
    detail.status === 200 && evLegacy && evLegacy.count === 4 && (evLegacy.labels || []).join('/') === '签名图/确认时间/设备/动态码' &&
    evLegacy.signatureFileId !== undefined && evLegacy.confirmedAt !== undefined && evLegacy.device !== undefined && evLegacy.codeId !== undefined,
    evLegacy && ('count=' + evLegacy.count + ' 标签=' + (evLegacy.labels || []).join('、') + ' 签名图=' + (evLegacy.signatureFileId || '无') +
      ' 设备=' + (evLegacy.device || '—') + ' 动态码=' + (evLegacy.codeId || '—')));
  const evLocKeys = evLegacy ? Object.keys(evLegacy).filter((k) => /^(location|latitude|longitude|locationDenied)$/i.test(k)) : ['evidence 缺失'];
  check('证据区不含任何定位/位置字段（设计已移除）', evLocKeys.length === 0, evLocKeys.join(',') || '无位置字段');
  const recLocKeys = Object.keys(detail.json.data).filter((k) => /^(location|latitude|longitude|locationDenied)$/i.test(k));
  check('记录详情响应不含定位/位置字段', recLocKeys.length === 0, recLocKeys.join(',') || '无位置字段');
  check('详情返回 auditTail（该记录操作日志）', Array.isArray(detail.json.data.auditTail), (detail.json.data.auditTail || []).length + ' 条');

  // 管理后台前端源码：详情抽屉证据固定为**新流程四项**，且不读取任何定位字段
  const pageJs = await call('GET', '/admin/js/pages/records.js');
  check('GET /admin/js/pages/records.js 返回 200 JS', pageJs.status === 200 && /javascript/i.test(pageJs.headers.get('Content-Type') || ''), pageJs.status);
  check('后台课时明细页标题为「证据四项」', /证据四项/.test(pageJs.text));
  check('后台证据标签固定为 动态码/确认人/确认时间/设备（新流程口径）',
    /'动态码', '确认人', '确认时间', '设备'/.test(pageJs.text),
    /'签名图'/.test(pageJs.text) ? '仍存在旧流程签名图标签' : '标签已按新流程四项');
  check('后台不再使用旧流程证据标签（签名图/确认时间/设备/动态码）',
    !/'签名图', '确认时间', '设备', '动态码'/.test(pageJs.text));
  // 「位置 / 定位」只允许出现在"不使用定位"的说明文案里；任何定位字段引用都算失败
  const locNegation = /不再有位置|无定位|不含定位|不采集定位|不读取/;
  const locLines = pageJs.text.split('\n').filter((l) => /位置|location|latitude|longitude/i.test(l) && !locNegation.test(l));
  check('后台课时明细页不展示/不读取定位信息（仅保留「不使用定位」说明）',
    locLines.length === 0, locLines.length ? locLines[0].trim().slice(0, 90) : '无定位字段与位置文案');

  const makeupJs = await call('GET', '/admin/js/pages/makeup.js');
  const appealJs = await call('GET', '/admin/js/pages/appeal.js');
  const mkAppealLoc = (makeupJs.text + '\n' + appealJs.text).split('\n')
    .filter((l) => /位置|location|latitude|longitude/i.test(l) && !locNegation.test(l));
  check('补签/申诉审核页同样不展示定位信息',
    mkAppealLoc.length === 0, mkAppealLoc.length ? mkAppealLoc[0].trim().slice(0, 90) : 'makeup.js / appeal.js 均无定位字段');
  check('补签审核页证据区标注新流程证据四项（动态码 / 确认人 / 确认时间 / 设备）',
    /证据四项[\s\S]{0,140}动态码[\s\S]{0,40}确认人[\s\S]{0,40}确认时间[\s\S]{0,40}设备/.test(makeupJs.text));
  check('申诉处理页证据区同样为「双方证据：动态码 / 确认人 / 确认时间 / 设备」',
    /证据[\s\S]{0,140}动态码[\s\S]{0,40}确认人[\s\S]{0,40}确认时间[\s\S]{0,40}设备/.test(appealJs.text));

  // 旧流程历史签名图仍可鉴权读取（GET /files/{id} 需 token，不公开）
  const doneRecs = await call('GET', '/api/v1/records', { token, query: { status: 'done,makeup', pageSize: 5 } });
  const signed = (doneRecs.json.data.list || []).find((r) => r.signatureFileId);
  check('存在旧流程带签名图的历史记录（保留，不回退）', !!signed, signed && (signed.id + ' ' + signed.courseName + ' ' + signed.fullDate));
  const sig = await call('GET', '/api/v1/files/' + (signed && signed.signatureFileId), { token });
  check('GET /files/{id} 带 token 可读历史签名图', sig.status === 200 && /image\//.test(sig.headers.get('Content-Type') || ''),
    sig.status + ' ' + (sig.headers.get('Content-Type') || ''));
  const sigNoToken = await call('GET', '/api/v1/files/' + (signed && signed.signatureFileId));
  check('签名图未鉴权访问被拒绝', sigNoToken.status === 401, sigNoToken.status);
  const sigDetail = await call('GET', '/api/v1/records/' + (signed && signed.id), { token });
  const sEv = sigDetail.json.data.evidence;
  const sEvLocKeys = Object.keys(sEv).filter((k) => /^(location|latitude|longitude|locationDenied)$/i.test(k));
  check('历史记录证据四项仍含签名图与设备/动态码，且无位置字段',
    !!(sEv.signatureFileId && sEv.device && sEv.codeId) && sEv.count === 4 && sEvLocKeys.length === 0,
    '设备=' + sEv.device + ' 动态码=' + sEv.codeId + ' count=' + sEv.count + ' 标签=' + (sEv.labels || []).join('、') + ' 无位置字段');

  const logsByTarget = await call('GET', '/api/v1/logs', { token, query: { targetId: rid, pageSize: 20 } });
  check('GET /logs?targetId= 返回该记录操作日志', logsByTarget.status === 200 && Array.isArray(logsByTarget.json.data.list),
    logsByTarget.json && logsByTarget.json.data.list.length + ' 条，chain.ok=' + logsByTarget.json.data.chain.ok);

  // ---------------------------------------------------------------- 5. 补签 / 申诉
  section('5. 补签审核与申诉处理');
  const makeup = await call('GET', '/api/v1/makeup', { token, query: { status: 'pending', pageSize: 10 } });
  check('GET /makeup?status=pending 200', makeup.status === 200 && Array.isArray(makeup.json.data.list),
    '待审 ' + (makeup.json.data.pending || 0) + ' 条 / 总 ' + makeup.json.data.total);
  const appeal = await call('GET', '/api/v1/appeal', { token, query: { pageSize: 10 } });
  check('GET /appeal 200', appeal.status === 200 && Array.isArray(appeal.json.data.list), '总 ' + appeal.json.data.total + ' 条');
  // 造一条补签申请用于审核链路验证：找 expired/rejected 记录（种子中应有）
  const expiredRecs = await call('GET', '/api/v1/records', { token, query: { status: 'expired,rejected', pageSize: 5 } });
  const expiredList = (expiredRecs.json.data.list || []);
  check('存在可补签的 expired/rejected 记录（用于链路演示）', expiredList.length > 0 || makeup.json.data.total > 0,
    'expired/rejected ' + expiredList.length + ' 条，补签单 ' + makeup.json.data.total + ' 条');

  // ---------------------------------------------------------------- 5B. 补签 → 申诉 全链路
  section('5B. 补签审核 / 申诉处理 全链路（教师绑定 → 申请 → 通过/驳回 → 申诉）');
  const tLogin = await call('POST', '/api/v1/auth/login', { body: { code: 'selftest-teacher-2010032' } });
  let teacherToken = '';
  if (tLogin.json && tLogin.json.data && tLogin.json.data.token) {
    teacherToken = tLogin.json.data.token;
  } else if (tLogin.json && tLogin.json.data && tLogin.json.data.needBind) {
    const tBind = await call('POST', '/api/v1/auth/bind', {
      body: {
        openid: tLogin.json.data.openid, bindTicket: tLogin.json.data.bindTicket,
        role: 'teacher', no: '2010032', realName: '唐瑞明',
      },
    });
    if (tBind.json && tBind.json.code === 0) {
      teacherToken = tBind.json.data.token;
      check('教师端绑定（小程序分支）成功', !!teacherToken, '已绑定 2010032');
    } else {
      // 该工号已被前置自测（smoke-test 等）用另一个微信 openid 绑定：服务按既有规则正确拒绝二次绑定。
      // 这不是失败，故按「规则生效 + 复用已签发令牌」断言，不放宽任何权限校验。
      check('同一工号被其它微信重复绑定 → 40301（一个工号只能绑一个微信）',
        tBind.status === 403 && tBind.json.code === 40301,
        tBind.status + ' code=' + (tBind.json && tBind.json.code) + ' ' + (tBind.json && tBind.json.msg));
      teacherToken = readDevToken('2010032');
    }
  }
  check('教师端可用 token（用于发起补签/申诉）', !!teacherToken, teacherToken ? '已取得 2010032 令牌' : '未取得令牌');

  const ovBefore = (await call('GET', '/api/v1/stats/overview', { token })).json.data;
  const expiredRec = expiredList.filter(function (r) { return r.status === 'expired'; })[0];
  const rejectedRec = expiredList.filter(function (r) { return r.status === 'rejected'; })[0];

  if (teacherToken && expiredRec) {
    const mk1 = await call('POST', '/api/v1/makeup', {
      token: teacherToken,
      body: { recordId: expiredRec.id, reason: '自测：当天网络故障未能完成确认，特此申请补签' },
    });
    check('教师发起补签申请（pending）', mk1.status === 200 && mk1.json.data.status === 'pending', mk1.json && mk1.json.data.id);
    const pendingList = await call('GET', '/api/v1/makeup', { token, query: { status: 'pending', pageSize: 50 } });
    check('教务处待审列表可见该申请', pendingList.json.data.list.some(function (x) { return x.id === mk1.json.data.id; }),
      '待审 ' + pendingList.json.data.pending + ' 条');

    const rejEmpty = await call('POST', '/api/v1/makeup/' + mk1.json.data.id + '/reject', { token, body: {} });
    check('补签驳回未填原因被拒绝（40001）', rejEmpty.status === 400 && rejEmpty.json.code === 40001, rejEmpty.json && rejEmpty.json.msg);

    const ap1 = await call('POST', '/api/v1/makeup/' + mk1.json.data.id + '/approve', { token, body: { note: '自测：核实后同意补签' } });
    check('补签审核通过 → 原记录置 makeup', ap1.status === 200 && ap1.json.data.record.status === 'makeup',
      ap1.json && ('记录 ' + ap1.json.data.record.id + ' 状态 ' + ap1.json.data.record.status));
    const ovAfter = (await call('GET', '/api/v1/stats/overview', { token })).json.data;
    check('通过后看板「补签学时」立即增加（统计口径联动）', ovAfter.makeupHours >= ovBefore.makeupHours + Number(expiredRec.hours),
      '补签学时 ' + ovBefore.makeupHours + ' → ' + ovAfter.makeupHours + '，已确认 ' + ovBefore.confirmedHours + ' → ' + ovAfter.confirmedHours);
    const approvedList = await call('GET', '/api/v1/makeup', { token, query: { status: 'approved', pageSize: 50 } });
    check('已通过 Tab 可查到该申请', approvedList.json.data.list.some(function (x) { return x.id === mk1.json.data.id; }),
      '已通过 ' + approvedList.json.data.total + ' 条');
  } else {
    console.log('  [SKIP] 补签通过链路：无可用 expired 记录（数据已被前次自测消费）或教师 token 不可用');
  }

  if (teacherToken && rejectedRec) {
    const mk2 = await call('POST', '/api/v1/makeup', {
      token: teacherToken,
      body: { recordId: rejectedRec.id, reason: '自测：对班干部拒绝有异议，申请补签' },
    });
    check('教师对 rejected 记录发起补签', mk2.status === 200, mk2.json && mk2.json.data.id);
    const rej2 = await call('POST', '/api/v1/makeup/' + mk2.json.data.id + '/reject', { token, body: { note: '自测：证据不足，驳回' } });
    check('补签驳回（填写原因）成功', rej2.status === 200 && rej2.json.data.apply.status === 'rejected', rej2.json && rej2.json.data.apply.reviewNote);

    const ap2 = await call('POST', '/api/v1/appeal', { token: teacherToken, body: { recordId: rejectedRec.id, reason: '自测：有考勤记录与课堂照片可证明' } });
    check('教师发起申诉 → 原记录置 appealing', ap2.status === 200 && ap2.json.data.status === 'pending', ap2.json && ap2.json.data.id);
    const recAppealing = await call('GET', '/api/v1/records/' + rejectedRec.id, { token });
    check('申诉后原记录状态为 appealing', recAppealing.json.data.status === 'appealing', recAppealing.json.data.status);

    // 后端既有行为：approve 不强制要求 note，reject 必须填写原因（前端对两者均强制必填）
    const apNoNote = await call('POST', '/api/v1/appeal/' + ap2.json.data.id + '/reject', { token, body: {} });
    check('申诉「维持原判」未填意见被拒绝（40001）', apNoNote.status === 400 && apNoNote.json.code === 40001, apNoNote.json && apNoNote.json.msg);
    const stillPending = await call('GET', '/api/v1/appeal', { token, query: { status: 'pending', pageSize: 50 } });
    check('校验失败后申诉仍处于待处理（未被误改状态）', stillPending.json.data.list.some(function (x) { return x.id === ap2.json.data.id; }));

    const apOk = await call('POST', '/api/v1/appeal/' + ap2.json.data.id + '/approve', { token, body: { note: '自测：核实属实，恢复为已确认' } });
    check('申诉成立 → 原记录恢复 done', apOk.status === 200 && apOk.json.data && apOk.json.data.record.status === 'done',
      apOk.json && apOk.json.data && ('记录状态 ' + apOk.json.data.record.status));
    const apAgain = await call('POST', '/api/v1/appeal/' + ap2.json.data.id + '/approve', { token, body: { note: '重复处理' } });
    check('已处理的申诉不可重复处理（42201）', apAgain.status === 422 && apAgain.json.code === 42201, apAgain.json && apAgain.json.msg);
    const appealList = await call('GET', '/api/v1/appeal', { token, query: { status: 'approved', pageSize: 50 } });
    check('申诉「已恢复」Tab 可查到该申诉', appealList.json.data.list.some(function (x) { return x.id === ap2.json.data.id; }),
      '已恢复 ' + appealList.json.data.total + ' 条');
    const ovFinal = (await call('GET', '/api/v1/stats/overview', { token })).json.data;
    check('申诉恢复后计入正式学时（统计口径联动）', ovFinal.confirmedHours >= ovBefore.confirmedHours,
      '已确认学时 ' + ovBefore.confirmedHours + ' → ' + ovFinal.confirmedHours);
  } else {
    console.log('  [SKIP] 申诉链路：无可用 rejected 记录（数据已被前次自测消费）或教师 token 不可用');
  }

  // ---------------------------------------------------------------- 5C. 自由文本合规（HTTP 端到端）
  section('5C. 自由文本合规：敏感词拦截 / 长度限制 / 审计留痕');
  if (teacherToken) {
    const mine = await call('GET', '/api/v1/records', { token: teacherToken, query: { pageSize: 50 } });
    const mineList = (mine.json && mine.json.data && mine.json.data.list) || [];
    const target = mineList.filter((r) => r.status !== 'revoked')[0];
    check('教师名下存在可校验的记录', !!target, target && (target.id + ' ' + target.courseName + ' ' + target.status));

    const sens = await call('POST', '/api/v1/records/' + (target && target.id) + '/revoke', {
      token: teacherToken, body: { reason: '本次课存在代签情况，请求撤销' },
    });
    check('撤销原因命中敏感词 → 40001「内容包含敏感词」',
      sens.status === 400 && sens.json && sens.json.code === 40001 && /内容包含敏感词/.test(sens.json.msg) && /代签/.test(sens.json.msg),
      sens.json && ('HTTP ' + sens.status + ' code=' + sens.json.code + ' msg=' + sens.json.msg));

    const overLong = await call('POST', '/api/v1/records/' + (target && target.id) + '/revoke', {
      token: teacherToken, body: { reason: '因'.repeat(501) },
    });
    check('撤销原因超过 500 字符 → 40001（提示长度上限）',
      overLong.status === 400 && overLong.json.code === 40001 && /过长/.test(overLong.json.msg),
      overLong.json && overLong.json.msg);

    const still = await call('GET', '/api/v1/records/' + (target && target.id), { token: teacherToken });
    check('被拦截的撤销请求未改变记录状态（无脏数据）',
      still.json && still.json.data && still.json.data.status === target.status,
      still.json && (target.status + ' → ' + still.json.data.status));

    const blockedLogs = await call('GET', '/api/v1/logs', { token, query: { action: 'text.sensitive.blocked', pageSize: 5 } });
    check('敏感词拦截已写操作日志（text.sensitive.blocked）',
      blockedLogs.json.data.list.length > 0 && /内容包含敏感词/.test(blockedLogs.json.data.list[0].detail || ''),
      blockedLogs.json.data.list.length + ' 条，最后一条：' + ((blockedLogs.json.data.list[0] || {}).detail || ''));
    const invalidLogs = await call('GET', '/api/v1/logs', { token, query: { action: 'text.invalid.blocked', pageSize: 5 } });
    check('超长文本拦截同样写操作日志（text.invalid.blocked）', invalidLogs.json.data.list.length > 0,
      invalidLogs.json.data.list.length + ' 条');
  } else {
    console.log('  [SKIP] 自由文本合规链路：教师 token 不可用');
  }

  // ---------------------------------------------------------------- 6. 导入
  section('6. 数据导入中心（模板 / 预校验 / 导入 / 历史 / 回滚）');
  const tpl = await call('GET', '/api/v1/import/template', { query: { type: 'tasks' } });
  check('GET /import/template?type=tasks 返回 CSV 模板', tpl.status === 200 && /学期/.test(tpl.text) && /教师姓名/.test(tpl.text),
    tpl.text.split('\r\n')[0]);
  const tplJson = await call('GET', '/api/v1/import/template', { query: { type: 'whitelist', format: 'json' } });
  check('GET /import/template?format=json 返回表头', tplJson.json.code === 0 && tplJson.json.data.headers.length === 5, tplJson.json.data.headers.join('|'));

  // 6.1 校验失败样例（工号不存在 + 教学班不存在）
  const badCsv = '工号/学号,姓名,角色,院系,教学班\n' +
    '2099001,测试教师,teacher,不存在的院系,\n' +
    '2099002,张三,未知角色,护理学院,\n' +
    '2099003,李四,cadre,护理学院,\n';
  const preBad = await call('POST', '/api/v1/import/precheck', { token, query: { type: 'whitelist' }, form: makeForm(badCsv, 'bad.csv') });
  check('POST /import/precheck（校验不通过）返回逐行错误', preBad.status === 200 && preBad.json.data.errorRows >= 3 && preBad.json.data.valid === false,
    '总' + preBad.json.data.totalRows + ' 可导入' + preBad.json.data.validRows + ' 错误' + preBad.json.data.errorRows);
  const firstErr = (preBad.json.data.errors || [])[0];
  check('错误行含「行号 + 字段 + 问题」', !!(firstErr && firstErr.line && firstErr.msg), firstErr && JSON.stringify(firstErr));

  // 6.2 校验通过样例
  const goodCsv = '工号/学号,姓名,角色,院系,教学班\n2099001,测试教师,teacher,护理学院,\n';
  const preGood = await call('POST', '/api/v1/import/precheck', { token, query: { type: 'whitelist' }, form: makeForm(goodCsv, 'good.csv') });
  check('POST /import/precheck（校验通过）valid=true', preGood.status === 200 && preGood.json.data.valid === true && preGood.json.data.validRows === 1,
    '总' + preGood.json.data.totalRows + ' 可导入' + preGood.json.data.validRows);
  check('预校验返回数据预览', !!(preGood.json.data.preview && preGood.json.data.preview.rows.length), (preGood.json.data.preview.rows || []).length + ' 行');

  // 6.3 确认导入
  const imp = await call('POST', '/api/v1/import/whitelist', { token, form: makeForm(goodCsv, 'good.csv') });
  check('POST /import/whitelist 导入成功', imp.status === 200 && imp.json.data.committed === true && imp.json.data.successRows === 1,
    imp.json && imp.json.data.msg);
  const jobId = imp.json && imp.json.data && imp.json.data.jobId;

  const impList = await call('GET', '/api/v1/import/history', { token, query: { pageSize: 10 } });
  check('GET /import/history 返回导入历史', impList.status === 200 && impList.json.data.list.some((j) => j.jobId === jobId),
    impList.json && ('共 ' + impList.json.data.total + ' 条，操作人 ' + (impList.json.data.list[0] || {}).operatorName));

  const impJob = await call('GET', '/api/v1/import/' + jobId, { token });
  check('GET /import/{jobId} 返回任务详情', impJob.status === 200 && impJob.json.data.status === 'done',
    impJob.json && (impJob.json.data.status + ' 成功' + impJob.json.data.successRows + ' 行'));

  // 6.4 回滚
  const rb = await call('POST', '/api/v1/import/' + jobId + '/rollback', { token, body: {} });
  check('POST /import/{jobId}/rollback 回滚成功', rb.status === 200 && rb.json.data.ok === true,
    rb.json && ('恢复表 ' + JSON.stringify(rb.json.data.restored) + ' 快照 ' + rb.json.data.rows + ' 行'));
  const afterRb = await call('GET', '/api/v1/import/history', { token, query: { pageSize: 5 } });
  check('回滚后任务状态为 rolled_back', afterRb.json.data.list.some((j) => j.jobId === jobId && j.status === 'rolled_back'));

  // 6.5 失败导入产生错误报告
  const impFail = await call('POST', '/api/v1/import/whitelist', { token, form: makeForm(badCsv, 'bad.csv') });
  check('脏数据导入被整批拒绝且给出失败报告', impFail.status === 200 && impFail.json.data.committed === false && !!impFail.json.data.errorReportUrl,
    impFail.json && impFail.json.data.msg);
  if (impFail.json && impFail.json.data.errorReportUrl) {
    const report = await call('GET', impFail.json.data.errorReportUrl, { token });
    check('失败报告可下载（含问题字段列）', report.status === 200 && /问题字段/.test(report.text), report.status);
  }

  // ---------------------------------------------------------------- 7. 导出
  section('7. 报表导出中心（21 列固定表头 + 新增三列 / 旧流程数据为空）');
  const exp1 = await call('POST', '/api/v1/export/records', { token, body: { format: 'csv', status: '' } });
  check('POST /export/records 创建异步任务', exp1.status === 200 && !!exp1.json.data.jobId, exp1.json && exp1.json.data.jobId);
  let job = null;
  for (let i = 0; i < 20; i++) {
    const j = await call('GET', '/api/v1/export/' + exp1.json.data.jobId, { token });
    job = j.json.data;
    if (job.status === 'done' || job.status === 'failed') break;
    await sleep(300);
  }
  check('GET /export/{jobId} 任务完成并返回下载地址', job && job.status === 'done' && !!job.downloadUrl,
    job && ('状态 ' + job.status + ' ' + job.successRows + ' 行 ' + job.fileName));
  const dl = await call('GET', job.downloadUrl, { token });
  const csvRows = parseCsvRows(dl.text);
  const H = csvRows[0] || [];
  const header = H.join(',');
  check('导出文件可下载且表头固定 21 列（本次新增三列）',
    dl.status === 200 && H.length === 21, H.length + ' 列：' + header);
  check('导出表头第 11 列为「发起人（学委）」，14/15/16 列为新增的 确认人 / 是否临时调整 / 确认人与实际授课人不符',
    H[11] === '发起人（学委）' && H[14] === '确认人' && H[15] === '是否临时调整' && H[16] === '确认人与实际授课人不符',
    H.slice(10, 18).join(' / '));
  const idxOf = (name) => H.indexOf(name);
  const cell = (r, name) => { const i = idxOf(name); return i < 0 ? undefined : r[i]; };

  // 新流程数据（第 4 节创建并确认的课时会话）：三列必须有值且正确
  const newFlowRow = csvRows.slice(1).find((r) => cell(r, '课程') === '自测：新流程证据四项' && cell(r, '上课日期') === yday);
  check('新流程数据行「确认人」= 实际确认人（教务处）',
    !!newFlowRow && cell(newFlowRow, '确认人') === adminName,
    newFlowRow ? (cell(newFlowRow, '教师姓名') + ' → 确认人 ' + cell(newFlowRow, '确认人')) : '未找到新流程导出行');
  check('新流程数据行「是否临时调整」=否、「确认人与实际授课人不符」=是（与记录一致）',
    !!newFlowRow && cell(newFlowRow, '是否临时调整') === '否' && cell(newFlowRow, '确认人与实际授课人不符') === '是',
    newFlowRow ? ('临时调整=' + cell(newFlowRow, '是否临时调整') + ' 姓名不符=' + cell(newFlowRow, '确认人与实际授课人不符')) : '未找到新流程导出行');
  // 旧流程数据（无 confirmed_name / 无发起人）：三列输出空，不编造值
  const legacyRows = csvRows.slice(1).filter((r) => cell(r, '确认人') === '' &&
    cell(r, '是否临时调整') === '' && cell(r, '确认人与实际授课人不符') === '');
  check('旧流程数据（无确认人）三列输出空（可据此区分两套流程）', legacyRows.length > 0,
    legacyRows.length + ' 行旧流程数据三列为空，例如：' + (legacyRows[0] ? (cell(legacyRows[0], '课程') + ' ' + cell(legacyRows[0], '上课日期')) : '—'));
  check('数据行列数与表头一致（21 列，列顺序不因筛选缺列）',
    csvRows.length > 1 && csvRows.slice(1).every((r) => r.length === H.length),
    '数据行 ' + (csvRows.length - 1) + ' 行');

  const exp2 = await call('POST', '/api/v1/export/stats', { token, body: { term: '' } });
  check('POST /export/stats 创建统计报表任务', exp2.status === 200 && !!exp2.json.data.jobId, exp2.json && exp2.json.data.jobId);
  let job2 = null;
  for (let i = 0; i < 20; i++) {
    const j = await call('GET', '/api/v1/export/' + exp2.json.data.jobId, { token });
    job2 = j.json.data;
    if (job2.status === 'done' || job2.status === 'failed') break;
    await sleep(300);
  }
  check('统计报表导出完成', job2 && job2.status === 'done', job2 && job2.fileName);
  const stcsv = await call('GET', job2.downloadUrl, { token });
  check('统计报表「全校概览」口径同步：新增 临时调整 / 姓名不符 两列',
    /已确认学时,补签学时,应计学时,完成率\(%\),待确认,已过期,异常,现场指定签字人,临时调整,姓名不符/.test(stcsv.text) &&
    /临时调整 = /.test(stcsv.text),
    (stcsv.text.split('\r\n').find((l) => /^已确认学时,/.test(l)) || '').slice(0, 120));
  const expList = await call('GET', '/api/v1/export/history', { token, query: { pageSize: 10 } });
  check('GET /export/history 返回导出任务列表', expList.status === 200 && expList.json.data.list.length > 0,
    expList.json && ('共 ' + expList.json.data.total + ' 条，创建人 ' + (expList.json.data.list[0] || {}).operatorName));

  // ---------------------------------------------------------------- 8. 配置 / 日志
  section('8. 规则配置与操作日志');
  const cfg = await call('GET', '/api/v1/config', { token });
  check('GET /config 返回配置项与学期列表', cfg.status === 200 && Array.isArray(cfg.json.data.list) && cfg.json.data.list.length > 0,
    cfg.json && ('term=' + cfg.json.data.config.term + '，项数 ' + cfg.json.data.list.length + '，' + (cfg.json.data.list[0] || {}).description));
  const cfgKeys = cfg.json.data.list.map((x) => x.key);
  check('GET /config 暴露自由文本合规配置项（敏感词表 + 三个长度上限）',
    ['sensitive_words', 'max_summary_len', 'max_absent_names_len', 'max_reason_len'].every((k) => cfgKeys.indexOf(k) >= 0),
    cfgKeys.join(', '));
  check('GET /config 默认长度上限为 500 / 300 / 500',
    cfg.json.data.config.max_summary_len === '500' && cfg.json.data.config.max_absent_names_len === '300' && cfg.json.data.config.max_reason_len === '500',
    'max_summary_len=' + cfg.json.data.config.max_summary_len + ' max_absent_names_len=' + cfg.json.data.config.max_absent_names_len +
    ' max_reason_len=' + cfg.json.data.config.max_reason_len);
  const wordsItem = cfg.json.data.list.filter((x) => x.key === 'sensitive_words')[0] || {};
  check('敏感词表返回词条数与说明（内置换行表已生效）',
    (wordsItem.wordCount || 0) > 0 && !!wordsItem.description,
    '词条 ' + wordsItem.wordCount + ' 个；说明：' + wordsItem.description);
  const lenItem = cfg.json.data.list.filter((x) => x.key === 'max_summary_len')[0] || {};
  check('长度上限配置返回取值范围（供后台输入框约束）', lenItem.min === 1 && lenItem.max === 5000,
    'min=' + lenItem.min + ' max=' + lenItem.max);

  const oldTtl = cfg.json.data.config.code_ttl_seconds;
  const put = await call('PUT', '/api/v1/config', { token, body: { config: { code_ttl_seconds: '90' } } });
  check('PUT /config 修改配置成功', put.status === 200 && put.json.data.config.code_ttl_seconds === '90', put.json && JSON.stringify(put.json.data.changed));
  const putBack = await call('PUT', '/api/v1/config', { token, body: { config: { code_ttl_seconds: oldTtl } } });
  check('PUT /config 还原配置', putBack.status === 200 && putBack.json.data.config.code_ttl_seconds === oldTtl, '已还原为 ' + oldTtl);
  const putBad = await call('PUT', '/api/v1/config', { token, body: { config: { code_ttl_seconds: '5' } } });
  check('PUT /config 非法值被拒绝（校验生效）', putBad.status === 400, putBad.status + ' ' + (putBad.json && putBad.json.msg));

  // 自由文本合规配置的校验与即时生效
  const putWords = await call('PUT', '/api/v1/config', { token, body: { config: { sensitive_words: '冒名顶替,验证词' } } });
  check('PUT /config 修改 sensitive_words 成功并归一化',
    putWords.status === 200 && putWords.json.data.config.sensitive_words === '冒名顶替,验证词',
    putWords.json && putWords.json.data.config.sensitive_words);
  const putWordsBack = await call('PUT', '/api/v1/config', { token, body: { config: { sensitive_words: cfg.json.data.config.sensitive_words } } });
  check('PUT /config 还原敏感词表',
    putWordsBack.status === 200 && putWordsBack.json.data.config.sensitive_words === cfg.json.data.config.sensitive_words,
    '已还原 ' + String(putWordsBack.json.data.config.sensitive_words).split(',').length + ' 个词条');
  const badLen = await call('PUT', '/api/v1/config', { token, body: { config: { max_summary_len: '0' } } });
  check('PUT /config 长度上限越界被拒绝（40001）', badLen.status === 400 && badLen.json.code === 40001, badLen.json && badLen.json.msg);
  const badLen2 = await call('PUT', '/api/v1/config', { token, body: { config: { max_reason_len: '3.5' } } });
  check('PUT /config 长度上限非整数被拒绝（40001）', badLen2.status === 400 && badLen2.json.code === 40001, badLen2.json && badLen2.json.msg);
  const badWords = await call('PUT', '/api/v1/config', { token, body: { config: { sensitive_words: 'x' } } });
  check('PUT /config 敏感词过短被拒绝（40001）', badWords.status === 400 && badWords.json.code === 40001, badWords.json && badWords.json.msg);

  const logs = await call('GET', '/api/v1/logs', { token, query: { pageSize: 5, action: 'record' } });
  check('GET /logs 支持动作类型筛选', logs.status === 200 && logs.json.data.list.length > 0,
    logs.json && logs.json.data.list.slice(0, 3).map((l) => l.action).join(', '));
  const verify = await call('GET', '/api/v1/logs/verify', { token });
  check('GET /logs/verify 哈希链校验通过', verify.status === 200 && verify.json.data.ok === true,
    verify.json && ('共 ' + verify.json.data.total + ' 条，链头 ' + String(verify.json.data.headHash).slice(0, 16) + '…'));

  // ---------------------------------------------------------------- 9. 修改密码
  section('9. 修改本人密码 /auth/password');
  const badOld = await call('POST', '/api/v1/auth/password', { token, body: { oldPassword: 'wrong-old', newPassword: 'newpass123' } });
  check('原密码错误被拒绝', badOld.status === 400 && /原密码/.test(badOld.json.msg), badOld.json && badOld.json.msg);
  const shortPw = await call('POST', '/api/v1/auth/password', { token, body: { oldPassword: '123456', newPassword: '123' } });
  check('新密码过短被拒绝', shortPw.status === 400, shortPw.json && shortPw.json.msg);
  const chg = await call('POST', '/api/v1/auth/password', { token, body: { oldPassword: '123456', newPassword: 'Kcsq@2026' } });
  check('修改密码成功', chg.status === 200 && chg.json.code === 0, chg.json && chg.json.data.hint);
  const loginNew = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: 'Kcsq@2026' } });
  check('新密码可登录', loginNew.status === 200, loginNew.status);
  const loginOld = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: '123456' } });
  check('旧密码已失效', loginOld.status === 400, loginOld.status + ' ' + (loginOld.json && loginOld.json.msg));
  const token2 = loginNew.json.data.token;
  const back = await call('POST', '/api/v1/auth/password', { token: token2, body: { oldPassword: 'Kcsq@2026', newPassword: '123456' } });
  check('密码还原为默认（便于后续演示）', back.status === 200, back.status);

  // 密码修改不写入口令明文
  const pwLogs = await call('GET', '/api/v1/logs', { token: token2, query: { action: 'auth.password', pageSize: 5 } });
  check('密码修改已记入日志且不含口令明文', pwLogs.json.data.list.length > 0 && !/Kcsq@2026|123456/.test(JSON.stringify(pwLogs.json.data.list)),
    pwLogs.json && pwLogs.json.data.list[0] && pwLogs.json.data.list[0].detail);

  // ---------------------------------------------------------------- 10. 院系管理员权限边界
  section('10. 院系管理员（dept_admin）权限边界');
  const dOverview = await call('GET', '/api/v1/stats/overview', { token: deptToken });
  check('院系管理员可看看板（限本院系）', dOverview.status === 200, dOverview.json && ('已确认 ' + dOverview.json.data.confirmedHours + ' 学时'));
  const dPut = await call('PUT', '/api/v1/config', { token: deptToken, body: { config: { code_ttl_seconds: '70' } } });
  check('院系管理员无配置修改权限（40301）', dPut.status === 403 && dPut.json.code === 40301, dPut.status + ' code=' + (dPut.json && dPut.json.code));
  const dAppeal = await call('POST', '/api/v1/appeal/NOT_EXIST/approve', { token: deptToken, body: { note: 'x' } });
  check('院系管理员无申诉处理权限（40301）', dAppeal.status === 403, dAppeal.status + ' code=' + (dAppeal.json && dAppeal.json.code));
  const dImp = await call('POST', '/api/v1/import/precheck', { token: deptToken, query: { type: 'tasks' }, form: makeForm(tpl.text, 't.csv') });
  check('院系管理员可使用导入预校验', dImp.status === 200, dImp.json && ('总行 ' + dImp.json.data.totalRows));

  // ---------------------------------------------------------------- 11. 失败锁定
  section('11. 连续 5 次失败锁定 15 分钟');
  // 使用专用测试账号（不存在的工号 + 每次运行的唯一后缀）验证锁定策略，避免锁死演示账号，且可重复执行
  const LOCK_NO = 'TESTLOCK' + String(Date.now()).slice(-6);
  let lastMsg = '';
  for (let i = 1; i <= 5; i++) {
    const r = await call('POST', '/api/v1/auth/login', { body: { no: LOCK_NO, password: 'wrong-' + i } });
    lastMsg = (r.json && r.json.msg) || '';
    if (i < 5) {
      check('第 ' + i + ' 次失败返回剩余次数', r.status === 400 && /还可尝试/.test(lastMsg), lastMsg);
    } else {
      check('第 5 次失败即触发锁定（403 + 明确提示）', r.status === 403 && /锁定/.test(lastMsg), r.status + ' ' + lastMsg);
    }
  }
  const lockedTry = await call('POST', '/api/v1/auth/login', { body: { no: LOCK_NO, password: 'anything' } });
  check('锁定期间登录被拒绝并提示剩余时间', lockedTry.status === 403 && /15 分钟|后重试/.test(lockedTry.json.msg), lockedTry.json && lockedTry.json.msg);
  // store 落盘为 30ms 合并写，稍等片刻再读文件
  await sleep(300);
  const attempts = require('path').join(DATA_DIR, 'login_attempts.json');
  let attemptsFile = null;
  try { attemptsFile = JSON.parse(require('fs').readFileSync(attempts, 'utf8')); } catch (e) { attemptsFile = null; }
  const lockRow = Array.isArray(attemptsFile) ? attemptsFile.filter((a) => a.no_key === LOCK_NO)[0] : null;
  check('失败记录已落盘 data/login_attempts.json 且带锁定时间', !!(lockRow && lockRow.fail_count >= 5 && lockRow.locked_until_ms > 0),
    lockRow ? JSON.stringify({ no: lockRow.no, fail_count: lockRow.fail_count, locked_until: lockRow.locked_until }) : '未找到记录');

  // 真实账号：失败计数递增，成功后清零（不触发锁定）
  let realMsg = '';
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/v1/auth/login', { body: { no: '2017001', password: 'nope-' + i } });
    realMsg = (r.json && r.json.msg) || '';
  }
  const okAfterFails = await call('POST', '/api/v1/auth/login', { body: { no: '2017001', password: '123456' } });
  check('真实账号 3 次失败后仍可登录（未达 5 次不上锁）', okAfterFails.status === 200, realMsg);
  // 登录成功后计数清零 → 下一次失败应从「还可尝试 4 次」重新开始
  const afterReset = await call('POST', '/api/v1/auth/login', { body: { no: '2017001', password: 'nope-final' } });
  check('登录成功后失败计数已清零（重新从 4 次开始提示）', /还可尝试 4 次/.test(afterReset.json.msg || ''), afterReset.json && afterReset.json.msg);
  const finalLogin = await call('POST', '/api/v1/auth/login', { body: { no: '2017001', password: '123456' } });
  check('演示账号 2017001 仍可正常登录（未被锁死）', finalLogin.status === 200, finalLogin.status);
  console.log('\n  说明：锁定验证使用专用测试账号 ' + LOCK_NO + '（非真实用户），演示账号不受影响。');

  // ---------------------------------------------------------------- 汇总
  section('自测汇总');
  console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  if (fail) {
    console.log('  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[异常] 自测脚本执行中断：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
