'use strict';
/**
 * 路由 E：补签与申诉
 */
const express = require('express');
const u = require('../util');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const domain = require('../records');
const { CODES, fail, paramError } = require('../errors');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

function shapeApply(row, viewer) {
  const record = store.findById('period_records', row.record_id);
  return {
    id: row.id,
    recordId: row.record_id,
    applicantId: row.applicant_id,
    applicantName: row.applicant_name || view.userName(row.applicant_id),
    reason: row.reason,
    evidenceUrls: row.evidence_urls || [],
    status: row.status,
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_id ? view.userName(row.reviewer_id) : '',
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 便于审核端一屏决策
    record: record ? {
      id: record.id,
      courseName: record.course_name,
      className: record.class_name,
      teacherName: record.teacher_name,
      deptId: record.dept_id,
      deptName: view.deptName(record.dept_id),
      fullDate: record.teach_date,
      section: record.section,
      hours: Number(record.hours || 0),
      status: record.status,
      statusText: view.STATUS_TEXT[record.status] || record.status,
      signerName: record.signer_name,
      signerIsAdHoc: Number(record.signer_is_adhoc) === 1,
      note: record.note || '',
      canDecide: !!(viewer && (viewer.role === 'admin' || (viewer.role === 'dept_admin' && String(viewer.dept_id) === String(record.dept_id)))),
    } : null,
  };
}

// ---------------------------------------------------------------- 补签
/** POST /makeup —— 教师对 expired/rejected 记录发起补签 */
router.post('/makeup', auth.requireRole(['teacher', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.applyMakeup(user, req.body || {}, audit.ctxOf(req, user));
  return ok(res, Object.assign(shapeApply(row, user), { ok: true, status: row.status }));
}));

/** GET /makeup?status=pending —— 待审列表（dept_admin 本院系 / admin 全部） */
router.get('/makeup', auth.requireRole(['dept_admin', 'admin', 'teacher']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  let list = store.all('makeup_applies').slice();

  if (user.role === 'teacher') {
    list = list.filter(function (m) { return String(m.applicant_id) === String(user.id); });
  } else if (user.role === 'dept_admin') {
    list = list.filter(function (m) {
      const r = store.findById('period_records', m.record_id);
      return r && String(r.dept_id) === String(user.dept_id);
    });
  }
  if (q.status) list = list.filter(function (m) { return m.status === q.status; });
  if (q.recordId) list = list.filter(function (m) { return String(m.record_id) === String(q.recordId); });
  if (q.from) list = list.filter(function (m) { return String(m.created_at).slice(0, 10) >= String(q.from); });
  if (q.to) list = list.filter(function (m) { return String(m.created_at).slice(0, 10) <= String(q.to); });

  list.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  const all = list.map(function (m) { return shapeApply(m, user); });
  return ok(res, {
    list: page.list.map(function (m) { return shapeApply(m, user); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    pending: all.filter(function (m) { return m.status === 'pending'; }).length,
  });
}));

/** GET /makeup/{id} */
router.get('/makeup/:id', auth.requireAuth, wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = store.findById('makeup_applies', req.params.id);
  if (!row) throw fail(CODES.NOT_FOUND, '补签申请不存在：' + req.params.id);
  const record = store.findById('period_records', row.record_id);
  const allowed = String(row.applicant_id) === String(user.id) || user.role === 'admin' ||
    (user.role === 'dept_admin' && record && String(record.dept_id) === String(user.dept_id));
  if (!allowed) throw fail(CODES.FORBIDDEN, '无权查看该补签申请');
  return ok(res, shapeApply(row, user));
}));

/** POST /makeup/{id}/approve —— 通过后原记录置 makeup */
router.post('/makeup/:id/approve', auth.requireRole(['dept_admin', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.reviewMakeup(user, req.params.id, true, req.body || {}, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    apply: shapeApply(out.apply, user),
    record: view.shapeRecord(out.record, { viewer: user }),
  });
}));

/** POST /makeup/{id}/reject —— 驳回，原因必填 */
router.post('/makeup/:id/reject', auth.requireRole(['dept_admin', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.reviewMakeup(user, req.params.id, false, req.body || {}, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    apply: shapeApply(out.apply, user),
    record: view.shapeRecord(out.record, { viewer: user }),
  });
}));

// ---------------------------------------------------------------- 申诉
/** POST /appeal —— 教师对 rejected 记录申诉（1 次/记录） */
router.post('/appeal', auth.requireRole(['teacher', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.applyAppeal(user, req.body || {}, audit.ctxOf(req, user));
  return ok(res, Object.assign(shapeApply(row, user), { ok: true, status: row.status }));
}));

/** GET /appeal?status= —— 申诉列表（admin 全部 / teacher 本人） */
router.get('/appeal', auth.requireRole(['admin', 'teacher', 'dept_admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  let list = store.all('appeals').slice();
  if (user.role === 'teacher') list = list.filter(function (a) { return String(a.applicant_id) === String(user.id); });
  if (user.role === 'dept_admin') {
    list = list.filter(function (a) {
      const r = store.findById('period_records', a.record_id);
      return r && String(r.dept_id) === String(user.dept_id);
    });
  }
  if (q.status) list = list.filter(function (a) { return a.status === q.status; });
  list.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  return ok(res, {
    list: page.list.map(function (a) { return shapeApply(a, user); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  });
}));

/** POST /appeal/{id}/approve —— 教务处处理：通过 → done */
router.post('/appeal/:id/approve', auth.requireRole(['admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.reviewAppeal(user, req.params.id, true, req.body || {}, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    appeal: shapeApply(out.appeal, user),
    record: view.shapeRecord(out.record, { viewer: user }),
  });
}));

/** POST /appeal/{id}/reject —— 驳回，原因必填 */
router.post('/appeal/:id/reject', auth.requireRole(['admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.reviewAppeal(user, req.params.id, false, req.body || {}, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    appeal: shapeApply(out.appeal, user),
    record: view.shapeRecord(out.record, { viewer: user }),
  });
}));

module.exports = router;
