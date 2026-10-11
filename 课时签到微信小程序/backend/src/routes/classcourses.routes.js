'use strict';
/**
 * 路由 J：班级课程清单（业务轻流程第一步：班干部录入一次、长期保留）
 *
 *   GET    /class-courses            课程清单列表（班干部=本班 / 教师=可按班查询 / 院系管理员=本院系 / 教务处=全部）
 *   GET    /class-courses/today      某日期「当天有课」的课程（按该日期的星期带出）
 *   GET    /class-courses/{id}       单条详情
 *   POST   /class-courses            新增（班干部/管理员）
 *   PUT    /class-courses/{id}       修改（班干部/管理员）
 *   DELETE /class-courses/{id}       软删除 → status='archived'
 */
const express = require('express');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const domain = require('../classcourses');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

/** GET /class-courses?classId=&keyword=&status=&term=&weekday=&page=&pageSize= */
router.get('/class-courses', auth.requireRole(domain.READ_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const list = domain.queryClassCourses(user, q);
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  // 角标口径：不受 status= 影响（与 /records 的 statusTotals 同理）
  const scoped = domain.queryClassCourses(user, Object.assign({}, q, { status: 'all' }));
  return ok(res, {
    list: page.list.map(function (r) { return view.shapeClassCourse(r); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    summary: {
      total: scoped.length,
      active: scoped.filter(function (r) { return r.status === 'active'; }).length,
      archived: scoped.filter(function (r) { return r.status === 'archived'; }).length,
    },
  });
}));

/**
 * GET /class-courses/today?date=YYYY-MM-DD[&classId=]
 * 班干部：本班；教师/管理员：按 classId（不传则范围内全部班级）
 * 注意：必须注册在 /class-courses/:id 之前
 */
router.get('/class-courses/today', auth.requireRole(domain.READ_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const out = domain.coursesToday(user, req.query || {});
  return ok(res, {
    date: out.date,
    weekday: out.weekday,
    weekdayText: out.weekdayText,
    total: out.list.length,
    list: out.list.map(function (r) { return view.shapeClassCourse(r); }),
  });
}));

/** GET /class-courses/{id} */
router.get('/class-courses/:id', auth.requireRole(domain.READ_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.courseById(user, req.params.id);
  return ok(res, view.shapeClassCourse(row));
}));

/** POST /class-courses —— 新增（班干部/管理员） */
router.post('/class-courses', auth.requireRole(domain.WRITE_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.createClassCourse(user, req.body || {}, audit.ctxOf(req, user));
  return ok(res, view.shapeClassCourse(row));
}));

/** PUT /class-courses/{id} —— 修改（部分字段；不可改教学班） */
router.put('/class-courses/:id', auth.requireRole(domain.WRITE_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.updateClassCourse(user, req.params.id, req.body || {}, audit.ctxOf(req, user));
  return ok(res, view.shapeClassCourse(row));
}));

/** DELETE /class-courses/{id} —— 软删除（status='archived'，保留历史） */
router.delete('/class-courses/:id', auth.requireRole(domain.WRITE_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const row = domain.archiveClassCourse(user, req.params.id, audit.ctxOf(req, user));
  return ok(res, {
    ok: true,
    id: row.id,
    classId: row.class_id,
    status: row.status,
    archived: true,
    course: view.shapeClassCourse(row),
  });
}));

module.exports = router;
