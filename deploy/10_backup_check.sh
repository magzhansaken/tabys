#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — проверка бэкапов ВОССТАНОВЛЕНИЕМ.
#
# ЗАЧЕМ: бэкапы делаются каждую ночь, но их никто ни разу не разворачивал.
# Непроверенный бэкап — это не бэкап, а надежда. Узнать, что архивы
# битые, в день потери данных — худший из возможных сценариев.
#
# Что делает:
#   1) берёт самый свежий архив и проверяет его возраст;
#   2) разворачивает в ОТДЕЛЬНУЮ базу (живая не затрагивается);
#   3) СВЕРЯЕТ число записей в ключевых таблицах с живой базой;
#   4) удаляет временную базу за собой.
#
# Запуск:  bash /opt/tabys/deploy/10_backup_check.sh
# Хорошо ставить в еженедельный автозапуск.
# =====================================================================
set -uo pipefail
cd /opt/tabys/deploy
set -a; . ./.env; set +a

BACKUPS=/opt/tabys/deploy/backups
CHECK_DB=shop_restore_check
FAILS=0

psql_db() { docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db psql -tA -U postgres -d "$1" -c "$2" 2>/dev/null; }
psql_adm() { docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db psql -q -U postgres -d postgres -c "$1" >/dev/null 2>&1; }

echo "═══ ПРОВЕРКА БЭКАПОВ ═══"
echo
echo "── 1/4 Ищу свежий архив"
LATEST=$(ls -t "$BACKUPS"/*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "   АРХИВОВ НЕТ. Проверьте контейнер: docker logs tabys-backup"
  exit 1
fi
SIZE=$(du -h "$LATEST" | cut -f1)
AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST") ) / 3600 ))
COUNT=$(ls -1 "$BACKUPS"/*.sql.gz 2>/dev/null | wc -l)
echo "   файл:   $(basename "$LATEST")"
echo "   размер: $SIZE, возраст: $AGE_H ч, всего архивов: $COUNT"
if [ "$AGE_H" -gt 30 ]; then
  echo "   ВНИМАНИЕ: архив старше 30 часов — ночное копирование могло сломаться"
  FAILS=$((FAILS+1))
fi
if [ "$SIZE" = "0" ] || [ ! -s "$LATEST" ]; then
  echo "   ОШИБКА: архив пустой"
  exit 1
fi

echo
echo "── 2/4 Разворачиваю в отдельную базу (живая не тронута)"
psql_adm "DROP DATABASE IF EXISTS $CHECK_DB"
psql_adm "CREATE DATABASE $CHECK_DB"
if gunzip -c "$LATEST" | docker exec -i -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db \
     psql -q -U postgres -d "$CHECK_DB" > /tmp/restore.log 2>&1; then
  echo "   развёрнут без ошибок"
else
  echo "   ОШИБКА при восстановлении:"
  grep -iE "error|ошибк" /tmp/restore.log | head -5 | sed 's/^/   /'
  FAILS=$((FAILS+1))
fi

echo
echo "── 3/4 Сверяю содержимое с живой базой"
printf '   %-22s %10s %12s\n' "таблица" "в работе" "в архиве"
for T in account employee product sale stock_doc counterparty; do
  LIVE=$(psql_db shop "SELECT count(*) FROM $T" | tr -d ' ')
  REST=$(psql_db "$CHECK_DB" "SELECT count(*) FROM $T" | tr -d ' ')
  [ -z "$LIVE" ] && LIVE="—"; [ -z "$REST" ] && REST="—"
  if [ "$LIVE" = "$REST" ]; then
    printf '   %-22s %10s %12s   совпадает\n' "$T" "$LIVE" "$REST"
  else
    # Расхождение ожидаемо, если после ночного копирования была работа —
    # поэтому расхождение В МЕНЬШУЮ сторону это норма, а в большую — нет.
    printf '   %-22s %10s %12s   расходится\n' "$T" "$LIVE" "$REST"
    if [ "$REST" -gt "$LIVE" ] 2>/dev/null; then
      echo "        странно: в архиве БОЛЬШЕ, чем в работе — разберитесь"
      FAILS=$((FAILS+1))
    fi
  fi
done

echo
echo "── 4/4 Убираю за собой"
psql_adm "DROP DATABASE IF EXISTS $CHECK_DB"
echo "   временная база удалена"

echo
if [ "$FAILS" = "0" ]; then
  echo "═══ БЭКАП РАБОЧИЙ ═══"
  echo "Архив разворачивается и содержит данные. Восстановление вручную:"
  echo "  gunzip -c $LATEST | docker exec -i tabys-db psql -U postgres -d shop"
else
  echo "═══ ЕСТЬ ЗАМЕЧАНИЯ: $FAILS ═══"
fi
exit $FAILS
