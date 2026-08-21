/*
 * ЧЕК: строки, количество, отмена.
 *
 * Их правило слияния взято и переложено на магазин:
 *
 *   «Тот же товар С ТЕМ ЖЕ набором модификаторов подряд — наращиваем
 *    количество; острый лагман и обычный лагман — разные строки.»
 *
 * В магазине модификаторов нет, но разное есть:
 *   ВЕСОВОЙ товар не сливается: 0.45 кг сыра и 0.6 кг — это два
 *     взвешивания, и кассир должен видеть оба;
 *   товар с ИЗМЕНЁННОЙ ЦЕНОЙ не сливается с обычным: иначе скидка
 *     расползётся на весь товар;
 *   товар со СКИДКОЙ НА ПОЗИЦИЮ — тоже отдельно.
 *
 * ЧТО НЕ ДЕЛАЕМ. Числа держим целыми (тиыны), а не дробными: 0.1 + 0.2
 * в дробных даёт 0.30000000000000004, и на сотне чеков итог разъедется
 * с копейками. В тенге дробей нет, но вес дробный — и цена × вес легко
 * даёт хвост.
 */

/** Итог строки: цена × количество минус скидка. Всегда целое. */
function lineSum(l) {
  const raw = Number(l.price) * Number(l.qty);
  return Math.round(raw) - Math.round(Number(l.discount || 0));
}

/** Итог чека. */
function cartTotal(cart, cartDiscount = 0) {
  const сумма = (cart || []).reduce((a, l) => a + lineSum(l), 0);

  /* СКИДКА ЧЕКА ВЫЧИТАЕТСЯ ЗДЕСЬ.
   *
   * Найдено проверкой дисплея: касса дала скидку 400, а итог оставался
   * 4 000. Покупатель увидел бы на дисплее одну сумму, а заплатил
   * другую — или заплатил бы полную, а скидка ушла бы в отчёт как
   * данная, и деньги осели бы в ящике.
   *
   * Ноль в минус не уходим: касса не платит покупателю. */
  return Math.max(0, сумма - (Number(cartDiscount) || 0));
}

/** Сколько всего штук: для шапки «в чеке 7». */
function cartCount(cart) {
  return (cart || []).reduce((a, l) => a + (Number(l.qty) % 1 ? 1 : Number(l.qty)), 0);
}

/**
 * МОЖНО ЛИ СЛИТЬ со строкой.
 *
 * Сливаем только точно такое же: тот же товар, обычная цена, без
 * скидки, не весовой, не маркированный.
 *
 * МАРКИРОВАННЫЙ НЕ СЛИВАЕМ НАРОЧНО: у каждой пачки своя марка, и
 * держать их в одной строке значит путать, какая к чему.
 */
function canMerge(line, g) {
  if (!line || line.productId !== g.id) return false;
  if (line.qty % 1) return false;            // весовой
  if (line.priceChanged || line.discount) return false;
  if (line.marked || g.marked) return false;
  return true;
}

/**
 * ДОБАВИТЬ ТОВАР.
 *
 * Сливаем с ПОСЛЕДНЕЙ строкой, а не с любой в чеке — их правило.
 * Иначе кассир пробил хлеб, потом молоко, потом снова хлеб — и второй
 * хлеб прыгнул наверх, к первому. Кассир смотрит на конец чека и не
 * находит того, что сейчас пробил.
 */
function addToCart(cart, g, qty = 1, newId) {
  const n = Number(qty) || 1;

  /* ИЩЕМ СРЕДИ ВСЕХ СТРОК, А НЕ ТОЛЬКО В ПОСЛЕДНЕЙ.
   *
   * У донора слияние «подряд»: в ресторане официант вводит блюда одно
   * за другим, и последней строки хватает.
   *
   * В магазине покупатель выкладывает товар ВПЕРЕМЕШКУ — три пачки
   * молока пройдут через сканер с хлебом между ними. Найдено
   * проверкой: в чеке выходило «Молоко ×1» трижды, и покупатель решил
   * бы, что его обсчитали. */
  const last = cart.find((l) => canMerge(l, g)) || null;

  if (canMerge(last, g) && n % 1 === 0) {
    last.qty += n;
    return { line: last, merged: true };
  }

  const line = {
    id: newId(),
    productId: g.id,
    name: g.name,
    price: Number(g.price) || 0,
    qty: n,
    unit: g.unit || 'шт',
    barcodes: g.barcodes || [],
    marked: !!g.marked,
    /* ВИД МАРКИРОВКИ НЕСЁМ В СТРОКУ. Найдено живьём: строка теряла
       его, и проверка возраста не срабатывала — пиво уходило без
       вопроса о документе.
       «marked» говорит «нужна марка», а «marking» — ЧТО это за товар:
       табак, алкоголь, пиво. Возраст спрашивают по второму. */
    marking: g.marking || null,
    ageLimit: g.ageLimit || null,
    codes: [],            // марки соберутся на этапе 14
    discount: 0,
    priceChanged: false,
  };
  cart.push(line);
  return { line, merged: false };
}

/**
 * ПРЕДЕЛ КОЛИЧЕСТВА.
 *
 * Опечатка в одну лишнюю цифру давала чек на миллион: кассир набрал 99
 * вместо 9, промахнулся мимо кнопки — и покупатель видит сумму с
 * шестью нулями, а отменять её через старшего, при очереди.
 *
 * Тысяча за раз — верхняя граница здравого смысла для магазина.
 */
const QTY_MAX = 1000;

function qtyAllowed(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return { ok: false, said: 'Количество должно быть больше нуля' };
  if (v > QTY_MAX) {
    return { ok: false, said: `${v} — похоже на опечатку. Больше ${QTY_MAX} за раз не бывает` };
  }
  return { ok: true };
}

/**
 * ПОСТАВИТЬ КОЛИЧЕСТВО.
 *
 * Уменьшение требует разрешения — это след для владельца: кассир мог
 * пробить товар, а потом убрать его из чека, положив себе.
 *
 * @param allow  свёртка разрешения из этапа 9
 */
/* СНЯТИЕ МАРОК БЕРЁТСЯ ЗДЕСЬ, а не передаётся снаружи.
 *
 * Раньше свёртку передавали при вызове — и путь, который забыли
 * передать, оставался без снятия. Ровно так я пропустил ввод цифрами
 * в части 15, починив кнопку «−».
 *
 * Теперь забыть невозможно: свёртка одна и берётся изнутри. */
function trimMarksOf(line) {
  if (typeof require === 'function' && typeof module !== 'undefined') {
    return require('./marks.js').trimMarks(line);
  }
  return (typeof trimMarks === 'function') ? trimMarks(line) : 0;
}

async function setQty(cart, line, n, { allow }) {
  const стало = Number(n);
  const было = Number(line.qty);

  /* НОЛЬ ЗНАЧИТ «УБРАТЬ», А НЕ ОШИБКА.
   *
   * Найдено проверкой: убрать строку было НЕЛЬЗЯ ВОВСЕ — проверка
   * «больше нуля» била раньше. Покупатель передумал брать хлеб, а
   * кассир не может его вынуть: пришлось бы отменять весь чек и
   * пробивать заново, при очереди.
   *
   * Проверяем предел только для НАСТОЯЩЕГО количества. */
  if (стало > 0) {
    const проверка = qtyAllowed(стало);
    if (!проверка.ok) return { ok: false, said: проверка.said };
  } else if (!Number.isFinite(стало) || стало < 0) {
    return { ok: false, said: 'Количество не может быть отрицательным' };
  }

  if (стало < было) {
    const r = await allow(стало <= 0 ? 'remove_item' : 'reduce_qty');
    if (!r.ok) return r;

    if (стало <= 0) {
      cart.splice(cart.indexOf(line), 1);
      return { ok: true, removed: true, approval: r };
    }

    line.qty = стало;
    // Марки снимаются ВСЕГДА: свёртка одна на все пути уменьшения.
    const снято = trimMarksOf(line);
    return { ok: true, approval: r, marksDropped: снято };
  }

  line.qty = стало;
  return { ok: true };
}

/** Убрать строку целиком. */
async function removeLine(cart, line, { allow }) {
  return setQty(cart, line, 0, { allow });
}

/*
 * ОТЛОЖЕННЫЕ ЧЕКИ.
 *
 * Покупатель забыл кошелёк, ушёл за деньгами, а за ним очередь.
 * Откладываем его чек и берём следующего.
 *
 * ЛЕЖАТ НА ДИСКЕ, а не в памяти: касса может перезапуститься, пока
 * человек ходит, и товар в чеке — это его выбор, а не наш.
 */
async function parkCart(store, cart, { newId, who }) {
  if (!cart.length) return { ok: false, said: 'Чек пуст — откладывать нечего' };

  const st = await store.getState();
  const parked = [...(st.parked || [])];

  parked.push({
    id: newId(),
    at: new Date().toISOString(),
    by: who || null,
    total: cartTotal(cart),
    lines: JSON.parse(JSON.stringify(cart)),   // копия: чек больше не наш
  });

  await store.saveState({ parked });
  return { ok: true, count: parked.length };
}

/** Вернуть отложенный чек. Он уходит из списка: чек один, не копия. */
async function unparkCart(store, id) {
  const st = await store.getState();
  const parked = st.parked || [];
  const found = parked.find((p) => p.id === id);
  if (!found) return { ok: false, said: 'Этот чек уже забрали' };

  await store.saveState({ parked: parked.filter((p) => p.id !== id) });
  return { ok: true, lines: found.lines };
}

if (typeof module !== 'undefined') {
  module.exports = {
    lineSum, cartTotal, cartCount, canMerge, addToCart,
    QTY_MAX, qtyAllowed, setQty, removeLine, parkCart, unparkCart,
  };
}
