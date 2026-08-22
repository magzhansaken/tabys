/*
 * ОЧЕРЕДЬ ЧЕКОВ: отправка на сервер.
 *
 * ГЛАВНОЕ ИХ ПРАВИЛО ВЗЯТО ЦЕЛИКОМ:
 *
 *   «Отклонённые сервером НЕ ВЫБРАСЫВАЕМ молча. Раньше они снимались с
 *    очереди "чтобы не крутить вечно" — и чек исчезал навсегда. Кассир
 *    видел сумму, гость заплатил, а в отчёте пусто, и никто не знал
 *    почему.
 *
 *    Теперь откладываем в отдельный ящик: очередь не забивается, но
 *    деньги остаются на виду.»
 *
 * У МЕНЯ В ПРОШЛОЙ КАССЕ БЫЛА ОБРАТНАЯ БЕДА: отклонённый оставался в
 * очереди и уходил снова каждые тридцать секунд. Сервер отклонял
 * снова. Очередь не пустела НИКОГДА — кассир видел «не отправлено: 3»
 * вечно и переставал верить счётчику.
 *
 * ДВЕ БЕДЫ, И ОБЕ ПРО ОДНО: чек с деньгами не доходил до отчёта.
 */

/** Сколько чеков шлём за раз. Больше — запрос долгий, и по мобильному он оборвётся. */
/* Чем сервер отвечает, когда чек НЕ ПРИМЕНЁН. «quarantined» —
   принял, но применить не смог; такой чек деньгами не стал. */
const ПЛОХИЕ = ['error', 'quarantined', 'rejected'];

const BATCH = 50;

/**
 * ОТПРАВИТЬ НАКОПЛЕННОЕ.
 *
 * @returns { reached, sent, rejected, left } — связь, ушло, отклонено, осталось
 */
async function flush({ ask, store, settings, deviceToken, employeeId }) {
  /* Мост отвечает обёрткой { ok, data } — разворачиваем. Иначе
     очередь всегда кажется пустой, и чеки не уходят. */
  const pending = развернуть(await store.outboxPending());
  if (!pending.length) return { reached: null, sent: 0, rejected: 0, left: 0 };

  const пачка = pending.slice(0, BATCH);

  let ответ;
  try {
    ответ = await ask('/sync/push', {
      settings, deviceToken, method: 'POST',
      body: {
        /* ИМЕНА СОБЫТИЙ СВОДИМ ПОД СЕРВЕР.
         *
         * Найдено на боевом сервере: девятнадцать чеков в карантине.
         *   «refund» сервер НЕ ЗНАЕТ — возвраты не принимались вовсе;
         *   «cash_move» он зовёт «cash_operation»;
         *   у смены пустая метка времени, а поле обязательно. */
        events: пачка.map((e) => переведи(e, employeeId)),
      },
    });
  } catch (e) {
    /* СЕРВЕР МОЛЧИТ — очередь ЖДЁТ. Ничего не трогаем: чеки целы, уйдут
       при следующей связи. Пробрасываем признак, чтобы наверху отличали
       «нет связи» от «чек отклонён». */
    return { reached: false, sent: 0, rejected: 0, left: pending.length, error: e };
  }

  const results = (ответ && ответ.results) || [];

  /* ДУБЛЬ СЧИТАЕТСЯ ПРИНЯТЫМ — их правило.
   *
   * Связь оборвалась на полпути: сервер чек записал, а касса ответа не
   * получила. При следующей попытке он отвечает «уже есть».
   *
   * Если не считать это успехом, чек будет висеть в очереди ВЕЧНО, а
   * счётчик «не отправлено» никогда не обнулится. */
  const ушли = results
    /* КАРАНТИН — ЭТО НЕ «УШЛО». Сервер отвечает «quarantined», когда
       принял чек, но НЕ ПРИМЕНИЛ: например, строка без ключа товара —
       списывать со склада нечего.
       Касса считала такой чек ушедшим и убирала из очереди МОЛЧА:
       деньги взяты, в отчёте пусто, и никто не знает. */
    .filter((x) => !ПЛОХИЕ.includes(x.result))
    .map((x) => x.id);

  const отбиты = results.filter((x) => ПЛОХИЕ.includes(x.result));

  /* ОТКЛОНЁННЫЕ — В ОТДЕЛЬНЫЙ ЯЩИК, а не обратно в очередь и не в
     мусор. Их правило: «очередь не забивается, но деньги остаются на
     виду». */
  if (отбиты.length) {
    const записи = отбиты.map((b) => {
      const исходный = пачка.find((e) => e.id === b.id);
      return {
        id: b.id,
        number: исходный && исходный.payload && исходный.payload.number,
        total: исходный && исходный.payload && исходный.payload.total,
        entity: исходный && исходный.entity,
        reason: b.message || b.error || 'сервер не принял',
        at: new Date().toISOString(),
      };
    });
    await store.rejectedAdd(записи);
  }

  // Снимаем с очереди И ушедшие, И отклонённые: последние теперь в ящике.
  const снять = [...ушли, ...отбиты.map((x) => x.id)];
  if (снять.length) await store.outboxAck(снять);

  /* СЕРВЕР МОГ ОТВЕТИТЬ НЕ ПРО ВСЁ. Неотвеченное остаётся в очереди и
     уйдёт следующей попыткой — а не пропадёт вместе с ответом. */
  const осталось = развернуть(await store.outboxPending()).length;

  return {
    reached: true,
    sent: ушли.length,
    rejected: отбиты.length,
    left: осталось,
    // Ещё есть что слать: зовём себя снова, не дожидаясь таймера.
    more: осталось > 0 && пачка.length === BATCH,
  };
}

/**
 * КОЛЬЦО ОТПРАВКИ.
 *
 * Раз в полминуты пробуем отправить. Если ушла целая пачка и осталось
 * ещё — идём сразу дальше, не ждём.
 *
 * СВЯЗЬ ПРОВЕРЯЕТСЯ ОТДЕЛЬНО от очереди: пустая очередь не значит
 * «сеть жива». В прошлой кассе она давала зелёную точку всегда, и
 * кассир бил чеки при мёртвой сети.
 */
function makeSyncLoop({ ask, ping, store, getSettings, getState, watch, onChange, every = 30000 }) {
  let timer = null;
  let busy = false;

  async function once() {
    if (busy) return;
    busy = true;
    try {
      const settings = await getSettings();
      const state = await getState();
      if (!state.deviceToken) return;      // касса не привязана

      let r = await flush({ ask, store, settings,
        deviceToken: state.deviceToken,
        employeeId: state.employee && state.employee.id });

      // Пачка ушла целиком — гоним дальше сразу.
      let кругов = 0;
      while (r.more && кругов < 20) {
        r = await flush({ ask, store, settings, deviceToken: state.deviceToken,
          employeeId: state.employee && state.employee.id });
        кругов += 1;
      }

      if (r.reached === null) {
        /* Слать нечего — но связь всё равно проверяем. Иначе кассир
           видит зелёную точку при мёртвой сети. */
        try { await ping({ settings, deviceToken: state.deviceToken }); watch.good(); }
        catch { watch.bad(); }
      } else if (r.reached) {
        watch.good();
      } else {
        watch.bad();
      }

      if (onChange) onChange(r);
    } finally {
      busy = false;
    }
  }

  return {
    once,
    start() { if (!timer) timer = setInterval(once, every); once(); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/**
 * ЧТО ПОКАЗАТЬ КАССИРУ ПРО ОЧЕРЕДЬ.
 *
 * Не просто число: кассир должен понимать, беда это или нет.
 */
function queueNote({ left, rejected, lastSync, netDown }) {
  const части = [];

  if (left > 0) {
    части.push(`не отправлено: ${left}`);
  }

  if (netDown && lastSync) {
    /* КОГДА УШЛО В ПОСЛЕДНИЙ РАЗ. Без этого «не отправлено: 3» не
       говорит, копится это минуту или третий час. Связь могла
       вернуться и снова пропасть, а кассир думает, что всё стоит с
       утра. */
    const at = new Date(lastSync);
    части.push('ушло в ' + at.toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit' }));
  }

  if (rejected > 0) {
    части.push(`сервер не принял: ${rejected}`);
  }

  return части.length ? части.join(' · ') : null;
}

/**
 * ЧЕК В ВИД СЕРВЕРА.
 *
 * НАЙДЕНО ВЛАДЕЛЬЦЕМ: продажу пробили, а в кабинете её нет. Сервер
 * отвечал 500, и чек НАВСЕГДА оставался в очереди — деньги взяты,
 * учёта нет.
 *
 * Касса зовёт оплату way/cash/card, сервер ждёт payment. Имена строк
 * тоже свои: discountSum вместо discount, у каждой строки свой total.
 *
 * Переводим ЗДЕСЬ, а не в самом чеке: чек читает кассир на ленте, и
 * менять его имена значит менять печать, отчёты и возвраты разом.
 */
/**
 * СОБЫТИЕ В ВИД СЕРВЕРА.
 *
 * Касса и сервер зовут одно разными словами. Пока их не свести, чек
 * уходит в карантин: деньги взяты, а в отчёте пусто.
 */
function переведи(e, employeeId) {
  /* ВОЗВРАТ — ЭТО ТОТ ЖЕ ЧЕК со ссылкой на исходный.
     Сервер не знает слова «refund»: у него возвратность несёт
     return_of_id, а не отдельный вид события. */
  const вид = e.entity === 'refund' ? 'sale'
    : e.entity === 'cash_move' ? 'cash_operation'
      : e.entity;

  const тело = вид === 'sale' ? чекДляСервера(e.payload)
    : вид === 'cash_operation' ? движениеДляСервера(e.payload)
      : e.payload;

  return {
    id: e.id,
    entity: вид,
    entityId: e.entityId,
    op: e.op,
    payload: тело,
    clientSeq: e.clientSeq,
    /* МЕТКА ВРЕМЕНИ ОБЯЗАТЕЛЬНА. Без неё сервер отбивал смену, а за
       смену цеплялись все чеки: «sale_shift_id_fkey — смены нет».
       Берём из самого события, а нет — ставим текущее. */
    clientTs: e.clientTs || (e.payload && (e.payload.at || e.payload.openedAt))
      || new Date().toISOString(),
    employeeId: e.employeeId || employeeId,
  };
}

/**
 * ДВИЖЕНИЕ ДЕНЕГ В ВИД СЕРВЕРА.
 *
 * Касса зовёт причину «note», сервер ждёт «comment». И просит имя
 * движения отдельным полем — иначе в отчёте владельца будет
 * «cash_out» вместо «Изъятие из кассы».
 */
function движениеДляСервера(m) {
  if (!m) return m;
  return {
    /* ВИДЫ У СЕРВЕРА СВОИ: deposit, withdrawal, opening_float,
       collection. Касса зовёт их по-своему — сводим, иначе движение
       уходит в карантин, и ящик в отчёте не сойдётся с настоящим. */
    kind: ВИД_ДВИЖЕНИЯ[m.kind || m.type] || (m.kind || m.type),
    amount: Math.abs(Number(m.amount) || 0),
    comment: m.note || m.comment || null,
    /* Имя по-русски: владелец читает отчёт, а не наши слова. */
    name: MOVE_NAMES[m.kind || m.type] || null,
    shiftId: m.shiftId || null,
    approvedBy: m.approvedBy || null,
    openingFloat: m.openingFloat,
  };
}

/* Виды движения: слева как зовёт касса, справа как ждёт сервер. */
const ВИД_ДВИЖЕНИЯ = {
  cash_in: 'deposit',
  cash_out: 'withdrawal',
  collection: 'collection',
  opening: 'opening_float',
};

/* Имена движений по-русски — те же, что видит кассир на кассе. */
const MOVE_NAMES = {
  cash_in: 'Внесение в кассу',
  cash_out: 'Изъятие из кассы',
  collection: 'Инкассация',
};

function чекДляСервера(r) {
  if (!r) return r;

  const строки = (r.items || []).map((l) => ({
    productId: l.productId || l.id,
    qty: Number(l.qty) || 0,
    price: Number(l.price) || 0,
    discountSum: Number(l.discount) || 0,
    total: Math.round((Number(l.price) || 0) * (Number(l.qty) || 0))
      - (Number(l.discount) || 0),
    /* Марки едут в строке: без них товар не выйдет из оборота, а
       налоговая спросит именно за них. */
    marks: l.codes && l.codes.length ? l.codes : undefined,
  }));

  const подытог = строки.reduce((a, l) => a + l.total, 0);

  return {
    localNumber: r.number,
    shiftId: r.shiftId || null,
    subtotal: подытог,
    discountSum: Number(r.discount) || 0,
    total: Number(r.total) || 0,
    rounding: 0,
    items: строки,

    /* ОПЛАТА ОТДЕЛЬНЫМ УЗЛОМ. Смешанная едет обеими частями: карта
       точно, наличными добирают — иначе в отчёте магазина деньги
       разойдутся с ящиком. */
    payment: {
      cash: Number(r.cash) || 0,
      card: Number(r.card) || 0,
      qr: r.way === 'qr' ? (Number(r.total) || 0) : 0,
      credit: r.way === 'credit' ? (Number(r.total) || 0) : 0,
      bonus: 0,
      change: Number(r.change) || 0,
    },

    // Возврат несёт ссылку на свой чек, а не знак минус.
    refundOf: r.refundOf || r.returnOf || null,
  };
}

if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { развернуть } = require('./common.js');
  module.exports = { BATCH, чекДляСервера, переведи, движениеДляСервера, flush, makeSyncLoop, queueNote };
}
