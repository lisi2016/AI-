// 数据整形层：把后端响应统一成页面直接可渲染的形状，并提供日期/状态文案工具
//
// 为什么要这一层：
//   1) 同一个接口在 mock 与真实后端下的返回结构不同
//      例：GET /records 真实后端返回 { list, total, page, pageSize, summary }，
//          而 mock 直接返回数组；GET /tasks 两者都是数组。
//   页面不该为「现在连的是哪种后端」写两套分支。
//   2) 后端各接口的列表包装不完全一致（数组 / {list} / {tasks}），这里做一次收敛。
//
// 纯函数、不依赖 wx，可被 Node 自测脚本直接 require。

var STATUS_TEXT = {
  draft: '未发起',
  wait: '待确认',
  done: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  appealing: '申诉中',
  makeup: '已补签',
  revoked: '已撤销'
};

var DISCIPLINE_TEXT = { good: '好', normal: '一般', bad: '差' };

// 新流程（课时会话）状态文案：教师扫码确认，不再有班干部签名环节
var SESSION_STATUS_TEXT = {
  draft: '未发起',
  wait: '待教师确认',
  done: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  appealing: '申诉中',
  makeup: '已补签',
  revoked: '已撤销'
};

// 班级课程清单状态
var COURSE_STATUS_TEXT = { active: '使用中', archived: '已归档' };

// 星期选项（1-7；null = 未排课），供「我的课程」表单 picker 使用
var WEEKDAY_OPTIONS = [
  { value: 0, text: '未排课' },
  { value: 1, text: '周一' },
  { value: 2, text: '周二' },
  { value: 3, text: '周三' },
  { value: 4, text: '周四' },
  { value: 5, text: '周五' },
  { value: 6, text: '周六' },
  { value: 7, text: '周日' }
];

// 节次选项（与后端内置节次表一致：1-2 / 3-4 / 5-6 / 7-8）
var SECTION_OPTIONS = ['1-2', '3-4', '5-6', '7-8'];

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 今天（本地时区）YYYY-MM-DD */
function todayFull(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

/** 今天 MM-DD */
function todayShort(d) {
  var t = d || new Date();
  return pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

/** 'YYYY-MM-DD' → 'MM-DD'（已是短格式则原样返回） */
function shortDate(v) {
  var s = String(v || '');
  return s.length >= 10 ? s.slice(5, 10) : s;
}

/** 本周一 / 本周日（周一为一周起始），用于 /records?from=&to= 的周统计口径 */
function weekRange(d) {
  var t = d ? new Date(d) : new Date();
  var day = t.getDay();                       // 0 = 周日
  var diffToMon = day === 0 ? -6 : 1 - day;
  var mon = new Date(t.getFullYear(), t.getMonth(), t.getDate() + diffToMon);
  var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return {
    from: todayFull(mon),
    to: todayFull(sun),
    text: (mon.getMonth() + 1) + '月' + mon.getDate() + '日 – ' + (sun.getMonth() + 1) + '月' + sun.getDate() + '日'
  };
}

/** 'YYYY-MM-DD' 或 ISO 串 → 'YYYY-MM-DD HH:mm' */
function dateTimeText(v) {
  var s = String(v || '');
  if (!s) return '';
  return s.slice(0, 16).replace('T', ' ');
}

function statusTextOf(status) {
  return STATUS_TEXT[status] || status || '';
}

/** 取列表：兼容 数组 / {list} / {tasks} / {rows} */
function listOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.tasks)) return data.tasks;
  if (Array.isArray(data.rows)) return data.rows;
  return [];
}

/** 分页归一化 → { list, total, page, pageSize, summary } */
function pageOf(data) {
  var d = data || {};
  var list = listOf(d);
  var isArr = Array.isArray(d);
  var total = Number(d.total);
  if (!isFinite(total)) total = list.length;
  return {
    list: list,
    total: total,
    page: Number(d.page) || 1,
    pageSize: Number(d.pageSize) || list.length || 20,
    summary: (d && d.summary) || {}
  };
}

/** 统计某个状态的数量（本地数组入参时按状态现算） */
function countInArray(data, status) {
  var n = 0;
  for (var i = 0; i < data.length; i++) if (data[i] && data[i].status === status) n++;
  return n;
}

/**
 * GET /records 的「各状态数量」：优先取后端新增的 summary.statusTotals
 * （不受 status= 筛选影响、按角色可见范围统计），旧后端没有该字段时回退 summary.byStatus（兼容）。
 * @returns {Object} 形如 { wait: 3, done: 12, ... }（值为 Number）
 */
function statusTotals(data) {
  if (Array.isArray(data)) {
    // mock / 旧接口直接返回数组：本地按 status 现算
    var counted = {};
    for (var i = 0; i < data.length; i++) {
      var s0 = data[i] && data[i].status;
      if (!s0) continue;
      counted[s0] = (counted[s0] || 0) + 1;
    }
    return counted;
  }
  var s = (data && data.summary) || {};
  // statusTotals 优先；缺失（含旧后端返回 null）时回退 byStatus
  var raw = s.statusTotals || s.byStatus || {};
  var out = {};
  Object.keys(raw).forEach(function (k) { out[k] = Number(raw[k] || 0); });
  return out;
}

/** 后端 summary 里某个状态的数量（兼容数组入参；优先 statusTotals，回退 byStatus） */
function countByStatus(data, status) {
  if (Array.isArray(data)) return countInArray(data, status);
  return Number(statusTotals(data)[status] || 0);
}

/**
 * 授课任务列表归一化：补齐页面用到的展示字段
 * 后端 shapeTask 已给出 id/section/time/courseName/className/place/hours/status/recordId，
 * mock.js 的 todayCourses 也基本一致，这里只做缺省值兜底。
 */
function taskList(data) {
  return listOf(data).map(function (t) {
    var o = t || {};
    return {
      id: o.id || o.taskId || '',
      taskId: o.taskId || o.id || '',
      courseName: o.courseName || '',
      className: o.className || '',
      section: o.section || '',
      time: o.time || '',
      place: o.place || '',
      hours: Number(o.hours || 0),
      status: o.status || 'draft',
      statusText: o.statusText || statusTextOf(o.status || 'draft'),
      recordId: o.recordId || '',
      canCreate: o.canCreate === undefined ? !o.recordId : !!o.canCreate,
      // 该教学班的主签字人（后端 shapeTask 提供，用于提交记录时指定 signerId）
      signerId: o.signerId || '',
      signerName: o.signerName || '',
      signerDuty: o.signerDuty || '',
      confirmer: o.confirmer || '',
      teacherName: o.teacherName || '',
      fullDate: o.fullDate || o.teachDate || ''
    };
  });
}

/** 课时记录归一化：补齐展示字段（后端 /records 已是驼峰，这里只兜底） */
function recordList(data) {
  return listOf(data).map(function (r) {
    var o = r || {};
    return Object.assign({}, o, {
      id: o.id || '',
      courseName: o.courseName || '',
      className: o.className || '',
      date: o.date || shortDate(o.fullDate || o.teachDate),
      section: o.section || '',
      hours: Number(o.hours || 0),
      status: o.status || '',
      statusText: o.statusText || statusTextOf(o.status),
      note: o.note || '',
      disciplineText: o.disciplineText || DISCIPLINE_TEXT[o.discipline] || '—'
    });
  });
}

/** 星期文案（1-7 → 周一…周日；空 → ''） */
function weekdayTextOf(wd) {
  var n = Number(wd);
  if (!n || n < 1 || n > 7) return '';
  return WEEKDAY_OPTIONS[n].text;
}

/**
 * 班级课程清单归一化（GET /class-courses）
 * 后端 shapeClassCourse 已是驼峰；mock 与旧后端可能缺字段，这里统一兜底。
 */
function courseList(data) {
  return listOf(data).map(function (c) {
    var o = c || {};
    var wd = (o.weekday === undefined || o.weekday === null || o.weekday === '') ? null : Number(o.weekday);
    return {
      id: o.id || o.classCourseId || '',
      classId: o.classId || '',
      className: o.className || '',
      courseName: o.courseName || '',
      teacherName: o.teacherName || '',
      teacherNo: o.teacherNo || '',
      weekday: wd,
      weekdayText: o.weekdayText || weekdayTextOf(wd),
      section: o.section || '',
      startTime: o.startTime || '',
      endTime: o.endTime || '',
      time: o.time || ((o.startTime || '') + '–' + (o.endTime || '')),
      place: o.place || '',
      hours: Number(o.hours || 0),
      term: o.term || '',
      status: o.status || 'active',
      statusText: o.statusText || COURSE_STATUS_TEXT[o.status] || o.status || '',
      archived: o.archived === undefined ? o.status === 'archived' : !!o.archived
    };
  });
}

/**
 * 课时会话归一化（GET /sessions）
 * 展示字段：课程 / 实际授课人 / 班级 / 日期 / 节次 / 地点 / 学时 / 发起人 / 状态
 */
function sessionList(data) {
  return listOf(data).map(function (s) { return sessionOf(s); });
}

/** 单条课时会话归一化：兼容 {session:{…}}（详情响应）与裸会话对象 */
function sessionOf(data) {
  var raw = (data && data.session && typeof data.session === 'object') ? data.session : (data || {});
  var o = raw || {};
  var teachDate = o.teachDate || o.fullDate || '';
  return Object.assign({}, o, {
    id: o.sessionId || o.id || '',
    sessionId: o.sessionId || o.id || '',
    courseName: o.courseName || '',
    className: o.className || '',
    teacherName: o.teacherName || '',
    initiatorName: o.initiatorName || '',
    initiatorDuty: o.initiatorDuty || '',
    teachDate: teachDate,
    fullDate: teachDate,
    date: o.date || shortDate(teachDate),
    section: o.section || '',
    time: o.time || ((o.startTime || '') + '–' + (o.endTime || '')),
    place: o.place || '',
    hours: Number(o.hours || 0),
    status: o.status || '',
    statusText: o.statusText || SESSION_STATUS_TEXT[o.status] || o.status || '',
    counted: o.counted === undefined ? (o.status === 'done' || o.status === 'makeup') : !!o.counted,
    isTempAdjusted: !!o.isTempAdjusted,
    confirmedName: o.confirmedName || '',
    confirmedAt: o.confirmedAt || '',
    confirmDevice: o.confirmDevice || '',
    confirmNameMismatch: !!o.confirmNameMismatch,
    canConfirm: !!o.canConfirm,
    canRefreshCode: !!o.canRefreshCode,
    summary: o.summary || '',
    note: o.note || ''
  });
}

/**
 * 会话「证据四项」：动态码 / 确认人 / 确认时间 / 设备
 * 新流程不再有手写签名图与定位，页面只渲染这四项。
 */
function sessionEvidence(s, code) {
  var o = s || {};
  var ev = o.evidence || {};
  var codeText = (code && code.codeId) || ev.codeId || o.codeId || '';
  if (codeText && code && code.used) codeText += '（已消费）';
  return [
    { label: '动态码', value: codeText || '—' },
    { label: '确认人', value: o.confirmedName || ev.confirmedName || '—' },
    { label: '确认时间', value: dateTimeText(o.confirmedAt || ev.confirmedAt) || '—' },
    { label: '设备', value: o.confirmDevice || ev.device || '—' }
  ];
}

/** 院系统计归一化：兼容 数组 / {list}，percent 缺省时按最大值折算 */function deptStats(data) {
  var list = listOf(data).map(function (d) {
    return {
      name: d.name || d.deptName || '',
      hours: Number(d.hours || d.confirmedHours || 0),
      percent: Number(d.percent || d.rate || 0)
    };
  });
  var max = 0;
  list.forEach(function (d) { if (d.hours > max) max = d.hours; });
  return list.map(function (d) {
    return {
      name: d.name,
      hours: d.hours,
      percent: d.percent || (max > 0 ? Math.round(d.hours * 100 / max) : 0)
    };
  });
}

module.exports = {
  STATUS_TEXT: STATUS_TEXT,
  SESSION_STATUS_TEXT: SESSION_STATUS_TEXT,
  COURSE_STATUS_TEXT: COURSE_STATUS_TEXT,
  DISCIPLINE_TEXT: DISCIPLINE_TEXT,
  WEEKDAY_OPTIONS: WEEKDAY_OPTIONS,
  SECTION_OPTIONS: SECTION_OPTIONS,
  pad2: pad2,
  todayFull: todayFull,
  todayShort: todayShort,
  shortDate: shortDate,
  weekRange: weekRange,
  dateTimeText: dateTimeText,
  statusTextOf: statusTextOf,
  weekdayTextOf: weekdayTextOf,
  listOf: listOf,
  pageOf: pageOf,
  countByStatus: countByStatus,
  statusTotals: statusTotals,
  taskList: taskList,
  recordList: recordList,
  courseList: courseList,
  sessionList: sessionList,
  sessionOf: sessionOf,
  sessionEvidence: sessionEvidence,
  deptStats: deptStats
};
