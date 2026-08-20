/*
 * КАТАЛОГ ТОВАРОВ: вкладки, поиск, ходовое.
 *
 * УСТРОЙСТВО ПРОЩЕ, ЧЕМ У ДОНОРА, И ЭТО НАРОЧНО.
 *
 * У них касса «ходит вглубь»: дом → группа → подгруппа → товары. Так
 * привык персонал заведений, где меню на сотню позиций разложено по
 * разделам.
 *
 * В продуктовом магазине категорий десяток, а товаров тысячи. Лишний
 * уровень — лишнее нажатие при очереди, а найти товар всё равно проще
 * поиском или сканером.
 *
 * Поэтому: один ряд вкладок, первая — «Ходовое».
 *
 * ГЛАВНОЕ ИХ ПРАВИЛО ВЗЯТО ЦЕЛИКОМ: «Поиск сквозной и уровней не
 * знает: официант помнит блюдо, а не путь к нему». Кассир помнит
 * «хлеб», а не то, в какой он вкладке.
 */

const QUICK = 'Ходовое';
const ALL = 'Все';

/**
 * ВКЛАДКИ.
 *
 * «Ходовое» первым: восемь из десяти чеков — это хлеб, молоко,
 * сигареты и пакет. Кассир должен доставать их одним касанием.
 *
 * Дальше категории по алфавиту: их порядок с сервера может меняться, а
 * кассир привыкает к месту вкладки и целится не глядя.
 */
function catTabs(catalog) {
  const есть = new Set();
  let ходовых = 0;

  for (const g of catalog) {
    if (g.quick) ходовых += 1;
    if (g.category) есть.add(g.category);
  }

  const tabs = [];
  if (ходовых) tabs.push(QUICK);
  tabs.push(...[...есть].sort((a, b) => a.localeCompare(b, 'ru')));

  // Без категорий вовсе — одна вкладка «Все»: пустой ряд пугает.
  if (!tabs.length) tabs.push(ALL);
  return tabs;
}

/**
 * СРАВНЕНИЕ ТОВАРА С ЗАПРОСОМ.
 *
 * Кассир печатает быстро и промахивается по клавишам. Поэтому ищем не
 * только по началу, но и по любой части слова: «локо» найдёт «Молоко».
 *
 * Ищем и по штрихкоду: покупатель принёс товар без наклейки, а кассир
 * читает цифры с упаковки.
 */
function matchGood(g, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  if (String(g.name).toLowerCase().includes(s)) return true;
  return (g.barcodes || []).some((b) => String(b).includes(s));
}

/**
 * ПОИСК: СКВОЗНОЙ, УРОВНЕЙ НЕ ЗНАЕТ.
 *
 * Ищет по ВСЕМУ каталогу, мимо вкладок — их правило. Кассир помнит
 * товар, а не вкладку.
 *
 * ПОРЯДОК ВЫДАЧИ, тоже их правило: начинающиеся с запроса — первыми.
 * Набрал «мол» — сперва «Молоко», потом «Сгущённое молоко». Иначе
 * кассир листает список, чтобы найти очевидное.
 */
function searchGoods(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  return catalog
    .filter((g) => matchGood(g, q))
    .sort((a, b) => {
      const aн = String(a.name).toLowerCase().startsWith(q) ? 0 : 1;
      const bн = String(b.name).toLowerCase().startsWith(q) ? 0 : 1;
      if (aн !== bн) return aн - bн;
      // Дальше ходовое вперёд: его берут чаще.
      if (!!a.quick !== !!b.quick) return a.quick ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'ru');
    });
}

/**
 * ЧТО ПОКАЗАТЬ СЕЙЧАС.
 *
 * Есть запрос — показываем найденное, мимо вкладок. Нет — товары
 * выбранной вкладки.
 */
function visibleGoods(catalog, { tab, query }) {
  const q = String(query || '').trim();
  if (q) return searchGoods(catalog, q);

  if (tab === QUICK) return catalog.filter((g) => g.quick);
  if (!tab || tab === ALL) return catalog;
  return catalog.filter((g) => g.category === tab);
}

/**
 * ЧТО СКАЗАТЬ, ЕСЛИ ПУСТО.
 *
 * Пустое место без объяснения — это звонок в поддержку. Кассир не
 * знает, сломалась касса или товара вправду нет.
 */
function emptyText({ catalog, tab, query }) {
  if (!catalog.length) {
    return 'Товаров нет вовсе — каталог не пришёл с сервера. Позовите владельца';
  }
  const q = String(query || '').trim();
  if (q) {
    return `По запросу «${q}» ничего не нашлось. Проверьте написание `
      + 'или отсканируйте штрихкод';
  }
  if (tab === QUICK) {
    return 'Ходовые товары не отмечены. Владелец отмечает их в кабинете — '
      + 'тогда они будут под рукой';
  }
  return `Во вкладке «${tab}» пока нет товаров`;
}

/** Найти товар по штрихкоду — для сканера. Точное совпадение. */
function findByBarcode(catalog, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return catalog.find((g) => (g.barcodes || []).some((b) => String(b) === c)) || null;
}

if (typeof module !== 'undefined') {
  module.exports = { QUICK, ALL, catTabs, matchGood, searchGoods,
    visibleGoods, emptyText, findByBarcode };
}
