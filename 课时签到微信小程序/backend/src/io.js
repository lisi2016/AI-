'use strict';
/**
 * 导出（契约 G）与导入（契约 H）
 * 导出表头固定；导入先校验后落库，逐行错误报告，不允许部分脏数据静默入库
 */
const fs = require('fs');
const path = require('path');
const u = require('./util');
const store = require('./store');
const audit = require('./audit');
const view = require('./view');
const stats = require('./stats');
const records = require('./records');
const auth = require('./auth');
const { CODES, fail, paramError } = require('./errors');

/**
 * 课时明细导出固定表头（列顺序固定，不因筛选条件缺列）
 *
 * 业务流程简化后的口径：
 * · 「教师姓名」= **实际授课人**（学时按其实归属，会话里即 teacher_name）；
 * · 「发起人（学委）」= 发起本次课时的人（会话中 `signer_name` 同步为发起人，兼容旧流程「签字人」）；
 * · 新增三列（本次补齐）：「确认人」`confirmed_name`、「是否临时调整」`is_temp_adjusted`、
 *   「确认人与实际授课人不符」`confirm_name_mismatch`——新流程（课时会话）有值，旧流程数据（无
 *   `confirmed_name` / 无 `origin='session'`）输出空，便于区分两套流程；
 * · 不含签名图 URL、不含任何定位信息。
 */
const EXPORT_HEADERS = [
  '学期', '教师姓名', '工号', '院系', '课程', '教学班', '上课日期', '节次', '应计学时',
  '状态', '是否补签', '发起人（学委）', '签字人职务', '是否现场指定',
  '确认人', '是否临时调整', '确认人与实际授课人不符',
  '确认时间', '缺勤人数', '缺勤姓名', '课堂纪律',
];

/**
 * 导入类型（顺序 = 推荐导入顺序：先基础数据，再业务数据）
 *  · depts / classes：院系 / 教学班等主数据（ID 留空则按名称匹配；ID 命中则原地更新，可改名）
 *  · tasks / students / whitelist / cadres：既有业务数据（逻辑不变）
 */
const IMPORT_TYPES = ['depts', 'classes', 'tasks', 'students', 'whitelist', 'cadres'];

const IMPORT_HEADERS = {
  // 主数据：末列 ID 可选（留空 = 新增或按名称更新；填写 = 按 ID 更新，支持改名）
  depts: ['院系名称', '院系代码', '上级院系', '院系ID'],
  classes: ['教学班名称', '年级', '所属院系', '班主任', '教学班ID', '状态'],
  tasks: ['学期', '工号', '教师姓名', '课程代码', '课程名称', '教学班', '星期', '节次', '开始', '结束', '地点', '周次', '学时'],
  students: ['学号', '姓名', '教学班'],
  whitelist: ['工号/学号', '姓名', '角色', '院系', '教学班'],
  cadres: ['教学班', '学号', '姓名', '职务', '优先级'],
};

const IMPORT_HEADERS_ALT = {
  whitelist: { '工号/学号': ['工号学号', '工号', '学号', '编号'] },
  depts: {
    '院系名称': ['院系', '名称', '部门名称', '二级学院', '学院'],
    '院系代码': ['代码', '院系简称', '简称'],
    '上级院系': ['上级院系名称', '上级', '父级院系'],
    '院系ID': ['院系id', 'ID', 'id', '院系编号'],
  },
  classes: {
    '教学班名称': ['教学班', '班级名称', '班级', '名称'],
    '年级': ['入学年级'],
    '所属院系': ['院系', '院系名称', '所属学院'],
    '班主任': ['辅导员', '班主任姓名'],
    '教学班ID': ['班级ID', '班级id', '教学班id', 'ID', 'id'],
    '状态': ['班级状态'],
  },
};

// 导入类型 → 受影响的数据表（用于导入前快照 / 回滚）
const IMPORT_TABLES_OF = {
  depts: ['depts'],
  classes: ['classes'],
  tasks: ['course_tasks'],
  students: ['students'],
  whitelist: ['whitelist'],
  cadres: ['users', 'whitelist', 'class_cadres'],
};

/** 主数据（院系 / 教学班）：必须有名称与唯一 ID 前缀（ID 取现有最大序号 +1，避免与种子数据撞号） */
const MASTER_OF = {
  depts: { label: '院系', prefix: 'D' },
  classes: { label: '教学班', prefix: 'C' },
};

/** 主数据状态取值（教学班复用 classes.js 的 STATUSES 口径：active / archived / leave） */
const MASTER_STATUS_ALIASES = {
  active: 'active', '启用': 'active', '在用': 'active', '正常': 'active',
  archived: 'archived', '归档': 'archived', '停用': 'archived', '已停用': 'archived', '已归档': 'archived',
  leave: 'leave', '休学': 'leave',
};

// 导入快照目录（保留最近一次导入前的数据，支持回滚）
const SNAPSHOT_DIR = path.join(u.DATA_DIR, 'snapshots');
function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

// ---------------------------------------------------------------- 导出
/**
 * 是否「新流程」行（班干部发起 + 教师扫码确认的课时会话）
 * 判定与 view.shapeRecord 的 sessionId 口径一致：origin='session' 或存在发起人。
 * 旧流程（教师发起 → 班干部签名）行两个字段都没有 → 新增三列输出空。
 */
function isSessionFlowRow(r) {
  return String(r.origin || '') === 'session' || !!r.initiator_id;
}

function yesNo(v) { return Number(v || 0) === 1 ? '是' : '否'; }

function recordRow(r) {
  const sessionFlow = isSessionFlowRow(r);
  return [
    r.term || '',
    r.teacher_name || '',
    r.teacher_no || '',
    view.deptName(r.dept_id),
    r.course_name || '',
    r.class_name || view.className(r.class_id),
    r.teach_date || '',
    r.section || '',
    Number(r.hours || 0),
    view.STATUS_TEXT[r.status] || r.status,
    r.status === 'makeup' ? '是' : '否',
    r.signer_name || '',
    r.signer_duty || '',
    Number(r.signer_is_adhoc) === 1 ? '是' : '否',
    // ---- 新流程（课时会话）三列；旧流程行输出空 ----
    r.confirmed_name || '',
    sessionFlow ? yesNo(r.is_temp_adjusted) : '',
    sessionFlow ? yesNo(r.confirm_name_mismatch) : '',
    r.confirmed_at || '',
    Number(r.absent_count || 0),
    r.absent_names || '',
    view.DISCIPLINE_TEXT[r.discipline] || '',
  ];
}

function newJob(type) {
  const now = u.isoNow();
  const job = {
    id: store.newId(type === 'export' ? 'EJ' : 'IJ'),
    type: type,
    status: 'pending',
    total_rows: 0,
    success_rows: 0,
    fail_rows: 0,
    file_url: '',
    file_name: '',
    error_report_url: '',
    errors: [],
    params: {},
    operator_id: null,
    created_at: now,
    finished_at: null,
  };
  return job;
}

function runSoon(fn) {
  setImmediate(function () {
    try { fn(); } catch (e) { console.error('[job] 执行失败：' + (e && e.stack ? e.stack : e)); }
  });
}

/** POST /export/records：异步生成 CSV，返回 jobId */
function createExportRecords(user, body, ctx) {
  const b = body || {};
  const format = String(b.format || 'csv').toLowerCase();
  if (['csv', 'xlsx', 'excel'].indexOf(format) < 0) throw paramError('format 仅支持 csv（xlsx 按 csv 输出）');
  const job = newJob('export');
  job.params = {
    status: b.status || '', from: b.from || '', to: b.to || '', term: b.term || '',
    deptId: b.deptId || '', teacherId: b.teacherId || '', classId: b.classId || '',
    courseName: b.courseName || '', format: format, kind: 'records',
  };
  job.operator_id = user.id;
  store.insert('export_jobs', job);

  runSoon(function () {
    const list = records.queryRecords(user, job.params).filter(function (r) { return r.status !== 'revoked' || String(job.params.status).indexOf('revoked') >= 0; });
    job.total_rows = list.length;
    const csv = u.toCsv(EXPORT_HEADERS, list.map(recordRow));
    const fileName = 'records_' + u.stamp() + '.csv';
    fs.writeFileSync(path.join(u.EXPORT_DIR, fileName), csv, 'utf8');
    job.status = 'done';
    job.success_rows = list.length;
    job.file_url = fileName;
    job.file_name = fileName;
    job.finished_at = u.isoNow();
    store.touch('export_jobs');
    audit.log(ctx || { user: user }, 'export.records', {
      targetType: 'export_job', targetId: job.id,
      after: { rows: list.length, fileName: fileName, params: job.params },
      detail: '导出课时明细 CSV（' + list.length + ' 条）',
    });
  });
  return { jobId: job.id, status: job.status, type: 'records', format: format };
}

/** POST /export/stats：统计报表导出（按分院系汇总 + 明细两段） */
function createExportStats(user, body, ctx) {
  const b = body || {};
  const job = newJob('export');
  job.params = Object.assign({}, b, { kind: 'stats' });
  job.operator_id = user.id;
  store.insert('export_jobs', job);

  runSoon(function () {
    const o = { term: b.term || '', from: b.from || '', to: b.to || '', deptId: b.deptId || '' };
    const ov = stats.overview(user, o);
    const dept = stats.byDept(user, o);
    const teacher = stats.byTeacher(user, Object.assign({}, o, { page: 1, pageSize: 200 }));
    const course = stats.byCourse(user, o);
    const sections = [];
    sections.push('# 学时统计报表');
    sections.push('# 生成时间,' + u.isoNow() + ',,统计口径:仅"已确认/已补签"计入正式学时，补签单列');
    sections.push('');
    sections.push('## 全校概览');
    sections.push(['已确认学时', '补签学时', '应计学时', '完成率(%)', '待确认', '已过期', '异常', '现场指定签字人', '临时调整', '姓名不符'].join(','));
    sections.push([ov.confirmedHours, ov.makeupHours, ov.expectedHours, ov.completionRate, ov.waiting, ov.expired, ov.abnormal, ov.adhocCount, ov.tempAdjustedCount, ov.nameMismatchCount].join(','));
    sections.push('');
    sections.push('# 口径：学时按实际授课人归属（teacher_name，有 teacher_id 时优先用 id）；');
    sections.push('#      临时调整 = 本次换老师/改时间/改地点；姓名不符 = 确认人 ≠ 实际授课人（代课情形仍计学时）。');
    sections.push('');
    sections.push('## 分院系');
    sections.push(['院系', '已确认学时', '补签学时', '应计学时', '完成率(%)', '待确认', '已过期', '异常'].join(','));
    dept.list.forEach(function (d) {
      sections.push([d.name, d.hours, d.makeupHours, d.expectedHours, d.percent, d.waiting, d.expired, d.abnormal].map(u.csvCell).join(','));
    });
    sections.push('');
    sections.push('## 分教师');
    sections.push(['教师', '工号', '院系', '已确认学时', '补签学时', '完成率(%)', '记录数'].join(','));
    teacher.rank.forEach(function (t) {
      sections.push([t.name, t.staffNo, t.deptName, t.hours, t.makeupHours, t.percent, t.recordCount].map(u.csvCell).join(','));
    });
    sections.push('');
    sections.push('## 分课程');
    sections.push(['课程代码', '课程', '已确认学时', '补签学时', '记录数', '教学班数'].join(','));
    course.list.forEach(function (c) {
      sections.push([c.courseCode, c.courseName, c.hours, c.makeupHours, c.recordCount, c.classCount].map(u.csvCell).join(','));
    });

    const csv = '\ufeff' + sections.join('\r\n') + '\r\n';
    const fileName = 'stats_' + u.stamp() + '.csv';
    fs.writeFileSync(path.join(u.EXPORT_DIR, fileName), csv, 'utf8');
    job.total_rows = dept.list.length + teacher.rank.length + course.list.length;
    job.success_rows = job.total_rows;
    job.status = 'done';
    job.file_url = fileName;
    job.file_name = fileName;
    job.finished_at = u.isoNow();
    store.touch('export_jobs');
    audit.log(ctx || { user: user }, 'export.stats', {
      targetType: 'export_job', targetId: job.id,
      after: { fileName: fileName, overview: ov }, detail: '导出统计报表 CSV',
    });
  });
  return { jobId: job.id, status: job.status, type: 'stats', format: 'csv' };
}

/** GET /export/{jobId}：进度 + 鉴权下载地址（1 小时有效） */
function getExportJob(user, jobId) {
  const job = store.findById('export_jobs', jobId);
  if (!job) throw fail(CODES.NOT_FOUND, '导出任务不存在：' + jobId);
  if (user.role !== 'admin' && user.role !== 'dept_admin' && String(job.operator_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '无权查看该导出任务');
  }
  const out = {
    jobId: job.id,
    id: job.id,
    type: job.type,
    kind: job.params && job.params.kind,
    status: job.status,
    totalRows: job.total_rows,
    successRows: job.success_rows,
    failRows: job.fail_rows,
    fileName: job.file_name || '',
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    downloadUrl: '',
    expireAt: '',
  };
  if (job.status === 'done' && job.file_url) {
    const expMs = Date.now() + u.EXPORT_URL_TTL_MS;
    const token = exportToken(job.id, expMs);
    out.downloadUrl = '/api/v1/files/' + job.file_url + '?token=' + encodeURIComponent(token) + '&exp=' + expMs;
    out.expireAt = u.isoNow(new Date(expMs));
  }
  return out;
}

/** 导出任务列表（后台「报表导出中心」用） */
function listExportJobs(user, q) {
  const o = q || {};
  let list = store.all('export_jobs').slice();
  // 非教务处只能看自己创建的导出任务
  if (user.role !== 'admin' && user.role !== 'dept_admin') {
    list = list.filter(function (j) { return String(j.operator_id) === String(user.id); });
  }
  if (o.status) list = list.filter(function (j) { return String(j.status) === String(o.status); });
  if (o.kind) list = list.filter(function (j) { return String(j.params && j.params.kind) === String(o.kind); });
  if (o.from) list = list.filter(function (j) { return String(j.created_at).slice(0, 10) >= String(o.from); });
  if (o.to) list = list.filter(function (j) { return String(j.created_at).slice(0, 10) <= String(o.to); });
  list.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const page = Math.max(1, parseInt(o.page || 1, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(o.pageSize || 20, 10) || 20));
  const start = (page - 1) * pageSize;
  return {
    list: list.slice(start, start + pageSize).map(function (j) {
      // 复用 getExportJob 生成带鉴权的短期下载链接
      const shaped = getExportJob(user, j.id);
      return {
        jobId: shaped.jobId, id: shaped.id, type: shaped.type, kind: shaped.kind,
        status: shaped.status, totalRows: shaped.totalRows, successRows: shaped.successRows,
        failRows: shaped.failRows, fileName: shaped.fileName,
        downloadUrl: shaped.downloadUrl, expireAt: shaped.expireAt,
        operatorId: j.operator_id, operatorName: view.userName(j.operator_id) || '',
        createdAt: shaped.createdAt, finishedAt: shaped.finishedAt,
      };
    }),
    total: list.length, page: page, pageSize: pageSize,
  };
}

// ---------------------------------------------------------------- 下载令牌（短期有效）
function exportToken(jobId, expireAtMs) {
  return u.hmacSha256('export|' + jobId + '|' + expireAtMs, u.TOKEN_SECRET);
}

function verifyExportToken(jobId, expireAtMs, token) {
  if (!token || !expireAtMs) return false;
  if (Number(expireAtMs) < Date.now()) return false;
  return u.timingEqual(token, exportToken(jobId, expireAtMs));
}

// ---------------------------------------------------------------- 导入
function normHeader(h) {
  return String(h || '').replace(/\s|\ufeff/g, '');
}

function headerIndexOf(headers, name, type) {
  const target = normHeader(name);
  const alts = [target];
  const altMap = IMPORT_HEADERS_ALT[type] && IMPORT_HEADERS_ALT[type][name];
  if (altMap) altMap.forEach(function (a) { alts.push(normHeader(a)); });
  for (let i = 0; i < headers.length; i++) {
    if (alts.indexOf(normHeader(headers[i])) >= 0) return i;
  }
  return -1;
}

/** 按表头定位列（无表头时按契约固定顺序） */
function buildRowReader(parsed, type, errors) {
  const expected = IMPORT_HEADERS[type];
  const headers = parsed.headers || [];
  let idx = expected.map(function (h) { return headerIndexOf(headers, h, type); });
  const headerLooksValid = headers.length >= Math.ceil(expected.length / 2) && idx.filter(function (i) { return i >= 0; }).length >= Math.ceil(expected.length / 2);
  if (!headerLooksValid) {
    // 回退：按固定列顺序（无表头文件）
    idx = expected.map(function (h, i) { return i; });
    return { headerless: true, get: function (row, i) { return row.__cells ? row.__cells[i] : ''; }, headers: expected };
  }
  return {
    headerless: false,
    headers: headers,
    get: function (row, i) { return idx[i] >= 0 ? String(row[headers[idx[i]]] === undefined ? '' : row[headers[idx[i]]]).trim() : ''; },
  };
}

/** 从校验错误信息里提取字段名（约定用「」包裹字段，如 第 1 列「工号」不能为空） */
function fieldOf(msg) {
  const m = /「([^」]+)」/.exec(String(msg || ''));
  return m ? m[1] : '';
}

/** 解析 + 全量校验（不落库），导入与预校验共用同一套规则，保证「预校验结果 = 实际导入结果」 */
function analyse(type, buffer) {
  if (IMPORT_TYPES.indexOf(type) < 0) throw paramError('type 仅支持 ' + IMPORT_TYPES.join('|'));
  if (!buffer || !buffer.length) throw paramError('CSV 文件不能为空（multipart 字段名 file）');
  let text = buffer.toString('utf8');
  if (text.indexOf('\u0000') >= 0) text = text.replace(/\u0000/g, '');
  const parsed = u.parseCsv(text);
  if (!parsed.rows.length) throw paramError('CSV 没有数据行');

  const errors = [];
  const staged = [];
  const reader = buildRowReader(parsed, type, errors);

  parsed.rows.forEach(function (row, i) {
    const lineNo = i + (reader.headerless ? 1 : 2);
    try {
      const rec = validateRow(type, reader, row, lineNo);
      rec.lineNo = lineNo;
      staged.push(rec);
    } catch (e) {
      errors.push({ line: lineNo, field: fieldOf(e.message), msg: e.message, raw: row });
    }
  });

  // 主数据：同一文件内不得出现重复键（否则后面的行会覆盖前面的行，属于静默丢数据）
  if (MASTER_OF[type]) {
    const label = MASTER_OF[type].label;
    const firstAt = {};
    staged.forEach(function (s) {
      if (firstAt[s.key] === undefined) firstAt[s.key] = s.lineNo;
      else {
        s.dup = true;
        errors.push({
          line: s.lineNo, field: label + '名称',
          msg: '与第 ' + firstAt[s.key] + ' 行重复（同一文件内' + label + '「' + s.name + '」出现多次），请合并为一行',
          raw: parsed.rows[s.lineNo - (reader.headerless ? 1 : 2)],
        });
      }
    });
    if (errors.length) {
      for (let i = staged.length - 1; i >= 0; i--) if (staged[i].dup) staged.splice(i, 1);
    }
  }
  return { parsed: parsed, reader: reader, staged: staged, errors: errors };
}

/** 预校验用数据预览：按契约固定列顺序取前若干行 */
function previewRows(reader, rows, limit) {
  const out = [];
  const n = Math.min(rows.length, limit);
  for (let i = 0; i < n; i++) {
    const cells = [];
    for (let c = 0; c < 13; c++) cells.push(reader.get(rows[i], c));
    out.push(cells);
  }
  return out;
}

/**
 * 导入预校验（dry-run）：只校验不落库，返回逐行错误与可导入行数
 * 后台「数据导入中心」的「预校验结果」直接消费本结果。
 */
function precheck(user, type, buffer) {
  const a = analyse(type, buffer);
  const headers = IMPORT_HEADERS[type] || [];
  return {
    type: type,
    headers: headers,
    headerless: !!a.reader.headerless,
    totalRows: a.parsed.rows.length,
    importableRows: a.errors.length ? 0 : a.staged.length,
    validRows: a.staged.length,
    errorRows: a.errors.length,
    valid: a.errors.length === 0,
    errors: a.errors.slice(0, 200).map(function (e) {
      return { line: e.line, field: e.field, msg: e.msg };
    }),
    errorCount: a.errors.length,
    preview: { headers: headers, rows: previewRows(a.reader, a.parsed.rows, 10) },
    note: a.errors.length
      ? '存在校验不通过的行，整批不会入库（绝不静默丢弃脏数据）'
      : '全部行校验通过，可执行确认导入',
  };
}

/**
 * 导入快照：落库前把受影响的数据表整表备份到 data/snapshots/<jobId>.json
 * 便于「导入可回滚」（至少保留最近一次导入前的快照）
 */
function takeSnapshot(jobId, tables) {
  ensureSnapshotDir();
  const payload = { jobId: jobId, tables: {}, takenAt: u.isoNow() };
  tables.forEach(function (t) {
    payload.tables[t] = store.all(t).map(function (r) { return JSON.parse(JSON.stringify(r)); });
  });
  const file = 'snapshot_' + jobId + '.json';
  fs.writeFileSync(path.join(SNAPSHOT_DIR, file), JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 校验并落库（先全量校验，任一行失败则整批不落库） */
function importCsv(user, type, buffer, ctx) {
  const a = analyse(type, buffer);
  const parsed = a.parsed;
  const errors = a.errors;
  const staged = a.staged;

  const job = newJob('import');
  job.type = type;
  job.params = { type: type };
  job.operator_id = user.id;
  job.status = 'running';
  store.insert('import_jobs', job);

  job.total_rows = parsed.rows.length;
  job.fail_rows = errors.length;
  job.success_rows = errors.length ? 0 : staged.length;
  job.errors = errors.slice(0, 500);

  if (errors.length) {
    job.status = 'failed';
    const reportName = 'import_errors_' + job.id + '.csv';
    const csv = u.toCsv(['行号', '问题字段', '错误原因', '原始数据'], errors.map(function (e) {
      return [e.line, e.field || '', e.msg, JSON.stringify(e.raw)];
    }));
    fs.writeFileSync(path.join(u.EXPORT_DIR, reportName), csv, 'utf8');
    job.error_report_url = reportName;
    job.finished_at = u.isoNow();
    store.touch('import_jobs');
    audit.log(ctx, 'import.fail', {
      targetType: 'import_job', targetId: job.id,
      after: { type: type, total: job.total_rows, fail: errors.length, firstError: errors[0] },
      detail: '导入校验失败，未落库任何数据',
    });
    return { job: job, committed: false, errors: errors };
  }

  // 全部校验通过 → 先做快照（可回滚），再落库
  const tables = IMPORT_TABLES_OF[type] || [];
  try {
    job.snapshot_file = takeSnapshot(job.id, tables);
    job.snapshot_tables = tables;
  } catch (e) {
    console.error('[import] 快照写入失败（不影响导入）：' + (e && e.message));
  }

  commitRows(type, staged, user);
  job.status = 'done';
  job.finished_at = u.isoNow();
  store.touch('import_jobs');
  audit.log(ctx, 'import.success', {
    targetType: 'import_job', targetId: job.id,
    after: { type: type, rows: staged.length, snapshot: job.snapshot_file || '' }, detail: '导入成功并落库',
  });
  return { job: job, committed: true, errors: [] };
}

/**
 * 回滚最近一次导入（仅教务处）：用导入前快照恢复受影响的数据表
 * @returns {{ok:boolean, jobId:string, restored:string[], rows:number}}
 */
function rollbackImport(user, jobId, ctx) {
  const job = store.findById('import_jobs', jobId);
  if (!job) throw fail(CODES.NOT_FOUND, '导入任务不存在：' + jobId);
  if (job.status === 'rolled_back') throw fail(CODES.BAD_STATE, '该导入任务已回滚，不可重复回滚');
  if (job.status !== 'done') throw fail(CODES.BAD_STATE, '仅「导入成功」的任务可回滚，当前状态：' + job.status);
  if (!job.snapshot_file) throw fail(CODES.BAD_STATE, '该导入任务没有快照，无法回滚');
  const abs = path.join(SNAPSHOT_DIR, path.basename(String(job.snapshot_file)));
  if (!u.fileExists(abs)) throw fail(CODES.NOT_FOUND, '导入快照文件已丢失，无法回滚');
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw fail(CODES.SERVER, '导入快照解析失败：' + e.message);
  }
  const restored = [];
  let rows = 0;
  Object.keys(payload.tables || {}).forEach(function (t) {
    const data = payload.tables[t];
    if (!Array.isArray(data)) return;
    store.replaceAll(t, data);
    restored.push(t);
    rows += data.length;
  });
  job.status = 'rolled_back';
  job.rolled_back_at = u.isoNow();
  job.rolled_back_by = user.id;
  store.touch('import_jobs');
  audit.log(ctx, 'import.rollback', {
    targetType: 'import_job', targetId: job.id,
    after: { restored: restored, rows: rows, snapshot: job.snapshot_file },
    detail: '回滚导入：已用快照恢复 ' + restored.join('、'),
  });
  return { ok: true, jobId: job.id, restored: restored, rows: rows, rolledBackAt: job.rolled_back_at };
}

/** 导入历史列表（后台「数据导入中心」用） */
function listImportJobs(user, q) {
  const o = q || {};
  let list = store.all('import_jobs').slice();
  if (user.role === 'dept_admin') list = list.filter(function (j) { return String(j.operator_id) === String(user.id); });
  if (o.type) list = list.filter(function (j) { return String(j.type) === String(o.type); });
  if (o.status) list = list.filter(function (j) { return String(j.status) === String(o.status); });
  if (o.from) list = list.filter(function (j) { return String(j.created_at).slice(0, 10) >= String(o.from); });
  if (o.to) list = list.filter(function (j) { return String(j.created_at).slice(0, 10) <= String(o.to); });
  list.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const page = Math.max(1, parseInt(o.page || 1, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(o.pageSize || 20, 10) || 20));
  const start = (page - 1) * pageSize;
  return {
    list: list.slice(start, start + pageSize).map(function (j) {
      return {
        jobId: j.id, id: j.id, type: j.type, status: j.status,
        totalRows: j.total_rows, successRows: j.success_rows, failRows: j.fail_rows,
        operatorId: j.operator_id,
        operatorName: view.userName(j.operator_id) || '',
        errorReportUrl: j.error_report_url ? '/api/v1/files/' + j.error_report_url : '',
        snapshotFile: j.snapshot_file || '',
        canRollback: j.status === 'done' && !!j.snapshot_file,
        createdAt: j.created_at, finishedAt: j.finished_at,
        rolledBackAt: j.rolled_back_at || '',
      };
    }),
    total: list.length, page: page, pageSize: pageSize,
  };
}


function need(reader, row, i, label) {
  const v = reader.get(row, i);
  if (!v) throw new Error('第 ' + i + ' 列「' + label + '」不能为空');
  return v;
}

function weekdayOf(text) {
  const t = String(text || '').trim();
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  const m = /^(?:周|星期)?([一二三四五六日天])$/.exec(t);
  if (m) return map[m[1]];
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
  throw new Error('星期「' + t + '」无法识别（应为 1-7 或 周一…周日）');
}

function roleOf(text) {
  const t = String(text || '').trim();
  const map = {
    teacher: 'teacher', '教师': 'teacher', '任课教师': 'teacher',
    cadre: 'cadre', '班干部': 'cadre', '学委': 'cadre', '班长': 'cadre', '副班长': 'cadre',
    dept_admin: 'dept_admin', '院系管理员': 'dept_admin',
    admin: 'admin', '教务处': 'admin',
  };
  const hit = map[t];
  if (!hit) throw new Error('角色「' + t + '」无法识别（teacher/cadre/dept_admin/admin）');
  return hit;
}

/** 是否在用（未标注状态视为 active，与 classes.js 默认口径一致） */
function isActiveRow(r) {
  return String((r && r.status) || 'active') === 'active';
}

/** 名称匹配：优先 active 行（同名既有在用班又有归档班时，不再误配到归档行），无 active 才退回全部 */
function pickByName(table, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const all = store.all(table);
  const exact = all.filter(function (r) { return String(r.name).trim() === n; });
  const fuzzy = all.filter(function (r) { return String(r.name).indexOf(n) >= 0; });
  return exact.filter(isActiveRow)[0] || exact[0] || fuzzy.filter(isActiveRow)[0] || fuzzy[0] || null;
}

function findClassByName(name) {
  return pickByName('classes', name);
}

function findDeptByName(name) {
  return pickByName('depts', name);
}

/** 主数据引用解析（严格：ID 精确 → 名称完全相等；不做模糊匹配，避免「护理」误配「护理学院」） */
function resolveMaster(table, text, label) {
  const t = String(text || '').trim();
  if (!t) return null;
  const rows = store.all(table);
  const byId = rows.filter(function (r) { return String(r.id).trim() === t; })[0];
  if (byId) return byId;
  const byName = rows.filter(function (r) { return String(r.name).trim() === t; });
  if (byName.length > 1) throw new Error(label + '「' + t + '」匹配到 ' + byName.length + ' 条记录（ID：' + byName.map(function (r) { return r.id; }).join('/') + '），请改填 ID');
  return byName[0] || null;
}

/** 生成下一个主数据 ID（取现有最大序号 +1：D00000003 / C00000003 …） */
function nextMasterId(table, prefix) {
  let max = 0;
  const re = new RegExp('^' + prefix + '(\\d+)$');
  store.all(table).forEach(function (r) {
    const m = re.exec(String(r.id || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + String(max + 1).padStart(8, '0');
}

/** 状态文本 → active/archived/leave（空则用默认值） */
function masterStatusOf(text, dflt) {
  const t = String(text || '').trim();
  if (!t) return dflt;
  const hit = MASTER_STATUS_ALIASES[t] || MASTER_STATUS_ALIASES[t.toLowerCase()];
  if (!hit) throw new Error('状态「' + t + '」无法识别（应为 active/archived/leave，或 启用/归档/休学）');
  return hit;
}

function validateRow(type, reader, row, lineNo) {
  // ---- 主数据：院系（末列 院系ID 可选：留空按名称更新/新增，填写则按 ID 更新，可改名）----
  if (type === 'depts') {
    const name = need(reader, row, 0, '院系名称');
    const code = reader.get(row, 1);
    const parentText = reader.get(row, 2);
    const idText = reader.get(row, 3);
    let exist = null;
    if (idText) {
      exist = store.all('depts').filter(function (d) { return String(d.id).trim() === idText; })[0] || null;
      if (!exist) throw new Error('院系ID「' + idText + '」不存在（新增院系请留空该列，或改用「导出当前数据」获得正确 ID）');
    } else {
      exist = store.all('depts').filter(function (d) { return String(d.name).trim() === name; })[0] || null;
    }
    const clash = store.all('depts').filter(function (d) {
      return String(d.name).trim() === name && (!exist || String(d.id) !== String(exist.id));
    })[0];
    if (clash) throw new Error('院系名称「' + name + '」已被 ' + clash.id + ' 使用（同一名称不能对应两个院系；改名请填该行的院系ID）');
    let parent = null;
    if (parentText) {
      parent = resolveMaster('depts', parentText, '上级院系');
      if (!parent) throw new Error('上级院系「' + parentText + '」不存在（请先导入该院系，或留空表示顶级院系）');
      if (exist && String(parent.id) === String(exist.id)) throw new Error('上级院系不能是自己（' + name + '）');
    }
    return {
      kind: 'dept', exist: exist, name: name, code: code, parent: parent,
      key: exist ? String(exist.id) : 'name:' + name, lineNo: lineNo,
    };
  }

  // ---- 主数据：教学班（教学班ID 可选；所属院系必填；年级留空时从名称「2025级」自动识别）----
  if (type === 'classes') {
    const name = need(reader, row, 0, '教学班名称');
    let grade = reader.get(row, 1);
    if (!grade) {
      const m = /(\d{4})\s*级/.exec(name);
      if (m) grade = m[1];
    }
    const deptText = need(reader, row, 2, '所属院系');
    const idText = reader.get(row, 4);
    let exist = null;
    if (idText) {
      exist = store.all('classes').filter(function (c) { return String(c.id).trim() === idText; })[0] || null;
      if (!exist) throw new Error('教学班ID「' + idText + '」不存在（新增教学班请留空该列，或改用「导出当前数据」获得正确 ID）');
    } else {
      exist = store.all('classes').filter(function (c) { return String(c.name).trim() === name; })[0] || null;
    }
    const clash = store.all('classes').filter(function (c) {
      return String(c.name).trim() === name && (!exist || String(c.id) !== String(exist.id));
    })[0];
    if (clash) throw new Error('教学班名称「' + name + '」已被 ' + clash.id + ' 使用（同一名称不能对应两个教学班；改名请填该行的教学班ID）');
    const dept = resolveMaster('depts', deptText, '所属院系');
    if (!dept) throw new Error('所属院系「' + deptText + '」不存在（请先用「院系」页签导入院系，或改填院系ID）');
    const status = masterStatusOf(reader.get(row, 5), exist ? String(exist.status || 'active') : 'active');
    return {
      kind: 'class', exist: exist, name: name, grade: grade, dept: dept,
      advisor: reader.get(row, 3), status: status,
      key: exist ? String(exist.id) : 'name:' + name, lineNo: lineNo,
    };
  }

  if (type === 'tasks') {
    const term = reader.get(row, 0) || u.TERM_DEFAULT;
    const no = need(reader, row, 1, '工号');
    const teacherName = need(reader, row, 2, '教师姓名');
    const teacher = store.find('users', function (x) { return x.role === 'teacher' && String(x.staff_no) === no; });
    if (!teacher) throw new Error('工号 ' + no + ' 不存在（请先导入白名单或核对工号）');
    if (teacher.real_name !== teacherName) throw new Error('工号 ' + no + ' 对应教师为「' + teacher.real_name + '」，与「' + teacherName + '」不一致');
    const courseCode = reader.get(row, 3);
    const courseName = need(reader, row, 4, '课程名称');
    const className = need(reader, row, 5, '教学班');
    const cls = findClassByName(className);
    if (!cls) throw new Error('教学班「' + className + '」不存在');
    const weekday = weekdayOf(need(reader, row, 6, '星期'));
    const section = need(reader, row, 7, '节次');
    if (!/^\d+-\d+$/.test(section)) throw new Error('节次「' + section + '」格式应为 1-2');
    const startTime = reader.get(row, 8) || (u.SECTION_TIME[section] || ['08:00', '09:40'])[0];
    const endTime = reader.get(row, 9) || (u.SECTION_TIME[section] || ['08:00', '09:40'])[1];
    const place = reader.get(row, 10);
    const weeks = reader.get(row, 11) || '1-18';
    const hours = Number(reader.get(row, 12) || 2);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('学时「' + reader.get(row, 12) + '」应为正数');
    return {
      kind: 'course_task', term: term, teacher: teacher, courseCode: courseCode, courseName: courseName,
      cls: cls, weekday: weekday, section: section, startTime: startTime, endTime: endTime,
      place: place, weeks: weeks, hours: hours, lineNo: lineNo,
    };
  }
  if (type === 'students') {
    const no = need(reader, row, 0, '学号');
    const name = need(reader, row, 1, '姓名');
    const className = need(reader, row, 2, '教学班');
    const cls = findClassByName(className);
    if (!cls) throw new Error('教学班「' + className + '」不存在');
    return { kind: 'student', studentNo: no, realName: name, cls: cls, lineNo: lineNo };
  }
  if (type === 'whitelist') {
    const no = need(reader, row, 0, '工号/学号');
    const name = need(reader, row, 1, '姓名');
    const role = roleOf(need(reader, row, 2, '角色'));
    const deptName = reader.get(row, 3);
    const className = reader.get(row, 4);
    const dept = findDeptByName(deptName);
    if (deptName && !dept) throw new Error('院系「' + deptName + '」不存在');
    const cls = className ? findClassByName(className) : null;
    if (className && !cls) throw new Error('教学班「' + className + '」不存在');
    if (role === 'cadre' && !cls) throw new Error('班干部必须归属一个教学班');
    return { kind: 'whitelist', no: no, realName: name, role: role, dept: dept, cls: cls, lineNo: lineNo };
  }
  // cadres
  const className = need(reader, row, 0, '教学班');
  const cls = findClassByName(className);
  if (!cls) throw new Error('教学班「' + className + '」不存在');
  const studentNo = need(reader, row, 1, '学号');
  const name = need(reader, row, 2, '姓名');
  const duty = need(reader, row, 3, '职务');
  const priority = Number(reader.get(row, 4) || 1);
  if (!Number.isInteger(priority) || priority < 1) throw new Error('优先级「' + reader.get(row, 4) + '」应为 ≥1 的整数');
  return { kind: 'cadre', cls: cls, studentNo: studentNo, realName: name, duty: duty, priority: priority, lineNo: lineNo };
}

function commitRows(type, staged, user) {
  const now = u.isoNow();
  staged.forEach(function (s) {
    // ---- 主数据：院系（按 ID 或名称更新；不存在则新增；整行覆盖，不会删除任何行）----
    if (s.kind === 'dept') {
      if (s.exist) {
        Object.assign(s.exist, {
          name: s.name, code: s.code,
          parent_id: s.parent ? s.parent.id : null,
          updated_at: now,
        });
      } else {
        store.insert('depts', {
          id: nextMasterId('depts', 'D'), name: s.name, code: s.code,
          parent_id: s.parent ? s.parent.id : null, status: 'active',
          created_at: now, updated_at: now,
        });
      }
      return;
    }
    // ---- 主数据：教学班（按 ID 或名称更新；整行覆盖含状态；不会删除任何行）----
    if (s.kind === 'class') {
      if (s.exist) {
        Object.assign(s.exist, {
          name: s.name, grade: s.grade, dept_id: s.dept.id,
          advisor: s.advisor, status: s.status, updated_at: now,
        });
      } else {
        store.insert('classes', {
          id: nextMasterId('classes', 'C'), name: s.name, grade: s.grade,
          dept_id: s.dept.id, advisor: s.advisor, status: s.status,
          created_at: now, updated_at: now,
        });
      }
      return;
    }
    if (s.kind === 'course_task') {
      store.insert('course_tasks', {
        id: store.newId('T'), term: s.term,
        teacher_id: s.teacher.id, teacher_name: s.teacher.real_name, teacher_no: s.teacher.staff_no,
        course_code: s.courseCode, course_name: s.courseName,
        class_id: s.cls.id, class_name: s.cls.name, dept_id: s.cls.dept_id,
        weekday: s.weekday, section: s.section, start_time: s.startTime, end_time: s.endTime,
        place: s.place, weeks: s.weeks, hours: s.hours, coef: '1.0',
        source: 'import', status: 'active', created_at: now, updated_at: now,
      });
    } else if (s.kind === 'student') {
      const exist = store.find('students', function (x) {
        return String(x.student_no) === s.studentNo && String(x.class_id) === String(s.cls.id);
      });
      if (exist) { exist.real_name = s.realName; exist.status = 'active'; }
      else {
        store.insert('students', {
          id: store.newId('S'), student_no: s.studentNo, real_name: s.realName,
          class_id: s.cls.id, status: 'active', created_at: now,
        });
      }
    } else if (s.kind === 'whitelist') {
      const exist = store.find('whitelist', function (x) { return String(x.no) === s.no; });
      if (exist) {
        Object.assign(exist, { real_name: s.realName, role: s.role, dept_id: s.dept ? s.dept.id : null, class_id: s.cls ? s.cls.id : null, status: 'active' });
      } else {
        store.insert('whitelist', {
          id: store.newId('W'), no: s.no, real_name: s.realName, role: s.role,
          dept_id: s.dept ? s.dept.id : null, class_id: s.cls ? s.cls.id : null,
          status: 'active', created_at: now,
        });
      }
    } else if (s.kind === 'cadre') {
      // 优先复用已有用户档案（按学号或工号匹配，允许"教师兼任班干部"），不覆盖其原有角色
      let userRow = store.find('users', function (x) {
        return (x.student_no && String(x.student_no) === s.studentNo) ||
          (x.staff_no && String(x.staff_no) === s.studentNo) ||
          (x.real_name === s.realName && String(x.class_id) === String(s.cls.id));
      });
      if (!userRow) {
        userRow = store.insert('users', {
          id: store.newId('U'), openid: '', unionid: '', role: 'cadre', real_name: s.realName,
          staff_no: '', student_no: s.studentNo, dept_id: s.cls.dept_id, class_id: s.cls.id,
          phone: '', duty: s.duty, status: 'active', created_at: now, updated_at: now,
        });
        store.insert('whitelist', {
          id: store.newId('W'), no: s.studentNo, real_name: s.realName, role: 'cadre',
          dept_id: s.cls.dept_id, class_id: s.cls.id, status: 'active', created_at: now,
        });
      } else if (!userRow.student_no) {
        userRow.student_no = s.studentNo;
      }
      const exist = store.find('class_cadres', function (x) {
        return String(x.class_id) === String(s.cls.id) && String(x.user_id) === String(userRow.id);
      });
      if (exist) {
        Object.assign(exist, { duty: s.duty, priority: s.priority, status: 'active' });
      } else {
        store.insert('class_cadres', {
          id: store.newId('CC'), class_id: s.cls.id, user_id: userRow.id, duty: s.duty,
          priority: s.priority, status: 'active', start_at: now, end_at: null, created_at: now,
        });
      }
      if (s.duty) { userRow.duty = s.duty; }
    }
  });
}

function getImportJob(user, jobId) {
  const job = store.findById('import_jobs', jobId);
  if (!job) throw fail(CODES.NOT_FOUND, '导入任务不存在：' + jobId);
  if (user.role !== 'admin' && user.role !== 'dept_admin' && String(job.operator_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '无权查看该导入任务');
  }
  return {
    jobId: job.id,
    id: job.id,
    type: job.type,
    status: job.status,
    totalRows: job.total_rows,
    successRows: job.success_rows,
    failRows: job.fail_rows,
    errors: (job.errors || []).slice(0, 200),
    errorCount: (job.errors || []).length,
    errorReportUrl: job.error_report_url ? '/api/v1/files/' + job.error_report_url : '',
    createdAt: job.created_at,
    finishedAt: job.finished_at,
  };
}

/**
 * 导出当前主数据为可再导入的 CSV（带 ID，便于改名 / 改状态后重新导入）
 *  · 仅 depts / classes 支持；其他类型返回 null（由 template 回退到模板样例）
 */
function masterDataRows(type) {
  if (type === 'depts') {
    return store.all('depts').map(function (d) {
      const parent = d.parent_id ? store.findById('depts', d.parent_id) : null;
      return [d.name, d.code || '', parent ? parent.name : (d.parent_id || ''), d.id];
    });
  }
  if (type === 'classes') {
    return store.all('classes').map(function (c) {
      const dept = c.dept_id ? store.findById('depts', c.dept_id) : null;
      return [c.name, c.grade || '', dept ? dept.name : (c.dept_id || ''), c.advisor || '', c.id, String(c.status || 'active')];
    });
  }
  return null;
}

/**
 * GET /import/template?type= —— 标准模板（CSV，Excel 可直接打开）
 * @param {boolean} [withData] depts/classes 传 true 时导出「当前数据」而非样例（末列带 ID，可改名后重新导入）
 */
function template(type, withSample, withData) {
  const t = type && IMPORT_TYPES.indexOf(type) >= 0 ? type : 'tasks';
  const headers = IMPORT_HEADERS[t];
  const samples = {
    depts: [['护理学院', 'HL', '', ''], ['药学院', 'YX', '', '']],
    classes: [['2025级护理3班', '2025', '护理学院', '唐瑞明', '', 'active'], ['2025级药学1班', '2025', '药学院', '周慧敏', '', 'active']],
    tasks: [['2026-2027-1', '2010032', '唐瑞明', 'XXJS001', '信息技术', '2025级护理3班', '周三', '1-2', '08:00', '09:40', '实训楼A302', '1-18', '2']],
    students: [['2025030101', '李思琪', '2025级护理3班']],
    whitelist: [['2010032', '唐瑞明', 'teacher', '护理学院', ''], ['2025030117', '张一鸣', 'cadre', '护理学院', '2025级护理3班']],
    cadres: [['2025级护理3班', '2025030117', '张一鸣', '学委', '1']],
  };
  const exported = withData ? masterDataRows(t) : null;
  const rows = exported || (withSample === false ? [] : (samples[t] || []));
  return {
    type: t, headers: headers, csv: u.toCsv(headers, rows),
    exported: !!exported, totalRows: rows.length,
    fileName: exported ? 'export_' + t + '.csv' : 'template_' + t + '.csv',
  };
}

module.exports = {
  EXPORT_HEADERS, IMPORT_HEADERS, IMPORT_TYPES, IMPORT_TABLES_OF,
  createExportRecords, createExportStats, getExportJob, listExportJobs,
  exportToken, verifyExportToken,
  importCsv, precheck, getImportJob, listImportJobs, rollbackImport, template,
  recordRow, findClassByName, findDeptByName,
};
