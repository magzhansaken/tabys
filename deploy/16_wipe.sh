#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — стереть всё, оставить только владельца платформы.
#
# ЭТО СТИРАЕТ ДАННЫЕ НАСОВСЕМ. Магазины, партнёры, оплаты, заявки,
# журнал, товары, чеки, остатки — всё уходит. Восстановить нечем, если
# нет запасной копии.
#
# ОСТАНЕТСЯ:
#   владелец платформы — почта, пароль, имя;
#   тарифы «Старт» и «Стандарт»;
#   настройки платформы — цены, скидки, реквизиты оплаты;
#   заявки с сайта (кто оставил свой номер, но ещё не завёл магазин).
#
# Отличие от 15_demo_data.sh: тот стирает и ЗАВОДИТ новые данные для
# проверки. Этот только стирает — платформа остаётся пустой и готовой к
# настоящим клиентам.
#
# Использование:
#   bash 16_wipe.sh СТЕРЕТЬ-ВСЁ
# =====================================================================
set -euo pipefail

if [ "${1:-}" != "СТЕРЕТЬ-ВСЁ" ]; then
  cat <<'HELP'
Этот скрипт СТИРАЕТ ВСЁ и оставляет только владельца платформы.

Уйдут: магазины, партнёры, оплаты, заявки, журнал, товары, чеки.
Восстановить будет нечем.

Останутся: владелец платформы, тарифы, настройки и цены.

Если уверены, повторите команду со словом СТЕРЕТЬ-ВСЁ:

  bash 16_wipe.sh СТЕРЕТЬ-ВСЁ
HELP
  exit 1
fi

COMPOSE="/opt/tabys/deploy/docker-compose.prod.yml"

echo "· считаю, что уйдёт…"

docker compose -p tabys -f "$COMPOSE" exec -T server node -e '
const { Client } = require("pg");
const Q = String.fromCharCode(39);

(async () => {
  const c = new Client();
  await c.connect();

  const n = async (t) => (await c.query("SELECT count(*) x FROM " + t)).rows[0].x;

  // Считаем ФУНКЦИЕЙ: прямой подсчёт даёт ноль — защита строк не
  // пускает к чужим магазинам. Скрипт показывал «магазинов: 0» перед
  // тем, как стереть одиннадцать. Врать перед необратимым действием
  // нельзя: человек решает по этим числам.
  const before = (await c.query("SELECT * FROM platform_wipe_preview()")).rows[0];
  console.log("  магазинов:       " + before.accounts);
  console.log("  их сотрудников:  " + before.employees);
  console.log("  партнёров:       " + before.partners);
  console.log("  оплат:           " + before.payments);
  console.log("  заявок:          " + before.requests);
  console.log("  записей журнала: " + before.journal);
  console.log("");

  // Сперва то, что не ссылается на магазин: журнал, снимки дней.
  await c.query("DELETE FROM platform_audit");
  await c.query("DELETE FROM platform_daily");

  // Магазины и всё, что за ними тянется — 131 таблица. Функция чистит
  // по ссылкам и возвращает общие строки: роли и единицы измерения.
  await c.query("SELECT platform_wipe_accounts()");

  // Партнёры. Владельца платформы НЕ трогаем — без него не войти.
  await c.query("DELETE FROM platform_user WHERE role = " + Q + "partner" + Q);

  console.log("· стёрто. Осталось:");
  console.log("  владельцев платформы: " +
    await n("platform_user WHERE role = " + Q + "super" + Q));
  console.log("  тарифов: " + await n("tariff"));
  console.log("  ролей (владелец, кассир, администратор): " + await n("role"));
  const s = (await c.query("SELECT price_base, price_pro FROM platform_settings")).rows[0];
  if (s) console.log("  цены: Старт " + (s.price_base / 100) +
                     " · Стандарт " + (s.price_pro / 100));
  await c.end();
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
'

echo
echo "Платформа пуста и готова к настоящим клиентам."
echo
echo "  Войдите как раньше: https://tabys.duckdns.org/platform"
echo "  Партнёров заводите кнопкой «Завести партнёра» в разделе «Партнёры»"
echo "  или скриптом:"
echo "    bash deploy/14_platform_user.sh почта 'пароль' 'Имя' partner 15"
