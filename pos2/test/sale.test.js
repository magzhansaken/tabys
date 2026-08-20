/*
 * ПРОВЕРКА ЭКРАНА ПРОДАЖИ.
 *
 * Щелчки: вкладки, поиск, выбор товара.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
global.document = dom.window.document; global.window = dom.window;

const { buildSale } = require('../renderer/screen-sale.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };
const root = document.getElementById('app');

const товары = [
  { id: '1', name: 'Хлеб «Тандыр»', price: 250, category: 'Хлеб', quick: true, barcodes: ['4870001'] },
  { id: '2', name: 'Молоко Айналайын 2.5%', price: 420, category: 'Молочное', quick: true },
  { id: '3', name: 'Сигареты Winston', price: 800, category: 'Табак', marked: true },
  { id: '4', name: 'Отруби хлебные', price: 480, category: 'Бакалея' },
];

const набрать = (t) => {
  const f = root.querySelector('#saleSearch');
  f.value = t;
  f.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const плитки = () => [...root.querySelectorAll('.good .good-name')].map((e) => e.textContent);

console.log('═══ ЭКРАН ПРОДАЖИ ═══\n');

// ── СОБИРАЕТСЯ САМ ─────────────────────────────────────────────────
{
  buildSale(root, {}, { goods: товары, onPick: () => {} });
  ok(root.querySelector('#saleSearch'), 'Поле поиска на месте');
  ok(root.querySelectorAll('#saleTabs button').length === 5,
     `Вкладок: ${root.querySelectorAll('#saleTabs button').length}`);
  ok(root.querySelectorAll('.good').length === 2,
     '★ Открылось «Ходовое»: два товара, а не весь каталог');
}

// ── И СОБИРАЕТСЯ КАЖДЫЙ РАЗ ────────────────────────────────────────
{
  root.innerHTML = '<p>другой экран</p>';
  buildSale(root, {}, { goods: товары, onPick: () => {} });
  ok(root.querySelectorAll('#saleTabs button').length === 5,
     '★ Вернулись на продажу — вкладки собрались снова');
}

// ── ВКЛАДКИ ────────────────────────────────────────────────────────
{
  const таб = (n) => [...root.querySelectorAll('#saleTabs button')].find((b) => b.textContent === n);
  таб('Табак').click();
  ok(плитки().length === 1 && /Winston/.test(плитки()[0]), 'Вкладка «Табак» — только табак');
  ok(таб('Табак').className.includes('on'), 'И она подсвечена: видно, где стоим');
}

// ── ПОИСК СКВОЗНОЙ ─────────────────────────────────────────────────
{
  // Стоим на «Табак» — ищем молоко
  набрать('молоко');
  ok(плитки().length === 1 && /Молоко/.test(плитки()[0]),
     '★ Поиск нашёл молоко, хотя стоим на «Табак»');
}

// ── СМЕНА ВКЛАДКИ ЧИСТИТ ПОИСК ─────────────────────────────────────
{
  const таб = (n) => [...root.querySelectorAll('#saleTabs button')].find((b) => b.textContent === n);
  таб('Хлеб').click();
  ok(root.querySelector('#saleSearch').value === '',
     '★ Сменил вкладку — поиск очистился: иначе кассир решит, что касса сломалась');
  ok(плитки().length === 1 && /Хлеб «Тандыр»/.test(плитки()[0]), 'И показан хлеб');
}

// ── ВЫБОР ТОВАРА ЧИСТИТ ПОИСК ──────────────────────────────────────
{
  let взят = null;
  buildSale(root, {}, { goods: товары, onPick: (g) => { взят = g; } });
  набрать('хле');
  ok(плитки().length === 2, 'Нашлись хлеб и отруби');
  root.querySelector('.good').click();
  ok(взят && взят.id === '1', `★ Выбран «${взят.name}» — с начала выше`);
  ok(root.querySelector('#saleSearch').value === '',
     '★ Поиск очистился: следующий товар ищем с чистого места');
}

// ── ПУСТО ОБЪЯСНЯЕТ СЕБЯ ───────────────────────────────────────────
{
  набрать('квашеная капуста');
  const t = root.querySelector('.empty');
  ok(t && /Ничего не нашлось/.test(t.textContent),
     '★ Ничего не нашлось — сказано словами, а не пустое место');
  ok(/отсканируйте штрихкод/.test(t.textContent),
     'И подсказано, что делать дальше');
}

// ── КРЕСТИК ЧИСТИТ ─────────────────────────────────────────────────
{
  набрать('молоко');
  ok(!root.querySelector('#saleClear').classList.contains('hidden'),
     'Крестик появился при наборе');
  root.querySelector('#saleClear').click();
  ok(root.querySelector('#saleSearch').value === '' && плитки().length === 2,
     '★ Крестик очистил и вернул вкладку');
}

// ── МАРКИРОВКА ВИДНА СРАЗУ ─────────────────────────────────────────
{
  const таб = (n) => [...root.querySelectorAll('#saleTabs button')].find((b) => b.textContent === n);
  таб('Табак').click();
  ok(root.querySelector('.good-mark'),
     '★ У товара с маркой это видно на плитке: кассир готовит сканер заранее');
}

// ── ОГРОМНЫЙ КАТАЛОГ НЕ ВЕШАЕТ ЭКРАН ───────────────────────────────
{
  const много = [];
  for (let i = 0; i < 5000; i += 1) много.push({ id: String(i), name: `Товар ${i}`, price: 100 });
  const t = Date.now();
  buildSale(root, {}, { goods: много, onPick: () => {} });
  const ms = Date.now() - t;
  ok(root.querySelectorAll('.good').length === 200,
     '★ Показано 200 плиток, а не 5000: экран не вешается');
  ok(ms < 1000, `И собралось за ${ms} мс`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
