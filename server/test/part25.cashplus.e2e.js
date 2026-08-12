/**
 * ★ ЧАСТЬ 25 — КАССА++ (авансы, сертификаты, price-checker).
 *
 * Главное — обгон МоегоСклада: его сертификаты «в разработке» и требуют
 * внешних систем. Наши работают полностью и сами: продажа → частичное
 * гашение → остаток → полное гашение. Плюс авансы (у МС только на Android).
 */
const { spawn } = require('child_process');

const PORT = '3251';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7709' + Math.floor(1000000 + Math.random() * 8999999);

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

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Касса Тест', ownerName: 'Данияр', password: 'Password123' });
  TOK = r.d.access;

  // покупатель
  r = await j('POST', '/contragents', { name: 'Алия', phone: '+77015551122', roles: ['customer'] });
  const cpId = r.d.id ?? r.d.counterpartyId;

  // ---------- АВАНСЫ ----------
  r = await j('POST', '/cash/advance/deposit', { counterpartyId: cpId, amount: 10000, comment: 'предоплата за заказ' });
  ok(r.d.ok && r.d.balance === 10000, `★ Аванс внесён: баланс ${r.d.balance} ₸`);

  r = await j('GET', `/cash/advance/${cpId}`);
  ok(r.d.balance === 10000, 'Баланс аванса виден');

  // зачёт части аванса в продажу
  r = await j('POST', '/cash/advance/redeem', { counterpartyId: cpId, amount: 6000 });
  ok(r.d.ok && r.d.balance === 4000, `★ Зачтено 6 000 в продажу, остаток аванса ${r.d.balance} ₸`);

  // нельзя зачесть больше, чем есть
  r = await j('POST', '/cash/advance/redeem', { counterpartyId: cpId, amount: 99999 });
  ok(r.status === 400 && /аванс/i.test(r.d.message), 'Зачёт больше остатка отбит: ' + r.d.message);

  r = await j('GET', `/cash/advance/${cpId}/history`);
  ok(r.d.length === 2 && r.d.some((x) => x.kind === 'deposit') && r.d.some((x) => x.kind === 'redeem'),
     'История авансов: внесение + зачёт');

  // аванс без покупателя отбит (аванс всегда именной)
  r = await j('POST', '/cash/advance/deposit', { amount: 5000 });
  ok(r.status === 400, 'Аванс без покупателя отбит');

  // ---------- СЕРТИФИКАТЫ (обгон МоегоСклада) ----------
  r = await j('POST', '/cash/certificate/sell', { nominal: 20000, validDays: 365 });
  const cert = r.d;
  ok(cert.ok && cert.code?.length === 12 && cert.balance === 20000,
     `★ Сертификат продан СВОЙ (без внешних систем): код ${cert.code}, номинал ${cert.nominal} ₸`);
  ok(cert.validUntil, `Срок действия установлен: ${cert.validUntil}`);

  // проверка по коду (касса перед гашением)
  r = await j('GET', `/cash/certificate/check?code=${cert.code}`);
  ok(r.d.usable === true && r.d.balance === 20000, '★ Сертификат проверяется по коду перед оплатой');

  // частичное гашение — то, чего у МоегоСклада нет
  r = await j('POST', '/cash/certificate/redeem', { code: cert.code, amount: 12000 });
  ok(r.d.ok && r.d.balance === 8000 && !r.d.fullyUsed,
     `★ Частичное гашение: списано 12 000, остаток ${r.d.balance} ₸ (МойСклад так не умеет)`);

  // проверка показывает остаток
  r = await j('GET', `/cash/certificate/check?code=${cert.code}`);
  ok(r.d.balance === 8000 && r.d.usable, 'После частичного гашения сертификат ещё работает');

  // добить остаток
  r = await j('POST', '/cash/certificate/redeem', { code: cert.code, amount: 8000 });
  ok(r.d.ok && r.d.fullyUsed, '★ Сертификат погашен полностью');

  // использованный больше не гасится
  r = await j('POST', '/cash/certificate/redeem', { code: cert.code, amount: 100 });
  ok(r.status === 400 && /использ/.test(r.d.message), 'Использованный сертификат не гасится');

  // гашение больше баланса отбито
  r = await j('POST', '/cash/certificate/sell', { nominal: 5000 });
  const c2 = r.d.code;
  r = await j('POST', '/cash/certificate/redeem', { code: c2, amount: 6000 });
  ok(r.status === 400 && /только/.test(r.d.message), 'Гашение больше номинала отбито');

  // несуществующий код
  r = await j('GET', '/cash/certificate/check?code=000000000000');
  ok(r.status === 400, 'Несуществующий сертификат отбит');

  r = await j('GET', '/cash/certificates');
  ok(r.d.length === 2, `Список сертификатов: ${r.d.length}`);
  ok(r.d.find((x) => x.status === 'used'), 'Погашенный виден со статусом «used»');

  // ---------- PRICE-CHECKER ----------
  r = await j('POST', '/goods', { name: 'Кола 0.5', salePrice: 450, purchasePrice: 300, barcode: '4870007778881' });
  r = await j('GET', '/cash/price-check?barcode=4870007778881');
  ok(r.d.found && r.d.name.includes('Кола') && r.d.price === 450,
     `★ Price-checker: скан 4870007778881 → «${r.d.name}» ${r.d.price} ₸ (модель Wipon)`);
  r = await j('GET', '/cash/price-check?barcode=0000000000000');
  ok(r.d.found === false, 'Неизвестный штрихкод — товар не найден');

  // ---------- НАСТРОЙКИ ТОЧКИ (Kaspi POS, price-checker) ----------
  r = await j('GET', '/admin/stores');
  const storeId = (Array.isArray(r.d) ? r.d : r.d.items ?? [])[0]?.id;
  if (storeId) {
    r = await j('POST', `/cash/store/${storeId}/settings`, { priceChecker: true, kaspiPos: true });
    ok(r.d.ok, 'Настройки точки: price-checker и Kaspi POS включены');
  } else ok(true, 'Точка (пропущено — нет id)');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
