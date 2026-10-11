'use strict';
/**
 * 操作日志：t_audit_log + SHA-256 哈希链（契约 2.9 / 六.8，可检测篡改）
 * hash = SHA256(prev_hash + 本条内容)
 */
const u = require('./util');
const store = require('./store');

const GENESIS = 'GENESIS';

function canon(row) {
  return JSON.stringify([
    String(row.actor_id || ''),
    String(row.actor_role || ''),
    String(row.action || ''),
    String(row.target_type || ''),
    String(row.target_id || ''),
    row.before_json === undefined ? '' : JSON.stringify(row.before_json),
    row.after_json === undefined ? '' : JSON.stringify(row.after_json),
    String(row.ip || ''),
    String(row.device || ''),
    String(row.created_at || ''),
    String(row.detail || ''),
  ]);
}

function lastHash() {
  const log = store.all('audit_logs');
  return log.length ? String(log[log.length - 1].hash || GENESIS) : GENESIS;
}

/**
 * 写一条审计日志
 * @param {object} ctx {user, ip, device, traceId}
 * @param {string} action 如 login / record.create / record.sign
 * @param {object} opts {targetType, targetId, before, after, detail}
 */
function log(ctx, action, opts) {
  const o = opts || {};
  const c = ctx || {};
  const actor = c.user || null;
  const prev = lastHash();
  const row = {
    id: store.newId('L'),
    actor_id: actor ? String(actor.id) : '',
    actor_role: actor ? actor.role : '',
    action: String(action),
    target_type: o.targetType || '',
    target_id: o.targetId === undefined || o.targetId === null ? '' : String(o.targetId),
    before_json: o.before === undefined ? null : o.before,
    after_json: o.after === undefined ? null : o.after,
    ip: c.ip || '',
    device: c.device || '',
    trace_id: c.traceId || '',
    detail: o.detail || '',
    created_at: u.isoNow(),
    prev_hash: prev,
  };
  row.hash = u.sha256(prev + canon(row));
  store.insert('audit_logs', row);
  return row;
}

/**
 * 校验哈希链完整性
 * @returns {{ok:boolean,total:number,brokenAt:?string,reason:?string}}
 */
function verifyChain() {
  const list = store.all('audit_logs');
  let prev = GENESIS;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (String(row.prev_hash) !== prev) {
      return { ok: false, total: list.length, brokenAt: row.id, reason: 'prev_hash 与上一条 hash 不一致（第 ' + (i + 1) + ' 条）' };
    }
    const expect = u.sha256(prev + canon(row));
    if (expect !== row.hash) {
      return { ok: false, total: list.length, brokenAt: row.id, reason: 'hash 校验失败（第 ' + (i + 1) + ' 条）' };
    }
    prev = row.hash;
  }
  return { ok: true, total: list.length, brokenAt: null, reason: null, headHash: prev };
}

/** 请求上下文（审计用） */
function ctxOf(req, user) {
  return {
    user: user || req.__user || null,
    ip: (req.headers['x-forwarded-for'] || req.ip || req.socket && req.socket.remoteAddress || '').toString().split(',')[0].trim(),
    device: String(req.headers['x-device'] || req.headers['user-agent'] || '').slice(0, 200),
    traceId: (req.res && req.res.locals && req.res.locals.traceId) || '',
  };
}

module.exports = { log, verifyChain, ctxOf, GENESIS, canon, lastHash };
