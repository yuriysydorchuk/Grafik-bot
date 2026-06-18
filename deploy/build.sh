#!/usr/bin/env bash
# Build everything for production and (re)start under pm2.
# Run from the repo root:  bash deploy/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Installing dependencies…"
pnpm install --frozen-lockfile

echo "▶ Building web panel…"
pnpm --filter @workspace/web run build

echo "▶ Building API/bot…"
pnpm --filter @workspace/api-server run build

echo "▶ Typecheck (api + web)…"
pnpm --filter @workspace/api-server run typecheck
( cd artifacts/web && npx tsc -b --noEmit )

echo "▶ (Re)starting under pm2…"
pm2 start ecosystem.config.cjs --update-env || pm2 restart grafik-bot --update-env
pm2 save

echo "✅ Done. Logs: pm2 logs grafik-bot"
