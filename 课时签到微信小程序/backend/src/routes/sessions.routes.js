'use strict';
/**
 * 路由 K：课时会话（业务轻流程核心：班干部发起 + 教师扫码确认）
 *
 *   POST /sessions                班干部为本班发起一次课时（可选 courseId 从课程清单带出），同时签发 60 秒动态码
 *   POST /sessions/{id}/code      为已存在的会话重新生成动态码（二维码过期后刷新）
 *   GET  /sessions                会话列表（班干部=本班 / 教师=本人为实际授课人或被确认过 / 管理员按范围）
 *   GET  /sessions/{id}           会话详情（课程、实际授课人、班级、节次、地点、发起人、确认信息、证据）
 *   POST /sessions/{id}/confirm   任课教师确认（消费动态码、落确认信息、置 status='done'）
 */
const express = require('express');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const domain = require('../sessions');
const recordsDomain = require('../records');
const courses = require('../classcourses');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

const ALL_ROLES = ['cadre', 'teacher', 'dept_admin', 'admin'];

/** 组装「会话 + 动态码」的统一响应体 */
function sessionCodePayload(out, user, extra) {
  return Object.assign({
    sessionId: out.session.id,
    ...domain.codeFields(out.code),
    session: view.shapeSession(out.session, { viewer: user }),
    channels: {
      qr: { payload: out.code.qr_payload, hint: '任课教师用「扫码」扫描此二维码' },
      code: { value: out.code.code_value, hint: '任课教师也可手输这 6 位数字口令' },
    },
    rule: '同一 codeId 只能被消费一次；过期返回 41001，重复使用返回 41002；确认后本课时置 done',
  }, extra || {});
}

/**
 * POST /sessions —— 班干部发起课时
 * 入参：{courseId?, courseName, teacherName, teacherNo?, classId?, teachDate, section?, place?,
 *        hours?, note?, absentCount?, absentNames?, discipline?, summary?}
 */
router.post('/sessions', auth.requireRole(domain.INITIATOR_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.createSession(user, req.body || {}, audit.ctxOf(req, user));
  return ok(res, sessionCodePayload(out, user, { adopted: out.adopted }));
}));

/** POST /sessions/{id}/code —— 刷新动态码（会话仍待确认时） */
router.post('/sessions/:id/code', auth.requireRole(domain.INITIATOR_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.refreshCode(user, req.params.id, req.body || {}, audit.ctxOf(req, user));
  return ok(res, sessionCodePayload(out, user, { refreshed: true }));
}));

/** GET /sessions?date=&status=&from=&to=&classId=&courseId=&tempAdjusted=&nameMismatch=&page=&pageSize= */
router.get('/sessions', auth.requireRole(ALL_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const list = domain.querySessions(user, q);
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  return ok(res, {
    list: page.list.map(function (r) { return view.shapeSession(r, { viewer: user }); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    summary: {
      hours: list.filter(function (r) { return r.status === 'done' || r.status === 'makeup'; })
        .reduce(function (a, r) { return a + Number(r.hours || 0); }, 0),
      byStatus: list.reduce(function (acc, r) { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
      // 不受 status= 影响的角标口径
      statusTotals: domain.statusTotals(user, q),
      tempAdjustedCount: list.filter(function (r) { return Number(r.is_temp_adjusted || 0) === 1; }).length,
      nameMismatchCount: list.filter(function (r) { return Number(r.confirm_name_mismatch || 0) === 1; }).length,
    },
  });
}));

/** GET /sessions/{id} —— 详情（含证据与最近操作留痕） */
router.get('/sessions/:id', auth.requireRole(ALL_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.sessionById(user, req.params.id);
  const course = row.course_id ? store.findById(courses.TABLE, row.course_id) : null;
  return ok(res, {
    session: view.shapeSession(row, { viewer: user }),
    course: course ? view.shapeClassCourse(course) : null,
    teacher: row.teacher_id ? view.shapeUser(view.userById(row.teacher_id)) : null,
    initiator: row.initiator_id ? view.shapeUser(view.userById(row.initiator_id)) : null,
    confirmer: row.confirmed_by ? view.shapeUser(view.userById(row.confirmed_by)) : null,
    // 动态码：确认后可回看用的是哪一个码（不返回口令原文）
    code: row.code_id ? (function () {
      const c = recordsDomain.findCode(row.code_id);
      return c ? {
        codeId: c.id, expireAt: c.expire_at, used: Number(c.used) === 1,
        usedAt: c.used_at || '', usedBy: c.used_by || '',
      } : null;
    })() : null,
    auditTail: store.filter('audit_logs', function (l) {
      return String(l.target_id) === String(row.id);
    }).slice(-10).map(function (l) {
      return { action: l.action, actor: view.userName(l.actor_id) || l.actor_role, at: l.created_at, detail: l.detail };
    }),
  });
}));

/**
 * POST /sessions/{id}/confirm —— 任课教师确认
 * 入参可带 {codeId} | {code} | {qrContent}（三选一，用于消费动态码）；不带则默认消费该会话最新有效码
 */
router.post('/sessions/:id/confirm', auth.requireRole(domain.CONFIRM_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.confirmSession(user, req.params.id, req.body || {}, audit.ctxOf(req, user));
  const s = out.session;
  return ok(res, {
    ok: true,
    sessionId: s.id,
    status: s.status,
    counted: true,
    nameMismatch: out.nameMismatch,
    codeConsumed: out.codeConsumed,
    confirmedBy: s.confirmed_by,
    confirmedName: s.confirmed_name,
    confirmedAt: s.confirmed_at,
    confirmedRole: s.confirmed_role,
    teacherName: s.teacher_name,
    msg: out.nameMismatch
      ? '已确认本次课时（确认人「' + s.confirmed_name + '」与录入的实际授课人「' + s.teacher_name + '」不一致，已标记待提醒）'
      : '已确认本次课时',
    session: view.shapeSession(s, { viewer: user }),
  });
}));

module.exports = router;
