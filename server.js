/**
 * 月度工作总结与计划生成系统 —— 后端服务
 * 功能：成员在线提交月总结/月计划；大模型汇总生成两份 Word 文档；邮件发送给部门负责人；设置页管理配置。
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, LineRuleType, convertMillimetersToTwip,
} = require('docx');

const PORT = process.env.PORT || 3081;
const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const REPORTS_DIR = path.join(APP_DIR, 'reports');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

const FILE_SETTINGS = path.join(DATA_DIR, 'settings.json');
const FILE_DEPARTMENTS = path.join(DATA_DIR, 'departments.json');
const FILE_SUBMISSIONS = path.join(DATA_DIR, 'submissions.json');
const FILE_REPORTS = path.join(DATA_DIR, 'reports.json');

/* ---------------- 存储工具 ---------------- */

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_SETTINGS = {
  adminPassword: hashPassword('admin123'),
  smtp: { host: '', port: 465, secure: true, user: '', pass: '', fromName: '' },
  llm: {
    enabled: true,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.6,
  },
  auto: {
    enabled: true,
    collegeEmail: '',
    alsoSendToHead: true,
  },
  mailer: {
    method: 'agently', // 'agently'（腾讯 AI Agent 邮箱，推荐） 或 'smtp'（标准 SMTP）
  },
  mail: {
    subjectTemplate: '【教研室汇总】{department} {year}年{monthNum}月工作总结与{nextMonthYear}年{nextMonthNum}月工作计划',
    bodyTemplate: [
      '您好！',
      '',
      '{department}全体成员已全部提交{year}年{monthNum}月的月度工作总结与{nextMonthYear}年{nextMonthNum}月的工作计划，系统已自动汇总生成《{year}年{monthNum}月月度工作总结》《{nextMonthYear}年{nextMonthNum}月月度工作计划》两份 Word 文档，详见附件，请查收。',
      '',
      '本月共有 {count} 名成员提交。',
      '',
      '—— 月度工作总结与计划生成系统（自动发送，请勿直接回复）',
    ].join('\n'),
  },
};

const SEED_DEPARTMENTS = [
  {
    id: 'dept-cs', name: '计算机教研室', headName: '王建国', headEmail: '',
    members: [{ name: '王建国' }, { name: '李慧' }, { name: '张明' }, { name: '陈静' }, { name: '刘洋' }],
  },
  {
    id: 'dept-math', name: '数学教研室', headName: '赵敏', headEmail: '',
    members: [{ name: '赵敏' }, { name: '孙涛' }, { name: '周雪' }, { name: '吴强' }],
  },
];

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function getSettings() {
  const s = loadJson(FILE_SETTINGS, null);
  if (!s) {
    saveJson(FILE_SETTINGS, DEFAULT_SETTINGS);
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  // 迁移兜底
  const merged = {
    adminPassword: s.adminPassword || hashPassword('admin123'),
    smtp: Object.assign({}, DEFAULT_SETTINGS.smtp, s.smtp || {}),
    llm: Object.assign({}, DEFAULT_SETTINGS.llm, s.llm || {}),
    auto: Object.assign({}, DEFAULT_SETTINGS.auto, s.auto || {}),
    mailer: Object.assign({}, DEFAULT_SETTINGS.mailer, s.mailer || {}),
    mail: Object.assign({}, DEFAULT_SETTINGS.mail, s.mail || {}),
    sessionSecret: s.sessionSecret || '',
  };
  return merged;
}

function saveSettings(s) {
  saveJson(FILE_SETTINGS, s);
}

function getDepartments() {
  const d = loadJson(FILE_DEPARTMENTS, null);
  if (!d) {
    saveJson(FILE_DEPARTMENTS, SEED_DEPARTMENTS);
    return JSON.parse(JSON.stringify(SEED_DEPARTMENTS));
  }
  return d;
}

function saveDepartments(d) {
  saveJson(FILE_DEPARTMENTS, d);
}

function getSubmissions() {
  return loadJson(FILE_SUBMISSIONS, []);
}

function saveSubmissions(list) {
  saveJson(FILE_SUBMISSIONS, list);
}

function getReports() {
  return loadJson(FILE_REPORTS, {});
}

function saveReports(r) {
  saveJson(FILE_REPORTS, r);
}

function reportKey(month, departmentId) {
  return `${month}|${departmentId}`;
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtDate() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : null;
}

/* ---------------- 管理员令牌（HMAC 签名，重启后仍有效，不存内存） ---------------- */

function getSessionSecret() {
  let s = getSettings();
  if (!s.sessionSecret) {
    s.sessionSecret = crypto.randomBytes(32).toString('hex');
    saveSettings(s);
  }
  return s.sessionSecret;
}
function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function issueToken() {
  const exp = Date.now() + 24 * 3600 * 1000; // 24 小时有效
  return `${exp}.${hmac(getSessionSecret(), String(exp))}`;
}

function checkAuth(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!exp || !sig || sig !== hmac(getSessionSecret(), String(exp)) || Date.now() > exp) {
    res.status(401).json({ ok: false, error: '未登录或登录已过期' });
    return false;
  }
  return true;
}

/* ---------------- 大模型汇总 ---------------- */

async function callLLM(settings, systemPrompt, userContent, opts = {}) {
  const json = opts.json !== false;
  const { baseUrl, apiKey, model, temperature } = settings.llm;
  if (!apiKey) throw new Error('未配置 LLM API Key，请在设置页配置');
  const url = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const payload = {
    model: model || 'deepseek-chat',
    temperature: Number(temperature) || 0.6,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    stream: false,
  };
  // DeepSeek 等要求：启用 json_object 模式时，提示词中必须包含 "json" 字样。
  // 纯连通性测试无需 JSON 模式，否则会因提示词不含 "json" 而报 HTTP 400。
  if (json) payload.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    timeout: 120000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 请求失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('LLM 返回内容为空');
  const cleaned = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  if (!json) return cleaned;
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('LLM 返回内容不是合法 JSON：' + cleaned.slice(0, 300));
  }
  return parsed;
}

function normalizeResult(result) {
  const r = result || {};
  const summary = r.summary || {};
  const plan = r.plan || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const sections = (v) =>
    Array.isArray(v)
      ? v
          .map((s) => ({
            title: str(s && (s.title || s.name)),
            content: str(s && (s.content || s.text || s.描述 || s.detail)),
          }))
          .filter((s) => s.title)
      : [];
  return {
    summary: { sections: sections(summary.sections || summary.themes || summary.blocks || summary.主题) },
    plan: { sections: sections(plan.sections || plan.themes || plan.blocks || plan.重点方向) },
  };
}

/* 无 LLM 时的基础汇总（兜底，按主题归类，尽量有条理） */
const FALLBACK_THEMES = [
  { key: ['教学', '课程', '备课', '上课', '授课', '教案', '作业', '试卷'], title: '教学运行与常规管理' },
  { key: ['教研', '集体备课', '公开课', '示范课', '听评课', '听课评课', '评课'], title: '教研活动' },
  { key: ['课题', '科研', '论文', '项目', '申报', '著作'], title: '科研课题' },
  { key: ['教师', '培训', '进修', '学习', '比赛', '竞赛', '获奖', '荣誉'], title: '教师发展' },
  { key: ['学生', '指导', '辅导', '竞赛', '实训', '实践', '毕业', '答辩'], title: '学生培养' },
];
function fallbackAggregate(department, month, subs) {
  const { year, num } = splitMonth(month);
  const pm = splitMonth(nextMonth(month));
  const pending = FALLBACK_THEMES.map((t) => ({ title: t.title, key: t.key, items: [] }));
  const others = [];
  for (const s of subs) {
    for (const line of s.summary.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const th = pending.find((p) => p.key.some((k) => t.includes(k)));
      (th ? th.items : others).push(t);
    }
  }
  const used = pending.filter((p) => p.items.length);
  const summarySections = used.map((p) => ({
    title: p.title,
    content: p.items.map((it, i) => `${i + 1}．${it}`).join('\n'),
  }));
  if (others.length) {
    summarySections.push({ title: '其他工作', content: others.map((it, i) => `${i + 1}．${it}`).join('\n') });
  }
  const planSections = subs.map((s) => ({
    title: `${s.memberName}的工作安排`,
    content: String(s.plan).trim(),
  }));
  return {
    summary: { sections: summarySections },
    plan: { sections: planSections },
  };
}

async function aggregate(department, month, subs) {
  const settings = getSettings();
  let result = null;
  let usedLlm = false;
  let note = '';
  if (settings.llm.enabled && settings.llm.apiKey) {
    try {
      const memberBlock = subs
        .map(
          (s, i) =>
            `【成员${i + 1}】姓名：${s.memberName}\n本月工作总结：\n${s.summary}\n下月工作计划：\n${s.plan}`
        )
        .join('\n\n');
      const userContent = `部门：${department.name}\n汇总月份（工作总结所属月）：${fmtMonthLabel(month)}\n计划月份（工作计划所属月，即下月）：${fmtMonthLabel(nextMonth(month))}\n\n以下是该教研室 ${subs.length} 名成员提交的原始《本月工作总结》与《下月工作计划》：\n\n${memberBlock}`;
      const systemPrompt = `你是一名教研室主任，负责撰写本教研室的月度工作总结与工作计划。请以教研室主任的口吻，根据教研室成员提交的原始月度工作总结与工作计划，撰写一份高质量、正式规范的《月度工作总结及下月工作计划》。

【文档结构】内容分两大部分：
- 本月工作总结（对应 ${fmtMonthLabel(month)}）
- 下月工作计划（对应 ${fmtMonthLabel(nextMonth(month))}）

【写作要求——必须严格遵守】
1. 每个部分拆分为 3-5 个主题小节；
2. 每个小节包含：
   - 标题：用凝练的"动宾式"短语概括主题，体现成果或动作（如"课题申报工作成效显著""圆满完成卫生经济课题结题""扎实推进新学期课程备课"）；
   - 正文：成段叙述（200-350字），按"做了什么——怎么做的——取得什么成效"展开，语言正式、通顺、有公文质感；
3. 严禁逐人罗列、严禁流水账，严禁"1.张三完成……；2.李四完成……"式清单；不点名、不归属个人；
4. 对成员内容归纳提炼、同类合并，重要事项不得遗漏，可合理汇总量化信息（如"三名教师申报课题全部获批立项"）；
5. 如存在明显问题或不足，可在工作总结部分增设小节"存在的问题与不足"；如需改进安排可增设"下一步改进方向"；
6. 【严禁编造】不得虚构、夸大原始内容中不存在的事实、数据与数字。原始材料中没有具体数量时，用定性表述（如"多位教师""相关工作"），**切勿自行添加数字**；没有的内容不写，宁可简洁也不要凭空发挥。

严格按以下 JSON 输出（不要输出任何其他文字或 markdown）：
{
  "summary": {
    "sections": [
      {"title": "小节标题（动宾式）", "content": "成段叙述，200-350字"}
    ]
  },
  "plan": {
    "sections": [
      {"title": "小节标题（动宾式）", "content": "成段叙述，200-350字"}
    ]
  }
}`;
      const raw = await callLLM(settings, systemPrompt, userContent);
      result = normalizeResult(raw);
      usedLlm = true;
    } catch (e) {
      note = '大模型调用失败，已自动使用基础汇总模式：' + e.message;
      result = null;
    }
  }
  if (!result) {
    result = fallbackAggregate(department, month, subs);
  }
  return { result, usedLlm, note };
}

/* ---------------- 自动汇总（全员提交后触发） ---------------- */

/** 判断某教研室某月是否所有成员都已提交（成员名单以设置为准） */
function isDeptComplete(dept, month, subs) {
  const list = dept.members || [];
  if (!list.length) return false;
  const done = new Set(
    subs.filter((s) => s.month === month && s.departmentId === dept.id).map((s) => s.memberName)
  );
  return list.every((m) => done.has(m.name));
}

/**
 * 自动汇总并发送：全员已提交时生成两份 Word 并发送到二级学院指定邮箱。
 * 若已手动生成过文档则复用文件只发邮件；发送失败会记录 autoError 并稍后重试。
 */
async function autoGenerateAndSend(dept, month) {
  const key = reportKey(month, dept.id);
  const settings = getSettings();

  // 未启用 / 未配置学院邮箱则跳过
  if (!settings.auto.enabled) return { skipped: true, reason: 'auto-disabled' };
  if (!settings.auto.collegeEmail) return { skipped: true, reason: 'no-college-email' };

  const reports = getReports();
  const r = reports[key];
  if (r && r.autoSentAt) return { skipped: true, reason: 'already-sent' };
  // 上次失败后 30 分钟内不重试，避免反复报错刷日志
  if (r && r.autoErrorAt && Date.now() - new Date(r.autoErrorAt.replace(' ', 'T')).getTime() < 30 * 60 * 1000) {
    return { skipped: true, reason: 'retry-backoff' };
  }

  const subs = getSubmissions().filter((s) => s.month === month && s.departmentId === dept.id);
  if (!subs.length) return { skipped: true, reason: 'no-submissions' };

  try {
    let reportFile = r && r.reportFile ? path.join(REPORTS_DIR, r.reportFile) : null;
    let usedLlm = r ? !!r.usedLlm : false;
    let note = r ? r.note || '' : '';

    if (!reportFile || !fs.existsSync(reportFile)) {
      const { result, usedLlm: ul, note: nt } = await aggregate(dept, month, subs);
      reportFile = await writeCombinedReportDocx(dept, month, result);
      usedLlm = ul;
      note = nt;
    }

    // 发送到学院指定邮箱，可选抄送教研室主任
    const cc = settings.auto.alsoSendToHead && dept.headEmail ? dept.headEmail : undefined;
    const info = await sendReportMail(settings, dept, month, subs.length, [reportFile], settings.auto.collegeEmail, cc);

    const reports2 = getReports();
    const r2 = reports2[key] || {};
    r2.reportFile = path.basename(reportFile);
    r2.usedLlm = usedLlm;
    r2.note = note;
    r2.memberCount = subs.length;
    r2.autoGeneratedAt = fmtDateTime(Date.now());
    r2.autoSentAt = fmtDateTime(Date.now());
    r2.autoSentTo = settings.auto.collegeEmail;
    r2.autoError = '';
    r2.autoErrorAt = '';
    reports2[key] = r2;
    saveReports(reports2);
    console.log(`[自动汇总] ${dept.name} ${month} 全员已提交，已自动生成并发送至 ${settings.auto.collegeEmail}`);
    return { ok: true, sentTo: settings.auto.collegeEmail };
  } catch (e) {
    const reports2 = getReports();
    const r2 = reports2[key] || {};
    r2.autoError = e.message;
    r2.autoErrorAt = fmtDateTime(Date.now());
    reports2[key] = r2;
    saveReports(reports2);
    console.error(`[自动汇总失败] ${dept.name} ${month}：${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 提交后异步触发（不阻塞提交响应） */
function triggerAutoAfterSubmit(departmentId, month) {
  setImmediate(() => {
    const dept = getDepartments().find((d) => d.id === departmentId);
    if (!dept) return;
    const m = safeMonth(month);
    if (!m) return;
    if (!isDeptComplete(dept, m, getSubmissions())) return;
    autoGenerateAndSend(dept, m).catch((e) => console.error('[自动汇总异常] ' + e.message));
  });
}

/** 提交后自动：生成该成员的个人优化文档，并自动发送到学院指定邮箱（仅首次提交自动发送，避免重复打扰） */
function triggerPersonalDocAfterSubmit(departmentId, month, memberName) {
  setImmediate(async () => {
    try {
      const dept = getDepartments().find((d) => d.id === departmentId);
      if (!dept) return;
      const m = safeMonth(month);
      if (!m) return;
      const name = String(memberName || '').trim();
      if (!name) return;
      const docs = getMyDocs();
      const key = myDocKey(m, departmentId, name);
      // 已自动发送过则不重复发（重新提交仅更新文档，如需再发可手动点击发送）
      if (docs[key] && docs[key].autoSentAt) return;
      const g = await generatePersonalDocInternal(dept, name, m);
      if (!g.ok) return;
      const settings = getSettings();
      if (!settings.auto.collegeEmail || !settings.smtp.host || !settings.smtp.user) {
        console.log(`[个人文档] ${dept.name} ${name} ${m} 已生成（未配置邮箱，未自动发送）`);
        return;
      }
      const s = await sendPersonalDocInternal(dept, name, m, g.file);
      if (s.ok) {
        const docs2 = getMyDocs();
        const r2 = docs2[key];
        if (r2) {
          r2.autoSentAt = fmtDateTime(Date.now());
          r2.autoSentTo = s.sentTo;
          saveMyDocs(docs2);
        }
        console.log(`[个人文档] ${dept.name} ${name} ${m} 已自动生成并发送至 ${s.sentTo}`);
      }
    } catch (e) {
      console.error('[个人文档自动处理异常] ' + e.message);
    }
  });
}

/** 定时兜底：每 60 秒检查当月是否有"刚凑齐全员"的教研室（应对成员名单变动、服务重启等场景） */
function startAutoScheduler() {
  const run = async () => {
    try {
      const settings = getSettings();
      if (!settings.auto.enabled || !settings.auto.collegeEmail) return;
      const m = currentMonth();
      for (const dept of getDepartments()) {
        if (isDeptComplete(dept, m, getSubmissions())) {
          await autoGenerateAndSend(dept, m);
        }
      }
    } catch (e) {
      console.error('[自动检查异常] ' + e.message);
    }
  };
  setTimeout(run, 8000);
  setInterval(run, 60000);
}

/* ---------------- Word 文档生成 ---------------- */

const FONT_SONG = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' };
const FONT_HEI = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '黑体' };

function titlePara(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120, line: 400, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_HEI, size: 32, bold: true })],
  });
}

function metaPara(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_SONG, size: 21 })],
  });
}

function headingPara(text) {
  return new Paragraph({
    spacing: { before: 200, after: 120, line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_HEI, size: 28, bold: true })],
  });
}

function bodyPara(text, bold = false) {
  return new Paragraph({
    indent: { firstLine: 480 },
    spacing: { line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_SONG, size: 24, bold })],
  });
}

function itemPara(text) {
  return new Paragraph({
    indent: { firstLine: 480 },
    spacing: { line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_SONG, size: 24 })],
  });
}

function listPara(texts) {
  const out = [];
  (texts || []).forEach((t, i) => out.push(itemPara(`${i + 1}．${t}`)));
  if (!out.length) out.push(bodyPara('（无）'));
  return out;
}

function subheadingPara(text) {
  return new Paragraph({
    spacing: { before: 120, after: 60, line: 360, lineRule: LineRuleType.AUTO },
    children: [new TextRun({ text, font: FONT_HEI, size: 24, bold: true })],
  });
}

/* 把成段文本拆成正文段落（多行时每行一段） */
function contentParas(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) out.push(bodyPara('（无）'));
  else lines.forEach((l) => out.push(bodyPara(l)));
  return out;
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 2026 -> 二〇二六 */
function cnYear(y) { return String(y).split('').map((d) => CN_DIGITS[Number(d)]).join(''); }
/** 7 -> 七；11 -> 十一；12 -> 十二 */
function cnMonth(m) {
  const n = Number(m);
  if (n <= 10) return CN_DIGITS[n];
  return '十' + CN_DIGITS[n - 10];
}

function buildDocx(type, data) {
  const children = [];
  children.push(titlePara(data.title));
  children.push(metaPara(`（${data.deptName}　生成日期：${data.generatedDate}）`));

  if (type === 'summary') {
    children.push(headingPara('一、总体情况'));
    contentParas(data.content.summary.overview).forEach((p) => children.push(p));
    children.push(headingPara('二、主要工作及成效'));
    const themes = data.content.summary.themes || [];
    if (!themes.length) children.push(bodyPara('（无）'));
    themes.forEach((t, i) => {
      const label = `（${CN_NUM[i] || i + 1}）${t.title}`;
      children.push(subheadingPara(label));
      contentParas(t.content).forEach((p) => children.push(p));
    });
    children.push(headingPara('三、工作亮点与成效'));
    listPara(data.content.summary.highlights).forEach((p) => children.push(p));
    children.push(headingPara('四、存在的问题与不足'));
    listPara(data.content.summary.problems).forEach((p) => children.push(p));
    children.push(headingPara('五、下一步改进措施'));
    listPara(data.content.summary.improvements).forEach((p) => children.push(p));
  } else {
    children.push(headingPara('一、总体目标'));
    contentParas(data.content.plan.goals).forEach((p) => children.push(p));
    children.push(headingPara('二、重点工作安排'));
    const themes = data.content.plan.themes || [];
    if (!themes.length) children.push(bodyPara('（无）'));
    themes.forEach((t, i) => {
      let text = `${i + 1}．${t.title}`;
      if (t.deadline) text += `（时间节点：${t.deadline}）`;
      children.push(itemPara(text));
      contentParas(t.content).forEach((p) => children.push(p));
    });
    children.push(headingPara('三、保障措施'));
    listPara(data.content.plan.measures).forEach((p) => children.push(p));
  }

  // 附录：成员提交明细
  children.push(headingPara('附：成员提交明细'));
  if (!data.members.length) {
    children.push(bodyPara('（无）'));
  } else {
    for (const m of data.members) {
      children.push(
        new Paragraph({
          spacing: { before: 120 },
          children: [new TextRun({ text: `● ${m.name}（提交时间：${m.time}）`, font: FONT_HEI, size: 24, bold: true })],
        })
      );
      const lines = m.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) lines.push('（未填写）');
      lines.forEach((l) => children.push(bodyPara(l)));
    }
  }

  return wrapDocument(children);
}

/* 标准公文版式（A4，上3.7cm 下3.5cm 左2.8cm 右2.6cm） */
function wrapDocument(children) {
  return new Document({
    styles: {
      default: {
        document: { run: { font: FONT_SONG, size: 24 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertMillimetersToTwip(37),
              bottom: convertMillimetersToTwip(35),
              left: convertMillimetersToTwip(28),
              right: convertMillimetersToTwip(26),
            },
          },
        },
        children,
      },
    ],
  });
}

/** 生成单份合并文档：《XX教研室X月工作总结及下月工作计划》（对齐参考公文样式，含落款） */
async function writeCombinedReportDocx(dept, month, aggregateResult) {
  const { year, num } = splitMonth(month);
  const pm = splitMonth(nextMonth(month));
  const data = {
    title: `${dept.name}${year}年${num}月工作总结及${pm.year}年${pm.num}月工作计划`,
    deptName: dept.name,
    generatedDate: fmtDate(),
    summaryTitle: `${year}年${num}月工作总结`,
    planTitle: `${pm.year}年${pm.num}月工作计划`,
    summary: aggregateResult.summary,
    plan: aggregateResult.plan,
    signDate: `${cnYear(year)}年${cnMonth(num)}月`,
  };
  const doc = buildCombinedDocx(data);
  const buffer = await Packer.toBuffer(doc);
  const file = path.join(REPORTS_DIR, `${month}_${dept.id}_report.docx`);
  fs.writeFileSync(file, buffer);
  return file;
}

/** 合并文档版式：标题 → 一、总结（（一）小节…）→ 二、计划（（一）小节…）→ 落款 */
function buildCombinedDocx(data) {
  const children = [];
  children.push(titlePara(data.title));
  children.push(metaPara(`（${data.deptName}　生成日期：${data.generatedDate}）`));

  children.push(headingPara(`一、${data.summaryTitle}`));
  const sumSections = (data.summary && data.summary.sections) || [];
  if (!sumSections.length) children.push(bodyPara('（无）'));
  sumSections.forEach((s, i) => {
    children.push(subheadingPara(`（${CN_NUM[i] || i + 1}）${s.title}`));
    contentParas(s.content).forEach((p) => children.push(p));
  });

  children.push(headingPara(`二、${data.planTitle}`));
  const planSections = (data.plan && data.plan.sections) || [];
  if (!planSections.length) children.push(bodyPara('（无）'));
  planSections.forEach((s, i) => {
    children.push(subheadingPara(`（${CN_NUM[i] || i + 1}）${s.title}`));
    contentParas(s.content).forEach((p) => children.push(p));
  });

  // 落款
  children.push(new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: data.deptName, font: FONT_SONG, size: 24 })] }));
  children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: data.signDate, font: FONT_SONG, size: 24 })] }));
  return wrapDocument(children);
}

function splitMonth(month) {
  const [y, m] = month.split('-');
  return { year: y, num: String(Number(m)) };
}

/** 月份加减，返回 YYYY-MM（自动处理跨年） */
function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(month) { return addMonths(month, 1); }
/** YYYY-MM -> X年X月 */
function fmtMonthLabel(month) { const { year, num } = splitMonth(month); return `${year}年${num}月`; }

/* ---------------- 邮件发送 ---------------- */

function createTransporter(settings) {
  const s = settings.smtp;
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 465,
    secure: s.secure !== false,
    auth: { user: s.user, pass: s.pass },
  });
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/* ---------------- Agently Mail（腾讯 AI Agent 邮箱）发信 ---------------- */

let agentlyCliPath = null;
function getAgentlyCliPath() {
  if (agentlyCliPath && fs.existsSync(agentlyCliPath)) return agentlyCliPath;
  const candidates = [];
  // Windows：npm 全局在 %APPDATA%\npm\node_modules
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@tencent-qqmail', 'agently-cli', 'scripts', 'run.js'));
  }
  // Linux/macOS：优先用 npm root -g 解析，再补常见路径
  if (process.platform !== 'win32') {
    try {
      const root = require('child_process').execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
      if (root) candidates.push(path.join(root, '@tencent-qqmail', 'agently-cli', 'scripts', 'run.js'));
    } catch (e) { /* ignore */ }
    candidates.push('/usr/local/lib/node_modules/@tencent-qqmail/agently-cli/scripts/run.js');
    candidates.push(path.join(require('os').homedir(), '.npm-global', 'lib', 'node_modules', '@tencent-qqmail', 'agently-cli', 'scripts', 'run.js'));
  }
  agentlyCliPath = candidates.find((c) => c && fs.existsSync(c)) || null;
  return agentlyCliPath;
}

function execAgently(args) {
  const cli = getAgentlyCliPath();
  if (!fs.existsSync(cli)) return Promise.reject(new Error('未找到 Agently CLI，请先安装：npm install -g @tencent-qqmail/agently-cli 并完成授权'));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { cwd: APP_DIR, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || '').trim() || `agently-cli 退出码 ${err.code}`;
        reject(new Error(msg.slice(0, 400)));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** 通过 Agently Mail 发送（自动确认，含附件）。附件必须位于应用目录内，传相对路径 */
async function sendViaAgently(to, subject, body, files) {
  const args = ['message', '+send', '--to', to, '--subject', subject, '--body', body, '--confirmed'];
  for (const f of files || []) {
    const rel = path.relative(APP_DIR, f);
    if (rel.startsWith('..')) throw new Error('附件必须位于应用目录内');
    args.push('--attachment', rel.split(path.sep).join('/'));
  }
  const out = await execAgently(args);
  try {
    return JSON.parse(out);
  } catch (e) {
    return { ok: true, raw: out };
  }
}

/** 统一发信入口：按 settings.mailer.method 选择 Agently Mail 或 SMTP */
async function sendMail(settings, to, subject, body, files, cc) {
  if (settings.mailer.method === 'agently') {
    return await sendViaAgently(to, subject, body, files);
  }
  // 默认：SMTP（nodemailer）
  if (!settings.smtp.host || !settings.smtp.user) {
    throw new Error('未配置 SMTP 邮件服务，请在设置页配置');
  }
  const fromName = settings.smtp.fromName || settings.smtp.user;
  const transporter = createTransporter(settings);
  const mailOpts = {
    from: `"${fromName}" <${settings.smtp.user}>`,
    to,
    subject,
    text: body,
    attachments: files.map((f) => ({ filename: path.basename(f), path: f })),
  };
  if (cc) mailOpts.cc = cc;
  return await transporter.sendMail(mailOpts);
}

async function sendReportMail(settings, dept, month, count, files, to, cc) {
  const { year, num } = splitMonth(month);
  const nm = splitMonth(nextMonth(month));
  const vars = {
    department: dept.name,
    month,
    year,
    monthNum: num,
    count,
    nextMonth: nextMonth(month),
    nextMonthNum: nm.num,
    nextMonthYear: nm.year,
  };
  const subject = fillTemplate(settings.mail.subjectTemplate, vars);
  const body = fillTemplate(settings.mail.bodyTemplate, vars);
  return await sendMail(settings, to || dept.headEmail, subject, body, files, cc);
}

/* ---------------- Express 应用 ---------------- */

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));

/* 静态页面 */
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/report.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'report.html')));
app.get('/settings.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'settings.html')));

/* 引导数据（无需登录） */
app.get('/api/bootstrap', (req, res) => {
  const departments = getDepartments().map((d) => ({
    id: d.id, name: d.name, headName: d.headName, headEmail: d.headEmail, members: d.members || [],
  }));
  const subs = getSubmissions();
  const months = [...new Set(subs.map((s) => s.month))].sort().reverse();
  const settings = getSettings();
  res.json({
    ok: true,
    departments,
    currentMonth: currentMonth(),
    months,
    settings: {
      hasLlmKey: !!(settings.llm.apiKey),
      llmEnabled: settings.llm.enabled,
      hasSmtp: !!(settings.smtp.host && settings.smtp.user),
      autoEnabled: settings.auto.enabled !== false,
      hasCollegeEmail: !!(settings.auto.collegeEmail),
    },
  });
});

/* 成员提交（幂等：同一部门+姓名+月份重复提交则覆盖更新） */
app.post('/api/submit', (req, res) => {
  const { departmentId, memberName, summary, plan, month } = req.body || {};
  const m = safeMonth(month);
  if (!m) return res.status(400).json({ ok: false, error: '月份格式不正确' });
  if (!departmentId) return res.status(400).json({ ok: false, error: '请选择教研室' });
  const name = String(memberName || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '请选择姓名' });
  if (!String(summary || '').trim()) return res.status(400).json({ ok: false, error: '请填写本月工作总结' });
  if (!String(plan || '').trim()) return res.status(400).json({ ok: false, error: '请填写下月工作计划' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });

  const subs = getSubmissions();
  const idx = subs.findIndex((s) => s.departmentId === departmentId && s.memberName === name && s.month === m);
  const now = Date.now();
  if (idx >= 0) {
    subs[idx] = { ...subs[idx], summary: String(summary), plan: String(plan), updatedAt: now };
  } else {
    subs.push({ id: crypto.randomBytes(8).toString('hex'), departmentId, memberName: name, summary: String(summary), plan: String(plan), month: m, submittedAt: now, updatedAt: now });
  }
  saveSubmissions(subs);
  // 若该教研室该月已全员提交，则异步触发自动汇总与发送（不阻塞本次提交）
  triggerAutoAfterSubmit(departmentId, m);
  // 异步：自动生成并发送该成员的个人优化文档
  triggerPersonalDocAfterSubmit(departmentId, m, name);
  res.json({ ok: true, message: idx >= 0 ? '已更新你的提交内容' : '提交成功' });
});

/* 查询某成员某月已提交的内容（页面刷新后恢复显示用） */
app.get('/api/my-submission', (req, res) => {
  const month = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  const memberName = String(req.query.memberName || '').trim();
  if (!month || !departmentId || !memberName) return res.status(400).json({ ok: false, error: '参数不完整' });
  const sub = getSubmissions().find(
    (s) => s.month === month && s.departmentId === departmentId && s.memberName === memberName
  );
  res.json({ ok: true, submission: sub || null });
});

/* 查看某教研室某月的提交情况 */
app.get('/api/submissions', (req, res) => {
  const month = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  if (!month || !departmentId) return res.status(400).json({ ok: false, error: '参数不完整' });
  const subs = getSubmissions()
    .filter((s) => s.month === month && s.departmentId === departmentId)
    .sort((a, b) => (a.memberName || '').localeCompare(b.memberName || '', 'zh'));
  res.json({ ok: true, submissions: subs });
});

/* 生成报告状态 */
app.get('/api/report/status', (req, res) => {
  const month = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  if (!month || !departmentId) return res.status(400).json({ ok: false, error: '参数不完整' });
  const reports = getReports();
  const r = reports[reportKey(month, departmentId)];
  if (!r) return res.json({ ok: true, generated: false });
  res.json({
    ok: true,
    generated: true,
    generatedAt: r.generatedAt,
    reportFile: r.reportFile || null,
    usedLlm: r.usedLlm,
    note: r.note || '',
    sentAt: r.sentAt || null,
    sentTo: r.sentTo || null,
    memberCount: r.memberCount || 0,
    preview: r.preview || null,
    autoSentAt: r.autoSentAt || null,
    autoSentTo: r.autoSentTo || null,
    autoGeneratedAt: r.autoGeneratedAt || null,
    autoError: r.autoError || '',
  });
});

/* 汇总并生成合并版 Word 文档（总结+计划，单份） */
app.post('/api/generate', async (req, res) => {
  const { month, departmentId } = req.body || {};
  const m = safeMonth(month);
  if (!m || !departmentId) return res.status(400).json({ ok: false, error: '参数不完整' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });
  const subs = getSubmissions().filter((s) => s.month === m && s.departmentId === departmentId);
  if (!subs.length) return res.status(400).json({ ok: false, error: '该教研室本月暂无成员提交内容，请先让成员提交' });

  try {
    const { result, usedLlm, note } = await aggregate(dept, m, subs);
    const reportFile = await writeCombinedReportDocx(dept, m, result);

    const preview = {
      summarySections: (result.summary.sections || []).slice(0, 10),
      planSections: (result.plan.sections || []).slice(0, 10),
    };

    const reports = getReports();
    reports[reportKey(m, departmentId)] = {
      generatedAt: fmtDateTime(Date.now()),
      reportFile: path.basename(reportFile),
      usedLlm,
      note: note || '',
      memberCount: subs.length,
      sentAt: null,
      sentTo: null,
      preview,
    };
    saveReports(reports);

    res.json({
      ok: true,
      usedLlm,
      note,
      reportFile: path.basename(reportFile),
      preview,
      downloadUrl: `/api/download?month=${m}&departmentId=${departmentId}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: '生成失败：' + e.message });
  }
});

/* 下载 Word 文档 */
app.get('/api/download', (req, res) => {
  const month = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  const type = req.query.type === 'summary' || req.query.type === 'plan' ? req.query.type : null;
  if (!month || !departmentId) return res.status(400).json({ ok: false, error: '参数不完整' });
  const reports = getReports();
  const r = reports[reportKey(month, departmentId)];
  if (!r) return res.status(404).json({ ok: false, error: '文档不存在，请先生成' });
  // 新版：单份合并文档 reportFile；兼容旧版：summaryFile/planFile
  let file = null;
  if (r.reportFile) {
    file = path.join(REPORTS_DIR, r.reportFile);
  } else if (type && r[type === 'summary' ? 'summaryFile' : 'planFile']) {
    file = path.join(REPORTS_DIR, r[type === 'summary' ? 'summaryFile' : 'planFile']);
  }
  if (!file || !fs.existsSync(file)) return res.status(404).json({ ok: false, error: '文档不存在，请先重新生成' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });
  const { year, num } = splitMonth(month);
  const pm = splitMonth(nextMonth(month));
  let displayName;
  if (r.reportFile) {
    displayName = `${dept.name}${year}年${num}月工作总结及${pm.year}年${pm.num}月工作计划.docx`;
  } else {
    const kindName = type === 'summary' ? '工作总结' : '工作计划';
    const tm = type === 'plan' ? nextMonth(month) : month;
    const t = splitMonth(tm);
    displayName = `${dept.name}${t.year}年${t.num}月${kindName}.docx`;
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  fs.createReadStream(file).pipe(res);
});

/* 发送邮件给教研室主任 */
app.post('/api/send', async (req, res) => {
  const { month, departmentId } = req.body || {};
  const m = safeMonth(month);
  if (!m || !departmentId) return res.status(400).json({ ok: false, error: '参数不完整' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });
  const reports = getReports();
  const key = reportKey(m, departmentId);
  const r = reports[key];
  if (!r) return res.status(400).json({ ok: false, error: '请先生成 Word 文档' });
  if (!dept.headEmail) return res.status(400).json({ ok: false, error: '该教研室未配置主任邮箱，请在设置页补充' });

  const settings = getSettings();
  if (settings.mailer.method !== 'agently' && (!settings.smtp.host || !settings.smtp.user)) {
    return res.status(400).json({ ok: false, error: '未配置邮件发送服务，请在设置页配置' });
  }

  try {
    let files = [];
    if (r.reportFile) {
      const f = path.join(REPORTS_DIR, r.reportFile);
      if (fs.existsSync(f)) files = [f];
    } else {
      files = [r.summaryFile, r.planFile].map((n) => path.join(REPORTS_DIR, n)).filter((f) => fs.existsSync(f));
    }
    if (!files.length) return res.status(400).json({ ok: false, error: 'Word 文档文件缺失，请重新生成' });
    const info = await sendReportMail(settings, dept, m, r.memberCount, files);
    r.sentAt = fmtDateTime(Date.now());
    r.sentTo = dept.headEmail;
    saveReports(reports);
    res.json({ ok: true, sentAt: r.sentAt, sentTo: r.sentTo, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: '邮件发送失败：' + e.message });
  }
});

/* ---------------- 设置相关（需管理员令牌） ---------------- */

app.post('/api/settings/login', (req, res) => {
  const { password } = req.body || {};
  const settings = getSettings();
  if (hashPassword(password || '') === settings.adminPassword) {
    return res.json({ ok: true, token: issueToken() });
  }
  res.status(401).json({ ok: false, error: '密码错误' });
});

app.get('/api/settings', (req, res) => {
  if (!checkAuth(req, res)) return;
  const s = getSettings();
  res.json({
    ok: true,
    settings: {
      smtp: { ...s.smtp, pass: s.smtp.pass ? '******' : '' },
      llm: { ...s.llm, apiKey: s.llm.apiKey ? '******' : '' },
      auto: { ...s.auto },
      mailer: { ...s.mailer },
      mail: { ...s.mail },
      adminPasswordSet: !!s.adminPassword,
    },
    departments: getDepartments(),
  });
});

app.put('/api/settings', (req, res) => {
  if (!checkAuth(req, res)) return;
  const s = getSettings();
  const body = req.body || {};

  if (body.smtp) {
    s.smtp = {
      host: String(body.smtp.host || '').trim(),
      port: Number(body.smtp.port) || 465,
      secure: body.smtp.secure !== false,
      user: String(body.smtp.user || '').trim(),
      pass: body.smtp.pass === '******' ? s.smtp.pass : String(body.smtp.pass || ''),
      fromName: String(body.smtp.fromName || '').trim(),
    };
  }
  if (body.llm) {
    s.llm = {
      enabled: body.llm.enabled !== false,
      baseUrl: String(body.llm.baseUrl || 'https://api.deepseek.com').trim(),
      apiKey: body.llm.apiKey === '******' ? s.llm.apiKey : String(body.llm.apiKey || '').trim(),
      model: String(body.llm.model || 'deepseek-chat').trim(),
      temperature: Number(body.llm.temperature) || 0.6,
    };
  }
  if (body.auto) {
    s.auto = {
      enabled: body.auto.enabled !== false,
      collegeEmail: String(body.auto.collegeEmail || '').trim(),
      alsoSendToHead: body.auto.alsoSendToHead !== false,
    };
  }
  if (body.mailer) {
    s.mailer = { method: body.mailer.method === 'smtp' ? 'smtp' : 'agently' };
  }
  if (body.mail) {
    s.mail = {
      subjectTemplate: String(body.mail.subjectTemplate || s.mail.subjectTemplate),
      bodyTemplate: String(body.mail.bodyTemplate || s.mail.bodyTemplate),
    };
  }
  if (body.newPassword && String(body.newPassword).trim()) {
    s.adminPassword = hashPassword(String(body.newPassword).trim());
  }
  saveSettings(s);
  res.json({ ok: true, message: '设置已保存' });
});

app.put('/api/departments', (req, res) => {
  if (!checkAuth(req, res)) return;
  const list = req.body && req.body.departments;
  if (!Array.isArray(list)) return res.status(400).json({ ok: false, error: '数据格式错误' });
  const cleaned = list.map((d) => ({
    id: String(d.id || crypto.randomBytes(6).toString('hex')),
    name: String(d.name || '').trim(),
    headName: String(d.headName || '').trim(),
    headEmail: String(d.headEmail || '').trim(),
    members: Array.isArray(d.members)
      ? d.members.map((m) => ({ name: String((m && m.name) || '').trim() })).filter((m) => m.name)
      : [],
  })).filter((d) => d.name);
  saveDepartments(cleaned);
  res.json({ ok: true, message: '教研室信息已保存' });
});

/* 测试 SMTP（用表单中填写的配置，未保存也可测试） */
app.post('/api/test/smtp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const smtp = body.smtp || {};
  const to = String(body.to || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: '请填写测试收件邮箱' });
  if (!smtp.host || !smtp.user) return res.status(400).json({ ok: false, error: '请先填写 SMTP 主机与账号' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 465,
      secure: smtp.secure !== false,
      auth: { user: smtp.user, pass: smtp.pass || '' },
    });
    await transporter.verify();
    const fromName = smtp.fromName || smtp.user;
    await transporter.sendMail({
      from: `"${fromName}" <${smtp.user}>`,
      to,
      subject: '【测试】月度工作总结与计划生成系统邮件测试',
      text: '这是一封测试邮件，说明 SMTP 配置正确，可以正常发送邮件。',
    });
    res.json({ ok: true, message: `测试邮件已发送至 ${to}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'SMTP 测试失败：' + e.message });
  }
});

/* 测试 LLM 连接 */
app.post('/api/test/llm', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const llm = body.llm || {};
  if (!llm.apiKey) return res.status(400).json({ ok: false, error: '请填写 API Key' });
  const settings = getSettings();
  settings.llm = {
    enabled: true,
    baseUrl: String(llm.baseUrl || 'https://api.deepseek.com').trim(),
    apiKey: String(llm.apiKey || '').trim(),
    model: String(llm.model || 'deepseek-chat').trim(),
    temperature: Number(llm.temperature) || 0.6,
  };
  try {
    const r = await callLLM(settings, '你是一个测试助手，请直接回答"连接成功"。', '测试', { json: false });
    const text = typeof r === 'string' ? r : JSON.stringify(r);
    res.json({ ok: true, message: 'LLM 连接成功，返回：' + String(text).slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'LLM 测试失败：' + e.message });
  }
});

/* ---------------- 个人优化文档（成员个人总结与计划润色版） ---------------- */

const FILE_MYDOCS = path.join(DATA_DIR, 'mydocs.json');
function getMyDocs() { return loadJson(FILE_MYDOCS, {}); }
function saveMyDocs(d) { saveJson(FILE_MYDOCS, d); }
function myDocKey(month, departmentId, memberName) { return `${month}|${departmentId}|${memberName}`; }
function memberHash(name) { return crypto.createHash('md5').update(String(name)).digest('hex').slice(0, 8); }

/** 用大模型把成员个人的总结与计划润色成规范、通顺的成段文字 */
async function polishPersonal(department, memberName, month, summary, plan) {
  const settings = getSettings();
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  if (settings.llm.enabled && settings.llm.apiKey) {
    try {
      const systemPrompt = `你是一名教研室主任，正在协助本教研室教师整理个人月度总结。请以专业的公文口吻，将该教师的原始月度工作总结与工作计划进行润色优化，使其语言通顺、条理清晰、正式规范，形成一份"漂亮的"个人月度总结与计划。

要求：
1. 保留原始内容的全部要点，不得增删事实、不得编造、不得遗漏；
2. 将口语化、零散的表述润色为规范的公文语言，适当合并重复内容；
3. 【严禁编造】不得虚构、夸大原始内容中不存在的事实、数据与数字；原始内容没有具体数量时用定性表述（如"多次""相关工作"），切勿自行添加数字；没有的内容不写；
4. 输出结构：本月工作总结（成段）、工作亮点（1-3条）、问题与不足（1-3条）、下月工作计划（成段）。

严格按以下 JSON 输出（不要输出任何其他文字或 markdown）：
{
  "summary": "润色后的成段本月工作总结，150-300字",
  "highlights": ["亮点1", "亮点2"],
  "problems": ["不足1", "不足2"],
  "plan": "润色后的成段下月工作计划，150-300字"
}`;
      const userContent = `姓名：${memberName}\n教研室：${department.name}\n总结月份（本月）：${fmtMonthLabel(month)}\n计划月份（下月）：${fmtMonthLabel(nextMonth(month))}\n\n【原始本月工作总结】\n${summary}\n\n【原始下月工作计划】\n${plan}`;
      const raw = await callLLM(settings, systemPrompt, userContent);
      return {
        usedLlm: true,
        note: '',
        summary: str(raw.summary) || summary,
        highlights: arr(raw.highlights),
        problems: arr(raw.problems),
        plan: str(raw.plan) || plan,
      };
    } catch (e) {
      return {
        usedLlm: false,
        note: '大模型润色失败，已使用原始内容：' + e.message,
        summary: String(summary), highlights: [], problems: [], plan: String(plan),
      };
    }
  }
  return { usedLlm: false, note: '', summary: String(summary), highlights: [], problems: [], plan: String(plan) };
}

function buildPersonalDocx(data) {
  const children = [];
  children.push(titlePara(data.title));
  children.push(metaPara(`（${data.deptName}　生成日期：${data.generatedDate}）`));
  children.push(headingPara('一、本月工作总结'));
  contentParas(data.summary).forEach((p) => children.push(p));
  children.push(headingPara('二、工作亮点'));
  listPara(data.highlights).forEach((p) => children.push(p));
  children.push(headingPara('三、存在的问题与不足'));
  listPara(data.problems).forEach((p) => children.push(p));
  children.push(headingPara('四、下月工作计划'));
  contentParas(data.plan).forEach((p) => children.push(p));
  return wrapDocument(children);
}

/** 生成个人优化文档（内部函数，供手动接口与提交后自动触发复用） */
async function generatePersonalDocInternal(dept, memberName, month) {
  const sub = getSubmissions().find(
    (s) => s.month === month && s.departmentId === dept.id && s.memberName === memberName
  );
  if (!sub) return { ok: false, error: '该成员本月还没有提交内容' };
  const pol = await polishPersonal(dept, memberName, month, sub.summary, sub.plan);
  const { year, num } = splitMonth(month);
  const pm = splitMonth(nextMonth(month));
  const doc = buildPersonalDocx({
    title: `${memberName}${year}年${num}月个人工作总结与${pm.year}年${pm.num}月工作计划`,
    deptName: dept.name,
    generatedDate: fmtDate(),
    summary: pol.summary,
    highlights: pol.highlights,
    problems: pol.problems,
    plan: pol.plan,
  });
  const buffer = await Packer.toBuffer(doc);
  const file = path.join(REPORTS_DIR, `${month}_${dept.id}_${memberHash(memberName)}_personal.docx`);
  fs.writeFileSync(file, buffer);

  const docs = getMyDocs();
  const key = myDocKey(month, dept.id, memberName);
  const prev = docs[key];
  docs[key] = {
    generatedAt: fmtDateTime(Date.now()),
    file: path.basename(file),
    usedLlm: pol.usedLlm,
    note: pol.note || '',
    sentAt: prev && prev.sentAt ? prev.sentAt : null,
    sentTo: prev && prev.sentTo ? prev.sentTo : null,
    autoSentAt: prev && prev.autoSentAt ? prev.autoSentAt : null,
    autoSentTo: prev && prev.autoSentTo ? prev.autoSentTo : null,
    preview: {
      summary: pol.summary.slice(0, 200),
      plan: pol.plan.slice(0, 200),
      highlights: pol.highlights,
      problems: pol.problems,
    },
  };
  saveMyDocs(docs);
  return { ok: true, usedLlm: pol.usedLlm, note: pol.note || '', file, key, preview: docs[key].preview };
}

/** 发送个人优化文档到学院指定邮箱（内部函数） */
async function sendPersonalDocInternal(dept, memberName, month, file) {
  const settings = getSettings();
  if (!settings.auto.collegeEmail) return { ok: false, error: '未配置「二级学院指定邮箱」，无法发送（请在设置页-自动汇总设置中填写）' };
  const { year, num } = splitMonth(month);
  const pm = splitMonth(nextMonth(month));
  const subject = `【个人总结】${memberName} ${year}年${num}月个人工作总结与${pm.year}年${pm.num}月工作计划`;
  const body = `您好！\n\n${dept.name}教师${memberName}的《${year}年${num}月个人工作总结与${pm.year}年${pm.num}月工作计划》已由系统优化生成，详见附件，请查收。\n\n—— 月度工作总结与计划生成系统（自动发送，请勿直接回复）`;
  const info = await sendMail(settings, settings.auto.collegeEmail, subject, body, [file]);
  return { ok: true, sentTo: settings.auto.collegeEmail, messageId: info && info.messageId };
}

/* 生成/更新个人优化文档 */
app.post('/api/my-doc/generate', async (req, res) => {
  const { month, departmentId, memberName } = req.body || {};
  const m = safeMonth(month);
  const name = String(memberName || '').trim();
  if (!m || !departmentId || !name) return res.status(400).json({ ok: false, error: '参数不完整' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });
  try {
    const r = await generatePersonalDocInternal(dept, name, m);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({
      ok: true,
      usedLlm: r.usedLlm,
      note: r.note || '',
      downloadUrl: `/api/my-doc/download?month=${m}&departmentId=${departmentId}&memberName=${encodeURIComponent(name)}`,
      preview: r.preview,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: '生成失败：' + e.message });
  }
});

/* 个人优化文档状态 */
app.get('/api/my-doc/status', (req, res) => {
  const m = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  const name = String(req.query.memberName || '').trim();
  if (!m || !departmentId || !name) return res.status(400).json({ ok: false, error: '参数不完整' });
  const r = getMyDocs()[myDocKey(m, departmentId, name)];
  if (!r) return res.json({ ok: true, generated: false });
  res.json({
    ok: true,
    generated: true,
    generatedAt: r.generatedAt,
    usedLlm: r.usedLlm,
    note: r.note || '',
    sentAt: r.sentAt || null,
    sentTo: r.sentTo || null,
    preview: r.preview || null,
  });
});

/* 下载个人优化文档 */
app.get('/api/my-doc/download', (req, res) => {
  const m = safeMonth(req.query.month);
  const departmentId = String(req.query.departmentId || '');
  const name = String(req.query.memberName || '').trim();
  if (!m || !departmentId || !name) return res.status(400).json({ ok: false, error: '参数不完整' });
  const r = getMyDocs()[myDocKey(m, departmentId, name)];
  if (!r || !r.file) return res.status(404).json({ ok: false, error: '文档不存在，请先生成' });
  const file = path.join(REPORTS_DIR, r.file);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '文档文件缺失，请重新生成' });
  const { year, num } = splitMonth(m);
  const pm = splitMonth(nextMonth(m));
  const displayName = `${name}${year}年${num}月个人工作总结与${pm.year}年${pm.num}月工作计划.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="personal.docx"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  fs.createReadStream(file).pipe(res);
});

/* 发送个人优化文档到指定邮箱（二级学院指定邮箱） */
app.post('/api/my-doc/send', async (req, res) => {
  const { month, departmentId, memberName } = req.body || {};
  const m = safeMonth(month);
  const name = String(memberName || '').trim();
  if (!m || !departmentId || !name) return res.status(400).json({ ok: false, error: '参数不完整' });
  const dept = getDepartments().find((d) => d.id === departmentId);
  if (!dept) return res.status(400).json({ ok: false, error: '教研室不存在' });
  const docs = getMyDocs();
  const key = myDocKey(m, departmentId, name);
  const r = docs[key];
  if (!r || !r.file) return res.status(400).json({ ok: false, error: '请先生成个人优化文档' });
  const file = path.join(REPORTS_DIR, r.file);
  if (!fs.existsSync(file)) return res.status(400).json({ ok: false, error: '文档文件缺失，请重新生成' });
  try {
    const s = await sendPersonalDocInternal(dept, name, m, file);
    if (!s.ok) return res.status(400).json({ ok: false, error: s.error });
    r.sentAt = fmtDateTime(Date.now());
    r.sentTo = s.sentTo;
    saveMyDocs(docs);
    res.json({ ok: true, sentAt: r.sentAt, sentTo: r.sentTo, messageId: s.messageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: '发送失败：' + e.message });
  }
});

/* 404 兜底 */
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

/* ---------------- 启动 ---------------- */

ensureDirs();
startAutoScheduler();
const server = app.listen(PORT, () => {
  console.log('==================================================');
  console.log('  月度工作总结与计划生成系统 已启动');
  console.log(`  访问地址: http://127.0.0.1:${PORT}`);
  console.log(`  成员提交: http://127.0.0.1:${PORT}/`);
  console.log(`  汇总生成: http://127.0.0.1:${PORT}/report.html`);
  console.log(`  系统设置: http://127.0.0.1:${PORT}/settings.html`);
  console.log('  默认管理员密码: admin123（请在设置页修改）');
  console.log('==================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('==================================================');
    console.error(`  端口 ${PORT} 已被占用，无法启动服务。`);
    console.error('  可能原因：');
    console.error(`   1. 服务已经在运行 —— 直接访问 http://127.0.0.1:${PORT} 即可，无需重复启动；`);
    console.error('   2. 该端口被其他程序占用 —— 关闭占用程序，或换个端口启动：set PORT=3082 后重新运行。');
    console.error('==================================================');
    process.exit(1);
  }
  throw err;
});
