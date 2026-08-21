/*
 * ЭКРАН ПРИВЯЗКИ — собирает себя сам при каждом показе (правило
 * этапа 1: разметка и обработчики строятся целиком, ничего не
 * «должно быть собрано раньше»).
 *
 * ОБЛИК v3: это первое, что владелец видит после установки, и по нему
 * судит о кассе целиком. Знак «Табыс», один вопрос, одно поле.
 *
 * Экранная клавиатура — по кнопке, а не сама: на компьютере с
 * клавиатурой она бы только заслоняла. Код с буквами и дефисом
 * (TBS-4FE2-3137) теперь можно ввести пальцем: в цифровом ряду есть
 * дефис, латиница за клавишей ABC.
 *
 * ПОЛЕ ПО-ПРЕЖНЕМУ НЕ ЗНАЕТ ФОРМАТ КОДА: ни маски, ни цифровой
 * клавиатуры, ни предела длины. Формат решает сервер — проверка
 * формата на клиенте уже дважды подводила.
 */

function buildSetup(root, state, ctx) {
  const { onPair, version } = ctx;

  root.innerHTML = `
    <div class="gate">
      <div class="gate-brand">Табыс</div>
      <h1>Введите код из кабинета</h1>
      <p class="gate-hint">Владелец заводит кассу в кабинете и получает код.
        Продиктуйте ему название магазина — он найдёт кассу по нему.</p>

      <input id="pairCode" class="field" autocapitalize="characters"
             spellcheck="false" autocomplete="off"
             placeholder="напр. TBS-4FE2-3137">

      <div class="gate-err" id="pairErr"></div>
      <button id="pairGo" class="primary big">Привязать кассу</button>
      <button id="pairKbd" class="ghost">Экранная клавиатура</button>

      <div class="gate-foot">
        <span id="pairVer"></span>
        <button id="pairSettings" class="ghost dim">Адрес сервера</button>
      </div>
    </div>`;

  const field = root.querySelector('#pairCode');
  const err = root.querySelector('#pairErr');
  const go = root.querySelector('#pairGo');

  root.querySelector('#pairVer').textContent = version ? 'Табыс v' + version : '';

  const say = (m) => {
    err.textContent = m || '';
    if (m) { err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake'); }
  };

  const submit = async () => {
    say('');
    // Пока идём на сервер — кнопка занята. Иначе кассир нажмёт трижды
    // и заведёт три устройства.
    if (go.disabled) return;
    go.disabled = true;
    const было = go.textContent;
    go.textContent = 'Привязываем…';
    try {
      await onPair(field.value);
    } catch (e) {
      say(e && e.message ? e.message : 'Не вышло привязать');
      // Возвращаем возможность попробовать: код мог быть с опечаткой.
      go.disabled = false;
      go.textContent = было;
      field.focus();
      field.select();
    }
  };

  go.onclick = submit;

  // Enter работает: на ноутбуке код вставляют и жмут ввод.
  field.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  // Ошибка гаснет при правке: кассир видит, что его услышали.
  field.oninput = () => { err.textContent = ''; };

  root.querySelector('#pairSettings').onclick = () => ctx.onSettings && ctx.onSettings();

  /* ЭКРАННАЯ КЛАВИАТУРА — по кнопке. Пишет в поле через applyKey, тем
     же путём, что человек. Ловля mousedown в клавиатуре не даёт полю
     потерять курсор. */
  const kbdBtn = root.querySelector('#pairKbd');
  const kbdRoot = () => document.getElementById('kbd');

  const kbdHide = () => {
    const k = kbdRoot();
    if (k) { k.classList.add('hidden'); k.innerHTML = ''; }
    kbdBtn.classList.remove('on');
    kbdBtn.textContent = 'Экранная клавиатура';
  };

  kbdBtn.onclick = () => {
    const k = kbdRoot();
    if (!k) return;
    if (!k.classList.contains('hidden')) { kbdHide(); return; }
    buildKeyboard(k, {
      mode: 'text',
      onKey: (v) => applyKey(field, v),
      onClose: kbdHide,
    });
    k.classList.remove('hidden');
    kbdBtn.classList.add('on');
    kbdBtn.textContent = 'Скрыть клавиатуру';
    field.focus();
  };

  // Уходим с экрана — клавиатура не остаётся висеть.
  root.__cleanup = kbdHide;

  // Курсор сразу в поле: кассиру не надо целиться пальцем.
  setTimeout(() => field.focus(), 0);
}

if (typeof module !== 'undefined') module.exports = { buildSetup };
