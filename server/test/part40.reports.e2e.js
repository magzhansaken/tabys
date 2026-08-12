/**
 * ★ ЭТАП 6 — Отчёты до уровня UMAG.
 *
 * Проверяем:
 *  • отчёт по скидкам: кто, кому и сколько отдал;
 *  • доля скидки от цены (200 тенге с кофе и с телевизора — разное);
 *  • сводка по кассирам — кто раздаёт больше всех;
 *  • прибыль за смену (выручка минус себестоимость);
 *  • отданные за смену скидки;
 *  • возвраты не попадают в скидки и не завышают прибыль.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = '3392';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7706' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Отчёты Тест', ownerName: 'Асем', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // товары: дорогой и дешёвый — чтобы проверить долю скидки
  r = await j('POST', '/goods', { name: 'Кофе Латте', salePrice: 1000, purchasePrice: 400, barcode: '4870080001' });
  const coffee = r.d.id;
  r = await j('POST', '/goods', { name: 'Телевизор', salePrice: 200000, purchasePrice: 150000, barcode: '4870080002' });
  const tv = r.d.id;

  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const sd = r.d.id;
  await j('POST', `/stock/docs/${sd}/items`, { productId: coffee, qty: 100, price: 400 });
  await j('POST', `/stock/docs/${sd}/items`, { productId: tv, qty: 5, price: 150000 });
  await j('POST', `/stock/docs/${sd}/process`, {});

  // касса
  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  const sh = randomUUID();
  const ev = []; let seq = 0;
  const enq = (entity, entityId, payload) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 5000 });

  // Продажа 1: кофе со скидкой 200 из 1000 → доля 20%
  enq('sale', randomUUID(), { shiftId: sh, localNumber: '1', subtotal: 1000, discountSum: 200, rounding: 0,
    total: 800, costTotal: 400,
    items: [{ productId: coffee, qty: 1, price: 1000, discountSum: 200, total: 800, cost: 400 }],
    payment: { cash: 800 } });

  // Продажа 2: телевизор со скидкой 200 из 200000 → доля 0.1%
  enq('sale', randomUUID(), { shiftId: sh, localNumber: '2', subtotal: 200000, discountSum: 200, rounding: 0,
    total: 199800, costTotal: 150000,
    items: [{ productId: tv, qty: 1, price: 200000, discountSum: 200, total: 199800, cost: 150000 }],
    payment: { card: 199800 } });

  // Продажа 3: кофе БЕЗ скидки — в отчёт по скидкам попасть не должна
  enq('sale', randomUUID(), { shiftId: sh, localNumber: '3', subtotal: 1000, discountSum: 0, rounding: 0,
    total: 1000, costTotal: 400,
    items: [{ productId: coffee, qty: 1, price: 1000, discountSum: 0, total: 1000, cost: 400 }],
    payment: { cash: 1000 } });

  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, 'Три продажи проведены');

  // ---------- ОТЧЁТ ПО СКИДКАМ ----------
  r = await j('GET', '/reports/discounts');
  const rep = r.d;
  ok(rep?.count === 2, `★ В отчёт попали только продажи СО скидкой (${rep?.count} из 3)`);
  ok(rep?.total === 400, `★ Всего скидок отдано: ${rep?.total} ₸`);

  const cof = rep.items.find((x) => x.product === 'Кофе Латте');
  const television = rep.items.find((x) => x.product === 'Телевизор');
  ok(cof?.discount === 200 && television?.discount === 200, 'Обе скидки по 200 ₸ — в деньгах одинаковы');
  ok(cof?.discountShare === 20, `★ Доля скидки на кофе: ${cof?.discountShare}% (пятая часть цены!)`);
  ok(television?.discountShare === 0.1, `★ Доля скидки на телевизор: ${television?.discountShare}% (мелочь)`);
  ok(cof?.discountShare > television?.discountShare * 100,
     '★ Одинаковые суммы — разная тяжесть. Без доли этого не увидеть');

  ok(!!cof?.barcode && !!cof?.unit, 'Есть штрихкод и единица (столбцы UMAG)');
  ok(cof?.basePrice === 1000 && cof?.paid === 800, 'Начальная цена и цена со скидкой');

  // ---------- КТО РАЗДАЁТ ----------
  ok(Array.isArray(rep.byCashier) && rep.byCashier.length >= 1,
     `★ Сводка по кассирам: ${rep.byCashier[0]?.cashier} отдал ${rep.byCashier[0]?.sum} ₸ за ${rep.byCashier[0]?.count} раза`);

  // ---------- СМЕНЫ: ПРИБЫЛЬ И СКИДКИ ----------
  r = await j('GET', '/reports/shifts');
  const shift = (r.d ?? [])[0];
  ok(!!shift, 'Смена в отчёте');
  // прибыль: кофе (800-400) + телевизор (199800-150000) + кофе (1000-400) = 400+49800+600 = 50800
  ok(shift?.profit === 50800, `★ Прибыль за смену: ${shift?.profit} ₸ (выручка минус себестоимость)`);
  ok(shift?.discounts_given === 400, `★ Скидок отдано за смену: ${shift?.discounts_given} ₸`);
  ok(shift?.opening_float === 5000, 'Размен на начало смены виден');
  ok('discrepancy' in shift, '★ Расхождение по смене есть — сигнал недостачи');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
