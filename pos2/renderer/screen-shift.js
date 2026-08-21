/*
 * ЭКРАН СМЕНЫ: открыть, продолжить, принять, закрыть.
 *
 * Их правило: спросить про открытую смену ДО того, как предложить
 * новую — «иначе человек введёт размен, нажмёт Открыть, а сервер
 * подхватит чужую смену, и деньги уйдут не туда».
 */
function buildShift(root, state, ctx) {
  const { money, onOpen, onClose } = ctx;
  const смена = state.shift;

  if (смена) return drawOpen(root, state, ctx);
  return drawStart(root, state, ctx);
}

/** Смены нет — открываем. */
function drawStart(root, state, ctx) {
  const { money, onOpen } = ctx;
  let размен = FLOATS[1];

  root.innerHTML = `
    <div class="gate">
      <div class="gate-eyebrow">${state.storeName || ''}</div>
      <h1>Открыть смену</h1>
      <p class="gate-hint">Сколько мелочи в ящике на начало смены</p>
      <div class="pay-notes" id="shFloats"></div>
      <input id="shFloat" class="field" inputmode="numeric" value="${размен}">
      <div class="gate-err" id="shErr"></div>
      <button id="shGo" class="primary big">Открыть смену</button>
    </div>`;

  const поле = root.querySelector('#shFloat');
  const ряд = root.querySelector('#shFloats');

  for (const v of FLOATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = money(v);
    b.onclick = () => { размен = v; поле.value = String(v); };
    ряд.appendChild(b);
  }

  const go = root.querySelector('#shGo');
  go.onclick = async () => {
    if (go.disabled) return;
    go.disabled = true;
    try { await onOpen(Number(поле.value) || 0); }
    catch (e) {
      root.querySelector('#shErr').textContent = (e && e.message) || 'Не вышло открыть';
      go.disabled = false;
    }
  };
}

/** Смена открыта — продолжаем или закрываем. */
function drawOpen(root, state, ctx) {
  const { money, onClose } = ctx;
  const смена = state.shift;
  const чьё = shiftOwnership(смена, state.employee);
  const забыта = shiftForgotten(смена);
  const должно = state.cashInDrawer || 0;

  root.innerHTML = `
    <div class="gate">
      <div class="gate-eyebrow">${state.storeName || ''}</div>
      <h1>${чьё ? чьё.label : 'Смена'}</h1>
      ${забыта ? `<p class="gate-hint" style="color:#e0a86c">${забыта.said}</p>` : ''}
      ${чьё && чьё.note ? `<p class="gate-hint">${чьё.note}</p>` : ''}
      <p class="gate-hint">В ящике по расчёту: <b>${money(должно)}</b></p>

      <button id="shGo" class="primary big">${чьё ? чьё.label : 'Продолжить'}</button>

      <div style="margin-top:26px;width:min(420px,90vw)">
        <label style="color:#999;font-size:14px">Насчитал в ящике</label>
        <input id="shFact" class="field" inputmode="numeric" placeholder="пересчитайте деньги">
        <div class="gate-err" id="shDiff"></div>
        <button id="shClose" class="bad big">Закрыть смену</button>
      </div>
    </div>`;

  root.querySelector('#shGo').onclick = () => ctx.onContinue && ctx.onContinue();

  const факт = root.querySelector('#shFact');
  const разн = root.querySelector('#shDiff');

  /* РАСХОЖДЕНИЕ СЧИТАЕТСЯ ПРИ ВВОДЕ, а не после закрытия: кассир
     видит его сразу и успевает пересчитать. */
  факт.oninput = () => {
    if (!факт.value.trim()) { разн.textContent = ''; return; }
    const d = diffText(Number(факт.value) || 0, должно);
    разн.textContent = d.amount ? `${d.said} ${money(d.amount)}` : d.said;
    разн.style.color = d.kind === 'ok' ? '#7ec97e' : d.kind === 'warn' ? '#e0a86c' : '#e06c6c';
  };

  root.querySelector('#shClose').onclick = async () => {
    /* ПУСТОЕ ПОЛЕ НЕ ЗНАЧИТ НОЛЬ. В прошлой кассе это давало недостачу
       на всю кассу: кассир закрывал не глядя, и назавтра его спрашивали
       о деньгах, которых он не брал. */
    let сумма = факт.value.trim();
    if (!сумма) {
      const да = await askSure($('modal'), {
        title: 'Вы не вписали, сколько насчитали',
        text: `По расчёту в ящике ${money(должно)}.\n`
          + '«Пересчитал» — всё сходится, столько и уйдёт в отчёт.\n'
          + '«Вернуться» — вписать своё число: потом доказать будет нечем.',
        yes: 'Пересчитал, сходится', no: 'Вернуться',
      });
      if (!да) return;
      сумма = String(должно);
    }
    await onClose(Number(сумма) || 0);
  };
}

if (typeof module !== 'undefined') module.exports = { buildShift };
