'use strict';
/**
 * 通用工具：ID 生成、Asia/Shanghai 时间、哈希、CSV、文本清洗
 * 仅使用 Node 18 自带能力，无第三方依赖
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const textfilter = require('./textfilter');

// ---------------------------------------------------------------- 配置常量
const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';

function boolEnv(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v));
}

// 开发模式默认开启：不调用微信 code2Session，用 code 生成稳定 mock openid
const DEV_MODE = boolEnv('DEV_MODE', true);

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-token-secret-change-me';
const CODE_SECRET = process.env.CODE_SECRET || 'dev-code-secret-change-me';
const INTERNAL_JOB_TOKEN = process.env.INTERNAL_JOB_TOKEN || '';
// DEV_MODE 下把最近一次登录令牌落盘，便于开发/自动化脚本在绑定被占用时复用（生产环境不写入）
const DEV_LOGIN_FILE = path.join(DATA_DIR, 'dev-login-tokens.json');

const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 7 * 24 * 3600); // 7 天
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000; // 24h
const EXPORT_URL_TTL_MS = 60 * 60 * 1000; // 导出下载链接 1 小时
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 签名图 < 2MB
const ALLOWED_IMAGE_EXT = ['.png', '.jpg', '.jpeg'];

const TZ_OFFSET_MINUTES = 8 * 60; // Asia/Shanghai 固定 UTC+8，无夏令时
const TERM_DEFAULT = process.env.TERM || '2026-2027-1';

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 节次 → 起止时间（导入缺省值与种子数据共用，避免模块循环依赖）
const SECTION_TIME = {
  '1-2': ['08:00', '09:40'],
  '3-4': ['10:05', '11:45'],
  '5-6': ['14:00', '15:40'],
  '7-8': ['16:00', '17:40'],
};

const DEFAULT_CONFIG = {
  hours_coef_theory: '1.0',
  hours_coef_practice: '1.0',
  hours_coef_training: '1.0',
  confirm_deadline_hour: '24',
  code_ttl_seconds: '60',
  makeup_approver_role: 'dept_admin',
  appeal_approver_role: 'admin',
  urge_cooldown_minutes: '30',
  term: TERM_DEFAULT,
  // 自由文本合规（契约六.6）：敏感词表 + 各字段长度上限，可由 /config 覆盖
  sensitive_words: textfilter.DEFAULT_SENSITIVE_WORDS.join(','),
  max_summary_len: '500',
  max_absent_names_len: '300',
  max_reason_len: '500',
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

/** 历史配置键别名（旧名 → 新名），PUT /config 仍接受旧名以保持向后兼容 */
const CONFIG_ALIAS = { max_summary_length: 'max_summary_len' };

// ---------------------------------------------------------------- 目录准备
function ensureDirs() {
  [DATA_DIR, UPLOAD_DIR, EXPORT_DIR].forEach(function (d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ---------------------------------------------------------------- Asia/Shanghai 时间
/** 由"字面日历日期"推算星期（1=周一…7=周日），不受时区偏移影响 */
function weekdayOfDate(y, m, d) {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/**
 * 判断入参是否"已经带明确时区偏移"（如 2026-09-27T10:05:00+08:00 / ...Z）
 * 这类输入 shift=true 会重复加 8 小时，必须先抽出字面时间
 */
function literalTzParts(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/.exec(String(input));
  if (!m) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0),
    ms: Number(m[7] || 0),
    weekday: weekdayOfDate(Number(m[1]), Number(m[2]), Number(m[3])),
    literal: true,
  };
}

function tzParts(input) {
  if (typeof input === 'string') {
    const lit = literalTzParts(input);
    if (lit) return lit;
  }
  const d = input ? new Date(input) : new Date();
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
    weekday: weekdayOfDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()),
  };
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad3(n) { return n < 100 ? (n < 10 ? '00' + n : '0' + n) : String(n); }

/** 日期 → 2026-09-27（带明确时区偏移的输入按字面日期返回，不做二次位移） */
function dateOnly(input) {
  if (typeof input === 'string') {
    const lit = literalTzParts(input);
    if (lit) return lit.year + '-' + pad2(lit.month) + '-' + pad2(lit.day);
  }
  const p = tzParts(input);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

/** 日期 → 2026-09-27T10:05:00+08:00 （契约 1.1 要求 ISO8601 + Asia/Shanghai） */
function isoNow(input) {
  const p = tzParts(input);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T' +
    pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second) + '+08:00';
}

/** 文件/展示用紧凑时间 20260927-100500 */
function stamp(input) {
  const p = tzParts(input);
  return '' + p.year + pad2(p.month) + pad2(p.day) + '-' + pad2(p.hour) + pad2(p.minute) + pad2(p.second) + pad3(p.ms);
}

function nowMs() { return Date.now(); }

/** 某日期当天 24:00（含可配置的 confirm_deadline_hour）→ ISO8601 + Asia/Shanghai */
function deadlineOf(dateStr, hour) {
  const h = Number(hour || 24);
  const base = new Date(dateStr + 'T00:00:00+08:00');
  if (h >= 24) return isoNow(new Date(base.getTime() + 24 * 3600 * 1000));
  return isoNow(new Date(base.getTime() + h * 3600 * 1000));
}

/** 是否未来日期（按 Asia/Shanghai 的日粒度） */
function isFutureDate(dateStr) {
  return dateStr > dateOnly();
}

function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const d = new Date(dateStr + 'T00:00:00+08:00');
  return !isNaN(d.getTime()) && dateOnly(d) === dateStr;
}

/** YYYY-MM-DD → 星期（1=周一…7=周日），按 Asia/Shanghai 日历日 */
function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return u_nowWeekday();
  return weekdayOfDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function u_nowWeekday() { return tzParts().weekday; }

/** 该日期所在周的周一（Asia/Shanghai） */
function mondayOf(dateStr) {
  const w = weekdayOf(dateStr);
  return addDaysStr(String(dateStr), -(w - 1));
}

/** 纯日历加减天数（用 UTC 中午做基准，避免夏令时/时区漂移） */
function addDaysStr(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return String(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 24 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function addDays(dateStr, days) { return addDaysStr(dateStr, days); }

/** 学期周次（以学期首日为第 1 周；1=秋季学期 2=春季学期） */
function termWeekOf(dateStr, term) {
  const t = term || TERM_DEFAULT;
  const m = /^(\d{4})-(\d{4})-([12])$/.exec(t);
  const termStart = m ? (m[3] === '1' ? m[1] + '-09-01' : m[2] + '-02-20') : (t + '-01-01');
  const a = new Date(termStart + 'T00:00:00+08:00').getTime();
  const b = new Date(String(dateStr) + 'T00:00:00+08:00').getTime();
  return Math.floor((b - a) / (7 * 24 * 3600 * 1000)) + 1;
}

// ---------------------------------------------------------------- ID / 哈希
function randHex(n) { return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : (randHex(8) + '-' + randHex(4) + '-' + randHex(12)); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hmacSha256(text, secret) { return crypto.createHmac('sha256', secret || TOKEN_SECRET).update(String(text)).digest('base64url'); }
function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function nextId(prefix, seq) { return prefix + String(seq).padStart(8, '0'); }

// ---------------------------------------------------------------- 文本
function cleanText(v, maxLen) {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const limit = maxLen || 500;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

/** 敏感词脱敏（保留给历史调用方；新代码请用 textfilter.validate 做「命中即拦截」） */
function filterSensitive(text, words) {
  return {
    text: textfilter.maskText(text, words === undefined ? textfilter.DEFAULT_SENSITIVE_WORDS : words),
    hits: textfilter.findHits(text, words === undefined ? textfilter.DEFAULT_SENSITIVE_WORDS : words),
  };
}

/** 缺勤名单原文 → 姓名数组（中文/英文逗号、顿号、分号、空白、换行分隔） */
function splitNames(raw) {
  return String(raw || '')
    .split(/[\s,，、;；\/|]+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function normalizeName(s) {
  return String(s || '').replace(/[\s·•.]/g, '').toLowerCase();
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 导出 CSV（带 UTF-8 BOM，Excel 直接可读） */
function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(csvCell).join(','));
  rows.forEach(function (r) {
    lines.push(r.map(csvCell).join(','));
  });
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/** 解析 CSV 文本 → { headers, rows }（支持引号包裹、转义双引号、BOM） */
function parseCsv(text) {
  let s = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const cleaned = rows.filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
  if (!cleaned.length) return { headers: [], rows: [] };
  const headers = cleaned[0].map(function (h) { return String(h).trim(); });
  const body = cleaned.slice(1).map(function (r) {
    const o = {};
    headers.forEach(function (h, i) { o[h] = String(r[i] === undefined ? '' : r[i]).trim(); });
    return o;
  });
  return { headers: headers, rows: body };
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

function writeFileAtomic(p, data) {
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

function fileExists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

/** DEV_MODE 专用：记录/读取最近一次登录令牌（便于「绑定被占用」时复用） */
function readDevTokens() {
  try {
    const raw = fs.readFileSync(DEV_LOGIN_FILE, 'utf8');
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function saveDevToken(key, token) {
  if (!DEV_MODE || !key || !token) return;
  try {
    const all = readDevTokens();
    all[String(key)] = { token: String(token), at: new Date().toISOString() };
    writeFileAtomic(DEV_LOGIN_FILE, JSON.stringify(all, null, 2));
  } catch (e) { /* 仅开发便利，失败可忽略 */ }
}

module.exports = {
  PORT, HOST, DEV_MODE, ROOT_DIR, DATA_DIR, UPLOAD_DIR, EXPORT_DIR,
  TOKEN_SECRET, CODE_SECRET, INTERNAL_JOB_TOKEN, TOKEN_TTL_SECONDS,
  IDEMPOTENCY_TTL_MS, EXPORT_URL_TTL_MS, MAX_SIGNATURE_BYTES, ALLOWED_IMAGE_EXT,
  TZ_OFFSET_MINUTES, TERM_DEFAULT, WEEKDAY_CN, SECTION_TIME, DEFAULT_CONFIG, CONFIG_KEYS, CONFIG_ALIAS,
  ensureDirs, tzParts, literalTzParts, weekdayOfDate, pad2, dateOnly, isoNow, stamp, nowMs, deadlineOf,
  isFutureDate, isValidDate, weekdayOf, mondayOf, addDays, addDaysStr, termWeekOf,
  randHex, uuid, sha256, hmacSha256, timingEqual, nextId,
  cleanText, filterSensitive, splitNames, normalizeName,
  csvCell, toCsv, parseCsv, readFileSafe, writeFileAtomic, fileExists,
  readDevTokens, saveDevToken, DEV_LOGIN_FILE,
};
