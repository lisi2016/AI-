'use strict';
/**
 * 规则配置（P1）：学时系数 / 确认时限 / 动态码有效期 / 补签与申诉审批层级 /
 * 自由文本合规（敏感词表 + 摘要・缺勤姓名・理由备注长度上限）等
 * 修改权限限教务处（admin）；院系管理员只读。
 */
(function (A) {
  var ui = A.ui;
  var api = A.api;

  var ROLE_OPTIONS = [
    { value: 'dept_admin', label: '院系管理员（dept_admin）' },
    { value: 'admin', label: '教务处（admin）' },
  ];

  function inputFor(item, editable) {
    var key = item.key;
    var v = item.value === undefined || item.value === null ? '' : String(item.value);
    var dis = editable ? '' : ' disabled';
    if (key === 'makeup_approver_role' || key === 'appeal_approver_role') {
      return '<select data-key="' + ui.esc(key) + '"' + dis + '>' + ROLE_OPTIONS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === v ? ' selected' : '') + '>' + ui.esc(o.label) + '</option>';
      }).join('') + '</select>';
    }
    // 敏感词表可能很长，用多行文本框（逗号/顿号分隔，留空表示不启用过滤）
    if (key === 'sensitive_words') {
      return '<textarea rows="4" data-key="' + ui.esc(key) + '" placeholder="逗号或顿号分隔，例如：代签,作弊,包过（留空表示不启用敏感词过滤）"' + dis + '>' + ui.esc(v) + '</textarea>';
    }
    var isNum = item.valueType === 'number';
    return '<input type="' + (isNum ? 'number' : 'text') + '"' + (isNum ? ' step="0.1"' : '') +
      (isNum && item.min !== undefined ? ' min="' + ui.esc(item.min) + '"' : '') +
      (isNum && item.max !== undefined ? ' max="' + ui.esc(item.max) + '"' : '') +
      ' data-key="' + ui.esc(key) + '" value="' + ui.esc(v) + '"' + dis + '>';
  }

  var GROUP_OF = {
    hours_coef_theory: '学时系数',
    hours_coef_practice: '学时系数',
    hours_coef_training: '学时系数',
    confirm_deadline_hour: '时限与动态码',
    code_ttl_seconds: '时限与动态码',
    urge_cooldown_minutes: '时限与动态码',
    makeup_approver_role: '审批层级',
    appeal_approver_role: '审批层级',
    term: '基础参数',
    sensitive_words: '自由文本合规',
    max_summary_len: '自由文本合规',
    max_absent_names_len: '自由文本合规',
    max_reason_len: '自由文本合规',
  };

  function render(ctx) {
    var el = ctx.el;
    var editable = A.state.role === 'admin';

    el.innerHTML =
      '<div class="page-title"><h2>规则配置</h2>' +
      '<span class="desc">改动立即生效并写入操作日志；' + (editable ? '当前为教务处，可修改' : '当前角色为' + ui.esc(A.roleText(A.state.role)) + '，仅可查看') + '</span></div>' +
      '<div class="panel"><div class="panel-head"><h3>系统参数</h3>' +
      '<div class="actions"><button type="button" class="btn btn-ghost btn-sm" id="c-reload">重新加载</button>' +
      (editable ? '<button type="button" class="btn btn-sm" id="c-save">保存修改</button>' : '') +
      '</div></div>' +
      '<div class="panel-body" id="c-body">' + ui.loadingHtml('正在加载配置…') + '</div></div>';

    var bodyEl = el.querySelector('#c-body');
    var original = {};

    el.querySelector('#c-reload').addEventListener('click', load);
    if (editable) el.querySelector('#c-save').addEventListener('click', save);

    load();

    function load() {
      bodyEl.innerHTML = ui.loadingHtml('正在加载配置…');
      api.get('/config').then(function (d) {
        var list = d.list || [];
        original = {};
        list.forEach(function (it) { original[it.key] = String(it.value); });

        var groups = {};
        list.forEach(function (it) {
          var g = GROUP_OF[it.key] || '其它';
          (groups[g] = groups[g] || []).push(it);
        });

        bodyEl.innerHTML = Object.keys(groups).map(function (g) {
          return '<div class="section"><h4>' + ui.esc(g) + '</h4>' +
            groups[g].map(function (it) {
              return '<div class="cfg-row">' +
                '<div class="cfg-key"><code>' + ui.esc(it.key) + '</code><span class="desc">' + ui.esc(it.description || '') + '</span></div>' +
                '<div>' + inputFor(it, editable) + '</div>' +
                '<div class="cfg-meta">' + (it.updatedAt
                  ? '最后由 ' + ui.esc(it.updatedBy || '—') + '<br>' + ui.esc(ui.fmtDateTime(it.updatedAt)) + ' 修改'
                  : '尚未修改') + '</div>' +
                '</div>';
            }).join('') + '</div>';
        }).join('') +
          '<div class="alert alert-info" style="margin-top:6px">当前学期：<b>' + ui.esc((d.config && d.config.term) || '—') + '</b>' +
          ' · 可用学期：' + ui.esc((d.terms || []).join('、') || '—') + '</div>';
      }).catch(function (e) {
        bodyEl.innerHTML = ui.errorHtml((e && e.msg) || (e && e.message), load);
      });
    }

    function save() {
      var changed = {};
      bodyEl.querySelectorAll('[data-key]').forEach(function (inp) {
        var k = inp.getAttribute('data-key');
        var v = inp.value;
        if (String(original[k]) !== String(v)) changed[k] = v;
      });
      var keys = Object.keys(changed);
      if (!keys.length) { ui.toast('没有需要保存的修改', 'warn'); return; }
      ui.confirm({
        title: '保存配置',
        html: '将修改以下 ' + keys.length + ' 项：<ul style="padding-left:20px;margin:6px 0">' +
          keys.map(function (k) { return '<li><code>' + ui.esc(k) + '</code>：' + ui.esc(original[k]) + ' → <b>' + ui.esc(changed[k]) + '</b></li>'; }).join('') + '</ul>',
        okText: '保存',
      }).then(function (ok) {
        if (!ok) return;
        var btn = el.querySelector('#c-save');
        btn.disabled = true;
        btn.textContent = '保存中…';
        api.put('/config', { config: changed }).then(function (r) {
          if (r.errors && r.errors.length) {
            ui.toast('部分配置未保存：' + r.errors.map(function (x) { return x.key + ' ' + x.msg; }).join('；'), 'warn');
          } else {
            ui.toast('配置已保存，立即生效', 'ok');
          }
          A.data.loadConfig(true);
          load();
        }).catch(function (e) {
          ui.toast((e && e.msg) || '保存失败', 'error');
        }).then(function () {
          btn.disabled = false;
          btn.textContent = '保存修改';
        });
      });
    }
  }

  A.registerPage('config', { title: '规则配置', render: render });
})(window.Admin);
