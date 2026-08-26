module.exports = {
  apps: [
    {
      name: 'voice-keeper-bot',
      script: 'index.js',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
