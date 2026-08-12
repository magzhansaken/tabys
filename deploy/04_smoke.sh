#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — проверка состояния. Ничего не меняет, только смотрит.
# Запуск:  bash /opt/tabys/deploy/04_smoke.sh
#
# Использует те же проверки, что и обновление: одна реализация на всех.
# Две копии проверок рано или поздно разъезжаются, и одна начинает врать.
# =====================================================================
set -uo pipefail
cd /opt/tabys/deploy
set -a; . ./.env; set +a
source ./lib_check.sh

echo "── Контейнеры"
docker ps -a --filter name=tabys --format '   {{.Names}}\t{{.Status}}'
echo
echo "── Память сервера"
free -h | head -2 | sed 's/^/   /'
echo
echo "── Место на диске"
df -h / | tail -1 | sed 's/^/   /'

run_all_checks
exit $?
