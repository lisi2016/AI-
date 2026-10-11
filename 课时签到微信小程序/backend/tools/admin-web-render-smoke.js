'use strict';
/**
 * 临时渲染冒烟测试（无浏览器，最小 DOM 桩 + 真实后端同形样例数据）
 *   node kcsq-admin-render-smoke.js            # 新流程会话模式
 *   node kcsq-admin-render-smoke.js --legacy   # /sessions/{id} 404 → 回退 /records/{id}
 * 检查：各页面 render() 无异常；records 列表列/角标、详情抽屉「证据四项」与姓名不符提示；
 *      dashboard 新卡片与新口径；courses 清单行与编辑/归档入口；export 列口径说明；全程无签名图渲染。
 */
const fs = require('fs');
const path = require('path');
const ADMIN = require('path').join(__dirname, '..', 'public', 'admin');
const LEGACY = process.argv.indexOf('--legacy') >= 0;
const RID = 'R00000019';

const ROW = {
  sessionId: RID, id: RID, origin: 'session', term: '2026-2027-1',
  courseId: 'CR00000001', courseCode: 'XXJS001', courseName: '信息技术',
  classId: 'C00000001', className: '2025级护理3班', deptId: 'D00000001', deptName: '护理学院',
  teacherId: 'U00000001', teacherName: '唐瑞明', teacherNo: '2010032',
  teachDate: '2026-09-27', fullDate: '2026-09-27', date: '09-27', section: '1-2',
  startTime: '08:00', endTime: '09:40', time: '08:00–09:40', place: '实训楼A302', hours: 2,
  initiatorId: 'U00000004', initiatorName: '张一鸣', initiatorDuty: '学委', isTempAdjusted: true,
  status: 'done', statusText: '已确认', counted: true,
  confirmedBy: 'U00000001', confirmedName: '李代课', confirmedRole: 'teacher',
  confirmedAt: '2026-09-27T18:06:01+08:00', confirmIp: '110.52.203.127', confirmDevice: 'node',
  confirmNameMismatch: true, absentCount: 1, absentNames: '李思琪', discipline: 'good', disciplineText: '好',
  summary: '第 3 章 数据库基础', note: '', codeId: 'CD00000019', deadline: '2026-09-28T00:00:00+08:00',
  createdAt: '2026-09-27T18:06:01+08:00', updatedAt: '2026-09-27T18:06:01+08:00',
  evidence: { labels: ['动态码', '确认人', '确认时间', '设备'], codeId: 'CD00000019', confirmedName: '李代课', confirmedRole: 'teacher', confirmedAt: '2026-09-27T18:06:01+08:00', device: 'node', ip: '110.52.203.127', nameMismatch: true },
};
const UNREG = Object.assign({}, ROW, {
  id: 'R00000020', sessionId: 'R00000020', teacherId: '', teacherName: '外聘老师', teacherNo: '',
  status: 'wait', statusText: '待教师确认', confirmedName: '', confirmedAt: '', confirmNameMismatch: false, isTempAdjusted: false, counted: false,
  evidence: { labels: ['动态码', '确认人', '确认时间', '设备'], codeId: 'CD00000020', confirmedName: '', confirmedAt: '', device: '' },
});
const COURSE = { id: 'CR00000001', classCourseId: 'CR00000001', classId: 'C00000001', className: '2025级护理3班', deptId: 'D00000001', deptName: '护理学院', courseName: '信息技术', teacherName: '唐瑞明', teacherNo: '', weekday: 7, weekdayText: '周日', section: '1-2', startTime: '08:00', endTime: '09:40', time: '08:00–09:40', place: '实训楼A302', hours: 2, term: '2026-2027-1', status: 'active', statusText: '使用中', archived: false, createdBy: 'U00000004', createdByName: '张一鸣', createdAt: '2026-09-27T18:06:01+08:00', updatedAt: '2026-09-27T18:06:01+08:00' };
const TEACHERS = [
  { teacherId: 'U00000001', id: 'U00000001', name: '唐瑞明', teacherName: '唐瑞明', staffNo: '2010032', deptId: 'D00000001', deptName: '护理学院', registered: true, hours: 18, confirmedHours: 18, makeupHours: 0, expectedHours: 16, completionRate: 112.5, recordCount: 11, tempAdjustedCount: 1, nameMismatchCount: 1 },
  { teacherId: '', id: 'name:外聘老师', name: '外聘老师', teacherName: '外聘老师', staffNo: '', deptId: null, deptName: '', registered: false, hours: 4, confirmedHours: 4, makeupHours: 0, expectedHours: 0, completionRate: 100, recordCount: 2, tempAdjustedCount: 0, nameMismatchCount: 0 },
];
const DEPTS = [{ deptId: 'D00000001', id: 'D00000001', name: '护理学院', hours: 26, confirmedHours: 26, makeupHours: 0, expectedHours: 24, completionRate: 108.3, teacherCount: 2, waiting: 1, tempAdjustedCount: 1, abnormal: 0 }];
const OVERVIEW = { confirmedHours: 34, waiting: 1, pendingCount: 1, expired: 1, abnormal: 2, abnormalCount: 2, makeupHours: 0, rejectedCount: 1, appealingCount: 0, adhocCount: 0, tempAdjustedCount: 1, nameMismatchCount: 1, sessionCount: 2, sessionDoneCount: 1, expectedHours: 32, completionRate: 106.25, totalHours: 32, countedRecords: 17, byStatus: { draft: 0, wait: 1, done: 17, rejected: 1, expired: 1, appealing: 0, makeup: 0, revoked: 0 }, range: {} };
const STATUS_TOTALS = { draft: 0, wait: 1, done: 1, rejected: 0, expired: 0, appealing: 0, makeup: 0, revoked: 0 };

function route(url) {
  if (url.indexOf('/sessions/' + RID) >= 0) {
    if (LEGACY) return null; // 404 → 页面回退 /records/{id}
    return {
      session: ROW, course: COURSE,
      teacher: { id: 'U00000001', role: 'teacher', name: '唐瑞明', no: '2010032' },
      initiator: { id: 'U00000004', role: 'cadre', name: '张一鸣', realName: '张一鸣', studentId: '2025030117', no: '2025030117', classId: 'C00000001', className: '2025级护理3班', duty: '学委' },
      confirmer: { id: 'U00000001', role: 'teacher', name: '李代课', no: '2010032' },
      code: { codeId: 'CD00000019', expireAt: '2026-09-27T18:07:01+08:00', used: true, usedAt: '2026-09-27T18:06:01+08:00', usedBy: 'U00000001' },
      auditTail: [{ action: 'session.create', actor: '张一鸣', at: '2026-09-27T18:06:01+08:00', detail: '班干部发起课时会话并签发动态码' }, { action: 'session.confirm', actor: '李代课', at: '2026-09-27T18:06:01+08:00', detail: '任课教师扫码确认本次课时' }],
    };
  }
  if (url.indexOf('/sessions') >= 0) return { list: [ROW, UNREG], total: 2, page: 1, pageSize: 20, summary: { hours: 2, byStatus: { done: 1, wait: 1 }, statusTotals: STATUS_TOTALS, tempAdjustedCount: 1, nameMismatchCount: 1 } };
  if (url.indexOf('/records/' + RID) >= 0) return Object.assign({}, ROW, { signatureFileId: 'SG00000001', imageHash: 'ab'.repeat(32), signedAt: '2026-09-27T18:05:00+08:00', device: 'node', evidence: { count: 4, labels: ['签名图', '确认时间', '设备', '动态码'], signatureFileId: 'SG00000001', confirmedAt: ROW.confirmedAt, device: 'node', codeId: 'CD00000019' }, auditTail: [] });
  if (url.indexOf('/records') >= 0) return { list: [ROW], total: 1, page: 1, pageSize: 20, summary: { hours: 2, byStatus: { done: 1 }, statusTotals: STATUS_TOTALS } };
  if (url.indexOf('/stats/overview') >= 0) return OVERVIEW;
  if (url.indexOf('/stats/by-dept') >= 0) return { list: DEPTS, total: 1, totalHours: 26, totalExpectedHours: 24, stats: DEPTS };
  if (url.indexOf('/stats/by-teacher') >= 0) return { list: TEACHERS, rank: TEACHERS, total: 2, totalHours: 34 };
  if (url.indexOf('/stats/trend') >= 0) return { list: [{ label: '2026-W39', hours: 12 }, { label: '2026-W40', hours: 22 }], totalHours: 34 };
  if (url.indexOf('/class-courses') >= 0) return { list: [COURSE], total: 1, page: 1, pageSize: 20, summary: { total: 1, active: 1, archived: 0 } };
  if (url.indexOf('/config') >= 0) return { config: { term: '2026-2027-1' }, terms: ['2026-2027-1'], list: [] };
  if (url.indexOf('/logs') >= 0) return { list: [{ createdAt: '2026-09-27T18:06:01+08:00', actorName: '张一鸣', actorRole: 'cadre', action: 'session.create', detail: '班干部发起课时会话并签发动态码', ip: '110.52.203.127', device: 'node' }], total: 1, chain: { ok: true } };
  if (url.indexOf('/makeup') >= 0) return { list: [], total: 0, pending: 0 };
  if (url.indexOf('/appeal') >= 0) return { list: [], total: 0 };
  if (url.indexOf('/export/history') >= 0) return { list: [], total: 0 };
  if (url.indexOf('/import/history') >= 0) return { list: [], total: 0 };
  return {};
}

// ---------------------------------------------------------------- 最小 DOM 桩
function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], attrs: {}, style: {}, _html: '', _text: '', _value: '', _checked: false, _hidden: false,
    _q: {}, _qsAll: {}, _handlers: {}, disabled: false, title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute() {}, appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {}, click() {}, focus() {}, scrollIntoView() {},
    /** 只对详情按钮返回一个假按钮，便于触发「查看详情」 */
    querySelectorAll(sel) {
      if (!this._qsAll[sel]) {
        if (sel === '[data-view]') {
          const b = makeNode('button');
          b.attrs['data-view'] = RID;
          this._qsAll[sel] = [b];
        } else this._qsAll[sel] = [];
      }
      return this._qsAll[sel];
    },
    querySelector(sel) { if (!this._q[sel]) this._q[sel] = makeNode('div'); return this._q[sel]; },
    get parentNode() { return null; },
  };
  Object.defineProperty(node, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); } });
  Object.defineProperty(node, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); } });
  Object.defineProperty(node, 'value', { get() { return this._value; }, set(v) { this._value = String(v); } });
  Object.defineProperty(node, 'checked', { get() { return this._checked; }, set(v) { this._checked = !!v; } });
  Object.defineProperty(node, 'hidden', { get() { return this._hidden; }, set(v) { this._hidden = !!v; } });
  return node;
}
const doc = {
  addEventListener() {}, getElementById() { return makeNode('div'); }, querySelector() { return makeNode('div'); },
  querySelectorAll() { return []; }, createElement(t) { return makeNode(t); }, createElementNS(ns, t) { return makeNode(t); },
  body: makeNode('body'),
};

let drawer = null;
const sandbox = {
  console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Number, String, Object, Array, Error,
  isFinite, parseInt, parseFloat, document: doc, location: { hash: '', href: '' },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  fetch: (url) => {
    const data = route(String(url));
    const headers = { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : '') };
    if (data === null) {
      return Promise.resolve({ ok: false, status: 404, headers, json: () => Promise.resolve({ code: 40401, msg: '接口不存在：GET /api/v1/sessions/' + RID }), text: () => Promise.resolve('{"code":40401}') });
    }
    return Promise.resolve({
      ok: true, status: 200, headers,
      json: () => Promise.resolve({ code: 0, msg: 'ok', data }),
      text: () => Promise.resolve(JSON.stringify({ code: 0, data })),
      blob: () => Promise.resolve({ size: 10, type: 'text/csv' }),
    });
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: function () {}, FormData: function () { this.append = function () {}; },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { userAgent: 'node' },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;

const vm = require('vm');
vm.createContext(sandbox);
['js/api.js', 'js/ui.js', 'js/app.js'].forEach((rel) => vm.runInContext(fs.readFileSync(path.join(ADMIN, rel), 'utf8'), sandbox, { filename: rel }));
const A = sandbox.Admin;

// 捕获详情抽屉：替换 openDrawer，记录 body 节点
A.ui.openDrawer = function (opts) {
  drawer = { title: opts.title, body: makeNode('div'), setTitle(t) { this.title = t; }, close() {} };
  if (typeof opts.body === 'string') drawer.body.innerHTML = opts.body;
  return drawer;
};

const pages = {};
const orig = A.registerPage;
A.registerPage = function (id, def) { pages[id] = def; orig(id, def); };
A.api.setSession('test-token', { name: '教务处', role: 'admin' }, 'ADMIN001', false);
['login', 'dashboard', 'records', 'courses', 'makeup', 'appeal', 'import', 'export', 'config', 'logs']
  .forEach((p) => vm.runInContext(fs.readFileSync(path.join(ADMIN, 'js', 'pages', p + '.js'), 'utf8'), sandbox, { filename: p + '.js' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function report(name, html, want, dontWant, extra) {
  const missing = (want || []).filter((w) => html.indexOf(w) < 0);
  const banned = (dontWant || []).filter((w) => (w instanceof RegExp ? w.test(html) : html.indexOf(w) >= 0));
  const okFlag = missing.length === 0 && banned.length === 0 && html.length > 100;
  if (!okFlag) bad++;
  console.log((okFlag ? '  [OK]   ' : '  [FAIL] ') + name + '  ' + html.length + ' 字符' + (extra ? ' · ' + extra : '') +
    (missing.length ? ' · 缺少: ' + missing.join(' / ') : '') +
    (banned.length ? ' · 不该出现: ' + banned.map(String).join(' / ') : ''));
}

(async () => {
  console.log('渲染冒烟（' + (LEGACY ? '旧流程回退模式' : '新流程会话模式') + '）');

  // ---------- 课时明细
  const recEl = makeNode('main');
  try {
    pages.records.render({ el: recEl, params: {}, user: { role: 'admin' }, role: 'admin', state: { config: {} }, navigate() {}, refresh() {} });
    await sleep(200);
  } catch (e) { bad++; console.log('  [FAIL] records.js render 异常：' + ((e && e.stack) || e)); }
  const listNode = recEl._q['#list-body'];
  report('课时明细·列表', (listNode && listNode.innerHTML) || '',
    ['实际授课人', '发起人（学委）', '确认人', '临时调整', '姓名不符', 'tag-temp', 'tag-mismatch', '非系统内', '已确认', '待教师确认', '张一鸣', '学委', '查看详情'],
    [/\bsignatureFileId\b/, 'signature-box', /<img/],
    '新列 + 角标 + 状态文案');
  report('课时明细·筛选区', (recEl._q['#f-wrap'] && recEl._q['#f-wrap'].innerHTML) || '',
    ['实际授课人（按姓名）', '关键字（课程/教学班/授课人/发起人/确认人）', '是否临时调整', '姓名不符（确认人≠实际授课人）', '待教师确认', '已过期', 'data-cnt'],
    null, '含 statusTotals 角标位与新增筛选');

  // ---------- 详情抽屉：触发「查看详情」
  const btns = listNode && listNode._qsAll['[data-view]'];
  const handler = btns && btns[0] && btns[0]._handlers.click && btns[0]._handlers.click[0];
  if (handler) {
    try { handler({ stopPropagation() {}, target: { tagName: 'BUTTON' } }); await sleep(200); } catch (e) { bad++; console.log('  [FAIL] 详情点击异常：' + ((e && e.stack) || e)); }
  } else { bad++; console.log('  [FAIL] 未绑定「查看详情」事件'); }
  report('课时详情·抽屉', (drawer && drawer.body.innerHTML) || '',
    ['授课信息', '实际授课人', '证据四项', '动态码', '确认人', '确认时间', '设备', '发起人（学委）', '确认信息', '状态流转', '操作日志', '确认人与实际授课人不一致']
      .concat(LEGACY ? [] : ['课程清单快照']),
    [/\bsignatureFileId\b/, 'signature-box', /<img/],
    LEGACY ? '旧流程回退（GET /records/{id}）' : '新流程（GET /sessions/{id}），含姓名不符醒目提示');

  // ---------- 学时看板
  const dashEl = makeNode('main');
  try {
    pages.dashboard.render({ el: dashEl, params: {}, user: { role: 'admin' }, role: 'admin', state: { config: {} }, navigate() {}, refresh() {} });
    await sleep(250);
  } catch (e) { bad++; console.log('  [FAIL] dashboard.js render 异常：' + ((e && e.stack) || e)); }
  report('学时看板', (dashEl._q['#dash-body'] && dashEl._q['#dash-body'].innerHTML) || '',
    ['临时调整', '姓名不符', '课时会话', '已确认 1', '实际授课人', '非系统内', 'tag-temp', 'tag-mismatch', '所属院系归属'],
    null, '新增 4 张卡片 + 按实际授课人口径');

  // ---------- 课程清单
  const cEl = makeNode('main');
  try {
    pages.courses.render({ el: cEl, params: {}, user: { role: 'admin' }, role: 'admin', state: { config: {} }, navigate() {}, refresh() {} });
    await sleep(250);
  } catch (e) { bad++; console.log('  [FAIL] courses.js render 异常：' + ((e && e.stack) || e)); }
  report('课程清单页', (cEl._q['#c-list'] && cEl._q['#c-list'].innerHTML) || '',
    ['信息技术', '唐瑞明', '2025级护理3班', '周日', '实训楼A302', '使用中', '张一鸣', '编辑', '归档', '课时明细'],
    null, '清单行 + 编辑/归档入口');
  report('课程清单·筛选与摘要', (cEl._q['#c-filters'] && cEl._q['#c-filters'].innerHTML) || '',
    ['班级', '关键词（课程 / 授课老师 / 地点 / 班级）', '状态', '使用中（默认）', '仅已归档'],
    null, '班级/关键词/状态筛选');

  // ---------- 导出中心
  const xEl = makeNode('main');
  try {
    pages.export.render({ el: xEl, params: {}, user: { role: 'admin' }, role: 'admin', state: { config: {} }, navigate() {}, refresh() {} });
    await sleep(200);
  } catch (e) { bad++; console.log('  [FAIL] export.js render 异常：' + ((e && e.stack) || e)); }
  report('导出中心', xEl.innerHTML || '',
    ['教师姓名（= 实际授课人）', '发起人（学委）', '发起人职务', '确认人', '是否临时调整', '确认人与实际授课人不符', '不含签名图 URL 列', '21 列表头'],
    null, '21 列固定表头（与后端 EXPORT_HEADERS 一致）与列口径说明');

  // ---------- 其余页面：渲染无异常、HTML 非空（补签 / 申诉页本次也调整了证据区）
  for (const id of ['makeup', 'appeal', 'import', 'config', 'logs']) {
    const node = makeNode('main');
    try {
      pages[id].render({ el: node, params: {}, user: { role: 'admin' }, role: 'admin', state: { config: {} }, navigate() {}, refresh() {} });
      await sleep(150);
      const html = node.innerHTML || '';
      const okFlag = html.length > 100;
      if (!okFlag) bad++;
      console.log((okFlag ? '  [OK]   ' : '  [FAIL] ') + id + '.js 渲染 ' + html.length + ' 字符 · 无运行期异常');
    } catch (e) {
      bad++;
      console.log('  [FAIL] ' + id + '.js render 异常：' + ((e && e.stack) || e));
    }
  }

  console.log(bad ? ('\n渲染冒烟：' + bad + ' 项异常') : '\n渲染冒烟：全部通过（无运行期异常、关键内容齐备、无签名图渲染）');
  process.exit(bad ? 1 : 0);
})();
