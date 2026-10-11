'use strict';
/**
 * 课堂课时确认与学时统计 —— 后端服务入口
 * 启动：node server.js   （默认 http://127.0.0.1:8081）
 * 契约：docs/miniapp/api-contract.md
 */
const path = require('path');
const express = require('express');
const u = require('./src/util');
const store = require('./src/store');
const audit = require('./src/audit');
const seed = require('./src/seed');
const view = require('./src/view');
const http = require('./src/http');
const webauth = require('./src/webauth');

// 教务处 Web 管理后台静态资源目录：public/admin/
const PUBLIC_DIR = path.join(u.ROOT_DIR, 'public');
const ADMIN_DIR = path.join(PUBLIC_DIR, 'admin');
const ADMIN_INDEX = path.join(ADMIN_DIR, 'index.html');

function bootstrap() {
  u.ensureDirs();
  const missing = store.load();
  // 仅当「用户表为空」时才写种子数据：新增表（如 login_attempts）首次缺失不应触发重复种子
  const needSeed = !store.all('users').length;
  if (missing.length) console.log('[store] 以下数据表文件不存在，已按空表初始化：' + missing.join(', '));
  if (needSeed) {
    const info = seed.create();
    store.flushAll();
    console.log('[seed] 已写入演示种子数据：院系 ' + info.depts + ' 个 / 教学班 ' + info.classes +
      ' 个 / 教师 ' + info.teachers + ' 名 / 班干部 ' + info.cadres + ' 名 / 授课任务 ' +
      info.tasks + ' 条 / 课时记录 ' + info.records + ' 条');
    console.log('[seed] 基准日期：今天 ' + info.weekRef.today + '（' + u.WEEKDAY_CN[info.weekRef.weekday] +
      '），本周周一 ' + info.weekRef.monday);
  }
  // Web 后台账号密码：为缺失密码摘要的用户补齐默认密码（种子/老数据升级）
  const filled = webauth.ensurePasswordHashes();
  if (filled) {
    console.log('[webauth] 已为 ' + filled + ' 个账号补齐默认登录密码（默认 ' + webauth.DEFAULT_PASSWORD +
      '，生产环境请登录后台后立即修改）');
  }
  // 规则配置迁移（旧键名 / 旧内置敏感词表 → 新默认值），管理员自定义过的值不动
  const cfgMigrated = view.migrateLegacyConfig('system');
  if (cfgMigrated.length) {
    console.log('[config] 已迁移历史配置：' + cfgMigrated.join('；'));
  }
  store.installExitHook();
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(http.traceIdMiddleware);
  app.use(http.accessLog);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  // CORS（小程序不需要，但 Web 后台 / 本地调试需要）
  app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key,X-Internal-Token,X-Trace-Id,X-Device');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id,Idempotent-Replay');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // 幂等（写操作 + Idempotency-Key）
  app.use(http.idempotencyMiddleware);

  // 健康检查（契约外补充，便于部署探活）
  const routes = require('./src/routes');
  app.get('/health', http.wrap(function (req, res) { return http.ok(res, routes.healthPayload()); }));

  // 业务接口
  app.use('/api/v1', routes.router);

  // ------------------------------------------------ 教务处 Web 管理后台（静态托管）
  // Nginx 会把 /admin 反向代理到本服务；这里直接托管 public/admin 下的纯静态资源。
  app.use('/admin', express.static(ADMIN_DIR, {
    index: 'index.html',
    etag: true,
    lastModified: true,
    setHeaders: function (res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));
  // 前端使用 hash 路由（#/dashboard），此处兼容 /admin 与 /admin/ 以及深层路径刷新
  function sendAdminIndex(req, res, next) {
    if (!u.fileExists(ADMIN_INDEX)) {
      return res.status(404).json({
        code: 40401,
        msg: '管理后台前端未部署：缺少 public/admin/index.html',
        data: {},
        traceId: res.locals.traceId || '',
      });
    }
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(ADMIN_INDEX, function (err) { if (err) next(err); });
  }
  app.get(['/admin', '/admin/'], sendAdminIndex);
  // 刷新深层路径（不含扩展名且期望 HTML）时回落到后台首页
  app.get(/^\/admin\/(?!.*\.[A-Za-z0-9]+$).*$/, sendAdminIndex);

  // 根路径给一个说明，避免直接访问看到 404 不知所措
  app.get('/', function (req, res) {
    res.json({
      code: 0,
      msg: 'ok',
      data: {
        service: '课堂课时确认与学时统计 后端',
        apiPrefix: '/api/v1',
        health: '/health',
        adminWeb: '/admin/',
        docs: 'docs/miniapp/api-contract.md',
      },
      traceId: res.locals.traceId,
    });
  });

  app.use(http.notFoundHandler);
  app.use(http.errorHandler);
  return app;
}

// ---------------------------------------------------------------- 定时任务：每日 00:05 (Asia/Shanghai) 批量置过期
function startCron() {
  let lastRunDate = '';
  setInterval(function () {
    const p = u.tzParts();
    const today = u.dateOnly();
    if (p.hour === 0 && p.minute >= 5 && lastRunDate !== today) {
      lastRunDate = today;
      try {
        const out = require('./src/records').expireJob({ user: null, ip: 'cron', device: 'cron' }, {});
        const auditOut = audit.log({ user: null, ip: 'cron', device: 'cron' }, 'job.expire.cron', {
          targetType: 'period_record', targetId: '*',
          after: { expired: out.expired }, detail: '每日 00:05 定时任务批量置过期',
        });
        if (out.expired) {
          console.log('[' + u.isoNow() + '] 定时任务：' + out.expired + ' 条待确认记录已置为 expired（日志 ' + auditOut.id + '）');
        }
      } catch (e) {
        console.error('[cron] 过期任务执行失败：' + (e && e.stack ? e.stack : e));
      }
    }
  }, 30 * 1000).unref();
}

function main() {
  bootstrap();
  const app = buildApp();
  startCron();
  const server = app.listen(u.PORT, u.HOST, function () {
    const base = 'http://127.0.0.1:' + u.PORT;
    console.log('');
    console.log('  课堂课时确认与学时统计 · 后端已启动');
    console.log('  ------------------------------------------------');
    console.log('  地址        : ' + base + '   (绑定 ' + u.HOST + ':' + u.PORT + ')');
    console.log('  健康检查    : GET  ' + base + '/health');
    console.log('  管理后台    : GET  ' + base + '/admin/');
    console.log('  接口前缀    : /api/v1');
    console.log('  开发模式    : ' + (u.DEV_MODE ? 'DEV_MODE=1（不调用微信 code2Session）' : 'DEV_MODE=0（调用真实微信接口）'));
    console.log('  数据目录    : ' + u.DATA_DIR);
    console.log('  Node        : ' + process.version);
    console.log('  ------------------------------------------------');
    console.log('  接口文档    : ' + path.join(u.ROOT_DIR, 'README.md'));
    console.log('');
  });
  server.on('error', function (e) {
    if (e.code === 'EADDRINUSE') {
      console.error('端口 ' + u.PORT + ' 已被占用，请设置 PORT 环境变量后重试。');
      process.exit(1);
    }
    console.error('启动失败：' + e.message);
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { bootstrap, buildApp, main };
