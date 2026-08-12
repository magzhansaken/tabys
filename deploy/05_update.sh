#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — обновление уже работающей установки.
# Пароли и база НЕ трогаются, домен переподключать не нужно.
# Запуск после распаковки нового пакета:
#   bash /opt/tabystmp/shop/deploy/05_update.sh
# =====================================================================
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST=/opt/tabys

[ -f "$DST/deploy/.env" ] || { echo "ОШИБКА: $DST/deploy/.env не найден. Это не обновление, а первая установка — используйте 01_install.sh"; exit 1; }

echo "=== Обновляю код (настройки и пароли сохраняются)"
cp "$SRC"/server -r "$DST"/ 2>/dev/null || cp -r "$SRC"/server "$DST"/
cp -r "$SRC"/admin "$DST"/
cp -r "$SRC"/db "$DST"/
cp -r "$SRC"/docs "$DST"/ 2>/dev/null || true
cp -r "$SRC"/shared "$DST"/ 2>/dev/null || true
# Служебные скрипты: наполнение магазина данными, проверка правил.
# Раньше не копировались вовсе — папка была в проекте, но на сервер
# не доезжала, и запустить их было нечем.
cp -r "$SRC"/scripts "$DST"/ 2>/dev/null || true
# скрипты и compose обновляем, .env оставляем как есть
for f in "$SRC"/deploy/*.sh "$SRC"/deploy/docker-compose*.yml; do cp "$f" "$DST"/deploy/; done
echo "· код обновлён, .env сохранён"

cd "$DST/deploy"
echo
echo "=== Пересобираю и перезапускаю"
docker compose -p tabys -f docker-compose.prod.yml up -d --build

echo
echo "=== Контейнеры"
docker ps --filter name=tabys --format 'table {{.Names}}\t{{.Status}}'

echo
echo "=== Жду сервер"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  if docker logs --tail 5 tabys-server 2>&1 | grep -q "слушает порт"; then
    docker logs --tail 3 tabys-server 2>&1 | grep "слушает порт"
    break
  fi
  echo "  жду ($i)"
done

echo

# Проверки вынесены в общий файл и делают то же, что делает клиент.
# Раньше выкладка заканчивалась словом «ГОТОВО» — и четыре раза подряд
# это слово было неправдой: сервер отвечал, а работать было нельзя.
set -a; . "$DST/deploy/.env"; set +a
source "$DST/deploy/lib_check.sh"
# Строгий режим временно снимаем: иначе скрипт оборвётся на первой же
# неуспешной проверке и не покажет остальные — а нам нужна полная картина,
# а не первая попавшаяся неприятность.
set +e
run_all_checks
RC=$?
set -e

echo
if [ "$RC" = "0" ]; then
  echo "Обновление завершено и проверено."
else
  echo "Обновление применено, НО проверки нашли проблемы — см. выше."
fi
exit $RC
