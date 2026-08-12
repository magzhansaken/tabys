#!/usr/bin/env bash
# =====================================================================
# Применение миграций с учётом уже применённых (таблица schema_migrations).
# Каждый файл db/migrations/NNN_*.sql применяется ровно один раз — повторный
# запуск на живой базе безопасен. Это и есть путь обновления прода:
#   ./apply.sh  (или docker compose run --rm migrate)
# =====================================================================
set -euo pipefail
: "${PGUSER:=postgres}" "${PGDATABASE:=shop}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# PGHOST не навязываем: локально работает unix-сокет, в докере его задаёт compose
PSQL=(psql ${PGHOST:+-h "$PGHOST"} -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in "$DIR"/migrations/*.sql; do
  name="$(basename "$f")"
  done_row="$("${PSQL[@]}" -tAc "SELECT 1 FROM schema_migrations WHERE filename='$name'")"
  if [ -n "$done_row" ]; then
    echo "· $name — уже применена"
    continue
  fi
  echo "→ $name"
  # файл и отметка — одной транзакцией: упало посередине — отметки нет
  "${PSQL[@]}" --single-transaction \
    -f "$f" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
done
echo "Готово: миграции применены."
