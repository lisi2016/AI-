'use strict';
/**
 * 首页 · 学时统计看板（P0★）
 * 统计口径：学时按**实际授课人**归属（teacher_name，有 teacher_id 优先用 id；含非系统内教师）；
 *          仅 status IN (done, makeup) 计入正式学时，补签单独标注。
 * 业务流程简化后新增：临时调整数 / 姓名不符数 / 课时会话数（班干部发起 → 教师确认）。
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  // 最近一次筛选结果缓存（导出本页报表时复用）
  var lastQuery = {};

  function filterBarHtml(terms, depts, cur) {
    var termOpts = '<option value="">全部学期</option>' + terms.map(function (t) {
      return '<option value="' + ui.esc(t) + '"' + (String(t) === String(cur.term) ? ' selected' : '') + '>' + ui.esc(t) + '</option>';
    }).join('');
    var deptOpts = '<option value="">全部院系</option>' + depts.map(function (d) {
      return '<option value="' + ui.esc(d.id) + '"' + (String(d.id) === String(cur.deptId) ? ' selected' : '') + '>' + ui.esc(d.name) + '</option>';
    }).join('');
    var statusOpts = '<option value="">全部状态</option>' + ui.STATUS_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (s === cur.status ? ' selected' : '') + '>' + ui.statusText(s) + '</option>';
    }).join('');
    return '' +
      '<div class="filters">' +
      '<div class="f"><label>学期</label><select id="f-term">' + termOpts + '</select></div>' +
      '<div class="f"><label>开始日期</label><input type="date" id="f-from" value="' + ui.esc(cur.from || '') + '"></div>' +
      '<div class="f"><label>结束日期</label><input type="date" id="f-to" value="' + ui.esc(cur.to || '') + '"></div>' +
      '<div class="f"><label>院系</label><select id="f-dept">' + deptOpts + '</select></div>' +
      '<div class="f"><label>状态（用于明细联动）</label><select id="f-status">' + statusOpts + '</select></div>' +
      '<div class="f-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-quick="7">近 7 天</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-quick="30">近 30 天</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-quick="week">本周</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-quick="clear">清空日期</button>' +
      '<button type="button" class="btn" id="f-search">查询</button>' +
      '</div>' +
      '</div>';
  }

  function cardsHtml(ov) {
    return '<div class="cards">' +
      '<div class="card c-primary">' +
      '<div class="card-label">已确认学时 <span class="tag tag-done">含补签</span></div>' +
      '<div class="card-value">' + ui.num(ov.confirmedHours, 1) + '<span class="unit">学时</span></div>' +
      '<div class="card-foot">应计 ' + ui.num(ov.expectedHours, 1) + ' 学时 · 完成率 ' + ui.num(ov.completionRate, 1) + '%' +
      (ov.makeupHours ? ' · 其中补签 ' + ui.num(ov.makeupHours, 1) + ' 学时' : '') + '</div>' +
      '</div>' +
      '<div class="card c-warn">' +
      '<div class="card-label">待教师确认</div>' +
      '<div class="card-value">' + ov.waiting + '<span class="unit">条</span></div>' +
      '<div class="card-foot">班干部出示动态码后等待任课教师扫码确认</div>' +
      '</div>' +
      '<div class="card c-danger">' +
      '<div class="card-label">已过期条数</div>' +
      '<div class="card-value">' + ov.expired + '<span class="unit">条</span></div>' +
      '<div class="card-foot">超当天 24 点未确认自动置为已过期（补录历史课时不设时限）</div>' +
      '</div>' +
      '<div class="card c-info">' +
      '<div class="card-label">异常记录（过期+拒绝+申诉中）</div>' +
      '<div class="card-value">' + ov.abnormal + '<span class="unit">条</span></div>' +
      '<div class="card-foot">旧流程遗留「现场指定签字人」' + ov.adhocCount + ' 条</div>' +
      '</div>' +
      '</div>' +
      // 业务流程简化后新增口径
      '<div class="cards">' +
      '<div class="card c-warn">' +
      '<div class="card-label">临时调整 <span class="tag tag-temp">无需审批</span></div>' +
      '<div class="card-value">' + (ov.tempAdjustedCount || 0) + '<span class="unit">次</span></div>' +
      '<div class="card-foot">与课程清单 / 课表不一致（换授课人、改时间或改地点），仅留痕提醒</div>' +
      '</div>' +
      '<div class="card c-danger">' +
      '<div class="card-label">姓名不符 <span class="tag tag-mismatch">代课</span></div>' +
      '<div class="card-value">' + (ov.nameMismatchCount || 0) + '<span class="unit">条</span></div>' +
      '<div class="card-foot">确认人姓名 ≠ 实际授课人，课时仍然有效，需据实核对' +
      '<button type="button" class="btn-link" data-mismatch="1">查看 →</button></div>' +
      '</div>' +
      '<div class="card c-primary">' +
      '<div class="card-label">课时会话（班干部发起）</div>' +
      '<div class="card-value">' + (ov.sessionCount || 0) + '<span class="unit">条</span></div>' +
      '<div class="card-foot">其中已确认 ' + (ov.sessionDoneCount || 0) + ' 条' +
      '<button type="button" class="btn-link" data-goto-records="1">查看明细 →</button></div>' +
      '</div>' +
      '<div class="card c-info">' +
      '<div class="card-label">学时归属口径</div>' +
      '<div class="card-value" style="font-size:20px">实际授课人</div>' +
      '<div class="card-foot">本院系统内教师 + 班干部手填的非系统内教师均单独成行，不丢学时</div>' +
      '</div>' +
      '</div>';
  }

  function barRowsHtml(list) {
    var items = list.map(function (d) {
      return {
        label: d.name,
        value: d.confirmedHours || d.hours || 0,
        title: d.name + '：已确认 ' + ui.num(d.confirmedHours, 1) + ' 学时 / 完成率 ' + ui.num(d.completionRate, 1) + '%',
        right: ui.num(d.confirmedHours, 1) + ' 学时',
      };
    });
    return ui.barListHtml(items, { emptyTitle: '所选范围内暂无院系学时数据', emptyHint: '请先导入课表，或调整筛选条件' });
  }

  function render(ctx) {
    var el = ctx.el;
    var cur = {
      term: ctx.params.term !== undefined ? ctx.params.term : '',
      from: ctx.params.from || '',
      to: ctx.params.to || '',
      deptId: ctx.params.deptId || '',
      status: ctx.params.status || '',
    };
    var trendGran = 'week';
    var deptList = [];
    var rank = [];

    el.innerHTML =
      '<div class="page-title"><h2>学时统计看板</h2>' +
      '<span class="desc">口径：学时按<b>实际授课人</b>归属（含班干部手填的非系统内教师）；仅「已确认 / 已补签」计入正式学时；' +
      '合班课程按授课任务去重，不重复累加</span></div>' +
      '<div class="panel"><div class="panel-body" id="f-wrap">' + ui.loadingHtml('正在加载筛选项…') + '</div></div>' +
      '<div id="dash-body">' + ui.loadingHtml('正在加载统计数据…') + '</div>';

    var bodyEl = el.querySelector('#dash-body');

    A.data.loadDepts().then(function (depts) {
      deptList = depts || [];
      return A.data.loadTerms();
    }).then(function (terms) {
      el.querySelector('#f-wrap').innerHTML = filterBarHtml(terms || [], deptList, cur);
      bindFilters();
      loadAll();
    }).catch(function (e) {
      bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), function () { ctx.refresh(); });
    });

    function currentQuery() {
      return {
        term: cur.term,
        from: cur.from,
        to: cur.to,
        deptId: cur.deptId,
        status: cur.status,
      };
    }

    function bindFilters() {
      var wrap = el.querySelector('#f-wrap');
      function sync() {
        cur.term = wrap.querySelector('#f-term').value;
        cur.from = wrap.querySelector('#f-from').value;
        cur.to = wrap.querySelector('#f-to').value;
        cur.deptId = wrap.querySelector('#f-dept').value;
        cur.status = wrap.querySelector('#f-status').value;
      }
      wrap.querySelector('#f-search').addEventListener('click', function () { sync(); loadAll(); });
      ['#f-term', '#f-dept', '#f-status'].forEach(function (sel) {
        wrap.querySelector(sel).addEventListener('change', function () { sync(); loadAll(); });
      });
      ['#f-from', '#f-to'].forEach(function (sel) {
        wrap.querySelector(sel).addEventListener('change', function () { sync(); loadAll(); });
      });
      wrap.querySelectorAll('[data-quick]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var q = btn.getAttribute('data-quick');
          if (q === 'clear') { cur.from = ''; cur.to = ''; }
          else if (q === 'week') {
            var t = ui.todayStr();
            var w = new Date(t + 'T00:00:00Z').getUTCDay() || 7;
            cur.from = ui.addDaysStr(t, -(w - 1));
            cur.to = t;
          } else {
            cur.to = ui.todayStr();
            cur.from = ui.addDaysStr(cur.to, -(Number(q) - 1));
          }
          wrap.querySelector('#f-from').value = cur.from;
          wrap.querySelector('#f-to').value = cur.to;
          loadAll();
        });
      });
    }

    function loadAll() {
      lastQuery = currentQuery();
      bodyEl.innerHTML = ui.loadingHtml('正在加载统计数据…');
      var q = lastQuery;
      var statsQuery = { term: q.term, from: q.from, to: q.to, deptId: q.deptId };

      Promise.all([
        api.get('/stats/overview', statsQuery),
        api.get('/stats/by-dept', { term: q.term, from: q.from, to: q.to, deptId: q.deptId }),
        api.get('/stats/trend', { term: q.term, from: q.from, to: q.to, deptId: q.deptId, granularity: trendGran }),
        api.get('/stats/by-teacher', { term: q.term, from: q.from, to: q.to, deptId: q.deptId, page: 1, pageSize: 20 }),
        api.get('/records', { term: q.term, from: q.from, to: q.to, deptId: q.deptId, status: q.status, page: 1, pageSize: 1 }),
      ]).then(function (res) {
        var ov = res[0] || {};
        var dept = res[1] || {};
        var trend = res[2] || {};
        var teachers = res[3] || {};
        var recs = res[4] || {};
        rank = teachers.rank || teachers.list || [];
        draw(ov, dept, trend, rank, recs);
      }).catch(function (e) {
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), loadAll);
      });
    }

    function draw(ov, dept, trend, teachers, recs) {
      var deptRows = dept.list || [];
      var statusHint = cur.status
        ? '<div class="alert alert-info" style="margin-bottom:12px">状态筛选：<b>' + ui.esc(ui.statusText(cur.status)) + '</b> · ' +
          '匹配明细 <b>' + (recs.total || 0) + '</b> 条 ' +
          '<button type="button" class="btn-link" data-goto-records="1">查看明细 →</button></div>'
        : '';

      bodyEl.innerHTML = statusHint + cardsHtml(ov) +
        // 院系排行（按实际授课人所属院系归属）
        '<div class="panel">' +
        '<div class="panel-head"><h3>院系学时排行</h3><span class="sub">按<b>实际授课人</b>所属院系归属；点击行可下钻到该院系教师明细</span>' +
        '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-export="1">导出本页报表</button></div></div>' +
        '<div class="panel-body tight"><div style="padding:12px 16px 4px">' + barRowsHtml(deptRows) + '</div>' +
        (deptRows.length ? ui.tableHtml([
          { key: 'name', label: '院系' },
          { key: 'hours', label: '已确认学时', cls: 'num', render: function (r) { return ui.num(r.confirmedHours || r.hours, 1); } },
          { key: 'makeup', label: '其中补签', cls: 'num', render: function (r) { return ui.num(r.makeupHours, 1); } },
          { key: 'expected', label: '应计学时', cls: 'num', render: function (r) { return ui.num(r.expectedHours, 1); } },
          { key: 'rate', label: '完成率', cls: 'num', render: function (r) { return ui.num(r.completionRate, 1) + '%'; } },
          { key: 'teachers', label: '教师数', cls: 'num', render: function (r) { return r.teacherCount; } },
          { key: 'waiting', label: '待确认', cls: 'num', render: function (r) { return r.waiting; } },
          { key: 'temp', label: '临时调整', cls: 'num', render: function (r) { return r.tempAdjustedCount === undefined ? '—' : r.tempAdjustedCount; } },
          { key: 'abnormal', label: '异常', cls: 'num', render: function (r) { return r.abnormal; } },
          { key: 'op', label: '操作', render: function (r) { return '<button type="button" class="btn-link" data-dept="' + ui.esc(r.deptId || r.id) + '">教师明细</button>'; } },
        ], deptRows, { rowAttrs: function (r) { return 'class="clickable" data-dept-row="' + ui.esc(r.deptId || r.id) + '"'; } }) : '') +
        '</div></div>' +
        // 趋势
        '<div class="panel">' +
        '<div class="panel-head"><h3>已确认学时趋势</h3><span class="sub">按<b>实际授课人</b>归属</span>' +
        '<div class="actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-gran="week">按周</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-gran="month">按月</button>' +
        '</div></div>' +
        '<div class="panel-body">' +
        '<div class="chart-legend"><span><i></i>已确认学时（含补签）</span>' +
        '<span>合计 <b>' + ui.num(trend.totalHours, 1) + '</b> 学时 · ' + (trend.list ? trend.list.length : 0) + ' 个' + (trendGran === 'month' ? '月' : '周') + '</span></div>' +
        '<div class="chart-box" id="trend-chart"></div>' +
        '</div></div>' +
        // 教师 Top20（按实际授课人）
        '<div class="panel">' +
        '<div class="panel-head"><h3>教师学时排行 Top 20</h3>' +
        '<span class="sub">按<b>实际授课人</b>统计（含非系统内教师）· 按已确认学时降序</span></div>' +
        '<div class="panel-body tight" id="teacher-rank"></div>' +
        '</div>' +
        // 快捷入口
        '<div class="panel"><div class="panel-head"><h3>快捷入口</h3></div><div class="panel-body">' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button type="button" class="btn" data-export="1">导出本页报表</button>' +
        '<button type="button" class="btn btn-ghost" data-go="makeup">去处理待审补签</button>' +
        '<button type="button" class="btn btn-ghost" data-go="import">去导入数据</button>' +
        '<button type="button" class="btn btn-ghost" data-goto-records="1">查看课时明细</button>' +
        '</div></div></div>';

      // 趋势图
      var chartData = (trend.list || []).map(function (x) { return { label: x.label || x.bucket, value: x.hours }; });
      ui.drawLineChart(bodyEl.querySelector('#trend-chart'), chartData, { unit: ' 学时' });

      // 教师排行表（口径：实际授课人，含非系统内教师）
      var tEl = bodyEl.querySelector('#teacher-rank');
      if (!teachers.length) {
        ui.renderEmpty(tEl, { icon: '👩‍🏫', title: '暂无教师学时数据', hint: '调整筛选条件，或先由班干部录入课程清单并完成课时确认' });
      } else {
        tEl.innerHTML = ui.tableHtml([
          { key: 'rank', label: '#', render: function (r, i) { return String(i + 1); } },
          {
            key: 'name', label: '实际授课人',
            render: function (r) {
              return ui.esc(r.name || r.teacherName || '—') +
                (r.registered === false ? ' ' + ui.flagTag('非系统内', 'tag-reg') : '');
            },
          },
          { key: 'staffNo', label: '工号', render: function (r) { return ui.esc(r.staffNo || '—'); } },
          { key: 'deptName', label: '院系', render: function (r) { return ui.esc(r.deptName || '—'); } },
          { key: 'hours', label: '已确认学时', cls: 'num', render: function (r) { return ui.num(r.confirmedHours || r.hours, 1); } },
          { key: 'makeup', label: '其中补签', cls: 'num', render: function (r) { return ui.num(r.makeupHours, 1); } },
          { key: 'records', label: '记录数', cls: 'num', render: function (r) { return r.recordCount; } },
          { key: 'temp', label: '临时调整', cls: 'num', render: function (r) { return r.tempAdjustedCount === undefined ? '—' : r.tempAdjustedCount; } },
          { key: 'mismatch', label: '姓名不符', cls: 'num', render: function (r) { return r.nameMismatchCount === undefined ? '—' : r.nameMismatchCount; } },
          { key: 'rate', label: '完成率', cls: 'num', render: function (r) { return ui.num(r.completionRate, 1) + '%'; } },
          {
            key: 'op', label: '操作',
            render: function (r) {
              if (!r.teacherId) return '<span class="muted">按姓名筛选</span>';
              return '<button type="button" class="btn-link" data-teacher="' + ui.esc(r.teacherId) + '">课时明细</button>';
            },
          },
        ], teachers);
      }

      bindBody();
    }

    function bindBody() {
      bodyEl.querySelectorAll('[data-gran]').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-gran') === trendGran);
        btn.addEventListener('click', function () {
          trendGran = btn.getAttribute('data-gran');
          loadAll();
        });
      });
      bodyEl.querySelectorAll('[data-go]').forEach(function (btn) {
        btn.addEventListener('click', function () { ctx.navigate(btn.getAttribute('data-go')); });
      });
      bodyEl.querySelectorAll('[data-goto-records]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ctx.navigate('records', { term: cur.term, from: cur.from, to: cur.to, deptId: cur.deptId, status: cur.status });
        });
      });
      bodyEl.querySelectorAll('[data-teacher]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ctx.navigate('records', { teacherId: btn.getAttribute('data-teacher'), term: cur.term, from: cur.from, to: cur.to });
        });
      });
      // 「姓名不符」快捷下钻：课时明细按 nameMismatch=true 过滤
      bodyEl.querySelectorAll('[data-mismatch]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ctx.navigate('records', { nameMismatch: 'true', term: cur.term, from: cur.from, to: cur.to, deptId: cur.deptId });
        });
      });
      bodyEl.querySelectorAll('[data-export]').forEach(function (btn) {
        btn.addEventListener('click', doExport);
      });
      bodyEl.querySelectorAll('[data-dept], [data-dept-row]').forEach(function (n) {
        n.addEventListener('click', function () {
          drillDept(n.getAttribute('data-dept') || n.getAttribute('data-dept-row'));
        });
      });
    }

    /** 院系下钻：该院系教师明细 */
    function drillDept(deptId) {
      if (!deptId) return;
      var d = (deptList || []).filter(function (x) { return String(x.id) === String(deptId); })[0];
      var drawer = ui.openDrawer({
        title: (d ? d.name : '院系') + ' · 教师学时明细',
        subtitle: '同源统计口径',
        body: ui.loadingHtml('加载中…'),
        footer: [
          {
            label: '查看该院系课时明细', cls: 'btn-ghost', onClick: function (api2) {
              api2.close();
              ctx.navigate('records', { term: cur.term, from: cur.from, to: cur.to, deptId: deptId });
            },
          },
          { label: '关闭', onClick: function (api2) { api2.close(); } },
        ],
      });
      api.get('/stats/by-teacher', { term: cur.term, from: cur.from, to: cur.to, deptId: deptId, page: 1, pageSize: 200 })
        .then(function (res) {
          var list = res.rank || res.list || [];
          if (!list.length) {
            ui.renderEmpty(drawer.body, { icon: '👩‍🏫', title: '该院系暂无教师学时数据', hint: '请确认已导入教师白名单与课表' });
            return;
          }
          drawer.body.innerHTML = ui.tableHtml([
            { key: 'name', label: '教师' },
            { key: 'staffNo', label: '工号' },
            { key: 'hours', label: '已确认学时', cls: 'num', render: function (r) { return ui.num(r.confirmedHours || r.hours, 1); } },
            { key: 'makeup', label: '其中补签', cls: 'num', render: function (r) { return ui.num(r.makeupHours, 1); } },
            { key: 'records', label: '记录数', cls: 'num', render: function (r) { return r.recordCount; } },
            { key: 'rate', label: '完成率', cls: 'num', render: function (r) { return ui.num(r.completionRate, 1) + '%'; } },
            { key: 'waiting', label: '待确认', cls: 'num', render: function (r) { return r.waitCount; } },
            { key: 'expired', label: '已过期', cls: 'num', render: function (r) { return r.expiredCount; } },
          ], list);
        })
        .catch(function (e) { drawer.body.innerHTML = ui.errorHtml((e && e.msg) || '加载失败'); });
    }

    /** 导出本页报表（统计口径，与页面数字同源） */
    function doExport() {
      ui.confirm({
        title: '导出本页报表',
        html: '将按当前筛选条件（学期 ' + (cur.term || '全部') + '，日期 ' + (cur.from || '不限') + ' ~ ' + (cur.to || '不限') +
          '，院系 ' + (cur.deptId ? '已选院系' : '全部') + '）导出统计报表（CSV，Excel 可直接打开）。',
        okText: '开始导出',
      }).then(function (ok) {
        if (!ok) return;
        var q = { term: cur.term, from: cur.from, to: cur.to, deptId: cur.deptId, kind: 'stats' };
        api.post('/export/stats', q).then(function (job) {
          ui.toast('导出任务已创建：' + job.jobId, 'ok');
          return A.jobs.waitExport(job.jobId).then(function (done) {
            if (!done || done.status !== 'done') { ui.toast('导出失败：' + ((done && done.status) || 'unknown'), 'error'); return; }
            // 下载走 Authorization 头（导出文件对管理员开放），无需带短期令牌
            return api.download('/files/' + encodeURIComponent(done.fileName), null, done.fileName)
              .then(function () { ui.toast('已开始下载：' + done.fileName, 'ok'); });
          });
        }).catch(function (e) {
          ui.toast((e && e.msg) || '导出失败', 'error');
        });
      });
    }
  }

  A.registerPage('dashboard', { title: '学时统计看板', render: render });
})(window.Admin);
