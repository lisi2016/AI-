'use strict';
/**
 * 路由 F：统计  +  G：导出  +  H：导入  +  I：配置 / 日志 / 文件
 */
const express = require('express');
const multer = require('multer');
const u = require('../util');
const store = require('../store');
const audit = require('../audit');
const auth = require('../auth');
const view = require('../view');
const stats = require('../stats');
const io = require('../io');
const domain = require('../records');
const textfilter = require('../textfilter');
const { CODES, fail, paramError } = require('../errors');
const { ok, wrap, parsePage, paginate } = require('../http');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: u.MAX_SIGNATURE_BYTES, files: 1 },
});
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// ================================================================ F. 统计
const STAT_ROLES = ['teacher', 'cadre', 'dept_admin', 'admin'];

router.get('/stats/overview', auth.requireRole(STAT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = Object.assign({}, req.query);
  // 教师只能看本人
  if (user.role === 'teacher') q.teacherId = user.id;
  if (user.role === 'cadre' && !q.deptId) q.deptId = user.dept_id ? String(user.dept_id) : '';
  return ok(res, stats.overview(user, q));
}));

router.get('/stats/by-dept', auth.requireRole(STAT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, stats.byDept(user, req.query || {}));
}));

router.get('/stats/by-teacher', auth.requireRole(STAT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = Object.assign({}, req.query);
  if (user.role === 'teacher') q.teacherId = user.id;
  return ok(res, stats.byTeacher(user, q));
}));

router.get('/stats/by-course', auth.requireRole(STAT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = Object.assign({}, req.query);
  if (user.role === 'teacher') q.teacherId = user.id;
  return ok(res, stats.byCourse(user, q));
}));

router.get('/stats/trend', auth.requireRole(STAT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = Object.assign({}, req.query);
  if (user.role === 'teacher') q.teacherId = user.id;
  return ok(res, stats.trend(user, q));
}));

// ================================================================ G. 导出
const EXPORT_ROLES = ['dept_admin', 'admin', 'teacher'];

router.post('/export/records', auth.requireRole(EXPORT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const body = Object.assign({}, req.body || {});
  if (user.role === 'teacher') body.teacherId = user.id; // 教师只能导出本人
  if (user.role === 'dept_admin') {
    body.deptId = body.deptId || user.dept_id;
    if (String(body.deptId) !== String(user.dept_id)) throw fail(CODES.FORBIDDEN, '只能导出本院系数据');
  }
  const out = io.createExportRecords(user, body, audit.ctxOf(req, user));
  return ok(res, out);
}));

router.post('/export/stats', auth.requireRole(['dept_admin', 'admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const body = Object.assign({}, req.body || {});
  if (user.role === 'dept_admin') body.deptId = user.dept_id;
  const out = io.createExportStats(user, body, audit.ctxOf(req, user));
  return ok(res, out);
}));

/** GET /export/history —— 导出任务列表（后台「报表导出中心」；必须注册在 /export/:jobId 之前） */
router.get('/export/history', auth.requireRole(EXPORT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, io.listExportJobs(user, req.query || {}));
}));

router.get('/export/:jobId', auth.requireRole(EXPORT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, io.getExportJob(user, req.params.jobId));
}));

// ================================================================ H. 导入
const IMPORT_ROLES = ['admin', 'dept_admin'];

router.get('/import/template', wrap(function (req, res) {
  const type = (req.query && req.query.type) || 'tasks';
  if (io.IMPORT_TYPES.indexOf(type) < 0) throw paramError('type 仅支持 ' + io.IMPORT_TYPES.join('|'));
  // data=1：导出「当前数据」（院系/教学班带 ID，可改名后重新导入）；默认导出模板样例
  const t = io.template(type, String(req.query && req.query.sample) !== '0', String(req.query && req.query.data) === '1');
  if (String(req.query && req.query.format) === 'json') {
    return ok(res, { type: t.type, headers: t.headers, exported: !!t.exported, totalRows: t.totalRows });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + t.fileName + '"');
  return res.status(200).send(t.csv);
}));

/**
 * POST /import/precheck —— 导入预校验（dry-run，只校验不落库）
 * 后台「数据导入中心」先调本接口展示逐行错误，校验通过后再调 /import/{type} 确认导入。
 * 注意：必须注册在 /import/:type 之前，避免被当作导入类型。
 */
router.post('/import/precheck', auth.requireRole(IMPORT_ROLES), uploadCsv.single('file'), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const type = String((req.query && req.query.type) || (req.body && req.body.type) || '').toLowerCase();
  if (io.IMPORT_TYPES.indexOf(type) < 0) throw paramError('type 仅支持 ' + io.IMPORT_TYPES.join('|'));
  let buffer = req.file ? req.file.buffer : null;
  if (!buffer && req.body && (req.body.csv || req.body.content)) {
    buffer = Buffer.from(String(req.body.csv || req.body.content), 'utf8');
  }
  return ok(res, io.precheck(user, type, buffer));
}));

/** GET /import/history —— 导入历史列表（必须注册在 /import/:jobId 之前） */
router.get('/import/history', auth.requireRole(IMPORT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, io.listImportJobs(user, req.query || {}));
}));

router.post('/import/:type', auth.requireRole(IMPORT_ROLES), uploadCsv.single('file'), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const type = String(req.params.type || '').toLowerCase();
  if (io.IMPORT_TYPES.indexOf(type) < 0) throw paramError('导入类型仅支持 ' + io.IMPORT_TYPES.join('|'));
  let buffer = req.file ? req.file.buffer : null;
  // 兼容：未使用 multipart 时允许 body.csv 传文本
  if (!buffer && req.body && (req.body.csv || req.body.content)) {
    buffer = Buffer.from(String(req.body.csv || req.body.content), 'utf8');
  }
  const out = io.importCsv(user, type, buffer, audit.ctxOf(req, user));
  return ok(res, {
    jobId: out.job.id,
    type: type,
    status: out.job.status,
    totalRows: out.job.total_rows,
    successRows: out.job.success_rows,
    failRows: out.job.fail_rows,
    committed: out.committed,
    errors: out.errors.slice(0, 50).map(function (e) {
      return { line: e.line, field: e.field || '', msg: e.msg };
    }),
    errorReportUrl: out.job.error_report_url ? '/api/v1/files/' + out.job.error_report_url : '',
    canRollback: !!out.job.snapshot_file,
    msg: out.committed
      ? '导入成功：' + out.job.success_rows + ' 行已落库'
      : '导入失败：' + out.errors.length + ' 行校验不通过，未写入任何数据（先校验后落库）',
  });
}));

router.get('/import/:jobId', auth.requireRole(IMPORT_ROLES), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, io.getImportJob(user, req.params.jobId));
}));

/** POST /import/{jobId}/rollback —— 用导入前快照回滚该次导入（仅教务处） */
router.post('/import/:jobId/rollback', auth.requireRole(['admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  return ok(res, io.rollbackImport(user, req.params.jobId, audit.ctxOf(req, user)));
}));

// ================================================================ I. 配置
router.get('/config', auth.requireRole(['admin', 'dept_admin', 'teacher', 'cadre']), wrap(function (req, res) {
  const map = view.configMap();
  const list = u.CONFIG_KEYS.map(function (key) {
    const row = store.find('configs', function (c) { return String(c.key) === key; });
    const item = {
      key: key,
      value: map[key],
      valueType: /^\d+(\.\d+)?$/.test(String(map[key])) ? 'number' : 'string',
      description: CONFIG_DESC[key] || '',
      updatedBy: row ? view.userName(row.updated_by) || row.updated_by : '',
      updatedAt: row ? row.updated_at : '',
    };
    // 长度类配置：把取值范围一并返回，便于后台输入框设置 min/max 并做前端预校验
    if (CONFIG_LEN_RANGE[key]) {
      item.min = CONFIG_LEN_RANGE[key][0];
      item.max = CONFIG_LEN_RANGE[key][1];
    }
    // 敏感词表：返回解析后的词条数（0 表示未启用过滤）
    if (key === 'sensitive_words') item.wordCount = textfilter.parseWords(map[key]).length;
    return item;
  });
  return ok(res, { config: map, list: list, terms: Array.from(new Set(store.all('course_tasks').map(function (t) { return t.term; }))) });
}));

const CONFIG_DESC = {
  hours_coef_theory: '理论课学时系数',
  hours_coef_practice: '实践课学时系数',
  hours_coef_training: '实训课学时系数',
  confirm_deadline_hour: '确认截止小时（24 = 当天 24:00）',
  code_ttl_seconds: '动态确认码有效期（秒）',
  makeup_approver_role: '补签审批角色（默认 dept_admin）',
  appeal_approver_role: '申诉处理角色（默认 admin）',
  urge_cooldown_minutes: '提醒签字人冷却时间（分钟）',
  term: '当前学期',
  sensitive_words: '敏感词表（逗号/顿号分隔，命中即 40001 拦截并写审计日志；留空表示不启用敏感词过滤）',
  max_summary_len: '授课摘要最大长度（字符）',
  max_absent_names_len: '缺勤姓名最大长度（字符）',
  max_reason_len: '理由 / 备注 / 审核意见最大长度（字符）',
};

/** 长度类配置的取值范围（含端点，整数） */
const CONFIG_LEN_RANGE = {
  max_summary_len: [1, 5000],
  max_absent_names_len: [1, 2000],
  max_reason_len: [1, 2000],
};

router.put('/config', auth.requireRole(['admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const body = req.body || {};
  const incoming = body.config && typeof body.config === 'object' ? body.config : body;
  const changed = [];
  const errors = [];
  Object.keys(incoming).forEach(function (key0) {
    if (key0 === 'config' || key0 === 'list') return;
    // 兼容历史键名（max_summary_length → max_summary_len）
    const key = u.CONFIG_ALIAS[key0] || key0;
    if (u.CONFIG_KEYS.indexOf(key) < 0) { errors.push({ key: key0, msg: '未知配置项' }); return; }
    let value = incoming[key0];
    if (key === 'makeup_approver_role' && ['dept_admin', 'admin'].indexOf(value) < 0) {
      errors.push({ key: key, msg: '必须为 dept_admin 或 admin' }); return;
    }
    if (key === 'appeal_approver_role' && ['admin', 'dept_admin'].indexOf(value) < 0) {
      errors.push({ key: key, msg: '必须为 admin 或 dept_admin' }); return;
    }
    // 敏感词表：解析 + 归一化（逗号分隔），并校验单个词长度与数量上限
    if (key === 'sensitive_words') {
      const vr = textfilter.validateWordList(value);
      if (!vr.ok) { errors.push({ key: key, msg: vr.msg }); return; }
      value = vr.value;
    }
    if (['confirm_deadline_hour', 'code_ttl_seconds', 'urge_cooldown_minutes'].indexOf(key) >= 0) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) { errors.push({ key: key, msg: '必须为 ≥0 的数字' }); return; }
      if (key === 'code_ttl_seconds' && (n < 10 || n > 600)) { errors.push({ key: key, msg: '动态码有效期应在 10-600 秒' }); return; }
    }
    // 自由文本长度上限：必须为区间内的整数
    if (CONFIG_LEN_RANGE[key]) {
      const range = CONFIG_LEN_RANGE[key];
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) { errors.push({ key: key, msg: '必须为整数' }); return; }
      if (n < range[0] || n > range[1]) {
        errors.push({ key: key, msg: '取值范围应为 ' + range[0] + '-' + range[1] }); return;
      }
    }
    if (['hours_coef_theory', 'hours_coef_practice', 'hours_coef_training'].indexOf(key) >= 0) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) { errors.push({ key: key, msg: '学时系数应为正数' }); return; }
    }
    const before = view.configMap()[key];
    view.setConfig(key, value, user.id);
    changed.push({ key: key, alias: key0 === key ? '' : key0, before: before, after: String(value) });
  });
  if (errors.length && !changed.length) throw paramError('配置校验失败：' + errors.map(function (e) { return e.key + ' ' + e.msg; }).join('；'), { errors: errors });
  if (changed.length) {
    audit.log(audit.ctxOf(req, user), 'config.update', {
      targetType: 'config', targetId: changed.map(function (c) { return c.key; }).join(','),
      before: changed.map(function (c) { return { key: c.key, value: c.before }; }),
      after: changed.map(function (c) { return { key: c.key, value: c.after }; }),
      detail: '更新规则配置：' + changed.map(function (c) { return c.key; }).join('、'),
    });
  }
  return ok(res, { changed: changed, errors: errors, config: view.configMap(), list: u.CONFIG_KEYS.map(function (k) { return { key: k, value: view.configMap()[k] }; }) });
}));

// ================================================================ I. 日志
router.get('/logs', auth.requireRole(['admin', 'dept_admin']), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const q = req.query || {};
  let list = store.all('audit_logs').slice();
  if (q.action) list = list.filter(function (l) { return String(l.action).indexOf(String(q.action)) >= 0; });
  if (q.actorId) list = list.filter(function (l) { return String(l.actor_id) === String(q.actorId); });
  if (q.targetType) list = list.filter(function (l) { return String(l.target_type) === String(q.targetType); });
  if (q.targetId) list = list.filter(function (l) { return String(l.target_id) === String(q.targetId); });
  if (q.from) list = list.filter(function (l) { return String(l.created_at).slice(0, 10) >= String(q.from); });
  if (q.to) list = list.filter(function (l) { return String(l.created_at).slice(0, 10) <= String(q.to); });
  list.reverse(); // 最新在前
  const p = parsePage(q);
  const page = paginate(list, p.page, p.pageSize);
  const verify = audit.verifyChain();
  return ok(res, {
    list: page.list.map(function (l) {
      return {
        id: l.id,
        actorId: l.actor_id,
        actorName: view.userName(l.actor_id) || l.actor_role,
        actorRole: l.actor_role,
        action: l.action,
        targetType: l.target_type,
        targetId: l.target_id,
        before: l.before_json,
        after: l.after_json,
        detail: l.detail,
        ip: l.ip,
        device: l.device,
        traceId: l.trace_id,
        createdAt: l.created_at,
        prevHash: l.prev_hash,
        hash: l.hash,
      };
    }),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    chain: verify,
    note: '哈希链：hash = SHA256(prev_hash + 本条内容)，可用 chain.ok 判断是否被篡改',
  });
}));

router.get('/logs/verify', auth.requireRole(['admin', 'dept_admin']), wrap(function (req, res) {
  return ok(res, audit.verifyChain());
}));

// ================================================================ I. 文件
/** POST /files/signature —— 签名图上传（< 2MB，png/jpg），返回 url（带鉴权的读取地址） */
router.post('/files/signature', auth.requireRole(['cadre', 'admin']), upload.single('signature'), wrap(function (req, res) {
  const user = auth.currentUser(req);
  const file = req.file;
  if (!file || !file.buffer || !file.buffer.length) throw paramError('请上传签名图（multipart 字段名 signature）');
  const ext = require('path').extname(file.originalname || '').toLowerCase();
  if (u.ALLOWED_IMAGE_EXT.indexOf(ext) < 0 && ['image/png', 'image/jpeg', 'image/jpg'].indexOf(String(file.mimetype).toLowerCase()) < 0) {
    throw paramError('仅支持 png/jpg');
  }
  if (file.size > u.MAX_SIGNATURE_BYTES) throw paramError('签名图超过 2MB 限制');
  const imageHash = u.sha256(file.buffer);
  const fileName = 'sign_' + user.id + '_' + u.randHex(8) + (ext || '.png');
  require('fs').writeFileSync(require('path').join(u.UPLOAD_DIR, fileName), file.buffer);
  const row = store.insert('signatures', {
    id: store.newId('SG'),
    record_id: u.cleanText((req.body && req.body.recordId) || '', 40),
    signer_id: user.id,
    image_url: 'data/uploads/' + fileName,
    signed_at: u.isoNow(),
    // 定位/位置信息已彻底移除：这三个列保留仅为兼容历史数据，新数据一律为空
    latitude: null, longitude: null, location_denied: null,
    device_info: u.cleanText(req.body && req.body.device, 100),
    code_id: '', ip: audit.ctxOf(req, user).ip, image_hash: imageHash,
    created_at: u.isoNow(),
  });
  audit.log(audit.ctxOf(req, user), 'file.upload.signature', {
    targetType: 'signature', targetId: row.id,
    after: { size: file.size, imageHash: imageHash, recordId: row.record_id }, detail: '上传签名图',
  });
  return ok(res, {
    id: row.id,
    fileId: row.id,
    url: '/api/v1/files/' + row.id,
    imageHash: imageHash,
    size: file.size,
    expireHint: '读取需携带 Authorization: Bearer <token>',
  });
}));

/**
 * GET /files/{id} —— 文件读取（需鉴权，签名图不公开访问）
 * 支持：签名图（按记录相关人鉴权）、导出/导入报告文件（按短期令牌或管理员鉴权）
 */
router.get('/files/:id', wrap(function (req, res) {
  const id = String(req.params.id || '');
  const q = req.query || {};

  // 1) 签名图
  const sig = store.findById('signatures', id);
  if (sig && sig.image_url) {
    const record = sig.record_id ? store.findById('period_records', sig.record_id) : null;
    if (record) {
      const user = auth.optionalUser(req);
      if (!user) throw fail(CODES.UNAUTH, '签名图需鉴权访问，请携带 Authorization: Bearer <token>');
      domain.assertCanReadRecord(user, record);
    } else {
      const user = auth.optionalUser(req);
      if (!user || (user.role !== 'admin' && String(sig.signer_id) !== String(user.id))) {
        throw fail(CODES.UNAUTH, '签名图需鉴权访问');
      }
    }
    const abs = require('path').join(u.DATA_DIR, sig.image_url.replace(/^data[\\/]/, ''));
    if (!u.fileExists(abs)) throw fail(CODES.NOT_FOUND, '签名图文件缺失');
    res.setHeader('Content-Type', sig.image_url.endsWith('.jpg') || sig.image_url.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Image-Hash', sig.image_hash || '');
    return res.sendFile(abs);
  }

  // 2) 导出/导入报告文件：优先短期令牌，其次管理员身份
  const fileName = require('path').basename(id);
  if (!/^[\w.\-]+\.csv$/i.test(fileName)) throw fail(CODES.NOT_FOUND, '文件不存在或已过期（签名图未上传时也无文件）');
  const abs = require('path').join(u.EXPORT_DIR, fileName);
  if (!u.fileExists(abs)) throw fail(CODES.NOT_FOUND, '文件不存在或已过期');

  const job = store.find('export_jobs', function (j) { return j.file_url === fileName || j.error_report_url === fileName; }) ||
    store.find('import_jobs', function (j) { return j.error_report_url === fileName; });
  const tokenOk = io.verifyExportToken(job ? job.id : fileName, q.exp, q.token);
  if (!tokenOk) {
    const user = auth.optionalUser(req);
    if (!user || (user.role !== 'admin' && user.role !== 'dept_admin' &&
      !(job && String(job.operator_id) === String(user.id)))) {
      throw fail(CODES.UNAUTH, '下载链接需鉴权或已过期（导出链接有效期 1 小时）');
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
  return res.sendFile(abs);
}));

/**
 * GET /test-report/{kind} —— 后台测试报告（kind=html|docx）
 * 安全：**必须登录**（Authorization: Bearer <token>）才能读取；文件存放在非公开目录 private/，
 * 不通过静态资源暴露，因此未登录者既看不到内容也无法枚举。
 */
router.get('/test-report/:kind', auth.requireAuth, wrap(function (req, res) {
  const kind = String(req.params.kind || '').toLowerCase();
  if (kind !== 'html' && kind !== 'docx') throw fail(CODES.NOT_FOUND, '不支持的文档类型（仅支持 html / docx）');
  const abs = require('path').join(u.ROOT_DIR, 'private', 'test-report.' + kind);
  if (!u.fileExists(abs)) throw fail(CODES.NOT_FOUND, '测试报告文件不存在，请先部署到 private/ 目录');
  audit.log(audit.ctxOf(req, auth.currentUser(req)), 'test.report.read', {
    targetType: 'file', targetId: 'test-report.' + kind, after: { kind: kind }, detail: '查看/下载后台测试报告',
  });
  if (kind === 'docx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="test-report.docx"');
    return res.sendFile(abs);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.sendFile(abs);
}));

module.exports = router;
