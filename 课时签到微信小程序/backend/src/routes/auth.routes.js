'use strict';
/**
 * 路由 A：认证与绑定  +  路由 B：动态确认码
 */
const express = require('express');
const u = require('../util');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const domain = require('../records');
const webauth = require('../webauth');
const unbind = require('../unbind');
const { CODES, fail, paramError } = require('../errors');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

// ---------------------------------------------------------------- Web 后台账号密码登录
/**
 * 教务处 Web 后台登录分支（请求体不含 code，含 { no, password }）
 * - 仅 dept_admin / admin 可登录，其它角色 40301
 * - 连续 5 次失败锁定 15 分钟（data/login_attempts.json）
 * - 成功返回与小程序一致的 { token, user, role }
 */
function webLogin(req, res, body) {
  const no = String(body.no || body.staffNo || body.studentNo || body.account || '').trim();
  const password = String(body.password === undefined || body.password === null ? '' : body.password);
  if (!no) throw paramError('工号（no）必填');
  if (!password) throw paramError('密码（password）必填');

  const ctx = audit.ctxOf(req, null);

  // 1) 锁定校验（锁定期间不校验密码，直接给出明确提示）
  const lock = webauth.lockState(no);
  if (lock.locked) {
    audit.log(ctx, 'auth.login.locked', {
      targetType: 'user', targetId: no,
      after: { remainSeconds: lock.remainSeconds, failCount: lock.failCount },
      detail: '账号锁定期间尝试登录被拒绝',
    });
    throw fail(CODES.FORBIDDEN, webauth.lockMessage(lock.remainSeconds));
  }

  // 2) 账号存在性
  const user = webauth.findUserByNo(no);
  if (!user) {
    const r = webauth.registerFailure(no, ctx.ip);
    audit.log(ctx, 'auth.login.fail', {
      targetType: 'user', targetId: no,
      after: { reason: 'account_not_found', failCount: r.failCount, locked: r.locked },
      detail: 'Web 后台登录失败：账号不存在',
    });
    if (r.locked) throw fail(CODES.FORBIDDEN, webauth.lockMessage(r.remainSeconds));
    throw paramError('工号/学号或密码错误（还可尝试 ' + r.left + ' 次）');
  }

  // 3) 账号状态
  if (user.status !== 'active') throw fail(CODES.FORBIDDEN, '账号已被停用，请联系教务处');

  // 4) 角色限制：仅院系管理员 / 教务处可登录 Web 后台
  if (!webauth.canLoginWeb(user)) {
    audit.log(ctx, 'auth.login.fail', {
      targetType: 'user', targetId: user.id,
      after: { reason: 'role_not_allowed', role: user.role },
      detail: 'Web 后台登录失败：角色不允许（' + user.role + '）',
    });
    throw fail(CODES.FORBIDDEN, '当前角色（' + user.role + '）无 Web 后台登录权限，仅院系管理员/教务处可用；' +
      '教师与班干部请使用微信小程序');
  }

  // 5) 密码校验
  if (!webauth.verifyPassword(user, password)) {
    const r = webauth.registerFailure(no, ctx.ip);
    audit.log(ctx, 'auth.login.fail', {
      targetType: 'user', targetId: user.id,
      after: { reason: 'bad_password', failCount: r.failCount, locked: r.locked },
      detail: 'Web 后台登录失败：密码错误（第 ' + r.failCount + ' 次）',
    });
    if (r.locked) throw fail(CODES.FORBIDDEN, webauth.lockMessage(r.remainSeconds));
    throw paramError('工号/学号或密码错误（还可尝试 ' + r.left + ' 次）');
  }

  // 6) 登录成功
  webauth.resetFailures(no);
  const now = u.isoNow();
  user.last_login_at = now;
  user.updated_at = now;
  store.touch('users');

  const t = auth.issueToken(user);
  u.saveDevToken(user.staff_no || user.student_no, t.token);
  audit.log(audit.ctxOf(req, user), 'auth.login', {
    targetType: 'user', targetId: user.id,
    after: { role: user.role, mode: 'password' }, detail: 'Web 后台账号密码登录成功',
  });
  return ok(res, {
    token: t.token,
    tokenType: 'Bearer',
    expiresAt: t.expiresAt,
    needBind: false,
    loginMode: 'password',
    role: user.role,
    user: view.shapeUser(user),
    hint: '后续请求请携带 Authorization: Bearer <token>',
  });
}

// ---------------------------------------------------------------- POST /auth/login
router.post('/auth/login', wrap(async function (req, res) {
  const body = req.body || {};
  const code = body.code || body.jsCode || req.query.code;
  // Web 后台分支：请求体不含 code，而含 { no, password }
  if (!code && (body.no || body.password || body.staffNo || body.account)) {
    return webLogin(req, res, body);
  }
  if (!code) throw paramError('code 必填（wx.login 获取）');

  const session = await auth.code2Session(code);
  const user = store.find('users', function (x) { return x.openid && x.openid === session.openid; });

  if (!user) {
    // 未绑定：返回 needBind + openid + 绑定票据（契约 1.3 / 三.A）
    audit.log(audit.ctxOf(req, null), 'auth.login.unbound', {
      targetType: 'user', targetId: session.openid,
      after: { openid: session.openid, mock: !!session.mock },
      detail: '微信登录成功但未绑定工号/学号',
    });
    return ok(res, {
      token: '',
      needBind: true,
      openid: session.openid,
      bindTicket: auth.issueBindTicket(session.openid, 1800),
      mock: !!session.mock,
      role: '',
      user: null,
      devMode: u.DEV_MODE,
      hint: '请调用 POST /api/v1/auth/bind 绑定工号/学号（白名单校验）',
    });
  }
  if (user.status !== 'active') throw fail(CODES.FORBIDDEN, '账号已被停用，请联系教务处');

  user.last_login_at = u.isoNow();
  user.updated_at = user.last_login_at;
  store.touch('users');

  const t = auth.issueToken(user);
  u.saveDevToken(user.staff_no || user.student_no, t.token);
  audit.log(audit.ctxOf(req, user), 'auth.login', {
    targetType: 'user', targetId: user.id,
    after: { role: user.role, mock: !!session.mock }, detail: '登录成功',
  });
  return ok(res, {
    token: t.token,
    tokenType: 'Bearer',
    expiresAt: t.expiresAt,
    needBind: false,
    openid: session.openid,
    mock: !!session.mock,
    role: user.role,
    user: view.shapeUser(user),
  });
}));

// ---------------------------------------------------------------- POST /auth/bind

/**
 * 日志/错误提示里只回显 openid 前缀：既不泄露完整标识，也避免把攻击者构造的超长串写进日志
 */
function maskOpenid(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!s) return '(空)';
  return s.slice(0, 8) + (s.length > 8 ? '…(len=' + s.length + ')' : '');
}

/**
 * 解析绑定用的 openid（安全关键，契约 1.3）
 * - DEV_MODE=0（生产）：**必须**提供有效且未过期的 bindTicket；请求体若同时传了 openid，必须与票据一致。
 *   票据缺失/无效/过期 → 40101；openid 与票据不一致 → 40301（防伪造他人 openid 占号）。
 * - DEV_MODE=1（开发）：保留「直接传 openid」的宽松联调路径；
 *   但只要传了 bindTicket，就必须校验票据有效性与 openid 一致性（不能借开发模式绕过已提供票据的校验）。
 */
function resolveBindOpenid(req) {
  const b = req.body || {};
  const ctx = audit.ctxOf(req, null);
  const ticketText = b.bindTicket === undefined || b.bindTicket === null ? '' : String(b.bindTicket).trim();
  const bodyOpenid = b.openid === undefined || b.openid === null ? '' : String(b.openid).trim();

  if (ticketText) {
    const ticket = auth.verifyBindTicket(ticketText);
    if (!ticket || !ticket.oid) {
      audit.log(ctx, 'auth.bind.reject', {
        targetType: 'user', targetId: maskOpenid(bodyOpenid),
        after: { reason: 'invalid_ticket', devMode: u.DEV_MODE },
        detail: '绑定被拒绝：bindTicket 无效或已过期',
      });
      throw fail(CODES.UNAUTH,
        'bindTicket 无效或已过期（有效期 30 分钟），请重新调用 /auth/login 获取票据后再绑定');
    }
    if (bodyOpenid && bodyOpenid !== String(ticket.oid)) {
      audit.log(ctx, 'auth.bind.reject', {
        targetType: 'user', targetId: maskOpenid(bodyOpenid),
        after: { reason: 'openid_mismatch', ticketOpenid: maskOpenid(ticket.oid), bodyOpenid: maskOpenid(bodyOpenid) },
        detail: '绑定被拒绝：请求体 openid 与 bindTicket 内的 openid 不一致（疑似伪造他人 openid）',
      });
      throw fail(CODES.FORBIDDEN,
        'openid 与 bindTicket 不一致：票据对应的 openid 为 ' + maskOpenid(ticket.oid) +
        '，请求体携带的是 ' + maskOpenid(bodyOpenid) + '，禁止用他人 openid 绑定');
    }
    return String(ticket.oid);
  }

  if (!u.DEV_MODE) {
    audit.log(ctx, 'auth.bind.reject', {
      targetType: 'user', targetId: maskOpenid(bodyOpenid),
      after: { reason: 'missing_ticket', devMode: 0 },
      detail: '绑定被拒绝：生产环境缺少 bindTicket',
    });
    throw fail(CODES.UNAUTH,
      '缺少 bindTicket：生产环境（DEV_MODE=0）必须先经 /auth/login 获取 bindTicket，' +
      '并用该票据绑定；不接受直接提交 openid（防止伪造他人 openid）');
  }

  // DEV_MODE=1 且未带票据：允许直接给 openid 联调
  return bodyOpenid;
}

router.post('/auth/bind', wrap(function (req, res) {
  const b = req.body || {};
  const openid = resolveBindOpenid(req);
  if (!openid) throw paramError('openid 或 bindTicket 必填（由 /auth/login 返回）');

  const role = String(b.role || '').trim();
  const no = String(b.no || b.staffNo || b.studentNo || '').trim();
  const realName = String(b.realName || b.name || '').trim();
  if (!role) throw paramError('role 必填（teacher/cadre/dept_admin/admin）');
  if (['teacher', 'cadre', 'dept_admin', 'admin'].indexOf(role) < 0) throw paramError('role 取值非法');
  if (!no) throw paramError('no（工号/学号）必填');
  if (!realName) throw paramError('realName 必填');

  // 白名单校验（契约 1.3）
  const white = store.find('whitelist', function (w) { return String(w.no) === no && w.status === 'active'; });
  if (!white) throw fail(CODES.FORBIDDEN, '工号/学号 ' + no + ' 不在白名单内，无法绑定');
  if (white.real_name !== realName) {
    throw fail(CODES.FORBIDDEN, '白名单中 ' + no + ' 对应姓名为「' + white.real_name + '」，与填写的不一致');
  }
  if (white.role !== role) {
    throw fail(CODES.FORBIDDEN, '白名单中 ' + no + ' 的角色为「' + white.role + '」，与填写的不一致');
  }
  if (role === 'cadre' && !white.class_id) throw paramError('班干部白名单缺少教学班信息，请联系教务处');

  // 同一 openid 已绑定其他账号 → 拒绝
  const occupied = store.find('users', function (x) { return x.openid && x.openid === openid; });
  if (occupied && String(occupied.staff_no || occupied.student_no) !== no) {
    throw fail(CODES.FORBIDDEN, '当前微信已绑定账号「' + occupied.real_name + '」，请联系教务处解绑');
  }

  // 找到白名单对应的用户档案并写入 openid
  let user = store.find('users', function (x) {
    return (role === 'teacher' || role === 'dept_admin' || role === 'admin')
      ? String(x.staff_no) === no
      : String(x.student_no) === no;
  });
  const now = u.isoNow();
  if (!user) {
    user = store.insert('users', {
      id: store.newId('U'), openid: openid, unionid: '', role: role, real_name: white.real_name,
      staff_no: (role === 'teacher' || role === 'dept_admin' || role === 'admin') ? no : '',
      student_no: role === 'cadre' ? no : '',
      dept_id: white.dept_id || null, class_id: white.class_id || null,
      phone: u.cleanText(b.phone, 20), duty: '',
      status: 'active', created_at: now, updated_at: now,
    });
  } else {
    if (user.role !== role) throw fail(CODES.FORBIDDEN, '账号「' + user.real_name + '」角色为 ' + user.role + '，与申请角色不一致');
    if (user.openid && user.openid !== openid) {
      // 开发模式（DEV_MODE=1）：openid 是由 wx.login 的 code 派生的模拟值（dev_ 前缀），
      // 每次 wx.login 的 code 都不同 → 若沿用"一个工号只能绑一个微信"的严格规则，
      // 测试者一旦退出登录就再也绑不回同一工号。故开发模式下允许用新模拟 openid 覆盖旧模拟绑定；
      // 生产（DEV_MODE=0）与"旧绑定是真实 openid"的情况仍严格拒绝。
      const isDevRebind = !!(u.DEV_MODE && /^dev_/i.test(String(user.openid)));
      if (!isDevRebind) throw fail(CODES.FORBIDDEN, '该工号/学号已被其他微信绑定，请联系教务处');
      audit.log(audit.ctxOf(req, user), 'auth.bind.dev.replace', {
        targetType: 'user', targetId: user.id,
        after: { from: maskOpenid(user.openid), to: maskOpenid(openid) },
        detail: '开发模式下覆盖旧的模拟 openid 绑定（便于反复联调）',
      });
    }
    user.openid = openid;
    user.updated_at = now;
    if (b.phone) user.phone = u.cleanText(b.phone, 20);
    store.touch('users');
  }

  const t = auth.issueToken(user);
  u.saveDevToken(no, t.token);
  audit.log(audit.ctxOf(req, user), 'auth.bind', {
    targetType: 'user', targetId: user.id,
    after: { role: user.role, no: no, classId: user.class_id }, detail: '工号/学号绑定成功',
  });
  return ok(res, {
    token: t.token, tokenType: 'Bearer', expiresAt: t.expiresAt,
    needBind: false, role: user.role, user: view.shapeUser(user),
  });
}));

// ---------------------------------------------------------------- GET /auth/me
router.get('/auth/me', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const extra = {};
  if (user.role === 'teacher') {
    extra.tasks = store.filter('course_tasks', function (t) { return String(t.teacher_id) === String(user.id); }).length;
  }
  if (user.role === 'cadre') {
    extra.pendingCount = domain.queryRecords(user, { status: 'wait' }).length;
  }
  return ok(res, {
    user: view.shapeUser(user, extra),
    role: user.role,
    config: {
      codeTtlSeconds: view.configNum('code_ttl_seconds'),
      confirmDeadlineHour: view.configNum('confirm_deadline_hour'),
      term: view.configMap().term,
      devMode: u.DEV_MODE,
    },
  });
}));

// ---------------------------------------------------------------- POST /auth/logout
router.post('/auth/logout', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  auth.revokeToken(auth.tokenFromReq(req));
  audit.log(audit.ctxOf(req, user), 'auth.logout', { targetType: 'user', targetId: user.id, detail: '退出登录' });
  return ok(res, { ok: true, revoked: true });
}));

// ---------------------------------------------------------------- POST /auth/unbind
/**
 * 解绑本人微信（**需登录**）—— 自助换绑的「旧微信还能登录」分支
 *
 * 语义（严格限定为「解除登录绑定」）：
 *   · 清除 users[].openid（置空），使该工号/学号可被其它微信重新绑定
 *   · **不删除**用户档案（users 行保留，历史课时/统计/审计全部不动）
 *   · 返回前**先注销当前 token**：解绑即下线，旧 token 立即失效
 * 审计：auth.unbind（记 no、realName、原 openid 前缀脱敏）
 * 不采集定位、不引入依赖。
 */
router.post('/auth/unbind', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const token = auth.tokenFromReq(req);
  const no = user.staff_no || user.student_no || '';

  // 先注销令牌：无论后续落盘/审计是否异常，旧 token 都不会继续可用
  auth.revokeToken(token);

  const out = unbind.unbindUser(user);
  audit.log(audit.ctxOf(req, user), 'auth.unbind', {
    targetType: 'user', targetId: user.id,
    after: {
      no: no,
      realName: user.real_name,
      // 只回显前缀：既不泄露完整标识，也避免把超长串写进日志
      openidPrefix: out.before ? maskOpenid(out.before) : '(空)',
    },
    detail: '本人自助解绑微信：仅清除 openid 绑定，不删除用户档案、不改动历史课时/统计/审计数据；当前 token 已同步失效',
  });
  return ok(res, {
    ok: true,
    no: no,
    realName: user.real_name,
    unbound: true,
    hint: '解绑成功：当前令牌已失效；该工号/学号可被其它微信重新绑定，历史课时数据不受影响',
  });
}));

// ---------------------------------------------------------------- POST /auth/unbind-self
/**
 * 未登录自助解绑（换绑）——「换了新微信、旧微信登不进去」分支
 *
 * 入参：{ no, realName }（no 支持工号或学号）
 * 凭证（**弱凭证**）：白名单 active + real_name 与 no 完全一致，不一致 → 40301
 * 风控（**必须**）：同一 no 24 小时 ≤2 次、同一 IP 1 小时 ≤5 次，超限 → 40001
 *   · 计数落在新表 data/unbind_requests.json（store 表 unbind_requests，保留 7 天）
 * 审计：auth.unbind.self（记 no、realName、IP、设备、是否确有绑定）
 * 幂等：本就没有绑定 → 成功并返回 hadBinding:false
 * 不采集定位、不引入依赖。
 */
router.post('/auth/unbind-self', wrap(function (req, res) {
  const b = req.body || {};
  const no = String(b.no || b.staffNo || b.studentNo || '').trim();
  const realName = String(b.realName || b.name || '').trim();
  const ctx = audit.ctxOf(req, null);
  if (!no) throw paramError('工号/学号（no）必填');
  if (!realName) throw paramError('真实姓名（realName）必填');

  // 1) 频率限制闸门：**先限流、再校验弱凭证**
  //    这样"猜姓名"的失败尝试同样被计数（每 24 小时最多 2 次），盲猜成本被抬高；
  //    而"已被限流直接拒绝"的请求不再重复计数，避免攻击者靠刷请求无限延长他人等待窗口。
  const gate = unbind.rateLimit(no, ctx.ip);
  if (!gate.allowed) {
    audit.log(ctx, 'auth.unbind.self', {
      targetType: 'user', targetId: no,
      after: {
        no: no, realName: realName, ip: ctx.ip, device: ctx.device, hadBinding: null,
        allowed: false, reason: gate.reason, scope: gate.scope,
        noCount: gate.noCount, ipCount: gate.ipCount,
      },
      detail: '自助解绑被拒绝（' + gate.reason + '）：' + gate.msg,
    });
    throw fail(CODES.PARAM, gate.msg);
  }

  // 2) 弱凭证校验：必须在白名单内且姓名完全一致
  //    「不在白名单」与「姓名不符」返回同一提示，避免该接口被用来探测工号是否存在
  const white = unbind.whitelisted(no);
  const user = unbind.userByNo(no);
  const nameOk = !!white && String(white.real_name) === realName;
  if (!nameOk) {
    const reason = white ? 'name_mismatch' : 'not_in_whitelist';
    unbind.record({
      no: no, realName: realName, ip: ctx.ip, device: ctx.device,
      hadBinding: false, allowed: false, reason: reason,
    });
    audit.log(ctx, 'auth.unbind.self', {
      targetType: 'user', targetId: user ? user.id : no,
      after: {
        no: no, realName: realName, ip: ctx.ip, device: ctx.device, hadBinding: null,
        allowed: false, reason: reason,
      },
      detail: '自助解绑被拒绝：姓名与工号/学号不匹配（白名单校验未通过，未做任何解绑）',
    });
    throw fail(CODES.FORBIDDEN,
      '姓名与工号/学号不匹配：请核对姓名是否与教务处登记完全一致（工号/学号 ' + no + '）；' +
      '若确实无法自助解绑，请联系教务处处理');
  }

  // 3) 执行解绑（幂等：本就没有绑定也返回成功，hadBinding=false）
  const out = unbind.unbindUser(user);
  unbind.record({
    no: no, realName: realName, ip: ctx.ip, device: ctx.device,
    hadBinding: out.hadBinding, allowed: true, reason: 'ok',
  });
  audit.log(ctx, 'auth.unbind.self', {
    targetType: 'user', targetId: user ? user.id : no,
    after: {
      no: no, realName: realName, ip: ctx.ip, device: ctx.device, hadBinding: out.hadBinding,
      allowed: true, reason: 'ok',
      openidPrefix: out.before ? maskOpenid(out.before) : '(空)',
    },
    detail: out.hadBinding
      ? '未登录自助解绑成功：已清除该工号/学号原绑定的微信（不删除档案、历史课时数据不受影响）'
      : '未登录自助解绑成功：该工号/学号本就没有绑定微信（幂等返回）',
  });
  return ok(res, { ok: true, no: no, realName: realName, hadBinding: out.hadBinding });
}));

// ---------------------------------------------------------------- POST /auth/password
/** 登录后修改本人密码：入参 { oldPassword, newPassword }（密码不明文入日志） */
router.post('/auth/password', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const b = req.body || {};
  const out = webauth.changePassword(user, b.oldPassword, b.newPassword);
  audit.log(audit.ctxOf(req, user), 'auth.password.change', {
    targetType: 'user', targetId: user.id,
    after: { no: user.staff_no || user.student_no || '', changedAt: out.updatedAt },
    detail: '修改本人登录密码（口令内容不入日志）',
  });
  return ok(res, {
    ok: true,
    updatedAt: out.updatedAt,
    hint: '密码已更新；当前登录令牌仍然有效，如需强制下线请调用 /auth/logout',
  });
}));

// ================================================================ 动态确认码（A+B 双通道）
// A 真二维码（应用内扫码，载荷 kcsq://code/<codeId>） + B 6 位数字口令（手输兜底）
// POST /code/generate —— 班干部调用，60 秒有效
router.post('/code/generate', auth.requireRole(['cadre', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const b = req.body || {};
  let classId = b.classId || user.class_id;
  if (user.role === 'admin' && b.classId) classId = b.classId;
  if (!classId) throw paramError('班干部未绑定教学班，无法生成动态码');
  if (user.role === 'cadre' && !view.isActiveCadreOf(user.id, classId)) {
    throw fail(CODES.FORBIDDEN, '当前用户在「' + view.className(classId) + '」无有效班干部授权');
  }
  const row = domain.generateCode(user, { ttl: b.ttl, classId: classId });
  audit.log(audit.ctxOf(req, user), 'code.generate', {
    targetType: 'code', targetId: row.id,
    after: {
      classId: classId, expireAt: row.expire_at, ttl: Math.round((row.expire_at_ms - row.created_at_ms) / 1000),
      // 口令本身可入日志（用于追溯"谁签发了哪个口令"），但不下发到非授权方
      passCode: row.code_value, qrPayload: row.qr_payload,
    },
    detail: '班干部签发动态确认码（A 二维码 + B 6 位口令）',
  });
  return ok(res, {
    codeId: row.id,
    // B 通道：6 位数字口令（教师可手输）
    code: row.code_value,
    codeLength: String(row.code_value).length,
    // A 通道：二维码要编码的字符串
    qrPayload: row.qr_payload,
    // 兼容别名（历史前端读 qrUrl）
    qrUrl: row.qr_payload,
    sign: row.signature,
    expireAt: row.expire_at,
    expireAtMs: row.expire_at_ms,
    ttl: Math.round((row.expire_at_ms - row.created_at_ms) / 1000),
    className: view.className(classId),
    cadre: view.shapeUser(user),
    channels: {
      qr: { payload: row.qr_payload, hint: '教师用「扫码发起」扫描此二维码' },
      code: { value: row.code_value, hint: '教师用「输入口令」手输此 6 位数字' },
    },
    rule: '同一 codeId 只能被消费一次；过期返回 41001，重复使用返回 41002',
  });
}));

/**
 * POST /code/verify —— 教师扫码 / 输口令后调用
 *
 * 入参三选一（契约 B 组）：
 *   { codeId }     直接给动态码 ID
 *   { code }       6 位数字口令（历史版本此处也用于传 codeId，已兼容）
 *   { qrContent }  扫码得到的字符串，支持 kcsq://code/<codeId>、kcsq://confirm?codeId=..、裸 codeId/口令
 * 解析失败 / 查不到 → 40401；过期 → 41001；已消费 → 41002
 *
 * 返回（业务流程简化后）：
 *   · 若该码是**课时会话码**（班干部 POST /sessions 签发的码，codes.session_id 非空）：
 *     返回本次课时信息（sessionId + session + sessionInfo：课程名/实际授课人/班级/日期/节次/地点/发起人），
 *     教师据此直接点「确认」（POST /sessions/{id}/confirm）。
 *   · 否则**回退到原行为**：返回班干部身份 + 该班当日授课任务列表（旧课表流程继续可用）。
 */
router.post('/code/verify', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const b = req.body || {};
  const ref = domain.resolveCodeRef(b);
  if (!ref.codeId) {
    if (ref.by === 'code') throw fail(CODES.NOT_FOUND, '口令不存在或已失效：' + (ref.passCode || ''));
    if (ref.by === 'qrContent') {
      throw fail(CODES.NOT_FOUND, ref.invalid
        ? '扫码内容无法识别，请确认扫描的是课程确认二维码（或让老师手输 6 位数字口令）'
        : '二维码对应的动态码不存在或已失效');
    }
    throw paramError('codeId 必填（也可传 code 6 位口令 或 qrContent 扫码内容）');
  }

  const row = domain.findCode(ref.codeId);
  if (!row) throw fail(CODES.NOT_FOUND, '动态码不存在：' + ref.codeId);
  // 过期 → 41001；已消费 → 41002（由 domain.checkCode 统一处理）
  domain.checkCode(ref.codeId);

  const issuer = view.userById(row.issuer_id);
  const classId = row.class_id || (issuer && issuer.class_id);
  const date = b.date || u.dateOnly();
  const channelText = ref.by === 'qrContent' ? 'A 扫码' : (ref.by === 'code' ? 'B 口令' : 'codeId');

  // ------------------------------------------------ 课时会话码：返回本次课时信息（新流程）
  if (row.session_id) {
    const session = store.findById('period_records', row.session_id);
    if (session && domain.isSessionRow(session)) {
      const shaped = view.shapeSession(session, { viewer: user });
      audit.log(audit.ctxOf(req, user), 'code.verify', {
        targetType: 'code', targetId: row.id,
        after: {
          classId: classId, date: session.teach_date, sessionId: session.id,
          courseName: session.course_name, teacherName: session.teacher_name,
          status: session.status, channel: ref.by,
        },
        detail: '教师核验课时会话码（通道：' + channelText + '，课时 ' + session.id + '）',
      });
      return ok(res, {
        codeId: row.id,
        verifyBy: ref.by,
        channel: ref.by === 'qrContent' ? 'qr' : (ref.by === 'code' ? 'code' : 'codeId'),
        isSession: true,
        // 本次课时信息：教师直接看到「要确认哪节课」
        sessionId: session.id,
        session: shaped,
        sessionInfo: shaped,
        expireAt: row.expire_at,
        ttl: Math.max(0, Math.round((Number(row.expire_at_ms) - Date.now()) / 1000)),
        canConfirm: session.status === 'wait',
        confirmEndpoint: 'POST /api/v1/sessions/' + session.id + '/confirm',
        // 兼容保留：旧客户端仍可读到 cadre / classId / className / tasks 字段（课时会话不带课表任务）
        cadre: issuer ? view.shapeUser(issuer) : null,
        classId: classId,
        className: classId ? view.className(classId) : '',
        date: session.teach_date,
        tasks: [],
        myTasks: user.role === 'teacher'
          ? domain.tasksOfTeacherOnDate(user.id, session.teach_date).map(function (t) { return view.shapeTask(t, session.teach_date); })
          : [],
      });
    }
    // 会话已被物理删除等异常情况 → 回退到原行为（并写日志便于排查）
    audit.log(audit.ctxOf(req, user), 'code.verify.session_missing', {
      targetType: 'code', targetId: row.id,
      after: { sessionId: row.session_id }, detail: '动态码绑定的课时会话不存在，回退为课表任务行为',
    });
  }

  // ------------------------------------------------ 旧课表码：原行为（保持不变）
  const list = classId
    ? store.filter('course_tasks', function (t) {
        return String(t.class_id) === String(classId) &&
          Number(t.weekday) === u.weekdayOf(date) &&
          domain.taskActiveOn(t, date) && (!t.status || t.status === 'active');
      }).sort(function (a, c) { return String(a.start_time).localeCompare(String(c.start_time)); })
    : [];

  audit.log(audit.ctxOf(req, user), 'code.verify', {
    targetType: 'code', targetId: row.id,
    after: {
      classId: classId, date: date, taskCount: list.length,
      // 记录教师用的是哪条通道（A 扫码 / B 口令 / 直传 codeId），便于事后追溯
      channel: ref.by,
    },
    detail: '教师核验动态码（通道：' + channelText + '）',
  });

  return ok(res, {
    codeId: row.id,
    // 回显通道信息，便于前端提示与排障
    verifyBy: ref.by,
    channel: ref.by === 'qrContent' ? 'qr' : (ref.by === 'code' ? 'code' : 'codeId'),
    isSession: false,
    sessionId: '',
    date: date,
    expireAt: row.expire_at,
    ttl: Math.max(0, Math.round((Number(row.expire_at_ms) - Date.now()) / 1000)),
    // 前端 api.js verifyCode 期望 { cadre, tasks }
    cadre: issuer ? view.shapeUser(issuer) : null,
    classId: classId,
    className: classId ? view.className(classId) : '',
    tasks: list.map(function (t) { return view.shapeTask(t, date); }),
    // 兼容：教师本人当日任务
    myTasks: user.role === 'teacher'
      ? domain.tasksOfTeacherOnDate(user.id, date).map(function (t) { return view.shapeTask(t, date); })
      : [],
  });
}));

module.exports = router;
