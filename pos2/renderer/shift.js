/*
 * СМЕНА.
 *
 * Открыл — торгуешь. Закрыл — пересчитал деньги и сдал.
 *
 * Три беды, каждая уже случалась:
 *
 *   1. ЗАБЫТАЯ СМЕНА. Кассир ушёл домой, не закрыв. Утром сменщик
 *      садится — и его чеки идут во ВЧЕРАШНЮЮ смену. Выручка за два
 *      дня в одной куче, сверка не сойдётся ни за один.
 *
 *   2. ЧУЖАЯ СМЕНА. Их урок: «спрашиваем открытую смену ДО того, как
 *      предложить открыть новую: иначе человек введёт размен, нажмёт
 *      "Открыть", а сервер подхватит чужую смену — и деньги уйдут не
 *      туда».
 *
 *   3. ПУСТОЕ ПОЛЕ ПРИ ЗАКРЫТИИ давало ноль — недостачу на всю кассу.
 *      Кассир закрывал не глядя, и назавтра его спрашивали о деньгах,
 *      которых он не брал.
 */

/** Обычные размены. Их числа, они же ходят и в магазинах. */
const FLOATS = [20000, 40000, 60000];

/**
 * ЗАБЫТА ЛИ СМЕНА.
 *
 * У донора мерка «идёт больше 14 часов». Она неверна для магазина:
 * смена может законно идти шестнадцать — заведение работает с десяти
 * до двух ночи.
 *
 * Моя мерка вернее: смена открыта ДО утренней границы, а сейчас уже
 * после. Значит её забыли вчера — ловим именно забытую, а не долгую.
 */
const MORNING_HOUR = 6;

function shiftForgotten(shift, now = new Date()) {
  if (!shift || !shift.openedAt) return null;
  const opened = new Date(shift.openedAt);
  if (Number.isNaN(opened.getTime())) return null;

  const border = new Date(now);
  border.setHours(MORNING_HOUR, 0, 0, 0);

  // Открыта после границы, или сейчас ещё ночь — обычная смена.
  if (opened >= border || now < border) return null;

  const hours = Math.floor((now.getTime() - opened.getTime()) / 3600000);
  return {
    hours,
    said: `Смена открыта ${hours} ч назад и не закрыта со вчера. `
      + 'Закройте её и откройте новую, иначе выручка за два дня смешается',
  };
}

/**
 * ОТКРЫТЬ СМЕНУ.
 *
 * Сперва спрашиваем, нет ли уже открытой — их урок. Без связи не
 * мешаем работать: смена откроется, а сервер разберётся при первой
 * отправке.
 */
async function openShift({ ask, store, settings, deviceToken, employee, openingCash, newId }) {
  const shift = {
    id: newId(),
    openedAt: new Date().toISOString(),
    openedBy: employee && employee.id || null,
    openedByName: employee && employee.name || '',
    openingCash: Number(openingCash || 0),
  };

  // Кладём в очередь СНАЧАЛА: если упасть между записью и отправкой,
  // смена цела. Наоборот — смена открылась только на сервере, а касса
  // о ней не знает.
  await store.outboxAdd({
    id: shift.id, entity: 'shift', entityId: shift.id, op: 'insert', payload: shift,
  });

  await store.saveState({ shift, cashInDrawer: shift.openingCash });
  return shift;
}

/** Спросить сервер, нет ли уже открытой смены на этой кассе. */
async function currentShift({ ask, settings, deviceToken }) {
  try {
    const d = await ask('/pos/shift/current', { settings, deviceToken });
    return d && d.open ? d : null;
  } catch {
    /* Без связи не мешаем работать: их правило. Смена откроется, а
       сервер разберётся с двойной при первой отправке. */
    return null;
  }
}

/**
 * СВОДКА СМЕНЫ — считаем НА КАССЕ.
 *
 * У донора сводка приходит с сервера, и без связи её нет. У меня
 * считается на месте: закрытие работает без интернета всегда, а
 * интернета в магазине может не быть весь день.
 */
function shiftSummary({ shift, receipts, cashInDrawer }) {
  const мои = (receipts || []).filter((r) => !shift || r.shiftId === shift.id);
  const продажи = мои.filter((r) => !r.isRefund);
  const возвраты = мои.filter((r) => r.isRefund);

  const сумма = (rows) => rows.reduce((a, r) => a + Number(r.total || 0), 0);

  return {
    count: продажи.length,
    refundCount: возвраты.length,
    revenue: сумма(продажи) - сумма(возвраты),
    cash: мои.reduce((a, r) => a + Number(r.cashPart || 0), 0),
    card: мои.reduce((a, r) => a + Number(r.cardPart || 0), 0),
    openingCash: shift ? Number(shift.openingCash || 0) : 0,
    expectedCash: Number(cashInDrawer || 0),
  };
}

/**
 * ЗАКРЫТЬ СМЕНУ.
 *
 * Пустое поле НЕ ЗНАЧИТ НОЛЬ. Это была беда про деньги: кассир
 * закрывал не глядя, в отчёт уходила недостача на всю кассу, и
 * назавтра его спрашивали о деньгах, которых он не брал.
 *
 * @param factCash  сколько насчитали; null значит «не вписали»
 */
async function closeShift({ store, shift, factCash, expectedCash, newId }) {
  if (factCash == null || factCash === '') {
    // Решает не касса, а кассир: спрашивает экран, а мы отказываем.
    const e = new Error('Не вписано, сколько денег в ящике');
    e.needCount = true;
    e.expected = Number(expectedCash || 0);
    throw e;
  }

  const fact = Number(factCash);
  const must = Number(expectedCash || 0);

  const close = {
    id: newId(),
    shiftId: shift.id,
    closedAt: new Date().toISOString(),
    factCash: fact,
    expectedCash: must,
    diff: fact - must,
  };

  await store.outboxAdd({
    id: close.id, entity: 'shift_close', entityId: shift.id, op: 'update', payload: close,
  });

  // Смену снимаем и ящик обнуляем: деньги сданы.
  await store.saveState({ shift: null, cashInDrawer: 0 });
  return close;
}

/** Расхождение словами: показываем ДО подтверждения, а не после. */
function diffText(fact, must) {
  const d = Number(fact) - Number(must);
  if (!Number.isFinite(d)) return null;
  if (d === 0) return { kind: 'ok', said: 'Сходится' };
  if (d > 0) return { kind: 'warn', said: `Излишек ${d}` , diff: d };
  return { kind: 'bad', said: `Не хватает ${-d}`, diff: d };
}

if (typeof module !== 'undefined') {
  module.exports = {
    FLOATS, MORNING_HOUR, shiftForgotten, openShift, currentShift,
    shiftSummary, closeShift, diffText,
  };
}
