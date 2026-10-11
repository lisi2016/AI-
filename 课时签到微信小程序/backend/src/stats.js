'use strict';
/**
 * 统计（契约 F 组）
 * 硬性口径：仅 status IN (done, makeup) 计入正式学时；makeup 单独标注；
 *           合班课程按 task_id 统计，不按班级重复累加。
 * 归属口径（业务流程简化后调整）：学时按**实际授课人**（t_period_record.teacher_name，
 *           有 teacher_id 时优先用 id）归属，而不是"课表上的任课教师"——临时换老师时
 *           学时计给真正上课的人。
 */
const u = require('./util');
const store = require('./store');
const view = require('./view');
const records = require('./records');

const COUNTED = ['done', 'makeup'];

function countedFilter(extra) {
  return function (r) {
    if (COUNTED.indexOf(r.status) < 0) return false;
    if (extra && !extra(r)) return false;
    return true;
  };
}

/**
 * 记录集去重（合班课程/重复导入任务不重复累加）
 * - 有 task_id：按 task_id + 日期 + 节次（合班课程只算一次）
 * - 无 task_id（班干部发起的课时会话）：按 教学班 + 课程 + 实际授课人 + 日期 + 节次
 */
function dedupeByTaskDate(list) {
  const seen = {};
  const out = [];
  list.forEach(function (r) {
    const key = r.task_id
      ? [String(r.task_id), String(r.teach_date || ''), String(r.section || '')].join('#')
      : [String(r.class_id || ''), String(r.course_name || ''), records.attributionKey(r),
        String(r.teach_date || ''), String(r.section || '')].join('#');
    if (seen[key]) return;
    seen[key] = true;
    out.push(r);
  });
  return out;
}

function sumHours(list) {
  return list.reduce(function (acc, r) { return acc + Number(r.hours || 0); }, 0);
}

function sumMakeupHours(list) {
  return list.reduce(function (acc, r) { return acc + (r.status === 'makeup' ? Number(r.hours || 0) : 0); }, 0);
}

function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

/** 日期范围过滤 */
function inRange(r, from, to) {
  if (from && String(r.teach_date) < String(from)) return false;
  if (to && String(r.teach_date) > String(to)) return false;
  return true;
}

function baseQuery(q) {
  const o = q || {};
  return function (r) {
    if (o.term && String(r.term) !== String(o.term)) return false;
    if (o.deptId && String(r.dept_id) !== String(o.deptId)) return false;
    if (o.teacherId && !matchesTeacher(r, o.teacherId)) return false;
    if (o.classId && String(r.class_id) !== String(o.classId)) return false;
    if (o.from || o.to) return inRange(r, o.from, o.to);
    return true;
  };
}

/**
 * 是否归属该教师（实际授课人口径）
 * - teacher_id === teacherId：直接命中
 * - teacher_id 为空但 teacher_name 与该教师同名：命中（班干部手填的外聘/外院老师）
 * - teacher_id 指向别人：不命中（代课确认人不会顶替实际授课人）
 */
function matchesTeacher(r, teacherId) {
  const tid = String(teacherId);
  if (String(r.teacher_id) === tid) return true;
  if (r.teacher_id) return false;
  const t = view.userById(tid);
  if (!t || !r.teacher_name) return false;
  return u.normalizeName(r.teacher_name) === u.normalizeName(t.real_name);
}


/**
 * 该条课时归属的院系（**实际授课人口径**）：
 *  实际授课人能对应到系统内教师 → 用教师的院系；否则回退到教学班所属院系。
 */
function deptIdOf(r) {
  const key = records.attributionKey(r);
  if (key.indexOf('id:') === 0) {
    const t = view.userById(key.slice(3));
    if (t && t.dept_id) return String(t.dept_id);
  }
  return String((r && r.dept_id) || '');
}

/** 应计学时总量：按课表逐日推算（周次区间内），不受记录状态影响 */
function expectedHours(opts) {
  const o = opts || {};
  let from = o.from;
  let to = o.to;
  if (!from || !to) {
    const dates = store.all('period_records').map(function (r) { return r.teach_date; }).filter(Boolean).sort();
    if (!from) from = dates.length ? dates[0] : u.addDays(u.dateOnly(), -30);
    if (!to) to = dates.length ? dates[dates.length - 1] : u.dateOnly();
  }
  if (from > to) { const t = from; from = to; to = t; }
  let total = 0;
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < 400) {
    guard++;
    const weekday = u.weekdayOf(cursor);
    store.all('course_tasks').forEach(function (t) {
      if (Number(t.weekday) !== weekday) return;
      if (o.term && String(t.term) !== String(o.term)) return;
      if (o.deptId && String(t.dept_id) !== String(o.deptId)) return;
      if (o.teacherId && String(t.teacher_id) !== String(o.teacherId)) return;
      if (o.classId && String(t.class_id) !== String(o.classId)) return;
      // 按实际授课人所属院系推算应计学时（by-dept 口径与归属口径保持一致）
      if (o.teacherDeptId) {
        const tu = view.userById(t.teacher_id);
        if (!tu || String(tu.dept_id) !== String(o.teacherDeptId)) return;
      }
      if (t.status && t.status !== 'active') return;
      if (!records.taskActiveOn(t, cursor)) return;
      total += Number(t.hours || 0);
    });
    cursor = u.addDays(cursor, 1);
  }
  return round(total);
}

/** 契约：/stats/overview 全校：已确认学时、待确认数、过期数、异常数 */
function overview(user, q) {
  const o = q || {};
  let list = store.all('period_records').slice();
  // 院系管理员限本院系
  if (user && user.role === 'dept_admin' && user.dept_id && !o.deptId) o.deptId = String(user.dept_id);
  const inBase = baseQuery(o);
  list = list.filter(inBase);
  list = list.filter(function (r) { return r.status !== 'revoked'; });

  const counted = dedupeByTaskDate(list.filter(countedFilter()));
  const confirmedHours = round(sumHours(counted));
  const makeupHours = round(sumMakeupHours(counted));
  const expired = list.filter(function (r) { return r.status === 'expired'; });
  const rejected = list.filter(function (r) { return r.status === 'rejected'; });
  const appealing = list.filter(function (r) { return r.status === 'appealing'; });
  const waiting = list.filter(function (r) { return r.status === 'wait'; });
  const adhoc = list.filter(function (r) { return Number(r.signer_is_adhoc) === 1; });
  // 业务流程简化后新增口径：临时调整（换老师/改时间/改地点）与「确认人≠实际授课人」单独计数
  const tempAdjusted = list.filter(function (r) { return Number(r.is_temp_adjusted || 0) === 1; });
  const nameMismatch = list.filter(function (r) { return Number(r.confirm_name_mismatch || 0) === 1; });
  const sessionOrigin = list.filter(function (r) { return records.isSessionRow(r); });
  const exp = expectedHours(o);
  const rate = exp > 0 ? Math.round((confirmedHours / exp) * 10000) / 100 : 0;

  return {
    // 前端首页 / mock.js 口径
    confirmedHours: confirmedHours,
    waiting: waiting.length,
    pendingCount: waiting.length,
    expired: expired.length,
    abnormal: expired.length + rejected.length + appealing.length,
    abnormalCount: expired.length + rejected.length + appealing.length,
    // 契约 F 组补充
    makeupHours: makeupHours,
    rejectedCount: rejected.length,
    appealingCount: appealing.length,
    adhocCount: adhoc.length,
    // 新增：临时调整次数 / 确认人≠实际授课人（后台可筛选提醒）/ 班干部发起的课时数
    tempAdjustedCount: tempAdjusted.length,
    nameMismatchCount: nameMismatch.length,
    sessionCount: sessionOrigin.length,
    sessionDoneCount: sessionOrigin.filter(function (r) { return r.status === 'done'; }).length,
    expectedHours: exp,
    completionRate: rate,
    totalHours: exp,
    countedRecords: counted.length,
    byStatus: {
      draft: list.filter(function (r) { return r.status === 'draft'; }).length,
      wait: waiting.length,
      done: list.filter(function (r) { return r.status === 'done'; }).length,
      rejected: rejected.length,
      expired: expired.length,
      appealing: appealing.length,
      makeup: list.filter(function (r) { return r.status === 'makeup'; }).length,
      revoked: store.all('period_records').filter(function (r) { return r.status === 'revoked' && (!o.term || String(r.term) === String(o.term)); }).length,
    },
    range: { from: o.from || null, to: o.to || null, term: o.term || null },
  };
}

/** 契约：/stats/by-dept 分院系学时（含完成率）—— 归属口径按实际授课人所属院系 */
function byDept(user, q) {
  const o = Object.assign({}, q || {});
  const scopeDept = (user && user.role === 'dept_admin' && user.dept_id)
    ? String(user.dept_id)
    : (o.deptId ? String(o.deptId) : '');
  const baseOpt = Object.assign({}, o);
  delete baseOpt.deptId; // 院系归属由 deptIdOf(r) 决定，不再用教学班院系过滤
  const inBase = baseQuery(baseOpt);
  const all = store.all('period_records').filter(function (r) { return r.status !== 'revoked' && inBase(r); });
  const rows = [];
  store.all('depts').forEach(function (d) {
    if (scopeDept && String(d.id) !== scopeDept) return;
    const mine = all.filter(function (r) { return deptIdOf(r) === String(d.id); });
    const counted = dedupeByTaskDate(mine.filter(countedFilter()));
    const conf = round(sumHours(counted));
    const exp = expectedHours({ term: o.term, teacherDeptId: d.id, from: o.from, to: o.to });
    rows.push({
      deptId: d.id,
      id: d.id,
      name: d.name,
      code: d.code,
      hours: conf,
      confirmedHours: conf,
      makeupHours: round(sumMakeupHours(counted)),
      expectedHours: exp,
      percent: exp > 0 ? Math.round((conf / exp) * 10000) / 100 : (conf > 0 ? 100 : 0),
      completionRate: exp > 0 ? Math.round((conf / exp) * 10000) / 100 : (conf > 0 ? 100 : 0),
      waiting: mine.filter(function (r) { return r.status === 'wait'; }).length,
      expired: mine.filter(function (r) { return r.status === 'expired'; }).length,
      abnormal: mine.filter(function (r) { return ['expired', 'rejected', 'appealing'].indexOf(r.status) >= 0; }).length,
      teacherCount: store.filter('users', function (x) { return x.role === 'teacher' && String(x.dept_id) === String(d.id); }).length,
      recordCount: mine.length,
      tempAdjustedCount: mine.filter(function (r) { return Number(r.is_temp_adjusted || 0) === 1; }).length,
    });
  });
  rows.sort(function (a, b) { return b.hours - a.hours; });
  const totalHours = round(rows.reduce(function (a, r) { return a + r.hours; }, 0));
  const totalExpected = round(rows.reduce(function (a, r) { return a + r.expectedHours; }, 0));
  return {
    list: rows,
    total: rows.length,
    totalHours: totalHours,
    totalExpectedHours: totalExpected,
    totalPercent: totalExpected > 0 ? Math.round((totalHours / totalExpected) * 10000) / 100 : 0,
    // 兼容 mock.js 的 deptStats 形状（数组）
    stats: rows,
  };
}

/**
 * 契约：/stats/by-teacher 分教师学时排行与明细
 *
 * 归属口径：**按实际授课人**（teacher_id 优先，其次 teacher_name）
 *  · 教师表里的在职教师即使没有课时也会出现在榜上（0 学时，与改造前一致）；
 *  · 班干部手填的非系统教师（外聘/外院，teacher_id 为空）按姓名单独成行，不丢学时；
 *  · 合计 totalHours 与 /stats/overview 的 confirmedHours 始终一致。
 */
function byTeacher(user, q) {
  const o = q || {};
  if (user && user.role === 'dept_admin' && user.dept_id && !o.deptId) o.deptId = String(user.dept_id);
  const inBase = baseQuery(o);
  const all = store.all('period_records').filter(function (r) { return r.status !== 'revoked' && inBase(r); });
  const page = Math.max(1, parseInt(o.page || 1, 10) || 1);
  const pageSizeRaw = parseInt(o.pageSize || 20, 10) || 20;
  const pageSize = Math.min(200, Math.max(1, pageSizeRaw));

  // 每个「实际授课人」一个分组：key 由 records.attributionKey 统一生成
  const groups = {};
  function groupOf(key) {
    if (!groups[key]) groups[key] = { key: key, records: [] };
    return groups[key];
  }

  // 先在职工（含 0 学时）建组，保证排行榜行为与改造前一致
  store.filter('users', function (x) {
    if (x.role !== 'teacher') return false;
    if (o.deptId && String(x.dept_id) !== String(o.deptId)) return false;
    if (o.teacherId && String(x.id) !== String(o.teacherId)) return false;
    if (x.status !== 'active') return false;
    return true;
  }).forEach(function (t) { groupOf('id:' + String(t.id)); });

  all.forEach(function (r) { groupOf(records.attributionKey(r)).records.push(r); });

  const rows = Object.keys(groups).map(function (key) {
    const g = groups[key];
    const mine = g.records;
    const teacherId = key.indexOf('id:') === 0 ? key.slice(3) : '';
    const t = teacherId ? view.userById(teacherId) : null;
    const sample = mine[0] || null;
    const name = t ? t.real_name : (sample ? String(sample.teacher_name || '') : '');
    const deptId = t ? t.dept_id : (sample ? sample.dept_id : null);
    const counted = dedupeByTaskDate(mine.filter(countedFilter()));
    const conf = round(sumHours(counted));
    const exp = teacherId ? expectedHours({ term: o.term, teacherId: teacherId, from: o.from, to: o.to }) : 0;
    return {
      teacherId: teacherId,
      id: teacherId || key,
      name: name,
      teacherName: name,
      staffNo: t ? t.staff_no : (sample ? String(sample.teacher_no || '') : ''),
      deptId: deptId || null,
      deptName: view.deptName(deptId),
      // 该行是否为系统内教师（false = 班干部手填的实际授课人，如外聘/外院教师）
      registered: !!t,
      hours: conf,
      confirmedHours: conf,
      makeupHours: round(sumMakeupHours(counted)),
      expectedHours: exp,
      percent: exp > 0 ? Math.round((conf / exp) * 10000) / 100 : (conf > 0 ? 100 : 0),
      completionRate: exp > 0 ? Math.round((conf / exp) * 10000) / 100 : (conf > 0 ? 100 : 0),
      recordCount: mine.length,
      doneCount: mine.filter(function (r) { return r.status === 'done'; }).length,
      waitCount: mine.filter(function (r) { return r.status === 'wait'; }).length,
      expiredCount: mine.filter(function (r) { return r.status === 'expired'; }).length,
      rejectedCount: mine.filter(function (r) { return r.status === 'rejected'; }).length,
      tempAdjustedCount: mine.filter(function (r) { return Number(r.is_temp_adjusted || 0) === 1; }).length,
      nameMismatchCount: mine.filter(function (r) { return Number(r.confirm_name_mismatch || 0) === 1; }).length,
    };
  }).filter(function (row) {
    // teacherId 过滤（可能是系统内 id，也可能是姓名）；已由上面预筛过，这里再做一次兜底
    if (!o.teacherId) return true;
    if (String(row.teacherId) === String(o.teacherId)) return true;
    if (!row.teacherId && row.name && u.normalizeName(row.name) === u.normalizeName(view.userName(o.teacherId) || '')) return true;
    return false;
  });
  rows.sort(function (a, b) { return b.hours - a.hours || String(a.name).localeCompare(String(b.name)); });
  const total = rows.length;
  const start = (page - 1) * pageSize;
  return {
    list: rows.slice(start, start + pageSize),
    total: total,
    page: page,
    pageSize: pageSize,
    totalHours: round(rows.reduce(function (a, r) { return a + r.hours; }, 0)),
    rank: rows,
  };
}

/** 契约：/stats/by-course 分课程 */
function byCourse(user, q) {
  const o = q || {};
  if (user && user.role === 'dept_admin' && user.dept_id && !o.deptId) o.deptId = String(user.dept_id);
  const inBase = baseQuery(o);
  const all = store.all('period_records').filter(function (r) { return r.status !== 'revoked' && inBase(r); });
  const map = {};
  all.forEach(function (r) {
    const key = String(r.course_code || '') + '|' + String(r.course_name || '');
    if (!map[key]) {
      map[key] = {
        courseCode: r.course_code || '', courseName: r.course_name || '',
        hours: 0, makeupHours: 0, recordCount: 0, classIds: {}, teacherIds: {},
        waiting: 0, expired: 0, abnormal: 0,
      };
    }
    const c = map[key];
    c.recordCount++;
    c.classIds[r.class_id] = 1;
    // 教师数按实际授课人口径去重（id 优先，其次姓名）
    c.teacherIds[records.attributionKey(r)] = 1;
    if (r.status === 'wait') c.waiting++;
    if (r.status === 'expired') c.expired++;
    if (['expired', 'rejected', 'appealing'].indexOf(r.status) >= 0) c.abnormal++;
  });
  // 正式学时按 task+date 去重后累加
  dedupeByTaskDate(all.filter(countedFilter())).forEach(function (r) {
    const key = String(r.course_code || '') + '|' + String(r.course_name || '');
    if (!map[key]) return;
    map[key].hours = round(map[key].hours + Number(r.hours || 0));
    if (r.status === 'makeup') map[key].makeupHours = round(map[key].makeupHours + Number(r.hours || 0));
  });
  const rows = Object.keys(map).map(function (k) {
    const c = map[k];
    return {
      courseCode: c.courseCode,
      courseName: c.courseName,
      hours: c.hours,
      confirmedHours: c.hours,
      makeupHours: c.makeupHours,
      recordCount: c.recordCount,
      classCount: Object.keys(c.classIds).length,
      teacherCount: Object.keys(c.teacherIds).length,
      waiting: c.waiting,
      expired: c.expired,
      abnormal: c.abnormal,
    };
  });
  rows.sort(function (a, b) { return b.hours - a.hours || String(a.courseName).localeCompare(String(b.courseName)); });
  return { list: rows, total: rows.length, totalHours: round(rows.reduce(function (a, r) { return a + r.hours; }, 0)) };
}

/** 契约：/stats/trend?from=&to=&granularity=day|week|month */
function trend(user, q) {
  const o = q || {};
  const granularity = ['day', 'week', 'month'].indexOf(o.granularity) >= 0 ? o.granularity : 'week';
  const inBase = baseQuery(o);
  const all = store.all('period_records').filter(function (r) { return r.status !== 'revoked' && inBase(r); });
  const counted = dedupeByTaskDate(all.filter(countedFilter()));

  function bucketOf(dateStr) {
    if (granularity === 'day') return dateStr;
    if (granularity === 'month') return String(dateStr).slice(0, 7);
    return u.mondayOf(dateStr);
  }

  const map = {};
  counted.forEach(function (r) {
    const b = bucketOf(r.teach_date);
    if (!map[b]) map[b] = { bucket: b, hours: 0, records: 0, makeupHours: 0 };
    map[b].hours = round(map[b].hours + Number(r.hours || 0));
    map[b].records++;
    if (r.status === 'makeup') map[b].makeupHours = round(map[b].makeupHours + Number(r.hours || 0));
  });
  // 待确认/异常也按桶统计，便于看板叠加显示
  const aux = {};
  all.forEach(function (r) {
    const b = bucketOf(r.teach_date);
    if (!aux[b]) aux[b] = { waiting: 0, expired: 0, abnormal: 0 };
    if (r.status === 'wait') aux[b].waiting++;
    if (r.status === 'expired') aux[b].expired++;
    if (['expired', 'rejected', 'appealing'].indexOf(r.status) >= 0) aux[b].abnormal++;
  });

  const list = Object.keys(map).sort().map(function (b) {
    const a = aux[b] || { waiting: 0, expired: 0, abnormal: 0 };
    return Object.assign({ bucket: b, label: b, hours: map[b].hours, records: map[b].records, makeupHours: map[b].makeupHours }, a);
  });
  return {
    list: list,
    granularity: granularity,
    total: list.length,
    totalHours: round(list.reduce(function (a, r) { return a + r.hours; }, 0)),
    from: o.from || null,
    to: o.to || null,
  };
}

module.exports = {
  COUNTED, dedupeByTaskDate, sumHours, sumMakeupHours, expectedHours, round, matchesTeacher, deptIdOf,
  overview, byDept, byTeacher, byCourse, trend,
};
