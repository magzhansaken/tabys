/*
 * ПРАВА И ПРЕДЕЛЫ.
 *
 * Два правила стоят рядом, и оба нужны.
 *
 * ПРАВИЛО МАГАЗИНА: «отмены только с разрешения». Его ставит владелец,
 * оно одно на всех и про магазин.
 *
 * ПРАВО ЧЕЛОВЕКА: «этот кассир может отменять сам». Оно про людей.
 *
 * Их довод: «У кого нет права брать деньги — тому и кнопки оплаты
 * видеть незачем. Иначе он жмёт "Оплатить", получает запрос PIN и не
 * понимает, что сделал не так».
 *
 * ЧЕМ ЭТО КОНЧАЛОСЬ У МЕНЯ. Правило было ТОЛЬКО магазинное, и старший
 * кассир стоял у СВОЕЙ кассы и вводил СВОЙ ЖЕ код, чтобы отменить
 * позицию. Касса не знала, кто перед ней.
 */

/* Действия, которые касса охраняет. Каждое — про деньги или про товар,
   уходящий мимо кассы. */
const ACTIONS = {
  remove_item:  'Удаление позиции',
  reduce_qty:   'Уменьшение количества',
  discount:     'Скидка',
  price_change: 'Изменение цены',
  refund:       'Возврат по чеку',
  refund_free:  'Возврат без чека',
  cash_out:     'Изъятие из кассы',
  cash_in:      'Внесение в кассу',
};

/* Три уровня правила магазина. */
const LEVELS = { everyone: 'всем', admin_only: 'только с разрешения', nobody: 'запрещено' };

/**
 * Может ли ЧЕЛОВЕК сам, без старшего.
 *
 * Владелец и старший смены могут всегда: они и есть последняя подпись,
 * звать им некого.
 */
function selfAllowed(employee, action) {
  if (!employee) return false;
  if (employee.isOwner || employee.isShiftAdmin) return true;
  const p = employee.permissions;
  if (!p) return false;
  // Права приходят разделами: { pos: { view, create, void } }
  const pos = p.pos || {};
  const map = {
    remove_item: pos.void, reduce_qty: pos.void,
    discount: pos.discount, price_change: pos.price,
    refund: pos.refund, refund_free: pos.refund,
    cash_out: pos.cash, cash_in: pos.cash,
  };
  return map[action] === true;
}

/**
 * РЕШИТЬ, НУЖНО ЛИ РАЗРЕШЕНИЕ.
 *
 * @returns 'free'   — можно молча
 *          'senior' — нужен код старшего
 *          'never'  — владелец запретил вовсе
 */
function decide({ settings, employee, action }) {
  const level = (settings && settings.actions && settings.actions[action]) || 'everyone';

  // Запрет владельца сильнее любых прав: это его магазин и его деньги.
  if (level === 'nobody') return 'never';

  // Магазин разрешил всем — идём молча.
  if (level === 'everyone') return 'free';

  /* Магазин требует разрешения, НО право человека сильнее: старший не
     должен звать сам себя. Иначе он стоит у своей кассы и вводит свой
     же код, а очередь ждёт. */
  if (selfAllowed(employee, action)) return 'free';

  return 'senior';
}

/**
 * ПРОВЕРИТЬ КОД СТАРШЕГО.
 *
 * Их правило, взятое целиком: «Пад старшего работает и без интернета:
 * если старший уже входил на этой кассе, его PIN узнаваем локально, и
 * права проверяются по-настоящему. Совсем незнакомый PIN без связи —
 * отказ пропускается с честной пометкой в отчёт: гость уже отказался,
 * ЗАЛ НЕ МОЖЕТ ЖДАТЬ РОУТЕР».
 *
 * И их же различение: «сервер жив и сказал „не подошёл" — это про PIN,
 * не про связь».
 *
 * Шесть исходов, каждый разобран.
 */
async function approve({ ask, store, settings, deviceToken, pin, action, pinPrint, requestedBy }) {
  try {
    const d = await ask('/pos/approve', {
      settings, deviceToken, method: 'POST',
      body: {
        pin, action,
        /* КТО ПРОСИТ — КЛЮЧ вошедшего кассира, а не имя.
         *
         * Найдено проверкой живьём: я слал слово, база отбила ключ, и
         * сервер упал с «внутренней ошибкой». Касса честно сказала
         * «сервер отвечает с ошибкой» и действие не пропустила — но
         * кассир упёрся бы в стену на ровном месте.
         *
         * В журнале должны остаться оба: кто просил и кто разрешил.
         * Иначе видно «разрешил Ерлан», а кому — неясно. */
        requestedBy: requestedBy || null,
      },
    });
    /* СЕРВЕР ОТВЕЧАЕТ «approved», А НЕ «ok».
     *
     * Найдено проверкой живьём: сервер разрешил (approved: true), а
     * касса не поняла и сказала «Код не подошёл». Старший стоял бы у
     * кассы с ВЕРНЫМ кодом и не мог отменить позицию.
     *
     * Берём оба вида: сервер могут поправить, а касса не должна
     * ломаться от переименованного поля. */
    const разрешил = d && (d.approved === true || d.ok === true);
    if (разрешил) {
      return {
        ok: true,
        byId: d.approvedBy || d.employeeId || d.id || null,
        byName: d.name || d.approvedName || 'старший',
        note: null,
      };
    }
    return { ok: false, said: (d && (d.reason || d.message)) || 'Код не подошёл' };
  } catch (e) {
    /* Сервер ЖИВ и отказал — верим ему. Пропуск не смотрим: старшего
       могли лишить прав сегодня утром. */
    if (e && e.serverAnswered) {
      return { ok: false, said: e.message || 'Код не подошёл' };
    }

    // Сервер молчит — смотрим пропуска на кассе.
    const print = await pinPrint(pin, deviceToken);
    const pass = await store.passRead(print);

    if (!pass) {
      /* Незнакомый код без связи. Их правило: очередь важнее строгости,
         но ОТЧЁТ УЗНАЕТ ПРАВДУ — владелец увидит, что подпись не
         проверена, и спросит. */
      return {
        ok: true, byId: null, byName: 'без проверки',
        note: 'без связи, код старшего не проверен',
      };
    }

    const кто = pass.employee || {};
    if (!(кто.isOwner || кто.isShiftAdmin) && !selfAllowed(кто, action)) {
      // Код УЗНАН, но человек не вправе — отказ настоящий.
      return { ok: false, said: 'Этот код не даёт права разрешать' };
    }

    return {
      ok: true, byId: кто.id || null, byName: кто.name || 'старший',
      note: 'код старшего проверен на кассе (без связи)',
    };
  }
}

/**
 * ПРЕДЕЛ СКИДКИ — два потолка, берётся МЕНЬШИЙ.
 *
 * Потолок магазина: «больше 30% не даём никому» — правило владельца.
 * Потолок человека: «этот кассир до 10%» — правило про людей.
 *
 * Было «всё или ничего»: можно скидки — значит любую, хоть сто
 * процентов. Кассир по сговору отдавал товар почти даром, и в отчёте
 * это выглядело обычной продажей со скидкой.
 *
 * А запрет вовсе изматывает: старшего зовут двадцать раз за смену
 * из-за мелочи, он перестаёт вникать и жмёт код не глядя — тогда
 * охрана не работает вовсе, а все думают, что защита есть.
 */
function discountCap({ settings, employee, base }) {
  const shopPct = (settings && settings.discountMaxPct != null) ? settings.discountMaxPct : 100;
  const myPct = employee && employee.discountLimitPct;

  // Владелец и админ без предела: они последняя подпись.
  const личный = (employee && (employee.isOwner || employee.isShiftAdmin))
    ? null
    : (myPct == null ? null : myPct);

  const pct = личный == null ? shopPct : Math.min(shopPct, личный);
  return {
    pct,
    sum: Math.floor((base || 0) * pct / 100),
    // Чей предел сработал — чтобы сказать кассиру правду.
    mine: личный != null && личный <= shopPct,
  };
}

/** Сказать кассиру, чей предел и что будет сверх него. */
function capText(cap) {
  if (cap.pct >= 100) return '';
  return cap.mine
    ? `ваш предел ${cap.pct}% (сверх — только со старшим)`
    : `больше ${cap.pct}% не даём`;
}

if (typeof module !== 'undefined') {
  module.exports = { ACTIONS, LEVELS, selfAllowed, decide, approve, discountCap, capText };
}
