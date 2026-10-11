// 模拟数据层
// 拿到学校 HTTPS 域名前，所有页面读这里；接口层统一在 utils/api.js 切换
// 真实数据接入后只改 api.js，页面不动

var teacher = {
  name: '唐瑞明',
  staffId: '2010032',
  dept: '计算机教研室',
  role: 'teacher'
};

var cadre = {
  name: '张一鸣',
  studentId: '2025030117',
  className: '2025级药学1班',
  role: 'cadre',
  duty: '学委'
};

var admin = {
  name: '教务处',
  dept: '长沙卫生职业学院',
  role: 'admin'
};

// 今日授课任务（演示数据，等真实课表导入后替换）
var todayCourses = [
  {
    id: 'C20260927-1',
    courseName: '信息技术',
    className: '2025级护理3班',
    section: '第1-2节',
    time: '08:00–09:40',
    place: '实训楼A302',
    hours: 2,
    status: 'done',
    confirmer: '李思琪（学委）'
  },
  {
    id: 'C20260927-2',
    courseName: '信息技术',
    className: '2025级药学1班',
    section: '第3-4节',
    time: '10:05–11:45',
    place: '实训楼A302',
    hours: 2,
    status: 'wait',
    confirmer: ''
  },
  {
    id: 'C20260927-3',
    courseName: '信息技术',
    className: '2025级检验2班',
    section: '第5-6节',
    time: '14:00–15:40',
    place: '实训楼B105',
    hours: 2,
    status: 'draft',
    confirmer: ''
  }
];

// 历史记录
var records = [
  {
    id: 'R20260924-1',
    courseName: '信息技术',
    className: '2025级检验2班',
    date: '09-24',
    section: '第5-6节',
    hours: 2,
    status: 'expired',
    note: '超过当天 24 点未确认'
  },
  {
    id: 'R20260922-1',
    courseName: '医学信息检索',
    className: '2025级护理1班',
    date: '09-22',
    section: '第3-4节',
    hours: 2,
    status: 'rejected',
    note: '学委拒绝：当天为自习'
  },
  {
    id: 'R20260920-1',
    courseName: '信息技术',
    className: '2025级护理3班',
    date: '09-20',
    section: '第1-2节',
    hours: 2,
    status: 'makeup',
    note: '补签已通过'
  }
];

// ---------------------------------------------------------------- 业务流程简化后的演示数据
// 班级课程清单（班干部录入一次、长期保留）+ 课时会话（每次上课出示二维码）
// 说明：为了让离线演示「今天一定有课」，种子数据的 weekday 按运行当天的星期生成；
//      真实后端由班干部在「我的课程」里自行录入。

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 今天的星期（1=周一 … 7=周日，与后端 weekday 口径一致） */
function todayWeekday() {
  var d = new Date().getDay();
  return d === 0 ? 7 : d;
}

/** 相对今天偏移 n 天的 YYYY-MM-DD */
function dateOffset(n) {
  var t = new Date();
  t.setDate(t.getDate() + n);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

var MOCK_CLASS = { id: 'C2025YX1', name: '2025级药学1班', deptId: 'D00000001', deptName: '药学院' };

// 课程清单：前两门排在「今天」，第三门未排课（用于演示「未排课」状态）
var classCourses = [
  {
    id: 'CR00000001', classCourseId: 'CR00000001', classId: MOCK_CLASS.id, className: MOCK_CLASS.name,
    deptId: MOCK_CLASS.deptId, deptName: MOCK_CLASS.deptName,
    courseName: '信息技术', teacherName: '唐瑞明', teacherNo: '2010032',
    weekday: todayWeekday(), section: '1-2', startTime: '08:00', endTime: '09:40', time: '08:00–09:40',
    place: '实训楼A302', hours: 2, term: '2026-2027-1',
    status: 'active', statusText: '使用中', archived: false,
    createdBy: 'U00000009', createdByName: '张一鸣', createdAt: '', updatedAt: ''
  },
  {
    id: 'CR00000002', classCourseId: 'CR00000002', classId: MOCK_CLASS.id, className: MOCK_CLASS.name,
    deptId: MOCK_CLASS.deptId, deptName: MOCK_CLASS.deptName,
    courseName: '医学信息检索', teacherName: '唐瑞明', teacherNo: '2010032',
    weekday: todayWeekday(), section: '3-4', startTime: '10:05', endTime: '11:45', time: '10:05–11:45',
    place: '图书馆电子阅览室', hours: 2, term: '2026-2027-1',
    status: 'active', statusText: '使用中', archived: false,
    createdBy: 'U00000009', createdByName: '张一鸣', createdAt: '', updatedAt: ''
  },
  {
    id: 'CR00000003', classCourseId: 'CR00000003', classId: MOCK_CLASS.id, className: MOCK_CLASS.name,
    deptId: MOCK_CLASS.deptId, deptName: MOCK_CLASS.deptName,
    courseName: '计算机应用基础', teacherName: '李慧', teacherNo: '2010044',
    weekday: null, section: '5-6', startTime: '14:00', endTime: '15:40', time: '14:00–15:40',
    place: '实训楼B105', hours: 2, term: '2026-2027-1',
    status: 'active', statusText: '使用中', archived: false,
    createdBy: 'U00000009', createdByName: '张一鸣', createdAt: '', updatedAt: ''
  }
];

// 课时会话（最近课时列表的演示数据）：一条已确认、一条已过期
var sessions = [
  {
    sessionId: 'MR00000001', id: 'MR00000001', origin: 'session', term: '2026-2027-1',
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明', teacherNo: '2010032',
    classId: MOCK_CLASS.id, className: MOCK_CLASS.name, deptId: MOCK_CLASS.deptId, deptName: MOCK_CLASS.deptName,
    teachDate: dateOffset(-1), fullDate: dateOffset(-1),
    section: '1-2', startTime: '08:00', endTime: '09:40', time: '08:00–09:40',
    place: '实训楼A302', hours: 2,
    initiatorId: 'U00000009', initiatorName: '张一鸣', initiatorDuty: '学委',
    isTempAdjusted: false, status: 'done', statusText: '已确认', counted: true,
    confirmedBy: 'U00000001', confirmedName: '唐瑞明', confirmedRole: 'teacher',
    confirmedAt: '', confirmDevice: 'iPhone 13', confirmIp: '10.0.0.8', confirmNameMismatch: false,
    absentCount: 0, absentNames: '', discipline: 'good', disciplineText: '好', summary: '',
    codeId: '', deadline: '', createdAt: '', updatedAt: '', canConfirm: false, canRefreshCode: false
  },
  {
    sessionId: 'MR00000002', id: 'MR00000002', origin: 'session', term: '2026-2027-1',
    courseId: 'CR00000002', courseName: '医学信息检索', teacherName: '唐瑞明', teacherNo: '2010032',
    classId: MOCK_CLASS.id, className: MOCK_CLASS.name, deptId: MOCK_CLASS.deptId, deptName: MOCK_CLASS.deptName,
    teachDate: dateOffset(-3), fullDate: dateOffset(-3),
    section: '3-4', startTime: '10:05', endTime: '11:45', time: '10:05–11:45',
    place: '图书馆电子阅览室', hours: 2,
    initiatorId: 'U00000009', initiatorName: '张一鸣', initiatorDuty: '学委',
    isTempAdjusted: true, status: 'expired', statusText: '已过期', counted: false,
    confirmedBy: '', confirmedName: '', confirmedRole: '', confirmedAt: '',
    confirmDevice: '', confirmIp: '', confirmNameMismatch: false,
    absentCount: 0, absentNames: '', discipline: 'good', disciplineText: '好', summary: '',
    codeId: '', deadline: '', createdAt: '', updatedAt: '', canConfirm: false, canRefreshCode: false
  }
];

// 院系统计（教务处看板）
var deptStats = [
  { name: '护理学院', hours: 486, percent: 82 },
  { name: '药学院', hours: 362, percent: 61 },
  { name: '医学技术系', hours: 261, percent: 44 },
  { name: '公共课部', hours: 175, percent: 29 }
];

// 状态文案映射
var statusText = {
  draft: '未发起',
  wait: '待确认',
  done: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
  appealing: '申诉中',
  makeup: '已补签',
  revoked: '已撤销'
};

module.exports = {
  teacher: teacher,
  cadre: cadre,
  admin: admin,
  todayCourses: todayCourses,
  records: records,
  deptStats: deptStats,
  statusText: statusText,
  // 业务流程简化（课程清单 + 课时会话）演示数据
  MOCK_CLASS: MOCK_CLASS,
  classCourses: classCourses,
  sessions: sessions,
  todayWeekday: todayWeekday,
  dateOffset: dateOffset
};
