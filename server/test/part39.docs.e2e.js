/**
 * ★ ЭТАП 5 — Документы как у взрослой системы.
 *
 * Проверяем то, чем UMAG отличается в мелочах:
 *  • комментарий у документа виден в списке и по нему можно искать;
 *  • комментарий правится у любого документа, включая проведённый;
 *  • удалённый документ НЕ исчезает: его видно по запросу и можно вернуть;
 *  • вернувшийся документ приходит в черновик, а не проводится сам;
 *  • проведённый документ удалить нельзя (защита остатков).
 */
const { spawn } = require('child_process');

const PORT = '3391';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7705' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Документы Тест', ownerName: 'Данияр', password: 'Password123' });
  TOK = r.d.access;

  r = await j('POST', '/goods', { name: 'Сахар 1кг', salePrice: 500, purchasePrice: 300, barcode: '4870070001' });
  const pid = r.d.id;

  // ---------- КОММЕНТАРИЙ ПРИ СОЗДАНИИ ----------
  r = await j('POST', '/stock/docs', { kind: 'supply', comment: 'Привёз Марат, пересчитать вечером' });
  const doc1 = r.d.id;
  ok(!!doc1, 'Документ создан с комментарием');

  r = await j('GET', '/stock/docs');
  let row = (r.d ?? []).find((x) => x.id === doc1);
  ok(row?.comment === 'Привёз Марат, пересчитать вечером', '★ Комментарий виден в списке документов');

  // ---------- ПОИСК ПО КОММЕНТАРИЮ ----------
  r = await j('GET', '/stock/docs?q=Марат');
  ok((r.d ?? []).some((x) => x.id === doc1), '★ Поиск по комментарию находит документ');

  r = await j('GET', '/stock/docs?q=такого-текста-нет');
  ok(!(r.d ?? []).some((x) => x.id === doc1), 'Поиск по чужому тексту документ не находит');

  // поиск по номеру документа — тем же полем
  r = await j('GET', `/stock/docs?q=${row.number}`);
  ok((r.d ?? []).some((x) => x.id === doc1), 'Тот же поиск находит и по номеру документа');

  // ---------- ПРАВКА КОММЕНТАРИЯ ----------
  r = await j('PATCH', `/stock/docs/${doc1}/comment`, { comment: 'Пересчитали, всё сошлось' });
  ok(r.d?.comment === 'Пересчитали, всё сошлось', '★ Комментарий можно поправить');

  // ---------- УДАЛЕНИЕ МЯГКОЕ ----------
  r = await j('DELETE', `/stock/docs/${doc1}`);
  ok(r.status === 200 || r.status === 201, 'Черновик удалён');

  r = await j('GET', '/stock/docs');
  ok(!(r.d ?? []).some((x) => x.id === doc1), 'Удалённый документ пропал из обычного списка');

  r = await j('GET', '/stock/docs?deleted=true');
  const del = (r.d ?? []).find((x) => x.id === doc1);
  ok(!!del && !!del.deleted_at, '★ Удалённый документ ВИДЕН по запросу и помечен датой удаления');
  ok(del?.comment === 'Пересчитали, всё сошлось', 'У удалённого сохранился комментарий');

  // ---------- ВОССТАНОВЛЕНИЕ ----------
  r = await j('POST', `/stock/docs/${doc1}/restore`, {});
  ok(r.d?.ok, '★ Удалённый документ восстановлен');

  r = await j('GET', '/stock/docs');
  row = (r.d ?? []).find((x) => x.id === doc1);
  ok(!!row, 'Вернулся в обычный список');
  ok(row?.status === 'draft', '★ Вернулся ЧЕРНОВИКОМ — движения сами собой не появились');

  // ---------- ПРОВЕДЁННЫЙ УДАЛИТЬ НЕЛЬЗЯ ----------
  await j('POST', `/stock/docs/${doc1}/items`, { productId: pid, qty: 10, price: 300 });
  r = await j('POST', `/stock/docs/${doc1}/process`, {});
  ok(r.status === 200 || r.status === 201, 'Документ проведён');

  r = await j('DELETE', `/stock/docs/${doc1}`);
  ok(r.status === 400 && /сторно/.test(r.d?.message ?? ''),
     '★ Проведённый удалить нельзя — предлагает сторно (остатки защищены)');

  // комментарий у проведённого — правится (это заметка, а не учёт)
  r = await j('PATCH', `/stock/docs/${doc1}/comment`, { comment: 'Оплачено 12 августа' });
  ok(r.d?.comment === 'Оплачено 12 августа', '★ У проведённого комментарий менять можно');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
