/*
 * ЗАМОК ПРИ ПРОСТОЕ И ВЫХОД.
 *
 * ЗДЕСЬ БЫЛА ВАША БЕДА, и ради неё всё переделывается.
 *
 * Прежняя касса: нажал «Выйти» — экран кода без клавиатуры. Ввести
 * нечем ни пальцем, ни с ноутбука. Касса запиралась НАСМЕРТЬ, помогал
 * только перезапуск, а смена оставалась открытой.
 *
 * Их довод про замок:
 *
 *   «Официант отошёл — и любой может пробить чек от его имени. Но
 *    выходить насовсем нельзя: незаконченный заказ пропадёт, а гость
 *    сидит за столом. Поэтому касса не выходит, а ЗАПИРАЕТСЯ: поверх
 *    экрана ложится замок, сама касса со всем набранным остаётся живой
 *    под ним. Ввёл PIN — продолжил с той же строки.
 *
 *    Три минуты: меньше — мешает разговаривать с гостем, больше — уже
 *    небезопасно в зале.»
 *
 * В магазине то же самое: кассир отошёл в подсобку, к полке, покурить.
 * Касса открыта под его именем — кто угодно пробьёт чек, даст скидку,
 * вернёт деньги. Он узнает при сверке и доказать не сможет.
 */

/* Общие мелочи: счёт по-русски и разряды. Лежат отдельно, потому что
   нужны всем, а одно имя в двух файлах ломает второй целиком. */
if (typeof module !== 'undefined' && typeof plural === 'undefined') {
  // eslint-disable-next-line global-require
  var { plural } = require('./common.js');
}

/** Три минуты — их число. Ноль значит «не запирать». */
const IDLE_MIN = 3;

/**
 * ОТСЧЁТ ПРОСТОЯ.
 *
 * Любое касание сбрасывает: кассир работает — замок не мешает.
 */
function makeIdleWatch({ minutes = IDLE_MIN, onLock, now = () => Date.now() }) {
  let timer = null;
  let locked = false;
  let last = now();

  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function arm() {
    if (locked) return;
    stop();
    const min = Number(minutes);
    // Ноль — не запирать вовсе: на кассе в закрытой комнате замок
    // только мешает.
    if (!(min > 0)) return;
    timer = setTimeout(() => { locked = true; if (onLock) onLock(); }, min * 60000);
  }

  return {
    arm,
    stop,
    touch() { last = now(); arm(); },
    get locked() { return locked; },
    unlock() { locked = false; arm(); },
    /** Для проверок: сколько прошло без касаний. */
    idleMs() { return now() - last; },
  };
}

/**
 * ОТПЕРЕТЬ ЗАМОК.
 *
 * По тому же пропуску, что и вход без сети — значит замок работает без
 * интернета. Иначе кассир заперт до приезда мастера.
 *
 * СМЕНЩИК ОТПИРАЕТ СВОИМ КОДОМ, и кассир в чеке МЕНЯЕТСЯ: дальше
 * пробивает он, и чеки идут на него. Утренний ушёл — вечерний не
 * должен торговать под его именем.
 */
async function unlock({ pin, state, store, deviceToken, offlineLogin, login, ask, settings }) {
  /* ЗАМОК ИДЁТ ТЕМ ЖЕ ПУТЁМ, ЧТО И ВХОД: сперва сервер, не вышло —
   * пропуск с диска.
   *
   * Было: смотрел ТОЛЬКО пропуск. А пропуск ложится при входе через
   * сервер — значит если касса заперлась ДО первого входа, отпереть
   * нечем вовсе. И даже при живой сети замок говорил «код не подошёл»,
   * хотя код верный.
   *
   * Найдено владельцем: «код кассы в замке не подходит». */
  let pass = await offlineLogin({ store, pin, deviceKey: deviceToken });

  if (!pass && login && ask) {
    /* Пропуска нет — спрашиваем сервер. Он же и положит пропуск, чтобы
       в следующий раз замок отпёрся без сети. */
    const r = await login({ ask, store, settings, deviceToken, pin })
      .catch(() => ({ ok: false }));

    if (r && r.ok) {
      pass = { employee: r.employee };
    } else if (r && r.said) {
      return { ok: false, said: r.said };
    }
  }

  if (!pass) return { ok: false, said: 'Код не подошёл' };

  const тот_же = state.employee && pass.employee
    && state.employee.id === pass.employee.id;

  return {
    ok: true,
    employee: pass.employee,
    changed: !тот_же,
    said: тот_же ? null : `За кассой теперь ${pass.employee.name || 'другой кассир'}`,
  };
}

/**
 * ВЫХОД КАССИРА.
 *
 * Не то же, что замок. Замок — «отошёл на минуту». Выход — «моя смена
 * за кассой кончилась, сел сменщик».
 *
 * СМЕНА ПРИ ЭТОМ ОСТАЁТСЯ ОТКРЫТОЙ: ящик один, деньги в нём общие, и
 * закрывать смену должен тот, кто её сводит.
 */
function planLogout({ cart, state }) {
  const предупреждения = [];

  /* НАБРАННЫЙ ЧЕК ПРОПАДЁТ. Кассир нажал «Выйти», не заметив, что в
     чеке десять позиций — а покупатель отошёл за деньгами. */
  if (cart && cart.length) {
    предупреждения.push({
      kind: 'cart',
      said: `В чеке ${cart.length} ${plural(cart.length, 'позиция', 'позиции', 'позиций')}. `
        + 'Они пропадут — отложите чек, если он нужен',
    });
  }

  /* СМЕНА ОСТАЁТСЯ. Говорим прямо: иначе кассир решит, что выход её
     закрыл, и уйдёт домой с открытой сменой. */
  if (state.shift) {
    предупреждения.push({
      kind: 'shift',
      said: 'Смена останется открытой — сменщик продолжит на ней. '
        + 'Закрывать её должен тот, кто сводит ящик',
    });
  }

  return { warnings: предупреждения, canLogout: true };
}


/**
 * СБОРЩИК ЭКРАНА ЗАМКА.
 *
 * ГЛАВНОЕ: разметка и клавиатура строятся ЗДЕСЬ, при каждом показе.
 * Ровно на этом сломалась прежняя касса.
 */
const LOCK_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];

function buildLock(root, state, ctx) {
  let pin = '';

  root.innerHTML = `
    <div class="lock-card">
      <div class="lock-title">Касса заперта</div>
      <div class="lock-who" id="lockWho"></div>
      <div class="lock-hint">Чек не потерян — введите код и продолжайте</div>
      <div class="dots" id="lockDots"></div>
      <div class="gate-err" id="lockErr"></div>
      <div class="keypad" id="lockPad"></div>
    </div>`;

  const dots = root.querySelector('#lockDots');
  const err = root.querySelector('#lockErr');
  const pad = root.querySelector('#lockPad');

  root.querySelector('#lockWho').textContent =
    (state.employee && state.employee.name) || '';

  const draw = () => {
    dots.innerHTML = [0, 1, 2, 3]
      .map((i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  };

  let busy = false;

  const press = async (k) => {
    if (busy) return;
    err.textContent = '';

    if (k === 'C') { pin = ''; draw(); return; }
    if (k === '⌫') { pin = pin.slice(0, -1); draw(); return; }

    pin = (pin + k).slice(0, 4);
    draw();
    if (pin.length < 4) return;

    busy = true;
    const код = pin;
    try {
      const r = await ctx.onUnlock(код);
      if (!r || !r.ok) { pin = ''; draw(); err.textContent = (r && r.said) || 'Код не подошёл'; }
    } catch (e) {
      pin = ''; draw();
      err.textContent = (e && e.message) || 'Не вышло отпереть';
    } finally {
      busy = false;
    }
  };

  /* КЛАВИАТУРА СОБИРАЕТСЯ ЗДЕСЬ — двенадцать кнопок, каждая со своим
     обработчиком. Не «навесим потом». */
  pad.innerHTML = '';
  for (const k of LOCK_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k;
    b.className = (k === 'C' || k === '⌫') ? 'kb-aux' : '';
    b.onclick = () => press(k);
    pad.appendChild(b);
  }

  /* И КЛАВИАТУРА НОУТБУКА. Ваши слова: «и в ноуте даже не пишется».
     Обработчик снимается при уходе с экрана — иначе цифры будут
     приходить с других экранов. */
  const onKey = (e) => {
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); }
    else if (e.key === 'Delete') { e.preventDefault(); press('C'); }
    // Escape НЕ отпирает: замок на то и замок.
    else if (e.key === 'Escape') e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  root.__cleanup = () => document.removeEventListener('keydown', onKey);

  draw();
}

if (typeof module !== 'undefined') {
  module.exports = { IDLE_MIN, LOCK_KEYS, makeIdleWatch, unlock, planLogout, buildLock };
}
