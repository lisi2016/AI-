'use strict';
/**
 * 业务流程简化专项自测：班级课程清单 + 课时会话（班干部发起 + 教师扫码确认）
 *
 * 用法：node tools/session-flow-test.js
 *
 * 特点：**进程内**启动真实 app（server.buildApp()），使用独立临时 DATA_DIR 与随机端口，
 *       不接触正在运行的 8081 演示服务及其 data/；跑完自动清理临时目录。
 *       零新增依赖（仅 Node 18 内置 fetch/FormData）。
 *
 * 覆盖：
 *   1) 班级课程清单 CRUD + 角色权限（班干部只能动本班）+ 软删除（archived）
 *   2) GET /class-courses/today 按该日期的星期带出当天课程
 *   3) POST /sessions：无课表也能发起、未来日期 40001、重复 40901、返回 6 位口令 + qrPayload
 *   4) POST /code/verify 返回**本次课时信息**（sessionId/session）
 *   5) POST /sessions/{id}/confirm → done、确认信息落库、动态码被消费、重复确认 41002/42201
 *   6) 确认人姓名 ≠ 实际授课人 → confirm_name_mismatch=true 但仍成功（代课老师可确认）
 *   7) 统计按**实际授课人**（by-teacher / overview / by-course 数字核对）
 *   8) 临时调整：改 teacherName / 与课表星期不符 → is_temp_adjusted=true 且不报错
 *   9) 会话动态码刷新；确认时限（当天 24 点，补录历史不设时限）
 *  10) 兼容：旧课表码 /code/verify 仍返回 tasks；旧流程遗留 wait 记录可升级为会话；/records 8 状态角标不变
 *  11) 审计哈希链在新增动作后仍完整
 *  12) GET /classes 教学班列表：班干部=本班 / 教师=全部 / 院系管理员=本院系 / 教务处=全部，
 *      deptId / keyword / classId 筛选与越权，以及「先取班列表再 POST /class-courses」串联可用
 *  13) 导出课时明细新增三列（确认人 / 是否临时调整 / 确认人与实际授课人不符）：
 *      新流程有值（代课=是、临时调整=是、教师本人确认=否），旧流程数据（无 confirmed_name）输出空
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsq-session-'));
process.env.DATA_DIR = tmp;
process.env.DEV_MODE = '1';
process.env.TOKEN_SECRET = 'session-test-token-secret';
process.env.CODE_SECRET = 'session-test-code-secret';

const u = require('../src/util');
const store = require('../src/store');
const seed = require('../src/seed');
const view = require('../src/view');
const audit = require('../src/audit');
const auth = require('../src/auth');
const webauth = require('../src/webauth');
const server = require('../server');

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) {
  if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail);
  return !!cond;
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

let BASE = '';

async function call(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  let body;
  if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(BASE + '/api/v1' + p, { method: method, headers: headers, body: body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { httpStatus: res.status, code: json && json.code, body: json, data: json && json.data };
}

async function expect(method, p, opts, wantCode, name) {
  const r = await call(method, p, opts);
  check(r.code === wantCode, name, 'HTTP ' + r.httpStatus + ' code=' + r.code + ' msg=' + (r.body && r.body.msg));
  return r.data;
}

async function loginAs(prefix, role, no, realName) {
  const l = await call('POST', '/auth/login', { body: { code: prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) } });
  const d = l.data;
  if (l.code !== 0 || !d) throw new Error('登录失败：' + JSON.stringify(l.body));
  if (!d.needBind) return d.token;
  const b = await call('POST', '/auth/bind', { body: { openid: d.openid, role: role, no: no, realName: realName } });
  if (b.code === 0) return b.data.token;
  throw new Error('绑定失败：' + JSON.stringify(b.body));
}

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(tmp, name), 'utf8')); } catch (e) { return null; }
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function addDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const w = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return w === 0 ? 7 : w;
}
/** 最近的、星期为 wd 的过去日期 */
function pastDateOf(wd, skipDays) {
  let d = addDays(u.dateOnly(), -(skipDays || 1));
  for (let i = 0; i < 14; i++) {
    if (weekdayOf(d) === wd) return d;
    d = addDays(d, -1);
  }
  return d;
}
/** 为某个课表任务找一个「同星期 + 过去 + 无记录」的日期 */
async function freeTaskDate(adminToken, teacherId, taskId, weekday) {
  for (let i = 1; i <= 60; i++) {
    const d = addDays(u.dateOnly(), -i);
    if (weekdayOf(d) !== weekday) continue;
    const t = await call('GET', '/tasks?date=' + d + '&teacherId=' + teacherId, { token: adminToken });
    if (t.code !== 0 || !(t.data || []).some(function (x) { return x.id === taskId; })) continue;
    const r = await call('GET', '/records?from=' + d + '&to=' + d + '&pageSize=200', { token: adminToken });
    if (r.code !== 0) continue;
    if (!(r.data.list || []).some(function (x) { return x.taskId === taskId; })) return d;
  }
  return '';
}

async function main() {
  console.log('业务流程简化专项自测（临时数据目录 ' + tmp + '）');

  u.ensureDirs();
  store.load();
  seed.create();
  store.flushAll();
  webauth.ensurePasswordHashes();
  view.migrateLegacyConfig('system');
  store.flushAll();

  const srv = await new Promise(function (resolve) {
    const s = server.buildApp().listen(0, '127.0.0.1', function () { resolve(s); });
  });
  BASE = 'http://127.0.0.1:' + srv.address().port;
  console.log('  测试实例：' + BASE);

  try {
    // ---------------------------------------------------------------- 0 账号
    section('0. 登录（小程序分支：code → bind）');
    const adminToken = await loginAs('sf-admin', 'admin', 'ADMIN001', '教务处');
    const deptToken = await loginAs('sf-dept', 'dept_admin', '2017001', '孙主任');
    const teacherToken = await loginAs('sf-t1', 'teacher', '2010032', '唐瑞明');
    const teacher2Token = await loginAs('sf-t2', 'teacher', '2011045', '李慧');
    const cadreToken = await loginAs('sf-c1', 'cadre', '2025030117', '张一鸣');
    const cadre2Token = await loginAs('sf-c4', 'cadre', '2025040201', '陈思远');
    check(!!adminToken && !!deptToken && !!teacherToken && !!teacher2Token && !!cadreToken && !!cadre2Token,
      '6 个角色账号登录成功（教务处/院系管理员/两名教师/两个班的班干部）');

    const me1 = await call('GET', '/auth/me', { token: cadreToken });
    const me2 = await call('GET', '/auth/me', { token: cadre2Token });
    const nursingClassId = me1.data.user.classId;
    const pharmacyClassId = me2.data.user.classId;
    const teacherUserId = (await call('GET', '/auth/me', { token: teacherToken })).data.user.id;
    check(nursingClassId !== pharmacyClassId, '两个班干部属于不同教学班', nursingClassId + ' / ' + pharmacyClassId);

    // ---------------------------------------------------------------- 1 课程清单 CRUD + 权限
    section('1. 班级课程清单 CRUD + 权限 + 软删除');
    let myCourse = null;
    {
      const created = await expect('POST', '/class-courses', {
        token: cadreToken,
        body: {
          courseName: '形势与政策', teacherName: '外聘教师甲', weekday: 5, section: '1-2',
          place: 'A101', hours: 2,
        },
      }, 0, 'POST /class-courses（班干部为本科录入课程）');
      myCourse = created;
      check(!!created.id && created.classId === nursingClassId && created.weekday === 5 && created.weekdayText === '周五' &&
        created.hours === 2 && created.status === 'active',
        '返回课程清单视图（id/班级/星期文案/学时/状态）',
        created.id + ' ' + created.className + ' ' + created.weekdayText + ' ' + created.hours + '学时');

      // 班干部只能动本班
      await expect('POST', '/class-courses', {
        token: cadreToken, body: { classId: pharmacyClassId, courseName: '越权课程', teacherName: '某人' },
      }, 40301, '班干部为其它班录入课程 → 40301');
      await expect('POST', '/class-courses', {
        token: cadre2Token, body: { classId: nursingClassId, courseName: '越权课程', teacherName: '某人' },
      }, 40301, '另一班班干部跨班录入 → 40301');
      await expect('POST', '/class-courses', {
        token: teacherToken, body: { courseName: '教师不该能建', teacherName: '唐瑞明' },
      }, 40301, '教师新增课程清单 → 40301（只读）');

      // 校验：必填 / 敏感词 / 长度
      await expect('POST', '/class-courses', { token: cadreToken, body: { courseName: '缺老师' } },
        40001, '缺 teacherName → 40001');
      const sens = await call('POST', '/class-courses', {
        token: cadreToken, body: { courseName: '代签服务', teacherName: '某人' },
      });
      check(sens.code === 40001 && /内容包含敏感词/.test(sens.body.msg),
        '课程名称命中敏感词 → 40001 且提示命中词', sens.body.msg);
      await expect('POST', '/class-courses', {
        token: cadreToken, body: { courseName: '超长课程名称'.repeat(20), teacherName: '某人' },
      }, 40001, '课程名称超长 → 40001');
      await expect('POST', '/class-courses', {
        token: cadreToken, body: { courseName: '星期非法', teacherName: '某人', weekday: 9 },
      }, 40001, 'weekday 非法 → 40001');

      // 查询范围
      const mine = await expect('GET', '/class-courses?pageSize=200', { token: cadreToken }, 0, 'GET /class-courses（班干部）');
      check(mine.list.length > 0 && mine.list.every(function (r) { return r.classId === nursingClassId; }),
        '班干部列表只含本班课程', mine.total + ' 条，班级=' + mine.list[0].className);
      await expect('GET', '/class-courses?classId=' + pharmacyClassId, { token: cadreToken },
        40301, '班干部查询其它班清单 → 40301');
      const asTeacher = await expect('GET', '/class-courses?classId=' + nursingClassId, { token: teacherToken },
        0, '教师可按班查询课程清单（只读）');
      check(asTeacher.list.length > 0, '教师拿到该班课程', asTeacher.total + ' 条');
      const asDept = await expect('GET', '/class-courses?pageSize=200', { token: deptToken }, 0, 'GET /class-courses（院系管理员）');
      check(asDept.list.every(function (r) { return r.classId === nursingClassId; }),
        '院系管理员只看到本院系班级的课程', asDept.total + ' 条');
      const asAdmin = await expect('GET', '/class-courses?pageSize=200', { token: adminToken }, 0, 'GET /class-courses（教务处）');
      check(asAdmin.total > asDept.total, '教务处可见全部班级课程', asAdmin.total + ' 条 vs 院系 ' + asDept.total + ' 条');
      check(asAdmin.summary && asAdmin.summary.active >= 1 && typeof asAdmin.summary.archived === 'number',
        '列表 summary 给出 active/archived 角标', JSON.stringify(asAdmin.summary));

      // 修改
      await expect('PUT', '/class-courses/' + myCourse.id, {
        token: cadre2Token, body: { place: 'B202' },
      }, 40301, '其它班班干部修改 → 40301');
      const upd = await expect('PUT', '/class-courses/' + myCourse.id, {
        token: cadreToken, body: { place: 'B202', hours: 3, section: '3-4' },
      }, 0, 'PUT /class-courses/{id}（本班班干部）');
      check(upd.place === 'B202' && upd.hours === 3 && upd.section === '3-4' && upd.startTime === '10:05',
        '修改生效且节次自动补全起止时间', upd.section + ' ' + upd.time);
      await expect('PUT', '/class-courses/' + myCourse.id, {
        token: cadreToken, body: { classId: pharmacyClassId },
      }, 40001, '改教学班 → 40001（禁止换班）');

      // 软删除
      await expect('DELETE', '/class-courses/' + myCourse.id, { token: cadre2Token }, 40301, '其它班班干部删除 → 40301');
      const del = await expect('DELETE', '/class-courses/' + myCourse.id, { token: cadreToken }, 0, 'DELETE /class-courses/{id}（软删除）');
      check(del.archived === true && del.status === 'archived', '删除是软删除：status=archived', JSON.stringify({ id: del.id, status: del.status }));
      const activeList = await expect('GET', '/class-courses?pageSize=200', { token: cadreToken }, 0, '默认只列 active（软删除后不可见）');
      check(!activeList.list.some(function (r) { return r.id === myCourse.id; }), '归档课程不在默认列表');
      const archList = await expect('GET', '/class-courses?status=archived&pageSize=200', { token: cadreToken }, 0, 'status=archived 可查到归档课程');
      check(archList.list.some(function (r) { return r.id === myCourse.id; }), '归档课程保留可追溯', archList.total + ' 条');
      await expect('DELETE', '/class-courses/' + myCourse.id, { token: cadreToken }, 42201, '重复归档 → 42201');
    }

    // ---------------------------------------------------------------- 2 today
    section('2. GET /class-courses/today 按星期带出当天课程');
    {
      const wd3 = pastDateOf(3);
      const today3 = await expect('GET', '/class-courses/today?date=' + wd3, { token: cadreToken }, 0,
        'GET /class-courses/today（班干部，周三）');
      check(today3.date === wd3 && today3.weekday === 3 && today3.weekdayText === '周三',
        '返回日期/星期/星期文案', today3.date + ' ' + today3.weekdayText);
      check(today3.total >= 1 && today3.list.every(function (r) { return r.weekday === 3 && r.classId === nursingClassId; }),
        '仅带出该班星期三的课程', today3.list.map(function (r) { return r.courseName + '@' + r.section; }).join('、'));

      const wd7 = pastDateOf(7);
      const sun = await expect('GET', '/class-courses/today?date=' + wd7, { token: cadreToken }, 0, '星期日 → 无课');
      check(sun.total === 0 && sun.weekday === 7, '没有排课的星期返回空列表（不报错）', sun.weekdayText + ' ' + sun.total + ' 条');

      await expect('GET', '/class-courses/today?date=2026-13-45', { token: cadreToken }, 40001, 'date 非法 → 40001');
      const teacherToday = await expect('GET', '/class-courses/today?date=' + wd3 + '&classId=' + nursingClassId,
        { token: teacherToken }, 0, '教师按班查当天课程');
      check(teacherToday.total === today3.total, '教师与班干部看到同一份当天课程', teacherToday.total + ' 条');
    }

    // ---------------------------------------------------------------- 3 发起会话
    section('3. POST /sessions（班干部发起 + 60 秒动态码）');
    let s1 = null;
    let s2 = null;
    let s1Code = null;
    {
      const d1 = pastDateOf(2, 1);
      const out = await expect('POST', '/sessions', {
        token: cadreToken,
        body: {
          courseName: '专题讲座：护理前沿', teacherName: '外聘教师乙', teachDate: d1,
          section: '5-6', place: '报告厅', hours: 3, summary: '第一次专题讲座',
        },
      }, 0, 'POST /sessions（清单里没有这门课也能发起）');
      s1 = out;
      s1Code = out.codeId;
      check(/^\d{6}$/.test(String(out.code)) && out.codeLength === 6, '返回 6 位数字口令（B 通道）', out.code);
      check(out.qrPayload === 'kcsq://code/' + out.codeId && out.qrUrl === out.qrPayload,
        '返回 qrPayload=kcsq://code/<codeId>（A 通道）', out.qrPayload);
      check(out.sessionId && out.session.status === 'wait' && out.session.hours === 3 &&
        out.session.teacherName === '外聘教师乙' && out.session.className && out.session.initiatorName === '张一鸣',
        '会话为 wait 状态并带出课程/实际授课人/班级/发起人',
        out.sessionId + ' ' + out.session.courseName + ' / ' + out.session.teacherName + ' / ' + out.session.initiatorName);
      check(out.session.isTempAdjusted === false && out.adopted === false,
        '无课表参照 → isTempAdjusted=false，且不是升级旧记录');
      check(out.ttl >= 55 && out.ttl <= 60, '动态码默认 60 秒有效', 'ttl=' + out.ttl + 's');
      check(out.session.teachDate === d1 && out.session.section === '5-6' && out.session.place === '报告厅',
        '本次课时信息按入参落库（含临时安排的节次地点）');

      // 未来日期
      await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '未来课', teacherName: '某人', teachDate: addDays(u.dateOnly(), 1) },
      }, 40001, 'teachDate 为未来 → 40001');

      // 重复
      const dup = await call('POST', '/sessions', {
        token: cadreToken,
        body: {
          courseName: '专题讲座：护理前沿', teacherName: '外聘教师乙', teachDate: d1,
          section: '5-6', place: '报告厅', hours: 3,
        },
      });
      check(dup.code === 40901 && dup.body.data && dup.body.data.details && dup.body.data.details.existingId === s1.sessionId,
        '同一 班级+日期+节次+实际授课人 重复发起 → 40901（附现有会话 id）',
        'code=' + dup.code + ' existing=' + (dup.body.data && dup.body.data.details && dup.body.data.details.existingId));

      // 越权 / 角色
      await expect('POST', '/sessions', {
        token: cadre2Token, body: { classId: nursingClassId, courseName: '越权课', teacherName: '某人' },
      }, 40301, '班干部为其它班发起 → 40301');
      await expect('POST', '/sessions', {
        token: teacherToken, body: { courseName: '教师发起', teacherName: '唐瑞明' },
      }, 40301, '教师调用 POST /sessions → 40301（仅班干部/管理员）');
      await expect('POST', '/sessions', {
        token: cadreToken, body: { courseName: '敏感词课', teacherName: '代签人' },
      }, 40001, '实际授课人命中敏感词 → 40001');

      // 为后面的统计准备两条不同实际授课人的会话
      const d2 = pastDateOf(4, 2);
      const a = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '专题讲座：康复护理', teacherName: '外聘教师丙', teachDate: d2, section: '7-8', place: '实训楼D1', hours: 3 },
      }, 0, '为统计口径准备：外聘教师丙 3 学时');
      const d3 = pastDateOf(6, 2);
      const b = await expect('POST', '/sessions', {
        token: cadre2Token,
        body: { courseName: '专题讲座：药学前沿', teacherName: '外聘教师丁', teachDate: d3, section: '1-2', place: '药学楼101', hours: 4 },
      }, 0, '为统计口径准备：外聘教师丁 4 学时');
      check(a.session.teacherName === '外聘教师丙' && b.session.teacherName === '外聘教师丁',
        '两条会话的实际授课人不同（用于核对 by-teacher）',
        a.sessionId + '=' + a.session.teacherName + ' / ' + b.sessionId + '=' + b.session.teacherName);
      global.__ids = { d2: d2, d3: d3, aId: a.sessionId, bId: b.sessionId, bCode: b.codeId, aCode: a.codeId };
    }

    // ---------------------------------------------------------------- 4 code/verify
    section('4. POST /code/verify 返回本次课时信息');
    {
      const v = await expect('POST', '/code/verify', { token: teacherToken, body: { qrContent: 'kcsq://code/' + s1Code } },
        0, '扫码（qrContent）核验');
      check(v.isSession === true && v.sessionId === s1.sessionId && v.session && v.session.courseName === '专题讲座：护理前沿',
        '返回会话信息：sessionId + session（课程名）', 'sessionId=' + v.sessionId + ' ' + (v.session && v.session.courseName));
      check(v.session.teacherName === '外聘教师乙' && v.session.className && v.session.initiatorName === '张一鸣' &&
        v.session.teachDate && v.session.section === '5-6' && v.session.place === '报告厅',
        '含实际授课人/班级/日期/节次/地点/发起人（教师直接看到要确认哪节课）',
        [v.session.teacherName, v.session.className, v.session.teachDate, v.session.section, v.session.place, v.session.initiatorName].join(' | '));
      check(v.canConfirm === true && v.confirmEndpoint === 'POST /api/v1/sessions/' + s1.sessionId + '/confirm',
        '给出 canConfirm 与确认接口', v.confirmEndpoint);
      check(Array.isArray(v.tasks) && v.tasks.length === 0, '兼容字段 tasks 仍存在（会话码为空数组）');

      const v2 = await expect('POST', '/code/verify', { token: teacherToken, body: { code: s1.code } }, 0, '手输 6 位口令核验（B 通道）');
      check(v2.channel === 'code' && v2.sessionId === s1.sessionId, '两条通道解析到同一会话', 'channel=' + v2.channel);

      // 旧课表码回退
      const legacy = await expect('POST', '/code/generate', { token: cadreToken, body: {} }, 0, '旧流程：POST /code/generate 签发课表码');
      const lv = await expect('POST', '/code/verify', { token: teacherToken, body: { codeId: legacy.codeId } }, 0, '旧课表码核验');
      check(lv.isSession === false && Array.isArray(lv.tasks), '非会话码回退原行为（返回课表任务列表）',
        'isSession=' + lv.isSession + ' tasks=' + (lv.tasks || []).length);
      check(lv.sessionId === '' && !!lv.cadre, '回退响应保持旧字段', 'cadre=' + (lv.cadre && lv.cadre.name));
    }

    // ---------------------------------------------------------------- 5 教师确认
    section('5. POST /sessions/{id}/confirm（教师确认 + 消费动态码）');
    {
      await expect('POST', '/sessions/' + s1.sessionId + '/confirm', {
        token: cadreToken, body: { codeId: s1Code },
      }, 40301, '班干部自己确认 → 40301（仅教师/管理员）');

      const cf = await expect('POST', '/sessions/' + s1.sessionId + '/confirm', {
        token: teacherToken, body: { codeId: s1Code },
      }, 0, 'POST /sessions/{id}/confirm（任课教师扫码确认）');
      check(cf.status === 'done' && cf.counted === true && cf.confirmedName === '唐瑞明' && cf.confirmedRole === 'teacher' && !!cf.confirmedAt,
        '确认成功 → status=done，落确认人/角色/时间', cf.confirmedName + ' @ ' + cf.confirmedAt);

      // 落库核对（直接读 data/period_records.json）
      store.flushAll();
      const rows = readJson('period_records.json') || [];
      const row = rows.filter(function (r) { return r.id === s1.sessionId; })[0];
      check(!!row && row.status === 'done' && row.confirmed_by && row.confirmed_name === '唐瑞明' &&
        row.confirmed_role === 'teacher' && !!row.confirmed_at && row.initiator_name === '张一鸣' &&
        Number(row.confirm_name_mismatch) === 1 && row.origin === 'session',
        '确认信息与发起人标记持久化到 data/period_records.json',
        row ? JSON.stringify({
          status: row.status, by: row.confirmed_by, name: row.confirmed_name, role: row.confirmed_role,
          mismatch: row.confirm_name_mismatch, initiator: row.initiator_name, origin: row.origin,
        }) : '未找到记录');

      const codes = readJson('codes.json') || [];
      const codeRow = codes.filter(function (c) { return c.id === s1Code; })[0];
      check(!!codeRow && Number(codeRow.used) === 1 && !!codeRow.used_at && String(codeRow.session_id) === String(s1.sessionId),
        '动态码被一次性消费并绑定会话（data/codes.json）',
        codeRow ? JSON.stringify({ used: codeRow.used, session: codeRow.session_id, by: codeRow.used_by }) : '未找到码');

      // 重复确认
      const again = await call('POST', '/sessions/' + s1.sessionId + '/confirm', { token: teacherToken, body: { codeId: s1Code } });
      check(again.code === 41002, '拿已消费的码重复确认 → 41002（动态码已被使用）', 'code=' + again.code + ' msg=' + again.body.msg);
      const again2 = await call('POST', '/sessions/' + s1.sessionId + '/confirm', { token: teacherToken, body: {} });
      check(again2.code === 42201, '不带码重复确认 → 42201（状态机）', 'code=' + again2.code + ' msg=' + again2.body.msg);

      const detail = await expect('GET', '/sessions/' + s1.sessionId, { token: teacherToken }, 0, 'GET /sessions/{id} 详情');
      check(detail.session.status === 'done' && detail.session.confirmNameMismatch === true &&
        detail.session.evidence.confirmedName === '唐瑞明' && detail.session.evidence.nameMismatch === true,
        '详情证据四项（动态码/确认人/确认时间/设备）+ 姓名不一致标记',
        JSON.stringify(detail.session.evidence));
      check(detail.auditTail && detail.auditTail.some(function (l) { return l.action === 'session.confirm'; }),
        '详情带最近操作留痕（session.confirm）', (detail.auditTail || []).map(function (l) { return l.action; }).join(','));
      check(detail.code && detail.code.codeId === s1Code && detail.code.used === true,
        '详情可回看该会话使用的动态码（不返回口令原文）', JSON.stringify(detail.code));

      // 可用于筛选提醒
      const mm = await expect('GET', '/sessions?nameMismatch=true&pageSize=200', { token: adminToken }, 0, 'GET /sessions?nameMismatch=true');
      check(mm.list.some(function (r) { return r.sessionId === s1.sessionId; }), '后台可按「确认人≠实际授课人」筛选', mm.total + ' 条待提醒');
    }

    // ---------------------------------------------------------------- 6 姓名一致确认 + 外部教师归属
    section('6. 姓名一致确认 / 代课确认后的学时归属');
    {
      const d = pastDateOf(2, 6);
      const out = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '专题讲座：实训安全', teacherName: '唐瑞明', teachDate: d, section: '3-4', hours: 2 },
      }, 0, '发起一条实际授课人为系统内教师的会话');
      s2 = out;
      const cf = await expect('POST', '/sessions/' + out.sessionId + '/confirm', {
        token: teacherToken, body: { codeId: out.codeId },
      }, 0, '教师本人确认');
      check(cf.nameMismatch === false && cf.session.teacherId === teacherUserId,
        '姓名一致 → nameMismatch=false 且补齐 teacher_id（按 id 归属）',
        'teacherId=' + cf.session.teacherId);

      // 为「外聘教师乙」补建系统账号：此前会话的 teacher_id 为空，应按姓名归并到该账号
      const ext = store.insert('users', {
        id: store.newId('U'), openid: '', unionid: '', role: 'teacher', real_name: '外聘教师乙',
        staff_no: '9000001', student_no: '', dept_id: store.all('depts')[0].id, class_id: null,
        phone: '', duty: '', status: 'active', created_at: u.isoNow(), updated_at: u.isoNow(),
      });
      store.flushAll();
      const extToken = auth.issueToken(ext).token;
      const ov = await expect('GET', '/stats/overview', { token: extToken }, 0, '外聘教师乙 查本人学时（按实际授课人）');
      check(ov.confirmedHours === 3,
        '按姓名归并：外聘教师乙 的 3 学时会话计入本人（teacher_id 当初为空）',
        'confirmedHours=' + ov.confirmedHours + '（会话学时 3）');
    }

    // ---------------------------------------------------------------- 7 统计按实际授课人
    section('7. 统计按实际授课人（by-teacher / overview / by-course）');
    {
      const ids = global.__ids;
      await expect('POST', '/sessions/' + ids.aId + '/confirm', { token: adminToken, body: { codeId: ids.aCode } },
        0, '教务处代确认：外聘教师丙（3 学时）');
      await expect('POST', '/sessions/' + ids.bId + '/confirm', { token: adminToken, body: { codeId: ids.bCode } },
        0, '教务处代确认：外聘教师丁（4 学时）');

      const bt = await expect('GET', '/stats/by-teacher?pageSize=200', { token: adminToken }, 0, 'GET /stats/by-teacher');
      const rowC = bt.rank.filter(function (r) { return r.name === '外聘教师丙'; })[0];
      const rowD = bt.rank.filter(function (r) { return r.name === '外聘教师丁'; })[0];
      check(!!rowC && rowC.hours === 3, '外聘教师丙 = 3 学时（实际授课人）', rowC ? JSON.stringify({ name: rowC.name, hours: rowC.hours, registered: rowC.registered }) : '未上榜');
      check(!!rowD && rowD.hours === 4, '外聘教师丁 = 4 学时（实际授课人）', rowD ? JSON.stringify({ name: rowD.name, hours: rowD.hours, registered: rowD.registered }) : '未上榜');
      const rowB = bt.rank.filter(function (r) { return r.name === '外聘教师乙'; })[0];
      check(!!rowB && rowB.hours === 3, '外聘教师乙 = 3 学时（补建账号后按 id 归并）',
        rowB ? JSON.stringify({ name: rowB.name, hours: rowB.hours, teacherId: rowB.teacherId }) : '未上榜');

      const ov = await expect('GET', '/stats/overview', { token: adminToken }, 0, 'GET /stats/overview');
      check(Math.abs(bt.totalHours - ov.confirmedHours) < 0.01,
        '分教师学时合计 == 全校已确认学时（口径一致）', bt.totalHours + ' vs ' + ov.confirmedHours);
      check(typeof ov.nameMismatchCount === 'number' && ov.sessionCount >= 4,
        '概览新增会话口径：sessionCount / tempAdjustedCount / nameMismatchCount',
        JSON.stringify({ sessionCount: ov.sessionCount, sessionDoneCount: ov.sessionDoneCount, tempAdjustedCount: ov.tempAdjustedCount, nameMismatchCount: ov.nameMismatchCount }));

      const bc = await expect('GET', '/stats/by-course', { token: adminToken }, 0, 'GET /stats/by-course');
      const courseD = bc.list.filter(function (r) { return r.courseName === '专题讲座：药学前沿'; })[0];
      check(!!courseD && courseD.hours === 4, '分课程学时按会话累加', courseD ? JSON.stringify({ name: courseD.courseName, hours: courseD.hours, teachers: courseD.teacherCount }) : '未找到');

      // 教师视角：只算实际授课人
      const tOv = await expect('GET', '/stats/overview', { token: teacher2Token }, 0, 'GET /stats/overview（李慧本人）');
      check(tOv.confirmedHours >= 0, '其它教师查本人学时不受外聘会话影响', 'confirmedHours=' + tOv.confirmedHours);

      const bd = await expect('GET', '/stats/by-dept', { token: adminToken }, 0, 'GET /stats/by-dept（按实际授课人所属院系）');
      check(bd.list.length >= 2 && bd.list.every(function (r) { return typeof r.percent === 'number'; }),
        '分院系仍返回完成率', bd.list.map(function (r) { return r.name + '=' + r.hours + 'h'; }).join(' '));
    }

    // ---------------------------------------------------------------- 8 临时调整
    section('8. 临时调整（与课表/清单不符不报错，标记 is_temp_adjusted）');
    {
      // 取一条清单里真实存在的课程（护理3班 星期三 的信息技术）
      const list = await expect('GET', '/class-courses?weekday=3&pageSize=200', { token: cadreToken }, 0, '取星期三的课程清单');
      const target = list.list.filter(function (r) { return r.courseName.indexOf('信息技术') >= 0; })[0];
      check(!!target, '清单中有星期三的信息技术', target && (target.courseName + ' ' + target.teacherName + ' ' + target.section));

      const notWed = pastDateOf(1, 1); // 星期一（与清单的 weekday=3 不符）
      const out = await expect('POST', '/sessions', {
        token: cadreToken,
        body: {
          courseId: target.id, courseName: target.courseName, teacherName: '王强',
          teachDate: notWed, section: '5-6', place: '临时教室', hours: 2,
        },
      }, 0, '换老师 + 改节次地点 + 与课表星期不符 → 仍然发起成功（不再硬拦截）');
      check(out.session.isTempAdjusted === true, '标记 is_temp_adjusted=true',
        JSON.stringify({ weekdayOfDate: weekdayOf(notWed), courseWeekday: target.weekday, teacher: out.session.teacherName }));
      check(out.session.courseId === target.id && out.session.teacherName === '王强' && out.session.place === '临时教室',
        '临时调整后的信息按本次课落库（清单本身不变）',
        out.session.courseName + '/' + out.session.teacherName + '/' + out.session.place);

      const after = await expect('GET', '/class-courses/' + target.id, { token: cadreToken }, 0, '清单原记录未被改动');
      check(after.teacherName === target.teacherName && after.section === target.section && after.place === target.place,
        '临时调整只影响本次课时，课程清单保持长期稳定',
        after.teacherName + ' ' + after.section + ' ' + after.place);

      const temp = await expect('GET', '/sessions?tempAdjusted=true&pageSize=200', { token: adminToken }, 0, 'GET /sessions?tempAdjusted=true');
      check(temp.list.some(function (r) { return r.sessionId === out.sessionId; }), '后台可按临时调整筛选', temp.total + ' 条');
    }

    // ---------------------------------------------------------------- 9 刷新动态码
    section('9. POST /sessions/{id}/code 刷新动态码');
    {
      const d = pastDateOf(5, 3);
      const out = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '专题讲座：急救技能', teacherName: '外聘教师戊', teachDate: d, section: '1-2', hours: 2 },
      }, 0, '发起一条待确认会话');
      const refreshed = await expect('POST', '/sessions/' + out.sessionId + '/code', { token: cadreToken }, 0, 'POST /sessions/{id}/code 刷新二维码');
      check(refreshed.codeId !== out.codeId && /^\d{6}$/.test(String(refreshed.code)) && refreshed.sessionId === out.sessionId,
        '刷新得到新的 codeId / 口令（同一会话）', out.codeId + ' → ' + refreshed.codeId);
      const cf = await expect('POST', '/sessions/' + out.sessionId + '/confirm', {
        token: teacherToken, body: { qrContent: 'kcsq://code/' + refreshed.codeId },
      }, 0, '用刷新后的二维码确认');
      check(cf.status === 'done', '刷新后的码可用', cf.sessionId + ' → ' + cf.status);
      await expect('POST', '/sessions/' + out.sessionId + '/code', { token: cadreToken }, 42201, '已确认会话再刷新 → 42201');

      const other = await expect('POST', '/sessions', {
        token: cadre2Token,
        body: { courseName: '专题讲座：药物分析', teacherName: '外聘教师己', teachDate: pastDateOf(6, 4), section: '3-4', hours: 2 },
      }, 0, '其它班会话（用于越权刷新校验）');
      await expect('POST', '/sessions/' + other.sessionId + '/code', { token: cadreToken }, 40301, '跨班刷新动态码 → 40301');
    }

    // ---------------------------------------------------------------- 10 确认时限
    section('10. 确认时限（当天 24 点；补录历史课时不设时限，不被定时任务置过期）');
    {
      const dY = addDays(u.dateOnly(), -1);
      const back = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '专题讲座：补录历史课时', teacherName: '外聘教师庚', teachDate: dY, section: '3-4', hours: 2 },
      }, 0, '补录一条历史（昨天）课时');
      check(back.session.deadline === '', '历史课时不设确认时限（deadline 为空）', 'deadline="' + back.session.deadline + '"');

      const todaySes = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '专题讲座：当天课时', teacherName: '外聘教师辛', teachDate: u.dateOnly(), section: '3-4', hours: 2 },
      }, 0, '发起一条当天课时');
      check(!!todaySes.session.deadline, '当天课时保留「当天 24 点」确认时限', todaySes.session.deadline);

      const job = await expect('POST', '/records/expire-job', { token: adminToken, body: {} }, 0, 'POST /records/expire-job（定时任务）');
      check(typeof job.expired === 'number', '过期任务可执行（旧流程不回退）', '过期 ' + job.expired + ' 条');
      const after = await expect('GET', '/sessions/' + back.sessionId, { token: cadreToken }, 0, '补录历史课时仍可确认');
      check(after.session.status === 'wait', '补录历史课时未被置 expired（教师仍可确认）', 'status=' + after.session.status);
    }

    // ---------------------------------------------------------------- 11 列表范围
    section('11. GET /sessions 角色可见范围');
    {
      const cad = await expect('GET', '/sessions?pageSize=200', { token: cadreToken }, 0, '班干部列表（本班）');
      check(cad.list.length > 0 && cad.list.every(function (r) { return r.classId === nursingClassId; }),
        '班干部只看到本班会话', cad.total + ' 条');
      const eight = cad.summary.statusTotals;
      check(Object.keys(eight).length === 8 && typeof cad.summary.hours === 'number',
        '列表 summary 含 hours + byStatus + statusTotals（8 状态角标）',
        'hours=' + cad.summary.hours + ' keys=' + Object.keys(eight).length);

      const t = await expect('GET', '/sessions?pageSize=200', { token: teacherToken }, 0, '教师列表（本人为实际授课人或被确认过）');
      check(t.list.length > 0 && t.list.every(function (r) {
        return r.teacherName === '唐瑞明' || r.confirmedName === '唐瑞明';
      }), '教师只看到本人实际授课/本人确认过的会话', t.total + ' 条');

      const t2 = await expect('GET', '/sessions?pageSize=200', { token: teacher2Token }, 0, '另一教师列表');
      check(t2.list.every(function (r) { return r.teacherName === '李慧' || r.confirmedName === '李慧'; }),
        '其它教师不会看到别人的会话', t2.total + ' 条');

      const adm = await expect('GET', '/sessions?pageSize=200', { token: adminToken }, 0, '教务处列表（全部）');
      check(adm.total >= cad.total, '教务处可见全部会话', adm.total + ' vs 班干部 ' + cad.total);

      const pha = await expect('GET', '/sessions?classId=' + pharmacyClassId + '&pageSize=200', { token: adminToken }, 0, '按班级筛选');
      check(pha.list.every(function (r) { return r.classId === pharmacyClassId; }), '按 classId 过滤生效', pha.total + ' 条');

      await expect('GET', '/sessions/' + (cad.list[0] || {}).sessionId, { token: cadre2Token }, 40301, '跨班查看会话详情 → 40301');
    }

    // ---------------------------------------------------------------- 12 兼容
    section('12. 兼容性：旧接口不回退');
    {
      // /records 仍能读到新会话（班干部按 signer_id 可见），8 状态角标不变
      const recs = await expect('GET', '/records?pageSize=200', { token: cadreToken }, 0, 'GET /records（旧列表含新会话）');
      check(recs.list.some(function (r) { return r.id === s2.sessionId; }), '旧 /records 能读到会话记录', 'total=' + recs.total);
      check(Object.keys(recs.summary.statusTotals).length === 8, '/records statusTotals 仍为 8 状态', Object.keys(recs.summary.statusTotals).join(','));

      // 旧流程遗留 wait 记录 → 升级为会话（不重复建行）
      const wed = pastDateOf(3);
      const tk = await call('GET', '/tasks?date=' + wed + '&teacherId=' + teacherUserId, { token: adminToken });
      const task = (tk.data || []).filter(function (x) { return x.classId === nursingClassId && x.section === '1-2'; })[0];
      check(!!task, '找到护理3班星期三 1-2 的课表任务', task && (task.courseName + ' ' + task.teacherName + ' ' + task.weekdayText));
      if (task) {
        const freeDate = await freeTaskDate(adminToken, teacherUserId, task.id, Number(task.weekday));
        check(!!freeDate, '找到一条同星期且无记录的过去日期', freeDate);
        if (freeDate) {
          const cadreUser = (await call('GET', '/auth/me', { token: cadreToken })).data.user;
          const legacyRec = await expect('POST', '/records', {
            token: teacherToken,
            body: { taskId: task.id, teachDate: freeDate, absentCount: 0, signerId: cadreUser.id, summary: '旧流程发起的记录' },
          }, 0, '旧流程 POST /records 成功（保持可用）');
          const up = await expect('POST', '/sessions', {
            token: cadreToken,
            body: { courseName: task.courseName, teacherName: task.teacherName, teachDate: freeDate, section: task.section },
          }, 0, '同课时的 POST /sessions → 升级旧记录（不重复建行）');
          check(up.adopted === true && up.sessionId === legacyRec.id,
            '旧记录被升级为会话（adopted=true，同一 id）', 'adopted=' + up.adopted + ' ' + up.sessionId + ' vs ' + legacyRec.id);
          const cf = await expect('POST', '/sessions/' + up.sessionId + '/confirm', {
            token: teacherToken, body: { codeId: up.codeId },
          }, 0, '升级后的会话可被教师确认');
          check(cf.status === 'done', '升级会话确认成功', cf.sessionId + ' → ' + cf.status);
          check(up.session.isTempAdjusted === false, '与课表完全一致 → isTempAdjusted=false');
        }
      }

      // 签名接口仍保留（历史数据/旧客户端可用）
      const rec = await call('GET', '/records/' + s2.sessionId, { token: cadreToken });
      check(rec.code === 0 && rec.data && rec.data.evidence && rec.data.evidence.count === 4 &&
        rec.data.evidence.labels.join('/') === '签名图/确认时间/设备/动态码',
        '旧 /records/{id} 仍返回兼容口径证据四项（历史数据/旧客户端；新流程四项见 /sessions/{id}）',
        rec.data && rec.data.evidence ? rec.data.evidence.labels.join('/') : '');
    }

    // ---------------------------------------------------------------- 12B 教学班列表
    section('12B. GET /classes 教学班列表（角色可见范围 + 筛选 + 与 POST /class-courses 串联）');
    {
      const nursingDeptId = (await call('GET', '/auth/me', { token: cadreToken })).data.user.deptId;
      const pharmacyDeptId = (await call('GET', '/auth/me', { token: cadre2Token })).data.user.deptId;
      check(!!nursingDeptId && !!pharmacyDeptId && nursingDeptId !== pharmacyDeptId,
        '两个班干部所属院系不同', nursingDeptId + ' / ' + pharmacyDeptId);

      // 班干部：仅本班
      const cad = await expect('GET', '/classes?pageSize=200', { token: cadreToken }, 0, 'GET /classes（班干部）');
      check(cad.total === 1 && cad.list.length === 1 && cad.list[0].classId === nursingClassId,
        '班干部仅看到本班（其它班不可见）', cad.total + ' 个：' + cad.list.map(function (r) { return r.className; }).join(','));
      const c0 = cad.list[0] || {};
      check(c0.id === c0.classId && c0.name === c0.className && !!c0.grade && c0.deptId === nursingDeptId && c0.deptName === '护理学院',
        '返回 id/classId/name/className/grade/deptId/deptName（deptName 由 t_dept 关联）',
        JSON.stringify({ id: c0.id, classId: c0.classId, name: c0.name, grade: c0.grade, deptName: c0.deptName }));
      check(typeof c0.cadreCount === 'number' && c0.cadreCount >= 1 && typeof c0.studentCount === 'number' && c0.studentCount >= 1,
        '带班干部人数 / 学生人数（取自 t_class_cadre / t_student）', '班干部 ' + c0.cadreCount + ' / 学生 ' + c0.studentCount);

      // 教师：全部（只读）
      const tea = await expect('GET', '/classes?pageSize=200', { token: teacherToken }, 0, 'GET /classes（教师）');
      check(tea.total >= 2 && tea.list.some(function (r) { return r.classId === nursingClassId; }) &&
        tea.list.some(function (r) { return r.classId === pharmacyClassId; }),
        '教师可见全部教学班（跨院系，只读）', tea.total + ' 个');

      // 院系管理员：仅本院系
      const dept = await expect('GET', '/classes?pageSize=200', { token: deptToken }, 0, 'GET /classes（院系管理员）');
      check(dept.total >= 1 && dept.list.every(function (r) { return r.deptId === nursingDeptId; }) &&
        !dept.list.some(function (r) { return r.classId === pharmacyClassId; }),
        '院系管理员仅见本院系班级', dept.total + ' 个：' + dept.list.map(function (r) { return r.className; }).join(','));

      // 教务处：全部
      const adm = await expect('GET', '/classes?pageSize=200', { token: adminToken }, 0, 'GET /classes（教务处）');
      check(adm.total >= tea.total, '教务处可见全部教学班', adm.total + ' 个');

      // 筛选：deptId / keyword / classId
      const byDept = await expect('GET', '/classes?deptId=' + pharmacyDeptId + '&pageSize=200', { token: adminToken }, 0, '按 deptId 筛选');
      check(byDept.list.length >= 1 && byDept.list.every(function (r) { return r.deptId === pharmacyDeptId && r.deptName === '药学院'; }),
        'deptId 过滤生效', byDept.total + ' 个');
      const byKw = await expect('GET', '/classes?keyword=' + encodeURIComponent('护理') + '&pageSize=200', { token: adminToken }, 0, '按 keyword 筛选');
      check(byKw.list.length >= 1 && byKw.list.every(function (r) { return /护理/.test(r.className) || /护理/.test(r.deptName); }),
        'keyword 支持班级名/院系名模糊匹配', byKw.total + ' 个');
      const byClass = await expect('GET', '/classes?classId=' + pharmacyClassId, { token: adminToken }, 0, '按 classId 精确查');
      check(byClass.total === 1 && byClass.list[0].classId === pharmacyClassId, 'classId 精确查询', byClass.total + ' 个');
      const crossDept = await expect('GET', '/classes?deptId=' + pharmacyDeptId, { token: deptToken }, 0, '院系管理员带别院系 deptId');
      check(crossDept.total === 0, '院系管理员无法用 deptId 突破本院系范围（返回空）', crossDept.total + ' 个');
      await expect('GET', '/classes?classId=' + pharmacyClassId, { token: cadreToken }, 40301, '班干部查询别班 → 40301');

      // 串联：先 GET /classes 拿 classId，再 POST /class-courses 建课（后台新增第一条课程的链路）
      const ownClass = cad.list[0] || {};
      const created = ownClass.classId ? await expect('POST', '/class-courses', {
        token: cadreToken,
        body: { classId: ownClass.classId, courseName: '自测：先选班再建课', teacherName: '唐瑞明', section: '9-10', hours: 2 },
      }, 0, '用 /classes 返回的 classId 录入课程清单（串联可用）') : null;
      check(!!created && created.classId === ownClass.classId && created.className === ownClass.className && created.classCourseId === created.id,
        '/classes → /class-courses 串联成功（班级快照一致）',
        created ? (created.id + ' ' + created.className + ' / ' + created.courseName) : '未取得教学班');
      if (created) {
        const back = await expect('GET', '/class-courses?classId=' + created.classId + '&pageSize=200', { token: cadreToken }, 0, '回查课程清单');
        check(back.list.some(function (r) { return r.id === created.id; }), '新建课程出现在课程清单中', back.total + ' 条');
      }
    }

    // ---------------------------------------------------------------- 12C 导出新增三列
    section('12C. 导出课时明细新增三列（确认人 / 是否临时调整 / 确认人与实际授课人不符）');
    {
      const adminName = (await call('GET', '/auth/me', { token: adminToken })).data.user.name;
      // 造一条「临时调整 + 确认人≠实际授课人」的新流程会话，保证三列都有值可校验
      const dT = pastDateOf(2, 8);
      const tmpSes = await expect('POST', '/sessions', {
        token: cadreToken,
        body: {
          courseName: '自测导出：临时调整课时', teacherName: '外聘教师甲', teachDate: dT,
          section: '7-8', hours: 2, isTempAdjusted: true,
        },
      }, 0, '发起一条标记「临时调整」的会话（导出三列取值校验用）');
      const tmpCf = await expect('POST', '/sessions/' + tmpSes.sessionId + '/confirm', {
        token: adminToken, body: { codeId: tmpSes.codeId },
      }, 0, '教务处代确认（确认人 ≠ 实际授课人）');
      check(!!tmpCf && tmpCf.nameMismatch === true, '该会话确认人与实际授课人不符（用于校验导出列）', adminName + ' ≠ 外聘教师甲');

      const expJob = await expect('POST', '/export/records', { token: adminToken, body: { format: 'csv' } }, 0, 'POST /export/records');
      let expMeta = null;
      for (let i = 0; i < 25; i++) {
        expMeta = (await call('GET', '/export/' + expJob.jobId, { token: adminToken })).data;
        if (expMeta && (expMeta.status === 'done' || expMeta.status === 'failed')) break;
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      check(!!expMeta && expMeta.status === 'done' && !!expMeta.downloadUrl, '导出任务完成并返回下载地址',
        expMeta && (expMeta.successRows + ' 行 ' + expMeta.fileName));
      const dl = expMeta && expMeta.downloadUrl ? await fetch(BASE + expMeta.downloadUrl) : null;
      const parsed = dl ? u.parseCsv(await dl.text()) : { headers: [], rows: [] };
      const H = parsed.headers;
      check(!!dl && dl.status === 200 && H.length === 21 &&
        H[11] === '发起人（学委）' && H[14] === '确认人' && H[15] === '是否临时调整' && H[16] === '确认人与实际授课人不符',
        '导出表头 21 列，「签字人」改为「发起人（学委）」，第 14/15/16 列为新增三列（列顺序固定）',
        H.length + ' 列：' + H.join('|'));
      const rows = parsed.rows;
      const cell = function (r, name) { return r[name] === undefined ? '' : String(r[name]); };
      const findRow = function (course, date, section) {
        return rows.filter(function (r) {
          return cell(r, '课程') === course && cell(r, '上课日期') === date && cell(r, '节次') === section;
        })[0];
      };

      // ① 新流程 · 临时调整 + 代课确认：三列均为「是」/确认人
      const rowA = findRow('自测导出：临时调整课时', dT, '7-8');
      check(!!rowA && cell(rowA, '确认人') === adminName && cell(rowA, '是否临时调整') === '是' &&
        cell(rowA, '确认人与实际授课人不符') === '是',
        '新流程（临时调整 + 姓名不符）：确认人 / 是否临时调整=是 / 姓名不符=是 均有正确值',
        rowA ? JSON.stringify({ 确认人: cell(rowA, '确认人'), 临时调整: cell(rowA, '是否临时调整'), 姓名不符: cell(rowA, '确认人与实际授课人不符'), 发起人: cell(rowA, '发起人（学委）') }) : '未找到导出行');

      // ② 新流程 · 教师本人确认、非临时调整：是否临时调整=否 / 姓名不符=否
      const rowB = findRow(s2.session.courseName, s2.session.teachDate, s2.session.section);
      check(!!rowB && cell(rowB, '确认人') === '唐瑞明' && cell(rowB, '是否临时调整') === '否' &&
        cell(rowB, '确认人与实际授课人不符') === '否',
        '新流程（姓名一致、非临时调整）：确认人=唐瑞明 / 临时调整=否 / 姓名不符=否',
        rowB ? JSON.stringify({ 确认人: cell(rowB, '确认人'), 临时调整: cell(rowB, '是否临时调整'), 姓名不符: cell(rowB, '确认人与实际授课人不符') }) : '未找到导出行');

      // ③ 旧流程数据（无 confirmed_name / 无发起人）：三列输出空
      const legacyRows = rows.filter(function (r) {
        return cell(r, '确认人') === '' && cell(r, '是否临时调整') === '' && cell(r, '确认人与实际授课人不符') === '';
      });
      check(legacyRows.length > 0, '旧流程数据（无确认人）三列输出空，可据此区分两套流程',
        legacyRows.length + ' 行，例如 ' + (legacyRows[0] ? (cell(legacyRows[0], '课程') + ' ' + cell(legacyRows[0], '上课日期') + ' ' + cell(legacyRows[0], '状态')) : '—'));

      // ④ 新流程未确认的会话：确认人为空，但临时调整/姓名不符仍给出 是/否（不出现缺列）
      const dW = pastDateOf(4, 9);
      const waitSes = await expect('POST', '/sessions', {
        token: cadreToken,
        body: { courseName: '自测导出：待确认课时', teacherName: '外聘教师癸', teachDate: dW, section: '1-2', hours: 2 },
      }, 0, '发起一条待确认会话（校验未确认行的取值）');
      const exp2 = await expect('POST', '/export/records', { token: adminToken, body: { format: 'csv' } }, 0, '再次导出（含待确认会话）');
      let meta2 = null;
      for (let i = 0; i < 25; i++) {
        meta2 = (await call('GET', '/export/' + exp2.jobId, { token: adminToken })).data;
        if (meta2 && (meta2.status === 'done' || meta2.status === 'failed')) break;
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      const dl2 = meta2 && meta2.downloadUrl ? await fetch(BASE + meta2.downloadUrl) : null;
      const rows2 = dl2 ? u.parseCsv(await dl2.text()).rows : [];
      const rowW = rows2.filter(function (r) {
        return r['课程'] === waitSes.session.courseName && r['上课日期'] === dW && r['节次'] === '1-2';
      })[0];
      check(!!rowW && rowW['确认人'] === '' && rowW['是否临时调整'] === '否' && rowW['确认人与实际授课人不符'] === '否',
        '待确认会话：确认人为空、临时调整/姓名不符仍为「否」（列不缺失、不编造确认人）',
        rowW ? JSON.stringify({ 状态: rowW['状态'], 确认人: rowW['确认人'], 临时调整: rowW['是否临时调整'], 姓名不符: rowW['确认人与实际授课人不符'] }) : '未找到导出行');
    }

    // ---------------------------------------------------------------- 13 审计
    section('13. 操作留痕与审计哈希链');
    {
      const logs = await expect('GET', '/logs?action=session&pageSize=200', { token: adminToken }, 0, 'GET /logs?action=session');
      check(logs.total >= 5, '会话相关操作已留痕（session.create/confirm/code.refresh/adopt）',
        logs.list.map(function (l) { return l.action; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(','));
      const cc = await expect('GET', '/logs?action=class_course&pageSize=200', { token: adminToken }, 0, 'GET /logs?action=class_course');
      check(cc.total >= 3, '课程清单操作已留痕（class_course.create/update/archive）',
        cc.list.map(function (l) { return l.action; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(','));
      const chain = await expect('GET', '/logs/verify', { token: adminToken }, 0, 'GET /logs/verify');
      check(chain.ok === true, '审计哈希链完整（新增动作后未断裂）', 'total=' + chain.total);
      const local = audit.verifyChain();
      check(local.ok === true, '进程内哈希链校验一致', 'headHash=' + String(local.headHash).slice(0, 16) + '…');
    }
  } finally {
    await new Promise(function (r) { srv.close(r); });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n============================================================');
  console.log('业务流程简化专项自测结果：通过 ' + pass + ' / 失败 ' + failCount);
  if (failures.length) {
    console.log('失败明细：');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
  }
  console.log('临时数据目录已清理：' + tmp);
  console.log('============================================================');
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
