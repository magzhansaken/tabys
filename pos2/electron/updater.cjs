/*
 * ОБНОВЛЕНИЕ КАССЫ.
 *
 * ГЛАВНОЕ ПРАВИЛО, выстраданное на боевой кассе: НИКОГДА НЕ ОБНОВЛЯТЬ
 * ПОСРЕДИ СМЕНЫ.
 *
 * Обновление во время очереди — это остановка торговли, и виноват
 * будет не Windows, а мы. Касса уходит на минуту, а покупатель стоит с
 * деньгами.
 *
 * У ДОНОРА ТРИ ЗАЩИТЫ, у меня четыре:
 *   скачивание только по согласию (у них тоже);
 *   не ставить при выходе (у них тоже);
 *   откат к старой версии отбит (у них тоже);
 *   ПРИ ОТКРЫТОЙ СМЕНЕ ДАЖЕ НЕ ПРЕДЛАГАЕМ — этого у них нет.
 *
 * Их довод «установка безопасна в любой момент: очередь чеков живёт на
 * диске» верен ДЛЯ ЧЕКОВ. Но не для покупателя.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/**
 * СРАВНЕНИЕ ВЕРСИЙ — ЧИСЛАМИ, А НЕ СТРОКАМИ.
 *
 * Строкой «2.10» меньше «2.9», и касса откатилась бы на девять версий
 * назад. Это не выдумка: так ломаются обновления повсеместно.
 */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Спросить сервер, есть ли новая. */
function check({ apiUrl, current, deviceToken }) {
  return new Promise((resolve, reject) => {
    const url = String(apiUrl || '').replace(/\/$/, '') + '/pos/update';
    const lib = url.startsWith('https') ? https : http;

    const req = lib.get(url, {
      headers: deviceToken ? { 'x-device-token': deviceToken } : {},
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (!d || !d.version) return resolve({ available: false, current });

          /* ОТКАТ ОТБИТ. Владелец выложил 2.5.0, потом по ошибке залил
             2.3.0 поверх — кассы поставили бы СТАРУЮ и откатили правки
             недели разом. Хуже: касса уже писала чеки в новом виде, а
             старая их не поймёт. */
          if (!isNewer(d.version, current)) {
            return resolve({ available: false, current, server: d.version });
          }

          resolve({
            available: true, current,
            version: d.version,
            url: d.url,
            sha256: d.sha256 || null,
            notes: d.notes || '',
            size: d.size || 0,
          });
        } catch (e) { reject(new Error('Сервер ответил непонятно')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Сервер не отвечает')); });
    req.on('error', () => reject(new Error('Нет связи с сервером')));
  });
}

/**
 * СКАЧАТЬ.
 *
 * ОТПЕЧАТОК ПРОВЕРЯЕМ ОБЯЗАТЕЛЬНО. Файл мог побиться по дороге или
 * скачаться наполовину — установщик тогда испортит рабочую кассу, и
 * магазин встанет до приезда мастера.
 */
function download({ url, version, sha256, onProgress }) {
  return new Promise((resolve, reject) => {
    const dest = path.join(os.tmpdir(), `Tabys-Kassa-${version}-setup.exe`);
    const file = fs.createWriteStream(dest);
    const lib = String(url).startsWith('https') ? https : http;
    const hash = crypto.createHash('sha256');

    lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {});
        return reject(new Error(`Файл не скачался (${res.statusCode})`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;

      res.on('data', (c) => {
        got += c.length;
        hash.update(c);
        if (onProgress && total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          const свой = hash.digest('hex');
          if (sha256 && свой !== String(sha256).toLowerCase()) {
            fs.unlink(dest, () => {});
            return reject(new Error(
              'Файл скачался повреждённым — установка отменена. Попробуйте ещё раз'));
          }
          resolve({ path: dest, version, sha256: свой });
        });
      });
    }).on('error', (e) => {
      file.close(); fs.unlink(dest, () => {});
      reject(new Error('Не удалось скачать: ' + e.message));
    });
  });
}

/**
 * МОЖНО ЛИ СЕЙЧАС ОБНОВЛЯТЬСЯ.
 *
 * Главная защита, которой нет у донора.
 */
function canUpdate(state) {
  if (state && state.shift) {
    return {
      ok: false,
      said: 'Смена открыта — обновимся после её закрытия. '
        + 'Обновление посреди смены останавливает торговлю',
    };
  }
  if (state && state.pendingCount > 0) {
    /* И НЕОТПРАВЛЕННЫЕ ЧЕКИ. Они переживут перезапуск, но лучше
       дождаться: вдруг новая версия читает их иначе. */
    return {
      ok: false,
      said: `Не отправлено чеков: ${state.pendingCount}. Дождитесь связи — `
        + 'после обновления они уйдут сами, но спокойнее сделать это сейчас',
    };
  }
  return { ok: true };
}

/**
 * ПОСТАВИТЬ.
 *
 * Запускаем установщик и выходим: он сам закроет кассу и поднимет
 * новую. Ставится ВРУЧНУЮ, а не «сама при выходе» — кассир должен
 * знать, что происходит.
 */
function install({ file, onQuit }) {
  const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' });
  child.unref();
  if (onQuit) setTimeout(onQuit, 1500);
  return true;
}

module.exports = { isNewer, check, download, canUpdate, install };
