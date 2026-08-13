/**
 * ★ СИГНАЛЫ ДЛЯ ШАПКИ КАБИНЕТА («Важное»).
 *
 * Один ответ вместо шести запросов: шапка живёт на каждой странице, и
 * шесть обращений при каждом переходе заметны — особенно в областях,
 * где связь медленная.
 *
 * Проверяем: сигнал появляется только когда есть на что реагировать,
 * порядок по важности (сначала где теряются деньги), и что пустой
 * магазин не показывает ничего.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = '3397';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7723' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Сигналы Тест', ownerName: 'Магжан', password: 'Password123' });
  TOK = r.d.access;
  const me = (await j('GET', '/auth/me')).d;

  // ---------- ПУСТОЙ МАГАЗИН: ТИШИНА ----------
  r = await j('GET', '/admin/alerts');
  ok(Array.isArray(r.d) && r.d.length === 0,
     '★ На новом магазине сигналов НЕТ — колокол не пугает того, у кого ещё ничего не случилось');

  // ---------- ТОВАР ЗАКОНЧИЛСЯ ----------
  r = await j('POST', '/goods', { name: 'Сахар 1кг', salePrice: 500, purchasePrice: 300,
    barcode: '4870130001', minStock: 20 });
  const sugar = r.d.id;
  r = await j('POST', '/goods', { name: 'Соль 1кг', salePrice: 200, purchasePrice: 100,
    barcode: '4870130002', minStock: 5 });

  r = await j('GET', '/admin/alerts');
  const outOf = (r.d ?? []).find((a) => a.kind === 'out_of_stock');
  ok(outOf && outOf.tone === 'bad',
     `★ Закончившийся товар — красным: «${outOf?.title}»`);
  ok(/теряются/.test(outOf?.sub ?? ''),
     'Подпись объясняет последствие, а не повторяет заголовок');
  ok(outOf?.href === '/stock', 'Ведёт в раздел, где это чинят');

  // ---------- ЗАКАНЧИВАЕТСЯ — ОТДЕЛЬНО ОТ ЗАКОНЧИВШЕГОСЯ ----------
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: sugar, qty: 10, price: 300 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('GET', '/admin/alerts');
  const low = (r.d ?? []).find((a) => a.kind === 'low_stock');
  const out2 = (r.d ?? []).find((a) => a.kind === 'out_of_stock');
  ok(low && low.tone === 'warn',
     `★ «Заканчивается» — жёлтым, отдельно от закончившегося: «${low?.title}»`);
  ok(out2 && !out2.title.includes('2'),
     'Сахар ушёл из «закончилось» — там осталась только соль');

  // ---------- ПОРЯДОК: ДЕНЬГИ ПЕРВЫМИ ----------
  r = await j('GET', '/admin/alerts');
  const kinds = (r.d ?? []).map((a) => a.kind);
  ok(kinds.indexOf('out_of_stock') < kinds.indexOf('low_stock'),
     '★ Порядок по важности: пустая полка выше «пора заказывать»');
  ok((r.d ?? []).every((a) => a.title && a.sub && a.href && a.tone),
     'У каждого сигнала есть всё нужное для показа');

  // ---------- НЕЗАКРЫТАЯ СМЕНА ----------
  // Открытая смена сама по себе норма. Сигнал — только если висит со
  // вчера: продавец ушёл, не закрыв, и выручка не сошлась.
  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'windows', appVersion: '1.6.0' });
  DEV = r.d.deviceToken;

  const shiftId = randomUUID();
  await j('POST', '/sync/push', { events: [{
    id: randomUUID(), entity: 'shift', entityId: shiftId, op: 'insert',
    clientSeq: 1, clientTs: new Date().toISOString(),
    payload: { number: 1, openedAt: new Date().toISOString(), openingFloat: 5000 },
    employeeId: me?.employeeId,
  }] }, true);

  r = await j('GET', '/admin/alerts');
  ok(!(r.d ?? []).some((a) => a.kind === 'shift_open'),
     '★ Открытая смена СЕГОДНЯ — не сигнал: магазин просто работает');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
