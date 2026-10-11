'use strict';
/**
 * HTTP 中间件：traceId、统一响应包、异步错误、错误码处理、幂等
 */
const crypto = require('crypto');
const u = require('./util');
const { CODES, AppError } = require('./errors');
const store = require('./store');

// ---------------------------------------------------------------- 统一响应
function ok(res, data, traceId) {
  const body = {
    code: 0,
    msg: 'ok',
    data: data === undefined || data === null ? {} : data,
    traceId: traceId || res.locals.traceId || '',
  };
  return res.status(200).json(body);
}

/** 异步路由包装：把 Promise 异常交给错误处理中间件 */
function wrap(fn) {
  return function (req, res, next) {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.then === 'function') r.catch(next);
    } catch (e) { next(e); }
  };
}

/** 分页参数解析（契约 1.2） */
function parsePage(query) {
  let page = parseInt((query && query.page) || 1, 10);
  let pageSize = parseInt((query && query.pageSize) || 20, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > 200) pageSize = 200;
  return { page: page, pageSize: pageSize };
}

function paginate(list, page, pageSize) {
  const total = list.length;
  const start = (page - 1) * pageSize;
  return { list: list.slice(start, start + pageSize), total: total, page: page, pageSize: pageSize };
}

// ---------------------------------------------------------------- traceId
function traceIdMiddleware(req, res, next) {
  const incoming = req.headers['x-trace-id'] || req.headers['x-request-id'];
  const id = String(incoming || crypto.randomBytes(4).toString('hex')).slice(0, 32);
  res.locals.traceId = id;
  res.setHeader('X-Trace-Id', id);
  next();
}

// ---------------------------------------------------------------- 访问日志
function accessLog(req, res, next) {
  const start = Date.now();
  res.on('finish', function () {
    const ms = Date.now() - start;
    console.log('[' + u.isoNow() + '] ' + req.method + ' ' + req.originalUrl +
      ' -> ' + res.statusCode + ' ' + ms + 'ms trace=' + (res.locals.traceId || '-'));
  });
  next();
}

// ---------------------------------------------------------------- 幂等
/**
 * 写操作幂等：Idempotency-Key + userId，24h 内同 Key 返回首次结果（契约 1.1 / 七）
 */
function idempotencyMiddleware(req, res, next) {
  const key = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
  if (!key || !/^(POST|PUT|PATCH|DELETE)$/i.test(req.method)) return next();

  // 延迟取用户：鉴权中间件已把用户挂到 req.__user 上
  const uid = (req.__user && req.__user.id) || 'anon';
  const cacheKey = String(uid) + ':' + String(key);
  const now = Date.now();

  // 顺带清理过期幂等记录（保留 24h）
  const all = store.all('idempotency');
  for (let i = all.length - 1; i >= 0; i--) {
    if (now - Number(all[i].createdAtMs || 0) > u.IDEMPOTENCY_TTL_MS) all.splice(i, 1);
  }

  const hit = all.find(function (r) { return r.key === cacheKey; });
  if (hit && now - Number(hit.createdAtMs || 0) <= u.IDEMPOTENCY_TTL_MS) {
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(hit.status || 200).json(hit.body);
  }

  const originJson = res.json.bind(res);
  res.json = function (body) {
    try {
      store.insert('idempotency', {
        id: store.newId('IK'),
        key: cacheKey,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        body: body,
        createdAtMs: Date.now(),
        createdAt: u.isoNow(),
      });
    } catch (e) { /* 幂等缓存失败不影响主流程 */ }
    return originJson(body);
  };
  next();
}

// ---------------------------------------------------------------- 错误处理
function notFoundHandler(req, res) {
  res.status(404).json({
    code: CODES.NOT_FOUND,
    msg: '接口不存在：' + req.method + ' ' + req.path,
    data: {},
    traceId: res.locals.traceId || '',
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const traceId = res.locals.traceId || '';
  if (err instanceof AppError) {
    if (err.code >= 50000) console.error('[error] ' + err.code + ' ' + err.message + ' trace=' + traceId, err.details || '');
    return res.status(err.httpStatus).json({
      code: err.code,
      msg: err.msg,
      data: err.details ? { details: err.details } : {},
      traceId: traceId,
    });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ code: CODES.PARAM, msg: '签名图超过 2MB 限制', data: {}, traceId: traceId });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: CODES.PARAM, msg: '请求体不是合法 JSON', data: {}, traceId: traceId });
  }
  console.error('[unhandled] trace=' + traceId, err && err.stack ? err.stack : err);
  return res.status(500).json({
    code: CODES.SERVER,
    msg: '服务端错误（' + (err && err.message ? err.message : 'unknown') + '）',
    data: {},
    traceId: traceId,
  });
}

module.exports = {
  ok, wrap, parsePage, paginate,
  traceIdMiddleware, accessLog, idempotencyMiddleware,
  notFoundHandler, errorHandler,
};
