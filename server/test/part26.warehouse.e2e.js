/**
 * ★ ЧАСТЬ 26 — СКЛАД++ (адресное хранение, ТСД, лист отбора).
 *
 * Проверяем механику:
 *  • зоны (лимит 10 как у МоегоСклада), ячейки с адресом и штрихкодом
 *  • размещение товара в ячейке, снятие, защита от минуса
 *  • ТСД: скан ячейки по штрихкоду
 *  • лист отбора строит маршрут по ячейкам (где лежит товар)
 */
const { spawn } = require('child_process');

const PORT = '3261';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7700' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Склад Тест', ownerName: 'Ерлан', password: 'Password123' });
  TOK = r.d.access;

  // склад
  r = await j('GET', '/warehouse/list');
  const whId = (r.d ?? []).find((w) => w.is_primary)?.id ?? r.d[0]?.id;
  ok(!!whId, 'Склад найден');

  // ---------- адресное хранение ----------
  r = await j('POST', `/warehouse/${whId}/bin-enabled`, { enabled: true });
  ok(r.d.ok && r.d.binEnabled, '★ Адресное хранение включено (опционально — по умолчанию было выкл)');

  // зоны
  r = await j('POST', `/warehouse/${whId}/zones`, { name: 'Стеллаж А' });
  const zoneId = r.d.id;
  ok(!!zoneId, 'Зона создана');

  // лимит 10 зон (модель МоегоСклада)
  for (let i = 2; i <= 10; i++) await j('POST', `/warehouse/${whId}/zones`, { name: `Зона ${i}` });
  r = await j('POST', `/warehouse/${whId}/zones`, { name: 'Лишняя' });
  ok(r.status === 400 && /10 зон/.test(r.d.message), '★ 11-я зона отбита (лимит 10 как у МоегоСклада)');

  // ячейки
  r = await j('POST', '/warehouse/cells', { warehouseId: whId, zoneId, address: 'А-01-01', barcode: 'CELL001' });
  const cell1 = r.d.id;
  r = await j('POST', '/warehouse/cells', { warehouseId: whId, zoneId, address: 'А-01-02', barcode: 'CELL002' });
  const cell2 = r.d.id;
  ok(!!cell1 && !!cell2, 'Две ячейки созданы с адресами и штрихкодами');

  r = await j('POST', '/warehouse/cells', { warehouseId: whId, address: 'А-01-01' });
  ok(r.status === 400 && /уже есть/.test(r.d.message), 'Дубль адреса ячейки отбит');

  // ---------- ТСД: скан ячейки по штрихкоду ----------
  r = await j('GET', '/warehouse/cells/by-barcode?barcode=CELL001');
  ok(r.d.address === 'А-01-01' && r.d.zone === 'Стеллаж А', '★ ТСД: скан штрихкода ячейки → адрес и зона');
  r = await j('GET', '/warehouse/cells/by-barcode?barcode=NOPE');
  ok(r.status === 400, 'Неизвестный штрихкод ячейки отбит');

  // ---------- размещение товара в ячейках ----------
  r = await j('POST', '/goods', { name: 'Гвозди 50мм', salePrice: 300, purchasePrice: 180, barcode: '4870009990001' });
  const pid = r.d.id;
  r = await j('POST', '/warehouse/cells/place', { cellId: cell1, productId: pid, qty: 40 });
  ok(r.d.ok && r.d.cellQty === 40, `★ Размещено 40 в ячейку А-01-01 (остаток ячейки ${r.d.cellQty})`);
  r = await j('POST', '/warehouse/cells/place', { cellId: cell2, productId: pid, qty: 25 });
  ok(r.d.cellQty === 25, 'Ещё 25 в А-01-02 (тот же товар в двух ячейках)');

  // снятие
  r = await j('POST', '/warehouse/cells/place', { cellId: cell1, productId: pid, qty: -10 });
  ok(r.d.cellQty === 30, 'Снятие 10 из ячейки: осталось 30');
  // защита от минуса
  r = await j('POST', '/warehouse/cells/place', { cellId: cell1, productId: pid, qty: -999 });
  ok(r.status === 400, '★ Снять больше, чем в ячейке, нельзя');

  // где лежит товар
  r = await j('GET', `/warehouse/product/${pid}/locations`);
  ok(r.d.length === 2 && r.d.reduce((s, x) => s + x.qty, 0) === 55,
     `★ Товар в 2 ячейках, всего 55 (30+25): ${r.d.map((x) => x.address + '=' + x.qty).join(', ')}`);

  // список ячеек с остатками
  r = await j('GET', `/warehouse/${whId}/cells`);
  ok(r.d.length === 2 && r.d.find((x) => x.address === 'А-01-01').total_qty === 30,
     'Список ячеек показывает остатки');

  // ---------- лист отбора ----------
  r = await j('POST', '/warehouse/picking', { warehouseId: whId,
    items: [{ productId: pid, qty: 20 }], comment: 'Сборка на отгрузку' });
  const listId = r.d.id;
  ok(r.d.number?.startsWith('ЛО-'), `★ Лист отбора создан: ${r.d.number}`);

  r = await j('GET', `/warehouse/picking/${listId}`);
  ok(r.d.items.length === 1 && r.d.items[0].cell === 'А-01-01' && r.d.items[0].product.includes('Гвозди'),
     `★ Лист отбора построил маршрут: ${r.d.items[0].product} из ячейки ${r.d.items[0].cell} (макс. остаток)`);

  // отметить собранным
  const itemId = r.d.items[0].id;
  r = await j('POST', `/warehouse/picking/item/${itemId}/picked`, { picked: true });
  ok(r.d.ok, 'Позиция отмечена собранной');

  r = await j('POST', `/warehouse/picking/${listId}/close`, {});
  ok(r.d.ok && r.d.notPicked === 0, '★ Лист отбора закрыт, всё собрано');

  r = await j('GET', '/warehouse/picking');
  // Статус листа отбора теперь «picked» («Собран»), а не «done»: слово
  // «done» в общем словаре значит «Проведён» — верно для складского
  // документа, но не для листа отбора. Из-за этого страница держала свой
  // перевод статусов, а второй перевод всегда разъезжается с первым.
  ok(r.d.length === 1 && r.d[0].picked === 1 && r.d[0].status === 'picked',
     'Список листов: 1 собран');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
