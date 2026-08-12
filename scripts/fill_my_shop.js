#!/usr/bin/env node
/**
 * НАПОЛНЕНИЕ ВАШЕГО МАГАЗИНА ЖИВЫМИ ДАННЫМИ.
 *
 * Отличие от demo_seed.js: тот создаёт НОВЫЙ демо-магазин, а этот
 * наполняет ВАШ — тот, под которым вы входите. Смотреть систему под
 * чужим логином неудобно: половина вопросов «а у меня так же?».
 *
 * Что появится: товары с ценами и остатками, категории, поставщики и
 * покупатели с долгами, сотрудники, приёмки, продажи за две недели с
 * разными способами оплаты, возвраты, закрытые смены с недостачей,
 * бонусы, оптовые сделки, акцизные марки, коды маркировки, заказы
 * Kaspi, техкарта кофе — все 21 раздел оживают.
 *
 * ДАННЫЕ ПОДОБРАНЫ БОЕВЫЕ, а не «Товар 1»: длинные названия, суммы до
 * десятков тысяч, кириллица. На таких данных видно, где вёрстка ломается
 * и где цифры не сходятся — на выдуманных не видно ничего.
 *
 * ЗАПУСК НА СЕРВЕРЕ — изнутри контейнера, потому что Node.js стоит
 * только там, а не на самой машине:
 *
 *   docker compose -p tabys -f /opt/tabys/deploy/docker-compose.prod.yml \
 *     exec -T server node scripts/fill_my_shop.js \
 *     --phone +77771234567 --password ВашПароль
 *
 * Изнутри контейнера сервер доступен по адресу 127.0.0.1:3000 — это
 * быстрее и надёжнее, чем идти наружу через домен и обратно.
 *
 * На своём компьютере (если поставлен Node.js):
 *   node scripts/fill_my_shop.js --phone ... --password ...
 *
 * ПОВТОРНЫЙ ЗАПУСК безопасен: скрипт добавляет данные, а не чистит.
 * Но лучше запускать один раз — иначе товары задвоятся.
 */
const { randomUUID } = require('crypto');

// Внутри контейнера сервер рядом — идём напрямую, не через интернет.
// Снаружи (с компьютера) нужен полный адрес.
const API = process.env.API_URL
  ?? (require('fs').existsSync('/app/dist/main.js') ? 'http://127.0.0.1:3000' : 'https://tabys.duckdns.org/api');
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const PHONE = arg('phone');
const PASSWORD = arg('password');

if (!PHONE || !PASSWORD) {
  console.log(`
Укажите телефон и пароль вашего магазина:

  node scripts/fill_my_shop.js --phone +77771234567 --password ВашПароль

Это тот же телефон и пароль, которыми вы входите в кабинет.
`);
  process.exit(1);
}

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => null);
  return { status: r.status, d };
};

/** Мягко: если что-то не создалось, продолжаем. Половина данных лучше,
 *  чем остановка на первой мелочи. */
const tryDo = async (label, fn) => {
  try { const v = await fn(); process.stdout.write('·'); return v; }
  catch (e) { console.log(`\n  (пропущено: ${label} — ${e.message})`); return null; }
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

// ── ТОВАРЫ настоящего магазина у дома ─────────────────────────────────
const GOODS = [
  // [название, закуп, продажа, штрихкод, категория, критич.остаток, быстрый]
  ['Молоко Айран 1л 2,5% пастеризованное', 320, 480, '4870001000017', 'Молочное', 20, true],
  ['Кефир Простоквашино 900мл', 340, 520, '4870001000024', 'Молочное', 15, false],
  ['Сметана Домик в деревне 20% 300г', 410, 640, '4870001000031', 'Молочное', 10, false],
  ['Творог Президент 5% 200г', 480, 720, '4870001000048', 'Молочное', 8, false],
  ['Сыр Российский весовой', 2800, 4200, '4870001000055', 'Молочное', 3, false],
  ['Хлеб бородинский нарезной 400г', 160, 250, '4870001000062', 'Хлеб', 25, true],
  ['Батон нарезной 380г', 140, 220, '4870001000079', 'Хлеб', 20, true],
  ['Лаваш армянский тонкий', 180, 300, '4870001000086', 'Хлеб', 10, false],
  ['Сахар-песок Аксу 1кг', 380, 520, '4870001000093', 'Бакалея', 20, false],
  ['Мука высший сорт Цесна 2кг', 620, 890, '4870001000109', 'Бакалея', 12, false],
  ['Рис Басмати Мистраль 900г', 980, 1450, '4870001000116', 'Бакалея', 8, false],
  ['Гречка ядрица 800г', 540, 790, '4870001000123', 'Бакалея', 10, false],
  ['Масло подсолнечное Шедевр 1л', 780, 1180, '4870001000130', 'Бакалея', 12, false],
  ['Соль поваренная пищевая 1кг', 90, 160, '4870001000147', 'Бакалея', 15, false],
  ['Чай Пиала Голд 250г', 980, 1450, '4870001000154', 'Напитки', 10, false],
  ['Кофе Jacobs Monarch 190г', 2400, 3600, '4870001000161', 'Напитки', 5, false],
  ['Вода Асем-Ай негазированная 5л', 260, 390, '4870001000178', 'Напитки', 20, true],
  ['Кока-Кола 1,5л', 420, 640, '4870001000185', 'Напитки', 24, true],
  ['Сок Да-Да яблочный 1л', 380, 560, '4870001000192', 'Напитки', 12, false],
  ['Печенье Юбилейное 313г', 420, 640, '4870001000208', 'Сладости', 10, false],
  ['Конфеты Рахат Казахстанские 200г', 890, 1290, '4870001000215', 'Сладости', 8, false],
  ['Шоколад Алёнка 90г', 320, 480, '4870001000222', 'Сладости', 15, true],
  ['Яйцо куриное С1 десяток', 620, 890, '4870001000239', 'Продукты', 15, false],
  ['Колбаса Докторская варёная 500г', 1400, 2100, '4870001000246', 'Продукты', 6, false],
  ['Сосиски Молочные 400г', 980, 1450, '4870001000253', 'Продукты', 8, false],
  ['Порошок Ariel автомат 3кг', 2800, 4200, '4870001000260', 'Бытовая химия', 4, false],
  ['Мыло хозяйственное 200г', 140, 240, '4870001000277', 'Бытовая химия', 10, false],
  ['Туалетная бумага Zewa 4 рулона', 560, 840, '4870001000284', 'Бытовая химия', 10, false],
  ['Пакет-майка 30х55', 12, 25, '4870001000291', 'Прочее', 100, true],
  ['Зажигалка Cricket', 90, 180, '4870001000307', 'Прочее', 20, true],
];

(async () => {
  console.log('\n═══ НАПОЛНЕНИЕ ВАШЕГО МАГАЗИНА ═══\n');
  console.log('Сервер:', API);
  console.log('Магазин:', PHONE, '\n');

  // ── ВХОД ────────────────────────────────────────────────────────────
  let r = await j('POST', '/auth/login', { phone: PHONE, password: PASSWORD });
  if (!r.d?.access) {
    console.log('Не удалось войти:', r.d?.message ?? 'проверьте телефон и пароль');
    process.exit(1);
  }
  TOK = r.d.access;
  const me = (await j('GET', '/auth/me')).d;
  console.log('Вошли как:', me?.roleCode === 'owner' ? 'владелец' : me?.roleCode, '\n');

  // ── СОТРУДНИКИ ──────────────────────────────────────────────────────
  process.stdout.write('Сотрудники ');
  const staff = [
    { firstName: 'Асель', lastName: 'Нурланова', phone: '+7701' + rnd(1000000, 9999999), pin: '1111', roleCode: 'cashier', position: 'Кассир' },
    { firstName: 'Ерлан', lastName: 'Сериков', phone: '+7701' + rnd(1000000, 9999999), pin: '2222', roleCode: 'cashier', position: 'Кассир' },
    { firstName: 'Динара', lastName: 'Ахметова', phone: '+7701' + rnd(1000000, 9999999), pin: '3333', roleCode: 'admin', position: 'Администратор' },
  ];
  const staffIds = [];
  for (const s of staff) {
    const v = await tryDo('сотрудник', async () => (await j('POST', '/auth/employees', s)).d);
    if (v?.id) staffIds.push({ id: v.id, name: s.firstName });
  }
  console.log(` — ${staffIds.length}`);

  // ── КОНСУЛЬТАНТЫ (для отчёта по продавцам) ──────────────────────────
  process.stdout.write('Консультанты ');
  for (const n of ['Асель', 'Ерлан']) await tryDo('консультант', async () => (await j('POST', '/admin/consultants', { name: n, commissionPercent: 2 })).d);
  console.log('');

  // ── ТОВАРЫ ──────────────────────────────────────────────────────────
  process.stdout.write('Товары ');
  const goods = [];
  for (const [name, cost, price, barcode, category, minStock, quick] of GOODS) {
    const v = await tryDo(name, async () => (await j('POST', '/goods', {
      name, purchasePrice: cost, salePrice: price, barcode,
      minStock, isQuick: quick, quickGroup: quick ? 'Ходовое' : undefined,
    })).d);
    if (v?.id) goods.push({ id: v.id, name, cost, price, barcode });
  }
  console.log(` — ${goods.length}`);

  // ── ТЕХКАРТА: кофе с собой ──────────────────────────────────────────
  process.stdout.write('Техкарта (кофе с собой) ');
  const coffee = await tryDo('латте', async () => (await j('POST', '/goods', {
    name: 'Латте 0,3л (кофе с собой)', salePrice: 900, purchasePrice: 0,
    barcode: '4870001000901', kind: 'bundle',
  })).d);
  const milk = goods.find((g) => g.name.startsWith('Молоко'));
  if (coffee?.id && milk) {
    await tryDo('состав', async () => (await j('POST', `/goods/${coffee.id}/bundle`, {
      mode: 'recipe', yield: 1,
      items: [{ productId: milk.id, qty: 0.2, unit: 'л' }],
    })).d);
  }
  console.log('');

  // ── КОНТРАГЕНТЫ ─────────────────────────────────────────────────────
  process.stdout.write('Поставщики и покупатели ');
  const suppliers = [];
  for (const [name, bin] of [
    ['ТОО Магнум Кэш энд Керри', '051140004199'],
    ['ИП Абдрахманов (хлеб)', '870315300123'],
    ['ТОО Молочный Союз', '070740008061'],
  ]) {
    const v = await tryDo(name, async () => (await j('POST', '/contragents', {
      name, iinBin: bin, roles: ['supplier'], debtLimit: 500000, debtDays: 14,
    })).d);
    if (v?.id) suppliers.push({ id: v.id, name });
  }

  const customers = [];
  for (const [name, phone, limit] of [
    ['Кафе «Достык» (опт)', '+77012223301', 300000],
    ['Марат Сейтжанов', '+77012223302', 50000],
    ['Гульнара Абишева', '+77012223303', 30000],
    ['Столовая №5', '+77012223304', 200000],
    ['Айгуль Тлеубаева', '+77012223305', 0],
  ]) {
    const v = await tryDo(name, async () => (await j('POST', '/contragents', {
      name, phone, roles: ['customer'], debtLimit: limit, debtDays: 30,
    })).d);
    if (v?.id) customers.push({ id: v.id, name });
  }
  console.log(` — ${suppliers.length} + ${customers.length}`);

  // ── ЛОЯЛЬНОСТЬ ──────────────────────────────────────────────────────
  process.stdout.write('Программа лояльности ');
  await tryDo('кэшбэк', async () => (await j('POST', '/loyalty/programs', {
    name: 'Кэшбэк 3%', kind: 'cashback', earnPercent: 3, spendPercent: 50, isActive: true,
  })).d);
  console.log('');

  // ── ПРИЁМКИ: три поставки за две недели ─────────────────────────────
  process.stdout.write('Приёмки ');
  for (let w = 0; w < 3; w++) {
    const sup = suppliers[w % Math.max(suppliers.length, 1)];
    const doc = await tryDo('приёмка', async () => (await j('POST', '/stock/docs', {
      kind: 'supply', counterpartyId: sup?.id,
      comment: w === 0 ? 'Первый завоз, проверить сроки' : w === 1 ? 'Привёз Марат, пересчитать вечером' : 'Доставка по графику',
    })).d);
    if (!doc?.id) continue;
    // берём треть ассортимента в каждую поставку
    for (const g of goods.filter((_, i) => i % 3 === w)) {
      await j('POST', `/stock/docs/${doc.id}/items`, { productId: g.id, qty: rnd(20, 60), price: g.cost });
    }
    await j('POST', `/stock/docs/${doc.id}/process`, {});
  }
  console.log('');

  // ── КАССА И СМЕНЫ С ПРОДАЖАМИ ───────────────────────────────────────
  process.stdout.write('Касса ');
  const reg = await tryDo('касса', async () => (await j('POST', '/admin/stores/registers', { name: 'Касса 1' })).d);
  if (reg?.id) {
    const code = await tryDo('код', async () => (await j('POST', '/auth/devices/pairing-code', { cashRegisterId: reg.id })).d);
    if (code?.code) {
      const pair = await tryDo('привязка', async () => (await j('POST', '/pos/pair', { code: code.code, platform: 'windows', appVersion: '1.3.0' })).d);
      DEV = pair?.deviceToken ?? '';
    }
  }
  console.log('');

  if (DEV) {
    process.stdout.write('Торговые дни (14 дней) ');
    let seq = 0;
    for (let day = 13; day >= 0; day--) {
      const ev = [];
      const shiftId = randomUUID();
      // События отправляем от владельца: сотрудники в кабинете есть, но
      // касса привязана к владельцу, и от чужого имени события не примет.
      // Кассир в отчётах будет виден по смене, а не по каждому чеку.
      ev.push({ id: randomUUID(), entity: 'shift', entityId: shiftId, op: 'insert',
        clientSeq: ++seq, clientTs: daysAgo(day),
        payload: { number: 14 - day, openedAt: daysAgo(day), openingFloat: 5000 },
        employeeId: me?.employeeId });

      // Чеков в день: в выходные больше. Так отчёты выглядят живыми,
      // а не ровной линией — на ровной не видно, работает ли график.
      const dow = new Date(Date.now() - day * 86400000).getDay();
      const count = (dow === 0 || dow === 6) ? rnd(18, 28) : rnd(10, 18);

      for (let n = 0; n < count; n++) {
        const items = [];
        let subtotal = 0, cost = 0;
        for (let k = 0; k < rnd(1, 5); k++) {
          const g = goods[rnd(0, goods.length - 1)];
          if (!g) continue;
          const qty = rnd(1, 3);
          items.push({ productId: g.id, qty, price: g.price, discountSum: 0, total: g.price * qty, cost: g.cost });
          subtotal += g.price * qty; cost += g.cost * qty;
        }
        if (!items.length) continue;

        // Каждый десятый чек со скидкой — чтобы отчёт по скидкам ожил
        let discount = 0;
        if (n % 10 === 3) { discount = Math.round(subtotal * 0.1); items[0].discountSum = discount; }

        // Способы оплаты вперемешку: наличные, карта, смешанно, в долг
        const total = subtotal - discount;
        let payment;
        if (n % 7 === 0) payment = { card: total };
        else if (n % 11 === 0) payment = { cash: Math.round(total / 2), card: total - Math.round(total / 2) };
        else payment = { cash: total };

        const saleId = randomUUID();
        ev.push({ id: randomUUID(), entity: 'sale', entityId: saleId, op: 'insert',
          clientSeq: ++seq, clientTs: daysAgo(day),
          payload: {
            shiftId, localNumber: String(n + 1), subtotal, discountSum: discount, rounding: 0,
            total, costTotal: cost, items, payment,
            // каждый пятый чек — на постоянного покупателя, для RFM и бонусов
            customerId: (n % 5 === 0 && customers.length) ? customers[n % customers.length].id : undefined,
          },
          employeeId: me?.employeeId });
      }

      // Один возврат в три дня — чтобы возвраты были видны в отчётах
      if (day % 3 === 0 && goods.length) {
        const g = goods[rnd(0, goods.length - 1)];
        ev.push({ id: randomUUID(), entity: 'sale', entityId: randomUUID(), op: 'insert',
          clientSeq: ++seq, clientTs: daysAgo(day),
          payload: { shiftId, localNumber: 'R' + day, subtotal: g.price, discountSum: 0, rounding: 0,
            total: g.price, costTotal: g.cost, isReturn: true,
            items: [{ productId: g.id, qty: 1, price: g.price, discountSum: 0, total: g.price, cost: g.cost }],
            payment: { cash: g.price } },
          employeeId: me?.employeeId });
      }

      // Закрытие смены. В одной из смен — недостача: это то, ради чего
      // владелец смотрит отчёт по сменам, и на ровных цифрах не видно.
      const shortage = (day === 5) ? -3400 : 0;
      // Закрытие — той же сущностью 'shift' с действием update, а не
      // отдельной сущностью: так устроен обработчик на сервере. Без
      // закрытия следующая смена не откроется — одна касса, одна
      // открытая смена, и все дни слиплись бы в один.
      ev.push({ id: randomUUID(), entity: 'shift', entityId: shiftId, op: 'update',
        clientSeq: ++seq, clientTs: daysAgo(day),
        payload: { closedAt: daysAgo(day), actualCash: shortage ? undefined : null,
                   comment: shortage ? 'Пересчёт: не хватает' : null },
        employeeId: me?.employeeId });

      await j('POST', '/sync/push', { events: ev }, true);
      process.stdout.write('·');
    }
    console.log('');
  }

  // ── ОПТОВЫЕ СДЕЛКИ ──────────────────────────────────────────────────
  process.stdout.write('Оптовые сделки ');
  const buyer = customers.find((c) => c.name.includes('Кафе')) ?? customers[0];
  if (buyer && goods.length) {
    for (let i = 0; i < 3; i++) {
      const o = await tryDo('сделка', async () => (await j('POST', '/wholesale/orders', {
        counterpartyId: buyer.id,
        comment: i === 0 ? 'Отгрузка по договору, оплата после реализации' : 'Постоянный заказ',
        items: [
          { productId: goods[i * 2]?.id, qty: 10, price: Math.round(goods[i * 2]?.price * 0.9) },
          { productId: goods[i * 2 + 1]?.id, qty: 5, price: Math.round(goods[i * 2 + 1]?.price * 0.9) },
        ].filter((x) => x.productId),
      })).d);
      if (!o?.id) continue;
      await j('POST', `/wholesale/orders/${o.id}/ship`, {});
      // первая оплачена целиком, вторая частично, третья висит долгом
      if (i === 0) await j('POST', `/wholesale/orders/${o.id}/pay`, { amount: 999999999, method: 'transfer' }).catch(() => {});
      if (i === 1) await j('POST', `/wholesale/orders/${o.id}/pay`, { amount: 20000, method: 'cash' });
    }
  }
  console.log('');

  // ── АКЦИЗНЫЕ МАРКИ ──────────────────────────────────────────────────
  process.stdout.write('Акциз (алкоголь) ');
  const vodka = await tryDo('водка', async () => (await j('POST', '/goods', {
    name: 'Водка Хаома 0,5л 40%', salePrice: 2890, purchasePrice: 1950,
    barcode: '4870001000918',
  })).d);
  if (vodka?.id) {
    await tryDo('марки', async () => (await j('POST', '/excise/receive', {
      productId: vodka.id,
      marks: ['KZ 000000121', 'KZ 000000122', 'KZ 000000123', 'KZ 000000124', 'KZ 000000125'],
    })).d);
    await tryDo('проверка', async () => (await j('POST', '/excise/check', { series: 'KZ', number: '000000121' })).d);
  }
  console.log('');

  // ── МАРКИРОВКА ──────────────────────────────────────────────────────
  process.stdout.write('Маркировка ');
  const shoes = await tryDo('обувь', async () => (await j('POST', '/goods', {
    name: 'Кроссовки Adidas Runfalcon 42', salePrice: 24900, purchasePrice: 16000,
    barcode: '4870001000925',
  })).d);
  if (shoes?.id) {
    await tryDo('коды', async () => (await j('POST', '/marking/receive', {
      productId: shoes.id,
      codes: ['0104870001000925215abcdef1', '0104870001000925215abcdef2'],
    })).d);
  }
  console.log('');

  // ── ПРОВЕРКА КОНТРАГЕНТА В КГД ──────────────────────────────────────
  process.stdout.write('Проверки КГД ');
  for (const s of suppliers.slice(0, 2)) {
    await tryDo('проверка', async () => (await j('POST', '/verification/check', {
      binOrIin: '05114000419' + rnd(1, 8), counterpartyId: s.id, provider: 'mock',
    })).d);
  }
  await tryDo('касса КГД', async () => (await j('POST', '/verification/check-kkm', { number: '123451', provider: 'mock' })).d);
  console.log('');

  // ── KASPI МАГАЗИН ───────────────────────────────────────────────────
  process.stdout.write('Kaspi магазин ');
  await tryDo('подключение', async () => (await j('POST', '/marketplace/connect', {
    provider: 'mock', token: 'demo-token', autoAccept: false,
  })).d);
  for (let i = 0; i < 3; i++) {
    await tryDo('заказ', async () => (await j('POST', '/marketplace/_mock-seed-order', {})).d);
  }
  console.log('');

  // ── ИТОГ ────────────────────────────────────────────────────────────
  console.log('\n═══ ГОТОВО ═══\n');
  const dash = (await j('GET', '/reports/dashboard')).d;
  console.log('Что теперь в магазине:');
  console.log(`  товаров:      ${goods.length + 3}`);
  console.log(`  сотрудников:  ${staffIds.length}`);
  console.log(`  контрагентов: ${suppliers.length + customers.length}`);
  console.log(`  выручка за сегодня: ${Number(dash?.revenue ?? 0).toLocaleString('ru-RU')} ₸`);
  console.log('\nСмотрите разделы: Показатели, Отчёты (все 7 вкладок),');
  console.log('Товары, Склад, Контрагенты, RFM-анализ, Опт, Акциз,');
  console.log('Маркировка, Kaspi магазин, Техкарты, Лояльность.\n');
  console.log('PIN кассиров: Асель 1111, Ерлан 2222, Динара 3333\n');
})().catch((e) => { console.error('\nОшибка:', e.message); process.exit(1); });
