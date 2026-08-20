/*
 * ЧЕК: строки, количество, отложенные.
 *
 * Их правило взято целиком: «Заказ как чистый редьюсер событий. Один и
 * тот же код гоняет состояние на кассе и материализует чек на сервере
 * — расхождения между "что видел кассир" и "что легло в базу"
 * исключены by design».
 *
 * У меня то же, но проще: чек — список строк, и каждое действие над ним
 * — отдельная свёртка. Проверить можно каждую, не поднимая кассу.
 *
 * ПОЧЕМУ СТРОКИ, А НЕ СОБЫТИЯ. У них событиями, потому что заказ живёт
 * часами и переходит между официантами. В магазине чек живёт минуту и
 * не переходит никуда — событий было бы больше, чем пользы.
 */

/** Предел количества в одной строке. Больше — опечатка. */
const MAX_QTY = 1000;

/** Пересчитать строку: сумма минус её скидка. */
function lineSum(l) {
  return Math.round(l.price * l.qty) - (l.discount || 0);
}

/** Итог чека. */
function cartTotal(cart, cartDiscount = 0) {
  const sum = cart.reduce((a, l) => a + lineSum(l), 0);
  return Math.max(0, sum - (cartDiscount || 0));
}

/**
 * ДОБАВИТЬ ТОВАР.
 *
 * СЛИЯНИЕ СТРОК — их правило, но с моей поправкой.
 *
 * У них сливается только ПОСЛЕДНЯЯ строка: «тот же товар с тем же
 * набором модификаторов ПОДРЯД». В магазине покупатель выкладывает
 * товар вперемешку — три пачки молока могут пройти через сканер с
 * хлебом между ними.
 *
 * Поэтому ищем СРЕДИ ВСЕХ строк, а не только в последней. Иначе в чеке
 * будет «Молоко ×1» три раза, и покупатель решит, что его обсчитали.
 *
 * НЕ СЛИВАЕМ:
 *   весовой товар — 0,45 кг и 1,2 кг это разные взвешивания;
 *   строку со своей скидкой — она уже посчитана;
 *   строку с изменённой ценой — их правило про «закрытую строку».
 */
function addGood(cart, good, qty = 1) {
  const n = Number(qty) || 1;
  const дробное = n % 1 !== 0;

  const same = дробное ? null : cart.find((l) =>
    l.productId === good.id
    && !(l.qty % 1)            // не весовая
    && !l.discount             // без своей скидки
    && !l.priceChanged);       // цену не меняли

  if (same) {
    same.qty += n;
    return { cart, line: same, merged: true };
  }

  const line = {
    productId: good.id,
    name: good.name,
    price: Number(good.price) || 0,
    qty: n,
    unit: good.unit || 'шт',
    barcodes: good.barcodes || [],
    marked: !!good.marked,
    codes: [],            // марки, собранные сканером
    discount: 0,
    priceChanged: false,
  };
  cart.push(line);
  return { cart, line, merged: false };
}

/**
 * ПОСТАВИТЬ КОЛИЧЕСТВО.
 *
 * Возвращает, что надо сделать: сразу поставить, спросить разрешение
 * или отказать. Само не решает — решает экран, у которого есть права.
 */
function planQty(line, n) {
  const q = Number(n);

  if (!Number.isFinite(q) || q < 0) {
    return { act: 'deny', said: 'Не понял количество' };
  }

  /* ПРЕДЕЛ. Опечатка в лишнюю цифру давала чек на миллион: кассир
     набрал 99 вместо 9, промахнулся мимо кнопки — и покупатель видит
     сумму с шестью нулями, а отменять её через старшего при очереди. */
  if (q > MAX_QTY) {
    return { act: 'deny', said: `${q} — похоже на опечатку. Больше ${MAX_QTY} за раз не бывает` };
  }

  if (q === 0) return { act: 'ask', action: 'remove_item', qty: 0 };
  if (q < line.qty) return { act: 'ask', action: 'reduce_qty', qty: q };
  return { act: 'set', qty: q };
}

/** Убрать строку целиком. */
function removeLine(cart, line) {
  const i = cart.indexOf(line);
  if (i >= 0) cart.splice(i, 1);
  return cart;
}

/*
 * ОТЛОЖЕННЫЕ ЧЕКИ.
 *
 * Покупатель забыл кошелёк в машине, или ему звонят и он выходит.
 * Очередь стоит, а чек набран — десять позиций.
 *
 * Откладываем: чек уходит в сторону, касса чистая, следующий проходит.
 * Вернулся — достали и продолжили.
 *
 * ЛЕЖАТ НА ДИСКЕ, а не в памяти: касса может перезапуститься, пока
 * покупатель ходит за деньгами.
 */
function parkCart(parked, cart, cartDiscount, { newId, now = new Date() }) {
  if (!cart.length) return { ok: false, said: 'Чек пуст — откладывать нечего' };

  const entry = {
    id: newId(),
    at: now.toISOString(),
    // Время короткое: кассир ищет «тот, что в 14:20», а не по ключу.
    label: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    items: cart.length,
    total: cartTotal(cart, cartDiscount),
    cart: JSON.parse(JSON.stringify(cart)),   // копия: дальше чек чистят
    cartDiscount: cartDiscount || 0,
  };
  parked.push(entry);
  return { ok: true, entry, parked };
}

/** Достать отложенный. */
function unparkCart(parked, id) {
  const i = parked.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, said: 'Этот чек уже забрали' };
  const [entry] = parked.splice(i, 1);
  return { ok: true, cart: entry.cart, cartDiscount: entry.cartDiscount, parked };
}

/**
 * СТАРЫЕ ОТЛОЖЕННЫЕ.
 *
 * Покупатель ушёл и не вернулся — чек висит третий день. Товар при
 * этом числится непроданным, а кассир видит чужой список и не решается
 * его тронуть.
 *
 * Говорим про такие, но НЕ УДАЛЯЕМ сами: вдруг это заказ, который
 * ждут.
 */
function staleParked(parked, hours = 12, now = Date.now()) {
  return parked.filter((p) => (now - new Date(p.at).getTime()) / 3600000 > hours);
}

if (typeof module !== 'undefined') {
  module.exports = { MAX_QTY, lineSum, cartTotal, addGood, planQty, removeLine,
    parkCart, unparkCart, staleParked };
}
