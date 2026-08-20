/*
 * ПРОПУСКА КАССЫ — вход без сети.
 *
 * Их довод дословно:
 *
 *   «Интернет в зале пропадает, смена — нет. Всё, что требует проверки
 *    PIN, обязано уметь работать без сервера — иначе "упал роутер"
 *    превращается в "встал зал".
 *
 *    При каждой УСПЕШНОЙ онлайн-проверке касса оставляет себе пропуск —
 *    не сам PIN, а его след, посоленный ключом устройства. Подобрать
 *    код по следу нельзя, унести след на другую кассу бессмысленно:
 *    соль другая.»
 *
 * КАССИРЫ СМЕНЯЮТСЯ, И ЭТО ГЛАВНОЕ. Утренний ушёл, вечерний сел. Если
 * помнить только последнего, вечерний либо не войдёт вовсе, либо будет
 * торговать ПОД ЧУЖИМ ИМЕНЕМ — и все его чеки уйдут на утреннего.
 *
 * Поэтому склад: по пропуску на каждого, кто входил при связи.
 */

/**
 * След кода: необратимый, посоленный ключом устройства.
 *
 * Сам код НЕ ХРАНИМ. С отпечатком нельзя войти на другой кассе — там
 * своя соль, и тот же код даёт другой след.
 */
async function pinPrint(pin, deviceKey) {
  const raw = new TextEncoder().encode(`${String(pin)}\u00b7${String(deviceKey || '')}`);
  try {
    const dig = await crypto.subtle.digest('SHA-256', raw);
    return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    /* Надёжной свёртки нет — берём простую. Хуже, но лучше, чем
       пускать по любому коду: без следа проверять нечем вовсе. */
    let h = 0;
    const src = `${pin}|${deviceKey || ''}`;
    for (let i = 0; i < src.length; i += 1) h = (h * 31 + src.charCodeAt(i)) | 0;
    return 'w' + (h >>> 0).toString(16);
  }
}

/**
 * ЧТО КЛАДЁМ В ПРОПУСК.
 *
 * Не только имя: без сети касса должна знать и права, и предел скидки —
 * иначе кассир без права отменять сможет отменять, пока лежит роутер.
 */
function makePass(employee, extra = {}) {
  return {
    employee: {
      id: employee.id || employee.employeeId || null,
      name: employee.name || 'Кассир',
      isOwner: !!employee.isOwner,
      isShiftAdmin: !!employee.isShiftAdmin,
    },
    permissions: employee.permissions || extra.permissions || null,
    discountLimitPct: employee.discountLimitPct != null
      ? employee.discountLimitPct
      : (extra.discountLimitPct != null ? extra.discountLimitPct : null),
    savedAt: new Date().toISOString(),
  };
}

/**
 * Выписать пропуск после ЖИВОЙ проверки сервером.
 *
 * Только после живой: иначе касса запомнит того, кого сервер не
 * признал, и он войдёт завтра как свой.
 */
async function savePass({ store, pin, deviceKey, employee, extra }) {
  const print = await pinPrint(pin, deviceKey);
  await store.passSave(print, makePass(employee, extra));
  return print;
}

/**
 * Впустить без сети.
 *
 * @returns пропуск или null
 */
async function offlineLogin({ store, pin, deviceKey }) {
  const print = await pinPrint(pin, deviceKey);
  const pass = await store.passRead(print);
  return pass || null;
}

/**
 * СТАРЫЙ ПРОПУСК — беда особого рода.
 *
 * Кассира уволили месяц назад, а его пропуск лежит на кассе. Сеть
 * упала — и он входит как свой: продаёт, отменяет, возвращает деньги.
 *
 * У донора такой проверки нет вовсе. Ставлю срок: тридцать дней с
 * последнего живого входа. Кто работает — тот входит при связи хотя бы
 * раз в месяц, и пропуск обновляется сам.
 */
const PASS_DAYS = 30;

function passTooOld(pass, days = PASS_DAYS) {
  if (!pass || !pass.savedAt) return true;
  const age = (Date.now() - new Date(pass.savedAt).getTime()) / 86400000;
  return age > days;
}

/**
 * ПОЛНЫЙ ПУТЬ ВХОДА: сперва сервер, не вышло — пропуск.
 *
 * Их правило: «сервер жив и сказал „не подошёл" — это про PIN, не про
 * связь». Живому серверу верим: отказ настоящий, пропуск не смотрим.
 * Молчащему не верим — смотрим пропуск.
 */
async function login({ ask, store, settings, deviceToken, pin }) {
  try {
    const d = await ask('/pos/login', {
      settings, deviceToken, method: 'POST', body: { pin },
    });
    const who = d.employee || d;

    // Живая проверка прошла — оставляем пропуск на будущее.
    await savePass({ store, pin, deviceKey: deviceToken, employee: who, extra: d });

    return { ok: true, employee: who, from: 'сервер' };
  } catch (e) {
    /* Сервер ЖИВ и отказал — верим ему. Пропуск не смотрим: код мог
       быть отозван, а человек уволен сегодня утром. */
    if (e && e.serverAnswered) {
      return { ok: false, said: e.message || 'Код не подошёл' };
    }

    // Сервер молчит — смотрим пропуска.
    const pass = await offlineLogin({ store, pin, deviceKey: deviceToken });

    if (!pass) {
      const сколько = await store.passCount();
      return {
        ok: false,
        said: сколько
          ? 'Нет связи. Без интернета входит только тот, кто уже работал на этой кассе'
          : 'Нет связи, а на этой кассе ещё никто не входил — нужен интернет',
      };
    }

    if (passTooOld(pass)) {
      /* Пропуску больше месяца. Говорим прямо: человек мог быть уволен,
         и пускать его на кассу с деньгами нельзя. */
      return {
        ok: false,
        said: 'Вы давно не входили при связи — нужен интернет, чтобы проверить код',
      };
    }

    return { ok: true, employee: pass.employee, pass, from: 'пропуск' };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { pinPrint, makePass, savePass, offlineLogin, passTooOld, login, PASS_DAYS };
}
