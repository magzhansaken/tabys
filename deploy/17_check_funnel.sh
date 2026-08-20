#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — почему карточка стоит не в том столбце воронки.
#
# Показывает по каждому клиенту: где он в воронке, что вывела система
# из фактов, и стоит ли ручная пометка. Ничего не меняет.
#
# Использование:
#   bash 17_check_funnel.sh
# =====================================================================
set -euo pipefail

COMPOSE="/opt/tabys/deploy/docker-compose.prod.yml"

docker compose -p tabys -f "$COMPOSE" exec -T db \
  psql -U postgres -d shop -tAF' | ' -c "
SELECT rpad(name, 26),
       rpad('видно: ' || stage, 18),
       rpad('по фактам: ' || derived_stage, 22),
       CASE WHEN stage_manual THEN 'ПОСТАВЛЕН РУКАМИ' ELSE '' END
  FROM platform_funnel('super', NULL, NULL)
 ORDER BY stage, name;
"

echo
echo "Если «видно» и «по фактам» расходятся — этап поставлен руками."
echo "Снять: в карточке «Сдвинуть» → «Снова по фактам»."
echo
echo "Оплата ручной этап пересиливает — кроме «Отказа»: человек мог"
echo "узнать об уходе клиента раньше, чем это стало видно системе."
