/*
 * ВОЗВРАТЫ И ДВИЖЕНИЕ ДЕНЕГ.
 *
 * Здесь деньги уходят ИЗ кассы — самое опасное место в смене. Каждое
 * действие требует разрешения и оставляет след в журнале.
 *
 * ВЗЯТО У НИХ:
 *   причина возврата обязательна — «причина ляжет в отчёт владельца»;
 *   недавняя причина всплывает первой: «смена повторяет ошибки
 *     сериями» — если утром привезли кислое молоко, его вернут ещё
 *     десять раз до обеда;
 *   путь один: причина → код старшего → событие.
 *
 * СВОЁ:
 *   возврат по чеку и без чека — разные вещи;
 *   изъятие и внесение наличных;
 *   инкассация.
 */

/** Причины возврата. Магазинные, не ресторанные. */
const REASONS = [
  'Товар не подошёл',
  'Брак или срок',
  'Ошибка кассира',
  'Покупатель передумал',
];

/** Куда девается товар после возврата — это решает владелец потом. */
const ACTIONS = ['refund', 'refund_free', 'cash_out', 'cash_in', 'collection'];

/**
 * НЕДАВНЯЯ ПРИЧИНА ПЕРВОЙ.
 *
 * Их находка: «смена повторяет ошибки сериями». Привезли кислое молоко
 * — вернут десять раз до обеда, и кассир не должен каждый раз искать
 * причину в списке.
 */
function orderReasons(recent = []) {
  const свежие = recent.filter((r) => REASONS.includes(r));
  return [...new Set([...свежие, ...REASONS])];
}

/** Запомнить причину: следующий возврат начнётся с неё. */
function rememberReason(recent, reason) {
  return [reason, ...(recent || []).filter((r) => r !== reason)].slice(0, 3);
}

/**
 * ВОЗВРАТ ПО ЧЕКУ.
 *
 * Покупатель принёс чек — знаем, что и почём продали. Это главный
 * случай: возвращаем ровно то, что в чеке.
 *
 * ЧАСТИЧНЫЙ ВОЗВРАТ. Купил три пачки, вернул одну — обычное дело.
 * Считаем по строкам, а не «весь чек или ничего».
 */
function planRefund(receipt, picked) {
  if (!receipt) return { ok: false, said: 'Чек не найден' };

  const строки = (receipt.items || []).map((it, i) => {
    const взять = picked && picked[i] != null ? Number(picked[i]) : it.qty;
    return { ...it, refundQty: Math.max(0, Math.min(взять, it.qty)) };
  }).filter((it) => it.refundQty > 0);

  if (!строки.length) return { ok: false, said: 'Нечего возвращать — выберите позиции' };

  /* СКИДКА ВОЗВРАЩАЕТСЯ СОРАЗМЕРНО. Купил на 5 000 со скидкой 500,
     вернул половину — вернуть надо 2 250, а не 2 500. Иначе магазин
     теряет скидку дважды. */
  const полная = (receipt.items || []).reduce((a, it) =>
    a + Math.round(it.price * it.qty) - (it.discount || 0), 0);

  const часть = строки.reduce((a, it) => {
    const своя = Math.round(it.price * it.refundQty);
    const скидка = it.discount ? Math.round(it.discount * it.refundQty / it.qty) : 0;
    return a + своя - скидка;
  }, 0);

  const доля = полная ? часть / полная : 0;
  const скидкаЧека = Math.round((receipt.discount || 0) * доля);
  const сумма = Math.max(0, часть - скидкаЧека);

  return {
    ok: true,
    items: строки,
    subtotal: часть,
    cartDiscount: скидкаЧека,
    total: сумма,
    full: строки.length === (receipt.items || []).length
      && строки.every((it) => it.refundQty === it.qty),
  };
}

/**
 * ХВАТИТ ЛИ ДЕНЕГ В ЯЩИКЕ.
 *
 * Покупатель принёс чек на 5 000, а в ящике 3 000: утро, размен
 * маленький. Отдать нечем.
 *
 * Говорим ЧЕСТНО и заранее — до того, как кассир скажет «сейчас
 * верну» и полезет в ящик.
 */
function cashEnough(cashInDrawer, amount) {
  const есть = Math.round(Number(cashInDrawer) || 0);
  const надо = Math.round(Number(amount) || 0);
  if (есть >= надо) return { ok: true };
  return {
    ok: false,
    short: надо - есть,
    said: `В ящике ${есть} ₸, а вернуть надо ${надо} ₸. `
      + 'Не хватает — позовите владельца или верните на карту',
  };
}

/**
 * СОБРАТЬ ЧЕК ВОЗВРАТА.
 *
 * Отдельный чек со знаком возврата: он уходит на сервер, печатается и
 * ложится в отчёт.
 */
function buildRefund({ plan, receipt, reason, way, state, approval, newId, now = new Date() }) {
  return {
    id: newId(),
    number: (state.lastNumber || 0) + 1,
    at: now.toISOString(),
    shiftId: state.shift && state.shift.id,
    isRefund: true,

    // На какой чек ссылаемся: без этого возврат не сверить с продажей.
    ofReceiptId: receipt ? receipt.id : null,
    ofReceiptNumber: receipt ? receipt.number : null,

    store: state.storeName || '',
    register: state.registerName || '',
    cashier: state.employee && state.employee.name || '',
    cashierId: state.employee && state.employee.id || null,

    items: plan.items.map((it) => ({
      productId: it.productId,
      name: it.name,
      qty: it.refundQty,
      price: it.price,
      discount: it.discount ? Math.round(it.discount * it.refundQty / it.qty) : 0,
      marks: it.marks || [],
    })),

    discount: plan.cartDiscount,
    total: plan.total,
    way,
    cash: way === 'cash' ? plan.total : 0,
    card: way === 'card' ? plan.total : 0,
    change: 0,
    // Из ящика УШЛО: со знаком минус, чтобы сверка сходилась сама.
    cashDelta: way === 'cash' ? -plan.total : 0,

    reason,
    // Кто разрешил — и проверена ли подпись сервером.
    approvedBy: approval && approval.approvedBy || null,
    approvedName: approval && approval.approvedName || null,
    offlineNote: approval && approval.offlineNote || null,

    returnNote: 'Возврат принят. Обмен и возврат — по чеку в течение 14 дней',
  };
}

/*
 * ДВИЖЕНИЕ НАЛИЧНЫХ БЕЗ ПРОДАЖИ.
 *
 * Внесение: кассир добавил размен из сейфа.
 * Изъятие: владелец забрал часть выручки среди дня.
 * Инкассация: деньги увезли в банк.
 *
 * Всё это меняет ящик, и без записи вечерняя сверка не сойдётся:
 * кассир будет объясняться за деньги, которых не брал.
 */
function buildCashMove({ kind, amount, note, state, approval, newId, now = new Date() }) {
  const сумма = Math.abs(Math.round(Number(amount) || 0));
  const минус = kind !== 'cash_in';

  return {
    id: newId(),
    at: now.toISOString(),
    shiftId: state.shift && state.shift.id,
    entity: 'cash_move',
    kind,                       // cash_in · cash_out · collection
    amount: сумма,
    cashDelta: минус ? -сумма : сумма,
    note: note || '',
    cashier: state.employee && state.employee.name || '',
    cashierId: state.employee && state.employee.id || null,
    approvedBy: approval && approval.approvedBy || null,
    approvedName: approval && approval.approvedName || null,
    offlineNote: approval && approval.offlineNote || null,
  };
}

/** Название движения для журнала и чека. */
const MOVE_NAME = {
  cash_in: 'Внесение в кассу',
  cash_out: 'Изъятие из кассы',
  collection: 'Инкассация',
};

/**
 * ИЗЪЯТЬ БОЛЬШЕ, ЧЕМ ЕСТЬ, НЕЛЬЗЯ.
 *
 * Ящик ушёл бы в минус, и в отчёте появилось бы отрицательное число,
 * которое никто не сможет объяснить.
 */
function checkMove(kind, amount, cashInDrawer) {
  const сумма = Math.round(Number(amount) || 0);
  if (!Number.isFinite(сумма) || сумма <= 0) {
    return { ok: false, said: 'Введите сумму' };
  }
  if (kind === 'cash_in') return { ok: true, amount: сумма };

  const есть = Math.round(Number(cashInDrawer) || 0);
  if (сумма > есть) {
    return { ok: false, said: `В ящике всего ${есть} ₸ — больше изъять нельзя` };
  }
  return { ok: true, amount: сумма };
}

if (typeof module !== 'undefined') {
  module.exports = { REASONS, ACTIONS, MOVE_NAME, orderReasons, rememberReason,
    planRefund, cashEnough, buildRefund, buildCashMove, checkMove };
}
