/*
 * ОПЛАТА.
 *
 * ЧЕТЫРЕ ИХ УРОКА ВЗЯТЫ ЦЕЛИКОМ:
 *
 * 1. СУММА ПОДСТАВЛЕНА СРАЗУ. Их довод: «точный расчёт — самый частый
 *    случай, а кассир, у которого гость даёт больше, поправит одним
 *    касанием. С нуля кнопка "Принять оплату" была погашена, и человек
 *    искал, что не так, вместо того чтобы закрыть чек».
 *
 * 2. КАССА ПОМНИТ, ЧЕМ ПЛАТЯТ ЧАЩЕ. В одном магазине берут картой, в
 *    другом наличными — кассир не должен переключать каждый раз.
 *
 * 3. ДВОЙНОЙ ТАП НЕ ДАЁТ ДВА ЧЕКА. Их слова: «двойной тап по
 *    "Оплатить" на медленном планшете = два чека».
 *
 * 4. ESCAPE ВОЗВРАЩАЕТ К ЧЕКУ. Покупатель передумал платить картой —
 *    касса не листает заново.
 *
 * УМНЫЕ КУПЮРЫ — из этого чата, часть 9. У меня в прошлой кассе на
 * 24 000 не показывалось НИ ОДНОЙ кнопки: купюры кончились, и кассир
 * набирал руками при очереди.
 */

/** Способы оплаты. Первые три — почти весь оборот магазина. */
const WAYS = [
  { id: 'cash',   name: 'Наличные',  cash: true },
  { id: 'card',   name: 'Карта' },
  { id: 'qr',     name: 'QR с телефона' },
  { id: 'mixed',  name: 'Смешанно',  cash: true },
  { id: 'credit', name: 'В долг' },
];

/** Купюры Казахстана. */
const NOTES = [200, 500, 1000, 2000, 5000, 10000, 20000];

/**
 * УМНЫЕ КУПЮРЫ.
 *
 * Покупатель почти всегда даёт круглым: к оплате 1 340 — протянет
 * 1 500 или 2 000. Кассир жмёт одну кнопку вместо набора цифр.
 *
 * Порядок: точная сумма первой (самый частый случай), потом округления
 * вверх до сотни, пятисот, тысячи, потом купюры, потом десятки тысяч.
 *
 * ПУСТО НЕ БЫВАЕТ НИКОГДА — вот чего не хватало в прошлой кассе.
 */
function tenderOptions(due) {
  const d = Math.max(0, Math.round(Number(due) || 0));
  const out = [d];

  for (const step of [100, 500, 1000]) {
    const v = Math.ceil(d / step) * step;
    if (v > d && !out.includes(v)) out.push(v);
    if (out.length >= 4) return out;
  }
  for (const n of NOTES) {
    if (n >= d && !out.includes(n)) out.push(n);
    if (out.length >= 4) return out;
  }
  // Купюры кончились — идём десятками тысяч. Тут и ломалась прежняя
  // касса: на 24 000 не показывала ничего.
  let v = Math.ceil(d / 10000) * 10000;
  while (out.length < 4) {
    if (!out.includes(v)) out.push(v);
    v += 10000;
  }
  return out;
}

/**
 * СДАЧА.
 *
 * Считаем ОТ ВНЕСЁННОГО, а не от способа: кассир мог взять деньги и
 * картой, и наличными разом.
 */
function change(due, tendered) {
  return Math.max(0, Math.round(Number(tendered) || 0) - Math.round(Number(due) || 0));
}

/**
 * ХВАТАЕТ ЛИ ДЕНЕГ.
 *
 * @returns { ok } или { ok:false, short } — сколько не хватает
 */
function enough(due, { cash = 0, card = 0 } = {}) {
  const d = Math.round(Number(due) || 0);
  const внесено = Math.round(Number(cash) || 0) + Math.round(Number(card) || 0);
  if (внесено >= d) return { ok: true, change: change(d, внесено) };
  return { ok: false, short: d - внесено };
}

/**
 * СМЕШАННАЯ ОПЛАТА.
 *
 * Покупатель платит часть картой, часть наличными: на карте не хватило
 * или он хочет разменять крупную.
 *
 * ПРАВИЛО: карта проходит ТОЧНО, наличными добирают остаток. Иначе
 * банк вернёт лишнее на карту через три дня, а деньги из ящика ушли
 * сегодня.
 */
function planMixed(due, cardPart) {
  const d = Math.round(Number(due) || 0);
  const c = Math.max(0, Math.round(Number(cardPart) || 0));

  if (c > d) {
    return { ok: false, said: `Картой больше суммы чека — в чеке ${d} ₸` };
  }
  return { ok: true, card: c, cashNeeded: d - c };
}

/**
 * СОБРАТЬ ЧЕК К ОТПРАВКЕ.
 *
 * Всё, что должно уйти на сервер и остаться на кассе.
 */
function buildReceipt({ cart, cartDiscount, way, cash, card, due, state, newId, now = new Date() }) {
  const внесено = Math.round(Number(cash) || 0) + Math.round(Number(card) || 0);
  const сдача = change(due, внесено);

  return {
    id: newId(),
    number: (state.lastNumber || 0) + 1,
    at: now.toISOString(),
    shiftId: state.shift && state.shift.id,

    store: state.storeName || '',
    register: state.registerName || '',
    /* КЛЮЧ КАССИРА, А НЕ ТОЛЬКО ИМЯ. Двух Айгуль за год — обычное
       дело: одна ушла, другая пришла. Без ключа выручку по кассирам не
       сверить и спросить не с кого. */
    cashier: state.employee && state.employee.name || '',
    cashierId: state.employee && state.employee.id || null,

    items: cart.map((l) => ({
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      price: l.price,
      discount: l.discount || 0,
      // Коды маркировки едут в чеке: по ним товар выходит из оборота.
      marks: l.codes || [],
    })),

    discount: cartDiscount || 0,
    total: due,
    way,
    cash: Math.round(Number(cash) || 0),
    card: Math.round(Number(card) || 0),
    change: сдача,
    // Наличных В ЯЩИКЕ прибавилось: внесённое минус сдача.
    cashDelta: Math.round(Number(cash) || 0) - сдача,
  };
}

/** Запомнить, чем платили: касса подставит это в следующий раз. */
function rememberWay(store, way) {
  return store.saveSettings({ lastWay: way });
}

function lastWay(settings) {
  const id = settings && settings.lastWay;
  return WAYS.some((w) => w.id === id) ? id : 'cash';
}

if (typeof module !== 'undefined') {
  module.exports = { WAYS, NOTES, tenderOptions, change, enough, planMixed,
    buildReceipt, rememberWay, lastWay };
}
