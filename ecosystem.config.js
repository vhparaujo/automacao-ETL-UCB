module.exports = {
  apps: [{
    name: 'etl-ucb',
    script: 'src/pipeline.js',
    args: '--watch',
    cwd: '/opt/dashboards/automacao-ETL-UCB',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 10000,
    time: true,
  }],
};