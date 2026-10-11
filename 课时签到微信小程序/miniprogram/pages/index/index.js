// 首页：按「真实登录身份」渲染不同内容（业务流程简化版）
//
// 新流程（学生驱动 + 教师扫码确认）：
//   ① 班干部先在「我的课程」里录入一次本班课程清单（长期保留）
//   ② 每次上课：首页「今日课程」直接点「出示二维码」→ POST /sessions（缺省自动带出该课信息）
//      如需临时调整（换老师 / 改节次 / 改地点），走「临时调整」面板后再出示，全程无需审批
//   ③ 任课教师扫二维码或输 6 位口令 → POST /code/verify → 看到本次课时信息 → POST /sessions/{id}/confirm
//   ④ 学时按学生端录入的「实际授课人」统计
//
// 身份来源：app.globalData.role / user（绑定页写入 storage，app.onLaunch 用 GET /auth/me 恢复）。
// 动态确认码 A+B 双通道：A 真二维码（canvas 渲染 qrPayload）+ B 6 位数字口令，60 秒有效、一次性。
// 本页不采集定位（无任何位置类接口调用）。

var app = getApp();
var api = require('../../utils/api.js');
var qrcode = require('../../utils/qrcode.js');
var codeParse = require('../../utils/code-parse.js');
var session = require('../../utils/session.js');
var shape = require('../../utils/shape.js');

var DEFAULT_TTL = 60;
var RECENT_SIZE = 5;

function trim(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

Page({
  data: {
    role: '',
    ready: false,
    user: null,
    // 未登录 / 未绑定：显示「去绑定」引导，绝不静默失败
    needBind: false,
    bindHint: '',
    loading: false,
    loadError: '',
    todayText: '',
    todayWeekdayText: '',

    // ---- 班干部：今日课程 + 出示面板 + 最近课时
    courses: [],
    courseEmpty: false,
    recentSessions: [],
    pendingCount: 0,
    seconds: DEFAULT_TTL,
    codeExpired: false,
    codeId: '',
    code: '',
    codeDisplay: '',
    qrPayload: '',
    qrSize: 220,
    qrVersion: 0,
    codeLoading: false,
    codeError: '',
    sessionError: '',
    // 当前出示的课时会话（面板）
    panel: {
      show: false, sessionId: '', courseName: '', teacherName: '', className: '',
      section: '', time: '', place: '', hours: 0, isTempAdjusted: false,
      initiatorName: '', initiatorDuty: '', statusText: ''
    },
    // 临时调整表单（本次课；不等同于改课程清单）
    adj: {
      show: false, courseId: '', courseName: '', teacherName: '', section: '', place: '',
      hours: '', absentCount: '', summary: '', saveToCourse: false, error: ''
    },

    // ---- 教师
    todayCount: 0,
    doneCount: 0,
    waitCount: 0,
    tasks: [],
    waitSessions: [],
    weekHours: 0,
    weekRangeText: '',

    // ---- 教务处 / 院系管理员
    deptStats: [],
    weekTotal: 0,
    waitTotal: 0,
    abnormalCount: 0
  },

  onLoad: function () {
    // canvas 使用 px 坐标系：按屏宽算出边长为整数，避免真机上出现半像素缝隙
    var width = 375;
    try {
      var info = wx.getSystemInfoSync();
      if (info && info.windowWidth) width = info.windowWidth;
    } catch (e) { /* 取不到就用默认宽度 */ }
    var size = Math.max(180, Math.min(260, Math.floor(width - 150)));
    this.setData({
      qrSize: size,
      todayText: shape.todayFull()
    });
  },

  onShow: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () { that.render(); });
  },

  onHide: function () { this.stopTimer(); },
  onUnload: function () { this.stopTimer(); },

  onPullDownRefresh: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () { that.render(); }).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  /** 按当前登录身份渲染；未登录时给出绑定引导 */
  render: function () {
    var role = (app.globalData && app.globalData.role) || session.getRole() || '';
    var user = (app.globalData && app.globalData.user) || session.getUser() || null;
    var needBind = !role || !user;
    var keep = !needBind && role === 'cadre' && this.data.panel.show;
    this.stopTimer();
    this.setData({
      role: role,
      user: user,
      ready: true,
      needBind: needBind,
      bindHint: (app.globalData && app.globalData.bindHint) || '',
      // 身份变化时清掉上一位用户出示中的动态码，避免误出示
      panel: keep ? this.data.panel : { show: false, sessionId: '', courseName: '', teacherName: '', className: '', section: '', time: '', place: '', hours: 0, isTempAdjusted: false, initiatorName: '', initiatorDuty: '', statusText: '' },
      code: role === 'cadre' && keep ? this.data.code : '',
      codeDisplay: role === 'cadre' && keep ? this.data.codeDisplay : '',
      qrPayload: role === 'cadre' && keep ? this.data.qrPayload : '',
      codeError: '',
      sessionError: '',
      adj: { show: false, courseId: '', courseName: '', teacherName: '', section: '', place: '', hours: '', absentCount: '', summary: '', saveToCourse: false, error: '' }
    });
    if (needBind) return;
    if (role === 'teacher') this.loadTeacher();
    if (role === 'cadre') this.loadCadre();
    if (role === 'admin' || role === 'dept_admin') this.loadAdmin();
  },

  /** 未登录引导：可点跳绑定页 */
  goBind: function () {
    wx.navigateTo({
      url: '/pages/bind/bind',
      fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
    });
  },

  /** 收到 40101：本地会话已被 api 层清除，这里切换到「去绑定」引导 */
  handleUnauthorized: function (err) {
    this.stopTimer();
    this.setData({
      needBind: true,
      role: '',
      user: null,
      courses: [],
      recentSessions: [],
      panel: { show: false, sessionId: '', courseName: '', teacherName: '', className: '', section: '', time: '', place: '', hours: 0, isTempAdjusted: false, initiatorName: '', initiatorDuty: '', statusText: '' },
      code: '',
      codeDisplay: '',
      qrPayload: '',
      codeId: '',
      codeError: '',
      codeLoading: false,
      codeExpired: false,
      bindHint: (err && err.msg) || '登录已失效，请重新绑定工号/学号'
    });
    session.guideToBind((err && err.msg) || '');
  },

  // ================================================================
  // 班干部
  // ================================================================
  /** 今日课程（GET /class-courses/today）+ 最近课时（GET /sessions） */
  loadCadre: function () {
    var that = this;
    var date = shape.todayFull();
    this.setData({ loading: true, loadError: '', todayText: date });
    return api.getCoursesToday({ date: date }).then(function (data) {
      var list = shape.courseList(data);
      that.setData({
        loading: false,
        courses: list,
        courseEmpty: list.length === 0,
        todayWeekdayText: (data && data.weekdayText) || ''
      });
      return null;
    }).catch(function (err) {
      that.setData({ loading: false, courses: [], courseEmpty: true, loadError: (err && err.msg) || '今日课程加载失败' });
      if (api.isUnauthorized(err)) that.handleUnauthorized(err);
      return null;
    }).then(function () {
      return that.loadRecentSessions();
    });
  },

  /** 本班最近课时：GET /sessions（角标口径取 summary.statusTotals，不受筛选影响） */
  loadRecentSessions: function () {
    var that = this;
    return api.getSessions({ page: 1, pageSize: RECENT_SIZE }).then(function (data) {
      var page = shape.pageOf(data);
      var totals = shape.statusTotals(page);
      that.setData({
        recentSessions: shape.sessionList(page.list),
        pendingCount: Number(totals.wait || 0)
      });
      return null;
    }).catch(function (err) {
      if (api.isUnauthorized(err)) that.handleUnauthorized(err);
      return null;
    });
  },

  /** 「我的课程」入口 */
  goCourses: function () {
    wx.navigateTo({ url: '/pages/courses/courses', fail: function () { wx.switchTab({ url: '/pages/index/index' }); } });
  },

  /** 点击「出示二维码」：缺省直接从课程清单带出，不重复录入 */
  presentCode: function (e) {
    if (this.data.needBind) { this.goBind(); return; }
    var id = e.currentTarget.dataset.id;
    var c = this.__findCourse(id);
    if (!c) return;
    this.__pendingSave = null;
    this.startSession({
      courseId: c.id,
      courseName: c.courseName,
      teacherName: c.teacherName,
      teachDate: shape.todayFull(),
      section: c.section,
      place: c.place,
      hours: c.hours
    });
  },

  __findCourse: function (id) {
    var hit = (this.data.courses || []).filter(function (c) { return String(c.id) === String(id); });
    return hit[0] || null;
  },

  // ---------- 临时调整（本次课；无需审批） ----------
  openAdjust: function (e) {
    if (this.data.needBind) { this.goBind(); return; }
    var id = e.currentTarget.dataset.id;
    var c = this.__findCourse(id);
    if (!c) return;
    this.setData({
      adj: {
        show: true,
        courseId: c.id,
        courseName: c.courseName,
        teacherName: c.teacherName,
        section: c.section,
        place: c.place,
        hours: String(c.hours || 2),
        absentCount: '',
        summary: '',
        saveToCourse: false,
        error: ''
      }
    });
  },

  closeAdjust: function () {
    this.setData({ 'adj.show': false, 'adj.error': '' });
  },

  onAdjTeacher: function (e) { this.setData({ 'adj.teacherName': e.detail.value, 'adj.error': '' }); },
  onAdjSection: function (e) { this.setData({ 'adj.section': e.detail.value, 'adj.error': '' }); },
  onAdjPlace: function (e) { this.setData({ 'adj.place': e.detail.value, 'adj.error': '' }); },
  onAdjHours: function (e) { this.setData({ 'adj.hours': e.detail.value, 'adj.error': '' }); },
  onAdjAbsentCount: function (e) { this.setData({ 'adj.absentCount': e.detail.value, 'adj.error': '' }); },
  onAdjSummary: function (e) { this.setData({ 'adj.summary': e.detail.value, 'adj.error': '' }); },

  toggleSaveToCourse: function () {
    this.setData({ 'adj.saveToCourse': !this.data.adj.saveToCourse });
  },

  /** 临时调整后出示二维码：本次课走调整值；勾选「同时保存到课程清单」则额外 PUT /class-courses/{id} */
  submitAdjust: function () {
    var a = this.data.adj;
    var teacherName = trim(a.teacherName);
    if (!teacherName) {
      this.setData({ 'adj.error': '请填写本次课的实际授课人' });
      return;
    }
    if (a.saveToCourse) {
      this.__pendingSave = {
        id: a.courseId,
        payload: {
          teacherName: teacherName,
          section: trim(a.section),
          place: trim(a.place),
          hours: trim(a.hours) === '' ? undefined : Number(a.hours)
        }
      };
    } else {
      this.__pendingSave = null;
    }
    this.setData({ 'adj.show': false });
    this.startSession({
      courseId: a.courseId,
      courseName: a.courseName,
      teacherName: teacherName,
      teachDate: shape.todayFull(),
      section: trim(a.section),
      place: trim(a.place),
      hours: trim(a.hours) === '' ? undefined : Number(a.hours),
      absentCount: trim(a.absentCount) === '' ? undefined : Number(a.absentCount),
      summary: trim(a.summary)
    });
  },

  /**
   * 发起一次课时并出示动态码：POST /sessions
   * @param {object} payload 见 api.createSession
   */
  startSession: function (payload) {
    var that = this;
    this.stopTimer();
    this.setData({ codeLoading: true, codeError: '', codeExpired: false, sessionError: '' });

    api.createSession(payload).then(function (d) {
      that.applyCode(d);
      that.saveToCourseIfNeeded();
      return null;
    }).catch(function (err) {
      if (api.isUnauthorized(err)) {
        that.setData({ codeLoading: false });
        that.handleUnauthorized(err);
        return null;
      }
      var msg = (err && err.msg) || '发起课时失败，请稍后重试';
      var details = (err && err.details) || (err && err.data && err.data.details) || {};
      var sid = details.existingSessionId || details.existingId || '';

      // 同一节课已经发起过（唯一性 40901）：
      //   - 仍是「待教师确认」→ 直接复用该会话并刷新动态码（再次点「出示二维码」应该有用，而不是报错）
      //   - 已确认/已过期等不可刷新 → 明确提示并引导查看该课时
      if (Number(err && err.code) === 40901 && sid) {
        api.refreshSessionCode(sid).then(function (d) {
          that.applyCode(d);
          wx.showToast({ title: '本节课已发起过，已刷新二维码', icon: 'none', duration: 2500 });
          return null;
        }).catch(function () {
          that.setData({ codeLoading: false, codeError: msg, codeExpired: true });
          wx.showModal({
            title: '本节课已发起过',
            content: msg,
            showCancel: true,
            cancelText: '知道了',
            confirmText: '查看该课时',
            success: function (res) {
              if (res.confirm) wx.navigateTo({ url: '/pages/check/check?id=' + sid });
            }
          });
          return null;
        });
        return null;
      }

      that.setData({ codeLoading: false, codeError: msg, codeExpired: true, panel: { show: false, sessionId: '', courseName: '', teacherName: '', className: '', section: '', time: '', place: '', hours: 0, isTempAdjusted: false, initiatorName: '', initiatorDuty: '', statusText: '' } });
      // 其它业务错误：原样展示后端 msg，并引导去已有会话详情
      wx.showModal({
        title: '未能发起本次课时',
        content: msg,
        showCancel: !!sid,
        cancelText: '知道了',
        confirmText: sid ? '查看该课时' : '知道了',
        success: function (res) {
          if (res.confirm && sid) wx.navigateTo({ url: '/pages/check/check?id=' + sid });
        }
      });
      return null;
    });
  },

  /** 勾选「同时保存到课程清单」时的额外 PUT（失败只提示，不影响已发起的本次课时） */
  saveToCourseIfNeeded: function () {
    var pend = this.__pendingSave;
    if (!pend || !pend.id) { this.__pendingSave = null; return; }
    var that = this;
    this.__pendingSave = null;
    api.updateClassCourse(pend.id, pend.payload).then(function () {
      wx.showToast({ title: '已同步到课程清单', icon: 'none' });
      that.loadCadre();
      return null;
    }).catch(function (err) {
      var msg = (err && err.msg) || '课程清单同步失败';
      wx.showModal({ title: '课程清单未同步', content: msg + '（本次课时已按调整值发起）', showCancel: false, confirmText: '知道了' });
      return null;
    });
  },

  /** 用 POST /sessions 的返回渲染面板 + 二维码 + 倒计时 */
  applyCode: function (d) {
    var data = d || {};
    var s = shape.sessionOf(data.session || data.sessionInfo || {});
    var ttl = Number(data.ttl || DEFAULT_TTL);
    var code = String(data.code || '');
    var payload = data.qrPayload || data.qrUrl || '';
    this.setData({
      codeLoading: false,
      codeId: data.codeId || '',
      code: code,
      codeDisplay: code.split('').join(' '),
      qrPayload: payload,
      seconds: ttl,
      codeExpired: false,
      codeError: '',
      sessionError: '',
      panel: {
        show: true,
        sessionId: data.sessionId || s.sessionId,
        courseName: s.courseName,
        teacherName: s.teacherName,
        className: s.className,
        section: s.section,
        time: s.time,
        place: s.place,
        hours: s.hours,
        isTempAdjusted: !!s.isTempAdjusted,
        initiatorName: s.initiatorName,
        initiatorDuty: s.initiatorDuty,
        statusText: s.statusText
      }
    });
    this.drawQr(payload);
    this.startTimer(ttl);
  },

  /** 二维码过期时刷新：POST /sessions/{id}/code（同一会话换新码） */
  refreshCodeTap: function () {
    var that = this;
    if (this.data.needBind) { this.goBind(); return; }
    var sid = this.data.panel.sessionId;
    if (!sid) {
      // 没有课时会话（例如上次发起失败）：不再签发「旧课表码」，直接引导重新发起本次课时
      wx.showModal({
        title: '请先发起本次课时',
        content: '还没有本次课时的二维码。请点「出示二维码」重新发起（缺省自动带出课程清单信息）。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    if (this.data.codeLoading) return;
    this.stopTimer();
    this.setData({ codeLoading: true, codeError: '', codeExpired: false, sessionError: '' });
    wx.showToast({ title: '正在刷新…', icon: 'none', duration: 800 });
    api.refreshSessionCode(sid).then(function (d) {
      that.applyCode(d);
      return null;
    }).catch(function (err) {
      var msg = (err && err.msg) || '动态码刷新失败，请稍后重试';
      that.setData({ codeLoading: false, codeError: msg, codeExpired: true });
      if (api.isUnauthorized(err)) { that.handleUnauthorized(err); return; }
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      // 42201（已被确认 / 已过期）等状态变化：刷新列表让班干部看到最新状态
      that.loadRecentSessions();
      return null;
    });
  },

  closePanel: function () {
    this.stopTimer();
    this.setData({
      panel: { show: false, sessionId: '', courseName: '', teacherName: '', className: '', section: '', time: '', place: '', hours: 0, isTempAdjusted: false, initiatorName: '', initiatorDuty: '', statusText: '' },
      code: '', codeDisplay: '', qrPayload: '', codeId: '', codeExpired: false, codeError: '', sessionError: '', qrVersion: 0
    });
    this.loadRecentSessions();
  },

  /** 用 canvas 真正渲染二维码（A 通道） */
  drawQr: function (payload) {
    if (!payload) return;
    if (typeof wx.createCanvasContext !== 'function') {
      this.setData({ codeError: '当前基础库不支持 canvas，请升级微信后重试' });
      return;
    }
    var qr;
    try {
      qr = qrcode.encode(payload);
    } catch (e) {
      this.setData({ codeError: '二维码生成失败：' + (e && e.message ? e.message : '内容过长') });
      return;
    }
    this.setData({ qrVersion: qr.version });

    var px = this.data.qrSize;
    var quiet = qr.quietZone;            // 标准要求四周留 4 个模块静默区
    var total = qr.size + quiet * 2;
    var cell = px / total;
    // 说明：这里用旧版 canvas 接口 wx.createCanvasContext，而不是 type="2d"。
    // 原因：旧接口在开发者工具与真机上都能直接显示，无需等 wx.createSelectorQuery 的异步节点。
    var ctx = wx.createCanvasContext('qrcode', this);
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, px, px);
    ctx.setFillStyle('#000000');
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x] === 1) {
          ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell + 0.5, cell + 0.5);
        }
      }
    }
    ctx.draw();
  },

  startTimer: function (ttl) {
    var that = this;
    this.stopTimer();
    var seconds = Number(ttl || DEFAULT_TTL);
    this.setData({ seconds: seconds, codeExpired: false });
    this._timer = setInterval(function () {
      var s = that.data.seconds - 1;
      if (s <= 0) {
        that.stopTimer();
        that.setData({ seconds: 0, codeExpired: true });
      } else {
        that.setData({ seconds: s });
      }
    }, 1000);
  },

  stopTimer: function () {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  /** 点击复制 6 位口令（B 通道兜底体验） */
  copyCode: function () {
    var code = this.data.code;
    if (!code) {
      wx.showToast({ title: '暂无可复制的口令', icon: 'none' });
      return;
    }
    if (this.data.codeExpired) {
      wx.showToast({ title: '口令已失效，请先刷新', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: code,
      success: function () { wx.showToast({ title: '口令已复制', icon: 'none' }); },
      fail: function () { wx.showToast({ title: '复制失败，请手动输入', icon: 'none' }); }
    });
  },

  /** 最近课时 → 详情 */
  openSession: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/check/check?id=' + id });
  },

  goRecords: function () {
    wx.switchTab({ url: '/pages/records/records' });
  },

  // ================================================================
  // 教师（扫码确认，不填表、不手写签名）
  // ================================================================
  /** GET /tasks?date=<今天> 今日课表 + GET /sessions?status=wait 待确认课时 */
  loadTeacher: function () {
    var that = this;
    var date = shape.todayFull();
    this.setData({ loading: true, loadError: '', todayText: date });
    return api.getTasks(date).then(function (data) {
      var tasks = shape.taskList(data);
      var done = tasks.filter(function (c) { return c.status === 'done' || c.status === 'makeup'; }).length;
      var wait = tasks.filter(function (c) { return c.status === 'wait'; }).length;
      that.setData({
        loading: false,
        tasks: tasks,
        todayCount: tasks.length,
        doneCount: done,
        waitCount: wait
      });
      return null;
    }).catch(function (err) {
      that.setData({ loading: false, loadError: (err && err.msg) || '课表加载失败' });
      if (api.isUnauthorized(err)) that.handleUnauthorized(err);
      return null;
    }).then(function () {
      return that.loadTeacherSessions();
    });
  },

  /** 教师本人相关的课时会话：GET /sessions（后端只返回本人为实际授课人或本人确认过的） */
  loadTeacherSessions: function () {
    var that = this;
    var w = shape.weekRange();
    this.setData({ weekRangeText: w.text });
    return api.getSessions({ status: 'wait', page: 1, pageSize: 5 }).then(function (data) {
      var page = shape.pageOf(data);
      var totals = shape.statusTotals(page);
      that.setData({ waitSessions: shape.sessionList(page.list), waitCount: Number(totals.wait || 0) });
      return api.getSessions({ page: 1, pageSize: 1, from: w.from, to: w.to });
    }).then(function (data2) {
      var p2 = shape.pageOf(data2);
      that.setData({ weekHours: Number((p2.summary && p2.summary.hours) || 0) });
      return null;
    }).catch(function (err) {
      if (api.isUnauthorized(err)) that.handleUnauthorized(err);
      return null;
    });
  },

  /** A 通道：扫码确认（wx.scanCode） */
  startScan: function () {
    var that = this;
    if (typeof wx.scanCode !== 'function') {
      wx.showToast({ title: '当前环境不支持扫码，请改用「输入口令」', icon: 'none', duration: 2500 });
      return;
    }
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: function (res) {
        that.handleScanResult(res && res.result);
      },
      fail: function (err) {
        var msg = (err && err.errMsg) || '';
        // 用户主动取消不算失败，不打扰
        if (/cancel/i.test(msg)) return;
        wx.showToast({ title: '扫码失败，可改用「输入口令」', icon: 'none', duration: 2500 });
      }
    });
  },

  /**
   * 处理扫码结果：支持 kcsq://code/<codeId>、历史载荷 kcsq://confirm?codeId=..、
   * 带 codeId 参数的链接、裸 codeId、裸 6 位口令；识别不了给友好提示
   */
  handleScanResult: function (text) {
    var parsed = codeParse.parseCodeInput(text);
    if (!parsed) {
      wx.showModal({
        title: '无法识别',
        content: '这不是课时确认的动态码。请让班干部重新出示二维码，或改用「输入口令」手输 6 位数字。',
        showCancel: false,
        confirmText: '知道了'
      });
      return null;
    }
    var url = '/pages/create/create?' + codeParse.toCreateQuery(parsed);
    wx.navigateTo({ url: url });
    return url;
  },

  /** B 通道：手输 6 位数字口令 */
  inputPassCode: function () {
    wx.showModal({
      title: '输入 6 位口令',
      editable: true,
      placeholderText: '请输入班干部屏幕上的 6 位数字',
      confirmText: '确定',
      success: function (res) {
        if (!res.confirm) return;
        var value = String(res.content === undefined || res.content === null ? '' : res.content).trim();
        if (!codeParse.isPassCode(value)) {
          wx.showToast({ title: '请输入 6 位数字口令', icon: 'none' });
          return;
        }
        wx.navigateTo({ url: '/pages/create/create?code=' + value });
      },
      fail: function () {
        wx.showToast({ title: '当前微信版本不支持弹窗输入，请升级后重试', icon: 'none', duration: 2500 });
      }
    });
  },

  /** 今日授课里已有记录的课 → 详情；未发起的课 → 提示让班干部出示二维码（教师不再填表） */
  openRecord: function (e) {
    var ds = e.currentTarget.dataset || {};
    if (ds.recordId) {
      wx.navigateTo({ url: '/pages/check/check?id=' + ds.recordId });
      return;
    }
    var that = this;
    wx.showModal({
      title: '尚未发起确认',
      content: '这节课还没有课时二维码。请班干部在「今日课程」里点「出示二维码」，教师扫一扫或输入 6 位口令即可确认。',
      confirmText: '去扫码确认',
      cancelText: '知道了',
      success: function (res) {
        if (res.confirm) that.startScan();
      }
    });
  },

  // ================================================================
  // 院系管理员 / 教务处（小程序仅只读看板，操作在 Web 后台）
  // ================================================================
  loadAdmin: function () {
    var that = this;
    this.setData({ loading: true, loadError: '' });
    api.getSessions({ page: 1, pageSize: 1 }).then(function (data) {
      var page = shape.pageOf(data);
      var s = page.summary || {};
      // 角标/统计统一走 statusTotals（不受 status= 筛选影响；旧后端自动回退 byStatus）
      var totals = shape.statusTotals(page);
      that.setData({
        loading: false,
        weekTotal: Number(s.hours || 0),
        waitTotal: Number(totals.wait || 0),
        abnormalCount: Number(totals.expired || 0) + Number(totals.rejected || 0) + Number(totals.revoked || 0),
        deptStats: []
      });
      return api.getDeptStats().then(function (st) {
        that.setData({ deptStats: shape.deptStats(st) });
        return null;
      }).catch(function () { return null; });
    }).catch(function (err) {
      that.setData({ loading: false, loadError: (err && err.msg) || '统计加载失败' });
      if (api.isUnauthorized(err)) that.handleUnauthorized(err);
      return null;
    });
  },

  /** 管理端在小程序里没有对应操作，统一引导到 Web 后台 */
  goWebAdmin: function () {
    wx.showModal({
      title: '请使用 Web 后台',
      content: '统计、导入、导出与审核功能在教务处 Web 后台完成，小程序端仅提供教师与班干部功能。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
