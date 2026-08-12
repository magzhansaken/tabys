/**
 * ★ ЧАСТЬ 28 — МОБИЛЬНЫЙ КАБИНЕТ ВЛАДЕЛЬЦА (PWA).
 *
 * Проверяем серверную часть — «живой снимок» для телефона:
 *  • сводка дня (выручка, прибыль, чеки, средний чек)
 *  • открытые смены по точкам (модель МоегоСклада «какие точки открылись»)
 *  • реальные продажи отражаются в снимке
 * PWA-файлы (manifest, sw, иконки) проверяются отдельным скриптом сборки.
 */
const { spawn } = require('child_process');

const PORT = '3281';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7702' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Мобайл Тест', ownerName: 'Тимур', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // пустой снимок — смен нет
  r = await j('GET', '/reports/mobile/snapshot');
  ok(r.d.today && r.d.openShifts.length === 0 && r.d.openStoresCount === 0,
     'Снимок без смен: касс открытых нет');
  ok(r.d.today.revenue === 0 && r.d.today.receipts === 0, 'Сводка дня по нулям на старте');

  // товар, приёмка, касса, смена, продажи
  r = await j('POST', '/goods', { name: 'Вода 1л', salePrice: 200, purchasePrice: 120, barcode: '4870003330001' });
  const pid = r.d.id;
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: pid, qty: 50, price: 120 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;

  const { randomUUID } = require('crypto');
  const sh = randomUUID();
  const ev = []; let seq = 0;
  const enq = (entity, entityId, payload) => ev.push({ id: randomUUID(), entity, entityId, op: 'insert',
    payload, clientSeq: ++seq, clientTs: new Date().toISOString(), employeeId: me.d.employeeId });
  enq('shift', sh, { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });
  // 3 продажи по 200
  for (let i = 0; i < 3; i++)
    enq('sale', randomUUID(), { shiftId: sh, localNumber: `${i + 1}`, subtotal: 200, discountSum: 0,
      rounding: 0, total: 200, costTotal: 120,
      items: [{ productId: pid, qty: 1, price: 200, total: 200, cost: 120 }], payment: { cash: 200 } });
  r = await j('POST', '/sync/push', { events: ev }, true);
  const bad = (r.d.results ?? []).filter((x) => x.result === 'quarantined' || x.result === 'error');
  ok(bad.length === 0, 'Смена открыта и 3 продажи проведены');

  // снимок теперь показывает выручку и открытую точку
  r = await j('GET', '/reports/mobile/snapshot');
  ok(r.d.today.revenue === 600, `★ Снимок: выручка сегодня ${r.d.today.revenue} (3×200)`);
  ok(r.d.today.receipts === 3, `★ Снимок: чеков ${r.d.today.receipts}`);
  ok(r.d.today.profit === 240, `★ Снимок: прибыль ${r.d.today.profit} (3×80)`);
  ok(r.d.openShifts.length === 1, '★ Снимок: 1 открытая смена (владелец видит, кто на кассе)');
  ok(r.d.openStoresCount === 1, `★ Открытых точек: ${r.d.openStoresCount}`);
  const shift = r.d.openShifts[0];
  ok(shift.revenue === 600 && shift.receipts === 3, `Смена в снимке: ${shift.revenue} ₸, ${shift.receipts} чек(а)`);
  ok(!!shift.store && !!shift.register, `Точка и касса названы: ${shift.store} / ${shift.register}`);
  ok(!!shift.openedAt, 'Время открытия смены есть');

  // ---------- МОБИЛЬНЫЙ ЭКРАН ВЛАДЕЛЬЦА: всё одним запросом ----------
  // Дизайнер заметил, что ownerMobile уже отдаёт почти всё нужное, и был
  // прав. Не хватало «что закончилось» — добавлено в ТОТ ЖЕ ответ, а не
  // вторым запросом: в областях связь медленная, два ожидания на телефоне
  // заметны.
  r = await j('GET', '/reports/mobile');
  const mob = r.d;
  ok(!!mob?.today, '★ Мобильный экран: показатели за сегодня');
  ok(mob?.vsYesterday && 'deltaPercent' in mob.vsYesterday,
     `★ Сравнение со вчера: ${mob?.vsYesterday?.deltaPercent}% — цифра без сравнения не говорит ничего`);
  ok(Array.isArray(mob?.week), 'График недели');
  ok(Array.isArray(mob?.topProducts), 'Топ товаров');
  ok(!!mob?.lowStock && Array.isArray(mob.lowStock.items),
     '★ «Что заканчивается» пришло ТЕМ ЖЕ запросом');
  ok(typeof mob?.lowStock?.total === 'number' && typeof mob?.lowStock?.outCount === 'number',
     '★ Видно общее число и сколько закончилось совсем — «что везти сегодня»');
  ok(Array.isArray(mob?.openShifts) && typeof mob?.openStoresCount === 'number',
     '★ Открытые смены вернулись в мобильный: «какие точки открылись» — главная причина лезть в телефон');
  ok(mob.lowStock.items.length <= 5,
     `На телефоне не больше пяти позиций (пришло ${mob.lowStock.items.length}) — список из сорока не читают`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
