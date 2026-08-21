/*
 * ПРОВЕРКА МАГАЗИНА ПЕРЕД ТОРГОВЛЕЙ.
 *
 * Наполнение говорит «готово» — а готово ли? Эта проверка идёт по
 * тому же пути, что и живой кассир, и говорит, где встанет.
 *
 * ЗАЧЕМ ОТДЕЛЬНО. Наполнение уже дважды напечатало то, чего не
 * сделало: вход в кабинет без пароля, имя в поле телефона. Проверка
 * смотрит на РЕЗУЛЬТАТ, а не на намерение.
 *
 * Запуск на сервере:
 *   docker exec tabys-server node scripts/check-shop.js
 */
const { Client } = require('pg');

const ИМЯ = process.argv[2] || 'Мини-маркет на Абая';

let плохо = 0;
const ok = (годно, что, беда) => {
  if (годно) console.log('  ✔ ' + что);
  else { плохо += 1; console.log('  ✘ ' + что + (беда ? ' — ' + беда : '')); }
};

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  console.log('');
  console.log('═══ ПРОВЕРКА МАГАЗИНА «' + ИМЯ + '» ═══');
  console.log('');

  /* Магазин ищем через список платформы: защита строк прячет его,
     пока он не выбран — запрос молчит, а не падает. */
  let acc = null;
  try {
    acc = (await c.query(
      `SELECT id FROM platform_clients('super', NULL, $1) LIMIT 1`, [ИМЯ])).rows[0];
  } catch { /* нет свёртки — пробуем прямо */ }
  if (!acc) acc = (await c.query(
    `SELECT id FROM account WHERE name = $1 LIMIT 1`, [ИМЯ])).rows[0];

  if (!acc) {
    console.log('  ✘ Магазина нет вовсе. Запустите: node scripts/seed-shop.js');
    await c.end();
    process.exit(1);
  }

  const A = acc.id;
  await c.query(`SET app.account_id = '${A}'`);

  // ── ТОВАРЫ ──────────────────────────────────────────────────────
  console.log('  ── Товары');
  const т = (await c.query(
    `SELECT count(*)::int AS всего,
            count(*) FILTER (WHERE kind='weight')::int AS весовых,
            count(*) FILTER (WHERE marking <> 'none')::int AS марок,
            count(*) FILTER (WHERE is_quick)::int AS ходовых
       FROM product WHERE account_id=$1 AND deleted_at IS NULL`, [A])).rows[0];

  ok(т.всего >= 50, `товаров: ${т.всего}`, 'мало — наполнение не доработало');
  ok(т.весовых >= 10, `весовых: ${т.весовых}`, 'весы работать не будут');
  ok(т.марок >= 5, `маркированных: ${т.марок}`, 'марку требовать не с чего');
  ok(т.ходовых >= 5, `ходовых: ${т.ходовых}`, 'вкладка «Ходовое» будет пустой');

  /* ЦЕНА У КАЖДОГО ТОВАРА. Без неё касса пробьёт его за НОЛЬ — самая
     дорогая беда: покупатель унесёт товар даром, а недостача ляжет на
     кассира. */
  const безЦены = (await c.query(
    `SELECT count(*)::int AS n FROM product p
      WHERE p.account_id=$1 AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_price pp
                         WHERE pp.product_id=p.id AND pp.value > 0)`, [A])).rows[0];
  ok(безЦены.n === 0, `все товары с ценой`,
     `${безЦены.n} без цены — касса пробьёт их за НОЛЬ`);

  /* ШТРИХКОД У ШТУЧНОГО. Весовому он не нужен — его читают весы. */
  const безКода = (await c.query(
    `SELECT count(*)::int AS n FROM product p
      WHERE p.account_id=$1 AND p.deleted_at IS NULL AND p.kind='simple'
        AND NOT EXISTS (SELECT 1 FROM barcode b WHERE b.product_id=p.id)`, [A])).rows[0];
  ok(безКода.n === 0, 'у штучных есть штрихкод',
     `${безКода.n} без кода — сканером не пробить`);

  /* КОД ВЕСОВ У ВЕСОВОГО. Без него весы напечатают штрихкод, а касса
     скажет «товар не найден». */
  const безPLU = (await c.query(
    `SELECT count(*)::int AS n FROM product
      WHERE account_id=$1 AND deleted_at IS NULL AND kind='weight'
        AND (plu_code IS NULL OR plu_code = 0)`, [A])).rows[0];
  ok(безPLU.n === 0, 'у весовых есть код весов',
     `${безPLU.n} без кода — весы не найдут товар`);

  // ── КАТЕГОРИИ ───────────────────────────────────────────────────
  console.log('');
  console.log('  ── Категории');
  const к = (await c.query(
    `SELECT count(*)::int AS n FROM category WHERE account_id=$1 AND deleted_at IS NULL`,
    [A])).rows[0];
  ok(к.n >= 5, `категорий: ${к.n}`, 'вкладок на кассе почти не будет');

  const безКат = (await c.query(
    `SELECT count(*)::int AS n FROM product
      WHERE account_id=$1 AND deleted_at IS NULL AND category_id IS NULL`, [A])).rows[0];
  ok(безКат.n === 0, 'все товары в категориях',
     `${безКат.n} без категории — их не найти по вкладкам`);

  // ── ЛЮДИ ────────────────────────────────────────────────────────
  console.log('');
  console.log('  ── Кассиры');
  const л = (await c.query(
    `SELECT count(*)::int AS всего,
            count(*) FILTER (WHERE pos_pin_hash IS NOT NULL)::int AS с_кодом
       FROM employee WHERE account_id=$1 AND is_active`, [A])).rows[0];

  ok(л.всего >= 2, `сотрудников: ${л.всего}`);
  ok(л.с_кодом === л.всего, `у всех есть код для кассы`,
     `${л.всего - л.с_кодом} без кода — не войдут на кассу`);

  /* ВЛАДЕЛЕЦ ВХОДИТ В КАБИНЕТ. Без пароля нельзя ни завести товар, ни
     поменять цену, ни увидеть выручку. */
  const х = (await c.query(
    `SELECT first_name, phone, password_hash IS NOT NULL AS есть_пароль
       FROM employee WHERE account_id=$1 AND is_owner LIMIT 1`, [A])).rows[0];

  ok(!!х, 'владелец заведён');
  if (х) {
    ok(х.есть_пароль, 'у владельца есть пароль от кабинета',
       'в кабинет не войти');
    ok(х.first_name && !/^\+?\d[\d\s()-]{6,}$/.test(String(х.first_name)),
       `имя владельца: ${х.first_name}`, 'в поле имени лежит телефон');
    ok(х.phone && /^\+?\d[\d\s()-]{6,}$/.test(String(х.phone)),
       `телефон: ${х.phone}`, 'в поле телефона лежит не телефон');
  }

  /* РАЗНЫЕ ПРЕДЕЛЫ СКИДКИ. Если у всех один — не проверишь, что сверх
     предела зовут старшего. */
  /* Предел смотрим у ЧЕЛОВЕКА: он сильнее ролевого, а роли общие на
     все магазины — по ним разницы не увидеть. */
  const пределы = (await c.query(
    `SELECT count(DISTINCT coalesce(e.discount_limit_pct, r.discount_limit_pct))::int AS n
       FROM employee e LEFT JOIN role r ON r.id = e.role_id
      WHERE e.account_id=$1 AND e.is_active`, [A])).rows[0];
  ok(пределы.n >= 2, 'пределы скидки разные',
     'у всех один — вызов старшего не проверить');

  // ── КАССА ───────────────────────────────────────────────────────
  console.log('');
  console.log('  ── Касса');
  const касс = (await c.query(
    `SELECT count(*)::int AS n FROM cash_register WHERE account_id=$1`, [A])).rows[0];
  ok(касс.n >= 1, `касс заведено: ${касс.n}`);

  const код = (await c.query(
    `SELECT pairing_code, paired_at,
            pairing_expires_at > now() AS годен
       FROM device WHERE account_id=$1
       ORDER BY created_at DESC LIMIT 1`, [A])).rows[0];

  if (!код) {
    ok(false, 'код привязки', 'устройств нет — кассу не подключить');
  } else if (код.paired_at) {
    console.log('  ✔ касса уже привязана');
  } else {
    ok(код.годен !== false, `код привязки: ${код.pairing_code}`, 'просрочен');
  }

  await c.end();

  console.log('');
  if (плохо) {
    console.log(`═══ ЕСТЬ БЕДЫ: ${плохо} ═══`);
    console.log('');
    console.log('  Торговать можно, но эти места встанут. Почините и');
    console.log('  запустите проверку снова.');
    console.log('');
    process.exit(1);
  }

  console.log('═══ МАГАЗИН ГОТОВ К ТОРГОВЛЕ ═══');
  console.log('');
  console.log('  Это не «готово» на словах: проверено всё, что нужно');
  console.log('  кассиру — цены, штрихкоды, коды весов, марки, коды');
  console.log('  входа и пароль от кабинета.');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
