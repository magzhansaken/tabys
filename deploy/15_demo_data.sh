#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — стереть клиентов с партнёрами и завести свежие для проверки.
#
# ЭТО СТИРАЕТ ДАННЫЕ. Магазины, партнёры, оплаты, заявки, журнал — всё
# уходит. Владелец платформы остаётся: без него не войти.
#
# Поэтому скрипт требует слово-подтверждение. Случайно запустить его
# нельзя, и это нарочно: команду вытаскивают стрелкой вверх из истории,
# а данные обратно не вытащишь.
#
# Использование:
#   bash 15_demo_data.sh СТЕРЕТЬ
#
# Заводит через ТЕ ЖЕ ФУНКЦИИ БАЗЫ, что и живая система: магазин
# создаётся ровно так, как если бы его завёл человек. Мимо защиты строк
# не лезем — она стоит не зря.
#
# Что появится:
#   4 партнёра с разными долями;
#   10 магазинов — платят, на пробном, просрочены, ждёт подтверждения,
#     отключён;
#   оплаты подтверждённые, ждущие и отклонённая;
#   заявки решённые и ждущие;
#   карточки воронки на разных этапах;
#   строки счёта — вторая касса, вторая точка, скидка.
#
# Пароль у всех один: это данные для проверки, а не для работы.
# =====================================================================
set -euo pipefail

if [ "${1:-}" != "СТЕРЕТЬ" ]; then
  cat <<'HELP'
Этот скрипт СТИРАЕТ всех клиентов и партнёров и заводит свежие.

Магазины, оплаты, заявки и журнал будут удалены. Владелец платформы
останется — иначе вы не войдёте.

Если уверены, повторите команду со словом СТЕРЕТЬ:

  bash 15_demo_data.sh СТЕРЕТЬ
HELP
  exit 1
fi

COMPOSE="/opt/tabys/deploy/docker-compose.prod.yml"

echo "· стираю старое и завожу свежее…"

docker compose -p tabys -f "$COMPOSE" exec -T server node -e '
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const Q = String.fromCharCode(39);   // одинарная кавычка для SQL

const PASS = "Tabys2026demo";

const PARTNERS = [
  ["erlan@tabys.kz",  "Ерлан Сериков",   15],
  ["galym@tabys.kz",  "Галым Оспанов",   25],
  ["dinara@tabys.kz", "Динара Ахметова", 10],
  ["aset@tabys.kz",   "Асет Жумабаев",   20],
];

// [партнёр, название, владелец, город, дней осталось]
const SHOPS = [
  [0, "Мини-маркет Достык",    "Нурлан Абаев",     "Астана",    45],
  [0, "Продукты у дома",       "Асель Куанышева",  "Астана",    12],
  [0, "Хозтовары Береке",      "Ерлан Тулегенов",  "Астана",     5],
  [1, "Кофейня Алматы",        "Айгуль Сатпаева",  "Алматы",    90],
  [1, "Магазин одежды Сымбат", "Данияр Оспанов",   "Алматы",    -3],
  [1, "Автозапчасти Турбо",    "Марат Ибраев",     "Шымкент",   30],
  [2, "Пекарня Нан",           "Гульнара Досова",  "Караганда",  8],
  [2, "Аптека Дару",           "Серик Нурланов",   "Караганда",-15],
  [3, "Цветы Гульдер",         "Жанна Абишева",    "Актобе",    60],
  [null, "Строймаркет Тас",    "Бахыт Сериков",    "Актау",     14],
];

(async () => {
  const c = new Client();
  await c.connect();

  // ── Стираем ────────────────────────────────────────────────────
  // Порядок важен: сперва то, что ссылается на магазины. Мимо защиты
  // строк не лезем — удаление идёт от владельца базы.
  for (const t of ["platform_audit", "tenant_payment", "tenant_request",
                   "plan_line", "tenant_card", "platform_daily"]) {
    await c.query("DELETE FROM " + t);
  }
  // Владельца платформы НЕ трогаем: без него не войти.
  await c.query("DELETE FROM platform_user WHERE role = " + Q + "partner" + Q);
  await c.query("SELECT platform_wipe_accounts()");

  // ── Партнёры ───────────────────────────────────────────────────
  const hash = bcrypt.hashSync(PASS, 10);
  const pids = [];
  for (const [email, name, pct] of PARTNERS) {
    const r = await c.query(
      "INSERT INTO platform_user (email, password_hash, full_name, role, commission_bp)" +
      " VALUES ($1,$2,$3," + Q + "partner" + Q + ",$4) RETURNING id",
      [email, hash, name, pct * 100]);
    pids.push(r.rows[0].id);
  }

  // ── Магазины ───────────────────────────────────────────────────
  // Через ТУ ЖЕ функцию, что зовёт сервер: магазин, подписка, владелец
  // и карточка появляются разом и правильно.
  const made = [];
  let n = 0;
  for (const [pi, name, owner, city, days] of SHOPS) {
    n += 1;
    const phone = "+7701" + String(1110000 + n * 111);
    const id = (await c.query(
      "SELECT out_account FROM platform_create_tenant($1,$2,$3,$4,$5,$6)",
      [name, phone, owner, hash, Math.max(1, days), pi === null ? null : pids[pi]]
    )).rows[0].out_account;

    // Срок правим ПОСЛЕ заведения: функция не примет отрицательный
    // пробный период, а просроченный магазин видеть надо — это тоже
    // состояние, и по нему звонят.
    await c.query("SELECT platform_set_paid_until($1,$2)", [id, days]);
    await c.query("SELECT platform_set_city($1,$2)", [id, city]);

    made.push({ id, name, pi, phone });
  }

  // ── Строки счёта ───────────────────────────────────────────────
  // Через функцию: прямая вставка не видит чужие строки.
  const line = (shop, kind, title, price, endedDays) => c.query(
    "SELECT platform_add_line($1,$2,$3,$4,$5)",
    [shop.id, kind, title, price, endedDays ?? null]);
  await line(made[0], "pos", "Касса №2", 300000);
  await line(made[3], "store", "Точка на Абая", 500000);
  await line(made[5], "discount", "Скидка за год", -100000);

  // ── Оплаты ─────────────────────────────────────────────────────
  const bp = [1500, 2500, 1000, 2000];
  const pay = async (shop, amount, months, method, status, daysAgo, reason) => {
    const share = shop.pi === null ? 0 : Math.round(amount * bp[shop.pi] / 10000);
    const done = status === "approved";
    await c.query(
      "INSERT INTO tenant_payment (account_id, amount, months, method, status," +
      " partner_id, partner_bp, partner_share, platform_share, declared_by," +
      " reject_reason, created_at, approved_at)" +
      " VALUES ($1,$2,$3,$4,$5::tenant_payment_status,$6,$7,$8,$9,$10,$11," +
      " now() - ($12 || " + Q + " days" + Q + ")::interval," +
      " CASE WHEN $5 = " + Q + "approved" + Q +
      " THEN now() - ($12 || " + Q + " days" + Q + ")::interval END)",
      [shop.id, amount, months, method, status,
       shop.pi === null ? null : pids[shop.pi],
       shop.pi === null ? null : bp[shop.pi],
       done ? share : 0, done ? amount - share : 0,
       status === "pending" ? "partner" : "super", reason ?? null, daysAgo]);
  };
  await pay(made[0], 690000,  1, "kaspi",    "approved", 25);
  await pay(made[0], 990000,  1, "kaspi",    "approved",  3);
  await pay(made[1], 2070000, 3, "kaspi",    "approved", 18);
  await pay(made[3], 1190000, 1, "transfer", "approved", 12);
  await pay(made[3], 1190000, 1, "transfer", "approved",  2);
  await pay(made[5], 690000,  1, "cash",     "approved",  9);
  await pay(made[8], 690000,  1, "kaspi",    "approved",  6);
  await pay(made[2], 690000,  1, "kaspi",    "pending",   0);
  await pay(made[6], 690000,  1, "kaspi",    "pending",   1);
  await pay(made[7], 690000,  1, "cash",     "rejected",  4,
            "деньги не поступили, проверьте квитанцию");

  // ── Заявки ─────────────────────────────────────────────────────
  const req = (shop, kind, payload, comment, status, note) => c.query(
    "INSERT INTO tenant_request (account_id, kind, payload, comment, status," +
    " decision_note, created_at, decided_at)" +
    " VALUES ($1,$2,$3,$4,$5,$6," +
    " now() - interval " + Q + "2 days" + Q + "," +
    " CASE WHEN $5 <> " + Q + "pending" + Q +
    " THEN now() - interval " + Q + "1 day" + Q + " END)",
    [shop.id, kind, JSON.stringify(payload), comment, status, note ?? null]);
  await req(made[1], "device", { device: "pos" }, "открыли вторую точку на Абая", "pending");
  await req(made[4], "grace",  { days: 7 },       "клиент в отпуске до понедельника", "pending");
  await req(made[6], "other",  {},                "просит выгрузку продаж в Excel", "pending");
  await req(made[0], "device", { device: "pos" }, "нужна касса на кассовой зоне", "approved");
  await req(made[7], "tariff", { tier: "pro" },   "хотят маркировку", "rejected",
            "на «Стандарт» переходим с сентября");

  // ── Воронка и заметки ──────────────────────────────────────────
  await c.query(
    "UPDATE tenant_card SET deal_stage = " + Q + "contacted" + Q + ", stage_manual = true," +
    " deal_note = " + Q + "позвонил, ждёт счёт до пятницы" + Q +
    " WHERE account_id = $1", [made[6].id]);
  await c.query(
    "UPDATE tenant_card SET deal_stage = " + Q + "lost" + Q + ", stage_manual = true," +
    " deal_note = " + Q + "ушли к конкурентам, вернуться через полгода" + Q +
    " WHERE account_id = $1", [made[7].id]);
  await c.query(
    "UPDATE tenant_card SET note = " + Q +
    "владелец глухой на левое ухо, звонить громче" + Q +
    " WHERE account_id = $1", [made[0].id]);

  // Один отключён — чтобы было видно, как это выглядит.
  await c.query("SELECT platform_set_status($1, " + Q + "suspended" + Q + ")", [made[4].id]);

  // ── Редкие случаи ──────────────────────────────────────────────
  // Без них часть действий проверить НЕ НА ЧЕМ: не увидеть, как ведёт
  // себя учебный магазин, тариф «Стандарт», закрытая строка счёта или
  // отключённый партнёр.

  // Учебный магазин: его нельзя удалить и он не считается клиентом.
  const demo = (await c.query(
    "SELECT out_account FROM platform_create_tenant($1,$2,$3,$4,$5,$6)",
    ["Учебный магазин — Магжан", "+77011111111", "Магжан", hash, 3650, null]
  )).rows[0].out_account;
  await c.query("SELECT platform_set_demo($1)", [demo]);

  // Тариф «Стандарт» — чтобы было видно, что тарифов два.
  await c.query("SELECT platform_set_tariff($1,$2)", [made[3].id, "standard"]);

  // Закрытая строка счёта: убранная касса остаётся в истории, но в
  // счёт не входит. Видно только у того, кто откроет состав.
  await line(made[0], "pos", "Касса №3 (убрана)", 300000, 5);

  // Отключённый партнёр: вход закрыт, клиенты работают.
  await c.query(
    "UPDATE platform_user SET is_active = false WHERE id = $1", [pids[3]]);

  // Заявка на смену тарифа — четвёртый вид, остальные три уже есть.
  await req(made[8], "tariff", { tier: "pro" }, "просят опт и маркировку", "pending");

  const cnt = async (t) => (await c.query("SELECT count(*) n FROM " + t)).rows[0].n;
  console.log("· партнёров:   " + pids.length);
  console.log("· магазинов:   " + made.length);
  console.log("· оплат:       " + await cnt("tenant_payment"));
  console.log("· заявок:      " + await cnt("tenant_request"));
  console.log("· строк счёта: " + await cnt("plan_line"));
  console.log("");
  console.log("Телефоны магазинов:");
  for (const m of made) console.log("  " + m.phone + "  " + m.name);
  await c.end();
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
'

echo
echo "Входы:"
echo
echo "  ПАНЕЛЬ — https://tabys.duckdns.org/platform"
echo "    erlan@tabys.kz · galym@tabys.kz · dinara@tabys.kz · aset@tabys.kz"
echo "    пароль у всех: Tabys2026demo"
echo
echo "  КАБИНЕТ МАГАЗИНА — https://tabys.duckdns.org/login"
echo "    телефон из списка выше, пароль тот же: Tabys2026demo"
echo
echo "  Владелец платформы не тронут — входите как раньше."
