/**
 * ОБНОВЛЕНИЕ КАССЫ.
 *
 * ГЛАВНОЕ ПРАВИЛО, выстраданное на боевой кассе соседнего проекта:
 * НИКОГДА не обновлять посреди смены. Обновление во время очереди — это
 * остановка торговли, и виноват будет не Windows, а мы.
 *
 * Поэтому здесь три защиты:
 *   1) при ОТКРЫТОЙ смене обновление даже не предлагается;
 *   2) скачивание только по согласию кассира, с показом «что нового»;
 *   3) установка запускается вручную, а не «сама при выходе».
 *
 * Скачанный файл проверяется по хэшу: битый установщик хуже, чем
 * отсутствие обновления — он ломает работающую кассу.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, shell } = require('electron');
const store = require('./store.cjs');

/** Сравнение версий вида 1.10.2: по частям, а не как строки —
 *  иначе «1.10» окажется меньше «1.9». */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function check() {
  const s = store.readSettings();
  const state = store.readState();

  // Смена открыта — молчим. Не показываем даже значка: любое сообщение
  // про обновление посреди работы отвлекает кассира.
  if (state.shift) return { skip: 'смена открыта' };

  try {
    const r = await fetch(s.apiUrl.replace(/\/$/, '') + '/pos/update/latest',
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { available: false };
    const d = await r.json();
    if (!d?.available) return { available: false };

    const current = app.getVersion();
    if (!isNewer(d.version, current)) return { available: false, current };
    return { available: true, current, ...d };
  } catch {
    // Нет связи — не беда. Касса работает без интернета, обновится позже.
    return { available: false };
  }
}

/** Скачивание с показом хода: файл весит сотни мегабайт, и молчащая
 *  полоса выглядит как зависшая программа. */
async function download(onProgress) {
  const s = store.readSettings();
  const meta = await check();
  if (!meta.available) throw new Error('Обновление недоступно');

  const url = s.apiUrl.replace(/\/$/, '') + meta.url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);

  const dest = path.join(os.tmpdir(), `Tabys-Kassa-${meta.version}-setup.exe`);
  const file = fs.createWriteStream(dest);
  const total = meta.size || 0;
  let got = 0;

  const reader = res.body.getReader();
  const hash = crypto.createHash('sha256');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    hash.update(value);
    file.write(Buffer.from(value));
    if (onProgress && total) onProgress(Math.round((got / total) * 100));
  }
  await new Promise((res2) => file.end(res2));

  // Проверка целостности: половина файла установится и сломает кассу.
  const sum = hash.digest('hex');
  if (meta.sha256 && sum !== meta.sha256) {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error('Файл скачался с ошибкой — попробуйте ещё раз');
  }
  return { path: dest, version: meta.version };
}

/** Запуск установщика. Касса закроется, установщик спросит подтверждение. */
async function install(filePath) {
  const state = store.readState();
  if (state.shift) throw new Error('Сначала закройте смену — обновление во время работы недопустимо');
  await shell.openPath(filePath);
  setTimeout(() => { app.quitting = true; app.quit(); }, 1500);
  return true;
}

module.exports = { check, download, install, isNewer };
