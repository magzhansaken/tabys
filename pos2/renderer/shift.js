/*
 * СМЕНА.
 *
 * Смена — это отрезок, за который сводят деньги. Открыли с разменом,
 * поторговали, закрыли с пересчётом: сколько должно быть в ящике и
 * сколько насчитали.
 *
 * ЧЕТЫРЕ ПРАВИЛА, каждое выстрадано.
 *
 * 1. СПРОСИТЬ ПРО ОТКРЫТУЮ СМЕНУ ДО ТОГО, как предложить новую. Их
 *    урок: «иначе человек введёт размен, нажмёт Открыть, а сервер
 *    подхватит чужую смену — и деньги уйдут не туда».
 *
 * 2. ЧУЖАЯ СМЕНА ПРИНИМАЕТСЯ, А НЕ ПРОДОЛЖАЕТСЯ. Слово другое
 *    нарочно: кассир должен понимать, что берёт на себя чужой ящик.
 *
 * 3. ЗАБЫТАЯ СМЕНА ловится по границе суток, а не по числу часов. У
 *    донора «смена идёт 14 часов» — но она может законно идти
 *    шестнадцать. У меня: открыта до шести утра, а сейчас позже —
 *    значит вчерашняя.
 *
 * 4. ПУСТОЕ ПОЛЕ ПРИ ЗАКРЫТИИ НЕ ЗНАЧИТ НОЛЬ. В прошлой кассе это
 *    давало недостачу на всю кассу: кассир закрывал не глядя, и
 *    назавтра его спрашивали о деньгах, которых он не брал.
 */

/** Обычные размены. Кассир жмёт один раз вместо набора цифр. */
const FLOATS = [10000, 20000, 40000];

/**
 * ЗАБЫТА ЛИ СМЕНА.
 *
 * Граница — шесть утра: до неё ещё «вчерашний вечер», после — новый
 * день. Магазины работают до полуночи и до двух ночи, и смена,
 * открытая в двадцать три часа, — это нормально.
 *
 * А вот смена, открытая вчера до шести утра, когда сейчас уже день —
 * забыта. Утренний кассир сядет, и его чеки уйдут во вчерашнюю смену:
 * выручка за два дня в одной куче, и сверка не сойдётся ни за один.
 */
function shiftForgotten(shift, now = new Date()) {
  if (!shift || !shift.openedAt) return null;
  const opened = new Date(shift.openedAt);
  const border = new Date(now); border.setHours(6, 0, 0, 0);

  // Открыта после границы, или сейчас ещё ночь — обычная смена.
  if (opened >= border || now < border) return null;

  const hours = Math.floor((now - opened) / 3600000);
  return {
    hours,
    said: `Смена открыта ${hours} ч назад и не закрыта. `
      + 'Ваши чеки уйдут во вчерашний отчёт — закройте её и откройте новую',
  };
}

/**
 * ЧЬЯ СМЕНА.
 *
 * Своя — «Продолжить». Чужая — «Принять смену»: слово другое нарочно,
 * кассир берёт на себя чужой ящик и отвечает за его пересчёт.
 */
function shiftOwnership(shift, employee) {
  if (!shift) return null;
  const mine = shift.openedById && employee && shift.openedById === employee.id;
  return {
    mine: !!mine,
    label: mine ? 'Продолжить смену' : 'Принять смену',
    note: mine ? null
      : `Смену открыл ${shift.openedByName || 'другой кассир'}. `
        + 'Приняв её, вы отвечаете за деньги в ящике — пересчитайте их сейчас',
  };
}

/** Открыть смену. Размен идёт в ящик как начальные наличные. */
async function openShift({ ask, store, settings, deviceToken, openingCash, newId }) {
  const shift = {
    id: newId(),
    openedAt: new Date().toISOString(),
    openingCash: Number(openingCash) || 0,
  };

  /* Сперва в очередь, потом на сервер: если упасть между, смена цела.
     Наоборот — она бы открылась на сервере, а касса о ней не знала. */
  await store.outboxAdd({
    id: shift.id, entity: 'shift', entityId: shift.id, op: 'insert',
    payload: shift, clientTs: shift.openedAt,
  });

  await store.saveState({
    shift: { ...shift, openedById: null, openedByName: null },
    cashInDrawer: shift.openingCash,
    lastNumber: 0,        // нумерация чеков начинается со смены
  });

  return shift;
}

/**
 * СКОЛЬКО ДОЛЖНО БЫТЬ В ЯЩИКЕ.
 *
 * Считаем НА КАССЕ, а не спрашиваем сервер: закрытие обязано работать
 * без связи. У донора сводка приходит с сервера, и без сети её нет.
 */
function expectedCash(state) {
  return Number(state.cashInDrawer) || 0;
}

/**
 * ЗАКРЫТЬ СМЕНУ.
 *
 * @param factCash сколько насчитали. null значит «не вписал» — тогда
 *                 решение принимает экран, спросив кассира.
 */
async function closeShift({ store, state, factCash, newId }) {
  const must = expectedCash(state);
  const fact = Number(factCash) || 0;

  const close = {
    id: newId(),
    shiftId: state.shift && state.shift.id,
    closedAt: new Date().toISOString(),
    expectedCash: must,
    factCash: fact,
    diff: fact - must,
  };

  await store.outboxAdd({
    id: close.id, entity: 'shift_close', entityId: close.shiftId,
    op: 'update', payload: close, clientTs: close.closedAt,
  });

  await store.saveState({ shift: null, cashInDrawer: 0 });
  return close;
}

/** Как назвать расхождение. Считаем при вводе, а не после закрытия. */
function diffText(fact, must) {
  const d = Number(fact) - Number(must);
  if (!Number.isFinite(d)) return null;
  if (d === 0) return { kind: 'ok', said: 'Сходится' };
  if (d > 0) return { kind: 'warn', said: 'Излишек', amount: d };
  return { kind: 'bad', said: 'Не хватает', amount: -d };
}

/**
 * ЧТО СКАЗАТЬ ПРО НЕОТПРАВЛЕННОЕ.
 *
 * Деньги за эти чеки УЖЕ В ЯЩИКЕ — это не излишек. Без объяснения
 * кассир решит, что насчитал лишнего, и начнёт искать ошибку.
 */
/* СЧЁТ ПО-РУССКИ: 1 чек, 2 чека, 5 чеков.
 *
 * Было «3 чеков» — коряво. Кассир читает это при каждом закрытии
 * смены, и небрежность в словах подрывает доверие к цифрам: если тут
 * не считают как надо, то и в деньгах?
 *
 * Правило языка: 11-14 всегда «чеков», дальше по последней цифре. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  if (a >= 11 && a <= 14) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function pendingNote(pending, rejected) {
  const out = [];
  if (pending > 0) {
    out.push(`В очереди ${pending} ${plural(pending, 'чек', 'чека', 'чеков')} — `
      + 'они уйдут вместе с закрытием. Деньги за них уже в ящике, это не излишек');
  }
  if (rejected > 0) {
    out.push(`Сервер не принял ${rejected} ${plural(rejected, 'чек', 'чека', 'чеков')} — `
      + 'деньги за них в ящике, а в отчёте их нет. Покажите владельцу');
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { FLOATS, plural, shiftForgotten, shiftOwnership, openShift,
    expectedCash, closeShift, diffText, pendingNote };
}

/*
 * ЯВКА КАССИРА — отдельно от смены, и это важно.
 *
 * Смена про ДЕНЬГИ: открыли ящик, закрыли, свели. Явка про ЧЕЛОВЕКА:
 * пришёл на работу, ушёл домой.
 *
 * Их довод: «вход по PIN открывает явку на сервере; „Я ухожу" — тот же
 * PIN, но явка закрывается и касса прощается, назвав отработанное
 * время».
 *
 * Смена может пережить кассира: утренний ушёл, вечерний принял тот же
 * ящик. И наоборот — кассир может отметить уход, не закрывая смену,
 * если сменщик уже сел.
 *
 * Кассир ушёл домой, а явка висит — владелец думает, что человек на
 * работе, и считает ему часы.
 */
async function clockOut({ ask, store, settings, deviceToken, pin }) {
  try {
    const d = await ask('/pos/clock-out', {
      settings, deviceToken, method: 'POST', body: { pin },
    });
    return {
      ok: true,
      name: d.fullName || d.name || 'Кассир',
      workedMin: Number(d.workedMin || d.worked_min || 0),
    };
  } catch (e) {
    if (e && e.serverAnswered) {
      /* Явки нет — это не ошибка кода. Человек мог отметить уход
         раньше, а теперь жмёт повторно. */
      if (/NO_OPEN_ATTENDANCE|нет открытой/i.test(e.code || e.message || '')) {
        return { ok: false, said: 'Открытой явки нет — уход уже отмечен' };
      }
      return { ok: false, said: e.message || 'Код не подошёл' };
    }

    /* БЕЗ СВЯЗИ ЯВКУ НЕ ЗАКРЫТЬ, и это верно: часы считает сервер, а
       касса не знает, когда человек пришёл.
       Но говорим прямо, что делать, а не «ошибка». */
    return {
      ok: false,
      said: 'Нет связи — уход отметится, когда появится интернет. '
        + 'Можно уходить, скажите владельцу',
    };
  }
}

if (typeof module !== 'undefined') module.exports.clockOut = clockOut;
