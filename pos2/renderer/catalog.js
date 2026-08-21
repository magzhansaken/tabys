/*
 * КАТАЛОГ С ЗАПАСОМ НА ДИСКЕ.
 *
 * Их довод, взятый дословно:
 *
 *   «Касса включается утром, а сеть у заведения может лежать со
 *    вчера. Без запаса кассир увидел бы пустой экран и не принял бы ни
 *    одного заказа — при том, что кухня работает и гости пришли.»
 *
 * В магазине то же: утром сеть лежит, а покупатели идут. Касса должна
 * торговать по вчерашнему каталогу, а не стоять.
 *
 * Три случая, и все три обязаны работать:
 *   удачная загрузка кладёт запас на диск;
 *   сеть упала — берём последний известный;
 *   ни сети, ни запаса — БЕДА НАЗЫВАЕТСЯ ВСЛУХ, а не прячется.
 */

/**
 * Взять каталог. Сперва с сервера, не вышло — с диска.
 *
 * @returns { items, from: 'сеть'|'диск', ageDays }
 */
async function loadCatalog({ ask, store, settings, deviceToken }) {
  try {
    const d = await ask('/pos/goods/catalog', { settings, deviceToken });
    const items = mapGoods(d);
    if (items.length) {
      await store.saveCatalog(items);
      return { items, from: 'сеть', ageDays: 0 };
    }
    // Сервер ответил пустым — не затираем запас: у клиента могли
    // просто ещё не завести товары, а вчерашний список рабочий.
    const kept = await store.getCatalog();
    if (kept.items && kept.items.length) {
      return { items: kept.items, from: 'диск', ageDays: await store.catalogAge() };
    }
    return { items: [], from: 'сеть', ageDays: 0 };
  } catch (e) {
    const kept = await store.getCatalog();
    if (kept.items && kept.items.length) {
      return { items: kept.items, from: 'диск', ageDays: await store.catalogAge() };
    }
    /* НИ СЕТИ, НИ ЗАПАСА. Раньше ошибка глоталась молча: кассир видел
       пустой каталог и не понимал почему. Ни товаров, ни объяснения —
       думал, что касса сломалась, и звонил. */
    const err = new Error('Нет связи и нет сохранённых товаров — касса не сможет '
      + 'продавать. Дождитесь интернета или позовите владельца');
    err.empty = true;
    err.cause = e;
    throw err;
  }
}

/* Разбор ответа сервера. Держим отдельно: сервер может менять поля, а
   касса не должна знать о них в десяти местах. */
function mapGoods(d) {
  const rows = (d && d.products) || [];

  /* НАЗВАНИЯ КАТЕГОРИЙ ПРИХОДЯТ ОТДЕЛЬНЫМ СПИСКОМ, а в товаре лежит
     только ключ. Без этой сшивки вкладок не было вовсе. */
  const катИмя = new Map();
  for (const c of (d && d.categories) || []) катИмя.set(c.id, c.name);

  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    price: Number(g.price ?? 0),

    // Штрихкодов может быть несколько: сканер найдёт товар по любому.
    barcodes: Array.isArray(g.barcodes) ? g.barcodes.map((b) => String(b.code ?? b)) : [],

    /* КОД ВЕСОВ. Сервер шлёт plu_code — по нему разбирается штрихкод,
       напечатанный весами. Со старым именем весовые товары не
       находились вовсе. */
    plu: (g.plu_code ?? g.plu) != null ? String(g.plu_code ?? g.plu) : null,

    /* НУЖНА ЛИ МАРКА. Сервер шлёт marking: none, tobacco, alcohol,
       beer, shoes, pharma. Со старым именем сигареты шли БЕЗ
       требования марки, и товар уходил бы мимо налоговой. */
    marked: !!(g.marked || (g.marking && g.marking !== 'none')),
    marking: g.marking || null,

    // Название вкладки, а не ключ: кассир читает буквы.
    category: катИмя.get(g.category_id) || g.category || g.categoryName || null,

    quick: !!(g.is_quick || g.quick),
    unit: g.unit || (g.kind === 'weight' ? 'кг' : 'шт'),

    // Весовой товар считается дробно — это видно по виду товара.
    weight: g.kind === 'weight',
  })).filter((g) => g.id && g.name);
}

/**
 * СКАЗАТЬ ЛИ ПРО ВОЗРАСТ.
 *
 * Владелец поднял цены вчера, а касса не выходила в сеть три дня — она
 * продаёт по старым, и не знает об этом никто.
 *
 * Два дня терпимо: цены меняют не каждый день, а частые сообщения
 * перестают читать.
 */
function catalogWarning(ageDays) {
  if (ageDays == null || ageDays < 3) return null;
  return `Цены не обновлялись ${ageDays} дн. — если владелец их менял, `
    + 'касса об этом не знает';
}

if (typeof module !== 'undefined') {
  module.exports = { loadCatalog, mapGoods, catalogWarning };
}
