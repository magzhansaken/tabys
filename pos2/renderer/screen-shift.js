/*
 * ЭКРАН СМЕНЫ: открыть, продолжить, принять, закрыть.
 *
 * Правило прежнее: открытая смена показывается ДО предложения новой —
 * иначе размен уйдёт в чужую смену.
 *
 * ОБЛИК v3:
 *   два дела — две карточки: «продолжить» отдельно от «закрыть», чтобы
 *     рука, идущая продолжать, не попала в закрытие;
 *   у полей сумм своя цифровая клавиатура ПРЯМО НА ЭКРАНЕ: на планшете
 *     без неё пересчёт ящика было не вписать вовсе;
 *   чья смена — сказано по имени: «Смену открыла Айгуль»;
 *   расхождение считается при вводе и подкрашивается (это было — оставлено).
 *
 * ПОЧИНЕНО ПО ХОДУ: прежний экран звал несуществующие shiftOwnership и
 * $ — «Продолжить» и подтверждение пустого поля роняли экран. Теперь
 * всё зовётся по-настоящему; «Продолжить» без свёртки связки идёт в
 * продажу через show().
 */
function buildShift(root, state, ctx) {
  const k = document.getElementById('kbd');
  if (k) { k.classList.add('hidden'); k.innerHTML = ''; }

  if (state.shift) return drawOpen(root, state, ctx);
  return drawStart(root, state, ctx);
}

/** Смены нет — открываем. */
function drawStart(root, state, ctx) {
  const { money, onOpen } = ctx;

  root.innerHTML = `
    <div class="gate">
      <div class="gate-eyebrow">${esc(state.storeName || '')}</div>
      <h1>Открыть смену</h1>
      <p class="gate-hint">Сколько мелочи в ящике на начало смены</p>

      <div class="gate-card">
        <div class="pay-notes" id="shFloats"></div>
        <input id="shFloat" class="field" inputmode="numeric" value="${FLOATS[1]}">
        <div class="kbd kbd-inline pay-pad" id="shPad"></div>
        <div class="gate-err" id="shErr"></div>
        <button id="shGo" class="primary big">Открыть смену</button>
      </div>
    </div>`;

  const поле = root.querySelector('#shFloat');

  // Обычные размены — одним касанием.
  const ряд = root.querySelector('#shFloats');
  for (const v of FLOATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = money(v);
    b.onclick = () => { поле.value = String(v); };
    ряд.appendChild(b);
  }

  // Цифры под пальцем: системной клавиатуры на планшете нет.
  buildKeyboard(root.querySelector('#shPad'), {
    mode: 'number', inline: true, onKey: (v) => applyKey(поле, v),
  });

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
  const я = state.employee;
  const должно = state.cashInDrawer || 0;

  // Чья смена: своя продолжается, чужая принимается.
  const чужая = !!(смена.openedBy && я && я.id && смена.openedBy !== я.id);
  const кто = смена.openedByName || '';
  const когда = (() => {
    const d = new Date(смена.openedAt || '');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  })();
  const забыта = shiftForgotten(смена);

  root.innerHTML = `
    <div class="gate">
      <div class="gate-eyebrow">${esc(state.storeName || '')}</div>
      <h1>Смена открыта</h1>
      ${забыта ? `<p class="gate-hint" style="color: var(--warn); max-width: 520px">${esc(забыта.said)}</p>` : ''}

      <div class="gate-card">
        <p class="gate-hint">${кто ? `Открыл${кто.endsWith('а') ? 'а' : ''} ${esc(кто)}${когда ? ' · ' + когда : ''}<br>` : ''}
          В ящике по расчёту: <b style="color: var(--gold)">${money(должно)}</b></p>
        <button id="shGo" class="primary big">${чужая ? 'Принять смену' : 'Продолжить смену'}</button>
      </div>

      <div class="gate-card">
        <h2>Закрыть смену — пересчитайте ящик</h2>
        <input id="shFact" class="field" inputmode="numeric" placeholder="сколько насчитали">
        <div class="kbd kbd-inline pay-pad" id="shPad"></div>
        <div class="gate-err" id="shDiff"></div>
        <button id="shClose" class="bad big">Закрыть смену</button>
      </div>
    </div>`;

  root.querySelector('#shGo').onclick = () => {
    // Свёртки может не быть — тогда идём в продажу через ядро.
    if (ctx.onContinue) return ctx.onContinue();
    return show('sale', state, {});
  };

  const факт = root.querySelector('#shFact');
  const разн = root.querySelector('#shDiff');

  buildKeyboard(root.querySelector('#shPad'), {
    mode: 'number', inline: true, onKey: (v) => applyKey(факт, v),
  });

  /* Расхождение считается ПРИ ВВОДЕ: кассир видит его сразу и успевает
     пересчитать, а не узнаёт после закрытия. */
  факт.oninput = () => {
    if (!факт.value.trim()) { разн.textContent = ''; return; }
    const d = diffText(Number(факт.value) || 0, должно);
    разн.textContent = d.diff ? `${d.said.replace(/ -?\d+$/, '')} ${money(Math.abs(d.diff))}` : d.said;
    разн.style.color = d.kind === 'ok' ? 'var(--green)' : d.kind === 'warn' ? 'var(--warn)' : 'var(--red)';
  };

  root.querySelector('#shClose').onclick = async () => {
    /* ПУСТОЕ ПОЛЕ НЕ ЗНАЧИТ НОЛЬ: это была недостача на всю кассу. */
    let сумма = факт.value.trim();
    if (!сумма) {
      const да = await askSure(document.getElementById('modal'), {
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

/* Экранирование берём из окон: второе объявление сломало бы файл. */
if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { esc } = require('./ui.js');
  module.exports = { buildShift };
}
