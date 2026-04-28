/** PM2: `pm2 start ecosystem.config.cjs` — yalnızca TW Stats Telegram bot (Node). Python gerekmez. */

module.exports = {
  apps: [
    {
      name: 'twstats-bot',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
