'use strict';
/**
 * 小程序「真实登录 / 绑定 + 真实后端数据流」自测脚本（Node 18+，零依赖，不需要微信开发者工具）
 *
 * 用法：
 *   node tools/miniapp-auth-selftest.js        # 在项目根目录执行（课时签到微信小程序/）
 *
 * 背景（历史 bug，已修复并持续回归）：
 *   此前小程序没有任何写入 token 的代码，所有真实请求都不带 Authorization，
 *   后端一律返回 40101「未登录或登录已失效」，班干部首页拿不到动态码，
 *   二维码与 6 位口令都不显示。
 *
 * 本脚本用 wx / Page / App / getApp 桩 + 一个「离线假后端」验证（业务流程简化后的新流程）：
 *   ① 未绑定 → 首页给出「去绑定」引导（不静默失败、不出示动态码）
 *   ② 执行绑定 → token 被写入 storage、role=班干部、跳首页
 *   ③ 绑定失败 → 后端 msg 原样展示 + 可操作建议
 *   ④ 班干部首页 → GET /class-courses/today → POST /sessions 拿到 code(6 位) 与 qrPayload →
 *      真正进入 canvas 渲染分支 → 刷新码 POST /sessions/{id}/code →
 *      临时调整（POST /sessions + 可选 PUT /class-courses/{id}）；请求均带 Authorization
 *   ⑤ 教师端首页 → GET /tasks + GET /sessions?status=wait + 扫码/口令入口
 *   ⑥ 记录页 → GET /sessions 分页 + onReachBottom + statusTotals 角标 + 状态筛选
 *   ⑦ 详情页 → GET /sessions/{id}（证据四项：动态码/确认人/确认时间/设备，无手写签名图）
 *   ⑧ 课时确认页 → POST /code/verify(isSession) → POST /sessions/{id}/confirm；
 *      代课（确认人≠实际授课人）仍成功并提示学时归属；后端错误 msg 原样展示
 *   ⑨ 我的课程 → GET/POST/PUT/DELETE（归档）与敏感词/长度/权限 msg 原样展示
 *   ⑩ 40101 场景 → 清除本地 token/user/role 并跳「去绑定」引导
 *   ⑪ mock 模式 → useMock=true 时零网络请求（离线演示不受影响）
 *
 * 说明：本脚本用内存桩替代 wx，不改动任何线上代码；所有断言数最后统一汇总。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const shape = require(path.join(ROOT, 'miniprogram/utils/shape.js'));

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ================================================================ 离线假后端
// 只实现本脚本用到的接口，响应体形状与已部署后端（8.138.41.74）一致。
const BASE = 'http://backend.test';

const backend = {
  // 登录用的 code → openid 映射（模拟 DEV_MODE 下「同 code 同 openid」）
  openidOfCode: function (code) { return 'dev_' + String(code).replace(/[^a-z0-9]/gi, ''); },
  // 场景开关
  boundTokens: {},              // token → user（已绑定的登录态）
  boundOpenids: {},             // openid → user
  whitelist: [
    { no: '2010032', real_name: '唐瑞明', role: 'teacher' },
    { no: '2025030117', real_name: '张一鸣', role: 'cadre', className: '2025级护理3班', duty: '学委' }
  ],
  occupiedNo: { '2010032': true },   // 模拟「已被其他微信绑定」的工号
  records: [],
  tasks: [],
  codes: {},            // codeId → { code, issuerToken, expireAtMs, used, sessionId }
  pendingTotal: 3,
  totalOverride: null,  // 用于验证「页面用的是后端 total，而不是本页 list.length」
  codeSeq: 0,
  recordSeq: 0,
  tokenSeq: 0,
  // 业务流程简化（课程清单 + 课时会话）
  classCourses: [],
  courseSeq: 0,
  sessions: [],
  sessionSeq: 0,
  courseError: null,    // 课程清单写入失败（msg 原样展示）覆盖
  sessionError: null,   // 发起课时失败覆盖
  confirmError: null,   // 确认失败覆盖
};

const requests = [];        // 记录每个请求，用于断言 URL / 方法 / body / 请求头

function okBody(data) { return { statusCode: 200, data: { code: 0, msg: 'ok', data: data } }; }
function errBody(status, code, msg) { return { statusCode: status, data: { code: code, msg: msg, data: {} } }; }

function bearer(header) {
  const h = header || {};
  const m = /^Bearer\s+(.+)$/i.exec(String(h['Authorization'] || h['authorization'] || '').trim());
  return m ? m[1].trim() : '';
}

function userView(u) {
  return Object.assign({
    id: 'U-' + u.no,
    role: u.role,
    name: u.real_name,
    realName: u.real_name,
    staffId: u.role === 'teacher' ? u.no : '',
    studentId: u.role === 'cadre' ? u.no : '',
    no: u.no,
    dept: '计算机教研室',
    className: u.className || '',
    duty: u.duty || '',
    status: 'active'
  });
}

/** 假后端路由：返回 { statusCode, data } */
function route(opts) {
  const url = String(opts.url || '');
  const method = String(opts.method || 'GET').toUpperCase();
  const p = url.replace(BASE, '');
  const body = opts.data || {};
  const tok = bearer(opts.header);
  const pathOnly = p.split('?')[0];
  // wx.request 在 GET 时会把 data 序列化进 query string；这里两种来源都收，
  // 让假后端与真实后端的取参方式一致。
  const query = Object.assign({}, body);
  const qi = p.indexOf('?');
  if (qi >= 0) {
    p.slice(qi + 1).split('&').forEach(function (kv) {
      if (!kv) return;
      const i = kv.indexOf('=');
      query[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
  }

  // ---------------- 认证
  if (pathOnly === '/api/v1/auth/login' && method === 'POST') {
    const openid = backend.openidOfCode(body.code);
    const bound = backend.boundOpenids[openid];
    if (bound) {
      return okBody({ token: bound.token, tokenType: 'Bearer', needBind: false, openid: openid, role: bound.user.role, user: userView(bound.user) });
    }
    return okBody({
      token: '', needBind: true, openid: openid, bindTicket: 'TICKET-' + openid,
      mock: true, role: '', user: null, devMode: true
    });
  }

  if (pathOnly === '/api/v1/auth/bind' && method === 'POST') {
    const white = backend.whitelist.filter(function (w) { return w.no === String(body.no); })[0];
    if (!white) return errBody(403, 40301, '工号/学号 ' + body.no + ' 不在白名单内，无法绑定');
    if (white.real_name !== body.realName) {
      return errBody(403, 40301, '白名单中 ' + body.no + ' 对应姓名为「' + white.real_name + '」，与填写的不一致');
    }
    if (white.role !== body.role) {
      return errBody(403, 40301, '白名单中 ' + body.no + ' 的角色为「' + white.role + '」，与填写的不一致');
    }
    if (backend.occupiedNo[white.no]) {
      return errBody(403, 40301, '该工号/学号已被其他微信绑定，请联系教务处');
    }
    const token = 'TOKEN-' + (++backend.tokenSeq) + '-' + white.no;
    const rec = { token: token, user: white };
    backend.boundOpenids[body.openid] = rec;
    backend.boundTokens[token] = white;
    return okBody({ token: token, tokenType: 'Bearer', needBind: false, role: white.role, user: userView(white) });
  }

  // 其余接口一律要求有效 token，否则 40101（与真实后端一致）
  const user = backend.boundTokens[tok] || null;
  if (!user) return errBody(401, 40101, '未登录或登录已失效');

  if (pathOnly === '/api/v1/auth/me' && method === 'GET') {
    return okBody({ user: userView(user), role: user.role, config: { codeTtlSeconds: 60, confirmDeadlineHour: 24, term: '2026-2027-1', devMode: true } });
  }
  if (pathOnly === '/api/v1/auth/logout' && method === 'POST') {
    delete backend.boundTokens[tok];
    return okBody({ ok: true, revoked: true });
  }

  if (pathOnly === '/api/v1/code/generate' && method === 'POST') {
    if (user.role !== 'cadre') return errBody(403, 40301, '当前角色（' + user.role + '）无权访问该接口');
    backend.codeSeq++;
    const codeId = 'CD' + String(backend.codeSeq).padStart(8, '0');
    backend.codes[codeId] = { code: '042317', issuerToken: tok, expireAtMs: Date.now() + 60000, used: false };
    return okBody({
      codeId: codeId,
      code: '042317',                 // 固定含前导零，验证 6 位口令不被数字转换吃掉
      codeLength: 6,
      qrPayload: 'kcsq://code/' + codeId,
      qrUrl: 'kcsq://code/' + codeId,
      expireAtMs: Date.now() + 60000,
      ttl: 60,
      className: user.className,
      cadre: userView(user),
      channels: {
        qr: { payload: 'kcsq://code/' + codeId, hint: '教师用「扫码发起」扫描此二维码' },
        code: { value: '042317', hint: '教师用「输入口令」手输此 6 位数字' }
      }
    });
  }

  // 教师扫码 / 输口令后核验（A+B 双通道共用）
  if (pathOnly === '/api/v1/code/verify' && method === 'POST') {
    let codeId = String(body.codeId || '');
    let by = 'codeId';
    if (!codeId && body.code) {
      by = 'code';
      codeId = Object.keys(backend.codes).filter(function (k) { return backend.codes[k].code === String(body.code); }).pop() || '';
    }
    if (!codeId && body.qrContent) {
      by = 'qrContent';
      const m = /kcsq:\/\/code\/([^/?#\s]+)/i.exec(String(body.qrContent));
      codeId = m ? m[1] : '';
    }
    const row = backend.codes[codeId];
    if (!row) {
      if (by === 'code') return errBody(404, 40401, '口令不存在或已失效：' + body.code);
      return errBody(404, 40401, by === 'qrContent' ? '二维码对应的动态码不存在或已失效' : '动态码不存在：' + codeId);
    }
    if (row.used) return errBody(410, 41002, '动态码已被使用');
    if (row.expireAtMs <= Date.now()) return errBody(410, 41001, '动态码已过期，请班干部刷新');
    const issuer = backend.boundTokens[row.issuerToken] || null;
    const date = body.date || shape.todayFull();

    // 课时会话码（codes.session_id 非空）→ 返回本次课时信息（新流程）
    const bound = row.sessionId
      ? (backend.sessions || []).filter(function (s) { return s.sessionId === row.sessionId; })[0]
      : null;
    if (bound) {
      return okBody({
        codeId: codeId,
        verifyBy: by,
        channel: by === 'qrContent' ? 'qr' : (by === 'code' ? 'code' : 'codeId'),
        isSession: true,
        sessionId: bound.sessionId,
        session: bound,
        sessionInfo: bound,
        expireAt: new Date(row.expireAtMs).toISOString(),
        ttl: Math.max(0, Math.round((row.expireAtMs - Date.now()) / 1000)),
        canConfirm: bound.status === 'wait',
        confirmEndpoint: 'POST /api/v1/sessions/' + bound.sessionId + '/confirm',
        cadre: issuer ? userView(issuer) : null,
        classId: 'C1',
        className: bound.className,
        date: bound.teachDate,
        tasks: []
      });
    }

    return okBody({
      codeId: codeId,
      verifyBy: by,
      channel: by === 'qrContent' ? 'qr' : (by === 'code' ? 'code' : 'codeId'),
      isSession: false,
      sessionId: '',
      date: date,
      expireAt: new Date(row.expireAtMs).toISOString(),
      ttl: Math.max(0, Math.round((row.expireAtMs - Date.now()) / 1000)),
      cadre: issuer ? userView(issuer) : null,
      classId: issuer && issuer.className ? 'C1' : null,
      className: (issuer && issuer.className) || '',
      tasks: tasksOn(date)
    });
  }

  // ---------------- 班级课程清单（业务流程简化第一步）
  if (pathOnly === '/api/v1/class-courses' && method === 'GET') {
    const all = backend.classCourses.length ? backend.classCourses : (backend.classCourses = defaultClassCourses());
    const status = (query.status === undefined || query.status === '') ? 'active' : String(query.status);
    const filtered = status === 'all' ? all : all.filter(function (c) { return c.status === status; });
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || 20);
    return okBody({
      list: filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
      total: filtered.length,
      page: page,
      pageSize: pageSize,
      summary: {
        total: all.length,
        active: all.filter(function (c) { return c.status === 'active'; }).length,
        archived: all.filter(function (c) { return c.status === 'archived'; }).length
      }
    });
  }

  if (pathOnly === '/api/v1/class-courses/today' && method === 'GET') {
    const date = query.date || shape.todayFull();
    const parts = date.split('-');
    const dow = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay();
    const wd = dow === 0 ? 7 : dow;
    const all = backend.classCourses.length ? backend.classCourses : (backend.classCourses = defaultClassCourses());
    const list = all.filter(function (c) { return c.status === 'active' && Number(c.weekday) === wd; });
    return okBody({ date: date, weekday: wd, weekdayText: '周' + '一二三四五六日'.charAt(wd - 1), total: list.length, list: list });
  }

  if (pathOnly === '/api/v1/class-courses' && method === 'POST') {
    if (backend.courseError) {
      const e = backend.courseError;
      return errBody(e.status || 400, e.code || 40001, e.msg);
    }
    if (!body.courseName) return errBody(400, 40001, '课程名称不能为空，请填写后重新提交');
    backend.courseSeq++;
    const row = {
      id: 'CR' + String(backend.courseSeq).padStart(8, '0'),
      classId: 'C1', className: '2025级护理3班',
      courseName: body.courseName, teacherName: body.teacherName || '',
      weekday: body.weekday === '' || body.weekday === undefined ? null : Number(body.weekday),
      section: body.section || '', place: body.place || '', hours: Number(body.hours || 2),
      term: '2026-2027-1', status: 'active', statusText: '使用中', archived: false
    };
    if (!backend.classCourses.length) backend.classCourses = defaultClassCourses();
    backend.classCourses.push(row);
    return okBody(row);
  }

  if (/^\/api\/v1\/class-courses\/[^/]+$/.test(pathOnly) && (method === 'PUT' || method === 'DELETE')) {
    const id = pathOnly.split('/').pop();
    const all = backend.classCourses.length ? backend.classCourses : (backend.classCourses = defaultClassCourses());
    const hit = all.filter(function (c) { return c.id === id; })[0];
    if (!hit) return errBody(404, 40401, '课程清单记录不存在：' + id);
    if (backend.courseError) {
      const e = backend.courseError;
      return errBody(e.status || 400, e.code || 40001, e.msg);
    }
    if (method === 'DELETE') {
      if (hit.status === 'archived') return errBody(422, 42201, '该课程已归档，无需重复删除');
      hit.status = 'archived';
      hit.statusText = '已归档';
      hit.archived = true;
      return okBody({ ok: true, id: hit.id, classId: hit.classId, status: 'archived', archived: true, course: hit });
    }
    Object.keys(body).forEach(function (k) { if (body[k] !== undefined) hit[k] = body[k]; });
    hit.statusText = hit.status === 'archived' ? '已归档' : '使用中';
    return okBody(hit);
  }

  // ---------------- 课时会话（业务流程简化第二步）
  if (pathOnly === '/api/v1/sessions' && method === 'POST') {
    if (backend.sessionError) {
      const e = backend.sessionError;
      return errBody(e.status || 400, e.code || 40001, e.msg);
    }
    if (user.role === 'teacher') return errBody(403, 40301, '仅班干部或管理员可发起课时确认');
    if (!body.teacherName) return errBody(400, 40001, '实际授课人不能为空，请填写后重新提交');
    backend.sessionSeq++;
    const sid = 'R' + backend.sessionSeq;
    const codeId = 'CDS' + backend.sessionSeq;
    backend.codes[codeId] = { code: '654321', issuerToken: tok, expireAtMs: Date.now() + 60000, used: false, sessionId: sid };
    const ref = (backend.classCourses || []).filter(function (c) { return c.id === body.courseId; })[0] || null;
    // 与后端一致：与课程清单逐项比对（授课人/节次/地点/学时），任一不符即为临时调整
    const tempAdjusted = !!body.isTempAdjusted || (ref ? (
      ref.teacherName !== body.teacherName ||
      String(ref.section || '') !== String(body.section || '') ||
      String(ref.place || '') !== String(body.place || '') ||
      Number(ref.hours || 0) !== Number(body.hours || 0)
    ) : false);
    const row = {
      sessionId: sid, id: sid, origin: 'session',
      courseId: body.courseId || '', courseName: body.courseName || '新课程',
      teacherName: body.teacherName, className: '2025级护理3班',
      teachDate: body.teachDate || shape.todayFull(), fullDate: body.teachDate || shape.todayFull(),
      section: body.section || '1-2', time: '08:00–09:40', place: body.place || '',
      hours: Number(body.hours || 2),
      initiatorId: user.id, initiatorName: user.real_name, initiatorDuty: user.duty || '学委',
      isTempAdjusted: tempAdjusted, status: 'wait', statusText: '待教师确认', counted: false,
      codeId: codeId, canConfirm: false, canRefreshCode: true, confirmNameMismatch: false,
      createdAt: '2026-09-27T09:00:00+08:00'
    };
    backend.sessions.unshift(row);
    return okBody({
      sessionId: sid, codeId: codeId, code: '654321', codeLength: 6,
      qrPayload: 'kcsq://code/' + codeId, qrUrl: 'kcsq://code/' + codeId, ttl: 60,
      expireAtMs: Date.now() + 60000, adopted: false,
      channels: { qr: { payload: 'kcsq://code/' + codeId }, code: { value: '654321' } },
      session: row
    });
  }

  if (/^\/api\/v1\/sessions\/[^/]+\/code$/.test(pathOnly) && method === 'POST') {
    const id = pathOnly.split('/')[4];
    const row = (backend.sessions || []).filter(function (s) { return s.sessionId === id; })[0];
    if (!row) return errBody(404, 40401, '课时会话不存在：' + id);
    if (row.status !== 'wait') {
      return errBody(422, 42201, '当前状态为「' + row.status + '」，仅「待教师确认」的课时可刷新动态码');
    }
    backend.sessionSeq++;
    const codeId = 'CDS' + backend.sessionSeq;
    backend.codes[codeId] = { code: '112233', issuerToken: tok, expireAtMs: Date.now() + 60000, used: false, sessionId: id };
    row.codeId = codeId;
    return okBody({
      sessionId: id, codeId: codeId, code: '112233', qrPayload: 'kcsq://code/' + codeId,
      ttl: 60, expireAtMs: Date.now() + 60000, refreshed: true, session: row
    });
  }

  if (pathOnly === '/api/v1/sessions' && method === 'GET') {
    const all = backend.sessions || [];
    let list = query.status ? all.filter(function (s) { return s.status === query.status; }) : all.slice();
    if (query.date) list = list.filter(function (s) { return s.teachDate === query.date; });
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || 20);
    const totals = {};
    ['draft', 'wait', 'done', 'rejected', 'expired', 'appealing', 'makeup', 'revoked'].forEach(function (k) { totals[k] = 0; });
    all.forEach(function (s) { totals[s.status] = (totals[s.status] || 0) + 1; });
    return okBody({
      list: list.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
      total: list.length, page: page, pageSize: pageSize,
      summary: {
        hours: all.filter(function (s) { return s.status === 'done' || s.status === 'makeup'; })
          .reduce(function (a, s) { return a + Number(s.hours || 0); }, 0),
        byStatus: list.reduce(function (a, s) { a[s.status] = (a[s.status] || 0) + 1; return a; }, {}),
        statusTotals: totals
      }
    });
  }

  if (/^\/api\/v1\/sessions\/[^/]+$/.test(pathOnly) && method === 'GET') {
    const id = pathOnly.split('/').pop();
    const row = (backend.sessions || []).filter(function (s) { return s.sessionId === id; })[0];
    if (!row) return errBody(404, 40401, '课时会话不存在：' + id);
    const course = (backend.classCourses.length ? backend.classCourses : defaultClassCourses())
      .filter(function (c) { return c.id === row.courseId; })[0] || null;
    const codeRow = backend.codes[row.codeId] || null;
    return okBody({
      session: row,
      course: course,
      teacher: { id: 'U-T', name: row.teacherName, realName: row.teacherName, role: 'teacher' },
      initiator: { id: row.initiatorId, name: row.initiatorName, realName: row.initiatorName, duty: row.initiatorDuty, role: 'cadre' },
      confirmer: row.confirmedName ? { id: row.confirmedBy, name: row.confirmedName, role: 'teacher' } : null,
      code: codeRow ? { codeId: row.codeId, used: !!codeRow.used, usedAt: '', expireAt: '' } : null,
      auditTail: [{ action: 'session.create', actor: row.initiatorName, at: '2026-09-27T09:00:00+08:00', detail: '班干部发起课时会话并签发动态码' }]
    });
  }

  if (/^\/api\/v1\/sessions\/[^/]+\/confirm$/.test(pathOnly) && method === 'POST') {
    if (backend.confirmError) {
      const e = backend.confirmError;
      return errBody(e.status || 400, e.code || 40001, e.msg);
    }
    const id = pathOnly.split('/')[4];
    const row = (backend.sessions || []).filter(function (s) { return s.sessionId === id; })[0];
    if (!row) return errBody(404, 40401, '课时会话不存在：' + id);
    if (user.role === 'cadre') return errBody(403, 40301, '仅任课教师（或管理员）可确认课时');
    const ref = body.codeId || body.code;
    const codeRow = ref ? backend.codes[ref] : backend.codes[row.codeId];
    if (!codeRow) return errBody(404, 40401, '动态码不存在：' + ref);
    if (codeRow.used) return errBody(410, 41002, '该动态码已被使用，一次动态码只能使用一次，请让班干部刷新后重新出示');
    if (codeRow.expireAtMs <= Date.now()) return errBody(410, 41001, '动态码已过期，请班干部刷新后重新出示');
    if (row.status !== 'wait') return errBody(422, 42201, '该课时当前状态为「' + row.status + '」，无需重复确认');
    codeRow.used = true;
    const sameName = user.real_name === row.teacherName;
    row.confirmedBy = user.id;
    row.confirmedName = user.real_name;
    row.confirmedAt = '2026-09-27T10:05:12+08:00';
    row.confirmedRole = user.role;
    row.confirmDevice = 'Apple iPhone 13';
    row.confirmNameMismatch = !sameName;
    row.status = 'done';
    row.statusText = '已确认';
    row.counted = true;
    return okBody({
      ok: true, sessionId: id, status: 'done', counted: true, nameMismatch: !sameName,
      codeConsumed: ref ? ref : row.codeId, confirmedBy: user.id, confirmedName: user.real_name,
      confirmedAt: row.confirmedAt, confirmedRole: user.role, teacherName: row.teacherName,
      msg: '已确认本次课时', session: row
    });
  }

  if (pathOnly === '/api/v1/tasks' && method === 'GET') {
    const date = query.date || shape.todayFull();
    backend.lastTasksDate = date;
    return okBody(tasksOn(date));
  }

  if (pathOnly === '/api/v1/records' && method === 'GET') {
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || 20);
    const all = backend.records.length ? backend.records : defaultRecords();
    const filtered = query.status ? all.filter(function (r) { return r.status === query.status; }) : all;
    const start = (page - 1) * pageSize;
    const total = backend.totalOverride === null ? filtered.length : backend.totalOverride;
    return okBody({
      list: filtered.slice(start, start + pageSize),
      total: total,
      page: page,
      pageSize: pageSize,
      summary: {
        hours: all.filter(function (r) { return r.status === 'done' || r.status === 'makeup'; })
          .reduce(function (a, r) { return a + Number(r.hours || 0); }, 0),
        // byStatus 受 status= 筛选影响（当前列表内计数）
        byStatus: filtered.reduce(function (acc, r) { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
        // statusTotals 不受 status= 筛选影响（各状态数量角标口径，与服务端一致）
        statusTotals: all.reduce(function (acc, r) { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {})
      }
    });
  }

  if (/^\/api\/v1\/records\/[^/]+$/.test(pathOnly) && method === 'GET') {
    const id = pathOnly.split('/').pop();
    const all = backend.records.length ? backend.records : defaultRecords();
    const hit = all.filter(function (r) { return r.id === id; })[0];
    if (!hit) return errBody(404, 40401, '课时记录不存在：' + id);
    return okBody(Object.assign({}, hit, { evidence: { count: 4 } }));
  }

  if (pathOnly === '/api/v1/records' && method === 'POST') {
    // 场景：模拟后端唯一性/星期校验失败（msg 必须被前端原样展示）
    if (backend.createRecordError) {
      const e = backend.createRecordError;
      return errBody(e.status || 409, e.code || 40901, e.msg);
    }
    const missing = ['taskId', 'teachDate', 'codeId'].filter(function (k) { return !body[k]; });
    if (missing.length) return errBody(400, 40001, '缺少必填参数：' + missing.join(','));
    backend.recordSeq++;
    const rec = {
      id: 'R' + backend.recordSeq,
      taskId: body.taskId,
      courseName: body.courseName || '信息技术',
      className: body.className || '2025级护理3班',
      date: shape.shortDate(body.teachDate),
      fullDate: body.teachDate,
      section: body.section || '第1-2节',
      hours: Number(body.hours || 2),
      status: 'wait',
      statusText: '待确认',
      absentCount: Number(body.absentCount || 0),
      absentNames: body.absentNames || '',
      discipline: body.discipline || 'good',
      disciplineText: shape.DISCIPLINE_TEXT[body.discipline] || '好',
      summary: body.summary || '',
      signerName: body.signerName || '张一鸣',
      signerDuty: body.signerDuty || '学委',
      codeId: body.codeId,
      canSign: false,
      canRevoke: true
    };
    backend.records.unshift(rec);
    return okBody(rec);
  }

  if (/^\/api\/v1\/records\/[^/]+\/sign$/.test(pathOnly) && method === 'POST') {
    const id = pathOnly.split('/')[4];
    const hit = backend.records.filter(function (r) { return r.id === id; })[0];
    if (!hit) return errBody(404, 40401, '课时记录不存在：' + id);
    hit.status = 'done';
    hit.statusText = '已确认';
    hit.confirmedAt = '2026-09-27T10:00:00+08:00';
    return okBody(hit);
  }

  if (/^\/api\/v1\/records\/[^/]+\/reject$/.test(pathOnly) && method === 'POST') {
    const id = pathOnly.split('/')[4];
    const hit = backend.records.filter(function (r) { return r.id === id; })[0];
    if (!hit) return errBody(404, 40401, '课时记录不存在：' + id);
    hit.status = 'rejected';
    hit.note = '班干部拒绝：' + (body.reason || '');
    return okBody(hit);
  }

  if (pathOnly === '/api/v1/stats/by-dept' && method === 'GET') {
    return okBody([{ name: '护理学院', hours: 486 }, { name: '药学院', hours: 362 }]);
  }

  return errBody(404, 40401, '假后端未实现的接口：' + method + ' ' + pathOnly);
}

function defaultRecords() {
  return [
    { id: 'R1', courseName: '信息技术', className: '2025级护理3班', date: '09-27', fullDate: '2026-09-27', section: '第1-2节', hours: 2, status: 'wait', statusText: '待确认', note: '', canSign: true, canReject: true, signerName: '张一鸣', signerDuty: '学委' },
    { id: 'R2', courseName: '医学信息检索', className: '2025级药学1班', date: '09-24', fullDate: '2026-09-24', section: '第3-4节', hours: 2, status: 'done', statusText: '已确认', note: '', signature: '/api/v1/files/SG1', signedAt: '2026-09-24T15:00:00+08:00', device: 'Apple iPhone 13', codeId: 'CD00000002' },
    { id: 'R3', courseName: '大学计算机基础', className: '2025级护理3班', date: '09-20', fullDate: '2026-09-20', section: '第5-6节', hours: 2, status: 'expired', statusText: '已过期', note: '超过当天 24 点未确认' }
  ];
}

/** 某教学班当日的授课任务（/tasks 与 /code/verify 共用，字段与后端 shapeTask 一致） */
function tasksOn(date) {
  return [
    { id: 'T1', taskId: 'T1', courseName: '信息技术', className: '2025级护理3班', section: '第1-2节', time: '08:00–09:40', place: '实训楼A302', hours: 2, status: 'wait', recordId: 'R1', signerId: 'U-2025030117', signerName: '张一鸣', signerDuty: '学委', fullDate: date },
    { id: 'T2', taskId: 'T2', courseName: '信息技术', className: '2025级药学1班', section: '第3-4节', time: '10:05–11:45', place: '实训楼A302', hours: 2, status: 'done', recordId: 'R2', signerId: 'U-2025040201', signerName: '陈思远', signerDuty: '学委', confirmer: '学委 陈思远', fullDate: date }
  ];
}

/** 今天的星期（1=周一 … 7=周日，与后端 weekday 口径一致） */
function todayWeekday() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

/** 班级课程清单（假后端初始数据，字段与后端 shapeClassCourse 一致） */
function defaultClassCourses() {
  const wd = todayWeekday();
  const other = (wd % 7) + 1;
  const cn = function (n) { return '周' + '一二三四五六日'.charAt(n - 1); };
  return [
    { id: 'CR00000001', classCourseId: 'CR00000001', classId: 'C1', className: '2025级护理3班', courseName: '信息技术', teacherName: '唐瑞明', teacherNo: '2010032', weekday: wd, weekdayText: cn(wd), section: '1-2', startTime: '08:00', endTime: '09:40', time: '08:00–09:40', place: '实训楼A302', hours: 2, term: '2026-2027-1', status: 'active', statusText: '使用中', archived: false },
    { id: 'CR00000002', classCourseId: 'CR00000002', classId: 'C1', className: '2025级护理3班', courseName: '医学信息检索', teacherName: '唐瑞明', teacherNo: '2010032', weekday: other, weekdayText: cn(other), section: '3-4', startTime: '10:05', endTime: '11:45', time: '10:05–11:45', place: '图书馆电子阅览室', hours: 2, term: '2026-2027-1', status: 'active', statusText: '使用中', archived: false },
    { id: 'CR00000003', classCourseId: 'CR00000003', classId: 'C1', className: '2025级护理3班', courseName: '大学计算机基础', teacherName: '李慧', teacherNo: '2010044', weekday: 5, weekdayText: '周五', section: '5-6', startTime: '14:00', endTime: '15:40', time: '14:00–15:40', place: '实训楼B105', hours: 2, term: '2026-2027-1', status: 'archived', statusText: '已归档', archived: true }
  ];
}

// ================================================================ wx / App / Page 桩
const storage = {};
const calls = { toasts: [], modals: [], navigations: [], canvas: [], uploads: [], downloads: [], login: 0 };
let modalReply = { confirm: true };
let scanResultOverride = '';   // 教师扫码结果（可被用例改写为课时会话码）

function resetCalls() {
  calls.toasts = []; calls.modals = []; calls.navigations = [];
  calls.canvas = []; calls.uploads = []; calls.downloads = [];
}

function makeCanvasContext(id) {
  const ops = { id: id, fills: [], colors: [], draws: 0 };
  calls.canvas.push(ops);
  return {
    setFillStyle: function (c) { ops.colors.push(c); },
    fillRect: function (x, y, w, h) { ops.fills.push([x, y, w, h]); },
    draw: function () { ops.draws++; },
    setStrokeStyle: function () {}, setLineWidth: function () {}, setLineCap: function () {},
    setLineJoin: function () {}, moveTo: function () {}, lineTo: function () {}, stroke: function () {},
    clearRect: function () {}
  };
}

let appInstance = null;

global.App = function (cfg) {
  const inst = {};
  Object.keys(cfg).forEach(function (k) { inst[k] = cfg[k]; });
  inst.globalData = cfg.globalData;
  appInstance = inst;
  return inst;
};
global.getApp = function () { return appInstance; };

global.wx = {
  env: { USER_DATA_PATH: '/tmp/miniprogram' },
  getSystemInfoSync: function () { return { windowWidth: 375, brand: 'Apple', model: 'iPhone 13' }; },
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { calls.toasts.push(o); },
  showModal: function (o) {
    calls.modals.push(o);
    if (typeof o.success === 'function') o.success(modalReply);
  },
  navigateTo: function (o) { calls.navigations.push({ type: 'navigateTo', url: o.url }); if (o.success) o.success(); },
  navigateBack: function (o) { calls.navigations.push({ type: 'navigateBack', delta: (o && o.delta) || 1 }); },
  redirectTo: function (o) { calls.navigations.push({ type: 'redirectTo', url: o.url }); },
  reLaunch: function (o) { calls.navigations.push({ type: 'reLaunch', url: o.url }); },
  switchTab: function (o) { calls.navigations.push({ type: 'switchTab', url: o.url }); if (o.success) o.success(); },
  setClipboardData: function (o) { if (o.success) o.success(); },
  setNavigationBarTitle: function () {},
  createCanvasContext: function (id) { return makeCanvasContext(id); },
  canvasToTempFilePath: function (o) { if (o.success) o.success({ tempFilePath: '/tmp/sign.png' }); },
  getFileSystemManager: function () {
    return { saveFile: function (o) { if (o.success) o.success({ savedFilePath: o.filePath }); else if (o.fail) o.fail({}); } };
  },
  login: function (o) {
    // 每次 wx.login 给一个不同的 code：后端 DEV_MODE 下 openid 由 code 派生，
    // 这样桩里每次都是「新微信」，才能走到 needBind → /auth/bind 分支。
    calls.login++;
    const code = 'wx-code-' + String(calls.login).padStart(3, '0');
    if (o.success) o.success({ code: code });
  },
  scanCode: function (o) { if (o.success) o.success({ result: scanResultOverride || 'kcsq://code/CD00000001' }); },
  request: function (o) {
    const rec = { url: o.url, method: (o.method || 'GET').toUpperCase(), data: o.data, header: o.header };
    requests.push(rec);
    const res = route(o);
    rec.response = res.data;
    if (o.success) o.success(res);
  },
  uploadFile: function (o) {
    calls.uploads.push({ url: o.url, name: o.name, filePath: o.filePath, formData: o.formData, header: o.header });
    requests.push({ url: o.url, method: 'POST', data: o.formData, header: o.header, upload: true });
    const res = route({ url: o.url, method: 'POST', data: o.formData || {}, header: o.header });
    if (o.success) o.success({ statusCode: res.statusCode, data: JSON.stringify(res.data) });
  },
  downloadFile: function (o) {
    calls.downloads.push({ url: o.url, header: o.header });
    const tok = bearer(o.header);
    if (backend.boundTokens[tok]) {
      if (o.success) o.success({ statusCode: 200, tempFilePath: '/tmp/sig_downloaded.png' });
    } else if (o.fail) {
      o.fail({ errMsg: 'downloadFile:fail 401' });
    }
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
  // 支持 'form.courseName' 这类嵌套路径（与微信 setData 语义一致）
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

/** 造一个「已登录」的本地状态（模拟上次会话仍然有效） */
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

// ================================================================ 主流程
async function main() {
  // ---- 载入 app.js（App() 桩会捕获实例）
  delete require.cache[require.resolve(path.join(ROOT, 'miniprogram/app.js'))];
  require(path.join(ROOT, 'miniprogram/app.js'));
  const app = appInstance;
  app.globalData.useMock = false;          // 关键：走真实请求分支
  app.globalData.apiBase = BASE;

  const session = require(path.join(ROOT, 'miniprogram/utils/session.js'));

  // ================================================================ 1
  section('1. 未绑定 → 首页给出「去绑定」引导（不静默失败）');
  Object.keys(storage).forEach(function (k) { delete storage[k]; });
  requests.length = 0;
  resetCalls();
  app.onLaunch();
  await app.ready();
  check(storage.token === undefined, '全新设备上没有 token', 'token=' + storage.token);
  check(app.globalData.needBind === true, 'app.onLaunch 判定为「未绑定」（needBind=true）');

  let indexPage = loadPage('miniprogram/pages/index/index.js');
  resetCalls();
  indexPage.onLoad({});
  indexPage.onShow();
  await sleep(80);
  check(indexPage.data.needBind === true, '首页进入「去绑定」引导分支（不再是空白/静默失败）', 'needBind=' + indexPage.data.needBind);
  check(indexPage.data.code === '' && indexPage.data.qrPayload === '',
    '未绑定时不签发动态码（不会出现「获取失败」死循环）', 'code="' + indexPage.data.code + '" qr="' + indexPage.data.qrPayload + '"');
  check(requestOf('/api/v1/code/generate').length === 0, '未绑定时没有发出 /code/generate 请求');
  resetCalls();
  indexPage.goBind();
  check(calls.navigations.some(function (n) { return n.type === 'navigateTo' && n.url === '/pages/bind/bind'; }),
    '引导可点击跳转 pages/bind/bind', JSON.stringify(calls.navigations[0] || {}));

  // ================================================================ 2
  section('2. 执行绑定 → token 落盘 + role=班干部');
  const bindPage = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  bindPage.onLoad({});
  bindPage.setData({ realName: '张一鸣', no: '2025030117', roleIndex: 1 });   // 1 = 班干部
  const beforeBind = requests.length;
  bindPage.submit();
  await sleep(80);

  const loginReq = requestOf('/api/v1/auth/login', 'POST');
  const bindReq = requestOf('/api/v1/auth/bind', 'POST');
  check(loginReq.length === 1 && loginReq[0].data.code === 'wx-code-001',
    '① wx.login 取 code → POST /auth/login {code}', 'code=' + (loginReq[0] || {}).data && (loginReq[0].data || {}).code);
  check(bindReq.length === 1, '② 未绑定（needBind=true）时继续调 POST /auth/bind');
  check(bindReq.length === 1 && bindReq[0].data.openid && bindReq[0].data.bindTicket === 'TICKET-' + bindReq[0].data.openid,
    '③ bind 带上 login 返回的 openid + bindTicket', JSON.stringify(bindReq[0] ? { openid: bindReq[0].data.openid, bindTicket: bindReq[0].data.bindTicket } : null));
  check(bindReq.length === 1 && bindReq[0].data.role === 'cadre' && bindReq[0].data.no === '2025030117' && bindReq[0].data.realName === '张一鸣',
    '④ bind 带上角色/工号学号/姓名', bindReq.length ? JSON.stringify({ role: bindReq[0].data.role, no: bindReq[0].data.no, realName: bindReq[0].data.realName }) : '无');
  check(typeof storage.token === 'string' && storage.token.indexOf('TOKEN-') === 0,
    '⑤ token 已被写入 storage（本次 bug 的根因就是此前没有任何代码写 token）', 'token=' + storage.token);
  check(storage.role === 'cadre', '⑥ storage.role = cadre', storage.role);
  check(storage.user && storage.user.no === '2025030117' && storage.user.name === '张一鸣',
    '⑦ storage.user 为后端返回的真实用户', JSON.stringify(storage.user && { name: storage.user.name, no: storage.user.no }));
  check(app.globalData.role === 'cadre' && app.globalData.user && app.globalData.user.no === '2025030117',
    '⑧ app.globalData.role/user 同步更新', app.globalData.role);
  check(app.globalData.needBind === false, '⑨ 绑定成功后清掉 needBind 标记');
  await sleep(900);
  check(calls.navigations.some(function (n) { return n.type === 'switchTab' && n.url === '/pages/index/index'; }),
    '⑩ 绑定成功后跳回首页', JSON.stringify(calls.navigations.map(function (n) { return n.type + ':' + n.url; })));
  check(requests.length > beforeBind, '本次提交确实发出了网络请求（不是只写本地）', (requests.length - beforeBind) + ' 个请求');

  // ================================================================ 3
  section('3. 绑定失败 → 后端 msg 原样展示 + 可操作建议');

  // 3.1 白名单里没有的工号
  let p = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  p.onLoad({});
  p.setData({ realName: '李某某', no: '2025999999', roleIndex: 0 });
  p.submit();
  await sleep(80);
  check(p.data.errorMsg === '工号/学号 2025999999 不在白名单内，无法绑定',
    '① 「不在白名单」：errorMsg 与后端 msg 完全一致', p.data.errorMsg);
  check(/加入白名单/.test(p.data.advice), '② 给出可操作建议（联系教务处加白名单）', p.data.advice);
  check(calls.toasts.some(function (t) { return t.title === p.data.errorMsg; }),
    '③ 同时用 toast 原样提示后端 msg');

  // 3.2 姓名不一致
  p = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  p.onLoad({});
  p.setData({ realName: '张一明', no: '2025030117', roleIndex: 1 });
  p.submit();
  await sleep(80);
  check(/对应姓名为「张一鸣」，与填写的不一致/.test(p.data.errorMsg),
    '④ 「姓名不一致」：原样展示后端的姓名提示', p.data.errorMsg);

  // 3.3 已被其他微信绑定
  p = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  p.onLoad({});
  p.setData({ realName: '唐瑞明', no: '2010032', roleIndex: 0 });
  p.submit();
  await sleep(80);
  check(p.data.errorMsg === '该工号/学号已被其他微信绑定，请联系教务处',
    '⑤ 「已被其他微信绑定」：原样展示', p.data.errorMsg);
  // 说明：自助解绑（换绑）上线后，该场景的建议文案由「联系教务处解绑」改为
  //      「点下方自助解绑并重新绑定」（并保留联系教务处的兜底），此处同步断言新文案。
  check(/只能绑定一个微信/.test(p.data.advice) && /自助解绑并重新绑定/.test(p.data.advice) && /联系教务处/.test(p.data.advice),
    '⑥ 给出可操作建议（一码一微信 / 自助解绑并重新绑定 / 教务处兜底）', p.data.advice);

  // 3.4 角色选错
  p = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  p.onLoad({});
  p.setData({ realName: '张一鸣', no: '2025030117', roleIndex: 0 });   // 选成教师
  p.submit();
  await sleep(80);
  check(/角色为「cadre」，与填写的不一致/.test(p.data.errorMsg), '⑦ 「角色不一致」原样展示', p.data.errorMsg);
  check(/身份选择与白名单不一致/.test(p.data.advice), '⑧ 给出改选身份的建议', p.data.advice);

  // ================================================================ 4
  section('4. 班干部首页 → GET /class-courses/today + POST /sessions（code + qrPayload）→ canvas');
  // 上面 3.x 的失败尝试没有改变 storage（仍是 2025030117 班干部），断言一下
  check(storage.role === 'cadre' && !!storage.token, '绑定失败不会破坏已有登录态', storage.role);

  const api = require(path.join(ROOT, 'miniprogram/utils/api.js'));
  backend.classCourses = defaultClassCourses();
  backend.sessions = [];
  requests.length = 0;
  resetCalls();
  indexPage = loadPage('miniprogram/pages/index/index.js');
  indexPage.onLoad({});
  indexPage.onShow();
  await sleep(160);

  const todayReq = requestOf('/api/v1/class-courses/today', 'GET')[0];
  check(!!todayReq, '① 班干部首页调用 GET /class-courses/today');
  check(!!todayReq && todayReq.data && todayReq.data.date === shape.todayFull(),
    '② date 参数 = 今天（YYYY-MM-DD）', todayReq ? JSON.stringify(todayReq.data) : '无');
  check(!!todayReq && /^Bearer\s+TOKEN-/.test(String(todayReq.header.Authorization)),
    '③ 请求头带上 Authorization: Bearer <token>（根因修复的实证）',
    todayReq ? String(todayReq.header.Authorization).slice(0, 24) + '…' : '无请求');
  check(indexPage.data.courses.length === 1,
    '④ 只展示「今天该星期有课」的课程（周三 1 门）', indexPage.data.courses.length + ' 门');
  check(requestOf('/api/v1/sessions', 'GET').length === 1, '⑤ 同时拉本班最近课时 GET /sessions');
  check(indexPage.data.needBind === false, '已登录 → 不显示绑定引导');

  // 点「出示二维码」：POST /sessions（缺省从课程清单带出，不重复录入）
  requests.length = 0;
  resetCalls();
  indexPage.presentCode({ currentTarget: { dataset: { id: indexPage.data.courses[0].id } } });
  await sleep(160);
  const sessPost = requestOf('/api/v1/sessions', 'POST')[0];
  check(!!sessPost, '⑥ 点「出示二维码」→ POST /sessions');
  const sp = (sessPost && sessPost.data) || {};
  check(sp.courseId === 'CR00000001' && sp.courseName === '信息技术' && sp.teacherName === '唐瑞明' &&
    sp.teachDate === shape.todayFull() && sp.section === '1-2' && sp.place === '实训楼A302' && Number(sp.hours) === 2,
    '⑦ 请求体从课程清单带出（courseId/courseName/teacherName/teachDate/section/place/hours）', JSON.stringify(sp));
  check(!!sessPost && /^Bearer\s+TOKEN-/.test(String(sessPost.header.Authorization)), '⑧ POST /sessions 带 Authorization');
  check(indexPage.data.code === '654321', '⑨ 拿到 6 位数字口令（B 通道，含前导零不丢）', 'code=' + indexPage.data.code);
  check(indexPage.data.qrPayload === 'kcsq://code/' + indexPage.data.codeId && /^CDS\d+$/.test(indexPage.data.codeId),
    '⑩ 拿到二维码载荷（A 通道）', indexPage.data.qrPayload);
  check(indexPage.data.codeDisplay === '6 5 4 3 2 1', '⑪ 口令按位间隔展示，便于教师手输', indexPage.data.codeDisplay);
  check(indexPage.data.panel.show === true && indexPage.data.panel.sessionId === 'R1' &&
    indexPage.data.panel.statusText === '待教师确认',
    '⑫ 展示本次课时（会话 id + 状态文案）', indexPage.data.panel.sessionId + ' / ' + indexPage.data.panel.statusText);
  check(indexPage.data.seconds === 60 && indexPage.data.codeExpired === false && indexPage.data.codeError === '',
    '⑬ 60 秒倒计时启动且无错误态', 'seconds=' + indexPage.data.seconds);
  const canvas = calls.canvas[0];
  check(!!canvas && canvas.draws === 1 && canvas.fills.length > 1,
    '⑭ 真正进入 canvas 渲染分支并绘制了二维码', canvas ? (canvas.fills.length + ' 次 fillRect / draw×' + canvas.draws) : '未绘制');
  check(!!canvas && canvas.fills[0][2] === indexPage.data.qrSize,
    '⑮ 首笔为整块白底（含静默区）', canvas ? canvas.fills[0].join(',') : '无');

  // 二维码过期 → 刷新（同一会话换新码）
  const firstCodeId = indexPage.data.codeId;
  requests.length = 0;
  indexPage.refreshCodeTap();
  await sleep(160);
  const refreshReq = requests.filter(function (r) { return /\/api\/v1\/sessions\/R1\/code$/.test(r.url); })[0];
  check(!!refreshReq && refreshReq.method === 'POST', '⑯ 刷新 → POST /sessions/{id}/code', refreshReq ? refreshReq.url.replace(BASE, '') : '无');
  check(indexPage.data.codeId && indexPage.data.codeId !== firstCodeId,
    '⑰ 同一会话换新码（codeId 变化）', firstCodeId + ' → ' + indexPage.data.codeId);
  check(indexPage.data.seconds === 60, '⑱ 刷新后倒计时重置为 60 秒');
  indexPage.stopTimer();

  // 临时调整：本次课走调整值 + 可选「同时保存到课程清单」（无需审批）
  requests.length = 0;
  resetCalls();
  indexPage.openAdjust({ currentTarget: { dataset: { id: 'CR00000001' } } });
  check(indexPage.data.adj.show === true && indexPage.data.adj.courseName === '信息技术',
    '⑲ 「临时调整」带出本次课信息', indexPage.data.adj.courseName);
  indexPage.setData({
    'adj.teacherName': '王代课', 'adj.section': '7-8', 'adj.place': '教学楼B201', 'adj.saveToCourse': true
  });
  indexPage.submitAdjust();
  await sleep(200);
  const adjPost = requests.filter(function (r) { return r.method === 'POST' && /\/api\/v1\/sessions$/.test(r.url); })[0];
  check(!!adjPost && adjPost.data.teacherName === '王代课' && adjPost.data.section === '7-8' && adjPost.data.place === '教学楼B201',
    '⑳ 临时调整后仍走 POST /sessions（本次课用调整值）', adjPost ? JSON.stringify({ t: adjPost.data.teacherName, s: adjPost.data.section }) : '无');
  check(indexPage.data.panel.isTempAdjusted === true, '㉑ 后端返回 isTempAdjusted=true（临时调整已标记）',
    'tempAdjusted=' + indexPage.data.panel.isTempAdjusted);
  const putReq = requests.filter(function (r) { return r.method === 'PUT'; })[0];
  check(!!putReq && putReq.url === BASE + '/api/v1/class-courses/CR00000001' && putReq.data.teacherName === '王代课',
    '㉒ 勾选「同时保存到课程清单」→ 额外 PUT /class-courses/{id}',
    putReq ? (putReq.url.replace(BASE, '') + ' ' + JSON.stringify(putReq.data)) : '无');
  const savedCourse = (backend.classCourses || []).filter(function (c) { return c.id === 'CR00000001'; })[0];
  check(!!savedCourse && savedCourse.teacherName === '王代课' && savedCourse.section === '7-8',
    '㉓ 课程清单已同步（PUT 生效）', savedCourse ? (savedCourse.teacherName + ' / ' + savedCourse.section) : '未找到');
  const presentedCodeId = indexPage.data.codeId;
  indexPage.stopTimer();

  // ================================================================ 5
  section('5. 教师端首页 → GET /tasks + GET /sessions?status=wait + 扫码确认入口');
  // 换教师登录态（模拟另一位用户绑定后的会话）
  const teacherUser = userView({ no: '2010032', real_name: '唐瑞明', role: 'teacher' });
  backend.boundTokens['TOKEN-TEACHER'] = { no: '2010032', real_name: '唐瑞明', role: 'teacher' };
  seedSession('TOKEN-TEACHER', teacherUser);
  app.globalData.token = 'TOKEN-TEACHER';
  app.globalData.role = 'teacher';
  app.globalData.user = teacherUser;
  app.globalData.needBind = false;

  requests.length = 0;
  resetCalls();
  let teacherPage = loadPage('miniprogram/pages/index/index.js');
  teacherPage.onLoad({});
  teacherPage.onShow();
  await sleep(200);
  const tasksReq = requestOf('/api/v1/tasks', 'GET')[0];
  check(!!tasksReq, '① 教师端首页调用 GET /tasks');
  check(!!tasksReq && tasksReq.data && tasksReq.data.date === shape.todayFull(),
    '② date 参数 = 今天（YYYY-MM-DD）', tasksReq ? JSON.stringify(tasksReq.data) : '无');
  check(!!tasksReq && /^Bearer\s+TOKEN-TEACHER/.test(String(tasksReq.header.Authorization)),
    '③ /tasks 请求带 Authorization');
  check(teacherPage.data.tasks.length === 2, '④ 渲染出后端返回的当日课程（2 门）', teacherPage.data.tasks.length + ' 门');
  check(teacherPage.data.todayCount === 2 && teacherPage.data.doneCount === 1 && teacherPage.data.waitCount === 2,
    '⑤ 今日/已确认/待确认 计数由真实数据算出',
    [teacherPage.data.todayCount, teacherPage.data.doneCount, teacherPage.data.waitCount].join('/'));
  const waitReq = requestOf('/api/v1/sessions', 'GET').filter(function (r) { return r.data && r.data.status === 'wait'; })[0];
  check(!!waitReq, '⑥ 教师端拉「待我确认的课时」GET /sessions?status=wait', waitReq ? JSON.stringify(waitReq.data) : '无');
  check(teacherPage.data.waitSessions.length === 2, '⑦ 渲染待确认课时列表（2 条）', teacherPage.data.waitSessions.length + ' 条');
  check(teacherPage.data.weekHours === 0 || Number.isFinite(Number(teacherPage.data.weekHours)),
    '⑦b 本周学时取自 GET /sessions 的 summary.hours', 'weekHours=' + teacherPage.data.weekHours);

  // 扫码确认入口：扫到课时会话码 → 跳「课时确认页」
  scanResultOverride = 'kcsq://code/' + presentedCodeId;
  resetCalls();
  teacherPage.startScan();
  check(calls.navigations.some(function (n) { return n.url === '/pages/create/create?codeId=' + presentedCodeId; }),
    '⑧ 扫码结果解析后跳课时确认页（不填表）', JSON.stringify(calls.navigations[0] || {}));

  // 手输 6 位口令（B 通道）
  resetCalls();
  modalReply = { confirm: true, content: '654321' };
  teacherPage.inputPassCode();
  check(calls.navigations.some(function (n) { return n.url === '/pages/create/create?code=654321'; }),
    '⑨ 手输 6 位口令 → 跳课时确认页', JSON.stringify(calls.navigations[0] || {}));
  modalReply = { confirm: true };

  // 点今日授课里未发起的课 → 提示让班干部出示二维码（教师不再填表）
  resetCalls();
  teacherPage.openRecord({ currentTarget: { dataset: { id: 'T9', recordId: '' } } });
  check(calls.modals.length === 1 && /尚未发起确认/.test(calls.modals[0].title),
    '⑩ 点未发起的课程 → 明确提示走「扫码确认」', (calls.modals[0] || {}).title);
  check(calls.modals[0] && /出示二维码/.test(calls.modals[0].content || ''),
    '⑪ 提示内容引导班干部出示二维码（不再要教师填表 / 签名）', (calls.modals[0] || {}).content);

  // ================================================================ 6
  section('6. 记录页 → GET /sessions 分页 + 状态筛选 + statusTotals 角标');
  backend.sessions = [];
  backend.sessionSeq = 40;
  for (let i = 0; i < 25; i++) {
    backend.sessions.push({
      sessionId: 'RP' + i, id: 'RP' + i, courseName: '信息技术', className: '2025级护理3班',
      teacherName: '唐瑞明', teachDate: shape.todayFull(), date: shape.shortDate(shape.todayFull()),
      section: '第1-2节', place: '实训楼A302', hours: 2,
      status: i % 2 === 0 ? 'wait' : 'done',
      statusText: i % 2 === 0 ? '待教师确认' : '已确认',
      initiatorName: '张一鸣', initiatorDuty: '学委', isTempAdjusted: i % 5 === 0,
      confirmedName: i % 2 === 0 ? '' : '唐瑞明'
    });
  }
  requests.length = 0;
  resetCalls();
  const recordsPage = loadPage('miniprogram/pages/records/records.js');
  recordsPage.onShow();
  await sleep(200);
  const listReq1 = requestOf('/api/v1/sessions', 'GET').filter(function (r) { return Number(r.data && r.data.page) === 1; })[0];
  check(!!listReq1 && Number(listReq1.data.pageSize) === 20, '① 第一页按 pageSize=20 请求（服务端分页）', listReq1 ? JSON.stringify(listReq1.data) : '无');
  check(recordsPage.data.list.length === 20, '② 第一页取回 20 条', recordsPage.data.list.length + ' 条');
  check(/共 25 条/.test(recordsPage.data.summary), '③ 汇总用后端 total（共 25 条）', recordsPage.data.summary);
  check(recordsPage.data.list.every(function (s) { return !!s.statusText; }),
    '④ 列表项带状态文案（待教师确认 / 已确认）', recordsPage.data.list[0].statusText);
  check(JSON.stringify(recordsPage.data.badges) === JSON.stringify([0, 13, 12, 0]),
    '⑤ 角标走 summary.statusTotals（wait=13 / done=12 / expired=0）', JSON.stringify(recordsPage.data.badges));
  await recordsPage.onReachBottom();
  await sleep(200);
  check(recordsPage.data.list.length === 25, '⑥ 上拉加载第二页后共 25 条', recordsPage.data.list.length + ' 条');
  check(requestOf('/api/v1/sessions', 'GET').some(function (r) { return Number(r.data && r.data.page) === 2; }),
    '⑦ 拉第二页时 page=2（不是重复拉第一页）');

  resetCalls();
  requests.length = 0;
  recordsPage.switchTab({ currentTarget: { dataset: { index: 1 } } });   // 待教师确认
  await sleep(200);
  check(requestOf('/api/v1/sessions', 'GET').some(function (r) { return r.data && r.data.status === 'wait'; }),
    '⑧ 切「待教师确认」标签 → 按 status=wait 重新请求',
    JSON.stringify((requestOf('/api/v1/sessions', 'GET')[0] || {}).data || null));
  check(recordsPage.data.list.every(function (s) { return s.status === 'wait'; }),
    '⑨ 列表只含待教师确认的课时', recordsPage.data.list.length + ' 条');
  check(JSON.stringify(recordsPage.data.badges) === JSON.stringify([0, 13, 12, 0]),
    '⑩ 切标签后角标不随筛选归零（仍取全部状态计数）', JSON.stringify(recordsPage.data.badges));

  resetCalls();
  recordsPage.openDetail({ currentTarget: { dataset: { id: 'RP0' } } });
  check(calls.navigations.some(function (n) { return n.url === '/pages/check/check?id=RP0'; }),
    '⑪ 点击列表项跳详情页', JSON.stringify(calls.navigations[0] || {}));

  // ================================================================ 7
  section('7. 详情页 → GET /sessions/{id}（证据四项 / 课程快照 / 审计尾部，无手写签名图）');
  backend.codes['CDS901'] = { code: '135790', expireAtMs: Date.now() + 60000, used: true, sessionId: 'RS1' };
  backend.sessions = [{
    sessionId: 'RS1', id: 'RS1', courseId: 'CR00000001', courseName: '信息技术', className: '2025级护理3班',
    teacherName: '唐瑞明', teachDate: '2026-09-27', date: '09-27', section: '1-2', time: '08:00–09:40',
    place: '实训楼A302', hours: 2, status: 'done', statusText: '已确认', counted: true,
    initiatorId: 'U-2025030117', initiatorName: '张一鸣', initiatorDuty: '学委', isTempAdjusted: true,
    confirmedBy: 'U-2010032', confirmedName: '唐瑞明', confirmedAt: '2026-09-27T10:05:12+08:00',
    confirmDevice: 'Apple iPhone 13', confirmNameMismatch: false, codeId: 'CDS901',
    absentCount: 0, absentNames: '', summary: '第 3 章 数据库基础'
  }];
  requests.length = 0;
  resetCalls();
  const checkPage = loadPage('miniprogram/pages/check/check.js');
  checkPage.onLoad({ id: 'RS1' });
  checkPage.onShow();
  await sleep(200);
  check(requestOf('/api/v1/sessions/RS1', 'GET').length === 1, '① 详情调 GET /sessions/{id}');
  check(/^Bearer\s+TOKEN-TEACHER/.test(String(requestOf('/api/v1/sessions/RS1', 'GET')[0].header.Authorization)),
    '② 详情请求带 Authorization');
  check(checkPage.data.session.status === 'done' && checkPage.data.session.statusText === '已确认',
    '③ 状态与状态文案来自后端', checkPage.data.session.status + '/' + checkPage.data.session.statusText);
  check(checkPage.data.evidence.length === 4 &&
    checkPage.data.evidence.map(function (e) { return e.label; }).join('、') === '动态码、确认人、确认时间、设备',
    '④ 证据固定四项（动态码/确认人/确认时间/设备），不含手写签名与定位',
    checkPage.data.evidence.map(function (e) { return e.label; }).join('、'));
  check(checkPage.data.evidence[1].value === '唐瑞明' &&
    /2026-09-27 10:05/.test(checkPage.data.evidence[2].value) &&
    checkPage.data.evidence[3].value === 'Apple iPhone 13',
    '⑤ 证据取值来自后端确认信息', checkPage.data.evidence.map(function (e) { return e.value; }).join(' | '));
  check(checkPage.data.evidence[0].value === 'CDS901（已消费）', '⑥ 动态码显示为已消费状态', checkPage.data.evidence[0].value);
  check(!!checkPage.data.course && checkPage.data.course.courseName === '信息技术' && checkPage.data.course.hours === 2,
    '⑦ 展示课程清单快照', checkPage.data.course ? checkPage.data.course.courseName : '无');
  check(checkPage.data.auditTail.length === 1 && /session\.create/.test(checkPage.data.auditTail[0].action),
    '⑧ 展示审计尾部（操作留痕）', checkPage.data.auditTail[0].action);
  check(calls.downloads.length === 0, '⑨ 详情不再下载签名图（证据四项里没有手写签名）', calls.downloads.length + ' 次下载');
  check(checkPage.data.session.isTempAdjusted === true, '⑩ 临时调整标记为过程信息展示');

  // ================================================================ 8
  section('8. 课时确认页 → POST /code/verify（isSession）→ POST /sessions/{id}/confirm');
  // 班干部发起一次课时（真实 token）
  backend.boundTokens['TOKEN-CADRE'] = { no: '2025030117', real_name: '张一鸣', role: 'cadre', className: '2025级护理3班', duty: '学委' };
  seedSession('TOKEN-CADRE', userView({ no: '2025030117', real_name: '张一鸣', role: 'cadre', className: '2025级护理3班', duty: '学委' }));
  const issued = await api.createSession({
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明',
    teachDate: shape.todayFull(), section: '1-2', place: '实训楼A302', hours: 2
  });
  check(!!issued.sessionId && !!issued.code, '前置：班干部发起课时拿到 code + qrPayload', issued.sessionId + ' / ' + issued.code);

  // 教师核验（A 扫码通道）
  seedSession('TOKEN-TEACHER', teacherUser);
  requests.length = 0;
  resetCalls();
  let createPage = loadPage('miniprogram/pages/create/create.js');
  createPage.onLoad({ codeId: issued.codeId });
  await sleep(200);
  const verifyReq = requestOf('/api/v1/code/verify', 'POST')[0];
  check(!!verifyReq && verifyReq.data.codeId === issued.codeId,
    '① 核验走 POST /code/verify {codeId}', verifyReq ? JSON.stringify(verifyReq.data) : '无');
  check(createPage.data.verifyState === 'session', '② isSession=true → 进入课时确认态',
    'state=' + createPage.data.verifyState + ' ' + createPage.data.verifyError);
  check(createPage.data.session.courseName === '信息技术' && createPage.data.session.teacherName === '唐瑞明' &&
    createPage.data.session.className === '2025级护理3班' && createPage.data.session.section === '1-2' &&
    createPage.data.session.place === '实训楼A302' && Number(createPage.data.session.hours) === 2,
    '③ 展示本次课时信息（课程/实际授课人/班级/节次/地点/学时）',
    [createPage.data.session.courseName, createPage.data.session.teacherName, createPage.data.session.className,
      createPage.data.session.section, createPage.data.session.place, createPage.data.session.hours].join(' / '));
  check(createPage.data.session.initiatorDuty === '学委' && createPage.data.session.initiatorName === '张一鸣',
    '④ 展示发起人（班干部）', createPage.data.session.initiatorDuty + ' ' + createPage.data.session.initiatorName);
  check(createPage.data.canConfirm === true, '⑤ 提供「确认本次课时」按钮（不要求填表 / 签名）');

  // 点确认 → POST /sessions/{id}/confirm（带 codeId）
  requests.length = 0;
  resetCalls();
  modalReply = { confirm: false };
  createPage.confirm();
  await sleep(200);
  const confirmReq = requestOf('/api/v1/sessions/' + issued.sessionId + '/confirm', 'POST')[0];
  check(!!confirmReq && confirmReq.data.codeId === issued.codeId,
    '⑥ 确认走 POST /sessions/{id}/confirm 并带 codeId（消费动态码）', confirmReq ? JSON.stringify(confirmReq.data) : '无');
  check(!!confirmReq && /^Bearer\s+TOKEN-TEACHER/.test(String(confirmReq.header.Authorization)), '⑦ 确认请求带 Authorization');
  check(createPage.data.verifyState === 'done', '⑧ 成功后进入「已确认」态');
  check(calls.modals.some(function (m) { return m.title === '已确认本次课时'; }),
    '⑨ 提示「已确认本次课时」', (calls.modals[0] || {}).title);
  check(calls.modals.some(function (m) { return /学时计入实际授课人：唐瑞明/.test(m.content || ''); }),
    '⑩ 提示学时按实际授课人计入', (calls.modals[0] || {}).content);
  const confirmedRow = (backend.sessions || []).filter(function (s) { return s.sessionId === issued.sessionId; })[0];
  check(!!confirmedRow && confirmedRow.status === 'done' && confirmedRow.confirmedName === '唐瑞明',
    '⑪ 后端会话置 done 并落确认人', confirmedRow ? (confirmedRow.status + ' / ' + confirmedRow.confirmedName) : '未找到');
  modalReply = { confirm: true };

  // 代课：确认人 ≠ 实际授课人 → 仍成功并提示学时归属
  seedSession('TOKEN-CADRE', userView({ no: '2025030117', real_name: '张一鸣', role: 'cadre' }));
  const issued2 = await api.createSession({ courseName: '专题讲座', teacherName: '唐瑞明', teachDate: shape.todayFull(), section: '7-8', hours: 2 });
  const substitute = userView({ no: '2099999', real_name: '王代课', role: 'teacher' });
  backend.boundTokens['TOKEN-SUB'] = { no: '2099999', real_name: '王代课', role: 'teacher' };
  seedSession('TOKEN-SUB', substitute);
  resetCalls();
  createPage = loadPage('miniprogram/pages/create/create.js');
  createPage.onLoad({ code: issued2.code });
  await sleep(200);
  check(createPage.data.verifyState === 'session', '⑫ B 通道（6 位口令）核验通过', 'state=' + createPage.data.verifyState);
  modalReply = { confirm: false };
  createPage.confirm();
  await sleep(200);
  check(createPage.data.confirmResult && createPage.data.confirmResult.nameMismatch === true,
    '⑬ 确认人 ≠ 实际授课人 → nameMismatch=true（仍算成功）');
  check(calls.modals.some(function (m) { return /已确认；学时按实际授课人 唐瑞明 计入/.test(m.content || ''); }),
    '⑭ 代课提示「已确认；学时按实际授课人 XXX 计入」',
    (calls.modals.filter(function (m) { return /学时按实际授课人/.test(m.content || ''); })[0] || {}).content);
  modalReply = { confirm: true };

  // 失败路径：msg 原样展示（41002 已消费 / 42201 状态不允许 / 40301 无权限）
  resetCalls();
  createPage = loadPage('miniprogram/pages/create/create.js');
  createPage.onLoad({ codeId: issued.codeId });
  await sleep(200);
  check(createPage.data.verifyState === 'error' && /已被使用/.test(createPage.data.verifyError),
    '⑮ 41002 已消费：明确中文提示', createPage.data.verifyError);
  check(/让班干部刷新/.test(createPage.data.errorAdvice), '⑯ 41002 引导班干部刷新二维码', createPage.data.errorAdvice);

  backend.sessionError = { status: 403, code: 40301, msg: '仅班干部或管理员可发起课时确认' };
  let sessionErr = null;
  try { await api.createSession({ courseName: 'X', teacherName: 'Y', teachDate: shape.todayFull() }); } catch (e) { sessionErr = e; }
  check(!!sessionErr && sessionErr.msg === '仅班干部或管理员可发起课时确认',
    '⑰ 后端 40301 的 msg 原样抛出（不吞错误）', sessionErr ? sessionErr.msg : '未报错');
  backend.sessionError = null;

  backend.confirmError = { status: 422, code: 42201, msg: '该课时当前状态为「done」，无需重复确认' };
  seedSession('TOKEN-CADRE', userView({ no: '2025030117', real_name: '张一鸣', role: 'cadre' }));
  const issued3 = await api.createSession({ courseName: '新生研讨课', teacherName: '唐瑞明', teachDate: shape.todayFull(), section: '5-6', hours: 1 });
  seedSession('TOKEN-TEACHER', teacherUser);
  resetCalls();
  createPage = loadPage('miniprogram/pages/create/create.js');
  createPage.onLoad({ codeId: issued3.codeId });
  await sleep(200);
  createPage.confirm();
  await sleep(200);
  check(calls.modals.some(function (m) { return m.content === backend.confirmError.msg; }),
    '⑱ 后端 42201 的 msg 原样展示', (calls.modals.filter(function (m) { return /无需重复确认/.test(m.content || ''); })[0] || {}).content);
  backend.confirmError = null;

  // ================================================================ 9
  section('9. 我的课程 → GET/POST/PUT/DELETE + 后端 msg 原样展示');
  backend.classCourses = defaultClassCourses();
  backend.courseError = null;
  backend.courseSeq = 10;
  seedSession('TOKEN-CADRE', userView({ no: '2025030117', real_name: '张一鸣', role: 'cadre', className: '2025级护理3班', duty: '学委' }));
  requests.length = 0;
  resetCalls();
  const coursesPage = loadPage('miniprogram/pages/courses/courses.js');
  coursesPage.onLoad({});
  coursesPage.onShow();          // 列表在 onShow 拉取（与真实页面行为一致）
  await sleep(200);
  check(requestOf('/api/v1/class-courses', 'GET').some(function (r) { return r.data && r.data.status === 'active'; }),
    '① 默认按 status=active 拉课程清单',
    JSON.stringify((requestOf('/api/v1/class-courses', 'GET')[0] || {}).data || null));
  check(coursesPage.data.list.length === 2 && coursesPage.data.list[0].courseName === '信息技术',
    '② 渲染「使用中」课程（2 门，已归档的不在列表）', coursesPage.data.list.length + ' 门');
  check(/^周[一二三四五六日]$/.test(coursesPage.data.list[0].weekdayText) && coursesPage.data.list[0].place === '实训楼A302',
    '③ 列表展示 星期 / 节次 / 地点 / 学时', [coursesPage.data.list[0].weekdayText, coursesPage.data.list[0].place, coursesPage.data.list[0].hours].join(' / '));
  check(coursesPage.data.summary.archived === 1, '④ summary 给出使用中/已归档计数', JSON.stringify(coursesPage.data.summary));

  // 新增
  coursesPage.openCreate();
  check(coursesPage.data.form.show === true && coursesPage.data.form.mode === 'create', '⑤ 打开新增表单');
  coursesPage.setData({
    'form.courseName': '数据库原理', 'form.teacherName': '周敏',
    'form.weekdayIndex': 3, 'form.sectionIndex': 2, 'form.place': '实训楼C201', 'form.hours': '4'
  });
  requests.length = 0;
  resetCalls();
  coursesPage.submitForm();
  await sleep(200);
  const addReq = requestOf('/api/v1/class-courses', 'POST')[0];
  check(!!addReq, '⑥ 新增走 POST /class-courses');
  check(!!addReq && addReq.data.courseName === '数据库原理' && addReq.data.teacherName === '周敏' &&
    Number(addReq.data.weekday) === 3 && addReq.data.section === '3-4' && Number(addReq.data.hours) === 4,
    '⑦ 请求体带 课程名/授课老师/星期/节次/学时',
    addReq ? JSON.stringify(addReq.data) : '无');
  check(calls.toasts.some(function (t) { return /已添加/.test(t.title || ''); }), '⑧ 新增成功提示');
  check(coursesPage.data.form.show === false, '⑨ 成功后收起表单');

  // 编辑
  coursesPage.openEdit({ currentTarget: { dataset: { id: 'CR00000001' } } });
  check(coursesPage.data.form.mode === 'edit' && coursesPage.data.form.courseName === '信息技术',
    '⑩ 编辑带出该课程', coursesPage.data.form.courseName);
  coursesPage.setData({ 'form.teacherName': '李慧' });
  requests.length = 0;
  coursesPage.submitForm();
  await sleep(200);
  const editReq = requestOf('/api/v1/class-courses/CR00000001', 'PUT')[0];
  check(!!editReq && editReq.data.teacherName === '李慧', '⑪ 编辑走 PUT /class-courses/{id}', editReq ? JSON.stringify(editReq.data) : '无');

  // 归档（软删除）
  requests.length = 0;
  resetCalls();
  modalReply = { confirm: true };
  coursesPage.archive({ currentTarget: { dataset: { id: 'CR00000001', name: '信息技术' } } });
  await sleep(200);
  const delReq = requestOf('/api/v1/class-courses/CR00000001', 'DELETE')[0];
  check(!!delReq, '⑫ 归档走 DELETE /class-courses/{id}（软删除）');
  const archivedRow = (backend.classCourses || []).filter(function (c) { return c.id === 'CR00000001'; })[0];
  check(!!archivedRow && archivedRow.status === 'archived', '⑬ 后端置 status=archived（保留历史）', archivedRow ? archivedRow.status : '未找到');

  // 重复归档 → 42201，msg 原样展示
  resetCalls();
  coursesPage.archive({ currentTarget: { dataset: { id: 'CR00000001', name: '信息技术' } } });
  await sleep(200);
  check(calls.modals.some(function (m) { return m.content === '该课程已归档，无需重复删除'; }),
    '⑭ 重复归档 → 42201，后端 msg 原样展示',
    (calls.modals.filter(function (m) { return /归档未成功/.test(m.title || ''); })[0] || {}).content);

  // 敏感词 / 长度 / 权限：msg 原样展示
  backend.courseError = { status: 400, code: 40001, msg: '内容包含敏感词：代签（课程名称），请修改后重新提交' };
  resetCalls();
  coursesPage.openCreate();
  coursesPage.setData({ 'form.courseName': '代签服务', 'form.teacherName': '唐瑞明' });
  coursesPage.submitForm();
  await sleep(200);
  check(coursesPage.data.form.error === backend.courseError.msg,
    '⑮ 敏感词被拦截：后端 msg 原样展示在表单上', coursesPage.data.form.error);
  check(calls.modals.some(function (m) { return m.content === backend.courseError.msg; }),
    '⑯ 同时弹窗展示同一条原文（不换文案、不吞错误）');

  backend.courseError = { status: 400, code: 40001, msg: '课程名称过长：当前 61 字符，最多 60 字符' };
  resetCalls();
  coursesPage.setData({ 'form.courseName': new Array(62).join('长'), 'form.teacherName': '唐瑞明' });
  coursesPage.submitForm();
  await sleep(200);
  check(coursesPage.data.form.error === backend.courseError.msg, '⑰ 超长：后端 msg 原样展示', coursesPage.data.form.error);

  backend.courseError = { status: 403, code: 40301, msg: '班干部只能维护本班（2025级护理3班）的课程清单' };
  resetCalls();
  coursesPage.setData({ 'form.courseName': '正常课程', 'form.teacherName': '唐瑞明' });
  coursesPage.submitForm();
  await sleep(200);
  check(coursesPage.data.form.error === backend.courseError.msg, '⑱ 越权：后端 msg 原样展示', coursesPage.data.form.error);
  backend.courseError = null;
  coursesPage.closeForm();

  // ================================================================ 10
  section('10. 40101 → 清除本地 token 并跳「去绑定」引导');
  // 造一个「本地还有 token，但服务端已失效」的场景
  seedSession('TOKEN-EXPIRED', teacherUser);
  app.globalData.token = 'TOKEN-EXPIRED';
  app.globalData.role = 'teacher';
  app.globalData.user = teacherUser;
  app.globalData.needBind = false;
  requests.length = 0;
  resetCalls();
  const stalePage = loadPage('miniprogram/pages/index/index.js');
  stalePage.onLoad({});
  stalePage.onShow();
  await sleep(200);

  check(requestOf('/api/v1/tasks', 'GET').length === 1, '① 仍按本地 token 发起业务请求');
  check(requestOf('/api/v1/tasks', 'GET')[0].header.Authorization === 'Bearer TOKEN-EXPIRED',
    '② 请求头使用的是本地那个已失效的 token', requestOf('/api/v1/tasks', 'GET')[0].header.Authorization);
  check(storage.token === undefined && storage.user === undefined && storage.role === undefined,
    '③ 收到 40101 后本地 token / user / role 全部被清除',
    JSON.stringify({ token: storage.token, user: storage.user, role: storage.role }));
  check(session.hasSession() === false, '④ session.hasSession() = false');
  check(app.globalData.needBind === true, '⑤ app.globalData.needBind = true');
  check(app.globalData.role === '' && !app.globalData.user, '⑥ globalData 中的身份被清空', 'role="' + app.globalData.role + '"');
  check(stalePage.data.needBind === true && stalePage.data.role === '' && stalePage.data.code === '',
    '⑦ 首页立刻切到「去绑定」引导，且不再展示失效的动态码',
    JSON.stringify({ needBind: stalePage.data.needBind, role: stalePage.data.role, code: stalePage.data.code }));
  check(calls.modals.length >= 1 && calls.modals.some(function (m) { return m.confirmText === '去绑定'; }),
    '⑧ 弹出「去绑定」引导弹窗（不是静默失败）', JSON.stringify(calls.modals.map(function (m) { return { title: m.title, confirmText: m.confirmText }; })));
  check(calls.navigations.some(function (n) { return n.type === 'navigateTo' && n.url === '/pages/bind/bind'; }),
    '⑨ 用户确认后跳转绑定页', JSON.stringify(calls.navigations.map(function (n) { return n.type + ':' + n.url; })));

  // 40101 后重新绑定应能恢复（闭环）
  const rebindPage = loadPage('miniprogram/pages/bind/bind.js');
  resetCalls();
  rebindPage.onLoad({});
  rebindPage.setData({ realName: '张一鸣', no: '2025030117', roleIndex: 1 });
  rebindPage.submit();
  await sleep(120);
  check(!!storage.token && storage.role === 'cadre',
    '⑩ 40101 之后可重新绑定恢复会话（闭环）', 'role=' + storage.role);

  // ================================================================ 11
  section('11. mock 模式仍然可用（离线演示不受影响）');
  app.globalData.useMock = true;
  app.globalData.apiBase = '';
  app.globalData.role = 'cadre';
  app.globalData.user = { id: 'MOCK-cadre', role: 'cadre', name: '张一鸣', className: '2025级药学1班', duty: '学委' };
  app.globalData.needBind = false;
  storage.token = 'mock-token';
  storage.role = 'cadre';
  storage.user = app.globalData.user;
  const mockApi = require(path.join(ROOT, 'miniprogram/utils/api.js'));
  mockApi.__mock.reset();
  requests.length = 0;
  resetCalls();
  const mockPage = loadPage('miniprogram/pages/index/index.js');
  mockPage.onLoad({});
  mockPage.onShow();
  await sleep(900);
  check(requests.length === 0, '① useMock=true 时不发任何网络请求', requests.length + ' 个请求');
  check(mockPage.data.courses.length >= 2, '② mock 下「今日课程」仍有演示数据', mockPage.data.courses.length + ' 门');
  mockPage.presentCode({ currentTarget: { dataset: { id: mockPage.data.courses[0].id } } });
  await sleep(600);
  check(/^\d{6}$/.test(String(mockPage.data.code)) && mockPage.data.qrPayload === 'kcsq://code/' + mockPage.data.codeId,
    '③ mock 下同样能拿到 6 位口令 + 二维码载荷（离线演示保留）', mockPage.data.code + ' / ' + mockPage.data.qrPayload);
  check(mockPage.data.codeError === '', '④ 无错误态', mockPage.data.codeError || '—');
  mockPage.stopTimer();

  const mockCoursesPage = loadPage('miniprogram/pages/courses/courses.js');
  mockCoursesPage.onLoad({});
  await mockCoursesPage.reload();
  check(mockCoursesPage.data.list.length >= 3, '⑤ mock 下「我的课程」有演示课程清单', mockCoursesPage.data.list.length + ' 门');
  check(requests.length === 0, '⑥ 课程清单页在 mock 下同样零请求', requests.length + ' 个请求');

  // ---- 汇总
  console.log('\n' + '='.repeat(66));
  console.log('小程序登录/绑定 + 真实数据流自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('='.repeat(66));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e);
  process.exit(2);
});
