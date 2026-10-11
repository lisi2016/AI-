'use strict';
/**
 * 路由 L：教学班列表（t_class = data/classes.json）
 *
 *   GET /classes?deptId=&keyword=&classId=&status=&page=&pageSize=
 *
 * 用途：管理后台「新增班级课程清单」的下拉数据源 —— 先 GET /classes 选教学班拿到 classId，
 *       再 POST /class-courses 录入课程（`POST /class-courses` 的 classId 必填）。
 * 权限：班干部=本班（仅自己的班）；教师=全部（可按班/院系/关键字收窄）；
 *       院系管理员=本院系；教务处=全部。
 */
const express = require('express');
const auth = require('../auth');
const view = require('../view');
const domain = require('../classes');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

/** GET /classes —— 教学班列表（含班干部/学生人数，deptName 由 t_dept 关联） */
router.get('/classes', auth.requireRole(domain.READ_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  const list = domain.queryClasses(user, q);
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  return ok(res, {
    list: page.list.map(function (r) { return view.shapeClass(r, domain.countsOf(r.id)); }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  });
}));

module.exports = router;
