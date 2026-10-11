'use strict';
/**
 * 补签审核（P0★）：Tab（待审/已通过/已驳回/全部）+ 审核抽屉（原记录详情 + 理由 + 证据 + 通过/驳回）
 * 处理人：院系管理员（本院系）/ 教务处
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var TABS = [
    { key: 'pending', label: '待我审核' },
    { key: 'approved', label: '已通过' },
    { key: 'rejected', label: '已驳回' },
    { key: '', label: '全部' },
  ];

  function render(ctx) {
    var el = ctx.el;
    var st = { tab: ctx.params.status === undefined || ctx.params.status === '' ? 'pending' : ctx.params.status, page: 1, pageSize: 20, total: 0, rows: [], selected: {}, pending: 0 };

    el.innerHTML =
      '<div class="page-title"><h2>补签审核</h2>' +
      '<span class="desc">通过后原记录置为「已补签」，计入正式学时并在报表中单独标注；驳回必须填写原因</span></div>' +
      '<div class="panel">' +
      '<div class="tabs" id="tabs">' + TABS.map(function (t) {
        return '<div class="tab" data-tab="' + t.key + '">' + t.label + '</div>';
      }).join('') + '</div>' +
      '<div class="panel-head"><h3>申请列表</h3><span class="sub" id="sub"></span>' +
      '<div class="actions">' +
      '<input type="date" id="f-from" title="申请开始日期">' +
      '<input type="date" id="f-to" title="申请结束日期">' +
      '<button type="button" class="btn btn-ghost btn-sm" id="btn-query">查询</button>' +
      '<button type="button" class="btn btn-ok btn-sm" id="btn-batch" disabled>批量通过</button>' +
      '</div></div>' +
      '<div id="list-body">' + ui.loadingHtml('正在加载补签申请…') + '</div>' +
      '</div>';

    var bodyEl = el.querySelector('#list-body');

    el.querySelector('#tabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (!tab) return;
      st.tab = tab.getAttribute('data-tab');
      st.page = 1;
      st.selected = {};
      markTabs();
      load();
    });
    el.querySelector('#btn-query').addEventListener('click', function () { st.page = 1; load(); });
    el.querySelector('#btn-batch').addEventListener('click', batchApprove);
    markTabs();
    load();

    function markTabs() {
      el.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === st.tab);
      });
    }

    function load() {
      var w = el.querySelector('#f-from');
      var q = {
        status: st.tab,
        from: w.value,
        to: el.querySelector('#f-to').value,
        page: st.page,
        pageSize: st.pageSize,
      };
      bodyEl.innerHTML = ui.loadingHtml('正在加载补签申请…');
      api.get('/makeup', q).then(function (d) {
        st.rows = d.list || [];
        st.total = d.total || 0;
        st.pending = d.pending || 0;
        draw();
        A.app.refreshPendingBadge();
      }).catch(function (e) {
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    function draw() {
      el.querySelector('#sub').textContent = '共 ' + st.total + ' 条' + (st.pending ? ' · 待审 ' + st.pending + ' 条' : '');
      if (!st.rows.length) {
        ui.renderEmpty(bodyEl, {
          icon: '📝',
          title: st.tab === 'pending' ? '当前没有待审核的补签申请' : '暂无补签申请',
          hint: '教师在小程序对「已过期 / 已拒绝」的记录发起补签后，会出现在这里',
          actions: [
            { label: '查看课时明细', onClick: function () { ctx.navigate('records', { status: 'expired' }); } },
            { label: '刷新', primary: true, onClick: load },
          ],
        });
        return;
      }

      var cols = [
        {
          key: 'sel', labelHtml: '<input type="checkbox" data-role="all">',
          render: function (r) {
            return r.status === 'pending' && r.record && r.record.canDecide
              ? '<input type="checkbox" data-row="' + ui.esc(r.id) + '"' + (st.selected[r.id] ? ' checked' : '') + '>'
              : '<span class="muted">—</span>';
          },
        },
        { key: 'createdAt', label: '申请时间', render: function (r) { return ui.esc(ui.fmtDateTime(r.createdAt)); } },
        { key: 'teacher', label: '教师', render: function (r) { return ui.esc((r.record && r.record.teacherName) || r.applicantName || '—'); } },
        { key: 'course', label: '课程', render: function (r) { return ui.esc((r.record && r.record.courseName) || '—'); } },
        { key: 'className', label: '教学班', render: function (r) { return ui.esc((r.record && r.record.className) || '—'); } },
        { key: 'dept', label: '院系', render: function (r) { return ui.esc((r.record && r.record.deptName) || '—'); } },
        { key: 'date', label: '上课日期', render: function (r) { return ui.esc((r.record && r.record.fullDate) || '—') + ((r.record && r.record.section) ? ' 第' + ui.esc(r.record.section) + '节' : ''); } },
        { key: 'oldStatus', label: '原状态', render: function (r) { return ui.statusTag((r.record && r.record.status) || 'expired'); } },
        { key: 'reason', label: '补签理由', cls: 'wrap', render: function (r) { return ui.esc(r.reason || ''); } },
        { key: 'evidence', label: '证据附件', cls: 'num', render: function (r) { return (r.evidenceUrls || []).length; } },
        { key: 'status', label: '审核状态', render: function (r) { return ui.applyTag(r.status); } },
        { key: 'reviewer', label: '审核人/意见', cls: 'wrap', render: function (r) { return (r.reviewerName ? ui.esc(r.reviewerName) + ' ' : '') + '<span class="muted">' + ui.esc(r.reviewNote || '') + '</span>'; } },
        { key: 'op', label: '操作', render: function (r) { return '<button type="button" class="btn-link" data-open="' + ui.esc(r.id) + '">' + (r.status === 'pending' ? '审核' : '查看') + '</button>'; } },
      ];
      bodyEl.innerHTML = ui.tableHtml(cols, st.rows) + ui.pagerHtml(st.page, st.pageSize, st.total);
      ui.bindPager(bodyEl, st.page, st.pageSize, st.total, function (p, ps) {
        st.page = p; st.pageSize = ps; load();
      });
      bindRows();
    }

    function bindRows() {
      var all = bodyEl.querySelector('[data-role="all"]');
      var selectable = st.rows.filter(function (r) { return r.status === 'pending' && r.record && r.record.canDecide; });
      if (all) {
        all.checked = selectable.length > 0 && selectable.every(function (r) { return st.selected[r.id]; });
        all.addEventListener('change', function () {
          selectable.forEach(function (r) { if (all.checked) st.selected[r.id] = true; else delete st.selected[r.id]; });
          draw();
        });
      }
      bodyEl.querySelectorAll('[data-row]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-row');
          if (cb.checked) st.selected[id] = true; else delete st.selected[id];
          updateBatchBtn();
        });
      });
      bodyEl.querySelectorAll('[data-open]').forEach(function (btn) {
        btn.addEventListener('click', function (e) { e.stopPropagation(); openReview(btn.getAttribute('data-open')); });
      });
      bodyEl.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.classList.add('clickable');
        tr.addEventListener('click', function (e) {
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
          var b = tr.querySelector('[data-open]');
          if (b) openReview(b.getAttribute('data-open'));
        });
      });
      updateBatchBtn();
    }

    function updateBatchBtn() {
      var n = Object.keys(st.selected).length;
      var btn = el.querySelector('#btn-batch');
      btn.disabled = n === 0;
      btn.textContent = n ? ('批量通过（' + n + '）') : '批量通过';
    }

    // -------------------------------------------------------- 审核抽屉
    function openReview(id) {
      var row = st.rows.filter(function (r) { return r.id === id; })[0];
      var drawer = ui.openDrawer({
        title: '补签审核',
        subtitle: id,
        body: ui.loadingHtml('正在加载申请与原始记录…'),
      });

      Promise.all([
        api.get('/makeup/' + encodeURIComponent(id)).catch(function () { return row; }),
        row && row.recordId ? api.get('/records/' + encodeURIComponent(row.recordId)).catch(function () { return null; }) : Promise.resolve(null),
      ]).then(function (res) {
        var apply = res[0] || row;
        var record = res[1];
        drawer.body.innerHTML = reviewHtml(apply, record);
        bindReview(drawer, apply, record);
      }).catch(function (e) {
        drawer.body.innerHTML = ui.errorHtml((e && e.msg) || '加载失败');
      });
    }

    function reviewHtml(apply, record) {
      var r = record || {};
      var canDecide = apply.status === 'pending' && (!apply.record || apply.record.canDecide !== false);
      var evUrls = apply.evidenceUrls || [];
      return '' +
        '<div class="section"><h4>补签申请</h4><dl class="kv">' +
        '<dt>申请编号</dt><dd>' + ui.esc(apply.id) + '</dd>' +
        '<dt>申请时间</dt><dd>' + ui.esc(ui.fmtDateTime(apply.createdAt)) + '</dd>' +
        '<dt>申请人</dt><dd>' + ui.esc(apply.applicantName || '') + '</dd>' +
        '<dt>审核状态</dt><dd>' + ui.applyTag(apply.status) + '</dd>' +
        '<dt>补签理由</dt><dd>' + (apply.reason ? ui.esc(apply.reason) : '<span class="muted">—</span>') + '</dd>' +
        '<dt>证据附件</dt><dd>' + (evUrls.length
          ? evUrls.map(function (u) {
            return '<button type="button" class="btn-link" data-attach="' + ui.esc(u) + '">' + ui.esc(String(u).replace('/api/v1/files/', '附件 ')) + '</button>';
          }).join(' ')
          : '<span class="muted">无附件</span>') + '</dd>' +
        (apply.reviewerName ? '<dt>已由</dt><dd>' + ui.esc(apply.reviewerName) + ' 于 ' + ui.esc(ui.fmtDateTime(apply.reviewedAt)) + ' 处理：' + ui.esc(apply.reviewNote || '') + '</dd>' : '') +
        '</dl></div>' +

        '<div class="section"><h4>原记录详情</h4>' +
        (record ? '<dl class="kv">' +
          '<dt>课程</dt><dd>' + ui.esc(r.courseName) + '</dd>' +
          '<dt>教学班</dt><dd>' + ui.esc(r.className) + '</dd>' +
          '<dt>教师</dt><dd>' + ui.esc(r.teacherName) + '（' + ui.esc(r.teacherNo || '') + '）</dd>' +
          '<dt>上课时间</dt><dd>' + ui.esc(r.fullDate) + ' 第 ' + ui.esc(r.section) + ' 节（' + ui.esc(r.time) + '）</dd>' +
          '<dt>地点</dt><dd>' + ui.esc(r.place || '—') + '</dd>' +
          '<dt>应计学时</dt><dd>' + ui.num(r.hours, 1) + ' 学时</dd>' +
          '<dt>原状态</dt><dd>' + ui.statusTag(r.status) + '</dd>' +
          '<dt>签字人 / 发起人</dt><dd>' + ui.esc(r.signerName || r.initiatorName || '—') + (r.signerIsAdHoc ? ' <span class="tag tag-flag">现场指定</span>' : '') + '</dd>' +
          '<dt>原拒绝/过期原因</dt><dd>' + (r.note ? ui.esc(r.note) : '<span class="muted">—</span>') + '</dd>' +
          '<dt>授课摘要</dt><dd>' + (r.summary ? ui.esc(r.summary) : '<span class="muted">—</span>') + '</dd>' +
          '</dl>' : '<div class="muted">原记录不存在或无权查看</div>') +
        '</div>' +

        (record ? '<div class="section"><h4>证据四项 <span class="hint">动态码 / 确认人 / 确认时间 / 设备（新流程已取消手写签名）</span></h4><div class="evidence-grid">' +
          '<div class="ev-item"><div class="ev-label">动态码</div><div class="ev-value">' + ui.esc(r.codeId || '—') + '</div></div>' +
          '<div class="ev-item"><div class="ev-label">确认人</div><div class="ev-value">' + ui.esc(r.confirmedName || r.signerName || '—') + '</div></div>' +
          '<div class="ev-item"><div class="ev-label">确认时间</div><div class="ev-value">' + ui.esc(r.confirmedAt ? ui.fmtDateTime(r.confirmedAt) : '—') + '</div></div>' +
          '<div class="ev-item"><div class="ev-label">设备</div><div class="ev-value">' + ui.esc(r.device || '—') + '</div></div>' +
          (r.signatureFileId
            ? '<div class="ev-item" style="grid-column:1/-1"><div class="ev-label">历史手写签名图（旧流程数据，新流程不再产生）</div>' +
              '<div id="mk-sig"><div class="signature-box"><div class="loading"><span class="spinner"></span>读取中…</div></div></div></div>'
            : '') +
          '</div></div>' : '') +

        (canDecide
          ? '<div class="section"><h4>审批意见 <span class="hint">驳回过必须填写原因</span></h4>' +
            '<textarea id="mk-note" rows="3" style="width:100%" placeholder="通过时可选填说明；驳回时必须填写驳回原因"></textarea>' +
            '<div class="inline-error" id="mk-err"></div></div>'
          : '');
    }

    function bindReview(drawer, apply, record) {
      var r = record || {};
      if (r.signatureFileId) {
        var slot = drawer.body.querySelector('#mk-sig');
        api.fetchBlob('/files/' + encodeURIComponent(r.signatureFileId)).then(function (blob) {
          var url = URL.createObjectURL(blob);
          slot.innerHTML = '<div class="signature-box"><img src="' + url + '" alt="签名图" style="cursor:zoom-in"><div class="sig-actions">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-zoom="1">放大查看</button></div></div>';
          slot.querySelector('img').addEventListener('click', function () { ui.openImage(url, '签名图 · ' + r.id); });
          slot.querySelector('[data-zoom]').addEventListener('click', function () { ui.openImage(url, '签名图 · ' + r.id); });
        }).catch(function () { slot.innerHTML = '<div class="muted">签名图读取失败</div>'; });
      }
      drawer.body.querySelectorAll('[data-attach]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var u = btn.getAttribute('data-attach');
          var id = String(u).split('/').pop();
          api.fetchBlob('/files/' + encodeURIComponent(id)).then(function (blob) {
            var url = URL.createObjectURL(blob);
            if ((blob.type || '').indexOf('image') === 0) ui.openImage(url, '补签附件');
            else window.open(url, '_blank');
          }).catch(function (e) { ui.toast((e && e.msg) || '附件读取失败', 'error'); });
        });
      });

      var canDecide = apply.status === 'pending' && (!apply.record || apply.record.canDecide !== false);
      if (!canDecide) return;
      var noteEl = drawer.body.querySelector('#mk-note');
      // 追加底部操作按钮
      var foot = document.createElement('div');
      foot.className = 'drawer-foot';
      foot.innerHTML = '<button type="button" class="btn btn-ghost" data-act="close">关闭</button>' +
        '<button type="button" class="btn btn-danger" data-act="reject">驳回</button>' +
        '<button type="button" class="btn btn-ok" data-act="approve">通过</button>';
      drawer.panel.appendChild(foot);
      foot.querySelector('[data-act="close"]').addEventListener('click', function () { drawer.close(); });
      foot.querySelector('[data-act="reject"]').addEventListener('click', function () { decide([apply.id], false, noteEl, drawer); });
      foot.querySelector('[data-act="approve"]').addEventListener('click', function () { decide([apply.id], true, noteEl, drawer); });
    }

    function decide(ids, approve, noteEl, drawer) {
      var note = noteEl ? noteEl.value.trim() : '';
      var errEl = drawer.body.querySelector('#mk-err');
      if (errEl) errEl.textContent = '';
      if (!approve && !note) {
        if (errEl) errEl.textContent = '驳回必须填写原因';
        return;
      }
      var act = approve ? 'approve' : 'reject';
      var done = 0;
      var failed = [];
      function next(i) {
        if (i >= ids.length) {
          if (failed.length) ui.toast('部分处理失败：' + failed.join('；'), 'error');
          else ui.toast(approve ? ('已通过 ' + done + ' 条补签申请') : '已驳回补签申请', 'ok');
          if (drawer) drawer.close();
          st.selected = {};
          load();
          return;
        }
        api.post('/makeup/' + encodeURIComponent(ids[i]) + '/' + act, { note: note })
          .then(function () { done++; next(i + 1); })
          .catch(function (e) { failed.push(ids[i] + '：' + ((e && e.msg) || '失败')); next(i + 1); });
      }
      next(0);
    }

    function batchApprove() {
      var ids = Object.keys(st.selected);
      if (!ids.length) return;
      var rows = st.rows.filter(function (r) { return ids.indexOf(r.id) >= 0; });
      var depts = {};
      rows.forEach(function (r) { depts[(r.record && r.record.deptId) || ''] = 1; });
      if (Object.keys(depts).length > 1) {
        ui.toast('批量通过仅支持同一院系的申请，请分次操作或单独处理', 'warn');
        return;
      }
      ui.promptForm({
        title: '批量通过补签（' + ids.length + ' 条）',
        hint: '仅同院系申请可批量通过；通过后原记录置为「已补签」并计入正式学时。',
        fields: [{ name: 'note', label: '审批意见（可选）', type: 'textarea', rows: 3, full: true }],
        okText: '确认通过',
      }).then(function (v) {
        if (!v) return;
        var done = 0, failed = [];
        (function next(i) {
          if (i >= ids.length) {
            ui.toast(failed.length ? ('部分失败：' + failed.join('；')) : ('已批量通过 ' + done + ' 条'), failed.length ? 'error' : 'ok');
            st.selected = {};
            load();
            return;
          }
          api.post('/makeup/' + encodeURIComponent(ids[i]) + '/approve', { note: v.note || '' })
            .then(function () { done++; next(i + 1); })
            .catch(function (e) { failed.push(ids[i] + '：' + ((e && e.msg) || '失败')); next(i + 1); });
        })(0);
      });
    }
  }

  A.registerPage('makeup', { title: '补签审核', render: render });
})(window.Admin);
