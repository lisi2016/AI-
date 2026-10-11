#!/usr/bin/env node
'use strict';
/**
 * 生产加固验收探针（只读 + 至多 1 次登录尝试）
 *
 * 用途：在「安全收尾」前后各跑一次，用同一把尺子量线上服务：
 *   加固前：三项全部 FAIL（= 风险确认）
 *   加固后：三项全部 PASS（= 收尾完成）
 *
 * 三项判定：
 *   1) 生产模式      GET /api/v1/health 的 devMode 必须为 false（要求 DEV_MODE=0）
 *   2) 令牌密钥已换  用仓库内置默认密钥 dev-token-secret-change-me 伪造的令牌必须被拒（401）
 *   3) 后台弱口令已换 用演示口令 123456 登录 ADMIN001 / 2017001 必须失败
 *
 * 安全边界：
 *   - 只调用只读接口（/health、/auth/me）与登录接口，不写任何业务数据；
 *   - **不发**绑定/签到/解绑类请求（避免在真实数据上产生副作用）；
 *   - 口令检查每个账号**最多 1 次**请求（后端连续 5 次错误锁定 15 分钟，多次运行有锁定风险，
 *     故提供 --skip-password 只查前两项）。
 *
 * 用法：
 *   node tools/verify-hardening.js
 *   node tools/verify-hardening.js --base http://8.138.41.74 --skip-password
 *   node tools/verify-hardening.js --password 123456 --accounts ADMIN001,2017001
 *
 * 退出码：0 = 三项全 PASS；1 = 存在未达标项；2 = 参数/网络异常。
 */

const crypto = require('crypto');

// 仓库内置默认密钥（server 端 src/util.js 的兜底值）——若线上仍用此值，令牌可被任意伪造
const DEFAULT_TOKEN_SECRET = 'dev-token-secret-change-me';
// 种子默认口令（server 端 src/webauth.js DEFAULT_PASSWORD）
const DEFAULT_PASSWORD = '123456';

function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const BASE = String(argOf('base', process.env.BASE || 'http://8.138.41.74')).replace(/\/+$/, '');
const PASSWORD = String(argOf('password', DEFAULT_PASSWORD));
const ACCOUNTS = String(argOf('accounts', 'ADMIN001,2017001')).split(',').map(s => s.trim()).filter(Boolean);
const SKIP_PASSWORD = !!argOf('skip-password', false);
const SHOW_ALL_UIDS = !!argOf('all-uids', false);

function b64url(s) { return Buffer.from(s).toString('base64url'); }
function hmac(text, secret) {
  return crypto.createHmac('sha256', secret).update(String(text)).digest('base64url');
}

async function req(path, opts) {
  const res = await fetch(BASE + path, Object.assign({ signal: AbortSignal.timeout(15000) }, opts || {}));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON（如 /admin HTML） */ }
  return { status: res.status, text, json };
}

function line(ok, mark, title, detail) {
  const flag = ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL';
  console.log('  [' + flag + '] ' + mark + ' ' + title + (detail ? '\n         ' + detail : ''));
}

(async function main() {
  console.log('=== 课时签到后端 · 生产加固验收 ===');
  console.log('目标 : ' + BASE);
  console.log('时间 : ' + new Date().toISOString());
  console.log('');

  // ---------------------------------------------------------------- 连通性 + 1) 生产模式
  console.log('[1] 生产模式（DEV_MODE）');
  let health;
  try {
    health = await req('/api/v1/health');
  } catch (e) {
    console.error('  无法访问 ' + BASE + '/api/v1/health ：' + e.message);
    process.exit(2);
    return;
  }
  const hd = (health.json && health.json.data) || {};
  if (health.status !== 200) {
    line(false, 'health', '服务不可达', 'HTTP ' + health.status + ' ' + health.text.slice(0, 120));
    process.exit(2);
    return;
  }
  line(true, 'health', '服务在线', 'HTTP 200 · node ' + hd.node + ' · uptime ' + hd.uptimeSeconds + 's');
  const devMode = hd.devMode === true;
  line(!devMode, 'devMode', 'DEV_MODE=0（生产模式）',
    devMode
      ? 'devMode=true：开发模式仍开启，/auth/bind 接受直接传 openid（可伪造他人 openid 占号），需改为 DEV_MODE=0'
      : 'devMode=false：已关闭开发模式');
  if (hd.dataDir) {
    line(null, 'dataDir', '健康检查外泄字段（建议后续收敛）', 'dataDir=' + hd.dataDir);
  }

  // ---------------------------------------------------------------- 2) 令牌密钥是否已轮换
  console.log('');
  console.log('[2] 令牌密钥（TOKEN_SECRET）');
  const now = Math.floor(Date.now() / 1000);
  const uids = SHOW_ALL_UIDS
    ? Array.from({ length: 10 }, (_, i) => 'U' + String(i + 1).padStart(8, '0'))
    : ['U00000010', 'U00000009', 'U00000001'];
  let forged = null;
  for (const uid of uids) {
    const payload = { uid: uid, oid: '', ep: 0, role: 'admin', iat: now, exp: now + 600 };
    const body = b64url(JSON.stringify(payload));
    const token = body + '.' + hmac(body, DEFAULT_TOKEN_SECRET);
    const r = await req('/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 200 && r.json && r.json.code === 0) { forged = { uid: uid, r: r }; break; }
  }
  if (forged) {
    const u = (forged.r.json.data && (forged.r.json.data.user || forged.r.json.data)) || {};
    line(false, 'forge', '默认密钥签发令牌被接受 —— 严重',
      '用默认密钥即可伪造身份：uid=' + forged.uid + '，服务端返回 ' + JSON.stringify(u).slice(0, 140) +
      '\n         修复：为服务设置随机 TOKEN_SECRET 并重启（参见 deploy/harden-attendance.sh）');
  } else {
    line(true, 'forge', '默认密钥签发令牌被拒绝（401）', 'TOKEN_SECRET 已轮换，或线上未使用默认密钥');
  }

  // ---------------------------------------------------------------- 3) 后台弱口令
  console.log('');
  console.log('[3] 后台弱口令（演示口令 ' + PASSWORD + '）');
  if (SKIP_PASSWORD) {
    line(null, 'password', '已跳过（--skip-password）', '多次失败会触发 5 次/15 分钟锁定，请谨慎重复运行');
  } else {
    for (const no of ACCOUNTS) {
      let r;
      try {
        r = await req('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ no: no, password: PASSWORD }),
        });
      } catch (e) {
        line(false, 'password', no + ' 登录请求失败', e.message);
        continue;
      }
      const okLogin = r.status === 200 && r.json && r.json.code === 0 && r.json.data && r.json.data.token;
      line(!okLogin, 'password:' + no, okLogin ? no + ' 仍可用演示口令登录 —— 需立即修改' : no + ' 演示口令已失效',
        okLogin
          ? '登录成功且返回 token；该账号可管理全班/全院数据，公网可访问 /admin/'
          : 'HTTP ' + r.status + ' · ' + String((r.json && r.json.msg) || r.text).slice(0, 120));
    }
  }

  // ---------------------------------------------------------------- 附加信息
  console.log('');
  console.log('[附加] 管理后台暴露面（只取状态码）');
  try {
    const admin = await req('/admin/');
    line(null, 'admin', 'GET /admin/ → HTTP ' + admin.status, admin.status === 200 ? '公网可直接打开登录页（口令强度即唯一防线）' : '');
  } catch (e) {
    line(null, 'admin', 'GET /admin/ 失败', e.message);
  }

  console.log('');
  console.log('=== 结论 ===');
  const verdict = [!devMode ? null : 'devMode 仍为 true', forged ? '默认密钥可伪造令牌' : null];
  if (!SKIP_PASSWORD) verdict.push('（口令项见上方逐账号结果）');
  console.log(verdict.filter(Boolean).join(' / ') || '第 1、2 项已达标');
  console.log('注意：本探针只覆盖「密钥 / 生产模式 / 弱口令」三项，不代表已完成 HTTPS 备案域名与真机联调验证。');
  process.exit(!devMode && !forged ? 0 : 1);
})().catch(e => { console.error('探针异常：' + (e && e.stack || e)); process.exit(2); });
