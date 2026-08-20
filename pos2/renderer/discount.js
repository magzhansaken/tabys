/*
 * СКИДКИ: на позицию и на чек.
 *
 * ГЛАВНЫЙ ИХ УРОК ВЗЯТ ЦЕЛИКОМ:
 *
 *   «Скидка хранится СУММОЙ — если после скидки в чек добавили блюдо,
 *    сумма скидки не плывёт.»
 *
 * Чем это грозит в магазине. Кассир дал 10% на чек в 5 000 — скидка
 * 500. Покупатель вспомнил про пакет, добавили 30 ₸.
 *
 * Хранили бы процентом: 10% от 5 030 = 503. Скидка выросла САМА, и
 * кассир её не давал. Мелочь на одном чеке, но за месяц набегает, и в
 * отчёте владельца эти деньги ниоткуда.
 *
 * Хранится суммой: 500 как договорились.
 *
 * ДВА ПОТОЛКА, ВЗЯТО ИЗ ЭТОГО ЧАТА: магазина и человека. Берётся
 * меньший — правило не обойти, зайдя с другой стороны.
 */

/** Обычные скидки: кассир жмёт один раз вместо набора цифр. */
const PRESETS = [5, 10, 15];

/**
 * ПЕРЕСЧЁТ ПРОЦЕНТА В СУММУ.
 *
 * Считаем ОДИН РАЗ, в момент нажатия — дальше живёт сумма.
 */
function pctToAmount(base, pct) {
  return Math.round((Number(base) || 0) * (Number(pct) || 0) / 100);
}

/** И обратно — только чтобы показать кассиру, сколько это процентов. */
function amountToPct(base, amount) {
  const b = Number(base) || 0;
  if (!b) return 0;
  return Math.round((Number(amount) || 0) * 1000 / b) / 10;   // один знак
}

/**
 * ПРОВЕРИТЬ СКИДКУ.
 *
 * @returns { ok } или { ok:false, said } или { ok:false, needSenior, cap }
 */
function checkDiscount(amount, { base, capPct }) {
  const a = Math.round(Number(amount) || 0);
  const b = Number(base) || 0;

  if (!Number.isFinite(a) || a < 0) {
    return { ok: false, said: 'Скидка не может быть отрицательной' };
  }
  if (a === 0) return { ok: true, amount: 0 };   // снять скидку можно всегда

  /* СКИДКА БОЛЬШЕ ЧЕКА. Касса не должна платить покупателю: итог ушёл
     бы в минус, и в отчёте появился бы отрицательный чек. */
  if (a > b) {
    return { ok: false, said: `Скидка больше суммы — в чеке всего ${b} ₸` };
  }

  const cap = capPct == null ? 100 : Number(capPct);
  const предел = pctToAmount(b, cap);

  if (a > предел) {
    /* СВЕРХ ПОТОЛКА — не отказ, а «нужен старший». Разница важна:
       отказ кассир воспримет как поломку, а так он знает, кого звать. */
    return {
      ok: false,
      needSenior: true,
      cap,
      capAmount: предел,
      said: `Ваш предел — ${cap}% (${предел} ₸). Сверх подтвердит старший`,
    };
  }

  return { ok: true, amount: a };
}

/**
 * ПОТОЛОК: МЕНЬШИЙ ИЗ ДВУХ.
 *
 * Правило магазина и право человека. Обойти нельзя ни с одной стороны.
 */
function capFor({ shopMaxPct, employee }) {
  const shop = shopMaxPct == null ? 100 : Number(shopMaxPct);
  const mine = employee && employee.discountLimitPct;
  return mine == null ? shop : Math.min(shop, Number(mine));
}

/**
 * ЧТО НАПИСАТЬ НАД ПОЛЕМ ВВОДА.
 *
 * Кассир должен видеть СВОЙ предел и в процентах, и в деньгах: считать
 * в уме при очереди он не станет.
 */
function capHint({ base, capPct, employee, shopMaxPct }) {
  const cap = capFor({ shopMaxPct, employee });
  if (cap >= 100) return null;

  const сумма = pctToAmount(base, cap);
  const свой = employee && employee.discountLimitPct != null
    && Number(employee.discountLimitPct) < (shopMaxPct == null ? 100 : shopMaxPct);

  return свой
    ? `Ваш предел — ${cap}% (${сумма} ₸). Сверх подтвердит старший`
    : `Больше ${cap}% в этом магазине не дают (${сумма} ₸)`;
}

/**
 * ПРИМЕНИТЬ СКИДКУ НА ЧЕК.
 *
 * Хранится СУММОЙ — их правило. Возвращает новую скидку чека.
 */
function applyCartDiscount(amount) {
  return Math.max(0, Math.round(Number(amount) || 0));
}

/**
 * СКИДКА НА ПОЗИЦИЮ.
 *
 * Считается от суммы строки, а не от всего чека: кассир скидывает на
 * помятую пачку, а не на всю покупку.
 */
function applyLineDiscount(line, amount) {
  const сумма = Math.round(line.price * line.qty);
  const a = Math.max(0, Math.round(Number(amount) || 0));
  if (a > сумма) {
    return { ok: false, said: `Скидка больше строки — в ней ${сумма} ₸` };
  }
  line.discount = a;
  return { ok: true, amount: a };
}

/**
 * СКИДКА ПОСЛЕ ПРАВКИ ЧЕКА.
 *
 * Их правило про «не плывёт» верно, пока чек РАСТЁТ. Но если из чека
 * убрали товар, скидка может стать больше остатка — и итог уйдёт в
 * минус.
 *
 * Поджимаем до остатка молча: кассир и так видит итог, а лишнее окно
 * при очереди только мешает.
 */
function fitDiscount(cartSum, discount) {
  const d = Math.round(Number(discount) || 0);
  if (d <= cartSum) return { discount: d, trimmed: 0 };
  return { discount: Math.max(0, cartSum), trimmed: d - Math.max(0, cartSum) };
}

if (typeof module !== 'undefined') {
  module.exports = { PRESETS, pctToAmount, amountToPct, checkDiscount, capFor,
    capHint, applyCartDiscount, applyLineDiscount, fitDiscount };
}
