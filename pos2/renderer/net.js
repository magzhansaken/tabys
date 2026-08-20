/*
 * ОБМЕН С СЕРВЕРОМ.
 *
 * Три правила, каждое выстрадано.
 *
 * 1. СВЯЗЬ — ОТДЕЛЬНАЯ ВЕЛИЧИНА, а не «очередь пуста».
 *
 *    У донора было наоборот: одно застрявшее событие — и касса вечно
 *    показывала «Офлайн» при живой сети. У меня в прошлой кассе была
 *    обратная беда: пустая очередь давала ЗЕЛЁНУЮ точку всегда, даже
 *    когда сеть отвалилась час назад. Кассир видит зелёное, пробивает
 *    чеки, а они копятся.
 *
 *    Поэтому стучимся коротко, даже когда отправлять нечего.
 *
 * 2. ОШИБКА ГОВОРИТ СЛОВАМИ, а не кодом.
 *
 *    У донора ApiError несёт «401 TERMINAL_REVOKED». Кассиру это
 *    ничего не говорит: он видит набор букв и звонит. Здесь код
 *    переводится в человеческую фразу с указанием, что делать.
 *
 * 3. СЕРВЕР ЖИВ И СКАЗАЛ «НЕТ» — это про дело, а не про связь.
 *
 *    Их правило: «Сервер жив и сказал „не подошёл" — это про PIN, не
 *    про связь». Различать обязательно: живому серверу верим, молчащему
 *    нет.
 */

/** Ответ сервера словами: что случилось и что делать. */
const SAID = {
  TERMINAL_REVOKED: 'Кассу отвязали в кабинете. Привяжите заново кодом от владельца',
  DEVICE_BLOCKED:   'Устройство заблокировано владельцем платформы',
  ACCOUNT_SUSPENDED:'Магазин отключён — оплатите подписку или позвоните владельцу',
  PIN_INVALID:      'Код не подошёл',
  SHIFT_CLOSED:     'Смена уже закрыта — откройте новую',
  SHIFT_OPEN:       'Смена уже открыта',
  NO_RIGHT:         'Это действие вам не разрешено',
  DUPLICATE:        'Уже принято раньше — повторно не берём',
};

class NetError extends Error {
  constructor(status, code, said) {
    super(said);
    this.status = status;
    this.code = code;
    /* СЕРВЕР ОТВЕТИЛ — значит он жив, и дело не в связи. Отличать
       обязательно: живому верим, молчащему нет. */
    this.serverAnswered = true;
  }
}

class OfflineError extends Error {
  constructor() {
    super('Нет связи с сервером');
    this.serverAnswered = false;   // сервер молчит: судить о деле нельзя
  }
}

/* Что делать с ответом сервера: перевести код в слова. */
function sayIt(status, code, message) {
  if (SAID[code]) return SAID[code];
  // Сервер прислал свои слова — берём их: он ближе к делу, чем список.
  if (message && /[а-яё]/i.test(message)) return message;
  if (status === 401) return 'Касса не узнана — привяжите её заново';
  if (status === 403) return 'Это действие вам не разрешено';
  if (status === 404) return 'Сервер не нашёл, о чём речь';
  if (status >= 500) return 'Сервер отвечает с ошибкой — попробуйте позже';
  return 'Сервер отказал';
}

/**
 * Сходить на сервер.
 *
 * Возвращает данные или бросает: NetError (сервер ответил отказом) или
 * OfflineError (сервер молчит). Разница важнее самой ошибки.
 */
async function ask(path, opts = {}) {
  const S = opts.settings || {};
  const url = String(S.apiUrl || '').replace(/\/$/, '') + path;

  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.deviceToken ? { 'x-device-token': opts.deviceToken } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // Ждать вечно нельзя: касса встанет с зависшим окном, а очередь
      // у прилавка растёт. Десяти секунд хватает и по мобильному.
      signal: opts.signal || AbortSignal.timeout(opts.timeout || 10000),
    });
  } catch {
    // Сюда попадаем при обрыве связи и при истечении срока ожидания.
    throw new OfflineError();
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const code = (data && (data.code || data.error)) || 'HTTP_ERROR';
    const said = sayIt(res.status, code, data && data.message);

    /* КАССУ ОТВЯЗАЛИ — стираем привязку здесь же. Урок донора: «иначе
       касса будет молча биться в закрытую дверь до конца смены и
       путать кассира». */
    if (res.status === 401 && (code === 'TERMINAL_REVOKED' || code === 'DEVICE_GONE')) {
      if (opts.onRevoked) await opts.onRevoked();
    }

    throw new NetError(res.status, code, said);
  }

  return data;
}

/**
 * СТУК СВЯЗИ. Спрашиваем, даже когда слать нечего.
 *
 * Через тот же сторож устройства, что и остальное — заодно узнаём, что
 * устройство не заблокировано и магазин не отключён. Пустой стук этого
 * не покажет.
 */
async function ping(opts) {
  await ask('/pos/ping', opts);
  return true;
}

/* ── СВЯЗЬ ГОВОРИТ ОДИН РАЗ ───────────────────────────────────────
 *
 * Пропажу и возврат называем ПО ОДНОМУ разу.
 *
 * Молчать нельзя: кассир бьёт чеки час, уверенный, что всё уходит, а
 * они копятся — и узнаёт при закрытии смены, когда сверка не сойдётся.
 *
 * Повторять каждые тридцать секунд тоже нельзя: сообщение закроет
 * товар, помешает пробивать, и кассир перестанет читать сообщения
 * вовсе — а потом пропустит важное.
 */
function makeNetWatch(say) {
  let down = false;
  return {
    good() {
      if (down) { down = false; say('Связь вернулась — чеки ушли на сервер', 'ok'); }
    },
    bad() {
      if (!down) { down = true; say('Связь пропала — чеки копятся и уйдут сами', 'warn'); }
    },
    get isDown() { return down; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { ask, ping, sayIt, NetError, OfflineError, makeNetWatch, SAID };
}
