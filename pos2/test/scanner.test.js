/*
 * ПРОВЕРКА СКАНЕРА.
 *
 * Главное: отличить сканер от рук кассира, и разобрать штрихкод весов.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><input id="f"></body>');
global.document = dom.window.document; global.window = dom.window;

const { FAST_MS, MIN_LEN, weighedBarcode, resolveCode, listenScanner } = require('../renderer/scanner.js');
const { findByBarcode } = require('../renderer/goods.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const товары = [
  { id: '1', name: 'Хлеб', price: 250, barcodes: ['4870001234567'] },
  { id: '2', name: 'Сыр весовой', price: 4200, plu: '123', unit: 'кг' },
  { id: '3', name: 'Колбаса весовая', price: 3800, plu: '7', unit: 'кг' },
];

const набор = async (doc, знаки, паузаMs) => {
  for (const k of знаки) {
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    if (паузаMs) await new Promise((r) => setTimeout(r, паузаMs));
  }
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};

console.log('═══ ЭТАП 12 · СКАНЕР ═══\n');

(async () => {

// ── ШТРИХКОД ВЕСОВ ─────────────────────────────────────────────────
{
  const r = weighedBarcode('2200123004500', товары);
  ok(r && r.good && r.good.name === 'Сыр весовой', '★ Весовой код нашёл товар по PLU');
  ok(r.qty === 0.45, `★ И вес пришёл В КОДЕ: ${r.qty} кг — кассир не набирал ничего`);
  ok(r.weighed === true, 'Помечено как весовой: чек покажет «вес»');
}
{
  const r = weighedBarcode('2100007012340', товары);
  ok(r && r.good.name === 'Колбаса весовая' && r.qty === 1.234,
     '★ Другой префикс (21) и PLU с нулями — тоже разобрано');
}
{
  ok(weighedBarcode('2200123000000', товары) === null,
     '★ Ноль граммов — не товар: весы сбились, продавать нечего');
  ok(weighedBarcode('4870001234567', товары) === null,
     'Обычный штрихкод весовым не считаем');
  ok(weighedBarcode('', товары) === null && weighedBarcode(null, товары) === null,
     'Пусто — ничего');
}
{
  const r = weighedBarcode('2200999012340', товары);
  ok(r && r.unknownPlu === '999',
     '★ Товара с таким PLU нет — говорим какой, а не молчим');
  ok(r.qty === 1.234, 'И вес всё равно разобран: владельцу видно, что весы работают');
}

// ── РАЗБОР ЛЮБОГО КОДА ─────────────────────────────────────────────
{
  const r = resolveCode('4870001234567', товары, findByBarcode);
  ok(r.good && r.good.name === 'Хлеб' && r.qty === 1, 'Обычный код: товар и одна штука');
}
{
  const r = resolveCode('2200123004500', товары, findByBarcode);
  ok(r.good.name === 'Сыр весовой' && r.qty === 0.45,
     '★ Весовой разбирается ПЕРВЫМ: в продуктовом он самый частый');
}
{
  ok(resolveCode('123', товары, findByBarcode).tooShort,
     '★ Короткий код — не штрихкод: опечатка или мусор');
  ok(resolveCode('9999999999999', товары, findByBarcode).unknown,
     'Незнакомый код помечен: скажем кассиру, что товара нет');
}

// ── СКАНЕР ПРОТИВ РУК ──────────────────────────────────────────────
console.log('\n═══ СКАНЕР ИЛИ РУКИ ═══\n');
{
  const пришло = [];
  const off = listenScanner(document, { onCode: (c) => пришло.push(c) });

  // Сканер: знаки без пауз
  await набор(document, '4870001234567'.split(''), 0);
  ok(пришло.length === 1 && пришло[0] === '4870001234567',
     '★ Сканер прочитан целиком');

  off();
}
{
  const пришло = [];
  const off = listenScanner(document, { onCode: (c) => пришло.push(c) });

  // Человек: паузы больше 40 мс — набирает количество
  await набор(document, '123'.split(''), 60);
  ok(пришло.length === 0,
     '★ Человек набрал «123» и нажал ввод — за код НЕ приняли');

  off();
}
{
  const пришло = [];
  const off = listenScanner(document, { onCode: (c) => пришло.push(c) });

  // Кассир набрал «12», подумал, потом сканер
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  await набор(document, '4870001234567'.split(''), 0);

  ok(пришло.length === 1 && пришло[0] === '4870001234567',
     '★ Цифры, набранные руками, НЕ склеились с кодом сканера');

  off();
}
{
  const пришло = [];
  const off = listenScanner(document, { onCode: (c) => пришло.push(c) });

  // Буква сбрасывает набор: кассир ищет «хлеб»
  for (const k of ['4', '8', 'х', '7', '0']) {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  }
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(пришло.length === 0, '★ Буква в середине — это поиск, а не код');

  off();
}

// ── ЗАНЯТО: ОКНО ОТКРЫТО ───────────────────────────────────────────
{
  const пришло = [];
  let занято = true;
  const off = listenScanner(document, { onCode: (c) => пришло.push(c), busy: () => занято });

  await набор(document, '4870001234567'.split(''), 0);
  ok(пришло.length === 0, '★ Открыто окно — код не сработал: цифры не полетят в чужое поле');

  занято = false;
  await набор(document, '4870001234567'.split(''), 0);
  ok(пришло.length === 1, 'Окно закрыли — сканер снова работает');

  off();
}

// ── СЛУШАТЕЛЬ СНИМАЕТСЯ ────────────────────────────────────────────
{
  const пришло = [];
  const off = listenScanner(document, { onCode: (c) => пришло.push(c) });
  off();
  await набор(document, '4870001234567'.split(''), 0);
  ok(пришло.length === 0,
     '★ Ушли с экрана — сканер молчит: иначе товар упал бы в закрытый чек');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
