'use strict';
/**
 * 申诉处理（P0★）：结构与补签审核一致，处理人为教务处
 * 额外展示：原拒绝原因、教师申诉理由、双方证据；操作：申诉（恢复为已确认）/ 维持原判
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var TABS = [
    { key: 'pending', label: '待处理' },
    { key: 'approved', label: '已恢复（申诉成立）' },
    { key: 'rejected', label: '已维持原判' },
    { key: '', label: '全部' },
  ];

  function render(ctx) {
    var el = ctx.el;
    var st = { tab: ctx.params.status === undefined || ctx.params.status === '' ? 'pending' : ctx.params.status, page: 1, pageSize: 20, total: 0, rows: [] };

    el.innerHTML =
      '<div class="page-title"><h2>申诉处理</h2>' +
      '<span class="desc">申诉由教务处处理：通过则原记录恢复为「已确认」（计入正式学时），驳回则维持原判；两者均需填写处理意见</span></div>' +
      '<div class="panel">' +
      '<div class="tabs" id="tabs">' + TABS.map(function (t) {
        return '<div class="tab" data-tab="' + t.key + '">' + t.label + '</div>';
      }).join('') + '</div>' +
      '<div class="panel-head"><h3>申诉列表</h3><span class="sub" id="sub"></span>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="btn-refresh">刷新</button></div>' +
      '</div>' +
      '<div id="list-body">' + ui.loadingHtml('正在加载申诉…') + '</div>' +
      '</div>';

    var bodyEl = el.querySelector('#list-body');

    el.querySelector('#tabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (!tab) return;
      st.tab = tab.getAttribute('data-tab');
      st.page = 1;
      markTabs();
      load();
    });
    el.querySelector('#btn-refresh').addEventListener('click', load);
    markTabs();
    load();

    function markTabs() {
      el.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === st.tab); });
    }

    function load() {
      bodyEl.innerHTML = ui.loadingHtml('正在加载申诉…');
      api.get('/appeal', { status: st.tab, page: st.page, pageSize: st.pageSize }).then(function (d) {
        st.rows = d.list || [];
        st.total = d.total || 0;
        draw();
      }).catch(function (e) {
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    function draw() {
      el.querySelector('#sub').textContent = '共 ' + st.total + ' 条';
      if (!st.rows.length) {
        ui.renderEmpty(bodyEl, {
          icon: '⚖️',
          title: st.tab === 'pending' ? '当前没有待处理的申诉' : '暂无申诉记录',
          hint: '教师对「已拒绝」记录在小程序发起申诉后，会出现在这里（同一记录申诉上限 1 次）',
          actions: [{ label: '刷新', primary: true, onClick: load }],
        });
        return;
      }

      var cols = [
        { key: 'createdAt', label: '申诉时间', render: function (r) { return ui.esc(ui.fmtDateTime(r.createdAt)); } },
        { key: 'teacher', label: '教师', render: function (r) { return ui.esc((r.record && r.record.teacherName) || r.applicantName || '—'); } },
        { key: 'course', label: '课程', render: function (r) { return ui.esc((r.record && r.record.courseName) || '—'); } },
        { key: 'className', label: '教学班', render: function (r) { return ui.esc((r.record && r.record.className) || '—'); } },
        { key: 'date', label: '上课日期', render: function (r) { return ui.esc((r.record && r.record.fullDate) || '—'); } },
        { key: 'reason', label: '申诉理由', cls: 'wrap', render: function (r) { return ui.esc(r.reason || ''); } },
        { key: 'status', label: '处理状态', render: function (r) { return ui.applyTag(r.status); } },
        { key: 'reviewer', label: '处理人/意见', cls: 'wrap', render: function (r) { return (r.reviewerName ? ui.esc(r.reviewerName) + ' ' : '') + '<span class="muted">' + ui.esc(r.reviewNote || '') + '</span>'; } },
        { key: 'op', label: '操作', render: function (r) { return '<button type="button" class="btn-link" data-open="' + ui.esc(r.id) + '">' + (r.status === 'pending' ? '处理' : '查看') + '</button>'; } },
      ];
      bodyEl.innerHTML = ui.tableHtml(cols, st.rows) + ui.pagerHtml(st.page, st.pageSize, st.total);
      ui.bindPager(bodyEl, st.page, st.pageSize, st.total, function (p, ps) { st.page = p; st.pageSize = ps; load(); });
      bodyEl.querySelectorAll('[data-open]').forEach(function (btn) {
        btn.addEventListener('click', function (e) { e.stopPropagation(); openDetail(btn.getAttribute('data-open')); });
      });
      bodyEl.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.classList.add('clickable');
        tr.addEventListener('click', function (e) {
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
          var b = tr.querySelector('[data-open]');
          if (b) openDetail(b.getAttribute('data-open'));
        });
      });
    }

    /** 申诉处理抽屉：原拒绝原因 + 申诉理由 + 双方证据 */
    function openDetail(id) {
      var row = st.rows.filter(function (r) { return r.id === id; })[0];
      var drawer = ui.openDrawer({ title: '申诉处理', subtitle: id, body: ui.loadingHtml('正在加载申诉与原始记录…') });
      var p = row && row.recordId ? api.get('/records/' + encodeURIComponent(row.recordId)).catch(function () { return null; }) : Promise.resolve(null);
      p.then(function (record) {
        drawer.body.innerHTML = detailHtml(row, record);
        bind(drawer, row, record);
      }).catch(function (e) {
        drawer.body.innerHTML = ui.errorHtml((e && e.msg) || '加载失败');
      });
    }

    function detailHtml(apply, record) {
      var r = record || {};
      var canDecide = apply.status === 'pending' && A.state.role === 'admin';
      return '' +
        '<div class="section"><h4>申诉信息</h4><dl class="kv">' +
        '<dt>申诉编号</dt><dd>' + ui.esc(apply.id) + '</dd>' +
        '<dt>申诉时间</dt><dd>' + ui.esc(ui.fmtDateTime(apply.createdAt)) + '</dd>' +
        '<dt>申诉人</dt><dd>' + ui.esc(apply.applicantName || '') + '</dd>' +
        '<dt>处理状态</dt><dd>' + ui.applyTag(apply.status) + '</dd>' +
        '<dt>申诉理由</dt><dd>' + (apply.reason ? ui.esc(apply.reason) : '<span class="muted">—</span>') + '</dd>' +
        (apply.reviewerName ? '<dt>已由</dt><dd>' + ui.esc(apply.reviewerName) + ' 于 ' + ui.esc(ui.fmtDateTime(apply.reviewedAt)) + ' 处理：' + ui.esc(apply.reviewNote || '') + '</dd>' : '') +
        '</dl></div>' +

        '<div class="section"><h4>原拒绝原因</h4>' +
        '<div class="alert alert-warn" style="margin-bottom:0">' + (r.note ? ui.esc(r.note) : '<span class="muted">原记录无拒绝说明</span>') + '</div></div>' +

        '<div class="section"><h4>原记录信息</h4>' +
        (record ? '<dl class="kv">' +
          '<dt>课程</dt><dd>' + ui.esc(r.courseName) + '</dd>' +
          '<dt>教学班</dt><dd>' + ui.esc(r.className) + '</dd>' +
          '<dt>教师</dt><dd>' + ui.esc(r.teacherName) + '（' + ui.esc(r.teacherNo || '') + '）</dd>' +
          '<dt>上课时间</dt><dd>' + ui.esc(r.fullDate) + ' 第 ' + ui.esc(r.section) + ' 节</dd>' +
          '<dt>应计学时</dt><dd>' + ui.num(r.hours, 1) + ' 学时</dd>' +
          '<dt>当前状态</dt><dd>' + ui.statusTag(r.status) + '</dd>' +
          '<dt>签字人 / 发起人</dt><dd>' + ui.esc(r.signerName || r.initiatorName || '—') + '</dd>' +
          '</dl>' : '<div class="muted">原记录不存在或无权查看</div>') +
        '</div>' +

        '<div class="section"><h4>双方证据 <span class="hint">证据四项：动态码 / 确认人 / 确认时间 / 设备（新流程已取消手写签名）</span></h4><div class="evidence-grid">' +
        '<div class="ev-item"><div class="ev-label">动态码</div><div class="ev-value">' + ui.esc(r.codeId || '—') + '</div></div>' +
        '<div class="ev-item"><div class="ev-label">确认人</div><div class="ev-value">' + ui.esc(r.confirmedName || r.signerName || '—') + '</div></div>' +
        '<div class="ev-item"><div class="ev-label">确认时间</div><div class="ev-value">' + ui.esc(r.confirmedAt ? ui.fmtDateTime(r.confirmedAt) : '—') + '</div></div>' +
        '<div class="ev-item"><div class="ev-label">设备</div><div class="ev-value">' + ui.esc(r.device || '—') + '</div></div>' +
        (r.signatureFileId
          ? '<div class="ev-item" style="grid-column:1/-1"><div class="ev-label">历史手写签名图（旧流程数据，新流程不再产生）</div>' +
            '<div id="ap-sig"><div class="signature-box"><div class="loading"><span class="spinner"></span>读取中…</div></div></div></div>'
          : '') +
        '<div class="ev-item" style="grid-column:1/-1"><div class="ev-label">教师申诉附件</div><div class="ev-value">' +
        ((apply.evidenceUrls || []).length
          ? apply.evidenceUrls.map(function (u) { return '<button type="button" class="btn-link" data-attach="' + ui.esc(u) + '">' + ui.esc(String(u).replace('/api/v1/files/', '附件 ')) + '</button>'; }).join(' ')
          : '<span class="muted">无附件</span>') +
        '</div></div></div></div>' +

        (canDecide
          ? '<div class="section"><h4>处理意见 <span class="hint">通过/维持原判均需填写</span></h4>' +
            '<textarea id="ap-note" rows="3" style="width:100%" placeholder="请填写处理意见（必填）"></textarea>' +
            '<div class="inline-error" id="ap-err"></div></div>'
          : (apply.status === 'pending' ? '<div class="alert alert-warn">当前角色（' + ui.esc(A.roleText(A.state.role)) + '）无申诉处理权限，仅教务处可处理。</div>' : ''));
    }

    function bind(drawer, apply, record) {
      var r = record || {};
      if (r.signatureFileId) {
        var slot = drawer.body.querySelector('#ap-sig');
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
          var id = String(btn.getAttribute('data-attach')).split('/').pop();
          api.fetchBlob('/files/' + encodeURIComponent(id)).then(function (blob) {
            var url = URL.createObjectURL(blob);
            if ((blob.type || '').indexOf('image') === 0) ui.openImage(url, '申诉附件');
            else window.open(url, '_blank');
          }).catch(function (e) { ui.toast((e && e.msg) || '附件读取失败', 'error'); });
        });
      });

      if (apply.status !== 'pending' || A.state.role !== 'admin') return;
      var noteEl = drawer.body.querySelector('#ap-note');
      var foot = document.createElement('div');
      foot.className = 'drawer-foot';
      foot.innerHTML = '<button type="button" class="btn btn-ghost" data-act="close">关闭</button>' +
        '<button type="button" class="btn btn-danger" data-act="reject">维持原判</button>' +
        '<button type="button" class="btn btn-ok" data-act="approve">申诉成立（恢复为已确认）</button>';
      drawer.panel.appendChild(foot);
      foot.querySelector('[data-act="close"]').addEventListener('click', function () { drawer.close(); });
      foot.querySelector('[data-act="reject"]').addEventListener('click', function () { decide(apply.id, false, noteEl, drawer); });
      foot.querySelector('[data-act="approve"]').addEventListener('click', function () { decide(apply.id, true, noteEl, drawer); });
    }

    function decide(id, approve, noteEl, drawer) {
      var note = noteEl ? noteEl.value.trim() : '';
      var errEl = drawer.body.querySelector('#ap-err');
      if (errEl) errEl.textContent = '';
      if (!note) {
        if (errEl) errEl.textContent = '请填写处理意见（通过/维持原判均需填写）';
        return;
      }
      var act = approve ? 'approve' : 'reject';
      var label = approve ? '申诉成立，原记录已恢复为「已确认」' : '已维持原判';
      api.post('/appeal/' + encodeURIComponent(id) + '/' + act, { note: note })
        .then(function () {
          ui.toast(label, 'ok');
          drawer.close();
          load();
        })
        .catch(function (e) { ui.toast((e && e.msg) || '处理失败', 'error'); });
    }
  }

  A.registerPage('appeal', { title: '申诉处理', render: render });
})(window.Admin);
