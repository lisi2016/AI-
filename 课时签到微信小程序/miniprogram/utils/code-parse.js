// 动态码入参解析（A+B 双通道共用）
//
// A 真二维码（应用内扫码）：扫码结果形如 kcsq://code/CD00000001
// B 6 位数字口令（手输兜底）：形如 042317
//
// 本模块被 pages/index/index.js（扫码结果解析）与 pages/create/create.js（页面入参解析）共用，
// 也被 Node 自测脚本（tools/miniapp-selftest.js）直接 require，所以不依赖 wx。

var QR_PREFIX = 'kcsq://code/';

/** 是否为 6 位数字口令（恰好 6 位，允许前导零） */
function isPassCode(v) {
  return /^\d{6}$/.test(String(v === undefined || v === null ? '' : v).trim());
}

/**
 * 解析一段文本 → { codeId, code, kind }；无法识别返回 null
 * kind 取值：'qr'（kcsq://code/...）、'legacy'（kcsq://confirm?codeId=...）、
 *           'url'（其它带 codeId 参数的链接）、'code'（6 位口令）、'codeId'（裸 codeId）
 */
function parseCodeInput(input) {
  var text = String(input === undefined || input === null ? '' : input).trim();
  if (!text) return null;

  // A 通道：本项目的二维码载荷
  var m1 = /^kcsq:\/\/code\/([^/?#\s]+)$/i.exec(text);
  if (m1) return { codeId: safeDecode(m1[1]), code: '', kind: 'qr', raw: text };

  // 兼容：历史载荷 kcsq://confirm?codeId=..&sign=..&exp=..
  if (/^kcsq:\/\/confirm/i.test(text)) {
    var m2 = /[?&]codeId=([^&#\s]+)/i.exec(text);
    if (m2) return { codeId: safeDecode(m2[1]), code: '', kind: 'legacy', raw: text };
    return null;
  }

  // 其它 URL（含 ?codeId= / ?code= 参数）
  if (/^https?:\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    var m3 = /[?&]codeId=([^&#\s]+)/i.exec(text);
    if (m3) return { codeId: safeDecode(m3[1]), code: '', kind: 'url', raw: text };
    var m4 = /[?&]code=([^&#\s]+)/i.exec(text);
    if (m4) {
      var cv = safeDecode(m4[1]);
      return isPassCode(cv)
        ? { codeId: '', code: cv, kind: 'code', raw: text }
        : { codeId: cv, code: '', kind: 'codeId', raw: text };
    }
    return null;
  }

  // B 通道：裸 6 位数字口令
  if (isPassCode(text)) return { codeId: '', code: text, kind: 'code', raw: text };

  // 裸 codeId（如 CD00000001 / MOCK-1730000000000）
  if (/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(text)) {
    return { codeId: text, code: '', kind: 'codeId', raw: text };
  }

  return null;
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
}

/**
 * 由页面入参组装 /code/verify 的请求体：
 * 支持 ?codeId=..&code=..&qrContent=..&scene=..（scene 为小程序码带参数场景）
 * 返回 { codeId } | { code } | { qrContent } 之一，无法识别返回 { invalid: true }
 */
function buildVerifyInput(query) {
  var q = query || {};
  var codeId = String(q.codeId || '').trim();
  var code = String(q.code || '').trim();
  var qrContent = String(q.qrContent || q.qr || q.scene || '').trim();
  if (qrContent) {
    var parsed = parseCodeInput(qrContent);
    if (parsed) {
      if (parsed.codeId) return { codeId: parsed.codeId, by: 'qrContent' };
      return { code: parsed.code, by: 'qrContent' };
    }
    return { invalid: true, by: 'qrContent', raw: qrContent };
  }
  if (isPassCode(code)) return { code: code, by: 'code' };
  if (code) return { codeId: code, by: 'code' };   // 兼容：把 code 当 codeId 传
  if (codeId) return { codeId: codeId, by: 'codeId' };
  return { invalid: true, by: '' };
}

/** 把解析结果拼成 pages/create/create 的查询串 */
function toCreateQuery(parsed, extra) {
  var parts = [];
  if (parsed && parsed.codeId) parts.push('codeId=' + encodeURIComponent(parsed.codeId));
  if (parsed && parsed.code) parts.push('code=' + encodeURIComponent(parsed.code));
  var e = extra || {};
  Object.keys(e).forEach(function (k) {
    if (e[k] === undefined || e[k] === null || e[k] === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(e[k]));
  });
  return parts.join('&');
}

module.exports = {
  QR_PREFIX: QR_PREFIX,
  isPassCode: isPassCode,
  parseCodeInput: parseCodeInput,
  buildVerifyInput: buildVerifyInput,
  toCreateQuery: toCreateQuery,
};
