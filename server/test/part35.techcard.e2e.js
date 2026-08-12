/**
 * ★ ЧАСТЬ 35 — СОСТАВНОЙ ТОВАР И ТЕХКАРТЫ (мини-общепит).
 *
 * Проверяем:
 *  • набор (kit) — списывается сам (как было, не сломали)
 *  • техкарта (recipe) — при продаже списываются ИНГРЕДИЕНТЫ, не блюдо
 *  • себестоимость блюда = сумма ингредиентов
 *  • выход рецепта: тесто на 10 булочек — продажа 1 булочки списывает 1/10
 */
const { spawn } = require('child_process');

const PORT = '3351';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7709' + Math.floor(1000000 + Math.random() * 8999999);

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

const bal = async (pid) => {
  const r = await j('GET', '/stock/balance?onlyNonZero=false');
  const rows = Array.isArray(r.d) ? r.d : r.d.items ?? [];
  const row = rows.find((x) => (x.product_id ?? x.productId) === pid);
  return row ? Number(row.qty) : 0;
};

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Кофейня Тест', ownerName: 'Айгуль', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  r = await j('GET', '/warehouse/list');
  const whId = (r.d ?? []).find((w) => w.is_primary)?.id ?? r.d[0]?.id;

  // ингредиенты для кофе: зёрна, молоко, стакан
  r = await j('POST', '/goods', { name: 'Кофе зёрна (г)', salePrice: 0, purchasePrice: 5, barcode: '4870030001' });
  const beans = r.d.id;
  r = await j('POST', '/goods', { name: 'Молоко (мл)', salePrice: 0, purchasePrice: 0.3, barcode: '4870030002' });
  const milk = r.d.id;
  r = await j('POST', '/goods', { name: 'Стакан', salePrice: 0, purchasePrice: 15, barcode: '4870030003' });
  const cup = r.d.id;

  // приёмка ингредиентов
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const sd = r.d.id;
  await j('POST', `/stock/docs/${sd}/items`, { productId: beans, qty: 1000, price: 5 });
  await j('POST', `/stock/docs/${sd}/items`, { productId: milk, qty: 5000, price: 0.3 });
  await j('POST', `/stock/docs/${sd}/items`, { productId: cup, qty: 100, price: 15 });
  await j('POST', `/stock/docs/${sd}/process`, {});

  // ---------- ТЕХКАРТА КОФЕ ----------
  // кофе латте: 18г зёрен + 200мл молока + 1 стакан
  r = await j('POST', '/goods', { name: 'Латте', salePrice: 900, purchasePrice: 0, barcode: '4870030100' });
  const latte = r.d.id;
  r = await j('POST', `/goods/${latte}/bundle`, {
    mode: 'recipe', yield: 1,
    items: [{ productId: beans, qty: 18, unit: 'г' }, { productId: milk, qty: 200, unit: 'мл' }, { productId: cup, qty: 1, unit: 'шт' }] });
  ok(r.d.mode === 'recipe', '★ Техкарта латте создана (режим recipe)');
  // себестоимость: 18*5 + 200*0.3 + 1*15 = 90 + 60 + 15 = 165
  ok(Math.abs(r.d.cost - 165) < 0.01, `★ Себестоимость латте = ${r.d.cost} ₸ (зёрна 90 + молоко 60 + стакан 15)`);

  r = await j('GET', `/goods/${latte}/recipe-cost`);
  ok(r.d.components.length === 3 && Math.abs(r.d.cost - 165) < 0.01, 'Расшифровка себестоимости из 3 ингредиентов');

  // ---------- ПРОДАЖА ЛАТТЕ → СПИСАНИЕ ИНГРЕДИЕНТОВ ----------
  const beansBefore = await bal(beans), milkBefore = await bal(milk), cupBefore = await bal(cup), latteBefore = await bal(latte);

  // касса
  r = await j('POST', '/admin/stores/registers', { name: 'Касса' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  const { randomUUID } = require('crypto');
  const sh = randomUUID();
  const ev = []; let seq = 0;
  const enq = (entity, entityId, payload) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });
  // продаём 2 латте
  enq('sale', randomUUID(), { shiftId: sh, localNumber: '1', subtotal: 1800, discountSum: 0, rounding: 0,
    total: 1800, costTotal: 330, items: [{ productId: latte, qty: 2, price: 900, total: 1800, cost: 165 }], payment: { cash: 1800 } });
  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, 'Продажа 2 латте проведена');

  // ингредиенты списались, сам латте — нет
  const beansAfter = await bal(beans), milkAfter = await bal(milk), cupAfter = await bal(cup), latteAfter = await bal(latte);
  ok(beansBefore - beansAfter === 36, `★ Зёрна списаны: ${beansBefore}→${beansAfter} (2 латте × 18г = 36)`);
  ok(milkBefore - milkAfter === 400, `★ Молоко списано: ${milkBefore}→${milkAfter} (2 × 200мл = 400)`);
  ok(cupBefore - cupAfter === 2, `★ Стаканы списаны: ${cupBefore}→${cupAfter} (2 шт)`);
  ok(latteAfter === latteBefore, '★ Сам латте остатка не ведёт (производится на лету)');

  // ---------- ВЫХОД РЕЦЕПТА: тесто на 10 булочек ----------
  r = await j('POST', '/goods', { name: 'Мука (г)', salePrice: 0, purchasePrice: 0.2, barcode: '4870030200' });
  const flour = r.d.id;
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: flour, qty: 10000, price: 0.2 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/goods', { name: 'Булочка', salePrice: 250, purchasePrice: 0, barcode: '4870030201' });
  const bun = r.d.id;
  // рецепт: 1000г муки на 10 булочек (выход 10)
  r = await j('POST', `/goods/${bun}/bundle`, { mode: 'recipe', yield: 10, items: [{ productId: flour, qty: 1000, unit: 'г' }] });
  // себестоимость 1 булочки = 1000*0.2 / 10 = 20
  ok(Math.abs(r.d.cost - 20) < 0.01, `★ Выход рецепта: булочка = ${r.d.cost} ₸ (1000г÷10 булочек × 0.2)`);

  const flourBefore = await bal(flour);
  const ev2 = [];
  const enq2 = (entity, entityId, payload) => ev2.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  // используем уже открытую смену sh (не открываем новую — касса одна)
  enq2('sale', randomUUID(), { shiftId: sh, localNumber: '2', subtotal: 250, discountSum: 0, rounding: 0,
    total: 250, costTotal: 20, items: [{ productId: bun, qty: 1, price: 250, total: 250, cost: 20 }], payment: { cash: 250 } });
  r = await j('POST', '/sync/push', { events: ev2 }, true);
  const bad2 = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad2.length === 0, 'Продажа булочки проведена');
  const flourAfter = await bal(flour);
  ok(flourBefore - flourAfter === 100, `★ 1 булочка списала 100г муки (1000г ÷ выход 10): ${flourBefore}→${flourAfter}`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
