'use strict';
/**
 * 班级课程清单（新增，业务流程简化第一步）
 *
 * 背景：原流程「教师填写发起 → 班干部签名」改为「班干部维护课程清单 → 每次上课选择该课
 * 并出示动态码 → 任课教师扫码点确认」。因此班干部只需**录入一次课程清单并长期保留**，
 * 之后每次上课从清单带出，允许临时调整（换老师/改时间/改地点），无需审批。
 *
 * 数据表：data/class_courses.json
 *   { id, class_id, class_name, dept_id, course_name, teacher_name, teacher_no?,
 *     weekday?(1-7 可空), section?, start_time?, end_time?, place?, hours, term,
 *     status:'active'|'archived', created_by, created_at, updated_at }
 *
 * 权限：
 *   · 班干部：只维护/查看本班（本人所在班 或 本人被 active 授权的教学班）
 *   · 院系管理员：本院系
 *   · 教务处：全部
 *   · 教师：只读，可按班查询（用于确认前核对课程清单）
 *
 * 校验：course_name / teacher_name 必填；长度上限 + 敏感词拦截（复用 src/freetext.js）
 * 删除：软删除（status='archived'），保留历史可追溯
 */
const u = require('./util');
const store = require('./store');
const audit = require('./audit');
const view = require('./view');
const freetext = require('./freetext');
const { CODES, fail, paramError } = require('./errors');

const TABLE = 'class_courses';
const STATUSES = ['active', 'archived'];
const READ_ROLES = ['cadre', 'teacher', 'dept_admin', 'admin'];
const WRITE_ROLES = ['cadre', 'dept_admin', 'admin'];
/** 字段长度上限（凭需求固定，避免改动 /config 配置面） */
const LIMITS = { course_name: 60, teacher_name: 30, place: 60, section: 20, term: 20, teacher_no: 32 };

// ---------------------------------------------------------------- 工具
/** 星期归一化：1-7 或 null（空 = 未排课） */
function normalizeWeekday(v) {
  if (v === undefined || v === null || v === '' || v === 'null') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 7) throw paramError('weekday 取值应为 1-7（可空表示未排课）');
  return n;
}

/** 学时归一化：0-100 的数字，空值取默认（默认 2） */
function normalizeHours(v, dflt) {
  if (v === undefined || v === null || v === '') return Number(dflt || 0);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw paramError('hours 取值应为 0-100 之间的数字');
  return Math.round(n * 100) / 100;
}

/** 节次 → 起止时间（未显式给 time 时按内置节次表补全） */
function timeOfSection(section) {
  const st = u.SECTION_TIME[String(section || '')];
  return st ? [st[0], st[1]] : ['', ''];
}

function cleanTime(v) {
  const s = u.cleanText(v, 5);
  return /^\d{2}:\d{2}$/.test(s) ? s : '';
}

function textField(field, value, ctx, opts) {
  return freetext.checkFreeText(field, value, ctx, Object.assign({ words: view.sensitiveWords() }, opts)).text;
}

// ---------------------------------------------------------------- 权限
/** 班干部可读/可管的班级（本人所在班 + 被 active 授权的教学班） */
function cadreClassIds(user) {
  const out = [];
  if (user.class_id) out.push(String(user.class_id));
  store.filter('class_cadres', function (r) {
    return String(r.user_id) === String(user.id) && r.status === 'active';
  }).forEach(function (r) {
    const id = String(r.class_id);
    if (out.indexOf(id) < 0) out.push(id);
  });
  return out;
}

/** 能否维护（新增/修改/归档）该教学班的课程清单 */
function canManageClass(user, classId) {
  if (!user || !classId) return false;
  if (user.role === 'admin') return true;
  const cls = store.findById('classes', classId);
  if (!cls) return false;
  if (user.role === 'dept_admin') return !!user.dept_id && String(cls.dept_id) === String(user.dept_id);
  if (user.role === 'cadre') return cadreClassIds(user).indexOf(String(classId)) >= 0;
  return false; // 教师只读
}

/** 能否查看某教学班的课程清单（教师可按班查看，属只读低敏数据） */
function canReadClass(user, classId) {
  if (!user) return false;
  if (user.role === 'teacher') return true;
  if (user.role === 'admin') return true;
  return canManageClass(user, classId);
}

function assertCanManage(user, classId) {
  const cls = store.findById('classes', classId);
  if (!cls) throw fail(CODES.NOT_FOUND, '教学班不存在：' + classId);
  if (!canManageClass(user, classId)) {
    if (user.role === 'cadre') throw fail(CODES.FORBIDDEN, '班干部只能维护本班（' + view.className(user.class_id) + '）的课程清单');
    throw fail(CODES.FORBIDDEN, '无权维护该教学班的课程清单');
  }
  return cls;
}

// ---------------------------------------------------------------- 查询
/**
 * 课程清单查询（按角色限定范围）
 * @param user 当前用户
 * @param q {classId, keyword, status, term, weekday, page, pageSize}
 */
function queryClassCourses(user, q) {
  const o = q || {};
  if (READ_ROLES.indexOf(user.role) < 0) throw fail(CODES.FORBIDDEN, '无权查看班级课程清单');
  let list = store.all(TABLE).slice();

  if (user.role === 'cadre') {
    const ids = cadreClassIds(user);
    list = list.filter(function (r) { return ids.indexOf(String(r.class_id)) >= 0; });
  } else if (user.role === 'dept_admin') {
    list = list.filter(function (r) { return !!user.dept_id && String(r.dept_id) === String(user.dept_id); });
  }
  // teacher / admin：不额外收窄（教师可按班查询）

  if (o.classId) {
    if (!canReadClass(user, o.classId)) throw fail(CODES.FORBIDDEN, '无权查看该教学班的课程清单');
    list = list.filter(function (r) { return String(r.class_id) === String(o.classId); });
  }

  const statusRaw = o.status === undefined || o.status === null || o.status === '' ? 'active' : String(o.status).trim();
  if (statusRaw !== 'all') {
    const ss = statusRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    ss.forEach(function (s) {
      if (STATUSES.indexOf(s) < 0) throw paramError('status 取值应为 active / archived / all');
    });
    if (ss.length) list = list.filter(function (r) { return ss.indexOf(String(r.status)) >= 0; });
  }

  if (o.term) list = list.filter(function (r) { return String(r.term) === String(o.term); });
  if (o.weekday !== undefined && o.weekday !== '' && o.weekday !== null) {
    const wd = normalizeWeekday(o.weekday);
    list = list.filter(function (r) { return Number(r.weekday) === wd; });
  }
  if (o.keyword) {
    const kw = String(o.keyword);
    list = list.filter(function (r) {
      return String(r.course_name || '').indexOf(kw) >= 0 ||
        String(r.teacher_name || '').indexOf(kw) >= 0 ||
        String(r.place || '').indexOf(kw) >= 0 ||
        String(r.class_name || '').indexOf(kw) >= 0;
    });
  }

  list.sort(function (a, b) {
    if (String(a.class_id) !== String(b.class_id)) return String(a.class_id).localeCompare(String(b.class_id));
    const wa = Number(a.weekday || 9);
    const wb = Number(b.weekday || 9);
    if (wa !== wb) return wa - wb;
    if (String(a.start_time || '') !== String(b.start_time || '')) return String(a.start_time || '').localeCompare(String(b.start_time || ''));
    return String(a.course_name || '').localeCompare(String(b.course_name || ''));
  });
  return list;
}

/**
 * 某日期「当天有课」的课程清单（按该日期的星期带出）
 * 班干部：本班；教师/管理员：按 classId（不传则范围内全部班级）
 * @returns {{date, weekday, weekdayText, list}}
 */
function coursesToday(user, q) {
  const o = q || {};
  const date = o.date || u.dateOnly();
  if (!u.isValidDate(date)) throw paramError('date 格式应为 YYYY-MM-DD');
  const weekday = u.weekdayOf(date);
  const list = queryClassCourses(user, Object.assign({}, o, {
    status: o.status === undefined || o.status === '' ? 'active' : o.status,
    weekday: weekday,
  }));
  return { date: date, weekday: weekday, weekdayText: u.WEEKDAY_CN[weekday] || '', list: list };
}

function courseById(user, id) {
  const row = store.findById(TABLE, id);
  if (!row) throw fail(CODES.NOT_FOUND, '课程清单记录不存在：' + id);
  if (!canReadClass(user, row.class_id)) throw fail(CODES.FORBIDDEN, '无权查看该课程清单记录');
  return row;
}

// ---------------------------------------------------------------- 写入
/**
 * 新增课程清单（班干部 / 院系管理员 / 教务处）
 * 必填 courseName、teacherName；可选 weekday / section / place / hours / term
 */
function createClassCourse(user, body, ctx) {
  const b = body || {};
  if (WRITE_ROLES.indexOf(user.role) < 0) throw fail(CODES.FORBIDDEN, '仅班干部或管理员可维护课程清单');
  const classId = b.classId || (user.role === 'cadre' ? user.class_id : '');
  if (!classId) throw paramError('classId 必填（班干部默认本班，管理员需显式指定）');
  const cls = assertCanManage(user, classId);

  const courseName = textField('course_name', b.courseName !== undefined ? b.courseName : b.course_name, ctx,
    { label: '课程名称', max: LIMITS.course_name, required: true });
  const teacherName = textField('teacher_name', b.teacherName !== undefined ? b.teacherName : b.teacher_name, ctx,
    { label: '授课老师', max: LIMITS.teacher_name, required: true });
  const teacherNo = u.cleanText(b.teacherNo !== undefined ? b.teacherNo : b.teacher_no, LIMITS.teacher_no);
  const place = textField('place', b.place, ctx, { label: '上课地点', max: LIMITS.place });
  const weekday = normalizeWeekday(b.weekday);
  const section = u.cleanText(b.section, LIMITS.section);
  const hours = normalizeHours(b.hours, 2);
  const term = u.cleanText(b.term, LIMITS.term) || view.configMap().term || u.TERM_DEFAULT;
  const auto = timeOfSection(section);
  const startTime = cleanTime(b.startTime !== undefined ? b.startTime : b.start_time) || auto[0];
  const endTime = cleanTime(b.endTime !== undefined ? b.endTime : b.end_time) || auto[1];

  const now = u.isoNow();
  const row = store.insert(TABLE, {
    id: store.newId('CR'),
    class_id: String(classId),
    class_name: cls.name || view.className(classId),
    dept_id: cls.dept_id || null,
    course_name: courseName,
    teacher_name: teacherName,
    teacher_no: teacherNo,
    weekday: weekday,
    section: section,
    start_time: startTime,
    end_time: endTime,
    place: place,
    hours: hours,
    term: term,
    status: 'active',
    created_by: user.id,
    created_at: now,
    updated_at: now,
  });

  audit.log(ctx, 'class_course.create', {
    targetType: 'class_course', targetId: row.id,
    after: {
      classId: row.class_id, courseName: row.course_name, teacherName: row.teacher_name,
      weekday: row.weekday, section: row.section, place: row.place, hours: row.hours,
    },
    detail: '录入班级课程清单：' + row.course_name + '（' + row.teacher_name + '）',
  });
  return row;
}

/** 修改课程清单（部分字段更新；不允许改教学班） */
function updateClassCourse(user, id, body, ctx) {
  const row = store.findById(TABLE, id);
  if (!row) throw fail(CODES.NOT_FOUND, '课程清单记录不存在：' + id);
  assertCanManage(user, row.class_id);
  if (row.status !== 'active') throw fail(CODES.BAD_STATE, '该课程已归档，不可修改（如需恢复请联系管理员）');
  const b = body || {};
  if (b.classId && String(b.classId) !== String(row.class_id)) {
    throw paramError('classId 不可修改（如需换班请归档后重新录入）');
  }
  const before = {
    courseName: row.course_name, teacherName: row.teacher_name, teacherNo: row.teacher_no,
    weekday: row.weekday, section: row.section, place: row.place, hours: row.hours,
    startTime: row.start_time, endTime: row.end_time, term: row.term,
  };
  const changed = [];

  if (b.courseName !== undefined || b.course_name !== undefined) {
    row.course_name = textField('course_name', b.courseName !== undefined ? b.courseName : b.course_name, ctx,
      { label: '课程名称', max: LIMITS.course_name, required: true });
    changed.push('course_name');
  }
  if (b.teacherName !== undefined || b.teacher_name !== undefined) {
    row.teacher_name = textField('teacher_name', b.teacherName !== undefined ? b.teacherName : b.teacher_name, ctx,
      { label: '授课老师', max: LIMITS.teacher_name, required: true });
    changed.push('teacher_name');
  }
  if (b.teacherNo !== undefined || b.teacher_no !== undefined) {
    row.teacher_no = u.cleanText(b.teacherNo !== undefined ? b.teacherNo : b.teacher_no, LIMITS.teacher_no);
    changed.push('teacher_no');
  }
  if (b.place !== undefined) {
    row.place = textField('place', b.place, ctx, { label: '上课地点', max: LIMITS.place });
    changed.push('place');
  }
  if (b.weekday !== undefined) {
    row.weekday = normalizeWeekday(b.weekday);
    changed.push('weekday');
  }
  if (b.section !== undefined) {
    row.section = u.cleanText(b.section, LIMITS.section);
    changed.push('section');
  }
  if (b.hours !== undefined) {
    row.hours = normalizeHours(b.hours, row.hours);
    changed.push('hours');
  }
  if (b.term !== undefined) {
    row.term = u.cleanText(b.term, LIMITS.term) || row.term;
    changed.push('term');
  }
  if (b.startTime !== undefined || b.start_time !== undefined) {
    row.start_time = cleanTime(b.startTime !== undefined ? b.startTime : b.start_time);
    changed.push('start_time');
  }
  if (b.endTime !== undefined || b.end_time !== undefined) {
    row.end_time = cleanTime(b.endTime !== undefined ? b.endTime : b.end_time);
    changed.push('end_time');
  }
  // 节次变了但未显式给时间 → 按内置节次表补全
  if (changed.indexOf('section') >= 0 && changed.indexOf('start_time') < 0 && changed.indexOf('end_time') < 0) {
    const auto = timeOfSection(row.section);
    if (auto[0]) { row.start_time = auto[0]; row.end_time = auto[1]; }
  }

  row.updated_at = u.isoNow();
  store.touch(TABLE);
  audit.log(ctx, 'class_course.update', {
    targetType: 'class_course', targetId: row.id,
    before: before,
    after: {
      courseName: row.course_name, teacherName: row.teacher_name, teacherNo: row.teacher_no,
      weekday: row.weekday, section: row.section, place: row.place, hours: row.hours,
      startTime: row.start_time, endTime: row.end_time, term: row.term,
    },
    detail: '修改课程清单：' + row.course_name + '（字段 ' + (changed.join('、') || '无') + '）',
  });
  return row;
}

/** 软删除：status='archived'（保留历史，不物理删除） */
function archiveClassCourse(user, id, ctx) {
  const row = store.findById(TABLE, id);
  if (!row) throw fail(CODES.NOT_FOUND, '课程清单记录不存在：' + id);
  assertCanManage(user, row.class_id);
  if (row.status === 'archived') throw fail(CODES.BAD_STATE, '该课程已归档，无需重复删除');
  const before = { status: row.status };
  row.status = 'archived';
  row.updated_at = u.isoNow();
  store.touch(TABLE);
  audit.log(ctx, 'class_course.archive', {
    targetType: 'class_course', targetId: row.id,
    before: before, after: { status: 'archived' },
    detail: '归档（软删除）课程清单：' + row.course_name,
  });
  return row;
}

module.exports = {
  TABLE, STATUSES, READ_ROLES, WRITE_ROLES, LIMITS,
  normalizeWeekday, normalizeHours, timeOfSection,
  cadreClassIds, canManageClass, canReadClass,
  queryClassCourses, coursesToday, courseById,
  createClassCourse, updateClassCourse, archiveClassCourse,
};
