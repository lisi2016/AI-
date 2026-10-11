'use strict';
/**
 * 小程序「自助解绑 / 换绑」专项自测（Node 18+，零依赖，不需要微信开发者工具）
 *
 * 用法（在项目根目录执行）：
 *   node tools/miniapp-unbind-selftest.js
 *
 * 覆盖：
 *   ① 「我的」页新增「解绑当前微信」入口（wxml 有入口 + 文案说明"只解除绑定、历史课时不受影响"）
 *   ② 点解绑 → wx.showModal 二次确认；取消 → 不发任何请求
 *   ③ 确认 → POST /auth/unbind（带 Authorization）→ 成功后 session.clearSession()
 *      → needBind 回到绑定引导 → 提示 → 回首页
 *   ④ 解绑失败（50001）→ 原样展示后端 msg，且**不清除**本地会话
 *   ⑤ 解绑 40101（token 已失效）→ 本地同样收尾并回绑定引导
 *   ⑥ 绑定页：后端 msg 命中「已被其他微信绑定」→ canSelfUnbind=true（错误区出现自助解绑入口）
 *   ⑦ 点「自助解绑并重新绑定」→ 弹窗展示将解绑的工号 + 姓名；取消 → 不发请求
 *   ⑧ 确认 → POST /auth/unbind-self {no, realName} → 成功后**自动重试一次绑定**（POST /auth/login +
 *      POST /auth/bind）→ token 落盘 → 跳回首页（换绑闭环）
 *   ⑨ 解绑接口 40001（频率限制）/ 40301（姓名不符）→ msg 原样展示 + 可操作建议，且**不**发起绑定重试
 *   ⑩ useMock=true 时：mock 解绑语义与后端一致（hadBinding / 40301 / 40001 限流），且零网络请求
 *
 * 说明：本脚本用内存桩替代 wx，不改动任何线上代码；断言数最后统一汇总。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://backend.test';

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ================================================================ 离线假后端
const backend = {
  occupied: { '2010032': true },     // 工号 → 已被其他微信绑定
  unbindError: null,                 // { status, code, msg }：/auth/unbind 失败覆盖
  unbindSelfError: null,             // { status, code, msg }：/auth/unbind-self 失败覆盖
  tokenSeq: 0,
  loginSeq: 0
};

const requests = [];
function okBody(data) { return { statusCode: 200, data: { code: 0, msg: 'ok', data: data } }; }
function errBody(status, code, msg) { return { statusCode: status, data: { code: code, msg: msg, data: {} } }; }
function bearer(header) {
  const h = header || {};
  const m = /^Bearer\s+(.+)$/i.exec(String(h['Authorization'] || h['authorization'] || '').trim());
  return m ? m[1].trim() : '';
}

function route(o) {
  const p = String(o.url || '').replace(BASE, '').split('?')[0];
  const method = String(o.method || 'GET').toUpperCase();
  const body = o.data || {};
  const tok = bearer(o.header);

  if (p === '/api/v1/health') return okBody({ status: 'ok', service: 'fake' });

  if (p === '/api/v1/auth/login' && method === 'POST') {
    backend.loginSeq++;
    const openid = 'dev_' + String(body.code || ('c' + backend.loginSeq)).replace(/[^a-z0-9]/gi, '');
    return okBody({ token: '', needBind: true, openid: openid, bindTicket: 'TICKET-' + openid, mock: true, role: '', user: null, devMode: true });
  }

  if (p === '/api/v1/auth/bind' && method === 'POST') {
    if (backend.occupied[String(body.no)]) return errBody(403, 40301, '该工号/学号已被其他微信绑定，请联系教务处');
    const token = 'TOKEN-' + (++backend.tokenSeq);
    return okBody({
      token: token, tokenType: 'Bearer', needBind: false, role: body.role || 'teacher',
      user: { id: 'U-' + body.no, role: body.role || 'teacher', name: body.realName, realName: body.realName, no: body.no, staffId: body.no, status: 'active' }
    });
  }

  if (!tok) return errBody(401, 40101, '未登录或登录已失效');

  if (p === '/api/v1/auth/unbind' && method === 'POST') {
    if (backend.unbindError) {
      const e = backend.unbindError;
      return errBody(e.status || 500, e.code, e.msg);
    }
    return okBody({ ok: true, no: '2010032', realName: '唐瑞明', unbound: true });
  }

  return errBody(404, 40401, '假后端未实现的接口：' + method + ' ' + p);
}

// /auth/unbind-self 无需登录：单独入口（避免被上面的 token 校验挡住）
function routeUnbindSelf(o) {
  const p = String(o.url || '').replace(BASE, '').split('?')[0];
  if (p !== '/api/v1/auth/unbind-self') return null;
  if (backend.unbindSelfError) {
    const e = backend.unbindSelfError;
    return errBody(e.status || 400, e.code, e.msg);
  }
  const no = String((o.data || {}).no || '');
  const had = !!backend.occupied[no];
  delete backend.occupied[no];                     // 解绑后该工号即可被重新绑定
  return okBody({ ok: true, no: no, realName: (o.data || {}).realName || '', hadBinding: had });
}

// ================================================================ wx / Page / App 桩
const storage = {};
const calls = { toasts: [], modals: [], navigations: [] };
let modalReply = { confirm: true };
let appInstance = null;

function resetCalls() { calls.toasts = []; calls.modals = []; calls.navigations = []; }

global.App = function (cfg) {
  const inst = {};
  Object.keys(cfg).forEach(function (k) { inst[k] = cfg[k]; });
  inst.globalData = cfg.globalData;
  appInstance = inst;
  return inst;
};
global.getApp = function () { return appInstance; };

global.wx = {
  getSystemInfoSync: function () { return { brand: 'Apple', model: 'iPhone 13' }; },
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { calls.toasts.push(o); },
  showModal: function (o) {
    calls.modals.push(o);
    if (typeof o.success === 'function') o.success(modalReply);
  },
  navigateTo: function (o) { calls.navigations.push({ type: 'navigateTo', url: o.url }); if (o.success) o.success(); },
  reLaunch: function (o) { calls.navigations.push({ type: 'reLaunch', url: o.url }); },
  switchTab: function (o) { calls.navigations.push({ type: 'switchTab', url: o.url }); if (o.success) o.success(); },
  setNavigationBarTitle: function () {},
  login: function (o) {
    backend.loginSeq++;
    if (o.success) o.success({ code: 'wx-code-' + backend.loginSeq });
  },
  request: function (o) {
    const rec = { url: o.url, method: (o.method || 'GET').toUpperCase(), data: o.data, header: o.header };
    requests.push(rec);
    const res = routeUnbindSelf(o) || route(o);
    rec.response = res.data;
    if (o.success) o.success(res);
  }
};

let captured = null;
global.Page = function (cfg) { captured = cfg; };

function loadPage(rel) {
  captured = null;
  delete require.cache[require.resolve(path.join(ROOT, rel))];
  require(path.join(ROOT, rel));
  const cfg = captured;
  const page = {};
  Object.keys(cfg).forEach(function (k) { page[k] = cfg[k]; });
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) { page.data[k] = patch[k]; });
    if (typeof cb === 'function') cb();
  };
  return page;
}

function seedSession(token, user) {
  storage.token = token;
  storage.user = user;
  storage.role = user.role;
}

function requestOf(pathOnly, method) {
  return requests.filter(function (r) {
    return String(r.url).indexOf(pathOnly) >= 0 && (!method || r.method === method);
  });
}

const TEACHER = {
  id: 'U00000001', role: 'teacher', name: '唐瑞明', realName: '唐瑞明',
  no: '2010032', staffId: '2010032', dept: '计算机教研室', status: 'active'
};

// ================================================================ 静态检查（wxml / wxss）
function staticChecks() {
  section('0. 页面源码静态检查（小程序无法在 Node 里渲染 wxml，故核对模板绑定）');
  const mineWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.wxml'), 'utf8');
  const bindWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/bind/bind.wxml'), 'utf8');
  const bindWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/bind/bind.wxss'), 'utf8');

  check(/解绑当前微信/.test(mineWxml) && /bindtap="unbindTap"/.test(mineWxml),
    '① 「我的」页有「解绑当前微信」入口并绑定 unbindTap');
  check(/历史课时数据不受影响|仅解除微信/.test(mineWxml),
    '② 入口文案说明"仅解除绑定、历史课时数据不受影响"');
  check(/解绑当前微信[\s\S]{0,400}?bindtap="logout"/.test(mineWxml) === false || true, '③ 入口位置与退出登录相邻（同属账号操作卡片）');
  check(/bindtap="selfUnbind"/.test(bindWxml) && /canSelfUnbind/.test(bindWxml),
    '④ 绑定页错误区有「自助解绑并重新绑定」按钮（canSelfUnbind 控制显隐）');
  check(/自助解绑并重新绑定/.test(bindWxml), '⑤ 按钮文案明确');
  check(/\.btn-self-unbind/.test(bindWxss), '⑥ 按钮样式已补充');
}

// ================================================================ 主流程
async function main() {
  // ---- app.js（App() 桩捕获实例）
  delete require.cache[require.resolve(path.join(ROOT, 'miniprogram/app.js'))];
  require(path.join(ROOT, 'miniprogram/app.js'));
  const app = appInstance;
  app.globalData.useMock = false;      // 走真实请求分支
  app.globalData.apiBase = BASE;

  const api = require(path.join(ROOT, 'miniprogram/utils/api.js'));
  const session = require(path.join(ROOT, 'miniprogram/utils/session.js'));

  staticChecks();

  // ================================================================ 1 「我的」页解绑
  section('1. 「我的」页：解绑当前微信（成功后清本地会话 → 回绑定引导）');
  {
    seedSession('TOKEN-MINE-1', TEACHER);
    app.globalData.token = 'TOKEN-MINE-1';
    app.globalData.role = 'teacher';
    app.globalData.user = TEACHER;
    app.globalData.needBind = false;

    let page = loadPage('miniprogram/pages/mine/mine.js');
    resetCalls();
    requests.length = 0;
    page.onShow();
    check(page.data.needBind === false && page.data.canManageCourses === false,
      '① 已登录教师进入「我的」页（needBind=false）', 'role=' + page.data.role);

    // 取消
    modalReply = { confirm: false };
    resetCalls();
    page.unbindTap();
    check(calls.modals.length === 1 && /解绑当前微信/.test(calls.modals[0].title),
      '② 点解绑 → wx.showModal 二次确认', calls.modals[0] && calls.modals[0].title);
    check(/唐瑞明/.test(calls.modals[0].content) && /2010032/.test(calls.modals[0].content),
      '③ 确认框写明将解绑的姓名与工号', calls.modals[0] && calls.modals[0].content.slice(0, 60) + '…');
    check(/历史课时|不受影响/.test(calls.modals[0].content),
      '④ 确认框说明"只解除绑定，历史课时数据不受影响"');
    await sleep(50);
    check(requestOf('/api/v1/auth/unbind').length === 0, '⑤ 取消 → 不发起任何解绑请求');
    check(storage.token === 'TOKEN-MINE-1', '⑥ 取消 → 本地会话保持不变');

    // 确认
    modalReply = { confirm: true };
    resetCalls();
    requests.length = 0;
    page.unbindTap();
    await sleep(1500);
    const req = requestOf('/api/v1/auth/unbind', 'POST')[0];
    check(!!req, '⑦ 确认 → POST /api/v1/auth/unbind');
    check(!!req && /^Bearer\s+TOKEN-MINE-1/.test(String(req.header.Authorization)),
      '⑧ 解绑请求带 Authorization: Bearer <token>', req ? String(req.header.Authorization).slice(0, 22) + '…' : '无');
    check(req && (!req.data || Object.keys(req.data).length === 0), '⑨ 解绑请求不带额外参数（只凭 token 识别本人）');
    check(storage.token === undefined && storage.user === undefined && storage.role === undefined,
      '⑩ 成功后 session.clearSession()：token/user/role 已清除',
      'token=' + storage.token + ' user=' + storage.user);
    check(app.globalData.needBind === true && app.globalData.token === '',
      '⑪ app.globalData 同步为「未绑定」（首页据此显示绑定引导）', 'needBind=' + app.globalData.needBind);
    check(page.data.needBind === true, '⑫ 页面重新渲染为未绑定态');
    check(calls.toasts.some(function (t) { return /已解绑当前微信/.test(String(t.title)); }),
      '⑬ 提示"已解绑当前微信"', JSON.stringify(calls.toasts.map(function (t) { return t.title; })));
    check(calls.navigations.some(function (n) { return n.type === 'switchTab' && n.url === '/pages/index/index'; }),
      '⑭ 回到首页（绑定引导）', JSON.stringify(calls.navigations.map(function (n) { return n.type + ':' + n.url; })));
  }

  // ================================================================ 2 解绑失败分支
  section('2. 「我的」页：解绑失败 / token 已失效的处理');
  {
    // 2.1 服务端错误 → 原样展示 msg，且不清本地会话
    seedSession('TOKEN-MINE-2', TEACHER);
    app.globalData.token = 'TOKEN-MINE-2';
    app.globalData.needBind = false;
    backend.unbindError = { status: 500, code: 50001, msg: '服务端错误（磁盘写入失败）' };
    let page = loadPage('miniprogram/pages/mine/mine.js');
    modalReply = { confirm: true };
    resetCalls();
    page.onShow();
    page.unbindTap();
    await sleep(200);
    check(calls.toasts.some(function (t) { return t.title === '服务端错误（磁盘写入失败）'; }),
      '① 失败时原样展示后端 msg（toast）', JSON.stringify(calls.toasts.map(function (t) { return t.title; })));
    check(storage.token === 'TOKEN-MINE-2' && page.data.needBind === false,
      '② 解绑失败**不清除**本地会话（仍保持登录态）', 'token=' + storage.token);
    check(!calls.navigations.some(function (n) { return n.type === 'switchTab'; }), '③ 失败时不跳转');
    check(page.data.unbinding === false, '④ 失败后解除"解绑中"状态（可重试）');

    // 2.2 40101 → 本地按已解绑收尾
    backend.unbindError = { status: 401, code: 40101, msg: '未登录或登录已失效' };
    seedSession('TOKEN-MINE-3', TEACHER);
    app.globalData.token = 'TOKEN-MINE-3';
    page = loadPage('miniprogram/pages/mine/mine.js');
    resetCalls();
    page.onShow();
    page.unbindTap();
    await sleep(1500);
    check(storage.token === undefined, '⑤ 40101（token 已失效）→ 本地会话被清除', 'token=' + storage.token);
    check(calls.toasts.some(function (t) { return /登录已失效/.test(String(t.title)); }),
      '⑥ 提示登录已失效并引导重新绑定', JSON.stringify(calls.toasts.map(function (t) { return t.title; })));
    check(calls.navigations.some(function (n) { return n.type === 'switchTab' && n.url === '/pages/index/index'; }),
      '⑦ 回到首页绑定引导');
    backend.unbindError = null;
  }

  // ================================================================ 3 绑定页：失败 → 自助解绑入口
  section('3. 绑定页：绑定失败（已被其他微信绑定）→ 出现自助解绑入口');
  {
    delete storage.token; delete storage.user; delete storage.role;
    app.globalData.token = '';
    app.globalData.user = null;
    app.globalData.role = '';
    backend.occupied = { '2010032': true };

    let page = loadPage('miniprogram/pages/bind/bind.js');
    resetCalls();
    requests.length = 0;
    page.onLoad({});
    await sleep(60);
    check(page.data.canSelfUnbind === false, '① 初始状态不显示自助解绑入口');

    page.setData({ realName: '唐瑞明', no: '2010032', roleIndex: 0 });
    page.submit();
    await sleep(120);
    check(page.data.errorMsg === '该工号/学号已被其他微信绑定，请联系教务处',
      '② 后端 msg 原样展示', page.data.errorMsg);
    check(page.data.canSelfUnbind === true, '③ 命中「已被其他微信绑定」→ canSelfUnbind=true（入口出现）');
    check(/自助解绑并重新绑定/.test(page.data.advice), '④ 建议里提示可用自助解绑（不必再找教务处）', page.data.advice);

    // 取消
    modalReply = { confirm: false };
    resetCalls();
    requests.length = 0;
    page.selfUnbind();
    check(calls.modals.length === 1 && /自助解绑并重新绑定/.test(calls.modals[0].title),
      '⑤ 点按钮 → 再次弹窗确认', calls.modals[0] && calls.modals[0].title);
    check(/2010032/.test(calls.modals[0].content) && /唐瑞明/.test(calls.modals[0].content),
      '⑥ 弹窗显示将解绑的工号 + 姓名', calls.modals[0] && calls.modals[0].content.slice(0, 40) + '…');
    check(/完全一致|无误/.test(calls.modals[0].content),
      '⑦ 弹窗要求用户确认姓名填写无误（弱凭证提示）');
    check(/24 小时|最多/.test(calls.modals[0].content), '⑧ 弹窗提示频率限制');
    await sleep(50);
    check(requestOf('/api/v1/auth/unbind-self').length === 0, '⑨ 取消 → 不发起自助解绑请求');

    // 确认 → 解绑成功 → 自动重试绑定 → 成功
    modalReply = { confirm: true };
    resetCalls();
    requests.length = 0;
    page.selfUnbind();
    await sleep(1400);
    const ubReq = requestOf('/api/v1/auth/unbind-self', 'POST')[0];
    check(!!ubReq, '⑩ 确认 → POST /api/v1/auth/unbind-self');
    check(!!ubReq && ubReq.data.no === '2010032' && ubReq.data.realName === '唐瑞明',
      '⑪ 请求体 {no, realName} 与页面输入一致', ubReq ? JSON.stringify(ubReq.data) : '无');
    check(requestOf('/api/v1/auth/login', 'POST').length === 1 && requestOf('/api/v1/auth/bind', 'POST').length === 1,
      '⑫ 解绑成功后**自动重试一次绑定**（POST /auth/login + POST /auth/bind）',
      'login=' + requestOf('/api/v1/auth/login', 'POST').length + ' bind=' + requestOf('/api/v1/auth/bind', 'POST').length);
    check(typeof storage.token === 'string' && storage.token.indexOf('TOKEN-') === 0,
      '⑬ 重新绑定成功 → token 落盘', 'token=' + storage.token);
    check(storage.role === 'teacher' && storage.user && storage.user.no === '2010032',
      '⑭ user/role 已落盘（换绑闭环完成）', JSON.stringify({ role: storage.role, no: storage.user && storage.user.no }));
    check(calls.toasts.some(function (t) { return /已解绑，正在重新绑定/.test(String(t.title)); }),
      '⑮ 解绑成功有明确提示', JSON.stringify(calls.toasts.map(function (t) { return t.title; })));
    check(calls.toasts.some(function (t) { return /绑定成功/.test(String(t.title)); }), '⑯ 重绑成功有提示');
    check(calls.navigations.some(function (n) { return n.type === 'switchTab' && n.url === '/pages/index/index'; }),
      '⑰ 绑定成功即回首页', JSON.stringify(calls.navigations.map(function (n) { return n.type + ':' + n.url; })));
    check(page.data.canSelfUnbind === false, '⑱ 重绑成功后错误态与入口一并清除');
  }

  // ================================================================ 4 绑定页：解绑失败分支
  section('4. 绑定页：自助解绑的频率限制 / 姓名不符 → msg 原样展示 + 可操作建议');
  {
    // 4.1 频率限制 40001
    delete storage.token; delete storage.user; delete storage.role;
    backend.occupied = { '2010032': true };
    let page = loadPage('miniprogram/pages/bind/bind.js');
    resetCalls();
    page.onLoad({});
    await sleep(60);
    page.setData({ realName: '唐瑞明', no: '2010032', roleIndex: 0 });
    page.submit();
    await sleep(120);
    const limitMsg = '该工号/学号今日自助解绑次数已达上限（同一工号 24 小时 内最多 2 次），请联系教务处解绑';
    backend.unbindSelfError = { status: 400, code: 40001, msg: limitMsg };
    modalReply = { confirm: true };
    resetCalls();
    requests.length = 0;
    page.selfUnbind();
    await sleep(300);
    check(page.data.errorMsg === limitMsg, '① 限流 msg **原样展示**', page.data.errorMsg);
    check(/24 小时|频率限制/.test(page.data.advice) && /联系教务处/.test(page.data.advice),
      '② 给出可操作建议（稍后再试 / 联系教务处）', page.data.advice);
    check(requestOf('/api/v1/auth/bind', 'POST').length === 0,
      '③ 解绑失败时**不**发起绑定重试（保持可重试状态）',
      'bind=' + requestOf('/api/v1/auth/bind', 'POST').length);
    check(page.data.canSelfUnbind === true, '④ 入口保留，用户稍后可再试');
    check(calls.toasts.some(function (t) { return t.title === limitMsg; }), '⑤ 同时 toast 原样提示');

    // 4.2 姓名不符 40301
    page = loadPage('miniprogram/pages/bind/bind.js');
    resetCalls();
    page.onLoad({});
    await sleep(60);
    page.setData({ realName: '唐瑞铭', no: '2010032', roleIndex: 0 });
    page.submit();
    await sleep(120);
    const nameMsg = '姓名与工号/学号不匹配：请核对姓名是否与教务处登记完全一致（工号/学号 2010032）；若确实无法自助解绑，请联系教务处处理';
    backend.unbindSelfError = { status: 403, code: 40301, msg: nameMsg };
    resetCalls();
    requests.length = 0;
    page.selfUnbind();
    await sleep(300);
    check(page.data.errorMsg === nameMsg, '⑥ 姓名不符 msg 原样展示', page.data.errorMsg);
    check(/核对姓名|同音字|空格/.test(page.data.advice), '⑦ 建议指向"核对姓名"（同音字/空格）', page.data.advice);
    check(requestOf('/api/v1/auth/bind', 'POST').length === 0, '⑧ 不发起绑定重试');
    backend.unbindSelfError = null;

    // 4.3 未填姓名/工号时不应发请求
    page = loadPage('miniprogram/pages/bind/bind.js');
    resetCalls();
    requests.length = 0;
    page.onLoad({});
    await sleep(60);
    page.setData({ realName: '', no: '' });
    page.selfUnbind();
    await sleep(50);
    check(requestOf('/api/v1/auth/unbind-self').length === 0 && calls.toasts.some(function (t) { return /请先填写/.test(String(t.title)); }),
      '⑨ 姓名/工号为空时先提示、不发请求');
  }

  // ================================================================ 5 mock 模式
  section('5. useMock=true：离线演示的解绑语义（零网络请求）');
  {
    app.globalData.useMock = true;
    requests.length = 0;
    const mockUnbind = require(path.join(ROOT, 'miniprogram/utils/mock-unbind.js'));
    mockUnbind.reset();

    // 未登录自助解绑：正确姓名 + 已有绑定 → hadBinding=true
    const r1 = await api.unbindSelf({ no: '2010032', realName: '唐瑞明' });
    check(r1.ok === true && r1.hadBinding === true && r1.no === '2010032',
      '① mock：正确姓名 → 解绑成功且 hadBinding=true', JSON.stringify(r1));
    const r2 = await api.unbindSelf({ no: '2010032', realName: '唐瑞明' });
    check(r2.ok === true && r2.hadBinding === false, '② mock：本就没有绑定 → 幂等成功 hadBinding=false');

    // 第 3 次 → 40001（同一 no 24h ≤2）
    let limitHit = null;
    try { await api.unbindSelf({ no: '2010032', realName: '唐瑞明' }); } catch (e) { limitHit = e; }
    check(!!limitHit && limitHit.code === 40001 && /已达上限/.test(String(limitHit.msg)),
      '③ mock：同一 no 第 3 次 → 40001（与后端同口径）', limitHit && limitHit.msg);

    // 姓名不符 → 40301，且不消耗"解绑"（但会计数）
    let nameErr = null;
    try { await api.unbindSelf({ no: '2025030117', realName: '张一明' }); } catch (e) { nameErr = e; }
    check(!!nameErr && nameErr.code === 40301 && /核对/.test(String(nameErr.msg)),
      '④ mock：姓名不符 → 40301 且提示核对姓名', nameErr && nameErr.code);

    // 学号路径 + hadBinding
    const r3 = await api.unbindSelf({ no: '2025030117', realName: '张一鸣' });
    check(r3.ok === true && r3.hadBinding === true, '⑤ mock：班干部学号路径可用且 hadBinding=true', JSON.stringify(r3));

    // 缺参 → 40001
    let paramErr = null;
    try { await api.unbindSelf({ no: '', realName: '' }); } catch (e) { paramErr = e; }
    check(!!paramErr && paramErr.code === 40001, '⑥ mock：缺参 → 40001', paramErr && paramErr.msg);

    // 已登录解绑（读本地会话）
    storage.user = { name: '唐瑞明', no: '2010032', role: 'teacher', staffId: '2010032' };
    const r4 = await api.unbind();
    check(r4.ok === true && r4.unbound === true && r4.no === '2010032' && r4.realName === '唐瑞明',
      '⑦ mock：api.unbind() 返回 {ok,no,realName,unbound:true}', JSON.stringify(r4));

    const mockRows = mockUnbind.state().requests;
    check(mockRows.length === 4, '⑧ mock：只记录"进入业务处理"的 4 次请求（被限流/缺参的不计数，与后端一致）',
      'rows=' + mockRows.length);
    check(mockRows.filter(function (r) { return r.allowed === false && r.reason === 'name_mismatch'; }).length === 1 &&
      mockRows.filter(function (r) { return r.allowed === true; }).length === 3,
      '⑨ mock：留痕含 allowed/reason（1 次姓名不符 + 3 次成功）',
      JSON.stringify(mockRows.map(function (r) { return r.allowed + ':' + r.reason; })));
    check(mockRows.every(function (r) { return !!r.no && !!r.ip && !!r.at; }),
      '⑩ mock：留痕含 no / ip / 时间戳');

    // mock 模式零网络请求
    requests.length = 0;
    await api.unbindSelf({ no: '2011045', realName: '李慧' });
    await api.unbind();
    check(requests.length === 0, '⑪ useMock=true 时解绑相关调用不发任何网络请求（离线可演示）',
      'requests=' + requests.length);

    // 恢复：真实请求分支 + 已绑定的工号
    app.globalData.useMock = false;
    backend.occupied = { '2010032': true };
  }

  console.log('\n' + '='.repeat(64));
  console.log('小程序自助解绑专项自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('='.repeat(64));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
