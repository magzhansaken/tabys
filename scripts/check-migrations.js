#!/usr/bin/env node
/**
 * СТОРОЖ МИГРАЦИЙ: применённые не правят.
 *
 * Миграции отмечаются применёнными ПО ИМЕНИ ФАЙЛА. Дописка в файл,
 * который уже стоит на сервере, туда не попадёт — развёртывание
 * скажет «уже применена» и пойдёт дальше. Молча.
 *
 * Эта ловушка сработала дважды подряд: сперва пропали четырнадцать
 * функций разделов, потом ещё пятнадцать. Оба раза находилось только
 * на живом сервере — на чистой базе всё накатывается целиком, и
 * разницы не видно.
 *
 * Сторож сравнивает файлы миграций с тем, что лежит в ветке prod (это
 * то, что стоит на сервере). Если применённый файл изменился —
 * ругается и говорит, что делать.
 *
 * Запуск:  node scripts/check-migrations.js
 */
const { execSync } = require('child_process');
const fs = require('fs');

const run = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }); } catch { return ''; } };

const files = fs.readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort();
const changed = [];

for (const f of files) {
  const path = `db/migrations/${f}`;
  const onProd = run(`git show prod:${path} 2>/dev/null`);
  if (!onProd) continue;                       // новый файл — так и надо
  const now = fs.readFileSync(path, 'utf8');
  if (onProd !== now) changed.push(f);
}

if (changed.length) {
  console.log('✘ Изменены миграции, которые УЖЕ применены на сервере:\n');
  for (const f of changed) console.log(`    ${f}`);
  console.log(`
  Эти правки на сервер НЕ попадут: миграции отмечаются применёнными по
  имени файла, и развёртывание пропустит их со словами «уже применена».

  Что делать: вынести изменения в НОВЫЙ файл миграции с бо́льшим
  номером. Тот, что уже применён, вернуть к виду из ветки prod:

      git checkout prod -- db/migrations/<файл>
`);
  process.exit(1);
}

// Расчёт месячного счёта живёт в platform_monthly и нигде больше.
// Если он снова появится руками в новой миграции — она разойдётся с
// остальными, и клиент заплатит не ту сумму.
const APPLIED = 69;
let spread = [];
for (const f of files) {
  const n = Number(f.slice(0, 3));
  if (!Number.isFinite(n) || n <= APPLIED) continue;
  const t = fs.readFileSync(path.join(DIR, f), 'utf8');
  if (/unit_price \* pl\.qty/.test(t) && /price_month/.test(t)) spread.push(f);
}
if (spread.length) {
  console.log('✘ Расчёт счёта переписан руками в: ' + spread.join(', '));
  console.log('  Зовите platform_monthly(account_id) — иначе цифры разойдутся.');
  process.exit(1);
}

console.log(`✔ Миграции: ${files.length} файлов, применённые не тронуты`);
