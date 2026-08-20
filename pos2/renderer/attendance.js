/*
 * ЯВКА КАССИРА — учёт рабочего времени.
 *
 * Их довод: «Вход по PIN открывает явку на сервере; „Я ухожу" — тот же
 * PIN, но явка закрывается и касса прощается с человеком, назвав
 * отработанное время».
 *
 * Зачем это магазину. Кассир ушёл домой, а явка висит — владелец
 * думает, что человек на работе, и считает ему часы. К концу месяца
 * зарплата не сойдётся, а доказать никто ничего не сможет.
 *
 * ЯВКА И СМЕНА — РАЗНОЕ. Смена про деньги в ящике, явка про часы
 * человека. За смену кассиры могут смениться дважды, а смена одна.
 */

/**
 * Отметить уход.
 *
 * Возвращает имя и отработанное время — чтобы касса попрощалась.
 */
async function clockOut({ ask, settings, deviceToken, pin }) {
  try {
    const d = await ask('/pos/clock-out', {
      settings, deviceToken, method: 'POST', body: { pin },
    });

    if (d && d.ok === false) {
      return { ok: false, said: d.reason || 'Код не подошёл' };
    }

    return {
      ok: true,
      name: d.fullName || d.name || 'Кассир',
      workedMin: Number(d.workedMin || d.worked_min || 0),
    };
  } catch (e) {
    /* Сервер жив и отказал — верим. Их случай: «открытой явки нет —
       уход уже отмечен». Такое бывает: кассир нажал дважды. */
    if (e && e.serverAnswered) {
      const said = /NO_OPEN_ATTENDANCE|нет открытой/i.test(e.code || e.message || '')
        ? 'Открытой явки нет — уход уже отмечен'
        : (e.message || 'Код не подошёл');
      return { ok: false, said };
    }

    /* Сервер молчит. Явку без связи закрыть НЕЛЬЗЯ — её ведёт сервер,
       и придумывать часы на кассе нельзя: это зарплата человека.
       Говорим прямо, а не делаем вид, что отметили. */
    return {
      ok: false,
      said: 'Нет связи — уход не отмечен. Скажите владельцу, '
        + 'он закроет явку в кабинете',
    };
  }
}

/** Отработанное словами: «8 ч 15 мин» или «45 мин». */
function workedText(min) {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} ч ${r} мин` : `${r} мин`;
}

/** Прощание: называем имя и время. */
function farewell(name, workedMin) {
  return `${name || 'Кассир'}, смена отмечена: ${workedText(workedMin)}. До свидания!`;
}

if (typeof module !== 'undefined') {
  module.exports = { clockOut, workedText, farewell };
}
