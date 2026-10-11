'use strict';
/**
 * 错误码（契约第八节）
 */
const CODES = {
  OK: 0,
  PARAM: 40001,          // 参数错误
  UNAUTH: 40101,         // 未登录 / token 失效
  FORBIDDEN: 40301,      // 越权
  SELF_SIGN: 40302,      // 教师不能确认本人课时（需求 5.2）
  NOT_FOUND: 40401,      // 资源不存在
  DUP_RECORD: 40901,     // 重复记录（唯一性冲突）
  CODE_EXPIRED: 41001,   // 动态码已过期
  CODE_USED: 41002,      // 动态码已被使用
  BAD_STATE: 42201,      // 状态不允许该操作
  SIGNER_NOT_ALLOWED: 42202, // 签字人不在授权名单内
  SERVER: 50001,         // 服务端错误
  WX_FAIL: 50002,        // 第三方（微信接口）调用失败
};

const DEFAULT_MSG = {
  0: 'ok',
  40001: '参数错误',
  40101: '未登录或登录已失效',
  40301: '无权限执行该操作',
  40302: '教师不能确认本人课时（需求 5.2：提交人不得为签字人）',
  40401: '资源不存在',
  40901: '重复记录：该教师同一课程、教学班、日期、节次已存在有效记录',
  41001: '动态码已过期',
  41002: '动态码已被使用',
  42201: '当前状态不允许该操作',
  42202: '签字人不在该教学班授权名单内',
  50001: '服务端错误',
  50002: '微信接口调用失败',
};

/** HTTP 状态码映射：契约 1.4 要求越权返回 403，未登录返回 401 */
const HTTP_STATUS = {
  40001: 400,
  40101: 401,
  40301: 403,
  40302: 403,
  40401: 404,
  40901: 409,
  41001: 410,
  41002: 410,
  42201: 422,
  42202: 422,
  50001: 500,
  50002: 502,
};

class AppError extends Error {
  constructor(code, msg, details) {
    super(msg || DEFAULT_MSG[code] || 'error');
    this.name = 'AppError';
    this.code = code;
    this.msg = msg || DEFAULT_MSG[code] || 'error';
    this.details = details || null;
  }
  get httpStatus() { return HTTP_STATUS[this.code] || 400; }
}

function fail(code, msg, details) { return new AppError(code, msg, details); }

// 参数错误的快捷构造
function paramError(msg, details) { return new AppError(CODES.PARAM, msg || DEFAULT_MSG[CODES.PARAM], details); }

module.exports = { CODES, DEFAULT_MSG, HTTP_STATUS, AppError, fail, paramError };
