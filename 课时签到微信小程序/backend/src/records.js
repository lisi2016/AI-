'use strict';
/**
 * 核心业务：课时记录状态机 + 契约第四节「服务端必须做的校验」
 * 所有校验集中在 domain 层，路由只负责解析入参
 */
const fs = require('fs');
const path = require('path');
const u = require('./util');
const view = require('./view');
const store = require('./store');
const audit = require('./audit');
const auth = require('./auth');
const textfilter = require('./textfilter');
const freetext = require('./freetext');
const { CODES, fail, paramError } = require('./errors');

// ---------------------------------------------------------------- 自由文本合规
// 校验实现已抽到 src/freetext.js（课程清单 / 课时会话共用同一套口径）：
// 命中敏感词或超长 → 40001 + 审计日志（text.sensitive.blocked / text.invalid.blocked）
const checkFreeText = freetext.checkFreeText;
const limitOf = freetext.limitOf;

// ---------------------------------------------------------------- 动态码
// A+B 双通道：A 真二维码（应用内扫码），B 6 位数字口令（手输兜底）
// - code_value   = 6 位数字口令（当前有效且未消费的码中唯一）
// - qr_payload   = 'kcsq://code/<codeId>'（二维码要编码的字符串）
// - signature    = HMAC(codeId|expireAtMs)，服务端核验时校验，防伪造
const QR_PREFIX = 'kcsq://code/';
const PASS_CODE_LEN = 6;

/** 生成 6 位数字口令（000000–999999，允许前导零） */
function randomPassCode() {
  let s = String(Math.floor(Math.random() * 1000000));
  while (s.length < PASS_CODE_LEN) s = '0' + s;
  return s;
}

/** 二维码载荷：kcsq://code/<codeId> */
function qrPayloadOf(codeId) { return QR_PREFIX + String(codeId); }

/** 口令是否已被「当前有效且未消费」的码占用（保证同时可用的口令唯一） */
function passCodeInUse(passCode, nowMs) {
  const at = Number(nowMs || Date.now());
  return !!store.find('codes', function (c) {
    if (String(c.code_value) !== String(passCode)) return false;
    if (Number(c.used) === 1) return false;              // 已消费：口令可回收
    if (Number(c.expire_at_ms || 0) <= at) return false; // 已过期：口令可回收
    return true;
  });
}

/** 取一个未被占用的 6 位口令，冲突则重试 */
function allocPassCode() {
  for (let i = 0; i < 200; i++) {
    const candidate = randomPassCode();
    if (!passCodeInUse(candidate)) return candidate;
  }
  throw fail(CODES.SERVER, '动态码口令分配失败：当前有效动态码过多，请稍后重试');
}

function generateCode(user, opts) {
  const o = opts || {};
  const ttl = Math.max(10, Math.min(600, Number(o.ttl || view.configNum('code_ttl_seconds') || 60)));
  const nowMs = Date.now();
  const expireAtMs = nowMs + ttl * 1000;
  const id = store.newId('CD');
  const signed = auth.signCode(id, expireAtMs);
  const row = {
    id: id,
    // 6 位数字口令（A+B 双通道之 B：教师手输兜底）
    code_value: allocPassCode(),
    // 二维码载荷（A+B 双通道之 A：应用内扫码）
    qr_payload: qrPayloadOf(id),
    signature: signed.sig,
    issuer_id: user.id,
    issuer_role: user.role,
    class_id: o.classId || user.class_id || null,
    used: 0,
    used_at: null,
    used_by: null,
    record_id: null,
    // 课时会话码（班干部「发起课时 → 教师扫码确认」流程）：非空表示这是某次课时的动态码。
    // 旧课表流程签发的码固定为 null，/code/verify 据此回退到原「返回课表任务」行为。
    session_id: o.sessionId ? String(o.sessionId) : null,
    created_at_ms: nowMs,
    created_at: u.isoNow(),
    expire_at: u.isoNow(new Date(expireAtMs)),
    expire_at_ms: expireAtMs,
  };
  store.insert('codes', row);
  return row;
}

function findCode(codeId) {
  return store.findById('codes', codeId);
}

/** 是否为 6 位数字口令 */
function isPassCode(v) { return /^\d{6}$/.test(String(v || '').trim()); }

/**
 * 按 6 位口令查码
 * - 优先返回「未消费」的码（这样过期会正确返回 41001，而不是 40401）
 * - 若同一口令当前只有已消费的码，则返回它（核验时统一返回 41002，语义与 codeId 通道一致）
 * - 同时存在多条时取最新签发的一条；同一时刻有效未消费的码中口令保证唯一
 */
function findCodeByPass(passCode) {
  const list = store.filter('codes', function (c) {
    return String(c.code_value) === String(passCode);
  });
  if (!list.length) return null;
  list.sort(function (a, b) { return Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0); });
  const alive = list.filter(function (c) { return Number(c.used) !== 1; });
  return alive.length ? alive[0] : list[0];
}

/**
 * 解析扫码得到的字符串 → { codeId } 或 { code }（6 位口令），无法识别返回 null
 * 兼容三类内容：
 *   1) kcsq://code/<codeId>                     —— 本版本二维码载荷
 *   2) kcsq://confirm?codeId=..&sign=..&exp=..  —— 历史版本二维码载荷（兼容）
 *   3) 裸 codeId / 裸 6 位口令                   —— 手输或第三方扫码结果
 */
function parseCodeContent(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return null;

  // kcsq://code/<codeId>
  const m1 = /^kcsq:\/\/code\/([^/?#\s]+)$/i.exec(text);
  if (m1) return { codeId: decodeURIComponent(m1[1]), code: '' };

  // 历史载荷 / 任意带 codeId 查询参数的 URL
  const m2 = /[?&]codeId=([^&#\s]+)/i.exec(text);
  if (m2) return { codeId: decodeURIComponent(m2[1]), code: '' };

  // 裸 6 位数字口令
  if (isPassCode(text)) return { codeId: '', code: text };

  // 裸 codeId
  if (/^[A-Za-z]{1,8}[-_]?[A-Za-z0-9]{1,40}$/.test(text)) return { codeId: text, code: '' };

  return null;
}

/**
 * 统一解析三种入参（契约三.B）：{codeId} / {code} / {qrContent}
 * 返回 { codeId, by } —— by 取值 codeId | code | qrContent
 * 说明：历史客户端曾用 {code} 传 codeId，这里做兼容（非 6 位数字按 codeId 处理）
 */
function resolveCodeRef(body) {
  const b = body || {};
  const codeIdIn = b.codeId === undefined || b.codeId === null ? '' : String(b.codeId).trim();
  const codeIn = b.code === undefined || b.code === null ? '' : String(b.code).trim();
  const qrIn = b.qrContent === undefined || b.qrContent === null
    ? (b.qrText === undefined || b.qrText === null ? '' : String(b.qrText).trim())
    : String(b.qrContent).trim();

  if (qrIn) {
    const parsed = parseCodeContent(qrIn);
    if (!parsed) return { codeId: '', by: 'qrContent', invalid: true };
    if (parsed.codeId) return { codeId: parsed.codeId, by: 'qrContent' };
    const row = findCodeByPass(parsed.code);
    return { codeId: row ? row.id : '', by: 'qrContent', passCode: parsed.code };
  }
  if (codeIn) {
    if (isPassCode(codeIn)) {
      const row = findCodeByPass(codeIn);
      return { codeId: row ? row.id : '', by: 'code', passCode: codeIn };
    }
    return { codeId: codeIn, by: 'code' }; // 兼容：历史版本用 code 传 codeId
  }
  if (codeIdIn) return { codeId: codeIdIn, by: 'codeId' };
  return { codeId: '', by: '', invalid: true };
}

/** 校验动态码：不存在 → 40401；签名不符/已过期 → 41001；已消费 → 41002 */
function checkCode(codeId, opts) {
  const o = opts || {};
  const row = findCode(codeId);
  if (!row) throw fail(CODES.NOT_FOUND, '动态码不存在');
  if (Number(row.used) === 1 && !o.allowUsed) throw fail(CODES.CODE_USED, '动态码已被使用');
  if (!auth.verifyCodeSignature(row.id, row.expire_at_ms, row.signature)) {
    throw fail(CODES.CODE_EXPIRED, '动态码签名校验失败');
  }
  if (Date.now() > Number(row.expire_at_ms)) throw fail(CODES.CODE_EXPIRED, '动态码已过期，请班干部刷新');
  return row;
}

/** 一次性消费动态码 */
function consumeCode(row, user, recordId) {
  row.used = 1;
  row.used_at = u.isoNow();
  row.used_by = user ? user.id : null;
  row.record_id = recordId || null;
  store.touch('codes');
  return row;
}

// ---------------------------------------------------------------- 授课任务
function taskById(id) { return store.findById('course_tasks', id); }

/** 任务在指定日期是否落在上课周次内 */
function taskActiveOn(task, dateStr) {
  const weeks = String(task.weeks || '').trim();
  if (!weeks) return true;
  const wk = u.termWeekOf(dateStr, task.term);
  const parts = weeks.split(/[,，]/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (m) {
      if (wk >= Number(m[1]) && wk <= Number(m[2])) return true;
    } else if (/^\d+$/.test(seg) && wk === Number(seg)) {
      return true;
    }
  }
  return false;
}

/** 某教师某日的授课任务（含当日单双周/周次过滤） */
function tasksOfTeacherOnDate(teacherId, dateStr, opts) {
  const o = opts || {};
  const weekday = u.weekdayOf(dateStr);
  return store.filter('course_tasks', function (t) {
    if (String(t.teacher_id) !== String(teacherId)) return false;
    if (Number(t.weekday) !== weekday) return false;
    if (t.status && t.status !== 'active') return false;
    if (o.term && String(t.term) !== String(o.term)) return false;
    if (!o.ignoreWeeks && !taskActiveOn(t, dateStr)) return false;
    return true;
  }).sort(function (a, b) { return String(a.start_time).localeCompare(String(b.start_time)); });
}

function teacherById(id) { return store.findById('users', id); }

// ---------------------------------------------------------------- 唯一性
function uniqueKey(teacherId, courseCode, classId, dateStr, section) {
  return [teacherId, courseCode || '', classId || '', dateStr, section || ''].join('|');
}

/** 同一 teacher+course+class+date+section 只允许一条非 revoked 记录 */
function findConflicting(recLike) {
  const key = uniqueKey(recLike.teacher_id, recLike.course_code, recLike.class_id, recLike.teach_date, recLike.section);
  return store.filter('period_records', function (r) {
    if (r.status === 'revoked') return false;
    return uniqueKey(r.teacher_id, r.course_code, r.class_id, r.teach_date, r.section) === key;
  })[0] || null;
}

/** 课时会话唯一性键：class_id + teach_date + section + 实际授课人姓名（需求：同一节课不重复发起） */
function sessionKeyOf(recLike) {
  return [
    String(recLike.class_id || ''),
    String(recLike.teach_date || ''),
    String(recLike.section || ''),
    u.normalizeName(recLike.teacher_name),
  ].join('|');
}

/** 同一 教学班+日期+节次+实际授课人 只允许一条非 revoked 课时记录（会话与旧记录共用） */
function findSessionConflict(recLike) {
  const key = sessionKeyOf(recLike);
  return store.filter('period_records', function (r) {
    if (r.status === 'revoked') return false;
    return sessionKeyOf(r) === key;
  })[0] || null;
}

/** 该行是否为「班干部发起的课时会话」（POST /sessions 创建或升级的记录） */
function isSessionRow(r) {
  if (!r) return false;
  return r.origin === 'session' || !!r.initiator_id;
}

// ---------------------------------------------------------------- 实际授课人归属
/**
 * 教师姓名（可带工号）→ 用户
 * 优先按工号精确匹配，其次按姓名归一化匹配（去除空格/点号/间隔号并转小写）
 */
function resolveTeacherByName(name, no) {
  const n = String(name === undefined || name === null ? '' : name).trim();
  const s = String(no === undefined || no === null ? '' : no).trim();
  if (!n && !s) return null;
  const list = store.filter('users', function (x) { return x.role === 'teacher' && x.status !== 'disabled'; });
  if (s) {
    const byNo = list.find(function (x) { return String(x.staff_no) === s; });
    if (byNo) return byNo;
  }
  if (!n) return null;
  const norm = u.normalizeName(n);
  return list.filter(function (x) { return u.normalizeName(x.real_name) === norm; })[0] || null;
}

/**
 * 学时归属键（**按实际授课人**，契约口径调整）：
 *  - 有 teacher_id 时优先用 id：'id:<userId>'
 *  - 无 teacher_id 时按姓名归并到同名教师：'id:<userId>'，找不到同名教师则退化为 'name:<归一化姓名>'
 */
function attributionKey(r) {
  if (!r) return 'unknown';
  if (r.teacher_id) return 'id:' + String(r.teacher_id);
  const name = String(r.teacher_name || '');
  if (!name) return 'unknown';
  const hit = resolveTeacherByName(name, r.teacher_no);
  return hit ? 'id:' + String(hit.id) : 'name:' + u.normalizeName(name);
}

/**
 * 该条课时是否归属指定教师（实际授课人口径）
 * 有 teacher_id 时严格按 id 判定（代课确认人不会顶替实际授课人）；
 * teacher_id 为空时按姓名匹配（班干部手填的外聘/外院老师）
 */
function isActualTeacher(r, user) {
  if (!r || !user) return false;
  if (r.teacher_id) return String(r.teacher_id) === String(user.id);
  const name = String(r.teacher_name || '');
  if (!name) return false;
  return u.normalizeName(name) === u.normalizeName(user.real_name);
}

// ---------------------------------------------------------------- 签字人校验
/**
 * 解析签字人：signerId / signerNo / signerName 任一种入参均可（前端只传姓名+职务）
 * 硬性规则：必须在 t_class_cadre 的 active 名单内，否则 42202
 */
function resolveSigner(input, classId) {
  const list = view.activeCadres(classId);
  if (!list.length) {
    throw fail(CODES.SIGNER_NOT_ALLOWED, '该教学班尚无有效班干部授权（t_class_cadre 无 active 记录）');
  }
  let hit = null;
  if (input.signerId) {
    hit = list.find(function (r) { return String(r.user_id) === String(input.signerId); }) || null;
    if (!hit) {
      const user = store.findById('users', input.signerId);
      if (user && view.isActiveCadreOf(user.id, classId)) {
        hit = list.find(function (r) { return String(r.user_id) === String(user.id); });
      }
    }
    if (!hit) {
      throw fail(CODES.SIGNER_NOT_ALLOWED,
        '签字人（ID ' + input.signerId + '）不在该教学班 active 班干部名单内，请重新选择');
    }
  } else if (input.signerNo || input.signerName) {
    for (let i = 0; i < list.length; i++) {
      const user = view.userById(list[i].user_id);
      if (!user) continue;
      if (input.signerNo && String(user.student_no) === String(input.signerNo)) { hit = list[i]; break; }
      if (!input.signerNo && input.signerName && u.normalizeName(user.real_name) === u.normalizeName(input.signerName)) {
        hit = list[i]; break;
      }
    }
    if (!hit) {
      throw fail(CODES.SIGNER_NOT_ALLOWED,
        '签字人「' + (input.signerName || input.signerNo) + '」不在该教学班 active 班干部名单内');
    }
  } else {
    hit = list[0]; // 未指定则默认学委（priority 最小）
  }
  const user = view.userById(hit.user_id);
  return {
    user: user,
    duty: hit.duty || user.duty || '',
    priority: Number(hit.priority),
    isPrimary: Number(hit.priority) === Number(list[0].priority) && String(hit.user_id) === String(list[0].user_id),
  };
}

/** 提交人 ≠ 签字人（需求 5.2 硬性） */
function assertNotSelfSign(submitter, signer) {
  if (String(submitter.id) === String(signer.id)) {
    throw fail(CODES.SELF_SIGN);
  }
}

// ---------------------------------------------------------------- 缺勤匹配
/** 缺勤姓名原始文本 → t_absent 明细（matched / unmatched / ambiguous） */
function matchAbsents(record, rawNames) {
  const names = u.splitNames(rawNames);
  const students = view.studentOf(record.class_id);
  store.replaceAll('absents', store.filter('absents', function (a) { return String(a.record_id) !== String(record.id); }));
  const details = [];
  names.forEach(function (name) {
    const norm = u.normalizeName(name);
    const hits = students.filter(function (s) { return u.normalizeName(s.real_name) === norm; });
    const row = {
      id: store.newId('AB'),
      record_id: record.id,
      raw_name: name,
      matched_student_id: null,
      match_status: 'unmatched',
      created_at: u.isoNow(),
    };
    if (hits.length === 1) {
      row.matched_student_id = hits[0].id;
      row.match_status = 'matched';
    } else if (hits.length > 1) {
      row.match_status = 'ambiguous';
    }
    store.insert('absents', row);
    details.push({ rawName: name, studentId: row.matched_student_id, studentNo: row.matched_student_id ? hits[0].student_no : '', status: row.match_status });
  });
  return details;
}

// ---------------------------------------------------------------- 创建记录
function createRecord(user, body, ctx) {
  const b = body || {};
  if (!b.taskId) throw paramError('taskId 必填');
  const task = taskById(b.taskId);
  if (!task) throw fail(CODES.NOT_FOUND, '授课任务不存在：' + b.taskId);

  // 权限：教师只能对本人授课任务发起
  if (user.role === 'teacher' && String(task.teacher_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '只能对本人授课任务发起课时确认');
  }
  if (user.role !== 'teacher' && user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN, '仅任课教师可发起课时确认');
  }

  const teacher = teacherById(task.teacher_id);
  const dateStr = b.teachDate || b.fullDate || b.date || u.dateOnly();
  if (!u.isValidDate(dateStr)) throw paramError('teachDate 格式应为 YYYY-MM-DD');
  // 校验 4：teach_date 不得为未来日期
  if (u.isFutureDate(dateStr)) throw paramError('teachDate 不得为未来日期（当前 ' + u.dateOnly() + '）');
  if (Number(task.weekday) !== u.weekdayOf(dateStr)) {
    throw paramError('teachDate 与授课任务的星期不符（任务为' + (u.WEEKDAY_CN[Number(task.weekday)] || '') + '）');
  }

  // 校验 1：唯一性（非 revoked）
  const candidate = {
    teacher_id: task.teacher_id,
    course_code: task.course_code,
    class_id: task.class_id,
    teach_date: dateStr,
    section: task.section,
  };
  const dup = findConflicting(candidate);
  if (dup) {
    throw fail(CODES.DUP_RECORD,
      '该教师同一课程/教学班/日期/节次已存在有效记录（' + dup.id + '，状态 ' + dup.status + '）',
      { existingId: dup.id, existingStatus: dup.status });
  }

  // 动态码校验（传入则必须有效且未被使用；SEED-/DEMO- 前缀为演示占位码，跳过）
  let codeRow = null;
  if (b.codeId) {
    codeRow = findCode(b.codeId);
    if (codeRow) {
      checkCode(b.codeId);
    } else if (!/^(DEMO|SEED|MOCK)/i.test(String(b.codeId))) {
      throw fail(CODES.NOT_FOUND, '动态码不存在：' + b.codeId);
    }
  }

  // 校验 2 + 3：签字人必须是该教学班 active 班干部，且提交人 ≠ 签字人
  const signer = resolveSigner(b, task.class_id);
  assertNotSelfSign(user, signer.user);

  // 自由文本合规（契约六.6）：长度上限 + 敏感词拦截（命中即 40001，不落库）
  const words = view.sensitiveWords();
  const summary = checkFreeText('summary', b.summary, ctx, {
    words: words, max: limitOf('max_summary_len', 'summary'),
  });
  const absentF = checkFreeText('absent_names', b.absentNames, ctx, {
    words: words, max: limitOf('max_absent_names_len', 'absent_names'),
  });
  const discipline = ['good', 'normal', 'bad'].indexOf(b.discipline) >= 0 ? b.discipline : 'good';
  const absentCountRaw = Number(b.absentCount || 0);
  const absentCount = Number.isFinite(absentCountRaw) && absentCountRaw >= 0 ? Math.floor(absentCountRaw) : 0;
  const coef = String(b.coef || task.coef || '1.0');
  const hours = Number(task.hours || 0);
  const adhoc = signer.isPrimary ? 0 : 1;
  // 备注（教师自由文本）：现场指定签字人时由服务端生成说明，不接受客户端覆盖
  const note = adhoc
    ? '学委不在，由教师现场指定签字人，需教务处事后审核'
    : checkFreeText('note', b.note, ctx, { words: words, max: limitOf('max_reason_len', 'note') }).text;

  const now = u.isoNow();
  const row = store.insert('period_records', {
    id: store.newId('R'),
    task_id: task.id,
    teacher_id: task.teacher_id,
    teacher_name: teacher ? teacher.real_name : task.teacher_name,
    teacher_no: teacher ? teacher.staff_no : task.teacher_no,
    course_code: task.course_code,
    course_name: task.course_name,
    class_id: task.class_id,
    class_name: task.class_name,
    dept_id: task.dept_id,
    term: task.term,
    teach_date: dateStr,
    section: task.section,
    start_time: task.start_time,
    end_time: task.end_time,
    place: task.place,
    hours: hours,
    coef: coef,
    status: 'wait',
    absent_count: absentCount,
    absent_names: absentF.text,
    discipline: discipline,
    summary: summary.text,
    signer_id: signer.user.id,
    signer_name: signer.user.real_name,
    signer_duty: signer.duty,
    signer_is_adhoc: adhoc,
    code_id: codeRow ? codeRow.id : (b.codeId || ''),
    confirmed_at: null,
    deadline_at: u.deadlineOf(dateStr, view.configNum('confirm_deadline_hour')),
    makeup_id: null,
    appeal_id: null,
    note: note,
    created_by: user.id,
    created_at: now,
    updated_at: now,
  });

  // 定位/位置信息已彻底移除：客户端若传 location / latitude / longitude / locationDenied
  // 一律忽略且不报错（向后兼容），不再写入 t_signature 任何位置字段。

  // 缺勤明细匹配
  if (absentF.text) matchAbsents(row, absentF.text);

  // 消费动态码（一次性）
  if (codeRow) consumeCode(codeRow, user, row.id);

  audit.log(ctx, 'record.create', {
    targetType: 'period_record', targetId: row.id,
    before: null,
    after: { status: 'wait', teacherId: row.teacher_id, signerId: row.signer_id, signerIsAdhoc: adhoc, teachDate: dateStr, section: row.section },
    detail: '发起课时确认' + (adhoc ? '（现场指定签字人）' : ''),
  });

  // 自由文本命中敏感词已在 checkFreeText 中直接 40001 拦截，这里不再产生脱敏 warning
  return { record: row, warnings: [] };
}

// ---------------------------------------------------------------- 签名确认
function signRecord(user, record, file, body, ctx) {
  const b = body || {};
  // 入参校验优先于状态校验：签名图不能为空
  if (!file || !file.buffer || !file.buffer.length) throw paramError('签名图不能为空（multipart 字段名 signature）');
  // 状态机：仅 wait → done
  if (record.status !== 'wait') {
    throw fail(CODES.BAD_STATE, '当前状态为「' + record.status + '」，仅「wait」状态可签名确认');
  }
  if (user.role !== 'cadre') throw fail(CODES.FORBIDDEN, '仅班干部可签名确认');
  if (String(record.signer_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '该记录指定签字人为「' + record.signer_name + '」，当前用户无权签字');
  }
  if (!view.isActiveCadreOf(user.id, record.class_id)) {
    throw fail(CODES.SIGNER_NOT_ALLOWED, '签字授权已失效（不在 active 班干部名单内）');
  }
  // 截止时间校验
  if (record.deadline_at && new Date(record.deadline_at).getTime() < Date.now()) {
    throw fail(CODES.BAD_STATE, '已超过确认截止时间（' + record.deadline_at + '），请走补签流程');
  }

  const ext = path.extname(file.originalname || '').toLowerCase();
  const allowed = u.ALLOWED_IMAGE_EXT.indexOf(ext) >= 0 ||
    ['image/png', 'image/jpeg', 'image/jpg'].indexOf(String(file.mimetype || '').toLowerCase()) >= 0;
  if (!allowed) throw paramError('签名图仅支持 png/jpg，收到：' + (ext || file.mimetype));
  if (file.size > u.MAX_SIGNATURE_BYTES) throw paramError('签名图超过 2MB 限制');

  const imageHash = u.sha256(file.buffer);
  const fileName = 'sign_' + record.id + '_' + u.randHex(8) + (ext || '.png');
  const abs = path.join(u.UPLOAD_DIR, fileName);
  fs.writeFileSync(abs, file.buffer);

  const now = u.isoNow();
  // 定位/位置信息已彻底移除：客户端传入的 latitude/longitude/locationDenied 一律忽略且不报错，
  // 写入签名时这三列固定置 null（保留列以兼容历史数据，新数据为空）。
  const deviceInfo = u.cleanText(b.device || b.deviceInfo, 100);

  let sig = view.signatureOf(record.id);
  if (sig) {
    sig.signer_id = user.id;
    sig.image_url = 'data/uploads/' + fileName;
    sig.signed_at = now;
    sig.latitude = null;
    sig.longitude = null;
    sig.location_denied = null;
    sig.device_info = deviceInfo;
    sig.ip = ctx ? ctx.ip : '';
    sig.image_hash = imageHash;
  } else {
    sig = store.insert('signatures', {
      id: store.newId('SG'),
      record_id: record.id,
      signer_id: user.id,
      image_url: 'data/uploads/' + fileName,
      signed_at: now,
      latitude: null,
      longitude: null,
      location_denied: null,
      device_info: deviceInfo,
      code_id: record.code_id,
      ip: ctx ? ctx.ip : '',
      image_hash: imageHash,
      created_at: now,
    });
  }
  store.touch('signatures');

  const before = { status: record.status };
  record.status = 'done';
  record.confirmed_at = now;
  if (deviceInfo) record.signer_device = deviceInfo;
  if (b.coef !== undefined && taskById(record.task_id)) {
    const t = taskById(record.task_id);
    const oldCoef = t.coef;
    t.coef = String(b.coef);
    store.touch('course_tasks');
    audit.log(ctx, 'task.coef.update', {
      targetType: 'course_task', targetId: t.id,
      before: { coef: oldCoef }, after: { coef: t.coef }, detail: '签名时更新学时系数',
    });
  }
  record.updated_at = now;
  store.touch('period_records');

  audit.log(ctx, 'record.sign', {
    targetType: 'period_record', targetId: record.id,
    before: before, after: { status: 'done', signedAt: now, imageHash: imageHash, device: sig.device_info },
    detail: '班干部签名确认',
  });

  return { record: record, signature: sig };
}

function rejectRecord(user, record, reason, ctx) {
  if (record.status !== 'wait') {
    throw fail(CODES.BAD_STATE, '当前状态为「' + record.status + '」，仅「wait」状态可拒绝');
  }
  if (user.role !== 'cadre') throw fail(CODES.FORBIDDEN, '仅班干部可拒绝确认');
  if (String(record.signer_id) !== String(user.id)) {
    throw fail(CODES.FORBIDDEN, '该记录指定签字人为「' + record.signer_name + '」，当前用户无权拒绝');
  }
  // 拒绝原因：必填 + 长度上限 + 敏感词拦截
  const r = checkFreeText('reason', reason, ctx, {
    required: true, label: '拒绝原因', max: limitOf('max_reason_len', 'reason'),
  }).text;
  const before = { status: record.status };
  record.status = 'rejected';
  record.note = '班干部拒绝：' + r;
  record.updated_at = u.isoNow();
  store.touch('period_records');
  audit.log(ctx, 'record.reject', {
    targetType: 'period_record', targetId: record.id,
    before: before, after: { status: 'rejected', reason: r }, detail: '班干部拒绝确认',
  });
  return record;
}

function revokeRecord(user, record, reason, ctx) {
  if (record.status === 'revoked') throw fail(CODES.BAD_STATE, '记录已撤销，不可重复撤销');
  const isOwner = String(record.teacher_id) === String(user.id);
  const isAdmin = user.role === 'admin';
  if (!isOwner && !isAdmin) throw fail(CODES.FORBIDDEN, '仅本人（教师）或教务处可撤销该记录');
  if (user.role === 'cadre' || user.role === 'dept_admin') {
    if (!isAdmin) throw fail(CODES.FORBIDDEN, '仅本人（教师）或教务处可撤销该记录');
  }
  // 撤销原因：可选，长度上限 + 敏感词拦截（必须在改动记录状态之前完成校验，避免被拦截时留下脏状态）
  const revokeReason = checkFreeText('reason', reason, ctx, {
    max: limitOf('max_reason_len', 'reason'),
  }).text;
  const before = { status: record.status };
  record.status = 'revoked';
  record.note = revokeReason || ('教师撤销（原状态 ' + before.status + '）');
  record.updated_at = u.isoNow();
  store.touch('period_records');
  audit.log(ctx, 'record.revoke', {
    targetType: 'period_record', targetId: record.id,
    before: before, after: { status: 'revoked' },
    detail: '撤销课时记录：' + record.note,
  });
  return record;
}

function urgeRecord(user, record, ctx) {
  if (String(record.teacher_id) !== String(user.id) && user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN, '只能提醒本人记录');
  }
  if (record.status !== 'wait') throw fail(CODES.BAD_STATE, '仅「wait」状态可提醒签字人');
  const cooldown = (view.configNum('urge_cooldown_minutes') || 30) * 60 * 1000;
  const last = Number(record.urged_at_ms || 0);
  if (last && Date.now() - last < cooldown) {
    const left = Math.ceil((cooldown - (Date.now() - last)) / 60000);
    throw fail(CODES.BAD_STATE, '提醒过于频繁，请 ' + left + ' 分钟后再试');
  }
  record.urged_at_ms = Date.now();
  record.urge_count = Number(record.urge_count || 0) + 1;
  record.urged_at = u.isoNow();
  record.updated_at = record.urged_at;
  store.touch('period_records');
  audit.log(ctx, 'record.urge', {
    targetType: 'period_record', targetId: record.id,
    after: { urgeCount: record.urge_count, signerId: record.signer_id },
    detail: '教师提醒签字人（应用内记录，订阅消息待接入）',
  });
  return { record: record, urgeCount: record.urge_count, channel: 'in-app', msg: '已提醒签字人 ' + record.signer_name };
}

/** 超期未确认批量置 expired（每日 00:05 定时任务） */
function expireJob(ctx, opts) {
  const o = opts || {};
  const now = Date.now();
  const list = store.filter('period_records', function (r) {
    if (r.status !== 'wait') return false;
    if (!r.deadline_at) return false;
    return new Date(r.deadline_at).getTime() < now;
  });
  list.forEach(function (r) {
    r.status = 'expired';
    r.note = u.cleanText(o.note || '超过当天 24 点未确认，系统自动置为已过期', 200);
    r.updated_at = u.isoNow();
    audit.log(ctx || { user: null }, 'record.expire', {
      targetType: 'period_record', targetId: r.id,
      before: { status: 'wait' }, after: { status: 'expired' }, detail: '定时任务自动过期',
    });
  });
  if (list.length) store.touch('period_records');
  return { scanned: list.length, expired: list.length, ids: list.map(function (r) { return r.id; }) };
}

// ---------------------------------------------------------------- 补签
function applyMakeup(user, body, ctx) {
  const b = body || {};
  const recordId = b.recordId || b.id;
  if (!recordId) throw paramError('recordId 必填');
  const record = store.findById('period_records', recordId);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + recordId);
  if (String(record.teacher_id) !== String(user.id)) throw fail(CODES.FORBIDDEN, '只能对本人记录发起补签');
  if (['expired', 'rejected'].indexOf(record.status) < 0) {
    throw fail(CODES.BAD_STATE, '仅「已过期 / 已拒绝」的记录可补签，当前状态：' + record.status);
  }
  const reason = checkFreeText('reason', b.reason, ctx, {
    required: true, label: '补签理由', max: limitOf('max_reason_len', 'reason'),
  }).text;
  const pending = store.find('makeup_applies', function (m) {
    return String(m.record_id) === String(record.id) && m.status === 'pending';
  });
  if (pending) throw fail(CODES.BAD_STATE, '该记录已有一条待审核的补签申请（' + pending.id + '）');
  const now = u.isoNow();
  const row = store.insert('makeup_applies', {
    id: store.newId('MK'),
    record_id: record.id,
    applicant_id: user.id,
    applicant_name: user.real_name,
    reason: reason,
    evidence_urls: Array.isArray(b.evidenceUrls) ? b.evidenceUrls : (b.evidenceUrls ? [String(b.evidenceUrls)] : []),
    status: 'pending',
    reviewer_id: null,
    reviewed_at: null,
    review_note: '',
    created_at: now,
    updated_at: now,
  });
  record.makeup_id = row.id;
  record.updated_at = now;
  store.touch('period_records');
  audit.log(ctx, 'makeup.apply', {
    targetType: 'makeup_apply', targetId: row.id,
    after: { recordId: record.id, status: 'pending', reason: reason }, detail: '教师发起补签申请',
  });
  return row;
}

function reviewMakeup(user, id, approve, body, ctx) {
  const row = store.findById('makeup_applies', id);
  if (!row) throw fail(CODES.NOT_FOUND, '补签申请不存在：' + id);
  if (row.status !== 'pending') throw fail(CODES.BAD_STATE, '该补签申请已处理（' + row.status + '）');
  const record = store.findById('period_records', row.record_id);
  if (!record) throw fail(CODES.NOT_FOUND, '关联课时记录不存在');
  // 权限：审批角色（配置 makeup_approver_role，默认 dept_admin），院系管理员限本院系
  const approverRole = view.configMap().makeup_approver_role || 'dept_admin';
  if (user.role !== approverRole && user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN, '仅「' + approverRole + '」或教务处可审批补签');
  }
  if (user.role === 'dept_admin' && record.dept_id && String(record.dept_id) !== String(user.dept_id)) {
    throw fail(CODES.FORBIDDEN, '只能审批本院系的补签申请');
  }
  const b = body || {};
  const rawNote = b.note === undefined || b.note === null ? b.reason : b.note;
  const note = approve
    ? checkFreeText('review_note', rawNote, ctx, { max: limitOf('max_reason_len', 'review_note') }).text
    : checkFreeText('review_note', rawNote, ctx, {
      required: true, label: '驳回原因', max: limitOf('max_reason_len', 'review_note'),
    }).text;
  const now = u.isoNow();
  const before = { status: record.status };
  if (approve) {
    row.status = 'approved';
    row.reviewer_id = user.id;
    row.reviewed_at = now;
    row.review_note = note;
    row.updated_at = now;
    record.status = 'makeup'; // 契约：通过后原记录置 makeup，计入正式学时并单独标注
    record.confirmed_at = record.confirmed_at || now;
    record.note = '补签已通过：' + (note || row.reason);
    record.updated_at = now;
  } else {
    row.status = 'rejected';
    row.reviewer_id = user.id;
    row.reviewed_at = now;
    row.review_note = note;
    row.updated_at = now;
    record.note = '补签已驳回：' + note;
    record.updated_at = now;
  }
  store.touch('makeup_applies');
  store.touch('period_records');
  audit.log(ctx, approve ? 'makeup.approve' : 'makeup.reject', {
    targetType: 'makeup_apply', targetId: row.id,
    before: { recordStatus: before.status, applyStatus: 'pending' },
    after: { recordStatus: record.status, applyStatus: row.status, note: note },
    detail: approve ? '补签审核通过' : '补签审核驳回',
  });
  return { apply: row, record: record };
}

// ---------------------------------------------------------------- 申诉
function applyAppeal(user, body, ctx) {
  const b = body || {};
  const recordId = b.recordId || b.id;
  if (!recordId) throw paramError('recordId 必填');
  const record = store.findById('period_records', recordId);
  if (!record) throw fail(CODES.NOT_FOUND, '课时记录不存在：' + recordId);
  if (String(record.teacher_id) !== String(user.id)) throw fail(CODES.FORBIDDEN, '只能对本人记录发起申诉');
  if (record.status !== 'rejected') throw fail(CODES.BAD_STATE, '仅「已拒绝」的记录可申诉，当前状态：' + record.status);
  const reason = checkFreeText('reason', b.reason, ctx, {
    required: true, label: '申诉理由', max: limitOf('max_reason_len', 'reason'),
  }).text;
  // 同一记录申诉次数上限：1 次
  const exists = store.filter('appeals', function (a) { return String(a.record_id) === String(record.id); });
  if (exists.length >= 1) throw fail(CODES.BAD_STATE, '该记录已申诉过，申诉次数已达上限（1 次/记录）');
  const now = u.isoNow();
  const row = store.insert('appeals', {
    id: store.newId('AP'),
    record_id: record.id,
    applicant_id: user.id,
    applicant_name: user.real_name,
    reason: reason,
    evidence_urls: Array.isArray(b.evidenceUrls) ? b.evidenceUrls : [],
    status: 'pending',
    reviewer_id: null,
    reviewed_at: null,
    review_note: '',
    created_at: now,
    updated_at: now,
  });
  record.status = 'appealing';
  record.appeal_id = row.id;
  record.updated_at = now;
  store.touch('period_records');
  audit.log(ctx, 'appeal.apply', {
    targetType: 'appeal', targetId: row.id,
    before: { recordStatus: 'rejected' }, after: { recordStatus: 'appealing', reason: reason },
    detail: '教师发起申诉',
  });
  return row;
}

function reviewAppeal(user, id, approve, body, ctx) {
  const row = store.findById('appeals', id);
  if (!row) throw fail(CODES.NOT_FOUND, '申诉不存在：' + id);
  if (row.status !== 'pending') throw fail(CODES.BAD_STATE, '该申诉已处理（' + row.status + '）');
  const record = store.findById('period_records', row.record_id);
  if (!record) throw fail(CODES.NOT_FOUND, '关联课时记录不存在');
  const approverRole = view.configMap().appeal_approver_role || 'admin';
  if (user.role !== approverRole && user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN, '仅「' + approverRole + '」可处理申诉');
  }
  const b = body || {};
  const rawNote = b.note === undefined || b.note === null ? b.reason : b.note;
  const note = approve
    ? checkFreeText('review_note', rawNote, ctx, { max: limitOf('max_reason_len', 'review_note') }).text
    : checkFreeText('review_note', rawNote, ctx, {
      required: true, label: '驳回原因', max: limitOf('max_reason_len', 'review_note'),
    }).text;
  const now = u.isoNow();
  const before = { status: record.status };
  if (approve) {
    row.status = 'approved';
    row.reviewer_id = user.id;
    row.reviewed_at = now;
    row.review_note = note;
    row.updated_at = now;
    // 契约状态机：appealing ──教务处处理──> done / rejected
    record.status = 'done';
    record.confirmed_at = record.confirmed_at || now;
    record.note = '申诉通过：' + (note || row.reason);
    record.updated_at = now;
  } else {
    row.status = 'rejected';
    row.reviewer_id = user.id;
    row.reviewed_at = now;
    row.review_note = note;
    row.updated_at = now;
    record.status = 'rejected';
    record.note = '申诉驳回：' + note;
    record.updated_at = now;
  }
  store.touch('appeals');
  store.touch('period_records');
  audit.log(ctx, approve ? 'appeal.approve' : 'appeal.reject', {
    targetType: 'appeal', targetId: row.id,
    before: before, after: { recordStatus: record.status, appealStatus: row.status, note: note },
    detail: approve ? '申诉处理通过' : '申诉驳回',
  });
  return { appeal: row, record: record };
}

// ---------------------------------------------------------------- 查询与权限
/** 课时记录全部状态（契约状态机：draft/wait/done/rejected/expired/appealing/makeup/revoked） */
const RECORD_STATUSES = ['draft', 'wait', 'done', 'rejected', 'expired', 'appealing', 'makeup', 'revoked'];

/**
 * 记录列表（按角色过滤）
 * - teacher：只看本人
 * - cadre：只看指定由本人确认的
 * - dept_admin：本院系
 * - admin：全部
 * @param opts {ignoreStatus:true} 忽略 status 过滤（含班干部「默认可见状态」收窄），用于统计角标口径
 */
function queryRecords(user, query, opts) {
  const o = opts || {};
  const q = query || {};
  let list = store.all('period_records').slice();

  if (user.role === 'teacher') {
    // 口径调整：教师「我的课时」按**实际授课人**归属（teacher_id 优先，空 id 时按姓名匹配）
    list = list.filter(function (r) { return isActualTeacher(r, user); });
  } else if (user.role === 'cadre') {
    list = list.filter(function (r) { return String(r.signer_id) === String(user.id); });
    if (!o.ignoreStatus && (q.status === undefined || q.status === '' || q.status === 'all')) {
      // 默认「待我确认 + 我确认过的」
      list = list.filter(function (r) { return ['wait', 'done', 'makeup', 'rejected', 'expired'].indexOf(r.status) >= 0; });
    }
  } else if (user.role === 'dept_admin') {
    if (user.dept_id) list = list.filter(function (r) { return String(r.dept_id) === String(user.dept_id); });
  } else if (user.role !== 'admin') {
    throw fail(CODES.FORBIDDEN);
  }

  if (q.status && !o.ignoreStatus) {
    const statuses = String(q.status).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (statuses.length) list = list.filter(function (r) { return statuses.indexOf(r.status) >= 0; });
  }
  // 按实际授课人筛选：teacher_id 命中；或 teacher_id 为空但姓名与该教师一致（外聘/手填授课人）
  if (q.teacherId) {
    const tid = String(q.teacherId);
    const tu = view.userById(tid);
    const norm = tu ? u.normalizeName(tu.real_name) : '';
    list = list.filter(function (r) {
      if (String(r.teacher_id) === tid) return true;
      if (r.teacher_id || !norm) return false;
      return !!r.teacher_name && u.normalizeName(r.teacher_name) === norm;
    });
  }
  if (q.classId) list = list.filter(function (r) { return String(r.class_id) === String(q.classId); });
  if (q.deptId) list = list.filter(function (r) { return String(r.dept_id) === String(q.deptId); });
  if (q.courseName) {
    const kw = String(q.courseName);
    list = list.filter(function (r) { return String(r.course_name).indexOf(kw) >= 0; });
  }
  if (q.term) list = list.filter(function (r) { return String(r.term) === String(q.term); });
  if (q.from) list = list.filter(function (r) { return String(r.teach_date) >= String(q.from); });
  if (q.to) list = list.filter(function (r) { return String(r.teach_date) <= String(q.to); });
  if (q.keyword) {
    const kw = String(q.keyword);
    list = list.filter(function (r) {
      return String(r.course_name).indexOf(kw) >= 0 || String(r.class_name).indexOf(kw) >= 0 ||
        String(r.teacher_name).indexOf(kw) >= 0 || String(r.signer_name).indexOf(kw) >= 0;
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

/**
 * 各状态数量（**不受 `status=` 筛选影响**，仅按当前用户可见范围/角色权限统计）
 *
 * 与 `summary.byStatus`（受 `status=` 过滤，前端做「当前筛选下各状态计数」）的区别：
 * - 本函数用于「各状态数量角标」：切到 `status=wait` 时，其它状态的角标仍然要有数；
 * - 统计口径 = 该角色能看到的全部记录（教师=本人 / 班干部=指定由本人确认 / 院系管理员=本院系 / 教务处=全部）；
 * - 其余非 status 的筛选条件（from/to/teacherId/term 等）仍然生效，保证与列表范围一致；
 * - 固定返回 8 种状态（RECORD_STATUSES），无记录的状态为 0，前端无需再做缺省判断。
 *
 * @returns {Object<string, number>} 形如 {draft:0, wait:3, done:12, ...}
 */
function statusTotals(user, query) {
  const scoped = queryRecords(user, query, { ignoreStatus: true, skipSort: true });
  const out = {};
  RECORD_STATUSES.forEach(function (s) { out[s] = 0; });
  scoped.forEach(function (r) {
    const s = String(r.status || '');
    out[s] = Number(out[s] || 0) + 1;   // 未知状态也如实计数，避免静默丢数
  });
  return out;
}

/** 记录详情权限：相关人（教师本人 / 指定签字人 / 同院系管理员 / 教务处） */
function assertCanReadRecord(user, record) {
  if (user.role === 'admin') return;
  if (String(record.teacher_id) === String(user.id)) return;
  if (String(record.signer_id) === String(user.id)) return;
  if (user.role === 'dept_admin' && record.dept_id && String(record.dept_id) === String(user.dept_id)) return;
  // 同教学班的其他 active 班干部也可查看（协作确认）
  if (user.role === 'cadre' && view.isActiveCadreOf(user.id, record.class_id)) return;
  throw fail(CODES.FORBIDDEN, '无权查看该课时记录');
}

module.exports = {
  // 动态码
  generateCode, findCode, checkCode, consumeCode,
  // 动态码 A+B 双通道：6 位口令 / 二维码载荷 / 三种入参解析
  QR_PREFIX, PASS_CODE_LEN, qrPayloadOf, randomPassCode, isPassCode,
  allocPassCode, passCodeInUse, findCodeByPass, parseCodeContent, resolveCodeRef,
  // 任务
  taskById, taskActiveOn, tasksOfTeacherOnDate, teacherById,
  // 校验
  uniqueKey, findConflicting, resolveSigner, assertNotSelfSign, matchAbsents,
  // 课时会话（班干部发起 + 教师确认）共用能力
  sessionKeyOf, findSessionConflict, isSessionRow,
  // 实际授课人归属（统计口径）
  resolveTeacherByName, attributionKey, isActualTeacher,
  // 自由文本合规（课程清单 / 会话复用同一口径）
  checkFreeText, limitOf,
  // 写操作
  createRecord, signRecord, rejectRecord, revokeRecord, urgeRecord, expireJob,
  applyMakeup, reviewMakeup, applyAppeal, reviewAppeal,
  // 读
  RECORD_STATUSES, queryRecords, statusTotals, assertCanReadRecord,
};
