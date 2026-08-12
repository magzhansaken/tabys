/**
 * ★ ЧАСТЬ 31 — CRM ДЛЯ ОПТА И ЮНИТ-ЭКОНОМИКА (финал плана 21–31).
 *
 * Проверяем:
 *  • оптовый заказ (сделка) с позициями и суммой
 *  • движение по воронке: новый → согласование → отгрузка → оплата → закрыт
 *  • воронка считает конверсию (закрытые / все)
 *  • юнит-экономика по клиенту: вклад в выручку и прибыль из чеков
 */
const { spawn } = require('child_process');

const PORT = '3311';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7705' + Math.floor(1000000 + Math.random() * 8999999);

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

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Опт Тест', ownerName: 'Аскар', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // оптовый клиент
  r = await j('POST', '/contragents', { name: 'Кафе Достар', roles: ['customer'], iinBin: '990101300101' });
  const cpId = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', `/wholesale/counterparties/${cpId}/wholesale`, { isWholesale: true });
  ok(r.d.ok, 'Клиент помечен оптовым');

  // товары
  r = await j('POST', '/goods', { name: 'Мука 50кг', salePrice: 12000, purchasePrice: 9000, barcode: '4870010001' });
  const p1 = r.d.id;
  r = await j('POST', '/goods', { name: 'Сахар 50кг', salePrice: 18000, purchasePrice: 14000, barcode: '4870010002' });
  const p2 = r.d.id;

  // ---------- ОПТОВЫЙ ЗАКАЗ ----------
  r = await j('POST', '/wholesale/orders', {
    counterpartyId: cpId,
    items: [{ productId: p1, qty: 10, price: 11000, cost: 9000 }, { productId: p2, qty: 5, price: 17000, cost: 14000 }],
    comment: 'Заказ на неделю', expectedDate: '2026-08-01' });
  const orderId = r.d.id;
  // 10*11000 + 5*17000 = 110000 + 85000 = 195000
  ok(r.d.number?.startsWith('ОПТ-') && r.d.total === 195000, `★ Оптовый заказ создан: ${r.d.number} на ${r.d.total} ₸`);
  ok(r.d.stage === 'new', 'Заказ в этапе «Новый»');

  r = await j('GET', `/wholesale/orders/${orderId}`);
  ok(r.d.items.length === 2 && r.d.customer === 'Кафе Достар', 'Позиции и клиент в заказе');

  // ---------- ДВИЖЕНИЕ ПО ВОРОНКЕ ----------
  r = await j('PATCH', `/wholesale/orders/${orderId}/stage`, { stage: 'negotiation' });
  ok(r.d.ok && r.d.stage === 'negotiation', '★ Заказ переведён: Новый → Согласование');
  r = await j('PATCH', `/wholesale/orders/${orderId}/stage`, { stage: 'shipped' });
  r = await j('PATCH', `/wholesale/orders/${orderId}/stage`, { stage: 'paid' });
  r = await j('PATCH', `/wholesale/orders/${orderId}/stage`, { stage: 'closed' });
  ok(r.d.ok && r.d.stage === 'closed', '★ Заказ дошёл до этапа «Закрыт» (успешная сделка)');

  r = await j('PATCH', `/wholesale/orders/${orderId}/stage`, { stage: 'выдумка' });
  ok(r.status === 400, 'Неизвестный этап отбит');

  // второй заказ, который потеряем
  r = await j('POST', '/wholesale/orders', { counterpartyId: cpId,
    items: [{ productId: p1, qty: 2, price: 11000, cost: 9000 }] });
  const order2 = r.d.id;
  await j('PATCH', `/wholesale/orders/${order2}/stage`, { stage: 'negotiation' });
  r = await j('PATCH', `/wholesale/orders/${order2}/stage`, { stage: 'lost' });
  ok(r.d.stage === 'lost', 'Второй заказ потерян');

  // ---------- ВОРОНКА ----------
  r = await j('GET', '/wholesale/funnel');
  ok(Array.isArray(r.d.funnel) && r.d.totalOrders === 2, `★ Воронка: всего сделок ${r.d.totalOrders}`);
  ok(r.d.conversion === 50, `★ Конверсия 50% (1 закрыта из 2): факт ${r.d.conversion}%`);
  ok(r.d.lost.orders === 1, 'В воронке 1 потерянная сделка');

  // список по этапу
  r = await j('GET', '/wholesale/orders?stage=closed');
  ok(r.d.length === 1 && r.d[0].profit === 35000,
     `★ Закрытая сделка с прибылью ${r.d[0]?.profit} ₸ (195000−160000)`);

  // ---------- ЮНИТ-ЭКОНОМИКА ПО КЛИЕНТУ ----------
  // проведём розничные продажи на этого клиента через кассу
  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  // приёмка товара, чтобы было что продавать
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: p1, qty: 100, price: 9000 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  const { randomUUID } = require('crypto');
  const sh = randomUUID();
  const ev = []; let seq = 0;
  const enq = (entity, entityId, payload) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });
  // 2 продажи этому клиенту по 12000 (прибыль 3000 каждая)
  for (let i = 0; i < 2; i++)
    enq('sale', randomUUID(), { shiftId: sh, localNumber: `${i + 1}`, customerId: cpId,
      subtotal: 12000, discountSum: 0, rounding: 0, total: 12000, costTotal: 9000,
      items: [{ productId: p1, qty: 1, price: 12000, total: 12000, cost: 9000 }], payment: { cash: 12000 } });
  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, 'Продажи клиенту проведены');

  r = await j('GET', '/wholesale/customer-economics');
  const eco = r.d.find((x) => x.customerId === cpId);
  ok(eco && eco.receipts === 2 && eco.revenue === 24000,
     `★ Юнит-экономика клиента: ${eco?.receipts} покупки, выручка ${eco?.revenue} ₸`);
  ok(eco.profit === 6000 && eco.avgReceipt === 12000,
     `★ Прибыль от клиента ${eco?.profit} ₸, средний чек ${eco?.avgReceipt} ₸`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
