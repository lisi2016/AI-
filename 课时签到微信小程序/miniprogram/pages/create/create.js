// 课时确认页（原「发起课时填表页」已按业务流程简化改造）
//
// 任课教师扫码（A）或手输 6 位口令（B）后进入本页：
//   1) POST /code/verify —— 核验动态码
//   2) isSession=true  → 展示本次课时信息（课程名 / 实际授课人 / 班级 / 日期 / 节次 / 地点 / 发起人）
//   3) 点「确认本次课时」→ POST /sessions/{id}/confirm（带 codeId）
//      · 确认人 ≠ 实际授课人（代课）→ 仍算成功，提示「已确认；学时按实际授课人 XXX 计入」
//      · 41001 过期 / 41002 已消费 / 40401 无效 → 明确中文提示并引导班干部刷新
//   4) isSession=false（旧课表码）→ 提示让班干部重新出示课时二维码；**不再有填表/手写签名路径**
//
// 入参（三选一，A+B 双通道）：
//   ?codeId=CD00000001                 按动态码 ID（调试 / 内部跳转）
//   ?code=042317                       按 6 位数字口令（B 通道，教师手输）
//   ?qrContent=kcsq%3A%2F%2Fcode%2F..  按扫码得到的内容（A 通道，兼容历史载荷）
//
// 本页不采集定位。

var app = getApp();
var api = require('../../utils/api.js');
var codeParse = require('../../utils/code-parse.js');
var shape = require('../../utils/shape.js');
var session = require('../../utils/session.js');

// 错误码 → 兜底中文提示（后端返回 msg 时优先用后端原文）
var ERROR_TEXT = {
  40001: '动态码入参有误，请重新扫码或重新输入口令。',
  40101: '登录已失效，请重新绑定工号/学号后再确认。',
  40301: '当前账号无权确认该课时（仅任课教师或管理员可确认）。',
  40401: '动态码不存在或已失效，请让班干部重新出示。',
  41001: '动态码已过期，请让班干部在首页点「刷新二维码」后重新扫码或报出口令。',
  41002: '该动态码已被使用（一次动态码只能确认一次），请让班干部刷新后重新出示。',
  42201: '该课时当前状态不允许确认，可能已被确认过。'
};

var EMPTY_SESSION = {
  sessionId: '', courseName: '', teacherName: '', className: '', teachDate: '', date: '',
  section: '', time: '', place: '', hours: 0, status: '', statusText: '',
  initiatorName: '', initiatorDuty: '', isTempAdjusted: false
};

Page({
  data: {
    codeId: '',
    codeInput: '',
    verifyBy: '',
    verifyState: '',        // '' 未开始 / 'loading' / 'session' / 'legacy' / 'error' / 'done'
    verifyError: '',
    errorAdvice: '',
    session: EMPTY_SESSION,
    canConfirm: false,
    confirming: false,
    confirmResult: null,    // { sessionId, nameMismatch, confirmedName, teacherName, confirmedAt }
    ttlText: 0
  },

  onLoad: function (query) {
    var q = query || {};
    this.__query = q;
    var pending = codeParse.buildVerifyInput(q);
    var queryCodeId = String(q.codeId || '').trim();
    var queryCode = String(q.code || '').trim();

    if (pending.invalid) {
      this.setData({
        verifyState: 'error',
        verifyError: '没有识别到动态码。请返回首页点「扫码确认」扫班干部的二维码，或手输班干部的 6 位数字口令。',
        errorAdvice: ''
      });
      wx.showModal({
        title: '缺少动态码',
        content: '请返回首页点「扫码确认」扫课时二维码，或点「输入 6 位口令」手输数字。',
        showCancel: false,
        confirmText: '返回首页',
        success: function () { wx.navigateBack({ delta: 1 }); }
      });
      return;
    }

    this.setData({
      codeInput: codeParse.isPassCode(queryCode) ? queryCode : '',
      codeId: queryCodeId,
      verifyState: 'loading'
    });
    this.verifyCode(pending);
  },

  /** POST /code/verify（A 扫码 / B 口令 / codeId 三选一） */
  verifyCode: function (input) {
    var that = this;
    this.setData({ verifyState: 'loading', verifyError: '', errorAdvice: '', confirmResult: null });
    api.verifyCode(input).then(function (d) {
      var data = d || {};
      var by = data.verifyBy || (input.code ? 'code' : (input.qrContent ? 'qrContent' : 'codeId'));
      var s = shape.sessionOf(data.session || data.sessionInfo || {});

      if (data.isSession === true) {
        that.setData({
          verifyState: 'session',
          verifyBy: by,
          codeId: data.codeId || that.data.codeId,
          session: s,
          ttlText: Number(data.ttl || 0),
          canConfirm: !!(data.canConfirm !== false && s.status === 'wait')
        });
        wx.setNavigationBarTitle({ title: '确认本次课时' });
        return;
      }

      // 旧课表码：新流程不再填表 / 不再手写签名，引导班干部重新出示课时二维码
      that.setData({
        verifyState: 'legacy',
        verifyBy: by,
        codeId: data.codeId || that.data.codeId,
        canConfirm: false
      });
      wx.setNavigationBarTitle({ title: '课时确认' });
    }).catch(function (err) {
      var code = err && err.code;
      var text = (err && err.msg) || ERROR_TEXT[code] || '动态码核验失败，请重试。';
      if (api.isUnauthorized(err)) {
        session.guideToBind((err && err.msg) || '');
        that.setData({ verifyState: 'error', verifyError: text, errorAdvice: '' });
        return;
      }
      that.setData({
        verifyState: 'error',
        verifyError: text,
        errorAdvice: adviceOf(code)
      });
      wx.showModal({
        title: '动态码不可用',
        content: text,
        showCancel: false,
        confirmText: '知道了'
      });
    });
  },

  /** 重新核验（网络抖动 / 班干部刚刷新后原地重试） */
  retryVerify: function () {
    if (this.data.confirming) return;
    this.verifyCode(codeParse.buildVerifyInput(this.__query || {}));
  },

  /** 重新扫码：回首页走「扫码确认 / 输入 6 位口令」 */
  rescan: function () {
    wx.navigateBack({
      delta: 1,
      fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
    });
  },

  /** 「确认本次课时」→ POST /sessions/{id}/confirm（带 codeId 消费动态码） */
  confirm: function () {
    var that = this;
    if (this.data.confirming) return;
    var s = this.data.session || {};
    if (!s.sessionId) {
      wx.showToast({ title: '没有可确认的课时', icon: 'none' });
      return;
    }
    if (!this.data.canConfirm) {
      wx.showToast({ title: '该课时已确认或状态不允许确认', icon: 'none' });
      return;
    }
    var payload = {};
    if (this.data.codeId) payload.codeId = this.data.codeId;
    else if (this.data.codeInput) payload.code = this.data.codeInput;

    this.setData({ confirming: true });
    api.confirmSession(s.sessionId, payload).then(function (res) {
      var r = res || {};
      var nameMismatch = !!r.nameMismatch;
      var teacherName = r.teacherName || s.teacherName || '';
      that.setData({
        confirming: false,
        verifyState: 'done',
        canConfirm: false,
        confirmResult: {
          sessionId: r.sessionId || s.sessionId,
          status: r.status || 'done',
          counted: r.counted !== false,
          nameMismatch: nameMismatch,
          confirmedName: r.confirmedName || '',
          confirmedAt: r.confirmedAt || '',
          teacherName: teacherName,
          msg: r.msg || ''
        }
      });
      wx.showModal({
        title: nameMismatch ? '已确认（代课）' : '已确认本次课时',
        content: nameMismatch
          ? ('已确认；学时按实际授课人 ' + teacherName + ' 计入。')
          : ('学时计入实际授课人：' + teacherName + '。'),
        confirmText: '查看课时详情',
        cancelText: '返回首页',
        success: function (m) {
          if (m.confirm) {
            wx.redirectTo({ url: '/pages/check/check?id=' + (r.sessionId || s.sessionId) });
          } else {
            wx.navigateBack({ delta: 1 });
          }
        }
      });
    }).catch(function (err) {
      var code = err && err.code;
      var text = (err && err.msg) || ERROR_TEXT[code] || '确认失败，请重试。';
      that.setData({ confirming: false });
      if (api.isUnauthorized(err)) {
        session.guideToBind((err && err.msg) || '');
        return;
      }
      if (code === 41001 || code === 41002) {
        // 动态码失效：回到错误态，明确引导班干部刷新后重新出示
        that.setData({ verifyState: 'error', verifyError: text, errorAdvice: adviceOf(code), canConfirm: false });
      }
      wx.showModal({
        title: '确认未成功',
        content: text,
        showCancel: false,
        confirmText: '知道了'
      });
    });
  }
});

/** 按错误码给出「下一步怎么做」的可操作建议 */
function adviceOf(code) {
  if (code === 41001) return '请让班干部在首页点「刷新二维码」（或重新出示），老师再扫一次或输入新的 6 位口令。';
  if (code === 41002) return '该动态码已被使用过：请让班干部刷新二维码后重新出示，一次动态码只能确认一次。';
  if (code === 40401) return '请确认扫的是本次课时的二维码；也可以让班干部报出屏幕上新的 6 位数字口令。';
  if (code === 42201) return '该课时可能已被确认，可在「记录」里查看状态。';
  return '可点「重新核验」重试；仍失败请让班干部重新出示二维码。';
}
