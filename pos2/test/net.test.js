/*
 * ПРОВЕРКА ОБМЕНА С СЕРВЕРОМ.
 *
 * Подменяем сам fetch: гоняем СВОЙ путь, а не пересказ. Каждый случай
 * — беда, которая уже случалась.
 */
const { ask, ping, sayIt, NetError, OfflineError, makeNetWatch } = require('../renderer/net.js');
const { loadCatalog, mapGoods, catalogWarning } = require('../renderer/catalog.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const S = { apiUrl: 'https://пример.kz/api' };
const setFetch = (fn) => { global.fetch = fn; };
global.AbortSignal = { timeout: () => null };

console.log('═══ ЭТАП 4 · ОБМЕН С СЕРВЕРОМ ═══\n');

// ── СЕРВЕР ОТВЕТИЛ ХОРОШО ──────────────────────────────────────────
(async () => {
  setFetch(async () => ({ ok: true, status: 200, json: async () => ({ products: [] }) }));
  const d = await ask('/pos/goods/catalog', { settings: S });
  ok(d && Array.isArray(d.products), 'Ответ сервера доходит целым');

  // ── СЕРВЕР МОЛЧИТ ────────────────────────────────────────────────
  setFetch(async () => { throw new Error('network'); });
  let e = null;
  try { await ask('/pos/ping', { settings: S }); } catch (x) { e = x; }
  ok(e instanceof OfflineError, 'Обрыв связи — своя ошибка');
  ok(e.serverAnswered === false,
     '★ Помечено: сервер МОЛЧИТ — судить о деле нельзя');

  // ── СЕРВЕР ЖИВ И СКАЗАЛ «НЕТ» ────────────────────────────────────
  setFetch(async () => ({ ok: false, status: 401,
    json: async () => ({ code: 'PIN_INVALID' }) }));
  e = null;
  try { await ask('/pos/login', { settings: S }); } catch (x) { e = x; }
  ok(e instanceof NetError && e.serverAnswered === true,
     '★ Сервер ЖИВ и отказал — это про дело, а не про связь');
  ok(e.message === 'Код не подошёл',
     `★ И сказано СЛОВАМИ: «${e.message}», а не «401 PIN_INVALID»`);

  // ── КАССУ ОТВЯЗАЛИ ───────────────────────────────────────────────
  {
    let стёрли = false;
    setFetch(async () => ({ ok: false, status: 401,
      json: async () => ({ code: 'TERMINAL_REVOKED' }) }));
    try {
      await ask('/pos/bootstrap', { settings: S, onRevoked: async () => { стёрли = true; } });
    } catch (x) {
      ok(стёрли, '★ Кассу отвязали — привязка стёрта сразу');
      ok(/Привяжите заново/.test(x.message),
         `И сказано, что делать: «${x.message}»`);
    }
  }

  // ── ВСЕ ОТКАЗЫ ГОВОРЯТ ПО-РУССКИ ────────────────────────────────
  {
    const коды = ['DEVICE_BLOCKED', 'ACCOUNT_SUSPENDED', 'SHIFT_CLOSED', 'NO_RIGHT'];
    const плохо = коды.filter((c) => !/[а-яё]/i.test(sayIt(403, c)));
    ok(плохо.length === 0, '★ Ни один отказ не показывает кассиру код');
    // Незнакомый код тоже должен сказать словами, а не «UNKNOWN_THING».
    ok(/[а-яё]/i.test(sayIt(500, 'НЕИЗВЕСТНО_ЧТО')),
       'Незнакомый код — тоже словами');
    // Сервер прислал свои слова — берём их: он ближе к делу.
    ok(sayIt(400, 'X', 'Цена выше прайса') === 'Цена выше прайса',
       '★ Слова сервера сильнее нашего списка');
  }

  // ── СВЯЗЬ ГОВОРИТ ОДИН РАЗ ───────────────────────────────────────
  {
    const сказано = [];
    const w = makeNetWatch((m) => сказано.push(m));
    for (const жива of [1, 1, 0, 0, 0, 0, 0, 1, 1, 1]) { if (жива) w.good(); else w.bad(); }
    ok(сказано.length === 2,
       `★ Десять проверок подряд — ДВА сообщения, а не десять`);
    ok(/пропала/.test(сказано[0]) && /вернулась/.test(сказано[1]),
       'Пропажа и возврат — оба названы');
  }

  // ── КАТАЛОГ: ТРИ СЛУЧАЯ ──────────────────────────────────────────
  console.log('\n═══ ЗАПАС КАТАЛОГА ═══\n');
  {
    const диск = { items: [], at: 0 };
    const store = {
      saveCatalog: async (i) => { диск.items = i; диск.at = Date.now(); },
      getCatalog: async () => диск,
      catalogAge: async () => (диск.at ? Math.floor((Date.now() - диск.at) / 86400000) : null),
    };
    const товар = { products: [{ id: 'g1', name: 'Хлеб', price: 250, barcodes: ['4870'] }] };

    // 1. Удачная загрузка кладёт запас
    setFetch(async () => ({ ok: true, status: 200, json: async () => товар }));
    let r = await loadCatalog({ ask, store, settings: S });
    ok(r.from === 'сеть' && r.items.length === 1, 'Удачная загрузка берёт из сети');
    ok(диск.items.length === 1, '★ И кладёт запас на диск');

    // 2. Сеть упала — живём на последнем известном
    setFetch(async () => { throw new Error('network'); });
    r = await loadCatalog({ ask, store, settings: S });
    ok(r.from === 'диск' && r.items[0].name === 'Хлеб',
       '★ Сеть упала — торгуем по последнему каталогу');

    // 3. Ни сети, ни запаса — беда вслух
    диск.items = [];
    let сказал = null;
    try { await loadCatalog({ ask, store, settings: S }); } catch (x) { сказал = x.message; }
    ok(сказал && /не сможет продавать/.test(сказал),
       '★ Ни сети, ни запаса — беда НЕ прячется');
    ok(/позовите владельца/.test(сказал), `И сказано, что делать: «${сказал.slice(0, 60)}…»`);

    // 4. Сервер ответил ПУСТЫМ — запас не затираем
    диск.items = [{ id: 'g1', name: 'Хлеб', price: 250 }];
    setFetch(async () => ({ ok: true, status: 200, json: async () => ({ products: [] }) }));
    r = await loadCatalog({ ask, store, settings: S });
    ok(r.items.length === 1 && r.from === 'диск',
       '★ Сервер прислал пусто — вчерашний список цел, касса торгует');
  }

  // ── ВОЗРАСТ КАТАЛОГА ─────────────────────────────────────────────
  {
    ok(catalogWarning(0) === null && catalogWarning(2) === null,
       'Два дня — молчим: цены меняют не каждый день');
    ok(/3 дн/.test(catalogWarning(3) || ''),
       '★ Три дня — говорим: касса может продавать по старым ценам');
  }

  // ── РАЗБОР ТОВАРА ────────────────────────────────────────────────
  {
    const g = mapGoods({ products: [
      { id: '1', name: 'Хлеб', price: '250', barcodes: [{ code: '4870' }, '123'] },
      { id: '2', name: 'Водка', price: 2500, marked: true, plu: 7, is_quick: true },
      { name: 'Без ключа' },   // мусор
    ] });
    ok(g.length === 2, '★ Товар без ключа отброшен, а не сломал каталог');
    ok(g[0].barcodes.length === 2, 'Все штрихкоды взяты: сканер найдёт по любому');
    ok(g[1].marked === true && g[1].plu === '7' && g[1].quick === true,
       'Марка, код весов и «ходовое» разобраны');
  }

  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
})();
