/*
 * ЯЗЫК ТЕРМОПРИНТЕРА (ESC/POS).
 *
 * Кассовый принтер не печатает текст как обычный: ему шлют байты с
 * командами — «жирный шрифт», «по центру», «отрезать ленту», «открыть
 * денежный ящик».
 *
 * ЛЕНТА УЗКАЯ. На 80 мм помещается 48 знаков в строке, на 58 мм — 32.
 * Ширину задаёт владелец в настройках: принтеры бывают оба.
 *
 * КОДИРОВКА CP866. Термопринтеры не понимают привычную кодировку —
 * русские буквы выйдут мусором. Приходится переводить каждую букву в
 * её номер по таблице CP866.
 */

const ESC = 0x1b;
const GS = 0x1d;

/* Таблица CP866: русские буквы по порядку с 0x80. */
const CP866 = (() => {
  const map = new Map();
  const А = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
  const а = 'абвгдежзийклмноп';       // 0xA0..0xAF
  const р = 'рстуфхцчшщъыьэюя';       // 0xE0..0xEF
  А.split('').forEach((c, i) => map.set(c, 0x80 + i));
  а.split('').forEach((c, i) => map.set(c, 0xa0 + i));
  р.split('').forEach((c, i) => map.set(c, 0xe0 + i));
  map.set('Ё', 0xf0); map.set('ё', 0xf1);
  // Казахские буквы принтеры обычно не знают — заменяем на близкие,
  // чтобы вместо чека не вышел мусор.
  const каз = { 'Ә':'А','ә':'а','Ғ':'Г','ғ':'г','Қ':'К','қ':'к','Ң':'Н','ң':'н',
    'Ө':'О','ө':'о','Ұ':'У','ұ':'у','Ү':'У','ү':'у','Һ':'Х','һ':'х','І':'И','і':'и' };
  for (const [k, v] of Object.entries(каз)) map.set(k, map.get(v) || 0x3f);
  return map;
})();

/*
 * ЗНАКИ, КОТОРЫХ ПРИНТЕР НЕ ЗНАЕТ, — заменяем заранее.
 *
 * Найдено проверкой: «960 ₸» выходило как «960 ?». Покупатель видит
 * вопросительный знак вместо валюты и не понимает, что за сумма.
 *
 * «тг» знают все принтеры, и в Казахстане так пишут повсеместно.
 */
const ЗАМЕНЫ = [
  [/₸/g, 'тг'],
  [/[«»]/g, '"'],       // ёлочки на узкой ленте выходят криво
  [/[—–]/g, '-'],       // длинное тире принтер рисует как мусор
  [/·/g, '*'],
];

/** Перевести строку в байты принтера. */
function encodeText(s) {
  let текст = String(s);
  for (const [что, чем] of ЗАМЕНЫ) текст = текст.replace(что, чем);

  const out = [];
  for (const ch of текст) {
    const code = ch.charCodeAt(0);
    if (code < 128) { out.push(code); continue; }
    const b = CP866.get(ch);
    // Незнакомый знак — вопрос: лучше «?» посреди слова, чем каша во
    // всей ленте.
    out.push(b == null ? 0x3f : b);
  }
  return out;
}

/** Собрать ленту чека в байты. */
function build(lines, { width = 48, cut = true, copies = 1, openDrawer = false } = {}) {
  const b = [];

  b.push(ESC, 0x40);              // сброс: принтер мог остаться в жирном
  b.push(ESC, 0x74, 0x11);        // кодировка CP866

  for (const l of lines) {
    if (l && l.type === 'center') b.push(ESC, 0x61, 0x01);
    else if (l && l.type === 'right') b.push(ESC, 0x61, 0x02);
    else b.push(ESC, 0x61, 0x00);

    if (l && l.bold) b.push(ESC, 0x45, 0x01);
    if (l && l.big) b.push(GS, 0x21, 0x11);      // вдвое выше и шире

    const text = typeof l === 'string' ? l : (l.text || '');
    b.push(...encodeText(text.slice(0, l && l.big ? Math.floor(width / 2) : width)));
    b.push(0x0a);

    if (l && l.big) b.push(GS, 0x21, 0x00);
    if (l && l.bold) b.push(ESC, 0x45, 0x00);
  }

  b.push(0x0a, 0x0a, 0x0a);       // отступ, чтобы чек можно было оторвать
  if (cut) b.push(GS, 0x56, 0x42, 0x00);

  /* ЯЩИК ОТКРЫВАЕТСЯ КОМАНДОЙ ПРИНТЕРА: он подключён к принтеру, а не
     к компьютеру. Двадцать пятая ножка, импульс 50 мс. */
  if (openDrawer) b.push(ESC, 0x70, 0x00, 0x19, 0xfa);

  const one = Buffer.from(b);
  if (copies <= 1) return one;

  // Копии — повтор всей ленты: второй чек нужен для отчётности.
  return Buffer.concat(Array.from({ length: copies }, () => one));
}

/** Строка «слева … справа» по ширине ленты: цена ровно у края. */
function pair(left, right, width = 48) {
  const l = String(left);
  const r = String(right);
  const место = width - r.length;
  if (l.length >= место) return l.slice(0, Math.max(0, место - 1)) + ' ' + r;
  return l + ' '.repeat(место - l.length) + r;
}

/** Разделитель во всю ленту. */
const rule = (width = 48, ch = '-') => ch.repeat(width);

module.exports = { build, encodeText, pair, rule, CP866 };
