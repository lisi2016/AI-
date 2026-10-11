'use strict';
/**
 * 自由文本合规（契约第六节第 6 条）：长度校验 + 敏感词检测
 *
 * 设计要点：
 *  1) 只做校验，不做静默截断：超长 / 含敏感词一律交给上层返回 40001，由业务层决定是否写审计日志；
 *  2) 长度按 Unicode 码点计（Array.from），中文与 emoji 都算 1 个字符；
 *  3) 内置一份通用中文敏感词表（DEFAULT_SENSITIVE_WORDS），可由 /config 的 sensitive_words 覆盖；
 *  4) 本模块零依赖（不 require 任何本地模块），因此 util.js 可以引用内置词表而不会产生循环依赖；
 *  5) Node 18 原生能力实现，不引入 lodash 等重依赖。
 */

/** 内置通用中文敏感词表（可用 /config 的 sensitive_words 覆盖） */
const DEFAULT_SENSITIVE_WORDS = [
  // 代签 / 作弊 / 刷课（与课堂课时确认场景直接相关）
  '代签', '替签', '代考', '替考', '枪手', '作弊', '舞弊', '包过', '保过', '泄题',
  '卖答案', '答案出售', '刷课', '刷时长', '挂机刷', '外挂', '代写论文', '论文代写',
  // 违规代办 / 证件票务
  '办证', '假证', '假文凭', '假学历', '刻章', '代开发票', '虚开发票', '买卖发票',
  '倒卖', '黄牛', '洗钱', '传销', '非法集资', '高利贷', '套路贷',
  // 赌博 / 毒品 / 枪爆
  '赌博', '赌场', '博彩', '六合彩', '私彩', '毒品', '冰毒', '海洛因', '大麻',
  '摇头丸', '枪支', '弹药', '炸药', '爆炸物', '管制刀具',
  // 恐怖 / 邪教 / 危害国家安全
  '恐怖袭击', '恐怖组织', '邪教', '法轮功', '分裂国家', '颠覆政权', '暴力革命', '买凶',
  // 色情低俗
  '色情', '嫖娼', '卖淫', '招嫖', '裸聊', '一夜情', '黄色网站', '成人影片',
  // 辱骂
  '傻逼', '煞笔', '操你妈', '狗娘养', '去死吧',
];

/** 敏感词表上限（/config 校验用） */
const MAX_WORD_LENGTH = 30;
const MIN_WORD_LENGTH = 2;
const MAX_WORD_COUNT = 500;

/**
 * 自由文本字段定义（长度上限的默认值，实际值由 /config 覆盖）
 * configKey 对应 t_config 的 key，defaultMax 为内置默认上限
 */
const FIELDS = {
  summary: { field: 'summary', label: '授课摘要', configKey: 'max_summary_len', defaultMax: 500, required: false },
  absent_names: { field: 'absent_names', label: '缺勤姓名', configKey: 'max_absent_names_len', defaultMax: 300, required: false },
  reason: { field: 'reason', label: '理由', configKey: 'max_reason_len', defaultMax: 500, required: true },
  note: { field: 'note', label: '备注', configKey: 'max_reason_len', defaultMax: 500, required: false },
  review_note: { field: 'review_note', label: '审核意见', configKey: 'max_reason_len', defaultMax: 500, required: false },
};

/** 入参别名（前端习惯用驼峰） */
const FIELD_ALIAS = { absentNames: 'absent_names', absentName: 'absent_names' };

// ---------------------------------------------------------------- 文本基础处理
/** 去控制字符 / 零宽字符并去首尾空白（不截断，超长由长度校验拦截） */
function sanitize(value) {
  let s = value === undefined || value === null ? '' : String(value);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\ufeff]/g, '');
  return s.trim();
}

/** 按 Unicode 码点计算长度：中文、emoji 均计 1 个字符 */
function lengthOf(value) {
  return Array.from(value === undefined || value === null ? '' : String(value)).length;
}

/** 敏感词表解析：支持「逗号 / 中文逗号 / 顿号 / 空白 / 分号」分隔，也接受数组 */
function parseWords(words) {
  if (Array.isArray(words)) {
    return words.map(function (w) { return sanitize(w); }).filter(Boolean);
  }
  return String(words === undefined || words === null ? '' : words)
    .split(/[,，、;；\s|]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/** 在文本中查找命中的敏感词（去重，按首次出现位置排序） */
function findHits(text, words) {
  const hay = String(text === undefined || text === null ? '' : text).toLowerCase();
  if (!hay) return [];
  const list = parseWords(words === undefined ? DEFAULT_SENSITIVE_WORDS : words);
  const seen = {};
  const hits = [];
  list.forEach(function (w) {
    const key = w.toLowerCase();
    if (seen[key]) return;
    const at = hay.indexOf(key);
    if (at < 0) return;
    seen[key] = 1;
    hits.push({ word: w, at: at });
  });
  hits.sort(function (a, b) { return a.at - b.at; });
  return hits.map(function (h) { return h.word; });
}

/** 脱敏：把命中的敏感词替换为等长 *（保留给需要「打码留存」的场景） */
function maskText(text, words) {
  let out = String(text === undefined || text === null ? '' : text);
  parseWords(words === undefined ? DEFAULT_SENSITIVE_WORDS : words).forEach(function (w) {
    if (!w) return;
    if (out.indexOf(w) >= 0) out = out.split(w).join('*'.repeat(w.length));
  });
  return out;
}

// ---------------------------------------------------------------- 字段校验
function defOf(fieldName, opts) {
  const o = opts || {};
  const name = FIELD_ALIAS[fieldName] || fieldName;
  const base = FIELDS[name] || {
    field: String(name || 'text'),
    label: o.label || '文本内容',
    configKey: 'max_reason_len',
    defaultMax: 500,
    required: false,
  };
  const max = Number.isFinite(Number(o.max)) && Number(o.max) > 0
    ? Math.floor(Number(o.max))
    : base.defaultMax;
  return {
    field: base.field,
    label: o.label || base.label,
    configKey: base.configKey,
    max: max,
    required: o.required === undefined ? base.required : !!o.required,
    words: o.words === undefined ? DEFAULT_SENSITIVE_WORDS : parseWords(o.words),
  };
}

/**
 * 校验一个自由文本字段（不抛异常，返回结构化结果）
 * @param fieldName summary / absent_names / reason / note / review_note
 * @param value 原始入参
 * @param opts {max, required, label, words}
 * @returns {{ok:boolean, field:string, label:string, text:string, length:number, max:number,
 *            hits:string[], reason:''|'empty'|'too_long'|'sensitive', msg:string}}
 */
function validate(fieldName, value, opts) {
  const def = defOf(fieldName, opts);
  const text = sanitize(value);
  const length = lengthOf(text);
  const out = {
    ok: true,
    field: def.field,
    label: def.label,
    text: text,
    length: length,
    max: def.max,
    hits: [],
    reason: '',
    msg: '',
  };
  if (!text) {
    if (def.required) {
      out.ok = false;
      out.reason = 'empty';
      out.msg = def.label + '不能为空，请填写后重新提交';
    }
    return out;
  }
  if (length > def.max) {
    out.ok = false;
    out.reason = 'too_long';
    out.msg = def.label + '过长：当前 ' + length + ' 字符，最多 ' + def.max + ' 字符';
    return out;
  }
  const hits = findHits(text, def.words);
  if (hits.length) {
    out.ok = false;
    out.reason = 'sensitive';
    out.hits = hits;
    out.msg = '内容包含敏感词：' + hits.join('、') + '（' + def.label + '），请修改后重新提交';
    return out;
  }
  return out;
}

// ---------------------------------------------------------------- /config 词表校验
/**
 * 校验并归一化 sensitive_words 配置值
 * @returns {{ok:boolean, value?:string, words?:string[], msg?:string}}
 */
function validateWordList(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw);
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, msg: '敏感词表不能包含控制字符' };
  const words = parseWords(text);
  const seen = {};
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const len = lengthOf(w);
    if (len < MIN_WORD_LENGTH) return { ok: false, msg: '敏感词「' + w + '」过短：至少 ' + MIN_WORD_LENGTH + ' 个字符' };
    if (len > MAX_WORD_LENGTH) return { ok: false, msg: '敏感词「' + w + '」过长：最多 ' + MAX_WORD_LENGTH + ' 个字符' };
    const key = w.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(w);
  }
  if (out.length > MAX_WORD_COUNT) return { ok: false, msg: '敏感词数量过多：最多 ' + MAX_WORD_COUNT + ' 个' };
  return { ok: true, value: out.join(','), words: out };
}

module.exports = {
  DEFAULT_SENSITIVE_WORDS, FIELDS, FIELD_ALIAS,
  MAX_WORD_LENGTH, MIN_WORD_LENGTH, MAX_WORD_COUNT,
  sanitize, lengthOf, parseWords, findHits, maskText,
  validate, validateWordList, defOf,
};
