/**
 * ★ ЭТАП 8 — Продажа из кабинета (модель UMAG, раздел «Продажи»).
 *
 * Полный путь оптовой сделки:
 *  • сделка на контрагента с позициями;
 *  • отгрузка СПИСЫВАЕТ товар (остаток единый с кассой);
 *  • отгрузка не проходит, если товара не хватает — и НИЧЕГО не списывает
 *    частично: половина отгруженной сделки хуже неотгруженной;
 *  • частичная оплата: остаток остаётся долгом, статус красный;
 *  • полная оплата: статус зелёный, этап «оплачено»;
 *  • переплата не принимается (обычно это опечатка);
 *  • КЭШБЭК начисляется от заплаченных денег, а не от суммы сделки.
 */
const { spawn } = require('child_process');

const PORT = '3394';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7708' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
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
    businessName: 'Опт Тест', ownerName: 'Бakyt', password: 'Password123' });
  TOK = r.d.access;

  // бонусная программа — чтобы проверить кэшбэк
  await j('POST', '/loyalty/programs', { name: 'Кэшбэк 3%', kind: 'cashback', earnPercent: 3, spendPercent: 50 });

  r = await j('POST', '/goods', { name: 'Мука мешок', salePrice: 5000, purchasePrice: 3500, barcode: '4870100001' });
  const flour = r.d.id;

  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: flour, qty: 100, price: 3500 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/contragents', { name: 'ТОО Магазин Партнёр', roles: ['customer'], iinBin: '070740008061' });
  const buyer = r.d.id ?? r.d.counterpartyId;

  // ---------- СДЕЛКА ----------
  r = await j('POST', '/wholesale/orders', { counterpartyId: buyer,
    comment: 'Отгрузка по договору, оплата после реализации',
    items: [{ productId: flour, qty: 20, price: 4500 }] });
  const order = r.d.id ?? r.d.orderId;
  ok(!!order, '★ Оптовая сделка создана на контрагента');

  // ---------- ОТГРУЗКА НЕ ПРОХОДИТ, ЕСЛИ ТОВАРА НЕТ ----------
  r = await j('POST', '/wholesale/orders', { counterpartyId: buyer,
    items: [{ productId: flour, qty: 500, price: 4500 }] });
  const bigOrder = r.d.id ?? r.d.orderId;
  const before = await bal(flour);
  r = await j('POST', `/wholesale/orders/${bigOrder}/ship`, {});
  ok(r.status === 400, '★ Отгрузка отбита: товара не хватает');
  ok(await bal(flour) === before, '★ И НИЧЕГО не списалось частично (сделка целиком или никак)');

  // ---------- ОТГРУЗКА ----------
  r = await j('POST', `/wholesale/orders/${order}/ship`, {});
  ok(r.d?.ok, 'Сделка отгружена');
  const after = await bal(flour);
  ok(before - after === 20, `★ Товар списан со склада: ${before} → ${after} (остаток единый с кассой)`);

  // ---------- ЧАСТИЧНАЯ ОПЛАТА ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 40000, method: 'transfer' });
  ok(r.d?.ok && r.d?.left === 50000, `★ Частичная оплата: осталось ${r.d?.left} ₸ долга`);
  ok(r.d?.payStatus === 'red', '★ Статус красный — долг не погашен (цвет как у UMAG)');
  ok(r.d?.cashback === 1200, `★ Кэшбэк от ЗАПЛАЧЕННЫХ 40 000, а не от суммы сделки: ${r.d?.cashback} ₸`);

  // ---------- ПЕРЕПЛАТА НЕ ПРИНИМАЕТСЯ ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 999999 });
  ok(r.status === 400 && /осталось/.test(r.d?.message ?? ''),
     '★ Переплата отбита с подсказкой суммы (чаще это опечатка)');

  // ---------- ДОПЛАТА ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 50000 });
  ok(r.d?.fullyPaid && r.d?.left === 0, 'Сделка оплачена полностью');
  ok(r.d?.payStatus === 'green', '★ Статус зелёный — долг погашен');
  ok(r.d?.cashback === 1500, `Кэшбэк со второй оплаты: ${r.d?.cashback} ₸`);

  // ---------- ИСТОРИЯ И ВОРОНКА ----------
  r = await j('GET', `/wholesale/orders/${order}/payments`);
  ok((r.d ?? []).length === 2, `★ История платежей: ${r.d?.length} записи`);

  r = await j('GET', `/wholesale/orders/${order}`);
  ok(r.d?.stage === 'paid', '★ Этап воронки сам перешёл в «оплачено»');
  ok(Number(r.d?.paid_sum) === 90000, `Оплачено всего: ${r.d?.paid_sum} ₸`);
  ok(Number(r.d?.cashback_sum) === 2700, `★ Кэшбэк накоплен по сделке: ${r.d?.cashback_sum} ₸`);
  ok(r.d?.comment === 'Отгрузка по договору, оплата после реализации', 'Комментарий сохранён');

  // ---------- ПОВТОРНАЯ ОТГРУЗКА ----------
  r = await j('POST', `/wholesale/orders/${order}/ship`, {});
  ok(r.status === 400 && /уже отгружена/.test(r.d?.message ?? ''), 'Повторная отгрузка отбита');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
