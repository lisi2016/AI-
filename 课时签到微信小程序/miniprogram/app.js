// 全局应用逻辑
// 身份（teacher / cadre / dept_admin / admin）来自后端 /auth/bind（白名单校验），
// 由 utils/session.js 落盘到本地 storage；不再有任何 mock 身份切换。
//
// 启动流程（修复「未登录仍走真实接口 → 40101」的根因）：
//   1) 先用本地 storage 恢复 role/user（离线也能立即渲染）
//   2) 有 token 就调 GET /auth/me 校验并刷新 user/role（token 过期会被清掉）
//   3) 无 token 或校验失败 → globalData.needBind = true，首页显示「去绑定」引导
//   页面可 await app.ready() 再发起业务请求，避免与启动校验竞争。

var api = require('./utils/api.js');
var session = require('./utils/session.js');

App({
  globalData: {
    role: '',
    user: null,
    token: '',
    // 未登录/未绑定标记：首页据此显示「去绑定」引导，不要静默失败
    needBind: false,
    // 绑定/校验失败原因（后端 msg 原文），供首页展示
    bindHint: '',
    // 后端开关：true=走本地 mock；false=连真实后端
    // 联调阶段：已在微信开发者工具勾选"不校验合法域名"，指向已部署后端
    // 正式上线：把 apiBase 换成学校已备案的 HTTPS 域名（如 https://kcsq.xxx.edu.cn）
    useMock: false,
    apiBase: 'http://8.138.41.74',
    // 后端下发的规则（/auth/me 返回 config）：动态码有效期等
    config: null
  },

  onLaunch: function () {
    var that = this;
    // ① 先用本地缓存渲染，避免白屏
    this.globalData.token = session.getToken();
    this.globalData.role = session.getRole();
    this.globalData.user = session.getUser();
    this.globalData.needBind = !this.globalData.token;

    // ready() 必须同步可用，所以先建好 deferred，再在下一个 tick 发起网络请求：
    // 微信在 onLaunch 执行期间 getApp() 可能还取不到 App 实例，而 api.js 依赖 getApp() 判断
    // 是否走 mock，因此把 /auth/me 放到 onLaunch 之后再发。
    this._readyResolve = null;
    this._readyPromise = new Promise(function (resolve) { that._readyResolve = resolve; });
    this._readyPromise.then(function () { that._readyResolve = null; });
    setTimeout(function () {
      that.bootstrap().then(function (r) {
        if (that._readyResolve) that._readyResolve(r);
      });
    }, 0);
  },

  /**
   * 启动校验：有 token 就调 /auth/me 刷新身份；失败（含 40101）改为引导绑定
   * @returns Promise<{role, user}> 永不 reject，保证 await 它的页面不会被异常中断
   */
  bootstrap: function () {
    var that = this;
    if (this.globalData.useMock) {
      this.globalData.needBind = !this.globalData.token;
      return Promise.resolve({ role: this.globalData.role, user: this.globalData.user });
    }
    if (!this.globalData.token) {
      this.globalData.needBind = true;
      this.globalData.bindHint = '';
      return Promise.resolve({ role: '', user: null });
    }
    return api.me().then(function (data) {
      var d = data || {};
      var user = d.user || null;
      var role = d.role || (user && user.role) || '';
      session.saveSession({ token: session.getToken(), user: user, role: role });
      that.globalData.config = d.config || null;
      that.globalData.needBind = false;
      that.globalData.bindHint = '';
      return { role: role, user: user };
    }).catch(function (err) {
      // 40101（token 失效）或网络异常：本地 token 已由 api 层清掉
      that.globalData.needBind = true;
      that.globalData.bindHint = (err && err.msg) || '';
      if (!api.isUnauthorized(err)) {
        // 网络异常不删 token，仅提示；下次进入会再校验
        that.globalData.bindHint = '';
      }
      return { role: '', user: null, error: err };
    });
  },

  /** 页面等待启动校验完成：await app.ready() */
  ready: function () {
    return this._readyPromise || Promise.resolve({ role: this.globalData.role, user: this.globalData.user });
  },

  /** 登录/绑定成功后统一写入（token 必须落盘，见 utils/session.js） */
  setSession: function (data) {
    var s = session.saveSession(data);
    this.globalData.config = this.globalData.config || null;
    return s;
  },

  setRole: function (role) {
    this.globalData.role = role;
    wx.setStorageSync('role', role);
  },

  /** 退出登录 / 清理身份：连同 token 一起清（否则下次启动又会用坏 token 请求） */
  clearRole: function () {
    session.clearSession();
    this.globalData.needBind = true;
  }
});
