/*
 * КАНАРЕЙКА: касса упала — мы узнали.
 *
 * Их слово точное. Птица в шахте падает первой, и все узнают о газе.
 *
 * Касса падает у клиента в Шымкенте. Кассир перезапускает её и
 * работает дальше — ему некогда звонить. Мы не узнаём НИКОГДА, а
 * падение повторяется каждый день у десяти клиентов, и мы думаем, что
 * всё хорошо.
 *
 * ДВА ИХ ПРАВИЛА:
 *   «дедуп по сообщению раз в минуту» — одна ошибка не должна залить
 *     сервер тысячей писем за смену;
 *   «любые сбои отправки молча глотаем» — отчёт о падении не имеет
 *     права уронить кассу ВТОРОЙ раз, уже своей ошибкой.
 */

/** Одно и то же сообщение шлём не чаще раза в минуту. */
const REPEAT_MS = 60000;

/** Кассу могли не привязать — тогда токена нет, но падение важнее. */
function makeCrashReporter({ fetchIt, getSettings, getState, now = () => Date.now() }) {
  const виделось = new Map();

  async function report(message, stack) {
    try {
      const msg = String(message || '').slice(0, 500);
      if (!msg) return false;

      /* ДЕДУП. Одна и та же ошибка в цикле отрисовки повторяется
         десять раз в секунду — без этого сервер получит тысячи писем и
         перестанет быть полезен. */
      const t = now();
      if (t - (виделось.get(msg) || 0) < REPEAT_MS) return false;
      виделось.set(msg, t);

      const settings = getSettings ? await getSettings() : {};
      const state = getState ? await getState() : {};

      /* ШЛЁМ НАПРЯМУЮ, а не через обычный путь к серверу: тот бросает
         при отказе и требует токен, а касса могла упасть ДО привязки —
         и это самый тяжёлый случай. */
      await fetchIt(String(settings.apiUrl || '').replace(/\/$/, '') + '/pos/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          stack: String(stack || '').slice(0, 2000),
          version: settings.version || '',
          accountId: state.accountId || null,
          registerId: state.cashRegisterId || null,
          at: new Date(t).toISOString(),
        }),
      });
      return true;
    } catch {
      /* СБОИ ОТПРАВКИ ГЛОТАЕМ. Отчёт о падении — последняя надежда, и
         он не имеет права уронить кассу ещё раз. */
      return false;
    }
  }

  return {
    report,

    /** Повесить на окно. Ловим и брошенное, и необработанное. */
    wire(win) {
      const onError = (e) => report(e.message, e.error && e.error.stack);
      const onReject = (e) => {
        const r = e.reason;
        report(r && r.message ? r.message : String(r), r && r.stack);
      };
      win.addEventListener('error', onError);
      win.addEventListener('unhandledrejection', onReject);
      return () => {
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onReject);
      };
    },

    /** Для проверок: сколько разных сообщений видели. */
    get seen() { return виделось.size; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { REPEAT_MS, makeCrashReporter };
}
