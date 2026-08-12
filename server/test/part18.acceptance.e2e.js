/**
 * ★★★ ЧАСТЬ 18 — ПРИЁМОЧНЫЙ ТЕСТ «ДЕНЬ МАГАЗИНА».
 *
 * Один тест проживает весь путь владельца, как он пройдёт его на пилоте:
 * регистрация (2 минуты, автотриал) → импорт номенклатуры из Excel →
 * приёмка товара → кассир + продавец + касса → покупатель с лимитом →
 * ОФЛАЙН торговый день (все способы оплаты, скидки, округление, бонусы,
 * долг, отмена, внесение/изъятие, погашение долга, возврат) → закрытие
 * смены → вечер владельца: дашборд, P&L, смены, кассиры, консультанты
 * («к выплате»), долговая книга, склад. Всё должно сойтись до тенге.
 *
 * Если этот тест зелёный — магазин можно ставить на пилот.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const XLSX = require('xlsx');

const PORT = '3188';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // ============ УТРО ПОНЕДЕЛЬНИКА: владелец регистрируется ============
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Продукты у дома', ownerName: 'Салтанат', password: 'Password123' });
  TOK = r.d.access;
  ok(!!TOK, 'День 0, 09:00 — владелец зарегистрировался сам, без звонка менеджеру');

  r = await j('GET', '/billing/access');
  ok(r.d.canSell && r.d.status === 'trial', 'Пробный период включился сам — торговать можно сразу');

  // ============ ИМПОРТ НОМЕНКЛАТУРЫ ИЗ EXCEL ============
  const rows = [
    ['Наименование', 'Штрихкод', 'Код НКТ (NTIN)', 'Категория', 'Единица измерения', 'Цена закупки', 'Цена', 'НДС'],
    ['Молоко Айналайын 1л', '4870300000011', '', 'Молочное', 'шт', 320, 434, 12],
    ['Хлеб Бородинский',    '4870300000028', '', 'Хлеб',     'шт', 120, 179, 12],
    ['Сахар 1кг',           '4870300000035', '', 'Бакалея',  'шт', 380, 500, 12],
    ['Кола 1л',             '4870300000042', '', 'Напитки',  'шт', 300, 400, 12],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Товары');
  const base64 = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64');

  r = await j('POST', '/import/preview', { fileName: 'nomen.xlsx', base64 });
  ok(r.d.totalRows === 4 && r.d.problems.length === 0, 'Excel с номенклатурой распознан: 4 товара, колонки сопоставились сами');
  r = await j('POST', '/import/run', { sessionId: r.d.sessionId, base64 });
  ok(r.d.created === 4 && r.d.errors === 0, `Импорт: создано ${r.d.created} товара, ошибок ${r.d.errors}`);

  r = await j('GET', '/goods?q=&limit=50');
  const G = {};
  for (const p of (Array.isArray(r.d) ? r.d : [])) {
    if (/Молоко/.test(p.name)) G.milk = p.id;
    if (/Хлеб/.test(p.name)) G.bread = p.id;
    if (/Сахар/.test(p.name)) G.sugar = p.id;
    if (/Кола/.test(p.name)) G.cola = p.id;
  }
  ok(G.milk && G.bread && G.sugar && G.cola, 'Все 4 товара видны в кабинете');

  // минимальная цена на хлеб — защита от продажи в убыток (МС)
  await j('PATCH', `/goods/${G.bread}`, { minPrice: 150 });

  // ============ ПРИЁМКА ТОВАРА ============
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const doc = r.d.id;
  for (const [id, qty, price] of [[G.milk, 100, 320], [G.bread, 100, 120], [G.sugar, 100, 380], [G.cola, 100, 300]]) {
    await j('POST', `/stock/docs/${doc}/items`, { productId: id, qty, price });
  }
  r = await j('POST', `/stock/docs/${doc}/process`, {});
  ok(r.status === 201, 'Приёмка проведена: по 100 шт каждого');

  // ============ КОМАНДА И КАССА ============
  r = await j('POST', '/auth/employees', { firstName: 'Мадина', phone: '+77012220011', roleCode: 'cashier', pin: '4321' });
  const cashierId = r.d.id;
  r = await j('POST', '/admin/consultants', { name: 'Ерлан', phone: '+77013330022', commissionPercent: 10 });
  const erlan = r.d.id;
  ok(cashierId && erlan && Number(r.d.commission_percent) === 10,
     'Команда: кассир Мадина (PIN) и продавец Ерлан (10% с продаж)');

  r = await j('POST', '/contragents', { name: 'Азамат', phone: '+77017770099', roles: ['customer'], debtLimit: 5000 });
  const azamat = r.d.id;
  r = await j('POST', '/loyalty/programs', { name: 'Кешбэк', earnPercent: 5, spendPercent: 50 });
  ok(!!azamat, 'Покупатель Азамат (лимит долга 5000) и бонусы 5% настроены');

  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;
  r = await j('GET', '/pos/bootstrap', null, true);
  ok(!!DEV && r.d.consultants.some((x) => x.id === erlan) && r.d.loyaltyProgram?.earnPercent === 5,
     'Касса привязана; bootstrap несёт продавцов и правила бонусов');
  r = await j('GET', '/pos/goods/catalog', null, true);
  ok(r.d.products.length === 4, 'Каталог уехал на кассу — торговать можно и без интернета');

  // ============ ТОРГОВЫЙ ДЕНЬ (ОФЛАЙН) ============
  const q = [];
  let seq = 0;
  const enq = (entity, entityId, op, payload, emp = cashierId) =>
    q.push({ id: randomUUID(), entity, entityId, op, payload, clientSeq: ++seq,
      clientTs: new Date().toISOString(), employeeId: emp });

  const shiftId = randomUUID();
  enq('shift', shiftId, 'insert', { number: 1, openedAt: new Date().toISOString(), openingFloat: 5000 });

  let cashInBox = 0, revenue = 0, profit = 0;
  const sold = { [G.milk]: 0, [G.bread]: 0, [G.sugar]: 0, [G.cola]: 0 };
  let local = 0;
  const sale = (items, payment, extra = {}) => {
    const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
    const discount = extra.discountSum ?? 0;
    const before = subtotal - discount;
    const rounding = Math.floor(before / 5) * 5 - before;   // вниз до 5 — в пользу покупателя
    const total = before + rounding;
    const cost = items.reduce((s, i) => s + i.qty * i.cost, 0);
    const id = randomUUID();
    enq('sale', id, 'insert', {
      shiftId, localNumber: ++local, ...extra,
      subtotal, discountSum: discount, rounding, total, costTotal: cost,
      items: items.map((i) => ({ productId: i.id, qty: i.qty, price: i.price,
        discountSum: i.disc ?? 0, total: i.qty * i.price - (i.disc ?? 0), cost: i.cost })),
      payment,
    });
    for (const i of items) sold[i.id] += i.qty;
    revenue += total; profit += total - cost;
    cashInBox += (payment.cash ?? 0) - (payment.change ?? 0);
    return { id, total };
  };

  // 10:05 — наличные со скидкой 10% на хлеб: 434+179−17.9=595.1 → 595
  const s1 = sale(
    [{ id: G.milk, qty: 1, price: 434, cost: 320 },
     { id: G.bread, qty: 1, price: 179, cost: 120, disc: 17.9 }],
    { cash: 1000, change: 405 }, { discountSum: 17.9 });
  ok(near(s1.total, 595), `10:05 чек №1: скидка + округление вниз = ${s1.total} ₸`);

  // 11:30 — карта, продавец Ерлан (2 колы = 800)
  const s2 = sale([{ id: G.cola, qty: 2, price: 400, cost: 300 }], { card: 800 }, { consultantId: erlan });

  // 13:00 — смешанная: сахар ×3 = 1500 (1000 нал + 500 карта)
  sale([{ id: G.sugar, qty: 3, price: 500, cost: 380 }], { cash: 1000, card: 500 });

  // 14:20 — Азамат берёт в долг 2000 (в лимите)
  sale([{ id: G.sugar, qty: 4, price: 500, cost: 380 }], { credit: 2000 }, { customerId: azamat });

  // 15:00 — отмена позиции (журнал UMAG «100→98»)
  enq('cancelled_item', randomUUID(), 'insert',
    { shiftId, productId: G.cola, qtyAdded: 3, qtyCancelled: 2, price: 400 });

  // 16:00 — внесение размена 2000, изъятие 3000 на закуп
  enq('cash_operation', randomUUID(), 'insert', { shiftId, kind: 'deposit', amount: 2000, comment: 'Мелочь' });
  enq('cash_operation', randomUUID(), 'insert', { shiftId, kind: 'withdrawal', amount: 3000, comment: 'Закуп у поставщика' });
  cashInBox += 2000 - 3000;

  // 17:30 — Азамат занёс 1000 наличными в счёт долга
  enq('debt_payment', randomUUID(), 'insert', { counterpartyId: azamat, amount: 1000, method: 'cash', shiftId });
  cashInBox += 1000;

  // 18:15 — Азамат платит бонусами: у него 5% от (595+800+1500+2000)... бонусы
  // начислит сервер; здесь чек молока 434: 100 бонусами + 334 наличными
  sale([{ id: G.milk, qty: 1, price: 434, cost: 320 }],
    { bonus: 100, cash: 334 }, { customerId: azamat });

  // 19:00 — возврат колы из чека №2 (продавец Ерлан теряет процент с 400)
  enq('sale', randomUUID(), 'insert', {
    shiftId, localNumber: ++local, refundOf: s2.id,
    subtotal: -400, discountSum: 0, rounding: 0, total: -400, costTotal: -300,
    items: [{ productId: G.cola, qty: -1, price: 400, total: -400, cost: 300 }],
    payment: { card: -400 },
  });
  sold[G.cola] -= 1; revenue -= 400; profit -= 100;

  // 21:00 — закрытие: пересчитали, недостача 50 ₸
  const expectedCash = 5000 + cashInBox;
  enq('shift', shiftId, 'update', { closedAt: new Date().toISOString(),
    actualCash: expectedCash - 50, comment: 'Не хватает полтинника, видимо сдача' });

  // ============ ИНТЕРНЕТ ВЕРНУЛСЯ: ОЧЕРЕДЬ УЕХАЛА ============
  let accepted = 0;
  for (let i = 0; i < q.length; i += 100) {
    r = await j('POST', '/sync/push', { events: q.slice(i, i + 100), pending: q.length }, true);
    accepted += r.d.accepted;
    const bad = r.d.results.filter((x) => x.result === 'quarantined');
    if (bad.length) console.log('   карантин:', JSON.stringify(bad));
  }
  ok(accepted === q.length, `★ Все ${q.length} событий дня приняты сервером`);

  // ============ ВЕЧЕР ВЛАДЕЛЬЦА: ВСЁ ЛИ СОШЛОСЬ ============
  r = await j('GET', '/reports/dashboard?period=today');
  ok(near(r.d.revenue, revenue), `★ Дашборд: выручка ${r.d.revenue} = ${revenue} ₸ (до тенге)`);
  ok(near(r.d.grossProfit, profit), `★ Валовая прибыль ${r.d.grossProfit} = ${profit} ₸`);

  r = await j('GET', '/reports/shifts?period=today');
  const sh = (Array.isArray(r.d) ? r.d : r.d.rows ?? [])[0];
  ok(sh && near(sh.expected_cash, expectedCash) && near(sh.discrepancy, -50),
     `★ Смена: в кассе должно быть ${sh?.expected_cash} ₸, недостача ${sh?.discrepancy} с комментарием`);
  ok(sh?.discrepancy_comment?.includes('полтинника'), 'Комментарий недостачи сохранён');

  r = await j('GET', '/reports/cashiers?period=today');
  const madina = (Array.isArray(r.d) ? r.d : []).find((x) => /Мадина/.test(x.name ?? ''));
  ok(!!madina, `Отчёт по кассирам: Мадина, ${madina?.receipts} чеков`);

  // ★ консультанты: Ерлан продал 800, возврат 400 → база 400 × 10% = 40
  r = await j('GET', '/reports/consultants?period=today');
  const er = r.d.find((x) => x.consultantId === erlan);
  ok(er && near(er.revenue, 800) && near(er.refunds, 400) && near(er.commission, 40),
     `★ Консультант Ерлан: продал 800, вернули 400, к выплате (800−400)×10% = ${er?.commission} ₸`);

  // долговая книга: 2000 − 1000 = 1000
  r = await j('GET', '/contragents/debts');
  const dAz = r.d.items.find((x) => x.counterpartyId === azamat);
  ok(near(dAz?.debt, 1000), `★ Долговая книга: Азамат должен 2000−1000 = ${dAz?.debt} ₸`);

  // бонусы: порог программы по умолчанию 1000 ₸ (модель Wipon «от 1000»):
  // credit-чек 2000 → earn 100; чек 430 ниже порога → без начисления; spend 100
  r = await j('GET', `/loyalty/balance/${azamat}`);
  ok(near(r.d.balance, 100 - 100),
     `★ Бонусы Азамата: +100 (чек 2000) − 100 списано; чек 430 ниже порога 1000 → баланс ${r.d.balance} ₸`);

  // склад: 100 − продано (+ возврат колы уже учтён в sold)
  r = await j('GET', '/stock/balance?onlyNonZero=true');
  let stockOk = true;
  for (const [id, qty] of Object.entries(sold)) {
    const b = r.d.find((x) => x.product_id === id);
    if (!near(b?.qty, 100 - qty)) { stockOk = false; console.log('   склад разошёлся:', id, b?.qty, 'ожидали', 100 - qty); }
  }
  ok(stockOk, '★ Склад по всем 4 товарам сошёлся с проданным (возврат вернулся)');

  // P&L дня: выручка/себестоимость видны в финансах
  r = await j('GET', `/finance/pnl?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`);
  ok(near(r.d.revenue?.total ?? 0, revenue) && near(r.d.grossProfit ?? 0, profit),
     `P&L: выручка дня ${r.d.revenue?.total} ₸, валовая ${r.d.grossProfit} ₸`);

  // повтор всей очереди — ни одного дубля нигде
  r = await j('POST', '/sync/push', { events: q.slice(0, 5) }, true);
  ok(r.d.results.every((x) => x.result === 'duplicate'), 'Повторная отправка после обрыва — только duplicate');
  r = await j('GET', '/reports/dashboard?period=today');
  ok(near(r.d.revenue, revenue), 'Выручка не задвоилась');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  if (!fail) console.log('★★★ МАГАЗИН ПРОЖИЛ ПОЛНЫЙ ДЕНЬ: от регистрации до вечерних отчётов всё сошлось до тенге. Готов к пилоту.');
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
