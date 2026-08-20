/*
 * ПРОВЕРКА ОБОЛОЧКИ: защиты окна, журнал, одна копия.
 *
 * Читаем сам код: запустить Windows-окно здесь негде, но правила
 * должны быть на месте, а не «я помню, что писал».
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

console.log('═══ ЭТАП 2 · ОБОЛОЧКА ═══\n');

// ── ОКНО ───────────────────────────────────────────────────────────
ok(/fullscreen:\s*true/.test(main), '★ Полный экран');
ok(/setMenu\(null\)/.test(main), 'Меню Windows убрано');
ok(/backgroundColor/.test(main), 'Тон при загрузке — не мигает белым');

// ── ИЗ ПОЛНОГО ЭКРАНА НЕ ВЫЙТИ ─────────────────────────────────────
{
  const m = main.match(/before-input-event[\s\S]{0,500}/);
  const b = m ? m[0] : '';
  ok(/F11/.test(b) && /preventDefault/.test(b), '★ F11 не выпускает окно');
  ok(/Escape/.test(b), '★ Escape тоже');
  ok(/'w'/.test(b) && /'r'/.test(b), '★ Ctrl+W и Ctrl+R отбиты: не закроет чек случайно');
}

// ── ОДНА КОПИЯ ─────────────────────────────────────────────────────
ok(/requestSingleInstanceLock/.test(main), '★ Вторая копия не запустится');
ok(/second-instance[\s\S]{0,200}focus\(\)/.test(main),
   'А первая поднимется наверх: кассир ткнул дважды — видит свою кассу');

// ── ЗАКРЫТИЕ С ПРЕДУПРЕЖДЕНИЕМ ─────────────────────────────────────
{
  const m = main.match(/win\.on\('close'[\s\S]{0,900}/);
  const c = m ? m[0] : '';
  ok(/__tabysPending/.test(c), '★ При закрытии спрашиваем число неотправленных');
  ok(/Всё равно закрыть/.test(c) && /Остаться/.test(c),
     'Две кнопки, и «Остаться» первая: случайный тычок безопасен');
  ok(/в отчётах их не будет/.test(c),
     'Объяснено, чем грозит: «в отчётах их не будет»');
}

// ── ЖУРНАЛ ─────────────────────────────────────────────────────────
ok(/kassa\.log/.test(main), '★ Журнал оболочки есть');
ok(/trimLog/.test(main) && /512 \* 1024/.test(main),
   'И не растёт без края: полмегабайта, старое отрезается');
ok(/catch \{ \/\* журнал не должен ронять кассу/.test(main),
   '★ Журнал не роняет кассу: не записалось — и ладно');

// ── БЕЗОПАСНОСТЬ СТРАНИЦЫ ──────────────────────────────────────────
ok(/contextIsolation:\s*true/.test(main), '★ Страница отделена от системы');
ok(/nodeIntegration:\s*false/.test(main), 'И не имеет доступа к файлам');
ok(/loadFile/.test(main), '★ Страница с ДИСКА: касса откроется без сети');

// ── МОСТ ───────────────────────────────────────────────────────────
ok(/contextBridge\.exposeInMainWorld/.test(pre), 'Мост через список, а не всё подряд');
{
  const умеет = (pre.match(/^\s{2}(\w+):/gm) || []).map((s) => s.trim().replace(':', ''));
  ok(умеет.length >= 4, `Касса умеет: ${умеет.join(', ')}`);
}

// ── СБОРКА ─────────────────────────────────────────────────────────
ok(pkg.build.files.includes('renderer/**/*'), '★ Страница попадёт в сборку');
ok(pkg.build.files.includes('electron/**/*'), 'И оболочка тоже');
ok(pkg.build.nsis.oneClick === false,
   'Установщик спрашивает папку: касса ставится на рабочий компьютер, а не тайком');

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
