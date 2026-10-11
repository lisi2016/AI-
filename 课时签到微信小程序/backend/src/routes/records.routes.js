'use strict';
/**
 * 路由 C：授课任务  +  路由 D：课时记录（核心）
 */
const express = require('express');
const multer = require('multer');
const u = require('../util');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const domain = require('../records');
const { CODES, fail, paramError } = require('../errors');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

// 签名图上传：内存暂存后自行落盘（data/uploads，不公开）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: u.MAX_SIGNATURE_BYTES, files: 1 },
});

// ---------------------------------------------------------------- 任务
/** GET /tasks?date=&teacherId=&week= */
router.get('/tasks', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const date = q.date || u.dateOnly();
  if (!u.isValidDate(date)) throw paramError('date 格式应为 YYYY-MM-DD');
  let teacherId = user.id;
  if (user.role === 'admin' || user.role === 'dept_admin') {
    teacherId = q.teacherId || user.id;
    if (user.role === 'dept_admin' && q.teacherId) {
      const t = view.userById(q.teacherId);
      if (!t || String(t.dept_id) !== String(user.dept_id)) throw fail(CODES.FORBIDDEN, '只能查看本院系教师');
    }
    if ((user.role === 'admin' || user.role === 'dept_admin') && !q.teacherId) {
      // 管理端不传 teacherId 时返回该日全部任务
      const list = store.filter('course_tasks', function (t) {
        if (Number(t.weekday) !== u.weekdayOf(date)) return false;
        if (!domain.taskActiveOn(t, date)) return false;
        if (t.status && t.status !== 'active') return false;
        if (user.role === 'dept_admin' && String(t.dept_id) !== String(user.dept_id)) return false;
        if (q.term && String(t.term) !== String(q.term)) return false;
        return true;
      }).sort(function (a, b) { return String(a.start_time).localeCompare(String(b.start_time)); });
      return ok(res, list.map(function (t) { return view.shapeTask(t, date); }));
    }
  }
  if (user.role === 'cadre') throw fail(CODES.FORBIDDEN, '班干部请使用 /code/generate 提供动态码');
  const list = domain.tasksOfTeacherOnDate(teacherId, date, { term: q.term });
  return ok(res, list.map(function (t) { return view.shapeTask(t, date); }));
}));

/** GET /tasks/week?week=4&term=&teacherId= */
router.get('/tasks/week', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const curWeek = u.termWeekOf(u.dateOnly());
  const week = Number(q.week || curWeek);
  if (!Number.isFinite(week) || week < 1 || week > 30) throw paramError('week 取值应为 1-30');
  let teacherId = user.id;
  if ((user.role === 'admin' || user.role === 'dept_admin') && q.teacherId) teacherId = q.teacherId;
  if (user.role === 'cadre') throw fail(CODES.FORBIDDEN, '班干部无课表查询权限');

  // week = 当前周往前推 (week-1) 周；不传 week 返回当前周
  const monday = u.addDays(u.mondayOf(u.dateOnly()), (week - curWeek) * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = u.addDays(monday, i);
    const dayTasks = domain.tasksOfTeacherOnDate(teacherId, d, { term: q.term }).map(function (t) {
      return view.shapeTask(t, d);
    });
    days.push({
      date: d,
      weekday: i + 1,
      weekdayText: u.WEEKDAY_CN[i + 1],
      isToday: d === u.dateOnly(),
      tasks: dayTasks,
      hours: dayTasks.reduce(function (a, t) { return a + Number(t.hours || 0); }, 0),
    });
  }
  const flat = days.reduce(function (acc, d) { return acc.concat(d.tasks); }, []);
  return ok(res, {
    week: week,
    term: q.term || view.configMap().term,
    monday: monday,
    sunday: u.addDays(monday, 6),
    // 前端 api.js getTasks 直接消费数组；这里同时给出 days/list 便于不同页面使用
    days: days,
    list: flat,
    tasks: flat,
    total: flat.length,
    totalHours: flat.reduce(function (a, t) { return a + Number(t.hours || 0); }, 0),
  });
}));

/** GET /tasks/{id} */
router.get('/tasks/:id', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const task = domain.taskById(req.params.id);
  if (!task) throw fail(CODES.NOT_FOUND, '授课任务不存在：' + req.params.id);
  if (user.role === 'teacher' && String(task.teacher_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '只能查看本人授课任务');
  }
  if (user.role === 'dept_admin' && String(task.dept_id) !== String(user.dept_id)) {
    throw fail(CODES.FORBIDDEN, '只能查看本院系授课任务');
  }
  if (user.role === 'cadre') throw fail(CODES.FORBIDDEN, '班干部无课表查询权限');
  const date = (req.query && req.query.date) || u.dateOnly();
  const rec = view.recordOfTask(task.id, date);
  return ok(res, {
    task: view.shapeTask(task, date, { record: rec }),
    teacher: view.shapeUser(view.userById(task.teacher_id)),
    signer: (function () {
      const c = view.primaryCadre(task.class_id);
      return c ? view.shapeUser(c) : null;
    })(),
    authorizedCadres: view.activeCadres(task.class_id).map(function (r) {
      const usr = view.userById(r.user_id);
      return { userId: r.user_id, name: usr ? usr.real_name : '', duty: r.duty, priority: r.priority, studentNo: usr ? usr.student_no : '' };
    }),
    record: rec ? view.shapeRecord(rec, { viewer: user }) : null,
  });
}));

// ---------------------------------------------------------------- 记录
/** POST /records —— 教师发起确认（校验见契约第四节）；不再要求/校验 location，传入即忽略 */
router.post('/records', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const ctx = audit.ctxOf(req, user);
  const out = domain.createRecord(user, req.body || {}, ctx);
  return ok(res, Object.assign(view.shapeRecord(out.record, { viewer: user }), { warnings: out.warnings }));
}));

/** GET /records?status=&from=&to=&page=&pageSize=&... */
router.get('/records', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const list = domain.queryRecords(user, q);
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  return ok(res, {
    list: page.list.map(function (r) { return view.shapeRecord(r, { viewer: user }); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    summary: {
      hours: list.filter(function (r) { return r.status === 'done' || r.status === 'makeup'; })
        .reduce(function (a, r) { return a + Number(r.hours || 0); }, 0),
      // 受 status=（及其它筛选）影响的计数：当前列表内各状态条数（向后兼容，语义不变）
      byStatus: list.reduce(function (acc, r) { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
      // 新增：不受 status= 影响的「各状态数量角标」口径，按当前用户可见范围（角色权限）统计，
      // 固定返回 8 种状态（无记录为 0），供前端标签角标使用；byStatus 保持不变以兼容旧前端
      statusTotals: domain.statusTotals(user, q),
    },
  });
}));

/** POST /records/expire-job —— 内部定时任务：超期 wait → expired */
router.post('/records/expire-job', auth.requireJobAuth, wrap(function (req, res) {
  const user = auth.optionalUser(req);
  const out = domain.expireJob(audit.ctxOf(req, user), req.body || {});
  audit.log(audit.ctxOf(req, user), 'job.expire', {
    targetType: 'period_record', targetId: '*',
    after: { expired: out.expired }, detail: '定时任务批量置过期',
  });
  return ok(res, out);
}));

/** GET /records/{id} */
router.get('/records/:id', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const record = store.findById('period_records', req.params.id);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + req.params.id);
  domain.assertCanReadRecord(user, record);
  const sig = view.signatureOf(record.id);
  const makeup = record.makeup_id ? store.findById('makeup_applies', record.makeup_id) : null;
  const appeal = record.appeal_id ? store.findById('appeals', record.appeal_id) : null;
  const teacher = view.userById(record.teacher_id);
  return ok(res, Object.assign(view.shapeRecord(record, { viewer: user, signature: sig }), {
    // 契约 D 组：详情 + 签名证据四项（签名图 / 确认时间 / 设备 / 动态码，不含位置）
    evidence: view.shapeEvidence(record, sig),
    teacher: view.shapeUser(teacher),
    signer: view.shapeUser(view.userById(record.signer_id)),
    absents: store.filter('absents', function (a) { return String(a.record_id) === String(record.id); }).map(function (a) {
      return { rawName: a.raw_name, matchStatus: a.match_status, matchedStudentId: a.matched_student_id };
    }),
    makeupApply: makeup ? {
      id: makeup.id, status: makeup.status, reason: makeup.reason,
      reviewedAt: makeup.reviewed_at, reviewNote: makeup.review_note,
    } : null,
    appeal: appeal ? {
      id: appeal.id, status: appeal.status, reason: appeal.reason,
      reviewedAt: appeal.reviewed_at, reviewNote: appeal.review_note,
    } : null,
    auditTail: store.filter('audit_logs', function (l) {
      return String(l.target_id) === String(record.id);
    }).slice(-10).map(function (l) {
      return { action: l.action, actor: view.userName(l.actor_id) || l.actor_role, at: l.created_at, detail: l.detail };
    }),
  }));
}));

/**
 * POST /records/{id}/sign —— 班干部上传签名图，置 done
 * 说明：本接口不再采集定位，multipart 中的 latitude/longitude/locationDenied（或 lat/lng）
 * 一律忽略且不报错（向后兼容）；签名证据固定四项：签名图 / 确认时间 / 设备 / 动态码。
 */
router.post('/records/:id/sign', auth.requireRole(['cadre', 'admin']), upload.single('signature'), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const record = store.findById('period_records', req.params.id);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + req.params.id);
  const ctx = audit.ctxOf(req, user);
  const file = req.file;
  const out = domain.signRecord(user, record, file, req.body || {}, ctx);
  return ok(res, view.shapeRecord(out.record, { viewer: user, signature: out.signature }));
}));

/** POST /records/{id}/reject —— 班干部拒绝（原因必填） */
router.post('/records/:id/reject', auth.requireRole(['cadre', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const record = store.findById('period_records', req.params.id);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + req.params.id);
  const out = domain.rejectRecord(user, record, (req.body || {}).reason, audit.ctxOf(req, user));
  return ok(res, view.shapeRecord(out, { viewer: user }));
}));

/** POST /records/{id}/revoke —— 撤销（教师本人 / 教务处） */
router.post('/records/:id/revoke', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const record = store.findById('period_records', req.params.id);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + req.params.id);
  const out = domain.revokeRecord(user, record, (req.body || {}).reason, audit.ctxOf(req, user));
  return ok(res, view.shapeRecord(out, { viewer: user }));
}));

/** POST /records/{id}/urge —— 教师提醒签字人 */
router.post('/records/:id/urge', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const record = store.findById('period_records', req.params.id);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + req.params.id);
  const out = domain.urgeRecord(user, record, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    recordId: record.id,
    signerId: record.signer_id,
    signerName: record.signer_name,
    channel: out.channel,
    urgeCount: out.urgeCount,
    msg: out.msg,
    record: view.shapeRecord(record, { viewer: user }),
  });
}));

module.exports = router;
