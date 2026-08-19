#!/usr/bin/env node
/**
 * СТОРОЖ ПАМЯТИ: она объявляется ДО выходов.
 *
 * Написан после того, как «Настройки» упали с ошибкой React #310. Я
 * вписал новое состояние ниже строк «if (!prices) return» — и страница
 * перестала открываться.
 *
 * Почему падает: пока данные грузятся, отрисовка выходит раньше и до
 * памяти не доходит. Данные пришли — выхода нет, память заводится.
 * Разное число ячеек между отрисовками React запрещает.
 *
 * Беда в том, что ЭТО НЕ ЗАМЕТНО ПРИ СБОРКЕ: код верный, ошибка
 * вылезает только у человека на экране. Поэтому сторож.
 */
const fs = require('fs');
const path = require('path');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); }
    else if (e.name.endsWith('.tsx')) files.push(p);
  }
})('admin/app');

const problems = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // Режем файл по объявлениям составляющих: в одном файле их бывает
  // несколько, и выход в первой не относится ко второй.
  const parts = src.split(/\n(?=(?:export default )?function [A-Z]|const [A-Z]\w* = \()/);
  let base = 0;
  for (const part of parts) {
    const lines = part.split('\n');
    let sawReturn = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Ранний выход на верхнем уровне тела — ровно два пробела.
      if (sawReturn === null && /^  (if \(.*\) )?return /.test(ln)) sawReturn = i;
      if (sawReturn !== null && /^  const \[[^\]]+\] = use(State|Reducer|Ref)/.test(ln)) {
        problems.push({ file: f, line: base + i + 1, text: ln.trim() });
      }
    }
    base += lines.length;
  }
}

if (problems.length === 0) {
  console.log('✔ Память: вся объявляется до выходов, страницы не упадут');
  process.exit(0);
}
console.log(`✘ Память объявлена ПОСЛЕ выхода — страница упадёт: ${problems.length} мест\n`);
for (const p of problems.slice(0, 10)) {
  console.log(`  ${p.file}:${p.line}`);
  console.log(`     ${p.text.slice(0, 66)}`);
}
console.log('\n  Перенесите объявление наверх, к остальной памяти составляющей.');
process.exit(1);
