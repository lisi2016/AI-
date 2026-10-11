'use strict';
/**
 * 报表导出中心（P0★）：新建导出 + 任务列表（状态 / 下载）
 * 说明：后端 /export/records 为课时明细；/export/stats 一次产出「概览 + 分院系 + 分教师 + 分课程」统计报表，
 *       因此教师学时汇总 / 院系汇总 / 课程汇总均走 /export/stats（同一份文件内分节呈现）。
 *
 * 业务流程简化后的导出列口径（后端固定表头，不因筛选缺列）：
 *   教师姓名 = 实际授课人；发起人（学委）/发起人职务 = 原「签字人」列；确认时间为教师确认时间；
 *   确认人 / 是否临时调整 / 确认人与实际授课人不符 三列已由后端提供（新流程有值，旧流程为空）；
 *   不含签名图 URL 列。
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var KINDS = [
    { key: 'records', label: '课时明细', api: '/export/records', desc: '逐条课时记录，固定 21 列表头（教师姓名=实际授课人；发起人（学委）=原签字人列；不含签名图列）' },
    { key: 'stats', label: '教师学时汇总', api: '/export/stats', desc: '按教师（实际授课人）汇总（含工号、院系、补签学时、完成率、记录数）' },
    { key: 'stats', label: '院系汇总', api: '/export/stats', desc: '按院系汇总（按实际授课人所属院系归属；已确认/补签/应计学时、完成率、待确认、异常）' },
    { key: 'stats', label: '课程汇总', api: '/export/stats', desc: '按课程汇总（课程代码、学时、记录数、教学班数）' },
  ];

  /** 课时明细固定 21 列表头（与后端 EXPORT_HEADERS 一致，顺序不可改） */
  var RECORDS_HEADERS = [
    '学期', '教师姓名（= 实际授课人）', '工号', '院系', '课程', '教学班', '上课日期', '节次', '应计学时',
    '状态', '是否补签', '发起人（学委）', '发起人职务', '是否现场指定',
    '确认人', '是否临时调整', '确认人与实际授课人不符',
    '确认时间', '缺勤人数', '缺勤姓名', '课堂纪律',
  ];

  function render(ctx) {
    var el = ctx.el;
    var st = { kindIndex: 0, teachers: [] };

    el.innerHTML =
      '<div class="page-title"><h2>报表导出中心</h2>' +
      '<span class="desc">导出为异步任务：创建后可在下方任务列表查看进度并下载（Excel 可直接打开 CSV；当前后端以 CSV 输出）</span></div>' +

      '<div class="panel"><div class="panel-head"><h3>新建导出</h3>' +
      '<span class="sub">固定表头，不随筛选条件缺列</span></div>' +
      '<div class="panel-body">' +
      '<div class="form-grid">' +
      '<div class="form-item"><label>报表类型</label><select id="x-kind">' +
      KINDS.map(function (k, i) { return '<option value="' + i + '">' + ui.esc(k.label) + '</option>'; }).join('') +
      '</select><div class="help-text" id="x-kind-desc"></div></div>' +
      '<div class="form-item"><label>格式</label><select id="x-format">' +
      '<option value="csv">CSV（推荐，Excel 可直接打开）</option>' +
      '<option value="xlsx">xlsx（后端当前按 CSV 输出）</option>' +
      '</select></div>' +
      '<div class="form-item"><label>学期</label><select id="x-term"></select></div>' +
      '<div class="form-item"><label>院系</label><select id="x-dept"><option value="">全部院系</option></select></div>' +
      '<div class="form-item"><label>开始日期</label><input type="date" id="x-from"></div>' +
      '<div class="form-item"><label>结束日期</label><input type="date" id="x-to"></div>' +
      '<div class="form-item"><label>教师（仅课时明细生效）</label><select id="x-teacher"><option value="">全部教师</option></select></div>' +
      '<div class="form-item"><label>课程名（仅课时明细生效）</label><input type="text" id="x-course" placeholder="课程名称模糊匹配"></div>' +
      '<div class="form-item"><label>状态（仅课时明细生效）</label><select id="x-status"><option value="">全部状态</option>' +
      ui.STATUS_ORDER.map(function (s) { return '<option value="' + s + '">' + ui.statusText(s) + '</option>'; }).join('') +
      '</select></div>' +
      '</div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;align-items:center">' +
      '<button type="button" class="btn" id="x-create">创建导出任务</button>' +
      '<button type="button" class="btn btn-ghost" id="x-reset">重置</button>' +
      '<span class="help-text" style="margin:0">导出数字与页面统计同源；下载行为会写入操作日志</span>' +
      '</div>' +
      '<div class="help-text" style="margin-top:12px"><b>课时明细固定 21 列表头（不因筛选缺列）</b>：' + RECORDS_HEADERS.join('、') + '。</div>' +
      '<div class="alert alert-info" style="margin:10px 0 0">口径说明：<b>教师姓名</b>即实际授课人（学时按其实归属）；' +
      '<b>发起人（学委）/ 发起人职务</b>即原「签字人」列（课时会话的发起人）；<b>确认人 / 是否临时调整 / 确认人与实际授课人不符</b>三列为新流程专有（旧流程数据为空）；表中<b>不含签名图 URL 列</b>。</div>' +
      '</div></div>' +

      '<div class="panel"><div class="panel-head"><h3>导出任务列表</h3><span class="sub" id="x-sub"></span>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="x-refresh">刷新</button></div></div>' +
      '<div id="x-list">' + ui.loadingHtml('正在加载导出任务…') + '</div></div>';

    var listEl = el.querySelector('#x-list');
    var kindSel = el.querySelector('#x-kind');
    var descEl = el.querySelector('#x-kind-desc');

    Promise.all([
      A.data.loadTerms(),
      A.data.loadDepts(),
      api.get('/stats/by-teacher', { page: 1, pageSize: 200 }).catch(function () { return { rank: [] }; }),
    ]).then(function (res) {
      var terms = res[0] || [], depts = res[1] || [];
      st.teachers = (res[2] && (res[2].rank || res[2].list)) || [];
      el.querySelector('#x-term').innerHTML = '<option value="">全部学期</option>' + terms.map(function (t) {
        return '<option value="' + ui.esc(t) + '">' + ui.esc(t) + '</option>';
      }).join('');
      // 默认选中学期
      if (A.state.config && A.state.config.term) el.querySelector('#x-term').value = A.state.config.term;
      el.querySelector('#x-dept').innerHTML = '<option value="">全部院系</option>' + depts.map(function (d) {
        return '<option value="' + ui.esc(d.id) + '">' + ui.esc(d.name) + '</option>';
      }).join('');
      el.querySelector('#x-teacher').innerHTML = '<option value="">全部教师</option>' + st.teachers.map(function (t) {
        var id = t.teacherId || t.id;
        return '<option value="' + ui.esc(id) + '">' + ui.esc(t.name) + '（' + ui.esc(t.staffNo || '') + '）</option>';
      }).join('');
      kindSel.addEventListener('change', function () {
        st.kindIndex = Number(kindSel.value) || 0;
        descEl.textContent = KINDS[st.kindIndex].desc;
      });
      descEl.textContent = KINDS[0].desc;
      loadList();
    }).catch(function (e) {
      listEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), loadList);
    });

    el.querySelector('#x-create').addEventListener('click', create);
    el.querySelector('#x-refresh').addEventListener('click', loadList);
    el.querySelector('#x-reset').addEventListener('click', function () {
      el.querySelector('#x-from').value = '';
      el.querySelector('#x-to').value = '';
      el.querySelector('#x-dept').value = '';
      el.querySelector('#x-teacher').value = '';
      el.querySelector('#x-course').value = '';
      el.querySelector('#x-status').value = '';
      el.querySelector('#x-format').value = 'csv';
      loadList();
    });

    function create() {
      var kind = KINDS[Number(kindSel.value) || 0];
      var body = {
        term: el.querySelector('#x-term').value,
        from: el.querySelector('#x-from').value,
        to: el.querySelector('#x-to').value,
        deptId: el.querySelector('#x-dept').value,
        format: el.querySelector('#x-format').value === 'xlsx' ? 'xlsx' : 'csv',
      };
      if (kind.api === '/export/records') {
        body.teacherId = el.querySelector('#x-teacher').value;
        body.courseName = el.querySelector('#x-course').value.trim();
        body.status = el.querySelector('#x-status').value;
      }
      var btn = el.querySelector('#x-create');
      btn.disabled = true;
      btn.textContent = '创建中…';
      api.post(kind.api, body).then(function (job) {
        ui.toast('导出任务已创建：' + job.jobId, 'ok');
        loadList();
        watch(job.jobId);
      }).catch(function (e) {
        ui.toast((e && e.msg) || '创建导出任务失败', 'error');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '创建导出任务';
      });
    }

    /** 轮询直到完成或失败，然后自动刷新列表 */
    function watch(jobId) {
      A.jobs.waitExport(jobId, function (job) {
        if (job && job.status === 'done') ui.toast('导出完成：' + job.fileName + '（' + job.successRows + ' 行）', 'ok');
        if (job && job.status === 'failed') ui.toast('导出失败：' + jobId, 'error');
      }).then(function () { loadList(); });
    }

    function loadList() {
      listEl.innerHTML = ui.loadingHtml('正在加载导出任务…');
      api.get('/export/history', { page: 1, pageSize: 50 }).then(function (d) {
        var list = d.list || [];
        el.querySelector('#x-sub').textContent = '共 ' + (d.total || 0) + ' 个任务 · 下载链接有效期 1 小时，过期请重新生成';
        if (!list.length) {
          ui.renderEmpty(listEl, {
            icon: '📤',
            title: '还没有导出任务',
            hint: '在上方选择报表类型与筛选条件，点击「创建导出任务」',
            actions: [{ label: '立即创建', primary: true, onClick: create }],
          });
          return;
        }
        listEl.innerHTML = ui.tableHtml([
          { key: 'createdAt', label: '创建时间', render: function (r) { return ui.esc(ui.fmtDateTime(r.createdAt)); } },
          { key: 'operatorName', label: '创建人', render: function (r) { return ui.esc(r.operatorName || r.operatorId || '—'); } },
          { key: 'kind', label: '类型', render: function (r) { return ui.esc(r.kind === 'records' ? '课时明细' : '统计报表'); } },
          { key: 'jobId', label: '任务号' },
          { key: 'status', label: '状态', render: function (r) { return ui.applyTag(r.status); } },
          { key: 'rows', label: '行数', cls: 'num', render: function (r) { return r.successRows || r.totalRows || 0; } },
          { key: 'finishedAt', label: '完成时间', render: function (r) { return ui.esc(r.finishedAt ? ui.fmtDateTime(r.finishedAt) : '—'); } },
          {
            key: 'op', label: '下载',
            render: function (r) {
              if (r.status === 'done' && r.fileName) {
                return '<button type="button" class="btn-link" data-dl="' + ui.esc(r.fileName) + '">下载 ' + ui.esc(r.fileName) + '</button>';
              }
              if (r.status === 'failed') return '<span class="muted">生成失败</span>';
              return '<span class="muted">生成中…</span>';
            },
          },
        ], list);

        listEl.querySelectorAll('[data-dl]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var name = btn.getAttribute('data-dl');
            btn.disabled = true;
            api.download('/files/' + encodeURIComponent(name), null, name)
              .then(function () { ui.toast('已开始下载：' + name, 'ok'); })
              .catch(function (e) { ui.toast((e && e.msg) || '下载失败（链接可能已过期，请重新创建）', 'error'); })
              .then(function () { btn.disabled = false; });
          });
        });
      }).catch(function (e) {
        listEl.innerHTML = ui.errorHtml((e && e.msg) || '加载失败', loadList);
      });
    }
  }

  A.registerPage('export', { title: '报表导出中心', render: render });
})(window.Admin);
