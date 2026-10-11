// 绑定页：微信登录 → 未绑定则用工号/学号绑定（后端白名单校验）
//
// 链路（契约 1.3 / 三.A）：
//   wx.login() → code
//   POST /api/v1/auth/login {code}
//     ├─ 已绑定 → { token, user, role }         → 落盘 → 回首页
//     └─ 未绑定 → { openid, bindTicket, needBind:true }
//                 POST /api/v1/auth/bind { openid, bindTicket, role, no, realName }
//                 → { token, user, role }        → 落盘 → 回首页
//
// 失败时**必须把后端返回的 msg 原样展示**（如「该工号/学号不在白名单内，无法绑定」
// 「该工号/学号已被其他微信绑定，请联系教务处」），并附上可操作建议。
// 本页不采集定位，不调用任何位置类接口。
//
// 本次新增：**自助解绑并重新绑定**（换微信的兜底路径）
//   绑定失败且后端 msg 命中「已被其他微信绑定」时，错误区额外显示该按钮：
//   二次确认（显示将解绑的工号 + 姓名，需用户确认姓名输入无误）
//     → POST /auth/unbind-self {no, realName}（弱凭证 + 服务端频率限制）
//     → 成功后**自动重试一次绑定**（复用本页既有逻辑：wx.login → /auth/login → /auth/bind）
//     → 成功即回首页。解绑只解除微信绑定，历史课时数据不受影响。

var app = getApp();
var api = require('../../utils/api.js');
var session = require('../../utils/session.js');

// 可选身份：与后端白名单 role 取值一致（教师 teacher / 班干部 cadre）
// 说明：院系管理员（dept_admin）与教务处（admin）走 Web 后台账号密码登录，
//      不在小程序绑定范围内，后端 /auth/bind 也接受其 role，但小程序不提供入口。
var ROLES = ['teacher', 'cadre'];
var ROLE_TEXT = ['任课教师', '班干部（学委 / 班长）'];

/** 把 code 换成 Promise，兼容只支持回调的旧基础库 */
function wxLogin() {
  return new Promise(function (resolve, reject) {
    if (typeof wx.login !== 'function') {
      reject({ code: 50001, msg: '当前环境不支持微信登录，请升级微信后重试' });
      return;
    }
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code);
        else reject({ code: 50001, msg: 'wx.login 未返回 code，请重试' });
      },
      fail: function (err) {
        reject({ code: 50001, msg: '微信登录失败，请重试', raw: err });
      }
    });
  });
}

/**
 * 按后端错误码/文案给出可操作提示（展示仍以后端 msg 原文为主）
 * @returns {string} 建议文案，无建议时返回空串
 */
function adviceOf(err) {
  var msg = String((err && err.msg) || '');
  var code = err && err.code;
  if (code === 40101 || (err && err.unauthorized)) {
    return '绑定票据已失效，请重新点「绑定」再试一次。';
  }
  if (code === 50002 || /code2Session|AppSecret|WX_APPID/i.test(msg)) {
    return '服务端未正确配置微信 AppID / AppSecret，请联系系统管理员。';
  }
  if (/不在白名单/.test(msg)) {
    return '请联系教务处：把你的工号/学号加入白名单（白名单中的姓名必须与本页填写的一致）。';
  }
  if (/已被其他微信绑定/.test(msg)) {
    return '一个工号/学号只能绑定一个微信。若这是你自己的工号/学号、且姓名填写无误，' +
      '可点下方「自助解绑并重新绑定」解除原微信的绑定后自动重绑；若仍失败请联系教务处。';
  }
  if (/当前微信已绑定账号/.test(msg)) {
    return '当前微信已经绑定过其他账号。请到「我的」页点「解绑当前微信」，或用原账号继续；如需换绑请联系教务处。';
  }
  if (/对应姓名为|不匹配/.test(msg)) {
    return '请按教务处的登记信息填写真实姓名（常见问题：同音字、多空格、写了昵称）。';
  }
  if (/的角色为/.test(msg)) {
    return '身份选择与白名单不一致，请改选正确的身份（教师 / 班干部）后重试。';
  }
  if (/账号已被停用/.test(msg)) {
    return '账号已被停用，请联系教务处处理。';
  }
  if (/缺少教学班/.test(msg)) {
    return '班干部白名单缺少教学班信息，请联系教务处补全后再绑定。';
  }
  if (code === 40001) {
    return '请检查姓名、工号/学号是否填写完整且无多余空格。';
  }
  if (code === 50001) {
    return '请确认网络可用，以及 apiBase 是否指向已部署的后端。';
  }
  return '';
}

/**
 * 自助解绑（POST /auth/unbind-self）失败时的可操作建议
 * 展示仍以**后端 msg 原文**为主，这里只补充"下一步怎么办"
 */
function selfUnbindAdvice(err) {
  var e = err || {};
  var msg = String(e.msg || '');
  var code = e.code;
  if (code === 40001 || /已达上限/.test(msg)) {
    return '频率限制：同一工号 24 小时内最多 2 次、同一网络 1 小时内最多 5 次。请稍后再试；' +
      '急需换绑可直接联系教务处人工解绑。';
  }
  if (code === 40301 || /不匹配/.test(msg)) {
    return '请核对姓名是否与教务处登记完全一致（注意同音字、多余空格）；' +
      '每 24 小时只有 2 次机会，确认无误后再提交，或联系教务处。';
  }
  if (api.isUnauthorized(e)) {
    return '登录已失效，请退出后重新进入小程序再试一次。';
  }
  if (/超时/.test(msg) || e.domainBlocked) {
    return '请检查手机网络，以及本页顶部的服务器连通性提示后重试。';
  }
  return '若多次失败，请联系教务处人工解绑。';
}

Page({
  data: {
    roleRange: ROLE_TEXT,
    roleIndex: 0,
    realName: '',
    no: '',
    // 状态
    submitting: false,
    errorMsg: '',      // 后端 msg 原文
    advice: '',        // 可操作建议
    // 自助解绑（仅当后端提示「已被其他微信绑定」时出现）
    canSelfUnbind: false,
    selfUnbindBusy: false,
    mode: 'bind',      // bind=首次绑定 / rebind=重新绑定
    currentText: '',   // 已登录时的当前身份，便于提示
    apiBase: '',
    // 连通性预检（真机最常见的问题是请求域名未配置，提前暴露而不是一直转圈）
    conn: 'checking',  // checking | ok | fail
    connMsg: ''
  },

  onLoad: function (query) {
    var q = query || {};
    var mode = String(q.mode || 'bind');
    var user = app.globalData.user || session.getUser();
    var patch = {
      mode: mode,
      apiBase: (app.globalData && app.globalData.apiBase) || '',
      currentText: user ? ((user.name || '') + '（' + (user.no || user.staffId || user.studentId || '') + '）') : ''
    };
    // 重新绑定：用当前身份预填，减少重复输入
    if (mode === 'rebind' && user) {
      patch.realName = user.name || user.realName || '';
      patch.no = user.no || user.staffId || user.studentId || '';
      var idx = ROLES.indexOf(user.role);
      patch.roleIndex = idx >= 0 ? idx : 0;
    }
    this.setData(patch);
    wx.setNavigationBarTitle({ title: mode === 'rebind' ? '重新绑定身份' : '绑定工号/学号' });
    this.checkConn();
  },

  /** 页面重新显示时清掉可能残留的提交中状态，避免按钮点不动 */
  onShow: function () {
    if (this.data.submitting) this.setData({ submitting: false });
  },

  /**
   * 连通性预检：GET /api/v1/health
   * 目的是把「手机连不上后端」这个最常见问题在提交前就暴露出来（否则会一直停在"绑定中"）
   */
  checkConn: function () {
    var that = this;
    var settled = false;
    this.setData({ conn: 'checking', connMsg: '' });
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      that.setData({
        conn: 'fail',
        connMsg: '连接服务器超时（12 秒无响应）。请确认手机网络可用，且服务器 ' + (that.data.apiBase || '') + ' 能访问。'
      });
    }, 12000);
    api.ping().then(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      that.setData({ conn: 'ok', connMsg: '' });
    }).catch(function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      that.setData({ conn: 'fail', connMsg: (err && err.msg) || '无法连接服务器' });
    });
  },

  onName: function (e) { this.setData({ realName: e.detail.value }); },
  onNo: function (e) { this.setData({ no: e.detail.value }); },

  pickRole: function (e) {
    this.setData({ roleIndex: Number(e.detail.value) });
  },

  /** 提交绑定：见文件头链路说明 */
  submit: function () {
    var that = this;
    if (this.data.submitting) return;

    var realName = String(this.data.realName || '').trim();
    var no = String(this.data.no || '').trim();
    var role = ROLES[this.data.roleIndex] || 'teacher';

    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    if (!no) {
      wx.showToast({ title: '请填写工号 / 学号', icon: 'none' });
      return;
    }

    this.setData({ submitting: true, errorMsg: '', advice: '', canSelfUnbind: false });

    // 兜底：30 秒内没有任何结果就解除"绑定中"并给出可操作提示。
    // 真机上最常见的原因是「请求域名未在微信公众平台配置」，wx.request 会失败或长时间无响应。
    var settled = false;
    var guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      that.setData({
        submitting: false,
        errorMsg: '绑定请求超时（30 秒无响应）',
        advice: '请检查手机网络；若页面顶部提示「请求域名未在微信公众平台配置」，' +
          '请在手机预览时从右上角「…」菜单开启「开发调试」，然后重新进入小程序再绑定；' +
          '正式使用需改用已备案的 HTTPS 域名并在公众平台配置服务器域名。'
      });
      wx.showToast({ title: '绑定超时，请重试', icon: 'none', duration: 3000 });
    }, 30000);
    var finish = function () {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
    };

    wxLogin().then(function (code) {
      return api.login(code);
    }).then(function (login) {
      var d = login || {};
      // 情况一：该微信已绑定 → 直接拿 token
      if (!d.needBind && d.token) {
        return { session: d, bound: true };
      }
      // 情况二：未绑定 → 用工号/学号绑定
      if (d.needBind) {
        if (!d.openid && !d.bindTicket) {
          return Promise.reject({ code: 40001, msg: '后端未返回 openid / bindTicket，无法绑定，请联系管理员' });
        }
        return api.bind({
          openid: d.openid || '',
          bindTicket: d.bindTicket || '',
          role: role,
          no: no,
          realName: realName
        }).then(function (bound) {
          return { session: bound, bound: true };
        });
      }
      return Promise.reject({ code: 50001, msg: '后端登录返回结构异常（缺少 token 与 needBind），请联系管理员' });
    }).then(function (out) {
      var s = out.session || {};
      finish();
      // 落盘：token + user + role（api.js 后续请求据此带 Authorization）
      session.saveSession(s);
      if (app.globalData) {
        app.globalData.needBind = false;
        app.globalData.bindHint = '';
      }
      that.setData({ submitting: false });
      wx.showToast({ title: '绑定成功', icon: 'success', duration: 800 });
      // 回首页：首页会按 role 渲染（班干部=出示动态码，教师=工作台）
      setTimeout(function () {
        wx.switchTab({
          url: '/pages/index/index',
          fail: function () { wx.reLaunch({ url: '/pages/index/index' }); }
        });
      }, 800);
    }).catch(function (err) {
      finish();
      var e = err || {};
      var msg = e.msg || '绑定失败，请重试';
      that.setData({
        submitting: false,
        errorMsg: msg,                       // 原样展示后端 msg
        advice: adviceOf(e),
        // 「该工号/学号已被其他微信绑定」→ 给出自助解绑入口（免去找教务处）
        canSelfUnbind: /已被其他微信绑定/.test(msg)
      });
      // 域名未配置（真机常见）→ 顺带刷新顶部连通性提示
      if (e && e.domainBlocked) {
        that.setData({ conn: 'fail', connMsg: msg });
      }
      // 40101：登录票据失效，本地会话已被 api 层清掉
      if (api.isUnauthorized(e)) {
        that.setData({ advice: adviceOf(e) });
      }
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    });
  },

  /**
   * 自助解绑并重新绑定（换微信的兜底路径，免去找教务处）
   * ① 弹窗二次确认（显示将解绑的工号 + 姓名，需用户确认姓名输入无误）
   * ② POST /auth/unbind-self { no, realName }（弱凭证 + 服务端频率限制）
   * ③ 成功后自动重试一次绑定（复用 submit()：wx.login → /auth/login → /auth/bind）
   */
  selfUnbind: function () {
    var that = this;
    if (this.data.selfUnbindBusy || this.data.submitting) return;
    var no = String(this.data.no || '').trim();
    var realName = String(this.data.realName || '').trim();
    if (!no || !realName) {
      wx.showToast({ title: '请先填写姓名与工号/学号', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '自助解绑并重新绑定',
      content: '将解绑工号/学号「' + no + '」当前绑定的微信（姓名：' + realName + '），并用当前微信重新绑定。\n' +
        '请确认姓名与工号/学号填写无误（必须与教务处登记完全一致）。\n' +
        '解绑只解除微信绑定，历史课时与统计数据不受影响。\n' +
        '注意：同一工号 24 小时内最多自助解绑 2 次。',
      confirmText: '确认解绑',
      confirmColor: '#C0392B',
      success: function (res) {
        if (!res.confirm) return;
        that.doUnbindSelf(no, realName);
      }
    });
  },

  /** 调 POST /auth/unbind-self → 成功后自动重试一次绑定 */
  doUnbindSelf: function (no, realName) {
    var that = this;
    this.setData({ selfUnbindBusy: true, errorMsg: '', advice: '' });
    api.unbindSelf({ no: no, realName: realName }).then(function (out) {
      var d = out || {};
      that.setData({ selfUnbindBusy: false });
      wx.showToast({
        title: d.hadBinding === false ? '该工号未绑定微信，直接重新绑定' : '已解绑，正在重新绑定',
        icon: 'none',
        duration: 1500
      });
      // 解绑成功后自动重试一次绑定（复用现有绑定逻辑：wx.login → /auth/login → /auth/bind）
      that.submit();
    }, function (err) {
      var e = err || {};
      var msg = e.msg || '自助解绑失败，请重试';
      that.setData({
        selfUnbindBusy: false,
        errorMsg: msg,            // 原样展示后端 msg（频率限制 / 姓名不匹配 / 网络错误）
        advice: selfUnbindAdvice(e),
        // 保留入口：用户改对姓名、或过了限流窗口后可以再点一次
        canSelfUnbind: true
      });
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    });
  },

  /** 重新走一遍微信登录（换 openid 后重试，用于「票据过期 / 需要换微信」场景） */
  retryLogin: function () {
    this.setData({ errorMsg: '', advice: '', canSelfUnbind: false });
    this.submit();
  },

  /** 已登录用户直接回首页，不重复绑定 */
  goHome: function () {
    wx.switchTab({
      url: '/pages/index/index',
      fail: function () { wx.reLaunch({ url: '/pages/index/index' }); }
    });
  }
});
