#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — шаг 1: установка проекта и создание паролей.
#
# Почему скриптом, а не одной командой в ssh: PowerShell на Windows
# портит кавычки и знак $ при передаче — проверено дважды. Скрипт
# внутри пакета этой проблемы лишён: команда запуска короткая и
# без единой кавычки.
#
# Запуск (после распаковки пакета):  bash shop/deploy/01_install.sh
# Повторный запуск безопасен: пароли не перезатираются, если целые.
# =====================================================================
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"     # корень распакованного проекта
DST=/opt/tabys

echo "=== 1/3 Копирую проект в $DST"
mkdir -p "$DST"
if [ "$SRC" = "$DST" ]; then
  # скрипт запущен из уже установленной папки — копировать некуда и незачем
  echo "· запуск из установленной папки, копирование пропускаю"
else
  cp -r "$SRC"/. "$DST"/
  echo "· скопировано из $SRC"
fi
cd "$DST/deploy"

echo "=== 2/3 Проверяю пароли"
NEED_NEW=1
if [ -f .env ]; then
  # .env считаем целым, только если все три секрета непустые и длинные
  if grep -qE '^DB_SUPER_PASSWORD=.{32,}' .env \
  && grep -qE '^DB_APP_PASSWORD=.{32,}' .env \
  && grep -qE '^JWT_SECRET=.{32,}' .env; then
    NEED_NEW=0
    echo "· .env уже есть и выглядит целым — оставляю как есть."
    echo "  (это важно: смена паролей на живой базе сломала бы вход)"
  else
    echo "· .env есть, но пароли пустые или короткие — пересоздаю."
  fi
fi

if [ "$NEED_NEW" = "1" ]; then
  P_SUPER="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  P_APP="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  P_JWT="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    echo "# Табыс — боевые настройки. Создано $(date +%F' '%H:%M)."
    echo "# Пароли сгенерированы на сервере, в переписке не передавались."
    echo "DB_SUPER_PASSWORD=$P_SUPER"
    echo "DB_APP_PASSWORD=$P_APP"
    echo "JWT_SECRET=$P_JWT"
    echo "PUBLIC_API_URL=https://tabys.duckdns.org/api"
  } > .env
  chmod 600 .env
  echo "· .env создан, доступ только root."
fi

echo "=== 3/3 Проверка"
echo "--- содержимое .env (значения скрыты):"
sed 's/=.*/=***/' .env | grep -v '^#'
echo "--- длина значений (ожидаем 48, 48, 64 и адрес):"
grep -v '^#' .env | awk -F= '{printf "%-20s %s\n", $1, length($2)}'
echo "--- что установлено:"
ls -1 "$DST"
echo
echo "ГОТОВО. Дальше: bash /opt/tabys/deploy/02_start.sh"
