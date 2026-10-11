'use strict';
/**
 * 认证：HMAC-SHA256 自包含令牌（含 userId / 过期时间 7 天）+ 动态码签名
 * DEV_MODE 下不调用微信 code2Session；生产模式用 Node 18 内置 fetch 调用并容错
 */
const u = require('./util');
const { CODES, fail } = require('./errors');
const store = require('./store');

// 已登出的 token（进程内失效名单；重启即清空，属于可接受的简化）
const revokedTokens = new Set();

// ---------------------------------------------------------------- 令牌
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(s) { return Buffer.from(String(s), 'base64url').toString('utf8'); }

/** 生成访问令牌：payload = {uid, oid, ep, role, iat, exp} */
function issueToken(user, ttlSeconds) {
  const ttl = Number(ttlSeconds || u.TOKEN_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid: String(user.id),
    oid: user.openid || '',
    // 绑定世代（auth_epoch）：解绑时 +1，使该工号此前签发的所有令牌立即失效
    // （解绑后"旧微信"即使还持有未过期的 token 也无法继续以该工号身份操作）
    ep: Number(user.auth_epoch || 0),
    role: user.role,
    iat: now,
    exp: now + ttl,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = u.hmacSha256(body, u.TOKEN_SECRET);
  return { token: body + '.' + sig, payload: payload, expiresAt: u.isoNow(new Date(payload.exp * 1000)) };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const sig = parts[1];
  const expect = u.hmacSha256(body, u.TOKEN_SECRET);
  if (!u.timingEqual(sig, expect)) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(body)); } catch (e) { return null; }
  if (!payload || !payload.uid) return null;
  if (Number(payload.exp || 0) * 1000 < Date.now()) return null;
  return payload;
}

function revokeToken(token) { if (token) revokedTokens.add(String(token)); }
function isRevoked(token) { return revokedTokens.has(String(token)); }

function tokenFromReq(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

/** 解析当前登录用户；失败抛 40101 */
function currentUser(req) {
  if (req.__user) return req.__user;
  const token = tokenFromReq(req);
  if (!token) throw fail(CODES.UNAUTH);
  if (isRevoked(token)) throw fail(CODES.UNAUTH, '登录已失效，请重新登录');
  const payload = verifyToken(token);
  if (!payload) throw fail(CODES.UNAUTH);
  const user = store.findById('users', payload.uid);
  if (!user) throw fail(CODES.UNAUTH, '账号不存在');
  if (user.status !== 'active') throw fail(CODES.FORBIDDEN, '账号已被停用');
  // 绑定世代校验：解绑（换绑）会把 auth_epoch +1，使该工号此前签发的所有令牌立即失效。
  // 老令牌 payload 无 ep → 视为 0，与未解绑过的用户（auth_epoch 缺省 0）一致，向后兼容。
  if (Number(payload.ep || 0) !== Number(user.auth_epoch || 0)) {
    throw fail(CODES.UNAUTH, '微信绑定已变更（已解绑或换绑），请重新绑定工号/学号后继续');
  }
  req.__user = user;
  req.__token = token;
  return user;
}

/** 可选解析（不强制登录的接口用） */
function optionalUser(req) {
  try { return currentUser(req); } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  try { currentUser(req); next(); } catch (e) { next(e); }
}

/** 角色校验：越权 40301 */
function requireRole(roles) {
  const allow = Array.isArray(roles) ? roles : [roles];
  return function (req, res, next) {
    try {
      const user = currentUser(req);
      if (allow.indexOf(user.role) < 0) throw fail(CODES.FORBIDDEN, '当前角色（' + user.role + '）无权访问该接口');
      next();
    } catch (e) { next(e); }
  };
}

/** 内部任务令牌（定时任务用）：配置了 INTERNAL_JOB_TOKEN 时必须匹配，否则仅允许 admin */
function requireJobAuth(req, res, next) {
  try {
    const user = optionalUser(req);
    const provided = req.headers['x-internal-token'] || (req.body && req.body.internalToken) || req.query.internalToken;
    if (u.INTERNAL_JOB_TOKEN && provided && u.timingEqual(provided, u.INTERNAL_JOB_TOKEN)) return next();
    if (user && (user.role === 'admin' || user.role === 'dept_admin')) return next();
    throw fail(CODES.FORBIDDEN, '需要管理员身份或内部任务令牌');
  } catch (e) { next(e); }
}

// ---------------------------------------------------------------- 动态码签名
/** code 内容 = codeId + 时间戳签名（契约三.B） */
function signCode(codeId, expireAtMs) {
  const text = String(codeId) + '|' + Number(expireAtMs);
  return { code: text, sig: u.hmacSha256(text, u.CODE_SECRET) };
}

function verifyCodeSignature(codeId, expireAtMs, sig) {
  const text = String(codeId) + '|' + Number(expireAtMs);
  return u.timingEqual(sig, u.hmacSha256(text, u.CODE_SECRET));
}

// ---------------------------------------------------------------- 绑定票据
/** 未绑定用户登录后，返回一个短票据用于 /auth/bind（DEV_MODE 直接可用 mock openid） */
function issueBindTicket(openid, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { oid: String(openid), kind: 'bind', iat: now, exp: now + Number(ttlSeconds || 1800) };
  const body = b64url(JSON.stringify(payload));
  return body + '.' + u.hmacSha256('bind:' + body, u.TOKEN_SECRET);
}

function verifyBindTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return null;
  const parts = String(ticket).split('.');
  if (parts.length !== 2) return null;
  if (!u.timingEqual(parts[1], u.hmacSha256('bind:' + parts[0], u.TOKEN_SECRET))) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(parts[0])); } catch (e) { return null; }
  if (!payload || payload.kind !== 'bind') return null;
  if (Number(payload.exp || 0) * 1000 < Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------- 微信 code2Session
/** DEV_MODE：用 code 生成稳定的 mock openid；生产：真实调用 code2Session */
async function code2Session(code) {
  if (u.DEV_MODE) {
    const openid = 'dev_' + u.sha256('mock-openid:' + String(code)).slice(0, 24);
    return { openid: openid, unionid: '', sessionKey: '', mock: true };
  }
  const appid = process.env.WX_APPID || '';
  const secret = process.env.WX_APPSECRET || '';
  if (!appid || !secret) {
    throw fail(CODES.WX_FAIL, '服务端未配置 WX_APPID / WX_APPSECRET，无法调用微信接口（可设置 DEV_MODE=1 使用开发模式）');
  }
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(appid) +
    '&secret=' + encodeURIComponent(secret) +
    '&js_code=' + encodeURIComponent(code) +
    '&grant_type=authorization_code';
  let body;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    const resp = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    body = await resp.json();
  } catch (e) {
    throw fail(CODES.WX_FAIL, '微信 code2Session 调用失败：' + e.message);
  }
  if (!body || body.errcode || !body.openid) {
    throw fail(CODES.WX_FAIL, '微信 code2Session 返回异常：' + JSON.stringify(body));
  }
  return { openid: body.openid, unionid: body.unionid || '', sessionKey: body.session_key || '', mock: false };
}

module.exports = {
  issueToken, verifyToken, revokeToken, isRevoked, tokenFromReq,
  currentUser, optionalUser, requireAuth, requireRole, requireJobAuth,
  signCode, verifyCodeSignature, issueBindTicket, verifyBindTicket, code2Session,
};
