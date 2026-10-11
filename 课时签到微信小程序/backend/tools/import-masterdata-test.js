'use strict';
/**
 * 主数据导入单测（院系 / 教学班）：不起 HTTP 服务，直接调用业务层
 *   node tools/import-masterdata-test.js
 *
 * 覆盖：
 *   1) IMPORT_TYPES 含 depts|classes 且排在业务数据之前；表头 / 模板 / 导出当前数据
 *   2) 院系：按名称更新、新增（ID 自动续号不与种子数据撞号）、上级院系、填 ID 改名、名称冲突、自引用
 *   3) 教学班：按名称更新、新增、所属院系严格匹配（不做模糊）、年级自动识别、状态 active|archived|leave
 *   4) 整批校验语义：任一行失败整批不落库；同一文件重复键报错；导入不删除任何行
 *   5) 导入前快照与回滚
 *   6) 归档行仍可按名称匹配，但同名时优先匹配在用行
 *   7) 回归：白名单 / 课表导入不受影响
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsq-md-'));
process.env.DATA_DIR = tmp;

const u = require('../src/util');
const store = require('../src/store');
const seed = require('../src/seed');
const io = require('../src/io');

let pass = 0;
let failCount = 0;
const failures = [];
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, detail) { failCount++; failures.push(name + ' :: ' + detail); console.log('  ✗ ' + name + '  → ' + detail); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail || '断言失败'); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
function csv(rows) { return Buffer.from('\ufeff' + rows.join('\r\n') + '\r\n', 'utf8'); }
function codeOf(fn) { try { fn(); return { code: 0 }; } catch (e) { return { code: e.code, msg: e.message }; } }

console.log('主数据导入单测（临时数据目录 ' + tmp + '）');
u.ensureDirs();
store.load();
seed.create();
store.flushAll();

const admin = store.find('users', function (x) { return x.role === 'admin'; });
const ctx = { user: admin, ip: '127.0.0.1', device: 'md-test', traceId: 'md' };
const DEPT_H = '院系名称,院系代码,上级院系,院系ID';
const CLASS_H = '教学班名称,年级,所属院系,班主任,教学班ID,状态';

// ---------------------------------------------------------------- 1. 类型与模板
section('1. 类型 / 表头 / 模板 / 导出当前数据');
check(io.IMPORT_TYPES.join(',') === 'depts,classes,tasks,students,whitelist,cadres',
  'IMPORT_TYPES = 基础数据在前（depts,classes,tasks,students,whitelist,cadres）', io.IMPORT_TYPES.join('|'));
check(io.IMPORT_TABLES_OF.depts.join() === 'depts' && io.IMPORT_TABLES_OF.classes.join() === 'classes',
  '快照/回滚表登记 depts 与 classes（各自只影响本表）');
const tD = io.template('depts');
const tC = io.template('classes');
check(tD.headers.length === 4 && tD.csv.indexOf('院系名称') === 1, 'depts 模板 4 列（院系名称/院系代码/上级院系/院系ID）', tD.headers.join('|'));
check(tC.headers.length === 6 && /状态$/.test(tC.headers[5]), 'classes 模板 6 列（末列状态）', tC.headers.join('|'));
const tDData = io.template('depts', true, true);
check(tDData.exported === true && tDData.fileName === 'export_depts.csv' && tDData.csv.indexOf('D00000001') > 0,
  '?data=1 导出当前院系（带 ID，可改名后重新导入）', tDData.fileName + ' / ' + tDData.totalRows + ' 行');
const tCData = io.template('classes', true, true);
check(tCData.exported === true && tCData.csv.indexOf('C00000001') > 0 && tCData.csv.indexOf('护理学院') > 0,
  '?data=1 导出当前教学班（含院系名称与 ID）');

// ---------------------------------------------------------------- 2. 院系
section('2. 院系导入（按名称更新 / 新增 / 改名 / 上级院系）');
check(store.all('depts').length === 2, '种子院系 2 条（D00000001 护理学院 / D00000002 药学院）', store.all('depts').length);

const preNew = io.precheck(admin, 'depts', csv([DEPT_H, '康养学院,KY,,']));
check(preNew.valid === true && preNew.totalRows === 1 && preNew.importableRows === 1, '新增院系预校验通过', preNew.note);
const imp1 = io.importCsv(admin, 'depts', csv([DEPT_H, '康养学院,KY,,']), ctx);
const created = store.all('depts').filter(function (d) { return d.name === '康养学院'; })[0];
check(imp1.committed === true && store.all('depts').length === 3, '新增院系落库', 'depts=' + store.all('depts').length);
check(!!created && /^D\d{8}$/.test(created.id) && created.id !== 'D00000001' && created.id !== 'D00000002',
  '新增 ID 自动续号（取现有最大序号 +1，不与种子数据撞号）', created && created.id);
check(!!created && created.status === 'active' && !!created.created_at, '新增行补 status/created_at',
  created && created.status + ' ' + created.created_at);

const imp2 = io.importCsv(admin, 'depts', csv([DEPT_H, '药学院,YX2,康养学院,']), ctx);
const yx = store.all('depts').filter(function (d) { return d.name === '药学院'; })[0];
check(imp2.committed === true && store.all('depts').length === 3 && yx.code === 'YX2' && String(yx.parent_id) === String(created.id),
  '按名称命中既有院系 → 原地覆盖更新（不新增行），上级院系按名称解析', 'code=' + yx.code + ' parent=' + yx.parent_id);

const imp3 = io.importCsv(admin, 'depts', csv([DEPT_H, '智慧康养学院,KY,,' + created.id]), ctx);
const renamed = store.findById('depts', created.id);
check(imp3.committed === true && renamed.name === '智慧康养学院' && store.all('depts').length === 3,
  '填院系ID → 支持原地改名（不产生第二行）', renamed.id + ' ' + renamed.name);

const preClash = io.precheck(admin, 'depts', csv([DEPT_H, '智慧康养学院,,,D00000002']));
check(preClash.valid === false && /已被 D00000003 使用|已被/.test(preClash.errors[0].msg), '改名撞其他院系名称 → 校验失败',
  preClash.errors[0] && preClash.errors[0].msg);
const preSelf = io.precheck(admin, 'depts', csv([DEPT_H, '智慧康养学院,,智慧康养学院,' + created.id]));
check(preSelf.valid === false && /不能是自己/.test(preSelf.errors[0].msg), '上级院系不能是自己', preSelf.errors[0] && preSelf.errors[0].msg);
const preId = io.precheck(admin, 'depts', csv([DEPT_H, '新学院,,,D00009999']));
check(preId.valid === false && /不存在/.test(preId.errors[0].msg) && preId.errors[0].field === 'D00009999',
  '院系ID 不存在 → 报错且问题字段为该 ID', preId.errors[0] && preId.errors[0].msg);
const preParent = io.precheck(admin, 'depts', csv([DEPT_H, '新学院,,不存在的学院,']));
check(preParent.valid === false && /上级院系/.test(preParent.errors[0].msg), '上级院系不存在 → 报错（提示先导入该院系）',
  preParent.errors[0] && preParent.errors[0].msg);
const preEmptyName = io.precheck(admin, 'depts', csv([DEPT_H, ',KY,,']));
check(preEmptyName.valid === false && preEmptyName.errors[0].field === '院系名称', '院系名称为空 → 问题字段=院系名称',
  preEmptyName.errors[0] && preEmptyName.errors[0].msg);

// ---------------------------------------------------------------- 3. 教学班
section('3. 教学班导入（年级自动识别 / 院系严格匹配 / 状态）');
const tplC = io.template('classes');
check(tplC.csv.indexOf('2025级护理3班') > 0 && tplC.csv.indexOf(',2025,') > 0, 'classes 模板样例自带年级列');
const preCls = io.precheck(admin, 'classes', csv([CLASS_H, '2024级护理1班,,护理学院,王芳,,']));
check(preCls.valid === true, '年级留空不影响校验通过（落库时从「2024级」自动识别）', 'validRows=' + preCls.validRows);
const imp4 = io.importCsv(admin, 'classes', csv([CLASS_H, '2024级护理1班,,护理学院,王芳,,']), ctx);
const newCls = store.all('classes').filter(function (c) { return c.name === '2024级护理1班'; })[0];
check(imp4.committed === true && !!newCls && newCls.grade === '2024' && newCls.dept_id === 'D00000001' && newCls.status === 'active' && store.all('classes').length === 3,
  '新增教学班：院系按名称解析 + 默认 active + ID 自动续号', newCls && (newCls.id + ' dept=' + newCls.dept_id + ' ' + newCls.status));

const imp5 = io.importCsv(admin, 'classes', csv([CLASS_H, '2025级护理3班,2025,护理学院,李娜,,归档']), ctx);
const c1 = store.findById('classes', 'C00000001');
check(imp5.committed === true && c1.advisor === '李娜' && c1.status === 'archived' && store.all('classes').length === 3,
  '按名称命中既有教学班 → 原地覆盖（含状态 归档），不新增行', c1.id + ' ' + c1.advisor + '/' + c1.status);
const impStatusEn = io.importCsv(admin, 'classes', csv([CLASS_H, '2024级护理1班,2024,护理学院,王芳,,leave']), ctx);
check(impStatusEn.committed === true && store.findById('classes', newCls.id).status === 'leave', '状态支持英文 leave', store.findById('classes', newCls.id).status);

const preFuzzy = io.precheck(admin, 'classes', csv([CLASS_H, '2024级护理1班,2024,护理,王芳,,active']));
check(preFuzzy.valid === false && /所属院系/.test(preFuzzy.errors[0].msg), '所属院系严格匹配（「护理」不会误配「护理学院」）',
  preFuzzy.errors[0] && preFuzzy.errors[0].msg);
const preNoDept = io.precheck(admin, 'classes', csv([CLASS_H, '2024级护理2班,2024,,王芳,,active']));
check(preNoDept.valid === false && preNoDept.errors[0].field === '所属院系', '所属院系必填（问题字段=所属院系）',
  preNoDept.errors[0] && preNoDept.errors[0].msg);
const preBadStatus = io.precheck(admin, 'classes', csv([CLASS_H, '2024级护理1班,2024,护理学院,王芳,,停用中']));
check(preBadStatus.valid === false && /状态/.test(preBadStatus.errors[0].msg), '状态取值非法 → 报错并列出可用值',
  preBadStatus.errors[0] && preBadStatus.errors[0].msg);

// ---------------------------------------------------------------- 4. 整批校验语义
section('4. 整批校验：任一行失败整批不落库 / 重复键 / 不删除');
const beforeClasses = store.all('classes').length;
const impBad = io.importCsv(admin, 'classes', csv([CLASS_H, '2023级药学2班,2023,药学院,赵敏,,active', '2023级坏班,2023,不存在的学院,,,active']), ctx);
check(impBad.committed === false && store.all('classes').length === beforeClasses,
  '一行不合法 → 整批不落库（含合法行也不入库）', 'committed=' + impBad.committed + ' classes=' + store.all('classes').length);
check(impBad.job.status === 'failed' && !!impBad.job.error_report_url &&
  fs.existsSync(path.join(u.EXPORT_DIR, impBad.job.error_report_url)), '失败生成错误报告 CSV', impBad.job.error_report_url);

const impDup = io.importCsv(admin, 'depts', csv([DEPT_H, '口腔学院,KQ,,', '口腔学院,KQ2,,']), ctx);
check(impDup.committed === false && store.all('depts').length === 3 && /重复/.test(impDup.errors[0].msg),
  '同一文件内重复院系 → 整批拒绝（不静默覆盖）', impDup.errors.map(function (e) { return e.msg; }).join(' / '));

const impOne = io.importCsv(admin, 'depts', csv([DEPT_H, '药学院,YX,,']), ctx);
check(impOne.committed === true && store.all('depts').length === 3 && !!store.all('depts').filter(function (d) { return d.name === '护理学院'; })[0],
  '只导 1 行不会删除其他院系（导入从不删行）', 'depts=' + store.all('depts').length);

// ---------------------------------------------------------------- 5. 快照与回滚
section('5. 导入前快照与回滚');
check(!!impOne.job.snapshot_file, '导入前写入快照（可回滚）', impOne.job.snapshot_file);
const rb = io.rollbackImport(admin, impOne.job.id, ctx);
const yxAfter = store.all('depts').filter(function (d) { return d.name === '药学院'; })[0];
check(rb.ok === true && yxAfter.code === 'YX2' && store.all('depts').length === 3,
  '回滚恢复导入前数据（药学院代码回到 YX2，行数不变）', 'code=' + yxAfter.code);
check(codeOf(function () { io.rollbackImport(admin, impBad.job.id, ctx); }).code === 42201, '失败任务不可回滚（42201 BAD_STATE）');

// ---------------------------------------------------------------- 6. 名称匹配口径
section('6. 归档行仍可用，但同名时优先在用行');
const arch = store.findById('classes', 'C00000001');
check(String(arch.status) === 'archived' && !!io.findClassByName('2025级护理3班'),
  '归档教学班仍可按名称匹配（历史业务数据、绑定不受影响）', arch.id + ' ' + arch.status);
store.insert('classes', {
  id: 'C00000099', name: '2025级护理3班', grade: '2025', dept_id: 'D00000001',
  advisor: '', status: 'active', created_at: u.isoNow(),
});
check(String(io.findClassByName('2025级护理3班').id) === 'C00000099',
  '同名时优先匹配在用（active）教学班，不再误配归档行');

// ---------------------------------------------------------------- 7. 回归
section('7. 回归：白名单 / 课表导入不受影响');
const wl = io.precheck(admin, 'whitelist', csv(['工号/学号,姓名,角色,院系,教学班', '2099001,测试教师,teacher,护理学院,']));
check(wl.valid === true, '白名单预校验仍通过（院系名解析正常）', 'validRows=' + wl.validRows);
const prTasks = io.precheck(admin, 'tasks', csv([
  '学期,工号,教师姓名,课程代码,课程名称,教学班,星期,节次,开始,结束,地点,周次,学时',
  '2026-2027-1,2010032,唐瑞明,XXJS001,信息技术,2025级护理3班,周三,1-2,08:00,09:40,实训楼A302,1-18,2',
]));
check(prTasks.valid === true, '课表预校验仍通过（教学班按名称解析）', prTasks.errors[0] && prTasks.errors[0].msg);
const preBadType = codeOf(function () { io.precheck(admin, 'unknown', csv(['a'])); });
check(preBadType.code === 40001 && /depts/.test(preBadType.msg), '未知类型报错文案包含新增类型', preBadType.msg);

// ---------------------------------------------------------------- 8. 审计与历史
section('8. 审计日志与导入历史');
const logs = store.all('audit_logs').filter(function (l) { return l.action === 'import.success'; });
check(logs.length >= 5, '主数据导入写审计日志', 'import.success=' + logs.length);
const hist = io.listImportJobs(admin, { pageSize: 50 });
check(Array.isArray(hist.list) && hist.list.some(function (j) { return j.type === 'depts'; }) &&
  hist.list.some(function (j) { return j.type === 'classes'; }), '导入历史含 depts / classes 任务', 'total=' + hist.total);

// ---------------------------------------------------------------- 结果
console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' / 失败 ' + failCount);
if (failCount) {
  console.log('失败项：');
  failures.forEach(function (f) { console.log('  · ' + f); });
  process.exit(1);
}
console.log('主数据导入单测全部通过。');
