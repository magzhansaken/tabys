#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — ключ операторской админки (/operator).
#
# Без ключа админка закрыта полностью — это безопасное умолчание, но
# работать в ней вы не сможете. Скрипт создаёт ключ (если его нет),
# сохраняет в настройки и перезапускает сервер.
#
# Ключ хранится ТОЛЬКО на сервере, в /opt/tabys/deploy/.env
# Посмотреть позже:  bash /opt/tabys/deploy/09_operator_key.sh --show
# =====================================================================
set -euo pipefail
cd /opt/tabys/deploy

if [ "${1:-}" = "--show" ]; then
  KEY=$(grep '^OPERATOR_KEY=' .env | cut -d= -f2- || echo '')
  [ -n "$KEY" ] && echo "Ключ оператора: $KEY" || echo "Ключ ещё не создан. Запустите скрипт без --show."
  exit 0
fi

if grep -q '^OPERATOR_KEY=.\{16,\}' .env 2>/dev/null; then
  echo "· ключ уже существует, оставляю как есть"
else
  KEY="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # убираем возможную пустую/короткую строку и дописываем новую
  sed -i '/^OPERATOR_KEY=/d' .env
  echo "OPERATOR_KEY=$KEY" >> .env
  chmod 600 .env
  echo "· ключ создан"
fi

echo
echo "=== Перезапускаю сервер с новым ключом"
docker compose -p tabys -f docker-compose.prod.yml up -d --force-recreate server >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  docker logs --tail 5 tabys-server 2>&1 | grep -q "слушает порт" && break
done
echo "· сервер перезапущен"

echo
echo "=== Проверка: админка отвечает на ключ"
KEY=$(grep '^OPERATOR_KEY=' .env | cut -d= -f2-)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "x-operator-key: $KEY" https://tabys.duckdns.org/api/operator/signups || echo 000)
BAD=$(curl -s -o /dev/null -w '%{http_code}' -H "x-operator-key: nevernyi" https://tabys.duckdns.org/api/operator/signups || echo 000)
echo "· с верным ключом:   $CODE  (ожидаем 200)"
echo "· с неверным ключом: $BAD  (ожидаем 403 — чужого не пустит)"

echo
echo "════════════════════════════════════════════════════════"
echo "  ВАШ КЛЮЧ ОПЕРАТОРА:"
echo "  $KEY"
echo "════════════════════════════════════════════════════════"
echo
echo "Где вводить:  https://tabys.duckdns.org/operator"
echo "Сохраните его у себя. НЕ пересылайте в переписке —"
echo "с этим ключом виден список всех клиентов."
echo "Посмотреть снова: bash /opt/tabys/deploy/09_operator_key.sh --show"
