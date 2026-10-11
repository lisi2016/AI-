'use strict';
/**
 * Web 管理后台「账号密码」登录支撑（教务处后台专用）
 *
 * 设计要点：
 * 1. 密码存储：密码的 SHA-256 十六进制摘要，写入用户记录 `password_hash` 字段。
 *    生产环境建议替换为 bcrypt / argon2 + 随机盐，此处按需求保持「零新增依赖」。
 * 2. 种子用户（含全部演示账号）默认密码 `123456`；服务启动时对缺失 password_hash
 *    的用户自动补齐，便于已有 data 目录平滑升级。
 * 3. 仅 `dept_admin` / `admin` 允许通过 Web 后台登录，其它角色返回 40301。
 * 4. 连续 5 次密码错误锁定 15 分钟，失败次数与锁定时间落入 `data/login_attempts.json`。
 */
const u = require('./util');
const store = require('./store');
const { CODES, fail, paramError } = require('./errors');

// 种子用户默认密码（仅演示/初始化用途）
const DEFAULT_PASSWORD = '123456';
// 连续失败次数上限
const MAX_FAIL = 5;
// 锁定时长（毫秒）
const LOCK_MS = 15 * 60 * 1000;
// 允许登录 Web 后台的角色（契约 1.4：院系管理员 / 教务处）
const WEB_ROLES = ['dept_admin', 'admin'];
// 失败记录保留时长（超出后清理，避免文件无限增长）
const ATTEMPT_KEEP_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 密码
/** 密码摘要：SHA-256 十六进制（与种子写入的默认密码摘要口径一致） */
function hashPassword(plain) {
  return u.sha256(String(plain === undefined || plain === null ? '' : plain));
}

/**
 * 为所有缺失 password_hash 的用户补齐默认密码摘要。
 * 首次启动 / 新增用户 / 老数据升级都会走到这里。
 * @returns {number} 本次补齐的用户数
 */
function ensurePasswordHashes() {
  const now = u.isoNow();
  let count = 0;
  store.all('users').forEach(function (user) {
    if (!user.password_hash) {
      user.password_hash = hashPassword(DEFAULT_PASSWORD);
      user.password_updated_at = now;
      count++;
    }
  });
  if (count) store.touch('users');
  return count;
}

/** 常量时间比较（避免时序侧信道） */
function safeEqual(a, b) {
  try {
    return u.timingEqual(String(a || ''), String(b || ''));
  } catch (e) {
    return false;
  }
}

/** 校验明文密码是否匹配用户记录 */
function verifyPassword(user, plain) {
  if (!user || !user.password_hash) return false;
  return safeEqual(hashPassword(plain), user.password_hash);
}

/** 密码强度校验（Web 端统一口径） */
function assertNewPassword(newPassword) {
  const pw = String(newPassword === undefined || newPassword === null ? '' : newPassword);
  if (!pw) throw paramError('新密码（newPassword）必填');
  if (pw.length < 6) throw paramError('新密码长度不得少于 6 位');
  if (pw.length > 64) throw paramError('新密码长度不得超过 64 位');
  if (/\s/.test(pw)) throw paramError('新密码不得包含空格');
  return pw;
}

/**
 * 修改本人密码
 * @param {object} user 当前登录用户
 * @param {string} oldPassword 原密码
 * @param {string} newPassword 新密码
 * @returns {{ok:boolean, updatedAt:string}}
 */
function changePassword(user, oldPassword, newPassword) {
  if (!user) throw fail(CODES.UNAUTH);
  if (!user.password_hash) {
    throw fail(CODES.UNAUTH, '该账号尚未开通密码登录，请联系教务处');
  }
  if (!String(oldPassword === undefined || oldPassword === null ? '' : oldPassword)) {
    throw paramError('原密码（oldPassword）必填');
  }
  if (!verifyPassword(user, oldPassword)) throw paramError('原密码不正确');
  const pw = assertNewPassword(newPassword);
  if (safeEqual(hashPassword(pw), user.password_hash)) throw paramError('新密码不得与原密码相同');
  user.password_hash = hashPassword(pw);
  user.password_updated_at = u.isoNow();
  user.updated_at = user.password_updated_at;
  store.touch('users');
  return { ok: true, updatedAt: user.password_updated_at };
}

// ---------------------------------------------------------------- 用户查找
/** 工号/学号归一化（去空格并转大写，便于大小写不敏感匹配） */
function normalizeNo(no) {
  return String(no === undefined || no === null ? '' : no).trim().toUpperCase();
}

/** 按工号/学号查找用户（精确匹配优先，其次大小写不敏感匹配） */
function findUserByNo(no) {
  const raw = String(no === undefined || no === null ? '' : no).trim();
  if (!raw) return null;
  const exact = store.find('users', function (x) {
    return String(x.staff_no || '') === raw || String(x.student_no || '') === raw;
  });
  if (exact) return exact;
  const key = normalizeNo(raw);
  return store.find('users', function (x) {
    return normalizeNo(x.staff_no) === key || normalizeNo(x.student_no) === key;
  });
}

/** 是否为允许 Web 登录的角色 */
function canLoginWeb(user) {
  return !!(user && WEB_ROLES.indexOf(user.role) >= 0);
}

// ---------------------------------------------------------------- 失败计数与锁定
function nowMs() { return Date.now(); }

/** 读取某账号的失败记录（顺带清理过期记录） */
function findAttempt(no, cleanup) {
  const key = normalizeNo(no);
  const list = store.all('login_attempts');
  if (cleanup !== false) {
    const now = nowMs();
    for (let i = list.length - 1; i >= 0; i--) {
      const row = list[i];
      const expired = Number(row.locked_until_ms || 0) < now && now - Number(row.updated_at_ms || 0) > ATTEMPT_KEEP_MS;
      if (expired) list.splice(i, 1);
    }
  }
  return list.find(function (r) { return r.no_key === key; }) || null;
}

/**
 * 锁定状态查询
 * @returns {{locked:boolean, remainSeconds:number, failCount:number}}
 */
function lockState(no) {
  const row = findAttempt(no);
  if (!row) return { locked: false, remainSeconds: 0, failCount: 0 };
  const until = Number(row.locked_until_ms || 0);
  if (until > nowMs()) {
    return { locked: true, remainSeconds: Math.max(1, Math.ceil((until - nowMs()) / 1000)), failCount: Number(row.fail_count || 0) };
  }
  // 锁定已过期：计数归零，重新开始
  if (until && until <= nowMs()) {
    row.fail_count = 0;
    row.locked_until_ms = 0;
    row.locked_until = '';
    row.updated_at_ms = nowMs();
    row.updated_at = u.isoNow();
    store.touch('login_attempts');
    return { locked: false, remainSeconds: 0, failCount: 0 };
  }
  return { locked: false, remainSeconds: 0, failCount: Number(row.fail_count || 0) };
}

/**
 * 记录一次密码失败；达到上限则锁定 15 分钟
 * @returns {{failCount:number, locked:boolean, remainSeconds:number, left:number}}
 */
function registerFailure(no, ip) {
  const now = nowMs();
  let row = findAttempt(no);
  if (!row) {
    row = store.insert('login_attempts', {
      id: store.newId('LA'),
      no_key: normalizeNo(no),
      no: String(no || ''),
      fail_count: 0,
      locked_until_ms: 0,
      locked_until: '',
      first_fail_at: u.isoNow(),
      last_fail_at: '',
      last_ip: '',
      updated_at_ms: now,
      updated_at: u.isoNow(),
    });
  }
  row.fail_count = Number(row.fail_count || 0) + 1;
  row.last_fail_at = u.isoNow();
  row.last_ip = String(ip || '');
  row.updated_at_ms = now;
  row.updated_at = row.last_fail_at;
  if (row.fail_count >= MAX_FAIL) {
    row.locked_until_ms = now + LOCK_MS;
    row.locked_until = u.isoNow(new Date(row.locked_until_ms));
  }
  store.touch('login_attempts');
  const locked = Number(row.locked_until_ms || 0) > now;
  return {
    failCount: row.fail_count,
    locked: locked,
    remainSeconds: locked ? Math.ceil((row.locked_until_ms - now) / 1000) : 0,
    left: Math.max(0, MAX_FAIL - row.fail_count),
  };
}

/** 登录成功后清空失败计数 */
function resetFailures(no) {
  const row = findAttempt(no);
  if (!row) return;
  if (Number(row.fail_count || 0) === 0 && !Number(row.locked_until_ms || 0)) return;
  row.fail_count = 0;
  row.locked_until_ms = 0;
  row.locked_until = '';
  row.updated_at_ms = nowMs();
  row.updated_at = u.isoNow();
  store.touch('login_attempts');
}

/** 锁定提示文案（秒 → 「X 分钟」/「X 秒」） */
function lockMessage(remainSeconds) {
  const s = Number(remainSeconds || 0);
  const text = s >= 60 ? Math.ceil(s / 60) + ' 分钟' : s + ' 秒';
  return '密码连续错误 ' + MAX_FAIL + ' 次，账号已锁定，请 ' + text + '后重试（或联系教务处解锁）';
}

module.exports = {
  DEFAULT_PASSWORD, MAX_FAIL, LOCK_MS, WEB_ROLES,
  hashPassword, ensurePasswordHashes, verifyPassword, changePassword, assertNewPassword,
  normalizeNo, findUserByNo, canLoginWeb,
  lockState, registerFailure, resetFailures, lockMessage,
};
