# 生产环境（pm2 进程守护）配置
module.exports = {
  apps: [
    {
      name: 'monthly-report',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3081,
      },
    },
  ],
};
