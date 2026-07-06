#!/usr/bin/env bash
# Щоденний бекап Grafik-bot: дамп PostgreSQL + архів uploads/ у $BACKUP_DIR з
# ротацією. Пароль БД не дублюється — DATABASE_URL береться з .env застосунку.
#
# Встановлення на сервері (раз):
#   chmod +x /root/grafik-bot/deploy/backup.sh
#   ( crontab -l 2>/dev/null; echo '0 3 * * * /root/grafik-bot/deploy/backup.sh >> /root/backups/backup.log 2>&1' ) | crontab -
#
# Відновлення — див. docs/infrastructure/DATABASE.md → Backup / restore.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/grafik-bot}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL not found in $APP_DIR/.env" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F)"

# .tmp + mv: обірваний дамп ніколи не виглядає як готовий бекап
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz.tmp"
mv "$BACKUP_DIR/db-$STAMP.sql.gz.tmp" "$BACKUP_DIR/db-$STAMP.sql.gz"

UPLOADS_DIR="${UPLOADS_DIR:-$APP_DIR/uploads}"
if [ -d "$UPLOADS_DIR" ]; then
  tar czf "$BACKUP_DIR/uploads-$STAMP.tar.gz.tmp" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
  mv "$BACKUP_DIR/uploads-$STAMP.tar.gz.tmp" "$BACKUP_DIR/uploads-$STAMP.tar.gz"
fi

find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $(du -h "$BACKUP_DIR/db-$STAMP.sql.gz" | cut -f1) db, $( [ -f "$BACKUP_DIR/uploads-$STAMP.tar.gz" ] && du -h "$BACKUP_DIR/uploads-$STAMP.tar.gz" | cut -f1 || echo 'no') uploads"
