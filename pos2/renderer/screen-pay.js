/*
 * ЭКРАН ОПЛАТЫ.
 *
 * Собирает себя сам — правило этапа 1.
 *
 * Их урок: сумма подставлена сразу, «точный расчёт — самый частый
 * случай, а кассир, у которого гость даёт больше, поправит одним
 * касанием».
 */
function buildPay(root, state, ctx) {
  const { due, ways, lastWay, tenderOptions, onPay, onBack, money } = ctx;
  let way = lastWay || 'cash';
  let внесено = due;          // сумма подставлена СРАЗУ
  let занято = false;         // двойной тап не даёт два чека

  const наличными = () => {
    const w = ways.find((x) => x.id === way);
    return !!(w && w.cash);
  };

  root.innerHTML = `
    <div class="pay">
      <div class="pay-head">
        <button id="payBack" class="ghost">← К чеку</button>
        <div class="pay-due">К оплате <b>${money(due)}</b></div>
      </div>
      <div class="pay-ways" id="payWays"></div>
      <div class="pay-body">
        <div class="pay-in">
          <label>Внесено</label>
          <input id="payCash" inputmode="numeric" value="${due}">
        </div>
        <div class="pay-notes" id="payNotes"></div>
        <div class="pay-change" id="payChange"></div>
      </div>
      <div class="pay-err" id="payErr"></div>
      <button id="payGo" class="primary big">Принять оплату</button>
    </div>`;

  const поле = root.querySelector('#payCash');
  const сдача = root.querySelector('#payChange');
  const err = root.querySelector('#payErr');
  const go = root.querySelector('#payGo');

  /* СПОСОБЫ ОПЛАТЫ. Строятся здесь же, при каждом показе. */
  const рядСпособов = root.querySelector('#payWays');
  for (const w of ways) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.way = w.id;
    b.textContent = w.name;
    b.className = w.id === way ? 'on' : '';
    b.onclick = () => {
      way = w.id;
      [...рядСпособов.children].forEach((x) => x.classList.toggle('on', x.dataset.way === way));
      // Картой сдачи не бывает — поле и купюры прячем.
      внесено = наличными() ? due : due;
      поле.value = String(внесено);
      draw();
    };
    рядСпособов.appendChild(b);
  }

  /* КУПЮРЫ. Пусто не бывает никогда — их пересобираем при каждой
     смене способа. */
  const рядКупюр = root.querySelector('#payNotes');

  function drawNotes() {
    рядКупюр.innerHTML = '';
    if (!наличными()) return;
    tenderOptions(due).forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === 0 ? 'exact' : '';
      b.textContent = i === 0 ? 'Без сдачи' : money(v);
      b.onclick = () => { внесено = v; поле.value = String(v); draw(); };
      рядКупюр.appendChild(b);
    });
  }

  function draw() {
    drawNotes();
    const дали = Number(поле.value) || 0;
    const остаток = дали - due;

    if (!наличными()) { сдача.textContent = ''; err.textContent = ''; return; }

    if (остаток >= 0) {
      сдача.innerHTML = остаток
        ? `<span class="lbl">Сдача</span><b>${money(остаток)}</b>`
        : '<span class="lbl">Без сдачи</span>';
      err.textContent = '';
    } else {
      // СКОЛЬКО не хватает, а не «мало денег».
      сдача.innerHTML = '';
      err.textContent = `Не хватает ${money(-остаток)}`;
    }
  }

  поле.oninput = () => { внесено = Number(поле.value) || 0; draw(); };

  go.onclick = async () => {
    /* ДВОЙНОЙ ТАП НЕ ДАЁТ ДВА ЧЕКА — их урок: «на медленном планшете
       = два чека». */
    if (занято) return;

    const дали = Number(поле.value) || 0;
    if (наличными() && дали < due) { err.textContent = `Не хватает ${money(due - дали)}`; return; }

    занято = true;
    const было = go.textContent;
    go.disabled = true;
    go.textContent = 'Проводим…';
    try {
      await onPay({ way, cash: наличными() ? дали : 0, card: наличными() ? 0 : due });
    } catch (e) {
      err.textContent = (e && e.message) || 'Не вышло провести оплату';
      занято = false;
      go.disabled = false;
      go.textContent = было;
    }
  };

  root.querySelector('#payBack').onclick = () => onBack && onBack();

  /* ESCAPE ВОЗВРАЩАЕТ К ЧЕКУ — их правило: покупатель передумал
     платить картой, касса не листает заново. */
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onBack && onBack(); } };
  document.addEventListener('keydown', onKey);
  root.__cleanup = () => document.removeEventListener('keydown', onKey);

  draw();
  setTimeout(() => { поле.focus(); поле.select(); }, 0);
}

if (typeof module !== 'undefined') module.exports = { buildPay };
