// 会话层：token / user / role 的唯一读写入口
//
// 背景（本次修复的根因）：此前全目录没有任何代码写入 storage 的 token，
// utils/api.js 只读取 token，于是所有真实请求都不带 Authorization，
// 后端一律返回 40101「未登录或登录已失效」，班干部首页 api.generateCode() 失败，
// 二维码与 6 位口令都不显示。本模块把「登录结果落盘」与「未登录清理 + 引导」收在一处，
// 保证 token 一定被写入，且 40101 时一定被清掉并给出可操作入口。
//
// 本模块不拼 URL、不发请求（接口调用仍统一走 utils/api.js），也不依赖 api.js，避免循环引用。

var KEY_TOKEN = 'token';
var KEY_USER = 'user';
var KEY_ROLE = 'role';

function app() {
  try { return getApp(); } catch (e) { return null; }
}

function safeGet(key) {
  try { return wx.getStorageSync(key); } catch (e) { return ''; }
}

function safeSet(key, value) {
  try { wx.setStorageSync(key, value); } catch (e) { /* 存储不可用时忽略，内存态仍可用 */ }
}

function safeRemove(key) {
  try { wx.removeStorageSync(key); } catch (e) { /* 同上 */ }
}

/** 读取本地 token（空字符串表示未登录） */
function getToken() {
  return String(safeGet(KEY_TOKEN) || '');
}

/** 读取本地用户（对象或 null） */
function getUser() {
  var u = safeGet(KEY_USER);
  return u && typeof u === 'object' ? u : null;
}

/** 读取本地角色（取 user.role 兜底，避免两处不一致） */
function getRole() {
  var r = String(safeGet(KEY_ROLE) || '');
  if (r) return r;
  var u = getUser();
  return (u && u.role) || '';
}

/**
 * 登录/绑定成功后落盘：token 必须写入，否则后续所有请求都会 40101
 * @param {object} data 后端 /auth/login 或 /auth/bind 的 data（含 token、user、role）
 * @returns {object} 归一化后的 { token, user, role }
 */
function saveSession(data) {
  var d = data || {};
  var token = String(d.token || '');
  var user = d.user || null;
  // 后端在 /auth/login 与 /auth/bind 都会回 role；user 内也有 role，取其一即可
  var role = String(d.role || (user && user.role) || '');
  if (user && !user.role && role) user.role = role;

  safeSet(KEY_TOKEN, token);
  safeSet(KEY_USER, user);
  safeSet(KEY_ROLE, role);

  var a = app();
  if (a && a.globalData) {
    a.globalData.token = token;
    a.globalData.user = user;
    a.globalData.role = role;
    a.globalData.needBind = false;
  }
  return { token: token, user: user, role: role };
}

/** 清除本地会话（退出登录 / 收到 40101 时调用） */
function clearSession() {
  safeRemove(KEY_TOKEN);
  safeRemove(KEY_USER);
  safeRemove(KEY_ROLE);
  var a = app();
  if (a && a.globalData) {
    a.globalData.token = '';
    a.globalData.user = null;
    a.globalData.role = '';
    a.globalData.needBind = true;
  }
}

/** 是否已登录（有 token 即视为已登录；角色是否有效由后端判定） */
function hasSession() {
  return !!getToken();
}

// ---------------------------------------------------------------- 未登录引导
// 说明：40101 可能来自任意页面，这里统一给出「去绑定」入口，避免静默失败。
// 同一时刻只弹一次，防止并发请求各弹一个弹窗。
var guiding = false;

/**
 * 提示并跳转绑定页
 * @param {string} [reason] 说明文案（通常是后端 msg 或场景说明）
 * @param {object} [opts] { silent: true 时只跳转不弹窗 }
 */
function guideToBind(reason, opts) {
  var o = opts || {};
  var text = reason || '登录已失效，请重新绑定工号/学号后继续。';
  if (guiding) return;
  if (o.silent) {
    wx.navigateTo({
      url: '/pages/bind/bind',
      fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
    });
    return;
  }
  guiding = true;
  wx.showModal({
    title: '需要重新绑定',
    content: text,
    confirmText: '去绑定',
    cancelText: '暂不',
    success: function (res) {
      guiding = false;
      if (!res.confirm) return;
      // bind 页不在 tabBar 中，用 navigateTo；失败时退回首页（首页也会显示绑定引导）
      wx.navigateTo({
        url: '/pages/bind/bind',
        fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
      });
    },
    fail: function () { guiding = false; }
  });
}

module.exports = {
  KEY_TOKEN: KEY_TOKEN,
  KEY_USER: KEY_USER,
  KEY_ROLE: KEY_ROLE,
  getToken: getToken,
  getUser: getUser,
  getRole: getRole,
  saveSession: saveSession,
  clearSession: clearSession,
  hasSession: hasSession,
  guideToBind: guideToBind
};
