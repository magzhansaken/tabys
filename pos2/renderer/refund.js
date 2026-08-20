/*
 * ВОЗВРАТЫ И ДВИЖЕНИЕ НАЛИЧНЫХ.
 *
 * Здесь деньги уходят ИЗ кассы — самое опасное место. Каждое действие
 * оставляет след: кто, когда, сколько и по чьему слову.
 *
 * У ДОНОРА возврат есть только как отмена заказа с причиной и
 * подписью старшего. Внесений и изъятий нет вовсе — в ресторане ящик
 * открывают, а движение денег не считают.
 *
 * В магазине это обязательно: кассир берёт размен утром, сдаёт выручку
 * вечером, и всё должно сойтись с ящиком.
 */

/** Причины возврата. Их список, поправленный под магазин. */
const REFUND_REASONS = [
  'Не подошёл товар',
  'Брак или просрочка',
  'Ошибка кассира',
  'Покупатель передумал',
];

/** Куда и откуда идут наличные мимо чеков. */
const CASH_MOVES = {
  cash_in:    { name: 'Внесение в кассу', sign: +1,
                hint: 'Размен утром или доложили мелочь' },
  cash_out:   { name: 'Изъятие из кассы', sign: -1,
                hint: 'Взяли на расходы — назовите на что' },
  collection: { name: 'Инкассация',       sign: -1,
                hint: 'Сдали выручку владельцу или в банк' },
};

/**
 * ВОЗВРАТ ПО ЧЕКУ.
 *
 * Покупатель принёс чек и товар. Возвращаем то, что вправду в нём
 * было, — не «на глаз».
 *
 * ЧАСТИЧНЫЙ ВОЗВРАТ обязателен: в чеке пять товаров, а несут один.
 * Возвращать весь чек значит отдать деньги за четыре товара, которые
 * покупатель унёс.
 */
function planRefund(receipt, picked) {
  if (!receipt) return { ok: false, said: 'Чек не найден' };

  const строки = (receipt.items || []).map((it, i) => ({
    ...it,
    idx: i,
    // Сколько уже вернули по этой строке раньше: чек могли нести дважды.
    returned: Number(it.returned || 0),
  }));

  const берём = [];
  for (const p of picked || []) {
    const l = строки[p.idx];
    if (!l) return { ok: false, said: 'Такой строки в чеке нет' };

    const можно = l.qty - l.returned;
    const сколько = Number(p.qty) || 0;

    if (сколько <= 0) continue;
    if (сколько > можно) {
      /* Просят больше, чем осталось. Часть уже возвращали — и без этой
         проверки кассир отдал бы деньги дважды за один товар. */
      return {
        ok: false,
        said: можно > 0
          ? `${l.name}: можно вернуть только ${можно} — остальное уже возвращали`
          : `${l.name}: по этой строке уже всё возвращено`,
      };
    }

    берём.push({ ...l, qty: сколько });
  }

  if (!берём.length) return { ok: false, said: 'Выберите, что возвращаем' };

  /* СУММА СЧИТАЕТСЯ ПО ЦЕНЕ ИЗ ЧЕКА, а не по нынешней. Цена могла
     вырасти со вчера — покупатель не должен получить больше, чем
     платил, а магазин не должен потерять на этом. */
  const сумма = берём.reduce((a, l) => {
    const доля = l.qty / l.qty0 || l.qty / (l.qty + l.returned) || 1;
    const скидка = Math.round((l.discount || 0) * (l.qty / (l.qty + l.returned || l.qty)));
    return a + Math.round(l.price * l.qty) - скидка;
  }, 0);

  return { ok: true, items: берём, total: сумма, full: берём.length === строки.length
    && берём.every((b) => b.qty === строки[b.idx].qty - строки[b.idx].returned) };
}

/**
 * СОБРАТЬ ВОЗВРАТ К ОТПРАВКЕ.
 *
 * Возврат — это отдельная запись, а не правка старого чека. Старый чек
 * остаётся как был: он уже ушёл в налоговую, и менять его нельзя.
 */
function buildRefund({ receipt, plan, reason, way, approval, state, newId, now = new Date() }) {
  return {
    id: newId(),
    kind: 'refund',
    number: (state.lastNumber || 0) + 1,
    at: now.toISOString(),
    shiftId: state.shift && state.shift.id,

    // На какой чек ссылаемся: без этого возврат не сверить с продажей.
    ofReceiptId: receipt.id,
    ofReceiptNumber: receipt.number,

    store: state.storeName || '',
    register: state.registerName || '',
    cashier: state.employee && state.employee.name || '',
    cashierId: state.employee && state.employee.id || null,

    items: plan.items.map((l) => ({
      productId: l.productId, name: l.name, qty: l.qty, price: l.price,
      // Марки возвращаются В ОБОРОТ: товар снова можно продать.
      marks: (l.marks || []).slice(0, Math.ceil(l.qty)),
    })),

    total: plan.total,
    reason: reason || 'Не указана',
    way: way || 'cash',

    /* ПОДПИСЬ. Кто разрешил и как проверен — это главное в возврате.
       Владелец при разборе должен видеть не только «вернули 3 400», но
       и кто за это отвечает. */
    approvedBy: approval && approval.approvedBy || null,
    approvedName: approval && approval.approvedName || null,
    offlineNote: approval && approval.offlineNote || null,

    // Из ящика ушло: только наличная часть.
    cashDelta: (way || 'cash') === 'cash' ? -plan.total : 0,
  };
}

/**
 * ДВИЖЕНИЕ НАЛИЧНЫХ МИМО ЧЕКОВ.
 *
 * Внесение, изъятие, инкассация. Все три меняют ящик, и все три
 * обязаны оставить след — иначе вечером ящик не сойдётся, а объяснить
 * будет нечем.
 */
function buildCashMove({ type, amount, note, approval, state, newId, now = new Date() }) {
  const вид = CASH_MOVES[type];
  if (!вид) return { ok: false, said: 'Неизвестное движение денег' };

  const сумма = Math.round(Number(amount) || 0);
  if (сумма <= 0) return { ok: false, said: 'Сумма должна быть больше нуля' };

  /* ИЗ ЯЩИКА НЕЛЬЗЯ ВЗЯТЬ БОЛЬШЕ, ЧЕМ В НЁМ ЕСТЬ. Иначе в отчёте
     появится отрицательный ящик, и сверка не сойдётся никогда. */
  const в_ящике = Number(state.cashInDrawer) || 0;
  if (вид.sign < 0 && сумма > в_ящике) {
    return {
      ok: false,
      said: `В ящике ${в_ящике} ₸ — больше взять нельзя. Пересчитайте`,
    };
  }

  return {
    ok: true,
    move: {
      id: newId(),
      kind: 'cash_move',
      type,
      at: now.toISOString(),
      shiftId: state.shift && state.shift.id,
      amount: сумма,
      delta: вид.sign * сумма,
      /* ПРИЧИНА ОБЯЗАТЕЛЬНА для изъятия. «Взяли 5 000» без слов — это
         дыра в отчёте, и виноватым окажется кассир. */
      note: note || '',
      cashier: state.employee && state.employee.name || '',
      cashierId: state.employee && state.employee.id || null,
      approvedBy: approval && approval.approvedBy || null,
      approvedName: approval && approval.approvedName || null,
      offlineNote: approval && approval.offlineNote || null,
    },
  };
}

/** Нужна ли причина словами. */
function needsNote(type) {
  return type === 'cash_out';
}

/** Лента возврата — по образцу чека, но с пометкой. */
function refundLines(r, width = 48, { receiptLines }) {
  const lines = receiptLines({
    ...r,
    total: r.total,
    cash: 0, card: 0, change: 0,
  }, width);

  /* Лента идёт описаниями строк, а не голым текстом: у каждой есть
     свой вид — по центру, жирно. Ищем по тексту ВНУТРИ описания. */
  const текст = (l) => (typeof l === 'string' ? l : (l && l.text) || '');

  // Пометка сразу под шапкой: это ВОЗВРАТ, а не продажа.
  const i = lines.findIndex((l) => текст(l).includes('Чек №'));
  const метка = [
    { text: 'ВОЗВРАТ', type: 'center', bold: true },
    { text: `к чеку №${r.ofReceiptNumber}`, type: 'center' },
  ];
  lines.splice(i >= 0 ? i + 1 : 0, 0, ...метка);

  // И причину — владелец читает её при разборе.
  const j = lines.findIndex((l) => текст(l).startsWith('ИТОГО'));
  if (j >= 0) lines.splice(j + 1, 0, { text: `Причина: ${r.reason}` });

  return lines;
}

if (typeof module !== 'undefined') {
  module.exports = { REFUND_REASONS, CASH_MOVES, planRefund, buildRefund,
    buildCashMove, needsNote, refundLines };
}
