// pm2 process config — keeps the bot alive across crashes and machine reboots.
//   pnpm --filter @workspace/api-server run build   # build first
//   pm2 start ecosystem.config.cjs                  # start (or reload)
//   pm2 save                                        # persist process list
//   pm2 startup                                     # (run once, needs sudo) auto-start on boot
//   pm2 logs grafik-bot                             # tail logs
module.exports = {
  apps: [
    {
      name: "grafik-bot",
      script: "./artifacts/api-server/dist/index.mjs",
      cwd: __dirname,
      node_args: "--env-file=./.env --enable-source-maps",
      autorestart: true,
      max_restarts: 30,
      restart_delay: 3000,
      env: { NODE_ENV: "production" },
    },
  ],
};
