/*
 * ЭКРАН КОДА КАССИРА.
 *
 * ЗДЕСЬ СЛОМАЛАСЬ ПРЕЖНЯЯ КАССА, и ради этого всё переделывается.
 *
 * Было так: клавиатура строилась ОДИН РАЗ при запуске, а кнопка
 * «Выйти» показывала этот экран напрямую, минуя сборку. Экран
 * появлялся ПУСТЫМ — без единой кнопки. Ввести код было нечем: ни
 * пальцем по стеклу, ни с клавиатуры ноутбука.
 *
 * Касса запиралась насмерть. Помогал только перезапуск, а смена при
 * этом оставалась открытой, и утренняя выручка смешивалась с вечерней.
 *
 * Поэтому здесь: РАЗМЕТКА И ОБРАБОТЧИКИ СТРОЯТСЯ ЦЕЛИКОМ, при каждом
 * показе. Ничего не переиспользуется, ничего не «должно быть собрано
 * раньше».
 */

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
const PIN_LEN = 4;

/**
 * Собрать экран кода.
 *
 * @param root  куда рисовать
 * @param state состояние кассы (магазин, касса)
 * @param ctx   { onPin, onClockOut, canClockOut, toast }
 */
function buildPin(root, state, ctx) {
  const mode = { out: false };   // «вход» или «я ухожу»
  let pin = '';

  root.innerHTML = `
    <div class="gate pin-gate">
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

  const say = (m) => { err.textContent = m || ''; };

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
      // Отказ приходит словами — их же правило: «строка вместо false —
      // собственное сообщение сервера».
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

  /* КЛАВИАТУРА НОУТБУКА ТОЖЕ РАБОТАЕТ.
   *
   * Вы сказали: «и в ноуте даже не пишется». Кассу ставят и на
   * ноутбук, и на компьютер с обычной клавиатурой — там цифры набирают
   * не пальцем по стеклу.
   *
   * Обработчик вешаем на сам экран и снимаем при уходе: иначе он
   * останется висеть, и цифры будут приходить с других экранов. */
  const onKey = (e) => {
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); }
    else if (e.key === 'Escape' || e.key === 'Delete') { e.preventDefault(); press('C'); }
  };
  document.addEventListener('keydown', onKey);
  // Уборка: когда экран сменится, разметка исчезнет, а обработчик — нет.
  root.__cleanup = () => document.removeEventListener('keydown', onKey);

  /* «Я УХОЖУ ДОМОЙ» — закрыть явку.
   *
   * Их довод: «вход по PIN открывает явку на сервере; „Я ухожу" — тот
   * же PIN, но явка закрывается и касса прощается с человеком, назвав
   * отработанное время».
   *
   * Кассир ушёл домой, а явка висит — владелец думает, что человек на
   * работе, и считает ему часы. */
  foot.innerHTML = ctx.canClockOut === false ? '' : `
    <button id="pinOut" class="ghost">Я ухожу домой</button>
    <button id="pinIn" class="ghost hidden">Назад ко входу</button>`;

  const bOut = root.querySelector('#pinOut');
  const bIn = root.querySelector('#pinIn');
  if (bOut) {
    bOut.onclick = () => { reset(true); bOut.classList.add('hidden'); bIn.classList.remove('hidden'); };
    bIn.onclick = () => { reset(false); bIn.classList.add('hidden'); bOut.classList.remove('hidden'); };
  }

  reset(false);

  /* Курсор в экран, чтобы клавиатура ноутбука работала сразу, без
     щелчка мышью. Кассир садится и печатает код. */
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
