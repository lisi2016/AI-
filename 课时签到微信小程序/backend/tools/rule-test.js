'use strict';
/**
 * 领域规则单元测试（不起 HTTP 服务，直接调用业务层）
 * 用临时数据目录运行，不污染正式 data/：
 *   node tools/rule-test.js
 *
 * 覆盖契约第四节「服务端必须做的校验」与状态机：
 *   1) 提交人 == 签字人 → 40302（需求 5.2 硬性）
 *   2) 唯一性 teacher+course+class+date+section → 40901
 *   3) 签字人不在 active 班干部名单 → 42202
 *   4) teach_date 不得为未来 → 40001
 *   5) 状态机：done 不可再改 / 非 wait 不可签名 → 42201
 *   6) 缺勤姓名匹配；自由文本长度限制 + 敏感词拦截（→ 40001，写审计日志）；
 *      定位信息已移除：传入 location 不报错且不落任何位置数据；签名证据固定四项
 *   7) 动态码一次性（41002）与过期（41001）；A+B 双通道：6 位数字口令（有效未消费码中唯一）、
 *      qr 载荷 kcsq://code/<codeId> 解析、{codeId}|{code}|{qrContent} 三种入参统一解析
 *   8) 记录列表统计口径：summary.statusTotals 不受 status= 筛选影响，按角色可见范围
 *      （教师=本人 / 班干部=签字人为本人 / 院系管理员=本院系 / 教务处=全部）统计 8 种状态
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsq-rule-'));
process.env.DATA_DIR = tmp;

const u = require('../src/util');
const store = require('../src/store');
const seed = require('../src/seed');
const view = require('../src/view');
const domain = require('../src/records');
const textfilter = require('../src/textfilter');
const { CODES } = require('../src/errors');

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail || '断言失败'); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 捕获业务函数抛出的错误码 */
function codeOf(fn) {
  try { fn(); return { code: 0 }; } catch (e) { return { code: e.code, msg: e.message, name: e.name }; }
}

console.log('领域规则单测（临时数据目录 ' + tmp + '）');
u.ensureDirs();
store.load();
const seedInfo = seed.create();
store.flushAll();

const teacher = store.find('users', function (x) { return x.role === 'teacher' && x.staff_no === '2010032'; });
const teacher2 = store.find('users', function (x) { return x.role === 'teacher' && x.staff_no === '2011045'; });
const cadre = store.find('users', function (x) { return x.role === 'cadre' && x.student_no === '2025030117'; });
const cadre2 = store.find('users', function (x) { return x.role === 'cadre' && x.student_no === '2025030102'; });
const task = store.find('course_tasks', function (t) { return String(t.teacher_id) === String(teacher.id); });
const ctx = { user: teacher, ip: '127.0.0.1', device: 'rule-test', traceId: 'rule' };
const pastDate = u.addDays(u.dateOnly(), -7);
const taskWeekday = Number(task.weekday);
// 取一个"与任务同星期 + 早于今天 + 无记录"的日期
let dateTry = pastDate;
for (let i = 0; i < 60 && (u.weekdayOf(dateTry) !== taskWeekday || view.recordOfTask(task.id, dateTry)); i++) {
  dateTry = u.addDays(dateTry, -1);
}
check(u.weekdayOf(dateTry) === taskWeekday && !view.recordOfTask(task.id, dateTry),
  '准备测试日期（与任务同星期且无历史记录）', dateTry + ' ' + u.WEEKDAY_CN[taskWeekday]);

// ---------------------------------------------------------------- 1 提交人 = 签字人
section('1. 提交人 ≠ 签字人（需求 5.2 硬性）');
{
  // 把教师自己也登记为该教学班的班干部（模拟"同一账号既是任课教师又被授权签字"）
  store.insert('class_cadres', {
    id: store.newId('CC'), class_id: task.class_id, user_id: teacher.id, duty: '学班',
    priority: 9, status: 'active', start_at: u.isoNow(), end_at: null, created_at: u.isoNow(),
  });
  const r = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerId: teacher.id }, ctx);
  });
  check(r.code === CODES.SELF_SIGN, '提交人指定本人为签字人 → 40302', 'code=' + r.code + ' msg=' + r.msg);

  const r2 = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerName: '唐瑞明' }, ctx);
  });
  check(r2.code === CODES.SELF_SIGN, '按签字人姓名传入本人 → 同样 40302', 'code=' + r2.code);
}

// ---------------------------------------------------------------- 2 签字人授权名单
section('2. 签字人必须在 active 班干部名单内');
{
  const r = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerId: teacher2.id }, ctx);
  });
  check(r.code === CODES.SIGNER_NOT_ALLOWED, '非本班班干部 → 42202', 'code=' + r.code + ' msg=' + r.msg);

  // 把班长置为请假（leave），指定其为签字人仍应通过（active 名单里还有学委/副班长）
  const leave = store.find('class_cadres', function (c) {
    return String(c.class_id) === String(task.class_id) && String(c.user_id) === String(cadre2.id);
  });
  leave.status = 'leave';
  const r2 = codeOf(function () {
    return domain.createRecord(teacher, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerId: cadre2.id }, ctx);
  });
  check(r2.code === CODES.SIGNER_NOT_ALLOWED, '班干部已请假（leave）→ 42202', 'code=' + r2.code);
  leave.status = 'active';
}

// ---------------------------------------------------------------- 3 正常发起 + 唯一性
section('3. 正常发起 / 唯一性 / 未来日期 / 定位入参被忽略');
let rec = null;
{
  const r = codeOf(function () {
    return domain.createRecord(teacher, {
      taskId: task.id, teachDate: dateTry, absentCount: 2, absentNames: '李思琪 张三不存在',
      discipline: 'normal', summary: '规则单测摘要', signerId: cadre.id,
      // 定位已从设计中移除：即使客户端依旧传入，也必须被忽略且不报错
      location: { lat: 28.228209, lng: 112.938814 },
      latitude: 28.228209, longitude: 112.938814, locationDenied: true,
    }, ctx);
  });
  check(r.code === 0, '正常发起成功（含 location/locationDenied 入参也不报错）', 'code=' + r.code);
  rec = store.filter('period_records', function (x) { return String(x.id) === String(store.all('period_records').slice(-1)[0].id); })[0];
  rec = store.all('period_records').slice(-1)[0];
  check(rec.status === 'wait' && String(rec.signer_id) === String(cadre.id), '状态 wait，签字人为指定班干部', rec.status + ' / ' + rec.signer_name + '(' + rec.signer_duty + ')');
  check(rec.deadline_at.indexOf('+08:00') > 0, 'deadline_at 为 Asia/Shanghai ISO8601', rec.deadline_at);

  const shaped = view.shapeRecord(rec, { viewer: teacher });
  const locKeys = Object.keys(shaped).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); });
  check(locKeys.length === 0, '记录视图不含 location/latitude/longitude/locationDenied 字段', locKeys.join(',') || '无位置字段');
  check(!store.all('signatures').some(function (s) { return String(s.record_id) === String(rec.id); }),
    '发起记录不再预写 t_signature 位置留痕（签名时才有证据行）');

  const dup = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(dup.code === CODES.DUP_RECORD, '重复发起 → 40901', 'code=' + dup.code);

  const future = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: u.addDays(u.dateOnly(), 1), absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(future.code === CODES.PARAM, 'teach_date 为未来 → 40001', 'code=' + future.code + ' msg=' + future.msg);

  const wrongDay = codeOf(function () {
    domain.createRecord(teacher, { taskId: task.id, teachDate: u.addDays(dateTry, 1), absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(wrongDay.code === CODES.PARAM, 'teach_date 与任务星期不符 → 40001', 'code=' + wrongDay.code);

  const notOwner = codeOf(function () {
    domain.createRecord(teacher2, { taskId: task.id, teachDate: dateTry, absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(notOwner.code === CODES.FORBIDDEN, '非本人授课任务发起 → 40301', 'code=' + notOwner.code);
}

// ---------------------------------------------------------------- 4 缺勤匹配 / 自由文本合规
section('4. 缺勤姓名匹配与自由文本合规（长度限制 + 敏感词拦截）');
{
  const absents = store.filter('absents', function (a) { return String(a.record_id) === String(rec.id); });
  const matched = absents.find(function (a) { return a.raw_name === '李思琪'; });
  const unmatched = absents.find(function (a) { return a.raw_name === '张三不存在'; });
  check(absents.length === 2 && matched.match_status === 'matched' && unmatched.match_status === 'unmatched',
    '缺勤姓名尽力匹配 t_student（matched / unmatched）',
    absents.map(function (a) { return a.raw_name + ':' + a.match_status; }).join(' '));

  // 4.0 textfilter 纯函数
  check(textfilter.lengthOf('中文abc') === 5 && textfilter.lengthOf('😀') === 1, '长度按 Unicode 码点计算（中文/emoji 各算 1 字符）',
    '中文abc=' + textfilter.lengthOf('中文abc') + ' emoji=' + textfilter.lengthOf('😀'));
  check(textfilter.parseWords('代签,包过、作弊 舞弊；黄牛').length === 5, '敏感词表支持逗号/顿号/空白/分号分隔',
    textfilter.parseWords('代签,包过、作弊 舞弊；黄牛').join('|'));
  check(textfilter.findHits('本次课存在代签行为', textfilter.DEFAULT_SENSITIVE_WORDS).indexOf('代签') >= 0,
    '命中检测：内置词表能识别「代签」');
  check(textfilter.validateWordList('代签,代签,包过').value === '代签,包过', '/config 词表归一化并去重',
    textfilter.validateWordList('代签,代签,包过').value);
  check(textfilter.validateWordList('a').ok === false && textfilter.validateWordList('').ok === true,
    '/config 词表校验：过短词被拒、空串表示不启用过滤（合法）');

  /** 找一个与任务同星期、无记录的日期 */
  function freeDate(from) {
    let d = from;
    for (let i = 0; i < 90 && (u.weekdayOf(d) !== taskWeekday || view.recordOfTask(task.id, d)); i++) d = u.addDays(d, -1);
    return d;
  }

  // 4.1 摘要命中敏感词 → 40001，且不落库，写审计日志
  const beforeCount = store.all('period_records').length;
  const sens = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: '本次课存在代签情况，包过是不可能的',
    }, ctx);
  });
  check(sens.code === CODES.PARAM && /内容包含敏感词/.test(String(sens.msg)) && sens.msg.indexOf('代签') >= 0,
    '摘要命中敏感词 → 40001「内容包含敏感词：xxx」', 'code=' + sens.code + ' msg=' + sens.msg);
  check(store.all('period_records').length === beforeCount, '命中敏感词的请求不落库（无脏数据）');
  const blockedLogs = store.filter('audit_logs', function (l) { return l.action === 'text.sensitive.blocked'; });
  check(blockedLogs.length >= 1 && String(blockedLogs[blockedLogs.length - 1].detail).indexOf('内容包含敏感词') >= 0,
    '命中敏感词已写操作日志（text.sensitive.blocked）',
    blockedLogs.length + ' 条，最后一条：' + (blockedLogs[blockedLogs.length - 1] || {}).detail);

  // 4.2 缺勤姓名命中敏感词 → 40001
  const sens2 = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 1, absentNames: '李思琪 代签', signerId: cadre.id,
    }, ctx);
  });
  check(sens2.code === CODES.PARAM && /内容包含敏感词/.test(String(sens2.msg)), '缺勤姓名命中敏感词 → 40001',
    'code=' + sens2.code + ' msg=' + sens2.msg);

  // 4.3 超长文本 → 40001（摘要 500 / 缺勤姓名 300）
  const overSummary = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: new Array(502).join('好'),
    }, ctx);
  });
  check(overSummary.code === CODES.PARAM && /过长/.test(String(overSummary.msg)),
    '摘要超过 500 字符 → 40001（提示长度上限）', 'code=' + overSummary.code + ' msg=' + overSummary.msg);
  const overAbsent = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      absentNames: new Array(302).join('李'),
    }, ctx);
  });
  check(overAbsent.code === CODES.PARAM && /过长/.test(String(overAbsent.msg)),
    '缺勤姓名超过 300 字符 → 40001', 'code=' + overAbsent.code + ' msg=' + overAbsent.msg);
  check(store.filter('audit_logs', function (l) { return l.action === 'text.invalid.blocked'; }).length >= 2,
    '超长文本同样写操作日志（text.invalid.blocked）');

  // 4.4 边界：正好 500 字符可以提交
  const edge = codeOf(function () {
    return domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: new Array(501).join('好'),
    }, ctx);
  });
  check(edge.code === 0, '摘要恰好 500 字符可通过（上限含端点）', 'code=' + edge.code);

  // 4.5 /config 覆盖 sensitive_words 后立即生效
  view.setConfig('sensitive_words', '测试禁词,违规词', 'system');
  const cfgPass = codeOf(function () {
    return domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: '本次课存在代签情况（覆盖词表后不再拦截）',
    }, ctx);
  });
  check(cfgPass.code === 0, '/config 覆盖 sensitive_words 后，原内置词不再拦截', 'code=' + cfgPass.code);
  const cfgBlock = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: '这是测试禁词，应被拦截',
    }, ctx);
  });
  check(cfgBlock.code === CODES.PARAM && String(cfgBlock.msg).indexOf('测试禁词') >= 0,
    '覆盖后的新敏感词立即生效（无需重启）', 'code=' + cfgBlock.code + ' msg=' + cfgBlock.msg);

  // 4.6 /config 调整长度上限后立即生效
  view.setConfig('max_summary_len', '10', 'system');
  const cfgShort = codeOf(function () {
    domain.createRecord(teacher, {
      taskId: task.id, teachDate: freeDate(dateTry), absentCount: 0, signerId: cadre.id,
      summary: '一二三四五六七八九十十一',
    }, ctx);
  });
  check(cfgShort.code === CODES.PARAM && String(cfgShort.msg).indexOf('最多 10 字符') >= 0,
    '/config 调整 max_summary_len=10 后立即生效', 'code=' + cfgShort.code + ' msg=' + cfgShort.msg);

  // 4.7 理由/备注同样受限
  view.setConfig('max_summary_len', u.DEFAULT_CONFIG.max_summary_len, 'system');
  view.setConfig('sensitive_words', u.DEFAULT_CONFIG.sensitive_words, 'system');
  const badReason = codeOf(function () { domain.rejectRecord(cadre, rec, '这个理由包含包过', ctx); });
  check(badReason.code === CODES.PARAM && /内容包含敏感词/.test(String(badReason.msg)),
    '拒绝原因（reason）命中敏感词 → 40001', 'code=' + badReason.code + ' msg=' + badReason.msg);
  const emptyReason = codeOf(function () { domain.rejectRecord(cadre, rec, '   ', ctx); });
  check(emptyReason.code === CODES.PARAM && /不能为空/.test(String(emptyReason.msg)),
    '拒绝原因空值 → 40001（明确提示必填）', 'code=' + emptyReason.code + ' msg=' + emptyReason.msg);
  const longReason = codeOf(function () { domain.rejectRecord(cadre, rec, new Array(502).join('因'), ctx); });
  check(longReason.code === CODES.PARAM && /过长/.test(String(longReason.msg)), '拒绝原因超长 → 40001',
    'code=' + longReason.code + ' msg=' + longReason.msg);
  check(rec.status === 'wait', '被拦截的拒绝请求未改变记录状态（仍为 wait）', rec.status);

  // 4.8 撤销原因同样受限，且被拦截时不得留下「已撤销」脏状态
  const revokeBlocked = codeOf(function () { domain.revokeRecord(teacher, rec, '这个撤销理由包含包过', ctx); });
  check(revokeBlocked.code === CODES.PARAM && /内容包含敏感词/.test(String(revokeBlocked.msg)),
    '撤销原因命中敏感词 → 40001', 'code=' + revokeBlocked.code + ' msg=' + revokeBlocked.msg);
  check(rec.status === 'wait', '被拦截的撤销请求未把记录改成 revoked（校验先于状态变更）', rec.status);
  const revokeTooLong = codeOf(function () { domain.revokeRecord(teacher, rec, new Array(502).join('由'), ctx); });
  check(revokeTooLong.code === CODES.PARAM && rec.status === 'wait', '撤销原因超长 → 40001 且状态不变',
    'code=' + revokeTooLong.code + ' status=' + rec.status);
  domain.revokeRecord(teacher, rec, '记录有误，撤销重发', ctx);
  check(rec.status === 'revoked' && rec.note === '记录有误，撤销重发', '合法原因可正常撤销', rec.status + ' / ' + rec.note);
}

// ---------------------------------------------------------------- 5 状态机
section('5. 状态机（draft→wait→done/rejected/expired/revoked）');
{
  // 签名需要"当天"记录（当天 24:00 前必须完成），因此补一条今天的授课任务
  const today = u.dateOnly();
  const todayWeekday = u.tzParts().weekday;
  const todayTask = store.insert('course_tasks', {
    id: store.newId('T'), term: task.term,
    teacher_id: teacher.id, teacher_name: teacher.real_name, teacher_no: teacher.staff_no,
    course_code: 'RULE001', course_name: '规则单测当天课', class_id: task.class_id, class_name: task.class_name,
    dept_id: task.dept_id, weekday: todayWeekday, section: '7-8', start_time: '16:00', end_time: '17:40',
    place: 'rule-test', weeks: '1-18', hours: 2, coef: '1.0', source: 'manual', status: 'active',
    created_at: u.isoNow(), updated_at: u.isoNow(),
  });
  const todayRecTry = codeOf(function () {
    return domain.createRecord(teacher, { taskId: todayTask.id, teachDate: today, absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(todayRecTry.code === 0, '当天记录发起成功（deadline 当天 24:00）',
    'task.weekday=' + todayTask.weekday + ' todayWeekday=' + todayWeekday + ' today=' + today + ' dateTry=' + dateTry +
    ' targetTask.weekday=' + task.weekday + ' code=' + todayRecTry.code + ' msg=' + todayRecTry.msg);
  const todayRec = store.all('period_records').slice(-1)[0];

  const raw = { size: 128, mimetype: 'image/png', originalname: 'sign.png', buffer: Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex') };

  const noFile = codeOf(function () { domain.signRecord(cadre, todayRec, null, {}, ctx); });
  check(noFile.code === CODES.PARAM, '未上传签名图 → 40001', 'code=' + noFile.code);

  const wrongSigner = codeOf(function () { domain.signRecord(cadre2, todayRec, raw, {}, ctx); });
  check(wrongSigner.code === CODES.FORBIDDEN, '非指定签字人签名 → 40301', 'code=' + wrongSigner.code);

  const teacherSign = codeOf(function () { domain.signRecord(teacher, todayRec, raw, {}, ctx); });
  check(teacherSign.code === CODES.FORBIDDEN, '教师签名 → 40301', 'code=' + teacherSign.code);

  const badFile = codeOf(function () { domain.signRecord(cadre, todayRec, { size: 10, mimetype: 'text/plain', originalname: 'a.txt', buffer: Buffer.from('x') }, {}, ctx); });
  check(badFile.code === CODES.PARAM, '非 png/jpg 签名图 → 40001', 'code=' + badFile.code);

  domain.signRecord(cadre, todayRec, raw, {
    latitude: 28.2, longitude: 112.9, locationDenied: true, lat: 28.2, lng: 112.9, device: 'rule-test',
  }, ctx);
  check(todayRec.status === 'done' && todayRec.confirmed_at, 'wait → done（写入签名证据；传入定位不报错）', todayRec.status);
  const sig = view.signatureOf(todayRec.id);
  check(sig && sig.image_hash && sig.image_hash.length === 64 && sig.device_info === 'rule-test' &&
    sig.latitude === null && sig.longitude === null && sig.location_denied === null,
    't_signature 记录图片 SHA-256 / 设备；位置三列固定 null（传入的定位被忽略）',
    sig.image_hash.slice(0, 16) + '… lat=' + sig.latitude + ' lng=' + sig.longitude + ' denied=' + sig.location_denied);
  const sigShaped = view.shapeRecord(todayRec, { viewer: cadre, signature: sig });
  const sigLocKeys = Object.keys(sigShaped).filter(function (k) { return /^(location|latitude|longitude|locationDenied)$/i.test(k); });
  check(sigLocKeys.length === 0, '签名后的记录视图同样不含任何位置字段', sigLocKeys.join(',') || '无位置字段');
  const ev = view.shapeEvidence(todayRec, sig);
  check(ev.count === 4 && (ev.labels || []).join('/') === '签名图/确认时间/设备/动态码',
    '签名证据固定四项（签名图/确认时间/设备/动态码）', 'count=' + ev.count + ' labels=' + (ev.labels || []).join('、'));
  check(ev.signatureFileId === sig.id && ev.device === 'rule-test' && ev.confirmedAt && ev.codeId === todayRec.code_id,
    '证据四项取值正确（签名图/确认时间/设备/动态码）',
    [ev.signatureFileId, ev.confirmedAt, ev.device, ev.codeId].join(' | '));

  const reSign = codeOf(function () { domain.signRecord(cadre, todayRec, raw, {}, ctx); });
  check(reSign.code === CODES.BAD_STATE, 'done 再签名 → 42201', 'code=' + reSign.code);
  const reReject = codeOf(function () { domain.rejectRecord(cadre, todayRec, '理由', ctx); });
  check(reReject.code === CODES.BAD_STATE, 'done 再拒绝 → 42201', 'code=' + reReject.code);

  domain.revokeRecord(teacher, todayRec, '教师撤销', ctx);
  check(todayRec.status === 'revoked', '任意状态 → revoked（教师本人）', todayRec.status);
  const reRevoke = codeOf(function () { domain.revokeRecord(teacher, todayRec, '', ctx); });
  check(reRevoke.code === CODES.BAD_STATE, '重复撤销 → 42201', 'code=' + reRevoke.code);

  // 撤销后可重新发起（唯一性只约束非 revoked）
  const redo = codeOf(function () {
    return domain.createRecord(teacher, { taskId: todayTask.id, teachDate: today, absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(redo.code === 0, '撤销后可重新发起同一天记录（唯一性排除 revoked）', 'code=' + redo.code);

  // 超时未确认 → expired（定时任务）
  const waitRec = store.all('period_records').slice(-1)[0];
  waitRec.deadline_at = u.isoNow(new Date(Date.now() - 3600 * 1000));
  store.touch('period_records');
  const job = domain.expireJob(ctx, {});
  check(job.expired >= 1 && waitRec.status === 'expired', '每日 00:05 定时任务：超期 wait → expired', 'expired=' + job.expired);

  const lateSign = codeOf(function () { domain.signRecord(cadre, waitRec, raw, {}, ctx); });
  check(lateSign.code === CODES.BAD_STATE, '过期后签名 → 42201（须走补签）', 'code=' + lateSign.code);
}

// ---------------------------------------------------------------- 6 补签与申诉
section('6. 补签与申诉流转');
{
  const deptAdmin = store.find('users', function (x) { return x.role === 'dept_admin'; });
  const admin = store.find('users', function (x) { return x.role === 'admin'; });
  const ctxAdmin = { user: admin, ip: '127.0.0.1' };
  const expired = store.find('period_records', function (x) { return x.status === 'expired'; });

  const mk = domain.applyMakeup(teacher, { recordId: expired.id, reason: '当天已授课，班干部请假' }, ctx);
  check(mk.status === 'pending', '教师对 expired 发起补签 → pending', mk.id);
  const dupMk = codeOf(function () { domain.applyMakeup(teacher, { recordId: expired.id, reason: '重复' }, ctx); });
  check(dupMk.code === CODES.BAD_STATE, '重复补签 → 42201', 'code=' + dupMk.code);
  const noReason = codeOf(function () {
    const other = store.find('period_records', function (x) { return x.status === 'rejected'; });
    domain.applyMakeup(teacher, { recordId: other ? other.id : expired.id, reason: '' }, ctx);
  });
  check(noReason.code === CODES.PARAM || noReason.code === CODES.BAD_STATE, '补签缺理由 → 40001/42201', 'code=' + noReason.code);

  const notApprover = codeOf(function () { domain.reviewMakeup(teacher, mk.id, true, {}, ctx); });
  check(notApprover.code === CODES.FORBIDDEN, '教师自审批补签 → 40301', 'code=' + notApprover.code);

  const approved = domain.reviewMakeup(deptAdmin, mk.id, true, { note: '核实无误' }, { user: deptAdmin });
  check(approved.record.status === 'makeup', '院系管理员通过 → 原记录置 makeup', approved.record.status);
  const reApprove = codeOf(function () { domain.reviewMakeup(deptAdmin, mk.id, true, {}, { user: deptAdmin }); });
  check(reApprove.code === CODES.BAD_STATE, '重复审核 → 42201', 'code=' + reApprove.code);

  // 申诉：需要一条 rejected 记录
  const rejRec = store.find('period_records', function (x) { return x.status === 'rejected'; });
  let apId = null;
  if (rejRec) {
    const ap = domain.applyAppeal(teacher, { recordId: rejRec.id, reason: '当天确实上课' }, ctx);
    apId = ap.id;
    check(rejRec.status === 'appealing', '教师申诉 → appealing', rejRec.status);
    const twice = codeOf(function () { domain.applyAppeal(teacher, { recordId: rejRec.id, reason: '再申诉' }, ctx); });
    check(twice.code === CODES.BAD_STATE, '二次申诉 → 42201（上限 1 次）', 'code=' + twice.code);
    const wrongRole = codeOf(function () { domain.reviewAppeal(teacher, apId, true, {}, ctx); });
    check(wrongRole.code === CODES.FORBIDDEN, '非教务处处理申诉 → 40301', 'code=' + wrongRole.code);
    const res = domain.reviewAppeal(admin, apId, true, { note: '查实通过' }, ctxAdmin);
    check(res.record.status === 'done', '教务处通过 → done', res.record.status);
  } else {
    ok('跳过申诉流程（无 rejected 记录）');
  }
}

// ---------------------------------------------------------------- 7 动态码
section('7. 动态确认码（60 秒 / 一次性 / 签名 / A+B 双通道）');
{
  /** 找一个与任务同星期、早于今天且无记录的日期 */
  function freeDate(startFrom) {
    let d = startFrom;
    for (let i = 0; i < 200; i++) {
      if (u.weekdayOf(d) === taskWeekday && !view.recordOfTask(task.id, d) && d < u.dateOnly()) return d;
      d = u.addDays(d, -1);
    }
    return null;
  }

  const code = domain.generateCode(cadre, { ttl: 60 });
  check(code.qr_payload === domain.QR_PREFIX + code.id && Math.round((code.expire_at_ms - code.created_at_ms) / 1000) === 60,
    '签发动态码：ttl=60，qr 载荷 = kcsq://code/<codeId>', code.qr_payload);
  check(domain.checkCode(code.id).id === code.id, '未消费可核验', code.id);

  // ---- A+B 双通道：6 位数字口令 + 二维码载荷解析
  check(/^\d{6}$/.test(String(code.code_value)) && String(code.code_value).length === 6,
    '生成时返回 6 位数字口令（B 通道）', 'code=' + code.code_value);
  check(domain.isPassCode(code.code_value) && !domain.isPassCode('12345') && !domain.isPassCode('1234567'),
    '口令格式判定：恰好 6 位数字', '12345/1234567 均判为非口令');
  {
    // 二维码载荷解析（A 通道）
    const p1 = domain.parseCodeContent(code.qr_payload);
    check(p1 && p1.codeId === code.id, '解析 kcsq://code/<codeId> → codeId', JSON.stringify(p1));
    const p2 = domain.parseCodeContent('kcsq://confirm?codeId=' + code.id + '&sign=x&exp=1');
    check(p2 && p2.codeId === code.id, '兼容解析历史载荷 kcsq://confirm?codeId=..', JSON.stringify(p2));
    const p3 = domain.parseCodeContent(code.code_value);
    check(p3 && p3.code === code.code_value && !p3.codeId, '解析裸 6 位口令 → code', JSON.stringify(p3));
    check(domain.parseCodeContent(code.id) && domain.parseCodeContent(code.id).codeId === code.id,
      '解析裸 codeId → codeId', code.id);
    check(domain.parseCodeContent('  这是一段无关文本  ') === null, '无关文本解析失败（前端可提示重扫）', 'null');

    // 三种入参统一解析
    const r1 = domain.resolveCodeRef({ codeId: code.id });
    check(r1.codeId === code.id && r1.by === 'codeId', '入参 {codeId} 解析成功', r1.by);
    const r2 = domain.resolveCodeRef({ code: code.code_value });
    check(r2.codeId === code.id && r2.by === 'code', '入参 {code}（6 位口令）解析成功', r2.by);
    const r3 = domain.resolveCodeRef({ qrContent: code.qr_payload });
    check(r3.codeId === code.id && r3.by === 'qrContent', '入参 {qrContent}（扫码内容）解析成功', r3.by);
    const r4 = domain.resolveCodeRef({ code: code.id });
    check(r4.codeId === code.id && r4.by === 'code', '兼容：非 6 位数字的 {code} 按 codeId 处理', r4.by);
    const r5 = domain.resolveCodeRef({});
    check(!r5.codeId && r5.invalid === true, '空入参 → 标记为非法（路由返回 40001）', JSON.stringify(r5));
    const r6 = domain.resolveCodeRef({ code: '999999' });
    check(!r6.codeId && r6.by === 'code' && r6.passCode === '999999', '不存在的口令解析不到 codeId（路由返回 40401）', JSON.stringify(r6));
  }

  // 口令在当前有效且未消费的码中唯一
  {
    const active = [];
    for (let i = 0; i < 30; i++) active.push(domain.generateCode(cadre, { ttl: 60 }));
    const seen = {};
    let dup = 0;
    active.forEach(function (c) {
      if (seen[c.code_value]) dup++;
      seen[c.code_value] = 1;
    });
    check(dup === 0, '连续签发 30 个码：有效未消费的码中口令互不重复', '唯一口令 ' + Object.keys(seen).length + ' 个');
    // 已消费的码：口令仍能查到该码，但核验统一返回 41002（与 codeId 通道语义一致）
    const victim = active[0];
    domain.consumeCode(victim, cadre, 'R-MOCK');
    const hit = domain.findCodeByPass(victim.code_value);
    check(hit && hit.id === victim.id, '已消费的码仍能按口令定位（便于返回 41002 而不是 40401）', victim.code_value);
    const usedErr = codeOf(function () { domain.checkCode(hit.id); });
    check(usedErr.code === CODES.CODE_USED, '已消费口令核验 → 41002', 'code=' + usedErr.code);
  }

  // 用该码发起一条全新记录
  const d1 = freeDate(u.addDays(dateTry, -1));
  const created = domain.createRecord(teacher, { codeId: code.id, taskId: task.id, teachDate: d1, absentCount: 0, signerId: cadre.id }, ctx);
  check(created.record.status === 'wait' && created.record.code_id === code.id, '用动态码发起成功并绑定 code_id', created.record.id + ' / ' + d1);

  // 换一条新日期，用同一个码再发起 → 41002（码已消费）
  const d2 = freeDate(u.addDays(d1, -1));
  const reuse = codeOf(function () {
    domain.createRecord(teacher, { codeId: code.id, taskId: task.id, teachDate: d2, absentCount: 0, signerId: cadre.id }, ctx);
  });
  check(reuse.code === CODES.CODE_USED, '同一码二次消费（另一条记录）→ 41002', 'code=' + reuse.code);

  const code4 = domain.generateCode(cadre, { ttl: 60 });
  code4.expire_at_ms = Date.now() - 1000; // 人为置过期
  store.touch('codes');
  const expired = codeOf(function () { domain.checkCode(code4.id); });
  check(expired.code === CODES.CODE_EXPIRED, '过期动态码 → 41001', 'code=' + expired.code);

  const notExist = codeOf(function () { domain.checkCode('CD-NOT-EXIST'); });
  check(notExist.code === CODES.NOT_FOUND, '不存在的动态码 → 40401', 'code=' + notExist.code);

  // 「拒绝」动作：另起一条 wait 记录，由班干部拒绝
  const d3 = freeDate(u.addDays(d2, -1));
  const rejRec = domain.createRecord(teacher, { taskId: task.id, teachDate: d3, absentCount: 0, signerId: cadre.id }, ctx).record;
  domain.rejectRecord(cadre, rejRec, '当天实际为自习', ctx);
  check(rejRec.status === 'rejected', '班干部拒绝 → rejected（写日志）', rejRec.id + ' / ' + d3);
}

// ---------------------------------------------------------------- 8 审计哈希链
section('8. 操作日志哈希链');
{
  const audit = require('../src/audit');
  // 签发动态码的日志由路由层写入，这里补一条模拟
  audit.log(ctx, 'code.generate', { targetType: 'code', targetId: domain.generateCode(cadre, { ttl: 60 }).id, detail: '规则单测：签发动态码' });
  const chain = audit.verifyChain();
  check(chain.ok === true && chain.total > 10, '哈希链完整', 'total=' + chain.total + ' head=' + String(chain.headHash).slice(0, 12) + '…');
  const actions = Array.from(new Set(store.all('audit_logs').map(function (l) { return l.action; })));
  const required = ['record.create', 'record.sign', 'record.revoke', 'record.reject', 'makeup.apply', 'makeup.approve', 'appeal.apply', 'appeal.approve', 'code.generate', 'record.expire'];
  const missing = required.filter(function (a) { return actions.indexOf(a) < 0; });
  check(missing.length === 0, '关键动作均已留痕', missing.length ? '缺少 ' + missing.join(',') : actions.length + ' 类动作');

  // 篡改检测
  const row = store.all('audit_logs')[3];
  const backup = row.detail;
  row.detail = '被人为篡改的内容';
  const broken = audit.verifyChain();
  check(broken.ok === false && broken.brokenAt === row.id, '篡改日志后可检测（brokenAt=' + broken.brokenAt + '）', broken.reason);
  row.detail = backup;
  check(audit.verifyChain().ok === true, '恢复后链校验重新通过');
}

// ---------------------------------------------------------------- 9 配置兼容与迁移
section('9. 配置兼容与迁移（旧键名 / 旧内置词表）');
{
  // 模拟「升级前的库」：只有旧键 max_summary_length 与旧内置 4 词词表
  store.replaceAll('configs', store.all('configs').filter(function (c) {
    return ['max_summary_len', 'sensitive_words'].indexOf(String(c.key)) < 0;
  }));
  store.insert('configs', { id: store.newId('CFG'), key: 'max_summary_length', value: '260', updated_by: 'system', updated_at: u.isoNow() });
  store.insert('configs', { id: store.newId('CFG'), key: 'sensitive_words', value: '代签,作弊,包过,黄牛', updated_by: 'system', updated_at: u.isoNow() });
  view.configMap(true);
  check(view.configNum('max_summary_len') === 260,
    '旧键 max_summary_length 在新键缺失时仍生效（读取兼容）', 'max_summary_len=' + view.configNum('max_summary_len'));

  const migrated = view.migrateLegacyConfig('system');
  check(migrated.length === 2, '启动迁移同时处理旧键与旧内置词表', migrated.join('；'));
  check(view.configMap(true).max_summary_len === '260', '迁移保留原有长度值（不覆盖为默认）', view.configMap(true).max_summary_len);
  check(view.sensitiveWords().length === textfilter.DEFAULT_SENSITIVE_WORDS.length,
    '旧内置 4 词词表升级为新的内置通用中文敏感词表', view.sensitiveWords().length + ' 条');

  // 管理员自定义过的词表不应被迁移覆盖
  view.setConfig('sensitive_words', '只保留这一个词', 'system');
  const again = view.migrateLegacyConfig('system');
  check(view.sensitiveWords().join(',') === '只保留这一个词' &&
    again.filter(function (x) { return x.indexOf('sensitive_words') >= 0; }).length === 0,
    '管理员自定义过的词表不会被迁移覆盖', '迁移动作：' + (again.join('；') || '无'));
  const third = view.migrateLegacyConfig('system');
  check(third.length === 0, '旧键已迁移完成时再次迁移无动作（幂等）', '动作 ' + third.length + ' 项');
}

// ---------------------------------------------------------------- 10 记录列表统计口径
section('10. 记录列表统计口径（statusTotals 不受 status= 筛选影响，按角色可见范围）');
{
  const admin = store.find('users', function (x) { return x.role === 'admin'; });
  const deptAdmin = store.find('users', function (x) { return x.role === 'dept_admin'; });
  const teacherT = store.find('users', function (x) { return x.role === 'teacher' && x.staff_no === '2010032'; });

  check(domain.RECORD_STATUSES.length === 8,
    'RECORD_STATUSES 固定 8 种状态', domain.RECORD_STATUSES.join('/'));

  const totals = domain.statusTotals(admin, {});
  check(domain.RECORD_STATUSES.every(function (s) { return typeof totals[s] === 'number'; }),
    'statusTotals 固定返回 8 种状态（无记录为 0）',
    domain.RECORD_STATUSES.map(function (s) { return s + '=' + totals[s]; }).join(' '));

  const filteredTotals = domain.statusTotals(admin, { status: 'wait' });
  check(JSON.stringify(filteredTotals) === JSON.stringify(totals),
    'status=wait 不影响 statusTotals（与不带筛选完全一致）', JSON.stringify(filteredTotals));

  const waitList = domain.queryRecords(admin, { status: 'wait' });
  const inner = domain.queryRecords(admin, {}, { ignoreStatus: true });
  const sum = domain.RECORD_STATUSES.reduce(function (a, s) { return a + Number(totals[s] || 0); }, 0);
  check(inner.length === domain.queryRecords(admin, {}).length && sum === inner.length,
    'ignoreStatus 只跳过 status 过滤（其它口径与普通查询一致）',
    'sum=' + sum + ' ignoreStatus=' + inner.length + ' 普通=' + domain.queryRecords(admin, {}).length);
  check(waitList.length === Number(totals.wait || 0) && waitList.length < sum,
    '受筛选的列表（仅 wait）与 statusTotals（全部状态）同时可得',
    'wait=' + waitList.length + ' 全部=' + sum);

  // 角色可见范围
  const tTotals = domain.statusTotals(teacherT, {});
  const tSum = domain.RECORD_STATUSES.reduce(function (a, s) { return a + Number(tTotals[s] || 0); }, 0);
  const tList = store.all('period_records').filter(function (r) { return String(r.teacher_id) === String(teacherT.id); });
  check(tSum === tList.length, '教师 statusTotals 只统计本人记录', tSum + ' vs ' + tList.length);
  check(tSum < sum, '教师可见范围严格小于教务处', tSum + ' < ' + sum);

  const cadreUser = store.find('users', function (x) { return x.role === 'cadre'; });
  const cTotals = domain.statusTotals(cadreUser, {});
  const cSum = domain.RECORD_STATUSES.reduce(function (a, s) { return a + Number(cTotals[s] || 0); }, 0);
  const cList = store.all('period_records').filter(function (r) { return String(r.signer_id) === String(cadreUser.id); });
  check(cSum === cList.length, '班干部 statusTotals 只统计"签字人为本人"的记录，且不因默认可见状态收窄',
    cSum + ' vs ' + cList.length);
  check(domain.queryRecords(cadreUser, {}).length <= cSum,
    '班干部默认列表会被"默认可见状态"收窄，而角标口径给出全部状态',
    domain.queryRecords(cadreUser, {}).length + ' <= ' + cSum);

  const dTotals = domain.statusTotals(deptAdmin, {});
  const dSum = domain.RECORD_STATUSES.reduce(function (a, s) { return a + Number(dTotals[s] || 0); }, 0);
  const dList = store.all('period_records').filter(function (r) { return String(r.dept_id) === String(deptAdmin.dept_id); });
  check(dSum === dList.length, '院系管理员 statusTotals 只统计本院系记录', dSum + ' vs ' + dList.length);
  check(dSum <= sum, '院系管理员可见范围 ≤ 教务处', dSum + ' ≤ ' + sum);

  // 其它筛选条件（非 status）仍然生效
  const termScoped = domain.statusTotals(admin, { term: '不存在的学期-9' });
  check(domain.RECORD_STATUSES.every(function (s) { return termScoped[s] === 0; }),
    '非 status 的筛选条件（term）仍然生效（角标与列表范围一致）', JSON.stringify(termScoped));
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(64));
console.log('领域规则单测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
if (failCount) {
  console.log('失败清单：');
  failures.forEach(function (f) { console.log('  - ' + f); });
}
console.log('='.repeat(64));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failCount ? 1 : 0);
