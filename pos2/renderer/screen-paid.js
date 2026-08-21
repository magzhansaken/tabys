/*
 * ЭКРАН ПОСЛЕ ОПЛАТЫ.
 *
 * Держится восемь секунд или до касания. Сдача — самое крупное: её
 * называют вслух.
 */
function buildPaid(root, view, ctx) {
  const { money, onDone } = ctx;

  /* ПОЛЯ СВОДИМ ПОД СВЁРТКУ. Найдено ЗАПУСКОМ: экран ждал heroLabel и
     heroAmount, а свёртка отдаёт title, change и changeWords — на
     экране выходило «undefined» вместо сдачи.

     СДАЧА ГЛАВНАЯ, когда она есть. Нет сдачи — главным становится
     итог: кассиру всё равно надо убедиться, что чек закрыт. */
  const сдача = Math.round(Number(view.change) || 0);
  const главное = сдача > 0
    ? { label: 'Сдача', amount: сдача, words: view.changeWords }
    : { label: 'Оплачено', amount: view.total, words: null };

  root.innerHTML = `
    <div class="paid-card">
      <div class="paid-num">Чек №${view.number ?? ''} · ${view.positions} поз.</div>
      ${сдача > 0 ? `<div class="paid-sum">${money(view.total)}</div>` : ''}
      <div class="paid-label">${главное.label}</div>
      <div class="paid-hero">${money(главное.amount)}</div>
      ${главное.words ? `<div class="paid-words">${главное.words}</div>` : ''}
      ${view.printNote ? `<div class="paid-warn">${view.printNote}</div>` : ''}
      <div class="paid-hint">Коснитесь, чтобы продолжить</div>
    </div>`;

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
  const таймер = setTimeout(done, view.holdMs || 8000);
  root.onclick = done;

  // Любая клавиша тоже закрывает: кассир уже потянулся к клавиатуре.
  const onKey = () => done();
  document.addEventListener('keydown', onKey);
  root.__cleanup = done;
}

if (typeof module !== 'undefined') module.exports = { buildPaid };
