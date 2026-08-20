/**
 * ПЕЧАТЬ ЧЕКОВ (ESC/POS) и денежный ящик.
 *
 * Два правила, выстраданные на боевой кассе соседнего проекта:
 *
 * 1. ОЧЕРЕДЬ ЗАДАНИЙ. Чек и копия могут уйти в одну секунду.
 *    Параллельная отправка перемешивает задания и рвёт ленту посреди
 *    чека. Поэтому здесь одна очередь: следующее печатается только
 *    после предыдущего.
 *
 * 2. БЕЗ ОБЩЕГО ДОСТУПА К ПРИНТЕРУ. Старый способ (копирование файла на
 *    \\localhost\Имя) требует включить «Общий доступ» в Windows — лишняя
 *    настройка, которая слетает после обновлений. Правильно — писать
 *    сырые байты прямо в очередь печати через системную библиотеку
 *    winspool. Тогда достаточно, чтобы принтер просто был установлен.
 *
 * Если принтера нет вовсе, касса продолжает работать: чек можно
 * посмотреть на экране. Продажа важнее печати.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Настройки подгружаются лениво: так модуль сборки чека можно проверять
// отдельно, без запуска Electron. Проверяемость важнее краткости.
let _store = null;
const store = () => (_store ??= require('./store.cjs'));

// ── Очередь: не печатаем два задания одновременно ────────────────────
let chain = Promise.resolve();
const enqueue = (task) => (chain = chain.then(task, task));

const ps = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20000 },
    (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
});

/** Список установленных принтеров — для выбора в настройках кассы. */
async function listPrinters() {
  if (process.platform !== 'win32') return [];
  const out = await ps('Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name');
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Отправка сырых байтов в очередь печати через winspool.
 * Скрипт PowerShell пишется во временный файл, а не передаётся строкой:
 * длинные строки с кавычками PowerShell портит — проверено на этом
 * проекте дважды.
 */
async function sendRaw(bytes, printerName) {
  if (process.platform !== 'win32') throw new Error('Печать доступна только в Windows');
  const tmpData = path.join(os.tmpdir(), `tabys-print-${Date.now()}.bin`);
  const tmpPs = path.join(os.tmpdir(), `tabys-print-${Date.now()}.ps1`);
  fs.writeFileSync(tmpData, Buffer.from(bytes));

  const script = `
$ErrorActionPreference = "Stop"
$printer = ${printerName ? `"${printerName.replace(/"/g, '""')}"` : '(Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1 -ExpandProperty Name)'}
if (-not $printer) { throw "Принтер не найден" }
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static void Send(string printerName, byte[] bytes) {
    IntPtr h; if (!OpenPrinter(printerName, out h, IntPtr.Zero)) throw new Exception("Не удалось открыть принтер");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Tabys chek"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("Не удалось начать печать");
      try {
        if (!StartPagePrinter(h)) throw new Exception("Не удалось начать страницу");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try { Marshal.Copy(bytes, 0, p, bytes.Length); int written;
              if (!WritePrinter(h, p, bytes.Length, out written)) throw new Exception("Ошибка записи"); }
        finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes("${tmpData.replace(/\\/g, '\\\\')}")
[RawPrinter]::Send($printer, $bytes)
`;
  fs.writeFileSync(tmpPs, '\ufeff' + script, 'utf8');   // BOM: PowerShell иначе портит кириллицу
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs],
        { windowsHide: true, timeout: 20000 },
        (err, _o, stderr) => err ? reject(new Error(stderr || err.message)) : resolve());
    });
  } finally {
    try { fs.unlinkSync(tmpData); fs.unlinkSync(tmpPs); } catch {}
  }
}

// ── Сборка чека в командах ESC/POS ───────────────────────────────────
const ESC = 0x1b, GS = 0x1d;
const cp866 = (s) => {
  // Кириллица для чековых принтеров: кодовая страница 866.
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 128) out.push(c);
    else if (c >= 0x410 && c <= 0x43f) out.push(c - 0x410 + 0x80);   // А-п
    else if (c >= 0x440 && c <= 0x44f) out.push(c - 0x440 + 0xe0);   // р-я
    else if (c === 0x401) out.push(0xf0);                            // Ё
    else if (c === 0x451) out.push(0xf1);                            // ё
    else if (c === 0x2116) out.push(0xfc);                           // №
    else out.push(0x3f);                                             // ? вместо неизвестного
  }
  return out;
};

/** Строка «слева … справа» ровно по ширине ленты — иначе итог не сходится глазом. */
const pad = (left, right, width) => {
  const l = String(left), r = String(right);
  const space = Math.max(1, width - l.length - r.length);
  return l + ' '.repeat(space) + r;
};

function buildReceipt(d, width) {
  const b = [];
  const line = (s = '') => { b.push(...cp866(s), 0x0a); };
  const center = (s) => { b.push(ESC, 0x61, 1); line(s); b.push(ESC, 0x61, 0); };
  const bold = (on) => b.push(ESC, 0x45, on ? 1 : 0);

  b.push(ESC, 0x40);            // сброс принтера
  b.push(ESC, 0x74, 17);        // кодовая страница 866 (кириллица)

  bold(true); center(d.store || 'Магазин'); bold(false);

  /* ОТЧЁТ ЗАКРЫТИЯ — не чек: у него нет товаров, способов оплаты и
   * фискального номера. Строим отдельно, а не подгоняем чек.
   *
   * Он нужен на бумаге, потому что кассир сдаёт по нему деньги
   * старшему: без бумаги сдают на словах, и спор — слово против
   * слова. */
  if (d.isReport) {
    line('-'.repeat(width));
    bold(true); center(d.title || 'ОТЧЁТ'); bold(false);
    line('-'.repeat(width));
    line(d.date || '');
    if (d.cashier) line('Кассир: ' + d.cashier);
    line('-'.repeat(width));
    for (const [name, value] of (d.lines || [])) line(pad(name, value, width));
    line('-'.repeat(width));
    // Место для подписи: отчёт кладут в папку и подписывают.
    line('');
    line('Сдал: ______________');
    line('');
    line('Принял: ____________');
    line('');
    b.push(0x1d, 0x56, 0x42, 0x00);   // отрез
    return Buffer.from(b);
  }

  if (d.address) center(d.address);
  if (d.bin) center('БИН/ИИН: ' + d.bin);
  line('-'.repeat(width));
  line(pad(d.isPreReceipt ? 'ПРЕДВАРИТЕЛЬНЫЙ РАСЧЁТ'
    : d.isRefund ? 'ВОЗВРАТ' : 'ЧЕК № ' + (d.number ?? '—'), d.date || '', width));
  if (d.cashier) line('Кассир: ' + d.cashier);
  line('-'.repeat(width));

  for (const it of d.items || []) {
    line(it.name);
    const qty = `${it.qty} x ${money(it.price)}`;
    line(pad('  ' + qty, money(it.total), width));
  }

  line('-'.repeat(width));
  if (d.discount) line(pad('Скидка', '-' + money(d.discount), width));
  bold(true);
  b.push(GS, 0x21, 0x01);                       // двойная высота для итога
  line(pad('ИТОГО', money(d.total), width));
  b.push(GS, 0x21, 0x00);
  bold(false);

  for (const p of d.payments || []) line(pad(p.label, money(p.sum), width));
  if (d.change) line(pad('Сдача', money(d.change), width));

  line('-'.repeat(width));
  if (d.isPreReceipt) {
    // Крупно и по центру: покупатель не должен принять пречек за чек и
    // уйти без настоящего — а магазин остаться без фискального документа.
    b.push(ESC, 0x45, 1);
    center('ЭТО НЕ ЧЕК');
    b.push(ESC, 0x45, 0);
    center('Предварительный расчёт');
  }
  if (d.offline) center('Чек сохранён, отправка при связи');
  // На пречеке прощального текста нет: покупатель ещё ничего не купил,
  // и «спасибо за покупку» на предварительном расчёте сбивает с толку —
  // человек решает, что чек уже пробит.
  if (!d.isPreReceipt) center(d.footer ?? 'Спасибо за покупку!');
  center('Табыс');
  line(); line(); line();
  b.push(GS, 0x56, 0x00);       // отрез ленты
  return b;
}

const money = (n) => {
  const v = Number(n || 0);
  // Целые — без копеек, дробные — с копейками. Иначе столбик оплат
  // не сходится с итогом на единицу, и владелец видит «недостачу».
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' T';
};

/** Напечатать чек. Возвращает описание ошибки, но кассу не роняет. */
function printReceipt(data) {
  return enqueue(async () => {
    const s = store().readSettings();
    // КОПИИ ОДНИМ ЗАДАНИЕМ, а не несколькими. Отдельные задания
    // встают в очередь порознь и могут перемешаться с чужим чеком —
    // лента порвётся посреди. Отрез после каждой копии уже внутри
    // сборки, поэтому кассир снимает готовые листы.
    const one = buildReceipt(data, s.printWidth || 48);
    const copies = Math.min(3, Math.max(1, Number(s.printCopies) || 1));
    const bytes = copies === 1
      ? one
      : Buffer.concat(Array.from({ length: copies }, () => one));
    await sendRaw(bytes, s.printer);
    if (s.openDrawerOnCash && data.hasCash) await sendRaw([ESC, 0x70, 0x00, 0x19, 0xfa], s.printer);
    return true;
  });
}

/** Денежный ящик открывается командой через тот же принтер. */
function openCashDrawer() {
  return enqueue(async () => {
    const s = store().readSettings();
    await sendRaw([ESC, 0x70, 0x00, 0x19, 0xfa], s.printer);
    return true;
  });
}

/**
 * ДИАГНОСТИКА ПЕЧАТИ.
 *
 * Печатает лист, по которому сразу видно всё, что обычно выясняется
 * методом проб на живом клиенте:
 *   · РАМКА по краям — если она не помещается или обрывается, значит
 *     выбрана не та ширина ленты (58 мм вместо 80 или наоборот);
 *   · ЛИНЕЙКА с цифрами — видно, сколько знаков реально влезает;
 *   · КИРИЛЛИЦА и цифры — если вместо букв кракозябры, не та кодовая
 *     страница у принтера;
 *   · ЖИРНЫЙ и ДВОЙНАЯ ВЫСОТА — поддерживает ли принтер выделение;
 *   · ДЕНЬГИ в том же виде, что в чеке.
 *
 * Приём подсмотрен у соседнего проекта: они оборачивали ленту рамкой
 * │…│ именно чтобы ширина была видна с одного взгляда.
 */
function buildDiagnostic(width) {
  const b = [];
  const line = (s = '') => { b.push(...cp866(s), 0x0a); };
  const framed = (s) => line('|' + String(s).padEnd(width - 2).slice(0, width - 2) + '|');
  const center = (s) => { b.push(ESC, 0x61, 1); line(s); b.push(ESC, 0x61, 0); };

  b.push(ESC, 0x40);            // сброс
  b.push(ESC, 0x74, 17);        // кодовая страница 866

  b.push(ESC, 0x45, 1); center('ПРОВЕРКА ПЕЧАТИ'); b.push(ESC, 0x45, 0);
  center(`Табыс - ширина ${width} знаков`);
  line();

  // Рамка: сразу видно, помещается ли строка целиком
  line('+' + '-'.repeat(width - 2) + '+');
  framed(' Если рамка ровная - ширина верная');
  framed(' Если обрывается - смените ширину');
  line('+' + '-'.repeat(width - 2) + '+');
  line();

  // Линейка: считаем знаки
  line('Линейка (считайте знаки до края):');
  let ruler = '';
  for (let i = 1; i <= width; i++) ruler += (i % 10 === 0) ? String((i / 10) % 10) : '.';
  line(ruler);
  line();

  // Кириллица и цифры
  line('Кириллица: АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ');
  line('Строчные:  абвгдеёжзийклмнопрстуфхцчшщъыьэюя');
  line('Цифры:     0123456789   Знаки: N% - + / ( )');
  line();

  // Выделение
  b.push(ESC, 0x45, 1); line('Жирный шрифт - для итога'); b.push(ESC, 0x45, 0);
  b.push(GS, 0x21, 0x01); line('Двойная высота'); b.push(GS, 0x21, 0x00);
  line();

  // Деньги — в точности как в чеке
  line('Деньги в чеке:');
  line(pad('  Обычная сумма', money(1250), width));
  line(pad('  Большая сумма', money(1234567), width));
  line(pad('  С копейками', money(99.5), width));
  line('-'.repeat(width));
  b.push(ESC, 0x45, 1);
  line(pad('ИТОГО', money(1334916.5), width));
  b.push(ESC, 0x45, 0);
  line();

  center('Если всё читается - принтер настроен');
  line(); line(); line();
  b.push(GS, 0x56, 0x00);       // отрез
  return b;
}

/** Печать диагностики. Ящик НЕ открываем: это проверка бумаги, а не денег. */
function printDiagnostic() {
  return enqueue(async () => {
    const s = store().readSettings();
    await sendRaw(buildDiagnostic(s.printWidth || 48), s.printer);
    return true;
  });
}

module.exports = { printReceipt, listPrinters, openCashDrawer, buildReceipt,
                   buildDiagnostic, printDiagnostic, money };
