/*
 * ЭКРАН КОДА КАССИРА.
 *
 * ЗДЕСЬ СЛОМАЛАСЬ ПРЕЖНЯЯ КАССА: клавиатура строилась один раз, а
 * «Выйти» показывал экран напрямую — экран выходил ПУСТЫМ, и касса
 * запиралась насмерть. Поэтому разметка и обработчики строятся
 * ЦЕЛИКОМ при каждом показе. Это правило перепроверяется отдельной
 * проверкой — не трогать.
 *
 * ОБЛИК v3: точки и клавиши крупнее (клавиша 84 точки — бьётся не
 * глядя), ошибка вздрагивает — боковым зрением видно отказ, не читая.
 * Всё поведение прежнее: ноутбучная клавиатура, занятость на время
 * сервера, «Я ухожу домой», «Отвязать кассу».
 */

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
const PIN_LEN = 4;

/**
 * @param ctx { onPin, onClockOut, canClockOut, onReset }
 */
function buildPin(root, state, ctx) {
  const mode = { out: false };   // «вход» или «я ухожу»
  let pin = '';

  root.innerHTML = `
    <div class="gate pin-gate" tabindex="-1">
      <div class="gate-eyebrow" id="pinWhere"></div>
      <h1 id="pinTitle">Введите свой код</h1>

      <div class="dots" id="pinDots"></div>
      <div class="gate-err" id="pinErr"></div>

      <!-- Клавиатура строится ЗДЕСЬ ЖЕ, при каждом показе экрана.
           Ровно на этом сломалась прежняя касса. -->
      <div class="keypad" id="pinPad"></div>

      <div class="gate-foot" id="pinFoot"></div>
    </div>`;

  const dots = root.querySelector('#pinDots');
  const err = root.querySelector('#pinErr');
  const pad = root.querySelector('#pinPad');
  const title = root.querySelector('#pinTitle');
  const foot = root.querySelector('#pinFoot');

  root.querySelector('#pinWhere').textContent =
    [state.storeName, state.registerName].filter(Boolean).join(' · ');

  const drawDots = () => {
    dots.innerHTML = Array.from({ length: PIN_LEN },
      (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  };

  const say = (m) => {
    err.textContent = m || '';
    if (m) { err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake'); }
  };

  const reset = (m) => {
    pin = '';
    say('');
    mode.out = !!m;
    title.textContent = mode.out ? 'Код для ухода домой' : 'Введите свой код';
    drawDots();
  };

  /* Занятость: пока идём на сервер, кнопки молчат. Иначе кассир
     дожимает пятый знак, и уходит второй запрос. */
  let busy = false;

  const press = async (k) => {
    if (busy) return;
    say('');

    if (k === 'C') { pin = ''; drawDots(); return; }
    if (k === '⌫') { pin = pin.slice(0, -1); drawDots(); return; }

    pin = (pin + k).slice(0, PIN_LEN);
    drawDots();
    if (pin.length < PIN_LEN) return;

    busy = true;
    const code = pin;
    try {
      const r = mode.out ? await ctx.onClockOut(code) : await ctx.onPin(code);
      if (r && r.ok === false) {
        pin = ''; drawDots();
        say(r.said || 'Код не подошёл');
      }
    } catch (e) {
      pin = ''; drawDots();
      say(e && e.message ? e.message : 'Не вышло войти');
    } finally {
      busy = false;
    }
  };

  /* КЛАВИАТУРА СОБИРАЕТСЯ ЗДЕСЬ. Двенадцать кнопок, каждая со своим
     обработчиком — а не «навесим потом». */
  pad.innerHTML = '';
  for (const k of PIN_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k;
    b.className = k === 'C' || k === '⌫' ? 'kb-aux' : '';
    b.onclick = () => press(k);
    pad.appendChild(b);
  }

  /* КЛАВИАТУРА НОУТБУКА ТОЖЕ РАБОТАЕТ. Обработчик вешаем на документ
     и снимаем при уходе: иначе цифры будут приходить с других экранов. */
  const onKey = (e) => {
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); }
    else if (e.key === 'Escape' || e.key === 'Delete') { e.preventDefault(); press('C'); }
  };
  document.addEventListener('keydown', onKey);
  root.__cleanup = () => document.removeEventListener('keydown', onKey);

  /* «Я УХОЖУ ДОМОЙ» — закрыть явку. Кассир ушёл, а явка висит —
     владелец считает ему часы. */
  foot.innerHTML = `
    ${ctx.canClockOut === false ? '' : `
      <button id="pinOut" class="ghost">Я ухожу домой</button>
      <button id="pinIn" class="ghost hidden">Назад ко входу</button>`}
    <button id="pinReset" class="ghost dim">Отвязать кассу</button>`;

  const bOut = root.querySelector('#pinOut');
  const bIn = root.querySelector('#pinIn');
  if (bOut) {
    bOut.onclick = () => { reset(true); bOut.classList.add('hidden'); bIn.classList.remove('hidden'); };
    bIn.onclick = () => { reset(false); bIn.classList.add('hidden'); bOut.classList.remove('hidden'); };
  }

  /* ОТВЯЗАТЬ КАССУ: редкое и опасное — неяркое, но есть. Без него
     касса, вставшая на вводе кода, лечилась только поиском файлов. */
  const bReset = root.querySelector('#pinReset');
  if (bReset) bReset.onclick = () => ctx.onReset && ctx.onReset();

  reset(false);

  /* Курсор в экран, чтобы клавиатура ноутбука работала сразу. */
  setTimeout(() => { const f = root.querySelector('.pin-gate'); if (f && f.focus) f.focus(); }, 0);
}

/** Попрощаться с кассиром, назвав отработанное. */
function farewellText(fullName, workedMin) {
  const h = Math.floor((workedMin || 0) / 60);
  const m = (workedMin || 0) % 60;
  const время = h ? `${h} ч ${m} мин` : `${m} мин`;
  return `${fullName || 'Кассир'}, смена отмечена: ${время}. До свидания!`;
}

if (typeof module !== 'undefined') module.exports = { buildPin, farewellText, PIN_KEYS, PIN_LEN };
