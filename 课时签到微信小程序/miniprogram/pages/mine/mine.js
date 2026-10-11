// 我的：展示真实已绑定身份，提供「重新绑定」「解绑当前微信（自助换绑）」与「退出登录」
//
// 变更说明（本次修复）：此前本页用 mock.teacher / mock.cadre / mock.admin 做身份切换，
// 只写本地 storage、不产生 token，导致后续所有真实请求 40101。
// 现在身份只来自后端绑定结果（app.globalData.user / utils/session.js），并删除了 mock 身份切换。
//
// 本次新增：自助解绑（换绑）入口 —— 只解除「微信 ↔ 工号/学号」的登录绑定，
// 不删除用户档案、不影响历史课时与统计数据；解绑后服务端会立即吊销 token，
// 因此成功后必须 session.clearSession() 并回到首页的绑定引导。

var app = getApp();
var api = require('../../utils/api.js');
var session = require('../../utils/session.js');

var ROLE_TEXT = {
  teacher: '任课教师',
  cadre: '班干部（学委 / 班长）',
  dept_admin: '院系管理员',
  admin: '教务处管理员'
};

Page({
  data: {
    role: '',
    roleText: '',
    user: null,
    items: [],
    needBind: false,
    apiBase: '',
    dataSource: '',
    // 班干部/管理员可维护课程清单；教师为只读
    canManageCourses: false,
    // 自助解绑进行中（防连点）
    unbinding: false
  },

  onShow: function () {
    this.render();
  },

  render: function () {
    var role = (app.globalData && app.globalData.role) || session.getRole() || '';
    var user = (app.globalData && app.globalData.user) || session.getUser() || null;
    var base = (app.globalData && app.globalData.apiBase) || '';
    var mockOn = !!(app.globalData && app.globalData.useMock);
    this.setData({
      role: role,
      roleText: ROLE_TEXT[role] || '未绑定',
      user: user,
      needBind: !role || !user,
      apiBase: base,
      dataSource: mockOn ? '本地演示数据（useMock=true）' : ('已部署后端 ' + (base || '（未配置）')),
      canManageCourses: role === 'cadre' || role === 'admin' || role === 'dept_admin'
    });
    this.buildItems(user, role);
  },

  buildItems: function (user, role) {
    var items = [];
    if (user) {
      var idLabel = role === 'teacher' || role === 'dept_admin' || role === 'admin' ? '工号' : '学号';
      var idValue = user.no || user.staffId || user.studentId || '';
      items.push({ k: '姓名', v: user.name || user.realName || '' });
      items.push({ k: idLabel, v: idValue });
      if (user.dept) items.push({ k: '院系', v: user.dept });
      if (user.className) items.push({ k: '班级', v: user.className });
      if (user.duty) items.push({ k: '职务', v: user.duty });
      if (user.authorizedClasses && user.authorizedClasses.length) {
        items.push({
          k: '授权教学班',
          v: user.authorizedClasses.map(function (c) { return c.name; }).join('、')
        });
      }
    }
    this.setData({ items: items });
  },

  /** 重新绑定（切号）：走绑定页；唯一能改变身份的入口 */
  rebind: function () {
    var that = this;
    wx.showModal({
      title: '重新绑定',
      content: '将重新发起微信登录并绑定工号/学号。同一工号/学号在服务端只能绑定一个微信；' +
        '若该工号已被别的微信占用，可在绑定页用「自助解绑并重新绑定」自助换绑（无需找教务处）。',
      confirmText: '继续',
      success: function (res) {
        if (!res.confirm) return;
        wx.navigateTo({
          url: '/pages/bind/bind?mode=rebind',
          fail: function () {
            that.goBind();
          }
        });
      }
    });
  },

  goBind: function () {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  /**
   * 自助解绑当前微信（换绑：换手机/换微信时用）
   * 只解除「微信 ↔ 工号/学号」的登录绑定：不删除用户档案，历史课时与统计数据不受影响。
   */
  unbindTap: function () {
    var that = this;
    if (this.data.unbinding) return;
    var user = this.data.user || {};
    var no = user.no || user.staffId || user.studentId || '';
    var name = user.name || user.realName || '';
    wx.showModal({
      title: '解绑当前微信',
      content: '将解除本微信与「' + name + (no ? '（' + no + '）」' : '」') + '的绑定。\n' +
        '仅解除微信登录绑定：用户档案与历史课时/统计数据都不受影响；' +
        '解绑后本机需重新绑定才能继续使用，该工号/学号可被新的微信重新绑定。',
      confirmText: '确认解绑',
      confirmColor: '#C0392B',
      success: function (res) {
        if (!res.confirm) return;
        that.doUnbind();
      }
    });
  },

  /** 调 POST /auth/unbind → 成功后清本地会话 → 回首页绑定引导 */
  doUnbind: function () {
    var that = this;
    this.setData({ unbinding: true });
    api.unbind().then(function (out) {
      that.afterUnbound((out && out.realName) || '', '已解绑当前微信');
    }, function (err) {
      that.setData({ unbinding: false });
      // 40101：token 已失效（服务端已解绑 / 会话过期）→ 本地同样按「已解绑」收尾，回绑定引导
      if (api.isUnauthorized(err)) {
        that.afterUnbound('', '登录已失效，请重新绑定');
        return;
      }
      wx.showToast({
        title: (err && err.msg) || '解绑失败，请重试',
        icon: 'none',
        duration: 3000
      });
    });
  },

  /** 解绑成功后的统一收尾：清 token/user/role → 提示 → 回首页绑定引导 */
  afterUnbound: function (name, toastTitle) {
    session.clearSession();
    if (app.globalData) {
      app.globalData.needBind = true;
      app.globalData.bindHint = name
        ? (name + ' 已解绑当前微信，请重新绑定工号/学号')
        : '微信已解绑，请重新绑定工号/学号';
    }
    this.setData({ unbinding: false });
    this.render();
    wx.showToast({ title: toastTitle || '已解绑', icon: 'none', duration: 1800 });
    setTimeout(function () {
      wx.switchTab({
        url: '/pages/index/index',
        fail: function () { wx.reLaunch({ url: '/pages/index/index' }); }
      });
    }, 900);
  },

  /** 我的课程（班干部维护本班课程清单；教师只读） */
  goCourses: function () {
    wx.navigateTo({
      url: '/pages/courses/courses',
      fail: function () { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); }
    });
  },

  /** 退出登录：清 token + user（必须清 token，否则下次启动又会用坏 token 请求） */
  logout: function () {
    var that = this;
    wx.showModal({
      title: '退出登录',
      content: '将清除本机登录状态（token 与身份）。下次使用需重新绑定/登录。',
      confirmText: '退出',
      success: function (res) {
        if (!res.confirm) return;
        // 先通知服务端吊销 token（失败不影响本地清理）
        var done = function () {
          session.clearSession();
          if (app.globalData) {
            app.globalData.needBind = true;
            app.globalData.bindHint = '';
          }
          that.render();
          wx.showToast({ title: '已退出登录', icon: 'none' });
          setTimeout(function () {
            wx.switchTab({
              url: '/pages/index/index',
              fail: function () { wx.reLaunch({ url: '/pages/index/index' }); }
            });
          }, 600);
        };
        api.logout().then(done, done);
      }
    });
  },

  /** 清除本地演示数据（仅影响 mock 兜底缓存，不动后端数据） */
  clearData: function () {
    var that = this;
    wx.showModal({
      title: '清除本地演示数据',
      content: '将清空本机缓存的课时记录、课程清单、课时会话与自助解绑状态（仅 mock 演示数据），不影响后端数据。',
      success: function (res) {
        if (res.confirm) {
          ['ch_records_v1', 'ch_class_courses_v1', 'ch_class_courses_v1_meta', 'ch_sessions_v1',
            'ch_bindings_v1', 'ch_unbind_requests_v1'].forEach(function (k) {
            try { wx.removeStorageSync(k); } catch (e) { /* ignore */ }
          });
          if (api.__mock && api.__mock.reset) api.__mock.reset();
          that.render();
          wx.showToast({ title: '已清除' });
        }
      }
    });
  }
});
