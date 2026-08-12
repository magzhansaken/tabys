/**
 * ★ ЧАСТЬ 22 — НАЛОГОВЫЙ БЛОК КАЗАХСТАНА.
 *
 * Проверяем не «страница открылась», а АРИФМЕТИКУ: провели реальные
 * продажи на известную сумму → форма 910.00 посчитала доход и ИПН до
 * тенге по ставке 2026 года. Это то, что у Wipon владелец заполняет
 * руками, а у нас считается из чеков.
 *
 * Ключевые проверки:
 *  • доход = нал + безнал, возврат уменьшает доход (иначе завышение → штраф)
 *  • ИПН = доход × ставка (базовые 4% или ставка маслихата)
 *  • XML валиден и содержит строки 910.00.001 и 910.00.004
 *  • соцплатежи считаются по ставкам года
 */
const { spawn } = require('child_process');

const PORT = '3221';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;
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
    businessName: 'Налоги Тест', ownerName: 'Асель', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // ---------- показатели года ----------
  r = await j('GET', '/taxes/settings');
  ok(r.d.taxRegime === 'simplified', 'Режим по умолчанию — упрощёнка (95% магазинов)');

  // ---------- товар, приёмка, касса, продажи ----------
  r = await j('POST', '/goods', { name: 'Товар А', salePrice: 1000, purchasePrice: 700, barcode: '4870002220001' });
  const pid = r.d.id;
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: pid, qty: 100, price: 700 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/admin/stores/registers', {});
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  const { randomUUID } = require('crypto');
  const sh = randomUUID();
  const ev = [];
  let seq = 0;
  const enq = (entity, entityId, payload) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });

  // 10 продаж по 1000 наличными = 10 000 нал
  for (let i = 0; i < 10; i++)
    enq('sale', randomUUID(), { shiftId: sh, localNumber: `${i + 1}`, subtotal: 1000, discountSum: 0,
      rounding: 0, total: 1000, costTotal: 700,
      items: [{ productId: pid, qty: 1, price: 1000, total: 1000, cost: 700 }], payment: { cash: 1000 } });
  // 5 продаж по 1000 картой = 5 000 безнал
  for (let i = 0; i < 5; i++)
    enq('sale', randomUUID(), { shiftId: sh, localNumber: `c${i + 1}`, subtotal: 1000, discountSum: 0,
      rounding: 0, total: 1000, costTotal: 700,
      items: [{ productId: pid, qty: 1, price: 1000, total: 1000, cost: 700 }], payment: { card: 1000 } });
  // 1 возврат наличными: ссылается на первый чек (refundOf), сервер
  // нормализует и уменьшит доход через return_of_id
  const firstSaleId = ev.find((e) => e.entity === 'sale').entityId;
  enq('sale', randomUUID(), { shiftId: sh, localNumber: 'r1', subtotal: 1000, discountSum: 0,
    rounding: 0, total: 1000, costTotal: 700, refundOf: firstSaleId,
    items: [{ productId: pid, qty: 1, price: 1000, total: 1000, cost: 700 }], payment: { cash: 1000 } });

  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d?.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, `Продажи записаны (${ev.length - 1} чеков + возврат)` + (bad.length ? ' карантин: ' + JSON.stringify(bad[0]) : ''));

  // итог: 10 000 нал − 1000 возврат = 9 000 нал; 5 000 безнал; всего 14 000
  const year = new Date().getFullYear();
  const half = new Date().getMonth() < 6 ? 1 : 2;

  // ---------- регистры ----------
  r = await j('GET', `/taxes/registers?from=${year}-01-01&to=${year}-12-31`);
  ok(near(r.d.salesRegister.cash, 9000), `★ Регистр продаж: наличными 9 000 (10 000 − возврат 1 000) = ${r.d.salesRegister.cash}`);
  ok(near(r.d.salesRegister.noncash, 5000), `★ Регистр продаж: безналичными 5 000 = ${r.d.salesRegister.noncash}`);
  ok(near(r.d.salesRegister.total, 14000), `★ Доход всего 14 000 = ${r.d.salesRegister.total}`);
  ok(near(r.d.purchaseRegister.total, 70000), `Регистр закупок: приёмка 100×700 = ${r.d.purchaseRegister.total}`);

  // ---------- форма 910.00, базовая ставка 4% ----------
  r = await j('GET', `/taxes/declaration/910?year=${year}&half=${half}`);
  ok(r.d.lines['910.00.001'] === 14000, `★ 910.00.001 (доход) = ${r.d.lines['910.00.001']}`);
  ok(r.d.lines['910.00.001_I'] === 9000 && r.d.lines['910.00.001_II'] === 5000,
     `★ Разбивка дохода: нал ${r.d.lines['910.00.001_I']} + безнал ${r.d.lines['910.00.001_II']}`);
  ok(r.d.lines['910.00.004'] === 560, `★ ИПН = 14 000 × 4% = 560 ₸ (ставка 2026) = ${r.d.lines['910.00.004']}`);
  ok(r.d.rate === 0.04, `Базовая ставка упрощёнки 4% = ${r.d.rate}`);
  ok(r.d.params.mzp === 85000 && r.d.params.mrp === 4325, `Показатели 2026: МЗП ${r.d.params.mzp}, МРП ${r.d.params.mrp}`);
  ok(r.d.social.opv === 8500 * 6, `★ ОПВ «за себя» = 8 500 × 6 мес = ${r.d.social.opv} (база 1 МЗП)`);
  ok(r.d.social.vosms === Math.round(85000 * 1.4 * 0.05) * 6, `★ ВОСМС = 5 950 × 6 = ${r.d.social.vosms} (5% от 1.4 МЗП)`);

  // ---------- ставка маслихата 3% ----------
  await j('POST', '/taxes/settings', { ogedCode: '6001', maslikhatIpnRate: 0.03, declaredIncomeMonthly: 85000 });
  r = await j('GET', `/taxes/declaration/910?year=${year}&half=${half}`);
  ok(r.d.lines['910.00.004'] === 420, `★ Ставка маслихата 3%: ИПН = 14 000 × 3% = 420 ₸ = ${r.d.lines['910.00.004']}`);
  r = await j('POST', '/taxes/settings', { maslikhatIpnRate: 0.09 });
  ok(r.status === 400, 'Ставка вне диапазона 2–6% отбита');

  // ---------- XML ----------
  r = await j('GET', `/taxes/declaration/910/xml?year=${year}&half=${half}`);
  ok(r.d.fileName.endsWith('.xml'), `Файл XML: ${r.d.fileName}`);
  const xml = r.d.xml;
  ok(xml.includes('formCode="910.00"') && xml.includes('910.00.001') && xml.includes('910.00.004'),
     '★ XML содержит код формы и ключевые строки — загружается в Кабинет налогоплательщика');
  ok(xml.includes('value="14000"') && xml.includes('value="420"'),
     '★ XML несёт реальные цифры: доход 14000, ИПН 420');
  ok(xml.includes('<?xml'), 'XML корректно оформлен');

  // ---------- сохранение и история ----------
  r = await j('POST', '/taxes/declaration/910', { year, half });
  ok(r.d.id && r.d.lines['910.00.004'] === 420, 'Декларация сохранена в историю');
  r = await j('GET', '/taxes/history');
  ok(r.d.length === 1 && r.d[0].income === 14000 && r.d[0].ipn === 420,
     `История: 1 декларация, доход ${r.d[0].income}, ИПН ${r.d[0].ipn}`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
