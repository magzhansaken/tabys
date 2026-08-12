import { Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * ЭТИКЕТКИ И ЦЕННИКИ.
 *
 * Размеры взяты у UMAG (58×40, 58×30, 43×25, 30×20) — это реальные рулоны,
 * которые продаются в Казахстане. А4-сетка — у МоегоСклада: у половины
 * магазинов у дома нет термопринтера, они печатают на обычном листе и режут.
 *
 * Два языка на этикетке — модель UMAG (у них до 2 из RU/KK/UZ/KG). Казахское
 * наименование уже лежит в карточке товара с Части 1.
 *
 * История печати с повтором — модель Wipon: партия смялась в принтере,
 * нажал «повторить» и не собираешь список заново.
 *
 * Штрихкод рисуем сами: не зависим от внешних библиотек и шрифтов, печатается
 * одинаково на термопринтере, на лазернике и в PDF.
 */

/** Кодировка EAN-13: наборы A, B, C и таблица чётности по первой цифре. */
const EAN_A = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_B = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_C = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['AAAAAA','AABABB','AABBAB','AABBBA','ABAABB','ABBAAB','ABBBAA','ABABAB','ABABBA','ABBABA'];

export interface LabelItem { productId: string; qty: number; }

@Injectable()
export class LabelsService {
  constructor(private db: DbService) {}

  // ==================================================================
  // ШТРИХКОД EAN-13 В SVG
  // ==================================================================
  private ean13Bits(code: string): string {
    if (!/^[0-9]{13}$/.test(code)) throw new BadRequestException(`Штрихкод «${code}» — не 13 цифр`);
    const d = code.split('').map(Number);
    const parity = PARITY[d[0]];
    let bits = '101';                                  // левый маркер
    for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'A' ? EAN_A : EAN_B)[d[i]];
    bits += '01010';                                   // центральный маркер
    for (let i = 7; i <= 12; i++) bits += EAN_C[d[i]];
    bits += '101';                                     // правый маркер
    return bits;
  }

  /** Проверка контрольной цифры: ошибка в одной цифре — чужой товар в чеке. */
  checkDigit(first12: string): number {
    if (!/^[0-9]{12}$/.test(first12)) throw new BadRequestException('Нужно 12 цифр');
    let s = 0;
    for (let i = 0; i < 12; i++) s += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (s % 10)) % 10;
  }

  isValidEan13(code: string): boolean {
    return /^[0-9]{13}$/.test(code) && this.checkDigit(code.slice(0, 12)) === Number(code[12]);
  }

  barcodeSvg(code: string, widthMm: number, heightMm: number): string {
    const bits = this.ean13Bits(code);
    const barW = widthMm / bits.length;
    let rects = '';
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === '1') rects += `<rect x="${(i * barW).toFixed(3)}" y="0" width="${barW.toFixed(3)}" height="${heightMm}" fill="#000"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">${rects}</svg>`;
  }

  // ==================================================================
  // СБОР ДАННЫХ И ВЁРСТКА
  // ==================================================================
  private async loadItems(accountId: string, items: LabelItem[], storeId?: string) {
    const ids = items.map((i) => i.productId);
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.name, p.name_kk, p.article, p.country, p.kind,
                (SELECT code FROM barcode b WHERE b.product_id = p.id AND b.is_primary LIMIT 1) AS barcode,
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id = pp.price_type_id
                  WHERE pp.product_id = p.id AND pt.code = 'retail'
                    AND (pp.store_id = $2 OR pp.store_id IS NULL)
                  ORDER BY pp.store_id NULLS LAST LIMIT 1) AS price,
                (SELECT short_name FROM unit u WHERE u.id = p.unit_id) AS unit
           FROM product p WHERE p.id = ANY($1) AND p.deleted_at IS NULL`,
        [ids, storeId ?? null]);
      return rows;
    });
  }

  private esc(s: any) {
    return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
  }

  private money(v: any) {
    if (v == null) return '';
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(v)) + ' ₸';
  }

  /** Одна этикетка или один ценник. */
  private renderOne(p: any, tpl: any): string {
    const f = tpl.fields ?? {};
    const scale = Number(tpl.font_scale);
    const w = Number(tpl.width_mm), h = Number(tpl.height_mm);
    const isTag = tpl.kind === 'price_tag';

    // Два языка (модель UMAG): второе название — из карточки, поле name_kk
    const nameLines: string[] = [];
    if (f.name !== false) {
      nameLines.push(this.esc(p.name));
      if (tpl.lang2 && tpl.lang2 !== tpl.lang1 && p.name_kk) nameLines.push(this.esc(p.name_kk));
    }

    const nameSize = (isTag ? 2.6 : 2.2) * scale;
    const priceSize = (isTag ? h * 0.34 : 3.6) * scale;

    let y = 3.2;
    let body = '';
    for (const line of nameLines) {
      body += `<div class="nm" style="font-size:${nameSize.toFixed(2)}mm">${line}</div>`;
    }
    if (f.article && p.article) body += `<div class="sm">Арт. ${this.esc(p.article)}</div>`;
    if (f.country && p.country) body += `<div class="sm">${this.esc(p.country)}</div>`;
    if (f.price !== false) body += `<div class="pr" style="font-size:${priceSize.toFixed(2)}mm">${this.money(p.price)}</div>`;

    // штрихкод: только если он есть и валиден — иначе печатаем предупреждение,
    // а не молча кривую полоску, которую касса потом не считает
    if (f.barcode && p.barcode) {
      if (this.isValidEan13(p.barcode)) {
        const bw = w * 0.86, bh = Math.max(6, h * 0.28);
        body += `<div class="bc">${this.barcodeSvg(p.barcode, bw, bh)}<div class="bcn">${this.esc(p.barcode)}</div></div>`;
      } else {
        body += `<div class="warn">штрихкод не EAN-13: ${this.esc(p.barcode)}</div>`;
      }
    }
    if (f.date) body += `<div class="sm">${new Date().toLocaleDateString('ru-RU')}</div>`;

    return `<div class="lbl">${body}</div>`;
  }

  /**
   * HTML для печати с точными миллиметрами: одинаково уходит и на
   * термопринтер, и на обычный А4, и в PDF. Картинкой делать нельзя —
   * на термопринтере получится мыло.
   */
  async render(accountId: string, templateId: string, items: LabelItem[], storeId?: string) {
    const tpl = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM label_template WHERE id=$1 AND deleted_at IS NULL`, [templateId])).rows[0]);
    if (!tpl) throw new BadRequestException('Шаблон не найден');

    const products = await this.loadItems(accountId, items, storeId);
    const byId = new Map(products.map((p: any) => [p.id, p]));

    const missing = items.filter((i) => !byId.has(i.productId));
    if (missing.length) throw new BadRequestException(`Товары не найдены: ${missing.length}`);

    let cells = '';
    let total = 0;
    for (const it of items) {
      const p = byId.get(it.productId);
      for (let k = 0; k < Math.max(1, it.qty); k++) { cells += this.renderOne(p, tpl); total++; }
    }

    const w = Number(tpl.width_mm), h = Number(tpl.height_mm);
    const isA4 = tpl.paper === 'a4';
    const page = isA4
      ? `@page { size: A4; margin: ${tpl.margin_mm}mm; }`
      : `@page { size: ${w}mm ${h}mm; margin: 0; }`;   // рулон: страница = этикетка

    const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Печать: ${this.esc(tpl.name)}</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, "Noto Sans", sans-serif; }
  .sheet { display: ${isA4 ? 'grid' : 'block'};
           ${isA4 ? `grid-template-columns: repeat(${tpl.cols}, ${w}mm); gap: ${tpl.gap_mm}mm;` : ''} }
  .lbl { width: ${w}mm; height: ${h}mm; padding: 1.5mm; overflow: hidden;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         text-align: center; page-break-inside: avoid; ${isA4 ? 'border: 0.2mm dashed #bbb;' : ''} }
  ${!isA4 ? '.lbl { page-break-after: always; }' : ''}
  .nm { font-weight: 600; line-height: 1.1; max-height: ${(h * 0.4).toFixed(1)}mm; overflow: hidden; }
  .pr { font-weight: 800; line-height: 1.05; margin-top: 0.6mm; }
  .sm { font-size: ${(1.8 * Number(tpl.font_scale)).toFixed(2)}mm; color: #333; }
  .bc { margin-top: 0.8mm; }
  .bcn { font-size: ${(1.7 * Number(tpl.font_scale)).toFixed(2)}mm; letter-spacing: 0.3mm; }
  .warn { font-size: 1.6mm; color: #c00; }
  @media screen { body { background: #eee; padding: 8mm; } .sheet { background: #fff; } }
</style></head>
<body><div class="sheet">${cells}</div>
<script>if (location.search.includes('print=1')) window.print();</script>
</body></html>`;

    return { html, totalLabels: total, template: { id: tpl.id, name: tpl.name, width: w, height: h, paper: tpl.paper } };
  }

  /** Печать + запись в историю (модель Wipon). */
  async print(accountId: string, employeeId: string | null, templateId: string, items: LabelItem[], storeId?: string) {
    const r = await this.render(accountId, templateId, items, storeId);
    const job = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO label_print_job (account_id, employee_id, template_id, store_id, items, total_labels)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, printed_at`,
        [accountId, employeeId, templateId, storeId ?? null, JSON.stringify(items), r.totalLabels])).rows[0]);
    return { ...r, jobId: job.id, printedAt: job.printed_at };
  }

  /** История печати. */
  async history(accountId: string, limit = 50) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT j.id, j.total_labels, j.printed_at, j.repeated_from, t.name AS template_name,
                e.first_name AS employee
           FROM label_print_job j
           LEFT JOIN label_template t ON t.id = j.template_id
           LEFT JOIN employee e ON e.id = j.employee_id
          ORDER BY j.printed_at DESC LIMIT $1`, [limit])).rows);
  }

  /** Повторить печать (модель Wipon): партия смялась — не собираем список заново. */
  async repeat(accountId: string, employeeId: string | null, jobId: string) {
    const job = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM label_print_job WHERE id=$1`, [jobId])).rows[0]);
    if (!job) throw new BadRequestException('Печать не найдена в истории');

    const r = await this.render(accountId, job.template_id, job.items, job.store_id);
    const nj = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO label_print_job (account_id, employee_id, template_id, store_id, items, total_labels, repeated_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [accountId, employeeId, job.template_id, job.store_id, JSON.stringify(job.items), r.totalLabels, jobId])).rows[0]);
    return { ...r, jobId: nj.id, repeatedFrom: jobId };
  }

  async templates(accountId: string, kind?: 'label' | 'price_tag') {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, name, kind, paper, width_mm, height_mm, cols, rows_per_page, font_scale, lang1, lang2, fields, is_default
           FROM label_template WHERE deleted_at IS NULL AND ($1::text IS NULL OR kind::text = $1)
          ORDER BY kind, is_default DESC, name`, [kind ?? null])).rows);
  }

  async saveTemplate(accountId: string, dto: any) {
    return this.db.withTenant(accountId, async (c) => {
      if (dto.isDefault) {
        await c.query(`UPDATE label_template SET is_default=false WHERE kind=$1 AND deleted_at IS NULL`, [dto.kind ?? 'label']);
      }
      if (dto.id) {
        const { rows } = await c.query(
          `UPDATE label_template SET name=$2, width_mm=$3, height_mm=$4, font_scale=$5,
                  lang1=$6, lang2=$7, fields=$8, is_default=coalesce($9,is_default), cols=$10, rows_per_page=$11
             WHERE id=$1 RETURNING *`,
          [dto.id, dto.name, dto.widthMm, dto.heightMm, dto.fontScale ?? 1, dto.lang1 ?? 'ru',
           dto.lang2 ?? null, JSON.stringify(dto.fields ?? {}), dto.isDefault ?? null, dto.cols ?? 1, dto.rowsPerPage ?? 1]);
        return rows[0];
      }
      const { rows } = await c.query(
        `INSERT INTO label_template (account_id, name, kind, paper, width_mm, height_mm, cols, rows_per_page,
                                     font_scale, lang1, lang2, fields, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [accountId, dto.name, dto.kind ?? 'label', dto.paper ?? 'roll', dto.widthMm, dto.heightMm,
         dto.cols ?? 1, dto.rowsPerPage ?? 1, dto.fontScale ?? 1, dto.lang1 ?? 'ru', dto.lang2 ?? null,
         JSON.stringify(dto.fields ?? {}), dto.isDefault ?? false]);
      return rows[0];
    });
  }
}
