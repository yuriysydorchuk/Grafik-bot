#!/usr/bin/env bash
# Build everything for production and (re)start under pm2.
# Run from the repo root:  bash deploy/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Installing dependencies…"
# pnpm 10+ exits non-zero with ERR_PNPM_IGNORED_BUILDS when a dependency's build
# script is skipped. esbuild ships its native binary via @esbuild/linux-x64
# (kept in pnpm-workspace.yaml overrides), so its build script is a no-op for us.
# Tolerate that specific case only — any other install failure still aborts.
set +e
pnpm install --frozen-lockfile 2>&1 | tee /tmp/grafik-pnpm-install.log
install_rc=${PIPESTATUS[0]}
set -e
if [ "$install_rc" -ne 0 ]; then
  if grep -q "ERR_PNPM_IGNORED_BUILDS" /tmp/grafik-pnpm-install.log; then
    echo "  (tolerating ERR_PNPM_IGNORED_BUILDS — esbuild binary ships via @esbuild/linux-x64)"
  else
    echo "✗ pnpm install failed (exit $install_rc)"; exit "$install_rc"
  fi
fi

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
