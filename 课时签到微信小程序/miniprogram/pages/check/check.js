// 课时详情（新流程：班干部发起 + 教师扫码确认）
//
// 数据来源：
//   · GET /api/v1/sessions/{id}  → { session, course, teacher, initiator, confirmer, code, auditTail }
//   · 旧流程记录（教师发起 + 班干部签名，不是课时会话）自动回退 GET /api/v1/records/{id}，
//     只读展示，且**不再渲染手写签名图**（新流程已取消手写签名）
//
// 展示内容（本次改造重点）：
//   · 本次课时信息：课程 / 实际授课人 / 班级 / 日期 / 节次 / 地点 / 学时 / 发起人
//   · 课程清单快照（本次课时来自哪条课程清单）
//   · 确认信息：确认人 / 确认时间 / 设备 / 是否「确认人≠实际授课人」
//   · 证据四项：动态码 / 确认人 / 确认时间 / 设备（无手写签名图、无任何定位信息）
//   · 审计尾部：最近 10 条操作留痕
//
// 本页不采集定位，也不提供教师填表 / 手写签名入口（确认动作在教师扫码后的课时确认页完成）。

var app = getApp();
var api = require('../../utils/api.js');
var shape = require('../../utils/shape.js');
var session = require('../../utils/session.js');

function emptySession() {
  return {
    id: '', sessionId: '', courseName: '', teacherName: '', className: '', teachDate: '', date: '',
    section: '', time: '', place: '', hours: 0, status: '', statusText: '', isTempAdjusted: false,
    initiatorName: '', initiatorDuty: '', confirmedName: '', confirmedAt: '', confirmDevice: '',
    confirmNameMismatch: false, absentCount: 0, absentNames: '', disciplineText: '', summary: '',
    deadline: ''
  };
}

Page({
  data: {
    id: '',
    role: '',
    ready: false,
    needBind: false,
    loading: false,
    loadError: '',
    isLegacy: false,
    session: emptySession(),
    course: null,
    code: null,
    auditTail: [],
    evidence: []
  },

  onLoad: function (query) {
    this.setData({ id: String((query && query.id) || '') });
  },

  onShow: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () {
      var role = (app.globalData && app.globalData.role) || session.getRole() || '';
      var user = (app.globalData && app.globalData.user) || session.getUser() || null;
      that.setData({ role: role, ready: true, needBind: !role || !user });
      that.reload();
    });
  },

  onPullDownRefresh: function () {
    var that = this;
    this.reload().then(function () { wx.stopPullDownRefresh(); });
    setTimeout(function () { wx.stopPullDownRefresh(); }, 800);
  },

  reload: function () {
    var that = this;
    if (!this.data.id) {
      this.setData({ loadError: '缺少课时 ID，无法加载详情' });
      return Promise.resolve(null);
    }
    this.setData({ loading: true, loadError: '' });

    return api.getSession(this.data.id).then(function (data) {
      var d = data || {};
      var s = shape.sessionOf(d.session || d);
      that.renderSession(s, d);
      return null;
    }).catch(function (err) {
      if (api.isUnauthorized(err)) {
        that.setData({ loading: false, needBind: true });
        session.guideToBind((err && err.msg) || '');
        return null;
      }
      // 旧流程记录（非课时会话）→ 回退只读查看，保留历史数据可见性
      if (err && err.code === 40401) return that.loadLegacy();
      that.setData({
        loading: false,
        loadError: (err && err.msg) || '课时详情加载失败'
      });
      return null;
    });
  },

  /** 旧流程记录：GET /records/{id} 只读展示（不渲染手写签名图） */
  loadLegacy: function () {
    var that = this;
    return api.getRecord(this.data.id).then(function (rec) {
      var r = rec || {};
      var s = shape.sessionOf({
        sessionId: r.id,
        id: r.id,
        courseName: r.courseName,
        className: r.className,
        teacherName: r.teacherName,
        teachDate: r.fullDate || r.teachDate,
        date: r.date,
        section: r.section,
        time: r.time,
        place: r.place,
        hours: r.hours,
        status: r.status,
        statusText: r.statusText,
        initiatorName: r.signerName,
        initiatorDuty: r.signerDuty,
        confirmedName: r.confirmer || r.signerName,
        confirmedAt: r.signedAt || r.confirmedAt,
        confirmDevice: r.device,
        summary: r.summary,
        note: r.note
      });
      that.setData({ loading: false, isLegacy: true, loadError: '', code: null, auditTail: [] });
      that.renderSession(s, { session: s, course: null, code: null, auditTail: [] });
      wx.setNavigationBarTitle({ title: (s.courseName || '课时') + ' · 旧流程记录' });
      return null;
    }).catch(function (err) {
      var msg = (err && err.msg) || '课时详情加载失败';
      that.setData({ loading: false, loadError: msg });
      if (api.isUnauthorized(err)) {
        that.setData({ needBind: true });
        session.guideToBind(msg);
      }
      return null;
    });
  },

  renderSession: function (s, data) {
    var d = data || {};
    var course = d.course ? shape.courseList([d.course])[0] : null;
    var code = d.code || null;
    this.setData({
      loading: false,
      loadError: '',
      session: s,
      course: course,
      code: code,
      auditTail: (d.auditTail || []).map(function (l) {
        return {
          action: l.action || '',
          actor: l.actor || '',
          at: shape.dateTimeText(l.at),
          detail: l.detail || ''
        };
      }),
      evidence: shape.sessionEvidence(s, code)
    });
    if (s.courseName) {
      wx.setNavigationBarTitle({ title: s.courseName + ' · 课时详情' });
    }
  },

  goRecords: function () {
    wx.switchTab({ url: '/pages/records/records' });
  },

  goBind: function () {
    wx.navigateTo({ url: '/pages/bind/bind' });
  }
});
