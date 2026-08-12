/**
 * ★ ЧАСТЬ 33 — AI-ПРИЁМКА НА МАКСИМУМ.
 *
 * Проверяем усиление уникального (чего нет у конкурентов):
 *  • распознавание накладной из фото (mock) → черновик приёмки
 *  • СВЕРКА с заказом поставщику: недовоз, перевоз, не привезли
 *  • КОНТРОЛЬ ЦЕН: подорожание относительно прошлой поставки
 *  • новый товар (нет в каталоге)
 *  • ГОЛОСОВАЯ инвентаризация: «сахар двадцать, мука пятнадцать» → позиции
 */
const { spawn } = require('child_process');

const PORT = '3331';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7707' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test', AI_PROVIDER: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'AI Тест', ownerName: 'Ораз', password: 'Password123' });
  TOK = r.d.access;

  // склад
  r = await j('GET', '/warehouse/list');
  const whId = (r.d ?? []).find((w) => w.is_primary)?.id ?? r.d[0]?.id;

  // товары: mock-накладная содержит «Молоко Айран 1л» 20×300 и «Хлеб бородинский» 30×150
  // создаём молоко и делаем ему прошлую поставку по 250 (чтобы поймать подорожание до 300)
  r = await j('POST', '/goods', { name: 'Молоко Айран 1л', salePrice: 480, purchasePrice: 250, barcode: '4870000000017' });
  const milk = r.d.id;
  // прошлая поставка молока по 250
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: milk, qty: 10, price: 250 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});
  // Хлеб НЕ создаём — он будет «новым товаром» при сверке

  // заказ поставщику: молока заказали 25 (привезут 20 — недовоз)
  r = await j('POST', '/contragents', { name: 'ТОО Караван', roles: ['supplier'], iinBin: '070740008064' });
  const supId = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/contragents/orders', { counterpartyId: supId, warehouseId: whId });
  const orderId = r.d.id ?? r.d.orderId;
  await j('POST', `/contragents/orders/${orderId}/items`, { productId: milk, qty: 25, price: 250 });

  // ---------- РАСПОЗНАВАНИЕ НАКЛАДНОЙ ----------
  r = await j('POST', '/ai/invoice-from-photo', { imageRef: 'nakladnaya.jpg' });
  const taskId = r.d.taskId ?? r.d.id;
  ok(!!taskId, '★ Накладная отправлена на распознавание (задача создана)');

  // обрабатываем очередь (mock распознаёт)
  await j('POST', '/ai/process-queue', {});
  r = await j('GET', '/ai/tasks?kind=invoice_photo');
  const task = (r.d ?? []).find((t) => t.id === taskId) ?? r.d[0];
  ok(task && task.status === 'done', '★ Накладная распознана (mock OCR)');

  // ---------- СВЕРКА С ЗАКАЗОМ + КОНТРОЛЬ ЦЕН ----------
  r = await j('POST', '/ai/check-invoice', { taskId, orderId });
  ok(Array.isArray(r.d.checks), 'Сверка выполнена');

  const priceUp = r.d.checks.find((x) => x.kind === 'price_up' && /Молоко/.test(x.product_name));
  ok(priceUp && priceUp.last_price === 250 && priceUp.invoice_price === 300,
     `★ Контроль цен: подорожание молока 250→300 поймано`);

  const shortfall = r.d.checks.find((x) => x.kind === 'shortfall' && /Молоко/.test(x.product_name));
  ok(shortfall && shortfall.ordered_qty === 25 && shortfall.invoice_qty === 20,
     `★ Сверка с заказом: недовоз молока (заказали 25, привезли 20)`);

  const newProd = r.d.checks.find((x) => x.kind === 'new_product' && /Хлеб/.test(x.product_name));
  ok(newProd, '★ Новый товар: «Хлеб бородинский» нет в каталоге — подсвечен');

  ok(r.d.summary.priceUp >= 1 && r.d.summary.shortfall >= 1 && r.d.summary.newProducts >= 1,
     `Сводка расхождений: подорожаний ${r.d.summary.priceUp}, недовозов ${r.d.summary.shortfall}, новых ${r.d.summary.newProducts}`);

  // ---------- ПРИЁМКА ИЗ ФОТО ----------
  r = await j('POST', '/ai/receive-from-photo', { taskId, warehouseId: whId });
  ok(r.d.created && r.d.status === 'draft', `★ Черновик приёмки создан из фото (${r.d.matched} сопоставлено)`);
  ok(r.d.supplierFound, 'Поставщик найден по БИН');

  // ---------- ГОЛОСОВАЯ ИНВЕНТАРИЗАЦИЯ ----------
  r = await j('POST', '/ai/voice-inventory', { text: 'молоко двадцать, хлеб пятнадцать' });
  const milkRec = r.d.recognized.find((x) => /Молоко/.test(x.product));
  ok(milkRec && milkRec.qty === 20, `★ Голос: «молоко двадцать» → ${milkRec?.product} = ${milkRec?.qty}`);
  ok(r.d.notFound.some((x) => /хлеб/i.test(x.said)), 'Хлеб не в каталоге — в notFound (честно)');

  // цифрами тоже
  r = await j('POST', '/ai/voice-inventory', { text: 'молоко 35' });
  ok(r.d.recognized[0]?.qty === 35, 'Голос цифрами: «молоко 35» → 35');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
