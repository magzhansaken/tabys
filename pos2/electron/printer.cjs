/*
 * ПЕЧАТЬ ЧЕКОВ И ДЕНЕЖНЫЙ ЯЩИК.
 *
 * ДВА ПРАВИЛА ДОНОРА, ВЫСТРАДАННЫХ КАССОВОЙ ПРАКТИКОЙ:
 *
 * 1. ПО ОЧЕРЕДИ. Их слова: «Чек, бегунок кухни и бегунок бара могут
 *    прилететь в одну секунду. Если слать их параллельно, задания
 *    перемешиваются и ЛЕНТА РВЁТСЯ ПОСРЕДИ ЧЕКА».
 *
 *    В магазине то же: кассир пробил чек, тут же нажал «повторить
 *    печать», а следом пошёл отчёт смены. Три задания в одну секунду —
 *    и покупатель получает половину своего чека и половину чужого.
 *
 * 2. БЕЗ ОБЩЕГО ДОСТУПА. «Старый путь требовал расшарить принтер в
 *    Windows — лишний шаг настройки, о котором никто не знает и
 *    который слетает после обновлений».
 *
 *    Пишем прямо в очередь печати Windows по имени принтера, как он
 *    виден в системе. Достаточно, чтобы принтер был установлен.
 */
const { execFile } = require('child_process');

/* ── ОЧЕРЕДЬ: ОДНО ЗАДАНИЕ ЗА РАЗ ─────────────────────────────────
 *
 * Ошибка одного задания не топит следующее: у кассира кончилась лента
 * на отчёте — чек покупателя всё равно должен выйти.
 */
let chain = Promise.resolve();

function enqueue(job) {
  const turn = chain.then(job, job);
  chain = turn.then(() => undefined, () => undefined);
  return turn;
}

/* ── КОМАНДЫ ПРИНТЕРА (ESC/POS) ───────────────────────────────────
 * Их понимают все чековые принтеры: XPrinter, EPSON, Star.
 */
const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init:      [ESC, 0x40],                  // сброс перед каждым чеком
  cut:       [GS, 0x56, 0x42, 0x00],       // отрезать ленту
  drawer:    [ESC, 0x70, 0x00, 0x19, 0xfa],// открыть денежный ящик
  codepage:  [ESC, 0x74, 0x11],            // кириллица (CP866)
  alignLeft: [ESC, 0x61, 0x00],
};

/**
 * Строки в байты для принтера.
 *
 * КИРИЛЛИЦА В CP866. Принтер не знает нынешних кодировок: пошлёшь
 * обычным способом — на ленте выйдут вопросительные знаки, и кассир
 * решит, что принтер сломан.
 */
function encode(lines) {
  const bytes = [...CMD.init, ...CMD.codepage, ...CMD.alignLeft];

  for (const line of lines) {
    for (const ch of String(line)) {
      const c = ch.codePointAt(0);
      if (c < 128) { bytes.push(c); continue; }
      // А-Я → 0x80-0x9F, а-п → 0xA0-0xAF, р-я → 0xE0-0xEF, ё → 0xF0/0xF1
      if (c >= 0x410 && c <= 0x43f) bytes.push(c - 0x410 + 0x80);
      else if (c >= 0x440 && c <= 0x44f) bytes.push(c - 0x440 + 0xe0);
      else if (c === 0x401) bytes.push(0xf0);
      else if (c === 0x451) bytes.push(0xf1);
      else if (ch === '─' || ch === '═') bytes.push(ch === '─' ? 0xc4 : 0xcd);
      else if (ch === '₸') bytes.push(...[0x54]);   // на ленте — «T»
      else bytes.push(0x3f);                        // незнакомое — вопрос
    }
    bytes.push(0x0a);
  }

  bytes.push(0x0a, 0x0a, 0x0a, ...CMD.cut);
  return Buffer.from(bytes);
}

/* ── ВИРТУАЛЬНЫЕ ПРИНТЕРЫ ─────────────────────────────────────────
 *
 * Урок донора: «PDF, XPS, OneNote, факс не понимают сырые ESC/POS-байты:
 * очередь принимает задание УСПЕШНО, а файл выходит пустым».
 *
 * Владелец ставит кассу и тычет в первый принтер списка — а там часто
 * «Microsoft Print to PDF», он есть в Windows всегда. Касса скажет «чек
 * напечатан», бумаги не будет, и покупатели уйдут без чеков ВЕСЬ ДЕНЬ:
 * ошибки-то нет.
 */
const VIRTUAL = /pdf|xps|onenote|fax|факс|document writer|print to|снимок|snapshot/i;

const isVirtual = (name) => VIRTUAL.test(String(name || ''));

/** Список принтеров с пометкой, какие чеки не печатают. */
async function listPrinters() {
  const out = await ps(
    'Get-Printer | Select-Object -ExpandProperty Name');
  return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((name) => ({ name, virtual: isVirtual(name) }));
}

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

/**
 * НАПЕЧАТАТЬ.
 *
 * Идёт через очередь: следующее задание ждёт, пока принтер не примет
 * это целиком.
 */
function printLines(lines, { printer, copies = 1 } = {}) {
  return enqueue(async () => {
    if (!printer) {
      throw new Error('Принтер не выбран — откройте «Настройки печати»');
    }
    if (isVirtual(printer)) {
      /* Не запрещаем: бывает, что владелец вправду хочет в файл. Но
         называем вещи своими именами, а не молчим. */
      throw new Error(`«${printer}» — это печать в файл, чеки на бумагу не выйдут. `
        + 'Выберите чековый принтер в настройках');
    }

    const bytes = encode(lines);
    const all = copies > 1 ? Buffer.concat(Array(copies).fill(bytes)) : bytes;
    await rawPrint(printer, all);
    return true;
  });
}

/** Открыть денежный ящик. Он подключён к принтеру и слушает его же. */
function openDrawer({ printer } = {}) {
  return enqueue(async () => {
    if (!printer) throw new Error('Принтер не выбран — ящик открывается через него');
    await rawPrint(printer, Buffer.from(CMD.drawer));
    return true;
  });
}

/** Прямая запись в очередь Windows, без общего доступа к принтеру. */
async function rawPrint(printer, buffer) {
  const b64 = buffer.toString('base64');
  await ps(`
$ErrorActionPreference = 'Stop'
$bytes = [Convert]::FromBase64String('${b64}')
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class Raw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr buf, int len, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Принтер не найден");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Чек"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("Принтер не принял задание");
      try {
        if (!StartPagePrinter(h)) throw new Exception("Принтер не принял страницу");
        IntPtr p = Marshal.AllocHGlobal(data.Length);
        try {
          Marshal.Copy(data, 0, p, data.Length);
          int written;
          if (!WritePrinter(h, p, data.Length, out written)) throw new Exception("Ошибка записи");
        } finally { Marshal.FreeHGlobal(p); }
      } finally { EndPagePrinter(h); }
    } finally { EndDocPrinter(h); ClosePrinter(h); }
  }
}
"@
[Raw]::Send('${String(printer).replace(/'/g, "''")}', $bytes)
`);
}

module.exports = { printLines, openDrawer, listPrinters, isVirtual, encode, enqueue };
