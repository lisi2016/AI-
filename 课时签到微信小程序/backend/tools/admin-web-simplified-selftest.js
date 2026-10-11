'use strict';
/**
 * 教务处 Web 管理后台 · 业务流程简化适配自测（只读，Node 18+，无第三方依赖）
 *
 * 用法：
 *   node tools/admin-web-simplified-selftest.js                          # 默认真实后端 http://8.138.41.74
 *   SELFTEST_BASE=http://127.0.0.1:8091 node tools/admin-web-simplified-selftest.js
 *   SELFTEST_BASE=... SELFTEST_EXPORT=1 node tools/admin-web-simplified-selftest.js   # 额外验证导出表头（会新建 1 个导出任务）
 *
 * 覆盖：
 *   1. 登录（账号密码，ADMIN001/123456）
 *   2. GET /sessions：列表 + 新字段（实际授课人 / 发起人 / 确认人 / 临时调整 / 姓名不符）+ statusTotals
 *   3. GET /sessions 新筛选：tempAdjusted / nameMismatch / teacherName / courseName
 *   4. GET /sessions/{id}：证据四项（动态码 / 确认人 / 确认时间 / 设备），无签名图、无位置键
 *   5. GET /stats/overview：tempAdjustedCount / nameMismatchCount / sessionCount / sessionDoneCount
 *   6. GET /class-courses：课程清单列表 + 新字段 + 班级/状态筛选
 *   7. 旧接口兼容：GET /records、GET /records/{id}
 *   8. 本地前端源码：新流程页面与「无签名图依赖」静态检查（不改后端、不上线也能验证）
 *   9. （可选 SELFTEST_EXPORT=1）导出表头列核对（21 列：含确认人 / 是否临时调整 / 确认人与实际授课人不符）
 *
 * 默认全程只读；仅 SELFTEST_EXPORT=1 时会创建一个导出任务（可视为写入，默认关闭）。
 */
// 不使用 BASE 环境变量名，避免与宿主自带的 BASE 冲突
const BASE = process.env.SELFTEST_BASE || 'http://8.138.41.74';
const ADMIN_DIR = require('path').join(__dirname, '..', 'public', 'admin');
const fs = require('fs');
const path = require('path');

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
  console.log('\n== ' + title + ' ' + '='.repeat(Math.max(2, 58 - title.length)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, opts) {
  const o = opts || {};
  const url = (p.startsWith('http') ? p : BASE + p) + (o.query ? qs(o.query) : '');
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  let body;
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, headers: res.headers, text, json, data: json && json.data };
}
function qs(q) {
  const parts = Object.keys(q).filter((k) => q[k] !== '' && q[k] !== undefined && q[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
  return parts.length ? '?' + parts.join('&') : '';
}
function readLocal(rel) {
  try { return fs.readFileSync(path.join(ADMIN_DIR, rel), 'utf8'); } catch (e) { return null; }
}
const KEYS_SIGNATURE = ['signatureUrl', 'signatureFileId', 'imageHash', 'signedAt', 'signature_path'];
const KEYS_LOCATION = ['location', 'latitude', 'longitude', 'locationDenied', 'location_denied'];
function leakKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).filter((k) => KEYS_SIGNATURE.concat(KEYS_LOCATION).indexOf(k) >= 0);
}

async function main() {
  console.log('业务流程简化 · 管理后台适配自测  BASE=' + BASE + '  时间=' + new Date().toISOString());

  // ---------------------------------------------------------------- 1. 健康检查
  section('1. 健康检查（真实后端可达）');
  const health = await call('GET', '/api/v1/health');
  check('GET /api/v1/health 返回 200 且 code=0', health.status === 200 && health.json && health.json.code === 0,
    health.data && health.data.counts ? ('记录数 records=' + health.data.counts.periodRecords + ' users=' + health.data.counts.users) : ('HTTP ' + health.status));

  // ---------------------------------------------------------------- 2. 登录
  section('2. 登录（账号密码）');
  const login = await call('POST', '/api/v1/auth/login', { body: { no: 'ADMIN001', password: '123456' } });
  check('POST /auth/login {ADMIN001,123456} 返回 200 且 code=0', login.status === 200 && login.json && login.json.code === 0,
    login.json && JSON.stringify({ code: login.json.code, msg: login.json.msg }));
  const token = login.data && login.data.token;
  check('登录返回 role=admin 且 token 非空', !!token && login.data.role === 'admin', login.data && login.data.role);
  if (!token) { console.log('\n  登录失败，后续接口检查终止。'); return summary(); }

  // ---------------------------------------------------------------- 3. 会话列表
  section('3. GET /sessions 列表与新字段');
  const sess = await call('GET', '/api/v1/sessions', { token, query: { page: 1, pageSize: 20 } });
  const sList = (sess.data && sess.data.list) || [];
  check('GET /sessions 返回 200 且 code=0', sess.status === 200 && sess.json && sess.json.code === 0, 'HTTP ' + sess.status);
  check('返回分页 list + total + summary', Array.isArray(sList) && sess.data.total !== undefined && !!sess.data.summary,
    'total=' + (sess.data && sess.data.total) + ' 本页 ' + sList.length + ' 条');

  const NEW_FIELDS = ['teacherName', 'initiatorName', 'confirmedName', 'isTempAdjusted', 'confirmNameMismatch', 'statusText', 'evidence'];
  const first = sList[0] || null;
  check('列表行含新流程字段（实际授课人/发起人/确认人/临时调整/姓名不符/状态/证据）',
    !!first && NEW_FIELDS.every((k) => first[k] !== undefined),
    first ? NEW_FIELDS.filter((k) => first[k] === undefined).join(' 缺失,') || '字段齐全' : '列表为空');
  check('列表中无签名图 / 位置字段泄漏',
    first ? leakKeys(first).length === 0 : false,
    first ? (leakKeys(first).join(',') || '无签名图与位置字段') : '列表为空');

  const sm = (sess.data && sess.data.summary) || {};
  check('summary 含 statusTotals（8 状态角标，不受 status= 影响）',
    !!sm.statusTotals && Object.keys(sm.statusTotals).length === 8,
    sm.statusTotals ? JSON.stringify(sm.statusTotals) : '缺失');
  check('summary 含 hours / tempAdjustedCount / nameMismatchCount',
    sm.hours !== undefined && sm.tempAdjustedCount !== undefined && sm.nameMismatchCount !== undefined,
    'hours=' + sm.hours + ' 临时调整=' + sm.tempAdjustedCount + ' 姓名不符=' + sm.nameMismatchCount);

  // ---------------------------------------------------------------- 4. 新筛选
  section('4. GET /sessions 新筛选条件');
  const fTemp = await call('GET', '/api/v1/sessions', { token, query: { tempAdjusted: 'true', pageSize: 200 } });
  const tempRows = (fTemp.data && fTemp.data.list) || [];
  check('tempAdjusted=true 生效（返回行全部为临时调整）',
    fTemp.status === 200 && tempRows.every((r) => r.isTempAdjusted === true),
    '命中 ' + tempRows.length + ' 条');

  const fMm = await call('GET', '/api/v1/sessions', { token, query: { nameMismatch: 'true', pageSize: 200 } });
  const mmRows = (fMm.data && fMm.data.list) || [];
  check('nameMismatch=true 生效（返回行全部为姓名不符）',
    fMm.status === 200 && mmRows.every((r) => r.confirmNameMismatch === true),
    '命中 ' + mmRows.length + ' 条');

  if (first && first.teacherName) {
    const fT = await call('GET', '/api/v1/sessions', { token, query: { teacherName: first.teacherName, pageSize: 200 } });
    const tRows = (fT.data && fT.data.list) || [];
    check('teacherName 按实际授课人筛选生效（' + first.teacherName + '）',
      fT.status === 200 && tRows.length > 0 && tRows.every((r) => String(r.teacherName).indexOf(first.teacherName) >= 0),
      '命中 ' + tRows.length + ' 条');
  } else {
    console.log('  [SKIP] teacherName 筛选：列表中无可用的实际授课人');
  }
  if (first && first.courseName) {
    const fC = await call('GET', '/api/v1/sessions', { token, query: { courseName: first.courseName, pageSize: 200 } });
    const cRows = (fC.data && fC.data.list) || [];
    check('courseName 按课程名筛选生效（' + first.courseName + '）',
      fC.status === 200 && cRows.length > 0 && cRows.every((r) => String(r.courseName).indexOf(first.courseName) >= 0),
      '命中 ' + cRows.length + ' 条');
  } else {
    console.log('  [SKIP] courseName 筛选：列表中无可用的课程名');
  }

  // ---------------------------------------------------------------- 5. 会话详情 / 证据四项
  section('5. GET /sessions/{id} 详情与「证据四项」');
  if (first) {
    const det = await call('GET', '/api/v1/sessions/' + first.id, { token });
    const d = det.data || {};
    check('GET /sessions/{id} 返回 200 且 code=0', det.status === 200 && det.json.code === 0, 'HTTP ' + det.status + ' ' + first.id);
    check('详情含 session / course / initiator / confirmer / code / auditTail',
      !!(d.session && d.initiator !== undefined && d.confirmer !== undefined && d.code !== undefined && Array.isArray(d.auditTail)),
      Object.keys(d).join(','));

    const ev = (d.session && d.session.evidence) || {};
    const labels = ev.labels || [];
    check('evidence.labels 为四项「动态码 / 确认人 / 确认时间 / 设备」',
      labels.length === 4 && labels.join('/') === '动态码/确认人/确认时间/设备', labels.join('、') || '缺失');
    check('evidence 覆盖四项取值字段（codeId / confirmedName / confirmedAt / device）',
      ev.codeId !== undefined && ev.confirmedName !== undefined && ev.confirmedAt !== undefined && ev.device !== undefined,
      'codeId=' + ev.codeId + ' 确认人=' + ev.confirmedName + ' 确认时间=' + ev.confirmedAt + ' 设备=' + ev.device);
    check('evidence 不含签名图键（signatureUrl/signatureFileId/imageHash/signedAt）',
      KEYS_SIGNATURE.every((k) => ev[k] === undefined), leakKeys(ev).join(',') || '无签名图键');
    check('evidence 不含位置键（location/latitude/longitude/locationDenied）',
      KEYS_LOCATION.every((k) => ev[k] === undefined), leakKeys(ev).join(',') || '无位置键');
    check('详情响应整体不含签名图 / 位置键',
      leakKeys(d).length === 0 && leakKeys(d.session).length === 0,
      leakKeys(d).concat(leakKeys(d.session)).join(',') || '干净');

    check('课程清单快照（course）字段完整（发起时带出的信息）',
      !d.session.courseId || (d.course && d.course.courseName !== undefined && d.course.teacherName !== undefined && d.course.hours !== undefined),
      d.course ? (d.course.courseName + ' / ' + d.course.teacherName + ' / ' + d.course.weekdayText) : '该课时未关联课程清单');
    check('发起人信息含学号与职务（学委侧）',
      !!(d.initiator && d.initiator.name && d.initiator.no !== undefined && d.initiator.duty !== undefined),
      d.initiator ? (d.initiator.name + '（' + d.initiator.duty + '，' + d.initiator.no + '）') : '无发起人');
    const doneRow = sList.filter((r) => r.status === 'done')[0];
    if (doneRow) {
      const d2 = (await call('GET', '/api/v1/sessions/' + doneRow.id, { token })).data || {};
      check('已确认会话含确认人 / 确认时间 / 设备 / 动态码消费记录',
        !!(d2.session.confirmedName && d2.session.confirmedAt && d2.code && d2.code.used),
        '确认人=' + d2.session.confirmedName + ' 设备=' + d2.session.confirmDevice + ' 码已消费=' + (d2.code && d2.code.used));
    } else {
      console.log('  [SKIP] 已确认会话检查：当前无 done 状态会话');
    }
  } else {
    console.log('  [SKIP] 会话详情：/sessions 列表为空');
  }

  // ---------------------------------------------------------------- 6. 统计口径
  section('6. GET /stats/overview 新口径与「按实际授课人」归属');
  const ov = (await call('GET', '/api/v1/stats/overview', { token })).data || {};
  check('overview 含 tempAdjustedCount / nameMismatchCount / sessionCount / sessionDoneCount',
    ['tempAdjustedCount', 'nameMismatchCount', 'sessionCount', 'sessionDoneCount'].every((k) => ov[k] !== undefined),
    '临时调整=' + ov.tempAdjustedCount + ' 姓名不符=' + ov.nameMismatchCount +
    ' 会话=' + ov.sessionCount + ' 已确认会话=' + ov.sessionDoneCount);
  check('sessionDoneCount ≤ sessionCount 且均为非负整数',
    Number.isInteger(ov.sessionCount) && Number.isInteger(ov.sessionDoneCount) &&
    ov.sessionDoneCount <= ov.sessionCount && ov.sessionCount >= 0,
    ov.sessionDoneCount + ' / ' + ov.sessionCount);

  const bt = (await call('GET', '/api/v1/stats/by-teacher', { token, query: { page: 1, pageSize: 200 } })).data || {};
  const rank = bt.rank || bt.list || [];
  check('by-teacher 返回 registered 标记（含非系统内教师）',
    rank.length > 0 && rank.every((r) => r.registered !== undefined),
    '教师行 ' + rank.length + ' 条，非系统内 ' + rank.filter((r) => r.registered === false).length + ' 条');
  check('by-teacher 合计学时与 overview.confirmedHours 一致（同源口径）',
    Number(bt.totalHours) === Number(ov.confirmedHours),
    'by-teacher=' + bt.totalHours + ' overview=' + ov.confirmedHours);
  const bd = (await call('GET', '/api/v1/stats/by-dept', { token })).data || {};
  check('by-dept 返回院系排行（按实际授课人所属院系归属）',
    Array.isArray(bd.list) && bd.list.length > 0 && bd.list[0].confirmedHours !== undefined,
    (bd.list || []).slice(0, 3).map((d) => d.name + '=' + d.confirmedHours).join(' | '));

  // ---------------------------------------------------------------- 7. 课程清单
  section('7. GET /class-courses 课程清单');
  const cc = await call('GET', '/api/v1/class-courses', { token, query: { page: 1, pageSize: 20 } });
  const cList = (cc.data && cc.data.list) || [];
  check('GET /class-courses 返回 200 且 code=0', cc.status === 200 && cc.json && cc.json.code === 0, 'HTTP ' + cc.status);
  check('返回 list + total + summary(total/active/archived)',
    Array.isArray(cList) && cc.data.summary && cc.data.summary.total !== undefined &&
    cc.data.summary.active !== undefined && cc.data.summary.archived !== undefined,
    'total=' + cc.data.total + ' 使用中=' + cc.data.summary.active + ' 已归档=' + cc.data.summary.archived);
  const cc0 = cList[0] || null;
  const CC_FIELDS = ['courseName', 'teacherName', 'className', 'weekday', 'weekdayText', 'section', 'place', 'hours', 'status', 'statusText', 'createdByName'];
  check('清单行含页面所需字段（课程名/授课老师/班级/星期/节次/地点/学时/状态/创建人）',
    !!cc0 && CC_FIELDS.every((k) => cc0[k] !== undefined),
    cc0 ? (CC_FIELDS.filter((k) => cc0[k] === undefined).join(' 缺失,') ||
      (cc0.courseName + ' / ' + cc0.teacherName + ' / ' + cc0.className + ' / ' + cc0.weekdayText + ' / ' + cc0.hours + ' 学时 / ' + cc0.statusText)) : '清单为空');
  if (cc0) {
    const byClass = await call('GET', '/api/v1/class-courses', { token, query: { classId: cc0.classId, pageSize: 200 } });
    const rowsC = (byClass.data && byClass.data.list) || [];
    check('classId 筛选生效（' + cc0.className + '）',
      byClass.status === 200 && rowsC.length > 0 && rowsC.every((r) => String(r.classId) === String(cc0.classId)),
      '命中 ' + rowsC.length + ' 条');
  }
  const ccArch = await call('GET', '/api/v1/class-courses', { token, query: { status: 'archived', pageSize: 200 } });
  check('status=archived 筛选可用（归档课程可查）',
    ccArch.status === 200 && ((ccArch.data.list || []).every((r) => r.status === 'archived')),
    '已归档 ' + ((ccArch.data && ccArch.data.list) || []).length + ' 条');

  // ---------------------------------------------------------------- 8. 旧接口兼容
  section('8. 旧接口兼容回退（GET /records）');
  const rec = await call('GET', '/api/v1/records', { token, query: { page: 1, pageSize: 5 } });
  check('GET /records 仍可用（页面回退数据源）', rec.status === 200 && rec.json.code === 0 && Array.isArray(rec.data.list),
    'total=' + (rec.data && rec.data.total) + ' statusTotals=' + JSON.stringify((rec.data.summary || {}).statusTotals || {}));
  if (first) {
    const recDet = await call('GET', '/api/v1/records/' + first.id, { token });
    check('GET /records/{id} 仍可读到同一课时（回退详情）',
      recDet.status === 200 && recDet.json.code === 0 && recDet.data.id === first.id, 'HTTP ' + recDet.status + ' ' + first.id);
  }

  // ---------------------------------------------------------------- 9. 前端源码静态检查
  section('9. 管理后台前端源码（新流程适配 / 无签名图依赖）');
  const idx = readLocal('index.html');
  check('index.html 引入课程清单页 js/pages/courses.js', !!idx && /pages\/courses\.js/.test(idx));
  check('index.html 引入改造后的 records.js / dashboard.js / export.js', !!idx &&
    /pages\/records\.js/.test(idx) && /pages\/dashboard\.js/.test(idx) && /pages\/export\.js/.test(idx));

  const recJs = readLocal('js/pages/records.js');
  check('records.js 数据源为 GET /sessions 且保留 /records 回退', !!recJs &&
    /'\/sessions'/.test(recJs) && /'\/records'/.test(recJs) && /sessions\/' \+ encodeURIComponent/.test(recJs));
  check('records.js 证据四项标签为 动态码 / 确认人 / 确认时间 / 设备', !!recJs &&
    /'动态码', '确认人', '确认时间', '设备'/.test(recJs));
  check('records.js 已删除签名图逻辑（无 signatureFileId / signatureUrl / fetchBlob / imageHash 引用）', !!recJs &&
    !/signatureFileId/.test(recJs) && !/signatureUrl/.test(recJs) && !/fetchBlob/.test(recJs) && !/imageHash/.test(recJs) && !/signedAt/.test(recJs),
    recJs ? (/signatureFileId|signatureUrl|fetchBlob/.test(recJs) ? '仍存在签名图依赖' : '无签名图依赖（不再读取 /files 图片）') : '读取失败');
  check('records.js 含新筛选（tempAdjusted / nameMismatch / teacherName / courseName）', !!recJs &&
    /tempAdjusted/.test(recJs) && /nameMismatch/.test(recJs) && /teacherName/.test(recJs) && /courseName/.test(recJs));
  check('records.js 状态角标走 statusTotals', !!recJs && /statusTotals/.test(recJs));
  check('records.js 不引用任何定位字段（location/latitude/longitude）并声明不采集定位', !!recJs &&
    !/location|latitude|longitude/i.test(recJs) && /无定位/.test(recJs));

  const dashJs = readLocal('js/pages/dashboard.js');
  check('dashboard.js 含临时调整 / 姓名不符 / 会话数卡片', !!dashJs &&
    /tempAdjustedCount/.test(dashJs) && /nameMismatchCount/.test(dashJs) && /sessionCount/.test(dashJs) && /sessionDoneCount/.test(dashJs));
  check('dashboard.js 教师排行标注「按实际授课人」并标注非系统内教师', !!dashJs &&
    /实际授课人/.test(dashJs) && /registered === false/.test(dashJs));

  const coursesJs = readLocal('js/pages/courses.js');
  check('courses.js 使用 GET/PUT/DELETE /class-courses', !!coursesJs &&
    /\/class-courses/.test(coursesJs) && /api\.put\(/.test(coursesJs) && /api\.del\(/.test(coursesJs));
  check('courses.js 提供班级 / 关键词 / 状态筛选', !!coursesJs &&
    /c-class/.test(coursesJs) && /c-keyword/.test(coursesJs) && /c-status/.test(coursesJs));

  const exportJs = readLocal('js/pages/export.js');
  check('export.js 列出口径同步（教师姓名=实际授课人、签字人=发起人、不含签名图列）', !!exportJs &&
    /实际授课人/.test(exportJs) && /发起人/.test(exportJs) && /不含签名图 URL 列/.test(exportJs));
  // 后端 EXPORT_HEADERS 为唯一口径来源：此处直接读后端列数，避免测试与实际列数脱节（曾误写 18 列）
  const backendExportHeaders = require('../src/io').EXPORT_HEADERS;
  check('export.js 标注 ' + backendExportHeaders.length + ' 列固定表头（不因筛选缺列），且与后端 EXPORT_HEADERS 列数一致', !!exportJs &&
    /RECORDS_HEADERS/.test(exportJs) &&
    new RegExp(backendExportHeaders.length + ' 列表头').test(exportJs) &&
    /RECORDS_HEADERS/.test(exportJs),
    '后端 ' + backendExportHeaders.length + ' 列：' + backendExportHeaders.join('/'));

  const mkJs = readLocal('js/pages/makeup.js');
  const apJs = readLocal('js/pages/appeal.js');
  check('补签 / 申诉审核页证据区改为四项且签名图仅在历史数据时出现', !!mkJs && !!apJs &&
    /动态码/.test(mkJs) && /确认人/.test(mkJs) && /动态码/.test(apJs) && /确认人/.test(apJs) &&
    /历史手写签名图/.test(mkJs) && /历史手写签名图/.test(apJs));
  check('两个审核页均无位置信息展示', !!mkJs && !!apJs && !/位置/.test(mkJs) && !/位置/.test(apJs));

  const appJs = readLocal('js/app.js');
  check('app.js 菜单新增「课程清单」', !!appJs && /id: 'courses', label: '课程清单'/.test(appJs));

  section('9B. 页面引用的 UI/API 成员是否真实存在（无浏览器也能查错别字）');
  const surf = surfaceCheck();
  check('基础模块可在最小 window/document 桩下加载并暴露 ui/api/data/jobs', !!surf.baseOk,
    surf.baseOk ? ('ui ' + surf.counts.ui + ' 项 / api ' + surf.counts.api + ' 项 / data ' + surf.counts.data + ' 项') : surf.baseError);
  check('10 个页面里引用的 ui.* / api.* / A.data.* / A.jobs.* 全部存在', surf.problems.length === 0,
    surf.problems.length ? surf.problems.join('; ') : '全部命中（含新增 courses.js 与改造后的 records.js / dashboard.js）');

  // ---------------------------------------------------------------- 10. 导出表头（可选，会新建 1 个导出任务）
  section('10. 导出表头核对（可选：SELFTEST_EXPORT=1）');
  if (process.env.SELFTEST_EXPORT === '1') {
    console.log('  说明：本节会新建 1 个导出任务（空数据区间 1990-01-01 ~ 1990-01-02），用于核对固定表头列。');
    const exp = await call('POST', '/api/v1/export/records', {
      token, body: { format: 'csv', from: '1990-01-01', to: '1990-01-02' },
    });
    check('POST /export/records 创建任务', exp.status === 200 && !!(exp.data && exp.data.jobId), exp.data && exp.data.jobId);
    let job = null;
    for (let i = 0; i < 20 && exp.data && exp.data.jobId; i++) {
      job = (await call('GET', '/api/v1/export/' + exp.data.jobId, { token })).data;
      if (job && (job.status === 'done' || job.status === 'failed')) break;
      await sleep(300);
    }
    check('导出任务完成并可下载', !!(job && job.status === 'done' && job.fileName), job && job.status);
    if (job && job.fileName) {
      const dl = await call('GET', '/api/v1/files/' + encodeURIComponent(job.fileName), { token });
      const header = String(dl.text).split('\r\n')[0].replace(/^\ufeff/, '');
      const cols = header.split(',');
      check('导出表头列数固定 21（不因筛选缺列）', cols.length === 21, cols.length + ' 列：' + header);
      check('导出表头含「教师姓名」（= 实际授课人）与「发起人（学委）」（原「签字人」列改名）',
        header.indexOf('教师姓名') >= 0 && header.indexOf('发起人（学委）') >= 0, header);
      check('导出表头不含签名图 / 位置列', !/签名图|位置|location|latitude/i.test(header), '无签名图与位置列');
      const missing = ['确认人', '是否临时调整', '确认人与实际授课人不符'].filter((c) => header.indexOf(c) < 0);
      check('导出表头已含「确认人 / 是否临时调整 / 确认人与实际授课人不符」三列',
        missing.length === 0, missing.length ? ('后端仍缺列：' + missing.join('、')) : '三列齐备（14/15/16 列）');
    }
  } else {
    console.log('  [SKIP] 未设置 SELFTEST_EXPORT=1，跳过（避免创建导出任务等写入操作）');
  }

  return summary();
}

/**
 * 无浏览器静态校验：用最小 window/document 桩加载 api.js/ui.js/app.js，
 * 再扫描每个页面文件里引用的 ui.* / api.* / A.data.* / A.jobs.* 是否都真实存在。
 */
function surfaceCheck() {
  const vm = require('vm');
  const out = { baseOk: false, baseError: '', counts: { ui: 0, api: 0, data: 0, jobs: 0 }, problems: [] };
  const doc = {
    addEventListener() {}, getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
    createElementNS() { return { setAttribute() {}, appendChild() {}, style: {} }; },
    body: { style: {} },
  };
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Number, String, Object, Array, Error,
    isFinite, parseInt, parseFloat, document: doc, location: { hash: '', href: '' },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: () => Promise.resolve({
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ code: 0, data: {} }),
      text: () => Promise.resolve(''),
    }),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function () {}, FormData: function () { this.append = function () {}; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.createContext(sandbox);
    ['js/api.js', 'js/ui.js', 'js/app.js'].forEach((rel) => {
      vm.runInContext(fs.readFileSync(path.join(ADMIN_DIR, rel), 'utf8'), sandbox, { filename: rel });
    });
  } catch (e) {
    out.baseError = String((e && e.message) || e);
    return out;
  }
  const A = sandbox.window.Admin || {};
  const surface = {
    ui: Object.keys(A.ui || {}), api: Object.keys(A.api || {}),
    data: Object.keys(A.data || {}), jobs: Object.keys(A.jobs || {}),
  };
  out.baseOk = surface.ui.length > 0 && surface.api.length > 0;
  out.counts = { ui: surface.ui.length, api: surface.api.length, data: surface.data.length, jobs: surface.jobs.length };

  const patterns = [
    ['ui', /ui\.([A-Za-z_$][\w$]*)/g],
    ['api', /api\.([A-Za-z_$][\w$]*)/g],
    ['data', /A\.data\.([A-Za-z_$][\w$]*)/g],
    ['jobs', /A\.jobs\.([A-Za-z_$][\w$]*)/g],
  ];
  ['login', 'dashboard', 'records', 'courses', 'makeup', 'appeal', 'import', 'export', 'config', 'logs'].forEach((p) => {
    const src = readLocal('js/pages/' + p + '.js');
    if (src === null) { out.problems.push(p + '.js 缺失'); return; }
    const used = {};
    patterns.forEach((pair) => {
      const re = pair[1];
      let m;
      while ((m = re.exec(src))) { (used[pair[0]] = used[pair[0]] || new Set()).add(m[1]); }
    });
    Object.keys(used).forEach((ns) => {
      used[ns].forEach((k) => { if (surface[ns].indexOf(k) < 0) out.problems.push(p + '.js → ' + ns + '.' + k); });
    });
    if (p !== 'login' && !/registerPage\(/.test(src)) out.problems.push(p + '.js 未调用 Admin.registerPage');
  });
  return out;
}

function summary() {  section('自测汇总');
  console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  if (fail) {
    console.log('  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[异常] 自测中断：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
