/**
 * ДЕМО-ДАННЫЕ ДЛЯ ЗАПУСКА НА НОУТБУКЕ.
 *
 * Наполняет систему живым магазином, чтобы было что смотреть:
 * товары с ценами и остатками, кассир и продавец-консультант, покупатели
 * с долгами и бонусами, торговый день с чеками всех видов (наличные,
 * карта, долг, бонусы, возврат), закрытая смена с недостачей, заявка
 * с лендинга — все страницы кабинета и операторки оживают.
 *
 * Запуск (сервер должен работать):  node scripts/demo_seed.js
 * Печатает логин/пароль демо-владельца в конце.
 */
const { randomUUID } = require('crypto');
const API = process.env.API_URL ?? 'http://localhost:3000';

const PHONE = '+77010001122';
const PASSWORD = 'Demo1234';

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null);
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
};

(async () => {
  console.log('→ Демо-магазин «Продукты на Абая»…');

  // ---------- владелец ----------
  let d = await j('POST', '/auth/otp', { phone: PHONE }).catch(() => null);
  if (d?.devCode) {
    await j('POST', '/auth/register', { phone: PHONE, code: d.devCode,
      businessName: 'Продукты на Абая', ownerName: 'Салтанат', password: PASSWORD })
      .catch(() => null);
  }
  d = await j('POST', '/auth/login', { phone: PHONE, password: PASSWORD });
  TOK = d.access;
  const me = await j('GET', '/auth/me');
  console.log('  владелец готов:', PHONE);

  // если демо уже наполнялось — не дублируем
  const existing = await j('GET', '/goods?q=&limit=1');
  if (Array.isArray(existing) && existing.length > 0) {
    console.log('  данные уже есть — пропускаю наполнение.');
    console.log(`\n=== ДЕМО ГОТОВО ===\nКабинет:  http://localhost:3001/login\nТелефон:  ${PHONE}\nПароль:   ${PASSWORD}\nОператор: http://localhost:3001/operator (ключ: значение OPERATOR_KEY)`);
    return;
  }

  // ---------- товары ----------
  const GOODS = [
    ['Молоко Айналайын 3.2% 1л', 434, 320, 'Молочное'], ['Кефир Foodmaster 1л', 520, 390, 'Молочное'],
    ['Сметана 20% 400г', 690, 510, 'Молочное'], ['Хлеб Бородинский', 179, 120, 'Хлеб'],
    ['Лепёшка тандырная', 250, 150, 'Хлеб'], ['Багет французский', 320, 200, 'Хлеб'],
    ['Сахар 1кг', 500, 380, 'Бакалея'], ['Мука в/с 2кг', 890, 640, 'Бакалея'],
    ['Рис Краснодарский 900г', 780, 560, 'Бакалея'], ['Гречка 800г', 650, 470, 'Бакалея'],
    ['Масло подсолнечное 1л', 950, 720, 'Бакалея'], ['Макароны Цесна 400г', 380, 260, 'Бакалея'],
    ['Кола 1л', 400, 300, 'Напитки'], ['Сок Gracio яблоко 1л', 620, 450, 'Напитки'],
    ['Вода Tassay 1.5л', 250, 150, 'Напитки'], ['Чай Пиала гранулированный 250г', 1190, 880, 'Напитки'],
    ['Шоколад Казахстан 100г', 640, 460, 'Кондитерка'], ['Печенье Юбилейное', 450, 320, 'Кондитерка'],
    ['Конфеты Рахат ассорти 1кг', 2900, 2100, 'Кондитерка'], ['Жевательная резинка Orbit', 250, 160, 'Кондитерка'],
    ['Сосиски молочные 1кг', 1850, 1350, 'Мясное'], ['Колбаса сервелат 350г', 1690, 1200, 'Мясное'],
    ['Яйца С1 десяток', 720, 540, 'Молочное'], ['Сыр Голландский 300г', 1450, 1050, 'Молочное'],
    ['Порошок стиральный 3кг', 2490, 1800, 'Бытовая химия'], ['Мыло Absolut', 290, 180, 'Бытовая химия'],
    ['Салфетки 100шт', 350, 220, 'Бытовая химия'], ['Пакет майка', 20, 8, 'Бытовая химия'],
  ];
  const ids = {};
  let bc = 4870100000001;
  for (const [name, price, cost, cat] of GOODS) {
    const g = await j('POST', '/goods', { name, salePrice: price, purchasePrice: cost,
      categoryName: cat, barcodes: [String(bc++)] });
    ids[name] = { id: g.id, price, cost };
  }
  console.log(`  товаров: ${GOODS.length}`);

  // ---------- приёмка ----------
  const doc = await j('POST', '/stock/docs', { kind: 'supply' });
  for (const [name] of GOODS) {
    await j('POST', `/stock/docs/${doc.id}/items`,
      { productId: ids[name].id, qty: 60, price: ids[name].cost });
  }
  await j('POST', `/stock/docs/${doc.id}/process`, {});
  console.log('  приёмка: по 60 шт каждого');

  // ---------- команда ----------
  await j('POST', '/auth/employees', { firstName: 'Мадина', phone: '+77012223344', roleCode: 'cashier', pin: '1234' });
  const con = await j('POST', '/admin/consultants', { name: 'Ерлан', phone: '+77013334455', commissionPercent: 10 });
  console.log('  команда: кассир Мадина (PIN 1234), продавец Ерлан (10%)');

  // ---------- покупатели и бонусы ----------
  await j('POST', '/loyalty/programs', { name: 'Кешбэк 5%', earnPercent: 5, spendPercent: 50, minPurchase: 500 });
  const az = await j('POST', '/contragents', { name: 'Азамат (сосед)', phone: '+77017778899', roles: ['customer'], debtLimit: 10000 });
  const sa = await j('POST', '/contragents', { name: 'Сауле-апай', phone: '+77015556677', roles: ['customer'], debtLimit: 5000 });
  await j('POST', '/contragents', { name: 'ТОО «Оптовик KZ» (поставщик)', roles: ['supplier'], iinBin: '123456789012' }).catch(() => null);
  console.log('  покупатели с лимитами долга, бонусы 5%');

  // ---------- касса ----------
  const reg = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  const code = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: reg.id });
  const pair = await j('POST', '/pos/pair', { code: code.code, platform: 'windows', appVersion: 'demo' });
  DEV = pair.deviceToken;

  // ---------- торговый день (офлайн-события, как шлёт Flutter-касса) ----------
  const q = [];
  let seq = 0, local = 0, cashBox = 10000;   // размен при открытии
  const enq = (entity, entityId, op, payload) =>
    q.push({ id: randomUUID(), entity, entityId, op, payload, clientSeq: ++seq,
      clientTs: new Date().toISOString(), employeeId: me.employeeId });
  const P = (n) => ids[n];
  const sale = (items, payment, extra = {}) => {
    const subtotal = items.reduce((s, [n, qq]) => s + qq * P(n).price, 0);
    const before = subtotal - (extra.discountSum ?? 0);
    const rounding = Math.floor(before / 5) * 5 - before;
    const total = before + rounding;
    const cost = items.reduce((s, [n, qq]) => s + qq * P(n).cost, 0);
    const id = randomUUID();
    enq('sale', id, 'insert', { shiftId: sh, localNumber: ++local, ...extra,
      subtotal, discountSum: extra.discountSum ?? 0, rounding, total, costTotal: cost,
      items: items.map(([n, qq]) => ({ productId: P(n).id, qty: qq, price: P(n).price,
        total: qq * P(n).price, cost: P(n).cost })),
      payment });
    cashBox += (payment.cash ?? 0) - (payment.change ?? 0);
    return { id, total };
  };

  const sh = randomUUID();
  enq('shift', sh, 'insert', { number: 1, openedAt: new Date().toISOString(), openingFloat: 10000 });

  sale([['Молоко Айналайын 3.2% 1л', 2], ['Хлеб Бородинский', 1], ['Яйца С1 десяток', 1]], { cash: 1765 });
  const s2 = sale([['Кола 1л', 2], ['Шоколад Казахстан 100г', 1]], { card: 1440 }, { consultantId: con.id });
  sale([['Сахар 1кг', 2], ['Мука в/с 2кг', 1], ['Масло подсолнечное 1л', 1]], { cash: 2000, card: 840 });
  sale([['Сосиски молочные 1кг', 1], ['Лепёшка тандырная', 2]], { credit: 2350 }, { customerId: az.id });
  sale([['Чай Пиала гранулированный 250г', 1], ['Конфеты Рахат ассорти 1кг', 1]], { credit: 4090 }, { customerId: sa.id });
  sale([['Кефир Foodmaster 1л', 1], ['Багет французский', 1]], { cash: 840 }, { customerId: az.id });
  enq('cash_operation', randomUUID(), 'insert', { shiftId: sh, kind: 'withdrawal', amount: 5000, comment: 'Закуп овощей у поставщика' });
  cashBox -= 5000;
  enq('debt_payment', randomUUID(), 'insert', { counterpartyId: az.id, amount: 1000, method: 'cash', shiftId: sh });
  cashBox += 1000;
  // возврат колы из чека Ерлана
  enq('sale', randomUUID(), 'insert', { shiftId: sh, localNumber: ++local, refundOf: s2.id,
    subtotal: -400, discountSum: 0, rounding: 0, total: -400, costTotal: -300,
    items: [{ productId: P('Кола 1л').id, qty: -1, price: 400, total: -400, cost: 300 }],
    payment: { card: -400 } });
  sale([['Вода Tassay 1.5л', 3], ['Жевательная резинка Orbit', 2]], { cash: 1250 });
  sale([['Сыр Голландский 300г', 1], ['Колбаса сервелат 350г', 1]], { cash: 3140 }, { consultantId: con.id });

  // закрытие: пересчитали ящик, не хватает 150 — касса знает ожидаемую
  // сумму сама (cashBox), как настоящая: сервер посчитает то же самое
  enq('shift', sh, 'update', { closedAt: new Date().toISOString(),
    actualCash: cashBox - 150, comment: 'Не хватает 150 — видимо сдача' });

  for (let i = 0; i < q.length; i += 100) {
    const r = await j('POST', '/sync/push', { events: q.slice(i, i + 100), pending: q.length }, true);
    const bad = (r.results ?? []).filter((x) => x.result === 'quarantined');
    if (bad.length) console.log('  карантин:', JSON.stringify(bad.slice(0, 2)));
  }
  console.log('  торговый день: 9 чеков, долги, бонусы, возврат, смена закрыта с недостачей 150 ₸');

  // ---------- заявка с лендинга (для операторки) ----------
  await j('POST', '/public/leads', { name: 'Бахыт (магазин в Туркестане)',
    phone: '+77051112233', city: 'Туркестан', comment: 'Хотим переехать с UMAG', locale: 'kk' }).catch(() => null);

  console.log(`\n=== ДЕМО ГОТОВО ===
Лендинг:  http://localhost:3001/
Кабинет:  http://localhost:3001/login
Телефон:  ${PHONE}
Пароль:   ${PASSWORD}
PIN кассира Мадины: 1234
Оператор: http://localhost:3001/operator (ключ: значение OPERATOR_KEY из окружения сервера)`);
})().catch((e) => { console.error('ОШИБКА ДЕМО:', e.message); process.exit(1); });
