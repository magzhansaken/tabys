/*
 * ПРОВЕРКА ЭКРАНА ПОСЛЕ ОПЛАТЫ И ДИСПЛЕЯ.
 *
 * Главное: сдача видна и названа прописью — её говорят вслух.
 */
const { HOLD_MS, moneyInWords, paidView, displayView } = require('../renderer/paid.js');
const { addToCart, cartTotal, lineSum } = require('../renderer/cart.js');
const { buildReceipt } = require('../renderer/pay.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };
let ln = 0; const newId = () => `l${++ln}`;

console.log('═══ ЭТАП 17 · ПОСЛЕ ОПЛАТЫ ═══\n');

// ── СУММА ПРОПИСЬЮ ─────────────────────────────────────────────────
{
  ok(moneyInWords(450) === 'четыреста пятьдесят тенге',
     '★ 450 → «четыреста пятьдесят»: чтобы не услышали «сорок пять»');
  ok(moneyInWords(45) === 'сорок пять тенге', 'И 45 отличается на слух');

  ok(moneyInWords(2000) === 'две тысячи тенге',
     '★ «ДВЕ тысячи», а не «два тысячи»: тысяча женского рода');
  ok(moneyInWords(1000) === 'одна тысяча тенге', 'И «одна тысяча»');
  ok(moneyInWords(5000) === 'пять тысяч тенге', 'Пять тысяч');

  ok(moneyInWords(11) === 'одиннадцать тенге', 'Одиннадцать — не «десять один»');
  ok(moneyInWords(21) === 'двадцать один тенге', 'Двадцать один');
  ok(moneyInWords(0) === 'ноль тенге', 'Ноль назван');
  ok(moneyInWords(2450) === 'две тысячи четыреста пятьдесят тенге', 'Составная сумма');
  ok(moneyInWords(-100) === 'ноль тенге', 'Отрицательное не ломает');
}

// ── ЭКРАН ПОСЛЕ ОПЛАТЫ ─────────────────────────────────────────────
console.log('\n═══ ЧТО ВИДИТ КАССИР ═══\n');
{
  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Молоко', price: 480 }, 2, newId);
  addToCart(cart, { id: 'g2', name: 'Хлеб', price: 250 }, 1, newId);
  const due = cartTotal(cart);

  const state = { lastNumber: 56, employee: { id: 'e1', name: 'Айгуль' }, shift: { id: 's1' } };
  const r = buildReceipt({ cart, cartDiscount: 0, way: 'cash',
    cash: 2000, card: 0, due, state, newId });

  const v = paidView(r);
  ok(v.number === 57 && v.positions === 2, 'Номер чека и число позиций видны');
  ok(v.change === 2000 - due, `Сдача: ${v.change} ₸`);
  ok(v.title === 'Сдача', 'И названа');
  ok(v.changeWords === moneyInWords(v.change),
     `★ Прописью: «${v.changeWords}»`);
  ok(v.holdMs === HOLD_MS && HOLD_MS === 8000,
     '★ Держится восемь секунд: очередь не ждёт, пока кассир дочитает');
}

// ── БЕЗ СДАЧИ ──────────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Хлеб', price: 250 }, 1, newId);
  const state = { lastNumber: 0, employee: {}, shift: {} };
  const r = buildReceipt({ cart, cartDiscount: 0, way: 'cash',
    cash: 250, card: 0, due: 250, state, newId });

  const v = paidView(r);
  ok(v.change === 0 && v.title === 'Без сдачи', 'Дали точно — «Без сдачи»');
  ok(v.changeWords === null,
     '★ Прописи нет: нечего называть вслух, и лишнего не пишем');
}

// ── ОПЛАТА КАРТОЙ ──────────────────────────────────────────────────
{
  const state = { lastNumber: 0, employee: {}, shift: {} };
  const r = buildReceipt({ cart: [], cartDiscount: 0, way: 'card',
    cash: 0, card: 5000, due: 5000, state, newId });
  ok(paidView(r).change === 0, 'Картой — сдачи не бывает');
}

// ── ДИСПЛЕЙ ПОКУПАТЕЛЮ ─────────────────────────────────────────────
console.log('\n═══ ДИСПЛЕЙ ПОКУПАТЕЛЮ ═══\n');
{
  const пусто = displayView({ cart: [], cartTotal, lineSum });
  ok(пусто.mode === 'idle', 'Пустая касса — покой');

  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Молоко 2,5%', price: 480 }, 2, newId);
  addToCart(cart, { id: 'g2', name: 'Хлеб', price: 250 }, 1, newId);

  const d = displayView({ cart, cartDiscount: 0, cartTotal, lineSum });
  ok(d.mode === 'sale' && d.rows.length === 2,
     '★ Покупатель видит, что пробивают: ловит ошибку сразу');
  ok(d.rows[0].name === 'Молоко 2,5%' && d.rows[0].sum === 960, 'Со строками и суммами');
  ok(d.total === 1210, 'И растущий итог');
}

// ── ДЛИННЫЙ ЧЕК НЕ ЛЕЗЕТ НА ЭКРАН ──────────────────────────────────
{
  const cart = [];
  for (let i = 0; i < 10; i += 1) {
    addToCart(cart, { id: `g${i}`, name: `Товар ${i}`, price: 100 }, 1, newId);
  }
  const d = displayView({ cart, cartDiscount: 0, cartTotal, lineSum });
  ok(d.rows.length === 6 && d.hidden === 4,
     '★ Показываем ПОСЛЕДНИЕ шесть строк: покупатель смотрит на то, что пробивают сейчас');
  ok(d.rows[5].name === 'Товар 9', 'И последняя — самая свежая');
}

// ── ДИСПЛЕЙ ПОСЛЕ ОПЛАТЫ ───────────────────────────────────────────
{
  const state = { lastNumber: 0, employee: {}, shift: {} };
  const r = buildReceipt({ cart: [], cartDiscount: 0, way: 'cash',
    cash: 2000, card: 0, due: 1620, state, newId });

  const d = displayView({ receipt: r, cartTotal, lineSum });
  ok(d.mode === 'paid' && d.change === 380,
     '★ После оплаты покупатель видит сдачу и считает деньги в руке');
  ok(/триста восемьдесят/.test(d.changeWords),
     `И прописью: «${d.changeWords}»`);
}

// ── СКИДКА ВИДНА ПОКУПАТЕЛЮ ────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Сыр', price: 4000 }, 1, newId);
  const d = displayView({ cart, cartDiscount: 400, cartTotal, lineSum });
  ok(d.discount === 400 && d.total === 3600,
     '★ Скидка показана покупателю: он видит, что она вправду дана');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
