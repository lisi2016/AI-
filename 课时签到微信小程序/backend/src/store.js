'use strict';
/**
 * JSON 文件持久化存储（契约一.2 要求 JSON 文件即可，无需数据库）
 * - 每个业务表一个 data/*.json
 * - 启动时全量载入内存，写入时整表原子落盘（写请求串行化）
 * - ID 通过 data/_meta.json 里的自增计数器生成，重启后继续递增
 */
const fs = require('fs');
const path = require('path');
const u = require('./util');

const ARRAY_TABLES = [
  'depts', 'classes', 'students', 'users', 'class_cadres', 'course_tasks',
  // 班级课程清单（班干部录入一次、长期保留；data/class_courses.json）
  'class_courses',
  'period_records', 'signatures', 'absents', 'makeup_applies', 'appeals',
  'audit_logs', 'configs', 'import_jobs', 'export_jobs', 'whitelist',
  'codes', 'idempotency',
  // Web 后台账号密码登录失败记录（data/login_attempts.json）
  'login_attempts',
  // 未登录「自助解绑（换绑）」请求计数与留痕（data/unbind_requests.json）
  // 用途：/auth/unbind-self 的频率限制（同 no 24h ≤2 次、同 IP 1h ≤5 次）+ 事后追溯
  'unbind_requests',
];

const OBJECT_TABLES = ['meta'];

const FILE_OF = {};
ARRAY_TABLES.forEach(function (t) { FILE_OF[t] = t + '.json'; });
OBJECT_TABLES.forEach(function (t) { FILE_OF[t] = '_' + t + '.json'; });

const db = {};
const pending = {};
const flushing = {};
let counters = {};
let ready = false;

function filePath(table) { return path.join(u.DATA_DIR, FILE_OF[table]); }

function defaultFor(table) {
  if (OBJECT_TABLES.indexOf(table) >= 0) {
    return table === 'meta'
      ? { schemaVersion: 1, counters: {}, createdAt: u.isoNow() }
      : {};
  }
  return [];
}

function loadTable(table) {
  const p = filePath(table);
  if (!u.fileExists(p)) {
    db[table] = defaultFor(table);
    return false;
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : defaultFor(table);
    if (OBJECT_TABLES.indexOf(table) >= 0) {
      db[table] = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : defaultFor(table);
    } else {
      db[table] = Array.isArray(parsed) ? parsed : defaultFor(table);
    }
    return true;
  } catch (e) {
    const broken = p + '.broken-' + Date.now();
    try { fs.renameSync(p, broken); } catch (e2) { /* ignore */ }
    console.error('[store] ' + table + '.json 解析失败，已备份为 ' + path.basename(broken) + '：' + e.message);
    db[table] = defaultFor(table);
    return false;
  }
}

/** 载入全部表；返回缺失的表名（用于触发种子数据） */
function load() {
  u.ensureDirs();
  const missing = [];
  ARRAY_TABLES.concat(OBJECT_TABLES).forEach(function (t) {
    if (!loadTable(t)) missing.push(t);
  });
  counters = db.meta && db.meta.counters ? db.meta.counters : {};
  ready = true;
  return missing;
}

function flush(table, cb) {
  if (flushing[table]) return cb && cb();
  flushing[table] = true;
  const data = JSON.stringify(db[table], null, 2);
  try {
    u.writeFileAtomic(filePath(table), data);
    flushing[table] = false;
    if (pending[table]) { pending[table] = false; flush(table); }
    if (cb) cb(null);
  } catch (e) {
    flushing[table] = false;
    console.error('[store] 写入 ' + FILE_OF[table] + ' 失败：' + e.message);
    if (cb) cb(e);
  }
}

/** 标记某表待落盘（合并 30ms 内的多次写入，避免频繁 IO） */
function touch(table) {
  if (!ready) throw new Error('store 未初始化');
  if (pending[table]) return;
  pending[table] = true;
  setTimeout(function () {
    if (!pending[table]) return;
    pending[table] = false;
    flush(table);
  }, 30);
}

function flushAll() {
  ARRAY_TABLES.concat(OBJECT_TABLES).forEach(function (t) {
    if (pending[t]) { pending[t] = false; }
    flush(t);
  });
}

/** 自增 ID（按前缀隔离，持久化在 _meta.json） */
function nextSeq(prefix) {
  const key = String(prefix);
  const cur = Number(counters[key] || 0);
  const next = cur + 1;
  counters[key] = next;
  if (db.meta) {
    db.meta.counters = counters;
    db.meta.updatedAt = u.isoNow();
  }
  touch('meta');
  return next;
}

/** 生成形如 U00000001 的业务 ID */
function newId(prefix) { return prefix + String(nextSeq(prefix)).padStart(8, '0'); }

function all(table) {
  if (!db[table]) db[table] = defaultFor(table);
  return db[table];
}

function find(table, predicate) {
  return all(table).find(predicate) || null;
}

function filter(table, predicate) {
  return all(table).filter(predicate);
}

function findById(table, id) {
  const key = String(id === undefined || id === null ? '' : id);
  return find(table, function (r) { return String(r.id) === key; });
}

/** 插入并落盘 */
function insert(table, row) {
  all(table).push(row);
  touch(table);
  return row;
}

/** 更新：patch 为对象或 (row)=>void */
function update(table, id, patch) {
  const row = findById(table, id);
  if (!row) return null;
  if (typeof patch === 'function') patch(row);
  else if (patch) Object.assign(row, patch);
  touch(table);
  return row;
}

function remove(table, id) {
  const arr = all(table);
  const i = arr.findIndex(function (r) { return String(r.id) === String(id); });
  if (i < 0) return false;
  arr.splice(i, 1);
  touch(table);
  return true;
}

/** 批量替换整表（导入落库用，保证一次落盘） */
function replaceAll(table, rows) {
  db[table] = rows;
  touch(table);
}

function getMeta() { return db.meta || (db.meta = defaultFor('meta')); }

// 进程退出前把待写数据落盘
function installExitHook() {
  ['SIGINT', 'SIGTERM'].forEach(function (sig) {
    process.on(sig, function () {
      try { flushAll(); } catch (e) { /* ignore */ }
      process.exit(0);
    });
  });
  process.on('exit', function () { try { flushAll(); } catch (e) { /* ignore */ } });
}

module.exports = {
  db, ARRAY_TABLES, OBJECT_TABLES, FILE_OF,
  load, flush, flushAll, touch, installExitHook,
  all, find, filter, findById, insert, update, remove, replaceAll,
  newId, nextSeq, getMeta, filePath,
};
