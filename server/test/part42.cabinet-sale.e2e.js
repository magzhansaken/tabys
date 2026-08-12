/**
 * ★ ЭТАП 8 — Продажа из кабинета доведена до конца.
 *
 * Раньше оптовая воронка только меняла ярлык этапа: сделка выглядела
 * отгруженной и оплаченной, а товар лежал на складе и денег не было.
 *
 * Проверяем настоящие движения:
 *  • отгрузка списывает товар со склада;
 *  • не хватает товара — отгрузка не проходит ЦЕЛИКОМ (не частично!);
 *  • оплата частичная и полная, остаток долга считается;
 *  • переплату не принимаем;
 *  • цвет суммы: красный пока долг, зелёный после погашения;
 *  • столбцы UMAG в списке: оплачено, бонусы, кэшбэк, комментарий, кто создал.
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
    businessName: 'Опт Тест', ownerName: 'Ержан', password: 'Password123' });
  TOK = r.d.access;

  r = await j('POST', '/goods', { name: 'Мука 50кг', salePrice: 12000, purchasePrice: 9000, barcode: '4870100001' });
  const flour = r.d.id;

  // на складе 10 мешков
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: flour, qty: 10, price: 9000 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/contragents', { name: 'ТОО Пекарня', roles: ['customer'] });
  const buyer = r.d.id ?? r.d.counterpartyId;

  // ---------- СДЕЛКА НА БОЛЬШЕ, ЧЕМ ЕСТЬ ----------
  r = await j('POST', '/wholesale/orders', { counterpartyId: buyer,
    items: [{ productId: flour, qty: 15, price: 12000, cost: 9000 }], comment: 'Проверка нехватки' });
  const bigOrder = r.d.id;

  const before = await bal(flour);
  r = await j('POST', `/wholesale/orders/${bigOrder}/ship`, {});
  ok(r.status === 400 && /Не хватает товара/.test(r.d?.message ?? ''),
     '★ Нельзя отгрузить больше, чем есть на складе');
  ok(/нужно 15, есть 10/.test(r.d?.message ?? ''), 'Сообщение говорит, чего и сколько не хватает');
  ok(await bal(flour) === before,
     '★ Остаток НЕ изменился: отгрузка отменяется целиком, а не частично');

  // ---------- НОРМАЛЬНАЯ СДЕЛКА ----------
  r = await j('POST', '/wholesale/orders', { counterpartyId: buyer,
    items: [{ productId: flour, qty: 5, price: 12000, cost: 9000 }], comment: 'Отгрузка в пятницу' });
  const order = r.d.id;
  ok(!!order, 'Сделка создана на 5 мешков (60 000 ₸)');

  r = await j('GET', '/wholesale/orders');
  let row = (r.d ?? []).find((x) => x.id === order);
  ok(row?.payStatus === 'red', '★ Пока не оплачено — сумма красная (как у UMAG)');
  ok(row?.comment === 'Отгрузка в пятницу', 'Комментарий виден в списке');
  ok(!!row?.createdBy, `Видно, кто создал сделку: ${row?.createdBy}`);
  ok(row?.shipped === false, 'Отметка отгрузки пока пустая');

  // ---------- ОТГРУЗКА ----------
  r = await j('POST', `/wholesale/orders/${order}/ship`, {});
  ok(r.d?.ok && r.d?.shipped === 1, '★ Сделка отгружена');
  ok(await bal(flour) === before - 5, `★ Товар СПИСАН со склада: было ${before}, стало ${await bal(flour)}`);

  r = await j('POST', `/wholesale/orders/${order}/ship`, {});
  ok(r.status === 400 && /уже отгружена/.test(r.d?.message ?? ''), 'Повторная отгрузка отбита');

  // ---------- ЧАСТИЧНАЯ ОПЛАТА ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 20000, method: 'transfer', comment: 'Аванс' });
  ok(r.d?.paid === 20000 && r.d?.left === 40000,
     `★ Частичная оплата: внесено ${r.d?.paid}, осталось ${r.d?.left}`);
  ok(r.d?.fullyPaid === false && r.d?.payStatus === 'red', 'Долг ещё красный');

  // ---------- ПЕРЕПЛАТА ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 100000 });
  ok(r.status === 400 && /осталось/.test(r.d?.message ?? ''),
     '★ Переплату не принимаем — чаще это опечатка, а не подарок');

  // ---------- ДОПЛАТА ----------
  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 40000, method: 'cash' });
  ok(r.d?.fullyPaid === true && r.d?.left === 0, '★ Сделка оплачена полностью');
  ok(r.d?.payStatus === 'green', '★ Сумма стала зелёной — долг погашен');

  r = await j('POST', `/wholesale/orders/${order}/pay`, { amount: 1000 });
  ok(r.status === 400 && /уже оплачена/.test(r.d?.message ?? ''), 'Оплата закрытой сделки отбита');

  // ---------- ИСТОРИЯ ПЛАТЕЖЕЙ ----------
  r = await j('GET', `/wholesale/orders/${order}/payments`);
  ok(r.d?.length === 2, `★ История платежей: ${r.d?.length} записи (частичная оплата — норма в опте)`);
  ok(r.d?.some((x) => x.comment === 'Аванс'), 'Комментарий к платежу сохранён');

  // ---------- ЭТАП ДВИНУЛСЯ САМ ----------
  r = await j('GET', '/wholesale/orders');
  row = (r.d ?? []).find((x) => x.id === order);
  ok(row?.stage === 'paid', '★ Этап сделки стал «оплачено» сам — ярлык и деньги больше не расходятся');
  ok(row?.paid === 60000 && row?.left === 0, 'В списке видно: оплачено 60 000, долга нет');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
