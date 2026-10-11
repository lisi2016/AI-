'use strict';
/**
 * 自助解绑（换绑）的弱凭证风控与落地
 *
 * 背景：一个工号/学号只能绑定一个微信。老师换手机/换微信后原本必须找教务处解绑，
 * 这里支撑「未登录也能自助解绑」的 POST /auth/unbind-self：
 *   · 凭证是**弱凭证**（白名单内的 工号/学号 + 真实姓名，二者完全一致），因此必须叠加
 *     **频率限制** 与 **审计留痕**，否则可被用来爆破姓名、或恶意解绑他人微信。
 *   · 计数与留痕落在新表 data/unbind_requests.json（store 表名 unbind_requests），
 *     仅保留最近 RETENTION_MS（7 天）的记录，并带防御性条数上限，避免无限增长。
 *
 * 频率限制口径（可被 README/自测引用的常量）：
 *   · 同一 no：LIMITS.no.windowMs（24 小时）内最多 LIMITS.no.max（2）次
 *   · 同一 IP：LIMITS.ip.windowMs（1 小时）内最多 LIMITS.ip.max（5）次
 *
 * 计数范围：**放行后进入业务处理的请求**（成功 + 姓名不符被拒）都计数，
 * 这样"猜姓名"每 24 小时最多只能试 2 次；而被限流直接拒绝的请求不再重复计数，
 * 避免攻击者靠刷请求把受害者的等待窗口无限延长。
 *
 * 零新增依赖：仅使用 store / util（Node 18 内置能力）。
 */
const u = require('./util');
const store = require('./store');

const TABLE = 'unbind_requests';

const LIMITS = {
  no: { max: 2, windowMs: 24 * 3600 * 1000, windowText: '24 小时' },
  ip: { max: 5, windowMs: 3600 * 1000, windowText: '1 小时' },
};

// 保留最近 7 天的记录（超过即清理）；另有条数上限做兜底
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const MAX_RECORDS = 5000;

function nowMs() { return Date.now(); }

function all() { return store.all(TABLE); }

/** 清理过期记录（按 created_at_ms）+ 条数上限；返回清理后的条数 */
function prune(now) {
  const t = now === undefined ? nowMs() : now;
  const list = all();
  for (let i = list.length - 1; i >= 0; i--) {
    if (t - Number(list[i].created_at_ms || 0) > RETENTION_MS) list.splice(i, 1);
  }
  if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
  return list.length;
}

/** 统计指定窗口内某字段取值的记录条数（field = 'no' | 'ip'） */
function countIn(field, value, windowMs, now) {
  const t = now === undefined ? nowMs() : now;
  const key = String(value === undefined || value === null ? '' : value);
  if (!key) return 0;
  return all().filter(function (r) {
    return String(r[field] || '') === key && t - Number(r.created_at_ms || 0) <= windowMs;
  }).length;
}

/** 当前计数快照（自测/排障用） */
function countsOf(no, ip, now) {
  const t = now === undefined ? nowMs() : now;
  return {
    no: countIn('no', no, LIMITS.no.windowMs, t),
    ip: countIn('ip', ip, LIMITS.ip.windowMs, t),
  };
}

/**
 * 频率限制闸门（必须在业务处理之前调用）
 * @param {string} no 工号/学号
 * @param {string} ip 客户端 IP
 * @returns {{allowed:boolean, reason:string, msg:string, noCount:number, ipCount:number}}
 */
function rateLimit(no, ip, now) {
  const t = now === undefined ? nowMs() : now;
  const noCount = countIn('no', no, LIMITS.no.windowMs, t);
  if (noCount >= LIMITS.no.max) {
    return {
      allowed: false,
      scope: 'no',
      reason: 'rate_limited_no',
      noCount: noCount,
      ipCount: countIn('ip', ip, LIMITS.ip.windowMs, t),
      msg: '该工号/学号今日自助解绑次数已达上限（同一工号 ' + LIMITS.no.windowText + ' 内最多 ' +
        LIMITS.no.max + ' 次），请联系教务处解绑',
    };
  }
  const ipCount = countIn('ip', ip, LIMITS.ip.windowMs, t);
  if (String(ip || '') && ipCount >= LIMITS.ip.max) {
    return {
      allowed: false,
      scope: 'ip',
      reason: 'rate_limited_ip',
      noCount: noCount,
      ipCount: ipCount,
      msg: '当前网络自助解绑次数已达上限（同一 IP ' + LIMITS.ip.windowText + ' 内最多 ' +
        LIMITS.ip.max + ' 次），请稍后再试或联系教务处解绑',
    };
  }
  return { allowed: true, scope: '', reason: 'ok', noCount: noCount, ipCount: ipCount, msg: '' };
}

/**
 * 记录一次「已进入业务处理」的解绑请求（成功 / 姓名不符被拒都记）
 * @param {object} entry { no, realName, ip, device, hadBinding, allowed, reason }
 */
function record(entry) {
  const e = entry || {};
  const t = nowMs();
  prune(t);
  const allowed = e.allowed !== false;
  const row = {
    id: store.newId('UB'),
    no: String(e.no || ''),
    real_name: String(e.realName || ''),
    ip: String(e.ip || ''),
    device: String(e.device || '').slice(0, 200),
    had_binding: e.hadBinding === true,
    allowed: allowed,
    reason: String(e.reason || (allowed ? 'ok' : 'rejected')),
    created_at: u.isoNow(),
    created_at_ms: t,
  };
  store.insert(TABLE, row);
  return row;
}

/** 白名单（active）按工号/学号查询 */
function whitelisted(no) {
  const key = String(no || '');
  return store.find('whitelist', function (w) {
    return String(w.no) === key && w.status === 'active';
  }) || null;
}

/** 按工号或学号查用户档案（自助解绑不区分角色：工号/学号均可） */
function userByNo(no) {
  const key = String(no || '');
  return store.find('users', function (x) {
    return String(x.staff_no) === key || String(x.student_no) === key;
  }) || null;
}

/**
 * 解除某用户档案的微信绑定（仅清 openid/unionid，不动档案与任何历史数据）
 * 同时把 auth_epoch +1：该工号此前签发的所有令牌立即失效
 * （否则"旧微信"手里的未过期 token 仍能以该工号身份继续操作，解绑就不彻底）。
 * @returns {{hadBinding:boolean, before:string}} before = 解绑前的 openid（脱敏由调用方负责）
 */
function unbindUser(user) {
  if (!user) return { hadBinding: false, before: '' };
  const before = String(user.openid || '');
  user.openid = '';
  // unionid 同属微信侧标识：当前实现恒为空，一并清空以免残留
  user.unionid = '';
  user.auth_epoch = Number(user.auth_epoch || 0) + 1;
  user.updated_at = u.isoNow();
  store.touch('users');
  return { hadBinding: !!before, before: before };
}

module.exports = {
  TABLE, LIMITS, RETENTION_MS, MAX_RECORDS,
  all, prune, countIn, countsOf, rateLimit, record,
  whitelisted, userByNo, unbindUser,
};
