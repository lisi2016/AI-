'use strict';
/**
 * 数据导入中心（P0★）：院系 / 教学班 / 课表 / 学生名单 / 白名单 / 班干部授权
 * 流程：下载模板 → 拖拽或选择文件 → 预校验（逐行错误）→ 确认导入 → 导入历史（失败报告下载 / 回滚）
 * 主数据（院系/教学班）额外支持「导出当前数据」：带 ID 导出，改名字段后重新导入即可原地改名（导入从不删行，停用请改状态归档）
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var TYPES = [
    { key: 'depts', label: '院系', master: true, desc: '列：院系名称|院系代码|上级院系|院系ID（ID 留空=按名称新增或更新，填 ID=按 ID 原地改名）', empty: '还没有院系数据，建议先维护院系，再导入教学班与各类名单' },
    { key: 'classes', label: '教学班', master: true, desc: '列：教学班名称|年级|所属院系|班主任|教学班ID|状态（年级留空自动从「2024级」识别；状态 active启用/archived归档/leave休学）', empty: '还没有教学班数据，导入后学生名单、课表、班干部授权才能按教学班匹配' },
    { key: 'tasks', label: '授课任务（课表）', desc: '列：学期|工号|教师姓名|课程代码|课程名称|教学班|星期|节次|开始|结束|地点|周次|学时', empty: '还没有导入课表，导入后教师端才能看到授课任务' },
    { key: 'students', label: '学生名单', desc: '列：学号|姓名|教学班', empty: '还没有导入学生名单，导入后缺勤姓名才能自动匹配' },
    { key: 'whitelist', label: '工号学号白名单', desc: '列：工号/学号|姓名|角色|院系|教学班', empty: '还没有导入白名单，教师与班干部将无法绑定微信' },
    { key: 'cadres', label: '班干部授权', desc: '列：教学班|学号|姓名|职务|优先级', empty: '还没有导入班干部授权，课时确认将无人可签字' },
  ];

  /** 未知页签参数回退到第一个类型，避免 params.type 乱填时整页空白 */
  function typeKey(k) {
    return TYPES.some(function (t) { return t.key === k; }) ? k : TYPES[0].key;
  }

  function render(ctx) {
    var el = ctx.el;
    var st = { type: typeKey(ctx.params.type), file: null, check: null, busy: false };

    el.innerHTML =
      '<div class="page-title"><h2>数据导入中心</h2>' +
      '<span class="desc">先校验后落库：任何一行不通过则整批不入库，并给出逐行错误报告（绝不静默丢弃脏数据）</span></div>' +
      '<div class="panel">' +
      '<div class="tabs" id="tabs">' + TYPES.map(function (t) {
        return '<div class="tab" data-type="' + t.key + '">' + ui.esc(t.label) + '</div>';
      }).join('') + '</div>' +
      '<div id="tab-body"></div>' +

      // 导入历史（所有类型共用）
      '<div class="panel-head" style="border-top:1px solid var(--border)"><h3>导入历史</h3>' +
      '<span class="sub">保留导入前快照，教务处可回滚</span>' +
      '<div class="actions"><label class="inline"><input type="checkbox" id="h-all"> 显示全部类型</label>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="h-refresh">刷新</button></div></div>' +
      '<div id="history-body">' + ui.loadingHtml('正在加载导入历史…') + '</div>' +
      '</div>';

    var tabBody = el.querySelector('#tab-body');
    var historyBody = el.querySelector('#history-body');

    el.querySelector('#tabs').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.tab') : null;
      if (!tab) return;
      st.type = tab.getAttribute('data-type');
      st.file = null;
      st.check = null;
      markTabs();
      drawTab();
      loadHistory();
    });
    el.querySelector('#h-refresh').addEventListener('click', loadHistory);
    el.querySelector('#h-all').addEventListener('change', loadHistory);
    markTabs();
    drawTab();
    loadHistory();

    function markTabs() {
      el.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-type') === st.type); });
    }

    function typeMeta() {
      return TYPES.filter(function (t) { return t.key === st.type; })[0] || TYPES[0];
    }

    // ---------------------------------------------------------- 上传区
    function drawTab() {
      var meta = typeMeta();
      tabBody.innerHTML =
        '<div class="panel-body">' +
        '<div class="alert alert-info">当前类型：<b>' + ui.esc(meta.label) + '</b> · ' + ui.esc(meta.desc) + '</div>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
        '<button type="button" class="btn btn-ghost" id="btn-tpl">下载标准模板（CSV）</button>' +
        (meta.master ? '<button type="button" class="btn btn-ghost" id="btn-tpl-data">导出当前数据（含 ID）</button>' : '') +
        '<button type="button" class="btn btn-ghost" id="btn-tpl-json">查看模板列</button>' +
        '<span class="help-text" style="margin:0">重复数据处理：院系/教学班/白名单/学生/班干部按唯一键<b>覆盖更新</b>，课表按行<b>追加</b>（当前版本固定策略，暂不提供切换）</span>' +
        '</div>' +
        (meta.master ? '<div class="help-text" style="margin:0 0 12px">改名/停用：先点「导出当前数据（含 ID）」，把该行的 ID 填回「' +
          (st.type === 'depts' ? '院系ID' : '教学班ID') + '」列后再导入即可<b>原地更新</b>（导入不会删除任何行；停用请把状态改为 <b>归档</b>）</div>' : '') +

        '<div class="drop-zone" id="dz">' +
        '<div class="dz-icon">📄</div>' +
        '<div class="dz-title">把 CSV 文件拖到这里，或点击选择文件</div>' +
        '<div class="dz-hint">UTF-8 编码；支持 Excel 另存为 CSV（逗号分隔）</div>' +
        '<input type="file" id="file-input" accept=".csv,text/csv" hidden>' +
        '</div>' +

        '<div id="file-info" style="margin-top:12px"></div>' +
        '<div id="check-box" style="margin-top:14px"></div>' +
        '</div>';

      tabBody.querySelector('#btn-tpl').addEventListener('click', function () {
        api.download('/import/template', { type: st.type }, 'template_' + st.type + '.csv')
          .then(function () { ui.toast('模板已开始下载', 'ok'); })
          .catch(function (e) { ui.toast((e && e.msg) || '模板下载失败', 'error'); });
      });
      var btnData = tabBody.querySelector('#btn-tpl-data');
      if (btnData) btnData.addEventListener('click', function () {
        api.download('/import/template', { type: st.type, data: '1' }, 'export_' + st.type + '.csv')
          .then(function () { ui.toast('当前数据已开始导出（含 ID，可改名后重新导入）', 'ok'); })
          .catch(function (e) { ui.toast((e && e.msg) || '导出失败', 'error'); });
      });
      tabBody.querySelector('#btn-tpl-json').addEventListener('click', function () {
        api.get('/import/template', { type: st.type, format: 'json' }).then(function (d) {
          ui.openModal({
            title: '模板列说明 · ' + st.type,
            body: '<div class="help-text">CSV 表头（顺序敏感，建议直接下载模板填写）：</div><ol style="padding-left:20px">' +
              (d.headers || []).map(function (h) { return '<li>' + ui.esc(h) + '</li>'; }).join('') + '</ol>',
            footer: [{ label: '关闭', onClick: function (api2) { api2.close(); } }],
          });
        }).catch(function (e) { ui.toast((e && e.msg) || '读取失败', 'error'); });
      });

      var dz = tabBody.querySelector('#dz');
      var input = tabBody.querySelector('#file-input');
      dz.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) pickFile(input.files[0]);
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
      });
      dz.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickFile(f);
      });
    }

    function pickFile(file) {
      if (!/\.csv$/i.test(file.name)) {
        ui.toast('仅支持 .csv 文件（可从 Excel 另存为 CSV）', 'error');
        return;
      }
      st.file = file;
      st.check = null;
      drawFileInfo();
      runPrecheck();
    }

    function drawFileInfo() {
      var box = tabBody.querySelector('#file-info');
      if (!st.file) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="alert alert-ok" style="display:flex;align-items:center;gap:10px">' +
        '<span>已选择：<b>' + ui.esc(st.file.name) + '</b>（' + (Math.round(st.file.size / 102.4) / 10) + ' KB）</span>' +
        '<span style="margin-left:auto"><button type="button" class="btn btn-ghost btn-sm" id="btn-recheck">重新预校验</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" id="btn-clear">移除</button></span></div>';
      box.querySelector('#btn-recheck').addEventListener('click', runPrecheck);
      box.querySelector('#btn-clear').addEventListener('click', function () {
        st.file = null; st.check = null;
        var input = tabBody.querySelector('#file-input');
        if (input) input.value = '';
        drawFileInfo();
        tabBody.querySelector('#check-box').innerHTML = '';
      });
    }

    // ---------------------------------------------------------- 预校验
    function runPrecheck() {
      if (!st.file || st.busy) return;
      st.busy = true;
      var box = tabBody.querySelector('#check-box');
      box.innerHTML = ui.loadingHtml('正在预校验（大文件可能需要数秒，请勿关闭页面）…');
      var fd = new FormData();
      fd.append('file', st.file, st.file.name);
      api.upload('/import/precheck', fd, { type: st.type })
        .then(function (d) {
          st.check = d;
          drawCheck(d);
        })
        .catch(function (e) {
          box.innerHTML = ui.alertHtml('预校验失败：' + ((e && e.msg) || '未知错误'), 'error');
        })
        .then(function () { st.busy = false; });
    }

    function drawCheck(d) {
      var box = tabBody.querySelector('#check-box');
      var errRows = (d.errors || []).map(function (e) {
        return [String(e.line), e.field || '—', e.msg];
      });
      var previewRows = d.preview && d.preview.rows ? d.preview.rows : [];

      box.innerHTML =
        '<div class="section"><h4>预校验结果</h4>' +
        '<div class="stat-strip">' +
        '<div class="stat-pill">总行数<b>' + d.totalRows + '</b></div>' +
        '<div class="stat-pill ' + (d.validRows ? 'ok' : '') + '">可导入行数<b>' + d.validRows + '</b></div>' +
        '<div class="stat-pill ' + (d.errorRows ? 'err' : '') + '">错误行数<b>' + d.errorRows + '</b></div>' +
        '<div class="stat-pill">表头识别<b>' + (d.headerless ? '按列顺序' : '按表头') + '</b></div>' +
        '</div>' +
        '<div class="alert alert-' + (d.valid ? 'ok' : 'error') + '">' + ui.esc(d.note || '') + '</div>' +

        (errRows.length
          ? '<div style="margin-bottom:10px"><b>错误明细' + (d.errorCount > errRows.length ? '（仅显示前 ' + errRows.length + ' 条，共 ' + d.errorCount + ' 条）' : '') + '</b></div>' +
            ui.tableHtml([
              { key: 'line', label: '行号', width: '90px', render: function (r) { return '第 ' + ui.esc(r[0]) + ' 行'; } },
              { key: 'field', label: '问题字段', width: '170px', render: function (r) { return '<span class="err-field">' + ui.esc(r[1] || '—') + '</span>'; } },
              { key: 'msg', label: '问题描述', cls: 'wrap', render: function (r) { return ui.esc(r[2]); } },
            ], errRows)
          : '') +

        (previewRows.length
          ? '<div style="margin:14px 0 10px"><b>数据预览（前 ' + previewRows.length + ' 行）</b></div>' +
            ui.tableHtml((d.headers || []).map(function (h, i) {
              return { key: 'c' + i, label: h, render: function (r) { return ui.esc(r[i]); } };
            }), previewRows)
          : '') +
        '</div>' +

        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<button type="button" class="btn" id="btn-commit"' + (d.valid ? '' : ' disabled') + '>确认导入' + (d.valid ? '' : '（校验未通过，已禁用）') + '</button>' +
        (d.errorRows ? '<button type="button" class="btn btn-ghost" id="btn-fix-tip">如何修正</button>' : '') +
        '<span class="help-text" style="margin:0">确认导入会先对受影响的数据表做快照，可在下方导入历史中回滚</span>' +
        '</div>';

      var commit = box.querySelector('#btn-commit');
      if (commit) commit.addEventListener('click', commitImport);
      var tip = box.querySelector('#btn-fix-tip');
      if (tip) tip.addEventListener('click', function () {
        ui.openModal({
          title: '如何修正错误行',
          body: '<div style="line-height:1.9">1. 按「问题字段」逐行修改原 CSV（或 Excel）文件；<br>' +
            '2. 常见原因：必填为空、星期格式应为 1-7 或「周三」、节次应为 <code>1-2</code>、教学班/院系名称不存在、工号不在白名单；<br>' +
            '3. 修改后重新上传，预校验通过再点「确认导入」；<br>' +
            '4. 系统在任何一行不通过时<b>不会写入任何数据</b>，可放心反复试。</div>',
          footer: [{ label: '知道了', onClick: function (api2) { api2.close(); } }],
        });
      });
    }

    function commitImport() {
      if (!st.file || !st.check || !st.check.valid) return;
      ui.confirm({
        title: '确认导入',
        html: '将把 <b>' + st.check.validRows + '</b> 行数据写入系统（类型：' + ui.esc(typeMeta().label) + '）。' +
          '<div class="help-text">导入前会自动保存受影响数据表的快照，必要时可在导入历史中回滚。</div>',
        okText: '确认导入',
      }).then(function (ok) {
        if (!ok) return;
        var box = tabBody.querySelector('#check-box');
        var btn = box.querySelector('#btn-commit');
        if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
        var fd = new FormData();
        fd.append('file', st.file, st.file.name);
        api.upload('/import/' + st.type, fd)
          .then(function (r) {
            if (r.committed) ui.toast('导入成功：' + r.successRows + ' 行已落库', 'ok');
            else ui.toast('导入失败：' + r.failRows + ' 行校验不通过，未写入数据', 'error');
            loadHistory();
            if (!r.committed && r.errorReportUrl) {
              ui.openModal({
                title: '导入失败',
                body: '<div class="alert alert-error">' + ui.esc(r.msg) + '</div>' +
                  ((r.errors || []).length ? '<div class="help-text">前若干条错误：</div><ul style="padding-left:20px">' +
                    r.errors.map(function (x) { return '<li>第 ' + x.line + ' 行' + (x.field ? '「' + ui.esc(x.field) + '」' : '') + '：' + ui.esc(x.msg) + '</li>'; }).join('') + '</ul>' : ''),
                footer: [
                  { label: '下载失败报告', cls: 'btn-ghost', onClick: function () { downloadReport(r.errorReportUrl); } },
                  { label: '关闭', onClick: function (api2) { api2.close(); } },
                ],
              });
            }
            if (btn) { btn.disabled = false; btn.textContent = '确认导入'; }
          })
          .catch(function (e) {
            ui.toast((e && e.msg) || '导入失败', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '确认导入'; }
          });
      });
    }

    // ---------------------------------------------------------- 导入历史
    function loadHistory() {
      var all = el.querySelector('#h-all').checked;
      historyBody.innerHTML = ui.loadingHtml('正在加载导入历史…');
      api.get('/import/history', { type: all ? '' : st.type, pageSize: 50, page: 1 }).then(function (d) {
        var list = d.list || [];
        if (!list.length) {
          ui.renderEmpty(historyBody, {
            icon: '📥',
            title: '还没有导入记录',
            hint: typeMeta().empty,
            actions: [{ label: '下载模板', primary: true, onClick: function () { tabBody.querySelector('#btn-tpl').click(); } }],
          });
          return;
        }
        historyBody.innerHTML = ui.tableHtml([
          { key: 'createdAt', label: '导入时间', render: function (r) { return ui.esc(ui.fmtDateTime(r.createdAt)); } },
          { key: 'operatorName', label: '操作人', render: function (r) { return ui.esc(r.operatorName || r.operatorId || '—'); } },
          { key: 'type', label: '类型', render: function (r) { return ui.esc(typeLabel(r.type)); } },
          { key: 'status', label: '状态', render: function (r) { return ui.applyTag(r.status); } },
          { key: 'totalRows', label: '总行数', cls: 'num' },
          { key: 'successRows', label: '成功', cls: 'num' },
          { key: 'failRows', label: '失败', cls: 'num', render: function (r) { return r.failRows ? '<span style="color:#dc2626;font-weight:600">' + r.failRows + '</span>' : '0'; } },
          {
            key: 'report', label: '失败报告',
            render: function (r) {
              return r.errorReportUrl
                ? '<button type="button" class="btn-link" data-report="' + ui.esc(r.errorReportUrl) + '">下载</button>'
                : '<span class="muted">—</span>';
            },
          },
          {
            key: 'op', label: '操作',
            render: function (r) {
              if (r.canRollback && A.state.role === 'admin') {
                return '<button type="button" class="btn-link danger" data-rollback="' + ui.esc(r.jobId) + '">回滚本次导入</button>';
              }
              if (r.status === 'rolled_back') return '<span class="muted">已回滚</span>';
              return '<span class="muted">—</span>';
            },
          },
        ], list);

        historyBody.querySelectorAll('[data-report]').forEach(function (btn) {
          btn.addEventListener('click', function () { downloadReport(btn.getAttribute('data-report')); });
        });
        historyBody.querySelectorAll('[data-rollback]').forEach(function (btn) {
          btn.addEventListener('click', function () { rollback(btn.getAttribute('data-rollback')); });
        });
      }).catch(function (e) {
        historyBody.innerHTML = ui.errorHtml((e && e.msg) || '加载失败', loadHistory);
      });
    }

    function typeLabel(t) {
      var m = TYPES.filter(function (x) { return x.key === t; })[0];
      return m ? m.label : t;
    }

    function downloadReport(url) {
      if (!url) return;
      var path = String(url).replace('/api/v1', '');
      api.download(path, null, String(path).split('/').pop())
        .then(function () { ui.toast('失败报告已开始下载', 'ok'); })
        .catch(function (e) { ui.toast((e && e.msg) || '下载失败', 'error'); });
    }

    function rollback(jobId) {
      ui.confirm({
        title: '回滚导入',
        html: '将使用导入前快照恢复受影响的数据表（任务 ' + ui.esc(jobId) + '）。' +
          '<div class="help-text">回滚会覆盖该表当前内容，请确认该导入之后没有新的手工改动。</div>',
        okText: '确认回滚',
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        api.post('/import/' + encodeURIComponent(jobId) + '/rollback', {})
          .then(function (r) {
            ui.toast('已回滚 ' + (r.restored || []).join('、') + '（共 ' + r.rows + ' 行快照）', 'ok');
            loadHistory();
          })
          .catch(function (e) { ui.toast((e && e.msg) || '回滚失败', 'error'); });
      });
    }
  }

  A.registerPage('import', { title: '数据导入中心', render: render });
})(window.Admin);
