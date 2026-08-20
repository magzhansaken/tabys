/*
 * ПРАВА И ПРЕДЕЛЫ.
 *
 * Два источника, и оба нужны:
 *
 *   ПРАВИЛО МАГАЗИНА — «отмены только с разрешения», «больше 30% не
 *   даём никому». Его ставит владелец, и оно одно на всех.
 *
 *   ПРАВО ЧЕЛОВЕКА — «этот кассир может отменять», «этот до 10%». Оно
 *   про людей.
 *
 * Их правило: право сильнее уклада. Их довод дословно:
 *
 *   «У кого нет права брать деньги — тому и кнопки оплаты видеть
 *    незачем. Иначе он жмёт "Оплатить", получает запрос PIN и не
 *    понимает, что сделал не так.»
 *
 * У меня в прошлой кассе был только первый источник. Значит СТАРШИЙ
 * КАССИР ЗВАЛ САМ СЕБЯ: стоял у своей кассы и вводил свой же код,
 * потому что касса не знала, кто перед ней.
 */

/** Уровни, которые владелец ставит действию в кабинете. */
const LEVELS = ['everyone', 'admin_only', 'nobody'];

/** Человеческие названия действий — для окон и журнала. */
const ACTIONS = {
  remove_item:  'Удаление позиции',
  reduce_qty:   'Уменьшение количества',
  discount:     'Скидка',
  price_change: 'Изменение цены',
  refund:       'Возврат по чеку',
  refund_free:  'Возврат без чека',
  cash_out:     'Изъятие из кассы',
  cash_in:      'Внесение в кассу',
  open_drawer:  'Открыть ящик',
};

/** Старший ли человек: владелец или назначенный старшим смены. */
function isSenior(employee) {
  return !!(employee && (employee.isOwner || employee.isShiftAdmin));
}

/**
 * ПОТОЛОК СКИДКИ — берём МЕНЬШИЙ из двух.
 *
 * Правило нельзя обойти, зайдя с другой стороны: ни через настройку
 * магазина, ни через личный предел.
 *
 * Пусто у человека значит «без личного предела» — тогда правит
 * магазин. Так у владельца: он и есть последняя подпись.
 */
function discountCap({ shopMaxPct, employee }) {
  const shop = shopMaxPct == null ? 100 : Number(shopMaxPct);
  const mine = employee && employee.discountLimitPct;
  if (mine == null) return shop;
  return Math.min(shop, Number(mine));
}

/**
 * ЧТО НУЖНО ДЛЯ ДЕЙСТВИЯ.
 *
 * Возвращает одно из:
 *   'free'   — можно молча;
 *   'senior' — нужен старший (свой или чужой код);
 *   'never'  — владелец запретил вовсе.
 */
function needFor(action, { settings, employee }) {
  const level = (settings && settings.actions && settings.actions[action]) || 'everyone';

  if (level === 'nobody') return 'never';
  if (level === 'everyone') return 'free';

  /* ПРАВО ЧЕЛОВЕКА СИЛЬНЕЕ НАСТРОЙКИ. Старший разрешает молча — иначе
     он стоит у своей кассы и вводит свой же код, а очередь ждёт. */
  if (isSenior(employee)) return 'free';

  return 'senior';
}

/**
 * РАЗРЕШИТЬ ДЕЙСТВИЕ.
 *
 * Возвращает подпись — кто разрешил — или отказ. Подпись идёт в журнал:
 * владелец должен видеть, кто снял позицию и по чьему слову.
 *
 * @param askPin  функция, которая спрашивает код старшего у экрана
 */
async function allow(action, {
  settings, employee, askPin, ask, store, deviceToken, net,
}) {
  const title = ACTIONS[action] || action;
  const need = needFor(action, { settings, employee });

  if (need === 'never') {
    return { ok: false, said: `${title}: владелец запретил это действие` };
  }

  if (need === 'free') {
    /* Записываем, КТО разрешил, даже если код никто не вводил: в
       журнале должно остаться имя. Пометки «без связи» тут нет
       нарочно — старший стоит за кассой сам, связь ни при чём. */
    return {
      ok: true,
      approvedBy: employee && employee.id || null,
      approvedName: employee && employee.name || null,
      offlineNote: null,
      silent: true,      // окна не показывали
    };
  }

  // Нужен старший. Спрашиваем код — окно даёт его экран.
  const pin = await askPin(title);
  if (!pin) return { ok: false, cancelled: true };

  return approveByPin(pin, { ask, store, deviceToken, settings, action });
}

/**
 * ПРОВЕРИТЬ КОД СТАРШЕГО.
 *
 * Шесть случаев, и каждый разобран. Их правило: «сервер жив и сказал
 * „не подошёл" — это про PIN, не про связь».
 */
async function approveByPin(pin, { ask, store, deviceToken, settings, action }) {
  try {
    const d = await ask('/pos/approve', {
      settings, deviceToken, method: 'POST', body: { pin, action },
    });
    if (d && d.ok === false) {
      return { ok: false, said: d.reason || 'Код не подошёл' };
    }
    return {
      ok: true,
      approvedBy: d.employeeId || d.id || null,
      approvedName: d.name || 'старший',
      offlineNote: null,
    };
  } catch (e) {
    /* Сервер ЖИВ и отказал — это про код, а не про связь. Верим. */
    if (e && e.serverAnswered) {
      return { ok: false, said: e.message || 'Код не подошёл' };
    }

    /* Сервер молчит. Их правило: «зал не может ждать роутер».
       Смотрим пропуска — старший мог входить на этой кассе. */
    const { pinPrint } = require('./passes.js');
    const print = await pinPrint(pin, deviceToken);
    const pass = await store.passRead(print);

    if (pass && isSenior(pass.employee)) {
      return {
        ok: true,
        approvedBy: pass.employee.id,
        approvedName: pass.employee.name,
        // Пометка идёт В ОТЧЁТ: владелец должен видеть, что подпись
        // проверена кассой, а не сервером.
        offlineNote: 'код старшего проверен на кассе (без связи)',
      };
    }

    if (pass) {
      // Код узнан, но человек не старший — отказ настоящий.
      return { ok: false, said: 'Этот код не даёт права разрешать' };
    }

    /* Незнакомый код без связи. Их правило: «отказ пропускается с
       честной пометкой в отчёт: гость уже отказался, зал не может
       ждать роутер».
       В магазине то же: покупатель стоит, товар лишний в чеке. */
    return {
      ok: true,
      approvedBy: null,
      approvedName: 'без проверки',
      offlineNote: 'без связи, код старшего не проверен',
    };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { LEVELS, ACTIONS, isSenior, discountCap, needFor, allow, approveByPin };
}
