'use strict';
/**
 * 视图层：数据库行 → 前端所需的驼峰字段（与 miniprogram/utils/mock.js、store.js 对齐）
 * 契约第五节「字段映射」在这里落地
 */
const u = require('./util');
const store = require('./store');
const textfilter = require('./textfilter');

const STATUS_TEXT = {
  draft: '未发起',
  wait: '待确认',
  done: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  appealing: '申诉中',
  makeup: '已补签',
  revoked: '已撤销',
};

const DISCIPLINE_TEXT = { good: '好', normal: '一般', bad: '差' };

/** 课时会话（班干部发起 → 教师确认）状态文案 */
const SESSION_STATUS_TEXT = {
  draft: '未发起',
  wait: '待教师确认',
  done: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  appealing: '申诉中',
  makeup: '已补签',
  revoked: '已撤销',
};

/** 课程清单状态文案 */
const COURSE_STATUS_TEXT = { active: '使用中', archived: '已归档' };

// ---------------------------------------------------------------- 配置
const CONFIG_CACHE_MS = 1000;
let configCache = null;
let configCacheAt = 0;

function configMap(force) {
  const now = Date.now();
  if (!force && configCache && now - configCacheAt < CONFIG_CACHE_MS) return configCache;
  const map = Object.assign({}, u.DEFAULT_CONFIG);
  store.all('configs').forEach(function (c) { map[String(c.key)] = String(c.value); });
  // 历史键名兼容：旧库里的 max_summary_length 在新键未显式配置时继续生效
  Object.keys(u.CONFIG_ALIAS || {}).forEach(function (oldKey) {
    const newKey = u.CONFIG_ALIAS[oldKey];
    const stored = store.all('configs').some(function (c) { return String(c.key) === newKey; });
    if (!stored && map[oldKey] !== undefined) map[newKey] = String(map[oldKey]);
  });
  configCache = map;
  configCacheAt = now;
  return map;
}

/** 敏感词表配置键（自由文本合规） */
const SENSITIVE_WORDS_KEY = 'sensitive_words';
/** 旧版本内置的默认词表：仅当库中仍是这个值时才认为「未被管理员自定义」 */
const LEGACY_SENSITIVE_WORDS = '代签,作弊,包过,黄牛';

/**
 * 配置迁移（启动时调用一次）：
 *  1) 旧键 → 新键（如 max_summary_length → max_summary_len），仅当新键尚未配置；
 *  2) 敏感词表仍停留在旧内置默认值（4 个词）时，升级为新的内置通用中文敏感词表。
 * 管理员显式改过的值一律不动。
 * @returns {string[]} 迁移动作描述（空数组表示无需迁移）
 */
function migrateLegacyConfig(operatorId) {
  const op = operatorId || 'system';
  const changed = [];
  Object.keys(u.CONFIG_ALIAS || {}).forEach(function (oldKey) {
    const newKey = u.CONFIG_ALIAS[oldKey];
    const oldRow = store.find('configs', function (c) { return String(c.key) === oldKey; });
    if (!oldRow) return;
    const hasNew = store.find('configs', function (c) { return String(c.key) === newKey; });
    if (hasNew) return;
    setConfig(newKey, oldRow.value, op);
    changed.push(oldKey + ' → ' + newKey + '（' + oldRow.value + '）');
  });
  const wordsRow = store.find('configs', function (c) { return String(c.key) === SENSITIVE_WORDS_KEY; });
  if (wordsRow && String(wordsRow.value).trim() === LEGACY_SENSITIVE_WORDS) {
    setConfig(SENSITIVE_WORDS_KEY, textfilter.DEFAULT_SENSITIVE_WORDS.join(','), op);
    changed.push(SENSITIVE_WORDS_KEY + ' → 内置通用词表（' + textfilter.DEFAULT_SENSITIVE_WORDS.length + ' 条）');
  }
  return changed;
}

function configNum(key) {
  const v = Number(configMap()[key]);
  return Number.isFinite(v) ? v : Number(u.DEFAULT_CONFIG[key]);
}

/**
 * 自由文本长度上限（契约六.6）：优先取 /config 配置值，非法/缺失时回退内置默认
 * @param key t_config 的 key（如 max_summary_len）
 * @param dflt 兜底默认值
 */
function configLimit(key, dflt) {
  const n = Number(configMap()[key]);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return dflt;
}

function setConfig(key, value, operatorId) {
  const row = store.find('configs', function (c) { return String(c.key) === String(key); });
  const now = u.isoNow();
  if (row) {
    row.value = String(value);
    row.updated_by = String(operatorId || '');
    row.updated_at = now;
    store.touch('configs');
  } else {
    store.insert('configs', {
      id: store.newId('CFG'), key: String(key), value: String(value),
      updated_by: String(operatorId || ''), updated_at: now,
    });
  }
  configMap(true);
}

/** 当前生效的敏感词表（逗号/顿号/空白分隔，可由 /config 覆盖；空串表示不启用过滤） */
function sensitiveWords() {
  const raw = configMap().sensitive_words;
  if (raw === undefined || raw === null) return textfilter.DEFAULT_SENSITIVE_WORDS.slice();
  return textfilter.parseWords(raw);
}

// ---------------------------------------------------------------- 基础查询
function userById(id) { return store.findById('users', id); }
function userName(id) { const x = userById(id); return x ? x.real_name : ''; }
function deptName(id) { const x = store.findById('depts', id); return x ? x.name : ''; }
function className(id) { const x = store.findById('classes', id); return x ? x.name : ''; }

/** 教学班 active 班干部授权（priority 升序，学委在前） */
function activeCadres(classId) {
  const list = store.filter('class_cadres', function (r) {
    return String(r.class_id) === String(classId) && r.status === 'active';
  });
  list.sort(function (a, b) { return Number(a.priority || 99) - Number(b.priority || 99); });
  return list;
}

/** 默认签字人（priority 最小） */
function primaryCadre(classId) {
  const list = activeCadres(classId);
  return list.length ? userById(list[0].user_id) : null;
}

/** 某用户是否为该教学班 active 班干部 */
function isActiveCadreOf(userId, classId) {
  return activeCadres(classId).some(function (r) { return String(r.user_id) === String(userId); });
}

function cadreDutyOf(userId, classId) {
  const hit = activeCadres(classId).find(function (r) { return String(r.user_id) === String(userId); });
  if (hit) return hit.duty;
  const user = userById(userId);
  return user && user.duty ? user.duty : '';
}

function studentOf(classId) {
  return store.filter('students', function (s) { return String(s.class_id) === String(classId); });
}

function signatureOf(recordId) {
  return store.find('signatures', function (s) { return String(s.record_id) === String(recordId); });
}

// ---------------------------------------------------------------- 用户视图
function shapeUser(user, extra) {
  if (!user) return null;
  const cadreClassIds = store.filter('class_cadres', function (r) {
    return String(r.user_id) === String(user.id) && r.status === 'active';
  }).map(function (r) { return String(r.class_id); });

  const out = {
    id: user.id,
    role: user.role,
    name: user.real_name,
    realName: user.real_name,
    staffId: user.staff_no || '',
    studentId: user.student_no || '',
    no: user.staff_no || user.student_no || '',
    dept: deptName(user.dept_id),
    deptId: user.dept_id || null,
    className: className(user.class_id),
    classId: user.class_id || null,
    phone: user.phone || '',
    duty: user.duty || cadreDutyOf(user.id, user.class_id),
    status: user.status,
    // 班干部被授权的教学班（契约 三.A /auth/me 要求返回授权班级）
    authorizedClassIds: cadreClassIds,
    authorizedClasses: cadreClassIds.map(function (id) {
      return { id: id, name: className(id) };
    }),
  };
  return Object.assign(out, extra || {});
}

// ---------------------------------------------------------------- 记录视图
/** 签名证据固定四项（契约 D 组）：签名图 / 确认时间 / 设备 / 动态码 —— 前端据此渲染，不含位置 */
const EVIDENCE_LABELS = ['签名图', '确认时间', '设备', '动态码'];

/**
 * 组装签名证据（四项）
 * @param record 课时记录行
 * @param sig t_signature 行（可空）
 */
function shapeEvidence(record, sig) {
  const s = sig || null;
  const sigImg = s && s.image_url ? s : null;
  return {
    count: EVIDENCE_LABELS.length,
    labels: EVIDENCE_LABELS.slice(),
    // ① 签名图
    signatureUrl: sigImg ? '/api/v1/files/' + sigImg.id : '',
    signatureFileId: sigImg ? sigImg.id : '',
    imageHash: sigImg ? sigImg.image_hash : '',
    signedAt: sigImg ? sigImg.signed_at : '',
    // ② 确认时间
    confirmedAt: record ? record.confirmed_at || '' : '',
    // ③ 设备
    device: s ? s.device_info || '' : '',
    // ④ 动态码
    codeId: record ? record.code_id || '' : '',
    ip: sigImg ? sigImg.ip : '',
  };
}

/**
 * 课时记录 → 前端视图（驼峰，字段名与 mock.js/store.js 一致）
 * @param row 记录行
 * @param opts {viewer} 当前用户，用于附加 canSign/canReject/canRevoke 等按钮状态
 *
 * 注意：本系统不采集定位/位置信息（已彻底移除），签名证据固定为四项
 * 「签名图 / 确认时间 / 设备 / 动态码」，因此响应中不再出现 location / latitude /
 * longitude / locationDenied 字段（t_signature 表仍保留这些列以兼容历史数据）。
 */
function shapeRecord(row, opts) {
  if (!row) return null;
  const o = opts || {};
  const viewer = o.viewer || null;
  const sig = o.signature !== undefined ? o.signature : signatureOf(row.id);
  // 只有真正上传过签名图（image_url 非空）才算有签名证据
  const sigImg = sig && sig.image_url ? sig : null;
  const deadline = row.deadline_at || '';
  const isForMe = !!(viewer && String(row.signer_id) === String(viewer.id));
  const isOwner = !!(viewer && String(row.teacher_id) === String(viewer.id));
  const isAdmin = !!(viewer && (viewer.role === 'admin'));
  const isDeptAdmin = !!(viewer && viewer.role === 'dept_admin');
  const hours = Number(row.hours || 0);
  const counted = row.status === 'done' || row.status === 'makeup';

  return {
    id: row.id,
    taskId: row.task_id || '',
    // 展示字段
    courseName: row.course_name || '',
    courseCode: row.course_code || '',
    className: row.class_name || className(row.class_id),
    classId: row.class_id || null,
    deptId: row.dept_id || null,
    deptName: deptName(row.dept_id),
    term: row.term || '',
    teacherId: row.teacher_id || '',
    teacherName: row.teacher_name || userName(row.teacher_id),
    teacherNo: row.teacher_no || '',
    date: shortDate(row.teach_date),
    fullDate: row.teach_date,
    teachDate: row.teach_date,
    section: row.section || '',
    time: (row.start_time || '') + '–' + (row.end_time || ''),
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    place: row.place || '',
    hours: hours,
    // 状态
    status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status,
    counted: counted,
    // 授课信息
    absentCount: Number(row.absent_count || 0),
    absentNames: row.absent_names || '',
    discipline: row.discipline || 'good',
    disciplineText: DISCIPLINE_TEXT[row.discipline] || '',
    summary: row.summary || '',
    note: row.note || '',
    // 签字人
    signerId: row.signer_id || '',
    signerName: row.signer_name || '',
    signerDuty: row.signer_duty || '',
    signerIsAdHoc: Number(row.signer_is_adhoc || 0) === 1,
    signature: sigImg ? '/api/v1/files/' + sigImg.id : '',
    signatureFileId: sigImg ? sigImg.id : '',
    signatureUrl: sigImg ? '/api/v1/files/' + sigImg.id : '',
    signatureHash: sigImg ? sigImg.image_hash : '',
    signedAt: sigImg ? sigImg.signed_at : '',
    confirmedAt: row.confirmed_at || '',
    confirmer: row.confirmed_at ? ((row.signer_duty || '') + ' ' + (row.signer_name || '')).trim() : '',
    // 证据四项（契约 D 组：签名图 / 确认时间 / 设备 / 动态码）—— 不再包含任何位置信息
    device: sig ? sig.device_info || '' : '',
    codeId: row.code_id || '',
    // 时限与关联（统一输出 Asia/Shanghai ISO8601，兼容历史 UTC 标记数据）
    deadline: deadline ? u.isoNow(deadline) : '',
    deadlineAt: deadline ? u.isoNow(deadline) : '',
    deadlineText: deadline ? u.isoNow(deadline).slice(0, 16).replace('T', ' ') : '',
    imageHash: sig ? sig.image_hash : '',
    makeupId: row.makeup_id || null,
    appealId: row.appeal_id || null,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    // 新增：课时会话（班干部发起 + 教师确认）扩展字段，旧客户端可忽略
    origin: row.origin || '',
    sessionId: row.origin === 'session' || row.initiator_id ? row.id : '',
    courseId: row.course_id || '',
    initiatorId: row.initiator_id || '',
    initiatorName: row.initiator_name || userName(row.initiator_id),
    initiatorDuty: row.initiator_duty || '',
    isTempAdjusted: Number(row.is_temp_adjusted || 0) === 1,
    confirmedBy: row.confirmed_by || '',
    confirmedName: row.confirmed_name || '',
    confirmedRole: row.confirmed_role || '',
    confirmNameMismatch: Number(row.confirm_name_mismatch || 0) === 1,
    // 按钮状态
    canSign: !!(viewer && viewer.role === 'cadre' && row.status === 'wait' && isForMe),
    canReject: !!(viewer && viewer.role === 'cadre' && row.status === 'wait' && isForMe),
    canRevoke: !!(viewer && (isAdmin || (isOwner && ['wait', 'rejected', 'expired', 'done', 'appealing'].indexOf(row.status) >= 0))),
    canUrge: !!(viewer && isOwner && row.status === 'wait'),
    canMakeup: !!(viewer && isOwner && ['expired', 'rejected'].indexOf(row.status) >= 0),
    canAppeal: !!(viewer && isOwner && row.status === 'rejected'),
    canAdhocReview: !!(row.signer_is_adhoc && (isAdmin || isDeptAdmin)),
  };
}

function shortDate(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr);
  return s.length >= 10 ? s.slice(5, 10) : s;
}

// ---------------------------------------------------------------- 教学班视图
/**
 * 教学班（t_class）→ 前端视图（驼峰）
 * 供管理后台「新增班级课程清单」下拉选择：id/classId 即 `POST /class-courses` 要传的 classId。
 * @param row data/classes.json 的一行
 * @param counts {cadreCount, studentCount}（可空，默认 0）
 */
function shapeClass(row, counts) {
  if (!row) return null;
  const c = counts || {};
  return {
    id: row.id,
    classId: row.id,
    name: row.name || '',
    className: row.name || '',
    grade: row.grade || '',
    deptId: row.dept_id || null,
    deptName: deptName(row.dept_id),
    advisor: row.advisor || '',
    status: row.status || 'active',
    cadreCount: Number(c.cadreCount || 0),
    studentCount: Number(c.studentCount || 0),
  };
}

// ---------------------------------------------------------------- 班级课程清单视图
/**
 * 班级课程清单 → 前端视图（驼峰）
 * @param row data/class_courses.json 的一行
 */
function shapeClassCourse(row) {
  if (!row) return null;
  const wd = row.weekday === undefined || row.weekday === null || row.weekday === '' ? null : Number(row.weekday);
  return {
    id: row.id,
    classCourseId: row.id,
    classId: row.class_id || null,
    className: row.class_name || className(row.class_id),
    deptId: row.dept_id || null,
    deptName: deptName(row.dept_id),
    courseName: row.course_name || '',
    teacherName: row.teacher_name || '',
    teacherNo: row.teacher_no || '',
    weekday: wd,
    weekdayText: wd ? (u.WEEKDAY_CN[wd] || '') : '',
    section: row.section || '',
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    time: (row.start_time || '') + '–' + (row.end_time || ''),
    place: row.place || '',
    hours: Number(row.hours || 0),
    term: row.term || '',
    status: row.status || 'active',
    statusText: COURSE_STATUS_TEXT[row.status] || row.status || '',
    archived: row.status === 'archived',
    createdBy: row.created_by || '',
    createdByName: userName(row.created_by),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

// ---------------------------------------------------------------- 课时会话视图
/**
 * 课时会话 → 前端视图（教师扫码后看到「要确认哪节课」）
 * 会话同样是 t_period_record 的一行（origin='session' + initiator_id 非空），
 * 因此旧接口 /records 依然能读到它，只是这里给出更贴合新流程的字段与按钮状态。
 */
function shapeSession(row, opts) {
  if (!row) return null;
  const o = opts || {};
  const viewer = o.viewer || null;
  const hours = Number(row.hours || 0);
  const counted = row.status === 'done' || row.status === 'makeup';
  const isWait = row.status === 'wait';
  const canRefreshCode = !!(viewer && isWait && (
    String(row.initiator_id || '') === String(viewer.id) ||
    (viewer.role === 'cadre' && isActiveCadreOf(viewer.id, row.class_id)) ||
    viewer.role === 'admin' ||
    (viewer.role === 'dept_admin' && row.dept_id && String(row.dept_id) === String(viewer.dept_id))
  ));
  return {
    // 会话本体
    sessionId: row.id,
    id: row.id,
    origin: row.origin || 'session',
    term: row.term || '',
    // 课程与教学班
    courseId: row.course_id || '',
    courseCode: row.course_code || '',
    courseName: row.course_name || '',
    classId: row.class_id || null,
    className: row.class_name || className(row.class_id),
    deptId: row.dept_id || null,
    deptName: deptName(row.dept_id),
    // 实际授课人（学时按此人统计）
    teacherId: row.teacher_id || '',
    teacherName: row.teacher_name || userName(row.teacher_id),
    teacherNo: row.teacher_no || '',
    // 本次课时信息
    teachDate: row.teach_date || '',
    fullDate: row.teach_date || '',
    date: shortDate(row.teach_date),
    section: row.section || '',
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    time: (row.start_time || '') + '–' + (row.end_time || ''),
    place: row.place || '',
    hours: hours,
    // 发起人（班干部）
    initiatorId: row.initiator_id || row.created_by || '',
    initiatorName: row.initiator_name || userName(row.initiator_id || row.created_by),
    initiatorDuty: row.initiator_duty || '',
    // 临时调整
    isTempAdjusted: Number(row.is_temp_adjusted || 0) === 1,
    // 状态
    status: row.status,
    statusText: SESSION_STATUS_TEXT[row.status] || row.status,
    counted: counted,
    // 教师确认信息（设备/IP 留痕）
    confirmedBy: row.confirmed_by || '',
    confirmedName: row.confirmed_name || '',
    confirmedRole: row.confirmed_role || '',
    confirmedAt: row.confirmed_at || '',
    confirmIp: row.confirm_ip || '',
    confirmDevice: row.confirm_device || '',
    confirmNameMismatch: Number(row.confirm_name_mismatch || 0) === 1,
    // 课堂情况
    absentCount: Number(row.absent_count || 0),
    absentNames: row.absent_names || '',
    discipline: row.discipline || 'good',
    disciplineText: DISCIPLINE_TEXT[row.discipline] || '',
    summary: row.summary || '',
    note: row.note || '',
    // 动态码与时限
    codeId: row.code_id || '',
    deadline: row.deadline_at ? u.isoNow(row.deadline_at) : '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    // 按钮状态：班干部可刷新二维码；教师可确认
    canConfirm: !!(viewer && isWait && ['teacher', 'dept_admin', 'admin'].indexOf(viewer.role) >= 0),
    canRefreshCode: canRefreshCode,
    // 证据（新流程：动态码 + 确认人 + 确认时间 + 设备；不再有手写签名图）
    evidence: {
      labels: ['动态码', '确认人', '确认时间', '设备'],
      codeId: row.code_id || '',
      confirmedName: row.confirmed_name || '',
      confirmedRole: row.confirmed_role || '',
      confirmedAt: row.confirmed_at || '',
      device: row.confirm_device || '',
      ip: row.confirm_ip || '',
      nameMismatch: Number(row.confirm_name_mismatch || 0) === 1,
    },
  };
}

// ---------------------------------------------------------------- 授课任务视图
/** 某任务在指定日期已有的有效记录（status != revoked 优先，返回最新一条） */
function recordOfTask(taskId, dateStr) {
  const list = store.filter('period_records', function (r) {
    return String(r.task_id) === String(taskId) && String(r.teach_date) === String(dateStr) && r.status !== 'revoked';
  });
  if (list.length) return list[list.length - 1];
  return store.filter('period_records', function (r) {
    return String(r.task_id) === String(taskId) && String(r.teach_date) === String(dateStr);
  }).pop() || null;
}

function shapeTask(task, dateStr, opts) {
  const o = opts || {};
  const rec = o.record !== undefined ? o.record : (dateStr ? recordOfTask(task.id, dateStr) : null);
  const signer = primaryCadre(task.class_id);
  return {
    id: task.id,
    taskId: task.id,
    term: task.term || '',
    teacherId: task.teacher_id || '',
    teacherName: task.teacher_name || userName(task.teacher_id),
    teacherNo: task.teacher_no || '',
    courseCode: task.course_code || '',
    courseName: task.course_name || '',
    classId: task.class_id || null,
    className: task.class_name || className(task.class_id),
    deptId: task.dept_id || null,
    weekday: Number(task.weekday),
    weekdayText: u.WEEKDAY_CN[Number(task.weekday)] || '',
    section: task.section || '',
    time: (task.start_time || '') + '–' + (task.end_time || ''),
    startTime: task.start_time || '',
    endTime: task.end_time || '',
    place: task.place || '',
    weeks: task.weeks || '',
    hours: Number(task.hours || 0),
    coef: task.coef || '1.0',
    // 日期与状态（前端首页/发起页据此渲染）
    date: dateStr || '',
    fullDate: dateStr || '',
    teachDate: dateStr || '',
    status: rec ? rec.status : 'draft',
    statusText: rec ? (STATUS_TEXT[rec.status] || rec.status) : '未发起',
    recordId: rec ? rec.id : '',
    canCreate: !rec || rec.status === 'revoked',
    confirmer: rec && (rec.status === 'done' || rec.status === 'makeup')
      ? (rec.signer_duty || '') + ' ' + (rec.signer_name || '') : '',
    signerId: signer ? signer.id : null,
    signerName: signer ? signer.real_name : '',
    signerDuty: signer ? signer.duty : '',
    source: task.source || '',
  };
}

module.exports = {
  STATUS_TEXT, DISCIPLINE_TEXT, EVIDENCE_LABELS, SESSION_STATUS_TEXT, COURSE_STATUS_TEXT,
  configMap, configNum, configLimit, setConfig, sensitiveWords, migrateLegacyConfig,
  userById, userName, deptName, className,
  activeCadres, primaryCadre, isActiveCadreOf, cadreDutyOf, studentOf, signatureOf,
  shapeUser, shapeRecord, shapeTask, shapeEvidence, recordOfTask, shortDate,
  shapeClassCourse, shapeSession, shapeClass,
};
