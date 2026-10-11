#!/usr/bin/env node
'use strict';
/**
 * 清理某一天的课时会话（用于测试复位：删除后同一天可以重新发起、重新出示二维码）。
 *
 * 只删除「课时会话」数据：
 *   - data/period_records.json 中 teach_date === 指定日期 且属于新流程（origin==='session' 或存在 initiator_id）的行
 *   - 这些会话关联的动态码（data/codes.json 中 session_id 命中被删会话的码）
 * **不删除** 操作日志（审计哈希链必须保持不可篡改），日志里仍留有历史痕迹。
 *
 * 用法（必须停服务后执行，避免内存态覆盖文件）：
 *   systemctl stop attendance && node tools/reset-sessions.js [YYYY-MM-DD] && systemctl start attendance
 *   不传日期则默认今天（Asia/Shanghai）。
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const recFile = path.join(dir, 'period_records.json');
const codeFile = path.join(dir, 'codes.json');

function readJson(f) {
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error('解析失败 ' + f + ': ' + e.message); process.exit(1); }
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
const date = (process.argv[2] || today).trim();

const records = readJson(recFile);
if (!Array.isArray(records)) { console.error('未找到 ' + recFile); process.exit(1); }

const removed = records.filter(function (r) {
  return String(r.teach_date) === date && (r.origin === 'session' || r.initiator_id);
});
const keep = records.filter(function (r) { return removed.indexOf(r) < 0; });

if (!removed.length) {
  console.log('日期 ' + date + '：没有需要清理的课时会话');
} else {
  removed.forEach(function (r) {
    console.log('  删除会话 ' + r.id + ' | ' + (r.course_name || '') + ' | ' + (r.teacher_name || '') + ' | ' + r.section + ' | ' + r.status);
  });
  fs.writeFileSync(recFile, JSON.stringify(keep, null, 2) + '\n', 'utf8');
  console.log('已删除 ' + removed.length + ' 条课时会话（' + date + '）');
}

const codes = readJson(codeFile);
if (Array.isArray(codes)) {
  const ids = removed.map(function (r) { return String(r.id); });
  const keepCodes = codes.filter(function (c) { return !(c.session_id && ids.indexOf(String(c.session_id)) >= 0); });
  const dropped = codes.length - keepCodes.length;
  if (dropped) {
    fs.writeFileSync(codeFile, JSON.stringify(keepCodes, null, 2) + '\n', 'utf8');
    console.log('已连带清理 ' + dropped + ' 个动态码');
  }
}
console.log('完成。操作日志未改动（审计链保持完整）。');
