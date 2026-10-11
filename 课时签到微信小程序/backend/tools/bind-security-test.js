'use strict';
/**
 * 绑定安全专项自测（DEV_MODE=0 生产模式）
 *
 * 用法：
 *   node tools/bind-security-test.js
 *
 * 为什么单独一个脚本：冒烟脚本（smoke-test.js）跑在 DEV_MODE=1 下（否则 /auth/login 会真调微信接口），
 * 而「生产环境禁止仅凭 openid 绑定」这条只能在 DEV_MODE=0 下验证。本脚本在**进程内**以
 * DEV_MODE=0 + 独立临时 DATA_DIR + 独立随机端口启动真实 app（server.buildApp()），
 * 因此可以用同一进程内的密钥直接签发 bindTicket（等价于 /auth/login 下发的票据），
 * 并且**不会碰到 8081 演示服务与它的 data/**。
 *
 * 覆盖：
 *   1) DEV_MODE=0 下仅传 openid（无票据）→ 40101，且不写入任何 openid（未越权占号）
 *   2) 票据被篡改 → 40101；票据已过期 → 40101
 *   3) 票据有效但请求体 openid 与票据不一致 → 40301
 *   4) 票据有效且 openid 一致 → 绑定成功（{token,user} 结构不变）
 *   5) 票据有效但不传 openid → 仍可成功（票据即凭据）
 *   6) 白名单校验逻辑不变（票据有效但姓名不符 → 40301）
 *   7) 被拒绝的绑定写审计日志 auth.bind.reject，哈希链完整
 *
 * 说明：零新增依赖，仅用 Node 18 内置 fetch/FormData。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsq-bind-'));
// —— 必须在 require 业务模块之前设置：util.js 在加载时读取这些环境变量
process.env.DATA_DIR = tmp;
process.env.DEV_MODE = '0';
process.env.TOKEN_SECRET = 'bind-test-token-secret';
process.env.CODE_SECRET = 'bind-test-code-secret';
process.env.INTERNAL_JOB_TOKEN = 'bind-test-internal-token';

const u = require('../src/util');
const store = require('../src/store');
const seed = require('../src/seed');
const view = require('../src/view');
const webauth = require('../src/webauth');
const auth = require('../src/auth');
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
  return store.find('users', function (x) {
    return String(x.staff_no) === String(no) || String(x.student_no) === String(no);
  });
}

async function main() {
  console.log('绑定安全专项自测（DEV_MODE=0，临时数据目录 ' + tmp + '）');

  // 与 server.bootstrap() 等价，但**不注册退出落盘钩子**：
  // 临时目录在结束时会被删除，注册钩子只会在退出时打印一堆写盘失败日志。
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
    // ---------------------------------------------------------------- 0 模式自证
    section('0. 生产模式自证（确认真的是 DEV_MODE=0）');
    {
      const hp = await call(base, 'GET', '/health');
      check(hp.body.code === 0 && hp.body.data.devMode === false, '健康检查 devMode=false',
        'devMode=' + (hp.body.data && hp.body.data.devMode) + ' node=' + (hp.body.data && hp.body.data.node));
      // 顺手自证：DEV_MODE=0 下小程序登录分支会真调微信接口（无凭据 → 50002），
      // 该错误会经 http.errorHandler 打一行 console.error，这里临时静音避免干扰自测输出
      const origConsoleError = console.error;
      console.error = function () {};
      let lg;
      try {
        lg = await call(base, 'POST', '/auth/login', { code: 'prod-mode-probe-code' });
      } finally {
        console.error = origConsoleError;
      }
      check(lg.body.code === 50002, 'DEV_MODE=0 下 /auth/login 真调微信接口（无凭据 → 50002），证明不是开发模式',
        'code=' + lg.body.code + ' msg=' + lg.body.msg);
    }

    // ---------------------------------------------------------------- 1 无票据
    const OPENID = 'wx_openid_' + u.randHex(16);
    const NO = '2010032';
    const NAME = '唐瑞明';
    section('1. 生产环境仅凭 openid 绑定 → 40101 且不落任何绑定');
    {
      const r = await call(base, 'POST', '/auth/bind', { openid: OPENID, role: 'teacher', no: NO, realName: NAME });
      check(r.body.code === 40101, '仅传 openid（无 bindTicket）→ 40101', 'code=' + r.body.code + ' msg=' + r.body.msg);
      check(/bindTicket/.test(String(r.body.msg || '')), '错误信息明确说明缺少 bindTicket', r.body.msg);
      const row = userByNo(NO);
      check(!!row && !row.openid, '该工号未被写入 openid（伪造 openid 无法占号）',
        'openid=' + JSON.stringify(row && row.openid));
    }

    // ---------------------------------------------------------------- 2 票据无效 / 过期
    const validTicket = auth.issueBindTicket(OPENID, 1800);
    section('2. 票据篡改 / 过期 → 40101');
    {
      const tampered = await call(base, 'POST', '/auth/bind', {
        bindTicket: validTicket + 'x', openid: OPENID, role: 'teacher', no: NO, realName: NAME,
      });
      check(tampered.body.code === 40101, '被篡改的 bindTicket → 40101', 'code=' + tampered.body.code + ' msg=' + tampered.body.msg);

      const junk = await call(base, 'POST', '/auth/bind', {
        bindTicket: 'not-a-ticket', role: 'teacher', no: NO, realName: NAME,
      });
      check(junk.body.code === 40101, '格式非法的 bindTicket → 40101', 'code=' + junk.body.code);

      const expiredTicket = auth.issueBindTicket(OPENID, -60);   // 60 秒前已过期
      check(auth.verifyBindTicket(expiredTicket) === null, '准备一张已过期票据（verifyBindTicket 返回 null）');
      const expired = await call(base, 'POST', '/auth/bind', {
        bindTicket: expiredTicket, openid: OPENID, role: 'teacher', no: NO, realName: NAME,
      });
      check(expired.body.code === 40101 && /过期|无效/.test(String(expired.body.msg || '')),
        '已过期的 bindTicket → 40101（提示重新登录）', 'code=' + expired.body.code + ' msg=' + expired.body.msg);

      const row = userByNo(NO);
      check(!!row && !row.openid, '以上失败请求均未写入 openid', 'openid=' + JSON.stringify(row && row.openid));
    }

    // ---------------------------------------------------------------- 3 openid 不一致
    section('3. 票据有效但请求体 openid 与票据不一致 → 40301');
    {
      const forged = 'wx_forged_' + u.randHex(12);
      const r = await call(base, 'POST', '/auth/bind', {
        bindTicket: validTicket, openid: forged, role: 'teacher', no: NO, realName: NAME,
      });
      check(r.body.code === 40301, 'openid 与票据不一致 → 40301', 'code=' + r.body.code + ' msg=' + r.body.msg);
      check(/不一致|不同/.test(String(r.body.msg || '')) && /bindTicket/.test(String(r.body.msg || '')),
        '错误信息说明 openid 与 bindTicket 不一致', r.body.msg);
      const row = userByNo(NO);
      check(!!row && !row.openid, '不一致的请求未写入任何 openid', 'openid=' + JSON.stringify(row && row.openid));
      const forgedRow = store.find('users', function (x) { return x.openid === forged; });
      check(!forgedRow, '伪造的 openid 未被任何账号绑定', forgedRow ? forgedRow.id : '无');
    }

    // ---------------------------------------------------------------- 4 有效票据 + 一致
    section('4. 有效票据 + openid 一致 → 绑定成功（响应结构不变）');
    let token = '';
    {
      const r = await call(base, 'POST', '/auth/bind', {
        bindTicket: validTicket, openid: OPENID, role: 'teacher', no: NO, realName: NAME,
      });
      const d = r.body.data || {};
      check(r.body.code === 0, '绑定成功 code=0', 'msg=' + r.body.msg);
      check(!!d.token && d.tokenType === 'Bearer' && d.needBind === false && d.role === 'teacher' && !!d.user,
        '响应仍为 {token, tokenType, expiresAt, needBind, role, user}', 'role=' + d.role + ' user=' + (d.user && d.user.name));
      token = d.token || '';
      const row = userByNo(NO);
      check(!!row && row.openid === OPENID, 'openid 已写入该工号档案', row && row.openid);
    }

    // ---------------------------------------------------------------- 5 只带票据
    section('5. 只带票据（不带 openid）→ 仍按票据内 openid 绑定');
    {
      const openid2 = 'wx_openid_' + u.randHex(16);
      const t2 = auth.issueBindTicket(openid2, 1800);
      const r = await call(base, 'POST', '/auth/bind', { bindTicket: t2, role: 'teacher', no: '2011045', realName: '李慧' });
      check(r.body.code === 0 && r.body.data.token, '仅 bindTicket → 绑定成功', 'code=' + r.body.code + ' msg=' + r.body.msg);
      const row = userByNo('2011045');
      check(!!row && row.openid === openid2, '绑定的 openid 取自票据', row && row.openid);
    }

    // ---------------------------------------------------------------- 6 白名单逻辑不变
    section('6. 白名单校验逻辑不变（票据有效但姓名不符 → 40301）');
    {
      const openid3 = 'wx_openid_' + u.randHex(16);
      const t3 = auth.issueBindTicket(openid3, 1800);
      const r = await call(base, 'POST', '/auth/bind', { bindTicket: t3, role: 'teacher', no: '2012088', realName: '张冠李戴' });
      check(r.body.code === 40301 && /不一致/.test(String(r.body.msg || '')),
        '票据有效但姓名与白名单不符 → 40301（白名单校验未被绕过）', 'code=' + r.body.code + ' msg=' + r.body.msg);
      const r2 = await call(base, 'POST', '/auth/bind', { bindTicket: t3, role: 'teacher', no: '9999999', realName: '王强' });
      check(r2.body.code === 40301, '工号不在白名单 → 40301', 'code=' + r2.body.code);
      // 已被绑定的工号：换个 openid 再绑 → 40301（占用校验仍生效）
      const t4 = auth.issueBindTicket('wx_openid_' + u.randHex(16), 1800);
      const r3 = await call(base, 'POST', '/auth/bind', { bindTicket: t4, role: 'teacher', no: NO, realName: NAME });
      check(r3.body.code === 40301, '同一工号已被其他微信绑定 → 40301', 'code=' + r3.body.code + ' msg=' + r3.body.msg);
    }

    // ---------------------------------------------------------------- 7 审计留痕
    section('7. 被拒绝的绑定写审计日志（auth.bind.reject）且哈希链完整');
    {
      const wl = await call(base, 'POST', '/auth/login', { no: 'ADMIN001', password: '123456' });
      const adminToken = (wl.body.data || {}).token || '';
      check(wl.body.code === 0 && !!adminToken, 'Web 后台账号密码登录可用（DEV_MODE=0 不影响后台登录）', 'code=' + wl.body.code);
      const logs = await call(base, 'GET', '/logs?action=auth.bind.reject&pageSize=50', undefined, { Authorization: 'Bearer ' + adminToken });
      const d = logs.body.data || {};
      const reasons = (d.list || []).map(function (x) { return (x.after || {}).reason; });
      check(logs.body.code === 0 && d.total >= 5, '拒绝记录已留痕', 'total=' + d.total + ' reasons=' + reasons.join(','));
      check(reasons.indexOf('missing_ticket') >= 0 && reasons.indexOf('invalid_ticket') >= 0 && reasons.indexOf('openid_mismatch') >= 0,
        '三类拒绝原因均可追溯（missing_ticket / invalid_ticket / openid_mismatch）', reasons.join(','));
      const chain = await call(base, 'GET', '/logs/verify', undefined, { Authorization: 'Bearer ' + adminToken });
      check(chain.body.code === 0 && chain.body.data.ok === true, '审计哈希链完整', 'total=' + (chain.body.data || {}).total);
      const detail = (d.list || []).filter(function (x) { return (x.after || {}).reason === 'openid_mismatch'; })[0];
      check(!!detail && /不一致/.test(String(detail.detail || '')), '不一致拒绝的日志 detail 写明原因', detail && detail.detail);
    }
    // ---------------------------------------------------------------- 8 自助解绑（生产模式）
    section('8. 生产模式（DEV_MODE=0）下的自助解绑 / 换绑');
    {
      const wl = await call(base, 'POST', '/auth/login', { no: 'ADMIN001', password: '123456' });
      const adm = (wl.body.data || {}).token || '';
      check(wl.body.code === 0 && !!adm, '后台管理员可登录（用于核对审计）', 'code=' + wl.body.code);

      // 8.1 已登录本人解绑：令牌在 DEV_MODE=0 下同样立即失效（含 auth_epoch 世代校验）
      const rowBefore = userByNo(NO);
      const epochBefore = Number(rowBefore && rowBefore.auth_epoch || 0);
      check(!!rowBefore && rowBefore.openid === OPENID, '前置：工号 ' + NO + ' 在严格模式下仍绑定着（openid 前缀 ' + String(OPENID).slice(0, 8) + '…）');
      const t1 = auth.issueToken(rowBefore).token;   // 等价于已绑定用户经 /auth/login 拿到的令牌
      const me0 = await call(base, 'GET', '/auth/me', undefined, { Authorization: 'Bearer ' + t1 });
      check(me0.body.code === 0, '① 解绑前令牌有效（/auth/me 正常）', 'code=' + me0.body.code);

      const un = await call(base, 'POST', '/auth/unbind', undefined, { Authorization: 'Bearer ' + t1 });
      check(un.body.code === 0 && (un.body.data || {}).unbound === true && (un.body.data || {}).no === NO,
        '② 严格模式下 /auth/unbind 解绑成功', 'data=' + JSON.stringify(un.body.data));
      const rowAfter = userByNo(NO);
      check(!!rowAfter && String(rowAfter.openid || '') === '' && !!rowAfter.id && rowAfter.status === 'active',
        '③ openid 置空但用户档案保留（不删除档案、不动历史数据）', 'openid=' + JSON.stringify(rowAfter.openid));
      check(Number(rowAfter.auth_epoch || 0) === epochBefore + 1,
        '④ 绑定世代 auth_epoch +1（使该工号此前签发的所有令牌失效）',
        epochBefore + ' → ' + (rowAfter.auth_epoch || 0));
      const me1 = await call(base, 'GET', '/auth/me', undefined, { Authorization: 'Bearer ' + t1 });
      check(me1.body.code === 40101, '⑤ 解绑后原令牌立即失效 → 40101', 'code=' + me1.body.code);

      // 8.2 生产模式仍**不接受裸 openid**（解绑不会顺带放宽绑定校验）
      const naked = await call(base, 'POST', '/auth/bind', {
        openid: 'wx_after_unbind_' + u.randHex(10), role: 'teacher', no: NO, realName: NAME,
      });
      check(naked.body.code === 40101, '⑥ 解绑后仅凭裸 openid 绑定仍被拒绝 → 40101（bindTicket 强制校验未放宽）',
        'code=' + naked.body.code);
      check(!userByNo(NO).openid, '⑦ 被拒的裸 openid 未写入档案');

      // 8.3 解绑后可用新微信（新票据）重新绑定同一工号 —— 生产模式没有 dev 覆盖分支，是"槽位真的空了"的硬证据
      const openidNew = 'wx_openid_' + u.randHex(16);
      const tNew = auth.issueBindTicket(openidNew, 1800);
      const rebind = await call(base, 'POST', '/auth/bind', {
        bindTicket: tNew, openid: openidNew, role: 'teacher', no: NO, realName: NAME,
      });
      check(rebind.body.code === 0 && !!((rebind.body.data || {}).token),
        '⑧ 解绑后同一工号可被新微信重新绑定（严格模式也是成功）', 'code=' + rebind.body.code + ' msg=' + rebind.body.msg);
      check(userByNo(NO).openid === openidNew, '⑨ 新 openid 已写入（绑定槽位确实被释放）', String(openidNew).slice(0, 10) + '…');
      const holder = store.find('users', function (x) { return x.openid === openidNew; });
      check(!!holder && String(holder.staff_no) === NO, '⑩ 该 openid 只被这一个账号持有');

      // 8.4 unbind-self 在生产模式同样可用（弱凭证 + 频率限制 + 审计留痕）
      //     注意：bind-security-test 第 5 节已把 2011045 绑走，这里另取一个从未绑定过的白名单工号
      const NO2 = '2012088';
      const openid2 = 'wx_openid_' + u.randHex(16);
      const t2b = auth.issueBindTicket(openid2, 1800);
      const bind2 = await call(base, 'POST', '/auth/bind', { bindTicket: t2b, openid: openid2, role: 'teacher', no: NO2, realName: '王强' });
      check(bind2.body.code === 0, '⑪ 前置：' + NO2 + ' 已绑定');

      const wrong = await call(base, 'POST', '/auth/unbind-self',
        { no: NO2, realName: '不对的姓名' }, { 'X-Forwarded-For': '192.168.77.7', 'X-Device': 'bind-security-test' });
      check(wrong.body.code === 40301 && /核对/.test(String(wrong.body.msg || '')),
        '⑫ 生产模式：姓名不符 → 40301（不区分"工号不存在"）', 'code=' + wrong.body.code);
      check(userByNo(NO2).openid === openid2, '⑬ 姓名不符时没有被解绑');

      const right = await call(base, 'POST', '/auth/unbind-self',
        { no: NO2, realName: '王强' }, { 'X-Forwarded-For': '192.168.77.7', 'X-Device': 'bind-security-test' });
      check(right.body.code === 0 && (right.body.data || {}).hadBinding === true,
        '⑭ 生产模式：正确姓名 → 自助解绑成功且 hadBinding=true', 'data=' + JSON.stringify(right.body.data));
      check(String(userByNo(NO2).openid || '') === '', '⑮ openid 已清空');

      const third = await call(base, 'POST', '/auth/unbind-self',
        { no: NO2, realName: '王强' }, { 'X-Forwarded-For': '192.168.77.7' });
      check(third.body.code === 40001 && /已达上限/.test(String(third.body.msg || '')),
        '⑯ 同一 no 第 3 次（含 1 次姓名不符）→ 40001（频率限制与模式无关）', 'code=' + third.body.code);

      // 幂等：本就没有绑定的工号 → 成功且 hadBinding=false
      const idem = await call(base, 'POST', '/auth/unbind-self',
        { no: '2017001', realName: '孙主任' }, { 'X-Forwarded-For': '192.168.77.7' });
      check(idem.body.code === 0 && (idem.body.data || {}).hadBinding === false,
        '⑰ 未绑定的工号 → 幂等成功且 hadBinding=false', 'data=' + JSON.stringify(idem.body.data));

      // 8.5 审计与计数表
      const logs = await call(base, 'GET', '/logs?pageSize=200', undefined, { Authorization: 'Bearer ' + adm });
      const list = (logs.body.data || {}).list || [];
      const unLogs = list.filter(function (l) { return l.action === 'auth.unbind'; });
      const selfLogs = list.filter(function (l) { return l.action === 'auth.unbind.self'; });
      check(unLogs.length >= 1 && unLogs.some(function (l) { return (l.after || {}).no === NO; }),
        '⑱ 审计含 auth.unbind（记 no / realName / 原 openid 前缀脱敏）',
        unLogs.map(function (l) { return (l.after || {}).openidPrefix; }).join(','));
      check(selfLogs.length >= 3 && selfLogs.some(function (l) { return (l.after || {}).ip === '192.168.77.7'; }),
        '⑲ 审计含 auth.unbind.self（记 no、realName、IP、设备、是否确有绑定）', 'total=' + selfLogs.length);
      check(store.all('unbind_requests').length >= 2, '⑳ 计数落在新表 unbind_requests（data/unbind_requests.json）',
        'rows=' + store.all('unbind_requests').length);
      const chain = await call(base, 'GET', '/logs/verify', undefined, { Authorization: 'Bearer ' + adm });
      check(chain.body.code === 0 && chain.body.data.ok === true, '㉑ 审计哈希链完整', 'total=' + (chain.body.data || {}).total);
    }
  } finally {
    await new Promise(function (resolve) { srv.close(function () { resolve(); }); });
    store.flushAll();
  }

  console.log('\n' + '='.repeat(64));
  console.log('绑定安全专项自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
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
