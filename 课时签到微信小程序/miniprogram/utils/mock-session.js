// mock：班级课程清单 + 课时会话（业务流程简化后的离线演示与自测数据源）
//
// 与真实后端（backend/src/{classcourses,sessions}.js）保持同一套：
//   · 字段命名（驼峰，等同 view.shapeClassCourse / view.shapeSession）
//   · 权限口径（班干部=本班 / 教师=本人为实际授课人或本人确认过 / 管理员=全部）
//   · 业务校验与中文提示（必填、长度、敏感词、weekday/hours 取值、重复发起 40901、
//     动态码 41001/41002、状态 42201、权限 40301）
//   · 动态码 60 秒一次性（复用 utils/mock-code.js）
//
// 页面只通过 utils/api.js 访问本模块；数据在内存 + 本地 storage 中保留，便于开发者工具里
// 反复演示（api.__mock.reset() 可清空）。

var mock = require('./mock.js');
var mockCode = require('./mock-code.js');
var codeParse = require('./code-parse.js');

var KEY_COURSES = 'ch_class_courses_v1';
var KEY_SESSIONS = 'ch_sessions_v1';
var SEED_VERSION = 'v1';

var SECTION_TIME = {
  '1-2': ['08:00', '09:40'],
  '3-4': ['10:05', '11:45'],
  '5-6': ['14:00', '15:40'],
  '7-8': ['16:00', '17:40']
};

var STATUS_TEXT = {
  draft: '未发起', wait: '待教师确认', done: '已确认', rejected: '已拒绝',
  expired: '已过期', appealing: '申诉中', makeup: '已补签', revoked: '已撤销'
};
var COURSE_STATUS_TEXT = { active: '使用中', archived: '已归档' };
var LIMITS = { course_name: 60, teacher_name: 30, place: 60, section: 20, term: 20, teacher_no: 32 };

// 内置敏感词（仅演示 / 自测用；真实后端由 /config 的 sensitive_words 决定）
var SENSITIVE_WORDS = ['代签', '作弊', '违规代办', '包过'];

// 会话操作留痕（审计尾部演示）
var AUDIT = {};

var courses = null;      // 课程清单（驼峰，等同 shapeClassCourse）
var sessions = null;     // 课时会话（驼峰，等同 shapeSession）
var seqCourse = 100;
var seqSession = 100;

// ---------------------------------------------------------------- 存储
function storageGet(key) {
  try { return wx.getStorageSync(key); } catch (e) { return ''; }
}
function storageSet(key, value) {
  try { wx.setStorageSync(key, value); } catch (e) { /* 存储不可用时仅用内存态 */ }
}
function storageRemove(key) {
  try { wx.removeStorageSync(key); } catch (e) { /* ignore */ }
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }

function load() {
  if (courses && sessions) return;
  var meta = storageGet(KEY_COURSES + '_meta');
  var seedOk = meta && meta.version === SEED_VERSION;
  var c = seedOk ? storageGet(KEY_COURSES) : '';
  var s = seedOk ? storageGet(KEY_SESSIONS) : '';
  courses = (c && c.length) ? c : clone(mock.classCourses);
  sessions = (s && s.length) ? s : clone(mock.sessions);
  if (!seedOk) {
    storageSet(KEY_COURSES + '_meta', { version: SEED_VERSION });
    persist();
  }
}
function persist() {
  storageSet(KEY_COURSES, courses);
  storageSet(KEY_SESSIONS, sessions);
}

/** 清空 mock 数据并回到种子状态（自测用） */
function reset() {
  courses = null;
  sessions = null;
  AUDIT = {};
  seqCourse = 100;
  seqSession = 100;
  mockCode.reset();
  storageRemove(KEY_COURSES + '_meta');
  storageRemove(KEY_COURSES);
  storageRemove(KEY_SESSIONS);
}

// ---------------------------------------------------------------- 当前登录者（mock 身份）
/**
 * mock 下的当前用户：优先取 app.globalData（页面桩 / 真机演示都会写），
 * 取不到时按角色回退到 mock.teacher / mock.cadre，保证离线演示永远有身份。
 */
function currentUser() {
  var a = null;
  try { a = getApp(); } catch (e) { a = null; }
  var g = (a && a.globalData) || {};
  var role = g.role || (g.user && g.user.role) || 'cadre';
  var u = g.user || null;
  if (!u) u = role === 'teacher' ? mock.teacher : mock.cadre;
  return {
    id: u.id || ('MOCK-' + role),
    role: role,
    name: u.name || u.realName || '',
    realName: u.name || u.realName || '',
    no: u.no || u.staffId || u.studentId || '',
    dept: u.dept || '',
    deptId: u.deptId || '',
    className: u.className || mock.MOCK_CLASS.name,
    classId: u.classId || mock.MOCK_CLASS.id,
    duty: u.duty || ''
  };
}

// ---------------------------------------------------------------- 校验工具（提示口径与后端一致）
function err(code, msg) { return { code: code, msg: msg }; }

function param(msg) { return err(40001, msg); }

function normalizeName(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, '').toLowerCase();
}

function textOf(label, value, max, required) {
  var s = String(value === undefined || value === null ? '' : value).trim();
  if (!s && required) throw param(label + '不能为空，请填写后重新提交');
  if (Array.from(s).length > max) throw param(label + '过长：当前 ' + Array.from(s).length + ' 字符，最多 ' + max + ' 字符');
  var hit = SENSITIVE_WORDS.filter(function (w) { return s.toLowerCase().indexOf(w.toLowerCase()) >= 0; });
  if (hit.length) throw param('内容包含敏感词：' + hit.join('、') + '（' + label + '），请修改后重新提交');
  return s;
}

/** 星期归一化：1-7 或 null（空 = 未排课） */
function normalizeWeekday(v) {
  if (v === undefined || v === null || v === '' || v === 'null' || v === '0') return null;
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 7) {
    throw param('weekday 取值应为 1-7（可空表示未排课）');
  }
  return n;
}

/** 学时归一化：0-100，空值取默认 */
function normalizeHours(v, dflt) {
  if (v === undefined || v === null || v === '') return Number(dflt || 0);
  var n = Number(v);
  if (!isFinite(n) || n < 0 || n > 100) throw param('hours 取值应为 0-100 之间的数字');
  return Math.round(n * 100) / 100;
}

function timeOfSection(section) {
  var st = SECTION_TIME[String(section || '')];
  return st ? [st[0], st[1]] : ['', ''];
}

function weekdayTextOf(wd) {
  var arr = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return wd ? (arr[Number(wd)] || '') : '';
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dateOnly(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}
function shortDate(v) {
  var s = String(v || '');
  return s.length >= 10 ? s.slice(5, 10) : s;
}
function weekdayOfDate(dateStr) {
  var parts = String(dateStr || '').split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var w = d.getDay();
  return w === 0 ? 7 : w;
}
function isFutureDate(dateStr) { return String(dateStr) > dateOnly(); }

function auditOf(sessionId) {
  if (!AUDIT[sessionId]) AUDIT[sessionId] = [];
  return AUDIT[sessionId];
}
function pushAudit(sessionId, action, actor, detail) {
  var list = auditOf(sessionId);
  list.push({ action: action, actor: actor, at: new Date().toISOString(), detail: detail });
  if (list.length > 10) list.splice(0, list.length - 10);
}

// ---------------------------------------------------------------- 课程清单
function withCourseText(c) {
  var o = clone(c);
  o.statusText = COURSE_STATUS_TEXT[o.status] || o.status;
  o.archived = o.status === 'archived';
  o.weekdayText = weekdayTextOf(o.weekday);
  o.time = (o.startTime || '') + '–' + (o.endTime || '');
  return o;
}

function canManageClass(user, classId) {
  if (!classId) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'dept_admin') return true;                 // mock 下不细分院系
  if (user.role === 'cadre') return String(user.classId) === String(classId) || !user.classId;
  return false;                                               // 教师只读
}

function courseById(id) {
  load();
  var hit = courses.filter(function (c) { return String(c.id) === String(id); });
  return hit[0] || null;
}

function sameCourseInClass(classId, courseName, teacherName) {
  load();
  var hit = courses.filter(function (c) {
    return String(c.classId) === String(classId) &&
      c.status === 'active' &&
      normalizeName(c.courseName) === normalizeName(courseName) &&
      (!teacherName || normalizeName(c.teacherName) === normalizeName(teacherName));
  });
  return hit[0] || null;
}

/**
 * GET /class-courses
 * @returns {{list, total, page, pageSize, summary}}
 */
function listCourses(query) {
  load();
  var user = currentUser();
  var q = query || {};
  var list = courses.slice();

  if (user.role === 'cadre') {
    list = list.filter(function (c) { return String(c.classId) === String(user.classId); });
  } else if (user.role === 'dept_admin') {
    // mock 下只有一个教学班，不额外收窄
  }
  if (q.classId) list = list.filter(function (c) { return String(c.classId) === String(q.classId); });

  var statusRaw = (q.status === undefined || q.status === null || q.status === '') ? 'active' : String(q.status).trim();
  if (statusRaw !== 'all') {
    var ss = statusRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    ss.forEach(function (s) {
      if (['active', 'archived'].indexOf(s) < 0) throw param('status 取值应为 active / archived / all');
    });
    if (ss.length) list = list.filter(function (c) { return ss.indexOf(String(c.status)) >= 0; });
  }
  if (q.term) list = list.filter(function (c) { return String(c.term) === String(q.term); });
  if (q.weekday !== undefined && q.weekday !== '' && q.weekday !== null) {
    var wd = normalizeWeekday(q.weekday);
    list = list.filter(function (c) { return Number(c.weekday) === wd; });
  }
  if (q.keyword) {
    var kw = String(q.keyword);
    list = list.filter(function (c) {
      return String(c.courseName || '').indexOf(kw) >= 0 ||
        String(c.teacherName || '').indexOf(kw) >= 0 ||
        String(c.place || '').indexOf(kw) >= 0;
    });
  }

  list.sort(function (a, b) {
    var wa = Number(a.weekday || 9);
    var wb = Number(b.weekday || 9);
    if (wa !== wb) return wa - wb;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''));
  });

  var scoped = courses.slice();
  if (user.role === 'cadre') scoped = scoped.filter(function (c) { return String(c.classId) === String(user.classId); });

  var page = Number(q.page) || 1;
  var pageSize = Number(q.pageSize) || 20;
  var start = (page - 1) * pageSize;
  var pageList = list.slice(start, start + pageSize).map(withCourseText);

  return {
    list: pageList,
    total: list.length,
    page: page,
    pageSize: pageSize,
    summary: {
      total: scoped.length,
      active: scoped.filter(function (c) { return c.status === 'active'; }).length,
      archived: scoped.filter(function (c) { return c.status === 'archived'; }).length
    }
  };
}

/** GET /class-courses/today?date= */
function coursesToday(query) {
  var q = query || {};
  var date = q.date || dateOnly();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw param('date 格式应为 YYYY-MM-DD');
  var weekday = weekdayOfDate(date);
  var out = listCourses({
    classId: q.classId, status: 'active', weekday: weekday, page: 1, pageSize: 200
  });
  return {
    date: date,
    weekday: weekday,
    weekdayText: weekdayTextOf(weekday),
    total: out.list.length,
    list: out.list
  };
}

/** POST /class-courses */
function createCourse(payload) {
  load();
  var user = currentUser();
  var b = payload || {};
  if (['cadre', 'dept_admin', 'admin'].indexOf(user.role) < 0) {
    throw err(40301, '仅班干部或管理员可维护课程清单');
  }
  var classId = b.classId || user.classId;
  if (!classId) throw param('classId 必填（班干部默认本班，管理员需显式指定）');
  if (!canManageClass(user, classId)) {
    throw err(40301, '班干部只能维护本班（' + mock.MOCK_CLASS.name + '）的课程清单');
  }
  var courseName = textOf('课程名称', b.courseName !== undefined ? b.courseName : b.course_name, LIMITS.course_name, true);
  var teacherName = textOf('授课老师', b.teacherName !== undefined ? b.teacherName : b.teacher_name, LIMITS.teacher_name, true);
  var place = textOf('上课地点', b.place, LIMITS.place, false);
  var weekday = normalizeWeekday(b.weekday);
  var section = String(b.section === undefined || b.section === null ? '' : b.section).trim().slice(0, LIMITS.section);
  var hours = normalizeHours(b.hours, 2);
  var auto = timeOfSection(section);
  var now = new Date().toISOString();
  seqCourse++;
  var row = {
    id: 'CR' + String(seqCourse).padStart(8, '0'),
    classCourseId: 'CR' + String(seqCourse).padStart(8, '0'),
    classId: String(classId),
    className: mock.MOCK_CLASS.name,
    deptId: mock.MOCK_CLASS.deptId,
    deptName: mock.MOCK_CLASS.deptName,
    courseName: courseName,
    teacherName: teacherName,
    teacherNo: String(b.teacherNo || '').trim().slice(0, LIMITS.teacher_no),
    weekday: weekday,
    section: section,
    startTime: auto[0],
    endTime: auto[1],
    time: auto[0] + '–' + auto[1],
    place: place,
    hours: hours,
    term: String(b.term || '2026-2027-1'),
    status: 'active',
    statusText: COURSE_STATUS_TEXT.active,
    archived: false,
    createdBy: user.id,
    createdByName: user.name,
    createdAt: now,
    updatedAt: now
  };
  courses.push(row);
  persist();
  return withCourseText(row);
}

/** PUT /class-courses/{id} */
function updateCourse(id, payload) {
  load();
  var user = currentUser();
  var row = courseById(id);
  if (!row) throw err(40401, '课程清单记录不存在：' + id);
  if (!canManageClass(user, row.classId)) throw err(40301, '班干部只能维护本班（' + mock.MOCK_CLASS.name + '）的课程清单');
  if (row.status !== 'active') throw err(42201, '该课程已归档，不可修改（如需恢复请联系管理员）');
  var b = payload || {};
  if (b.classId && String(b.classId) !== String(row.classId)) {
    throw param('classId 不可修改（如需换班请归档后重新录入）');
  }
  if (b.courseName !== undefined || b.course_name !== undefined) {
    row.courseName = textOf('课程名称', b.courseName !== undefined ? b.courseName : b.course_name, LIMITS.course_name, true);
  }
  if (b.teacherName !== undefined || b.teacher_name !== undefined) {
    row.teacherName = textOf('授课老师', b.teacherName !== undefined ? b.teacherName : b.teacher_name, LIMITS.teacher_name, true);
  }
  if (b.teacherNo !== undefined) row.teacherNo = String(b.teacherNo || '').trim().slice(0, LIMITS.teacher_no);
  if (b.place !== undefined) row.place = textOf('上课地点', b.place, LIMITS.place, false);
  if (b.weekday !== undefined) row.weekday = normalizeWeekday(b.weekday);
  if (b.section !== undefined) {
    row.section = String(b.section === undefined || b.section === null ? '' : b.section).trim().slice(0, LIMITS.section);
    var auto = timeOfSection(row.section);
    if (auto[0]) { row.startTime = auto[0]; row.endTime = auto[1]; }
  }
  if (b.hours !== undefined) row.hours = normalizeHours(b.hours, row.hours);
  if (b.term !== undefined) row.term = String(b.term || row.term);
  row.updatedAt = new Date().toISOString();
  persist();
  return withCourseText(row);
}

/** DELETE /class-courses/{id}（软删除） */
function archiveCourse(id) {
  load();
  var user = currentUser();
  var row = courseById(id);
  if (!row) throw err(40401, '课程清单记录不存在：' + id);
  if (!canManageClass(user, row.classId)) throw err(40301, '班干部只能维护本班（' + mock.MOCK_CLASS.name + '）的课程清单');
  if (row.status === 'archived') throw err(42201, '该课程已归档，无需重复删除');
  row.status = 'archived';
  row.statusText = COURSE_STATUS_TEXT.archived;
  row.archived = true;
  row.updatedAt = new Date().toISOString();
  persist();
  return { ok: true, id: row.id, classId: row.classId, status: row.status, archived: true, course: withCourseText(row) };
}

// ---------------------------------------------------------------- 课时会话
function sessionById(id) {
  load();
  var hit = sessions.filter(function (s) { return String(s.sessionId) === String(id); });
  return hit[0] || null;
}

/**
 * 能否管理（刷新动态码 / 协作）该课时：与后端 canManageSession 同口径
 * 注意：权限与状态是两件事 —— 有权限但状态不是 wait 时后端返回 42201（不是 40301）。
 */
function canManageSession(user, row) {
  if (!user || !row) return false;
  if (user.role === 'admin' || user.role === 'dept_admin') return true;
  if (user.role === 'cadre') {
    return String(row.initiatorId || '') === String(user.id) ||
      String(row.classId) === String(user.classId);
  }
  return false;
}

function visibleSessions(user) {  load();
  if (user.role === 'cadre') {
    return sessions.filter(function (s) { return String(s.classId) === String(user.classId); });
  }
  if (user.role === 'teacher') {
    return sessions.filter(function (s) {
      return normalizeName(s.teacherName) === normalizeName(user.name) ||
        String(s.confirmedBy || '') === String(user.id);
    });
  }
  return sessions.slice();
}

function statusTotalsOf(user, query) {
  var q = Object.assign({}, query || {});
  delete q.status;
  var list = filterSessions(visibleSessions(user), q);
  var out = {};
  ['draft', 'wait', 'done', 'rejected', 'expired', 'appealing', 'makeup', 'revoked'].forEach(function (s) { out[s] = 0; });
  list.forEach(function (s) { out[s.status] = Number(out[s.status] || 0) + 1; });
  return out;
}

function filterSessions(list, q) {
  var out = list.slice();
  if (q.status) {
    var ss = String(q.status).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (ss.length) out = out.filter(function (s) { return ss.indexOf(String(s.status)) >= 0; });
  }
  if (q.date) out = out.filter(function (s) { return String(s.teachDate) === String(q.date); });
  if (q.from) out = out.filter(function (s) { return String(s.teachDate) >= String(q.from); });
  if (q.to) out = out.filter(function (s) { return String(s.teachDate) <= String(q.to); });
  if (q.classId) out = out.filter(function (s) { return String(s.classId) === String(q.classId); });
  if (q.courseId) out = out.filter(function (s) { return String(s.courseId || '') === String(q.courseId); });
  if (q.teacherName) out = out.filter(function (s) { return String(s.teacherName || '').indexOf(String(q.teacherName)) >= 0; });
  if (q.courseName) out = out.filter(function (s) { return String(s.courseName || '').indexOf(String(q.courseName)) >= 0; });
  if (String(q.tempAdjusted) === 'true' || q.tempAdjusted === true) out = out.filter(function (s) { return s.isTempAdjusted === true; });
  if (String(q.nameMismatch) === 'true' || q.nameMismatch === true) out = out.filter(function (s) { return s.confirmNameMismatch === true; });
  out.sort(function (a, b) {
    if (String(a.teachDate) === String(b.teachDate)) return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return String(b.teachDate).localeCompare(String(a.teachDate));
  });
  return out;
}

/** GET /sessions */
function listSessions(query) {
  var user = currentUser();
  var q = query || {};
  var list = filterSessions(visibleSessions(user), q);
  var page = Number(q.page) || 1;
  var pageSize = Number(q.pageSize) || 20;
  var start = (page - 1) * pageSize;
  var pageList = list.slice(start, start + pageSize);
  return {
    list: pageList.map(function (s) { return sessionView(s, user); }),
    total: list.length,
    page: page,
    pageSize: pageSize,
    summary: {
      hours: list.filter(function (s) { return s.status === 'done' || s.status === 'makeup'; })
        .reduce(function (a, s) { return a + Number(s.hours || 0); }, 0),
      byStatus: list.reduce(function (acc, s) { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {}),
      statusTotals: statusTotalsOf(user, q),
      tempAdjustedCount: list.filter(function (s) { return s.isTempAdjusted === true; }).length,
      nameMismatchCount: list.filter(function (s) { return s.confirmNameMismatch === true; }).length
    }
  };
}

/** 会话视图：按查看者补 canConfirm / canRefreshCode（与后端 shapeSession 一致） */
function sessionView(row, user) {
  var u = user || currentUser();
  var isWait = row.status === 'wait';
  var o = clone(row);
  o.statusText = STATUS_TEXT[o.status] || o.status;
  o.counted = o.status === 'done' || o.status === 'makeup';
  o.date = shortDate(o.teachDate);
  o.fullDate = o.teachDate;
  o.canConfirm = !!(isWait && ['teacher', 'dept_admin', 'admin'].indexOf(u.role) >= 0);
  o.canRefreshCode = !!(isWait && canManageSession(u, row));
  o.evidence = {
    labels: ['动态码', '确认人', '确认时间', '设备'],
    codeId: o.codeId || '',
    confirmedName: o.confirmedName || '',
    confirmedRole: o.confirmedRole || '',
    confirmedAt: o.confirmedAt || '',
    device: o.confirmDevice || '',
    ip: o.confirmIp || '',
    nameMismatch: o.confirmNameMismatch === true
  };
  delete o._audit;
  return o;
}

/** GET /sessions/{id} —— 详情（课程快照 + 证据 + 审计尾部） */
function getSessionDetail(id) {
  var user = currentUser();
  var row = sessionById(id);
  if (!row) throw err(40401, '课时会话不存在：' + id);
  var visible = visibleSessions(user).filter(function (s) { return String(s.sessionId) === String(id); });
  if (!visible.length) throw err(40301, '无权查看该课时会话');
  var course = row.courseId ? courseById(row.courseId) : null;
  var code = mockCode.statusOf(row.codeId);
  return {
    session: sessionView(row, user),
    course: course ? withCourseText(course) : null,
    teacher: row.teacherName ? { id: row.teacherId || '', name: row.teacherName, realName: row.teacherName, staffId: row.teacherNo || '', role: 'teacher' } : null,
    initiator: row.initiatorName ? { id: row.initiatorId, name: row.initiatorName, realName: row.initiatorName, duty: row.initiatorDuty, role: 'cadre' } : null,
    confirmer: row.confirmedName ? { id: row.confirmedBy, name: row.confirmedName, realName: row.confirmedName, role: row.confirmedRole } : null,
    code: code,
    auditTail: (AUDIT[row.sessionId] || []).slice(-10)
  };
}

/** 组装「会话 + 动态码」响应（与后端 sessionCodePayload 同形） */
function sessionCodePayload(row, code, extra) {
  var user = currentUser();
  return Object.assign({
    sessionId: row.sessionId,
    codeId: code.codeId,
    code: code.code,
    codeLength: 6,
    qrPayload: code.qrPayload,
    qrUrl: code.qrPayload,
    sign: '',
    expireAt: new Date(code.expireAtMs).toISOString(),
    expireAtMs: code.expireAtMs,
    ttl: code.ttl,
    adopted: false,
    session: sessionView(row, user),
    channels: {
      qr: { payload: code.qrPayload, hint: '任课教师用「扫码确认」扫描此二维码' },
      code: { value: code.code, hint: '任课教师也可手输这 6 位数字口令' }
    },
    rule: '同一 codeId 只能被消费一次；过期返回 41001，重复使用返回 41002；确认后本课时置 done'
  }, extra || {});
}

function computeTempAdjusted(ref, p, teachDate) {
  if (!ref) return false;
  if (normalizeName(ref.courseName) !== normalizeName(p.courseName)) return true;
  if (normalizeName(ref.teacherName) !== normalizeName(p.teacherName)) return true;
  if (String(ref.section || '') !== String(p.section || '')) return true;
  if (String(ref.place || '') !== String(p.place || '')) return true;
  if (Number(ref.hours || 0) !== Number(p.hours || 0)) return true;
  if (ref.weekday && Number(ref.weekday) !== weekdayOfDate(teachDate)) return true;
  return false;
}

/** POST /sessions —— 班干部发起一次课时并签发 60 秒动态码 */
function createSession(payload) {
  load();
  var user = currentUser();
  var b = payload || {};
  if (['cadre', 'dept_admin', 'admin'].indexOf(user.role) < 0) {
    throw err(40301, '仅班干部或管理员可发起课时确认');
  }
  var classId = b.classId || user.classId;
  if (!classId) throw param('classId 必填（班干部默认本班，管理员需显式指定）');
  if (!canManageClass(user, classId)) {
    throw err(40301, '班干部只能为本班（' + mock.MOCK_CLASS.name + '）发起课时确认');
  }

  var course = b.courseId ? courseById(b.courseId) : null;
  if (b.courseId && !course) throw err(40401, '课程清单记录不存在：' + b.courseId);
  if (course && String(course.classId) !== String(classId)) throw param('courseId 不属于该教学班');
  if (course && course.status !== 'active') throw err(42201, '该课程已归档，无法发起（请先在课程清单中恢复）');

  var courseName = textOf('课程名称',
    b.courseName !== undefined ? b.courseName : (course ? course.courseName : ''),
    LIMITS.course_name, true);
  var teacherName = textOf('实际授课人',
    b.teacherName !== undefined ? b.teacherName : (course ? course.teacherName : ''),
    LIMITS.teacher_name, true);

  var teachDate = String(b.teachDate || b.date || b.fullDate || dateOnly()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(teachDate)) throw param('teachDate 格式应为 YYYY-MM-DD');
  if (isFutureDate(teachDate)) throw param('teachDate 不得为未来日期（当前 ' + dateOnly() + '）');

  var fallback = course ? null : sameCourseInClass(classId, courseName, teacherName);
  var ref = course || fallback;
  var section = String(b.section !== undefined && b.section !== null && b.section !== '' ? b.section : (ref ? ref.section : '')).trim();
  var place = b.place !== undefined ? textOf('上课地点', b.place, LIMITS.place, false) : (ref ? ref.place : '');
  var hours = b.hours !== undefined ? normalizeHours(b.hours, ref ? ref.hours : 2) : (ref ? Number(ref.hours || 0) : 2);
  var auto = timeOfSection(section);
  var startTime = (ref && ref.startTime) || auto[0] || '';
  var endTime = (ref && ref.endTime) || auto[1] || '';

  var summary = textOf('授课摘要', b.summary, 500, false);
  var absentNames = textOf('缺勤姓名', b.absentNames, 300, false);
  var note = textOf('备注', b.note, 500, false);
  var discipline = ['good', 'normal', 'bad'].indexOf(b.discipline) >= 0 ? b.discipline : 'good';
  var absentCountRaw = Number(b.absentCount || 0);
  var absentCount = isFinite(absentCountRaw) && absentCountRaw >= 0 ? Math.floor(absentCountRaw) : 0;

  // 唯一性：同教学班 + 日期 + 节次 + 实际授课人
  var conflict = sessions.filter(function (s) {
    return String(s.classId) === String(classId) &&
      String(s.teachDate) === String(teachDate) &&
      String(s.section || '') === String(section || '') &&
      normalizeName(s.teacherName) === normalizeName(teacherName) &&
      s.status !== 'revoked';
  })[0];
  if (conflict) {
    var dup = err(40901, '该课时已由班干部发起（会话 ' + conflict.sessionId + '，状态 ' + conflict.status + '），请勿重复发起');
    // 与后端一致：details 里带 existingId / existingSessionId / existingStatus，便于前端直接跳已有课时
    dup.details = { existingId: conflict.sessionId, existingSessionId: conflict.sessionId, existingStatus: conflict.status };
    throw dup;
  }

  var isTempAdjusted = computeTempAdjusted(ref, {
    courseName: courseName, teacherName: teacherName, section: section, place: place, hours: hours
  }, teachDate) || b.isTempAdjusted === true;

  var now = new Date().toISOString();
  seqSession++;
  var sid = 'MR' + String(seqSession).padStart(8, '0');
  var row = {
    sessionId: sid, id: sid, origin: 'session', term: (ref && ref.term) || '2026-2027-1',
    courseId: course ? course.id : '',
    courseName: courseName,
    teacherId: (course && course.teacherNo ? 'U' + course.teacherNo : ''),
    teacherName: teacherName,
    teacherNo: (course && course.teacherNo) || '',
    classId: String(classId),
    className: (course && course.className) || mock.MOCK_CLASS.name,
    deptId: mock.MOCK_CLASS.deptId,
    deptName: mock.MOCK_CLASS.deptName,
    teachDate: teachDate,
    fullDate: teachDate,
    section: section,
    startTime: startTime,
    endTime: endTime,
    time: startTime + '–' + endTime,
    place: place,
    hours: hours,
    initiatorId: user.id,
    initiatorName: user.name,
    initiatorDuty: user.duty || '学委',
    isTempAdjusted: isTempAdjusted,
    status: 'wait',
    statusText: STATUS_TEXT.wait,
    counted: false,
    confirmedBy: '', confirmedName: '', confirmedRole: '', confirmedAt: '',
    confirmIp: '', confirmDevice: '', confirmNameMismatch: false,
    absentCount: absentCount, absentNames: absentNames,
    discipline: discipline, disciplineText: { good: '好', normal: '一般', bad: '差' }[discipline] || '',
    summary: summary, note: note,
    codeId: '', deadline: teachDate + ' 24:00',
    createdAt: now, updatedAt: now,
    canConfirm: false, canRefreshCode: true
  };
  sessions.unshift(row);
  persist();

  var code = mockCode.generate({ sessionId: sid, classId: classId, ttl: b.ttl });
  row.codeId = code.codeId;
  persist();

  pushAudit(sid, 'session.create', user.name,
    '班干部发起课时会话并签发动态码' + (isTempAdjusted ? '（含临时调整）' : ''));

  return sessionCodePayload(row, code, { adopted: false });
}

/** POST /sessions/{id}/code —— 二维码过期后刷新（仅 wait 可刷新） */
function refreshSessionCode(id, opts) {
  var user = currentUser();
  var row = sessionById(id);
  if (!row) throw err(40401, '课时会话不存在：' + id);
  if (!canManageSession(user, row)) throw err(40301, '无权为该课时刷新动态码');
  if (row.status !== 'wait') {
    throw err(42201, '当前状态为「' + row.status + '」，仅「待教师确认」的课时可刷新动态码');
  }
  var code = mockCode.generate({ sessionId: row.sessionId, classId: row.classId, ttl: (opts || {}).ttl });
  row.codeId = code.codeId;
  row.updatedAt = new Date().toISOString();
  persist();
  pushAudit(row.sessionId, 'session.code.refresh', user.name, '刷新课时动态码（旧码仍按其自身 60 秒有效期失效）');
  return sessionCodePayload(row, code, { refreshed: true });
}

/** POST /sessions/{id}/confirm —— 任课教师扫码后点「确认」 */
function confirmSession(id, payload) {
  var user = currentUser();
  var b = payload || {};
  if (['teacher', 'dept_admin', 'admin'].indexOf(user.role) < 0) {
    throw err(40301, '仅任课教师（或管理员）可确认课时');
  }
  var row = sessionById(id);
  if (!row) throw err(40401, '课时会话不存在：' + id);

  var hasRef = !!(b.codeId || b.code || b.qrContent || b.qrText);
  var resolved = null;
  if (hasRef) {
    resolved = mockCode.resolve(b);                       // 40401 / 41001 / 41002
    if (String(resolved.row.sessionId || '') !== String(row.sessionId)) {
      throw param('动态码与本次课时不匹配（该码属于其它课时会话）');
    }
  } else {
    resolved = { row: mockCode.latestActiveOf(row.sessionId), by: '' };
  }
  var codeRow = resolved.row;

  if (row.status !== 'wait') {
    throw err(42201, '该课时当前状态为「' + row.status + '」，无需重复确认' +
      (row.confirmedName ? '（已由 ' + row.confirmedName + ' 于 ' + row.confirmedAt + ' 确认）' : ''));
  }

  if (codeRow) mockCode.consume(codeRow);                  // 一次性消费

  var now = new Date().toISOString();
  var sameName = normalizeName(user.name) === normalizeName(row.teacherName) ||
    (!!row.teacherNo && !!user.no && String(row.teacherNo) === String(user.no));
  row.confirmedBy = user.id;
  row.confirmedName = user.name;
  row.confirmedAt = now;
  row.confirmedRole = user.role;
  row.confirmIp = '127.0.0.1';
  row.confirmDevice = deviceOf();
  row.confirmNameMismatch = !sameName;
  row.status = 'done';
  row.statusText = STATUS_TEXT.done;
  row.counted = true;
  row.updatedAt = now;
  row.codeId = codeRow ? codeRow.codeId : row.codeId;
  persist();

  pushAudit(row.sessionId, 'session.confirm', user.name,
    '任课教师扫码确认本次课时' +
    (!sameName ? '（确认人「' + user.name + '」≠ 实际授课人「' + row.teacherName + '」，已标记待提醒）' : ''));

  return {
    ok: true,
    sessionId: row.sessionId,
    status: row.status,
    counted: true,
    nameMismatch: row.confirmNameMismatch === true,
    codeConsumed: codeRow ? codeRow.codeId : '',
    confirmedBy: row.confirmedBy,
    confirmedName: row.confirmedName,
    confirmedAt: row.confirmedAt,
    confirmedRole: row.confirmedRole,
    teacherName: row.teacherName,
    msg: row.confirmNameMismatch
      ? '已确认本次课时（确认人「' + row.confirmedName + '」与录入的实际授课人「' + row.teacherName + '」不一致，已标记待提醒）'
      : '已确认本次课时',
    session: sessionView(row, user)
  };
}

function deviceOf() {
  try {
    var info = wx.getSystemInfoSync();
    return ((info.brand || '') + ' ' + (info.model || '')).trim();
  } catch (e) {
    return '未知设备';
  }
}

/** 核验：动态码 → 是否是课时会话码（教师扫码后看到「要确认哪节课」） */
function verifyCode(input) {
  var user = currentUser();
  var resolved = mockCode.resolve(input);         // 40401 / 41001 / 41002 / 40001
  var row = resolved.row;
  var by = resolved.by;
  var session = row.sessionId ? sessionById(row.sessionId) : null;

  if (session && session.origin === 'session') {
    var shaped = sessionView(session, user);
    return {
      codeId: row.codeId,
      verifyBy: by,
      channel: by === 'qrContent' ? 'qr' : (by === 'code' ? 'code' : 'codeId'),
      isSession: true,
      sessionId: session.sessionId,
      session: shaped,
      sessionInfo: shaped,
      expireAt: new Date(row.expireAtMs).toISOString(),
      ttl: Math.max(0, Math.round((row.expireAtMs - Date.now()) / 1000)),
      canConfirm: session.status === 'wait',
      confirmEndpoint: 'POST /api/v1/sessions/' + session.sessionId + '/confirm',
      cadre: { id: session.initiatorId, name: session.initiatorName, realName: session.initiatorName, duty: session.initiatorDuty, role: 'cadre', className: session.className },
      classId: session.classId,
      className: session.className,
      date: session.teachDate,
      tasks: [],
      myTasks: []
    };
  }

  // 旧课表码：保持原行为（班干部身份 + 当日授课任务）
  return {
    codeId: row.codeId,
    verifyBy: by,
    channel: by === 'qrContent' ? 'qr' : (by === 'code' ? 'code' : 'codeId'),
    isSession: false,
    sessionId: '',
    date: dateOnly(),
    expireAt: new Date(row.expireAtMs).toISOString(),
    ttl: Math.max(0, Math.round((row.expireAtMs - Date.now()) / 1000)),
    cadre: mock.cadre,
    classId: mock.MOCK_CLASS.id,
    className: mock.MOCK_CLASS.name,
    tasks: mock.todayCourses,
    myTasks: []
  };
}

module.exports = {
  LIMITS: LIMITS,
  SECTION_TIME: SECTION_TIME,
  STATUS_TEXT: STATUS_TEXT,
  COURSE_STATUS_TEXT: COURSE_STATUS_TEXT,
  currentUser: currentUser,
  deviceOf: deviceOf,
  listCourses: listCourses,
  coursesToday: coursesToday,
  createCourse: createCourse,
  updateCourse: updateCourse,
  archiveCourse: archiveCourse,
  listSessions: listSessions,
  getSessionDetail: getSessionDetail,
  createSession: createSession,
  refreshSessionCode: refreshSessionCode,
  confirmSession: confirmSession,
  verifyCode: verifyCode,
  sessionById: sessionById,
  reset: reset
};
