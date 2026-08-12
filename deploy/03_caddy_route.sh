#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — шаг 3: подключение домена tabys.duckdns.org.
#
# ЕДИНСТВЕННЫЙ скрипт, который касается ресторана. Трогает ровно один
# разрешённый файл — /opt/dastarhan2/deploy/Caddyfile.paths — и только
# дописыванием в конец.
#
# Пять защит, по порядку:
#   1) не запустится, если наши контейнеры не подняты (иначе домен
#      открылся бы в пустоту и отдавал ошибку);
#   2) не запустится повторно, если блок уже добавлен;
#   3) делает резервную копию файла ресторана;
#   4) проверяет синтаксис ДО применения — при ошибке откатывает файл
#      и ничего не применяет;
#   5) после применения проверяет, что ресторан жив.
#
# Запуск:  bash /opt/tabys/deploy/03_caddy_route.sh
# Откат:   bash /opt/tabys/deploy/99_caddy_rollback.sh
# =====================================================================
set -euo pipefail

PATHS=/opt/dastarhan2/deploy/Caddyfile.paths
COMPOSE_REST=/opt/dastarhan2/deploy/docker-compose.yml
DOMAIN=tabys.duckdns.org

echo "=== Защита 1: наши контейнеры подняты?"
for c in tabys-server tabys-admin; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" != "true" ]; then
    echo "ОСТАНОВЛЕНО: контейнер $c не запущен."
    echo "Сначала выполните: bash /opt/tabys/deploy/02_start.sh"
    exit 1
  fi
  echo "· $c работает"
done

echo "=== Защита 2: блок ещё не добавлен?"
if grep -q "$DOMAIN" "$PATHS"; then
  echo "· блок для $DOMAIN уже есть в файле — ничего не меняю."
  echo "  Если нужно применить настройки заново:"
  echo "  docker compose -f $COMPOSE_REST exec -T web caddy reload --config /etc/caddy/Caddyfile"
  exit 0
fi

echo "=== Защита 3: резервная копия файла ресторана"
BACKUP="/root/Caddyfile.paths.backup-$(date +%F-%H%M%S)"
cp "$PATHS" "$BACKUP"
echo "· копия: $BACKUP"

echo "=== Дописываю блок Табыс в конец файла"
cat >> "$PATHS" <<EOF


# ===== Tabys (magaziny) — dobavleno $(date +%F' '%H:%M) =====
# API: /api/... -> serveru bez prefiksa (handle_path srezaet /api)
# Kabinet: vsyo ostalnoe -> Next.js na 3001
$DOMAIN {
        encode gzip
        log {
                output stdout
                format console
                level INFO
        }
        handle_path /api/* {
                reverse_proxy tabys-server:3000
        }
        handle {
                reverse_proxy tabys-admin:3001
        }
}
EOF
echo "· добавлено строк: $(($(wc -l < "$PATHS") - $(wc -l < "$BACKUP")))"

echo "=== Защита 4: проверка синтаксиса ДО применения"
if ! docker compose -f "$COMPOSE_REST" exec -T web caddy validate --config /etc/caddy/Caddyfile; then
  echo
  echo "ОШИБКА В НАСТРОЙКАХ — откатываю файл, ничего не применялось."
  cp "$BACKUP" "$PATHS"
  echo "Ресторан работает на прежних настройках, он даже не заметил."
  exit 1
fi
echo "· синтаксис верный"

echo "=== Применяю вживую (без перезапуска, без простоя)"
docker compose -f "$COMPOSE_REST" exec -T web caddy reload --config /etc/caddy/Caddyfile
echo "· настройки применены"

echo
echo "=== Защита 5: ресторан жив?"
REST=$(curl -s -o /dev/null -w '%{http_code}' https://dastarhan.duckdns.org/office/ || echo 000)
echo "· ресторан отвечает: $REST"
if [ "$REST" != "200" ]; then
  echo "ВНИМАНИЕ: ресторан ответил не 200. Откат:"
  echo "  bash /opt/tabys/deploy/99_caddy_rollback.sh"
fi

echo
echo "=== Наш домен (сертификат выпускается 10-30 секунд, наберитесь терпения)"
sleep 12
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/login" || echo 000)
  echo "· попытка $i: $CODE"
  [ "$CODE" = "200" ] && break
  sleep 10
done

echo
echo "ГОТОВО. Проверка целиком: bash /opt/tabys/deploy/04_smoke.sh"
