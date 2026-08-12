/**
 * ★ ЧАСТЬ 29 — ОНЛАЙН-ОПЛАТА ПОДПИСКИ.
 *
 * Проверяем flow Kaspi Merchant API (на mock-провайдере):
 *  • создание счёта → pay_url
 *  • webhook «оплачено» с подписью → баланс пополняется
 *  • ИДЕМПОТЕНТНОСТЬ: двойной webhook не задваивает баланс (критично!)
 *  • неверная подпись отбивается
 *  • автопродление выставляет счёт при нехватке баланса
 */
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = '3291';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7703' + Math.floor(1000000 + Math.random() * 8999999);

// mock-провайдер подписывает тело этим секретом (см. payment.provider.ts)
const MOCK_SECRET = 'mock-secret';
const sign = (obj) => crypto.createHmac('sha256', MOCK_SECRET).update(JSON.stringify(obj)).digest('hex');

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
    businessName: 'Биллинг Тест', ownerName: 'Асель', password: 'Password123' });
  TOK = r.d.access;

  // подписка на тариф (чтобы была subscription с price_locked)
  r = await j('GET', '/billing/tariffs');
  const tariff = (r.d ?? []).find((t) => t.code === 'standard') ?? r.d[0];
  await j('POST', '/billing/subscribe', { tariffCode: tariff.code, stores: 1 });

  r = await j('GET', '/billing/access');
  ok(r.d.status, `Подписка активна, статус: ${r.d.status}`);

  // ---------- СОЗДАНИЕ СЧЁТА ----------
  r = await j('POST', '/billing/invoice', { amount: 14900, provider: 'mock', purpose: 'topup' });
  const inv = r.d;
  ok(inv.id && inv.payUrl?.includes('pay.mock') && inv.status === 'pending',
     `★ Счёт создан: ${inv.amount} ₸, ссылка ${inv.payUrl}`);

  r = await j('POST', '/billing/invoice', { amount: -100 });
  ok(r.status === 400, 'Счёт на отрицательную сумму отбит');

  // узнаём external_id счёта (из списка)
  r = await j('GET', '/billing/invoices');
  ok(r.d.length === 1 && r.d[0].status === 'pending', 'Счёт виден в списке как pending');

  // ---------- WEBHOOK ОПЛАТЫ ----------
  // получаем external_id через прямой запрос списка — его нет в ответе, берём из БД через API? 
  // добавим: webhook по external_id. Узнаём его из pay_url (в mock он там).
  const externalId = inv.payUrl.split('/').pop();

  // неверная подпись — отбой
  const wbody = { invoiceId: externalId, status: 'paid' };
  r = await j('POST', `/billing/payment-webhook/mock?signature=badsig`, wbody);
  ok(r.status === 400 && /подпись/.test(r.d.message), '★ Webhook с неверной подписью отбит');

  // верная подпись — баланс пополняется
  const goodSig = sign(wbody);
  r = await j('POST', `/billing/payment-webhook/mock?signature=${goodSig}`, wbody);
  ok(r.d.ok && r.d.applied === true && r.d.balance === 14900,
     `★ Webhook оплаты проведён: баланс ${r.d.balance} ₸`);

  // ---------- ИДЕМПОТЕНТНОСТЬ (двойной webhook) ----------
  r = await j('POST', `/billing/payment-webhook/mock?signature=${goodSig}`, wbody);
  ok(r.d.ok && r.d.applied === false && r.d.balance === 14900,
     '★ Повторный webhook НЕ задвоил баланс (осталось 14 900, не 29 800)');

  // счёт теперь оплачен
  r = await j('GET', '/billing/invoices');
  ok(r.d[0].status === 'paid' && r.d[0].paid_at, 'Счёт помечен оплаченным');

  // ---------- АВТОПРОДЛЕНИЕ ----------
  r = await j('POST', '/billing/auto-renew', { enabled: true });
  ok(r.d.autoRenew === true, 'Автопродление включено');

  // баланс 14900 >= цены standard (14900) — счёт не нужен
  r = await j('POST', '/billing/run-auto-renew', {});
  ok(r.d.renewed === false && r.d.reason === 'balance_enough',
     'Автопродление не выставляет счёт, когда баланса хватает');

  // ---------- АВТОПРОДЛЕНИЕ на свежем аккаунте (trial-баланс 0) ----------
  const phone2 = '+7703' + Math.floor(1000000 + Math.random() * 8999999);
  let r2 = await j('POST', '/auth/otp', { phone: phone2 });
  r2 = await j('POST', '/auth/register', { phone: phone2, code: r2.d.devCode,
    businessName: 'Автопродление Тест', ownerName: 'Мадина', password: 'Password123' });
  const TOK2 = r2.d.access;
  const j2 = async (method, path, body) => {
    const rr = await fetch(API + path, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOK2}` },
      body: body ? JSON.stringify(body) : undefined });
    return { status: rr.status, d: await rr.json().catch(() => null) };
  };
  r = await j2('GET', '/billing/tariffs');
  const t2 = (r.d ?? []).find((t) => t.code === 'start') ?? r.d[0];
  await j2('POST', '/billing/subscribe', { tariffCode: t2.code, stores: 1 });
  await j2('POST', '/billing/auto-renew', { enabled: true });

  // баланс trial = 0, цена > 0 → автопродление выставит счёт
  r = await j2('POST', '/billing/run-auto-renew', {});
  ok(r.d.renewed === true && r.d.amount > 0,
     `★ Автопродление выставило счёт на ${r.d.amount} ₸ при нехватке баланса`);

  // выключение
  await j2('POST', '/billing/auto-renew', { enabled: false });
  r = await j2('POST', '/billing/run-auto-renew', {});
  ok(r.d.renewed === false && r.d.reason === 'auto_renew_off', 'Выключенное автопродление молчит');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
