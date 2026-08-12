/**
 * ★ ЧАСТЬ 32 — ИНТЕГРАЦИЯ С МАРКЕТПЛЕЙСОМ (Kaspi Магазин).
 *
 * Полный цикл на mock-провайдере:
 *  • подключение к маркетплейсу
 *  • маппинг товара ↔ SKU
 *  • выгрузка цен и остатков (только то, что в наличии)
 *  • приём заказа с маркетплейса (pull), сопоставление позиций
 *  • принять → завершить → СПИСАНИЕ со склада (единый остаток)
 *  • защита: незамапленную позицию нельзя отгрузить
 *  • идемпотентность: повторный pull не задваивает заказ
 */
const { spawn } = require('child_process');

const PORT = '3321';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7706' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Маркетплейс Тест', ownerName: 'Дана', password: 'Password123' });
  TOK = r.d.access;

  // ---------- ПОДКЛЮЧЕНИЕ ----------
  r = await j('POST', '/marketplace/connect', { provider: 'mock', merchantId: 'M-123', authToken: 'tok', autoAccept: false });
  ok(r.d.enabled && r.d.provider === 'mock', '★ Маркетплейс подключён');

  r = await j('GET', '/marketplace/connection?provider=mock');
  ok(r.d.merchant_id === 'M-123', 'Настройки подключения читаются');

  // ---------- ТОВАРЫ + МАППИНГ ----------
  r = await j('POST', '/goods', { name: 'Наушники', salePrice: 9900, purchasePrice: 6000, barcode: '4870020001' });
  const p1 = r.d.id;
  r = await j('POST', '/goods', { name: 'Чехол', salePrice: 2500, purchasePrice: 1200, barcode: '4870020002' });
  const p2 = r.d.id;

  // приёмка на склад (чтобы был остаток)
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: p1, qty: 20, price: 6000 });
  await j('POST', `/stock/docs/${r.d.id}/items`, { productId: p2, qty: 50, price: 1200 });
  await j('POST', `/stock/docs/${r.d.id}/process`, {});

  r = await j('POST', '/marketplace/listings', { provider: 'mock', productId: p1, sku: 'KASPI-SKU-100' });
  ok(r.d.sku === 'KASPI-SKU-100', '★ Товар сопоставлен с SKU маркетплейса');
  await j('POST', '/marketplace/listings', { provider: 'mock', productId: p2, sku: 'KASPI-SKU-200' });

  r = await j('POST', '/marketplace/listings', { provider: 'mock', productId: p1, sku: 'KASPI-SKU-100' });
  ok(r.status === 400, 'Повторный SKU отбит');

  // ---------- ВЫГРУЗКА ЦЕН И ОСТАТКОВ ----------
  r = await j('POST', '/marketplace/push-prices', { provider: 'mock' });
  ok(r.d.ok && r.d.pushed === 2, `★ Выгружено 2 позиции (цены+остатки)`);

  r = await j('GET', '/marketplace/listings?provider=mock');
  const l1 = r.d.find((x) => x.sku === 'KASPI-SKU-100');
  ok(l1.last_qty === 20 && l1.last_price === 9900, `Выгружены остаток 20 и цена 9900`);

  // ---------- ЗАКАЗ С МАРКЕТПЛЕЙСА ----------
  // засеваем заказ в mock-очередь
  await j('POST', '/marketplace/_mock-seed-order', {
    externalId: 'ORD-555', code: '555', state: 'new', status: 'approved_by_bank',
    customerName: 'Айбек', customerPhone: '77011112233', deliveryMode: 'pickup', totalPrice: 12400,
    items: [{ sku: 'KASPI-SKU-100', name: 'Наушники', qty: 1, price: 9900 },
            { sku: 'KASPI-SKU-200', name: 'Чехол', qty: 1, price: 2500 }] });

  r = await j('POST', '/marketplace/pull-orders', { provider: 'mock' });
  ok(r.d.saved === 1, `★ Заказ забран с маркетплейса (получено ${r.d.fetched}, сохранено ${r.d.saved})`);

  // идемпотентность
  r = await j('POST', '/marketplace/pull-orders', { provider: 'mock' });
  ok(r.d.saved === 0, '★ Повторный pull не задвоил заказ (идемпотентность)');

  r = await j('GET', '/marketplace/orders?provider=mock');
  const orderId = r.d[0].id;
  ok(r.d.length === 1 && r.d[0].customer_name === 'Айбек', 'Заказ виден в списке');

  r = await j('GET', `/marketplace/orders/${orderId}`);
  ok(r.d.items.length === 2 && r.d.unmatchedCount === 0, '★ Позиции сопоставлены с товарами (нераспознанных нет)');

  // ---------- ПРИНЯТЬ → ЗАВЕРШИТЬ → СПИСАНИЕ ----------
  // нельзя завершить до принятия
  r = await j('POST', `/marketplace/orders/${orderId}/complete`, { provider: 'mock' });
  ok(r.status === 400 && /примите заказ/.test(r.d.message), 'Нельзя завершить непринятый заказ');

  r = await j('POST', `/marketplace/orders/${orderId}/accept`, { provider: 'mock' });
  ok(r.d.ok, '★ Заказ принят (ACCEPTED_BY_MERCHANT)');

  // проверим остаток ДО завершения
  r = await j('GET', '/stock/balance?onlyNonZero=false');
  const before = (Array.isArray(r.d) ? r.d : r.d.items ?? []).find((x) => x.product_id === p1 || x.productId === p1);

  r = await j('POST', `/marketplace/orders/${orderId}/complete`, { provider: 'mock' });
  ok(r.d.ok && r.d.itemsShipped === 2, '★ Заказ завершён, товар отгружен');

  // остаток наушников уменьшился с 20 до 19
  r = await j('GET', '/stock/balance?onlyNonZero=false');
  const after = (Array.isArray(r.d) ? r.d : r.d.items ?? []).find((x) => (x.product_id ?? x.productId) === p1);
  ok(after && Number(after.qty) === 19, `★ Единый остаток: списано со склада (наушников осталось ${after?.qty}, было 20)`);

  // ---------- ЖУРНАЛ ----------
  r = await j('GET', '/marketplace/sync-log?provider=mock');
  ok(r.d.some((x) => x.kind === 'price_push') && r.d.some((x) => x.kind === 'orders_pull'),
     '★ Журнал синхронизации: выгрузка цен + заказы');

  // ---------- защита незамапленной позиции ----------
  await j('POST', '/marketplace/_mock-seed-order', {
    externalId: 'ORD-777', code: '777', state: 'new', status: 'approved_by_bank',
    customerName: 'Ер', deliveryMode: 'pickup', totalPrice: 5000,
    items: [{ sku: 'UNKNOWN-SKU', name: 'Неизвестный', qty: 1, price: 5000 }] });
  await j('POST', '/marketplace/pull-orders', { provider: 'mock' });
  r = await j('GET', '/marketplace/orders?provider=mock&state=new');
  const badOrder = r.d.find((x) => x.code === '777');
  await j('POST', `/marketplace/orders/${badOrder.id}/accept`, { provider: 'mock' });
  r = await j('POST', `/marketplace/orders/${badOrder.id}/complete`, { provider: 'mock' });
  ok(r.status === 400 && /не сопоставлен/.test(r.d.message), '★ Незамапленную позицию нельзя отгрузить (защита от ошибок остатка)');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
