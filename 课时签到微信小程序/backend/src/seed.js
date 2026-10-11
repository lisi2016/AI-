'use strict';
/**
 * 演示种子数据（首次运行自动写入 data/*.json）
 * 契约要求：1 个院系、2 个教学班、3 名教师、3 名班干部、若干授课任务、班干部授权、白名单
 * 日期全部基于"运行当天"动态生成，保证任意时间启动都能走通完整流程
 */
const u = require('./util');
const store = require('./store');
const audit = require('./audit');

const SECTION_TIME = u.SECTION_TIME;

function create() {
  const now = u.isoNow();
  const today = u.dateOnly();
  const weekday = u.tzParts().weekday;
  const monday = u.mondayOf(today);

  // ------------------------------------------------------------ 配置
  u.CONFIG_KEYS.forEach(function (key) {
    store.insert('configs', {
      id: store.newId('CFG'),
      key: key,
      value: u.DEFAULT_CONFIG[key],
      updated_by: 'system',
      updated_at: now,
    });
  });

  // ------------------------------------------------------------ 院系
  const deptNursing = store.insert('depts', {
    id: store.newId('D'), name: '护理学院', code: 'HL', parent_id: null, status: 'active', created_at: now,
  });
  const deptPharmacy = store.insert('depts', {
    id: store.newId('D'), name: '药学院', code: 'YX', parent_id: null, status: 'active', created_at: now,
  });

  // ------------------------------------------------------------ 教学班
  function addClass(name, grade, dept, advisor) {
    return store.insert('classes', {
      id: store.newId('C'), name: name, grade: grade, dept_id: dept.id,
      advisor: advisor, status: 'active', created_at: now,
    });
  }
  const clsNursing3 = addClass('2025级护理3班', '2025', deptNursing, '唐瑞明');
  const clsPharmacy1 = addClass('2025级药学1班', '2025', deptPharmacy, '周慧敏');

  // ------------------------------------------------------------ 用户（3 教师 / 3 班干部 / 1 院系管理员 / 1 教务处）
  function addUser(o) {
    return store.insert('users', {
      id: store.newId('U'),
      openid: o.openid || '',
      unionid: '',
      role: o.role,
      real_name: o.real_name,
      staff_no: o.staff_no || '',
      student_no: o.student_no || '',
      dept_id: o.dept_id || null,
      class_id: o.class_id || null,
      phone: o.phone || '',
      duty: o.duty || '',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }

  const t1 = addUser({ role: 'teacher', real_name: '唐瑞明', staff_no: '2010032', dept_id: deptNursing.id, phone: '13800000001' });
  const t2 = addUser({ role: 'teacher', real_name: '李慧', staff_no: '2011045', dept_id: deptPharmacy.id, phone: '13800000002' });
  const t3 = addUser({ role: 'teacher', real_name: '王强', staff_no: '2012088', dept_id: deptNursing.id, phone: '13800000003' });

  const c1 = addUser({ role: 'cadre', real_name: '张一鸣', student_no: '2025030117', class_id: clsNursing3.id, dept_id: deptNursing.id, duty: '学委' });
  const c2 = addUser({ role: 'cadre', real_name: '王悦', student_no: '2025030102', class_id: clsNursing3.id, dept_id: deptNursing.id, duty: '班长' });
  const c3 = addUser({ role: 'cadre', real_name: '刘欣', student_no: '2025030109', class_id: clsNursing3.id, dept_id: deptNursing.id, duty: '副班长' });
  const c4 = addUser({ role: 'cadre', real_name: '陈思远', student_no: '2025040201', class_id: clsPharmacy1.id, dept_id: deptPharmacy.id, duty: '学委' });
  const c5 = addUser({ role: 'cadre', real_name: '赵敏', student_no: '2025040202', class_id: clsPharmacy1.id, dept_id: deptPharmacy.id, duty: '班长' });

  const deptAdmin = addUser({ role: 'dept_admin', real_name: '孙主任', staff_no: '2017001', dept_id: deptNursing.id, phone: '13900000001' });
  const admin = addUser({ role: 'admin', real_name: '教务处', staff_no: 'ADMIN001', dept_id: null, phone: '13900000002' });

  // ------------------------------------------------------------ 班干部授权（学委 priority=1 默认为签字人）
  function addCadre(cls, user, duty, priority) {
    return store.insert('class_cadres', {
      id: store.newId('CC'),
      class_id: cls.id,
      user_id: user.id,
      duty: duty,
      priority: priority,
      status: 'active',
      start_at: now,
      end_at: null,
      created_at: now,
    });
  }
  addCadre(clsNursing3, c1, '学委', 1);
  addCadre(clsNursing3, c2, '班长', 2);
  addCadre(clsNursing3, c3, '副班长', 3);
  addCadre(clsPharmacy1, c4, '学委', 1);
  addCadre(clsPharmacy1, c5, '班长', 2);

  // ------------------------------------------------------------ 白名单（绑定校验用）
  function addWhite(no, name, role, deptId, classId) {
    return store.insert('whitelist', {
      id: store.newId('W'), no: no, real_name: name, role: role,
      dept_id: deptId || null, class_id: classId || null, status: 'active', created_at: now,
    });
  }
  addWhite(t1.staff_no, t1.real_name, 'teacher', t1.dept_id, null);
  addWhite(t2.staff_no, t2.real_name, 'teacher', t2.dept_id, null);
  addWhite(t3.staff_no, t3.real_name, 'teacher', t3.dept_id, null);
  addWhite(c1.student_no, c1.real_name, 'cadre', c1.dept_id, c1.class_id);
  addWhite(c2.student_no, c2.real_name, 'cadre', c2.dept_id, c2.class_id);
  addWhite(c3.student_no, c3.real_name, 'cadre', c3.dept_id, c3.class_id);
  addWhite(c4.student_no, c4.real_name, 'cadre', c4.dept_id, c4.class_id);
  addWhite(c5.student_no, c5.real_name, 'cadre', c5.dept_id, c5.class_id);
  addWhite(deptAdmin.staff_no, deptAdmin.real_name, 'dept_admin', deptAdmin.dept_id, null);
  addWhite(admin.staff_no, admin.real_name, 'admin', null, null);

  // ------------------------------------------------------------ 学生名单
  const STUDENTS = [
    ['2025030101', '李思琪'], ['2025030102', '王悦'], ['2025030103', '周舟'], ['2025030104', '吴桐'],
    ['2025030105', '郑好'], ['2025030106', '冯雨'], ['2025030107', '陈嘉'], ['2025030108', '褚明'],
    ['2025030109', '刘欣'], ['2025030110', '何静'], ['2025030111', '罗艺'], ['2025030112', '高远'],
    ['2025030113', '林果'], ['2025030114', '谢楠'], ['2025030115', '韩雪'], ['2025030116', '邓超'],
    ['2025030117', '张一鸣'], ['2025030118', '曾毅'], ['2025030119', '彭亮'], ['2025030120', '许飞'],
    ['2025030121', '曹雨'], ['2025030122', '苏杭'],
  ];
  const STUDENTS_PHA = [
    ['2025040201', '陈思远'], ['2025040202', '赵敏'], ['2025040203', '钱多多'], ['2025040204', '孙悦'],
    ['2025040205', '李雷'], ['2025040206', '周晴'], ['2025040207', '吴迪'], ['2025040208', '郑一'],
    ['2025040209', '王芳'], ['2025040210', '冯磊'], ['2025040211', '陈曦'], ['2025040212', '褚岩'],
    ['2025040213', '卫青'], ['2025040214', '蒋雯'], ['2025040215', '沈括'], ['2025040216', '韩梅'],
    ['2025040217', '杨帆'], ['2025040218', '朱迪'],
  ];
  STUDENTS.forEach(function (s) {
    store.insert('students', { id: store.newId('S'), student_no: s[0], real_name: s[1], class_id: clsNursing3.id, status: 'active', created_at: now });
  });
  STUDENTS_PHA.forEach(function (s) {
    store.insert('students', { id: store.newId('S'), student_no: s[0], real_name: s[1], class_id: clsPharmacy1.id, status: 'active', created_at: now });
  });

  // ------------------------------------------------------------ 授课任务（课表）
  const term = u.TERM_DEFAULT;
  function addTask(o) {
    const st = SECTION_TIME[o.section] || ['08:00', '09:40'];
    return store.insert('course_tasks', {
      id: store.newId('T'),
      term: term,
      teacher_id: o.teacher.id,
      teacher_name: o.teacher.real_name,
      teacher_no: o.teacher.staff_no,
      course_code: o.code,
      course_name: o.name,
      class_id: o.cls.id,
      class_name: o.cls.name,
      dept_id: o.cls.dept_id,
      weekday: o.weekday,
      section: o.section,
      start_time: o.start || st[0],
      end_time: o.end || st[1],
      place: o.place,
      weeks: '1-18',
      hours: o.hours || 2,
      coef: '1.0',
      source: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }

  // 护理3班：周三 1-2 理论 + 3-4 实践；周一 5-6
  addTask({ teacher: t1, code: 'XXJS001', name: '信息技术', cls: clsNursing3, weekday: 3, section: '1-2', place: '实训楼A302', hours: 2 });
  addTask({ teacher: t1, code: 'XXJS001', name: '信息技术', cls: clsNursing3, weekday: 3, section: '3-4', place: '实训楼A302', hours: 2 });
  addTask({ teacher: t1, code: 'XXJS001', name: '信息技术', cls: clsNursing3, weekday: 1, section: '5-6', place: '实训楼B105', hours: 2 });
  // 药学1班：周三 5-6
  addTask({ teacher: t1, code: 'XXJS001', name: '信息技术', cls: clsPharmacy1, weekday: 3, section: '5-6', place: '实训楼A302', hours: 2 });
  // 李慧：医学信息检索 周四 1-2 / 周五 3-4
  addTask({ teacher: t2, code: 'YXXX002', name: '医学信息检索', cls: clsNursing3, weekday: 4, section: '1-2', place: '图书馆电子阅览室', hours: 2 });
  addTask({ teacher: t2, code: 'YXXX002', name: '医学信息检索', cls: clsPharmacy1, weekday: 5, section: '3-4', place: '图书馆电子阅览室', hours: 2 });
  // 王强：大学计算机基础 周二 1-2 / 周三 7-8
  addTask({ teacher: t3, code: 'DXJS003', name: '大学计算机基础', cls: clsNursing3, weekday: 2, section: '1-2', place: '实训楼C201', hours: 2 });
  addTask({ teacher: t3, code: 'DXJS003', name: '大学计算机基础', cls: clsPharmacy1, weekday: 3, section: '7-8', place: '实训楼C201', hours: 2 });

  // ------------------------------------------------------------ 班级课程清单（新增：班干部录入一次、长期保留）
  // 与上面的课表基本对应，另加一条「未排课」课程用于演示「清单里没有也能发起 / 临时调整」
  function addCourse(o) {
    const st = SECTION_TIME[o.section] || ['', ''];
    return store.insert('class_courses', {
      id: store.newId('CR'),
      class_id: o.cls.id,
      class_name: o.cls.name,
      dept_id: o.cls.dept_id,
      course_name: o.name,
      teacher_name: o.teacher ? o.teacher.real_name : (o.teacherName || ''),
      teacher_no: o.teacher ? (o.teacher.staff_no || '') : '',
      weekday: o.weekday === undefined ? null : o.weekday,
      section: o.section || '',
      start_time: o.start || st[0],
      end_time: o.end || st[1],
      place: o.place || '',
      hours: o.hours === undefined ? 2 : o.hours,
      term: term,
      status: 'active',
      created_by: o.createdBy || null,
      created_at: now,
      updated_at: now,
    });
  }

  addCourse({ teacher: t1, name: '信息技术', cls: clsNursing3, weekday: 1, section: '5-6', place: '实训楼B105', hours: 2, createdBy: c1.id });
  addCourse({ teacher: t1, name: '信息技术', cls: clsNursing3, weekday: 3, section: '1-2', place: '实训楼A302', hours: 2, createdBy: c1.id });
  addCourse({ teacher: t3, name: '大学计算机基础', cls: clsNursing3, weekday: 2, section: '1-2', place: '实训楼C201', hours: 2, createdBy: c1.id });
  addCourse({ teacher: t2, name: '医学信息检索', cls: clsNursing3, weekday: 4, section: '1-2', place: '图书馆电子阅览室', hours: 2, createdBy: c1.id });
  addCourse({ teacher: t1, name: '信息技术', cls: clsPharmacy1, weekday: 3, section: '5-6', place: '实训楼A302', hours: 2, createdBy: c4.id });
  addCourse({ teacher: t3, name: '大学计算机基础', cls: clsPharmacy1, weekday: 3, section: '7-8', place: '实训楼C201', hours: 2, createdBy: c4.id });
  addCourse({ teacher: t2, name: '医学信息检索', cls: clsPharmacy1, weekday: 5, section: '3-4', place: '图书馆电子阅览室', hours: 2, createdBy: c4.id });
  // 未排课（weekday 为空）：清单里有课但不知道星期，用于演示临时安排
  addCourse({ teacherName: '附属医院带教老师', name: '临床见习', cls: clsPharmacy1, weekday: null, place: '附属医院', hours: 4, createdBy: c4.id });

  // ------------------------------------------------------------ 历史课时记录（上周已确认 + 本周）
  function activeCadreOf(classId) {
    const list = store.filter('class_cadres', function (r) { return String(r.class_id) === String(classId) && r.status === 'active'; });
    list.sort(function (a, b) { return Number(a.priority) - Number(b.priority); });
    return list.length ? store.findById('users', list[0].user_id) : null;
  }

  function addSignature(rec, signer) {
    const svgish = Buffer.from('fake-signature-image|' + rec.id + '|' + signer.real_name, 'utf8');
    const imageHash = u.sha256(svgish);
    const relative = 'sign_' + rec.id + '_' + u.randHex(6) + '.png';
    require('fs').writeFileSync(require('path').join(u.UPLOAD_DIR, relative), svgish);
    store.insert('signatures', {
      id: store.newId('SG'),
      record_id: rec.id,
      signer_id: signer.id,
      image_url: 'data/uploads/' + relative,
      signed_at: rec.confirmed_at,
      // 定位/位置信息已彻底移除：列保留仅为兼容历史数据，新数据一律为空
      latitude: null,
      longitude: null,
      location_denied: null,
      device_info: 'iPhone 15 Pro',
      code_id: rec.code_id,
      ip: '127.0.0.1',
      image_hash: imageHash,
      created_at: rec.confirmed_at,
    });
  }

  function makeRecord(task, dateStr, status, opts) {
    const o = opts || {};
    const cadre = activeCadreOf(task.class_id);
    const st = [task.start_time, task.end_time];
    const rec = store.insert('period_records', {
      id: store.newId('R'),
      task_id: task.id,
      teacher_id: task.teacher_id,
      teacher_name: task.teacher_name,
      teacher_no: task.teacher_no,
      course_code: task.course_code,
      course_name: task.course_name,
      class_id: task.class_id,
      class_name: task.class_name,
      dept_id: task.dept_id,
      term: task.term,
      teach_date: dateStr,
      section: task.section,
      start_time: st[0],
      end_time: st[1],
      place: task.place,
      hours: task.hours,
      coef: task.coef,
      status: status,
      absent_count: o.absentCount || 0,
      absent_names: o.absentNames || '',
      discipline: o.discipline || 'good',
      summary: o.summary || '',
      signer_id: cadre ? cadre.id : null,
      signer_name: cadre ? cadre.real_name : '',
      signer_duty: cadre ? cadre.duty : '',
      signer_is_adhoc: 0,
      code_id: o.codeId || 'SEED-CODE',
      confirmed_at: status === 'done' || status === 'makeup' ? (dateStr + 'T' + (st[1] || '09:40') + ':30+08:00') : null,
      deadline_at: u.isoNow(u.deadlineOf(dateStr, 24)),
      makeup_id: null,
      appeal_id: null,
      note: o.note || '',
      created_at: dateStr + 'T' + (st[1] || '09:40') + ':10+08:00',
      updated_at: o.updatedAt || u.isoNow(),
    });
    if (status === 'done' || status === 'makeup') addSignature(rec, cadre);
    audit.log({ user: store.findById('users', task.teacher_id), ip: '127.0.0.1', device: 'seed' },
      'record.seed', { targetType: 'period_record', targetId: rec.id, after: { status: status }, detail: '种子数据' });
    return rec;
  }

  const tasks = store.all('course_tasks');
  const thisMonday = monday;

  tasks.forEach(function (task) {
    // 上周：两条已确认（含合班课程只按 task 统计）
    const lastWeekDate = u.addDays(thisMonday, task.weekday - 8);
    makeRecord(task, lastWeekDate, 'done', { absentCount: 1, absentNames: '李思琪', summary: task.course_name + ' 第 1 次课' });
    // 本周：今天之前的日期 → 已确认；今天当天 → 待确认（按节次错开）
    const thisWeekDate = u.addDays(thisMonday, task.weekday - 1);
    if (thisWeekDate < today) {
      makeRecord(task, thisWeekDate, 'done', { absentCount: 0, summary: task.course_name + ' 课堂讲授' });
    } else if (thisWeekDate === today) {
      makeRecord(task, thisWeekDate, 'wait', { note: '' });
    }
  });

  // 一条超时未确认（跑到 24 点没签）→ expired，用于演示补签流程
  if (tasks.length) {
    const overdueDate = u.addDays(today, -1);
    makeRecord(tasks[0], overdueDate, 'expired', { note: '超过当天 24 点未确认，系统自动置为已过期' });
    const rejectedDate = u.addDays(today, -2);
    makeRecord(tasks[1] || tasks[0], rejectedDate, 'rejected', { note: '班干部拒绝：当天实际为自习' });
  }

  return {
    depts: 2,
    classes: 2,
    teachers: 3,
    cadres: 5,
    users: store.all('users').length,
    tasks: store.all('course_tasks').length,
    courses: store.all('class_courses').length,
    records: store.all('period_records').length,
    weekRef: { today: today, weekday: weekday, monday: monday, wednesday: u.addDays(monday, 2) },
    accounts: [t1, t2, t3, c1, c2, c3, c4, c5, deptAdmin, admin].map(function (x) {
      return { role: x.role, name: x.real_name, no: x.staff_no || x.student_no };
    }),
  };
}

module.exports = { create, SECTION_TIME };
