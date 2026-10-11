// 课时记录列表：GET /sessions（分页）+ 点击进详情 GET /sessions/{id}
//
// 角色差异由后端决定（班干部=本班；教师=本人为实际授课人或本人确认过；管理员=本院系/全校），
// 前端只负责按状态筛选与分页加载。
// 角标口径：summary.statusTotals（不受 status= 筛选影响）。

var app = getApp();
var api = require('../../utils/api.js');
var shape = require('../../utils/shape.js');

var PAGE_SIZE = 20;
// 标签 → 后端 status 过滤值（空串=全部）
var STATUS_MAP = ['', 'wait', 'done', 'expired'];
// 角标键：与服务端 statusTotals 一一对应（'' = 全部标签，不显示角标）
var BADGE_KEYS = ['', 'wait', 'done', 'expired'];

Page({
  data: {
    tabs: ['全部', '待教师确认', '已确认', '已过期'],
    badges: [0, 0, 0, 0],
    activeTab: 0,
    list: [],
    empty: false,
    loading: false,
    loadingMore: false,
    noMore: false,
    page: 0,
    total: 0,
    summary: '',
    loadError: '',
    needBind: false
  },

  onShow: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () {
      var role = (app.globalData && app.globalData.role) || '';
      var user = (app.globalData && app.globalData.user) || null;
      if (!role || !user) {
        that.setData({ needBind: true, empty: true, list: [], badges: [0, 0, 0, 0], summary: '' });
        return;
      }
      that.setData({ needBind: false });
      that.reload();
    });
  },

  onPullDownRefresh: function () {
    var that = this;
    this.reload().then(function () { wx.stopPullDownRefresh(); });
    // 兜底：即便 reload 内部异常也结束下拉态
    setTimeout(function () { wx.stopPullDownRefresh(); }, 800);
  },

  /** 上拉加载下一页（服务端分页） */
  onReachBottom: function () {
    if (this.data.loading || this.data.loadingMore || this.data.noMore) return;
    this.fetchPage(this.data.page + 1);
  },

  /** 重新加载第一页 */
  reload: function () {
    return this.fetchPage(1);
  },

  /**
   * 拉取某一页
   * @param {number} page 页码（从 1 开始）
   */
  fetchPage: function (page) {
    var that = this;
    var status = STATUS_MAP[this.data.activeTab] || '';
    var isFirst = page <= 1;
    this.setData(isFirst ? { loading: true, loadError: '' } : { loadingMore: true });

    var params = { page: page, pageSize: PAGE_SIZE };
    if (status) params.status = status;

    return api.getSessions(params).then(function (data) {
      var p = shape.pageOf(data);
      var rows = shape.sessionList(p.list);
      var list = isFirst ? rows : that.data.list.concat(rows);
      var summary = p.summary || {};
      var hours = Number(summary.hours || 0);
      // 角标口径：优先 summary.statusTotals（不受 status= 筛选影响），旧后端回退 byStatus
      var totals = shape.statusTotals(p);
      var badges = BADGE_KEYS.map(function (s) { return s ? Number(totals[s] || 0) : 0; });
      that.setData({
        loading: false,
        loadingMore: false,
        page: page,
        list: list,
        badges: badges,
        empty: list.length === 0,
        total: p.total,
        noMore: list.length >= p.total || rows.length === 0,
        summary: '共 ' + p.total + ' 条 · 本次筛选已确认 ' + hours + ' 学时'
      });
      return null;
    }).catch(function (err) {
      var msg = (err && err.msg) || '课时记录加载失败';
      that.setData({ loading: false, loadingMore: false, loadError: msg });
      if (api.isUnauthorized(err)) {
        that.setData({ needBind: true, empty: true, list: [], badges: [0, 0, 0, 0], summary: '' });
        return null;
      }
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      return null;
    });
  },

  /** 切换状态标签：按后端 status 重新拉第一页 */
  switchTab: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    if (idx === this.data.activeTab && this.data.list.length) return;
    this.setData({ activeTab: idx, list: [], empty: false, noMore: false });
    this.fetchPage(1);
  },

  openDetail: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/check/check?id=' + id });
  },

  goBind: function () {
    wx.navigateTo({ url: '/pages/bind/bind' });
  }
});
