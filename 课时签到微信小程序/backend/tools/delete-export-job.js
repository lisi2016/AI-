#!/usr/bin/env node
'use strict';
/**
 * 删除指定的导出任务（含其 CSV 文件）。用于清理测试产生的导出记录。
 * 用法（需先停服务）： node tools/delete-export-job.js EJ00000004
 */
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_DIR || '/opt/apps/attendance';
const DATA = path.join(APP, 'data');
const EXPORTS = path.join(DATA, 'exports');
const id = String(process.argv[2] || '').trim();
if (!id) { console.error('用法：node tools/delete-export-job.js <jobId>'); process.exit(1); }

const file = path.join(DATA, 'export_jobs.json');
let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const isArr = Array.isArray(raw);
const list = isArr ? raw : (raw.list || []);

const hit = list.filter(function (j) { return String(j.id) === id; });
if (!hit.length) { console.log('未找到导出任务 ' + id + '（可能已删除）'); process.exit(0); }

const keep = list.filter(function (j) { return String(j.id) !== id; });
fs.writeFileSync(file, JSON.stringify(isArr ? keep : Object.assign({}, raw, { list: keep }), null, 2) + '\n', 'utf8');

hit.forEach(function (j) {
  const name = j.file_url || j.file_name || '';
  if (name) {
    const p = path.join(EXPORTS, name);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  已删除文件 ' + name); }
  }
});
console.log('已删除导出任务 ' + id + '（' + list.length + ' → ' + keep.length + ' 条）');
