/**
 * E2E-тест номенклатуры (Часть 2).
 * Живой сервер, живой PostgreSQL с RLS. Запуск: node test/goods.e2e.js
 */
const { spawn } = require('child_process');
const { Client } = require('pg');

const API = 'http://127.0.0.1:3160';
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const call = async (p, o = {}) => {
  const r = await fetch(API + p, { method: o.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const phone = () => '+7701' + Math.floor(1000000 + Math.random() * 8999999);

async function main() {
  const ph = phone();
  let r = await call('/auth/otp', { body: { phone: ph } });
  r = await call('/auth/register', { body: { phone: ph, code: r.data.devCode, businessName: 'Магазин Товары', ownerName: 'Айгуль', password: 'Password123' } });
  const auth = { Authorization: `Bearer ${r.data.access}` };
  const accountId = r.data.employee.accountId;

  const db = new Client({ host: 'localhost', user: process.env.PGUSER || 'shop_app', password: process.env.PGPASSWORD || 'change_me_in_prod', database: process.env.PGDATABASE || 'shop_dev' });
  await db.connect();
  const tx = async (fn) => { await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id='${accountId}'`); const x = await fn(); await db.query('COMMIT'); return x; };

  // ---------- 1. КАТЕГОРИЯ С НАЦЕНКОЙ (находка UMAG) ----------
  r = await call('/goods/categories', { headers: auth, body: { name: 'Молочка', nameKk: 'Сүт өнімдері', markupPercent: 25 } });
  ok(r.status === 201 && r.data.id, 'Категория с наценкой 25% создана');
  const catId = r.data.id;

  r = await call('/goods/categories', { headers: auth, body: { name: 'Кефир', parentId: catId } });
  ok(r.status === 201 && r.data.parent_id === catId, 'Подкатегория создана (иерархия любой глубины)');
  const subCatId = r.data.id;

  // ---------- 2. ТОВАР БЕЗ ШТРИХКОДА (у UMAG/Wipon он обязателен) ----------
  r = await call('/goods', { headers: auth, body: { name: 'Носки с барахолки', purchasePrice: 300, categoryId: catId } });
  ok(r.status === 201, 'Товар создан БЕЗ штрихкода (UMAG и Wipon требуют — у носков с барахолки его нет)', JSON.stringify(r.data)?.slice(0, 120));
  const socks = r.data;
  ok(socks.barcodes?.length === 1 && socks.barcodes[0].type === 'internal', 'Внутренний штрихкод сгенерирован сам');
  ok(/^\d{13}$/.test(socks.barcodes[0].code), `Сгенерирован корректный EAN-13: ${socks.barcodes?.[0]?.code}`);

  // проверка контрольной цифры по стандарту
  const bc = socks.barcodes[0].code;
  const digits = bc.split('').map(Number);
  const sum = digits.slice(0, 12).reduce((a, d, i) => a + (i % 2 === 0 ? d : d * 3), 0);
  ok(((10 - (sum % 10)) % 10) === digits[12], 'Контрольная цифра штрихкода верна по стандарту EAN-13 (сканер его примет)');

  // ---------- 3. НАЦЕНКА КАТЕГОРИИ ПОДСТАВИЛАСЬ САМА ----------
  const price = socks.prices?.find((p) => p.code === 'retail');
  ok(price && Number(price.value) === 375, `Цена посчиталась от наценки категории: 300 + 25% = ${price?.value} (для 3000 позиций это недели работы)`);

  r = await call('/goods', { headers: auth, body: { name: 'Кефир 1л', purchasePrice: 400, categoryId: subCatId } });
  const kefirPrice = r.data.prices?.find((p) => p.code === 'retail');
  ok(kefirPrice && Number(kefirPrice.value) === 500, 'Наценка наследуется от родительской категории вверх по дереву');

  r = await call('/goods', { headers: auth, body: { name: 'Особый товар', purchasePrice: 1000, categoryId: catId, markupPercent: 10 } });
  ok(Number(r.data.prices[0].value) === 1100, 'Своя наценка товара важнее категорийной');

  // ---------- 4. ВЕСОВОЙ ТОВАР И ЕГО ШТРИХКОД ----------
  r = await call('/goods', { headers: auth, body: { name: 'Яблоки Апорт', kind: 'weight', purchasePrice: 600, salePrice: 890 } });
  ok(r.status === 201 && r.data.kind === 'weight', 'Весовой товар создан');
  const apples = r.data;
  const appleCode = apples.code;

  const unit = await tx(async () => (await db.query(`SELECT u.short_name FROM product p JOIN unit u ON u.id=p.unit_id WHERE p.id=$1`, [apples.id])).rows[0]);
  ok(unit.short_name === 'кг', 'Весовому товару автоматически проставлена единица «кг»');

  // весы печатают: префикс 20 + код(5) + вес в тысячных(5) + контрольная
  const base = '20' + String(appleCode).padStart(5, '0') + '01500';
  const s = base.split('').map(Number).reduce((a, d, i) => a + (i % 2 === 0 ? d : d * 3), 0);
  const weightBarcode = base + String((10 - (s % 10)) % 10);

  r = await call(`/pos/goods/scan?code=${weightBarcode}`, { method: 'GET', headers: { 'X-Device-Token': 'x' } });
  ok(r.status === 401, 'Касса без токена устройства товары не ищет');

  const scanned = await tx(async () => (await db.query(`SELECT * FROM parse_weight_barcode($1,$2)`, [accountId, weightBarcode])).rows[0]);
  ok(scanned?.product_name === 'Яблоки Апорт', 'Весовой штрихкод с весов распознан: найден товар');
  ok(Number(scanned.qty) === 1.5, `Вес извлечён из штрихкода: ${scanned?.qty} кг — кассир не вбивает его руками`);

  // ---------- 5. КОДЫ НКТ (модель UMAG целиком) ----------
  r = await call('/goods/ntin/stats', { method: 'GET', headers: auth });
  ok(r.data.without_ntin === 4 && r.data.ready === false, `Видно, сколько позиций без кода НКТ: ${r.data?.without_ntin} (клиент узнает не от кассира на кассе)`);

  r = await call('/goods?noNtin=true', { method: 'GET', headers: auth });
  ok(r.data.length === 4, 'Фильтр «код НКТ = нет» показывает, что дозаполнить (как у UMAG)');

  r = await call('/goods/ntin/assign', { headers: auth, body: { productIds: [socks.id, apples.id], ntin: '04870123456789' } });
  ok(r.data.updated === 2, 'Массовое присвоение NTIN двум товарам');

  r = await call('/goods/ntin/assign', { headers: auth, body: { productIds: [socks.id, apples.id], ntin: '04870999999999' } });
  ok(r.data.needConfirm === true && r.data.willOverwrite === 2, `Предупреждение о перезаписи: «${r.data?.message}»`);

  r = await call('/goods/ntin/assign', { headers: auth, body: { productIds: [socks.id, apples.id], ntin: '04870999999999', force: true } });
  ok(r.data.updated === 2, 'После подтверждения коды перезаписаны');

  r = await call('/goods/ntin/category/' + catId, { headers: auth, body: { ntin: '04871111111111' } });
  ok(r.data.updated >= 1, 'Агрегированный код НКТ присвоен всей категории (для товаров без заводского штрихкода)');

  const ntinSrc = await tx(async () => (await db.query(`SELECT ntin_source FROM product WHERE name='Особый товар'`)).rows[0]);
  ok(ntinSrc.ntin_source === 'category_aggregate', 'В карточке записано, что код взят агрегированный — видно происхождение');

  r = await call('/goods/ntin/assign', { headers: auth, body: { productIds: [socks.id], ntin: '123' } });
  ok(r.status === 400, 'Некорректный NTIN отклонён');

  // ---------- 6. ТОВАРНАЯ СЕТКА (мастер UMAG + наследование МС) ----------
  r = await call('/goods', { headers: auth, body: { name: 'Футболка', purchasePrice: 2000, categoryId: catId } });
  const shirt = r.data;
  r = await call(`/goods/${shirt.id}/variants`, { headers: auth,
    body: { attributes: [{ name: 'Размер', values: ['S', 'M', 'L'] }, { name: 'Цвет', values: ['Белый', 'Чёрный'] }] } });
  ok(r.status === 201 && r.data.created === 6, `Товарная сетка: 3 размера × 2 цвета = ${r.data?.created} вариантов`);
  ok(r.data.variants.every((v) => /^\d{13}$/.test(v.barcode)), 'Каждому варианту сгенерирован свой штрихкод');

  const parentKind = await tx(async () => (await db.query(`SELECT kind, track_stock FROM product WHERE id=$1`, [shirt.id])).rows[0]);
  ok(parentKind.kind === 'variant_parent' && parentKind.track_stock === false, 'Родитель стал витриной: остатки считаются по вариантам, а не по нему');

  const inherited = await tx(async () => (await db.query(
    `SELECT p.purchase_price, p.category_id FROM product p WHERE p.parent_id=$1 LIMIT 1`, [shirt.id])).rows[0]);
  ok(Number(inherited.purchase_price) === 2000 && inherited.category_id === catId, 'Вариант унаследовал цену и категорию родителя (модель МС, а не копия как у UMAG)');

  // ---------- 7. КОМПЛЕКТ ----------
  r = await call('/goods', { headers: auth, body: { name: 'Подарочный набор к Наурызу', categoryId: catId } });
  const bundle = r.data;
  r = await call(`/goods/${bundle.id}/bundle`, { headers: auth,
    body: { items: [{ productId: socks.id, qty: 2 }, { productId: kefirId(socks) ?? apples.id, qty: 1 }], extraCost: 200 } });
  ok(r.status === 201 && r.data.components === 2, 'Комплект собран из двух товаров');
  ok(Number(r.data.cost) === 300 * 2 + 600 + 200, `Себестоимость = компоненты + упаковка = ${r.data?.cost} ₸ (доп. расходы — идея UMAG)`);

  r = await call(`/goods/${bundle.id}/bundle`, { headers: auth, body: { items: [{ productId: bundle.id, qty: 1 }] } });
  ok(r.status === 400, 'Комплект не может включать сам себя');

  r = await call(`/goods/${socks.id}/archive`, { headers: auth });
  ok(r.status === 400 && /комплект/.test(r.data.message), 'Товар из комплекта нельзя отправить в архив, пока он в нём состоит');

  // ---------- 8. ПОИСК ----------
  r = await call('/goods?q=' + encodeURIComponent('ябло'), { method: 'GET', headers: auth });
  ok(r.data.length === 1 && r.data[0].name === 'Яблоки Апорт', 'Поиск по части слова: «ябло» → «Яблоки Апорт»');

  r = await call('/goods?q=' + encodeURIComponent(bc), { method: 'GET', headers: auth });
  ok(r.data.length === 1 && r.data[0].id === socks.id, 'Поиск по штрихкоду находит товар');

  r = await call('/goods?q=' + appleCode, { method: 'GET', headers: auth });
  ok(r.data.some((x) => x.id === apples.id), 'Поиск по короткому коду (быстрый ввод на кассе)');

  // ---------- 9. PLU ДЛЯ ВЕСОВ (модель Wipon) ----------
  r = await call('/goods/plu/assign', { headers: auth, body: {} });
  ok(r.data.assigned === 1, 'PLU присвоен весовым товарам');

  r = await call('/goods/plu', { method: 'GET', headers: auth });
  ok(r.data.length === 1 && r.data[0].name === 'Яблоки Апорт' && r.data[0].plu_code, 'Выгрузка PLU для весов: код, наименование, штрихкод, цена');
  ok(Number(r.data[0].price) === 890, 'В выгрузке для весов правильная цена');

  // ---------- 10. МУЛЬТИТЕНАНТНОСТЬ ----------
  const ph2 = phone();
  let o2 = await call('/auth/otp', { body: { phone: ph2 } });
  o2 = await call('/auth/register', { body: { phone: ph2, code: o2.data.devCode, businessName: 'Чужой', ownerName: 'Ержан', password: 'Password123' } });
  r = await call('/goods', { method: 'GET', headers: { Authorization: `Bearer ${o2.data.access}` } });
  ok(r.data.length === 0, 'Чужой аккаунт не видит наши товары');
  r = await call(`/goods/${socks.id}`, { method: 'GET', headers: { Authorization: `Bearer ${o2.data.access}` } });
  ok(r.status === 404, 'Чужой товар не открывается по прямой ссылке');

  await db.end();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
}
function kefirId() { return null; }

const srv = spawn('node', ['dist/main.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: '3160', NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => { const s = d.toString(); if (s.includes('Error') && !s.includes('Nest')) process.stderr.write(s); });
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(API + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 400)); } }
  try { await main(); } catch (e) { console.error('ОШИБКА ТЕСТА:', e); process.exit(1); }
  finally { srv.kill(); }
})();
