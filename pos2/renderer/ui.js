/*
 * СВОИ ОКНА КАССЫ.
 *
 * Системные окна на кассе не годятся. Их довод дословно:
 *
 *   «window.prompt на планшете — беда: в режиме киоска браузер его
 *    часто блокирует вовсе, а где показывает, там крошечное поле в
 *    системном стиле, без цифровой клавиатуры и с кнопками под палец
 *    ребёнка. КАССИР В ЧАС ПИК В НЕГО НЕ ПОПАДАЕТ.»
 *
 * То же и с confirm(): мелкие кнопки, чужой вид, поверх всего. На
 * планшете кассир бьёт пальцем и промахивается, а промах здесь —
 * «Отмена» вместо «Да» или наоборот.
 *
 * ЧЕТЫРЕ ЛОВУШКИ, каждая уже кого-то подводила:
 *
 *   1. Клик по САМОМУ окну не должен закрывать его. Фон закрывается по
 *      касанию мимо, и клик с кнопки внутри «пузырился» до фона — окно
 *      захлопывалось прямо во время ввода. Их урок.
 *
 *   2. Опасное действие подписано КРАСНЫМ и стоит СПРАВА: случайный
 *      тычок попадает в безопасное.
 *
 *   3. Окно закрывается по Escape — одним списком на все окна. У
 *      донора «раньше половина окон на Esc не отвечала, и кассир не мог
 *      предсказать, что сделает клавиша».
 *
 *   4. Открытых окон не больше одного. Второе поверх первого — и
 *      кассир не понимает, что подтверждает.
 */

/* Кто сейчас открыт. Нужен, чтобы Escape закрывал ВЕРХНЕЕ, а не
   случайное, и чтобы второе окно не легло поверх первого. */
let openDialog = null;

/** Экранировать: имя товара может содержать угловые скобки. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Показать окно.
 *
 * @param root   куда рисовать (элемент)
 * @param html   содержимое окна
 * @param onClose что делать при закрытии фоном или Escape
 */
function openModal(root, html, onClose) {
  // ОДНО ОКНО ЗА РАЗ. Второе поверх первого — кассир не понимает, что
  // подтверждает, и жмёт наугад.
  if (openDialog) closeModal(root);

  root.innerHTML = `<div class="backdrop" data-back="1"><div class="dialog">${html}</div></div>`;
  root.classList.remove('hidden');

  const back = root.querySelector('[data-back]');
  const card = root.querySelector('.dialog');

  /* КЛИК ПО САМОМУ ОКНУ НЕ ЗАКРЫВАЕТ ЕГО. Их урок: клик с кнопки
     внутри пузырился до фона, и окно захлопывалось во время ввода. */
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => e.stopPropagation());

  // Касание МИМО окна — закрыть: так ведут себя все окна кассы, и
  // кассир на это рассчитывает.
  back.addEventListener('mousedown', () => closeModal(root, onClose));

  openDialog = { root, onClose };
  return card;
}

function closeModal(root, onClose) {
  const r = root || (openDialog && openDialog.root);
  if (!r) return;
  const cb = onClose || (openDialog && openDialog.onClose);
  r.classList.add('hidden');
  r.innerHTML = '';
  openDialog = null;
  if (cb) cb();
}

/** Есть ли открытое окно. Нужно замку и горячим клавишам. */
const hasModal = () => openDialog !== null;

/**
 * ВОПРОС ДА-НЕТ вместо confirm().
 *
 * Опасное подписано красным и стоит справа. «Отмена» слева и первая по
 * порядку: случайный тычок попадает в неё.
 */
function askSure(root, { title, text, yes = 'Да', no = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    /* ОТВЕЧАЕМ ОДИН РАЗ.
     *
     * Найдено проверкой: кассир жал «Да», а касса слышала «нет».
     *
     * Закрытие окна само зовёт обработчик «закрыли фоном» — то есть
     * отказ. Он срабатывал ПЕРВЫМ, обещание решалось отказом, и «да»
     * уже не считалось.
     *
     * Это беда про деньги: «Вернуть чек на 3 400?» — кассир жмёт
     * «Вернуть», а возврат не проходит. Или обратное, что хуже. */
    let answered = false;
    const done = (v) => { if (answered) return; answered = true; resolve(v); };

    const card = openModal(root, `
      <h2>${esc(title)}</h2>
      ${text ? `<p class="muted">${esc(text).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="row-actions">
        <button data-no>${esc(no)}</button>
        <button data-yes class="${danger ? 'bad' : 'primary'}">${esc(yes)}</button>
      </div>`, () => done(false));   // закрыли фоном или Escape — это «нет»

    // Явный ответ отвечает ПЕРВЫМ, а закрытие потом уже не в счёт.
    card.querySelector('[data-no]').onclick = () => { done(false); closeModal(root); };
    card.querySelector('[data-yes]').onclick = () => { done(true); closeModal(root); };
  });
}

/**
 * СООБЩЕНИЕ — коротко, снизу, само уходит.
 *
 * Не окно: окно требует нажатия, а кассиру некогда — очередь. Но
 * ошибка держится дольше: её надо успеть прочитать.
 */
function toast(root, text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  root.appendChild(el);
  const hold = kind === 'ok' ? 2500 : 5000;
  setTimeout(() => el.remove(), hold);
  return el;
}

/**
 * ЛИСТ СНИЗУ — для длинного: список, отчёт, настройки.
 *
 * Снизу, а не по центру: на планшете верх экрана далеко от рук, а
 * кассир держит его двумя руками по бокам.
 */
function openSheet(root, { title, html, onClose }) {
  const card = openModal(root, `
    <div class="sheet">
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="sheet-body">${html}</div>
    </div>`, onClose);
  card.querySelector('[data-close]').onclick = () => closeModal(root, onClose);
  return card;
}

/**
 * ESCAPE ЗАКРЫВАЕТ ВЕРХНЕЕ ОКНО — один список на все.
 *
 * Их урок: «раньше половина окон на Esc не отвечала, и кассир не мог
 * предсказать, что сделает клавиша».
 */
function wireEscape(doc) {
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!openDialog) return;
    e.preventDefault();
    closeModal();
  });
}

if (typeof module !== 'undefined') {
  module.exports = { openModal, closeModal, hasModal, askSure, toast, openSheet, wireEscape, esc };
}
