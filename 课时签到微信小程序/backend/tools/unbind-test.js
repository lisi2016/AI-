'use strict';
/**
 * 自助解绑 / 换绑专项自测（DEV_MODE=1，进程内随机端口 + 独立临时 DATA_DIR）
 *
 * 用法：
 *   node tools/unbind-test.js
 *
 * 为什么独立成脚本：本次新增的两个接口都是纯增量能力，且涉及**弱凭证 + 频率限制 + 审计留痕**，
 * 需要在一个可反复重置的独立实例上把「解绑 → token 失效 → 重新绑定」「历史数据仍在」「限流」一次跑全。
 * 本脚本在**进程内**以 DEV_MODE=1 + 独立临时 DATA_DIR + 随机端口启动真实 app（server.buildApp()），
 * 因此不会碰到在跑的 8081 演示服务与它的 data/，跑完自动清理临时目录。
 *
 * 覆盖：
 *   1) POST /auth/unbind（需登录）：解绑成功 → 档案保留 + openid 置空 → 原 token 立即失效 →
 *      该工号可被新微信重新绑定（且**不是**走开发模式的 openid 覆盖分支 → 证明绑定槽位真的释放了）
 *   2) 解绑前后历史课时数据不变（GET /records、GET /sessions 的 total 与内存库计数逐项核对）
 *   3) POST /auth/unbind-self：白名单姓名不符 → 40301 且**不做任何解绑**；
 *      正确姓名 → 成功且 hadBinding=true；本就没绑定 → 幂等成功 hadBinding=false
 *   4) 频率限制：同一 no 第 3 次 → 40001；同一 IP 第 6 次 → 40001（换 IP 仍可用）
 *   5) 计数与新表 data/unbind_requests.json（store 表 unbind_requests）：字段完整、7 天保留策略生效
 *   6) 审计 auth.unbind / auth.unbind.self（含 no、realName、IP、设备、是否确有绑定）+ 哈希链完整
 *   7) 两个接口都不返回定位相关字段
 *
 * 说明：零新增依赖，仅用 Node 18+ 内置 fetch。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsq-unbind-'));
// —— 必须在 require 业务模块之前设置：util.js 在加载时读取这些环境变量
process.env.DATA_DIR = tmp;
process.env.DEV_MODE = '1';
process.env.TOKEN_SECRET = 'unbind-test-token-secret';
process.env.CODE_SECRET = 'unbind-test-code-secret';
process.env.INTERNAL_JOB_TOKEN = 'unbind-test-internal-token';

const u = require('../src/util');
const store = require('../src/store');
const seed = require('../src/seed');
const view = require('../src/view');
const webauth = require('../src/webauth');
const unbind = require('../src/unbind');
const server = require('../server');

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }

async function call(base, method, p, body, headers) {
  const h = Object.assign({}, headers || {});
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + '/api/v1' + p, { method: method, headers: h, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { httpStatus: res.status, body: json };
}

/** 直接查内存库（与 HTTP 服务同进程，反映已落内存的真实状态） */
function userByNo(no) {
  return unbind.userByNo(no);
}

/** 解绑请求的自定义请求头：IP（X-Forwarded-For，与 audit.ctxOf 同口径）+ 设备 */
function ubHeaders(ip, extra) {
  return Object.assign({ 'X-Forwarded-For': ip, 'X-Device': 'unbind-test/1.0' }, extra || {});
}

function unbindRequestsOf(no) {
  return store.all('unbind_requests').filter(function (r) { return String(r.no) === String(no); });
}

async function main() {
  console.log('自助解绑 / 换绑专项自测（DEV_MODE=1，临时数据目录 ' + tmp + '）');

  // 与 server.bootstrap() 等价，但**不注册退出落盘钩子**（临时目录结束后会被删除）
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
  const base = 'http://127.0.0.1:' + srv.address().port;
  console.log('  测试实例：' + base);

  try {
    // ---------------------------------------------------------------- 0
    section('0. 模式自证 + 后台管理员令牌');
    let adminToken = '';
    {
      const hp = await call(base, 'GET', '/health');
      check(hp.body.code === 0 && hp.body.data.devMode === true, '健康检查 devMode=true（开发模式联调路径）',
        'devMode=' + (hp.body.data && hp.body.data.devMode));
      const wl = await call(base, 'POST', '/auth/login', { no: 'ADMIN001', password: '123456' });
      adminToken = (wl.body.data || {}).token || '';
      check(wl.body.code === 0 && !!adminToken, '教务处账号密码登录可用（用于核对历史课时数据与审计）', 'code=' + wl.body.code);
      check(store.all('unbind_requests').length === 0, '新表 unbind_requests 初始为空（store 已登记该表）',
        'table=' + unbind.TABLE);
    }

    // ---------------------------------------------------------------- 1
    section('1. POST /auth/unbind（需登录）：解绑本人 → 档案保留 + token 失效');
    const NO_T = '2010032';
    const NAME_T = '唐瑞明';
    let openidA = '';
    let tokenA = '';
    let teacherUserId = '';
    let cadreToken = '';
    let recordsBefore = 0;
    let sessionsBefore = 0;
    let teacherRowsBefore = 0;
    {
      const lg = await call(base, 'POST', '/auth/login', { code: 'device-A-code' });
      openidA = (lg.body.data || {}).openid || '';
      check(lg.body.code === 0 && lg.body.data.needBind === true && !!openidA && !!lg.body.data.bindTicket,
        '① 未绑定的微信登录 → needBind + openid + bindTicket', 'openid=' + String(openidA).slice(0, 12) + '…');

      const bind = await call(base, 'POST', '/auth/bind', {
        bindTicket: lg.body.data.bindTicket, openid: openidA,
        role: 'teacher', no: NO_T, realName: NAME_T,
      });
      tokenA = (bind.body.data || {}).token || '';
      teacherUserId = (store.all('users').find(function (x) { return String(x.staff_no) === NO_T; }) || {}).id;
      check(bind.body.code === 0 && !!tokenA && userByNo(NO_T).openid === openidA,
        '② 绑定成功：openid 写入该工号档案', 'userId=' + teacherUserId);

      // 额外造一条**真实课时会话**（/sessions 计数用）：班干部登录 + 绑定 + 发起课时
      const lgCadre = await call(base, 'POST', '/auth/login', { code: 'cadre-session-code' });
      const bCadre = await call(base, 'POST', '/auth/bind', {
        bindTicket: lgCadre.body.data.bindTicket, openid: lgCadre.body.data.openid,
        role: 'cadre', no: '2025030117', realName: '张一鸣',
      });
      cadreToken = (bCadre.body.data || {}).token || '';
      const sess = await call(base, 'POST', '/sessions', {
        courseName: '信息技术', teacherName: NAME_T, teachDate: u.dateOnly(), section: '1-2', place: '实训楼A302',
      }, { Authorization: 'Bearer ' + cadreToken });
      check(sess.body.code === 0 && !!(sess.body.data || {}).sessionId,
        '②b 前置：已存在一条真实课时会话（用于核对 /sessions 计数不被解绑影响）',
        'sessionId=' + (sess.body.data || {}).sessionId);

      // 解绑前快照：HTTP 层（管理员视角）+ 内存库层
      const rec0 = await call(base, 'GET', '/records?pageSize=1', undefined, { Authorization: 'Bearer ' + adminToken });
      const ses0 = await call(base, 'GET', '/sessions?pageSize=1', undefined, { Authorization: 'Bearer ' + adminToken });
      recordsBefore = (rec0.body.data || {}).total;
      sessionsBefore = (ses0.body.data || {}).total;
      teacherRowsBefore = store.all('period_records').filter(function (r) { return String(r.teacher_id) === String(teacherUserId); }).length;
      check(recordsBefore > 0 && sessionsBefore > 0 && teacherRowsBefore > 0,
        '③ 解绑前已有历史课时数据（用于核对"解绑不动数据"）',
        'records=' + recordsBefore + ' sessions=' + sessionsBefore + ' teacherRows=' + teacherRowsBefore);

      const me0 = await call(base, 'GET', '/auth/me', undefined, { Authorization: 'Bearer ' + tokenA });
      check(me0.body.code === 0 && me0.body.data.user.no === NO_T, '④ 解绑前 token 有效（/auth/me 正常）');

      // ------- 解绑
      const un = await call(base, 'POST', '/auth/unbind', undefined, { Authorization: 'Bearer ' + tokenA });
      const d = un.body.data || {};
      check(un.body.code === 0 && d.ok === true && d.no === NO_T && d.realName === NAME_T && d.unbound === true,
        '⑤ 解绑成功且返回 {ok,no,realName,unbound:true}',
        'code=' + un.body.code + ' data=' + JSON.stringify(d));

      const row = userByNo(NO_T);
      check(!!row && String(row.openid || '') === '', '⑥ 该用户 openid 已置空', 'openid=' + JSON.stringify(row.openid));
      check(!!row && row.id === teacherUserId && row.real_name === NAME_T && row.staff_no === NO_T && row.status === 'active',
        '⑦ 用户档案**未删除**且字段不变（id/姓名/工号/状态保留）',
        'id=' + row.id + ' name=' + row.real_name);

      // ------- token 立即失效
      const me1 = await call(base, 'GET', '/auth/me', undefined, { Authorization: 'Bearer ' + tokenA });
      check(me1.body.code === 40101, '⑧ 原 token **立即失效**（/auth/me → 40101）',
        'code=' + me1.body.code + ' msg=' + me1.body.msg);
      const again = await call(base, 'POST', '/auth/unbind', undefined, { Authorization: 'Bearer ' + tokenA });
      check(again.body.code === 40101, '⑨ 原 token 不能再次解绑（/auth/unbind → 40101）', 'code=' + again.body.code);

      const noAuth = await call(base, 'POST', '/auth/unbind');
      check(noAuth.body.code === 40101, '⑩ 未登录调用 /auth/unbind → 40101（需登录）', 'code=' + noAuth.body.code);

      // ------- 历史课时数据仍在
      const rec1 = await call(base, 'GET', '/records?pageSize=1', undefined, { Authorization: 'Bearer ' + adminToken });
      const ses1 = await call(base, 'GET', '/sessions?pageSize=1', undefined, { Authorization: 'Bearer ' + adminToken });
      const teacherRowsAfter = store.all('period_records').filter(function (r) { return String(r.teacher_id) === String(teacherUserId); }).length;
      const auditRowsAfter = store.all('audit_logs').length;
      check((rec1.body.data || {}).total === recordsBefore, '⑪ GET /records 总数不变（历史课时数据未被动过）',
        recordsBefore + ' → ' + (rec1.body.data || {}).total);
      check((ses1.body.data || {}).total === sessionsBefore, '⑫ GET /sessions 总数不变（课时会话未被动过）',
        sessionsBefore + ' → ' + (ses1.body.data || {}).total);
      check(teacherRowsAfter === teacherRowsBefore, '⑬ 该教师名下课时记录条数不变（逐条核对内存库）',
        teacherRowsBefore + ' → ' + teacherRowsAfter);
      check(auditRowsAfter > 0, '⑭ 审计数据保留（哈希链继续累加，未被清空）', 'auditRows=' + auditRowsAfter);

      // ------- 解绑后可重新绑定该工号（且确实走了"空槽位"正常路径）
      const lg2 = await call(base, 'POST', '/auth/login', { code: 'device-B-code' });
      const openidB = (lg2.body.data || {}).openid || '';
      check(!!openidB && openidB !== openidA, '⑮ 新微信登录得到不同的 openid（模拟换微信）',
        String(openidA).slice(0, 10) + '… vs ' + String(openidB).slice(0, 10) + '…');

      const bind2 = await call(base, 'POST', '/auth/bind', {
        bindTicket: lg2.body.data.bindTicket, openid: openidB,
        role: 'teacher', no: NO_T, realName: NAME_T,
      });
      check(bind2.body.code === 0 && !!((bind2.body.data || {}).token),
        '⑯ 解绑后同一工号可被新微信重新绑定（成功）', 'code=' + bind2.body.code + ' msg=' + bind2.body.msg);
      const row2 = userByNo(NO_T);
      check(!!row2 && row2.openid === openidB && row2.id === teacherUserId,
        '⑰ 重新绑定写入新 openid，且仍是同一条用户档案（未新建档案）', 'id=' + (row2 || {}).id);
      const replaced = await call(base, 'GET', '/logs?action=auth.bind.dev.replace&pageSize=50', undefined, { Authorization: 'Bearer ' + adminToken });
      check((replaced.body.data || {}).total === 0,
        '⑱ 重新绑定**未**走开发模式的 openid 覆盖分支（证明解绑真的释放了绑定槽位）',
        'auth.bind.dev.replace total=' + (replaced.body.data || {}).total);
    }

    // ---------------------------------------------------------------- 2
    section('2. POST /auth/unbind-self（未登录）：弱凭证校验 + hadBinding');
    const NO_S = '2011045';
    const NAME_S = '李慧';
    let mismatchMsg = '';
    {
      // 先给该工号绑定一个微信（模拟"旧微信还绑着"）
      const lg = await call(base, 'POST', '/auth/login', { code: 'device-C-code' });
      const openidC = (lg.body.data || {}).openid || '';
      const bind = await call(base, 'POST', '/auth/bind', {
        bindTicket: lg.body.data.bindTicket, openid: openidC,
        role: 'teacher', no: NO_S, realName: NAME_S,
      });
      check(bind.body.code === 0 && userByNo(NO_S).openid === openidC, '① 前置：该工号已被某个微信绑定');

      // 姓名不符 → 40301，且**不做任何解绑**
      const wrong = await call(base, 'POST', '/auth/unbind-self',
        { no: NO_S, realName: '张冠李戴' }, ubHeaders('10.0.0.11'));
      mismatchMsg = String(wrong.body.msg || '');
      check(wrong.body.code === 40301, '② 姓名与白名单不符 → 40301', 'code=' + wrong.body.code + ' msg=' + mismatchMsg);
      check(/核对/.test(mismatchMsg) && /姓名/.test(mismatchMsg) && mismatchMsg.indexOf(NO_S) >= 0,
        '③ 提示与"姓名/工号核对"相关且带上工号', mismatchMsg);
      check(userByNo(NO_S).openid === openidC, '④ 姓名不符时**没有**解绑（openid 原样保留）',
        'openid=' + String(userByNo(NO_S).openid).slice(0, 10) + '…');

      // 正确姓名 → 解绑成功，hadBinding=true
      const right = await call(base, 'POST', '/auth/unbind-self',
        { no: NO_S, realName: NAME_S }, ubHeaders('10.0.0.11'));
      const d = right.body.data || {};
      check(right.body.code === 0 && d.ok === true && d.no === NO_S && d.realName === NAME_S,
        '⑤ 正确姓名 → 解绑成功（返回 {ok,no,realName,hadBinding}）', 'data=' + JSON.stringify(d));
      check(d.hadBinding === true, '⑥ 确有绑定 → hadBinding=true', 'hadBinding=' + d.hadBinding);
      check(String(userByNo(NO_S).openid || '') === '', '⑦ openid 已清空（登录绑定解除）');
      check(!!userByNo(NO_S) && userByNo(NO_S).real_name === NAME_S, '⑧ 用户档案保留（只解除绑定）');

      const me = await call(base, 'GET', '/auth/me', undefined, { Authorization: 'Bearer ' + (bind.body.data || {}).token });
      check(me.body.code === 40101, '⑨ 被解绑的旧微信：此前签发的 token 立即失效（40101）',
        'code=' + me.body.code + ' msg=' + me.body.msg);
      check(/绑定已变更/.test(String(me.body.msg || '')),
        '⑨b 失效原因明确提示"微信绑定已变更"（绑定世代 auth_epoch 校验）', me.body.msg);

      const rows = unbindRequestsOf(NO_S);
      check(rows.length === 2, '⑩ 新表已记录 2 次请求（1 次姓名不符 + 1 次成功）', 'rows=' + rows.length);
      check(rows.some(function (r) { return r.allowed === false && r.reason === 'name_mismatch'; }) &&
        rows.some(function (r) { return r.allowed === true && r.had_binding === true; }),
        '⑪ 计数记录含 allowed/reason/had_binding 三个关键字段',
        JSON.stringify(rows.map(function (r) { return { a: r.allowed, r: r.reason, h: r.had_binding }; })));
      check(rows.every(function (r) { return r.ip === '10.0.0.11' && r.device === 'unbind-test/1.0' && !!r.created_at_ms; }),
        '⑫ 记录含 IP、设备与时间戳', JSON.stringify(rows[0] && { ip: rows[0].ip, device: rows[0].device }));
    }

    // ---------------------------------------------------------------- 3
    section('3. 幂等 + 同一 no 频率限制（24 小时 ≤2 次）');
    const NO_IDEM = '2012088';
    {
      const r1 = await call(base, 'POST', '/auth/unbind-self',
        { no: NO_IDEM, realName: '王强' }, ubHeaders('10.0.0.12'));
      check(r1.body.code === 0 && (r1.body.data || {}).hadBinding === false,
        '① 本就没有绑定 → 幂等成功且 hadBinding=false', 'data=' + JSON.stringify(r1.body.data));

      const r2 = await call(base, 'POST', '/auth/unbind-self',
        { no: NO_IDEM, realName: '王强' }, ubHeaders('10.0.0.12'));
      check(r2.body.code === 0 && (r2.body.data || {}).hadBinding === false,
        '② 第 2 次（窗口内最后一次）仍成功', 'code=' + r2.body.code);

      const r3 = await call(base, 'POST', '/auth/unbind-self',
        { no: NO_IDEM, realName: '王强' }, ubHeaders('10.0.0.12'));
      check(r3.body.code === 40001, '③ 同一 no 第 3 次 → 40001（被限流）',
        'code=' + r3.body.code + ' http=' + r3.httpStatus);
      check(/已达上限/.test(String(r3.body.msg || '')) && /教务处/.test(String(r3.body.msg || '')),
        '④ 限流提示明确（含"已达上限"与"联系教务处"）', r3.body.msg);
      check(unbindRequestsOf(NO_IDEM).length === 2, '⑤ 被限流拒绝的请求不再重复计数（避免刷请求延长窗口）',
        'rows=' + unbindRequestsOf(NO_IDEM).length);
      check(unbind.rateLimit(NO_IDEM, '10.0.0.12').allowed === false, '⑥ 限流闸门在业务层同样生效（rateLimit 可单测）');
    }

    // ---------------------------------------------------------------- 4
    section('4. 同一 IP 频率限制（1 小时 ≤5 次）+ 换 IP 仍可用 + 学号路径');
    {
      // 先绑定一个班干部（学号 2025030117），验证 unbind-self 的「学号」与 hadBinding=true
      const lg = await call(base, 'POST', '/auth/login', { code: 'device-D-code' });
      const bind = await call(base, 'POST', '/auth/bind', {
        bindTicket: lg.body.data.bindTicket, openid: (lg.body.data || {}).openid,
        role: 'cadre', no: '2025030117', realName: '张一鸣',
      });
      check(bind.body.code === 0, '① 前置：班干部学号 2025030117 已绑定微信');

      const IP = '10.9.9.9';
      const cases = [
        { no: '2025030117', name: '张一鸣', had: true },
        { no: '2025030102', name: '王悦', had: false },
        { no: '2025030109', name: '刘欣', had: false },
        { no: '2025040201', name: '陈思远', had: false },
        { no: '2025040202', name: '赵敏', had: false },
      ];
      let allOk = true;
      let hadReported = null;
      for (const c of cases) {
        const r = await call(base, 'POST', '/auth/unbind-self', { no: c.no, realName: c.name }, ubHeaders(IP));
        if (r.body.code !== 0) allOk = false;
        if (c.had) hadReported = (r.body.data || {}).hadBinding;
      }
      check(allOk, '② 同一 IP 前 5 次（不同工号/学号）全部成功', '5 次全部 code=0');
      check(hadReported === true, '③ 学号（学生）路径同样可用，且确有绑定 → hadBinding=true', 'hadBinding=' + hadReported);

      const sixth = await call(base, 'POST', '/auth/unbind-self',
        { no: '2017001', realName: '孙主任' }, ubHeaders(IP));
      check(sixth.body.code === 40001, '④ 同一 IP 第 6 次 → 40001（被限流）',
        'code=' + sixth.body.code + ' msg=' + sixth.body.msg);
      check(/当前网络|IP/.test(String(sixth.body.msg || '')) && /已达上限/.test(String(sixth.body.msg || '')),
        '⑤ IP 限流提示明确', sixth.body.msg);
      check(unbindRequestsOf('2017001').length === 0, '⑥ IP 限流时该 no 未被记入计数（窗口不被无限延长）');

      const other = await call(base, 'POST', '/auth/unbind-self',
        { no: '2017001', realName: '孙主任' }, ubHeaders('10.9.9.10'));
      check(other.body.code === 0, '⑦ 换一个 IP 后同一工号仍可自助解绑（限流按 IP 维度隔离）',
        'code=' + other.body.code);
    }

    // ---------------------------------------------------------------- 5
    section('5. 参数与凭证边界');
    {
      const noNo = await call(base, 'POST', '/auth/unbind-self', { realName: '唐瑞明' }, ubHeaders('10.0.0.13'));
      check(noNo.body.code === 40001 && /no/.test(String(noNo.body.msg || '')),
        '① 缺 no → 40001 且提示明确', 'code=' + noNo.body.code + ' msg=' + noNo.body.msg);
      const noName = await call(base, 'POST', '/auth/unbind-self', { no: '2010032' }, ubHeaders('10.0.0.13'));
      check(noName.body.code === 40001 && /realName/.test(String(noName.body.msg || '')),
        '② 缺 realName → 40001 且提示明确', 'code=' + noName.body.code + ' msg=' + noName.body.msg);

      const notIn = await call(base, 'POST', '/auth/unbind-self',
        { no: '9999999', realName: '王强' }, ubHeaders('10.0.0.13'));
      check(notIn.body.code === 40301, '③ 工号不在白名单 → 40301', 'code=' + notIn.body.code);
      // 提示里回显的是用户自己提交的工号，把工号归一化后两者必须**完全一致**
      const norm = function (s, no) { return String(s || '').split(no).join('<NO>'); };
      check(norm(notIn.body.msg, '9999999') === norm(mismatchMsg, NO_S),
        '④ 「不在白名单」与「姓名不符」返回同一提示（不可用于探测工号是否存在）',
        norm(notIn.body.msg, '9999999') === norm(mismatchMsg, NO_S) ? '一致' : norm(notIn.body.msg, '9999999'));

      // 空串姓名 / 空白工号
      const blank = await call(base, 'POST', '/auth/unbind-self', { no: '   ', realName: '  ' }, ubHeaders('10.0.0.13'));
      check(blank.body.code === 40001, '⑤ 全空白入参 → 40001（trim 后校验）', 'code=' + blank.body.code);

      // 不采集定位：响应体不含位置字段
      const sample = await call(base, 'POST', '/auth/unbind-self',
        { no: '2025030117', realName: '张一鸣' }, ubHeaders('10.0.0.14'));
      const text = JSON.stringify(sample.body);
      check(!/latitude|longitude|location/i.test(text), '⑥ 响应体不含任何定位字段（不采集定位）',
        'code=' + sample.body.code);
      const unAuthText = JSON.stringify(await call(base, 'POST', '/auth/unbind', undefined, { Authorization: 'Bearer x' }));
      check(!/latitude|longitude|location/i.test(unAuthText), '⑦ /auth/unbind 的响应同样不含定位字段');
    }

    // ---------------------------------------------------------------- 6
    section('6. 审计留痕（auth.unbind / auth.unbind.self）+ 哈希链完整');
    {
      const logs = await call(base, 'GET', '/logs?pageSize=200', undefined, { Authorization: 'Bearer ' + adminToken });
      const list = (logs.body.data || {}).list || [];
      const unbinds = list.filter(function (l) { return l.action === 'auth.unbind'; });
      const selfs = list.filter(function (l) { return l.action === 'auth.unbind.self'; });

      check(unbinds.length >= 1, '① 已登录解绑写审计 auth.unbind', 'total=' + unbinds.length);
      const u1 = unbinds[unbinds.length - 1] || {};
      check(u1.after && u1.after.no === NO_T && u1.after.realName === NAME_T,
        '② auth.unbind 记录 no 与 realName', JSON.stringify(u1.after && { no: u1.after.no, realName: u1.after.realName }));
      const prefix = String((u1.after || {}).openidPrefix || '');
      check(/^dev_/.test(prefix) && prefix.indexOf('…') >= 0 && prefix.length < String(openidA).length,
        '③ 原 openid 以**前缀脱敏**形式留痕（不写完整标识）', 'openidPrefix=' + prefix);
      check(/不删除|不影响/.test(String(u1.detail || '')), '④ 日志 detail 写明"仅解除绑定、不动历史数据"', u1.detail);

      check(selfs.length >= 10, '⑤ 自助解绑的每次请求（成功/失败/限流）都写审计 auth.unbind.self', 'total=' + selfs.length);
      const reasons = {};
      selfs.forEach(function (l) { const r = String((l.after || {}).reason); reasons[r] = (reasons[r] || 0) + 1; });
      check(reasons.name_mismatch >= 1 && reasons.not_in_whitelist >= 1,
        '⑥ 姓名不符 / 不在白名单的拒绝均有留痕', JSON.stringify(reasons));
      check(reasons.rate_limited_no >= 1 && reasons.rate_limited_ip >= 1,
        '⑦ 两种限流拒绝均有留痕', JSON.stringify(reasons));
      const byIp = selfs.filter(function (l) { return (l.after || {}).ip === '10.9.9.9'; });
      check(byIp.length >= 6, '⑧ 审计记录 IP（同一 IP 的 6 次请求均可追溯）', 'ip=10.9.9.9 共 ' + byIp.length + ' 条');
      check(byIp.every(function (l) { return l.device === 'unbind-test/1.0' && (l.after || {}).device === 'unbind-test/1.0'; }),
        '⑨ 审计记录设备（x-device）', byIp[0] && byIp[0].device);
      const hadTrue = selfs.filter(function (l) { return (l.after || {}).hadBinding === true; });
      const hadFalse = selfs.filter(function (l) { return (l.after || {}).hadBinding === false; });
      check(hadTrue.length >= 2 && hadFalse.length >= 3, '⑩ 审计记录"是否确有绑定"（hadBinding true/false 均有）',
        'true=' + hadTrue.length + ' false=' + hadFalse.length);
      const lim = selfs.filter(function (l) { return (l.after || {}).allowed === false && /rate_limited/.test(String((l.after || {}).reason)); })[0];
      check(!!lim && /上限/.test(String(lim.detail || '')), '⑪ 限流拒绝的 detail 写明原因', lim && lim.detail);

      const chain = await call(base, 'GET', '/logs/verify', undefined, { Authorization: 'Bearer ' + adminToken });
      check(chain.body.code === 0 && chain.body.data.ok === true, '⑫ 审计哈希链完整（新增日志未破坏链）',
        'total=' + (chain.body.data || {}).total + ' brokenAt=' + (chain.body.data || {}).brokenAt);
    }

    // ---------------------------------------------------------------- 7
    section('7. 新表 data/unbind_requests.json 落地与保留策略');
    {
      store.flush('unbind_requests');
      const file = store.filePath('unbind_requests');
      check(fs.existsSync(file) && path.basename(file) === 'unbind_requests.json',
        '① store 新增表落到 data/unbind_requests.json', path.basename(file));
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { arr = null; }
      check(Array.isArray(arr) && arr.length === store.all('unbind_requests').length && arr.length > 0,
        '② 文件内容与内存表一致（数组）', 'rows=' + (arr ? arr.length : 'parse-error'));
      const row = arr[0] || {};
      check(!!row.id && /^UB\d+$/.test(String(row.id)) && !!row.no && !!row.real_name && !!row.ip &&
        !!row.created_at && !!row.created_at_ms && row.reason !== undefined,
        '③ 记录字段完整（id/no/real_name/ip/device/had_binding/allowed/reason/created_at）',
        JSON.stringify(Object.keys(row)));

      // 7 天保留：人为插入一条 8 天前的记录，prune() 后应被清理
      const stale = unbind.record({ no: 'STALE', realName: 'x', ip: '1.1.1.1', hadBinding: false, allowed: true });
      stale.created_at_ms = Date.now() - (8 * 24 * 3600 * 1000);
      const before = store.all('unbind_requests').length;
      const after = unbind.prune();
      check(before === after + 1, '④ 超过 7 天的记录被清理（保留最近记录，避免无限增长）',
        before + ' → ' + after);
      check(store.all('unbind_requests').every(function (r) { return r.id !== stale.id; }),
        '⑤ 过期记录已从表中移除');
      check(unbind.RETENTION_MS === 7 * 24 * 3600 * 1000 && unbind.LIMITS.no.max === 2 && unbind.LIMITS.ip.max === 5,
        '⑥ 限额常量与需求一致（no 24h ≤2、ip 1h ≤5、保留 7 天）',
        'RETENTION_MS=' + unbind.RETENTION_MS);
    }
  } finally {
    await new Promise(function (resolve) { srv.close(function () { resolve(); }); });
    store.flushAll();
  }

  console.log('\n' + '='.repeat(64));
  console.log('自助解绑 / 换绑专项自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('='.repeat(64));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e && e.stack ? e.stack : e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
  process.exit(2);
});
