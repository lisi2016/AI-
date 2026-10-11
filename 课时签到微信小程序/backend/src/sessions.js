'use strict';
/**
 * 课时会话（业务轻流程核心，新增）
 *
 * 流程：班干部从「班级课程清单」选择/带出本次课 → 允许临时调整（换老师/改时间/改地点，无需审批）
 *      → 出示 60 秒动态二维码 → 任课教师扫码看到本次课时信息 → 点一下「确认」→ status='done'。
 *
 * 设计要点：
 *  · 会话就是 t_period_record 的一行（origin='session'、initiator_id 非空），因此旧接口
 *    /records、/records/{id}/sign、统计、导出、审计全部继续可用，历史数据零迁移；
 *  · 课时不再手写签名：证据 = 动态码 + 确认人 + 确认时间 + 设备/IP（签名接口保留但新流程不需要）；
 *  · 学时按**实际授课人**（teacher_name，有 teacher_id 时优先用 id）归属；
 *  · 确认人姓名 ≠ 实际授课人时置 confirm_name_mismatch=1（代课老师也能确认），后台可筛选提醒；
 *  · 动态码一次性消费；重复确认返回 41002（码已消费）或 42201（会话已确认）。
 */
const u = require('./util');
const store = require('./store');
const audit = require('./audit');
const view = require('./view');
const domain = require('./records');
const courses = require('./classcourses');
const freetext = require('./freetext');
const { CODES, fail, paramError } = require('./errors');

const SESSION_STATUSES = domain.RECORD_STATUSES;
const INITIATOR_ROLES = ['cadre', 'dept_admin', 'admin'];
const CONFIRM_ROLES = ['teacher', 'dept_admin', 'admin'];

// ---------------------------------------------------------------- 小工具
function toBool(v) {
  if (v === true || v === 1) return true;
  return /^(1|true|yes|on)$/i.test(String(v === undefined || v === null ? '' : v));
}

function textField(field, value, ctx, opts) {
  return freetext.checkFreeText(field, value, ctx, Object.assign({ words: view.sensitiveWords() }, opts)).text;
}

/** 动态码响应字段（A 二维码 + B 6 位口令，与 /code/generate 保持一致） */
function codeFields(row) {
  return {
    codeId: row.id,
    code: row.code_value,
    codeLength: String(row.code_value).length,
    qrPayload: row.qr_payload,
    qrUrl: row.qr_payload, // 兼容别名（历史前端读 qrUrl）
    sign: row.signature,
    expireAt: row.expire_at,
    expireAtMs: row.expire_at_ms,
    ttl: Math.max(0, Math.round((Number(row.expire_at_ms) - Date.now()) / 1000)),
  };
}

/**
 * 同一教学班内同名（未归档）课程清单行，用于未传 courseId 时带出默认信息。
 * 多行同名时按「授课人一致 > 星期一致 > 节次一致」打分取最贴近的一条，
 * 避免把同一门课的另一时段当成参照物而误判为「临时调整」。
 * @param opts {weekday, section}
 */
function sameCourseInClass(classId, courseName, teacherName, opts) {
  const o = opts || {};
  const list = store.filter(courses.TABLE, function (r) {
    return String(r.class_id) === String(classId) && r.status === 'active' &&
      u.normalizeName(r.course_name) === u.normalizeName(courseName);
  });
  if (!list.length) return null;
  const scored = list.map(function (r) {
    let score = 0;
    if (u.normalizeName(r.teacher_name) !== u.normalizeName(teacherName)) score += 100;
    if (o.weekday && Number(r.weekday) !== Number(o.weekday)) score += 10;
    if (o.section !== undefined && String(r.section || '') !== String(o.section || '')) score += 5;
    return { row: r, score: score };
  });
  scored.sort(function (a, b) { return a.score - b.score; });
  return scored[0].row;
}

/** 匹配课表任务（无课表也允许发起，匹配不到就返回 null） */
function findTimetableTask(classId, courseName, teacherName, teachDate, section) {
  const wd = u.weekdayOf(teachDate);
  const pool0 = store.filter('course_tasks', function (t) {
    return String(t.class_id) === String(classId) &&
      u.normalizeName(t.course_name) === u.normalizeName(courseName) &&
      (!t.status || t.status === 'active') &&
      domain.taskActiveOn(t, teachDate);
  });
  if (!pool0.length) return null;
  const byTeacher = pool0.filter(function (t) {
    return !teacherName || u.normalizeName(t.teacher_name) === u.normalizeName(teacherName);
  });
  const pool1 = byTeacher.length ? byTeacher : pool0;
  const bySection = pool1.filter(function (t) { return String(t.section || '') === String(section || ''); });
  const pool2 = bySection.length ? bySection : pool1;
  const byWd = pool2.filter(function (t) { return Number(t.weekday) === wd; });
  return (byWd.length ? byWd : pool2)[0] || null;
}

/**
 * 本次课是否「临时调整」：
 *  与课程清单/课表参考信息逐项比对（授课人、节次、地点、学时、星期），任一不符即为临时调整。
 *  本次课不与任何清单/课表对应（例如新开的专题讲座）时不算调整，也**不报错**（不再硬拦截星期）。
 */
function computeIsTempAdjusted(p) {
  const ref = p.course || p.fallbackCourse;
  const wd = u.weekdayOf(p.teachDate);
  if (ref) {
    if (u.normalizeName(ref.course_name) !== u.normalizeName(p.courseName)) return true;
    if (u.normalizeName(ref.teacher_name) !== u.normalizeName(p.teacherName)) return true;
    if (String(ref.section || '') !== String(p.section || '')) return true;
    if (String(ref.place || '') !== String(p.place || '')) return true;
    if (Number(ref.hours || 0) !== Number(p.hours || 0)) return true;
    if (ref.weekday && Number(ref.weekday) !== wd) return true;
    return false;
  }
  const t = p.timetableTask;
  if (t) {
    if (Number(t.weekday) !== wd) return true;
    if (String(t.section || '') !== String(p.section || '')) return true;
    if (t.teacher_name && u.normalizeName(t.teacher_name) !== u.normalizeName(p.teacherName)) return true;
    if (t.place && String(t.place) !== String(p.place || '')) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 发起会话
/**
 * POST /sessions —— 班干部（管理员）为本班发起一次课时
 * 入参：{courseId?, courseName, teacherName, teacherNo?, classId?, teachDate, section?, place?,
 *        hours?, note?, absentCount?, absentNames?, discipline?, summary?}
 * 校验：teachDate 不得为未来；班干部只能为本班发起；文本过敏感词/长度校验；
 *      同 class_id + teach_date + section + teacher_name 不重复（40901）。
 * 兼容：若冲突行是**旧流程遗留的待确认记录**（无 initiator_id），则升级为会话（adopted=true）而不重复建行。
 */
function createSession(user, body, ctx) {
  const b = body || {};
  if (INITIATOR_ROLES.indexOf(user.role) < 0) throw fail(CODES.FORBIDDEN, '仅班干部或管理员可发起课时确认');

  const classId = b.classId || (user.role === 'cadre' ? user.class_id : '');
  if (!classId) throw paramError('classId 必填（班干部默认本班，管理员需显式指定）');
  const cls = store.findById('classes', classId);
  if (!cls) throw fail(CODES.NOT_FOUND, '教学班不存在：' + classId);
  if (!courses.canManageClass(user, classId)) {
    throw fail(CODES.FORBIDDEN, '班干部只能为本班（' + view.className(user.class_id) + '）发起课时确认');
  }

  // 课程清单（可空：清单里没有这门课也允许发起）
  let course = null;
  if (b.courseId) {
    course = store.findById(courses.TABLE, b.courseId);
    if (!course) throw fail(CODES.NOT_FOUND, '课程清单记录不存在：' + b.courseId);
    if (String(course.class_id) !== String(classId)) throw paramError('courseId 不属于该教学班');
    if (course.status !== 'active') throw fail(CODES.BAD_STATE, '该课程已归档，无法发起（请先在课程清单中恢复）');
  }

  const courseName = textField('course_name',
    b.courseName !== undefined ? b.courseName : (course ? course.course_name : ''), ctx,
    { label: '课程名称', max: courses.LIMITS.course_name, required: true });
  const teacherName = textField('teacher_name',
    b.teacherName !== undefined ? b.teacherName : (course ? course.teacher_name : ''), ctx,
    { label: '实际授课人', max: courses.LIMITS.teacher_name, required: true });

  // 日期校验（不得为未来）
  const teachDate = u.cleanText(b.teachDate !== undefined ? b.teachDate
    : (b.date !== undefined ? b.date : b.fullDate), 10) || u.dateOnly();
  if (!u.isValidDate(teachDate)) throw paramError('teachDate 格式应为 YYYY-MM-DD');
  if (u.isFutureDate(teachDate)) throw paramError('teachDate 不得为未来日期（当前 ' + u.dateOnly() + '）');

  // 课程清单带出：未传 courseId 时按「同班同名课程」回退匹配（清单里没有也允许发起）
  const reqSection = b.section !== undefined ? u.cleanText(b.section, courses.LIMITS.section) : '';
  const fallbackCourse = course ? null : sameCourseInClass(classId, courseName, teacherName, {
    weekday: u.weekdayOf(teachDate), section: reqSection,
  });
  const ref = course || fallbackCourse;
  const sectionRaw = reqSection || (ref ? ref.section : '');
  const timetableTask = findTimetableTask(classId, courseName, teacherName, teachDate, sectionRaw);

  // 本次课时信息：显式入参 > 课程清单 > 课表 > 默认
  const section = sectionRaw || (timetableTask ? timetableTask.section : '');
  const place = b.place !== undefined
    ? textField('place', b.place, ctx, { label: '上课地点', max: courses.LIMITS.place })
    : (ref && ref.place ? ref.place : (timetableTask ? timetableTask.place : ''));
  const hours = b.hours !== undefined
    ? courses.normalizeHours(b.hours, ref ? ref.hours : 2)
    : (ref ? Number(ref.hours || 0) : (timetableTask ? Number(timetableTask.hours || 0) : 2));
  const auto = courses.timeOfSection(section);
  const startTime = (ref && ref.start_time) || (timetableTask && timetableTask.start_time) || auto[0] || '';
  const endTime = (ref && ref.end_time) || (timetableTask && timetableTask.end_time) || auto[1] || '';

  const teacher = domain.resolveTeacherByName(teacherName, b.teacherNo);
  const teacherNo = u.cleanText(b.teacherNo !== undefined ? b.teacherNo
    : (ref && ref.teacher_no ? ref.teacher_no : (teacher ? teacher.staff_no : '')), courses.LIMITS.teacher_no);

  // 自由文本合规（与 /records 同一口径）
  const summary = textField('summary', b.summary, ctx, { max: freetext.limitOf('max_summary_len', 'summary') });
  const absentF = textField('absent_names', b.absentNames, ctx, { max: freetext.limitOf('max_absent_names_len', 'absent_names') });
  const note = textField('note', b.note, ctx, { max: freetext.limitOf('max_reason_len', 'note') });
  const discipline = ['good', 'normal', 'bad'].indexOf(b.discipline) >= 0 ? b.discipline : 'good';
  const absentCountRaw = Number(b.absentCount || 0);
  const absentCount = Number.isFinite(absentCountRaw) && absentCountRaw >= 0 ? Math.floor(absentCountRaw) : 0;

  // 唯一性：同 教学班 + 日期 + 节次 + 实际授课人 只允许一条非 revoked
  const conflict = domain.findSessionConflict({
    class_id: classId, teach_date: teachDate, section: section, teacher_name: teacherName,
  });
  let adopted = false;
  if (conflict) {
    if (domain.isSessionRow(conflict)) {
      throw fail(CODES.DUP_RECORD,
        '该课时已由班干部发起（会话 ' + conflict.id + '，状态 ' + conflict.status + '），请勿重复发起',
        { existingId: conflict.id, existingSessionId: conflict.id, existingStatus: conflict.status });
    }
    if (conflict.status !== 'wait') {
      throw fail(CODES.DUP_RECORD,
        '该教学班同一日期/节次/授课人已有课时记录（' + conflict.id + '，状态 ' + conflict.status + '）',
        { existingId: conflict.id, existingStatus: conflict.status });
    }
    // 旧流程（教师发起 → 班干部签名）遗留的待确认记录：同一节课升级为会话，不重复建行
    adopted = true;
  }

  const isTempAdjusted = computeIsTempAdjusted({
    course: course, fallbackCourse: fallbackCourse, timetableTask: timetableTask,
    courseName: courseName, teacherName: teacherName, section: section, place: place,
    hours: hours, teachDate: teachDate,
  }) || toBool(b.isTempAdjusted);

  const duty = view.cadreDutyOf(user.id, classId) || user.duty || '';
  const now = u.isoNow();
  const term = u.cleanText(b.term, courses.LIMITS.term) || (ref && ref.term) || view.configMap().term || u.TERM_DEFAULT;
  let row;

  if (adopted) {
    row = conflict;
    row.origin = 'session';
    row.course_id = course ? course.id : null;
    row.course_code = course && course.course_code ? course.course_code : (timetableTask ? timetableTask.course_code : (row.course_code || ''));
    row.course_name = courseName;
    row.task_id = row.task_id || (timetableTask ? timetableTask.id : '');
    if (teacher) row.teacher_id = teacher.id;
    row.teacher_name = teacherName;
    row.teacher_no = teacherNo;
    row.class_id = classId;
    row.class_name = cls.name || row.class_name;
    row.dept_id = cls.dept_id || row.dept_id;
    row.term = term;
    row.section = section;
    row.start_time = startTime;
    row.end_time = endTime;
    row.place = place;
    row.hours = hours;
    row.is_temp_adjusted = isTempAdjusted ? 1 : 0;
    row.initiator_id = user.id;
    row.initiator_name = user.real_name;
    row.initiator_duty = duty;
    // 会话由班干部发起，签字人字段同步为发起人（旧接口 /records 仍按 signer_id 可见）
    row.signer_id = user.id;
    row.signer_name = user.real_name;
    row.signer_duty = duty;
    row.signer_is_adhoc = 0;
    if (summary) row.summary = summary;
    if (note) row.note = note;
    if (absentF) row.absent_names = absentF;
    row.absent_count = absentCount;
    row.discipline = discipline;
    // 历史课时的旧截止时间已过期会让会话立即被定时任务置 expired，这里按新口径收敛
    if (teachDate !== u.dateOnly()) row.deadline_at = null;
    row.updated_at = now;
    store.touch('period_records');
    audit.log(ctx, 'session.adopt', {
      targetType: 'period_record', targetId: row.id,
      before: { origin: '', initiatorId: '', status: row.status },
      after: { origin: 'session', initiatorId: user.id, teacherName: teacherName, isTempAdjusted: isTempAdjusted },
      detail: '将旧流程遗留的待确认记录升级为课时会话（同一节课，不重复建立）',
    });
  } else {
    row = store.insert('period_records', {
      id: store.newId('R'),
      task_id: timetableTask ? timetableTask.id : '',
      origin: 'session',
      course_id: course ? course.id : null,
      teacher_id: teacher ? teacher.id : '',
      teacher_name: teacherName,
      teacher_no: teacherNo,
      course_code: course && course.course_code ? course.course_code : (timetableTask ? timetableTask.course_code : ''),
      course_name: courseName,
      class_id: classId,
      class_name: cls.name || view.className(classId),
      dept_id: cls.dept_id || null,
      term: term,
      teach_date: teachDate,
      section: section,
      start_time: startTime,
      end_time: endTime,
      place: place,
      hours: hours,
      coef: '1.0',
      status: 'wait',
      is_temp_adjusted: isTempAdjusted ? 1 : 0,
      initiator_id: user.id,
      initiator_name: user.real_name,
      initiator_duty: duty,
      absent_count: absentCount,
      absent_names: absentF,
      discipline: discipline,
      summary: summary,
      signer_id: user.id,
      signer_name: user.real_name,
      signer_duty: duty,
      signer_is_adhoc: 0,
      confirmed_by: '',
      confirmed_name: '',
      confirmed_at: null,
      confirmed_role: '',
      confirm_name_mismatch: 0,
      code_id: '',
      // 确认时限：当天发起的课时沿用「当天 24 点」；补录历史课时（teachDate < 今天）不设时限，
      // 避免被每日 00:05 的过期任务直接置 expired 而无法再确认（新流程已取消补签/审批）。
      deadline_at: teachDate === u.dateOnly()
        ? u.deadlineOf(teachDate, view.configNum('confirm_deadline_hour'))
        : null,
      makeup_id: null,
      appeal_id: null,
      note: note,
      created_by: user.id,
      created_at: now,
      updated_at: now,
    });
  }

  if (absentF) domain.matchAbsents(row, absentF);

  // 动态码（60 秒，A 二维码 + B 6 位口令），与会话绑定
  const codeRow = domain.generateCode(user, { ttl: b.ttl, classId: classId, sessionId: row.id });
  row.code_id = codeRow.id;
  row.updated_at = u.isoNow();
  store.touch('period_records');

  audit.log(ctx, 'session.create', {
    targetType: 'period_record', targetId: row.id,
    after: {
      status: 'wait', classId: classId, courseName: courseName, teacherName: teacherName,
      section: section, teachDate: teachDate, hours: hours, isTempAdjusted: isTempAdjusted,
      courseId: course ? course.id : '', adopted: adopted,
      codeId: codeRow.id, passCode: codeRow.code_value, expireAt: codeRow.expire_at,
    },
    detail: (adopted ? '升级旧记录为课时会话并签发动态码' : '班干部发起课时会话并签发动态码') +
      (isTempAdjusted ? '（含临时调整）' : ''),
  });

  return { session: row, code: codeRow, adopted: adopted };
}

// ---------------------------------------------------------------- 重新生成动态码
/** POST /sessions/{id}/code —— 会话仍待确认时刷新动态码（二维码过期后重出） */
function refreshCode(user, sessionId, body, ctx) {
  const row = getSessionRow(sessionId);
  const b = body || {};
  if (!canManageSession(user, row)) throw fail(CODES.FORBIDDEN, '无权为该课时刷新动态码');
  if (row.status !== 'wait') {
    throw fail(CODES.BAD_STATE, '当前状态为「' + row.status + '」，仅「待教师确认」的课时可刷新动态码');
  }
  const codeRow = domain.generateCode(user, {
    ttl: b.ttl, classId: row.class_id || user.class_id, sessionId: row.id,
  });
  row.code_id = codeRow.id;
  row.updated_at = u.isoNow();
  store.touch('period_records');
  audit.log(ctx, 'session.code.refresh', {
    targetType: 'period_record', targetId: row.id,
    after: { codeId: codeRow.id, passCode: codeRow.code_value, expireAt: codeRow.expire_at },
    detail: '刷新课时动态码（旧码仍按其自身 60 秒有效期失效）',
  });
  return { session: row, code: codeRow };
}

// ---------------------------------------------------------------- 权限
function getSessionRow(sessionId) {
  const row = store.findById('period_records', sessionId);
  if (!row) throw fail(CODES.NOT_FOUND, '课时会话不存在：' + sessionId);
  if (!domain.isSessionRow(row)) throw fail(CODES.NOT_FOUND, '该 ID 不是课时会话（班干部发起的课时）');
  return row;
}

/** 班干部侧：本人发起 / 本班 active 班干部（协作） / 本院系管理员 / 教务处 */
function canManageSession(user, row) {
  if (user.role === 'admin') return true;
  if (user.role === 'dept_admin') return !!(user.dept_id && row.dept_id && String(row.dept_id) === String(user.dept_id));
  if (user.role === 'cadre') {
    if (String(row.initiator_id || '') === String(user.id)) return true;
    return view.isActiveCadreOf(user.id, row.class_id) || String(row.class_id) === String(user.class_id);
  }
  return false;
}

/** 会话详情可见性（教师：实际授课人 / 确认人 / 仍待确认时可见） */
function canReadSession(user, row) {
  if (user.role === 'admin') return true;
  if (user.role === 'dept_admin') return !!(user.dept_id && row.dept_id && String(row.dept_id) === String(user.dept_id));
  if (user.role === 'teacher') {
    return domain.isActualTeacher(row, user) ||
      String(row.confirmed_by || '') === String(user.id) ||
      row.status === 'wait';
  }
  if (user.role === 'cadre') {
    return canManageSession(user, row);
  }
  return false;
}

// ---------------------------------------------------------------- 查询
/**
 * 课时会话列表（按角色限定范围）
 *  · 班干部：本班（本人所在班 + 被授权教学班）
 *  · 教师：本人为实际授课人，或本人确认过
 *  · 院系管理员：本院系；教务处：全部
 * @param opts {ignoreStatus} 忽略 status 过滤（角标口径用）
 */
function querySessions(user, query, opts) {
  const o = opts || {};
  const q = query || {};
  let list = store.all('period_records').filter(domain.isSessionRow);

  if (user.role === 'cadre') {
    const ids = courses.cadreClassIds(user);
    list = list.filter(function (r) { return ids.indexOf(String(r.class_id)) >= 0; });
  } else if (user.role === 'teacher') {
    list = list.filter(function (r) {
      return domain.isActualTeacher(r, user) || String(r.confirmed_by || '') === String(user.id);
    });
  } else if (user.role === 'dept_admin') {
    if (user.dept_id) list = list.filter(function (r) { return String(r.dept_id) === String(user.dept_id); });
  } else if (user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN, '无权查看课时会话');
  }

  if (q.status && !o.ignoreStatus) {
    const statuses = String(q.status).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (statuses.length) list = list.filter(function (r) { return statuses.indexOf(r.status) >= 0; });
  }
  if (q.date) list = list.filter(function (r) { return String(r.teach_date) === String(q.date); });
  if (q.from) list = list.filter(function (r) { return String(r.teach_date) >= String(q.from); });
  if (q.to) list = list.filter(function (r) { return String(r.teach_date) <= String(q.to); });
  if (q.classId) list = list.filter(function (r) { return String(r.class_id) === String(q.classId); });
  if (q.courseId) list = list.filter(function (r) { return String(r.course_id || '') === String(q.courseId); });
  if (q.teacherId) list = list.filter(function (r) { return String(r.teacher_id || '') === String(q.teacherId); });
  if (q.term) list = list.filter(function (r) { return String(r.term) === String(q.term); });
  if (q.teacherName) {
    const kw = String(q.teacherName);
    list = list.filter(function (r) { return String(r.teacher_name || '').indexOf(kw) >= 0; });
  }
  if (q.courseName) {
    const kw = String(q.courseName);
    list = list.filter(function (r) { return String(r.course_name || '').indexOf(kw) >= 0; });
  }
  if (toBool(q.tempAdjusted)) list = list.filter(function (r) { return Number(r.is_temp_adjusted || 0) === 1; });
  if (toBool(q.nameMismatch)) list = list.filter(function (r) { return Number(r.confirm_name_mismatch || 0) === 1; });
  if (q.keyword) {
    const kw = String(q.keyword);
    list = list.filter(function (r) {
      return String(r.course_name || '').indexOf(kw) >= 0 ||
        String(r.class_name || '').indexOf(kw) >= 0 ||
        String(r.teacher_name || '').indexOf(kw) >= 0 ||
        String(r.initiator_name || '').indexOf(kw) >= 0 ||
        String(r.confirmed_name || '').indexOf(kw) >= 0;
    });
  }

  if (!o.skipSort) {
    list.sort(function (a, b) {
      if (a.teach_date === b.teach_date) return String(b.created_at).localeCompare(String(a.created_at));
      return String(b.teach_date).localeCompare(String(a.teach_date));
    });
  }
  return list;
}

/** 会话各状态数量（不受 status= 影响，供前端角标） */
function statusTotals(user, query) {
  const scoped = querySessions(user, query, { ignoreStatus: true, skipSort: true });
  const out = {};
  SESSION_STATUSES.forEach(function (s) { out[s] = 0; });
  scoped.forEach(function (r) {
    const s = String(r.status || '');
    out[s] = Number(out[s] || 0) + 1;
  });
  return out;
}

function sessionById(user, sessionId) {
  const row = getSessionRow(sessionId);
  if (!canReadSession(user, row)) throw fail(CODES.FORBIDDEN, '无权查看该课时会话');
  return row;
}

// ---------------------------------------------------------------- 教师确认
/** 该会话当前仍有效的最新动态码（未消费且未过期） */
function latestActiveCodeOf(sessionId) {
  const now = Date.now();
  const list = store.filter('codes', function (c) {
    return String(c.session_id || '') === String(sessionId) &&
      Number(c.used) !== 1 && Number(c.expire_at_ms || 0) > now;
  });
  list.sort(function (a, b) { return Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0); });
  return list[0] || null;
}

/**
 * POST /sessions/{id}/confirm —— 任课教师扫码后点「确认」
 *  · 记录 confirmed_by / confirmed_name / confirmed_at / confirmed_role（+ 设备 / IP）
 *  · 同时消费该动态码（一次性）：码已用 → 41002；码过期 → 41001；码属于别的会话 → 40001
 *  · 确认人姓名 ≠ 实际授课人 → confirm_name_mismatch=1，**仍然成功**（代课老师也能确认）
 *  · 成功后 status='done'，写审计（审计哈希链不中断）
 *  · 重复确认：带码 → 41002；不带码且已确认 → 42201
 */
function confirmSession(user, sessionId, body, ctx) {
  const b = body || {};
  if (CONFIRM_ROLES.indexOf(user.role) < 0) throw fail(CODES.FORBIDDEN, '仅任课教师（或管理员）可确认课时');
  const session = getSessionRow(sessionId);
  if (user.role === 'dept_admin' && session.dept_id && String(session.dept_id) !== String(user.dept_id)) {
    throw fail(CODES.FORBIDDEN, '只能确认本院系的课时');
  }

  // 1) 动态码核验（传了就必须有效且属于本会话；未传则默认消费该会话最新有效码）
  const hasRef = !!(b.codeId || b.code || b.qrContent || b.qrText);
  let codeRow = null;
  if (hasRef) {
    const ref = domain.resolveCodeRef(b);
    if (!ref.codeId) {
      if (ref.by === 'code') throw fail(CODES.NOT_FOUND, '口令不存在或已失效：' + (ref.passCode || ''));
      if (ref.by === 'qrContent') {
        throw fail(CODES.NOT_FOUND, ref.invalid
          ? '扫码内容无法识别，请确认扫描的是本次课时的动态二维码'
          : '二维码对应的动态码不存在或已失效');
      }
      throw paramError('codeId 必填（也可传 code 6 位口令 或 qrContent 扫码内容）');
    }
    codeRow = domain.findCode(ref.codeId);
    if (!codeRow) throw fail(CODES.NOT_FOUND, '动态码不存在：' + ref.codeId);
    // 过期 41001 / 已消费 41002（由 domain.checkCode 统一处理，签名与有效期一并校验）
    domain.checkCode(ref.codeId);
    if (String(codeRow.session_id || '') !== String(session.id)) {
      throw paramError('动态码与本次课时不匹配（该码属于其它课时会话）');
    }
  } else {
    codeRow = latestActiveCodeOf(session.id);
  }

  // 2) 状态机：仅 wait → done
  if (session.status !== 'wait') {
    throw fail(CODES.BAD_STATE,
      '该课时当前状态为「' + session.status + '」，无需重复确认' +
      (session.confirmed_name ? '（已由 ' + session.confirmed_name + ' 于 ' + session.confirmed_at + ' 确认）' : ''));
  }

  // 3) 消费动态码（一次性）
  if (codeRow) domain.consumeCode(codeRow, user, session.id);

  const now = u.isoNow();
  const sameName = u.normalizeName(user.real_name) === u.normalizeName(session.teacher_name) ||
    (!!session.teacher_no && !!user.staff_no && String(session.teacher_no) === String(user.staff_no));
  session.confirmed_by = user.id;
  session.confirmed_name = user.real_name;
  session.confirmed_at = now;
  session.confirmed_role = user.role;
  session.confirm_ip = ctx ? (ctx.ip || '') : '';
  session.confirm_device = ctx ? String(ctx.device || '').slice(0, 200) : '';
  session.confirm_name_mismatch = sameName ? 0 : 1;
  // 姓名一致且尚未确定 teacher_id 时补齐（保证后续按 id 归属；代课时绝不顶替实际授课人）
  if (sameName && !session.teacher_id) session.teacher_id = user.id;
  if (sameName && !session.teacher_no && user.staff_no) session.teacher_no = user.staff_no;
  const before = { status: 'wait' };
  session.status = 'done';
  session.updated_at = now;
  store.touch('period_records');

  audit.log(ctx, 'session.confirm', {
    targetType: 'period_record', targetId: session.id,
    before: before,
    after: {
      status: 'done', confirmedBy: user.id, confirmedName: user.real_name, confirmedRole: user.role,
      teachDate: session.teach_date, teacherName: session.teacher_name,
      nameMismatch: session.confirm_name_mismatch === 1,
      codeId: codeRow ? codeRow.id : '', ip: session.confirm_ip, device: session.confirm_device,
    },
    detail: '任课教师扫码确认本次课时' +
      (session.confirm_name_mismatch === 1 ? '（确认人「' + user.real_name + '」≠ 实际授课人「' + session.teacher_name + '」，已标记待提醒）' : ''),
  });

  return {
    session: session,
    nameMismatch: session.confirm_name_mismatch === 1,
    codeConsumed: codeRow ? codeRow.id : '',
    codePassCode: codeRow ? codeRow.code_value : '',
  };
}

module.exports = {
  SESSION_STATUSES, INITIATOR_ROLES, CONFIRM_ROLES,
  codeFields, sameCourseInClass, findTimetableTask, computeIsTempAdjusted,
  createSession, refreshCode, querySessions, statusTotals, sessionById, getSessionRow,
  canManageSession, canReadSession, latestActiveCodeOf, confirmSession,
};
