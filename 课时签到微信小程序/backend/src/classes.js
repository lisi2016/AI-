'use strict';
/**
 * 教学班查询（t_class = data/classes.json）
 *
 * 背景：新流程第一步是「班干部维护班级课程清单」，而 `POST /class-courses` 必须带 `classId`。
 * 管理后台此前没有查询教学班的接口 → 无法选择班级 → 也就无法录入第一条课程。本模块补齐该缺口：
 *
 *   GET /classes?deptId=&keyword=&classId=&status=&page=&pageSize=
 *
 * 权限（与班级课程清单 /class-courses 同口径，避免两处范围不一致）：
 *   · 班干部：**仅本班**（本人所在班 + 被 active 授权的教学班）
 *   · 教师：**全部**（教学班名称属低敏基础数据；可用 deptId / classId / keyword 收窄）
 *   · 院系管理员：**仅本院系**
 *   · 教务处：全部
 *
 * 名称与院系：`name` 取自 `t_class.name`，`deptName` 由 `t_dept` 关联（`dept_id`）。
 */
const store = require('./store');
const view = require('./view');
const classcourses = require('./classcourses');
const { CODES, fail, paramError } = require('./errors');

const READ_ROLES = ['cadre', 'teacher', 'dept_admin', 'admin'];
/** 教学班状态（默认只看 active；`status=all` 可查全部） */
const STATUSES = ['active', 'archived', 'leave'];

/** 班干部可读的班级：本人所在班 + 被 active 授权的教学班（复用 /class-courses 的口径） */
function cadreClassIds(user) {
  return classcourses.cadreClassIds(user);
}

/**
 * 教学班查询（按角色限定范围）
 * @param user 当前用户
 * @param q {deptId, keyword, classId, status, page, pageSize}
 * @returns {Array} classes 表的行（未分页，排序稳定）
 */
function queryClasses(user, q) {
  const o = q || {};
  if (!user || READ_ROLES.indexOf(user.role) < 0) {
    throw fail(CODES.FORBIDDEN, '当前角色（' + ((user && user.role) || '匿名') + '）无权查看教学班列表');
  }
  let list = store.all('classes').slice();

  // ---- 角色可见范围 ----
  if (user.role === 'cadre') {
    const ids = cadreClassIds(user);
    list = list.filter(function (r) { return ids.indexOf(String(r.id)) >= 0; });
  } else if (user.role === 'dept_admin') {
    list = list.filter(function (r) { return !!user.dept_id && String(r.dept_id) === String(user.dept_id); });
  }
  // teacher / admin：全部（教师可按班查询）

  // ---- 状态（默认 active，与 /class-courses 一致；status=all 查全部）----
  const statusRaw = o.status === undefined || o.status === null || o.status === '' ? 'active' : String(o.status).trim();
  if (statusRaw !== 'all') {
    const ss = statusRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    ss.forEach(function (s) {
      if (STATUSES.indexOf(s) < 0) throw paramError('status 取值应为 active / archived / leave / all');
    });
    if (ss.length) list = list.filter(function (r) { return ss.indexOf(String(r.status || 'active')) >= 0; });
  }

  // ---- 筛选 ----
  if (o.deptId) list = list.filter(function (r) { return String(r.dept_id) === String(o.deptId); });
  if (o.classId) {
    if (!classcourses.canReadClass(user, o.classId)) throw fail(CODES.FORBIDDEN, '无权查看该教学班');
    list = list.filter(function (r) { return String(r.id) === String(o.classId); });
  }
  if (o.keyword) {
    const kw = String(o.keyword);
    list = list.filter(function (r) {
      return String(r.name || '').indexOf(kw) >= 0 ||
        String(r.grade || '').indexOf(kw) >= 0 ||
        String(r.advisor || '').indexOf(kw) >= 0 ||
        String(view.deptName(r.dept_id) || '').indexOf(kw) >= 0;
    });
  }

  list.sort(function (a, b) {
    if (String(a.dept_id || '') !== String(b.dept_id || '')) return String(a.dept_id || '').localeCompare(String(b.dept_id || ''));
    if (String(a.grade || '') !== String(b.grade || '')) return String(b.grade || '').localeCompare(String(a.grade || ''));
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return list;
}

/** 教学班规模（班干部人数 / 学生人数），供后台下拉显示，便于核对选对班级 */
function countsOf(classId) {
  const cid = String(classId);
  return {
    cadreCount: store.filter('class_cadres', function (r) {
      return String(r.class_id) === cid && r.status === 'active';
    }).length,
    studentCount: store.filter('students', function (r) {
      return String(r.class_id) === cid && (!r.status || r.status === 'active');
    }).length,
  };
}

module.exports = { READ_ROLES, STATUSES, cadreClassIds, queryClasses, countsOf };
