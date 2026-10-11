'use strict';
/**
 * 操作日志（P1）：筛选 + 表格 + 哈希链校验结果展示 + 导出当前页
 * 日志不可编辑不可删除；hash = SHA256(prev_hash + 本条内容)
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var TARGET_TYPES = [
    '', 'period_record', 'makeup_apply', 'appeal', 'user', 'course_task',
    'import_job', 'export_job', 'config', 'signature', 'code',
  ];

  function render(ctx) {
    var el = ctx.el;
    var st = { page: 1, pageSize: 20, total: 0, rows: [], chain: null, lastExportRows: [] };

    var f = {
      from: ctx.params.from || '',
      to: ctx.params.to || '',
      action: ctx.params.action || '',
      actorId: ctx.params.actorId || '',
      role: ctx.params.role || '',
      targetType: ctx.params.targetType || '',
      targetId: ctx.params.targetId || '',
    };

    el.innerHTML =
      '<div class="page-title"><h2>操作日志</h2>' +
      '<span class="desc">留存 5 年、不可编辑不可删除；SHA-256 哈希链可检测篡改（hash = SHA256(prev_hash + 本条内容)）</span></div>' +

      '<div class="panel"><div class="panel-head"><h3>哈希链校验</h3>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="v-run">重新校验</button></div></div>' +
      '<div class="panel-body" id="v-body">' + ui.loadingHtml('正在校验…') + '</div></div>' +

      '<div class="panel">' +
      '<div class="panel-head"><h3>日志查询</h3><span class="sub" id="l-sub"></span>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="l-export">导出当前页 CSV</button></div></div>' +
      '<div class="panel-body">' +
      '<div class="filters">' +
      '<div class="f"><label>开始日期</label><input type="date" id="f-from" value="' + ui.esc(f.from) + '"></div>' +
      '<div class="f"><label>结束日期</label><input type="date" id="f-to" value="' + ui.esc(f.to) + '"></div>' +
      '<div class="f"><label>动作类型（模糊）</label><input type="text" id="f-action" placeholder="如 record.sign" value="' + ui.esc(f.action) + '"></div>' +
      '<div class="f"><label>操作人 ID</label><input type="text" id="f-actor" placeholder="如 U00000010" value="' + ui.esc(f.actorId) + '"></div>' +
      '<div class="f"><label>角色（当前页内筛选）</label><select id="f-role">' +
      ['', 'admin', 'dept_admin', 'teacher', 'cadre'].map(function (r) {
        return '<option value="' + r + '"' + (r === f.role ? ' selected' : '') + '>' + (r ? ui.esc(A.roleText(r)) : '全部角色') + '</option>';
      }).join('') + '</select></div>' +
      '<div class="f"><label>目标对象类型</label><select id="f-ttype">' + TARGET_TYPES.map(function (t) {
        return '<option value="' + ui.esc(t) + '"' + (t === f.targetType ? ' selected' : '') + '>' + (t ? ui.esc(t) : '全部类型') + '</option>';
      }).join('') + '</select></div>' +
      '<div class="f"><label>目标对象 ID</label><input type="text" id="f-tid" placeholder="如 R00000001" value="' + ui.esc(f.targetId) + '"></div>' +
      '<div class="f-actions"><button type="button" class="btn btn-ghost btn-sm" id="f-reset">重置</button>' +
      '<button type="button" class="btn" id="f-search">查询</button></div>' +
      '</div>' +
      '<div class="help-text">角色筛选后端未提供参数，按当前页内筛选；导出为当前页数据（最多 ' + st.pageSize + ' 条）。</div>' +
      '</div>' +
      '<div id="l-body">' + ui.loadingHtml('正在加载操作日志…') + '</div>' +
      '</div>';

    var bodyEl = el.querySelector('#l-body');
    var vBody = el.querySelector('#v-body');

    el.querySelector('#v-run').addEventListener('click', verify);
    el.querySelector('#f-search').addEventListener('click', function () { sync(); st.page = 1; load(); });
    el.querySelector('#f-reset').addEventListener('click', function () {
      f = { from: '', to: '', action: '', actorId: '', role: '', targetType: '', targetId: '' };
      ['f-from', 'f-to', 'f-action', 'f-actor', 'f-tid'].forEach(function (id) { el.querySelector('#' + id).value = ''; });
      el.querySelector('#f-role').value = '';
      el.querySelector('#f-ttype').value = '';
      st.page = 1;
      load();
    });
    el.querySelector('#l-export').addEventListener('click', exportCsv);
    ['f-role', 'f-ttype'].forEach(function (id) {
      el.querySelector('#' + id).addEventListener('change', function () { sync(); st.page = 1; load(); });
    });

    sync();
    verify();
    load();

    function sync() {
      f.from = el.querySelector('#f-from').value;
      f.to = el.querySelector('#f-to').value;
      f.action = el.querySelector('#f-action').value.trim();
      f.actorId = el.querySelector('#f-actor').value.trim();
      f.role = el.querySelector('#f-role').value;
      f.targetType = el.querySelector('#f-ttype').value;
      f.targetId = el.querySelector('#f-tid').value.trim();
    }

    function verify() {
      vBody.innerHTML = ui.loadingHtml('正在校验哈希链…');
      api.get('/logs/verify').then(function (r) {
        st.chain = r;
        vBody.innerHTML = '<div class="alert alert-' + (r.ok ? 'ok' : 'error') + '" style="margin-bottom:0">' +
          (r.ok
            ? '✔ 哈希链完整：共 <b>' + r.total + '</b> 条日志，链头 <code>' + ui.esc(String(r.headHash || '').slice(0, 24)) + '…</code>'
            : '✘ 检测到篡改：第 <b>' + ui.esc(r.brokenAt) + '</b> 条前后不一致（' + ui.esc(r.reason || '') + '）') +
          '</div>';
      }).catch(function (e) {
        vBody.innerHTML = ui.alertHtml((e && e.msg) || '校验失败', 'error');
      });
    }

    function load() {
      var q = {
        from: f.from, to: f.to, action: f.action, actorId: f.actorId,
        targetType: f.targetType, targetId: f.targetId,
        page: st.page, pageSize: st.pageSize,
      };
      bodyEl.innerHTML = ui.loadingHtml('正在加载操作日志…');
      api.get('/logs', q).then(function (d) {
        st.rows = d.list || [];
        st.total = d.total || 0;
        if (d.chain) st.chain = d.chain;
        draw();
      }).catch(function (e) {
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    function visibleRows() {
      if (!f.role) return st.rows;
      return st.rows.filter(function (r) { return r.actorRole === f.role; });
    }

    function draw() {
      var rows = visibleRows();
      el.querySelector('#l-sub').textContent = '共 ' + st.total + ' 条' + (f.role ? ' · 当前页角色筛选后 ' + rows.length + ' 条' : '');
      if (!rows.length) {
        ui.renderEmpty(bodyEl, {
          icon: '🗂️',
          title: '没有符合条件的操作日志',
          hint: '可放宽时间范围或清空筛选条件',
          actions: [{ label: '重置筛选', primary: true, onClick: function () { el.querySelector('#f-reset').click(); } }],
        });
        return;
      }
      st.lastExportRows = rows;
      bodyEl.innerHTML = ui.tableHtml([
        { key: 'createdAt', label: '时间', render: function (r) { return ui.esc(ui.fmtDateTime(r.createdAt)); } },
        { key: 'actorName', label: '操作人', render: function (r) { return ui.esc(r.actorName || r.actorId || '系统'); } },
        { key: 'actorRole', label: '角色', render: function (r) { return ui.esc(A.roleText(r.actorRole) || r.actorRole || '—'); } },
        { key: 'action', label: '动作', render: function (r) { return '<b>' + ui.esc(r.action) + '</b>' + (r.detail ? '<div class="muted" style="font-size:11.5px;white-space:normal;max-width:360px">' + ui.esc(r.detail) + '</div>' : ''); } },
        { key: 'target', label: '目标对象', render: function (r) { return ui.esc(r.targetType || '—') + (r.targetId ? '<div class="muted" style="font-size:11.5px">' + ui.esc(r.targetId) + '</div>' : ''); } },
        { key: 'ip', label: 'IP', render: function (r) { return ui.esc(r.ip || '—'); } },
        { key: 'device', label: '设备', cls: 'wrap', render: function (r) { return '<span class="muted">' + ui.esc(String(r.device || '—').slice(0, 60)) + '</span>'; } },
        { key: 'hash', label: '哈希', render: function (r) { return '<code title="' + ui.esc(r.hash || '') + '">' + ui.esc(String(r.hash || '').slice(0, 12)) + '…</code>'; } },
      ], rows) + ui.pagerHtml(st.page, st.pageSize, st.total);
      ui.bindPager(bodyEl, st.page, st.pageSize, st.total, function (p, ps) { st.page = p; st.pageSize = ps; load(); });
    }

    function exportCsv() {
      var rows = st.lastExportRows || [];
      if (!rows.length) { ui.toast('当前没有可导出的日志', 'warn'); return; }
      var headers = ['时间', '操作人', '角色', '动作', '目标类型', '目标ID', 'IP', '设备', '哈希'];
      function cell(v) {
        var s = v === undefined || v === null ? '' : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      var lines = [headers.join(',')];
      rows.forEach(function (r) {
        lines.push([ui.fmtDateTime(r.createdAt), r.actorName || r.actorId, r.actorRole, r.action,
          r.targetType, r.targetId, r.ip, r.device, r.hash].map(cell).join(','));
      });
      var csv = '\ufeff' + lines.join('\r\n') + '\r\n';
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'audit_logs_page' + st.page + '_' + ui.todayStr() + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      ui.toast('已导出当前页 ' + rows.length + ' 条日志', 'ok');
    }
  }

  A.registerPage('logs', { title: '操作日志', render: render });
})(window.Admin);
