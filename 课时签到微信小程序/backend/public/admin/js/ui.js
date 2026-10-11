'use strict';
/**
 * UI 基础组件（原生 DOM，无第三方库）
 * - 顶部轻提示 toast / 行内 alert / 模态 modal / 抽屉 drawer / 确认框
 * - 空态、状态标签、表格渲染、分页、纯 SVG 折线图、CSS 横条排行
 */
window.Admin = window.Admin || {};
(function (A) {
  // ------------------------------------------------------------ 基础工具
  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDateTime(v) {
    if (!v) return '';
    var s = String(v);
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    if (m) return m[1] + ' ' + m[2];
    return s.length > 16 ? s.slice(0, 16).replace('T', ' ') : s;
  }
  function fmtDate(v) {
    if (!v) return '';
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s.slice(0, 10);
  }
  /** 数字格式化（保留最多 digits 位小数，去掉无意义的 .0） */
  function num(v, digits) {
    var n = Number(v || 0);
    if (!isFinite(n)) n = 0;
    var d = digits === undefined ? 2 : digits;
    var s = n.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s === '' || s === '-' ? '0' : s;
  }
  function todayStr() {
    var d = new Date(Date.now() + 8 * 3600 * 1000); // Asia/Shanghai
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function addDaysStr(dateStr, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
    if (!m) return dateStr;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  // 状态字典（与后端 view.STATUS_TEXT 一致）
  var STATUS_TEXT = {
    draft: '未发起', wait: '待确认', done: '已确认', rejected: '已拒绝',
    expired: '已过期', appealing: '申诉中', makeup: '已补签', revoked: '已撤销',
  };
  var STATUS_ORDER = ['draft', 'wait', 'done', 'rejected', 'expired', 'appealing', 'makeup', 'revoked'];
  function statusText(s) { return STATUS_TEXT[s] || s || ''; }
  function statusTag(s) {
    return '<span class="tag tag-' + esc(s || 'draft') + '">' + esc(statusText(s)) + '</span>';
  }

  /**
   * 课时会话状态字典（业务流程简化：班干部发起 → 任课教师扫码确认）
   * 与后端 view.SESSION_STATUS_TEXT 一致；旧接口回退时仍可用 STATUS_TEXT。
   */
  var SESSION_STATUS_TEXT = {
    draft: '未发起', wait: '待教师确认', done: '已确认', rejected: '已拒绝',
    expired: '已过期', appealing: '申诉中', makeup: '已补签', revoked: '已撤销',
  };
  function sessionStatusText(s) { return SESSION_STATUS_TEXT[s] || STATUS_TEXT[s] || s || ''; }
  /** 状态角标（课时会话口径）：优先用后端返回的 statusText */
  function sessionStatusTag(s, text) {
    return '<span class="tag tag-' + esc(s || 'draft') + '">' + esc(text || sessionStatusText(s)) + '</span>';
  }
  /** 临时调整 / 姓名不符等提示角标 */
  function flagTag(text, cls) {
    return '<span class="tag ' + esc(cls || 'tag-flag') + '">' + esc(text) + '</span>';
  }
  function applyTag(s) {
    var map = { pending: ['tag-pending', '待审核'], approved: ['tag-approved', '已通过'], rejected: ['tag-rejected', '已驳回'], done: ['tag-approved', '已完成'], failed: ['tag-rejected', '失败'], running: ['tag-wait', '处理中'], pending_job: ['tag-wait', '排队中'], rolled_back: ['tag-revoked', '已回滚'] };
    var m = map[s] || ['tag-draft', s || ''];
    return '<span class="tag ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function disciplineText(d) { return ({ good: '好', normal: '一般', bad: '差' })[d] || d || ''; }

  // ------------------------------------------------------------ 顶部轻提示
  function toast(msg, type, ms) {
    var root = document.getElementById('toast-root');
    if (!root) { window.alert(msg); return; }
    var box = document.createElement('div');
    box.className = 'toast ' + (type || '');
    var icon = type === 'ok' ? '✓' : (type === 'error' ? '✕' : (type === 'warn' ? '!' : 'i'));
    box.innerHTML = '<b>' + icon + '</b><span>' + esc(msg) + '</span>';
    root.appendChild(box);
    requestAnimationFrame(function () { box.classList.add('show'); });
    setTimeout(function () {
      box.classList.remove('show');
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 250);
    }, ms || (type === 'error' ? 4200 : 2600));
  }

  var alertSeq = 0;
  function alertHtml(msg, type) {
    return '<div class="alert alert-' + (type || 'info') + '">' + (type === 'raw' ? msg : esc(msg)) + '</div>';
  }
  function alertBox(container, msg, type) {
    if (!container) return;
    var id = 'al_' + (++alertSeq);
    var div = document.createElement('div');
    div.className = 'alert alert-' + (type || 'info');
    div.id = id;
    div.textContent = msg;
    container.insertBefore(div, container.firstChild);
    return div;
  }

  // ------------------------------------------------------------ 空态
  function emptyHtml(opts) {
    var o = opts || {};
    var actions = (o.actions || []).map(function (a, i) {
      return '<button type="button" class="btn ' + (a.primary ? '' : 'btn-ghost') + '" data-empty-action="' + i + '">' + esc(a.label) + '</button>';
    }).join('');
    return '<div class="empty">' +
      '<div class="icon">' + esc(o.icon || '📭') + '</div>' +
      '<div class="title">' + esc(o.title || '暂无数据') + '</div>' +
      (o.hint ? '<div class="hint">' + esc(o.hint) + '</div>' : '') +
      (actions ? '<div class="actions">' + actions + '</div>' : '') +
      '</div>';
  }
  /** 渲染空态并把按钮点击绑到 o.actions[i].onClick */
  function renderEmpty(container, opts) {
    container.innerHTML = emptyHtml(opts);
    (opts.actions || []).forEach(function (a, i) {
      var btn = container.querySelector('[data-empty-action="' + i + '"]');
      if (btn && typeof a.onClick === 'function') btn.addEventListener('click', a.onClick);
    });
  }

  function loadingHtml(text) {
    return '<div class="loading"><span class="spinner"></span>' + esc(text || '加载中…') + '</div>';
  }
  function errorHtml(msg, retryFn) {
    var id = 'retry_' + (++alertSeq);
    return '<div class="empty"><div class="icon">⚠️</div><div class="title">加载失败</div>' +
      '<div class="hint">' + esc(msg || '网络或服务异常') + '</div>' +
      (retryFn ? '<div class="actions"><button type="button" class="btn btn-ghost" id="' + id + '">重试</button></div>' : '') +
      '</div>';
  }

  // ------------------------------------------------------------ 遮罩层（抽屉 / 模态）
  function lockScroll(on) { document.body.style.overflow = on ? 'hidden' : ''; }

  function openDrawer(opts) {
    var o = opts || {};
    var root = document.getElementById('drawer-root');
    var mask = document.createElement('div');
    mask.className = 'drawer-mask';
    var panel = document.createElement('div');
    panel.className = 'drawer';
    if (o.width) panel.style.width = o.width;

    var head = document.createElement('div');
    head.className = 'drawer-head';
    head.innerHTML = '<h3>' + esc(o.title || '') + '</h3>' + (o.subtitle ? '<span class="sub">' + esc(o.subtitle) + '</span>' : '') +
      '<button type="button" class="close" title="关闭">×</button>';

    var body = document.createElement('div');
    body.className = 'drawer-body';
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else if (o.body) body.appendChild(o.body);

    panel.appendChild(head);
    panel.appendChild(body);

    var foot = null;
    if (o.footer && o.footer.length) {
      foot = document.createElement('div');
      foot.className = 'drawer-foot';
      o.footer.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (b.cls || 'btn-ghost');
        btn.textContent = b.label;
        if (b.disabled) btn.disabled = true;
        btn.addEventListener('click', function () { b.onClick && b.onClick(api); });
        foot.appendChild(btn);
      });
      panel.appendChild(foot);
    }

    root.appendChild(mask);
    root.appendChild(panel);
    lockScroll(true);
    requestAnimationFrame(function () { mask.classList.add('show'); panel.classList.add('show'); });

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.classList.remove('show');
      panel.classList.remove('show');
      lockScroll(false);
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }, 240);
      if (typeof o.onClose === 'function') o.onClose();
    }
    mask.addEventListener('click', close);
    head.querySelector('.close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } }

    var api = { close: close, body: body, panel: panel, foot: foot, setTitle: function (t) { head.querySelector('h3').textContent = t; } };
    return api;
  }

  function openModal(opts) {
    var o = opts || {};
    var root = document.getElementById('modal-root');
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal' + (o.wide ? ' wide' : '');

    var head = document.createElement('div');
    head.className = 'modal-head';
    head.innerHTML = '<span>' + esc(o.title || '') + '</span><button type="button" class="close">×</button>';

    var body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else if (o.body) body.appendChild(o.body);

    box.appendChild(head);
    box.appendChild(body);

    var foot = null;
    if (o.footer && o.footer.length) {
      foot = document.createElement('div');
      foot.className = 'modal-foot';
      o.footer.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (b.cls || 'btn-ghost');
        btn.textContent = b.label;
        if (b.disabled) btn.disabled = true;
        btn.addEventListener('click', function () { b.onClick && b.onClick(api); });
        foot.appendChild(btn);
      });
      box.appendChild(foot);
    }

    root.appendChild(mask);
    mask.appendChild(box);
    lockScroll(true);
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      lockScroll(false);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (typeof o.onClose === 'function') o.onClose();
    }
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    head.querySelector('.close').addEventListener('click', close);

    var api = { close: close, body: body, box: box, foot: foot };
    var firstInput = body.querySelector('input, textarea, select');
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 30);
    return api;
  }

  /** 确认框 → Promise<boolean>（注意：必须先 resolve 再 close，且用 settled 防止 onClose 覆盖结果） */
  function confirm(opts) {
    var o = (typeof opts === 'string') ? { message: opts } : (opts || {});
    return new Promise(function (resolve) {
      var settled = false;
      function settle(v) { if (settled) return; settled = true; resolve(v); }
      var m = openModal({
        title: o.title || '请确认',
        body: '<div style="line-height:1.8">' + (o.html || esc(o.message || '')) + '</div>',
        footer: [
          { label: o.cancelText || '取消', cls: 'btn-ghost', onClick: function (api) { settle(false); api.close(); } },
          { label: o.okText || '确定', cls: o.danger ? 'btn-danger' : '', onClick: function (api) { settle(true); api.close(); } },
        ],
        onClose: function () { settle(false); },
      });
      if (o.focusOk && m.foot) m.foot.lastChild.focus();
    });
  }

  /**
   * 表单弹窗 → Promise<values|null>（取消 / 直接关闭返回 null）
   * fields: [{name,label,type,value,placeholder,required,options:[{value,label}],hint,rows,disabled}]
   */
  function promptForm(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function settle(v) { if (settled) return; settled = true; resolve(v); }
      var parts = [];
      (o.fields || []).forEach(function (f) {
        var id = 'pf_' + f.name;
        var input;
        if (f.type === 'select') {
          input = '<select id="' + id + '" data-field="' + esc(f.name) + '">' +
            (f.options || []).map(function (op) {
              return '<option value="' + esc(op.value) + '"' + (String(op.value) === String(f.value === undefined ? '' : f.value) ? ' selected' : '') + '>' + esc(op.label) + '</option>';
            }).join('') + '</select>';
        } else if (f.type === 'textarea') {
          input = '<textarea id="' + id + '" rows="' + (f.rows || 3) + '" data-field="' + esc(f.name) + '" placeholder="' + esc(f.placeholder || '') + '">' + esc(f.value || '') + '</textarea>';
        } else if (f.type === 'checkbox') {
          input = '<label class="inline"><input type="checkbox" id="' + id + '" data-field="' + esc(f.name) + '"' + (f.value ? ' checked' : '') + '> ' + esc(f.checkboxLabel || '是') + '</label>';
        } else {
          input = '<input type="' + (f.type || 'text') + '" id="' + id + '" data-field="' + esc(f.name) + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '"' + (f.disabled ? ' disabled' : '') + '>';
        }
        parts.push('<div class="form-item"' + (f.full ? ' style="grid-column:1/-1"' : '') + '>' +
          '<label for="' + id + '">' + esc(f.label || f.name) + (f.required ? ' <span style="color:#dc2626">*</span>' : '') + '</label>' +
          input + (f.hint ? '<div class="help-text">' + esc(f.hint) + '</div>' : '') + '</div>');
      });
      var bodyHtml = '<div class="form-grid">' + parts.join('') + '</div>' +
        (o.hint ? '<div class="help-text" style="margin-top:10px">' + esc(o.hint) + '</div>' : '') +
        '<div class="inline-error" data-role="err"></div>';

      openModal({
        title: o.title || '填写信息',
        wide: o.wide,
        body: bodyHtml,
        footer: [
          { label: o.cancelText || '取消', cls: 'btn-ghost', onClick: function (api) { settle(null); api.close(); } },
          {
            label: o.okText || '确定',
            cls: o.danger ? 'btn-danger' : '',
            onClick: function (api) {
              var values = {};
              var errEl = api.body.querySelector('[data-role=err]');
              errEl.textContent = '';
              api.body.querySelectorAll('[data-field]').forEach(function (el) {
                values[el.getAttribute('data-field')] = (el.type === 'checkbox') ? el.checked : el.value;
              });
              // 校验
              var bad = null;
              (o.fields || []).forEach(function (f) {
                if (bad) return;
                var v = values[f.name];
                if (f.required && (v === '' || v === undefined || v === null)) bad = '请填写「' + (f.label || f.name) + '」';
                if (!bad && f.validate) {
                  var msg = f.validate(v, values);
                  if (msg) bad = msg;
                }
              });
              if (bad) { errEl.textContent = bad; return; }
              settle(values);
              api.close();
            },
          },
        ],
        onClose: function () { settle(null); },
      });
    });
  }

  // ------------------------------------------------------------ 表格
  /**
   * columns: [{key,label,cls,width,render(row)->html|string}]
   * 返回 HTML 字符串（注意 render 返回的内容视为可信 HTML，需自行 esc）
   */
  function tableHtml(columns, rows, opts) {
    var o = opts || {};
    var head = '<tr>' + columns.map(function (c) {
      return '<th' + (c.cls ? ' class="' + c.cls + '"' : '') + (c.width ? ' style="width:' + c.width + '"' : '') + '>' +
        (c.labelHtml !== undefined ? c.labelHtml : esc(c.label)) + '</th>';
    }).join('') + '</tr>';
    var body = rows.map(function (row, idx) {
      return '<tr' + (o.rowAttrs ? ' ' + o.rowAttrs(row, idx) : '') + '>' + columns.map(function (c) {
        var v = c.render ? c.render(row, idx) : esc(row[c.key]);
        return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + (v === undefined || v === null ? '' : v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="grid"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  /** 分页控件 HTML */
  function pagerHtml(page, pageSize, total) {
    var pages = Math.max(1, Math.ceil(total / pageSize));
    var cur = Math.min(Math.max(1, page), pages);
    var from = total === 0 ? 0 : (cur - 1) * pageSize + 1;
    var to = Math.min(total, cur * pageSize);
    var opts = [10, 20, 50, 100, 200].map(function (n) {
      return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + ' 条/页</option>';
    }).join('');
    return '<div class="pager">' +
      '<span>共 <b>' + total + '</b> 条，当前 ' + from + '–' + to + ' 条</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-pg="first"' + (cur <= 1 ? ' disabled' : '') + '>« 首页</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-pg="prev"' + (cur <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 <b>' + cur + '</b> / ' + pages + ' 页</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-pg="next"' + (cur >= pages ? ' disabled' : '') + '>下一页</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-pg="last"' + (cur >= pages ? ' disabled' : '') + '>末页 »</button>' +
      '<select data-pg="size">' + opts + '</select>' +
      '</div>';
  }

  /** 绑定分页事件，回调 onPage(page, pageSize) */
  function bindPager(container, page, pageSize, total, onPage) {
    var pages = Math.max(1, Math.ceil(total / pageSize));
    var cur = Math.min(Math.max(1, page), pages);
    [['first', 1], ['prev', cur - 1], ['next', cur + 1], ['last', pages]].forEach(function (pair) {
      var btn = container.querySelector('[data-pg="' + pair[0] + '"]');
      if (btn) btn.addEventListener('click', function () { onPage(Math.min(Math.max(1, pair[1]), pages), pageSize); });
    });
    var sel = container.querySelector('[data-pg="size"]');
    if (sel) sel.addEventListener('change', function () { onPage(1, Number(sel.value) || 20); });
  }

  // ------------------------------------------------------------ 横条排行（CSS）
  /** items: [{label, value, right, title}] */
  function barListHtml(items, opts) {
    var o = opts || {};
    var max = Math.max.apply(null, [1].concat(items.map(function (i) { return Number(i.value || 0); })));
    if (o.max) max = Math.max(max, Number(o.max));
    if (!items.length) return emptyHtml({ icon: '📊', title: o.emptyTitle || '暂无数据', hint: o.emptyHint || '' });
    return '<div class="bar-list">' + items.map(function (it) {
      var pct = max > 0 ? Math.round((Number(it.value || 0) / max) * 1000) / 10 : 0;
      return '<div class="bar-row" title="' + esc(it.title || (it.label + '：' + it.value)) + '">' +
        '<div class="bar-label">' + esc(it.label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="bar-value">' + (it.right !== undefined ? it.right : esc(it.value)) + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  // ------------------------------------------------------------ 纯 SVG 折线图
  /**
   * drawLineChart(container, data, opts)
   * data: [{label, value}]  opts: {unit, height, emptyText}
   */
  function drawLineChart(container, data, opts) {
    var o = opts || {};
    var NS = 'http://www.w3.org/2000/svg';
    container.innerHTML = '';
    if (!data || !data.length) {
      container.innerHTML = emptyHtml({ icon: '📈', title: o.emptyText || '所选范围内暂无已确认学时', hint: '换个时间范围或先导入课表' });
      return;
    }
    var W = Math.max(320, container.clientWidth || 720);
    var H = o.height || 240;
    var pad = { l: 52, r: 18, t: 18, b: 40 };
    var iw = W - pad.l - pad.r;
    var ih = H - pad.t - pad.b;
    var values = data.map(function (d) { return Number(d.value || 0); });
    var maxV = Math.max.apply(null, values);
    var minV = Math.min.apply(null, values);
    if (maxV === minV) maxV = maxV + 1;
    var top = Math.max(maxV, 1) * 1.12;
    var bottom = minV > 0 ? Math.max(0, minV * 0.6) : 0;
    function x(i) { return pad.l + (data.length === 1 ? iw / 2 : (iw * i) / (data.length - 1)); }
    function y(v) { return pad.t + ih - ((Number(v) - bottom) / (top - bottom)) * ih; }

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = H + 'px';

    function el(tag, attrs, text) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text !== undefined) n.textContent = text;
      svg.appendChild(n);
      return n;
    }

    // 横向网格与 Y 轴刻度（5 档）
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var vv = bottom + ((top - bottom) * t) / ticks;
      var yy = y(vv);
      el('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, stroke: t === 0 ? '#cbd5e1' : '#eef2f7', 'stroke-width': 1 });
      el('text', { x: pad.l - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#94a3b8' }, num(vv, num(vv) < 10 ? 1 : 0));
    }
    // 面积 + 折线
    var pts = data.map(function (d, i) { return x(i) + ',' + y(d.value); });
    var areaD = 'M ' + x(0) + ',' + y(bottom) + ' L ' + pts.join(' L ') + ' L ' + x(data.length - 1) + ',' + y(bottom) + ' Z';
    el('path', { d: areaD, fill: 'rgba(37,99,235,.10)', stroke: 'none' });
    el('polyline', { points: pts.join(' '), fill: 'none', stroke: '#2563eb', 'stroke-width': 2, 'stroke-linejoin': 'round' });

    // 数据点（带原生 title 悬浮提示）
    data.forEach(function (d, i) {
      var c = el('circle', { cx: x(i), cy: y(d.value), r: data.length > 40 ? 2 : 3.5, fill: '#fff', stroke: '#2563eb', 'stroke-width': 2 });
      var ti = document.createElementNS(NS, 'title');
      ti.textContent = d.label + '：' + num(d.value, 2) + (o.unit || ' 学时');
      c.appendChild(ti);
    });

    // X 轴标签（自动抽稀）
    var step = Math.max(1, Math.ceil(data.length / 9));
    data.forEach(function (d, i) {
      if (i % step !== 0 && i !== data.length - 1) return;
      el('text', {
        x: x(i), y: H - pad.b + 18, 'text-anchor': 'middle', 'font-size': 11, fill: '#94a3b8',
      }, String(d.label).length > 12 ? String(d.label).slice(5) : d.label);
    });

    container.appendChild(svg);
  }

  // ------------------------------------------------------------ 图片查看（附件 / 历史图片预览）
  function openImage(blobUrl, title, filename) {
    var wrap = document.createElement('div');
    wrap.style.textAlign = 'center';
    wrap.innerHTML = '<img src="' + blobUrl + '" style="max-width:100%;max-height:70vh;background:#fff">';
    openModal({
      title: title || '图片预览',
      wide: true,
      body: wrap,
      footer: [
        {
          label: '下载图片', cls: 'btn-ghost', onClick: function () {
            var a = document.createElement('a');
            a.href = blobUrl; a.download = filename || 'image.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          },
        },
        { label: '关闭', onClick: function (api) { api.close(); } },
      ],
    });
  }

  A.ui = {
    esc: esc, fmtDateTime: fmtDateTime, fmtDate: fmtDate, num: num,
    todayStr: todayStr, addDaysStr: addDaysStr,
    STATUS_TEXT: STATUS_TEXT, STATUS_ORDER: STATUS_ORDER,
    SESSION_STATUS_TEXT: SESSION_STATUS_TEXT,
    statusText: statusText, statusTag: statusTag, applyTag: applyTag, disciplineText: disciplineText,
    sessionStatusText: sessionStatusText, sessionStatusTag: sessionStatusTag, flagTag: flagTag,
    toast: toast, alertHtml: alertHtml, alertBox: alertBox,
    emptyHtml: emptyHtml, renderEmpty: renderEmpty, loadingHtml: loadingHtml, errorHtml: errorHtml,
    openDrawer: openDrawer, openModal: openModal, confirm: confirm, promptForm: promptForm,
    tableHtml: tableHtml, pagerHtml: pagerHtml, bindPager: bindPager,
    barListHtml: barListHtml, drawLineChart: drawLineChart, openImage: openImage,
  };
})(window.Admin);
