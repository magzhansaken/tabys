/*
 * НАПОЛНЕНИЕ МАГАЗИНА ДЛЯ ПРОВЕРКИ.
 *
 * Заводит настоящий мини-маркет: категории, товары с ценами и
 * штрихкодами, весовые с кодом весов, маркированные, кассиров с
 * разными правами.
 *
 * ЗАЧЕМ. Пустая касса ничего не показывает и проверить на ней нечего.
 * А выдуманные «Товар 1, Товар 2» не найдут беды: настоящие названия
 * длинные, цены разные, весовые считаются иначе.
 *
 * Запуск на сервере:
 *   cd /opt/tabys && node scripts/seed-shop.js "Мини-маркет на Абая"
 *
 * ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН: магазин с тем же названием не заводится
 * второй раз, товары не задваиваются.
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/*
 * НАЗВАНИЕ ЛУЧШЕ НЕ ПЕРЕДАВАТЬ.
 *
 * PowerShell шлёт по ssh в своей кодировке, а Linux ждёт UTF-8:
 * русские буквы превращаются в мусор. «Мини-маркет на Абая» дошло как
 * «-થ  ».
 *
 * Поэтому: без довода берём хорошее название само. А если довод
 * передан и он ИСПОРЧЕН — не заводим магазин с мусорным именем, а
 * говорим об этом вслух.
 */
const ПО_УМОЛЧАНИЮ = 'Мини-маркет на Абая';

function чистоеИмя(сырое) {
  if (!сырое) return ПО_УМОЛЧАНИЮ;

  const t = String(сырое).trim();

  /* Мусор от кодировки узнаётся просто: в имени магазина не бывает
     знаков вне русского, казахского, латиницы, цифр и обычных знаков
     препинания. */
  const испорчено = /[^\u0400-\u04FF\u0600-\u06FFA-Za-z0-9 «»"'().,\-№]/.test(t)
    || t.replace(/[^\wА-Яа-яЁё]/g, '').length < 3;

  if (испорчено) {
    console.log('');
    console.log('  ВНИМАНИЕ: название пришло испорченным — «' + t + '»');
    console.log('  Это PowerShell: он шлёт русские буквы в своей кодировке.');
    console.log('  Беру «' + ПО_УМОЛЧАНИЮ + '» — поменяете в кабинете.');
    console.log('');
    return ПО_УМОЛЧАНИЮ;
  }
  return t;
}

const ИМЯ = чистоеИмя(process.argv[2]);

/* ── ТОВАРЫ ───────────────────────────────────────────────────────
 *
 * Настоящий набор мини-маркета: то, что вправду лежит на полках в
 * Казахстане, с ценами лета 2026 года.
 *
 * Поля: название, цена, штрихкод, вес (кг вместо штук), код весов,
 * маркировка, ходовое.
 */
const КАТАЛОГ = [
  ['Хлеб и выпечка', [
    ['Хлеб «Тандыр»',              250, '4870001000017', { quick: true }],
    ['Хлеб формовой белый',        180, '4870001000024', { quick: true }],
    ['Батон нарезной',             220, '4870001000031'],
    ['Лепёшка узбекская',          300, '4870001000048'],
    ['Булочка с маком',            120, '4870001000055'],
    ['Самса с мясом',              350, '4870001000062'],
  ]],

  ['Молочное', [
    ['Молоко «Айналайын» 2,5% 1 л', 480, '4870002000016', { quick: true }],
    ['Молоко «食品» 3,2% 0,9 л',    520, '4870002000023'],
    ['Кефир 2,5% 0,5 л',            290, '4870002000030'],
    ['Айран 0,5 л',                 220, '4870002000047', { quick: true }],
    ['Сметана 20% 400 г',           690, '4870002000054'],
    ['Творог 5% 200 г',             450, '4870002000061'],
    ['Масло сливочное 82% 180 г',  1250, '4870002000078'],
    ['Сыр «Российский»',           4270, null, { weight: true, plu: '101' }],
    ['Сыр «Гауда»',                5100, null, { weight: true, plu: '102' }],
  ]],

  ['Мясо и колбасы', [
    ['Колбаса «Докторская»',       2890, null, { weight: true, plu: '201' }],
    ['Колбаса «Сервелат»',         3450, null, { weight: true, plu: '202' }],
    ['Сосиски молочные',           2100, null, { weight: true, plu: '203' }],
    ['Куриное филе',               2350, null, { weight: true, plu: '204' }],
    ['Фарш говяжий',               2800, null, { weight: true, plu: '205' }],
    ['Казы конская',               7500, null, { weight: true, plu: '206' }],
  ]],

  ['Овощи и фрукты', [
    ['Картофель',                   280, null, { weight: true, plu: '301', quick: true }],
    ['Лук репчатый',                220, null, { weight: true, plu: '302' }],
    ['Морковь',                     260, null, { weight: true, plu: '303' }],
    ['Помидоры',                    890, null, { weight: true, plu: '304' }],
    ['Огурцы',                      750, null, { weight: true, plu: '305' }],
    ['Яблоки «Апорт»',              690, null, { weight: true, plu: '306' }],
    ['Бананы',                      850, null, { weight: true, plu: '307' }],
    ['Лимоны',                      980, null, { weight: true, plu: '308' }],
  ]],

  ['Бакалея', [
    ['Рис «Лазер» 1 кг',            890, '4870003000015'],
    ['Гречка 800 г',                720, '4870003000022'],
    ['Макароны «Султан» 400 г',     320, '4870003000039'],
    ['Мука «Цесна» 2 кг',           780, '4870003000046'],
    ['Сахар 1 кг',                  520, '4870003000053', { quick: true }],
    ['Соль 1 кг',                   120, '4870003000060'],
    ['Масло подсолнечное 1 л',      950, '4870003000077'],
    ['Чай «Пиала» 250 г',           890, '4870003000084'],
    ['Кофе «Nescafe» 95 г',        2400, '4870003000091'],
  ]],

  ['Напитки', [
    ['Вода «Тассай» 1,5 л',         280, '4870004000014', { quick: true }],
    ['Кока-кола 1 л',               550, '4870004000021'],
    ['Фанта 1 л',                   550, '4870004000038'],
    ['Сок «Да-Да» 1 л',             690, '4870004000045'],
    ['Морс «Пилснер» 0,5 л',        320, '4870004000052'],
    ['Энергетик «Gorilla» 0,45 л',  590, '4870004000069'],
  ]],

  ['Сладости', [
    ['Шоколад «Казахстанский» 100 г', 690, '4870005000013'],
    ['Конфеты «Рахат» ассорти',      3200, null, { weight: true, plu: '401' }],
    ['Печенье «Юбилейное» 300 г',     480, '4870005000037'],
    ['Мороженое «Пломбир»',           350, '4870005000044'],
    ['Жвачка «Orbit»',                180, '4870005000051'],
  ]],

  ['Табак', [
    // МАРКИРОВАННЫЕ: без кода Data Matrix чек не закрыть.
    ['Сигареты «Winston» синий',    1200, '4870006000012', { marking: 'tobacco', quick: true }],
    ['Сигареты «Parliament»',       1800, '4870006000029', { marking: 'tobacco' }],
    ['Сигареты «Marlboro»',         1450, '4870006000036', { marking: 'tobacco' }],
    ['Сигареты «LD»',                950, '4870006000043', { marking: 'tobacco' }],
  ]],

  ['Алкоголь', [
    ['Водка «Хаома» 0,5 л',         2900, '4870007000011', { marking: 'alcohol' }],
    ['Водка «Снежная королева»',    3400, '4870007000028', { marking: 'alcohol' }],
    ['Пиво «Карагандинское» 0,5 л',  450, '4870007000035', { marking: 'beer' }],
    ['Пиво «Тянь-Шань» 0,5 л',       490, '4870007000042', { marking: 'beer' }],
  ]],

  ['Хозтовары', [
    ['Пакет-майка',                   30, '4870008000010', { quick: true }],
    ['Мыло хозяйственное',           220, '4870008000027'],
    ['Порошок «Ariel» 450 г',       1450, '4870008000034'],
    ['Губки для посуды 5 шт',        280, '4870008000041'],
    ['Салфетки влажные',             340, '4870008000058'],
    ['Спички',                        30, '4870008000065'],
  ]],
];

/* ── КАССИРЫ ──────────────────────────────────────────────────────
 *
 * Разные права нарочно: только так проверишь, что старший разрешает
 * молча, а кассиру нужен его код.
 */
const ЛЮДИ = [
  ['Нурлан',  'Абдиров',  '0000', 'owner',   null, 'Владелец'],
  ['Ерлан',   'Сериков',  '1111', 'admin',    30,  'Старший смены'],
  ['Айгуль',  'Жумабаева','2222', 'cashier',  10,  'Кассир'],
  ['Динара',  'Оспанова', '3333', 'cashier',  10,  'Кассир'],
  ['Мадина',  'Каиргали', '4444', 'cashier',   0,  'Кассир-новичок'],
];

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  /* ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН.
   *
   * ЗАЩИТА СТРОК ПРЯЧЕТ МАГАЗИН, пока он не выбран: запрос не падает,
   * а отдаёт ПУСТО. Наполнение решало, что магазина нет, заводило
   * второй и падало на занятом телефоне.
   *
   * Ищем через список платформы: он видит все магазины, как кабинет
   * владельца. */
  let acc = null;
  try {
    acc = (await c.query(
      `SELECT id FROM platform_clients('super', NULL, $1) LIMIT 1`, [ИМЯ])).rows[0] || null;
  } catch {
    // Свёртки нет — пробуем прямо: на старых сборках защита была иной.
  }
  if (!acc) {
    acc = (await c.query(
      `SELECT id FROM account WHERE name = $1 LIMIT 1`, [ИМЯ])).rows[0] || null;
  }

  if (!acc) {
    console.log('Магазина нет — завожу…');
    const r = (await c.query(
      `SELECT * FROM platform_create_tenant($1,$2,$3,$4)`,
      [ИМЯ, 'Нурлан Абдиров', '+7701' + String(Date.now()).slice(-7), null])).rows[0];
    acc = { id: r.out_account };
  } else {
    console.log('Магазин уже есть — дополняю его');
  }

  const A = acc.id;
  await c.query(`SET app.account_id = '${A}'`);

  // Вид цены и единицы
  let pt = (await c.query(
    `SELECT id FROM price_type WHERE account_id=$1 ORDER BY is_default DESC LIMIT 1`, [A])).rows[0];
  if (!pt) pt = (await c.query(
    `INSERT INTO price_type (account_id,name,code,is_default) VALUES ($1,'Розница','retail',true)
     RETURNING id`, [A])).rows[0];

  const ед = {};
  for (const r of (await c.query(
    `SELECT id, short_name FROM unit WHERE account_id=$1 OR account_id IS NULL`, [A])).rows) {
    ед[r.short_name] = r.id;
  }

  const store = (await c.query(
    `SELECT id FROM store WHERE account_id=$1 LIMIT 1`, [A])).rows[0];

  /* ── КАТЕГОРИИ И ТОВАРЫ ─────────────────────────────────────── */
  let товаров = 0;
  let порядок = 0;

  for (const [имяКат, товары] of КАТАЛОГ) {
    порядок += 1;
    let cat = (await c.query(
      `SELECT id FROM category WHERE account_id=$1 AND name=$2 LIMIT 1`, [A, имяКат])).rows[0];
    if (!cat) cat = (await c.query(
      `INSERT INTO category (account_id,name,sort_order,is_active)
       VALUES ($1,$2,$3,true) RETURNING id`, [A, имяКат, порядок])).rows[0];

    for (const [имя, цена, штрихкод, доп = {}] of товары) {
      const есть = (await c.query(
        `SELECT id FROM product WHERE account_id=$1 AND name=$2 LIMIT 1`, [A, имя])).rows[0];
      if (есть) continue;

      const p = (await c.query(
        `INSERT INTO product
           (account_id, kind, name, category_id, unit_id, plu_code, marking,
            is_quick, track_stock, vat_rate, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,12,true) RETURNING id`,
        [A,
         // Вид сам говорит, весовой товар или штучный.
         доп.weight ? 'weight' : 'simple',
         имя, cat.id,
         доп.weight ? ед['кг'] : ед['шт'],
         доп.plu || null,
         доп.marking || 'none',
         !!доп.quick])).rows[0];

      await c.query(
        `INSERT INTO product_price (account_id, product_id, price_type_id, value)
         VALUES ($1,$2,$3,$4)`, [A, p.id, pt.id, цена]);

      if (штрихкод) {
        await c.query(
          `INSERT INTO barcode (account_id, product_id, code, is_primary)
           VALUES ($1,$2,$3,true)`, [A, p.id, штрихкод]).catch(() => {});
      }
      товаров += 1;
    }
  }

  /* ── КАССИРЫ ────────────────────────────────────────────────── */
  const роли = {};
  for (const r of (await c.query(
    `SELECT id, code FROM role WHERE account_id=$1 OR account_id IS NULL`, [A])).rows) {
    роли[r.code] = r.id;
  }

  let людей = 0;

  /* ВЛАДЕЛЕЦ ЗАВОДИТСЯ САМ при создании магазина — второго база не
     примет. Ему только ставим код для входа на кассу. */
  const хозяин = (await c.query(
    `SELECT id FROM employee WHERE account_id=$1 AND is_owner LIMIT 1`, [A])).rows[0];

  for (const [имя, фамилия, pin, роль, предел, должность] of ЛЮДИ) {
    let есть = (await c.query(
      `SELECT id FROM employee WHERE account_id=$1 AND first_name=$2 AND last_name=$3 LIMIT 1`,
      [A, имя, фамилия])).rows[0];

    // Владельца не заводим второй раз — берём того, что уже есть.
    if (!есть && роль === 'owner' && хозяин) есть = хозяин;

    const хеш = bcrypt.hashSync(pin, 10);
    const след = crypto.createHash('sha256').update(pin).digest('hex').slice(0, 32);

    if (есть) {
      await c.query(
        `UPDATE employee SET pos_pin_hash=$1, pos_pin_fp=$2, can_login_pos=true WHERE id=$3`,
        [хеш, след, есть.id]);
    } else {
      /* ТЕЛЕФОН ОБЯЗАТЕЛЕН: по нему кассир входит в кабинет и
         восстанавливает код. Даём разные — двоих с одним база не
         примет. */
      const тел = '+7702' + String(1000000 + людей * 111111).slice(0, 7);

      await c.query(
        `INSERT INTO employee
           (account_id, role_id, first_name, last_name, phone, position,
            pos_pin_hash, pos_pin_fp, can_login_pos, is_owner, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,true)`,
        [A, роли[роль], имя, фамилия, тел, должность, хеш, след, роль === 'owner']);
      людей += 1;
    }

    /* ПРЕДЕЛ СКИДКИ ПО РОЛИ. Кассиру 10%, старшему 30%, новичку ноль:
       так проверишь, что сверх предела зовут старшего. */
    if (предел != null && роли[роль]) {
      await c.query(
        `UPDATE role SET discount_limit_pct=$1 WHERE id=$2 AND account_id=$3`,
        [предел, роли[роль], A]).catch(() => {});
    }
  }

  /* ── КОД ПРИВЯЗКИ КАССЫ ─────────────────────────────────────── */
  /* КОД ПРИВЯЗКИ. Берём свободный, а нет — заводим: без него кассу не
     подключить, и проверять будет нечем. Владелец делает то же в
     кабинете, кнопкой «добавить устройство». */
  let dev = (await c.query(
    `SELECT pairing_code FROM device
      WHERE account_id=$1 AND paired_at IS NULL AND pairing_code IS NOT NULL
        AND (pairing_expires_at IS NULL OR pairing_expires_at > now())
      ORDER BY created_at DESC LIMIT 1`, [A])).rows[0];

  /* ПОВТОРНЫЙ ЗАПУСК ДАЁТ СВЕЖИЙ КОД: прежний мог быть израсходован
     или просрочен, а без кода кассу не подключить. */
  if (!dev) {
    const касса = (await c.query(
      `SELECT id FROM cash_register WHERE account_id=$1 ORDER BY created_at LIMIT 1`,
      [A])).rows[0];

    if (касса) {
      /* Вид кода как в кабинете: читается вслух по телефону, буквы
         крупные — кассир диктует его владельцу и наоборот. */
      const код = 'TBS-' + crypto.randomBytes(2).toString('hex').toUpperCase()
        + '-' + String(1000 + Math.floor(Math.random() * 9000));

      dev = (await c.query(
        `INSERT INTO device (account_id, cash_register_id, name, pairing_code,
                             pairing_expires_at)
         VALUES ($1,$2,'Касса 1',$3, now() + interval '7 days')
         RETURNING pairing_code`, [A, касса.id, код])).rows[0];
    }
  }

  await c.end();

  console.log('');
  console.log('═══ МАГАЗИН ГОТОВ ═══');
  console.log('');
  console.log('  Название:  ' + ИМЯ);
  console.log('  Категорий: ' + КАТАЛОГ.length);
  console.log('  Товаров:   ' + товаров + ' добавлено');
  console.log('  Людей:     ' + людей + ' заведено');
  console.log('');
  console.log('  КОДЫ КАССИРОВ:');
  for (const [имя, ф, pin, роль, предел, должность] of ЛЮДИ) {
    console.log(`    ${pin}  ${имя} ${ф} · ${должность}`
      + (предел != null ? ` · скидка до ${предел}%` : ''));
  }
  console.log('');
  if (dev && dev.pairing_code) {
    console.log('  КОД ПРИВЯЗКИ КАССЫ: ' + dev.pairing_code);
  } else {
    console.log('  Код привязки возьмите в кабинете: карточка клиента → устройства');
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
