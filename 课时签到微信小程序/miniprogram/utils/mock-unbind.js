// 自助解绑（换绑）的 mock 语义 —— 与后端 POST /auth/unbind、POST /auth/unbind-self 保持一致，
// 便于在 useMock=true（未部署后端）时把「我的页解绑」「绑定页自助解绑并重新绑定」两条链路完整演示出来。
//
// 与真实后端一致的三条规则：
//   1) 弱凭证：白名单内的 工号/学号 + 真实姓名，二者必须**完全一致**，否则 40301；
//   2) 频率限制：同一 no 24 小时内最多 2 次、同一 IP 1 小时内最多 5 次，超限 40001；
//   3) 幂等：本就没有绑定也返回成功，hadBinding=false。
//
// 本模块只做「mock 服务端」语义（读/写本地 storage + 抛带 code/msg 的错误对象），
// 不拼 URL、不发请求、不弹窗；网络延迟与 reject 包装仍由 utils/api.js 统一处理。
// 解绑只解除「微信 ↔ 工号/学号」的绑定关系，不涉及任何课时/统计数据。

var KEY_BINDINGS = 'ch_bindings_v1';          // mock「服务端」的绑定表：no → openid
var KEY_REQUESTS = 'ch_unbind_requests_v1';   // 解绑请求计数与留痕（保留 7 天）

var LIMITS = {
  no: { max: 2, windowMs: 24 * 3600 * 1000, windowText: '24 小时' },
  ip: { max: 5, windowMs: 3600 * 1000, windowText: '1 小时' }
};
var RETENTION_MS = 7 * 24 * 3600 * 1000;
var MOCK_IP = '127.0.0.1';                    // mock 客户端 IP（真实环境由后端按请求头解析）

// 与后端种子白名单一致的演示数据（只覆盖小程序可绑定的教师/班干部）
var WHITELIST = [
  { no: '2010032', realName: '唐瑞明', role: 'teacher' },
  { no: '2011045', realName: '李慧', role: 'teacher' },
  { no: '2012088', realName: '王强', role: 'teacher' },
  { no: '2025030117', realName: '张一鸣', role: 'cadre' },
  { no: '2025030102', realName: '王悦', role: 'cadre' },
  { no: '2025030109', realName: '刘欣', role: 'cadre' },
  { no: '2025040201', realName: '陈思远', role: 'cadre' },
  { no: '2025040202', realName: '赵敏', role: 'cadre' }
];

/** mock 初始就「已绑定」的工号（便于演示 hadBinding=true；未部署后端时也能看到完整语义） */
function seedBindings() {
  return { '2010032': 'mock-openid', '2025030117': 'mock-openid' };
}

function safeGet(key) {
  try { return wx.getStorageSync(key); } catch (e) { return ''; }
}

function safeSet(key, value) {
  try { wx.setStorageSync(key, value); } catch (e) { /* 存储不可用时退化为内存态 */ }
}

function fail(code, msg) { return { code: code, msg: msg }; }

// ---------------------------------------------------------------- mock「服务端」状态
function bindings() {
  var b = safeGet(KEY_BINDINGS);
  if (!b || typeof b !== 'object') {
    b = seedBindings();
    safeSet(KEY_BINDINGS, b);
  }
  return b;
}

function requests() {
  var list = safeGet(KEY_REQUESTS);
  return list && list.length ? list : [];
}

function saveRequests(list) {
  // 与后端一致：仅保留最近 7 天（避免无限增长）
  var now = Date.now();
  var kept = [];
  for (var i = list.length - 1; i >= 0; i--) {
    if (now - Number(list[i].at || 0) <= RETENTION_MS) kept.unshift(list[i]);
  }
  safeSet(KEY_REQUESTS, kept);
  return kept;
}

function countIn(field, value, windowMs) {
  var now = Date.now();
  var key = String(value || '');
  if (!key) return 0;
  return requests().filter(function (r) {
    return String(r[field] || '') === key && now - Number(r.at || 0) <= windowMs;
  }).length;
}

/** 频率限制闸门：{ allowed, reason, msg }（与后端 src/unbind.js 同口径） */
function rateLimit(no, ip) {
  var noCount = countIn('no', no, LIMITS.no.windowMs);
  if (noCount >= LIMITS.no.max) {
    return {
      allowed: false, reason: 'rate_limited_no', scope: 'no',
      msg: '该工号/学号今日自助解绑次数已达上限（同一工号 ' + LIMITS.no.windowText + ' 内最多 ' +
        LIMITS.no.max + ' 次），请联系教务处解绑'
    };
  }
  var ipCount = countIn('ip', ip, LIMITS.ip.windowMs);
  if (ipCount >= LIMITS.ip.max) {
    return {
      allowed: false, reason: 'rate_limited_ip', scope: 'ip',
      msg: '当前网络自助解绑次数已达上限（同一 IP ' + LIMITS.ip.windowText + ' 内最多 ' +
        LIMITS.ip.max + ' 次），请稍后再试或联系教务处解绑'
    };
  }
  return { allowed: true, reason: 'ok', scope: '', msg: '' };
}

/** 记录一次已进入业务处理的请求（与后端一致：被限流直接拒绝的不计数） */
function record(entry) {
  var list = requests();
  list.push({
    no: String(entry.no || ''),
    realName: String(entry.realName || ''),
    ip: String(entry.ip || ''),
    hadBinding: entry.hadBinding === true,
    allowed: entry.allowed !== false,
    reason: String(entry.reason || (entry.allowed === false ? 'rejected' : 'ok')),
    at: Date.now()
  });
  return saveRequests(list);
}

function whiteOf(no) {
  var key = String(no || '');
  var hit = WHITELIST.filter(function (w) { return w.no === key; });
  return hit.length ? hit[0] : null;
}

/** mock 当前登录者（用于「解绑当前微信」） */
function currentUser() {
  var u = null;
  try { u = wx.getStorageSync('user'); } catch (e) { u = null; }
  return u && typeof u === 'object' ? u : null;
}

function noOfUser(user) {
  if (!user) return '';
  return String(user.no || user.staffId || user.studentId || '');
}

// ---------------------------------------------------------------- 对外语义
/**
 * 未登录自助解绑（对应 POST /auth/unbind-self）
 * @param {object} payload { no, realName }
 * @returns {object} { ok, no, realName, hadBinding }；失败抛 { code, msg }（msg 与后端口径一致）
 */
function unbindSelf(payload) {
  var p = payload || {};
  var no = String(p.no || '').trim();
  var realName = String(p.realName || '').trim();
  if (!no) throw fail(40001, '工号/学号（no）必填');
  if (!realName) throw fail(40001, '真实姓名（realName）必填');

  var gate = rateLimit(no, MOCK_IP);
  if (!gate.allowed) throw fail(40001, gate.msg);

  var white = whiteOf(no);
  if (!white || white.realName !== realName) {
    record({ no: no, realName: realName, ip: MOCK_IP, hadBinding: false, allowed: false, reason: white ? 'name_mismatch' : 'not_in_whitelist' });
    throw fail(40301, '姓名与工号/学号不匹配：请核对姓名是否与教务处登记完全一致（工号/学号 ' + no + '）；' +
      '若确实无法自助解绑，请联系教务处处理');
  }

  var map = bindings();
  var hadBinding = !!map[no];
  delete map[no];
  safeSet(KEY_BINDINGS, map);
  record({ no: no, realName: realName, ip: MOCK_IP, hadBinding: hadBinding, allowed: true, reason: 'ok' });
  return { ok: true, no: no, realName: realName, hadBinding: hadBinding };
}

/**
 * 解绑当前微信（对应 POST /auth/unbind，需登录）
 * @returns {object} { ok, no, realName, unbound:true }；未登录抛 40101
 */
function unbind() {
  var user = currentUser();
  var no = noOfUser(user);
  if (!no) throw fail(40101, '未登录或登录已失效，请重新绑定工号/学号');
  var map = bindings();
  delete map[no];
  safeSet(KEY_BINDINGS, map);
  return {
    ok: true,
    no: no,
    realName: String(user.name || user.realName || ''),
    unbound: true
  };
}

/** 自测辅助：当前 mock 绑定表 / 请求留痕快照 */
function state() {
  return { bindings: bindings(), requests: requests(), limits: LIMITS, ip: MOCK_IP };
}

/** 自测辅助：恢复初始 mock 状态（绑定表回到种子 + 清空请求留痕） */
function reset() {
  safeSet(KEY_BINDINGS, seedBindings());
  safeSet(KEY_REQUESTS, []);
  return state();
}

module.exports = {
  KEY_BINDINGS: KEY_BINDINGS,
  KEY_REQUESTS: KEY_REQUESTS,
  LIMITS: LIMITS,
  RETENTION_MS: RETENTION_MS,
  WHITELIST: WHITELIST,
  unbind: unbind,
  unbindSelf: unbindSelf,
  state: state,
  reset: reset
};
