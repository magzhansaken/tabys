/*
 * ПЕЧАТЬ ЧЕКОВ И ДЕНЕЖНЫЙ ЯЩИК.
 *
 * ДВА ПРАВИЛА ДОНОРА, ВЗЯТЫЕ ЦЕЛИКОМ:
 *
 * ПО ОЧЕРЕДИ. Их слова: «Чек, бегунок кухни и бегунок бара могут
 * прилететь в одну секунду. Если слать их параллельно, задания
 * перемешиваются и ЛЕНТА РВЁТСЯ ПОСРЕДИ ЧЕКА».
 *
 * В магазине то же: кассир пробил чек, тут же нажал «повторить», а
 * фискальный ответ печатает свою строку. Три задания в одну секунду —
 * и покупатель получит половину своего чека и половину чужого.
 *
 * БЕЗ ОБЩЕГО ДОСТУПА. Их слова: «Старый путь требовал расшарить принтер
 * в Windows — лишний шаг настройки, о котором никто не знает и который
 * слетает после обновлений». Байты идут прямо в очередь печати
 * Windows по имени принтера.
 *
 * И СВОЁ, ИЗ ЭТОГО ЧАТА: печать в PDF названа прямо. Владелец ставит
 * кассу, тычет в первый принтер списка — а там «Microsoft Print to
 * PDF», он есть всегда. Касса скажет «чек напечатан», бумаги не будет,
 * и покупатели уйдут без чеков ВЕСЬ ДЕНЬ: ошибки-то нет.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ── ОЧЕРЕДЬ: ОДНО ЗАДАНИЕ ЗА РАЗ ──────────────────────────────── */
let chain = Promise.resolve();
const enqueue = (task) => (chain = chain.then(task, task));

/* Windows-только: на другой системе печатать нечем, но касса не должна
   падать — она просто скажет об этом. */
const isWindows = process.platform === 'win32';

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

/**
 * ВИРТУАЛЬНЫЕ ПРИНТЕРЫ.
 *
 * Не понимают сырые байты: очередь принимает задание «успешно», а файл
 * выходит пустым. Не запрещаем — бывает, что человек вправду хочет в
 * файл, — но называем вещи своими именами.
 */
const VIRTUAL = /pdf|xps|onenote|fax|факс|document writer|print to|снимок|image writer/i;

const isVirtual = (name) => VIRTUAL.test(String(name || ''));

/** Список принтеров с пометкой, кто из них не печатает чеки. */
async function listPrinters() {
  if (!isWindows) return [];
  const out = await ps('Get-Printer | Select-Object -ExpandProperty Name');
  return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((name) => ({ name, virtual: isVirtual(name) }));
}

/**
 * Отправить байты в принтер.
 *
 * Через временный файл и системную печать: так не нужен общий доступ.
 */
async function sendRaw(printer, bytes) {
  if (!isWindows) throw new Error('Печать доступна только в Windows');
  if (!printer) {
    throw new Error('Принтер чеков не выбран — откройте настройки печати');
  }

  const tmp = path.join(os.tmpdir(), `tabys-${Date.now()}.bin`);
  fs.writeFileSync(tmp, bytes);

  try {
    /* Пишем в очередь печати напрямую (RAW). Имя принтера может
       содержать пробелы и кавычки — экранируем. */
    const имя = String(printer).replace(/'/g, "''");
    await ps(`
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Drawing
      $bytes = [System.IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}')
      $printer = '${имя}'
      $ok = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters -contains $printer
      if (-not $ok) { throw "Принтер не найден: $printer" }
      $handle = [System.IO.File]::OpenWrite('\\\\localhost\\' + $printer)
      $handle.Write($bytes, 0, $bytes.Length)
      $handle.Close()
    `);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* временный файл — не беда */ }
  }
}

/**
 * НАПЕЧАТАТЬ.
 *
 * Всегда через очередь: следующее задание ждёт, пока принтер не примет
 * предыдущее целиком.
 */
function print(printer, bytes) {
  return enqueue(async () => {
    await sendRaw(printer, bytes);
    return true;
  });
}

/**
 * ОТКРЫТЬ ДЕНЕЖНЫЙ ЯЩИК.
 *
 * Ящик подключён к принтеру, а не к компьютеру: открывается его
 * командой. Отдельным заданием, тоже через очередь — иначе импульс
 * уйдёт посреди чека и лента порвётся.
 */
function openDrawer(printer) {
  const bytes = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  return print(printer, bytes);
}

/**
 * ПРОБНАЯ ПЕЧАТЬ.
 *
 * Владелец настроил принтер и хочет убедиться. Печатаем всё, что
 * бывает в чеке: русские буквы, цифры, черту, крупный шрифт.
 */
function testPage(build, width) {
  return build([
    { text: 'ПРОБНАЯ ПЕЧАТЬ', type: 'center', bold: true },
    { text: 'Табыс · Касса', type: 'center' },
    '-'.repeat(width),
    'Русские буквы: АаБбВвГгЁё',
    'Цифры и деньги: 1 234 567 ₸',
    { text: 'КРУПНО', big: true },
    '-'.repeat(width),
    { text: `Ширина ленты: ${width} знаков`, type: 'center' },
    { text: 'Если текст ровный — принтер настроен', type: 'center' },
  ], { width, cut: true });
}

module.exports = { listPrinters, print, openDrawer, isVirtual, testPage, isWindows };
