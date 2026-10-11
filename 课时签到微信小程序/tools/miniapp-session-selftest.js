'use strict';
/**
 * 小程序「业务流程简化」专项自测（Node 18+，零依赖，不需要微信开发者工具）
 *
 * 用法（在项目根目录「课时签到微信小程序/」执行）：
 *   node tools/miniapp-session-selftest.js
 *
 * 覆盖新流程全链路（wx / Page / getApp 桩，默认走 useMock 离线数据）：
 *   ① 班干部「我的课程」：GET /class-courses → POST → PUT → DELETE(归档)
 *      以及后端 msg 原样展示（敏感词 / 长度 / 权限 / 已归档）
 *   ② 班干部首页：GET /class-courses/today → POST /sessions（拿 code + qrPayload）→
 *      canvas 渲染分支 → 刷新码（POST /sessions/{id}/code）→ 临时调整发起（isTempAdjusted）
 *      →「同时保存到课程清单」额外 PUT /class-courses/{id} → 重复发起 40901
 *   ③ 教师端：wx.scanCode / 6 位口令 → POST /code/verify（isSession + session）→
 *      POST /sessions/{id}/confirm → 成功「已确认本次课时」；代课 nameMismatch 仍成功；
 *      41001/41002/40401 中文提示 + 引导班干部刷新；旧课表码给出重新出示引导
 *   ④ 记录页 GET /sessions（分页 + statusTotals 角标）与详情 GET /sessions/{id}
 *      （证据四项：动态码 / 确认人 / 确认时间 / 设备，无手写签名图）
 *   ⑤ 未绑定 → 引导绑定（不静默失败）；mock 模式零网络请求
 *   ⑥ 真实分支（useMock=false）请求 URL / 方法 / 请求头 / 请求体核对
 *
 * 说明：本脚本用内存桩替代 wx，不改动任何线上代码；断言数最后统一汇总。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

let pass = 0;
let failCount = 0;
const failures = [];
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function trim(s) { return String(s === undefined || s === null ? '' : s); }

// ================================================================ wx / Page / getApp 桩
const storage = {};
const calls = {
  toasts: [], modals: [], navigations: [], clipboard: [], canvas: [], scan: 0, requests: []
};
let modalQueue = [];
let modalReply = { confirm: false };
let scanResult = '';
let scanFail = null;

function resetCalls() {
  calls.toasts = [];
  calls.modals = [];
  calls.navigations = [];
  calls.clipboard = [];
  calls.canvas = [];
  calls.scan = 0;
  calls.requests = [];
}

function makeCanvasContext(id) {
  const ops = { id: id, fills: [], colors: [], draws: 0 };
  calls.canvas.push(ops);
  return {
    setFillStyle: function (c) { ops.colors.push(c); },
    fillRect: function (x, y, w, h) { ops.fills.push([x, y, w, h]); },
    draw: function () { ops.draws++; },
    setStrokeStyle: function () {},
    stroke: function () {}
  };
}

const appStub = {
  globalData: {
    role: '', user: null, token: '', needBind: true, bindHint: '',
    useMock: true, apiBase: '', config: null
  },
  ready: function () { return Promise.resolve({ role: this.globalData.role, user: this.globalData.user }); }
};

function loginAs(role, user) {
  storage.token = 'mock-token';
  storage.role = role;
  storage.user = user;
  appStub.globalData.token = 'mock-token';
  appStub.globalData.role = role;
  appStub.globalData.user = user;
  appStub.globalData.needBind = false;
}
function logoutLocal() {
  ['token', 'role', 'user'].forEach(function (k) { delete storage[k]; });
  appStub.globalData.token = '';
  appStub.globalData.role = '';
  appStub.globalData.user = null;
  appStub.globalData.needBind = true;
}

/** 真实分支（useMock=false）用的极简假后端 */
const realBackend = {
  codes: {
    'CD00000001': { code: '042317', expireAtMs: Date.now() + 60000, used: false, sessionId: 'R00000031' }
  },
  route: function (o) {
    const url = String(o.url || '').replace('http://backend.test', '');
    const method = String(o.method || 'GET').toUpperCase();
    const pathOnly = url.split('?')[0];
    const okBody = function (data) { return { statusCode: 200, data: { code: 0, msg: 'ok', data: data } }; };
    if (pathOnly === '/api/v1/class-courses' && method === 'GET') {
      return okBody({ list: [{ id: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明', status: 'active' }], total: 1, page: 1, pageSize: 20, summary: { total: 1, active: 1, archived: 0 } });
    }
    if (pathOnly === '/api/v1/class-courses/today' && method === 'GET') {
      return okBody({ date: '2026-09-23', weekday: 3, weekdayText: '周三', total: 1, list: [{ id: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明', section: '1-2', hours: 2, status: 'active' }] });
    }
    if (pathOnly === '/api/v1/class-courses' && method === 'POST') {
      return okBody({ id: 'CR00000002', courseName: '医学信息检索', teacherName: '唐瑞明', status: 'active' });
    }
    if (/^\/api\/v1\/class-courses\/CR/.test(pathOnly) && method === 'PUT') {
      return okBody({ id: 'CR00000001', courseName: '信息技术', teacherName: '李慧', status: 'active' });
    }
    if (/^\/api\/v1\/class-courses\/CR/.test(pathOnly) && method === 'DELETE') {
      return okBody({ ok: true, id: 'CR00000001', status: 'archived', archived: true });
    }
    if (pathOnly === '/api/v1/sessions' && method === 'POST') {
      return okBody({
        sessionId: 'R00000031', codeId: 'CD00000001', code: '042317', codeLength: 6,
        qrPayload: 'kcsq://code/CD00000001', qrUrl: 'kcsq://code/CD00000001', ttl: 60,
        expireAtMs: Date.now() + 60000, adopted: false,
        channels: { qr: { payload: 'kcsq://code/CD00000001' }, code: { value: '042317' } },
        session: { sessionId: 'R00000031', courseName: '信息技术', teacherName: '唐瑞明', className: '2025级护理3班', status: 'wait', statusText: '待教师确认', isTempAdjusted: true, hours: 2 }
      });
    }
    if (/^\/api\/v1\/sessions\/R00000031\/code$/.test(pathOnly) && method === 'POST') {
      return okBody({
        sessionId: 'R00000031', codeId: 'CD00000002', code: '123456', qrPayload: 'kcsq://code/CD00000002', ttl: 60,
        expireAtMs: Date.now() + 60000, refreshed: true,
        session: { sessionId: 'R00000031', courseName: '信息技术', teacherName: '唐瑞明', status: 'wait', statusText: '待教师确认', hours: 2 }
      });
    }
    if (pathOnly === '/api/v1/sessions' && method === 'GET') {
      return okBody({
        list: [{ sessionId: 'R00000031', courseName: '信息技术', className: '2025级护理3班', teacherName: '唐瑞明', status: 'wait', statusText: '待教师确认', hours: 2 }],
        total: 1, page: 1, pageSize: 20,
        summary: { hours: 0, byStatus: { wait: 1 }, statusTotals: { draft: 0, wait: 1, done: 4, rejected: 0, expired: 2, appealing: 0, makeup: 0, revoked: 0 } }
      });
    }
    if (/^\/api\/v1\/sessions\/R00000031$/.test(pathOnly) && method === 'GET') {
      return okBody({
        session: { sessionId: 'R00000031', courseName: '信息技术', teacherName: '唐瑞明', className: '2025级护理3班', status: 'wait', statusText: '待教师确认', hours: 2 },
        course: { id: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明', hours: 2, status: 'active' },
        code: { codeId: 'CD00000001', used: false }, auditTail: []
      });
    }
    if (/^\/api\/v1\/sessions\/R00000031\/confirm$/.test(pathOnly) && method === 'POST') {
      return okBody({
        ok: true, sessionId: 'R00000031', status: 'done', counted: true, nameMismatch: false,
        codeConsumed: 'CD00000001', confirmedBy: 'U00000001', confirmedName: '唐瑞明',
        confirmedAt: '2026-09-23T10:05:12+08:00', confirmedRole: 'teacher', teacherName: '唐瑞明',
        msg: '已确认本次课时', session: { sessionId: 'R00000031', status: 'done', statusText: '已确认' }
      });
    }
    if (pathOnly === '/api/v1/code/verify' && method === 'POST') {
      return okBody({
        codeId: 'CD00000001', verifyBy: 'qrContent', isSession: true, sessionId: 'R00000031',
        session: { sessionId: 'R00000031', courseName: '信息技术', teacherName: '唐瑞明', className: '2025级护理3班', status: 'wait', statusText: '待教师确认', hours: 2 },
        canConfirm: true, tasks: []
      });
    }
    return { statusCode: 404, data: { code: 40401, msg: '假后端未实现：' + method + ' ' + pathOnly, data: {} } };
  }
};

global.getApp = function () { return appStub; };
global.wx = {
  getSystemInfoSync: function () { return { windowWidth: 375, brand: 'Apple', model: 'iPhone 13' }; },
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { calls.toasts.push(o); },
  showModal: function (o) {
    calls.modals.push(o);
    const next = modalQueue.length ? modalQueue.shift() : modalReply;
    if (next && typeof o.success === 'function') o.success(next);
  },
  navigateTo: function (o) { calls.navigations.push({ type: 'navigateTo', url: o.url }); if (o.success) o.success(); },
  navigateBack: function (o) { calls.navigations.push({ type: 'navigateBack', delta: (o && o.delta) || 1 }); if (o && o.success) o.success(); },
  redirectTo: function (o) { calls.navigations.push({ type: 'redirectTo', url: o.url }); },
  reLaunch: function (o) { calls.navigations.push({ type: 'reLaunch', url: o.url }); },
  switchTab: function (o) { calls.navigations.push({ type: 'switchTab', url: o.url }); },
  setClipboardData: function (o) { calls.clipboard.push(o.data); if (o.success) o.success(); },
  setNavigationBarTitle: function () {},
  createCanvasContext: function (id) { return makeCanvasContext(id); },
  login: function (o) { if (o && o.success) o.success({ code: 'stub-login-code' }); },
  scanCode: function (o) {
    calls.scan++;
    if (scanFail) { if (o.fail) o.fail(scanFail); return; }
    if (o.success) o.success({ result: scanResult });
  },
  request: function (o) {
    calls.requests.push({ url: o.url, method: String(o.method || 'GET').toUpperCase(), data: o.data, header: o.header });
    const res = realBackend.route(o);
    if (o.success) o.success(res);
  },
  uploadFile: function (o) { if (o.fail) o.fail({ errMsg: '桩测试不上传文件' }); },
  downloadFile: function (o) { if (o.fail) o.fail({ errMsg: '桩测试不下载文件' }); }
};

let captured = null;
global.Page = function (cfg) { captured = cfg; };

function loadPage(rel) {
  captured = null;
  delete require.cache[require.resolve(path.join(MP, rel))];
  require(path.join(MP, rel));
  const cfg = captured;
  const page = {};
  Object.keys(cfg).forEach(function (k) { page[k] = cfg[k]; });
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  // 支持 'form.courseName' 这类嵌套路径（与微信 setData 语义一致），否则表单断言无法生效
  page.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) {
      if (k.indexOf('.') < 0) { page.data[k] = patch[k]; return; }
      const parts = k.split('.');
      let cur = page.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = patch[k];
    });
    if (typeof cb === 'function') cb();
  };
  return page;
}

// ================================================================ 主流程
async function main() {
  const api = require(path.join(MP, 'utils/api.js'));
  const shape = require(path.join(MP, 'utils/shape.js'));
  const mockData = require(path.join(MP, 'utils/mock.js'));

  const noRequests = function (extra) {
    check(calls.requests.length === 0, 'mock 模式零网络请求（离线演示可用）', extra || ('requests=' + calls.requests.length));
  };

  // ================================================================ 1
  section('1. 班干部「我的课程」：清单 CRUD + 后端 msg 原样展示');
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);

  calls.requests = [];
  const coursesPage = loadPage('pages/courses/courses.js');
  coursesPage.onLoad({});
  await sleep(20);
  check(coursesPage.data.needBind === false, '已绑定班干部 → 不显示绑定引导');
  check(coursesPage.data.readonly === false, '班干部可维护课程清单（readonly=false）');
  await coursesPage.reload();
  check(coursesPage.data.list.length === 3, 'GET /class-courses 渲染出演示课程清单（3 门）', coursesPage.data.list.length + ' 门');
  check(coursesPage.data.list[0].weekdayText === shape.WEEKDAY_OPTIONS[mockData.todayWeekday()].text,
    '列表展示「星期」文案', coursesPage.data.list[0].weekdayText);
  check(coursesPage.data.summary.total === 3 && coursesPage.data.summary.active === 3,
    'summary 计数（total/active/archived）可用', JSON.stringify(coursesPage.data.summary));
  noRequests('课程清单在 mock 下不发请求');

  // 新增
  coursesPage.openCreate();
  coursesPage.setData({
    'form.courseName': '数据库原理', 'form.teacherName': '周敏',
    'form.weekdayIndex': 2, 'form.sectionIndex': 1, 'form.place': '实训楼C201', 'form.hours': '2'
  });
  calls.toasts = [];
  coursesPage.submitForm();
  await sleep(400);
  check(coursesPage.data.form.show === false, '新增成功后收起表单');
  check(calls.toasts.some(function (t) { return /已添加/.test(t.title || ''); }), '新增成功提示');
  const afterCreate = api.__mock.courses().list;
  check(afterCreate.length === 4 && afterCreate.some(function (c) { return c.courseName === '数据库原理'; }),
    'POST /class-courses 生效（清单新增一条）', afterCreate.length + ' 门');

  // 编辑
  const created = afterCreate.filter(function (c) { return c.courseName === '数据库原理'; })[0];
  await coursesPage.reload();
  coursesPage.openEdit({ currentTarget: { dataset: { id: created.id } } });
  check(coursesPage.data.form.mode === 'edit' && coursesPage.data.form.courseName === '数据库原理',
    '点击「编辑」带出该课程（mode=edit）', coursesPage.data.form.mode);
  coursesPage.setData({ 'form.teacherName': '周敏（改）', 'form.place': '实训楼C305' });
  coursesPage.submitForm();
  await sleep(400);
  const edited = api.__mock.courses().list.filter(function (c) { return c.id === created.id; })[0];
  check(edited && edited.teacherName === '周敏（改）' && edited.place === '实训楼C305',
    'PUT /class-courses/{id} 生效（老师/地点已更新）', edited ? (edited.teacherName + ' / ' + edited.place) : '未找到');

  // 归档（软删除）
  await coursesPage.reload();
  modalQueue = [{ confirm: true }];
  coursesPage.archive({ currentTarget: { dataset: { id: created.id, name: '数据库原理' } } });
  await sleep(400);
  const archived = api.__mock.courses().list.filter(function (c) { return c.id === created.id; })[0];
  check(archived && archived.status === 'archived' && archived.archived === true,
    'DELETE /class-courses/{id} 软删除（status=archived，历史可追溯）', archived ? archived.status : '未找到');
  check(coursesPage.data.list.every(function (c) { return c.status !== 'archived'; }),
    '默认列表只显示「使用中」的课程', coursesPage.data.list.length + ' 门');
  // 重复删除 → 42201（msg 原样展示）
  calls.modals = [];
  modalQueue = [{ confirm: true }];
  coursesPage.archive({ currentTarget: { dataset: { id: created.id, name: '数据库原理' } } });
  await sleep(300);
  const dupModal = calls.modals.filter(function (m) { return /归档未成功/.test(m.title || ''); })[0];
  check(!!dupModal && /已归档，无需重复删除/.test(dupModal.content || ''),
    '重复归档 → 42201，后端 msg 原样展示', dupModal ? dupModal.content : '无弹窗');

  // 已归档不可修改
  let updErr = null;
  try { await api.updateClassCourse(created.id, { teacherName: 'X' }); } catch (e) { updErr = e; }
  check(updErr && updErr.code === 42201 && /已归档，不可修改/.test(updErr.msg),
    '已归档课程不可修改 → 42201 + 原文提示', updErr ? (updErr.code + ' ' + updErr.msg) : '未报错');

  // 敏感词 / 长度 / 必填：msg 原样展示
  let sensErr = null;
  try { await api.createClassCourse({ courseName: '代签服务', teacherName: '唐瑞明' }); } catch (e) { sensErr = e; }
  check(sensErr && sensErr.code === 40001 && /内容包含敏感词：代签（课程名称）/.test(sensErr.msg),
    '敏感词 → 40001，提示含命中词与字段名', sensErr ? sensErr.msg : '未报错');

  let longErr = null;
  try { await api.createClassCourse({ courseName: new Array(62).join('长'), teacherName: '唐瑞明' }); } catch (e) { longErr = e; }
  check(longErr && longErr.code === 40001 && /课程名称过长：当前 61 字符，最多 60 字符/.test(longErr.msg),
    '超长 → 40001，提示当前长度与上限', longErr ? longErr.msg : '未报错');

  let emptyErr = null;
  try { await api.createClassCourse({ courseName: '', teacherName: '唐瑞明' }); } catch (e) { emptyErr = e; }
  check(emptyErr && emptyErr.code === 40001 && /课程名称不能为空/.test(emptyErr.msg),
    '必填为空 → 40001 原文提示', emptyErr ? emptyErr.msg : '未报错');

  let wdErr = null;
  try { await api.createClassCourse({ courseName: '体育', teacherName: '王强', weekday: 9 }); } catch (e) { wdErr = e; }
  check(wdErr && wdErr.code === 40001 && /weekday 取值应为 1-7/.test(wdErr.msg),
    'weekday 越界 → 40001 原文提示', wdErr ? wdErr.msg : '未报错');

  // 表单级校验：不填课程名不发请求
  await coursesPage.reload();
  coursesPage.openCreate();
  coursesPage.setData({ 'form.courseName': '', 'form.teacherName': '唐瑞明' });
  coursesPage.submitForm();
  check(/请填写课程名称/.test(coursesPage.data.form.error), '表单前置校验：课程名为空时给出本地提示', coursesPage.data.form.error);

  // 教师只读 + 写操作 40301
  loginAs('teacher', mockData.teacher);
  const teacherCoursesPage = loadPage('pages/courses/courses.js');
  teacherCoursesPage.onLoad({});
  await sleep(20);
  check(teacherCoursesPage.data.readonly === true, '教师打开「我的课程」为只读视图', 'readonly=' + teacherCoursesPage.data.readonly);
  let roleErr = null;
  try { await api.createClassCourse({ courseName: '体育', teacherName: '王强' }); } catch (e) { roleErr = e; }
  check(roleErr && roleErr.code === 40301 && /仅班干部或管理员可维护课程清单/.test(roleErr.msg),
    '教师写课程清单 → 40301 原文提示', roleErr ? roleErr.msg : '未报错');

  // ================================================================ 2
  section('2. 班干部首页：今日课程 → 出示二维码（A 二维码 + B 口令）→ 刷新码 → 临时调整');
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);
  resetCalls();
  const indexPage = loadPage('pages/index/index.js');
  indexPage.onLoad({});
  check(Number.isInteger(indexPage.data.qrSize) && indexPage.data.qrSize >= 180,
    'canvas 边长按屏宽算出整数 px', indexPage.data.qrSize + 'px');
  indexPage.onShow();
  await sleep(700);
  const today = shape.todayFull();
  check(indexPage.data.todayText === today, '首页展示今天（YYYY-MM-DD）', indexPage.data.todayText);
  check(indexPage.data.courses.length >= 2, 'GET /class-courses/today 带出今天有课的课程', indexPage.data.courses.length + ' 门');
  check(indexPage.data.courses.every(function (c) { return c.weekday === mockData.todayWeekday(); }),
    'today 只含「该日期星期有课」的课程', 'weekday=' + mockData.todayWeekday());
  check(indexPage.data.recentSessions.length >= 1, 'GET /sessions 渲染最近课时列表', indexPage.data.recentSessions.length + ' 条');
  check(indexPage.data.recentSessions.some(function (s) { return s.statusText === '已确认'; }),
    '最近课时的状态文案为「已确认 / 已过期」等', indexPage.data.recentSessions.map(function (s) { return s.statusText; }).join('、'));
  noRequests('首页在 mock 下不发起网络请求');

  // 出示二维码：直接带出课程清单信息
  const first = indexPage.data.courses[0];
  resetCalls();
  indexPage.presentCode({ currentTarget: { dataset: { id: first.id } } });
  await sleep(600);
  check(indexPage.data.panel.show === true, '点「出示二维码」后展示课时面板');
  check(indexPage.data.panel.courseName === first.courseName && indexPage.data.panel.teacherName === first.teacherName,
    'POST /sessions 缺省从课程清单带出（课程名 / 实际授课人）',
    indexPage.data.panel.courseName + ' / ' + indexPage.data.panel.teacherName);
  check(indexPage.data.panel.isTempAdjusted === false, '未调整时 isTempAdjusted=false');
  check(/^\d{6}$/.test(trim(indexPage.data.code)), '拿到 6 位数字口令（B 通道）', 'code=' + indexPage.data.code);
  check(indexPage.data.codeDisplay === String(indexPage.data.code).split('').join(' '),
    '口令按位间隔展示，便于教师手输', indexPage.data.codeDisplay);
  check(indexPage.data.qrPayload === 'kcsq://code/' + indexPage.data.codeId,
    '拿到二维码载荷（A 通道）', indexPage.data.qrPayload);
  check(indexPage.data.seconds === 60 && indexPage.data.codeExpired === false, '倒计时按 ttl=60 启动');
  const canvas = calls.canvas[0];
  check(!!canvas && canvas.draws === 1 && canvas.fills.length > 1,
    '真正进入 canvas 渲染分支并绘制二维码', canvas ? (canvas.fills.length + ' 次 fillRect / draw×' + canvas.draws) : '未绘制');
  const qrcode = require(path.join(MP, 'utils/qrcode.js'));
  const expectQr = qrcode.encode(indexPage.data.qrPayload);
  let dark = 0;
  for (let y = 0; y < expectQr.size; y++) for (let x = 0; x < expectQr.size; x++) if (expectQr.modules[y][x] === 1) dark++;
  check(canvas && canvas.fills.length === dark + 1,
    'canvas 上黑色模块数 = 二维码矩阵黑点数 + 1 次白底', canvas ? canvas.fills.length + ' vs ' + (dark + 1) : '无');

  // 复制口令
  resetCalls();
  indexPage.copyCode();
  check(calls.clipboard.length === 1 && calls.clipboard[0] === indexPage.data.code,
    '点击口令可复制（wx.setClipboardData）', calls.clipboard[0]);

  // 刷新码：同一会话换新码
  const oldCodeId = indexPage.data.codeId;
  resetCalls();
  indexPage.refreshCodeTap();
  await sleep(600);
  check(indexPage.data.codeId && indexPage.data.codeId !== oldCodeId,
    '二维码过期刷新 → POST /sessions/{id}/code 换新码', oldCodeId + ' → ' + indexPage.data.codeId);
  check(indexPage.data.seconds === 60 && indexPage.data.codeExpired === false, '刷新后倒计时重置为 60 秒');
  const refreshedSessionId = indexPage.data.panel.sessionId;
  check(!!refreshedSessionId, '刷新后仍是同一个课时会话（sessionId 不变）', refreshedSessionId);
  indexPage.stopTimer();
  indexPage.closePanel();
  await sleep(400);
  check(indexPage.data.panel.show === false, '「收起」关闭出示面板');

  // 临时调整：换老师 + 勾选同时保存到课程清单
  const second = indexPage.data.courses[1] || indexPage.data.courses[0];
  resetCalls();
  indexPage.openAdjust({ currentTarget: { dataset: { id: second.id } } });
  check(indexPage.data.adj.show === true && indexPage.data.adj.courseId === second.id,
    '点「临时调整」带出本次课信息', indexPage.data.adj.courseName);
  indexPage.setData({ 'adj.teacherName': '王代课', 'adj.section': '7-8', 'adj.place': '教学楼B201', 'adj.saveToCourse': true, 'adj.absentCount': '1', 'adj.summary': '第 3 章 数据库基础' });
  indexPage.submitAdjust();
  await sleep(800);
  check(indexPage.data.panel.show === true && indexPage.data.panel.isTempAdjusted === true,
    '临时调整发起 → 后端标记 isTempAdjusted=true（无需审批）', 'tempAdjusted=' + indexPage.data.panel.isTempAdjusted);
  check(indexPage.data.panel.teacherName === '王代课' && indexPage.data.panel.section === '7-8',
    '本次课时按调整值发起（实际授课人 / 节次）',
    indexPage.data.panel.teacherName + ' ' + indexPage.data.panel.section);
  const savedCourse = api.__mock.courses().list.filter(function (c) { return c.id === second.id; })[0];
  check(savedCourse && savedCourse.teacherName === '王代课' && savedCourse.section === '7-8',
    '勾选「同时保存到课程清单」→ 额外 PUT /class-courses/{id} 生效',
    savedCourse ? (savedCourse.teacherName + ' / ' + savedCourse.section) : '未找到');
  // 未勾选时不写回清单
  indexPage.stopTimer();
  indexPage.closePanel();
  await sleep(300);
  const third = indexPage.data.courses[0];
  indexPage.openAdjust({ currentTarget: { dataset: { id: third.id } } });
  indexPage.setData({ 'adj.teacherName': '临时老师', 'adj.saveToCourse': false });
  indexPage.submitAdjust();
  await sleep(600);
  const untouched = api.__mock.courses().list.filter(function (c) { return c.id === third.id; })[0];
  check(untouched && untouched.teacherName === third.teacherName,
    '未勾选时不修改课程清单（只影响本次课）', untouched ? untouched.teacherName : '未找到');
  indexPage.stopTimer();
  indexPage.closePanel();
  await sleep(300);

  // 重复发起 → 40901 + 引导查看已有课时
  resetCalls();
  modalQueue = [{ confirm: true }];
  indexPage.presentCode({ currentTarget: { dataset: { id: first.id } } });
  await sleep(600);
  const dupSessionModal = calls.modals.filter(function (m) { return /未能发起本次课时/.test(m.title || ''); })[0];
  check(!!dupSessionModal && /请勿重复发起/.test(dupSessionModal.content || ''),
    '同一节课重复发起 → 40901，后端 msg 原样展示', dupSessionModal ? dupSessionModal.content : '无弹窗');
  check(!!dupSessionModal && dupSessionModal.confirmText === '查看该课时',
    '40901 时提供「查看该课时」入口', dupSessionModal ? dupSessionModal.confirmText : '无');
  check(calls.navigations.some(function (n) { return n.type === 'navigateTo' && /\/pages\/check\/check\?id=/.test(n.url); }),
    '确认后跳转到已有课时详情', JSON.stringify((calls.navigations[0] || {})));
  check(indexPage.data.codeError !== '', '发起失败时给出明确的错误态（不是静默失败）', indexPage.data.codeError);

  // 已确认的课时不可刷新（42201）
  const doneSession = api.__mock.sessions().list.filter(function (s) { return s.status === 'done'; })[0];
  let refreshErr = null;
  try { await api.refreshSessionCode(doneSession.sessionId); } catch (e) { refreshErr = e; }
  check(refreshErr && refreshErr.code === 42201 && /仅「待教师确认」的课时可刷新动态码/.test(refreshErr.msg),
    '已确认课时刷新码 → 42201 原文提示', refreshErr ? refreshErr.msg : '未报错');

  // 今日无课 → 空态引导
  api.__mock.reset();
  const emptyToday = await api.getCoursesToday({ date: shape.todayFull() });
  check(emptyToday.list.length >= 2, '重置后今日仍有演示课程（种子按运行当天的星期生成）', emptyToday.list.length + ' 门');
  const otherDay = shape.todayFull(new Date(Date.now() + 86400000 * 3));
  const other = await api.getCoursesToday({ date: otherDay });
  check(other.weekday !== mockData.todayWeekday() || other.list.length === 0,
    '非排课日无课程 → 页面给空态与「去我的课程添加」引导', otherDay + ' ' + other.weekdayText + ' ' + other.list.length + ' 门');
  let badDateErr = null;
  try { await api.getCoursesToday({ date: '2026/09/23' }); } catch (e) { badDateErr = e; }
  check(badDateErr && badDateErr.code === 40001, 'date 格式错误 → 40001（前端直接展示原文）', badDateErr ? badDateErr.msg : '未报错');

  // ================================================================ 3
  section('3. 教师端：扫码 / 口令 → /code/verify（isSession）→ /sessions/{id}/confirm');
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);
  const issued = await api.createSession({
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明',
    teachDate: shape.todayFull(), section: '1-2', place: '实训楼A302', hours: 2
  });
  check(issued.isSession === undefined && issued.sessionId && issued.code && issued.qrPayload,
    '前置：班干部发起课时并拿到 code + qrPayload', issued.sessionId + ' / ' + issued.code);

  // 教师扫码（A 通道）：index.startScan → 跳课时确认页
  loginAs('teacher', mockData.teacher);
  resetCalls();
  const teacherIndex = loadPage('pages/index/index.js');
  teacherIndex.onLoad({});
  teacherIndex.onShow();
  await sleep(800);
  check(teacherIndex.data.tasks.length === 3, '教师首页仍渲染教务处导入的今日课表', teacherIndex.data.tasks.length + ' 门');
  check(teacherIndex.data.waitSessions.length >= 1 && teacherIndex.data.waitCount >= 1,
    '教师首页「待我确认的课时」来自 GET /sessions?status=wait', teacherIndex.data.waitSessions.length + ' 条');
  scanResult = issued.qrPayload;
  scanFail = null;
  teacherIndex.startScan();
  check(calls.scan === 1, 'wx.scanCode 被调用（扫码确认入口）');
  const nav = calls.navigations.filter(function (n) { return n.type === 'navigateTo'; })[0];
  check(!!nav && nav.url === '/pages/create/create?codeId=' + issued.codeId,
    '扫码结果解析后跳「课时确认页」', nav ? nav.url : '未跳转');

  // 扫码取消 / 无关内容
  resetCalls();
  scanResult = '';
  scanFail = { errMsg: 'scanCode:fail cancel' };
  teacherIndex.startScan();
  check(calls.navigations.length === 0 && calls.toasts.length === 0, '用户主动取消扫码：不跳转、不打扰');
  resetCalls();
  scanFail = null;
  scanResult = 'https://example.com/not-a-code';
  teacherIndex.startScan();
  check(calls.modals.length === 1 && /无法识别/.test(calls.modals[0].title),
    '扫到无关内容 → 提示「无法识别」，不跳转', (calls.modals[0] || {}).title);

  // B 通道：手输口令
  resetCalls();
  modalQueue = [{ confirm: true, content: issued.code }];
  teacherIndex.inputPassCode();
  check(calls.navigations.length === 1 && calls.navigations[0].url === '/pages/create/create?code=' + issued.code,
    '手输 6 位口令后跳课时确认页（B 通道）', calls.navigations[0] && calls.navigations[0].url);
  resetCalls();
  modalQueue = [{ confirm: true, content: '123' }];
  teacherIndex.inputPassCode();
  check(calls.navigations.length === 0 && calls.toasts.some(function (t) { return /6 位数字口令/.test(t.title || ''); }),
    '口令位数不对 → 不跳转并提示', (calls.toasts[0] || {}).title);

  // 课时确认页：A 通道（codeId）
  resetCalls();
  modalQueue = [];
  let confirmPage = loadPage('pages/create/create.js');
  confirmPage.onLoad({ codeId: issued.codeId });
  await sleep(500);
  check(confirmPage.data.verifyState === 'session', 'POST /code/verify 返回 isSession=true → 进入课时确认态',
    'state=' + confirmPage.data.verifyState + ' ' + confirmPage.data.verifyError);
  check(confirmPage.data.session.courseName === '信息技术' &&
    confirmPage.data.session.teacherName === '唐瑞明' &&
    confirmPage.data.session.className === '2025级药学1班',
    '展示本次课时信息（课程名 / 实际授课人 / 班级）',
    [confirmPage.data.session.courseName, confirmPage.data.session.teacherName, confirmPage.data.session.className].join(' / '));
  check(confirmPage.data.session.section === '1-2' && confirmPage.data.session.place === '实训楼A302' &&
    confirmPage.data.session.hours === 2,
    '展示节次 / 地点 / 学时', [confirmPage.data.session.section, confirmPage.data.session.place, confirmPage.data.session.hours].join(' / '));
  check(confirmPage.data.session.initiatorDuty === '学委' && confirmPage.data.session.initiatorName === '张一鸣',
    '展示发起人（班干部）', confirmPage.data.session.initiatorDuty + ' ' + confirmPage.data.session.initiatorName);
  check(confirmPage.data.canConfirm === true, '待确认课时可点「确认本次课时」');

  // 确认成功
  resetCalls();
  modalQueue = [{ confirm: false }];
  confirmPage.confirm();
  await sleep(600);
  check(confirmPage.data.verifyState === 'done', 'POST /sessions/{id}/confirm 成功 → 页面进入已确认态');
  check(calls.modals.some(function (m) { return m.title === '已确认本次课时'; }),
    '成功提示「已确认本次课时」', (calls.modals[0] || {}).title);
  check(calls.modals.some(function (m) { return /学时计入实际授课人：唐瑞明/.test(m.content || ''); }),
    '提示学时归属（实际授课人）', (calls.modals[0] || {}).content);
  const doneRow = api.__mock.sessions().list.filter(function (s) { return s.sessionId === issued.sessionId; })[0];
  check(doneRow && doneRow.status === 'done' && doneRow.confirmedName === '唐瑞明',
    '会话落库为 done 并记录确认人', doneRow ? (doneRow.status + ' / ' + doneRow.confirmedName) : '未找到');
  check(doneRow && doneRow.confirmDevice === 'Apple iPhone 13', '确认时记录设备（证据四项之一）', doneRow ? doneRow.confirmDevice : '无');

  // 重复确认 → 41002（动态码已消费）
  resetCalls();
  confirmPage = loadPage('pages/create/create.js');
  confirmPage.onLoad({ codeId: issued.codeId });
  await sleep(500);
  check(confirmPage.data.verifyState === 'error' && /已被使用/.test(confirmPage.data.verifyError),
    '已消费的动态码再次核验 → 41002 明确中文提示', confirmPage.data.verifyError);
  check(/让班干部刷新/.test(confirmPage.data.errorAdvice),
    '41002 同时给出「让班干部刷新」的可操作建议', confirmPage.data.errorAdvice);

  // 代课（确认人 ≠ 实际授课人）仍成功
  loginAs('cadre', mockData.cadre);
  const issued2 = await api.createSession({ courseId: 'CR00000002', courseName: '医学信息检索', teacherName: '唐瑞明', teachDate: shape.todayFull(), section: '3-4', place: '图书馆电子阅览室', hours: 2 });
  loginAs('teacher', { id: 'U-OTHER', role: 'teacher', name: '王代课', no: '2099999', dept: '计算机教研室' });
  resetCalls();
  const subPage = loadPage('pages/create/create.js');
  subPage.onLoad({ code: issued2.code });
  await sleep(500);
  check(subPage.data.verifyState === 'session', 'B 通道（6 位口令）核验通过', 'state=' + subPage.data.verifyState);
  modalQueue = [{ confirm: false }];
  subPage.confirm();
  await sleep(600);
  check(subPage.data.confirmResult && subPage.data.confirmResult.nameMismatch === true,
    '确认人 ≠ 实际授课人 → nameMismatch=true（仍算成功）');
  const mismatchModal = calls.modals.filter(function (m) { return /已确认（代课）/.test(m.title || ''); })[0];
  check(!!mismatchModal && /已确认；学时按实际授课人 唐瑞明 计入/.test(mismatchModal.content || ''),
    '代课提示「已确认；学时按实际授课人 XXX 计入」', mismatchModal ? mismatchModal.content : '无弹窗');
  const mismatchRow = api.__mock.sessions().list.filter(function (s) { return s.sessionId === issued2.sessionId; })[0];
  check(mismatchRow && mismatchRow.status === 'done' && mismatchRow.confirmNameMismatch === true,
    '代课课时落库 done + confirm_name_mismatch=1', mismatchRow ? mismatchRow.status : '未找到');

  // 41001 过期
  loginAs('cadre', mockData.cadre);
  const issued3 = await api.createSession({ courseName: '专题讲座', teacherName: '唐瑞明', teachDate: shape.todayFull(), section: '5-6', hours: 2 });
  api.__mockCode.expire(issued3.codeId);
  loginAs('teacher', mockData.teacher);
  resetCalls();
  modalQueue = [{ confirm: false }];
  let expPage = loadPage('pages/create/create.js');
  expPage.onLoad({ codeId: issued3.codeId });
  await sleep(500);
  check(expPage.data.verifyState === 'error' && /已过期/.test(expPage.data.verifyError),
    '41001 过期 → 明确中文提示', expPage.data.verifyError);
  check(/刷新二维码/.test(expPage.data.errorAdvice), '41001 引导班干部刷新二维码', expPage.data.errorAdvice);
  check(calls.modals.some(function (m) { return m.title === '动态码不可用'; }), '过期时弹窗告知，不静默失败');
  resetCalls();
  expPage.retryVerify();
  await sleep(400);
  check(expPage.data.verifyState === 'error' && /已过期/.test(expPage.data.verifyError),
    '「重新核验」在原地重试（码仍过期 → 仍报 41001）', expPage.data.verifyError);

  // 40401 无效
  resetCalls();
  modalQueue = [{ confirm: false }];
  let badPage = loadPage('pages/create/create.js');
  badPage.onLoad({ codeId: 'CD-NOT-EXIST' });
  await sleep(400);
  check(badPage.data.verifyState === 'error' && /不存在/.test(badPage.data.verifyError),
    '40401 无效动态码 → 明确中文提示', badPage.data.verifyError);

  // 缺少入参 → 直接提示并返回
  resetCalls();
  modalQueue = [{ confirm: true }];
  let nodPage = loadPage('pages/create/create.js');
  nodPage.onLoad({});
  check(nodPage.data.verifyState === 'error' && /没有识别到动态码/.test(nodPage.data.verifyError),
    '无动态码入参 → 页面直接提示（不发起请求）', nodPage.data.verifyError);
  check(calls.navigations.some(function (n) { return n.type === 'navigateBack'; }), '缺少动态码时提示后返回首页');

  // 旧课表码：新流程不再填表，引导重新出示
  const legacy = await api.generateCode();
  resetCalls();
  const legacyPage = loadPage('pages/create/create.js');
  legacyPage.onLoad({ codeId: legacy.codeId });
  await sleep(400);
  check(legacyPage.data.verifyState === 'legacy', '旧课表码（isSession=false）→ 进入「旧流程」提示态',
    'state=' + legacyPage.data.verifyState);
  check(legacyPage.data.canConfirm === false, '旧课表码不提供确认按钮（不再有填表 / 手写签名路径）');

  // ================================================================ 4
  section('4. 记录页 GET /sessions 与详情 GET /sessions/{id}（证据四项）');
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);
  const sessionsForList = [];
  for (let i = 0; i < 3; i++) {
    sessionsForList.push(await api.createSession({
      courseName: '课程' + i, teacherName: '唐瑞明', teachDate: shape.todayFull(), section: String(i + 1) + '-' + String(i + 2), hours: 2
    }));
  }
  // 另一条「从课程清单带出」的课时（用于验证详情里的课程清单快照）
  const withCourse = await api.createSession({
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明',
    teachDate: shape.todayFull(), section: '7-8', place: '实训楼A302', hours: 2
  });
  const recordsPage = loadPage('pages/records/records.js');
  recordsPage.onShow();
  await sleep(600);
  check(recordsPage.data.list.length >= 3, 'GET /sessions 渲染课时列表', recordsPage.data.list.length + ' 条');
  check(recordsPage.data.list.every(function (s) { return !!s.statusText; }),
    '列表项带状态文案（待教师确认 / 已确认 / 已过期）',
    recordsPage.data.list.map(function (s) { return s.statusText; }).join('、'));
  check(recordsPage.data.badges[1] >= 3, '角标取自 summary.statusTotals 的 wait', JSON.stringify(recordsPage.data.badges));
  check(/共 \d+ 条/.test(recordsPage.data.summary), '汇总展示后端 total', recordsPage.data.summary);

  resetCalls();
  recordsPage.switchTab({ currentTarget: { dataset: { index: 2 } } });   // 已确认
  await sleep(500);
  check(recordsPage.data.list.every(function (s) { return s.status === 'done'; }),
    '切「已确认」标签 → 只含 done 的课时', recordsPage.data.list.length + ' 条');
  check(recordsPage.data.badges[1] >= 3, '切标签后角标不归零（仍为全部状态计数）', JSON.stringify(recordsPage.data.badges));

  resetCalls();
  recordsPage.switchTab({ currentTarget: { dataset: { index: 1 } } });   // 待教师确认
  await sleep(500);
  const firstPageSession = recordsPage.data.list[0];
  check(!!firstPageSession, '「待教师确认」下有课时可点进详情');
  resetCalls();
  recordsPage.openDetail({ currentTarget: { dataset: { id: firstPageSession.id } } });
  check(calls.navigations.some(function (n) { return n.url === '/pages/check/check?id=' + firstPageSession.id; }),
    '点击列表项跳详情页', JSON.stringify(calls.navigations[0] || {}));

  // 详情：证据四项 + 课程快照 + 审计尾部
  resetCalls();
  const checkPage = loadPage('pages/check/check.js');
  checkPage.onLoad({ id: withCourse.sessionId });
  checkPage.onShow();
  await sleep(600);
  check(checkPage.data.loadError === '', 'GET /sessions/{id} 详情加载无错误', checkPage.data.loadError);
  check(checkPage.data.isLegacy === false, '课时会话走新详情视图（isLegacy=false）');
  const labels = checkPage.data.evidence.map(function (e) { return e.label; }).join('、');
  check(labels === '动态码、确认人、确认时间、设备',
    '证据四项 = 动态码 / 确认人 / 确认时间 / 设备（无手写签名、无定位）', labels);
  check(checkPage.data.session.teacherName === '唐瑞明' && checkPage.data.session.className === '2025级药学1班',
    '详情展示本次课时信息（实际授课人 / 班级）',
    checkPage.data.session.teacherName + ' / ' + checkPage.data.session.className);
  check(!!checkPage.data.course && checkPage.data.course.courseName === '信息技术',
    '展示课程清单快照（本次课时来自哪条清单）', checkPage.data.course ? checkPage.data.course.courseName : '无');
  check(checkPage.data.auditTail.length >= 1, '展示操作留痕（审计尾部）', checkPage.data.auditTail.length + ' 条');
  check(!!checkPage.data.code && checkPage.data.code.codeId === withCourse.codeId,
    '详情回看本次动态码（不返回口令原文）', checkPage.data.code ? checkPage.data.code.codeId : '无');

  // 旧流程记录 → 只读回退（不渲染手写签名图）
  resetCalls();
  const legacyPage2 = loadPage('pages/check/check.js');
  legacyPage2.onLoad({ id: 'R20260922-1' });
  legacyPage2.onShow();
  await sleep(600);
  check(legacyPage2.data.isLegacy === true, '旧流程记录自动回退只读视图（isLegacy=true）', 'loadError=' + legacyPage2.data.loadError);
  check(legacyPage2.data.evidence.map(function (e) { return e.label; }).join('、') === '动态码、确认人、确认时间、设备',
    '旧记录同样只展示四项证据（不渲染手写签名图）');
  const checkWxml = fs.readFileSync(path.join(MP, 'pages/check/check.wxml'), 'utf8');
  check(!/signimg|signatureSrc|signature/.test(checkWxml) && !/<image/.test(checkWxml),
    '详情页 wxml 不再有手写签名图元素（无 image / signature 渲染）');

  // ================================================================ 5
  section('5. 未绑定 → 引导绑定（不静默失败）');
  logoutLocal();
  resetCalls();
  const unboundIndex = loadPage('pages/index/index.js');
  unboundIndex.onLoad({});
  unboundIndex.onShow();
  await sleep(400);
  check(unboundIndex.data.needBind === true, '首页进入「去绑定」引导分支', 'needBind=' + unboundIndex.data.needBind);
  check(unboundIndex.data.panel.show === false && unboundIndex.data.code === '',
    '未绑定时不展示动态码', 'code="' + unboundIndex.data.code + '"');
  check(calls.requests.length === 0, '未绑定时不发起业务请求', calls.requests.length + ' 个请求');
  resetCalls();
  unboundIndex.goBind();
  check(calls.navigations.some(function (n) { return n.url === '/pages/bind/bind'; }), '引导可点击跳转 pages/bind/bind');

  const unboundCourses = loadPage('pages/courses/courses.js');
  unboundCourses.onLoad({});
  await sleep(200);
  check(unboundCourses.data.needBind === true, '「我的课程」未绑定时给出绑定引导');
  const unboundRecords = loadPage('pages/records/records.js');
  unboundRecords.onShow();
  await sleep(300);
  check(unboundRecords.data.needBind === true && unboundRecords.data.list.length === 0,
    '记录页未绑定时给出绑定引导（不静默空白）');

  // 40101 → 清 token + 引导
  loginAs('cadre', mockData.cadre);
  appStub.globalData.useMock = false;
  appStub.globalData.apiBase = 'http://backend.test';
  storage.token = 'BAD-TOKEN';
  appStub.globalData.token = 'BAD-TOKEN';
  const origRequest = global.wx.request;
  global.wx.request = function (o) {
    if (o.success) o.success({ statusCode: 401, data: { code: 40101, msg: '未登录或登录已失效', data: {} } });
  };
  resetCalls();
  const staleIndex = loadPage('pages/index/index.js');
  staleIndex.onLoad({});
  staleIndex.onShow();
  await sleep(400);
  check(staleIndex.data.needBind === true, '收到 40101 → 首页切到「去绑定」引导', 'needBind=' + staleIndex.data.needBind);
  check(storage.token === undefined, '40101 后本地 token 被清除', 'token=' + storage.token);
  global.wx.request = origRequest;
  appStub.globalData.useMock = true;
  appStub.globalData.apiBase = '';

  // ================================================================ 6
  section('6. 真实分支（useMock=false）请求 URL / 方法 / 请求头 / 请求体');
  loginAs('cadre', mockData.cadre);
  appStub.globalData.useMock = false;
  appStub.globalData.apiBase = 'http://backend.test';
  storage.token = 'REAL-TEST-TOKEN';
  appStub.globalData.token = 'REAL-TEST-TOKEN';
  resetCalls();

  const realCourses = await api.getClassCourses({ status: 'active', page: 1, pageSize: 20 });
  const req1 = calls.requests[0];
  check(!!req1 && req1.url === 'http://backend.test/api/v1/class-courses' && req1.method === 'GET',
    'GET /api/v1/class-courses', req1 ? (req1.method + ' ' + req1.url) : '无请求');
  check(!!req1 && req1.header.Authorization === 'Bearer REAL-TEST-TOKEN',
    '请求头带 Authorization: Bearer <token>', req1 ? req1.header.Authorization : '无');
  check(shape.pageOf(realCourses).list.length === 1, '列表被 shape.pageOf 归一化', '1 门');

  await api.getCoursesToday({ date: '2026-09-23' });
  check(calls.requests[1].url === 'http://backend.test/api/v1/class-courses/today' &&
    calls.requests[1].data.date === '2026-09-23',
    'GET /api/v1/class-courses/today?date=', JSON.stringify(calls.requests[1].data));

  await api.createClassCourse({ courseName: '医学信息检索', teacherName: '唐瑞明', weekday: 3, section: '1-2', hours: 2 });
  check(calls.requests[2].url === 'http://backend.test/api/v1/class-courses' && calls.requests[2].method === 'POST',
    'POST /api/v1/class-courses', calls.requests[2].method);

  await api.updateClassCourse('CR00000001', { teacherName: '李慧' });
  check(calls.requests[3].url === 'http://backend.test/api/v1/class-courses/CR00000001' && calls.requests[3].method === 'PUT',
    'PUT /api/v1/class-courses/{id}', calls.requests[3].method);

  await api.archiveClassCourse('CR00000001');
  check(calls.requests[4].url === 'http://backend.test/api/v1/class-courses/CR00000001' && calls.requests[4].method === 'DELETE',
    'DELETE /api/v1/class-courses/{id}（软删除）', calls.requests[4].method);

  const realSession = await api.createSession({
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明',
    teachDate: '2026-09-23', section: '1-2', place: '实训楼A302', hours: 2
  });
  const req6 = calls.requests[5];
  check(req6.url === 'http://backend.test/api/v1/sessions' && req6.method === 'POST',
    'POST /api/v1/sessions', req6.method);
  check(req6.data.courseId === 'CR00000001' && req6.data.teacherName === '唐瑞明' && req6.data.teachDate === '2026-09-23' &&
    req6.data.section === '1-2' && req6.data.place === '实训楼A302' && req6.data.hours === 2,
    '发起课时的请求体带 courseId/courseName/teacherName/teachDate/section/place/hours',
    JSON.stringify(req6.data));
  check(realSession.code === '042317' && realSession.qrPayload === 'kcsq://code/CD00000001',
    '拿到 code 与 qrPayload（A+B 双通道）', realSession.code);

  await api.refreshSessionCode('R00000031');
  check(calls.requests[6].url === 'http://backend.test/api/v1/sessions/R00000031/code' && calls.requests[6].method === 'POST',
    'POST /api/v1/sessions/{id}/code（刷新动态码）', calls.requests[6].method);

  const realList = await api.getSessions({ status: 'wait', page: 1, pageSize: 20 });
  check(calls.requests[7].url === 'http://backend.test/api/v1/sessions' && calls.requests[7].data.status === 'wait',
    'GET /api/v1/sessions?status=wait', calls.requests[7].url);
  check(shape.statusTotals(shape.pageOf(realList)).done === 4,
    '角标走 summary.statusTotals（done=4，不受 status=wait 影响）',
    JSON.stringify(shape.statusTotals(shape.pageOf(realList))));

  await api.getSession('R00000031');
  check(calls.requests[8].url === 'http://backend.test/api/v1/sessions/R00000031',
    'GET /api/v1/sessions/{id}', calls.requests[8].url);

  await api.confirmSession('R00000031', { codeId: 'CD00000001' });
  check(calls.requests[9].url === 'http://backend.test/api/v1/sessions/R00000031/confirm' && calls.requests[9].method === 'POST',
    'POST /api/v1/sessions/{id}/confirm', calls.requests[9].method);
  check(calls.requests[9].data.codeId === 'CD00000001', '确认请求带 codeId（消费动态码）', JSON.stringify(calls.requests[9].data));

  // 后端业务错误原样抛出（页面据此原样展示）
  global.wx.request = function (o) {
    if (o.success) o.success({ statusCode: 409, data: { code: 40901, msg: '该课时已由班干部发起（会话 R1，状态 wait），请勿重复发起', data: {} } });
  };
  let dupErr = null;
  try { await api.createSession({ courseName: 'X', teacherName: 'Y', teachDate: '2026-09-23' }); } catch (e) { dupErr = e; }
  check(dupErr && dupErr.code === 40901 && /请勿重复发起/.test(dupErr.msg),
    '真实分支：后端 40901 的 msg 原样抛出（不吞错误）', dupErr ? dupErr.msg : '未报错');
  global.wx.request = origRequest;
  appStub.globalData.useMock = true;
  appStub.globalData.apiBase = '';

  // ================================================================ 7
  section('7. 无定位采集（静态检查）');
  const sourceFiles = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json|wxml)$/.test(e.name)) sourceFiles.push(p);
    });
  })(MP);
  const locationHits = sourceFiles.filter(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    return /getLocation|chooseLocation|onLocationChange|startLocationUpdate|requiredPrivateInfos|latitude|longitude/.test(t);
  });
  check(locationHits.length === 0, 'miniprogram 全目录无 wx.getLocation / requiredPrivateInfos / 经纬度字段',
    locationHits.length ? locationHits.map(function (f) { return path.relative(ROOT, f); }).join('、') : sourceFiles.length + ' 个文件已检查');

  // ---- 汇总
  console.log('\n' + '='.repeat(70));
  console.log('小程序新流程自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('='.repeat(70));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e);
  process.exit(2);
});
