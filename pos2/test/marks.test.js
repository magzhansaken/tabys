/*
 * ПРОВЕРКА МАРКИРОВКИ.
 *
 * Главное: ВСЕ пути уменьшения снимают марки. Дважды на этом обжёгся.
 */
const { needMarks, marksMissing, trimMarks, parseMark, takeMark, marksReady } = require('../renderer/marks.js');
const { addToCart, setQty, removeLine } = require('../renderer/cart.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

let счёт = 0;
const newId = () => `l${++счёт}`;
const да = async () => ({ ok: true, approvedName: 'Ерлан' });

const водка = { id: 'g1', name: 'Водка «Алтай»', price: 2500, marked: true, barcodes: ['04870001234567'] };
const сиги  = { id: 'g2', name: 'Сигареты Winston', price: 800, marked: true, barcodes: ['04870009999999'] };
const хлеб  = { id: 'g3', name: 'Хлеб', price: 250 };

const марка = (gtin, серия) => `01${gtin}21${серия}\u001d93dGVz`;

console.log('═══ ЭТАП 14 · МАРКИРОВКА ═══\n');

(async () => {

// ── СКОЛЬКО НУЖНО ──────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  ok(needMarks(cart[0]) === 3, 'Три бутылки — три марки');
  cart[0].codes = ['М1'];
  ok(needMarks(cart[0]) === 2, 'Одну считали — осталось две');
  addToCart(cart, хлеб, 1, newId);
  ok(needMarks(cart[1]) === 0, '★ Хлеб марок не требует');
  ok(marksMissing(cart) === 2, 'По чеку не хватает двух');
}

// ── РАЗБОР МАРКИ ───────────────────────────────────────────────────
{
  const m = parseMark(марка('04870001234567', 'AbCd12'));
  ok(m && m.gtin === '04870001234567', `★ GTIN вынут: ${m && m.gtin}`);
  ok(parseMark('4870001') === null, 'Обычный штрихкод маркой не считаем');
  ok(parseMark('') === null && parseMark(null) === null, 'Пусто — не марка');
  ok(parseMark('01abcdefghijklmn21xx') === null, 'Буквы вместо GTIN — не марка');
}

// ── ПРИЁМ МАРКИ ────────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 2, newId);

  const r1 = takeMark(cart, марка('04870001234567', 'A1'));
  ok(r1.ok && cart[0].codes.length === 1, 'Первая марка принята');
  ok(/осталось отсканировать: 1/.test(r1.said), `★ И сказано сколько: «${r1.said}»`);

  const r2 = takeMark(cart, марка('04870001234567', 'A2'));
  ok(r2.ok && /Марки собраны/.test(r2.said),
     `★ Собрали все — сказано: «${r2.said}»`);
}

// ── ЧЕТЫРЕ ОТКАЗА ──────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 1, newId);

  ok(!takeMark(cart, '4870001').ok, 'Не марка — отказ');
  ok(/Data Matrix/.test(takeMark(cart, '4870001').said),
     'И сказано, что сканировать');

  takeMark(cart, марка('04870001234567', 'A1'));
  const дубль = takeMark(cart, марка('04870001234567', 'A1'));
  ok(!дубль.ok && /уже в чеке/.test(дубль.said),
     '★ Та же марка дважды — отказ: кассир пикнул пачку два раза');

  const все = takeMark(cart, марка('04870001234567', 'A2'));
  ok(!все.ok && /все марки уже собраны/.test(все.said),
     '★ Марок больше, чем товара — отказ с объяснением');

  const чужая = takeMark(cart, марка('04870009999999', 'B1'));
  ok(!чужая.ok && /нет в чеке/.test(чужая.said),
     '★ Марка от товара не из чека — «сперва пробейте его»');
}

// ── ГОТОВНОСТЬ К ОПЛАТЕ ────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  addToCart(cart, сиги, 2, newId);
  cart[0].codes = ['М1'];

  const r = marksReady(cart);
  ok(!r.ok && r.left === 4, `Не хватает четырёх марок`);
  ok(/Водка «Алтай» \(2\)/.test(r.said) && /Winston \(2\)/.test(r.said),
     `★ Отказ НАЗЫВАЕТ товары: «${r.said}»`);

  cart[0].codes = ['М1', 'М2', 'М3'];
  cart[1].codes = ['М4', 'М5'];
  ok(marksReady(cart).ok, 'Все собраны — можно к оплате');
}
{
  const cart = [];
  addToCart(cart, хлеб, 5, newId);
  ok(marksReady(cart).ok, 'Чек без маркированных — сразу готов');
}

// ── ГЛАВНОЕ: ВСЕ ПУТИ СНИМАЮТ МАРКИ ────────────────────────────────
console.log('\n═══ ВСЕ ПУТИ УМЕНЬШЕНИЯ ═══\n');

// Путь 1: кнопка «−» (уменьшение на единицу)
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['М1', 'М2', 'М3'];
  const r = await setQty(cart, cart[0], 2, { allow: да });
  ok(cart[0].codes.length === 2 && r.marksDropped === 1,
     '★ ПУТЬ 1 — кнопка «−»: марка снялась');
}

// Путь 2: ввод цифрами (тот, что я пропустил в части 5)
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['М1', 'М2', 'М3'];
  const r = await setQty(cart, cart[0], 1, { allow: да });
  ok(cart[0].codes.length === 1 && r.marksDropped === 2,
     '★ ПУТЬ 2 — ввод цифрами: две марки снялись');
}

// Путь 3: удаление строки целиком
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['М1', 'М2', 'М3'];
  const r = await removeLine(cart, cart[0], { allow: да });
  ok(r.removed && cart.length === 0,
     '★ ПУТЬ 3 — удаление строки: и товар, и марки ушли вместе');
}

// Путь 4: прямой вызов свёртки
{
  const l = { marked: true, qty: 1, codes: ['М1', 'М2', 'М3'] };
  ok(trimMarks(l) === 2 && l.codes.length === 1,
     '★ ПУТЬ 4 — свёртка сама: снимает лишние');
  ok(trimMarks(l) === 0, 'Второй раз ничего не снимает: нечего');
}

// Немаркированный не трогаем
{
  const l = { marked: false, qty: 1, codes: ['М1', 'М2'] };
  ok(trimMarks(l) === 0 && l.codes.length === 2,
     'Немаркированный не трогаем: коды там от другого');
}

// Увеличение марок НЕ снимает
{
  const cart = [];
  addToCart(cart, водка, 2, newId);
  cart[0].codes = ['М1', 'М2'];
  await setQty(cart, cart[0], 5, { allow: да });
  ok(cart[0].codes.length === 2 && needMarks(cart[0]) === 3,
     '★ Добавили бутылок — марки целы, нужно ещё три');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
