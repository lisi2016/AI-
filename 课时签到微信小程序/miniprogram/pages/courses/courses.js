// 我的课程：班干部维护本班课程清单（新流程第一步：录入一次、长期保留）
//
// 页面 ↔ 接口：
//   GET    /api/v1/class-courses        列表（默认只看「使用中」，可切「已归档 / 全部」）
//   POST   /api/v1/class-courses        新增（课程名、授课老师必填）
//   PUT    /api/v1/class-courses/{id}   编辑（部分字段；不可改教学班）
//   DELETE /api/v1/class-courses/{id}   归档（软删除 → status='archived'）
//
// 约定：
//   · 所有错误提示都用后端返回的 msg 原文（敏感词 / 长度 / 权限 / 已归档等），不吞不换
//   · 不采集定位（本页无任何位置类接口调用）
//   · 教师可只读查看（后端允许按班查询），写操作入口按角色隐藏

var app = getApp();
var api = require('../../utils/api.js');
var shape = require('../../utils/shape.js');
var session = require('../../utils/session.js');

var PAGE_SIZE = 100;
var STATUS_TABS = [
  { key: 'active', text: '使用中' },
  { key: 'archived', text: '已归档' },
  { key: 'all', text: '全部' }
];

function emptyForm() {
  return {
    show: false,
    mode: 'create',      // create | edit
    id: '',
    courseName: '',
    teacherName: '',
    weekdayIndex: 0,     // 0 = 未排课
    sectionIndex: 0,     // 0 = 不填
    place: '',
    hours: '2',
    error: ''
  };
}

Page({
  data: {
    role: '',
    ready: false,
    needBind: false,
    bindHint: '',
    readonly: false,
    loading: false,
    loadError: '',
    statusTabs: STATUS_TABS.map(function (t) { return t.text; }),
    statusIndex: 0,
    list: [],
    summary: { total: 0, active: 0, archived: 0 },
    empty: false,
    weekdayRange: shape.WEEKDAY_OPTIONS.map(function (w) { return w.text; }),
    sectionRange: ['不填'].concat(shape.SECTION_OPTIONS),
    form: emptyForm(),
    submitting: false
  },

  onLoad: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () { that.render(); });
  },

  onShow: function () {
    var that = this;
    var p = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
    Promise.resolve(p).then(function () {
      that.render();
      if (!that.data.needBind) that.reload();
    });
  },

  onPullDownRefresh: function () {
    var that = this;
    this.reload().then(function () { wx.stopPullDownRefresh(); });
    setTimeout(function () { wx.stopPullDownRefresh(); }, 800);
  },

  render: function () {
    var role = (app.globalData && app.globalData.role) || session.getRole() || '';
    var user = (app.globalData && app.globalData.user) || session.getUser() || null;
    var needBind = !role || !user;
    this.setData({
      role: role,
      ready: true,
      needBind: needBind,
      bindHint: (app.globalData && app.globalData.bindHint) || '',
      // 教师对本班课程清单只读（后端允许查看，写操作会 40301）
      readonly: role === 'teacher'
    });
  },

  goBind: function () {
    wx.navigateTo({
      url: '/pages/bind/bind',
      fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
    });
  },

  /** 列表：GET /class-courses（status 由标签决定） */
  reload: function () {
    var that = this;
    var status = (STATUS_TABS[this.data.statusIndex] || STATUS_TABS[0]).key;
    this.setData({ loading: true, loadError: '' });
    return api.getClassCourses({ status: status, page: 1, pageSize: PAGE_SIZE }).then(function (data) {
      var page = shape.pageOf(data);
      var list = shape.courseList(page.list);
      that.setData({
        loading: false,
        list: list,
        empty: list.length === 0,
        summary: page.summary || { total: 0, active: 0, archived: 0 }
      });
      return null;
    }).catch(function (err) {
      var msg = (err && err.msg) || '课程清单加载失败';
      that.setData({ loading: false, list: [], empty: true, loadError: msg });
      if (api.isUnauthorized(err)) {
        that.setData({ needBind: true });
        session.guideToBind(msg);
        return null;
      }
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      return null;
    });
  },

  switchStatus: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    if (idx === this.data.statusIndex && this.data.list.length) return;
    this.setData({ statusIndex: idx, form: emptyForm() });
    this.reload();
  },

  // ---------- 表单 ----------
  openCreate: function () {
    this.setData({ form: Object.assign(emptyForm(), { show: true }) });
  },

  openEdit: function (e) {
    var id = e.currentTarget.dataset.id;
    var hit = this.data.list.filter(function (c) { return String(c.id) === String(id); })[0];
    if (!hit) return;
    var wdIdx = 0;
    shape.WEEKDAY_OPTIONS.forEach(function (w, i) { if (Number(w.value) === Number(hit.weekday)) wdIdx = i; });
    var secIdx = this.data.sectionRange.indexOf(hit.section);
    this.setData({
      form: {
        show: true,
        mode: 'edit',
        id: hit.id,
        courseName: hit.courseName,
        teacherName: hit.teacherName,
        weekdayIndex: wdIdx,
        sectionIndex: secIdx < 0 ? 0 : secIdx,
        place: hit.place,
        hours: String(hit.hours || 2),
        error: ''
      }
    });
  },

  closeForm: function () {
    this.setData({ form: emptyForm() });
  },

  onCourseName: function (e) { this.setData({ 'form.courseName': e.detail.value, 'form.error': '' }); },
  onTeacherName: function (e) { this.setData({ 'form.teacherName': e.detail.value, 'form.error': '' }); },
  onPlace: function (e) { this.setData({ 'form.place': e.detail.value, 'form.error': '' }); },
  onHours: function (e) { this.setData({ 'form.hours': e.detail.value, 'form.error': '' }); },

  pickWeekday: function (e) {
    this.setData({ 'form.weekdayIndex': Number(e.detail.value) });
  },

  pickSection: function (e) {
    this.setData({ 'form.sectionIndex': Number(e.detail.value) });
  },

  /** 表单 → 接口入参（weekday 0 = 未排课 → 传 null 之外的语义：不传该字段） */
  buildPayload: function () {
    var f = this.data.form;
    var wd = shape.WEEKDAY_OPTIONS[f.weekdayIndex] || shape.WEEKDAY_OPTIONS[0];
    var section = f.sectionIndex > 0 ? (shape.SECTION_OPTIONS[f.sectionIndex - 1] || '') : '';
    var payload = {
      courseName: String(f.courseName || '').trim(),
      teacherName: String(f.teacherName || '').trim(),
      place: String(f.place || '').trim(),
      section: section,
      hours: f.hours === '' ? undefined : Number(f.hours)
    };
    // 未排课 → 显式传空字符串，后端 normalizeWeekday 归一为 null
    payload.weekday = Number(wd.value) ? Number(wd.value) : '';
    return payload;
  },

  /** 保存：新增 POST / 编辑 PUT；失败把后端 msg 原样展示（敏感词、长度、权限等） */
  submitForm: function () {
    var that = this;
    if (this.data.submitting) return;
    var f = this.data.form;
    if (!String(f.courseName || '').trim()) {
      this.setData({ 'form.error': '请填写课程名称' });
      return;
    }
    if (!String(f.teacherName || '').trim()) {
      this.setData({ 'form.error': '请填写授课老师' });
      return;
    }
    var payload = this.buildPayload();
    this.setData({ submitting: true, 'form.error': '' });

    var p = f.mode === 'edit'
      ? api.updateClassCourse(f.id, payload)
      : api.createClassCourse(payload);

    p.then(function () {
      that.setData({ submitting: false, form: emptyForm() });
      wx.showToast({ title: f.mode === 'edit' ? '已保存' : '已添加', icon: 'success' });
      that.reload();
    }).catch(function (err) {
      var msg = (err && err.msg) || '保存失败，请重试';
      that.setData({ submitting: false, 'form.error': msg });
      if (api.isUnauthorized(err)) {
        that.setData({ needBind: true });
        session.guideToBind(msg);
        return;
      }
      // 后端 msg 原样弹出（例如「内容包含敏感词：代签（课程名称），请修改后重新提交」）
      wx.showModal({ title: '保存未成功', content: msg, showCancel: false, confirmText: '知道了' });
    });
  },

  /** 归档（软删除）：DELETE /class-courses/{id} */
  archive: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    var name = e.currentTarget.dataset.name || '';
    wx.showModal({
      title: '归档这门课？',
      content: '「' + name + '」将从课程清单中移除（软删除，历史课时仍可追溯）。归档后需联系管理员才能恢复。',
      confirmText: '归档',
      success: function (res) {
        if (!res.confirm) return;
        api.archiveClassCourse(id).then(function () {
          wx.showToast({ title: '已归档', icon: 'success' });
          that.reload();
        }).catch(function (err) {
          var msg = (err && err.msg) || '归档失败，请重试';
          if (api.isUnauthorized(err)) {
            that.setData({ needBind: true });
            session.guideToBind(msg);
            return;
          }
          wx.showModal({ title: '归档未成功', content: msg, showCancel: false, confirmText: '知道了' });
        });
      }
    });
  }
});
