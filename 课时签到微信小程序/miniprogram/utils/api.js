// 接口层：页面只调本模块，不直接写 URL、不直接碰 wx.request
// 切换真实后端两步：
//   1. app.globalData.useMock = false
//   2. app.globalData.apiBase = 'https://<学校已备案域名>'
// 在此之前全部走本地 mock，界面与流程可完整演示
// 契约见 docs/miniapp/api-contract.md
//
// 认证约定（本次修复的关键）：
//   · 登录/绑定成功后必须由 utils/session.js 把 token 落盘，之后每个请求头都带
//     Authorization: Bearer <token>；
//   · 请求层收到 40101（后端「未登录或登录已失效」）时，统一清除本地会话并抛出
//     带 unauthorized=true 的可识别错误，由页面决定跳「去绑定」引导。

var mock = require('./mock.js');
var store = require('./store.js');
var session = require('./session.js');
var mockCode = require('./mock-code.js');
var mockSession = require('./mock-session.js');
var mockUnbind = require('./mock-unbind.js');

var NET_DELAY = 260; // mock 下模拟网络耗时，便于看到加载态
var UNAUTH = 40101;  // 契约第八节：未登录 / token 失效

// ---------------------------------------------------------------- mock 动态码登记表
// 说明：登记表已抽到 utils/mock-code.js（与 utils/mock-session.js 的课时会话码共用），
//       真实环境由后端签发；mock 下模拟「60 秒过期 + 一次性消费」，便于在开发者工具里
//       完整演示 A（扫码）/ B（6 位口令）两条通道与 41001/41002 提示。

/**
 * mock 版核验：与后端语义一致 —— 40401 / 41001 / 41002 / 40001
 * 课时会话码（sessionId 非空）返回 isSession=true + 本次课时信息；
 * 旧课表码保持原行为（isSession=false + 班干部 + 当日授课任务）。
 */
function mockVerifyCode(input) {
  try {
    return mockDelay(mockSession.verifyCode(input));
  } catch (e) {
    return reject(e);
  }
}

function reject(body) {
  return new Promise(function (resolve, rejectFn) { rejectFn(body); });
}

/** 统一 verifyCode 入参：字符串 = codeId；对象 = {codeId}|{code}|{qrContent} */
function normalizeVerifyInput(input) {
  return mockCode.normalizeVerifyInput(input);
}

function app() {
  return getApp();
}

function useMock() {
  var a = app();
  return !a || a.globalData.useMock !== false || !a.globalData.apiBase;
}

function base() {
  var a = app();
  return (a && a.globalData.apiBase) || '';
}

function token() {
  return session.getToken();
}

function mockDelay(data) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(data); }, NET_DELAY);
  });
}

/**
 * 构造 40101 错误：清本地会话 + 打可识别标记，页面据此跳绑定引导
 * @param {object} body 后端响应体（可能只有 msg）
 */
function unauthorizedError(body) {
  var b = body || {};
  session.clearSession();   // 关键：token 失效必须就地清掉，避免继续用坏 token 反复 40101
  return {
    code: UNAUTH,
    msg: b.msg || '未登录或登录已失效，请重新绑定工号/学号',
    unauthorized: true,
    traceId: b.traceId || ''
  };
}

/** 该错误是否为「未登录/登录失效」（页面据此跳绑定页而不是当成普通报错） */
function isUnauthorized(err) {
  return !!(err && (err.unauthorized === true || err.code === UNAUTH));
}

function request(method, path, data, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    wx.request({
      url: base() + path,
      method: method,
      data: data || {},
      header: {
        'Content-Type': opts.upload ? 'multipart/form-data' : 'application/json',
        'Authorization': 'Bearer ' + token()
      },
      timeout: 20000,
      success: function (res) {
        var body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && body.code === 0) {
          resolve(body.data);
          return;
        }
        // 40101：未登录或 token 失效 → 清会话 + 抛出可识别错误
        if (body.code === UNAUTH || res.statusCode === 401) {
          reject(unauthorizedError(body));
          return;
        }
        if (body.code === undefined) {
          reject({ code: 50001, msg: '服务返回异常（HTTP ' + res.statusCode + '）', raw: body });
          return;
        }
        reject(body);
      },
      fail: function (err) {
        var raw = (err && err.errMsg) || '';
        // 真机上最常见的失败：请求域名未在微信公众平台配置。
        // 开发期可在手机预览时用右上角菜单开启「开发调试」绕过；正式上线须用已备案的 HTTPS 域名。
        if (/not in domain list/i.test(raw)) {
          reject({
            code: 50003,
            domainBlocked: true,
            msg: '请求域名未在微信公众平台配置：' + base() +
              '。真机预览时请在右上角「…」菜单开启「开发调试」后重新进入；正式使用需改用已备案的 HTTPS 域名并在公众平台配置服务器域名。',
            raw: err
          });
          return;
        }
        if (/timeout/i.test(raw)) {
          reject({ code: 50004, msg: '请求超时：无法连接服务器 ' + base() + '，请检查手机网络后重试', raw: err });
          return;
        }
        reject({ code: 50001, msg: '网络请求失败：' + (raw || '请检查网络') + '（服务器 ' + base() + '）', raw: err });
      }
    });
  });
}

var api = {
  /**
   * 连通性预检：GET /api/v1/health（无需登录）。
   * 绑定页进入时调用，用来提前判断「手机能否连上后端」，避免一直停在"绑定中"。
   * @returns Promise<{ status, service, ... }>
   */
  ping: function () {
    if (useMock()) return mockDelay({ status: 'ok', mock: true, service: 'mock' });
    return request('GET', '/api/v1/health');
  },

  // ---------- 认证 ----------
  /**
   * wx.login 的 code 换取登录态
   * @param {string} code wx.login() 取得的 code
   * @returns Promise<{ token, needBind, openid, bindTicket, role, user, expiresAt }>
   *          已绑定：token 非空、needBind=false，可直接 session.saveSession(data)
   *          未绑定：needBind=true，附带 openid + bindTicket，需继续调 bind()
   */
  login: function (code) {
    if (useMock()) {
      // mock 下直接给一个已绑定的教师身份，便于离线演示（不发任何请求）
      return mockDelay({
        token: 'mock-token',
        tokenType: 'Bearer',
        needBind: false,
        openid: 'mock-openid',
        bindTicket: '',
        role: mock.teacher.role,
        user: mock.teacher
      });
    }
    return request('POST', '/api/v1/auth/login', { code: code });
  },

  /**
   * 绑定工号/学号（白名单校验，后端校验姓名 + 角色 + 是否已被其他微信占用）
   * @param {object} payload { openid, bindTicket, role: 'teacher'|'cadre', no, realName }
   * @returns Promise<{ token, role, user }>
   *          失败 reject({ code: 40301, msg })，msg 为后端原文，页面必须原样展示
   */
  bind: function (payload) {
    var p = payload || {};
    if (useMock()) {
      var role = p.role === 'cadre' ? 'cadre' : 'teacher';
      var base = role === 'cadre' ? mock.cadre : mock.teacher;
      var user = {
        id: 'MOCK-' + role,
        role: role,
        name: p.realName || base.name,
        realName: p.realName || base.name,
        staffId: role === 'teacher' ? (p.no || base.staffId) : '',
        studentId: role === 'cadre' ? (p.no || base.studentId) : '',
        no: p.no || '',
        dept: base.dept || '',
        className: base.className || '',
        duty: base.duty || ''
      };
      return mockDelay({ token: 'mock-token', tokenType: 'Bearer', needBind: false, role: role, user: user });
    }
    return request('POST', '/api/v1/auth/bind', {
      openid: p.openid || '',
      bindTicket: p.bindTicket || '',
      role: p.role || '',
      no: p.no || '',
      realName: p.realName || ''
    });
  },

  /** 取当前登录者（token 有效时用于恢复 user/role；失效则 reject 40101） */
  me: function () {
    if (useMock()) return mockDelay({ user: mock.teacher, role: mock.teacher.role });
    return request('GET', '/api/v1/auth/me');
  },

  /** 退出登录：让服务端吊销 token（失败也不影响本地清理） */
  logout: function () {
    if (useMock()) return mockDelay({ ok: true, revoked: true });
    return request('POST', '/api/v1/auth/logout');
  },

  /**
   * 解绑本人微信（POST /auth/unbind，**需登录**）——「我的」页的自助解绑入口
   *
   * 语义：只解除「微信 ↔ 工号/学号」的登录绑定，不删除档案、不影响历史课时与统计。
   * 服务端返回前会**立即吊销当前 token**，因此成功后页面必须 session.clearSession()，
   * 否则后续请求会以坏 token 反复 40101。
   * @returns Promise<{ ok, no, realName, unbound:true }>
   *          失败 reject({ code: 40001|40101|50001, msg })（msg 为后端原文）
   */
  unbind: function () {
    if (useMock()) {
      try { return mockDelay(mockUnbind.unbind()); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/auth/unbind');
  },

  /**
   * 未登录自助解绑 / 换绑（POST /auth/unbind-self）——「换了新微信、登不进去」时使用
   *
   * 弱凭证：白名单内的 工号/学号 + 真实姓名（必须完全一致），服务端叠加频率限制
   * （同一工号 24 小时 ≤2 次、同一 IP 1 小时 ≤5 次）与审计留痕。
   * @param {object} payload { no, realName }
   * @returns Promise<{ ok, no, realName, hadBinding:boolean }>
   *          失败 reject({ code: 40301|40001, msg })（msg 为后端原文，页面必须原样展示）
   */
  unbindSelf: function (payload) {
    var p = payload || {};
    if (useMock()) {
      try { return mockDelay(mockUnbind.unbindSelf(p)); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/auth/unbind-self', {
      no: p.no || '',
      realName: p.realName || ''
    });
  },

  /** 该错误是否需要「去绑定」引导 */
  isUnauthorized: isUnauthorized,

  // ---------- 动态确认码（A 真二维码 + B 6 位数字口令 双通道） ----------
  /**
   * 旧通道签发动态码（POST /code/generate，不绑定课时会话）
   *
   * 新流程统一走 POST /sessions 签发**会话码**（教师核验后能看到「本次课时」并直接确认），
   * 页面已不再调用本接口；保留它是为了：
   *   · 兼容仍在用旧通道的客户端（后端接口未删除）
   *   · 自测覆盖「旧课表码 isSession=false」分支（此时教师端会引导班干部重新出示课时二维码）
   * @param {object} [opts] { ttl: 秒, classId }
   * @returns Promise<{ codeId, code, qrPayload, qrUrl, expireAt, ttl, className, cadre }>
   *          code      —— 6 位数字口令（B 通道，教师手输）
   *          qrPayload —— 二维码要编码的字符串（A 通道，形如 kcsq://code/<codeId>）
   */
  generateCode: function (opts) {
    if (useMock()) {
      var row = mockCode.generate(opts);
      return mockDelay({
        codeId: row.codeId,
        code: row.code,
        codeLength: 6,
        qrPayload: row.qrPayload,
        qrUrl: row.qrPayload,          // 兼容别名
        expireAt: row.expireAtMs,
        expireAtMs: row.expireAtMs,
        ttl: row.ttl,
        className: mock.cadre.className,
        cadre: mock.cadre,
        channels: {
          qr: { payload: row.qrPayload, hint: '教师用「扫码确认」扫描此二维码' },
          code: { value: row.code, hint: '教师用手输此 6 位数字口令' }
        }
      });
    }
    return request('POST', '/api/v1/code/generate', opts || {});
  },

  /**
   * 教师核验动态码（A 扫码 / B 口令 / 直传 codeId 三种入参任一）
   * @param {string|object} input 字符串视为 codeId；对象支持 { codeId } | { code } | { qrContent }
   * @returns Promise<{ cadre, tasks, codeId, date, channel }>
   *          失败 reject({ code: 40401|41001|41002|40001, msg })
   */
  verifyCode: function (input) {
    if (useMock()) return mockVerifyCode(input);
    return request('POST', '/api/v1/code/verify', normalizeVerifyInput(input));
  },

  // ---------- mock 动态码自测辅助（仅 useMock 时有意义） ----------
  __mockCode: {
    /** 取当前 mock 动态码表（只读快照） */
    all: function () {
      return mockCode.all();
    },
    /** 人为置过期（自测 41001 用） */
    expire: function (codeId) {
      mockCode.expire(codeId);
    },
    /** 消费动态码（自测 41002 用） */
    consume: function (codeId) {
      try { mockCode.consume(mockCode.get(codeId)); } catch (e) { /* 已消费/已过期 */ }
      var row = mockCode.get(codeId);
      if (row) row.used = true;
    },
    /** 清空登记表 */
    reset: function () {
      mockCode.reset();
    },
    /** 按口令取码 */
    findByPass: function (passCode) { return mockCode.findByPass(passCode); }
  },

  /** mock 业务数据（课程清单 / 课时会话）自测辅助：回到种子状态 */
  __mock: {
    reset: function () { mockSession.reset(); },
    courses: function () { return mockSession.listCourses({ status: 'all' }); },
    sessions: function () { return mockSession.listSessions({ pageSize: 200 }); },
    /** 自助解绑 mock 状态（绑定表 + 请求留痕）自测辅助 */
    unbindState: function () { return mockUnbind.state(); },
    unbindReset: function () { return mockUnbind.reset(); }
  },

  // ================================================================
  // 业务流程简化（学生驱动 + 教师扫码确认）
  //   ① 班干部维护「班级课程清单」，长期保留
  //   ② 每次上课从清单带出 → POST /sessions 签发 60 秒动态码（A 二维码 + B 6 位口令）
  //   ③ 教师扫码/输口令 → POST /code/verify（isSession=true）→ POST /sessions/{id}/confirm
  //   ④ 记录与详情统一走 GET /sessions[/{id}]（证据四项，无手写签名、无定位）
  // ================================================================

  // ---------- 班级课程清单 ----------
  /**
   * 课程清单列表（班干部=本班 / 教师=按班只读 / 管理员=范围内）
   * @param {object} [params] { classId, keyword, status, term, weekday, page, pageSize }
   * @returns Promise<{ list, total, page, pageSize, summary:{total,active,archived} }>
   *          失败 reject({ code, msg })，msg 为后端原文（敏感词/长度/权限），页面必须原样展示
   */
  getClassCourses: function (params) {
    if (useMock()) return mockDelay(mockSession.listCourses(params));
    return request('GET', '/api/v1/class-courses', params || {});
  },

  /** 某日期「当天有课」的课程（按该日期的星期带出）→ { date, weekday, weekdayText, total, list } */
  getCoursesToday: function (params) {
    if (useMock()) return mockDelay(mockSession.coursesToday(params));
    return request('GET', '/api/v1/class-courses/today', params || {});
  },

  /** 单条课程清单详情 */
  getClassCourse: function (id) {
    if (useMock()) {
      var all = mockSession.listCourses({ status: 'all', pageSize: 500 }).list;
      var hit = all.filter(function (c) { return String(c.id) === String(id); })[0];
      if (!hit) return reject({ code: 40401, msg: '课程清单记录不存在：' + id });
      return mockDelay(hit);
    }
    return request('GET', '/api/v1/class-courses/' + id);
  },

  /**
   * 新增课程清单（课程名、授课老师必填；可选 星期/节次/地点/学时）
   * @param {object} payload { courseName, teacherName, weekday, section, place, hours, term, teacherNo, classId }
   */
  createClassCourse: function (payload) {
    if (useMock()) {
      try { return mockDelay(mockSession.createCourse(payload)); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/class-courses', payload || {});
  },

  /** 修改课程清单（部分字段；不可改教学班；已归档 42201） */
  updateClassCourse: function (id, payload) {
    if (useMock()) {
      try { return mockDelay(mockSession.updateCourse(id, payload)); } catch (e) { return reject(e); }
    }
    return request('PUT', '/api/v1/class-courses/' + id, payload || {});
  },

  /** 归档（软删除，status='archived'，重复删除 42201） */
  archiveClassCourse: function (id) {
    if (useMock()) {
      try { return mockDelay(mockSession.archiveCourse(id)); } catch (e) { return reject(e); }
    }
    return request('DELETE', '/api/v1/class-courses/' + id);
  },

  // ---------- 课时会话 ----------
  /**
   * 班干部发起一次课时（从课程清单带出，可临时调整实际授课人/节次/地点）
   * @param {object} payload { courseId?, courseName, teacherName, teachDate, section?, place?,
   *                           hours?, absentCount?, absentNames?, summary?, note?, discipline? }
   * @returns Promise<{ sessionId, codeId, code, qrPayload, qrUrl, ttl, expireAtMs, channels, session }>
   *          重复发起 40901；未来日期/必填缺失 40001；非本班 40301
   */
  createSession: function (payload) {
    if (useMock()) {
      try { return mockDelay(mockSession.createSession(payload)); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/sessions', payload || {});
  },

  /** 二维码过期后刷新（同一会话换新码；仅「待教师确认」可刷新，否则 42201） */
  refreshSessionCode: function (id, opts) {
    if (useMock()) {
      try { return mockDelay(mockSession.refreshSessionCode(id, opts)); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/sessions/' + id + '/code', opts || {});
  },

  /**
   * 课时会话列表（班干部=本班 / 教师=本人为实际授课人或本人确认过 / 管理员=范围内）
   * @param {object} [params] { date, status, from, to, classId, courseId, teacherName, tempAdjusted, nameMismatch, page, pageSize }
   * @returns Promise<{ list, total, page, pageSize, summary:{hours,byStatus,statusTotals,…} }>
   */
  getSessions: function (params) {
    if (useMock()) return mockDelay(mockSession.listSessions(params));
    return request('GET', '/api/v1/sessions', params || {});
  },

  /** 课时会话详情：{ session, course, teacher, initiator, confirmer, code, auditTail } */
  getSession: function (id) {
    if (useMock()) {
      try { return mockDelay(mockSession.getSessionDetail(id)); } catch (e) { return reject(e); }
    }
    return request('GET', '/api/v1/sessions/' + id);
  },

  /**
   * 任课教师确认本次课时（消费动态码 → status='done'）
   * @param {string} id 会话 id
   * @param {object} [payload] { codeId } | { code } | { qrContent }（三选一；不传则消费该会话最新有效码）
   * @returns Promise<{ ok, sessionId, status, counted, nameMismatch, codeConsumed, confirmedName, confirmedAt, teacherName, msg }>
   *          过期 41001 / 已消费 41002 / 无效 40401 / 状态不允许 42201
   */
  confirmSession: function (id, payload) {
    if (useMock()) {
      try { return mockDelay(mockSession.confirmSession(id, payload)); } catch (e) { return reject(e); }
    }
    return request('POST', '/api/v1/sessions/' + id + '/confirm', payload || {});
  },

  // ---------- 授课任务 ----------
  getTasks: function (date) {
    if (useMock()) return mockDelay(mock.todayCourses);
    return request('GET', '/api/v1/tasks', { date: date });
  },

  // ---------- 课时记录（只读：旧流程记录的历史查看） ----------
  // 说明：新流程的课时一律通过 /sessions 读写。
  //       旧流程遗留记录（教师发起 + 班干部签名）仍可只读查看，因此保留这两个只读接口；
  //       与之配套的写接口（POST /records、/sign、/reject、/revoke、/urge、补签、申诉）
  //       **已随业务流程简化从小程序端移除**（不填表、不手写签名、不再有审批）。
  getRecords: function (params) {
    if (useMock()) return mockDelay(store.getAll());
    return request('GET', '/api/v1/records', params || {});
  },

  getRecord: function (id) {
    if (useMock()) return mockDelay(store.getById(id));
    return request('GET', '/api/v1/records/' + id);
  },

  // ---------- 统计 ----------
  getOverview: function (params) {
    if (useMock()) {
      var c = store.countByStatus();
      return mockDelay({
        confirmedHours: c.total,
        waiting: c.wait,
        expired: c.expired,
        abnormal: c.expired + c.rejected
      });
    }
    return request('GET', '/api/v1/stats/overview', params || {});
  },

  getDeptStats: function (params) {
    if (useMock()) return mockDelay(mock.deptStats);
    return request('GET', '/api/v1/stats/by-dept', params || {});
  },

  // ---------- 导出与导入（归 Web 后台，小程序端只保留入口） ----------
  requestExport: function (params) {
    if (useMock()) return mockDelay({ jobId: 'mock-job', status: 'done' });
    return request('POST', '/api/v1/export/records', params || {});
  },

  getExportJob: function (jobId) {
    if (useMock()) return mockDelay({ jobId: jobId, status: 'done', downloadUrl: '' });
    return request('GET', '/api/v1/export/' + jobId);
  },

  // ---------- 开关 ----------
  isMock: useMock
};

module.exports = api;
