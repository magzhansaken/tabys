#!/usr/bin/env node
/**
 * НАПОЛНЕНИЕ ПЛАТФОРМЫ ПРОБНЫМИ ДАННЫМИ.
 *
 * Пустая платформа не показывает ничего: список клиентов пуст, сводка
 * по нулям, партнёров нет. Проверить, работает ли она, невозможно —
 * а именно это и нужно перед тем, как звать первого партнёра.
 *
 * Создаёт: двух партнёров с разной комиссией, шесть магазинов в разных
 * состояниях (работает, кончается через три дня, срок вышел, учебный),
 * оплаты — подтверждённые, ждущие и отклонённую, заявки партнёров,
 * записи в журнале.
 *
 * ДАННЫЕ ПОДОБРАНЫ ТАК, ЧТОБЫ ВИДЕТЬ КАЖДЫЙ СЛУЧАЙ. Один магазин с
 * истёкшим сроком, один на грани, один учебный — иначе не проверишь,
 * что подсветка работает и что учебный не попадает в деньги.
 *
 * Запуск на сервере:
 *   docker compose -p tabys -f /opt/tabys/deploy/docker-compose.prod.yml \
 *     exec -T server node scripts/fill_platform.js
 *
 * Повторный запуск безопасен: партнёры заводятся заново с теми же
 * почтами, магазины добавляются новые.
 */
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const PARTNER_PASS = 'partner-2026';

const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const phone = () => '+7701' + rnd(1000000, 9999999);
const tiyn = (tenge) => Math.round(tenge * 100);

(async () => {
  const db = new Client();
  await db.connect();

  console.log('\n═══ НАПОЛНЕНИЕ ПЛАТФОРМЫ ═══\n');

  // ── ПАРТНЁРЫ ────────────────────────────────────────────────────────
  // Двое с разной комиссией: так видно, что доля считается по каждому
  // своя, а не одна на всех.
  const partners = [];
  for (const [name, email, bp] of [
    ['Ерлан Сериков', 'erlan@partner.kz', 1500],   // 15%
    ['Динара Ахметова', 'dinara@partner.kz', 1000], // 10%
  ]) {
    const r = await db.query(
      `INSERT INTO platform_user (email, password_hash, full_name, role, commission_bp, phone)
       VALUES ($1,$2,$3,'partner',$4,$5)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash, commission_bp = EXCLUDED.commission_bp,
         is_active = true, deleted_at = NULL
       RETURNING id, full_name, commission_bp`,
      [email, bcrypt.hashSync(PARTNER_PASS, 10), name, bp, phone()]);
    partners.push(r.rows[0]);
    console.log(`· партнёр ${r.rows[0].full_name} — ${bp / 100}% — ${email}`);
  }

  // ── МАГАЗИНЫ ────────────────────────────────────────────────────────
  // Шесть штук в разных состояниях: только так видно, что подсветка
  // «кончается» и «срок вышел» работает, а учебный не в деньгах.
  const shops = [
    ['Продукты на Абая',      'Нурлан Сериков',  'Астана',    45,  false, 0],
    ['Магазин Береке',        'Асель Жумабаева', 'Астана',    3,   false, 0],  // кончается
    ['Мини-маркет Достык',    'Марат Оспанов',   'Караганда', -5,  false, 0],  // срок вышел
    ['Хозтовары у дома',      'Гульнара Ким',    'Астана',    120, false, 1],
    ['Кофейня Арома',         'Данияр Тлеу',     'Алматы',    20,  false, 1],
    ['Учебный магазин',       'Демо Демович',    'Астана',    30,  true,  0],
  ];

  const tariff = (await db.query(
    `SELECT id, price_month FROM tariff WHERE is_public ORDER BY price_month LIMIT 1`)).rows[0];

  const created = [];
  for (const [name, owner, city, days, isDemo, pIdx] of shops) {
    // Через функции с обходом изоляции: вставка в account и subscription
    // из-под роли приложения отбивается правилом «только свой магазин».
    const acc = (await db.query(
      `SELECT platform_create_account($1, $2) AS id`, [name, phone()])).rows[0];

    // Подписка с нужной датой: именно она красит строку в списке.
    await db.query(`SELECT platform_set_subscription($1, $2, $3)`,
      [acc.id, days, days < 0 ? 'readonly' : 'active']);

    await db.query(
      `INSERT INTO tenant_card (account_id, partner_id, city, owner_name, owner_phone,
                                deal_stage, deal_note, touched_at, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval, $9)`,
      [acc.id, partners[pIdx]?.id ?? null, city, owner, phone(),
       days < 0 ? 'won' : isDemo ? 'demo' : 'won',
       days < 0 ? 'Не платит второй месяц, обещал на этой неделе'
                : 'Работает, вопросов нет',
       String(rnd(1, 14)), isDemo]);

    created.push({ id: acc.id, name, days, isDemo, partner: partners[pIdx]?.id });
    console.log(`· магазин ${name} — ${days < 0 ? 'срок вышел' : days + ' дн.'}${isDemo ? ' (учебный)' : ''}`);
  }

  // ── ОПЛАТЫ ──────────────────────────────────────────────────────────
  // Подтверждённые за прошлые дни — чтобы график сводки не был пустым.
  // Ждущая — чтобы было что подтвердить и увидеть предпросмотр.
  // Отклонённая — чтобы видеть, как выглядит отказ с причиной.
  const real = created.filter((c) => !c.isDemo);
  let paid = 0;
  for (let d = 28; d >= 1; d -= rnd(2, 5)) {
    const c = real[rnd(0, real.length - 1)];
    const months = [1, 3, 6][rnd(0, 2)];
    const amount = tiyn(6900 * months);
    const bp = partners.find((p) => p.id === c.partner)?.commission_bp ?? 0;
    const share = Math.round(amount * bp / 10000);

    await db.query(
      `INSERT INTO tenant_payment (account_id, amount, months, method, status,
                                   partner_id, partner_bp, partner_share, platform_share,
                                   approved_at, created_at)
       VALUES ($1,$2,$3,'kaspi','approved',$4,$5,$6,$7,
               now() - ($8 || ' days')::interval, now() - ($8 || ' days')::interval)`,
      [c.id, amount, months, c.partner ?? null, bp, share, amount - share, String(d)]);
    paid++;
  }
  console.log(`· оплат подтверждено: ${paid}`);

  const waiting = real[0];
  await db.query(
    `INSERT INTO tenant_payment (account_id, amount, months, method, comment, status, partner_id)
     VALUES ($1,$2,3,'kaspi','Перевод с Каспи, чек прислал в вотсап','pending',$3)`,
    [waiting.id, tiyn(20700), waiting.partner ?? null]);
  console.log('· одна оплата ждёт подтверждения');

  await db.query(
    `INSERT INTO tenant_payment (account_id, amount, months, method, status,
                                 reject_reason, partner_id, created_at)
     VALUES ($1,$2,1,'kaspi','rejected','Деньги не поступили на счёт — проверьте реквизиты',$3,
             now() - interval '6 days')`,
    [real[1].id, tiyn(6900), real[1].partner ?? null]);
  console.log('· одна отклонена с причиной');

  // ── ЗАЯВКИ ПАРТНЁРОВ ────────────────────────────────────────────────
  for (const [idx, kind, comment] of [
    [0, 'device', 'Клиент открыл вторую точку, просит ещё кассу'],
    [1, 'grace',  'Оплатит после праздников, просит неделю отсрочки'],
  ]) {
    await db.query(
      `INSERT INTO tenant_request (account_id, kind, comment, created_by, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [real[idx].id, kind, comment, partners[0].id]);
  }
  console.log('· две заявки ждут решения');

  // ── СТРОКИ СЧЁТА ────────────────────────────────────────────────────
  // У одного магазина — чтобы видеть, что счёт складывается из строк,
  // а скидка идёт минусом.
  const big = real.find((c) => c.name === 'Хозтовары у дома') ?? real[0];
  for (const [kind, title, price] of [
    ['base',     'Тариф «Стандарт»',   14900],
    ['pos',      'Касса №2',            3000],
    ['store',    'Точка №2',            5000],
    ['discount', 'Скидка постоянному', -2000],
  ]) {
    await db.query(
      `INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
       VALUES ($1,$2,$3,1,$4)`, [big.id, kind, title, tiyn(price)]);
  }
  console.log(`· счёт из четырёх строк у «${big.name}»`);

  // ── ЖУРНАЛ ──────────────────────────────────────────────────────────
  for (const [action, note] of [
    ['partner_created',  'Заведён партнёр'],
    ['payment_approved', 'Подтверждена оплата'],
    ['price_book_changed', 'Изменены цены'],
  ]) {
    await db.query(
      `INSERT INTO platform_audit (actor_name, action, account_id, details, at)
       VALUES ('Магжан', $1, $2, $3, now() - ($4 || ' hours')::interval)`,
      [action, real[0].id, JSON.stringify({ note }), String(rnd(1, 72))]);
  }
  console.log('· записи в журнале');

  console.log('\n═══ ГОТОВО ═══\n');
  console.log('Партнёры для входа:');
  console.log(`  erlan@partner.kz  / ${PARTNER_PASS}  — 15%`);
  console.log(`  dinara@partner.kz / ${PARTNER_PASS}  — 10%`);
  console.log('\nЧто смотреть:');
  console.log('  · список клиентов — подсветка «кончается» и «срок вышел»');
  console.log('  · оплаты — одна ждёт подтверждения, одна отклонена');
  console.log('  · партнёры — заработок за 30 дней у каждого свой');
  console.log('  · сводка — график по дням');
  console.log('  · войти партнёром — увидит только своих\n');

  await db.end();
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
