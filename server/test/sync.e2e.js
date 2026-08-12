/**
 * E2E-тест протокола синхронизации (1.3).
 * Поднимает реальный сервер, две кассы, WebSocket, живой PostgreSQL с RLS.
 * Запуск: node test/sync.e2e.js
 */
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const API = 'http://127.0.0.1:3120';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { console.log(`✔ ${name}`); pass++; } else { console.log(`✘ ${name} ${extra}`); fail++; } };

const call = async (path, opts = {}) => {
  const r = await fetch(API + path, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const phone = () => '+7701' + Math.floor(1000000 + Math.random() * 8999999);
const ev = (o) => ({ id: randomUUID(), clientTs: new Date().toISOString(), payload: {}, ...o });

async function main() {
  // ---------- подготовка: аккаунт, точка, две кассы ----------
  const ph = phone();
  let r = await call('/auth/otp', { body: { phone: ph } });
  r = await call('/auth/register', {
    body: { phone: ph, code: r.data.devCode, businessName: 'Магазин Синх', ownerName: 'Айгуль', password: 'Password123' },
  });
  const auth = { Authorization: `Bearer ${r.data.access}` };
  const accountId = r.data.employee.accountId;

  const db = new Client({ host: 'localhost', user: process.env.PGUSER || 'shop_app', password: process.env.PGPASSWORD || 'change_me_in_prod', database: process.env.PGDATABASE || 'shop_dev' });
  await db.connect();
  const tx = async (fn) => { await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id='${accountId}'`); const x = await fn(); await db.query('COMMIT'); return x; };

  const { storeId, whId, reg1, reg2 } = await tx(async () => {
    const s = (await db.query('SELECT id FROM store LIMIT 1')).rows[0].id;
    const w = (await db.query('SELECT id FROM warehouse LIMIT 1')).rows[0].id;
    const a = (await db.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, s, w])).rows[0].id;
    const b = (await db.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 2') RETURNING id`, [accountId, s, w])).rows[0].id;
    return { storeId: s, whId: w, reg1: a, reg2: b };
  });

  const pair = async (regId) => {
    const c = await call('/auth/devices/pairing-code', { headers: auth, body: { cashRegisterId: regId } });
    const p = await call('/pos/pair', { body: { code: c.data.code, platform: 'windows', appVersion: '1.0.0' } });
    return p.data.deviceToken;
  };
  const tok1 = await pair(reg1), tok2 = await pair(reg2);
  const H1 = { 'X-Device-Token': tok1 }, H2 = { 'X-Device-Token': tok2 };

  // ---------- 1. ПРИЁМ СОБЫТИЯ ----------
  const e1 = ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 1, payload: { name: 'Продавец Алия', phone: '+77015550001' } });
  r = await call('/sync/push', { headers: H1, body: { events: [e1] } });
  ok(r.status === 201 && r.data.results[0].result === 'accepted', 'Событие с кассы принято', JSON.stringify(r.data));
  const seq1 = r.data.results[0].serverSeq;

  const created = await tx(async () => (await db.query('SELECT name FROM consultant WHERE id=$1', [e1.entityId])).rows[0]);
  ok(created?.name === 'Продавец Алия', 'Событие применено к данным, а не просто записано в журнал');

  // ---------- 2. ИДЕМПОТЕНТНОСТЬ ----------
  r = await call('/sync/push', { headers: H1, body: { events: [e1] } });
  ok(r.data.results[0].result === 'duplicate' && r.data.results[0].serverSeq === seq1,
     'Повторная отправка того же события — не дубль (сеть моргнула, клиент переслал)');
  const cnt = await tx(async () => (await db.query('SELECT count(*)::int n FROM consultant WHERE id=$1', [e1.entityId])).rows[0].n);
  ok(cnt === 1, 'В данных по-прежнему одна запись, а не две');

  // ---------- 3. МГНОВЕННОЕ УВЕДОМЛЕНИЕ ДРУГОЙ КАССЕ (главное отличие) ----------
  const ws = new WebSocket(`ws://127.0.0.1:3120/sync/live?deviceToken=${encodeURIComponent(tok2)}`);
  const notes = [];
  await new Promise((res, rej) => {
    ws.on('message', (m) => { const x = JSON.parse(m.toString()); if (x.type === 'ready') res(); else notes.push(x); });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('WS не подключился')), 5000);
  });
  ok(true, 'Касса 2 держит живое соединение с сервером');

  const t0 = Date.now();
  const e2 = ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 2, payload: { name: 'Продавец Ержан' } });
  await call('/sync/push', { headers: H1, body: { events: [e2] } });
  await new Promise((res) => setTimeout(res, 400));
  const dt = Date.now() - t0;
  ok(notes.length === 1 && notes[0].type === 'changes', 'Касса 2 получила уведомление о событии кассы 1', JSON.stringify(notes));
  ok(dt < 1000, `Уведомление дошло за ${dt} мс (у Wipon это ожидание до 15 минут)`);

  // ---------- 4. PULL И ДОКАЧКА С МЕСТА ОБРЫВА ----------
  r = await call('/sync/pull?since=0', { method: 'GET', headers: H2 });
  ok(r.status === 200 && r.data.events.length === 2, 'Касса 2 забрала оба события кассы 1', JSON.stringify(r.data.events?.length));
  const cursor = r.data.cursor;

  r = await call('/sync/pull?since=' + cursor, { method: 'GET', headers: H2 });
  ok(r.data.events.length === 0, 'Повторный запрос с курсора не тянет уже полученное');

  const e3 = ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 3, payload: { name: 'Третий' } });
  await call('/sync/push', { headers: H1, body: { events: [e3] } });
  r = await call('/sync/pull?since=' + cursor, { method: 'GET', headers: H2 });
  ok(r.data.events.length === 1 && r.data.events[0].payload.name === 'Третий',
     'Докачка с места обрыва: пришло только новое, а не всё заново');

  // ---------- 5. СВОИ СОБЫТИЯ НЕ ВОЗВРАЩАЮТСЯ (нет эха) ----------
  r = await call('/sync/pull?since=0', { method: 'GET', headers: H1 });
  ok(r.data.events.length === 0, 'Касса не получает обратно собственные события (без эха)');

  // ---------- 6. ОФЛАЙН: ПАЧКА НАКОПЛЕННЫХ СОБЫТИЙ ----------
  const batch = [];
  for (let i = 0; i < 50; i++)
    batch.push(ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 4 + i, payload: { name: 'Офлайн ' + i } }));
  r = await call('/sync/push', { headers: H1, body: { events: batch, pendingHint: 0 } });
  ok(r.data.accepted === 50, 'Пачка из 50 событий, накопленных офлайн, принята целиком');

  const tooBig = Array.from({ length: 501 }, (_, i) => ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 9000 + i }));
  r = await call('/sync/push', { headers: H1, body: { events: tooBig } });
  ok(r.status === 400, 'Батч больше 500 событий отклонён (защита канала)');

  // ---------- 7. КАРАНТИН: НИЧЕГО НЕ ТЕРЯЕТСЯ ----------
  const bad = ev({ entity: 'unknown_thing', entityId: randomUUID(), op: 'insert', clientSeq: 54 });
  r = await call('/sync/push', { headers: H1, body: { events: [bad] } });
  ok(r.data.results[0].result === 'quarantined', 'Непонятное событие ушло в карантин, а не потерялось');

  const badUpdate = ev({ entity: 'consultant', entityId: randomUUID(), op: 'update', clientSeq: 55, payload: { name: 'Призрак' } });
  r = await call('/sync/push', { headers: H1, body: { events: [badUpdate] } });
  ok(r.data.results[0].result === 'quarantined', 'Правка несуществующей записи — в карантин с причиной');

  r = await call('/admin/sync/quarantine', { method: 'GET', headers: auth });
  ok(r.status === 200 && r.data.length === 2, 'Владелец видит карантин в кабинете', JSON.stringify(r.data?.length));

  // ---------- 8. БЕЛЫЙ СПИСОК: КАССА НЕ МЕНЯЕТ ЧТО ПОПАЛО ----------
  const forbidden = ev({ entity: 'store', entityId: storeId, op: 'update', clientSeq: 56, payload: { name: 'Взлом' } });
  r = await call('/sync/push', { headers: H1, body: { events: [forbidden] } });
  ok(r.data.results[0].result === 'quarantined', 'Касса не может менять настройки точки (белый список сущностей)');
  const storeName = await tx(async () => (await db.query('SELECT name FROM store WHERE id=$1', [storeId])).rows[0].name);
  ok(storeName !== 'Взлом', 'Название точки не изменилось');

  // ---------- 9. КОНФЛИКТ ПРАВОК: ПОСЛЕДНИЙ ПОБЕДИЛ, НО ЗАПИСАНО ----------
  const cid = e1.entityId;
  const base = await tx(async () => Number((await db.query('SELECT seq FROM consultant WHERE id=$1', [cid])).rows[0].seq));
  await call('/sync/push', { headers: H1, body: { events: [ev({ entity: 'consultant', entityId: cid, op: 'update', clientSeq: 57, baseSeq: base, payload: { name: 'Правка с кассы 1' } })] } });
  // касса 2 правит ту же запись, считая, что видела старую версию
  await call('/sync/push', { headers: H2, body: { events: [ev({ entity: 'consultant', entityId: cid, op: 'update', clientSeq: 1, baseSeq: base, payload: { name: 'Правка с кассы 2' } })] } });

  const finalName = await tx(async () => (await db.query('SELECT name FROM consultant WHERE id=$1', [cid])).rows[0].name);
  ok(finalName === 'Правка с кассы 2', 'Последняя правка победила (правило понятное и предсказуемое)');

  r = await call('/admin/sync/conflicts', { method: 'GET', headers: auth });
  ok(r.status === 200 && r.data.length >= 1, 'Конфликт записан в журнал — владелец видит, чья правка перебила чью');

  // ---------- 10. ЧАСЫ КАССЫ ВРУТ ----------
  const skewed = ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 58,
                      clientTs: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), payload: { name: 'Часы врут' } });
  await call('/sync/push', { headers: H1, body: { events: [skewed] } });
  const skew = await tx(async () => (await db.query('SELECT clock_skew_sec FROM oplog WHERE id=$1', [skewed.id])).rows[0].clock_skew_sec);
  ok(skew > 10000, `Расхождение часов кассы зафиксировано (${skew} сек) — порядок берём по серверу, не по кассе`);

  // ---------- 11. ГОТОВНОСТЬ К ИНВЕНТАРИЗАЦИИ (ответ на боль UMAG) ----------
  r = await call('/admin/sync/readiness', { method: 'GET', headers: auth });
  ok(r.status === 200 && r.data.ready === true,
     'Все кассы отдали данные → инвентаризацию проводить можно (события в карантине пропуском не считаются)',
     JSON.stringify(r.data?.message));

  // касса 1 «застряла»: одно событие не доехало (дырка в нумерации)
  await call('/sync/push', { headers: H1, body: { events: [ev({ entity: 'consultant', entityId: randomUUID(), op: 'insert', clientSeq: 60, payload: { name: 'После дырки' } })] } });
  r = await call('/admin/sync/readiness', { method: 'GET', headers: auth });
  ok(r.data.ready === false && /Не все данные/.test(r.data.message),
     'Пропуск в нумерации замечен: система ЗНАЕТ, что данные не все (UMAG в этом месте лишь предупреждает «может быть неточно»)');
  const gapDev = r.data.devices.find((d) => d.hasGaps);
  ok(!!gapDev, 'Видно, какая именно касса не отдала события');

  // ---------- 12. ЧУЖОЙ АККАУНТ ----------
  const ph2 = phone();
  let o2 = await call('/auth/otp', { body: { phone: ph2 } });
  o2 = await call('/auth/register', { body: { phone: ph2, code: o2.data.devCode, businessName: 'Чужой', ownerName: 'Ержан', password: 'Password123' } });
  r = await call('/admin/sync/pull?since=0', { method: 'GET', headers: { Authorization: `Bearer ${o2.data.access}` } });
  ok(r.status === 200 && r.data.events.length === 0, 'Чужой аккаунт не видит наши события (изоляция на уровне БД)');

  ws.close(); await db.end();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
}

const srv = spawn('node', ['dist/main.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: '3120', NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => { const s = d.toString(); if (s.includes('Error') && !s.includes('Nest')) process.stderr.write(s); });

(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(API + '/auth/me'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  try { await main(); } catch (e) { console.error('ОШИБКА ТЕСТА:', e); process.exit(1); }
  finally { srv.kill(); }
})();
