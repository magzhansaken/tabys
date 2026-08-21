/*
 * ЭКРАН ПОСЛЕ ОПЛАТЫ.
 *
 * Держится восемь секунд или до касания. Сдача — самое крупное: её
 * называют вслух.
 */
function buildPaid(root, view, ctx) {
  const { money, onDone } = ctx;

  root.innerHTML = `
    <div class="paid-card">
      <div class="paid-num">Чек №${view.number ?? ''} · ${view.positions} поз.</div>
      ${view.hero === 'change' ? `<div class="paid-sum">${money(view.total)}</div>` : ''}
      <div class="paid-label">${view.heroLabel}</div>
      <div class="paid-hero">${money(view.heroAmount)}</div>
      ${view.heroWords ? `<div class="paid-words">${view.heroWords}</div>` : ''}
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
