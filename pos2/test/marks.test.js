/*
 * ПРОВЕРКА МАРКИРОВКИ.
 *
 * Главное: марка снимается вместе с товаром ЛЮБЫМ путём. Эту беду я
 * находил дважды — на кнопке и на цифрах.
 */
const { needMarks, marksMissing, trimMarks, trimAll, addMark, payBlock, markBar } = require('../renderer/marks.js');
const { addToCart, setQty, removeLine } = require('../renderer/cart.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const водка = { id: 'g1', name: 'Водка «Алтай»', price: 3200, marked: true, barcodes: ['4870001234567'] };
const сиг = { id: 'g2', name: 'Сигареты Winston', price: 1200, marked: true, barcodes: ['4870007654321'] };
const хлеб = { id: 'g3', name: 'Хлеб', price: 250 };
const всем = async () => ({ ok: true });   // разрешаем всё
let ln = 0; const newId = () => `l${++ln}`;

console.log('═══ ЭТАП 14 · МАРКИРОВКА ═══\n');

(async () => {

// ── СЧЁТ МАРОК ─────────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  ok(needMarks(cart[0]) === 3, 'Три бутылки — нужно три марки');
  cart[0].codes = ['M1'];
  ok(needMarks(cart[0]) === 2, 'Одну считали — осталось две');
  ok(needMarks({ marked: false, qty: 5 }) === 0, 'Немаркированный товар марок не просит');
}

// ── ТА САМАЯ БЕДА: КНОПКА «−» ──────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['M1', 'M2', 'M3'];

  await setQty(cart, cart[0], 2, { allow: всем, trimMarks });

  ok(cart[0].codes.length === 2,
     '★ Убрали бутылку кнопкой — марка снялась: 2 товара, 2 марки');
}

// ── ТА ЖЕ БЕДА: ВВОД ЦИФРАМИ ───────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['M1', 'M2', 'M3'];

  // Кассир набрал «1» на цифровой клавиатуре — ДРУГОЙ путь
  await setQty(cart, cart[0], 1, { allow: всем, trimMarks });

  ok(cart[0].codes.length === 1,
     '★ Набрали «1» цифрами — марки тоже снялись: ТА ЖЕ ДВЕРЬ');
}

// ── И УДАЛЕНИЕ СТРОКИ ──────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 2, newId);
  cart[0].codes = ['M1', 'M2'];
  addToCart(cart, хлеб, 1, newId);

  await removeLine(cart, cart[0], { allow: всем, trimMarks });
  ok(cart.length === 1 && cart[0].name === 'Хлеб',
     '★ Строку убрали целиком — марки ушли с ней');
}

// ── ПРОВЕРКА ПО ВСЕМУ ЧЕКУ ─────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  addToCart(cart, сиг, 2, newId);
  cart[0].codes = ['M1', 'M2', 'M3'];
  cart[1].codes = ['S1', 'S2'];

  cart[0].qty = 1; cart[1].qty = 1;      // как будто правили мимо двери
  const снято = trimAll(cart);

  ok(снято === 3 && cart[0].codes.length === 1 && cart[1].codes.length === 1,
     '★ Проверка по всему чеку ловит расхождение: снято 3 лишних');
}

// ── СБОР МАРОК ─────────────────────────────────────────────────────
console.log('\n═══ СБОР МАРОК ═══\n');
{
  const cart = [];
  addToCart(cart, водка, 2, newId);

  const r1 = addMark(cart, 'МАРКА-001');
  ok(r1.ok && cart[0].codes.length === 1, 'Первая марка принята');
  ok(/осталось отсканировать: 1/.test(r1.said),
     `★ И сказано, сколько осталось: «${r1.said}»`);

  const r2 = addMark(cart, 'МАРКА-002');
  ok(r2.ok && /можно к оплате/.test(r2.said),
     `★ Собрали все: «${r2.said}»`);
}

// ── ТА ЖЕ МАРКА ДВАЖДЫ ─────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  addMark(cart, 'МАРКА-001');
  const r = addMark(cart, 'МАРКА-001');

  ok(!r.ok && /уже в чеке/.test(r.said),
     '★ Та же марка дважды отбита: иначе две марки на одну бутылку');
  ok(cart[0].codes.length === 1, 'И в чеке осталась одна');
}

// ── МАРКА БЕЗ ТОВАРА ───────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  const r = addMark(cart, 'МАРКА-001');
  ok(!r.ok && /Сначала пробейте сам товар/.test(r.said),
     '★ Марка есть, товара нет — сказано, что делать');
}

// ── ВСЕ МАРКИ УЖЕ СОБРАНЫ ──────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 1, newId);
  addMark(cart, 'M1');
  const r = addMark(cart, 'M2');
  ok(!r.ok && /проверьте количество/.test(r.said),
     'Лишняя марка — подсказано проверить количество');
}

// ── МАРКА К СВОЕЙ СТРОКЕ ───────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 1, newId);
  addToCart(cart, сиг, 1, newId);

  /* Разбор кода: в марке после «01» идёт штрихкод товара, 13 знаков.
     Пример настоящей марки: 01 4870007654321 21 XXXX */
  const gtinOf = (c) => (c.startsWith('01') ? c.slice(2, 15) : null);
  addMark(cart, '014870007654321' + '21XXXX', { gtinOf });

  const кому = cart.find((l) => (l.codes || []).length);
  ok(кому && кому.name === 'Сигареты Winston',
     '★ Марка легла к СВОЕЙ строке по штрихкоду внутри кода');
}

// ── ОПЛАТА ЗАКРЫТА, И ОТКАЗ НАЗЫВАЕТ ТОВАР ─────────────────────────
console.log('\n═══ ОПЛАТА ═══\n');
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  addToCart(cart, сиг, 2, newId);
  cart[0].codes = ['M1'];

  const b = payBlock(cart);
  ok(b !== null, 'К оплате не пускает: марок не хватает');
  ok(/Водка «Алтай» \(2\)/.test(b) && /Winston \(2\)/.test(b),
     `★ И НАЗВАН ТОВАР: «${b}»`);
  ok(/Осталось отсканировать марок: 4/.test(b), 'И сколько всего');

  cart[0].codes = ['M1', 'M2', 'M3'];
  cart[1].codes = ['S1', 'S2'];
  ok(payBlock(cart) === null, '★ Собрали все — оплата открыта');
}

// ── ПОЛОСА НАД ЧЕКОМ ───────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  ok(markBar(cart) === null, 'Без маркированных полосы нет: лишнего не показываем');

  addToCart(cart, водка, 2, newId);
  const b1 = markBar(cart);
  ok(b1.kind === 'need' && /Нужно марок: 2/.test(b1.title), `Полоса: «${b1.title}»`);

  cart[1].codes = ['M1', 'M2'];
  const b2 = markBar(cart);
  ok(b2.kind === 'ok' && /выведут товар из оборота/.test(b2.note),
     '★ Собрали — сказано, что коды выведут товар из оборота');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
