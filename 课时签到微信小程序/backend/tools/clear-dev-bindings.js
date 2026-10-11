#!/usr/bin/env node
'use strict';
/**
 * 清理开发模式（DEV_MODE=1）遗留的模拟绑定。
 *
 * 背景：开发模式下 openid 由 wx.login 的 code 派生（dev_ 前缀），每次登录的 code 都不同，
 * 因此反复联调会在 users.json 里留下大量模拟绑定。本脚本把 openid 以 dev_ 开头的绑定清空，
 * 让演示账号可以重新绑定。
 *
 * 用法（必须在停掉服务后执行，否则内存态可能覆盖文件）：
 *   systemctl stop attendance && node tools/clear-dev-bindings.js && systemctl start attendance
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const file = path.join(dir, 'users.json');

if (!fs.existsSync(file)) {
  console.error('未找到 ' + file + '（数据目录：' + dir + '）');
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(file, 'utf8'));
let cleared = 0;
const keep = [];
users.forEach(function (u) {
  if (u.openid && /^dev_/i.test(String(u.openid))) {
    console.log('  清理绑定：' + (u.real_name || u.id) + '（' + (u.staff_no || u.student_no || '-') + '）openid=' + String(u.openid).slice(0, 14) + '…');
    u.openid = '';
    u.updated_at = new Date().toISOString();
    cleared++;
  } else if (u.openid) {
    keep.push((u.real_name || u.id) + '（真实 openid，保留）');
  }
});

fs.writeFileSync(file, JSON.stringify(users, null, 2) + '\n', 'utf8');
console.log('已清理 ' + cleared + ' 条开发绑定' + (keep.length ? '；保留 ' + keep.join('、') : ''));
