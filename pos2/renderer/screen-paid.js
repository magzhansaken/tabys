/*
 * ЭКРАН ПОСЛЕ ОПЛАТЫ.
 *
 * Сдача — САМОЕ КРУПНОЕ НА КАССЕ: её называют вслух через прилавок, и
 * ошибка в ней дороже всего. Пропись под цифрой снимает спор «сорок
 * пять или четыреста пятьдесят» до того, как он начался.
 *
 * Держится восемь секунд или до касания. ОБЛИК v3 добавил полосу
 * отсчёта понизу: видно, что экран уйдёт сам, и никто не ждёт его зря.
 *
 * И «ДАЛИ / ИТОГ» над сдачей, когда сдача есть. Это ответ на ваш
 * вопрос про промах по соседней купюре: касание платит сразу, значит
 * ошибка должна быть видна В ТУ ЖЕ СЕКУНДУ — пока деньги ещё в руке и
 * покупатель у прилавка. «Дали 2 000 · итог 1 368» — промах читается
 * сразу, а не всплывает при сверке ящика вечером, когда возврат уже
 * через старшего.
 *
 * Внесённое считаем на месте: итог + сдача. Свёртку не трогаем.
 */
function buildPaid(root, view, ctx) {
  const { money, onDone } = ctx;

  /* Сдача главная, когда она есть. Нет сдачи — главным становится
     итог: кассиру всё равно надо убедиться, что чек закрыт. */
  const сдача = Math.round(Number(view.change) || 0);
  const главное = сдача > 0
    ? { label: 'Сдача', amount: сдача, words: view.changeWords }
    : { label: 'Оплачено', amount: view.total, words: null };

  const держать = view.holdMs || 8000;
  const дали = сдача > 0 ? Math.round(Number(view.total) || 0) + сдача : 0;

  root.innerHTML = `
    <div class="paid-card">
      <div class="paid-num">Чек №${view.number ?? ''} · ${view.positions} поз.${
        сдача > 0 ? '' : ' · оплачен'}</div>
      ${сдача > 0 ? `<div class="paid-sum">Дали ${money(дали)}<i>·</i>итог ${money(view.total)}</div>` : ''}
      <div class="paid-label">${главное.label}</div>
      <div class="paid-hero">${money(главное.amount)}</div>
      ${главное.words ? `<div class="paid-words">${главное.words}</div>` : ''}
      ${view.printNote ? `<div class="paid-warn">${view.printNote}</div>` : ''}
      <div class="paid-hint">Коснитесь, чтобы продолжить</div>
    </div>
    <div class="paid-hold" style="animation-duration: ${держать}ms"></div>`;

  let ушли = false;
  const done = () => {
    if (ушли) return;
    ушли = true;
    clearTimeout(таймер);
    root.onclick = null;
    document.removeEventListener('keydown', onKey);
    if (onDone) onDone();
  };

  // Само через восемь секунд: очередь не ждёт, пока кассир дочитает.
  const таймер = setTimeout(done, держать);
  root.onclick = done;

  // Любая клавиша тоже закрывает: кассир уже потянулся к клавиатуре.
  const onKey = () => done();
  document.addEventListener('keydown', onKey);
  root.__cleanup = done;
}

if (typeof module !== 'undefined') module.exports = { buildPaid };
