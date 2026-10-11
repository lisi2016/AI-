'use strict';
/**
 * 小程序端自测脚本（Node 18+，零依赖，不需要微信开发者工具）
 *
 * 用法：
 *   node tools/miniapp-selftest.js          # 在项目根目录执行（课时签到微信小程序/）
 *
 * 覆盖三块：
 *   1) utils/qrcode.js —— 纯 JS 二维码编码器
 *      · RS 分块表与 ISO/IEC 18004 的"原始模块数"公式交叉校验（数据+纠错 = 总码字）
 *      · 结构校验：定位图形 / 分隔符 / 定时图形 / 对齐图形 / 固定黑模块 / 格式信息（BCH 双份一致）
 *      · 反解校验（独立实现掩码、之字形读取、分块解交织、RS 长除法）：解出的文本必须等于原文
 *   2) utils/code-parse.js —— 扫码结果 / 页面入参解析（A 二维码载荷、B 6 位口令、历史载荷兼容）
 *   3) 页面链路（wx / Page / getApp 桩，业务流程简化后的新流程）：
 *      班干部首页「今日课程」→ 点「出示二维码」→ POST /sessions 取 code + qrPayload →
 *      canvas 绘制二维码 → 教师扫码/输口令 → 跳课时确认页 → /code/verify(isSession) →
 *      点「确认本次课时」→ /sessions/{id}/confirm 成功；
 *      过期 41001 / 已使用 41002 / 无效 40401 的中文提示与「让班干部刷新」引导；
 *      旧课表码（isSession=false）不再走填表 / 手写签名路径。
 *      更完整的课程清单 CRUD / 临时调整 / 记录页与详情用例见 tools/miniapp-session-selftest.js。
 *
 * 说明：本脚本用内存桩替代 wx，不改动任何线上代码；所有断言数最后统一汇总。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const qrcode = require(path.join(ROOT, 'miniprogram/utils/qrcode.js'));
const codeParse = require(path.join(ROOT, 'miniprogram/utils/code-parse.js'));

let pass = 0;
let failCount = 0;
const failures = [];

function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
/** 与 backend/tools/*.js 保持一致的口径：check(条件, 名称, 补充说明) */
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail === undefined ? '断言失败' : detail); return !!cond; }
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ================================================================ 1. 二维码编码器
section('1. utils/qrcode.js · 纯 JS 二维码编码器');

// ---- 1.1 RS 分块表 vs ISO 公式
{
  let mismatch = [];
  for (let v = 1; v <= qrcode.MAX_VERSION; v++) {
    const total = qrcode.totalCodewordCount(v);
    qrcode.ECC_ORDER.forEach(function (ecc) {
      const t = qrcode.RS_BLOCKS[v][ecc];
      const blocks = t[1] + t[3];
      const sum = t[1] * t[2] + t[3] * t[4] + blocks * t[0];
      if (sum !== total) mismatch.push('v' + v + '-' + ecc + ' ' + sum + '≠' + total);
    });
  }
  check(mismatch.length === 0, 'RS 分块表与 ISO 原始模块数公式一致（版本 1–10 × L/M/Q/H 共 40 组）',
    mismatch.length ? mismatch.join(' / ') : '数据码字 + 纠错码字 = 总码字');
}

// ---- 1.2 结构校验所需的最小解码工具（独立实现，不复用编码器内部函数）
function makeFunctionMap(version) {
  const size = version * 4 + 17;
  const fn = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(false);
    fn.push(row);
  }
  // 定时图形
  for (let i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }
  // 三个角：定位图形 + 分隔符 + 格式信息条（9×9 / 9×8 / 8×9）
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) fn[y][x] = true;
  for (let y = 0; y <= 8; y++) for (let x = size - 8; x < size; x++) fn[y][x] = true;
  for (let y = size - 8; y < size; y++) for (let x = 0; x <= 8; x++) fn[y][x] = true;
  // 对齐图形
  const pos = qrcode.alignmentPositions(version);
  const n = pos.length;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) fn[pos[b] + dy][pos[a] + dx] = true;
      }
    }
  }
  // 版本信息（版本 ≥ 7）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fn[b][a] = true;
      fn[a][b] = true;
    }
  }
  return fn;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

/** 独立实现：从矩阵反解出数据码字（先按掩码还原，再之字形读取）
 *  注意：跳过第 6 列（定时图形）时必须直接改写循环变量，否则第 4 列会被读两遍。
 */
function extractCodewords(qrObj) {
  const n = qrObj.size;
  const fn = makeFunctionMap(qrObj.version);
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;   // 跳过定时图形所在列
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (fn[y][x]) continue;
        let bit = qrObj.modules[y][x];
        if (maskBit(qrObj.mask, x, y)) bit ^= 1;
        bits.push(bit);
      }
    }
  }
  const total = qrcode.totalCodewordCount(qrObj.version);
  const out = [];
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] || 0);
    out.push(v);
  }
  return out;
}

/** 独立实现：GF(256) 长除法算纠错码字 */
const GF_EXP = [];
const GF_LOG = [];
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
})();
function gmul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }
function genPoly(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], GF_EXP[i]); }
    g = ng;
  }
  return g;
}
function longDivisionEc(data, deg) {
  const g = genPoly(deg);
  const buf = data.concat(new Array(deg).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (c === 0) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= gmul(g[j], c);
  }
  return buf.slice(data.length);
}
/** 校验子：合法 RS 码字在 α^0..α^(deg-1) 上求值全为 0（系数按最高次在前） */
function syndromes(code, deg) {
  const n = code.length;
  const res = [];
  for (let j = 0; j < deg; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s ^= gmul(code[i], GF_EXP[(j * (n - 1 - i)) % 255]);
    res.push(s);
  }
  return res;
}

/** 反解并校验整张二维码 */
function decodeQr(qrObj) {
  const layout = qrcode.blockLayout(qrObj.version, qrObj.ecc);
  const seq = extractCodewords(qrObj);
  const dataLens = layout.map(function (l) { return l[1]; });
  const ecLen = layout[0][0];
  const maxData = Math.max.apply(null, dataLens);
  let pos = 0;
  const datas = layout.map(function () { return []; });
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < layout.length; b++) {
      if (i < dataLens[b]) datas[b].push(seq[pos++]);
    }
  }
  const ecs = layout.map(function () { return []; });
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < layout.length; b++) ecs[b].push(seq[pos++]);
  }
  // 逐块：独立长除法复算纠错码字 + 校验子为 0
  let ecOk = true;
  let synOk = true;
  for (let b = 0; b < layout.length; b++) {
    const expect = longDivisionEc(datas[b], ecLen);
    if (expect.join(',') !== ecs[b].join(',')) ecOk = false;
    if (syndromes(datas[b].concat(ecs[b]), ecLen).some(function (v) { return v !== 0; })) synOk = false;
  }
  // 拼回数据码字 → 解析模式 / 长度 / 字节
  const dataCodewords = [];
  datas.forEach(function (d) { d.forEach(function (v) { dataCodewords.push(v); }); });
  const bits = [];
  dataCodewords.forEach(function (b) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  });
  const mode = parseInt(bits.slice(0, 4).join(''), 2);
  const countBits = qrObj.version <= 9 ? 8 : 16;
  const count = parseInt(bits.slice(4, 4 + countBits).join(''), 2);
  const bytes = [];
  for (let i = 0; i < count; i++) {
    const off = 4 + countBits + i * 8;
    bytes.push(parseInt(bits.slice(off, off + 8).join(''), 2));
  }
  return {
    mode: mode,
    count: count,
    text: Buffer.from(bytes).toString('utf8'),
    ecOk: ecOk,
    synOk: synOk,
    blocks: layout.length,
    seqLen: seq.length,
  };
}

// ---- 1.3 结构校验函数
function checkFinderPatterns(q) {
  const n = q.size;
  const m = q.modules;
  const corners = [[0, 0], [n - 7, 0], [0, n - 7]];
  for (let c = 0; c < corners.length; c++) {
    const ox = corners[c][0];
    const oy = corners[c][1];
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        const expect = dist !== 2 ? 1 : 0;
        if (m[oy + dy][ox + dx] !== expect) return false;
      }
    }
  }
  return true;
}

function checkSeparators(q) {
  const n = q.size;
  const m = q.modules;
  for (let i = 0; i < 8; i++) {
    if (m[7][i] !== 0 || m[i][7] !== 0) return false;             // 左上
    if (m[7][n - 1 - i] !== 0 || m[i][n - 8] !== 0) return false; // 右上
    if (m[n - 8][i] !== 0 || m[n - 1 - i][7] !== 0) return false; // 左下
  }
  return true;
}

function checkTiming(q) {
  const n = q.size;
  const m = q.modules;
  for (let i = 8; i <= n - 9; i++) {
    const expect = i % 2 === 0 ? 1 : 0;
    if (m[6][i] !== expect) return false;
    if (m[i][6] !== expect) return false;
  }
  return true;
}

function checkAlignment(q) {
  if (q.version < 2) return true;
  const n = q.size;
  const m = q.modules;
  const pos = qrcode.alignmentPositions(q.version);
  const cnt = pos.length;
  for (let a = 0; a < cnt; a++) {
    for (let b = 0; b < cnt; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === cnt - 1) || (a === cnt - 1 && b === 0)) continue;
      const cx = pos[a];
      const cy = pos[b];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const expect = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
          if (m[cy + dy][cx + dx] !== expect) return false;
        }
      }
    }
  }
  return n > 0;
}

function readFormatValue(q) {
  const n = q.size;
  const m = q.modules;
  let v = 0;
  const bit = function (x, y, i) { if (m[y][x] === 1) v |= (1 << i); };
  for (let i = 0; i <= 5; i++) bit(8, i, i);
  bit(8, 7, 6);
  bit(8, 8, 7);
  bit(7, 8, 8);
  for (let i = 9; i < 15; i++) bit(14 - i, 8, i);
  return v;
}

function readFormatValueCopy2(q) {
  const n = q.size;
  const m = q.modules;
  let v = 0;
  for (let i = 0; i < 8; i++) if (m[8][n - 1 - i] === 1) v |= (1 << i);
  for (let i = 8; i < 15; i++) if (m[n - 15 + i][8] === 1) v |= (1 << i);
  return v;
}

/** 格式信息 = (data<<10 | BCH) ^ 0x5412，独立复算 */
function expectedFormatValue(ecc, mask) {
  const eccBits = { L: 1, M: 0, Q: 3, H: 2 }[ecc];
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const PAYLOAD = 'kcsq://code/CD00000001';
const qrMain = qrcode.encode(PAYLOAD);
check(qrMain.size === qrMain.version * 4 + 17,
  '矩阵边长 = 版本×4+17', 'version=' + qrMain.version + ' size=' + qrMain.size + ' ecc=' + qrMain.ecc + ' mask=' + qrMain.mask);
check(qrMain.version === 2 && qrMain.bytes === PAYLOAD.length,
  '内容 "' + PAYLOAD + '"（' + PAYLOAD.length + ' 字节）自动选到版本 2-L', 'version=' + qrMain.version);
check(checkFinderPatterns(qrMain), '三个定位图形（7×7）正确');
check(checkSeparators(qrMain), '定位图形分隔符（白色一圈）正确');
check(checkTiming(qrMain), '定时图形（第 6 行 / 第 6 列交替）正确');
check(checkAlignment(qrMain), '对齐图形（版本 ≥ 2）正确');
check(qrMain.modules[qrMain.size - 8][8] === 1, '固定黑模块 (8, size-8) 为黑');
{
  const v1 = readFormatValue(qrMain);
  const v2 = readFormatValueCopy2(qrMain);
  check(v1 === v2, '格式信息两份副本一致', '0x' + v1.toString(16));
  check(v1 === expectedFormatValue(qrMain.ecc, qrMain.mask),
    '格式信息与独立复算的 BCH(15,5) 结果一致（含纠错等级与掩码号）',
    '0x' + v1.toString(16) + ' / mask=' + qrMain.mask);
}
{
  const d = decodeQr(qrMain);
  check(d.mode === 4, '反解模式指示符 = 0100（字节模式）', 'mode=' + d.mode);
  check(d.count === PAYLOAD.length, '反解字符计数正确', d.count + ' 字节');
  check(d.text === PAYLOAD, '反解文本与原文完全一致（掩码/之字形/交织均正确）', JSON.stringify(d.text));
  check(d.ecOk, '逐块纠错码字与独立长除法结果一致', d.blocks + ' 块');
  check(d.synOk, 'RS 校验子在 α^0..α^(n-1) 上全为 0（可纠错码字合法）');
}

// ---- 1.4 各纠错等级 / 中文 / 强制掩码
{
  const cases = [
    ['L', 'kcsq://code/CD00000001'],
    ['M', 'kcsq://code/CD00000001'],
    ['Q', 'kcsq://code/CD00000001'],
    ['H', 'kcsq://code/CD00000001'],
    ['H', '课时确认动态码：2025级药学1班 张一鸣'],
  ];
  let allOk = true;
  const detail = [];
  cases.forEach(function (c) {
    const q = qrcode.encode(c[1], { ecc: c[0] });
    const d = decodeQr(q);
    const good = d.text === c[1] && d.ecOk && d.synOk && d.mode === 4;
    if (!good) allOk = false;
    detail.push(c[0] + '-v' + q.version + (good ? '✓' : '✗'));
  });
  check(allOk, '纠错等级 L/M/Q/H 与中文（UTF-8）内容均可反解还原', detail.join(' '));
}
{
  const masks = [];
  let allOk = true;
  for (let m = 0; m < 8; m++) {
    const q = qrcode.encode(PAYLOAD, { mask: m });
    const d = decodeQr(q);
    const good = q.mask === m && d.text === PAYLOAD;
    if (!good) allOk = false;
    masks.push(m + (good ? '✓' : '✗'));
  }
  check(allOk, '强制 8 种掩码（mask 0–7）均可正确反解', masks.join(' '));
}
{
  let threw = false;
  try {
    qrcode.encode('x'.repeat(4000), { ecc: 'H' });
  } catch (e) { threw = /内容过长/.test(e.message); }
  check(threw, '内容超出容量时抛出明确错误（不产生坏矩阵）');
}
check(qrcode.toText(qrMain, { quietZone: 0 }).split('\n').length === qrMain.size,
  'toText 输出的行数等于模块边长', qrMain.size + ' 行');
// ================================================================ 2. 入参解析
section('2. utils/code-parse.js · A 扫码 / B 口令 入参解析');
{
  const p1 = codeParse.parseCodeInput('kcsq://code/CD00000001');
  check(p1 && p1.codeId === 'CD00000001' && p1.kind === 'qr', 'A 通道：kcsq://code/<codeId> → codeId', JSON.stringify(p1));
  const p2 = codeParse.parseCodeInput('kcsq://confirm?codeId=CD00000007&sign=x&exp=1');
  check(p2 && p2.codeId === 'CD00000007' && p2.kind === 'legacy', '兼容历史载荷 kcsq://confirm?codeId=..', JSON.stringify(p2));
  const p3 = codeParse.parseCodeInput('https://kcsq.example.cn/c?codeId=CD00000009');
  check(p3 && p3.codeId === 'CD00000009' && p3.kind === 'url', '兼容带 codeId 参数的普通链接', JSON.stringify(p3));
  const p4 = codeParse.parseCodeInput('042317');
  check(p4 && p4.code === '042317' && !p4.codeId && p4.kind === 'code', 'B 通道：6 位数字口令 → code', JSON.stringify(p4));
  const p5 = codeParse.parseCodeInput('CD00000012');
  check(p5 && p5.codeId === 'CD00000012' && p5.kind === 'codeId', '裸 codeId → codeId', JSON.stringify(p5));
  check(codeParse.parseCodeInput('https://example.com/hello') === null, '无关链接 → null（页面提示重扫）');
  check(codeParse.parseCodeInput('  ') === null, '空白内容 → null');
  check(codeParse.isPassCode('000000') && codeParse.isPassCode('123456') &&
    !codeParse.isPassCode('12345') && !codeParse.isPassCode('1234567') && !codeParse.isPassCode('abcdef'),
    '口令判定严格为「恰好 6 位数字」');

  const b1 = codeParse.buildVerifyInput({ codeId: 'CD00000002' });
  check(b1.codeId === 'CD00000002' && b1.by === 'codeId', '页面入参 ?codeId= → {codeId}', JSON.stringify(b1));
  const b2 = codeParse.buildVerifyInput({ code: '042317' });
  check(b2.code === '042317' && b2.by === 'code', '页面入参 ?code=042317 → {code}', JSON.stringify(b2));
  const b3 = codeParse.buildVerifyInput({ qrContent: 'kcsq://code/CD00000003' });
  check(b3.codeId === 'CD00000003' && b3.by === 'qrContent', '页面入参 ?qrContent= → {codeId}', JSON.stringify(b3));
  const b4 = codeParse.buildVerifyInput({});
  check(b4.invalid === true, '无任何动态码入参 → 标记 invalid（页面给出明确提示）', JSON.stringify(b4));

  const q = codeParse.toCreateQuery(codeParse.parseCodeInput('kcsq://code/CD00000004'));
  check(q === 'codeId=CD00000004', 'toCreateQuery 生成 /pages/create 查询串', q);
  const q2 = codeParse.toCreateQuery(codeParse.parseCodeInput('042317'));
  check(q2 === 'code=042317', '口令通道生成 /pages/create?code=..', q2);
}

// ================================================================ 3. wx / Page 桩 + 页面链路
section('3. 页面链路（wx / Page / getApp 桩：今日课程 → 出示二维码 → 扫码/口令 → 课时确认）');

const wxCalls = {
  toasts: [], modals: [], navigations: [], clipboard: [], canvas: [], scan: 0,
};
const storage = {};
let modalQueue = [];      // 预置的 showModal 回调结果
let scanResult = '';      // 预置的 wx.scanCode 结果
let scanFail = null;

function resetWxCalls() {
  wxCalls.toasts = [];
  wxCalls.modals = [];
  wxCalls.navigations = [];
  wxCalls.clipboard = [];
  wxCalls.canvas = [];
  wxCalls.scan = 0;
}

/** 极简 canvas 2d 上下文桩：记录每一次 fillRect，用于校验真的画了二维码 */
function makeCanvasContext(id) {
  const ops = { id: id, fills: [], colors: [], draws: 0 };
  wxCalls.canvas.push(ops);
  return {
    setFillStyle: function (c) { ops.colors.push(c); },
    fillRect: function (x, y, w, h) { ops.fills.push([x, y, w, h]); },
    draw: function () { ops.draws++; },
    setStrokeStyle: function () {},
    stroke: function () {},
  };
}

const appStub = {
  globalData: {
    role: '',
    user: null,
    token: '',
    needBind: true,
    bindHint: '',
    useMock: true,       // 桩里强制走 mock，避免真实网络请求
    apiBase: '',
    config: null,
  },
  setRole: function (r) { this.globalData.role = r; },
  // 页面会 await app.ready() 等启动校验（/auth/me）完成
  ready: function () { return Promise.resolve({ role: this.globalData.role, user: this.globalData.user }); },
};

/**
 * 模拟「已完成微信绑定并登录」：token / user / role 同时写入 storage 与 globalData。
 * 页面一律取 globalData 的真实身份，不再用 mock 身份当登录者，
 * 所以桩必须真的造出登录态（storage 里有 token），否则首页会走「去绑定」引导。
 */
function loginAs(role, user) {
  storage.token = 'mock-token';
  storage.role = role;
  storage.user = user;
  appStub.globalData.token = 'mock-token';
  appStub.globalData.role = role;
  appStub.globalData.user = user;
  appStub.globalData.needBind = false;
}

global.getApp = function () { return appStub; };
global.wx = {
  getSystemInfoSync: function () { return { windowWidth: 375, brand: 'Apple', model: 'iPhone 13' }; },
  getStorageSync: function (k) { return storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  showToast: function (o) { wxCalls.toasts.push(o); },
  showModal: function (o) {
    wxCalls.modals.push(o);
    const next = modalQueue.shift();
    if (next && typeof o.success === 'function') o.success(next);
    else if (typeof o.success === 'function' && o.showCancel === false) o.success({ confirm: true });
  },
  navigateTo: function (o) { wxCalls.navigations.push({ type: 'navigateTo', url: o.url }); if (o.success) o.success(); },
  navigateBack: function (o) { wxCalls.navigations.push({ type: 'navigateBack', delta: (o && o.delta) || 1 }); if (o && o.success) o.success(); },
  redirectTo: function (o) { wxCalls.navigations.push({ type: 'redirectTo', url: o.url }); },
  reLaunch: function (o) { wxCalls.navigations.push({ type: 'reLaunch', url: o.url }); },
  switchTab: function (o) { wxCalls.navigations.push({ type: 'switchTab', url: o.url }); },
  setClipboardData: function (o) { wxCalls.clipboard.push(o.data); if (o.success) o.success(); },
  setNavigationBarTitle: function () {},
  createCanvasContext: function (id) { return makeCanvasContext(id); },
  login: function (o) { if (o && o.success) o.success({ code: 'stub-login-code' }); },
  scanCode: function (o) {
    wxCalls.scan++;
    if (scanFail) { if (o.fail) o.fail(scanFail); return; }
    if (o.success) o.success({ result: scanResult });
  },
  request: function () { throw new Error('桩测试不应发出真实网络请求'); },
  uploadFile: function () { throw new Error('桩测试不应发出真实上传请求'); },
  downloadFile: function (o) { if (o && o.fail) o.fail({ errMsg: 'stub: no download' }); },
};

let captured = null;
global.Page = function (cfg) { captured = cfg; };

function loadPage(rel) {
  captured = null;
  delete require.cache[require.resolve(path.join(ROOT, rel))];
  require(path.join(ROOT, rel));
  const cfg = captured;
  const page = {};
  Object.keys(cfg).forEach(function (k) { page[k] = cfg[k]; });
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  // 支持 'form.courseName' 这类嵌套路径（与微信 setData 语义一致）
  page.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) {
      if (k.indexOf('.') < 0) { page.data[k] = patch[k]; return; }
      const parts = k.split('.');
      let cur = page.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = patch[k];
    });
    if (typeof cb === 'function') cb();
  };
  return page;
}

let indexPage = null;
let createPage = null;

async function main() {
  const api = require(path.join(ROOT, 'miniprogram/utils/api.js'));
  const mockData = require(path.join(ROOT, 'miniprogram/utils/mock.js'));
  const shapeMod = require(path.join(ROOT, 'miniprogram/utils/shape.js'));

  // ---- 3.1 班干部：今日课程 → 点「出示二维码」拿到 code + qrPayload 并真正绘制二维码
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);
  indexPage = loadPage('miniprogram/pages/index/index.js');
  resetWxCalls();
  indexPage.onLoad({});
  check(indexPage.data.qrSize >= 180 && Number.isInteger(indexPage.data.qrSize),
    'canvas 边长按屏宽算出整数 px（避免真机半像素缝隙）', indexPage.data.qrSize + 'px');
  indexPage.onShow();
  await sleep(800);
  check(indexPage.data.needBind === false, '已绑定身份时不显示「去绑定」引导', 'needBind=' + indexPage.data.needBind);
  check(indexPage.data.courses.length >= 2,
    'GET /class-courses/today 渲染今日课程（无需重复录入）', indexPage.data.courses.length + ' 门');

  const course = indexPage.data.courses[0];
  resetWxCalls();
  indexPage.presentCode({ currentTarget: { dataset: { id: course.id } } });
  await sleep(600);
  const gen = JSON.parse(JSON.stringify(indexPage.data));   // 快照：后续刷新不应改变本次断言对象
  check(gen.panel.show === true && gen.panel.courseName === course.courseName,
    '点「出示二维码」→ POST /sessions 从课程清单带出本次课时', gen.panel.courseName + ' / ' + gen.panel.teacherName);
  check(/^\d{6}$/.test(String(gen.code)), '班干部端拿到 6 位数字口令（B 通道）', 'code=' + gen.code);
  check(gen.qrPayload === 'kcsq://code/' + gen.codeId, '班干部端拿到二维码载荷（A 通道）', gen.qrPayload);
  check(gen.codeDisplay === String(gen.code).split('').join(' '), '口令按位间隔展示，便于教师手输', gen.codeDisplay);
  check(gen.seconds === 60 && gen.codeExpired === false, '倒计时按后端 ttl=60 启动');
  check(gen.codeError === '', '无错误状态', gen.codeError || '—');

  const canvas = wxCalls.canvas[0];
  check(!!canvas && canvas.draws === 1, '调用 wx.createCanvasContext 绘制了 canvas', canvas ? 'draw() ×' + canvas.draws : '未绘制');
  const expectQr = qrcode.encode(gen.qrPayload);
  let darkCount = 0;
  for (let y = 0; y < expectQr.size; y++) for (let x = 0; x < expectQr.size; x++) if (expectQr.modules[y][x] === 1) darkCount++;
  check(canvas && canvas.fills.length === darkCount + 1,
    'canvas 上黑色模块数 = 二维码矩阵黑点数（1 次白底 + ' + darkCount + ' 个黑点）',
    canvas ? canvas.fills.length + ' 次 fillRect' : '无');
  check(canvas && canvas.fills[0][2] === indexPage.data.qrSize && canvas.fills[0][3] === indexPage.data.qrSize,
    '首笔绘制为整块白色背景（即静默区底色）', canvas ? canvas.fills[0].join(',') : '无');

  // ---- 3.2 copyCode 复制口令（B 通道兜底）
  resetWxCalls();
  indexPage.copyCode();
  check(wxCalls.clipboard.length === 1 && wxCalls.clipboard[0] === gen.code, '点击口令可复制（wx.setClipboardData）', wxCalls.clipboard[0]);
  check(wxCalls.toasts.some(function (t) { return /已复制/.test(t.title || ''); }), '复制成功给出明确提示');

  // ---- 3.3 教师：A 通道扫码 → 跳「课时确认页」
  resetWxCalls();
  loginAs('teacher', mockData.teacher);
  indexPage.onShow();
  await sleep(800);
  check(indexPage.data.tasks.length === 3, '教师端工作台正常渲染今日课表', indexPage.data.tasks.length + ' 门课');
  check(indexPage.data.waitSessions.length >= 1, '教师端展示「待我确认的课时」（GET /sessions?status=wait）', indexPage.data.waitSessions.length + ' 条');
  scanResult = gen.qrPayload;
  scanFail = null;
  indexPage.startScan();
  check(wxCalls.scan === 1, 'wx.scanCode 被调用（扫码确认入口）');
  const nav = wxCalls.navigations.filter(function (n) { return n.type === 'navigateTo'; })[0];
  check(!!nav && nav.url === '/pages/create/create?codeId=' + gen.codeId,
    '扫码结果解析后跳转 pages/create?codeId=..（课时确认页）', nav ? nav.url : '未跳转');

  // ---- 3.4 扫码取消 / 失败 / 扫到无关内容
  resetWxCalls();
  scanResult = '';
  scanFail = { errMsg: 'scanCode:fail cancel' };
  indexPage.startScan();
  check(wxCalls.navigations.length === 0 && wxCalls.toasts.length === 0,
    '用户主动取消扫码：不跳转、不打扰', 'navigate=' + wxCalls.navigations.length + ' toast=' + wxCalls.toasts.length);
  resetWxCalls();
  scanFail = { errMsg: 'scanCode:fail camera error' };
  indexPage.startScan();
  check(wxCalls.toasts.some(function (t) { return /扫码失败/.test(t.title || ''); }),
    '扫码失败给出友好提示（并提示可改用手输口令）', (wxCalls.toasts[0] || {}).title);
  resetWxCalls();
  scanFail = null;
  scanResult = 'https://example.com/not-a-code';
  indexPage.startScan();
  check(wxCalls.navigations.length === 0 && wxCalls.modals.length === 1 && /无法识别/.test(wxCalls.modals[0].title),
    '扫到无关内容：弹窗提示「无法识别」，不跳转', (wxCalls.modals[0] || {}).title);

  // ---- 3.5 教师：B 通道手输口令
  resetWxCalls();
  modalQueue = [{ confirm: true, content: gen.code }];
  indexPage.inputPassCode();
  check(wxCalls.navigations.length === 1 && wxCalls.navigations[0].url === '/pages/create/create?code=' + gen.code,
    '手输 6 位口令后跳转 pages/create?code=..', wxCalls.navigations[0] && wxCalls.navigations[0].url);
  resetWxCalls();
  modalQueue = [{ confirm: true, content: '123' }];
  indexPage.inputPassCode();
  check(wxCalls.navigations.length === 0 && wxCalls.toasts.some(function (t) { return /6 位数字口令/.test(t.title || ''); }),
    '口令位数不对：不跳转并提示', (wxCalls.toasts[0] || {}).title);

  // ---- 3.6 班干部：倒计时归零 → 已失效（二维码与口令一起置灰）
  // 说明：首页在身份变化时会主动清掉上一位用户出示中的动态码（防止把别人的码出示出去），
  //       前面 3.3–3.5 已切到教师身份，这里必须切回班干部并重新出示一次。
  resetWxCalls();
  loginAs('cadre', mockData.cadre);
  indexPage.onShow();
  await sleep(800);
  // 用另一门课重新出示（同一节课重复发起会被后端 40901 拦截，属另一条用例）
  const anotherCourse = indexPage.data.courses[1] || indexPage.data.courses[0];
  indexPage.presentCode({ currentTarget: { dataset: { id: anotherCourse.id } } });
  await sleep(600);
  check(!!indexPage.data.code, '切回班干部身份后重新出示动态码', 'codeId=' + indexPage.data.codeId);
  resetWxCalls();
  indexPage.stopTimer();
  indexPage.setData({ seconds: 1, codeExpired: false });
  indexPage.startTimer(1);
  await sleep(1200);
  check(indexPage.data.codeExpired === true && indexPage.data.seconds === 0,
    '倒计时归零后进入「已失效」状态（二维码与口令一起置灰）', 'expired=' + indexPage.data.codeExpired);
  resetWxCalls();
  indexPage.copyCode();
  check(wxCalls.clipboard.length === 0 && wxCalls.toasts.some(function (t) { return /已失效/.test(t.title || ''); }),
    '过期后不再复制口令，而是提示先刷新', (wxCalls.toasts[0] || {}).title);

  // ---- 3.7 刷新二维码：同一会话换新码（POST /sessions/{id}/code）
  const sessionId = indexPage.data.panel.sessionId;
  resetWxCalls();
  indexPage.refreshCodeTap();
  await sleep(600);
  check(indexPage.data.codeId && indexPage.data.codeId !== gen.codeId,
    '刷新后动态码已更换', gen.codeId + ' → ' + indexPage.data.codeId);
  check(indexPage.data.panel.sessionId === sessionId, '刷新仍是同一个课时会话（不是新建课时）', indexPage.data.panel.sessionId);
  check(indexPage.data.codeExpired === false && indexPage.data.seconds === 60,
    '刷新后倒计时重置为 60 秒', 'seconds=' + indexPage.data.seconds);
  indexPage.stopTimer();
  indexPage.onHide();

  // ---- 3.8 教师：课时确认页核验（A 扫码 qrContent / B 口令 / codeId 三选一）
  api.__mock.reset();
  loginAs('cadre', mockData.cadre);
  const issued = await api.createSession({
    courseId: 'CR00000001', courseName: '信息技术', teacherName: '唐瑞明',
    teachDate: shapeMod.todayFull(), section: '1-2', place: '实训楼A302', hours: 2
  });
  loginAs('teacher', mockData.teacher);

  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  createPage.onLoad({ codeId: issued.codeId });
  await sleep(500);
  check(createPage.data.verifyState === 'session', 'A: 按 codeId 核验通过（isSession=true）',
    'state=' + createPage.data.verifyState + ' ' + createPage.data.verifyError);
  check(createPage.data.session.courseName === '信息技术' && createPage.data.session.teacherName === '唐瑞明',
    '核验后展示本次课时信息（课程名 / 实际授课人）',
    createPage.data.session.courseName + ' / ' + createPage.data.session.teacherName);
  check(createPage.data.session.initiatorDuty === '学委' && createPage.data.session.initiatorName === '张一鸣',
    '展示发起人（班干部）', createPage.data.session.initiatorDuty + ' ' + createPage.data.session.initiatorName);
  check(createPage.data.canConfirm === true, '待确认课时可点「确认本次课时」');

  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  createPage.onLoad({ code: issued.code });
  await sleep(500);
  check(createPage.data.verifyState === 'session' && createPage.data.codeInput === issued.code,
    'B: 按 6 位口令核验通过', 'state=' + createPage.data.verifyState + ' 口令=' + createPage.data.codeInput);

  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  createPage.onLoad({ qrContent: issued.qrPayload });
  await sleep(500);
  check(createPage.data.verifyState === 'session', 'A: 按 qrContent（扫码原文）核验通过', 'state=' + createPage.data.verifyState);

  // ---- 3.9 确认成功：点一下即完成（不填表、不手写签名）
  resetWxCalls();
  modalQueue = [{ confirm: false }];
  createPage.confirm();
  await sleep(600);
  check(createPage.data.verifyState === 'done', '点「确认本次课时」→ POST /sessions/{id}/confirm 成功');
  check(wxCalls.modals.some(function (m) { return m.title === '已确认本次课时'; }),
    '成功提示「已确认本次课时」', (wxCalls.modals[0] || {}).title);
  const doneRow = api.__mock.sessions().list.filter(function (s) { return s.sessionId === issued.sessionId; })[0];
  check(doneRow && doneRow.status === 'done' && doneRow.confirmedName === '唐瑞明',
    '会话落库 done 并记录确认人（学时按实际授课人）', doneRow ? (doneRow.status + ' / ' + doneRow.confirmedName) : '未找到');

  // ---- 3.10 41002 已消费（同一动态码再次核验）
  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  modalQueue = [{ confirm: true }];
  createPage.onLoad({ codeId: issued.codeId });
  await sleep(500);
  check(createPage.data.verifyState === 'error' && /已被使用/.test(createPage.data.verifyError),
    '41002 已使用：明确中文提示', createPage.data.verifyError);
  check(/让班干部刷新/.test(createPage.data.errorAdvice), '41002 引导班干部刷新后重新出示', createPage.data.errorAdvice);

  // ---- 3.11 41001 已过期
  loginAs('cadre', mockData.cadre);
  const expired = await api.createSession({
    courseName: '专题讲座', teacherName: '唐瑞明', teachDate: shapeMod.todayFull(), section: '5-6', hours: 2
  });
  api.__mockCode.expire(expired.codeId);
  loginAs('teacher', mockData.teacher);
  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  modalQueue = [{ confirm: true }];
  createPage.onLoad({ codeId: expired.codeId });
  await sleep(500);
  check(createPage.data.verifyState === 'error', '过期动态码进入错误态', 'state=' + createPage.data.verifyState);
  check(/已过期/.test(createPage.data.verifyError), '41001 给出明确中文提示', createPage.data.verifyError);
  check(/刷新二维码/.test(createPage.data.errorAdvice), '41001 引导班干部刷新二维码', createPage.data.errorAdvice);
  check(wxCalls.modals.length >= 1, '41001 弹窗告知（不静默失败）');
  resetWxCalls();
  createPage.retryVerify();
  await sleep(400);
  check(createPage.data.verifyState === 'error' && /已过期/.test(createPage.data.verifyError),
    '「重新核验」可原地重试', createPage.data.verifyError);

  // ---- 3.12 40401 不存在 / 缺少入参
  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  modalQueue = [{ confirm: true }];
  createPage.onLoad({ codeId: 'CD-NOT-EXIST' });
  await sleep(500);
  check(createPage.data.verifyState === 'error' && /不存在/.test(createPage.data.verifyError),
    '40401 不存在的动态码给出明确中文提示', createPage.data.verifyError);

  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  modalQueue = [{ confirm: true }];
  createPage.onLoad({});
  check(createPage.data.verifyState === 'error' && /没有识别到动态码/.test(createPage.data.verifyError),
    '没有动态码入参：页面直接给出提示（不发起请求）', createPage.data.verifyError);
  check(wxCalls.navigations.some(function (n) { return n.type === 'navigateBack'; }), '缺少动态码时提示后返回首页');

  // ---- 3.13 旧课表码：新流程不再填表 / 手写签名，引导班干部重新出示
  const legacy = await api.generateCode();
  createPage = loadPage('miniprogram/pages/create/create.js');
  resetWxCalls();
  createPage.onLoad({ codeId: legacy.codeId });
  await sleep(500);
  check(createPage.data.verifyState === 'legacy', '旧课表码（isSession=false）进入「旧流程」提示态', 'state=' + createPage.data.verifyState);
  check(createPage.data.canConfirm === false, '旧课表码不提供确认按钮（不存在填表 / 签名入口）');

  // ---- 3.14 未绑定 → 引导绑定（不静默失败、不签发动态码）
  ['token', 'role', 'user'].forEach(function (k) { delete storage[k]; });
  appStub.globalData.token = '';
  appStub.globalData.role = '';
  appStub.globalData.user = null;
  appStub.globalData.needBind = true;
  indexPage = loadPage('miniprogram/pages/index/index.js');
  resetWxCalls();
  indexPage.onLoad({});
  indexPage.onShow();
  await sleep(300);
  check(indexPage.data.needBind === true, '未绑定 → 首页进入「去绑定」引导分支', 'needBind=' + indexPage.data.needBind);
  check(indexPage.data.code === '' && indexPage.data.panel.show === false,
    '未绑定时不出示动态码（不会出现「获取失败」死循环）', 'code="' + indexPage.data.code + '"');
  resetWxCalls();
  indexPage.goBind();
  check(wxCalls.navigations.some(function (n) { return n.type === 'navigateTo' && n.url === '/pages/bind/bind'; }),
    '引导可点击跳转 pages/bind/bind');

  // ---- 3.15 记录页角标：走 summary.statusTotals（不受 status= 筛选影响），旧后端回退 byStatus
  loginAs('cadre', mockData.cadre);
  {
    const totalsMap = { draft: 0, wait: 3, done: 5, rejected: 2, expired: 4, appealing: 1, makeup: 2, revoked: 1 };
    // 故意让 byStatus 与 statusTotals 不同：byStatus 只反映当前筛选（wait=1），
    // 若角标误用 byStatus，下面就会看到 wait=1 而不是 3
    const summaryWithTotals = { hours: 6, byStatus: { wait: 1 }, statusTotals: totalsMap };
    check(JSON.stringify(shapeMod.statusTotals({ summary: summaryWithTotals })) === JSON.stringify(totalsMap),
      'shape.statusTotals 优先取 summary.statusTotals', JSON.stringify(shapeMod.statusTotals({ summary: summaryWithTotals })));
    check(shapeMod.countByStatus({ summary: summaryWithTotals }, 'done') === 5 &&
      shapeMod.countByStatus({ summary: summaryWithTotals }, 'wait') === 3,
      'shape.countByStatus 同步走 statusTotals 口径（不是受筛选的 byStatus）',
      'wait=' + shapeMod.countByStatus({ summary: summaryWithTotals }, 'wait') +
      ' done=' + shapeMod.countByStatus({ summary: summaryWithTotals }, 'done'));
    const legacySummary = { hours: 6, byStatus: { wait: 7, done: 2 } };
    check(shapeMod.statusTotals({ summary: legacySummary }).wait === 7 &&
      shapeMod.countByStatus({ summary: legacySummary }, 'done') === 2,
      '旧后端无 statusTotals 时回退 summary.byStatus（兼容）', JSON.stringify(shapeMod.statusTotals({ summary: legacySummary })));

    // 页面级验证：桩掉 api.getSessions，断言 data.badges 取自 statusTotals（待教师确认/已确认/已过期 三个角标）
    const apiMod = require(path.join(ROOT, 'miniprogram/utils/api.js'));
    const origGetSessions = apiMod.getSessions;
    let payload = {
      list: [], total: 0, page: 1, pageSize: 20,
      summary: { hours: 6, byStatus: { wait: 1 }, statusTotals: totalsMap }
    };
    apiMod.getSessions = function () { return Promise.resolve(payload); };
    try {
      const recordsPage = loadPage('miniprogram/pages/records/records.js');
      await recordsPage.reload();
      check(JSON.stringify(recordsPage.data.badges) === JSON.stringify([0, 3, 5, 4]),
        '记录页角标取自 statusTotals（wait=3/done=5/expired=4，而非 byStatus 的 wait=1）',
        JSON.stringify(recordsPage.data.badges));

      payload = { list: [], total: 0, page: 1, pageSize: 20, summary: { hours: 0, byStatus: { wait: 0 }, statusTotals: totalsMap } };
      recordsPage.setData({ activeTab: 1 });
      await recordsPage.fetchPage(1);
      check(JSON.stringify(recordsPage.data.badges) === JSON.stringify([0, 3, 5, 4]),
        '切到 status=wait 后角标不随筛选归零（仍拿到全部状态计数）',
        JSON.stringify(recordsPage.data.badges));

      payload = { list: [], total: 0, page: 1, pageSize: 20, summary: legacySummary };
      recordsPage.setData({ activeTab: 0 });
      await recordsPage.fetchPage(1);
      check(JSON.stringify(recordsPage.data.badges) === JSON.stringify([0, 7, 2, 0]),
        '旧后端（只有 byStatus）时角标回退可用', JSON.stringify(recordsPage.data.badges));
    } finally {
      apiMod.getSessions = origGetSessions;
    }
  }

  // ---- 汇总
  console.log('\n' + '='.repeat(66));
  console.log('小程序自测：通过 ' + pass + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败清单：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('='.repeat(66));
  process.exit(failCount ? 1 : 0);
}

main().catch(function (e) {
  console.error('自测脚本异常：', e);
  process.exit(2);
});
