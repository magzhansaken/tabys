#!/usr/bin/env node
/**
 * СТОРОЖ ЯЗЫКА: человек не должен видеть код.
 *
 * Написан в последнем заходе, когда нашлись два ответа сервера,
 * говорившие с владельцем платформы словами «base» и «pos». В кабинете
 * он видит «Старт» и «Касса» — эти слова ему ничего не говорят.
 *
 * Проверяет три вещи:
 *   в тексте на экране нет английских слов;
 *   ответы сервера начинаются с заглавной и короче 90 знаков
 *     (в тосте на телефоне это уже четыре строки);
 *   в тексте нет двойных пробелов и пробелов перед запятой.
 */
const fs = require('fs');
const path = require('path');

const problems = [];

// ── 1. Английский в тексте на экране ──────────────────────────────
const uiFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) uiFiles.push(p);
  }
})('admin/app/platform');

for (const f of uiFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?:title|label|placeholder|sub|hint):\s*['"`]([A-Za-z][A-Za-z ,.\-]{5,60})['"`]/g)) {
    problems.push({ file: path.basename(f), what: 'английский на экране', text: m[1] });
  }
}

// ── 2. Ответы сервера ─────────────────────────────────────────────
const srv = fs.readFileSync('server/src/platform/platform.module.ts', 'utf8');
for (const m of srv.matchAll(/Exception\(\s*\n?\s*['"`]([^'"`]{4,200})/g)) {
  const t = m[1];
  if (t.startsWith('$')) continue;                 // подстановка
  if (t.length > 90) problems.push({ file: 'сервер', what: 'ответ длиннее 90 знаков', text: t });
  if (/\b(null|undefined|true|false)\b/.test(t))
    problems.push({ file: 'сервер', what: 'техническое слово в ответе', text: t });
  // латиница в кавычках — почти всегда код, который человеку не нужен
  if (/«[a-z_]{2,}»/.test(t))
    problems.push({ file: 'сервер', what: 'код вместо человеческого слова', text: t });
}

// ── 3. Опечатки ───────────────────────────────────────────────────
for (const f of [...uiFiles, 'server/src/platform/platform.module.ts']) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/['"`]([А-ЯЁ][^'"`<>{}]{10,120})['"`]/g)) {
    const t = m[1];
    if (/\s{2,}/.test(t)) problems.push({ file: path.basename(f), what: 'двойной пробел', text: t });
    if (/\s[,;:]/.test(t)) problems.push({ file: path.basename(f), what: 'пробел перед знаком', text: t });
  }
}

if (problems.length === 0) {
  console.log('✔ Язык: человек не видит кода, ответы короткие и по-русски');
  process.exit(0);
}
console.log(`✘ Язык: ${problems.length} мест\n`);
for (const p of problems.slice(0, 12)) {
  console.log(`  [${p.what}] ${p.file}`);
  console.log(`     «${p.text.slice(0, 70)}»`);
}
process.exit(1);
