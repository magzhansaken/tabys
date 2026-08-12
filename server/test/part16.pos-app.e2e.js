/**
 * ★ ЧАСТЬ 16 — КАССА (Flutter): проверка контракта и математики.
 *
 * Flutter в CI не собирается, поэтому проверяем то, что важнее пикселей:
 * 1) все HTTP/sync-контракты, на которые опирается приложение (привязка,
 *    bootstrap с PIN-хэшами, снимок каталога, дельты, push офлайн-событий);
 * 2) математику чека — формулы из pos/lib/domain/cart.dart зеркалятся здесь
 *    один в один и прогоняются против сервера: скидки, округление вниз до
 *    5 ₸, смешанная оплата, себестоимость;
 * 3) новые обработчики: закрытие смены офлайн, внесения/изъятия офлайн,
 *    возврат отрицательным чеком, дельты каталога из кабинета.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

const PORT = '3166';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

// ===================================================================
// ЗЕРКАЛО pos/lib/domain/cart.dart — формулы должны совпадать байт в байт
// ===================================================================
const r2 = (v) => Math.round(v * 100) / 100;
class Cart {
  constructor(roundTo = 5) { this.lines = []; this.roundTo = roundTo; this.rPct = 0; this.rAmt = 0; }
  add(l) { this.lines.push({ discountPercent: 0, discountAmount: 0, ...l }); return this.lines.at(-1); }
  lineGross(l) { return r2(l.price * l.qty); }
  lineDiscount(l) { return r2(Math.min(this.lineGross(l), r2(this.lineGross(l) * l.discountPercent / 100) + l.discountAmount)); }
  lineTotal(l) { return r2(this.lineGross(l) - this.lineDiscount(l)); }
  get subtotal() { return r2(this.lines.reduce((s, l) => s + this.lineGross(l), 0)); }
  get lineDiscounts() { return r2(this.lines.reduce((s, l) => s + this.lineDiscount(l), 0)); }
  get receiptDiscount() {
    const base = r2(this.subtotal - this.lineDiscounts);
    return r2(Math.min(base, r2(base * this.rPct / 100) + this.rAmt));
  }
  get discountSum() { return r2(this.lineDiscounts + this.receiptDiscount); }
  get totalBeforeRounding() { return r2(this.subtotal - this.discountSum); }
  get rounding() {
    if (this.roundTo <= 0) return 0;
    return r2(Math.floor(this.totalBeforeRounding / this.roundTo) * this.roundTo - this.totalBeforeRounding);
  }
  get total() { return r2(this.totalBeforeRounding + this.rounding); }
  get costTotal() { return r2(this.lines.reduce((s, l) => s + r2((l.cost ?? 0) * l.qty), 0)); }
  payload(shiftId, localNumber, payment) {
    return { shiftId, localNumber,
      subtotal: this.subtotal, discountSum: this.discountSum, rounding: this.rounding,
      total: this.total, costTotal: this.costTotal,
      items: this.lines.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price,
        discountSum: this.lineDiscount(l), total: this.lineTotal(l), cost: l.cost ?? 0 })),
      payment };
  }
}

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // ---------- владелец готовит магазин из кабинета ----------
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode, businessName: 'Касса Тест', ownerName: 'Салтанат', password: 'Password123' });
  TOK = r.d.access;
  ok(!!TOK, 'Владелец зарегистрирован');

  r = await j('POST', '/goods', { name: 'Молоко Айналайын 1л', salePrice: 434, purchasePrice: 320, barcode: '4870010000011' });
  const milk = r.d.id;
  r = await j('POST', '/goods', { name: 'Хлеб Бородинский', salePrice: 179, purchasePrice: 120, barcode: '4870010000028', minPrice: 150 });
  const bread = r.d.id;
  ok(!!milk && !!bread, 'Товары созданы в кабинете');

  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const doc = r.d.id;
  await j('POST', `/stock/docs/${doc}/items`, { productId: milk, qty: 100, price: 320 });
  await j('POST', `/stock/docs/${doc}/items`, { productId: bread, qty: 100, price: 120 });
  r = await j('POST', `/stock/docs/${doc}/process`, {});
  ok(r.status === 201, 'Приёмка проведена: по 100 шт на складе');

  r = await j('POST', '/auth/employees', { firstName: 'Мадина', phone: '+77012223344', roleCode: 'cashier', pin: '4321' });
  const cashierId = r.d.id;
  ok(!!cashierId, 'Кассир Мадина принята с PIN 4321');

  // ---------- касса: создать в кабинете, привязать устройство ----------
  r = await j('POST', '/admin/stores/registers', { name: 'Касса у входа' });
  ok(r.status === 201 && r.d.id, '★ Касса создана из кабинета (новый эндпоинт части 16)');
  const regId = r.d.id;

  r = await j('GET', '/admin/stores');
  ok(Array.isArray(r.d) && r.d[0]?.registers?.some((x) => x.id === regId), 'Точки и кассы отдаются кабинету');

  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: regId });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'windows', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;
  ok(!!DEV, 'Устройство привязано по одноразовому коду (модель UMAG)');

  // ---------- bootstrap: офлайн-вход возможен ----------
  r = await j('GET', '/pos/bootstrap', null, true);
  const madina = r.d.staff.find((s) => s.first_name === 'Мадина');
  ok(!!madina?.pos_pin_hash, 'Bootstrap привёз PIN-хэши сотрудников');
  ok(bcrypt.compareSync('4321', madina.pos_pin_hash), '★ PIN проверяется локально (bcrypt) — вход без интернета');
  ok(!bcrypt.compareSync('0000', madina.pos_pin_hash), 'Чужой PIN не подходит');

  // ---------- снимок каталога ----------
  r = await j('GET', '/pos/goods/catalog', null, true);
  const cat = r.d;
  ok(Array.isArray(cat.products) && cat.products.length === 2, '★ Снимок каталога отдаётся устройству (новый эндпоинт)');
  const cMilk = cat.products.find((p) => p.id === milk);
  const cBread = cat.products.find((p) => p.id === bread);
  ok(Number(cMilk.price) === 434 && Number(cBread.price) === 179, 'Цены в снимке верные');
  ok(Number(cBread.min_price) === 150, 'Минимальная цена приехала (защита МС)');
  ok(cMilk.barcodes.some((b) => b.code === '4870010000011'), 'Штрихкоды в снимке');
  ok(Number(cMilk.cost) === 320, 'Себестоимость в снимке — чек посчитается на кассе');
  ok(typeof cat.serverSeq === 'number', 'Снимок несёт serverSeq — курсор для дельт');

  // ---------- дельты: кабинет меняет цену и создаёт товар ----------
  await j('PATCH', `/goods/${milk}/price`, { typeCode: 'retail', value: 450 })
    .then(async (x) => x.status === 404 ? j('POST', `/goods/${milk}/price`, { typeCode: 'retail', value: 450 }) : x);
  r = await j('POST', '/goods', { name: 'Кефир Айналайын', salePrice: 390, purchasePrice: 300 });
  const kefir = r.d.id;

  r = await j('GET', `/sync/pull?since=${cat.serverSeq}&limit=100`, null, true);
  const evs = r.d.events;
  ok(evs.some((e) => e.entity === 'price' && e.entityId === milk && Number(e.payload.value) === 450),
     '★ Правка цены из кабинета доехала дельтой (событие price)');
  ok(evs.some((e) => e.entity === 'product' && e.entityId === kefir && e.payload.name === 'Кефир Айналайын'),
     '★ Новый товар из кабинета доехал дельтой (событие product)');

  // ===================================================================
  // ОФЛАЙН-ДЕНЬ: события копятся локально (как в Dart), потом push
  // ===================================================================
  const queue = [];
  let clientSeq = 0;
  const enqueue = (entity, entityId, op, payload, employeeId) =>
    queue.push({ id: randomUUID(), entity, entityId, op, payload,
      clientSeq: ++clientSeq, clientTs: new Date().toISOString(), employeeId });

  const shiftId = randomUUID();
  enqueue('shift', shiftId, 'insert', { number: 1, openedAt: new Date().toISOString(), openingFloat: 5000 }, cashierId);

  // размен-внесение и изъятие (новый обработчик cash_operation)
  const depId = randomUUID(), wdId = randomUUID();
  enqueue('cash_operation', depId, 'insert', { shiftId, kind: 'deposit', amount: 2000, comment: 'Мелочь из сейфа' }, cashierId);
  enqueue('cash_operation', wdId, 'insert', { shiftId, kind: 'withdrawal', amount: 1000, comment: 'Инкассация обеда' }, cashierId);

  // --- чек 1: скидки + округление вниз до 5 ---
  const c1 = new Cart(5);
  c1.add({ productId: milk, name: 'Молоко', price: 434, qty: 2, cost: 320 });        // 868
  const lb = c1.add({ productId: bread, name: 'Хлеб', price: 179, qty: 1, cost: 120, discountPercent: 10 }); // 179-17.9=161.1
  // итог 868+161.1=1029.1 → floor до 5 = 1025, rounding −4.1
  ok(Math.abs(c1.total - 1025) < 0.001, `Математика чека 1: итог ${c1.total} = 1025 (округление вниз ${c1.rounding})`);
  ok(Math.abs(c1.rounding + 4.1) < 0.001, 'Округление всегда в пользу покупателя (−4.1)');
  const sale1 = randomUUID();
  enqueue('sale', sale1, 'insert', c1.payload(shiftId, 1, { cash: 5000, change: r2(5000 - c1.total) }), cashierId);

  // --- чек 2: смешанная оплата, автоподстановка второй суммы ---
  const c2 = new Cart(5);
  c2.add({ productId: milk, name: 'Молоко', price: 434, qty: 3, cost: 320 });        // 1302 → 1300, rounding −2
  ok(c2.total === 1300, `Чек 2: ${c2.total} = 1300`);
  const cashPart = 1000, cardPart = r2(c2.total - cashPart);                          // Wipon: вторая сумма сама
  enqueue('sale', randomUUID(), 'insert', c2.payload(shiftId, 2, { cash: cashPart, card: cardPart }), cashierId);

  // --- отмена позиции (журнал UMAG «100→98») ---
  enqueue('cancelled_item', randomUUID(), 'insert',
    { shiftId, productId: bread, qtyAdded: 3, qtyCancelled: 2, price: 179 }, cashierId);

  // --- закрытие смены ОФЛАЙН: недостача 100 ₸ с комментарием ---
  // наличные: размен 5000 + чек1 (1025) + чек2 нал (1000) + внесение 2000 − изъятие 1000 = 8025
  const expectedCash = 5000 + c1.total + cashPart + 2000 - 1000;
  enqueue('shift', shiftId, 'update',
    { closedAt: new Date().toISOString(), actualCash: expectedCash - 100, comment: 'Не хватает сотки — разбираемся' },
    cashierId);

  // ---------- сеть вернулась: push батчами по 100 ----------
  let accepted = 0;
  for (let i = 0; i < queue.length; i += 100) {
    r = await j('POST', '/sync/push', { events: queue.slice(i, i + 100), pending: queue.length }, true);
    accepted += r.d.accepted;
    const bad = r.d.results.filter((x) => x.result === 'quarantined');
    if (bad.length) console.log('   карантин:', JSON.stringify(bad));
  }
  ok(accepted === queue.length, `★ Все ${queue.length} офлайн-событий приняты (${accepted})`);

  // ---------- сверка на сервере ----------
  r = await j('GET', `/reports/shifts?period=today`);
  const shifts = Array.isArray(r.d) ? r.d : r.d.rows ?? [];
  const sh = shifts.find((s) => s.id === shiftId) ?? shifts[0];
  ok(sh && (sh.status === 'closed' || sh.closed_at), '★ Смена, закрытая офлайн, закрыта и на сервере (новый обработчик)');
  ok(sh && Math.abs(Number(sh.expected_cash ?? 0) - expectedCash) < 0.01,
     `Сервер сам посчитал кассу: ${sh?.expected_cash} = ${expectedCash} (внесения/изъятия учтены)`);
  ok(sh && Math.abs(Number(sh.discrepancy ?? 0) + 100) < 0.01, `Недостача 100 ₸ зафиксирована (${sh?.discrepancy})`);

  r = await j('GET', '/stock/balance?onlyNonZero=true');
  const balMilk = r.d.find((x) => x.product_id === milk);
  const balBread = r.d.find((x) => x.product_id === bread);
  ok(Number(balMilk?.qty) === 95, `Склад молока списан офлайн-чеками: 100−5=${balMilk?.qty}`);
  ok(Number(balBread?.qty) === 99, `Склад хлеба: 100−1=${balBread?.qty}`);

  r = await j('GET', `/reports/dashboard?period=today`);
  const revenue = Number(r.d.revenue);
  ok(Math.abs(revenue - (c1.total + c2.total)) < 0.01,
     `★ Выручка в кабинете совпала с кассой до тенге: ${revenue} = ${r2(c1.total + c2.total)}`);

  // повтор отправки — дубли невозможны
  r = await j('POST', '/sync/push', { events: queue.slice(0, 3) }, true);
  ok(r.d.results.every((x) => x.result === 'duplicate'), 'Повторная отправка после обрыва — только duplicate');

  // ---------- возврат: отрицательный чек, склад возвращается ----------
  const shift2 = randomUUID();
  const q2 = [];
  const enq2 = (entity, entityId, op, payload) =>
    q2.push({ id: randomUUID(), entity, entityId, op, payload, clientSeq: ++clientSeq,
      clientTs: new Date().toISOString(), employeeId: cashierId });
  enq2('shift', shift2, 'insert', { number: 2, openedAt: new Date().toISOString(), openingFloat: 0 });
  enq2('sale', randomUUID(), 'insert', {
    shiftId: shift2, localNumber: 1, refundOf: sale1,
    subtotal: -434, discountSum: 0, rounding: 0, total: -434, costTotal: -320,
    items: [{ productId: milk, qty: -1, price: 434, total: -434, cost: 320 }],
    payment: { cash: -434 },
  });
  r = await j('POST', '/sync/push', { events: q2 }, true);
  ok(r.d.accepted === 2, 'Возврат (отрицательный чек) принят');
  r = await j('GET', '/stock/balance?onlyNonZero=true');
  ok(Number(r.d.find((x) => x.product_id === milk)?.qty) === 96, 'Молоко вернулось на склад: 95+1=96');

  // ---------- права: событие с кассы не может менять чужие сущности ----------
  r = await j('POST', '/sync/push', { events: [{ id: randomUUID(), entity: 'store', entityId: randomUUID(),
    op: 'update', payload: { name: 'Хак' }, clientSeq: ++clientSeq, clientTs: new Date().toISOString() }] }, true);
  ok(r.d.results[0].result === 'quarantined', 'Касса не может править точку — событие в карантине');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
