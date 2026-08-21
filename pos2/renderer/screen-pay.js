/*
 * ЭКРАН ОПЛАТЫ. Собирает себя сам.
 *
 * Прежние уроки живы: сумма подставлена сразу; касса помнит, чем
 * платят чаще (lastWay); двойной тап не даёт два чека; Escape
 * возвращает к чеку; купюрных кнопок пусто не бывает.
 *
 * ЧТО ИЗМЕНИЛОСЬ В ОБЛИКЕ v3:
 *   КУПЮРА — ОДНО КАСАНИЕ, И ЧЕК ЗАКРЫТ. Сдача написана на кнопке
 *     ЗАРАНЕЕ: «2 000 → сдача 660». Кассир видит последствие до
 *     нажатия, а не после. Это минус одно касание на каждой наличной
 *     оплате со сдачей — сотни касаний за смену;
 *   у суммы своя цифровая клавиатура на экране: произвольные «дали
 *     1 700» на планшете раньше было не набрать вовсе;
 *   СМЕШАННАЯ ОПЛАТА ПОЧИНЕНА: два поля — картой точно, наличными
 *     добирают; прежний экран отправлял смешанную как наличные целиком,
 *     и картная часть терялась в чеке;
 *   у каждого способа подсказка, что сейчас произойдёт: кассир не
 *     боится нажать.
 */
function buildPay(root, state, ctx) {
  const { due, ways, lastWay, tenderOptions, onPay, onBack, money } = ctx;
  let way = lastWay || 'cash';
  let занято = false;         // двойной тап не даёт два чека

  const kEl = document.getElementById('kbd');
  if (kEl) { kEl.classList.add('hidden'); kEl.innerHTML = ''; }

  const ПОДПИСИ = {
    cash: 'купюры и сдача',
    card: 'банковский терминал',
    qr: 'покупатель сканирует код',
    mixed: 'карта + наличные',
    credit: 'запишется за покупателем',
  };

  const наличными = () => {
    const w = ways.find((x) => x.id === way);
    return !!(w && w.cash);
  };

  root.innerHTML = `
    <div class="pay">
      <div class="pay-head">
        <button id="payBack" class="ghost">← К чеку</button>
        <div class="pay-due"><span>К оплате</span><b>${money(due)}</b></div>
      </div>
      <div class="pay-grid">
        <div class="pay-ways" id="payWays"></div>
        <div class="pay-main" id="payMain"></div>
      </div>
    </div>`;

  /* ── СПОСОБЫ. Строятся при каждом показе. ────────────────────── */
  const рядСпособов = root.querySelector('#payWays');
  for (const w of ways) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.way = w.id;
    b.innerHTML = `${esc(w.name)}<small>${esc(ПОДПИСИ[w.id] || '')}</small>`;
    b.className = w.id === way ? 'on' : '';
    b.onclick = () => {
      if (занято) return;
      way = w.id;
      [...рядСпособов.children].forEach((x) => x.classList.toggle('on', x.dataset.way === way));
      drawMain();
    };
    рядСпособов.appendChild(b);
  }

  const главное = root.querySelector('#payMain');

  /* ПРОВЕСТИ ОПЛАТУ — одна дверь для всех кнопок. */
  async function fire(parts, btn) {
    if (занято) return;
    занято = true;
    const было = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Проводим…'; }
    try {
      await onPay({ way, cash: parts.cash || 0, card: parts.card || 0 });
    } catch (e) {
      const err = главное.querySelector('#payErr');
      if (err) err.textContent = (e && e.message) || 'Не вышло провести оплату';
      занято = false;
      if (btn) { btn.disabled = false; btn.textContent = было; }
    }
  }

  function drawMain() {
    if (way === 'mixed') return drawMixed();
    if (наличными()) return drawCash();
    return drawSimple();
  }

  /* ── НАЛИЧНЫЕ ────────────────────────────────────────────────── */
  function drawCash() {
    главное.innerHTML = `
      <div class="tender" id="payTender"></div>
      <div class="pay-row">
        <div class="pay-in">
          <label>Дали наличными</label>
          <input id="payCash" inputmode="numeric" value="${due}">
          <div class="pay-change" id="payChange"></div>
          <div class="pay-err" id="payErr"></div>
        </div>
        <div class="kbd kbd-inline pay-pad" id="payPad"></div>
      </div>
      <button id="payGo" class="primary pay-go">Принять оплату</button>`;

    const поле = главное.querySelector('#payCash');
    const сдача = главное.querySelector('#payChange');
    const err = главное.querySelector('#payErr');

    /* КУПЮРЫ: одно касание — принято и посчитано. Сдача написана
       заранее, на кнопке. Пусто не бывает никогда. */
    const ряд = главное.querySelector('#payTender');
    tenderOptions(due).forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === 0 ? 'exact' : '';
      b.innerHTML = i === 0
        ? `<span class="t-sum">Без сдачи</span><span class="t-sub">ровно ${esc(money(due))}</span>`
        : `<span class="t-sum">${esc(money(v))}</span><span class="t-sub">сдача ${esc(money(v - due))}</span>`;
      b.onclick = () => fire({ cash: v }, b);
      ряд.appendChild(b);
    });

    buildKeyboard(главное.querySelector('#payPad'), {
      mode: 'number', inline: true, onKey: (v) => applyKey(поле, v),
    });

    const draw = () => {
      const дали = Number(поле.value) || 0;
      const остаток = дали - due;
      if (остаток >= 0) {
        сдача.innerHTML = остаток
          ? `<span class="lbl">Сдача</span><b>${money(остаток)}</b>`
          : '<span class="lbl">Без сдачи</span>';
        err.textContent = '';
      } else {
        сдача.innerHTML = '';
        err.textContent = `Не хватает ${money(-остаток)}`;   // сколько, а не «мало»
      }
    };
    поле.oninput = draw;

    главное.querySelector('#payGo').onclick = (e) => {
      const дали = Number(поле.value) || 0;
      if (дали < due) { err.textContent = `Не хватает ${money(due - дали)}`; return; }
      fire({ cash: дали }, e.currentTarget);
    };

    draw();
    setTimeout(() => { поле.focus(); поле.select(); }, 0);
  }

  /* ── СМЕШАННАЯ: карта точно, наличными добирают ──────────────── */
  function drawMixed() {
    главное.innerHTML = `
      <p class="pay-note">Карта проходит точно, наличными добирают остаток —
        иначе банк вернёт лишнее на карту через три дня, а деньги из ящика уйдут сегодня.</p>
      <div class="pay-row">
        <div class="pay-in">
          <label>Картой — проведите по терминалу</label>
          <input id="payCard" inputmode="numeric" placeholder="0">
          <label>Наличными</label>
          <input id="payCash" inputmode="numeric" value="${due}">
          <div class="pay-change" id="payChange"></div>
          <div class="pay-err" id="payErr"></div>
        </div>
        <div class="kbd kbd-inline pay-pad" id="payPad"></div>
      </div>
      <button id="payGo" class="primary pay-go">Принять оплату</button>`;

    const картой = главное.querySelector('#payCard');
    const налом = главное.querySelector('#payCash');
    const сдача = главное.querySelector('#payChange');
    const err = главное.querySelector('#payErr');

    // Клавиатура пишет в то поле, которого кассир коснулся последним.
    let цель = картой;
    картой.addEventListener('focusin', () => { цель = картой; });
    налом.addEventListener('focusin', () => { цель = налом; });
    buildKeyboard(главное.querySelector('#payPad'), {
      mode: 'number', inline: true, onKey: (v) => applyKey(цель, v),
    });

    const draw = () => {
      const c = Number(картой.value) || 0;
      const n = Number(налом.value) || 0;
      err.textContent = ''; сдача.innerHTML = '';
      if (c > due) { err.textContent = `Картой больше суммы чека — в чеке ${money(due)}`; return; }
      const всего = c + n;
      if (всего < due) { err.textContent = `Не хватает ${money(due - всего)}`; return; }
      const ост = всего - due;
      сдача.innerHTML = ост
        ? `<span class="lbl">Сдача наличными</span><b>${money(ост)}</b>`
        : '<span class="lbl">Без сдачи</span>';
    };

    // Ввели карту — наличные досчитались сами. Поправить можно.
    картой.oninput = () => {
      const c = Math.min(Math.max(0, Number(картой.value) || 0), due);
      налом.value = String(Math.max(0, due - c));
      draw();
    };
    налом.oninput = draw;

    главное.querySelector('#payGo').onclick = (e) => {
      const c = Number(картой.value) || 0;
      const n = Number(налом.value) || 0;
      if (c > due) { err.textContent = `Картой больше суммы чека — в чеке ${money(due)}`; return; }
      if (c + n < due) { err.textContent = `Не хватает ${money(due - c - n)}`; return; }
      fire({ cash: n, card: c }, e.currentTarget);
    };

    draw();
    setTimeout(() => { картой.focus(); картой.select(); }, 0);
  }

  /* ── КАРТА, QR, ДОЛГ: суммы не вводят — только подтверждают ──── */
  function drawSimple() {
    const слова = {
      card: {
        note: `Проведите ${money(due)} по банковскому терминалу. Касса терминал не дёргает — сверьте сумму на нём.`,
        go: 'Карта прошла — закрыть чек',
      },
      qr: {
        note: `Покупатель платит ${money(due)} по QR. Дождитесь «оплачено» у него на телефоне.`,
        go: 'QR оплачен — закрыть чек',
      },
      credit: {
        note: `${money(due)} запишется за покупателем. Деньги в ящик не лягут.`,
        go: 'Записать в долг',
      },
    };
    const с = слова[way] || { note: '', go: 'Принять оплату' };

    главное.innerHTML = `
      <p class="pay-note" style="font-size: 19px; max-width: 640px">${esc(с.note)}</p>
      <div class="pay-err" id="payErr"></div>
      <button id="payGo" class="primary pay-go">${esc(с.go)}</button>`;

    главное.querySelector('#payGo').onclick = (e) => fire({ card: due }, e.currentTarget);
  }

  root.querySelector('#payBack').onclick = () => onBack && onBack();

  /* ESCAPE ВОЗВРАЩАЕТ К ЧЕКУ: покупатель передумал — касса не листает
     заново. */
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onBack && onBack(); } };
  document.addEventListener('keydown', onKey);
  root.__cleanup = () => document.removeEventListener('keydown', onKey);

  drawMain();
}

/* Экранирование берём из окон: второе объявление сломало бы файл. */
if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { esc } = require('./ui.js');
  module.exports = { buildPay };
}
