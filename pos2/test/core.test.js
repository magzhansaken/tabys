/*
 * ПРОВЕРКА ЯДРА: экран собирает себя сам.
 *
 * Первая проверка — про ту беду, из-за которой всё и переделывается:
 * «Выйти» показывал экран кода без клавиатуры, и касса запиралась
 * насмерть.
 */
const { SCREENS, screen, show, currentScreen, startScreen } = require('../renderer/core.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

console.log('═══ ЭТАП 1 · УСТРОЙСТВО ═══\n');

// Считаем, сколько раз собрался каждый экран
const built = {};
for (const name of Object.keys(SCREENS)) {
  screen(name, () => { built[name] = (built[name] || 0) + 1; });
}

const full = { paired: true, employee: { id: 'e1', name: 'Айгуль' }, shift: { id: 's1' } };

// ── ТА САМАЯ БЕДА ──────────────────────────────────────────────────
{
  // Вошли, поработали, нажали «Выйти» — экран кода должен собраться
  // ЗАНОВО, со всеми кнопками.
  show('sale', full);
  show('pin', { paired: true });
  ok(built.pin === 1, '★ «Выйти» СОБРАЛ экран кода, а не показал пустой');

  // И ещё раз: заперли, отперли, снова заперли
  show('sale', full);
  show('pin', { paired: true });
  ok(built.pin === 2, '★ Второй раз — снова собрал: касса не запрётся насмерть');
}

// ── ПОКАЗАТЬ МИМО show() НЕЛЬЗЯ ────────────────────────────────────
{
  // Нет сборщика — падаем сразу и громко, а не показываем пустой экран
  // кассиру при очереди.
  const SCR = require('../renderer/core.js');
  SCR.SCREENS.__проба = { title: 'Проба', needs: [] };
  let said = null;
  try { show('__проба', full); } catch (e) { said = e.message; }
  ok(said && /нет сборщика/i.test(said),
     '★ Экран без сборщика — ошибка сразу, а не пустой экран у кассира');
  delete SCR.SCREENS.__проба;
}

// ── СОСТОЯНИЕ РЕШАЕТ, КУДА ПУСКАТЬ ────────────────────────────────
{
  const r1 = show('sale', { paired: true, employee: { id: 'e1' } });
  ok(!r1.ok && r1.need === 'shift',
     '★ В продажу без смены не пускает, и говорит куда идти');
  ok(/откройте смену/i.test(r1.reason), `И словами: «${r1.reason}»`);

  const r2 = show('shift', { paired: true });
  ok(!r2.ok && r2.need === 'employee', 'В смену без кассира не пускает');

  const r3 = show('pin', {});
  ok(!r3.ok && r3.need === 'paired', 'В код без привязки не пускает');
}

// ── КУДА ВСТАТЬ ПРИ ЗАПУСКЕ ────────────────────────────────────────
{
  ok(startScreen({}) === 'setup', 'Не привязана → привязка');
  ok(startScreen({ paired: true }) === 'pin', 'Привязана → код');
  ok(startScreen({ paired: true, employee: {} }) === 'shift', 'Вошёл → смена');
  ok(startScreen(full) === 'sale', '★ Смена открыта → сразу продажа');
}

// ── ВСЕ ЭКРАНЫ ИМЕЮТ СБОРЩИК ───────────────────────────────────────
{
  const без = Object.keys(SCREENS).filter((n) => !require('../renderer/core.js').builders[n]);
  ok(без.length === 0, `★ У всех ${Object.keys(SCREENS).length} экранов есть сборщик`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
