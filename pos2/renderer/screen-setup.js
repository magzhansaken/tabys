/*
 * ЭКРАН ПРИВЯЗКИ — собирает себя сам.
 *
 * Правило из этапа 1: ни один показ не полагается на то, что кто-то
 * собрал экран раньше. Разметка и обработчики строятся здесь целиком,
 * при каждом показе.
 */

function buildSetup(root, state, ctx) {
  const { onPair, toast, version } = ctx;

  root.innerHTML = `
    <div class="gate">
      <div class="gate-eyebrow">Привязка кассы</div>
      <h1>Введите код из кабинета</h1>
      <p class="gate-hint">Владелец заводит кассу в кабинете и получает код.
        Продиктуйте ему название магазина — он найдёт кассу по нему.</p>

      <!-- ПОЛЕ НЕ ЗНАЕТ ФОРМАТ КОДА.
           У меня это уже случалось: поле принимало только цифры, а код
           стал TBS-4FE2-3137 — кассир не мог ввести буквы вовсе.
           Здесь ни маски, ни цифровой клавиатуры: что дал владелец, то
           и вводим. -->
      <input id="pairCode" class="field" autocapitalize="characters"
             spellcheck="false" autocomplete="off"
             placeholder="напр. TBS-4FE2-3137">

      <div class="gate-err" id="pairErr"></div>
      <button id="pairGo" class="primary big">Привязать кассу</button>

      <div class="gate-foot">
        <span id="pairVer"></span>
        <button id="pairSettings" class="ghost">Адрес сервера</button>
      </div>
    </div>`;

  const field = root.querySelector('#pairCode');
  const err = root.querySelector('#pairErr');
  const go = root.querySelector('#pairGo');

  root.querySelector('#pairVer').textContent = version ? 'Табыс v' + version : '';

  const say = (m) => { err.textContent = m || ''; };

  const submit = async () => {
    say('');
    // Пока идём на сервер — кнопка занята. Иначе кассир нажмёт трижды и
    // заведёт три устройства: у владельца в кабинете будет три кассы.
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

  // Enter работает: на ноутбуке код вставляют и жмут ввод, а не мышью.
  field.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  // Ошибка гаснет при правке: кассир видит, что его услышали.
  field.oninput = () => say('');

  root.querySelector('#pairSettings').onclick = () => ctx.onSettings && ctx.onSettings();

  // Курсор сразу в поле: кассиру не надо целиться пальцем.
  setTimeout(() => field.focus(), 0);
}

if (typeof module !== 'undefined') module.exports = { buildSetup };
