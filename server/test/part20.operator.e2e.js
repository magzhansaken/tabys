/**
 * ★ ЧАСТЬ 20 — ОПЕРАТОРСКАЯ АДМИНКА.
 *
 * Путь оператора SaaS: посмотрел метрики (MRR, живые аккаунты, заявки) →
 * нашёл аккаунт → пришёл Kaspi-перевод → продлил на 30 дней с фиксацией
 * платежа (клиент видит его в своём кабинете) → злостного неплательщика
 * заморозил → передумал, разморозил. Всё под ключом, RLS не ослаблена.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = '3200';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
const OPERATOR_KEY = 'op-secret-20';

let TOK = '', DEV = '';
const j = async (method, path, body, opts = {}) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(opts.dev ? { 'X-Device-Token': DEV } : {}),
      ...(opts.op ? { 'x-operator-key': opts.opKey ?? OPERATOR_KEY } : {}),
      ...(!opts.dev && !opts.op && TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test', OPERATOR_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // ---------- без ключа всё закрыто ----------
  let r = await j('GET', '/operator/overview');
  ok(r.status === 403, 'Обзор без ключа — 403 (данные аккаунтов не светятся)');
  r = await j('GET', '/operator/overview', null, { op: true, opKey: 'wrong' });
  ok(r.status === 403, 'Неверный ключ — 403');

  // ---------- живой аккаунт: регистрация + пара чеков ----------
  r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Магазин Оператор-Тест', ownerName: 'Айжан', password: 'Password123' });
  TOK = r.d.access;
  const accountName = 'Магазин Оператор-Тест';
  r = await j('POST', '/goods', { name: 'Вода 0.5', salePrice: 200, purchasePrice: 100 });
  const water = r.d.id;
  r = await j('POST', '/admin/stores/registers', {});
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;
  const me = (await j('GET', '/auth/me')).d;

  const shiftId = randomUUID();
  const events = [
    { id: randomUUID(), entity: 'shift', entityId: shiftId, op: 'insert', clientSeq: 1,
      clientTs: new Date().toISOString(), employeeId: me.employeeId,
      payload: { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 } },
    { id: randomUUID(), entity: 'sale', entityId: randomUUID(), op: 'insert', clientSeq: 2,
      clientTs: new Date().toISOString(), employeeId: me.employeeId,
      payload: { shiftId, localNumber: 1, subtotal: 400, discountSum: 0, rounding: 0,
        total: 400, costTotal: 200,
        items: [{ productId: water, qty: 2, price: 200, total: 400, cost: 100 }],
        payment: { cash: 400 } } },
  ];
  r = await j('POST', '/sync/push', { events }, { dev: true });
  ok(r.d.accepted === 2, 'Аккаунт поторговал: смена + чек уехали');

  // заявка с лендинга — для метрики
  await j('POST', '/public/leads', { name: 'Лид Оператора', phone: '+77029990011' });

  // ---------- обзор ----------
  r = await j('GET', '/operator/overview', null, { op: true });
  const ov = r.d;
  ok(ov.accounts.total >= 1 && ov.accounts.alive7d >= 1,
     `★ Метрики: аккаунтов ${ov.accounts.total}, живых за 7д ${ov.accounts.alive7d}`);
  ok(typeof ov.mrr === 'number' && ov.subscriptions.trials >= 1,
     `MRR ${ov.mrr} ₸, триалов ${ov.subscriptions.trials}`);
  ok(ov.leadsNew >= 1, `Новых заявок: ${ov.leadsNew} — оператор видит очередь на прозвон`);

  // ---------- поиск аккаунта ----------
  r = await j('GET', '/operator/accounts?q=' + encodeURIComponent('Оператор-Тест'), null, { op: true });
  const acc = r.d.items.find((a) => a.name === accountName);
  ok(acc && acc.sub_status === 'trial' && acc.receipts_7d >= 1 && acc.devices >= 1,
     `★ Аккаунт найден: ${acc?.tariff ?? 'триал'}, чеков за 7д ${acc?.receipts_7d}, касс ${acc?.devices}`);

  // ---------- Kaspi-перевод пришёл: продлеваем ----------
  // продление идёт от КОНЦА текущего периода (клиент не теряет остаток
  // триала, заплатив раньше — иначе ранняя оплата наказывала бы)
  const mrrBefore = ov.mrr;
  const base = acc.paid_until ? new Date(acc.paid_until) : new Date();
  const from = base > new Date() ? base : new Date();
  const expected = new Date(from.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  r = await j('POST', `/operator/accounts/${acc.id}/extend`,
    { days: 30, amount: 6900, comment: 'Kaspi-перевод от Айжан' }, { op: true });
  ok(r.d.ok && r.d.status === 'active' && String(r.d.paid_until).slice(0, 10) === expected,
     `★ Продлено на 30 дней ОТ КОНЦА триала (${acc.paid_until ?? 'сегодня'}): оплачено до ${String(r.d.paid_until).slice(0, 10)}`,
     `ждали ${expected}`);

  // клиент видит платёж в СВОЁМ кабинете
  r = await j('GET', '/billing/history');
  ok(r.d.some((m) => m.kind === 'topup' && /Kaspi/.test(m.comment ?? '') && m.amount === 6900),
     '★ Платёж виден клиенту в его истории биллинга (прозрачность ручных продлений)');
  r = await j('GET', '/billing/access');
  ok(r.d.canSell && String(r.d.paidUntil).slice(0, 10) === expected, 'Доступ клиента: торговать можно, дата совпала');

  r = await j('GET', '/operator/overview', null, { op: true });
  ok(r.d.mrr >= mrrBefore, `MRR после активации: ${r.d.mrr} ₸ (триал стал платящим)`);
  ok(r.d.recentPayments.some((p) => p.account_name === accountName && p.amount === 6900),
     'Платёж — в ленте последних поступлений');

  // ---------- заморозка неплательщика ----------
  r = await j('POST', `/operator/accounts/${acc.id}/status`, { status: 'frozen' }, { op: true });
  ok(r.d.status === 'frozen', 'Аккаунт заморожен оператором');
  r = await j('GET', '/billing/access');
  ok(!r.d.canSell && /заморожен/i.test(r.d.reason ?? ''),
     '★ Замороженный аккаунт торговать не может — клиент видит причину');

  r = await j('POST', `/operator/accounts/${acc.id}/status`, { status: 'active' }, { op: true });
  r = await j('GET', '/billing/access');
  ok(r.d.canSell, 'Разморозка вернула доступ');

  r = await j('POST', `/operator/accounts/${acc.id}/status`, { status: 'hacked' }, { op: true });
  ok(r.status >= 400, 'Неизвестный статус отбит');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
