/*
 * ЯДРО КАССЫ: экраны и переходы.
 *
 * ГЛАВНОЕ ПРАВИЛО — ЭКРАН СОБИРАЕТ СЕБЯ САМ.
 *
 * Оно рождено бедой: в прежней кассе клавиатура ввода кода строилась
 * один раз при запуске, а кнопка «Выйти» показывала тот же экран
 * напрямую. Экран появлялся ПУСТЫМ — без единой кнопки. Ввести код
 * было нечем ни пальцем, ни с клавиатуры ноутбука.
 *
 * Касса запиралась насмерть. Помогал только перезапуск, а смена при
 * этом оставалась открытой.
 *
 * Поэтому здесь показать экран можно ТОЛЬКО через show(): она сама
 * зовёт сборку. Прямых обращений к разметке нет, и проверка это
 * стережёт.
 */

/** Все экраны кассы. Порядок — путь кассира от включения до продажи. */
const SCREENS = {
  setup:  { title: 'Привязка кассы',   needs: [] },
  pin:    { title: 'Вход кассира',     needs: ['paired'] },
  shift:  { title: 'Смена',            needs: ['paired', 'employee'] },
  sale:   { title: 'Продажа',          needs: ['paired', 'employee', 'shift'] },
  pay:    { title: 'Оплата',           needs: ['paired', 'employee', 'shift'] },
  paid:   { title: 'Оплачено',         needs: ['paired', 'employee', 'shift'] },
  locked: { title: 'Касса заперта',    needs: ['paired', 'employee'] },
};

/* Сборщики экранов. Каждый обязан нарисовать СВОЙ экран целиком: и
   разметку, и обработчики. Полагаться, что кто-то собрал раньше,
   нельзя — ровно на этом и сломалась прежняя касса. */
const builders = {};

/** Назначить сборщика экрану. */
function screen(name, build) {
  if (!SCREENS[name]) throw new Error(`Нет такого экрана: ${name}`);
  builders[name] = build;
}

let current = null;

/**
 * Показать экран. Единственный путь: собирает и показывает.
 *
 * Проверяет, что состояние позволяет: нельзя попасть в продажу без
 * открытой смены, а в смену — без вошедшего кассира. Иначе кассир
 * увидел бы экран, на котором ничего не работает, и не понял почему.
 */
function show(name, state, ctx) {
  const def = SCREENS[name];
  if (!def) throw new Error(`Нет такого экрана: ${name}`);

  /* ЧЕМ ПРОВЕРЯЕТСЯ КАЖДОЕ ТРЕБОВАНИЕ.
   *
   * Найдено ЗАПУСКОМ, а не проверками: они гоняли свои состояния с
   * полем paired, и всё сходилось. А в настоящем состоянии кассы лежит
   * deviceToken — привязка была, но ядро её не видело, и касса
   * оставалась на экране привязки навсегда. */
  const есть = {
    paired: (st) => !!(st.paired || st.deviceToken),
    employee: (st) => !!st.employee,
    shift: (st) => !!st.shift,
  };

  for (const need of def.needs) {
    const проверка = есть[need] || ((st) => !!st[need]);
    if (!проверка(state)) {
      // Не молчим и не показываем сломанный экран: говорим, куда идти.
      return { ok: false, reason: `Сначала: ${NEED_RU[need]}`, need };
    }
  }

  const build = builders[name];
  if (!build) throw new Error(`У экрана «${name}» нет сборщика`);

  current = name;
  build(state, ctx || {});
  return { ok: true, screen: name };
}

const NEED_RU = {
  paired:   'привяжите кассу кодом из кабинета',
  employee: 'войдите своим кодом',
  shift:    'откройте смену',
};

/** Какой экран открыт сейчас. */
function currentScreen() { return current; }

/**
 * Куда идти при запуске. Решает состояние, а не порядок вызовов:
 * касса включилась — сама встала туда, где кассир её оставил.
 */
function startScreen(state) {
  // Привязка лежит как deviceToken — та же беда, что была в show().
  if (!(state.paired || state.deviceToken)) return 'setup';
  if (!state.employee) return 'pin';
  if (!state.shift) return 'shift';
  return 'sale';
}

if (typeof module !== 'undefined') {
  module.exports = { SCREENS, screen, show, currentScreen, startScreen, NEED_RU, builders };
}
