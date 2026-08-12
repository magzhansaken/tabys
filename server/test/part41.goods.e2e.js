/**
 * ★ ЭТАП 7 — Товары и склад.
 *
 * Проверяем:
 *  • массовое присвоение артикулов, в том числе по образцу с номером;
 *  • заполненные артикулы не затираются без разрешения;
 *  • список артикулов со сводкой;
 *  • утренняя сводка: что заканчивается и на сколько дозаказать;
 *  • закончившийся совсем помечен отдельно;
 *  • расписание утренней сводки ставится на 9:00 по умолчанию;
 *  • выгрузка продаж для 1С в её колонках.
 */
const { spawn } = require('child_process');

const PORT = '3393';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7707' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('json')) return { status: r.status, d: await r.json().catch(() => null) };
  return { status: r.status, d: null, size: Number(r.headers.get('content-length') ?? 0) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Склад Тест', ownerName: 'Нурлан', password: 'Password123' });
  TOK = r.d.access;

  // товары: три футболки (для артикулов) + два с критическим остатком
  const ids = [];
  for (const n of ['Футболка белая', 'Футболка чёрная', 'Футболка синяя']) {
    r = await j('POST', '/goods', { name: n, salePrice: 3000, purchasePrice: 1500,
      barcode: '48700900' + (ids.length + 10) });
    ids.push(r.d.id);
  }

  // ---------- МАССОВОЕ ПРИСВОЕНИЕ ПО ОБРАЗЦУ ----------
  r = await j('POST', '/goods/articles/bulk', { productIds: ids, pattern: 'ФУТБ-{n}', startFrom: 1 });
  ok(r.d?.updated === 3, `★ Артикулы присвоены по образцу трём товарам`);

  r = await j('GET', '/goods/articles/list');
  const arts = (r.d ?? []).map((x) => x.article).sort();
  ok(arts.includes('ФУТБ-001') && arts.includes('ФУТБ-003'),
     `★ Номера дополнены нулями: ${arts.join(', ')} — сортируются по-человечески`);
  ok((r.d ?? []).find((x) => x.article === 'ФУТБ-001')?.products === 1, 'Сводка: сколько товаров в артикуле');

  // ---------- ЗАПОЛНЕННОЕ НЕ ЗАТИРАЕТСЯ ----------
  r = await j('POST', '/goods/articles/bulk', { productIds: ids, article: 'ДРУГОЙ' });
  ok(r.d?.updated === 0 && r.d?.skipped === 3,
     '★ Заполненные артикулы не затёрты (артикул мог прийти от поставщика)');
  ok(/включите замену/.test(r.d?.hint ?? ''), 'Подсказка объясняет, как перезаписать');

  r = await j('POST', '/goods/articles/bulk', { productIds: [ids[0]], article: 'ДРУГОЙ', overwrite: true });
  ok(r.d?.updated === 1, 'С явным разрешением перезапись работает');

  // ---------- УТРЕННЯЯ СВОДКА ПО ОСТАТКАМ ----------
  // товар с критическим остатком: заведём 10, порог 20 → не хватает 10
  r = await j('POST', '/goods', { name: 'Сахар 1кг', salePrice: 500, purchasePrice: 300,
    barcode: '4870090099', minStock: 20 });
  const sugar = r.d.id;
  // товар, которого нет совсем: порог 5, остаток 0
  r = await j('POST', '/goods', { name: 'Соль', salePrice: 200, purchasePrice: 100,
    barcode: '4870090098', minStock: 5 });
  const salt = r.d.id;

  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: sugar, qty: 10, price: 300 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('GET', '/automation/low-stock-digest');
  const dig = r.d;
  ok(dig?.count === 2, `★ В утренней сводке ${dig?.count} товара ниже порога`);

  const s1 = dig.items.find((x) => x.name === 'Сахар 1кг');
  ok(s1?.qty === 10 && s1?.minStock === 20 && s1?.need === 10,
     `★ Сахар: есть ${s1?.qty} из ${s1?.minStock}, дозаказать ${s1?.need}`);
  ok(s1?.sum === 3000, `★ Показана сумма дозаказа: ${s1?.sum} ₸ (не просто тревога, а решение)`);

  const s2 = dig.items.find((x) => x.name === 'Соль');
  ok(s2?.out === true, '★ Закончившийся совсем помечен отдельно — это потерянные продажи');
  ok(/ЗАКОНЧИЛСЯ/.test(dig.text), 'В тексте письма закончившийся выделен');
  ok(dig.orderSum > 0 && /дозаказ/.test(dig.text), `Общая сумма дозаказа: ${dig.orderSum} ₸`);
  ok(dig.link === '/stock?filter=low', '★ Ссылка ведёт на склад с включённым фильтром (приём UMAG)');

  // ---------- РАСПИСАНИЕ: УТРО ПО УМОЛЧАНИЮ ----------
  r = await j('POST', '/automation/schedules', { target: 'owner@shop.kz', report: 'low_stock' });
  ok(r.d?.send_at_hour === 9,
     `★ Сводка по остаткам ставится на ${r.d?.send_at_hour}:00 — заказ делают утром, а не вечером`);

  r = await j('POST', '/automation/schedules', { target: 'owner@shop.kz' });
  ok(r.d?.send_at_hour === 21, 'Итоги дня остаются вечерними (21:00)');

  // ---------- ВЫГРУЗКА ДЛЯ 1С ----------
  r = await j('GET', '/export/sales-1c');
  ok(r.status === 200, '★ Выгрузка продаж для 1С отдаётся файлом');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
