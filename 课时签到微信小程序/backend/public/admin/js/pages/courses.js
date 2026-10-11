'use strict';
/**
 * 课程清单（P1，业务流程简化第一步）—— 班干部（学委）录入一次、长期保留
 *
 *   GET    /class-courses?classId=&keyword=&status=&page=&pageSize=   列表（班级/关键词/状态筛选）
 *   PUT    /class-courses/{id}                                        部分字段更新（不可改教学班）
 *   DELETE /class-courses/{id}                                        归档（软删除 → status='archived'）
 *
 * 说明：后端未提供「教学班列表」接口，新增入口需要选择教学班（classId），
 *      因此本页不提供新增（POST /class-courses）——课程清单由班干部在小程序端录入，
 *      或在「数据导入中心」批量导入；本页只读为主 + 基础编辑（改 / 归档）。
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var WEEKDAY_OPTIONS = [
    { value: '', label: '未排课' },
    { value: '1', label: '周一' }, { value: '2', label: '周二' }, { value: '3', label: '周三' },
    { value: '4', label: '周四' }, { value: '5', label: '周五' }, { value: '6', label: '周六' },
    { value: '7', label: '周日' },
  ];

  function render(ctx) {
    var el = ctx.el;
    var state = {
      page: 1,
      pageSize: 20,
      total: 0,
      rows: [],
      summary: null,
      classes: [],
    };
    var f = {
      classId: ctx.params.classId || '',
      keyword: ctx.params.keyword || '',
      status: ctx.params.status || '',
    };

    el.innerHTML =
      '<div class="page-title"><h2>课程清单</h2>' +
      '<span class="desc">班干部（学委）录入一次、长期保留；每次上课从清单带出信息，允许临时调整（无需审批）。' +
      '本页只读为主，支持编辑与归档</span></div>' +
      '<div class="panel"><div class="panel-body" id="c-filters">' + ui.loadingHtml('正在加载筛选项…') + '</div></div>' +
      '<div class="panel">' +
      '<div class="panel-head"><h3>清单列表</h3><span class="sub" id="c-sub"></span>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="c-refresh">刷新</button></div></div>' +
      '<div class="panel-body" style="padding-bottom:0" id="c-strip"></div>' +
      '<div id="c-list">' + ui.loadingHtml('正在加载课程清单…') + '</div>' +
      '</div>';

    var listEl = el.querySelector('#c-list');
    var filterEl = el.querySelector('#c-filters');
    var stripEl = el.querySelector('#c-strip');

    // 首次加载：取一页较大数据用于构建「班级」下拉（后端无私用班级列表接口）
    api.get('/class-courses', { status: 'all', page: 1, pageSize: 200 }).then(function (d) {
      state.classes = buildClasses((d && d.list) || []);
      filterEl.innerHTML = filterBarHtml();
      bindFilters();
      load();
    }).catch(function (e) {
      listEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), function () { ctx.refresh(); });
    });

    el.querySelector('#c-refresh').addEventListener('click', function () { load(); });

    function buildClasses(list) {
      var seen = {};
      var out = [];
      list.forEach(function (r) {
        var id = String(r.classId || '');
        if (!id || seen[id]) return;
        seen[id] = true;
        out.push({ id: id, name: r.className || id });
      });
      out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      return out;
    }

    // ---------------------------------------------------------- 筛选区
    function filterBarHtml() {
      var classOpts = '<option value="">全部班级</option>' + state.classes.map(function (c) {
        return '<option value="' + ui.esc(c.id) + '"' + (String(c.id) === String(f.classId) ? ' selected' : '') + '>' + ui.esc(c.name) + '</option>';
      }).join('');
      var statusOpts = [
        { value: '', label: '使用中（默认）' },
        { value: 'active', label: '仅使用中' },
        { value: 'archived', label: '仅已归档' },
        { value: 'all', label: '全部状态' },
      ].map(function (o) {
        return '<option value="' + o.value + '"' + (String(o.value) === String(f.status) ? ' selected' : '') + '>' + ui.esc(o.label) + '</option>';
      }).join('');
      return '<div class="filters">' +
        '<div class="f"><label>班级</label><select id="c-class">' + classOpts + '</select>' +
        '<div class="help-text">选项来自清单中已出现过的教学班</div></div>' +
        '<div class="f"><label>关键词（课程 / 授课老师 / 地点 / 班级）</label>' +
        '<input type="text" id="c-keyword" placeholder="输入关键词模糊匹配" value="' + ui.esc(f.keyword) + '"></div>' +
        '<div class="f"><label>状态</label><select id="c-status">' + statusOpts + '</select></div>' +
        '<div class="f-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="c-reset">重置</button>' +
        '<button type="button" class="btn" id="c-search">查询</button>' +
        '</div>' +
        '</div>';
    }

    function syncFilters() {
      f.classId = filterEl.querySelector('#c-class').value;
      f.keyword = filterEl.querySelector('#c-keyword').value.trim();
      f.status = filterEl.querySelector('#c-status').value;
    }

    function bindFilters() {
      filterEl.querySelector('#c-search').addEventListener('click', function () { syncFilters(); state.page = 1; load(); });
      filterEl.querySelector('#c-reset').addEventListener('click', function () {
        f = { classId: '', keyword: '', status: '' };
        state.page = 1;
        filterEl.innerHTML = filterBarHtml();
        bindFilters();
        load();
      });
      filterEl.querySelector('#c-status').addEventListener('change', function () { syncFilters(); state.page = 1; load(); });
      filterEl.querySelector('#c-class').addEventListener('change', function () { syncFilters(); state.page = 1; load(); });
      filterEl.querySelector('#c-keyword').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); syncFilters(); state.page = 1; load(); }
      });
    }

    // ---------------------------------------------------------- 列表
    function load() {
      var q = {
        classId: f.classId,
        keyword: f.keyword,
        status: f.status || 'active', // 后端 status 为空时默认 active，这里显式传递
        page: state.page,
        pageSize: state.pageSize,
      };
      listEl.innerHTML = ui.loadingHtml('正在加载课程清单…');
      api.get('/class-courses', q).then(function (d) {
        state.rows = (d && d.list) || [];
        state.total = (d && d.total) || 0;
        state.summary = (d && d.summary) || null;
        state.page = (d && d.page) || 1;
        state.pageSize = (d && d.pageSize) || 20;
        // 班级下拉补齐（新出现的教学班）
        var merged = state.classes.slice();
        buildClasses(state.rows).forEach(function (c) {
          if (!merged.some(function (x) { return String(x.id) === String(c.id); })) merged.push(c);
        });
        if (merged.length !== state.classes.length) {
          state.classes = merged.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
          filterEl.innerHTML = filterBarHtml();
          bindFilters();
        }
        draw();
      }).catch(function (e) {
        stripEl.innerHTML = '';
        listEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    function draw() {
      var sum = state.summary || {};
      var sub = el.querySelector('#c-sub');
      sub.innerHTML = '共 <b>' + state.total + '</b> 条';
      stripEl.innerHTML = '<div class="stat-strip">' +
        '<div class="stat-pill">筛选范围内总数<b>' + (sum.total === undefined ? state.total : sum.total) + '</b></div>' +
        '<div class="stat-pill ok">使用中<b>' + (sum.active === undefined ? '—' : sum.active) + '</b></div>' +
        '<div class="stat-pill">已归档<b>' + (sum.archived === undefined ? '—' : sum.archived) + '</b></div>' +
        '<div class="stat-pill">本页 <b>' + state.rows.length + '</b></div>' +
        '</div>';

      if (!state.rows.length) {
        var filtered = !!(f.classId || f.keyword || (f.status && f.status !== 'active'));
        listEl.innerHTML = ui.emptyHtml({
          icon: '📚',
          title: filtered ? '没有符合条件的课程清单' : '还没有课程清单',
          hint: filtered
            ? '可切换班级 / 状态，或清空关键词后重试'
            : '班干部（学委）在小程序端录入一次课程清单后长期保留；每次上课从清单带出信息并出示动态码',
          actions: filtered
            ? [{ label: '重置筛选', primary: true, onClick: function () { filterEl.querySelector('#c-reset').click(); } }]
            : [
              { label: '查看课时明细', primary: true, onClick: function () { ctx.navigate('records'); } },
              { label: '去导入中心', onClick: function () { ctx.navigate('import'); } },
            ],
        });
        return;
      }

      var cols = [
        {
          key: 'courseName', label: '课程名称',
          render: function (r) {
            return ui.esc(r.courseName);
          },
        },
        {
          key: 'teacherName', label: '授课老师',
          render: function (r) {
            return ui.esc(r.teacherName) +
              (r.teacherNo ? '<div class="muted" style="font-size:11.5px">工号 ' + ui.esc(r.teacherNo) + '</div>' : '');
          },
        },
        { key: 'className', label: '教学班', render: function (r) { return ui.esc(r.className || '—'); } },
        {
          key: 'weekday', label: '星期 / 节次',
          render: function (r) {
            return (r.weekdayText ? ui.esc(r.weekdayText) : '<span class="muted">未排课</span>') +
              (r.section ? '<div class="muted" style="font-size:11.5px">第 ' + ui.esc(r.section) + ' 节' + (r.time ? ' ' + ui.esc(r.time) : '') + '</div>' : '');
          },
        },
        { key: 'place', label: '地点', render: function (r) { return r.place ? ui.esc(r.place) : '<span class="muted">—</span>'; } },
        { key: 'hours', label: '学时', cls: 'num', render: function (r) { return ui.num(r.hours, 1); } },
        { key: 'term', label: '学期', render: function (r) { return ui.esc(r.term || '—'); } },
        {
          key: 'status', label: '状态',
          render: function (r) {
            return r.archived
              ? '<span class="tag tag-revoked">已归档</span>'
              : '<span class="tag tag-done">使用中</span>';
          },
        },
        {
          key: 'createdByName', label: '创建人',
          render: function (r) {
            return ui.esc(r.createdByName || '—') +
              (r.createdAt ? '<div class="muted" style="font-size:11.5px">' + ui.esc(ui.fmtDateTime(r.createdAt)) + '</div>' : '');
          },
        },
        {
          key: 'updatedAt', label: '更新时间',
          render: function (r) { return r.updatedAt ? ui.esc(ui.fmtDateTime(r.updatedAt)) : '<span class="muted">—</span>'; },
        },
        {
          key: 'op', label: '操作',
          render: function (r) {
            var edit = r.archived
              ? '<button type="button" class="btn-link" disabled title="已归档课程不可修改">编辑</button>'
              : '<button type="button" class="btn-link" data-edit="' + ui.esc(r.id) + '">编辑</button>';
            var archive = r.archived
              ? '<button type="button" class="btn-link" disabled title="已归档">已归档</button>'
              : '<button type="button" class="btn-link danger" data-archive="' + ui.esc(r.id) + '">归档</button>';
            var detail = '<button type="button" class="btn-link" data-records="' + ui.esc(r.courseName) + '">课时明细</button>';
            return edit + ' ' + archive + ' ' + detail;
          },
        },
      ];

      listEl.innerHTML = ui.tableHtml(cols, state.rows) + ui.pagerHtml(state.page, state.pageSize, state.total);
      ui.bindPager(listEl, state.page, state.pageSize, state.total, function (p, ps) {
        state.page = p; state.pageSize = ps; load();
      });

      listEl.querySelectorAll('[data-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () { openEdit(btn.getAttribute('data-edit')); });
      });
      listEl.querySelectorAll('[data-archive]').forEach(function (btn) {
        btn.addEventListener('click', function () { doArchive(btn.getAttribute('data-archive')); });
      });
      listEl.querySelectorAll('[data-records]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ctx.navigate('records', { courseName: btn.getAttribute('data-records') });
        });
      });
    }

    function rowById(id) {
      return state.rows.filter(function (r) { return String(r.id) === String(id); })[0] || null;
    }

    // ---------------------------------------------------------- 编辑（PUT）
    function openEdit(id) {
      var r = rowById(id);
      if (!r) return;
      ui.promptForm({
        title: '编辑课程清单',
        hint: '教学班不可修改（' + (r.className || r.classId || '—') + '）；如需换班请归档后重新录入。字段留空表示按后端默认值处理。',
        wide: true,
        okText: '保存',
        fields: [
          { name: 'courseName', label: '课程名称', value: r.courseName, required: true, hint: '必填，≤60 字符，过敏感词校验' },
          { name: 'teacherName', label: '授课老师', value: r.teacherName, required: true, hint: '必填，≤30 字符，过敏感词校验' },
          { name: 'teacherNo', label: '工号', value: r.teacherNo, hint: '可空；填写后便于按工号匹配实际授课人' },
          { name: 'weekday', label: '星期', type: 'select', value: r.weekday === null || r.weekday === undefined ? '' : String(r.weekday), options: WEEKDAY_OPTIONS },
          { name: 'section', label: '节次', value: r.section, placeholder: '如 1-2' },
          { name: 'place', label: '上课地点', value: r.place, hint: '≤60 字符' },
          { name: 'hours', label: '学时', value: String(r.hours === undefined ? '' : r.hours), hint: '0–100，默认 2' },
          { name: 'term', label: '学期', value: r.term },
        ],
      }).then(function (v) {
        if (!v) return;
        var hours = String(v.hours).trim();
        if (hours !== '' && (!isFinite(Number(hours)) || Number(hours) < 0 || Number(hours) > 100)) {
          ui.toast('学时应为 0–100 之间的数字', 'error');
          return;
        }
        api.put('/class-courses/' + encodeURIComponent(id), {
          courseName: v.courseName,
          teacherName: v.teacherName,
          teacherNo: v.teacherNo,
          weekday: v.weekday === '' ? '' : Number(v.weekday),
          section: v.section,
          place: v.place,
          hours: hours === '' ? '' : Number(hours),
          term: v.term,
        }).then(function () {
          ui.toast('课程清单已更新：' + v.courseName, 'ok');
          load();
        }).catch(function (e) {
          ui.toast((e && e.msg) || '保存失败', 'error');
        });
      });
    }

    // ---------------------------------------------------------- 归档（DELETE）
    function doArchive(id) {
      var r = rowById(id);
      if (!r) return;
      ui.confirm({
        title: '归档课程清单',
        danger: true,
        html: '确认归档「<b>' + ui.esc(r.courseName) + '</b>」（' + ui.esc(r.className || '') + '）？<br>' +
          '归档为<b>软删除</b>：记录保留可追溯，状态变为「已归档」，归档后不可修改，也不会再出现在小程序发起页的课程清单中。',
        okText: '确认归档',
      }).then(function (ok) {
        if (!ok) return;
        api.del('/class-courses/' + encodeURIComponent(id)).then(function () {
          ui.toast('已归档：' + r.courseName, 'ok');
          load();
        }).catch(function (e) {
          ui.toast((e && e.msg) || '归档失败', 'error');
        });
      });
    }
  }

  A.registerPage('courses', { title: '课程清单', render: render });
})(window.Admin);
