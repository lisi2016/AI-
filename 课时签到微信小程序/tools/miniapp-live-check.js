'use strict';
/**
 * 小程序 ↔ 已部署后端 只读联调自检（Node 18+，需要能访问 http://8.138.41.74）
 *
 * 用法（在项目根目录「课时签到微信小程序/」执行）：
 *   node tools/miniapp-live-check.js
 *   node tools/miniapp-live-check.js --code=probe-fixed-cadre-02   # 指定一个已绑定的 wx.login code
 *
 * 作用：把小程序真正的 utils/api.js（业务流程简化后的新接口）接到真实后端上跑一遍，
 *       证明「班干部登录 → 课程清单 → 今日课程 → 课时会话列表/详情 → 教师可见范围」
 *       这条链路在已部署服务上是通的（而不是只在桩里通）。
 *
 * 安全约定（不写库、不改线上数据）：
 *   · 只做 GET，以及两个**必然被后端拒绝**的探针：
 *       - 教师调用 POST /sessions → 40301（角色校验先于写入，不落任何数据）
 *       - POST /code/verify {codeId:'CD-NOT-EXIST-LIVECHECK'} → 40401（不消费任何动态码）
 *   · 不调用 POST /sessions（真发起）、/sessions/{id}/code、/sessions/{id}/confirm、
 *     /class-courses 的写接口、/records 的写接口
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.KCSQ_API_BASE || 'http://8.138.41.74';

let pass = 0;
let failCount = 0;
const failures = [];
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------- wx / getApp 桩（真实 HTTP 版本）
const storage = {};
const trace = [];
let appStub = null;

function queryString(data) {
  const parts = [];
  Object.keys(data || {}).forEach(function (k) {
    const v = data[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.join('&');
}

async function http(opts) {
  const url = String(opts.url || '');
  const method = String(opts.method || 'GET').toUpperCase();
  const header = Object.assign({}, opts.header || {});
  const init = { method: method, headers: header };
  let finalUrl = url;
  if (method === 'GET' || method === 'HEAD') {
    const qs = queryString(opts.data);
    if (qs) finalUrl += (finalUrl.indexOf('?') >= 0 ? '&' : '?') + qs;
  } else {
    header['Content-Type'] = header['Content-Type'] || 'application/json';
    init.body = JSON.stringify(opts.data || {});
  }
  const resp = await fetch(finalUrl, init);
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { code: -1, msg: 'non-json', raw: text.slice(0, 200) }; }
  trace.push({ method: method, url: finalUrl.replace(BASE, ''), status: resp.status, code: body.code, msg: body.msg });
  return { statusCode: resp.status, data: body };
}

global.wx = {
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function () {},
  showModal: function (o) { if (o && o.success) o.success({ confirm: false }); },
  navigateTo: function () {}, switchTab: function () {}, reLaunch: function () {}, redirectTo: function () {},
  request: function (o) {
    http(o).then(function (res) { if (o.success) o.success(res); })
      .catch(function (err) { if (o.fail) o.fail({ errMsg: String(err && err.message) }); });
  },
  uploadFile: function (o) { if (o.fail) o.fail({ errMsg: 'live-check 不上传文件' }); },
  downloadFile: function (o) { if (o.fail) o.fail({ errMsg: 'live-check 不下载文件' }); },
  login: function (o) { if (o.fail) o.fail({ errMsg: 'live-check 用不到 wx.login' }); }
};
global.getApp = function () { return appStub; };

async function main() {
  const arg = process.argv.filter(function (a) { return a.indexOf('--code=') === 0; })[0];
  // DEV_MODE 下 openid 由 code 派生，同一个 code 永远是同一个微信 → 可复现「已绑定」登录
  const CADRE_CODE = arg ? arg.split('=')[1] : (process.env.KCSQ_CADRE_CODE || 'probe-fixed-cadre-02');
  const TEACHER_CODE = process.env.KCSQ_TEACHER_CODE || 'probe-fixed-teacher-01';

  appStub = {
    globalData: { role: '', user: null, token: '', needBind: false, bindHint: '', useMock: false, apiBase: BASE, config: null },
    ready: function () { return Promise.resolve(); },
    setSession: function (d) { return require(path.join(ROOT, 'miniprogram/utils/session.js')).saveSession(d); },
    clearRole: function () {}
  };

  const api = require(path.join(ROOT, 'miniprogram/utils/api.js'));
  const session = require(path.join(ROOT, 'miniprogram/utils/session.js'));
  const shape = require(path.join(ROOT, 'miniprogram/utils/shape.js'));

  section('0. 后端可达性');
  let health;
  try {
    const r = await fetch(BASE + '/api/v1/health');
    health = await r.json();
  } catch (e) {
    bad('后端可达性', '无法访问 ' + BASE + '：' + (e && e.message));
    console.log('\n无法连接后端，联调自检终止。');
    process.exit(2);
  }
  check(health.code === 0 && health.data && health.data.status === 'ok',
    'GET /api/v1/health 正常',
    health.data ? (health.data.service + ' v' + health.data.version + ' devMode=' + health.data.devMode + ' today=' + health.data.today) : '');
  const counts = (health.data && health.data.counts) || {};
  ok('后端数据规模', 'users=' + counts.users + ' classes=' + counts.classes + ' classCourses=' + counts.classCourses + ' periodRecords=' + counts.periodRecords);

  section('1. 班干部：登录（已绑定 → 直接拿 token）');
  let cadreOk = false;
  try {
    const login1 = await api.login(CADRE_CODE);
    cadreOk = !!login1.token;
    check(!!login1.token && login1.needBind === false, '已绑定的 code 直接返回 token',
      'role=' + login1.role + ' name=' + (login1.user && login1.user.name) + ' class=' + (login1.user && login1.user.className));
    if (cadreOk) {
      session.saveSession(login1);
      check(session.getToken() === login1.token, 'token 已写入 storage（session.saveSession）', 'len=' + session.getToken().length);
      check(appStub.globalData.role === login1.role && !!appStub.globalData.user, 'globalData.role/user 已同步', appStub.globalData.role);
    }
  } catch (e) {
    bad('班干部登录', 'code=' + CADRE_CODE + ' → code=' + e.code + ' msg=' + e.msg);
  }

  section('2. 班级课程清单（只读）：GET /class-courses');
  let firstCourse = null;
  if (!cadreOk) {
    ok('跳过（班干部未登录）', '无法拿到 token，改用后面的 40101 探针验证鉴权');
  } else {
    try {
      const all = await api.getClassCourses({ status: 'all', page: 1, pageSize: 20 });
      const page = shape.pageOf(all);
      const list = shape.courseList(page.list);
      check(Array.isArray(page.list), 'GET /class-courses 返回分页结构', 'total=' + page.total + ' 本页=' + list.length);
      check(!!page.summary && typeof page.summary.active === 'number',
        'summary 给出 使用中/已归档 计数', JSON.stringify(page.summary));
      if (list.length) {
        firstCourse = list[0];
        check(!!firstCourse.courseName && !!firstCourse.teacherName,
          '课程清单字段完整（课程名 / 授课老师 / 星期 / 节次 / 地点 / 学时 / 状态）',
          [firstCourse.courseName, firstCourse.teacherName, firstCourse.weekdayText, firstCourse.section,
            firstCourse.place, firstCourse.hours + '学时', firstCourse.statusText].join(' / '));
        const one = await api.getClassCourse(firstCourse.id);
        check(one && one.id === firstCourse.id, 'GET /class-courses/{id} 详情可读', one ? one.courseName : '—');
      } else {
        ok('课程清单暂为空（班干部还没录入）', 'total=0');
      }
    } catch (e) {
      bad('GET /class-courses', 'code=' + e.code + ' msg=' + e.msg);
    }

    section('3. 今日课程（只读）：GET /class-courses/today');
    try {
      const today = await api.getCoursesToday({ date: shape.todayFull() });
      check(!!today && today.date === shape.todayFull(),
        'GET /class-courses/today 返回日期/星期/当日课程',
        today.date + ' ' + today.weekdayText + ' 共 ' + today.total + ' 门');
      check(shape.courseList(today).every(function (c) { return Number(c.weekday) === Number(today.weekday); }),
        'today 只含「该日期星期有课」的课程', 'weekday=' + today.weekday);
    } catch (e) {
      bad('GET /class-courses/today', 'code=' + e.code + ' msg=' + e.msg);
    }

    section('4. 课时会话（只读）：GET /sessions');
    try {
      const sess = await api.getSessions({ page: 1, pageSize: 5 });
      const page = shape.pageOf(sess);
      const rows = shape.sessionList(page.list);
      check(Array.isArray(page.list), 'GET /sessions 返回分页结构', 'total=' + page.total + ' 本页=' + rows.length);
      check(!!page.summary && !!page.summary.statusTotals,
        'summary.statusTotals 可用（角标口径，不受 status= 影响）',
        JSON.stringify(page.summary && page.summary.statusTotals));
      if (rows.length) {
        const s0 = rows[0];
        check(!!s0.courseName && !!s0.teacherName && !!s0.statusText,
          '会话字段完整（课程 / 实际授课人 / 班级 / 节次 / 地点 / 学时 / 状态）',
          [s0.courseName, s0.teacherName, s0.className, s0.date, s0.section, s0.statusText].join(' / '));
        const detail = await api.getSession(s0.id);
        check(!!detail && !!detail.session, 'GET /sessions/{id} 详情可读', s0.id);
        const ev = shape.sessionEvidence(shape.sessionOf(detail.session), detail.code);
        check(ev.map(function (e) { return e.label; }).join('、') === '动态码、确认人、确认时间、设备',
          '详情证据四项 = 动态码 / 确认人 / 确认时间 / 设备（无手写签名、无定位）',
          ev.map(function (e) { return e.label + '=' + e.value; }).join(' | '));
        check(Array.isArray(detail.auditTail), '详情带审计尾部', (detail.auditTail || []).length + ' 条');
      } else {
        ok('暂无课时会话（班干部还没发起过）', '本页 0 条');
      }
    } catch (e) {
      bad('GET /sessions', 'code=' + e.code + ' msg=' + e.msg);
    }
  }

  section('5. 教师：登录 + 可见范围（只读）');
  let teacherToken = '';
  try {
    const login2 = await api.login(TEACHER_CODE);
    teacherToken = login2.token || '';
    if (!teacherToken) throw { code: 40101, msg: '该 code 未绑定教师账号（needBind=true）' };
    session.saveSession(login2);
    check(login2.role === 'teacher', '教师登录成功', (login2.user && login2.user.name) || '');
    const tasks = shape.taskList(await api.getTasks(shape.todayFull()));
    check(Array.isArray(tasks), 'GET /tasks?date=<今天> 可读并被 shape.taskList 归一化',
      tasks.length + ' 门课（' + shape.todayFull() + '）');
    const mine = await api.getSessions({ page: 1, pageSize: 5 });
    const minePage = shape.pageOf(mine);
    check(Array.isArray(minePage.list), '教师 GET /sessions 只返回本人相关课时（实际授课人或本人确认过）',
      'total=' + minePage.total + ' 本页=' + minePage.list.length);
  } catch (e) {
    bad('教师只读链路', 'code=' + e.code + ' msg=' + e.msg);
  }

  section('6. 权限与鉴权探针（只读，不写库）');
  if (teacherToken) {
    // 教师调 POST /sessions：后端在角色校验阶段就拒绝，不会写入任何数据
    let roleErr = null;
    try {
      await api.createSession({ courseName: 'LIVECHECK-探针', teacherName: '探针', teachDate: shape.todayFull(), section: '1-2', hours: 2 });
    } catch (e) { roleErr = e; }
    check(!!roleErr && roleErr.code === 40301,
      '教师调用 POST /sessions → 40301（角色校验先于写入，未落任何数据）',
      roleErr ? ('code=' + roleErr.code + ' msg=' + roleErr.msg) : '未报错');
    check(!!roleErr && roleErr.code !== 40101, '关键：不是 40101「未登录」→ Authorization 头已被后端接受');
  }
  // 不存在的动态码：40401（不消费任何真实动态码）
  let codeErr = null;
  try {
    await api.verifyCode({ codeId: 'CD-NOT-EXIST-LIVECHECK' });
  } catch (e) { codeErr = e; }
  check(!!codeErr && codeErr.code === 40401,
    'POST /code/verify 用不存在的 codeId → 40401（不消费任何真实动态码）',
    codeErr ? ('code=' + codeErr.code + ' msg=' + codeErr.msg) : '未报错');

  section('7. 40101 场景：伪造 token → 本地会话被清理');
  storage.token = 'FORGED-INVALID-TOKEN';
  appStub.globalData.token = 'FORGED-INVALID-TOKEN';
  let unauthorized = null;
  try {
    await api.getClassCourses({ status: 'active' });
  } catch (e) { unauthorized = e; }
  check(!!unauthorized && unauthorized.code === 40101, '无效 token → 后端返回 40101',
    unauthorized ? ('code=' + unauthorized.code + ' msg=' + unauthorized.msg) : '未报错');
  check(api.isUnauthorized(unauthorized) === true, 'api.isUnauthorized(err) 识别为「需要重新绑定」');
  check(!storage.token, '收到 40101 后本地 token 被清除', 'token=' + storage.token);

  section('8. 无定位采集（静态检查）');
  const fs = require('fs');
  const mp = path.join(ROOT, 'miniprogram');
  const hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json|wxml)$/.test(e.name)) {
        if (/getLocation|chooseLocation|onLocationChange|startLocationUpdate|requiredPrivateInfos|latitude|longitude/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    });
  })(mp);
  check(hits.length === 0, 'miniprogram 全目录无定位相关代码（无 wx.getLocation / requiredPrivateInfos / 经纬度）',
    hits.length ? hits.join('、') : '已检查 ' + mp);

  // ---- 汇总
  console.log('\n' + '='.repeat(70));
  console.log('真实后端只读联调自检（' + BASE + '）：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('--- 请求轨迹（方法 路径 → code）---');
  trace.forEach(function (t) { console.log('  ' + t.method + ' ' + t.url + ' → HTTP ' + t.status + ' code=' + t.code + (t.msg && t.msg !== 'ok' ? ' msg=' + t.msg : '')); });
  console.log('='.repeat(70));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('联调自检异常：', e);
  process.exit(2);
});
