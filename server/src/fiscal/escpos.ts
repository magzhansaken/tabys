/**
 * ПЕЧАТЬ ЧЕКА НА ESC/POS.
 *
 * ESC/POS — общий язык чековых принтеров (Xprinter, Rongta, Sunmi, Атол).
 * Байты пишем сами: команды простые, а внешняя библиотека — это чужой риск
 * в самом горячем месте продукта. Если она сломается на обновлении, встанут
 * все кассы разом.
 *
 * Ширина: 58 мм (32 символа) и 80 мм (48) — оба формата в Казахстане живые.
 *
 * Брендирование — идея Wipon (у них данные организации в чеках и отчётах):
 * магазин печатает своё название, а не наше.
 */

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

export type Align = 'left' | 'center' | 'right';

export interface ReceiptData {
  brand?: { name?: string; address?: string; phone?: string; bin?: string };
  kkm?: { regNumber?: string; serialNumber?: string };
  receiptNumber?: string | number;
  cashier?: string;
  consultant?: string;
  datetime?: Date;
  items: { name: string; qty: number; price: number; total: number; discount?: number; ntin?: string }[];
  subtotal: number;
  discount?: number;
  rounding?: number;
  total: number;
  payments: { method: string; amount: number }[];
  change?: number;
  fiscalNumber?: string;
  checkUrl?: string;
  isRefund?: boolean;
  footer?: string;
  lang?: 'ru' | 'kk';
}

const T: Record<string, Record<string, string>> = {
  ru: { receipt: 'ЧЕК', refund: 'ВОЗВРАТ', subtotal: 'Итого', discount: 'Скидка', rounding: 'Округление',
        total: 'К ОПЛАТЕ', change: 'Сдача', cashier: 'Кассир', consultant: 'Продавец', fiscal: 'Фискальный признак',
        cash: 'Наличные', card: 'Карта', qr: 'QR', credit: 'В долг', thanks: 'Спасибо за покупку!',
        check: 'Проверить чек:', bin: 'БИН', kkm: 'ККМ', notFiscal: 'ЧЕК НЕ ФИСКАЛЬНЫЙ' },
  kk: { receipt: 'ЧЕК', refund: 'ҚАЙТАРУ', subtotal: 'Барлығы', discount: 'Жеңілдік', rounding: 'Дөңгелектеу',
        total: 'ТӨЛЕУГЕ', change: 'Қайтарым', cashier: 'Кассир', consultant: 'Сатушы', fiscal: 'Фискалдық белгі',
        cash: 'Қолма-қол', card: 'Карта', qr: 'QR', credit: 'Қарызға', thanks: 'Сатып алғаныңызға рахмет!',
        check: 'Чекті тексеру:', bin: 'БСН', kkm: 'БКМ', notFiscal: 'ЧЕК ФИСКАЛДЫҚ ЕМЕС' },
};

export class EscPosBuilder {
  private buf: number[] = [];
  constructor(private width = 32) {}

  raw(...b: number[]) { this.buf.push(...b); return this; }

  /** Кириллица: CP866 — её понимают все чековые принтеры на рынке КЗ. */
  text(s: string) {
    for (const ch of s) this.buf.push(cp866(ch));
    return this;
  }

  line(s = '') { return this.text(s).raw(LF); }
  init() { return this.raw(ESC, 0x40); }                          // сброс принтера
  align(a: Align) { return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0); }
  bold(on: boolean) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  double(on: boolean) { return this.raw(GS, 0x21, on ? 0x11 : 0x00); }   // двойная высота и ширина
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  cut() { return this.raw(GS, 0x56, 0x42, 0x00); }                // частичная отрезка
  drawer() { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); }      // импульс на денежный ящик
  divider(ch = '-') { return this.line(ch.repeat(this.width)); }

  /** Две колонки: слева текст, справа сумма — основа чека. */
  pair(left: string, right: string) {
    const space = this.width - left.length - right.length;
    if (space < 1) {
      this.line(left.slice(0, this.width));
      return this.line(right.padStart(this.width));
    }
    return this.line(left + ' '.repeat(space) + right);
  }

  /** QR-код: ссылка на проверку чека у оператора. */
  qr(data: string, size = 6) {
    const bytes = data.split('').map((c) => c.charCodeAt(0));
    const len = bytes.length + 3;
    this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);           // модель 2
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size);                 // размер точки
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);                 // коррекция ошибок L
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes);  // данные
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);                 // печать
    return this;
  }

  build(): Buffer { return Buffer.from(this.buf); }
}

/** CP866 — кодировка, которую понимают чековые принтеры. */
function cp866(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c < 128) return c;
  if (c >= 0x410 && c <= 0x43f) return c - 0x410 + 0x80;      // А–п
  if (c >= 0x440 && c <= 0x44f) return c - 0x440 + 0xe0;      // р–я
  if (c === 0x401) return 0xf0;                                // Ё
  if (c === 0x451) return 0xf1;                                // ё
  if (c === 0x20b8) return 0x54;                               // ₸ → «T»: символа тенге в CP866 нет
  const kk: Record<number, number> = {                         // казахские буквы принтеры не знают —
    0x04d8: 0x41, 0x04d9: 0x61, 0x0492: 0x47, 0x0493: 0x67,    // приводим к близкой латинице,
    0x049a: 0x4b, 0x049b: 0x6b, 0x04a2: 0x48, 0x04a3: 0x68,    // иначе на чеке будет мусор
    0x04e8: 0x4f, 0x04e9: 0x6f, 0x04b0: 0x55, 0x04b1: 0x75,
    0x04ae: 0x55, 0x04af: 0x75, 0x04ba: 0x48, 0x04bb: 0x68,
    0x0406: 0x49, 0x0456: 0x69,
  };
  return kk[c] ?? 0x3f;                                        // «?» вместо неизвестного
}

const money = (v: number) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v);

/** Сборка чека целиком. */
export function renderReceipt(d: ReceiptData, width = 32): Buffer {
  const t = T[d.lang ?? 'ru'];
  const b = new EscPosBuilder(width);
  b.init().align('center');

  // брендирование магазина (идея Wipon): его название, не наше
  if (d.brand?.name) b.bold(true).double(true).line(d.brand.name).double(false).bold(false);
  if (d.brand?.address) b.line(d.brand.address);
  if (d.brand?.phone) b.line(d.brand.phone);
  if (d.brand?.bin) b.line(`${t.bin}: ${d.brand.bin}`);
  if (d.kkm?.regNumber) b.line(`${t.kkm}: ${d.kkm.regNumber}`);

  b.divider();
  b.bold(true).line(d.isRefund ? t.refund : t.receipt).bold(false);
  if (d.receiptNumber != null) b.line(`№ ${d.receiptNumber}`);
  b.align('left');
  b.line((d.datetime ?? new Date()).toLocaleString('ru-RU'));
  if (d.cashier) b.line(`${t.cashier}: ${d.cashier}`);
  if (d.consultant) b.line(`${t.consultant}: ${d.consultant}`);   // продавец в чеке (модель UMAG)
  b.divider();

  for (const it of d.items) {
    b.line(it.name.slice(0, width));
    b.pair(`  ${it.qty} x ${money(it.price)}`, money(it.total));
    if (it.discount) b.pair(`  ${t.discount}`, `-${money(it.discount)}`);
    if (it.ntin) b.line(`  НКТ: ${it.ntin}`);                     // NTIN в чеке (обязателен в КЗ)
  }

  b.divider();
  b.pair(t.subtotal, money(d.subtotal));
  if (d.discount) b.pair(t.discount, `-${money(d.discount)}`);
  if (d.rounding) b.pair(t.rounding, money(d.rounding));
  b.bold(true).double(true).pair(t.total, money(d.total)).double(false).bold(false);

  for (const p of d.payments) b.pair(t[p.method] ?? p.method, money(p.amount));
  if (d.change) b.pair(t.change, money(d.change));

  b.divider();
  if (d.fiscalNumber) {
    b.align('center').line(`${t.fiscal}:`).bold(true).line(d.fiscalNumber).bold(false);
    if (d.checkUrl) { b.line(t.check); b.qr(d.checkUrl); }
  } else {
    // честно: чек ещё не фискализирован (офлайн). Признак придёт позже — модель Wipon
    b.align('center').bold(true).line(t.notFiscal).bold(false);
  }

  b.align('center').line(d.footer ?? t.thanks);
  b.feed(3).cut();
  return b.build();
}
