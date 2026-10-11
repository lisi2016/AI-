'use strict';
/**
 * 课时明细（P0★）—— 业务流程简化版
 *
 * 新流程：班干部（学委）从课程清单带出信息 → 出示 60 秒动态码 → 任课教师扫码点「确认」。
 * 数据源：GET /sessions（课时会话）；后端未提供该接口时自动回退 GET /records（旧流程兼容）。
 *
 * 证据四项：**动态码 / 确认人 / 确认时间 / 设备**。
 * 不再有手写签名图、不再有位置信息 —— 本页不读取、不渲染任何签名图片。
 * 学时归属口径：按**实际授课人**（teacherName）。
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  // 审计动作 → 中文
  var ACTION_TEXT = {
    'session.create': '班干部发起课时并签发动态码',
    'session.confirm': '任课教师确认本次课时',
    'session.code.refresh': '刷新课时动态码',
    'session.adopt': '旧流程待确认记录升级为课时会话',
    'record.create': '发起课时确认（旧流程）',
    'record.sign': '班干部签名确认（旧流程）',
    'record.reject': '班干部拒绝确认（旧流程）',
    'record.revoke': '撤销课时记录',
    'record.urge': '提醒签字人',
    'record.expire': '超期自动置为已过期',
    'record.seed': '种子数据',
    'makeup.apply': '教师发起补签',
    'makeup.approve': '补签审核通过',
    'makeup.reject': '补签审核驳回',
    'appeal.apply': '教师发起申诉',
    'appeal.approve': '申诉处理通过',
    'appeal.reject': '申诉驳回',
  };
  function actionText(a) { return ACTION_TEXT[a] || a; }

  var ROLE_TEXT = { admin: '教务处', dept_admin: '院系管理员', teacher: '教师', cadre: '班干部' };
  function roleText(r) { return ROLE_TEXT[r] || r || ''; }

  /** 证据四项（新流程固定口径；标签优先取后端 evidence.labels） */
  var EVIDENCE_LABELS = ['动态码', '确认人', '确认时间', '设备'];

  /** 导出表头提示（后端固定 21 列，不随筛选缺列） */
  var EXPORT_HEADER_HINT = '固定 21 列表头：学期 / 教师姓名（= 实际授课人）/ 工号 / 院系 / 课程 / 教学班 / ' +
    '上课日期 / 节次 / 应计学时 / 状态 / 是否补签 / 发起人（学委）/ 发起人职务 / 是否现场指定 / ' +
    '确认人 / 是否临时调整 / 确认人与实际授课人不符 / 确认时间 / 缺勤人数 / 缺勤姓名 / 课堂纪律';

  function isOn(v) { return v === true || Number(v) === 1 || v === '1'; }
  /** 姓名归一化（去空白 + 小写，用于姓名 ↔ 教师匹配） */
  function norm(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, '').toLowerCase(); }

  function render(ctx) {
    var el = ctx.el;
    var state = {
      page: 1,
      pageSize: 20,
      total: 0,
      rows: [],
      summary: null,
      selected: {},
      teachers: [],
      source: 'sessions', // sessions=新流程课时会话；records=全部记录（旧流程兼容）
      clientNote: '',
      teacherIdFilter: ctx.params.teacherId || '', // 看板「教师学时排行」下钻用的精确 teacherId
    };

    var f = {
      term: ctx.params.term || '',
      from: ctx.params.from || '',
      to: ctx.params.to || '',
      deptId: ctx.params.deptId || '',
      teacherName: ctx.params.teacherName || '',
      courseName: ctx.params.courseName || '',
      keyword: ctx.params.keyword || '',
      temp: ctx.params.tempAdjusted || '',
      mismatch: ctx.params.nameMismatch || '',
      statuses: (ctx.params.status || '').split(',').filter(Boolean),
    };

    el.innerHTML =
      '<div class="page-title"><h2>课时明细</h2>' +
      '<span class="desc">学时按<b>实际授课人</b>归属；证据四项为「动态码 / 确认人 / 确认时间 / 设备」' +
      '（新流程不再手写签名、不采集定位）</span></div>' +
      '<div class="panel"><div class="panel-body" id="f-wrap">' + ui.loadingHtml('正在加载筛选项…') + '</div></div>' +
      '<div class="panel" id="list-panel">' +
      '<div class="panel-head"><h3>明细列表</h3><span class="sub" id="list-sub"></span>' +
      '<div class="actions">' +
      '<span class="seg">' +
      '<button type="button" class="btn btn-ghost btn-sm active" data-src="sessions">课时会话（新流程）</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-src="records">全部记录（含旧流程）</button>' +
      '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="btn-export" disabled>导出筛选结果</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="btn-export-sel" disabled>批量导出选中</button>' +
      '</div></div>' +
      '<div class="panel-body" style="padding:12px 16px 0" id="src-alert" hidden></div>' +
      '<div id="list-body">' + ui.loadingHtml('正在加载课时数据…') + '</div>' +
      '</div>';

    var bodyEl = el.querySelector('#list-body');
    var alertEl = el.querySelector('#src-alert');

    Promise.all([
      A.data.loadTerms(),
      A.data.loadDepts(),
      api.get('/stats/by-teacher', { page: 1, pageSize: 200 }).catch(function () { return { rank: [] }; }),
    ]).then(function (res) {
      state.teachers = (res[2] && (res[2].rank || res[2].list)) || [];
      // 看板下钻：teacherId → 姓名回填（便于用户看清筛的是谁）
      if (state.teacherIdFilter && !f.teacherName) {
        var picked = state.teachers.filter(function (t) { return String(t.teacherId || t.id) === String(state.teacherIdFilter); })[0];
        if (picked) f.teacherName = picked.name || '';
      }
      el.querySelector('#f-wrap').innerHTML = filterBarHtml(res[0] || [], res[1] || []);
      bindFilters();
      load();
    }).catch(function (e) {
      bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), function () { ctx.refresh(); });
    });

    // ---------------------------------------------------------- 提示条
    function alert(msg, type) {
      alertEl.innerHTML = msg ? ui.alertHtml(msg, type || 'info') : '';
      alertEl.hidden = !msg;
    }

    // ---------------------------------------------------------- 筛选区
    function filterBarHtml(terms, depts) {
      var termOpts = '<option value="">全部学期</option>' + terms.map(function (t) {
        return '<option value="' + ui.esc(t) + '"' + (t === f.term ? ' selected' : '') + '>' + ui.esc(t) + '</option>';
      }).join('');
      var deptOpts = '<option value="">全部院系</option>' + depts.map(function (d) {
        return '<option value="' + ui.esc(d.id) + '"' + (String(d.id) === String(f.deptId) ? ' selected' : '') + '>' + ui.esc(d.name) + '</option>';
      }).join('');
      var teacherOpts = state.teachers.map(function (t) {
        return '<option value="' + ui.esc(t.name || t.teacherName || '') + '">' +
          ui.esc(t.name || '') + (t.staffNo ? '（' + ui.esc(t.staffNo) + '）' : '') +
          (t.registered === false ? ' · 非系统内' : '') + '</option>';
      }).join('');
      var statusChips = ui.STATUS_ORDER.map(function (s) {
        var on = f.statuses.indexOf(s) >= 0;
        return '<label class="inline"><input type="checkbox" data-status="' + s + '"' + (on ? ' checked' : '') + '> ' +
          ui.esc(ui.sessionStatusText(s)) + ' <span class="muted" data-cnt="' + s + '"></span></label>';
      }).join('');

      return '<div class="filters">' +
        '<div class="f"><label>学期</label><select id="f-term">' + termOpts + '</select></div>' +
        '<div class="f"><label>开始日期</label><input type="date" id="f-from" value="' + ui.esc(f.from) + '"></div>' +
        '<div class="f"><label>结束日期</label><input type="date" id="f-to" value="' + ui.esc(f.to) + '"></div>' +
        '<div class="f"><label>院系</label><select id="f-dept">' + deptOpts + '</select></div>' +
        '<div class="f"><label>实际授课人（按姓名）</label>' +
        '<input type="text" id="f-teacher" list="f-teacher-list" placeholder="输入姓名模糊匹配" value="' + ui.esc(f.teacherName) + '">' +
        '<datalist id="f-teacher-list">' + teacherOpts + '</datalist>' +
        (state.teacherIdFilter ? '<div class="help-text">看板下钻：' + ui.esc(state.teacherIdFilter) + '</div>' : '') + '</div>' +
        '<div class="f"><label>课程</label><input type="text" id="f-course" placeholder="课程名称模糊匹配" value="' + ui.esc(f.courseName) + '"></div>' +
        '<div class="f"><label>关键字（课程/教学班/授课人/发起人/确认人）</label><input type="text" id="f-keyword" value="' + ui.esc(f.keyword) + '"></div>' +
        '<div class="f"><label>是否临时调整</label><select id="f-temp">' +
        '<option value=""' + (f.temp === '' ? ' selected' : '') + '>全部</option>' +
        '<option value="true"' + (f.temp === 'true' ? ' selected' : '') + '>仅临时调整</option>' +
        '<option value="false"' + (f.temp === 'false' ? ' selected' : '') + '>排除临时调整</option>' +
        '</select></div>' +
        '<div class="f"><label>姓名不符（确认人≠实际授课人）</label><select id="f-mismatch">' +
        '<option value=""' + (f.mismatch === '' ? ' selected' : '') + '>全部</option>' +
        '<option value="true"' + (f.mismatch === 'true' ? ' selected' : '') + '>仅姓名不符</option>' +
        '<option value="false"' + (f.mismatch === 'false' ? ' selected' : '') + '>排除姓名不符</option>' +
        '</select></div>' +
        '<div class="f" style="flex:1 1 100%"><label>状态（角标为 statusTotals，不受状态筛选影响）</label>' +
        '<div class="status-chips">' + statusChips + '</div></div>' +
        '<div class="f-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="f-reset">重置</button>' +
        '<button type="button" class="btn" id="f-search">查询</button>' +
        '</div>' +
        '</div>';
    }

    function syncFilters() {
      var w = el.querySelector('#f-wrap');
      f.term = w.querySelector('#f-term').value;
      f.from = w.querySelector('#f-from').value;
      f.to = w.querySelector('#f-to').value;
      f.deptId = w.querySelector('#f-dept').value;
      f.teacherName = w.querySelector('#f-teacher').value.trim();
      f.courseName = w.querySelector('#f-course').value.trim();
      f.keyword = w.querySelector('#f-keyword').value.trim();
      f.temp = w.querySelector('#f-temp').value;
      f.mismatch = w.querySelector('#f-mismatch').value;
      f.statuses = [];
      w.querySelectorAll('[data-status]').forEach(function (c) { if (c.checked) f.statuses.push(c.getAttribute('data-status')); });
    }

    /** 姓名 → 系统内教师 ID（用于旧接口按 teacherId 服务端筛选） */
    function resolveTeacherId(name) {
      var n = norm(name);
      if (!n) return '';
      var hit = state.teachers.filter(function (t) { return norm(t.name) === n && (t.teacherId || t.id); })[0];
      return hit ? String(hit.teacherId || hit.id) : '';
    }

    /** 后端接口支持的筛选条件（/sessions 支持 teacherName / tempAdjusted / nameMismatch；/records 不支持后三者） */
    function buildQuery() {
      var q = {
        term: f.term,
        from: f.from,
        to: f.to,
        deptId: f.deptId,
        courseName: f.courseName,
        keyword: f.keyword,
        status: f.statuses.join(','),
        page: state.page,
        pageSize: state.pageSize,
      };
      if (state.teacherIdFilter) q.teacherId = state.teacherIdFilter; // 精确下钻（两个接口都支持）
      if (state.source === 'sessions') {
        q.teacherName = f.teacherName;
        q.tempAdjusted = f.temp;
        q.nameMismatch = f.mismatch;
      } else {
        // 旧接口：仅有 teacherId；姓名无法解析为 ID 时按当前页内筛选（见 visibleRows）
        var tid = resolveTeacherId(f.teacherName);
        if (tid) q.teacherId = tid;
      }
      return q;
    }

    function bindFilters() {
      var w = el.querySelector('#f-wrap');
      w.querySelector('#f-search').addEventListener('click', function () { syncFilters(); state.page = 1; load(); });
      w.querySelector('#f-reset').addEventListener('click', function () {
        f = { term: '', from: '', to: '', deptId: '', teacherName: '', courseName: '', keyword: '', temp: '', mismatch: '', statuses: [] };
        state.teacherIdFilter = '';
        state.page = 1;
        w.innerHTML = ui.loadingHtml('正在重置筛选…');
        Promise.all([A.data.loadTerms(), A.data.loadDepts()]).then(function (res) {
          w.innerHTML = filterBarHtml(res[0] || [], res[1] || []);
          bindFilters();
          load();
        });
      });
      w.querySelectorAll('[data-status]').forEach(function (cb) {
        cb.addEventListener('change', function () { syncFilters(); state.page = 1; load(); });
      });
      ['#f-term', '#f-dept', '#f-temp', '#f-mismatch'].forEach(function (sel) {
        var node = w.querySelector(sel);
        if (node) node.addEventListener('change', function () { syncFilters(); state.page = 1; load(); });
      });
      el.querySelectorAll('[data-src]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var src = btn.getAttribute('data-src');
          if (src === state.source) return;
          state.source = src;
          state.page = 1;
          state.selected = {};
          syncSourceButtons();
          alert(src === 'records'
            ? '已切换到「全部记录（含旧流程）」：数据源为旧接口 GET /records；「是否临时调整 / 姓名不符」按当前页内筛选。'
            : '', 'info');
          load();
        });
      });
      el.querySelector('#btn-export').addEventListener('click', function () { doExport(false); });
      el.querySelector('#btn-export-sel').addEventListener('click', function () { doExport(true); });
    }

    function syncSourceButtons() {
      el.querySelectorAll('[data-src]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-src') === state.source);
      });
    }

    // ---------------------------------------------------------- 列表
    function load() {
      var q = buildQuery();
      bodyEl.innerHTML = ui.loadingHtml('正在加载课时数据…');
      var path = state.source === 'sessions' ? '/sessions' : '/records';
      api.get(path, q).then(function (data) {
        state.rows = data.list || [];
        state.total = data.total || 0;
        state.summary = data.summary || null;
        state.page = data.page || 1;
        state.pageSize = data.pageSize || 20;
        state.selected = {};
        paintCounts();
        draw();
      }).catch(function (e) {
        // 后端未提供 /sessions（旧版本）→ 自动回退旧接口，保证后台可用
        if (state.source === 'sessions' && (e.status === 404 || e.status === 405)) {
          state.source = 'records';
          syncSourceButtons();
          alert('当前后端未提供 GET /sessions（课时会话接口），已自动回退到旧接口 GET /records 兼容模式；' +
            '「是否临时调整 / 姓名不符」改为当前页内筛选。', 'warn');
          load();
          return;
        }
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    /** 把 statusTotals（不受状态筛选影响）填进筛选区角标 */
    function paintCounts() {
      var totals = (state.summary && state.summary.statusTotals) || null;
      var w = el.querySelector('#f-wrap');
      if (!w) return;
      w.querySelectorAll('[data-cnt]').forEach(function (n) {
        var s = n.getAttribute('data-cnt');
        n.textContent = totals && totals[s] !== undefined ? '(' + totals[s] + ')' : '';
      });
    }

    /** 后端不支持的筛选条件在当前页内兜底（并在列表摘要中标注） */
    function visibleRows() {
      var rows = state.rows;
      var notes = [];
      if (state.source === 'sessions') {
        if (f.deptId) {
          rows = rows.filter(function (r) { return String(r.deptId || '') === String(f.deptId); });
          notes.push('院系');
        }
      } else {
        if (f.teacherName && !resolveTeacherId(f.teacherName)) {
          var n = norm(f.teacherName);
          rows = rows.filter(function (r) { return norm(r.teacherName).indexOf(n) >= 0; });
          notes.push('实际授课人');
        }
        if (f.temp) {
          var wantTemp = f.temp === 'true';
          rows = rows.filter(function (r) { return isOn(r.isTempAdjusted) === wantTemp; });
          notes.push('是否临时调整');
        }
        if (f.mismatch) {
          var wantMm = f.mismatch === 'true';
          rows = rows.filter(function (r) { return isOn(r.confirmNameMismatch) === wantMm; });
          notes.push('姓名不符');
        }
      }
      state.clientNote = notes.length ? ('后端不支持该条件，按当前页内筛选：' + notes.join('、')) : '';
      return rows;
    }

    function draw() {
      var rows = visibleRows();
      var sub = el.querySelector('#list-sub');
      var sum = state.summary || {};
      var parts = ['共 <b>' + state.total + '</b> 条', '已确认/已补签学时合计 <b>' + ui.num(sum.hours, 1) + '</b> 学时'];
      if (sum.tempAdjustedCount !== undefined) parts.push('临时调整 <b>' + sum.tempAdjustedCount + '</b>');
      if (sum.nameMismatchCount !== undefined) parts.push('姓名不符 <b>' + sum.nameMismatchCount + '</b>');
      if (state.clientNote) parts.push(state.clientNote);
      sub.innerHTML = parts.join(' · ');
      sub.title = state.clientNote || '';

      if (!rows.length) {
        bodyEl.innerHTML = ui.emptyHtml({
          icon: '📋',
          title: state.total ? '当前页没有符合条件的课时' : '还没有符合条件的课时会话',
          hint: state.total
            ? '可切换分页，或清空「是否临时调整 / 姓名不符」等筛选条件'
            : '班干部（学委）在小程序端出示动态码、任课教师扫码点「确认」后，这里会出现课时会话',
          actions: [
            { label: '查看课程清单', primary: true, onClick: function () { ctx.navigate('courses'); } },
            { label: '重置筛选', onClick: function () { el.querySelector('#f-reset').click(); } },
          ],
        });
        el.querySelector('#btn-export').disabled = false;
        el.querySelector('#btn-export-sel').disabled = true;
        return;
      }

      var cols = [
        {
          key: 'sel', labelHtml: '<input type="checkbox" data-role="all">',
          render: function (r) {
            return '<input type="checkbox" data-row="' + ui.esc(r.id) + '"' + (state.selected[r.id] ? ' checked' : '') + '>';
          },
        },
        { key: 'date', label: '上课日期', render: function (r) { return ui.esc(r.fullDate || r.teachDate || r.date); } },
        { key: 'section', label: '节次', render: function (r) { return ui.esc(r.section) + (r.time ? '<div class="muted" style="font-size:11.5px">' + ui.esc(r.time) + '</div>' : ''); } },
        {
          key: 'teacherName', label: '实际授课人',
          render: function (r) {
            return ui.esc(r.teacherName || '—') +
              (r.teacherNo ? '<div class="muted" style="font-size:11.5px">工号 ' + ui.esc(r.teacherNo) + '</div>' : '') +
              (!r.teacherId ? ' ' + ui.flagTag('非系统内', 'tag-reg') : '');
          },
        },
        {
          key: 'initiatorName', label: '发起人（学委）',
          render: function (r) {
            return r.initiatorName
              ? ui.esc(r.initiatorName) + (r.initiatorDuty ? '<div class="muted" style="font-size:11.5px">' + ui.esc(r.initiatorDuty) + '</div>' : '')
              : '<span class="muted">—</span>';
          },
        },
        {
          key: 'confirmedName', label: '确认人',
          render: function (r) {
            if (!r.confirmedName) return '<span class="muted">待确认</span>';
            return ui.esc(r.confirmedName) +
              (r.confirmedRole ? '<div class="muted" style="font-size:11.5px">' + ui.esc(roleText(r.confirmedRole)) + '</div>' : '') +
              (isOn(r.confirmNameMismatch) ? ' ' + ui.flagTag('不符', 'tag-mismatch') : '');
          },
        },
        { key: 'courseName', label: '课程', render: function (r) { return ui.esc(r.courseName || '') + (r.courseCode ? '<div class="muted" style="font-size:11.5px">' + ui.esc(r.courseCode) + '</div>' : ''); } },
        { key: 'className', label: '教学班', render: function (r) { return ui.esc(r.className || ''); } },
        { key: 'deptName', label: '院系', render: function (r) { return ui.esc(r.deptName || ''); } },
        { key: 'hours', label: '应计学时', cls: 'num', render: function (r) { return ui.num(r.hours, 1); } },
        { key: 'status', label: '状态', render: function (r) { return ui.sessionStatusTag(r.status, state.source === 'sessions' ? r.statusText : ''); } },
        {
          key: 'isTempAdjusted', label: '临时调整',
          render: function (r) { return isOn(r.isTempAdjusted) ? ui.flagTag('临时调整', 'tag-temp') : '<span class="muted">—</span>'; },
        },
        {
          key: 'mismatch', label: '姓名不符',
          render: function (r) { return isOn(r.confirmNameMismatch) ? ui.flagTag('姓名不符', 'tag-mismatch') : '<span class="muted">—</span>'; },
        },
        { key: 'confirmedAt', label: '确认时间', render: function (r) { return r.confirmedAt ? ui.esc(ui.fmtDateTime(r.confirmedAt)) : '<span class="muted">—</span>'; } },
        { key: 'op', label: '操作', render: function (r) { return '<button type="button" class="btn-link" data-view="' + ui.esc(r.id) + '">查看详情</button>'; } },
      ];

      bodyEl.innerHTML = ui.tableHtml(cols, rows) + ui.pagerHtml(state.page, state.pageSize, state.total);
      ui.bindPager(bodyEl, state.page, state.pageSize, state.total, function (p, ps) {
        state.page = p; state.pageSize = ps; load();
      });
      bindRowEvents();
      el.querySelector('#btn-export').disabled = false;
      el.querySelector('#btn-export-sel').disabled = Object.keys(state.selected).length === 0;
    }

    function bindRowEvents() {
      var all = bodyEl.querySelector('[data-role="all"]');
      if (all) {
        all.checked = state.rows.length > 0 && state.rows.every(function (r) { return state.selected[r.id]; });
        all.addEventListener('change', function () {
          state.rows.forEach(function (r) { if (all.checked) state.selected[r.id] = true; else delete state.selected[r.id]; });
          draw();
        });
      }
      bodyEl.querySelectorAll('[data-row]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-row');
          if (cb.checked) state.selected[id] = true; else delete state.selected[id];
          var n = Object.keys(state.selected).length;
          var btn = el.querySelector('#btn-export-sel');
          btn.disabled = n === 0;
          btn.textContent = n ? ('批量导出选中（' + n + '）') : '批量导出选中';
        });
      });
      bodyEl.querySelectorAll('[data-view]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          openDetail(btn.getAttribute('data-view'));
        });
      });
      bodyEl.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.classList.add('clickable');
        tr.addEventListener('click', function (e) {
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
          var cb = tr.querySelector('[data-row]');
          if (cb) openDetail(cb.getAttribute('data-row'));
        });
      });
    }

    // ---------------------------------------------------------- 详情抽屉
    function openDetail(id) {
      var drawer = ui.openDrawer({
        title: '课时详情',
        subtitle: id,
        body: ui.loadingHtml('正在加载课时详情…'),
      });
      loadDetail(id).then(function (m) {
        drawer.setTitle('课时详情 · ' + (m.courseName || '') + ' ' + (m.fullDate || ''));
        drawer.body.innerHTML = detailHtml(m);
        bindDetail(drawer.body, m);
      }).catch(function (e) {
        drawer.body.innerHTML = ui.errorHtml((e && e.msg) || '加载失败');
      });
    }

    /**
     * 详情数据源：
     *  - 新流程：GET /sessions/{id}（session + course + initiator + confirmer + code + auditTail）
     *  - 旧流程 / 会话接口不可用：GET /records/{id}（兼容）
     */
    function loadDetail(id) {
      if (state.source === 'sessions') {
        return api.get('/sessions/' + encodeURIComponent(id)).then(sessionModel).catch(function (e) {
          return api.get('/records/' + encodeURIComponent(id)).then(function (r) {
            var m = recordModel(r);
            m.legacyNote = '该 ID 未命中课时会话接口，已按旧流程记录（GET /records/{id}）展示。';
            return m;
          }).catch(function () { throw e; });
        });
      }
      return api.get('/records/' + encodeURIComponent(id)).then(recordModel);
    }

    function sessionModel(d) {
      var s = (d && d.session) || {};
      var ev = s.evidence || {};
      return {
        kind: 'session',
        id: s.id || s.sessionId,
        courseName: s.courseName || '',
        courseCode: s.courseCode || '',
        className: s.className || '',
        deptName: s.deptName || '',
        teacherId: s.teacherId || '',
        teacherName: s.teacherName || '',
        teacherNo: s.teacherNo || '',
        fullDate: s.fullDate || s.teachDate || '',
        section: s.section || '',
        time: s.time || '',
        place: s.place || '',
        hours: s.hours,
        status: s.status || '',
        statusText: s.statusText || '',
        counted: s.counted,
        absentCount: s.absentCount,
        absentNames: s.absentNames || '',
        discipline: s.discipline || '',
        disciplineText: s.disciplineText || '',
        summary: s.summary || '',
        note: s.note || '',
        isTempAdjusted: isOn(s.isTempAdjusted),
        confirmNameMismatch: isOn(s.confirmNameMismatch),
        initiatorId: s.initiatorId || '',
        initiatorName: s.initiatorName || '',
        initiatorDuty: s.initiatorDuty || '',
        confirmedName: s.confirmedName || '',
        confirmedRole: s.confirmedRole || '',
        confirmedAt: s.confirmedAt || '',
        confirmDevice: s.confirmDevice || '',
        confirmIp: s.confirmIp || '',
        codeId: s.codeId || '',
        deadline: s.deadline || '',
        createdAt: s.createdAt || '',
        updatedAt: s.updatedAt || '',
        evidenceLabels: (ev.labels && ev.labels.length === 4) ? ev.labels : EVIDENCE_LABELS.slice(),
        course: d.course || null,
        initiator: d.initiator || null,
        confirmer: d.confirmer || null,
        code: d.code || null,
        auditTail: d.auditTail || [],
      };
    }

    function recordModel(r) {
      r = r || {};
      var ev = r.evidence || {};
      return {
        kind: 'record',
        id: r.id,
        courseName: r.courseName || '',
        courseCode: r.courseCode || '',
        className: r.className || '',
        deptName: r.deptName || '',
        teacherId: r.teacherId || '',
        teacherName: r.teacherName || '',
        teacherNo: r.teacherNo || '',
        fullDate: r.fullDate || r.teachDate || r.date || '',
        section: r.section || '',
        time: r.time || '',
        place: r.place || '',
        hours: r.hours,
        status: r.status || '',
        statusText: r.statusText || '',
        counted: r.counted,
        absentCount: r.absentCount,
        absentNames: r.absentNames || '',
        discipline: r.discipline || '',
        disciplineText: r.disciplineText || '',
        summary: r.summary || '',
        note: r.note || '',
        isTempAdjusted: isOn(r.isTempAdjusted),
        confirmNameMismatch: isOn(r.confirmNameMismatch),
        initiatorId: r.initiatorId || '',
        initiatorName: r.initiatorName || r.signerName || '',
        initiatorDuty: r.initiatorDuty || r.signerDuty || '',
        confirmedName: r.confirmedName || r.signerName || '',
        confirmedRole: r.confirmedRole || '',
        confirmedAt: r.confirmedAt || '',
        confirmDevice: r.device || ev.device || '',
        confirmIp: ev.ip || '',
        codeId: r.codeId || ev.codeId || '',
        deadline: r.deadline || r.deadlineAt || '',
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || '',
        evidenceLabels: EVIDENCE_LABELS.slice(),
        course: null,
        initiator: null,
        confirmer: null,
        code: null,
        auditTail: r.auditTail || [],
      };
    }

    /** 证据四项：动态码 / 确认人 / 确认时间 / 设备（不含签名图，不含定位） */
    function evidenceItems(m) {
      var labels = m.evidenceLabels || EVIDENCE_LABELS;
      var values = [
        m.codeId ? ui.esc(m.codeId) : '<span class="muted">—</span>',
        m.confirmedName
          ? ui.esc(m.confirmedName) + (m.confirmedRole ? ' <span class="muted">（' + ui.esc(roleText(m.confirmedRole)) + '）</span>' : '')
          : '<span class="muted">待确认</span>',
        m.confirmedAt ? ui.esc(ui.fmtDateTime(m.confirmedAt)) : '<span class="muted">—</span>',
        m.confirmDevice
          ? ui.esc(m.confirmDevice) + (m.confirmIp ? '<div class="muted" style="font-size:11.5px">IP ' + ui.esc(m.confirmIp) + '</div>' : '')
          : '<span class="muted">—</span>',
      ];
      return labels.map(function (label, i) {
        return '<div class="ev-item"><div class="ev-label">证据 ' + (i + 1) + ' · ' + ui.esc(label) + '</div>' +
          '<div class="ev-value">' + values[i] + '</div></div>';
      }).join('');
    }

    function detailHtml(m) {
      var mismatchAlert = m.confirmNameMismatch
        ? '<div class="alert alert-error">⚠️ <b>确认人与实际授课人不一致</b>：确认人「' + ui.esc(m.confirmedName || '—') +
          (m.confirmedRole ? '（' + ui.esc(roleText(m.confirmedRole)) + '）' : '') + '」≠ 录入的实际授课人「' + ui.esc(m.teacherName || '—') +
          '」。属代课 / 临时更换授课人情形，<b>本次课时仍然有效</b>，学时仍计入实际授课人，请据实核对。</div>'
        : '';
      var tempAlert = m.isTempAdjusted
        ? '<div class="alert alert-warn">本次课时与课程清单 / 课表不一致，已标记为 <b>临时调整</b>（换授课人 / 改时间 / 改地点）。新流程无需审批，仅作留痕与统计提醒。</div>'
        : '';
      var legacyNote = m.legacyNote ? ui.alertHtml(m.legacyNote, 'info') : '';
      var legacySig = m.kind === 'record'
        ? '<div class="help-text">该记录来自<b>旧流程</b>（教师发起 → 班干部签名）。新流程已取消手写签名，本后台不再读取或渲染签名图，' +
          '仅按证据四项（动态码 / 确认人 / 确认时间 / 设备）展示。</div>'
        : '';

      var teacherValue = ui.esc(m.teacherName || '—') +
        (m.teacherNo ? '（工号 ' + ui.esc(m.teacherNo) + '）' : '') +
        (!m.teacherId ? ' ' + ui.flagTag('非系统内教师', 'tag-reg') : '');

      return mismatchAlert + tempAlert + legacyNote +
        '<div class="section"><h4>授课信息</h4><dl class="kv">' +
        '<dt>课程</dt><dd>' + ui.esc(m.courseName || '—') + (m.courseCode ? '（' + ui.esc(m.courseCode) + '）' : '') + '</dd>' +
        '<dt>实际授课人</dt><dd>' + teacherValue + '</dd>' +
        '<dt>教学班</dt><dd>' + ui.esc(m.className || '—') + '</dd>' +
        '<dt>院系</dt><dd>' + ui.esc(m.deptName || '—') + '</dd>' +
        '<dt>上课日期</dt><dd>' + ui.esc(m.fullDate || '—') + '</dd>' +
        '<dt>节次</dt><dd>' + ui.esc(m.section || '—') + (m.time ? '（' + ui.esc(m.time) + '）' : '') + '</dd>' +
        '<dt>地点</dt><dd>' + ui.esc(m.place || '—') + '</dd>' +
        '<dt>应计学时</dt><dd>' + ui.num(m.hours, 1) + ' 学时</dd>' +
        '<dt>缺勤</dt><dd>' + Number(m.absentCount || 0) + ' 人' + (m.absentNames ? '：' + ui.esc(m.absentNames) : '') + '</dd>' +
        '<dt>课堂纪律</dt><dd>' + ui.esc(m.disciplineText || '—') + '</dd>' +
        '<dt>授课摘要</dt><dd>' + (m.summary ? ui.esc(m.summary) : '<span class="muted">—</span>') + '</dd>' +
        '<dt>备注</dt><dd>' + (m.note ? ui.esc(m.note) : '<span class="muted">—</span>') + '</dd>' +
        '<dt>当前状态</dt><dd>' + ui.sessionStatusTag(m.status, m.statusText) +
        (m.counted ? ' <span class="tag tag-ok">计入正式学时</span>' : ' <span class="muted">不计入正式学时</span>') +
        (m.isTempAdjusted ? ' ' + ui.flagTag('临时调整', 'tag-temp') : '') +
        (m.confirmNameMismatch ? ' ' + ui.flagTag('姓名不符', 'tag-mismatch') : '') + '</dd>' +
        '</dl></div>' +

        '<div class="section"><h4>证据四项 <span class="hint">动态码 / 确认人 / 确认时间 / 设备 · 无手写签名图、无定位</span></h4>' +
        '<div class="evidence-grid">' + evidenceItems(m) + '</div>' + legacySig + '</div>' +

        (m.kind === 'session'
          ? '<div class="section"><h4>课程清单快照 <span class="hint">发起时从课程清单带出的信息</span></h4>' +
            (m.course ? '<dl class="kv">' +
              '<dt>课程名称</dt><dd>' + ui.esc(m.course.courseName || '—') + '</dd>' +
              '<dt>授课老师</dt><dd>' + ui.esc(m.course.teacherName || '—') + (m.course.teacherNo ? '（工号 ' + ui.esc(m.course.teacherNo) + '）' : '') + '</dd>' +
              '<dt>教学班</dt><dd>' + ui.esc(m.course.className || '—') + '</dd>' +
              '<dt>星期/节次</dt><dd>' + ui.esc(m.course.weekdayText || '未排课') + ' ' + ui.esc(m.course.section || '') + (m.course.time ? '（' + ui.esc(m.course.time) + '）' : '') + '</dd>' +
              '<dt>地点</dt><dd>' + ui.esc(m.course.place || '—') + '</dd>' +
              '<dt>学时</dt><dd>' + ui.num(m.course.hours, 1) + ' 学时</dd>' +
              '<dt>学期</dt><dd>' + ui.esc(m.course.term || '—') + '</dd>' +
              '<dt>清单状态</dt><dd>' + ui.esc(m.course.statusText || m.course.status || '—') + '</dd>' +
              '<dt>创建人</dt><dd>' + ui.esc(m.course.createdByName || '—') + ' · ' + ui.esc(ui.fmtDateTime(m.course.createdAt)) + '</dd>' +
              '</dl>' : '<div class="muted">该课时未关联课程清单（未传 courseId，或课程清单已被归档）</div>') + '</div>'
          : '') +

        '<div class="section"><h4>发起人（学委）</h4>' +
        (m.initiatorName
          ? '<dl class="kv">' +
            '<dt>姓名</dt><dd>' + ui.esc(m.initiatorName) + '</dd>' +
            '<dt>职务</dt><dd>' + ui.esc(m.initiatorDuty || (m.initiator && m.initiator.duty) || '—') + '</dd>' +
            '<dt>学号</dt><dd>' + ui.esc((m.initiator && m.initiator.no) || m.initiatorId || '—') + '</dd>' +
            '<dt>教学班</dt><dd>' + ui.esc((m.initiator && m.initiator.className) || m.className || '—') + '</dd>' +
            '</dl>'
          : '<div class="muted">无发起人信息（旧流程记录由教师发起）</div>') + '</div>' +

        '<div class="section"><h4>确认信息</h4>' +
        (m.confirmedName
          ? '<dl class="kv">' +
            '<dt>确认人</dt><dd>' + ui.esc(m.confirmedName) + (m.confirmedRole ? '（' + ui.esc(roleText(m.confirmedRole)) + '）' : '') +
            (m.confirmNameMismatch ? ' ' + ui.flagTag('与实际授课人不符', 'tag-mismatch') : ' <span class="tag tag-ok">与实际授课人一致</span>') + '</dd>' +
            '<dt>确认时间</dt><dd>' + ui.esc(ui.fmtDateTime(m.confirmedAt) || '—') + '</dd>' +
            '<dt>设备</dt><dd>' + ui.esc(m.confirmDevice || '—') + '</dd>' +
            '<dt>IP</dt><dd>' + ui.esc(m.confirmIp || '—') + '</dd>' +
            '</dl>'
          : '<div class="muted">尚未确认（等待任课教师扫码后点「确认」）</div>') + '</div>' +

        '<div class="section"><h4>动态码</h4>' +
        '<dl class="kv">' +
        '<dt>动态码 ID</dt><dd>' + ui.esc(m.codeId || '—') + '</dd>' +
        (m.code
          ? '<dt>有效期至</dt><dd>' + ui.esc(ui.fmtDateTime(m.code.expireAt) || '—') + '</dd>' +
            '<dt>是否已消费</dt><dd>' + (m.code.used ? '<span class="tag tag-done">已消费（一次性）</span>' : '<span class="tag tag-wait">未消费</span>') + '</dd>' +
            '<dt>消费时间</dt><dd>' + ui.esc(ui.fmtDateTime(m.code.usedAt) || '—') + '</dd>' +
            '<dt>消费人</dt><dd>' + ui.esc(m.code.usedBy || '—') + '</dd>'
          : '') +
        (m.deadline ? '<dt>确认截止</dt><dd>' + ui.esc(ui.fmtDateTime(m.deadline)) + ' <span class="muted">（当天 24 点前未确认自动置为已过期；补录历史课时不设时限）</span></dd>' : '') +
        '</dl></div>' +

        '<div class="section"><h4>状态流转</h4><ul class="timeline" id="tl-slot">' + timelineHtml(m) + '</ul></div>' +
        '<div class="section"><h4>该课时操作日志 <span class="hint">哈希链留痕，不可编辑</span></h4>' +
        '<div class="log-list" id="log-slot">' + ui.loadingHtml('加载中…') + '</div></div>';
    }

    function timelineHtml(m) {
      var items = [];
      if (m.createdAt) {
        items.push({
          time: m.createdAt, hl: true,
          title: m.kind === 'session' ? '班干部发起课时并签发动态码' : '教师发起课时确认（旧流程）',
          desc: '发起人：' + (m.initiatorName || '—') + (m.initiatorDuty ? '（' + m.initiatorDuty + '）' : '') +
            (m.statusText ? ' · 状态：' + m.statusText : ''),
        });
      }
      if (m.isTempAdjusted) {
        items.push({
          time: m.createdAt, title: '标记为「临时调整」',
          desc: '与课程清单 / 课表不一致（换授课人、改时间或改地点），新流程无需审批，仅留痕',
        });
      }
      if (m.confirmedAt) {
        items.push({
          time: m.confirmedAt, hl: true,
          title: '任课教师扫码确认（状态 → ' + (m.statusText || ui.sessionStatusText(m.status)) + '）',
          desc: '确认人：' + (m.confirmedName || '—') + (m.confirmedRole ? '（' + roleText(m.confirmedRole) + '）' : '') +
            (m.confirmNameMismatch ? ' · 与实际授课人不一致（已标记）' : ''),
        });
      }
      if (m.deadline) {
        items.push({ time: m.deadline, title: '确认截止时间', desc: '超过该时间未确认将自动置为已过期' });
      }
      if (m.updatedAt && m.updatedAt !== m.confirmedAt) {
        items.push({ time: m.updatedAt, title: '最近一次更新', desc: '状态：' + (m.statusText || ui.sessionStatusText(m.status)) });
      }
      if (!items.length) return '<li><span class="t-desc">暂无流转记录</span></li>';
      items.sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });
      return items.map(function (it) {
        return '<li' + (it.hl ? ' class="hl"' : '') + '>' +
          '<div class="t-time">' + ui.esc(ui.fmtDateTime(it.time)) + '</div>' +
          '<div class="t-title">' + ui.esc(it.title) + '</div>' +
          (it.desc ? '<div class="t-desc">' + ui.esc(it.desc) + '</div>' : '') +
          '</li>';
      }).join('');
    }

    function bindDetail(root, m) {
      var logSlot = root.querySelector('#log-slot');
      api.get('/logs', { targetId: m.id, pageSize: 50 }).then(function (d) {
        logSlot.innerHTML = logListHtml((d && d.list) || []);
      }).catch(function () {
        logSlot.innerHTML = logListHtml((m.auditTail || []).map(function (x) {
          return { createdAt: x.at, actorName: x.actor, action: x.action, detail: x.detail };
        }));
      });
    }

    function logListHtml(list) {
      if (!list.length) return '<div class="muted">暂无操作日志</div>';
      return list.map(function (l) {
        return '<div class="log-item">' +
          '<div>' + ui.esc(ui.fmtDateTime(l.createdAt || l.at)) + ' · <b>' + ui.esc(actionText(l.action)) + '</b> ' +
          '<span class="log-meta">' + ui.esc(l.actorName || l.actor || '') + (l.actorRole ? '（' + ui.esc(roleText(l.actorRole)) + '）' : '') + '</span></div>' +
          (l.detail ? '<div class="log-meta">' + ui.esc(l.detail) + '</div>' : '') +
          ((l.ip || l.device) ? '<div class="log-meta">' + (l.ip ? 'IP ' + ui.esc(l.ip) : '') + (l.device ? ' · ' + ui.esc(l.device) : '') + '</div>' : '') +
          '</div>';
      }).join('');
    }

    // ---------------------------------------------------------- 导出
    function doExport(selectedOnly) {
      syncFilters();
      var q = {
        term: f.term,
        from: f.from,
        to: f.to,
        deptId: f.deptId,
        status: f.statuses.join(','),
        courseName: f.courseName,
      };
      var tid = resolveTeacherId(f.teacherName);
      if (tid) q.teacherId = tid;
      var n = Object.keys(state.selected).length;
      var base = selectedOnly
        ? '后端导出接口按<b>筛选条件</b>生成报表（不支持按记录 ID 导出）。当前勾选 <b>' + n + '</b> 条，' +
          '将导出符合当前筛选条件的全部 <b>' + state.total + '</b> 条记录，请知悉。'
        : '将按当前筛选条件导出全部 <b>' + state.total + '</b> 条课时明细（CSV，Excel 可直接打开）。';
      var limits = [];
      if (f.temp) limits.push('「是否临时调整」');
      if (f.mismatch) limits.push('「姓名不符」');
      if (f.teacherName && !tid) limits.push('「实际授课人姓名」');
      var extra = limits.length
        ? '<div class="alert alert-warn" style="margin:8px 0 0">后端导出接口暂不支持 ' + limits.join('、') +
          ' 作为导出条件，导出文件将包含更宽范围的记录；如需精确结果，请先用列表筛选核对。</div>'
        : '';
      ui.confirm({
        title: '导出课时明细',
        html: base + extra + '<div class="help-text">' + EXPORT_HEADER_HINT + '；不含签名图 URL 列。</div>',
        okText: '开始导出',
      }).then(function (ok) {
        if (!ok) return;
        q.format = 'csv';
        api.post('/export/records', q).then(function (job) {
          ui.toast('导出任务已创建：' + job.jobId, 'ok');
          return A.jobs.waitExport(job.jobId).then(function (done) {
            if (!done || done.status !== 'done') { ui.toast('导出失败：' + ((done && done.status) || 'unknown'), 'error'); return; }
            return api.download('/files/' + encodeURIComponent(done.fileName), null, done.fileName)
              .then(function () { ui.toast('已开始下载：' + done.fileName + '（' + done.successRows + ' 行）', 'ok'); });
          });
        }).catch(function (e) { ui.toast((e && e.msg) || '导出失败', 'error'); });
      });
    }
  }

  A.registerPage('records', { title: '课时明细', render: render });
})(window.Admin);
