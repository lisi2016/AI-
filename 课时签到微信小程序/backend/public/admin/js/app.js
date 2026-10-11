'use strict';
/**
 * 后台外壳：登录态切换、左侧菜单、顶部面包屑、hash 路由、公共数据缓存
 */
window.Admin = window.Admin || {};
(function (A) {
  var ui = A.ui;
  var api = A.api;

  // 一级菜单（按角色过滤；角色为空表示所有可登录角色可见）
  var MENU = [
    { group: '统计', items: [
      { id: 'dashboard', label: '学时统计看板', icon: '📊' },
      { id: 'records', label: '课时明细', icon: '📋' },
    ] },
    { group: '教学', items: [
      { id: 'courses', label: '课程清单', icon: '📚' },
    ] },
    { group: '审核', items: [
      { id: 'makeup', label: '补签审核', icon: '📝' },
      { id: 'appeal', label: '申诉处理', icon: '⚖️' },
    ] },
    { group: '数据', items: [
      { id: 'import', label: '数据导入中心', icon: '📥', roles: ['admin', 'dept_admin'] },
      { id: 'export', label: '报表导出中心', icon: '📤' },
    ] },
    { group: '系统', items: [
      { id: 'config', label: '规则配置', icon: '⚙️' },
      { id: 'logs', label: '操作日志', icon: '🗂️' },
    ] },
  ];

  var PAGES = {};
  var state = {
    user: null,
    role: '',
    config: null,
    route: '',
    params: {},
    pageCtx: null,
    badges: {},
  };

  // ---------------------------------------------------------------- 公共数据
  var cache = { terms: null, depts: null, config: null };

  function loadConfig(force) {
    if (!force && cache.config) return Promise.resolve(cache.config);
    return api.get('/config').then(function (d) {
      cache.config = d;
      state.config = d;
      if (d && d.terms) cache.terms = d.terms.slice();
      return d;
    });
  }
  function loadTerms(force) {
    if (!force && cache.terms) return Promise.resolve(cache.terms);
    return loadConfig(force).then(function (d) { return (d && d.terms) || []; });
  }
  /** 院系列表（用统计接口的返回，无需额外接口） */
  function loadDepts(force) {
    if (!force && cache.depts) return Promise.resolve(cache.depts);
    return api.get('/stats/by-dept', {}).then(function (d) {
      cache.depts = (d && d.list ? d.list : []).map(function (x) { return { id: x.deptId || x.id, name: x.name }; });
      return cache.depts;
    }).catch(function () { return cache.depts || []; });
  }
  function clearCache() { cache = { terms: null, depts: null, config: null }; }

  // ---------------------------------------------------------------- 页面注册
  function registerPage(id, def) {
    PAGES[id] = def;
  }

  function menuItemById(id) {
    for (var i = 0; i < MENU.length; i++) {
      for (var j = 0; j < MENU[i].items.length; j++) {
        if (MENU[i].items[j].id === id) return MENU[i].items[j];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 视图切换
  function showLogin(message) {
    document.getElementById('login-view').hidden = false;
    document.getElementById('app-view').hidden = true;
    var err = document.getElementById('login-error');
    if (err) err.textContent = message || '';
    var no = document.getElementById('login-no');
    if (no && !no.value) no.value = api.rememberedNo();
    if (no) no.focus();
  }

  function showApp() {
    document.getElementById('login-view').hidden = true;
    document.getElementById('app-view').hidden = false;
    renderSidebar();
    renderTopbar();
    route();
  }

  function renderSidebar() {
    var nav = document.getElementById('nav');
    var role = state.role;
    var html = '';
    MENU.forEach(function (g) {
      var items = g.items.filter(function (it) { return !it.roles || it.roles.indexOf(role) >= 0; });
      if (!items.length) return;
      html += '<div class="nav-group-title">' + ui.esc(g.group) + '</div>';
      items.forEach(function (it) {
        var badge = state.badges[it.id] ? '<span class="badge">' + state.badges[it.id] + '</span>' : '';
        html += '<a class="nav-item" href="#/' + it.id + '" data-route="' + it.id + '">' +
          '<span class="ico">' + it.icon + '</span><span class="label">' + ui.esc(it.label) + '</span>' + badge + '</a>';
      });
    });
    nav.innerHTML = html;
  }

  function renderTopbar() {
    var user = state.user || {};
    document.getElementById('role-tag').textContent = roleText(state.role);
    document.getElementById('user-name').textContent = user.name || user.realName || user.no || '—';
    document.getElementById('user-avatar').textContent = String(user.name || user.realName || '?').slice(0, 1);
  }

  function roleText(role) {
    return ({ admin: '教务处', dept_admin: '院系管理员', teacher: '教师', cadre: '班干部' })[role] || role || '';
  }

  function renderCrumb(id) {
    var item = menuItemById(id);
    var group = '';
    MENU.forEach(function (g) { if (g.items.some(function (it) { return it.id === id; })) group = g.group; });
    var page = PAGES[id];
    document.getElementById('crumb').innerHTML =
      '<span>首页</span><span>/</span>' +
      (group ? '<span>' + ui.esc(group) + '</span><span>/</span>' : '') +
      '<span class="cur">' + ui.esc((page && page.title) || (item && item.label) || id) + '</span>';
  }

  // ---------------------------------------------------------------- 路由
  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var qs = '';
    var qi = raw.indexOf('?');
    if (qi >= 0) { qs = raw.slice(qi + 1); raw = raw.slice(0, qi); }
    var params = {};
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      if (k) params[k] = v;
    });
    return { id: raw || 'dashboard', params: params };
  }

  function navigate(hash, params) {
    var qs = '';
    if (params) {
      var parts = Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] !== undefined && params[k] !== null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
      if (parts.length) qs = '?' + parts.join('&');
    }
    location.hash = '#/' + hash + qs;
  }

  function route() {
    if (!state.user) return;
    var r = parseHash();
    var page = PAGES[r.id];
    var item = menuItemById(r.id);
    if (!page || (item && item.roles && item.roles.indexOf(state.role) < 0)) {
      if (r.id !== 'dashboard') { navigate('dashboard'); return; }
      page = PAGES.dashboard;
      r.id = 'dashboard';
    }
    state.route = r.id;
    state.params = r.params;

    // 菜单高亮
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === r.id);
    });
    renderCrumb(r.id);

    var el = document.getElementById('page');
    el.innerHTML = '';
    el.scrollTop = 0;
    window.scrollTo(0, 0);

    var ctx = {
      el: el,
      route: r.id,
      params: r.params,
      user: state.user,
      role: state.role,
      state: state,
      navigate: navigate,
      refresh: function () { route(); },
      onDestroy: null,
    };
    state.pageCtx = ctx;
    try {
      var maybe = page.render(ctx);
      if (maybe && typeof maybe.catch === 'function') {
        maybe.catch(function (e) { el.innerHTML = ui.errorHtml(e && e.msg || e && e.message); });
      }
    } catch (e) {
      el.innerHTML = ui.errorHtml(e && e.message);
      console.error('[page] 渲染失败', e);
    }
  }

  // ---------------------------------------------------------------- 登录 / 登出
  function bindLogin() {
    var form = document.getElementById('login-form');
    var errEl = document.getElementById('login-error');
    var submit = document.getElementById('login-submit');
    var remember = document.getElementById('login-remember');
    var noInput = document.getElementById('login-no');
    var pwdInput = document.getElementById('login-password');
    var remembered = api.rememberedNo();
    if (remembered) { noInput.value = remembered; pwdInput.focus(); }

    document.getElementById('login-forgot').addEventListener('click', function (e) {
      e.preventDefault();
      ui.openModal({
        title: '忘记密码',
        body: '<div style="line-height:1.9">' +
          '本后台账号密码由<b>教务处</b>统一管理，请按以下方式处理：<br>' +
          '1. 联系教务处管理员在后台重置密码（当前版本请由管理员删除 data/users.json 中该账号的 <code>password_hash</code> 字段后重启服务，将自动恢复初始密码）；<br>' +
          '2. 初始密码为 <code>123456</code>，登录后请立即在右上角「修改密码」中更换。' +
          '</div>',
        footer: [{ label: '我知道了', onClick: function (api2) { api2.close(); } }],
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errEl.textContent = '';
      var no = noInput.value.trim();
      var password = pwdInput.value;
      if (!no) { errEl.textContent = '请输入工号/学号'; return; }
      if (!password) { errEl.textContent = '请输入密码'; return; }
      submit.disabled = true;
      submit.textContent = '登录中…';
      // Web 后台走账号密码分支：请求体不含 code，含 { no, password }
      api.post('/auth/login', { no: no, password: password })
        .then(function (data) {
          if (!data || !data.token) throw new Error('登录返回异常：缺少 token');
          api.setSession(data.token, data.user, no, !!remember.checked);
          state.user = data.user;
          state.role = data.role || (data.user && data.user.role) || '';
          pwdInput.value = '';
          ui.toast('登录成功，欢迎回来 ' + ((data.user && (data.user.name || data.user.realName)) || ''), 'ok');
          return bootstrapApp();
        })
        .catch(function (err) {
          errEl.textContent = (err && err.msg) || (err && err.message) || '登录失败';
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = '登 录';
        });
    });
  }

  function bootstrapApp() {
    return api.get('/auth/me').then(function (d) {
      state.user = d.user || state.user;
      state.role = d.role || state.role;
      state.config = d.config || null;
      clearCache();
      showApp();
      refreshPendingBadge();
      return d;
    });
  }

  function refreshPendingBadge() {
    if (!state.user) return;
    api.get('/makeup', { status: 'pending', pageSize: 1 }).then(function (d) {
      var n = (d && d.pending) || 0;
      if (n > 0) state.badges.makeup = n; else delete state.badges.makeup;
      renderSidebar();
    }).catch(function () { /* 无权限或失败时忽略角标 */ });
  }

  function doLogout() {
    var token = api.getToken();
    var done = function () {
      api.clearSession();
      state.user = null; state.role = '';
      clearCache();
      location.hash = '';
      showLogin('');
      ui.toast('已退出登录', 'ok');
    };
    if (!token) return done();
    api.post('/auth/logout', {}).then(done).catch(done);
  }

  function bindTopbar() {
    // 测试报告：必须已登录才能读取（接口需 Bearer token），未登录拿不到内容
    var reportBtn = document.getElementById('btn-test-report');
    if (reportBtn) {
      reportBtn.addEventListener('click', function () {
        var w = window.open('', '_blank');
        if (!w) { ui.toast('浏览器拦截了弹窗，请允许弹出窗口后重试', 'error'); return; }
        w.document.write('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">正在加载测试报告…</p>');
        api.fetchBlob('/test-report/html').then(function (b) { return b.text(); }).then(function (html) {
          w.document.open(); w.document.write(html); w.document.close();
          // 报告内指向 docx 的链接改为带鉴权下载
          try {
            var link = w.document.querySelector('a[href*="test-report.docx"]');
            if (link) {
              link.addEventListener('click', function (ev) {
                ev.preventDefault();
                api.download('/test-report/docx', null, 'test-report.docx').then(function () {
                  ui.toast('Word 版已开始下载', 'ok');
                }).catch(function (e) { ui.toast((e && e.msg) || '下载失败', 'error'); });
              });
            }
          } catch (e) { /* 忽略 */ }
        }).catch(function (e) {
          w.document.open();
          w.document.write('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px;color:#c00">加载失败：' +
            ((e && e.msg) || '未知错误') + '</p>');
          w.document.close();
        });
      });
    }
    document.getElementById('btn-logout').addEventListener('click', function () {
      ui.confirm({ title: '退出登录', message: '确认退出当前账号？', okText: '退出' }).then(function (ok) {
        if (ok) doLogout();
      });
    });
    document.getElementById('btn-change-pwd').addEventListener('click', function () {
      ui.promptForm({
        title: '修改密码',
        hint: '密码仅保存在服务端（SHA-256 摘要），修改后当前登录状态保持有效。',
        fields: [
          { name: 'oldPassword', label: '原密码', type: 'password', required: true, full: true },
          { name: 'newPassword', label: '新密码', type: 'password', required: true, full: true, hint: '6–64 位，不含空格' },
          { name: 'confirmPassword', label: '确认新密码', type: 'password', required: true, full: true },
        ],
        okText: '保存',
      }).then(function (v) {
        if (!v) return;
        if (v.newPassword !== v.confirmPassword) { ui.toast('两次输入的新密码不一致', 'error'); return; }
        api.post('/auth/password', { oldPassword: v.oldPassword, newPassword: v.newPassword })
          .then(function () { ui.toast('密码修改成功', 'ok'); })
          .catch(function (e) { ui.toast(e.msg || '修改失败', 'error'); });
      });
    });
  }

  // ---------------------------------------------------------------- 启动
  function init() {
    bindLogin();
    bindTopbar();

    api.onUnauthorized(function (msg) {
      if (document.getElementById('app-view').hidden === false) {
        showLogin(msg || '登录已失效，请重新登录');
        ui.toast(msg || '登录已失效，请重新登录', 'warn');
      }
    });

    window.addEventListener('hashchange', route);

    if (!api.hasToken()) { showLogin(''); return; }
    bootstrapApp().catch(function () {
      api.clearSession();
      showLogin('登录已失效，请重新登录');
    });
  }

  A.registerPage = registerPage;
  A.MENU = MENU;
  A.state = state;
  A.navigate = navigate;
  A.roleText = roleText;
  A.data = { loadConfig: loadConfig, loadTerms: loadTerms, loadDepts: loadDepts, clearCache: clearCache };

  // 异步任务轮询（导出等）：每 500ms 查一次状态，最多 tries 次
  A.jobs = {
    waitExport: function (jobId, onTick, tries) {
      var left = (tries === undefined) ? 40 : tries;
      return api.get('/export/' + encodeURIComponent(jobId)).then(function (job) {
        if (typeof onTick === 'function') onTick(job);
        if (!job || job.status === 'done' || job.status === 'failed') return job;
        if (left <= 0) return job;
        return new Promise(function (r) { setTimeout(r, 500); })
          .then(function () { return A.jobs.waitExport(jobId, onTick, left - 1); });
      });
    },
  };
  A.app = { init: init, refreshPendingBadge: refreshPendingBadge, logout: doLogout };

  document.addEventListener('DOMContentLoaded', init);
})(window.Admin);
