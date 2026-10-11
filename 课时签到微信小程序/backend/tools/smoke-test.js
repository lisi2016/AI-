'use strict';
/**
 * 端到端自测脚本（Node 18+ 内置 fetch/FormData/Blob，无需额外依赖）
 *
 * 用法：
 *   1) 另开终端启动服务：npm start
 *   2) node tools/smoke-test.js                     # 默认 http://127.0.0.1:8081
 *      BASE=http://127.0.0.1:8081 node tools/smoke-test.js
 *
 * 覆盖契约全部 A–I 接口与「服务端必须做的校验」：
 *   A 认证绑定 / B 动态码(60s、一次性、41001/41002) / C 课表 / D 课时记录（唯一性 40901、
 *   提交人≠签字人、签字人授权名单 42202、未来日期 40001、状态机 42201、权限 40301）
 *   E 补签与申诉 / F 统计（仅 done+makeup 计入） / G 导出 CSV / H 导入（先校验后落库）
 *   I 配置 / 操作日志哈希链 / 文件鉴权
 *   动态码 A+B 双通道：generate 返回 6 位数字口令 + qrPayload(kcsq://code/<codeId>)；
 *     verify 支持 {codeId} / {code}(6 位口令) / {qrContent}(扫码内容，兼容历史载荷) 三种入参，
 *     口令在有效未消费的码中唯一、过期 41001、已消费 41002
 *   合规：定位信息已彻底移除（传入 location 不报错且不落位置数据，证据固定四项）；
 *         自由文本敏感词拦截（40001 + 审计日志）与长度限制，/config 可改且立即生效
 *   本次修复补充：
 *     · 绑定安全：DEV_MODE=1 下保留直传 openid 联调路径，但传了 bindTicket 必须校验
 *       （篡改/过期 → 40101，openid 与票据不一致 → 40301）；DEV_MODE=0 的强制票据校验
 *       见 tools/bind-security-test.js
 *     · 统计口径：GET /records 的 summary.statusTotals 不受 status= 筛选影响，
 *       按角色可见范围（教师/班干部/院系管理员/教务处）统计全部 8 种状态
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || ('http://127.0.0.1:' + (process.env.PORT || 8081));
const API = BASE + '/api/v1';
// 与被测服务使用同一数据目录（可用 DATA_DIR 覆盖，便于用独立目录跑自测而不动演示数据）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DEV_TOKEN_FILE = path.join(DATA_DIR, 'dev-login-tokens.json');

let pass = 0;
let failCount = 0;
const failures = [];

function log(s) { console.log(s); }
function ok(name, extra) { pass++; log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); log('  ✗ ' + name + '  → ' + detail); }
function assert(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail || '断言失败'); }
function section(t) { log('\n=== ' + t + ' ==='); }

async function call(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers['Authorization'] = 'Bearer ' + o.token;
  let body;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(API + p, { method: method, headers: headers, body: body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { httpStatus: res.status, status: res.status, body: json, headers: res.headers };
}

function expectCode(r, code, name) {
  const got = r.body && r.body.code;
  assert(got === code, name, 'code=' + got + ' msg=' + (r.body && r.body.msg));
  return r.body && r.body.data;
}

function pngBuffer(bytes) {
  const head = Buffer.from('89504e470d0a1a0a', 'hex');
  const tail = Buffer.from('0000000049454e44ae426082', 'hex');
  return Buffer.concat([head, Buffer.alloc(bytes || 64, 7), tail]);
}

function isoDateOffset(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 读取 server 在 DEV_MODE 下落盘的最近一次登录令牌（重复运行脚本时复用） */
function readDevToken(no) {
  try {
    const all = JSON.parse(fs.readFileSync(DEV_TOKEN_FILE, 'utf8'));
    const hit = all[String(no)];
    return hit && hit.token ? hit.token : '';
  } catch (e) { return ''; }
}

async function loginAs(prefix, role, no, realName) {
  const l = await call('POST', '/auth/login', { body: { code: prefix + Date.now() + '-' + Math.random().toString(16).slice(2) } });
  const d = l.body && l.body.data;
  if (l.body.code !== 0 || !d) throw new Error('登录失败：' + JSON.stringify(l.body));
  if (!d.needBind) return d.token;
  const b = await call('POST', '/auth/bind', { body: { openid: d.openid, role: role, no: no, realName: realName } });
  if (b.body.code === 0) return b.body.data.token;
  const saved = readDevToken(no);
  if (saved) { log('    （' + no + ' 已被绑定，复用 DEV_MODE 记录的令牌）'); return saved; }
  throw new Error('绑定失败：' + JSON.stringify(b.body));
}

async function importCsv(type, csv, token, name) {
  const form = new FormData();
  form.set('file', new Blob([csv], { type: 'text/csv' }), name || (type + '.csv'));
  const r = await call('POST', '/import/' + type, { token: token, form: form });
  const d = expectCode(r, 0, '导入 ' + type + '（' + (name || 'csv') + '）');
  return d;
}

/** 分页拉取某 token 可见范围内的全部记录（自测用：核对 statusTotals 的角色可见范围） */
async function fetchAllRecords(token, query) {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = Object.keys(query || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
    }).join('&');
    const path = '/records?' + (qs ? qs + '&' : '') + 'page=' + page + '&pageSize=200';
    const r = await call('GET', path, { token: token });
    const d = r.body && r.body.data;
    if (!r.body || r.body.code !== 0 || !d) throw new Error('拉取记录失败：' + JSON.stringify(r.body));
    const rows = d.list || [];
    rows.forEach(function (x) { out.push(x); });
    if (out.length >= Number(d.total || 0) || !rows.length || page >= 20) break;
    page++;
  }
  return out;
}

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 为某任务找一个"同星期 + 早于今天 + 无记录"的日期 */
async function freeDateOf(task, startFrom, token) {
  let d = startFrom || isoDateOffset(-1);
  for (let i = 0; i < 200; i++) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay() === 0 ? 7 : new Date(d + 'T00:00:00Z').getUTCDay();
    if (d < isoDateOffset(0) && wd === Number(task.weekday)) {
      const r = await call('GET', '/tasks/' + task.id + '?date=' + d, { token: token });
      if (r.body.code === 0 && r.body.data.task && r.body.data.task.status === 'draft') return d;
    }
    d = isoDateOffset(-(i + 2));
  }
  return '';
}

async function main() {
  log('后端自测：' + BASE);
  log('时间：' + new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (Asia/Shanghai)');

  // ---------------------------------------------------------------- 0 健康检查
  section('0. 健康检查');
  {
    const r = await call('GET', '/health');
    const d = expectCode(r, 0, 'GET /health 返回 code=0');
    if (d) assert(d.status === 'ok', '健康状态 ok', 'today=' + d.today + ' node=' + d.node + ' devMode=' + d.devMode + ' traceId=' + r.body.traceId);
    assert(r.body.traceId && r.body.traceId.length >= 8, '统一响应含 traceId');
  }

  // ---------------------------------------------------------------- 1 认证
  section('1. 登录与白名单绑定（A）');
  let teacherToken = '';
  let teacherUser = null;
  {
    const code = 'SMOKE-T1-' + Date.now();
    const r = await call('POST', '/auth/login', { body: { code: code } });
    const d = expectCode(r, 0, 'POST /auth/login 返回 code=0');
    assert(d && d.needBind === true && d.openid && d.bindTicket, 'DEV_MODE 首次登录返回 needBind + openid + bindTicket', d && d.openid);
    // 用 bindTicket 绑定（另一种入参形式）
    const b = await call('POST', '/auth/bind', { body: { bindTicket: d.bindTicket, role: 'teacher', no: '2010032', realName: '唐瑞明' } });
    if (b.body.code === 0) {
      teacherToken = b.body.data.token;
      teacherUser = b.body.data.user;
      ok('POST /auth/bind（用 bindTicket）白名单校验通过', teacherUser.name + ' / ' + teacherUser.staffId);
    } else {
      teacherToken = readDevToken('2010032');
      const me = await call('GET', '/auth/me', { token: teacherToken });
      teacherUser = me.body.data.user;
      ok('该工号已绑定，复用 DEV_MODE 令牌', teacherUser.name + '（' + b.body.msg + '）');
    }
    const bad1 = await call('POST', '/auth/bind', { body: { openid: 'x' + Date.now(), role: 'teacher', no: '2010032', realName: '张冠李戴' } });
    expectCode(bad1, 40301, '姓名与白名单不一致 → 40301');
    const bad2 = await call('POST', '/auth/bind', { body: { openid: 'x' + Date.now(), role: 'teacher', no: '9999999', realName: '唐瑞明' } });
    expectCode(bad2, 40301, '工号不在白名单 → 40301');

    // ---- 安全（bind 修复）：开发模式仍保留「直接传 openid」的联调路径，
    //      但只要传了 bindTicket，就必须校验票据有效性与 openid 一致性（不能借 DEV_MODE 绕过）
    const badTicket = await call('POST', '/auth/bind', {
      body: { bindTicket: d.bindTicket + 'x', role: 'teacher', no: '2010032', realName: '唐瑞明' },
    });
    expectCode(badTicket, 40101, '篡改 bindTicket → 40101（带票据就必须校验，开发模式不例外）');
    const mismatch = await call('POST', '/auth/bind', {
      body: { bindTicket: d.bindTicket, openid: 'smoke-forged-' + Date.now(), role: 'teacher', no: '2010032', realName: '唐瑞明' },
    });
    expectCode(mismatch, 40301, '请求体 openid 与 bindTicket 不一致 → 40301（禁止伪造他人 openid）');
    const again = await call('POST', '/auth/login', { body: { code: code } });
    const ad = expectCode(again, 0, '同一 code 再次登录');
    assert(ad.needBind === false && ad.token, '已绑定用户直接返回 token');
    teacherToken = ad.token || teacherToken;

    // 顺序敏感：该探针会按 auth.routes.js 的 DEV_MODE 规则把本工号的模拟绑定改指向新 openid
    // （旧绑定是 dev_ 前缀的模拟 openid 时允许覆盖，真实 openid 则 40301），
    // 因此必须放在上面「同一 code 再次登录」之后，否则会自己破坏被测状态。
    const forgedFree = await call('POST', '/auth/bind', {
      body: { openid: 'smoke-dev-' + Date.now(), role: 'teacher', no: '2010032', realName: '唐瑞明' },
    });
    assert(forgedFree.body.code === 40301 || forgedFree.body.code === 0,
      'DEV_MODE=1 下不带票据直接传 openid 仍可用（旧绑定为 dev_ 模拟 openid 时可覆盖 → 0，否则 40301）',
      'code=' + forgedFree.body.code + ' msg=' + forgedFree.body.msg);

    const me = await call('GET', '/auth/me', { token: teacherToken });
    const md = expectCode(me, 0, 'GET /auth/me');
    teacherUser = md.user;
    assert(md.user.role === 'teacher' && md.user.dept && md.config.codeTtlSeconds === 60,
      '返回用户 / 角色 / 授权班级 / 配置', md.user.name + ' / ' + md.user.dept + ' / codeTtl=' + md.config.codeTtlSeconds);
    expectCode(await call('GET', '/auth/me'), 40101, '未带 token → 40101');
    expectCode(await call('GET', '/auth/me', { token: 'tampered.token' }), 40101, '伪造 token → 40101');
    expectCode(await call('GET', '/auth/me', { token: teacherToken.slice(0, -2) + 'aa' }), 40101, '篡改签名 → 40101');
  }

  const cadreToken = await loginAs('SMOKE-C1-', 'cadre', '2025030117', '张一鸣');
  const cadreToken2 = await loginAs('SMOKE-C2-', 'cadre', '2025030102', '王悦');
  const adminToken = await loginAs('SMOKE-AD-', 'admin', 'ADMIN001', '教务处');
  const deptToken = await loginAs('SMOKE-DP-', 'dept_admin', '2017001', '孙主任');
  const teacher2Token = await loginAs('SMOKE-T2-', 'teacher', '2011045', '李慧');
  const teacher3Token = await loginAs('SMOKE-T3-', 'teacher', '2012088', '王强');
  let cadreUser = null;
  {
    const me = await call('GET', '/auth/me', { token: cadreToken });
    const d = expectCode(me, 0, '班干部登录（GET /auth/me）');
    cadreUser = d.user;
    assert(cadreUser.duty === '学委' && cadreUser.authorizedClassIds.length >= 1,
      '班干部身份 + 授权班级', cadreUser.duty + ' / ' + cadreUser.className);
  }
  ok('教务处 / 院系管理员 / 另两位教师 登录完成', 'admin + dept_admin + 李慧 + 王强');

  // ---------------------------------------------------------------- 2 课表
  section('2. 我的课表（C）');
  let targetTask = null;
  let targetDate = '';
  {
    const today = isoDateOffset(0);
    const r = await call('GET', '/tasks?date=' + today, { token: teacherToken });
    const d = expectCode(r, 0, 'GET /tasks?date=' + today);
    assert(Array.isArray(d), '返回任务数组', d.length + ' 条（' + today + '）');

    const week = await call('GET', '/tasks/week', { token: teacherToken });
    const wd = expectCode(week, 0, 'GET /tasks/week');
    assert((wd.list || []).length > 0 && wd.days.length === 7, '本周课表含 7 天分组',
      wd.monday + '~' + wd.sunday + '，共 ' + wd.list.length + ' 条 / ' + wd.totalHours + ' 学时');

    let candidate = null;
    for (let back = 1; back <= 8 && !candidate; back++) {
      const wk = await call('GET', '/tasks/week?week=' + (wd.week - back), { token: teacherToken });
      const wkd = expectCode(wk, 0, 'GET /tasks/week?week=' + (wd.week - back));
      for (let i = 0; i < (wkd.list || []).length; i++) {
        if (!wkd.list[i].recordId) { candidate = wkd.list[i]; break; }
      }
    }
    assert(!!candidate, '找到一组"任务 + 过去日期"且当天无记录（用于校验用例）',
      candidate && (candidate.courseName + ' / ' + candidate.className + ' / ' + candidate.section + ' / ' + candidate.fullDate));
    targetTask = candidate;
    targetDate = candidate.fullDate;

    const one = await call('GET', '/tasks/' + targetTask.id + '?date=' + targetDate, { token: teacherToken });
    const od = expectCode(one, 0, 'GET /tasks/{id}');
    assert(od.task.id === targetTask.id && od.authorizedCadres.length >= 3,
      '详情的 active 班干部名单（学委优先）',
      od.authorizedCadres.map(function (c) { return c.duty + c.name + '(p' + c.priority + ')'; }).join('、'));
    expectCode(await call('GET', '/tasks/T-NOT-EXIST', { token: teacherToken }), 40401, '任务不存在 → 40401');
    expectCode(await call('GET', '/tasks/' + targetTask.id, { token: teacher3Token }), 40301, '查看他人授课任务 → 40301');
    expectCode(await call('GET', '/tasks/' + targetTask.id, { token: cadreToken }), 40301, '班干部查课表 → 40301');
  }

  // ---------------------------------------------------------------- 3 动态码
  section('3. 动态确认码（B：60 秒 / 一次性）');
  let codeId = '';
  let codePass = '';        // 该码的 6 位数字口令（B 通道）
  let expiredCodeId = '';   // ttl=10 的过期码，供后续按 qrContent 验证 41001
  let expiredPass = '';
  {
    const g = await call('POST', '/code/generate', { token: cadreToken });
    const d = expectCode(g, 0, 'POST /code/generate（班干部）');
    codeId = d.codeId;
    codePass = d.code;
    assert(d.ttl === 60 && d.qrUrl && d.expireAt.indexOf('+08:00') > 0, '返回 codeId/qrUrl/expireAt/ttl=60', d.expireAt);

    const v = await call('POST', '/code/verify', { token: teacherToken, body: { codeId: codeId } });
    const vd = expectCode(v, 0, 'POST /code/verify（教师扫码）');
    assert(vd.cadre && vd.cadre.name === '张一鸣', '扫码返回班干部身份', vd.cadre.duty + ' ' + vd.cadre.name);
    assert(Array.isArray(vd.tasks), '返回该班当日授课任务', (vd.tasks || []).length + ' 条（' + vd.date + '）');
    expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { codeId: 'CD-NOT-EXIST' } }), 40401, '不存在的动态码 → 40401');

    expectCode(await call('POST', '/code/generate', { token: teacherToken }), 40301, '教师生成动态码 → 40301');

    const g2 = await call('POST', '/code/generate', { token: cadreToken, body: { ttl: 10 } });
    const d2 = expectCode(g2, 0, 'POST /code/generate（ttl=10）');
    expiredCodeId = d2.codeId;
    expiredPass = d2.code;
    ok('等待 11 秒验证 60 秒过期机制……');
    await new Promise(function (r) { setTimeout(r, 11000); });
    expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { codeId: d2.codeId } }), 41001, '过期动态码 → 41001');
  }

  // ---------------------------------------------------------------- 4 校验用例
  section('4. 服务端必须做的校验（D 组硬性规则）');
  {
    // 4.1 签字人不在授权名单 → 42202
    const notCadre = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: codeId, taskId: targetTask.id, teachDate: targetDate, absentCount: 0, signerId: teacher3Token ? 'U00000003' : 'U00000003' },
    });
    const c1 = notCadre.body.code;
    assert(c1 === 42202 || c1 === 40001, '签字人不在 active 名单 → 42202', 'code=' + c1 + ' msg=' + notCadre.body.msg);

    // 4.2 提交人 = 签字人（硬性规则 5.2）→ 40302
    //     数据准备：把工号 2010032（唐瑞明，同时是该班任课教师）通过白名单 + 班干部授权导入
    //     登记为该班班干部，再用同一个账号提交并指定自己为签字人
    {
      const wl = '工号/学号,姓名,角色,院系,教学班\n2010032,唐瑞明,teacher,护理学院,\n';
      await importCsv('whitelist', wl, adminToken, 'selfsign-whitelist.csv');
      const cc = '教学班,学号,姓名,职务,优先级\n2025级护理3班,2010032,唐瑞明,副班长,9\n';
      const imp = await importCsv('cadres', cc, adminToken, 'selfsign-cadres.csv');
      assert(imp.committed === true, '准备数据：唐瑞明登记为该班班干部', imp.msg);
      const me = await call('GET', '/auth/me', { token: teacherToken });
      const selfId = me.body.data.user.id;
      const self = await call('POST', '/records', {
        token: teacherToken,
        body: { codeId: codeId, taskId: targetTask.id, teachDate: targetDate, absentCount: 0, signerId: selfId },
      });
      const c2 = self.body.code;
      assert(c2 === 40302, '提交人 == 签字人 → 40302（需求 5.2 硬性）', 'code=' + c2 + ' msg=' + self.body.msg);
    }

    // 4.3 未来日期 → 40001
    expectCode(await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: codeId, taskId: targetTask.id, teachDate: isoDateOffset(3), absentCount: 0, signerId: cadreUser.id },
    }), 40001, 'teachDate 为未来日期 → 40001');

    // 4.4 缺参 → 40001；任务不存在 → 40401
    expectCode(await call('POST', '/records', { token: teacherToken, body: { teachDate: targetDate } }), 40001, '缺少 taskId → 40001');
    expectCode(await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: codeId, taskId: 'T-NOT-EXIST', teachDate: targetDate, absentCount: 0, signerId: cadreUser.id },
    }), 40401, 'taskId 不存在 → 40401');

    // 4.5 正常发起（带动态码）
    const r = await call('POST', '/records', {
      token: teacherToken,
      body: {
        codeId: codeId, taskId: targetTask.id, teachDate: targetDate,
        absentCount: 2, absentNames: '李思琪、王悦', discipline: 'good',
        summary: 'SmokeTest 授课摘要（第 1 章）', signerId: cadreUser.id,
        location: { lat: 28.228209, lng: 112.938814 }, locationDenied: false, device: 'SmokeTest Device',
      },
    });
    const d = expectCode(r, 0, 'POST /records 发起成功（状态 wait）');
    assert(d.status === 'wait' && d.signerName === '张一鸣' && d.signerDuty === '学委' && d.signerIsAdHoc === false,
      '返回记录字段与前端对齐（camelCase）', d.id + ' / ' + d.courseName + ' / ' + d.className + ' / ' + d.date + ' / ' + d.hours + '学时');
    assert(d.confirmer === '' && d.signature === '' && d.deadlineAt.indexOf('+08:00') > 0,
      '未签名时为空 + deadline 为 Asia/Shanghai ISO8601', d.deadlineAt);
    assert(d.location === undefined && d.latitude === undefined && d.longitude === undefined && d.locationDenied === undefined,
      '传入 location/locationDenied 不报错，且响应不含任何位置字段',
      Object.keys(d).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); }).join(',') || '无位置字段');
    assert((d.warnings || []).length === 0, '正常文本无脱敏 warning', JSON.stringify(d.warnings));

    // 4.6 唯一性 → 40901
    expectCode(await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: codeId, taskId: targetTask.id, teachDate: targetDate, absentCount: 0, signerId: cadreUser.id },
    }), 40901, '同一 teacher+course+class+date+section 重复发起 → 40901');

    // 4.7 动态码一次性 → 41002（换一条记录触发码校验）
    let otherTask = null;
    for (let back = 2; back <= 8 && !otherTask; back++) {
      const wk = await call('GET', '/tasks/week?week=' + (1 - back + 5), { token: teacherToken });
      const wkd = wk.body.data;
      for (let i = 0; i < (wkd.list || []).length; i++) {
        if (!wkd.list[i].recordId && wkd.list[i].id !== targetTask.id) { otherTask = wkd.list[i]; break; }
      }
    }
    if (otherTask) {
      expectCode(await call('POST', '/records', {
        token: teacherToken,
        body: { codeId: codeId, taskId: otherTask.id, teachDate: otherTask.fullDate, absentCount: 0, signerId: cadreUser.id },
      }), 41002, '已消费的动态码再次使用 → 41002');
    }
  }

  // ---------------------------------------------------------------- 4b 动态码 A+B 双通道
  section('4b. 动态码 A+B 双通道（A 扫码 qrContent / B 6 位口令 / codeId 直传）');
  {
    // --- generate 双通道字段
    const g = await call('POST', '/code/generate', { token: cadreToken });
    const d = expectCode(g, 0, 'POST /code/generate 返回双通道字段');
    assert(/^\d{6}$/.test(String(d.code)), 'B 通道：返回 6 位数字口令（恰好 6 位数字）', 'code=' + d.code);
    assert(d.codeLength === 6, '返回 codeLength=6', 'codeLength=' + d.codeLength);
    assert(d.qrPayload === 'kcsq://code/' + d.codeId, 'A 通道：qrPayload = kcsq://code/<codeId>', d.qrPayload);
    assert(d.qrUrl === d.qrPayload, 'qrUrl 作为兼容别名与 qrPayload 一致', d.qrUrl);
    assert(d.channels && d.channels.qr && d.channels.qr.payload === d.qrPayload &&
      d.channels.code && d.channels.code.value === d.code,
      'channels 同时下发 A 二维码载荷与 B 口令', JSON.stringify(d.channels));

    // --- 同一 codeId 的三条通道都能核验成功
    const vByQr = await call('POST', '/code/verify', { token: teacherToken, body: { qrContent: d.qrPayload } });
    const dQr = expectCode(vByQr, 0, 'A 通道：按 qrContent 核验成功');
    assert(dQr.codeId === d.codeId && dQr.channel === 'qr' && dQr.verifyBy === 'qrContent',
      'qrContent 解析到同一 codeId，且回显 channel=qr', dQr.codeId + ' / ' + dQr.channel + ' / ' + dQr.verifyBy);
    assert(dQr.cadre && dQr.cadre.name === '张一鸣' && Array.isArray(dQr.tasks),
      'qrContent 核验返回班干部身份 + 当日授课任务', dQr.cadre.duty + dQr.cadre.name + ' / ' + dQr.tasks.length + ' 条');

    const vByCode = await call('POST', '/code/verify', { token: teacherToken, body: { code: d.code } });
    const dCode = expectCode(vByCode, 0, 'B 通道：按 6 位口令核验成功');
    assert(dCode.codeId === d.codeId && dCode.channel === 'code' && dCode.verifyBy === 'code',
      '口令解析到同一 codeId，且回显 channel=code', dCode.codeId + ' / ' + dCode.channel);

    const vById = await call('POST', '/code/verify', { token: teacherToken, body: { codeId: d.codeId } });
    const dId = expectCode(vById, 0, '按 codeId 直传核验成功');
    assert(dId.codeId === d.codeId && dId.channel === 'codeId' && dId.verifyBy === 'codeId',
      'codeId 直传仍可用（兼容旧客户端）', dId.channel);

    // --- 历史二维码载荷兼容 + 无法识别的扫码内容
    const legacy = await call('POST', '/code/verify', {
      token: teacherToken,
      body: { qrContent: 'kcsq://confirm?codeId=' + d.codeId + '&sign=x&exp=1' },
    });
    const legacyD = expectCode(legacy, 0, '兼容历史二维码载荷 kcsq://confirm?codeId=..');
    assert(legacyD && legacyD.codeId === d.codeId, '历史载荷解析到同一 codeId', legacyD && legacyD.codeId);
    expectCode(await call('POST', '/code/verify', {
      token: teacherToken, body: { qrContent: 'https://example.com/not-a-kcsq-code' },
    }), 40401, '无法识别的扫码内容 → 40401');
    expectCode(await call('POST', '/code/verify', { token: teacherToken, body: {} }), 40001, '三种入参都缺失 → 40001');
    expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { code: '000000' } }), 40401, '不存在/已失效的口令 → 40401');

    // --- 过期：A 通道 qrContent 同样返回 41001；B 通道口令同样返回 41001
    expectCode(await call('POST', '/code/verify', {
      token: teacherToken, body: { qrContent: 'kcsq://code/' + expiredCodeId },
    }), 41001, '过期码按 qrContent 核验 → 41001');
    if (expiredPass) {
      expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { code: expiredPass } }), 41001,
        '过期码按 6 位口令核验 → 41001');
    }

    // --- 已消费：三条通道统一 41002（第 4 节 4.5 用 codeId 发起记录时已消费）
    const probe = await call('POST', '/code/verify', { token: teacherToken, body: { codeId: codeId } });
    assert(probe.body.code === 41002, '第 4 节发起记录后该码已被消费（一次性）', 'code=' + probe.body.code + ' msg=' + probe.body.msg);
    if (probe.body.code === 41002) {
      assert(probe.body.msg && /已.{0,4}使用/.test(probe.body.msg), '41002 返回中文明确提示', probe.body.msg);
      expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { qrContent: 'kcsq://code/' + codeId } }),
        41002, '已消费码按 qrContent 核验 → 41002');
      if (codePass) {
        expectCode(await call('POST', '/code/verify', { token: teacherToken, body: { code: codePass } }), 41002,
          '已消费码按 6 位口令核验 → 41002');
      }
    }

    // --- 口令在「当前有效且未消费」的码中唯一：连续签发 12 个码，口令不重复
    const passes = [];
    for (let i = 0; i < 12; i++) {
      const gi = await call('POST', '/code/generate', { token: cadreToken });
      const di = expectCode(gi, 0, 'POST /code/generate（唯一性用例 ' + (i + 1) + '/12）');
      passes.push(di.code);
    }
    const uniq = Array.from(new Set(passes));
    assert(uniq.length === passes.length && passes.every(function (p) { return /^\d{6}$/.test(p); }),
      '连续签发 12 个码：6 位口令互不重复', '示例 ' + passes.slice(0, 3).join('、') + ' … 共 ' + uniq.length + ' 个');
  }

  // ---------------------------------------------------------------- 5 今天记录 + 状态机
  section('5. 当日记录：签名确认 → 状态机（D 组）');
  let todayRecordId = '';
  let oldRecordId = '';
  {
    // 5.1 准备一条"今天"的授课任务（周日通常没课，用导入补一条今天该教师的任务）
    const today = isoDateOffset(0);
    const weekdayCn = WEEKDAY_CN[new Date(today + 'T00:00:00Z').getUTCDay() === 0 ? 7 : new Date(today + 'T00:00:00Z').getUTCDay()];
    const SMOKE_COURSE = 'SmokeTest 当日课';
    let todayTask = null;
    {
      const t = await call('GET', '/tasks?date=' + today, { token: teacherToken });
      const td = expectCode(t, 0, 'GET /tasks?date=' + today);
      // 优先复用同一门"SmokeTest 当日课"（可重复运行时幂等），其次任意当天未发起任务
      todayTask = td.filter(function (x) { return x.courseName === SMOKE_COURSE && !x.recordId; })[0]
        || td.filter(function (x) { return !x.recordId; })[0] || null;
      if (!todayTask) {
        const csv = '学期,工号,教师姓名,课程代码,课程名称,教学班,星期,节次,开始,结束,地点,周次,学时\n' +
          '2026-2027-1,2010032,唐瑞明,SMK001,' + SMOKE_COURSE + ',2025级护理3班,' + weekdayCn + ',7-8,16:00,17:40,实训楼D001,1-18,2\n';
        const imp = await importCsv('tasks', csv, adminToken, 'smoke-today-task.csv');
        assert(imp.committed === true, '导入一条"当天"授课任务（' + weekdayCn + ' 7-8 节）', imp.msg);
        const t2 = await call('GET', '/tasks?date=' + today, { token: teacherToken });
        todayTask = expectCode(t2, 0, '重新获取当天任务').filter(function (x) { return !x.recordId; })[0];
      }
    }
    assert(!!todayTask, '拿到当天可用于发起的授课任务', todayTask.courseName + ' / ' + todayTask.className + ' / ' + todayTask.section);

    // 5.2 动态码 → 发起
    const g = await call('POST', '/code/generate', { token: cadreToken });
    const gd = expectCode(g, 0, '班干部重新签发动态码');
    const r = await call('POST', '/records', {
      token: teacherToken,
      body: {
        codeId: gd.codeId, taskId: todayTask.id, teachDate: today,
        absentCount: 0, absentNames: '', discipline: 'normal',
        summary: '当天正常授课，学生到课良好', signerId: cadreUser.id,
        location: { lat: 28.228209, lng: 112.938814 }, device: 'SmokeTest Device',
      },
    });
    const d = expectCode(r, 0, '发起当天课时确认');
    todayRecordId = d.id;
    assert(d.status === 'wait' && d.canSign !== undefined, '状态 wait', d.id);
    // 教师视角按钮状态
    const tview = await call('GET', '/records/' + todayRecordId, { token: teacherToken });
    const tv = expectCode(tview, 0, '教师查看该记录');
    assert(tv.canUrge === true && tv.canRevoke === true && tv.canSign === false, '教师按钮状态 canUrge/canRevoke=true, canSign=false');
    // 班干部视角
    const cview = await call('GET', '/records/' + todayRecordId, { token: cadreToken });
    const cv = expectCode(cview, 0, '班干部查看该记录');
    assert(cv.canSign === true && cv.canReject === true, '班干部按钮状态 canSign/canReject=true');

    // 5.3 越权与非法状态
    const f0 = new FormData();
    f0.set('signature', new Blob([pngBuffer()], { type: 'image/png' }), 'sign.png');
    expectCode(await call('POST', '/records/' + todayRecordId + '/sign', { token: teacherToken, form: f0 }), 40301, '教师调用 /sign → 40301');
    const f1 = new FormData();
    f1.set('signature', new Blob([pngBuffer()], { type: 'image/png' }), 'sign.png');
    expectCode(await call('POST', '/records/' + todayRecordId + '/sign', { token: cadreToken2, form: f1 }), 40301, '非指定签字人签名 → 40301');
    expectCode(await call('POST', '/records/' + todayRecordId + '/reject', { token: cadreToken, body: {} }), 40001, '拒绝未填原因 → 40001');

    // 5.4 签名图校验：非图片 / 空文件
    const fBad = new FormData();
    fBad.set('signature', new Blob([Buffer.from('not-an-image')], { type: 'text/plain' }), 'a.txt');
    expectCode(await call('POST', '/records/' + todayRecordId + '/sign', { token: cadreToken, form: fBad }), 40001, '签名图非 png/jpg → 40001');

    // 5.5 正常签名（multipart 字段名 signature）
    const form = new FormData();
    form.set('signature', new Blob([pngBuffer(128)], { type: 'image/png' }), 'sign.png');
    form.set('lat', '28.228209');
    form.set('lng', '112.938814');
    form.set('device', 'SmokeTest iPhone 15');
    const s = await call('POST', '/records/' + todayRecordId + '/sign', { token: cadreToken, form: form });
    const sd = expectCode(s, 0, 'POST /records/{id}/sign → done');
    assert(sd.status === 'done' && sd.confirmedAt, '状态变为 done', 'confirmedAt=' + sd.confirmedAt);
    assert(sd.signature === '/api/v1/files/' + sd.signatureFileId && sd.signatureHash,
      '返回带鉴权的签名图地址 + imageHash', sd.signature + ' hash=' + String(sd.signatureHash).slice(0, 16) + '…');
    assert(sd.confirmer === '学委 张一鸣' && sd.device === 'SmokeTest iPhone 15',
      'confirmer = 职务 + 姓名，设备留痕', sd.confirmer + ' / ' + sd.device);
    assert(sd.location === undefined && sd.latitude === undefined && sd.longitude === undefined && sd.locationDenied === undefined,
      '签名时传入 lat/lng 被忽略且不报错，响应无位置字段',
      Object.keys(sd).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); }).join(',') || '无位置字段');

    // 5.6 done 不可再改
    expectCode(await call('POST', '/records/' + todayRecordId + '/reject', { token: cadreToken, body: { reason: '想改' } }), 42201, 'done 再拒绝 → 42201');
    const f2 = new FormData();
    f2.set('signature', new Blob([pngBuffer()], { type: 'image/png' }), 'sign.png');
    expectCode(await call('POST', '/records/' + todayRecordId + '/sign', { token: cadreToken, form: f2 }), 42201, 'done 再签名 → 42201');

    // 5.7 拒绝流程（另取一条"过去日期 + 无记录"的课，避免与已签名记录冲突）
    const g2 = await call('POST', '/code/generate', { token: cadreToken });
    const g2d = expectCode(g2, 0, '再次签发动态码');
    let rejTask = targetTask;
    let rejDate = await freeDateOf(rejTask, isoDateOffset(-1), adminToken);
    if (!rejDate) {
      const csv = '学期,工号,教师姓名,课程代码,课程名称,教学班,星期,节次,开始,结束,地点,周次,学时\n' +
        '2026-2027-1,2010032,唐瑞明,SMK002,SmokeTest 拒绝用例课,2025级护理3班,' +
        WEEKDAY_CN[new Date(isoDateOffset(0) + 'T00:00:00Z').getUTCDay() === 0 ? 7 : new Date(isoDateOffset(0) + 'T00:00:00Z').getUTCDay()] +
        ',9-10,19:00,20:40,实训楼D002,1-18,2\n';
      await importCsv('tasks', csv, adminToken, 'smoke-reject-task.csv');
      const list = expectCode(await call('GET', '/tasks?date=' + isoDateOffset(0), { token: teacherToken }), 0, '取当天任务（拒绝用例）');
      rejTask = list.filter(function (x) { return !x.recordId; })[0];
      rejDate = rejTask ? isoDateOffset(0) : '';
    }
    const rr = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: g2d.codeId, taskId: rejTask.id, teachDate: rejDate, absentCount: 1, absentNames: '周舟', signerId: cadreUser.id, summary: '拒绝用例' },
    });
    const rd = expectCode(rr, 0, '再发起一条（用于拒绝与撤销流程）');
    oldRecordId = rd.id;
    const rej = await call('POST', '/records/' + oldRecordId + '/reject', { token: cadreToken, body: { reason: '当天实际为自习' } });
    const rjd = expectCode(rej, 0, '班干部拒绝（原因必填校验通过）');
    assert(rjd.status === 'rejected' && rjd.note === '班干部拒绝：当天实际为自习', '状态 rejected + 记录拒绝原因', rjd.note);
    expectCode(await call('POST', '/records/' + oldRecordId + '/reject', { token: cadreToken, body: { reason: '再来一次' } }), 42201, 'rejected 再拒绝 → 42201');

    // 5.8 撤销与审计（契约：任意 → revoked，写日志）
    const revoked = expectCode(await call('POST', '/records/' + oldRecordId + '/revoke', { token: teacherToken, body: { reason: '记录有误，撤销重发' } }), 0, '教师撤销该记录');
    assert(revoked.status === 'revoked', '状态变为 revoked', revoked.status + ' note=' + revoked.note);
    expectCode(await call('POST', '/records/' + oldRecordId + '/revoke', { token: teacherToken, body: {} }), 42201, '重复撤销 → 42201（不可恢复）');
    const revokeLog = await call('GET', '/logs?action=record.revoke&targetId=' + oldRecordId, { token: adminToken });
    const rld = expectCode(revokeLog, 0, '撤销已写入操作日志（hash 链）');
    assert(rld.total >= 1 && rld.list[0].hash, '撤销日志含 hash', rld.list[0].action + ' by ' + rld.list[0].actorName);
  }

  // ---------------------------------------------------------------- 6 详情 / 证据 / 文件
  section('6. 记录详情、签名证据四项与文件鉴权（D / I）');
  {
    const r = await call('GET', '/records/' + todayRecordId, { token: teacherToken });
    const d = expectCode(r, 0, 'GET /records/{id}');
    assert(d.evidence.count === 4 && (d.evidence.labels || []).join('/') === '签名图/确认时间/设备/动态码',
      '证据固定四项（签名图/确认时间/设备/动态码）', 'count=' + d.evidence.count + ' labels=' + (d.evidence.labels || []).join('、'));
    assert(d.evidence.signatureUrl && d.evidence.signatureFileId, '证据①签名图（带鉴权读取地址）', d.evidence.signatureUrl);
    assert(d.evidence.confirmedAt && d.evidence.signedAt, '证据②确认时间', d.evidence.signedAt);
    assert(d.evidence.device, '证据③设备', d.evidence.device);
    assert(d.evidence.codeId && d.evidence.imageHash && d.evidence.imageHash.length === 64, '证据④动态码 + 图片 SHA-256', d.evidence.imageHash.slice(0, 16) + '…');
    const evLocKeys = Object.keys(d.evidence).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); });
    assert(evLocKeys.length === 0, '证据中不含位置字段（无 location/latitude/longitude/locationDenied）', evLocKeys.join(',') || '无位置字段');
    const recLocKeys = Object.keys(d).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); });
    assert(recLocKeys.length === 0, '记录详情不含位置字段', recLocKeys.join(',') || '无位置字段');
    assert(d.status === 'done' && d.counted === true && d.auditTail.length >= 2, '审计轨迹 + counted 标记', d.auditTail.map(function (a) { return a.action; }).join(','));

    // 落库层复核：记录与签名行都不含位置数据（定位已从设计中彻底移除）
    await new Promise(function (x) { setTimeout(x, 300); });
    let recRow = null;
    let sigRow = null;
    try {
      recRow = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'period_records.json'), 'utf8')) || [])
        .filter(function (x) { return String(x.id) === String(todayRecordId); })[0] || null;
    } catch (e) { recRow = null; }
    try {
      sigRow = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'signatures.json'), 'utf8')) || [])
        .filter(function (x) { return String(x.record_id) === String(todayRecordId); })[0] || null;
    } catch (e) { sigRow = null; }
    assert(!!recRow && !('location' in recRow) && !('latitude' in recRow) && !('longitude' in recRow),
      't_period_record 无任何位置列（落库层复核）', recRow ? '记录 ' + recRow.id : '未找到记录行');
    assert(!!sigRow && sigRow.latitude === null && sigRow.longitude === null && sigRow.location_denied === null,
      't_signature 位置三列固定为 null（落库层复核）',
      sigRow ? JSON.stringify({ latitude: sigRow.latitude, longitude: sigRow.longitude, location_denied: sigRow.location_denied }) : '未找到签名行');

    const img = await fetch(BASE + d.evidence.signatureUrl, { headers: { Authorization: 'Bearer ' + teacherToken } });
    assert(img.status === 200 && String(img.headers.get('content-type')).indexOf('image') === 0,
      '签名图带 token 可读取', 'HTTP ' + img.status + ' ' + img.headers.get('content-type'));
    const noTok = await fetch(BASE + d.evidence.signatureUrl);
    assert(noTok.status === 401, '签名图不带 token → 401（不公开访问）', 'HTTP ' + noTok.status);

    const img2 = await fetch(BASE + d.evidence.signatureUrl, { headers: { Authorization: 'Bearer ' + adminToken } });
    assert(img2.status === 200, '教务处可查看签名证据', 'HTTP ' + img2.status);

    const rejected = await call('GET', '/records/' + oldRecordId, { token: teacherToken });
    const rjd = expectCode(rejected, 0, '被拒绝记录的详情');
    assert(rjd.signature === '' && rjd.counted === false, '未签名记录 signature 为空且不计入正式学时');

    expectCode(await call('GET', '/records/R-NOT-EXIST', { token: teacherToken }), 40401, '记录不存在 → 40401');
    // 班干部 token2（非签字人、非本班）访问无关记录
    const strangerRec = await call('GET', '/records/' + todayRecordId, { token: cadreToken2 });
    const src = strangerRec.body.code;
    assert(src === 0 || src === 40301, '同班其他班干部可协作查看（或越权 40301）', 'code=' + src);
  }

  // ---------------------------------------------------------------- 7 列表与权限
  section('7. 列表筛选与角色权限（D）');
  {
    const mine = await call('GET', '/records?page=1&pageSize=5', { token: teacherToken });
    const d = expectCode(mine, 0, 'GET /records（教师本人）');
    assert(d.list.length <= 5 && d.pageSize === 5 && typeof d.total === 'number',
      '分页结构 list/total/page/pageSize', JSON.stringify({ total: d.total, page: d.page, pageSize: d.pageSize }));
    assert(d.list.every(function (x) { return x.teacherName === '唐瑞明'; }), '教师只能看到本人记录');

    const cadres = await call('GET', '/records?status=wait', { token: cadreToken });
    const cd = expectCode(cadres, 0, 'GET /records?status=wait（班干部）');
    assert(cd.list.every(function (x) { return x.signerId === cadreUser.id && x.status === 'wait'; }),
      '班干部只看到"待本人确认"的记录', cd.total + ' 条');

    const byRange = await call('GET', '/records?from=' + targetDate + '&to=' + targetDate, { token: adminToken });
    const rd = expectCode(byRange, 0, 'GET /records?from&to（教务处）');
    assert(rd.total >= 1 && rd.list.every(function (x) { return x.fullDate === targetDate; }), 'from/to 过滤生效', rd.total + ' 条');

    const multi = await call('GET', '/records?status=done,makeup', { token: adminToken });
    const md = expectCode(multi, 0, 'GET /records?status=done,makeup（多状态）');
    assert(md.list.every(function (x) { return ['done', 'makeup'].indexOf(x.status) >= 0; }), '多状态过滤生效', md.total + ' 条');

    expectCode(await call('GET', '/logs', { token: cadreToken }), 40301, '班干部访问 /logs → 40301');
    const otherTeacher = await call('GET', '/records?status=wait', { token: teacher2Token });
    const ot = expectCode(otherTeacher, 0, '另一位教师（李慧）查看自己的待确认记录');
    assert(ot.list.every(function (x) { return x.teacherName === '李慧'; }), '教师之间记录互不可见', ot.total + ' 条');

    // ---- 本次修复：summary.statusTotals（各状态数量角标，不受 status= 筛选影响，按角色可见范围统计）
    const STATUS_KEYS = ['draft', 'wait', 'done', 'rejected', 'expired', 'appealing', 'makeup', 'revoked'];
    const sumTotals = function (t) {
      return STATUS_KEYS.reduce(function (a, k) { return a + Number((t || {})[k] || 0); }, 0);
    };

    const waitAdmin = await call('GET', '/records?status=wait&pageSize=200', { token: adminToken });
    const wad = expectCode(waitAdmin, 0, 'GET /records?status=wait（教务处；校验 statusTotals）');
    const totalsFiltered = (wad.summary || {}).statusTotals;
    assert(!!totalsFiltered && typeof totalsFiltered === 'object',
      'summary 新增 statusTotals 字段', JSON.stringify(totalsFiltered));
    assert(STATUS_KEYS.every(function (k) { return typeof totalsFiltered[k] === 'number'; }),
      'statusTotals 固定覆盖全部 8 种状态且为数字（无记录为 0）',
      STATUS_KEYS.map(function (k) { return k + '=' + totalsFiltered[k]; }).join(' '));
    assert(typeof wad.summary.hours === 'number' && !!wad.summary.byStatus,
      '原有 summary.hours / summary.byStatus 字段保留（向后兼容）',
      'hours=' + wad.summary.hours + ' byStatus=' + JSON.stringify(wad.summary.byStatus));
    assert(wad.total >= 1 && Object.keys(wad.summary.byStatus).length === 1 &&
      Number(wad.summary.byStatus.wait || 0) === wad.total,
      'byStatus 仍受 status= 影响（status=wait 时只剩 wait，语义不变）',
      JSON.stringify(wad.summary.byStatus) + ' total=' + wad.total);

    const plain = await call('GET', '/records?pageSize=1', { token: adminToken });
    const pld = expectCode(plain, 0, 'GET /records（教务处；不带 status=）');
    const totalsPlain = (pld.summary || {}).statusTotals || {};
    assert(JSON.stringify(totalsPlain) === JSON.stringify(totalsFiltered),
      'statusTotals 不随 status= 变化（status=wait 与不筛选完全一致）',
      'filtered=' + JSON.stringify(totalsFiltered) + ' plain=' + JSON.stringify(totalsPlain));
    assert(sumTotals(totalsPlain) === pld.total,
      '教务处 statusTotals 合计 == 全部可见记录数（可见范围=全校）',
      sumTotals(totalsPlain) + ' vs ' + pld.total);

    // 教师：可见范围 = 本人
    const tRecs = await call('GET', '/records?pageSize=1', { token: teacherToken });
    const trd2 = expectCode(tRecs, 0, 'GET /records（教师；校验 statusTotals 可见范围）');
    const tTotals = (trd2.summary || {}).statusTotals || {};
    const tAll = await fetchAllRecords(teacherToken, {});
    const tOwnCounts = {};
    tAll.forEach(function (x) { tOwnCounts[x.status] = (tOwnCounts[x.status] || 0) + 1; });
    assert(sumTotals(tTotals) === trd2.total && tAll.length === trd2.total,
      '教师 statusTotals 合计 == 本人可见记录数',
      sumTotals(tTotals) + ' / 全量 ' + tAll.length + ' vs total=' + trd2.total);
    assert(STATUS_KEYS.every(function (k) { return Number(tTotals[k] || 0) === Number(tOwnCounts[k] || 0); }),
      '教师各状态计数与本人记录逐一吻合',
      STATUS_KEYS.map(function (k) { return k + ':' + Number(tTotals[k] || 0) + '/' + Number(tOwnCounts[k] || 0); }).join(' '));
    assert(tAll.every(function (x) { return x.teacherName === '唐瑞明'; }),
      '教师全量列表仍只有本人记录（可见范围正确）', tAll.length + ' 条');
    assert(sumTotals(tTotals) < sumTotals(totalsPlain),
      '教师可见范围严格小于教务处（不越权统计）', sumTotals(tTotals) + ' < ' + sumTotals(totalsPlain));

    // 班干部：可见范围 = 指定由本人确认的（含 draft/appealing/revoked 等全部 8 状态，不受默认可见状态收窄影响）
    const allRecs = await fetchAllRecords(adminToken, {});
    const mineAsSigner = allRecs.filter(function (x) { return String(x.signerId) === String(cadreUser.id); });
    const signerCounts = {};
    mineAsSigner.forEach(function (x) { signerCounts[x.status] = (signerCounts[x.status] || 0) + 1; });
    const cRecs = await call('GET', '/records?pageSize=1', { token: cadreToken });
    const crd2 = expectCode(cRecs, 0, 'GET /records（班干部；校验 statusTotals 可见范围）');
    const cTotals = (crd2.summary || {}).statusTotals || {};
    assert(Object.keys(cTotals).length === 8 && sumTotals(cTotals) === mineAsSigner.length,
      '班干部 statusTotals 固定 8 状态，且合计 == 签字人为本人的记录数',
      Object.keys(cTotals).length + ' 键 / ' + sumTotals(cTotals) + ' vs ' + mineAsSigner.length);
    assert(STATUS_KEYS.every(function (k) { return Number(cTotals[k] || 0) === Number(signerCounts[k] || 0); }),
      '班干部各状态计数与"签字人本人全量记录"逐一吻合',
      STATUS_KEYS.map(function (k) { return k + ':' + Number(cTotals[k] || 0) + '/' + Number(signerCounts[k] || 0); }).join(' '));
    assert(sumTotals(cTotals) >= crd2.total,
      '班干部 statusTotals 口径 ≥ 默认列表条数（默认列表会被"默认可见状态"收窄，角标不受收窄影响）',
      sumTotals(cTotals) + ' >= ' + crd2.total + '（角标含全部 8 状态）');

    // 院系管理员：可见范围 = 本院系
    const dRecs = await call('GET', '/records?pageSize=1', { token: deptToken });
    const drd2 = expectCode(dRecs, 0, 'GET /records（院系管理员；校验 statusTotals 可见范围）');
    const dTotals = (drd2.summary || {}).statusTotals || {};
    const deptAll = await fetchAllRecords(deptToken, {});
    const deptIds = Array.from(new Set(deptAll.map(function (x) { return String(x.deptId); })));
    assert(deptIds.length === 1, '院系管理员仅看本院系记录（列表内 deptId 唯一）', deptIds.join(','));
    const deptScoped = allRecs.filter(function (x) { return String(x.deptId) === String(deptIds[0]); });
    const deptCounts = {};
    deptScoped.forEach(function (x) { deptCounts[x.status] = (deptCounts[x.status] || 0) + 1; });
    assert(sumTotals(dTotals) === deptScoped.length,
      '院系管理员 statusTotals 合计 == 本院系记录数',
      sumTotals(dTotals) + ' vs ' + deptScoped.length);
    assert(STATUS_KEYS.every(function (k) { return Number(dTotals[k] || 0) === Number(deptCounts[k] || 0); }),
      '院系管理员各状态计数与本院系记录逐一吻合',
      STATUS_KEYS.map(function (k) { return k + ':' + Number(dTotals[k] || 0) + '/' + Number(deptCounts[k] || 0); }).join(' '));
    assert(sumTotals(dTotals) <= sumTotals(totalsPlain) && deptScoped.length < allRecs.length,
      '院系管理员可见范围 ⊆ 教务处，且严格小于全校（按院系隔离生效）',
      sumTotals(dTotals) + ' ≤ ' + sumTotals(totalsPlain) + ' / ' + deptScoped.length + ' < ' + allRecs.length);
  }

  // ---------------------------------------------------------------- 8 幂等
  section('8. 幂等（Idempotency-Key，24h 内同 Key 返回首次结果）');
  {
    // 自建一条 wait 记录用于幂等与提醒校验，避免影响前面的用例
    const idemDate = await freeDateOf(targetTask, isoDateOffset(-1), adminToken);
    const idemCode = expectCode(await call('POST', '/code/generate', { token: cadreToken }), 0, '签发动态码（幂等用例）');
    const idemRec = expectCode(await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: idemCode.codeId, taskId: targetTask.id, teachDate: idemDate, absentCount: 0, signerId: cadreUser.id, summary: '幂等用例' },
    }), 0, '新建一条 wait 记录用于幂等校验');
    const id = idemRec.id;

    const key = 'smoke-idem-' + Date.now();
    const r1 = await call('POST', '/records/' + id + '/reject', {
      token: cadreToken, headers: { 'Idempotency-Key': key }, body: { reason: '课程内容与课表不符' },
    });
    const r2 = await call('POST', '/records/' + id + '/reject', {
      token: cadreToken, headers: { 'Idempotency-Key': key }, body: { reason: '课程内容与课表不符' },
    });
    const d1 = expectCode(r1, 0, '第一次拒绝（带 Idempotency-Key）');
    const d2 = expectCode(r2, 0, '第二次同 Key 调用');
    assert(d1.status === 'rejected' && d2.status === 'rejected', '第一次生效（wait → rejected）', d1.id + ' ' + d1.status);
    assert(JSON.stringify(r1.body.data) === JSON.stringify(r2.body.data), '两次返回体完全一致（幂等命中，未重复执行）');
    assert(r2.headers.get('idempotent-replay') === 'true', '响应头 Idempotent-Replay: true', String(r2.headers.get('idempotent-replay')));
    expectCode(await call('POST', '/records/' + id + '/reject', {
      token: cadreToken, headers: { 'Idempotency-Key': key + '-b' }, body: { reason: '再来一次' },
    }), 42201, '新 Key 重复拒绝 → 42201（状态机拦截，证明首次仅执行一次）');

    // 提醒：sign 之后再提醒会被状态机拦下，所以这里直接在 wait 记录上验证
    const urgeDate = await freeDateOf(targetTask, isoDateOffset(-1), adminToken);
    const urgeCode = expectCode(await call('POST', '/code/generate', { token: cadreToken }), 0, '签发动态码（提醒用例）');
    const urgeRec = expectCode(await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: urgeCode.codeId, taskId: targetTask.id, teachDate: urgeDate, absentCount: 0, signerId: cadreUser.id, summary: '提醒用例' },
    }), 0, '新建一条 wait 记录用于提醒校验');
    expectCode(await call('POST', '/records/' + urgeRec.id + '/urge', { token: teacher2Token }), 40301, '他人提醒签字人 → 40301');
    const ud = expectCode(await call('POST', '/records/' + urgeRec.id + '/urge', { token: teacherToken }), 0, 'POST /records/{id}/urge（教师提醒）');
    assert(ud.ok === true && ud.urgeCount === 1 && ud.channel === 'in-app' && ud.signerId === cadreUser.id,
      '提醒成功并记录次数/通道/签字人', ud.msg);
    expectCode(await call('POST', '/records/' + urgeRec.id + '/urge', { token: teacherToken }), 42201, '冷却期内重复提醒 → 42201');
    const urgeLog = await call('GET', '/logs?action=record.urge&targetId=' + urgeRec.id, { token: adminToken });
    const ulg = expectCode(urgeLog, 0, '提醒已写操作日志');
    assert(ulg.total >= 1, '提醒留痕', ulg.total + ' 条');
  }

  // ---------------------------------------------------------------- 9 统计
  section('9. 统计（F：仅 done/makeup 计入正式学时，合班按 task 统计）');
  {
    const ov = await call('GET', '/stats/overview', { token: adminToken });
    const d = expectCode(ov, 0, 'GET /stats/overview');
    assert(typeof d.confirmedHours === 'number' && d.confirmedHours > 0, '已确认学时 > 0', d.confirmedHours + ' 学时');
    assert(typeof d.waiting === 'number' && typeof d.expired === 'number' && typeof d.abnormal === 'number',
      '已确认学时 / 待确认数 / 过期数 / 异常数',
      JSON.stringify({ confirmedHours: d.confirmedHours, waiting: d.waiting, expired: d.expired, abnormal: d.abnormal }));
    assert(d.expectedHours > 0 && d.completionRate >= 0,
      '应计学时 + 完成率', 'expected=' + d.expectedHours + ' rate=' + d.completionRate + '% makeup=' + d.makeupHours);

    const bt = await call('GET', '/stats/by-teacher?pageSize=200', { token: adminToken });
    const td = expectCode(bt, 0, 'GET /stats/by-teacher');
    assert(Math.abs(td.totalHours - d.confirmedHours) < 0.01, '分教师学时合计 == 全校已确认学时（口径一致）', td.totalHours + ' vs ' + d.confirmedHours);

    const bd = await call('GET', '/stats/by-dept', { token: adminToken });
    const dd = expectCode(bd, 0, 'GET /stats/by-dept');
    assert(dd.list.length >= 2 && typeof dd.list[0].percent === 'number', '分院系含完成率',
      dd.list.map(function (x) { return x.name + ':' + x.hours + 'h/' + x.percent + '%'; }).join(' '));

    const bc = await call('GET', '/stats/by-course', { token: adminToken });
    const cd = expectCode(bc, 0, 'GET /stats/by-course');
    assert(cd.totalHours > 0, '分课程学时 > 0', cd.list.map(function (x) { return x.courseName + ':' + x.hours; }).join(' '));

    const tr = await call('GET', '/stats/trend?granularity=week', { token: adminToken });
    const trd = expectCode(tr, 0, 'GET /stats/trend?granularity=week');
    assert(trd.list.length > 0 && trd.granularity === 'week', '趋势数据按周聚合', trd.list.map(function (x) { return x.bucket + ':' + x.hours; }).join(' '));
    const trDay = await call('GET', '/stats/trend?granularity=day', { token: adminToken });
    expectCode(trDay, 0, 'GET /stats/trend?granularity=day');
    const trMonth = await call('GET', '/stats/trend?granularity=month', { token: adminToken });
    expectCode(trMonth, 0, 'GET /stats/trend?granularity=month');

    // 教师视角只看本人
    const tOv = await call('GET', '/stats/overview', { token: teacherToken });
    const tod = expectCode(tOv, 0, 'GET /stats/overview（教师本人口径）');
    assert(tod.confirmedHours <= d.confirmedHours, '教师口径 ≤ 全校口径', tod.confirmedHours + ' ≤ ' + d.confirmedHours);
  }

  // ---------------------------------------------------------------- 10 补签 / 申诉
  section('10. 补签与申诉（E）');
  {
    const expired = await call('GET', '/records?status=expired', { token: teacherToken });
    const ed = expectCode(expired, 0, '查询 expired 记录（种子数据）');
    if (ed.list.length) {
      const rid = ed.list[0].id;
      const mk = await call('POST', '/makeup', { token: teacherToken, body: { recordId: rid, reason: '当天已正常授课，班干部请假' } });
      const md = expectCode(mk, 0, 'POST /makeup（教师发起补签）');
      assert(md.status === 'pending' && md.record.status === 'expired', '补签申请 pending', 'id=' + md.id);
      expectCode(await call('POST', '/makeup', { token: teacherToken, body: { recordId: rid, reason: '重复' } }), 42201, '同一记录重复补签 → 42201');
      expectCode(await call('POST', '/makeup', { token: teacherToken, body: { recordId: rid } }), 40001, '缺 reason → 40001');

      const list = await call('GET', '/makeup?status=pending', { token: deptToken });
      const ld = expectCode(list, 0, 'GET /makeup?status=pending（院系管理员）');
      assert(ld.list.some(function (x) { return x.id === md.id; }), '待审列表包含该申请', ld.pending + ' 条待审');
      expectCode(await call('POST', '/makeup/' + md.id + '/reject', { token: deptToken, body: {} }), 40001, '驳回未填原因 → 40001');
      expectCode(await call('POST', '/makeup/' + md.id + '/approve', { token: teacherToken, body: {} }), 40301, '教师自审批补签 → 40301');

      const app = await call('POST', '/makeup/' + md.id + '/approve', { token: deptToken, body: { note: '核实无误，准予补签' } });
      const apd = expectCode(app, 0, 'POST /makeup/{id}/approve（院系管理员）');
      assert(apd.record.status === 'makeup' && apd.record.counted === true, '通过后原记录置 makeup（计入正式学时）', apd.record.id + ' → ' + apd.record.status);
      expectCode(await call('POST', '/makeup/' + md.id + '/approve', { token: deptToken, body: {} }), 42201, '重复审核 → 42201');

      const ov2 = await call('GET', '/stats/overview', { token: adminToken });
      const ovd2 = expectCode(ov2, 0, '补签后统计');
      assert(ovd2.makeupHours > 0, '补签学时在报表中单独标注（makeupHours）', 'makeup=' + ovd2.makeupHours);
    } else {
      ok('跳过补签流程（无 expired 记录）');
    }

    const rejected = await call('GET', '/records?status=rejected', { token: teacherToken });
    const rd = expectCode(rejected, 0, '查询 rejected 记录');
    if (rd.list.length) {
      const rid = rd.list[0].id;
      const ap = await call('POST', '/appeal', { token: teacherToken, body: { recordId: rid, reason: '当天确实上课，学委记错日期' } });
      const ad = expectCode(ap, 0, 'POST /appeal（教师申诉）');
      assert(ad.status === 'pending' && ad.record.status === 'appealing', '申诉 pending，记录置 appealing', 'id=' + ad.id);
      expectCode(await call('POST', '/appeal', { token: teacherToken, body: { recordId: rid, reason: '再申诉' } }), 42201, '同一记录二次申诉 → 42201（上限 1 次）');
      expectCode(await call('POST', '/appeal/' + ad.id + '/reject', { token: teacherToken, body: { note: 'x' } }), 40301, '教师处理申诉 → 40301');
      expectCode(await call('POST', '/appeal/' + ad.id + '/reject', { token: adminToken, body: {} }), 40001, '申诉驳回未填原因 → 40001');
      const appr = await call('POST', '/appeal/' + ad.id + '/approve', { token: adminToken, body: { note: '查实予以通过' } });
      const apd = expectCode(appr, 0, 'POST /appeal/{id}/approve（教务处）');
      assert(apd.record.status === 'done', '申诉通过后置 done', apd.record.status);
    } else {
      ok('跳过申诉流程（无 rejected 记录）');
    }
  }

  // ---------------------------------------------------------------- 11 导出
  section('11. 导出（G：异步任务 + 固定表头 + 短期链接）');
  {
    const r = await call('POST', '/export/records', { token: adminToken, body: { format: 'csv' } });
    const d = expectCode(r, 0, 'POST /export/records 返回 jobId');
    assert(d.jobId && d.status, 'jobId=' + d.jobId + ' status=' + d.status);
    await new Promise(function (x) { setTimeout(x, 400); });
    const job = await call('GET', '/export/' + d.jobId, { token: adminToken });
    const jd = expectCode(job, 0, 'GET /export/{jobId}');
    assert(jd.status === 'done' && jd.downloadUrl && jd.expireAt, '任务完成 + downloadUrl（1 小时有效）', jd.successRows + ' 行，到期 ' + jd.expireAt);

    const dl = await fetch(BASE + jd.downloadUrl);
    const csv = (await dl.text()).replace(/^\ufeff/, '');
    const header = '学期,教师姓名,工号,院系,课程,教学班,上课日期,节次,应计学时,状态,是否补签,发起人（学委）,签字人职务,是否现场指定,确认人,是否临时调整,确认人与实际授课人不符,确认时间,缺勤人数,缺勤姓名,课堂纪律';
    const headerCols = csv.split('\r\n')[0].split(',');
    assert(dl.status === 200 && csv.split('\r\n')[0] === header, '导出表头与契约完全一致（21 列：新增确认人/是否临时调整/姓名不符，签字人→发起人（学委））', csv.split('\r\n')[0]);
    assert(headerCols.length === 21 && headerCols[11] === '发起人（学委）' && headerCols[14] === '确认人' &&
      headerCols[15] === '是否临时调整' && headerCols[16] === '确认人与实际授课人不符',
      '新增三列位置与列名固定（14/15/16 列）', headerCols.slice(10, 18).join(' / '));
    assert(csv.split('\r\n').length > 2, '导出含数据行', (csv.split('\r\n').length - 2) + ' 行');
    assert(csv.split('\r\n')[1].split(',').length === 21, '数据行列数与表头一致（21 列）');
    // 新增三列取值：旧流程记录（本脚本 POST /records 产生）必须输出空；新流程记录必须为 是/否
    const dataRows = csv.split('\r\n').slice(1).filter(function (l) { return l.trim() !== ''; });
    const colsOf = function (l) { return l.split(','); };
    const mixed = dataRows.filter(function (l) {
      const c = colsOf(l);
      const legacyLike = c[14] === '' && c[15] === '' && c[16] === '';
      const newLike = ['是', '否'].indexOf(c[15]) >= 0 && ['是', '否'].indexOf(c[16]) >= 0;
      return !legacyLike && !newLike;
    });
    assert(mixed.length === 0, '新增三列取值成组：旧流程三列同为空 / 新流程必为 是|否（不出现半填充）',
      mixed.length + ' 行异常取值');
    const legacyRow = await call('GET', '/records/' + todayRecordId, { token: adminToken });
    const lr = (legacyRow.body.data) || {};
    const matched = dataRows.filter(function (l) {
      const c = colsOf(l);
      return c[1] === lr.teacherName && c[4] === lr.courseName && c[5] === lr.className &&
        c[6] === lr.fullDate && c[7] === String(lr.section);
    })[0];
    const mc = matched ? colsOf(matched) : [];
    assert(lr.confirmedName === undefined || !lr.confirmedName,
      '本脚本的今日课仍是旧流程记录（无确认人）', 'teacher=' + lr.teacherName + ' status=' + lr.status);
    assert(!!matched && mc[14] === '' && mc[15] === '' && mc[16] === '',
      '旧流程数据（无 confirmed_name / 无发起人）新增三列输出空，不编造值',
      matched ? ('确认人="' + mc[14] + '" 临时调整="' + mc[15] + '" 姓名不符="' + mc[16] + '"') : '未在导出中匹配到该旧流程记录');
    assert(dataRows.filter(function (l) { const c = colsOf(l); return c[14] === '' && c[15] === '' && c[16] === ''; }).length > 0,
      '旧流程数据三列输出空（新流程取值的断言见 tools/session-flow-test.js 第 12C 节）');

    const badDownload = await fetch(BASE + jd.downloadUrl.replace(/token=[^&]*/, 'token=deadbeef'));
    assert(badDownload.status === 401, '篡改下载令牌 → 401', 'HTTP ' + badDownload.status);

    const st = await call('POST', '/export/stats', { token: adminToken, body: {} });
    const sd = expectCode(st, 0, 'POST /export/stats');
    await new Promise(function (x) { setTimeout(x, 400); });
    const sjd = expectCode(await call('GET', '/export/' + sd.jobId, { token: adminToken }), 0, 'GET /export/{stats jobId}');
    const scsv = await (await fetch(BASE + sjd.downloadUrl)).text();
    assert(sjd.status === 'done' && scsv.indexOf('## 分院系') > 0 && scsv.indexOf('## 分教师') > 0,
      '统计报表含概览/分院系/分教师/分课程段', scsv.length + ' 字节');
    expectCode(await call('GET', '/export/EJ-NOT-EXIST', { token: adminToken }), 40401, '导出任务不存在 → 40401');
    expectCode(await call('GET', '/export/' + d.jobId, { token: teacher2Token }), 40301, '非任务创建者查询导出任务 → 40301');
  }

  // ---------------------------------------------------------------- 12 导入
  section('12. 基础数据导入（H：先校验后落库）');
  {
    const badCsv = '学号,姓名,教学班\n2025999801,测试学生A,2025级护理3班\n2025999802,测试学生B,不存在的班级\n2025999803,,2025级护理3班\n';
    const bad = new FormData();
    bad.set('file', new Blob([badCsv], { type: 'text/csv' }), 'students.csv');
    const r1 = await call('POST', '/import/students', { token: adminToken, form: bad });
    const d1 = expectCode(r1, 0, 'POST /import/students（含 2 处错误）');
    assert(d1.committed === false && d1.failRows === 2 && d1.errors.length === 2,
      '逐行错误报告（第几行 + 原因）且整批未落库', JSON.stringify(d1.errors.map(function (e) { return e.line + ':' + e.msg; })));
    const cj = expectCode(await call('GET', '/import/' + d1.jobId, { token: adminToken }), 0, 'GET /import/{jobId}');
    assert(cj.status === 'failed' && cj.errorReportUrl && cj.errorCount === 2, '任务 failed + 错误报告下载地址', cj.errorReportUrl);
    const report = await fetch(BASE + cj.errorReportUrl, { headers: { Authorization: 'Bearer ' + adminToken } });
    assert(report.status === 200, '错误报告可下载', 'HTTP ' + report.status);

    const goodCsv = '学号,姓名,教学班\n2025999801,测试学生A,2025级护理3班\n2025999802,测试学生B,2025级护理3班\n';
    const good = new FormData();
    good.set('file', new Blob([goodCsv], { type: 'text/csv' }), 'students.csv');
    const d2 = expectCode(await call('POST', '/import/students', { token: adminToken, form: good }), 0, 'POST /import/students（全部合法）');
    assert(d2.committed === true && d2.successRows === 2, '2 行全部落库', d2.msg);
    // 重复导入应更新而不是报错
    const again = expectCode(await call('POST', '/import/students', { token: adminToken, form: good }), 0, '重复导入同一份学生名单');
    assert(again.committed === true, '重复行按学号+班级幂等更新', again.msg);

    const tasksCsv = '学期,工号,教师姓名,课程代码,课程名称,教学班,星期,节次,开始,结束,地点,周次,学时\n' +
      '2026-2027-1,2011045,李慧,YXXX002,医学信息检索,2025级护理3班,周六,1-2,08:00,09:40,图书馆电子阅览室,1-18,2\n';
    const tf = new FormData();
    tf.set('file', new Blob([tasksCsv], { type: 'text/csv' }), 'tasks.csv');
    const d3 = expectCode(await call('POST', '/import/tasks', { token: adminToken, form: tf }), 0, 'POST /import/tasks');
    assert(d3.committed === true && d3.successRows === 1, '课表导入落库（工号/教学班校验通过）', d3.msg);

    const badTask = '学期,工号,教师姓名,课程代码,课程名称,教学班,星期,节次,开始,结束,地点,周次,学时\n' +
      '2026-2027-1,2011045,唐瑞明,X,Y,2025级护理3班,周三,1-2,08:00,09:40,A,1-18,2\n';
    const btf = new FormData();
    btf.set('file', new Blob([badTask], { type: 'text/csv' }), 'tasks.csv');
    const d3b = expectCode(await call('POST', '/import/tasks', { token: adminToken, form: btf }), 0, 'POST /import/tasks（工号与姓名不符）');
    assert(d3b.committed === false && d3b.failRows === 1, '工号与姓名不匹配 → 整批拒绝', d3b.errors[0].msg);

    const cadCsv = '教学班,学号,姓名,职务,优先级\n2025级护理3班,2025030118,曾毅,副班长,4\n';
    const cf = new FormData();
    cf.set('file', new Blob([cadCsv], { type: 'text/csv' }), 'cadres.csv');
    const d4 = expectCode(await call('POST', '/import/cadres', { token: adminToken, form: cf }), 0, 'POST /import/cadres');
    assert(d4.committed === true, '班干部授权导入落库', d4.msg);

    const tpl = await fetch(API + '/import/template?type=tasks');
    const tplText = (await tpl.text()).replace(/^\ufeff/, '');
    assert(tpl.status === 200 && tplText.indexOf('课程代码') > 0, 'GET /import/template?type=tasks', tplText.split('\r\n')[0]);

    const vo = new FormData();
    vo.set('file', new Blob([goodCsv], { type: 'text/csv' }), 'students.csv');
    expectCode(await call('POST', '/import/students', { token: teacherToken, form: vo }), 40301, '教师调用导入 → 40301');
  }

  // ---------------------------------------------------------------- 13 配置 / 日志 / 文件
  section('13. 配置、操作日志哈希链、文件（I）');
  {
    const cfg = await call('GET', '/config', { token: adminToken });
    const cd = expectCode(cfg, 0, 'GET /config');
    assert(cd.list.length >= 8 && cd.config.code_ttl_seconds && cd.terms.length >= 1, '返回配置清单 + 学期列表',
      cd.list.length + ' 项，code_ttl=' + cd.config.code_ttl_seconds + 's，confirm=' + cd.config.confirm_deadline_hour + 'h');

    expectCode(await call('PUT', '/config', { token: adminToken, body: { code_ttl_seconds: 5 } }), 40001, '动态码有效期 5 秒（<10）→ 40001');
    expectCode(await call('PUT', '/config', { token: adminToken, body: { makeup_approver_role: 'teacher' } }), 40001, '非法审批角色 → 40001');

    const put = await call('PUT', '/config', { token: adminToken, body: { urge_cooldown_minutes: 20, hours_coef_practice: '1.2' } });
    const pd = expectCode(put, 0, 'PUT /config 更新（学时系数 + 提醒冷却）');
    assert(pd.changed.length === 2 && pd.config.hours_coef_practice === '1.2', '返回变更明细与新值',
      pd.changed.map(function (c) { return c.key + ':' + c.before + '→' + c.after; }).join(', '));
    expectCode(await call('PUT', '/config', { token: adminToken, body: { hours_coef_theory: '-1' } }), 40001, '学时系数为负数 → 40001');
    expectCode(await call('PUT', '/config', { token: teacherToken, body: { term: 'x' } }), 40301, '教师改配置 → 40301');

    const logs = await call('GET', '/logs?pageSize=300', { token: adminToken });
    const ld = expectCode(logs, 0, 'GET /logs');
    const actions = Array.from(new Set(ld.list.map(function (x) { return x.action; })));
    assert(ld.list.length > 0 && ld.list[0].prevHash && ld.list[0].hash, '每条日志含 prev_hash / hash', '共 ' + ld.total + ' 条');
    assert(ld.chain.ok === true, '哈希链完整性校验通过（可检测篡改）', 'chain.total=' + ld.chain.total + ' head=' + String(ld.chain.headHash).slice(0, 12) + '…');
    const required = ['auth.login', 'record.create', 'record.sign', 'record.reject', 'record.revoke', 'makeup.approve', 'appeal.apply', 'export.records', 'import.success', 'config.update'];
    const missing = required.filter(function (a) { return actions.indexOf(a) < 0; });
    assert(missing.length === 0, '登录/发起/确认/拒绝/撤销/审核/导出/导入/配置 均已写日志', missing.length ? '缺少 ' + missing.join(',') : required.length + ' 类动作齐备');
    const byAction = await call('GET', '/logs?action=record.sign', { token: adminToken });
    const bad2 = expectCode(byAction, 0, 'GET /logs?action=record.sign');
    assert(bad2.total >= 1, '按 action 过滤生效', bad2.total + ' 条');
    const byTarget = await call('GET', '/logs?targetId=' + todayRecordId, { token: adminToken });
    const btd = expectCode(byTarget, 0, 'GET /logs?targetId=' + todayRecordId);
    assert(btd.total >= 2, '按 targetId 过滤生效', btd.total + ' 条');
    const chain = await call('GET', '/logs/verify', { token: adminToken });
    expectCode(chain, 0, 'GET /logs/verify');
    expectCode(await call('GET', '/logs', { token: deptToken }), 0, '院系管理员可查看日志');

    // 文件上传
    const f = new FormData();
    f.set('signature', new Blob([pngBuffer(256)], { type: 'image/png' }), 'sign.png');
    const ud = expectCode(await call('POST', '/files/signature', { token: cadreToken, form: f }), 0, 'POST /files/signature');
    assert(ud.url && ud.imageHash && ud.imageHash.length === 64 && ud.size > 0, '返回 url + image_hash（SHA-256）', ud.url + ' ' + ud.imageHash.slice(0, 16) + '…');
    assert((await fetch(BASE + ud.url, { headers: { Authorization: 'Bearer ' + cadreToken } })).status === 200, 'GET /files/{id} 带鉴权可读');
    assert((await fetch(BASE + ud.url)).status === 401, 'GET /files/{id} 无鉴权 → 401');
    const fBad = new FormData();
    fBad.set('signature', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'a.txt');
    expectCode(await call('POST', '/files/signature', { token: cadreToken, form: fBad }), 40001, '上传 txt → 40001');
    const fEmpty = new FormData();
    expectCode(await call('POST', '/files/signature', { token: cadreToken, form: fEmpty }), 40001, '未提供文件 → 40001');
  }

  // ---------------------------------------------------------------- 14 自由文本合规
  section('14. 自由文本合规（敏感词拦截 40001 + 长度限制 + /config 即时生效）');
  {
    const cfgBefore = expectCode(await call('GET', '/config', { token: adminToken }), 0, 'GET /config（读取当前词表/长度上限）');
    const origWords = cfgBefore.config.sensitive_words;
    const origSummaryLen = cfgBefore.config.max_summary_len;
    assert(cfgBefore.config.max_summary_len === '500' && cfgBefore.config.max_absent_names_len === '300' && cfgBefore.config.max_reason_len === '500',
      '自由文本长度上限默认 500 / 300 / 500（摘要 / 缺勤姓名 / 理由备注）',
      [origSummaryLen, cfgBefore.config.max_absent_names_len, cfgBefore.config.max_reason_len].join(' / '));
    const cfgKeys = (cfgBefore.list || []).map(function (x) { return x.key; });
    assert(['sensitive_words', 'max_summary_len', 'max_absent_names_len', 'max_reason_len'].every(function (k) { return cfgKeys.indexOf(k) >= 0; }),
      'GET /config 暴露 4 个合规配置项（含敏感词表与三个长度上限）', cfgKeys.length + ' 项');

    async function freshCode() {
      const g = await call('POST', '/code/generate', { token: cadreToken });
      return (g.body && g.body.data && g.body.data.codeId) || '';
    }
    async function freeDate() { return await freeDateOf(targetTask, isoDateOffset(-1), adminToken); }

    const date = await freeDate();
    const code1 = await freshCode();
    assert(!!date && !!code1, '准备合规用例的动态码与可用日期', date + ' / ' + code1);

    // 14.1 摘要命中敏感词 → 40001，msg 明确提示
    const sens = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date, absentCount: 0, signerId: cadreUser.id, summary: '本次课存在代签情况，请核查' },
    });
    assert(sens.body.code === 40001 && /内容包含敏感词/.test(sens.body.msg) && sens.body.msg.indexOf('代签') >= 0,
      '摘要命中敏感词 → 40001「内容包含敏感词：xxx」', 'code=' + sens.body.code + ' msg=' + sens.body.msg);

    // 14.2 缺勤姓名命中敏感词 → 40001
    const sens2 = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date, absentCount: 1, absentNames: '李思琪、代签', signerId: cadreUser.id },
    });
    assert(sens2.body.code === 40001 && /内容包含敏感词/.test(sens2.body.msg),
      '缺勤姓名命中敏感词 → 40001', sens2.body.msg);

    // 14.3 超长文本 → 40001
    const over = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date, absentCount: 0, signerId: cadreUser.id, summary: '好'.repeat(501) },
    });
    assert(over.body.code === 40001 && /过长/.test(over.body.msg), '摘要超过 500 字符 → 40001', over.body.msg);
    const overAbsent = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date, absentCount: 0, signerId: cadreUser.id, absentNames: '李'.repeat(301) },
    });
    assert(overAbsent.body.code === 40001 && /过长/.test(overAbsent.body.msg), '缺勤姓名超过 300 字符 → 40001', overAbsent.body.msg);

    // 14.4 被拦截的请求已写操作日志，且未消费动态码（同一码仍可正常发起）
    const blockedLogs = await call('GET', '/logs?action=text.sensitive.blocked&pageSize=5', { token: adminToken });
    const bl = expectCode(blockedLogs, 0, 'GET /logs?action=text.sensitive.blocked');
    assert(bl.total >= 1 && /内容包含敏感词/.test((bl.list[0] || {}).detail || ''),
      '敏感词拦截已写操作日志（audit）', bl.total + ' 条，最后一条：' + ((bl.list[0] || {}).detail || ''));
    const invalidLogs = await call('GET', '/logs?action=text.invalid.blocked&pageSize=5', { token: adminToken });
    const il = expectCode(invalidLogs, 0, 'GET /logs?action=text.invalid.blocked');
    assert(il.total >= 1, '超长文本拦截同样写操作日志', il.total + ' 条');

    const ok1 = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date, absentCount: 0, signerId: cadreUser.id, summary: '本次课正常授课，学生到课良好' },
    });
    const okd = expectCode(ok1, 0, '同一动态码在文本合规后可正常发起（拦截不消耗动态码）');
    assert((okd.warnings || []).length === 0, '合规文本不产生脱敏 warning', JSON.stringify(okd.warnings));

    // 14.5 动态码已一次性消费（换一条日期验证 41002，排除唯一性干扰）
    const date2 = await freeDate();
    const reuse = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code1, taskId: targetTask.id, teachDate: date2, absentCount: 0, signerId: cadreUser.id },
    });
    assert(reuse.body.code === 41002, '被拦截的请求未消费动态码（成功后才消费 → 再次使用 41002）', 'code=' + reuse.body.code + ' msg=' + reuse.body.msg);

    // 14.6 /config 修改 sensitive_words 后立即生效
    const putWords = await call('PUT', '/config', { token: adminToken, body: { sensitive_words: '冒名顶替,验证词' } });
    const pw = expectCode(putWords, 0, 'PUT /config 覆盖 sensitive_words');
    assert(pw.config.sensitive_words === '冒名顶替,验证词', '词表已归一化为逗号分隔', pw.config.sensitive_words);
    const code2 = await freshCode();
    const date3 = await freeDate();
    const afterPass = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code2, taskId: targetTask.id, teachDate: date3, absentCount: 0, signerId: cadreUser.id, summary: '本次课存在代签情况（词表已覆盖）' },
    });
    expectCode(afterPass, 0, '/config 覆盖词表后，原内置敏感词不再拦截（无需重启）');
    const code3 = await freshCode();
    const date4 = await freeDate();
    const afterBlock = await call('POST', '/records', {
      token: teacherToken,
      body: { codeId: code3, taskId: targetTask.id, teachDate: date4, absentCount: 0, signerId: cadreUser.id, summary: '这是验证词，应被立即拦截' },
    });
    assert(afterBlock.body.code === 40001 && /验证词/.test(afterBlock.body.msg),
      '修改后的新敏感词立即生效（40001 且提示命中词）', afterBlock.body.msg);

    // 14.7 /config 校验：非法长度上限 / 非法词表 / 越权
    expectCode(await call('PUT', '/config', { token: adminToken, body: { max_summary_len: 0 } }), 40001, 'max_summary_len=0（越界）→ 40001');
    expectCode(await call('PUT', '/config', { token: adminToken, body: { max_summary_len: 'abc' } }), 40001, 'max_summary_len 非整数 → 40001');
    expectCode(await call('PUT', '/config', { token: adminToken, body: { max_absent_names_len: 99999 } }), 40001, 'max_absent_names_len 超出 1-2000 → 40001');
    expectCode(await call('PUT', '/config', { token: adminToken, body: { max_reason_len: 3.5 } }), 40001, 'max_reason_len 非整数 → 40001');
    expectCode(await call('PUT', '/config', { token: adminToken, body: { sensitive_words: 'x' } }), 40001, '敏感词过短（<2 字符）→ 40001');
    expectCode(await call('PUT', '/config', { token: teacherToken, body: { max_reason_len: 100 } }), 40301, '教师修改合规配置 → 40301（仅 admin 可改）');

    // 14.8 还原配置（便于脚本重复执行）
    const restore = await call('PUT', '/config', { token: adminToken, body: { sensitive_words: origWords, max_summary_len: origSummaryLen } });
    const rd = expectCode(restore, 0, 'PUT /config 还原敏感词表与长度上限');
    assert(rd.config.sensitive_words === origWords && rd.config.max_summary_len === origSummaryLen,
      '配置已还原为初始值', '词条 ' + String(rd.config.sensitive_words).split(',').length + ' 个 / max_summary_len=' + rd.config.max_summary_len);
  }

  // ---------------------------------------------------------------- 15 定时任务 / 404 / 登出
  section('15. 定时任务、404 与登出');
  {
    const d = expectCode(await call('POST', '/records/expire-job', { token: adminToken, body: {} }), 0, 'POST /records/expire-job（管理员触发）');
    assert(typeof d.expired === 'number', '批量置过期执行完成', 'expired=' + d.expired);
    expectCode(await call('POST', '/records/expire-job', {}), 40301, '无令牌调用内部任务 → 40301');
    const nf = await call('GET', '/not-exists-path');
    assert(nf.httpStatus === 404 && nf.body.code === 40401, '未知路径 → 404 + 40401', 'HTTP ' + nf.httpStatus);
    const tracedError = await call('GET', '/records?page=abc', { token: teacherToken });
    assert(tracedError.body.traceId, '错误响应同样带 traceId');

    expectCode(await call('POST', '/auth/logout', { token: teacher2Token }), 0, 'POST /auth/logout');
    expectCode(await call('GET', '/auth/me', { token: teacher2Token }), 40101, '登出后 token 立即失效 → 40101');
  }

  log('\n' + '='.repeat(66));
  log('通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    log('失败清单：');
    failures.forEach(function (f) { log('  - ' + f); });
  }
  log('='.repeat(66));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e);
  process.exit(2);
});
