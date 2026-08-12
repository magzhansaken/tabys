/**
 * ★ ЧАСТЬ 37 — RFM-АНАЛИЗ КЛИЕНТОВ.
 *
 * Проверяем сегментацию по Recency/Frequency/Monetary:
 *  • чемпион (недавно, часто, много) → сегмент «Чемпионы»
 *  • засыпающий (часто, но давно) → «Засыпающие»/«Под угрозой оттока»
 *  • новичок (недавно, 1 покупка) → «Новички»
 *  • сводка по сегментам с рекомендациями
 *  • выборка клиентов сегмента для рассылки
 */
const { spawn } = require('child_process');

const PORT = '3371';
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

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

const { randomUUID } = require('crypto');

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'RFM Тест', ownerName: 'Динара', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // товар и приёмка
  r = await j('POST', '/goods', { name: 'Товар', salePrice: 1000, purchasePrice: 500, barcode: '4870050001' });
  const pid = r.d.id;
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: pid, qty: 1000, price: 500 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  // клиенты
  const champ = (await j('POST', '/contragents', { name: 'Чемпион', roles: ['customer'] })).d;
  const champId = champ.id ?? champ.counterpartyId;
  const sleeper = (await j('POST', '/contragents', { name: 'Засыпающий', roles: ['customer'] })).d;
  const sleeperId = sleeper.id ?? sleeper.counterpartyId;
  const newbie = (await j('POST', '/contragents', { name: 'Новичок', roles: ['customer'] })).d;
  const newbieId = newbie.id ?? newbie.counterpartyId;

  // касса
  r = await j('POST', '/admin/stores/registers', { name: 'Касса' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  // продажи с разными датами через clientTs (влияет на created_at? — sale.created_at ставится сервером,
  // поэтому засыпающего эмулируем прямым SQL после проведения)
  const sh = randomUUID();
  const ev = []; let seq = 0;
  const enq = (entity, entityId, payload, ts) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: ts ?? new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });

  const sale = (cust, total, ln) => enq('sale', randomUUID(), { shiftId: sh, localNumber: String(ln),
    customerId: cust, subtotal: total, discountSum: 0, rounding: 0, total, costTotal: 500,
    items: [{ productId: pid, qty: 1, price: total, total, cost: 500 }], payment: { cash: total } });

  // чемпион: 6 покупок, много
  let ln = 1;
  for (let i = 0; i < 6; i++) sale(champId, 5000, ln++);
  // засыпающий: 5 покупок (частый), но даты сдвинем назад
  for (let i = 0; i < 5; i++) sale(sleeperId, 3000, ln++);
  // новичок: 1 покупка, недавно
  sale(newbieId, 800, ln++);

  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, 'Продажи проведены');

  // засыпающему сдвинем даты продаж на 60 дней назад (низкий Recency).
  // shop_app под RLS — устанавливаем tenant-контекст аккаунта.
  const { Client } = require('pg');
  const pg = new Client({ host: '127.0.0.1', user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE });
  await pg.connect();
  await pg.query(`SELECT set_config('app.account_id', $1, false)`, [me.d.accountId]);
  await pg.query(`UPDATE sale SET created_at = now() - interval '60 days' WHERE customer_id=$1`, [sleeperId]);
  await pg.end();

  // ---------- RFM-АНАЛИЗ ----------
  r = await j('GET', '/rfm');
  ok(r.d.totalCustomers === 3, `★ RFM посчитан для ${r.d.totalCustomers} клиентов`);

  const champRow = r.d.customers.find((x) => x.name === 'Чемпион');
  ok(champRow && champRow.r === 3 && champRow.f === 3, `★ Чемпион: R=${champRow?.r} F=${champRow?.f} M=${champRow?.m} → ${champRow?.segment}`);
  ok(champRow.segment === 'Чемпионы', '★ Чемпион классифицирован верно');

  const sleeperRow = r.d.customers.find((x) => x.name === 'Засыпающий');
  ok(sleeperRow && sleeperRow.r === 1 && sleeperRow.f === 3,
     `★ Засыпающий: R=${sleeperRow?.r} (60 дней) F=${sleeperRow?.f} → ${sleeperRow?.segment}`);
  ok(['Засыпающие', 'Под угрозой оттока'].includes(sleeperRow.segment),
     '★ Засыпающий помечен как отток/засыпающий (низкий Recency, высокая частота)');

  const newbieRow = r.d.customers.find((x) => x.name === 'Новичок');
  ok(newbieRow && newbieRow.r === 3 && newbieRow.f === 1 && newbieRow.segment === 'Новички',
     `★ Новичок: R=${newbieRow?.r} F=${newbieRow?.f} → ${newbieRow?.segment}`);

  // у каждого сегмента есть рекомендация
  ok(r.d.customers.every((c) => c.action && c.action.length > 5), 'У каждого клиента есть рекомендация действия');

  // ---------- СВОДКА ПО СЕГМЕНТАМ ----------
  ok(Array.isArray(r.d.segments) && r.d.segments.length >= 2, `★ Сводка по сегментам: ${r.d.segments.map((s) => s.segment).join(', ')}`);
  const champSeg = r.d.segments.find((s) => s.segment === 'Чемпионы');
  ok(champSeg && champSeg.count === 1 && champSeg.action, 'Сегмент «Чемпионы» со счётчиком и рекомендацией');

  // ---------- ВЫБОРКА СЕГМЕНТА ДЛЯ РАССЫЛКИ ----------
  r = await j('GET', '/rfm/segment?segment=Чемпионы');
  ok(r.d.length === 1 && r.d[0].name === 'Чемпион', '★ Выборка клиентов сегмента «Чемпионы» для рассылки');

  r = await j('GET', '/rfm/segment');
  ok(r.status === 400, 'Запрос сегмента без имени отбит');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
