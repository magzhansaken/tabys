#!/usr/bin/env node
/**
 * СТОРОЖ АДРЕСОВ: каждый вызов кабинета должен попадать в свой
 * обработчик на сервере.
 *
 * Написан после того, как две мёртвые ссылки нашлись случайно:
 *   кнопка «Новый пароль» звала адрес, которого нет вовсе;
 *   правка партнёра шла на адрес отключения — имя, почта, доля и
 *     пароль молча терялись, а в ответ приходило «Вход закрыт».
 *
 * Обе не видны глазами и не ловятся сборкой: путь собирается строкой,
 * и опечатка в нём — обычный текст. Тесты их тоже не поймали, потому
 * что ходят к серверу напрямую, а не через кабинет.
 */
const fs = require('fs');
const path = require('path');

const SRV = 'server/src/platform/platform.module.ts';
const UI = 'admin/app/platform';

const srv = fs.readFileSync(SRV, 'utf8');

// Что объявлено на сервере.
const routes = new Map();
for (const m of srv.matchAll(
  /@(?:Public\(\) )?@(Get|Post|Patch|Delete)\('([^']+)'\)\s*\n\s*(?:async )?(\w+)\(/g)) {
  routes.set(`${m[1].toUpperCase()} ${m[2]}`, m[3]);
}

// Что зовёт кабинет.
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
})(UI);

const bad = [];
let total = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/api\(\s*[`']([^`']+)[`'](?:\s*,\s*\{\s*method:\s*'(\w+)')?/g)) {
    const p = m[1].replace(/\$\{[^}]+\}/g, ':id').split('?')[0].replace(/^\//, '');
    const meth = (m[2] || 'GET').toUpperCase();
    total++;
    if (!routes.has(`${meth} ${p}`)) {
      const alt = [...routes.keys()].filter((k) => k.endsWith(` ${p}`));
      bad.push({ file: path.basename(f), call: `${meth} /${p}`, alt });
    }
  }
}

if (bad.length === 0) {
  console.log(`✔ Адреса: ${total} вызовов кабинета, все попадают в свой обработчик`);
  process.exit(0);
}

console.log(`✘ Адреса: ${bad.length} вызовов бьют мимо\n`);
for (const b of bad) {
  console.log(`  ${b.file}: ${b.call}`);
  console.log(`     на сервере: ${b.alt.length ? b.alt.join(', ') : 'НЕТ ВОВСЕ'}`);
}
console.log('\nТакой вызов упадёт молча или попадёт в чужой обработчик.');
process.exit(1);
