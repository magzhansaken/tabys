#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — откат маршрута. Возвращает файл ресторана из последней копии
# и применяет. Ресторан продолжает работать, наш домен просто перестаёт
# открываться.
# Запуск:  bash /opt/tabys/deploy/99_caddy_rollback.sh
# =====================================================================
set -euo pipefail
LAST=$(ls -t /root/Caddyfile.paths.backup-* 2>/dev/null | head -1)
[ -z "$LAST" ] && { echo "Копий не найдено — откатывать нечего."; exit 1; }
echo "Возвращаю: $LAST"
cp "$LAST" /opt/dastarhan2/deploy/Caddyfile.paths
docker compose -f /opt/dastarhan2/deploy/docker-compose.yml exec -T web caddy reload --config /etc/caddy/Caddyfile
echo "ОТКАЧЕНО. Проверяю ресторан:"
curl -s -o /dev/null -w 'ресторан: %{http_code}\n' https://dastarhan.duckdns.org/office/
