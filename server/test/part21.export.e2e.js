/**
 * ★ ЧАСТЬ 21 — ЭКСПОРТ В EXCEL И ФИРМЕННЫЙ СТИЛЬ.
 *
 * Главное, что проверяем — не «файл скачался», а КРУГ: выгрузили
 * номенклатуру → поправили цены в Excel → загрузили обратно нашим же
 * импортом → цены изменились. Такого круга нет ни у одного конкурента
 * (у Wipon экспорт и импорт живут отдельно, отката нет ни у кого).
 *
 * И брендирование: логотип превращается в ESC/POS-растр на СЕРВЕРЕ,
 * уезжает на кассу в bootstrap; порог 500 КБ (модель Wipon) держит базу.
 */
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const { PNG } = require('pngjs');

const PORT = '3211';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7703' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};
const sheet = (base64) => {
  const wb = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
};
/** Рисуем настоящий PNG: чёрный квадрат на белом — растр обязан его увидеть */
const makePng = (w, h) => {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const black = x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.75;
    png.data[i] = png.data[i + 1] = png.data[i + 2] = black ? 0 : 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Экспорт Тест', ownerName: 'Дана', password: 'Password123' });
  TOK = r.d.access;

  // ---------- товары ----------
  r = await j('POST', '/goods', { name: 'Чай Пиала 250г', salePrice: 1190, purchasePrice: 880, barcode: '4870001112223' });
  const teaId = r.d.id;
  r = await j('POST', '/goods', { name: 'Сахар 1кг', salePrice: 500, purchasePrice: 380, barcode: '4870001112230' });
  ok(!!teaId && !!r.d.id, 'Два товара заведены');

  // ---------- экспорт номенклатуры ----------
  r = await j('GET', '/export/goods');
  if (r.status !== 200) console.log('   ОТВЕТ:', r.status, JSON.stringify(r.d).slice(0, 300));
  ok(r.d?.fileName?.endsWith('.xlsx') && r.d.rows === 2, `★ Выгрузка номенклатуры: ${r.d.fileName}, строк ${r.d.rows}`);
  let rows = sheet(r.d.base64);
  const head = rows[0];
  ok(head[0] === 'Наименование' && head.includes('Штрихкод') && head.includes('Код НКТ (NTIN)') && head.includes('Цена'),
     '★ Колонки выгрузки — те же, что понимает наш импорт (круг «выгрузил→правил→загрузил»)');
  const tea = rows.find((x) => String(x[0]).includes('Чай'));
  ok(tea && String(tea[1]).includes('4870001112223') && tea[6] === 1190,
     `Данные на месте: ${tea?.[0]} · ШК ${tea?.[1]} · ${tea?.[6]} ₸`);

  // ---------- КРУГ: правим цену в Excel и грузим обратно ----------
  const iName = 0, iPrice = head.indexOf('Цена');
  rows = rows.map((row, i) => i === 0 ? row : (String(row[iName]).includes('Чай') ? row.map((v, k) => k === iPrice ? 1290 : v) : row));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Номенклатура');
  const back = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64');

  r = await j('POST', '/import/preview', { fileName: 'edit.xlsx', base64: back });
  ok(r.d.totalRows === 2 && r.d.problems.length === 0, 'Правленый файл распознан импортом без проблем');
  r = await j('POST', '/import/run', { sessionId: r.d.sessionId, base64: back });
  ok(r.d.errors === 0, `★ Круг замкнулся: импорт принял свою же выгрузку (обновлено ${r.d.updated ?? 0}, создано ${r.d.created})`);

  r = await j('GET', '/goods?q=' + encodeURIComponent('Чай'));
  const teaNow = (Array.isArray(r.d) ? r.d : [])[0];
  ok(Number(teaNow?.price) === 1290, `★ Цена изменилась через Excel: 1190 → ${teaNow?.price} ₸`);

  // ---------- экспорт остатков и покупателей ----------
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const doc = r.d.id;
  await j('POST', `/stock/docs/${doc}/items`, { productId: teaId, qty: 30, price: 880 });
  await j('POST', `/stock/docs/${doc}/process`, {});
  r = await j('GET', '/export/stock');
  const st = sheet(r.d.base64);
  ok(st[0][0] === 'Наименование' && st.some((x) => Number(x[3]) === 30),
     '★ Выгрузка остатков: печатают и ходят по полкам при инвентаризации');

  await j('POST', '/contragents', { name: 'Азамат', phone: '+77017778899', roles: ['customer'], debtLimit: 5000 });
  r = await j('GET', '/export/customers');
  const cu = sheet(r.d.base64);
  ok(cu.some((x) => x[0] === 'Азамат' && Number(x[3]) === 5000), 'Выгрузка покупателей с лимитом долга');

  // ---------- экспорт отчёта ----------
  const day = new Date().toISOString().slice(0, 10);
  r = await j('GET', `/export/report/sales?from=${day}&to=${day}`);
  ok(r.status === 200 && r.d.fileName.includes('sales'), 'Выгрузка отчёта «Продажи по товарам» отдаётся');
  r = await j('GET', `/export/report/shifts?from=${day}&to=${day}`);
  ok(r.status === 200, 'Выгрузка отчёта по сменам отдаётся');
  r = await j('GET', `/export/report/выдумка?from=${day}&to=${day}`);
  ok(r.status === 400, 'Несуществующий отчёт отбит понятной ошибкой');

  // ---------- брендирование ----------
  const png = makePng(200, 100);
  r = await j('POST', '/branding/logo', { base64: png.toString('base64'), mime: 'image/png', printerWidth: 384 });
  ok(r.d.ok && r.d.receiptLogo.width % 8 === 0,
     `★ Логотип растеризован сервером: ${r.d.receiptLogo.width}×${r.d.receiptLogo.height}, ширина кратна 8 (иначе ESC/POS съезжает)`);
  ok(r.d.receiptLogo.width === 200, 'Картинка уже принтера — не растягиваем (200 < 384)');

  // большой логотип ужимается под ленту 58 мм
  r = await j('POST', '/branding/logo', { base64: makePng(1000, 400).toString('base64'), mime: 'image/png', printerWidth: 384 });
  ok(r.d.receiptLogo.width === 384 && r.d.receiptLogo.height === 154,
     `★ Широкая картинка ужата под 58 мм: 1000×400 → ${r.d.receiptLogo.width}×${r.d.receiptLogo.height} (пропорции целы)`);

  // порог Wipon: 500 КБ
  r = await j('POST', '/branding/logo', { base64: Buffer.alloc(600 * 1024, 1).toString('base64'), mime: 'image/png' });
  ok(r.status === 400 && /500 КБ/.test(r.d.message), 'Файл больше 500 КБ отбит (порог Wipon) — база не раздувается');
  r = await j('POST', '/branding/logo', { base64: Buffer.from('не картинка').toString('base64'), mime: 'image/gif' });
  ok(r.status === 400, 'Не-PNG/JPG отбит');

  r = await j('POST', '/branding/ad-text', { text: 'Спасибо за покупку! Скидка 10% по вторникам' });
  ok(r.d.ok, 'Рекламный текст сохранён (модель Wipon)');
  r = await j('POST', '/branding/ad-text', { text: 'я'.repeat(250) });
  ok(r.status === 400, 'Текст длиннее 200 символов отбит — это чек, а не буклет');

  r = await j('GET', '/branding');
  ok(r.d.logo?.startsWith('data:image/png;base64,') && r.d.hasReceiptLogo && r.d.receiptAdText.includes('Спасибо'),
     'Кабинет видит логотип и текст');

  // ---------- логотип доехал до кассы ----------
  r = await j('POST', '/admin/stores/registers', {});
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;
  r = await j('GET', '/pos/bootstrap', null, true);
  const br = r.d.branding;
  ok(br?.logoRaster && br.logoWidth === 384 && br.adText.includes('Спасибо'),
     '★ Касса получила ГОТОВЫЙ растр и текст — декодер картинок ей не нужен');
  const rasterBytes = Buffer.from(br.logoRaster, 'base64');
  ok(rasterBytes.length === (br.logoWidth / 8) * br.logoHeight,
     `Размер растра сходится: ${br.logoWidth}/8 × ${br.logoHeight} = ${rasterBytes.length} байт`);
  ok(rasterBytes.some((b) => b !== 0), '★ В растре есть чёрные точки — картинка не потерялась при конвертации');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
