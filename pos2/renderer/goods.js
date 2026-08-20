/*
 * КАТАЛОГ ТОВАРОВ: вкладки, поиск, ходовое.
 *
 * УСТРОЙСТВО ПЛОСКОЕ, а не вглубь.
 *
 * У донора касса ходит вглубь: дом → группа → подгруппа → товары. Их
 * довод верен для ресторана, где блюд сотни и они вложены.
 *
 * В продуктовом магазине категорий десяток, и лишний уровень значит
 * лишнее нажатие при очереди. Здесь вкладки одним рядом.
 *
 * НО ГЛАВНОЕ ИХ ПРАВИЛО БЕРЁМ ЦЕЛИКОМ:
 *
 *   «Поиск сквозной и уровней не знает: официант помнит блюдо, а не
 *    путь к нему.»
 *
 * Кассир помнит «хлеб», а не «Бакалея → Хлебобулочные → Хлеб».
 */

/** Вкладка «ходовое» стоит первой: там девять из десяти продаж. */
const QUICK_TAB = 'Ходовое';
const ALL_TAB = 'Все';

/**
 * ПОИСК ПО ТОВАРАМ.
 *
 * Ищем по названию И по штрихкоду: кассир может набрать цифры с
 * коробки, если сканер не берёт мятый код.
 *
 * СЛОВА ИЩЕМ ПО ОТДЕЛЬНОСТИ. «молоко 2.5» найдёт «Молоко Айналайын
 * 2.5%», хотя подряд этих знаков в названии нет. У донора такого
 * нет — их поиск ищет строку целиком, и «молоко 2.5» не нашло бы
 * ничего.
 */
function searchGoods(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;

  const слова = q.split(/\s+/).filter(Boolean);

  const found = items.filter((g) => {
    const name = String(g.name || '').toLowerCase();
    // Штрихкод ищем целиком: часть кода — это не тот товар.
    if ((g.barcodes || []).some((b) => String(b).includes(q))) return true;
    // Все слова должны найтись, в любом порядке.
    return слова.every((w) => name.includes(w));
  });

  /* СОВПАДЕНИЕ С НАЧАЛА — ВЫШЕ. Их правило: набрал «хле» — сперва
     «Хлеб», а не «Отруби хлебные». Кассир жмёт первое и не смотрит. */
  return found.sort((a, b) => {
    const an = String(a.name || '').toLowerCase();
    const bn = String(b.name || '').toLowerCase();
    const as = an.startsWith(слова[0]) ? 0 : 1;
    const bs = bn.startsWith(слова[0]) ? 0 : 1;
    return as - bs || an.localeCompare(bn, 'ru');
  });
}

/**
 * ВКЛАДКИ. «Ходовое» первой, потом категории по алфавиту.
 *
 * Пустых вкладок не делаем: категория без товаров — это нажатие в
 * никуда, и кассир решит, что касса сломалась.
 */
function catTabs(items) {
  const есть = new Set();
  let ходовых = 0;

  for (const g of items) {
    if (g.quick) ходовых += 1;
    if (g.category) есть.add(g.category);
  }

  const tabs = [];
  if (ходовых) tabs.push(QUICK_TAB);
  tabs.push(...[...есть].sort((a, b) => a.localeCompare(b, 'ru')));

  /* Если категорий нет вовсе — одна вкладка «Все». Иначе кассир увидит
     пустой ряд и не поймёт, куда делись товары. */
  if (!tabs.length) tabs.push(ALL_TAB);
  return tabs;
}

/**
 * ОТБОР ПО ВКЛАДКЕ.
 *
 * Поиск СИЛЬНЕЕ вкладки: набрал слово — ищем по всему каталогу, мимо
 * вкладок. Это и есть «поиск уровней не знает».
 */
function pickGoods(items, { tab, query }) {
  const q = String(query || '').trim();
  if (q) return searchGoods(items, q);          // сквозной

  if (tab === QUICK_TAB) return items.filter((g) => g.quick);
  if (tab && tab !== ALL_TAB) return items.filter((g) => g.category === tab);
  return items;
}

/**
 * НАЙТИ ПО ШТРИХКОДУ — для сканера.
 *
 * Отдельно от поиска: сканер даёт код целиком, и совпадение должно
 * быть ТОЧНЫМ. Частичное совпадение продало бы не тот товар.
 */
function findByBarcode(items, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return items.find((g) => (g.barcodes || []).some((b) => String(b) === c)) || null;
}

if (typeof module !== 'undefined') {
  module.exports = { QUICK_TAB, ALL_TAB, searchGoods, catTabs, pickGoods, findByBarcode };
}
