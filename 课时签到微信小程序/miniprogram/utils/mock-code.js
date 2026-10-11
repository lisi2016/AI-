// mock 动态码登记表（离线演示 / 自测用，与真实后端语义对齐）
//
// 为什么单独抽一个模块：
//   业务简化后动态码有两个来源 ——
//     ① 旧通道 POST /code/generate（不绑定课时会话）
//     ② 新通道 POST /sessions      （码绑定到课时会话 codes.session_id，教师核验后看到「本次课时」）
//   两条通道共用同一张「60 秒有效 + 一次性消费」的登记表，因此登记表必须独立于 api.js，
//   由 utils/api.js（①）与 utils/mock-session.js（②）共同使用。
//
// 语义与后端保持一致：
//   · 6 位数字口令在「未消费且未过期」的码之间互不重复
//   · qrPayload === 'kcsq://code/' + codeId（A 通道，扫码原文）
//   · 解析失败 / 查不到 → 40401；过期 → 41001；已消费 → 41002；三种入参全缺失 → 40001
//
// 本模块不依赖 wx，可被 Node 自测脚本直接 require。

var codeParse = require('./code-parse.js');

var CODES = {};      // codeId -> row
var SEQ = 0;

function padLeft(v, n) {
  var s = String(v);
  while (s.length < n) s = '0' + s;
  return s;
}

/** 生成一个当前未被占用（未消费且未过期）的 6 位数字口令 */
function nextPassCode() {
  var used = {};
  Object.keys(CODES).forEach(function (k) {
    var c = CODES[k];
    if (!c.used && c.expireAtMs > Date.now()) used[c.code] = 1;
  });
  var i, s;
  for (i = 0; i < 500; i++) {
    s = padLeft(Math.floor(Math.random() * 1000000), 6);
    if (!used[s]) return s;
  }
  return padLeft(String(Date.now()).slice(-6), 6);
}

/**
 * 签发一个动态码
 * @param {object} [opts] { ttl 秒, sessionId 绑定的课时会话, classId }
 * @returns {object} 登记表行（codeId / code / qrPayload / expireAtMs / ttl / sessionId / used）
 */
function generate(opts) {
  var o = opts || {};
  var ttl = Number(o.ttl || 60);
  if (!isFinite(ttl) || ttl <= 0) ttl = 60;
  SEQ++;
  var codeId = 'MOCKCD' + padLeft(SEQ, 6);
  var row = {
    codeId: codeId,
    code: nextPassCode(),
    qrPayload: codeParse.QR_PREFIX + codeId,
    ttl: ttl,
    expireAtMs: Date.now() + ttl * 1000,
    issuedAt: Date.now(),
    used: false,
    usedAt: 0,
    sessionId: o.sessionId ? String(o.sessionId) : '',
    classId: o.classId ? String(o.classId) : ''
  };
  CODES[codeId] = row;
  return row;
}

function get(codeId) {
  return CODES[String(codeId || '')] || null;
}

/** 按 6 位口令找码（多命中时优先未消费的最新一条） */
function findByPass(passCode) {
  var want = String(passCode === undefined || passCode === null ? '' : passCode);
  var hits = Object.keys(CODES).filter(function (id) { return CODES[id].code === want; });
  if (!hits.length) return null;
  hits.sort(function (a, b) { return CODES[b].issuedAt - CODES[a].issuedAt; });
  var alive = hits.filter(function (id) { return !CODES[id].used; });
  return CODES[alive.length ? alive[0] : hits[0]];
}

/** 某会话最新一个「未消费且未过期」的码（教师确认时未传码则消费它） */
function latestActiveOf(sessionId) {
  var list = Object.keys(CODES).filter(function (id) {
    var c = CODES[id];
    return String(c.sessionId) === String(sessionId) && !c.used && c.expireAtMs > Date.now();
  }).map(function (id) { return CODES[id]; });
  list.sort(function (a, b) { return b.issuedAt - a.issuedAt; });
  return list[0] || null;
}

/** 某会话最新一个码（不论是否过期/消费，用于详情回看） */
function latestOf(sessionId) {
  var list = Object.keys(CODES).filter(function (id) {
    return String(CODES[id].sessionId) === String(sessionId);
  }).map(function (id) { return CODES[id]; });
  list.sort(function (a, b) { return b.issuedAt - a.issuedAt; });
  return list[0] || null;
}

/** 归一化核验入参：字符串视为 codeId；对象支持 {codeId}|{code}|{qrContent} */
function normalizeVerifyInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === 'string') return { codeId: input };
  var o = input || {};
  return {
    codeId: o.codeId ? String(o.codeId) : '',
    code: o.code ? String(o.code) : '',
    qrContent: o.qrContent || o.qrText || o.qr || ''
  };
}

/**
 * 核验并返回登记表行（不消费）
 * @returns {{row: object, by: string}} by = 'qrContent' | 'code' | 'codeId'
 * @throws {{code, msg}} 与后端一致的业务错误（40401 / 41001 / 41002 / 40001）
 */
function resolve(input) {
  var req = normalizeVerifyInput(input);
  var row = null;
  var by = '';
  if (req.qrContent) {
    by = 'qrContent';
    var parsed = codeParse.parseCodeInput(req.qrContent);
    if (!parsed) throw { code: 40401, msg: '扫码内容无法识别，请确认扫描的是课程确认二维码（或让老师手输 6 位数字口令）' };
    row = parsed.codeId ? get(parsed.codeId) : findByPass(parsed.code);
    if (!row) throw { code: 40401, msg: '二维码对应的动态码不存在或已失效，请让班干部重新出示' };
  } else if (req.code) {
    by = 'code';
    row = findByPass(req.code);
    if (!row) throw { code: 40401, msg: '口令不存在或已失效：' + req.code + '，请让班干部重新出示' };
  } else if (req.codeId) {
    by = 'codeId';
    row = get(req.codeId);
    if (!row) throw { code: 40401, msg: '动态码不存在：' + req.codeId };
  } else {
    throw { code: 40001, msg: 'codeId 必填（也可传 code 6 位口令 或 qrContent 扫码内容）' };
  }
  if (row.used) throw { code: 41002, msg: '该动态码已被使用，一次动态码只能使用一次，请让班干部刷新后重新出示' };
  if (row.expireAtMs <= Date.now()) throw { code: 41001, msg: '动态码已过期，请班干部刷新后重新出示' };
  return { row: row, by: by };
}

/** 消费一个码（一次性）：已消费/已过期都会抛业务错误 */
function consume(row) {
  if (!row) throw { code: 40401, msg: '动态码不存在' };
  if (row.used) throw { code: 41002, msg: '该动态码已被使用，一次动态码只能使用一次，请让班干部刷新后重新出示' };
  if (row.expireAtMs <= Date.now()) throw { code: 41001, msg: '动态码已过期，请班干部刷新后重新出示' };
  row.used = true;
  row.usedAt = Date.now();
  return row;
}

/** 回看某码的状态（详情页证据用，不抛错） */
function statusOf(codeId) {
  var c = get(codeId);
  if (!c) return null;
  return {
    codeId: c.codeId,
    used: !!c.used,
    usedAt: c.usedAt ? new Date(c.usedAt).toISOString() : '',
    expireAt: new Date(c.expireAtMs).toISOString(),
    expired: c.expireAtMs <= Date.now()
  };
}

function expire(codeId) {
  var c = get(codeId);
  if (c) { c.expireAtMs = Date.now() - 1000; c.ttl = 0; }
  return c;
}

function reset() {
  CODES = {};
  SEQ = 0;
}

module.exports = {
  generate: generate,
  get: get,
  findByPass: findByPass,
  latestActiveOf: latestActiveOf,
  latestOf: latestOf,
  normalizeVerifyInput: normalizeVerifyInput,
  resolve: resolve,
  consume: consume,
  statusOf: statusOf,
  expire: expire,
  reset: reset,
  all: function () { return Object.keys(CODES).map(function (k) { return CODES[k]; }); }
};
