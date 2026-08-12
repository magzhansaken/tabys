import { Controller, Get, Post, Body, Query, Param, Module, Injectable, BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { ReportService } from '../reports/report.service';
import { AdminApiModule } from '../admin/admin.module';

/**
 * ЭКСПОРТ И ФИРМЕННЫЙ СТИЛЬ (часть 21).
 *
 * Экспорт: у всех троих есть кнопка «Скачать» — у нас её не было, это была
 * единственная реальная дыра против UMAG. Но мы делаем её сильнее:
 * выгрузка номенклатуры идёт РОВНО в тех колонках, что понимает наш импорт
 * (часть 2). Это даёт круг «выгрузил → поправил в Excel сотней строк →
 * загрузил обратно → не понравилось → откатил» — такого круга нет ни у кого:
 * у Wipon экспорт и импорт живут отдельно, отката нет ни у одного из троих.
 *
 * Брендирование: модель Wipon (логотип PNG/JPG ≤500 КБ + рекламный текст).
 * Логотип для чека сервер сразу превращает в 1-битный ESC/POS-растр —
 * касса печатает готовые байты без декодера картинок (и одинаково на всех
 * принтерах). Порог 500 КБ взят у Wipon: он реалистичен для логотипа и
 * защищает базу от «фотографии витрины на 8 мегапикселей».
 */

const MAX_LOGO_BYTES = 500 * 1024;

/** PNG/JPG → 1-битный растр ESC/POS (GS v 0). Порог Флойда не нужен: логотип
 *  магазина — это текст и простые фигуры, обычный порог даёт чище. */
export function toEscPosRaster(buf: Buffer, mime: string, maxWidth = 384) {
  let w: number, h: number, data: Buffer | Uint8Array;
  if (mime.includes('png')) {
    const png = PNG.sync.read(buf);
    w = png.width; h = png.height; data = png.data;              // RGBA
  } else {
    const img = jpeg.decode(buf, { useTArray: true });
    w = img.width; h = img.height; data = img.data;              // RGBA
  }

  // ширина принтера: 58 мм = 384 точки, 80 мм = 576. Ужимаем пропорционально
  // и округляем до кратного 8 — иначе ESC/POS съезжает построчно.
  const scale = Math.min(1, maxWidth / w);
  const outW = Math.max(8, Math.floor((w * scale) / 8) * 8);
  const outH = Math.max(1, Math.round(h * scale));
  const bytesPerRow = outW / 8;
  const raster = Buffer.alloc(bytesPerRow * outH, 0);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const sy = Math.min(h - 1, Math.floor(y / scale));
      const i = (sy * w + sx) * 4;
      const a = data[i + 3] ?? 255;
      // прозрачное считаем белым: логотипы часто PNG с альфой
      const lum = a < 128 ? 255
        : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 160) raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { raster: raster.toString('base64'), width: outW, height: outH };
}

@Injectable()
export class ExportService {
  constructor(private db: DbService, private rep: ReportService) {}

  /** Книга Excel из строк с заголовками. Ширины колонок — по содержимому:
   *  файл открывают и сразу читают, а не растягивают колонки мышкой. */
  private book(rows: any[][], sheet = 'Лист1'): Buffer {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = (rows[0] ?? []).map((_, i) => ({
      wch: Math.min(40, Math.max(10, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /**
   * ПРОДАЖИ ДЛЯ 1С (модель загрузки «Реализация товаров и услуг»).
   *
   * Разбирался, что именно ждёт 1С Бухгалтерия для Казахстана: у неё есть
   * загрузка табличной части из Excel со столбцами
   *   штрих-код, код, артикул, номенклатура, характеристика, количество, цена
   * и штрихкод там ОБЯЗАТЕЛЕН — по нему 1С находит номенклатуру у себя.
   * Поэтому колонки названы дословно как у неё: бухгалтер копирует лист
   * целиком, без переименований и подгонки.
   *
   * Добавлены две колонки для Казахстана:
   *   · код НКТ — в карточке номенклатуры 1С для КЗ он нужен отдельно;
   *   · сумма — 1С посчитает сама, но бухгалтеру удобно свериться глазами.
   *
   * Формат намеренно ПРОСТОЙ (лист Excel), а не обменный файл: обменные
   * форматы привязаны к версии конфигурации, ломаются при обновлениях 1С
   * и требуют настройки на стороне бухгалтера. Лист Excel работает всегда.
   *
   * Возвраты идут отдельными строками с минусом — так их видно, и итог
   * сходится с выручкой.
   */
  async salesFor1C(accountId: string, from: string, to: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT s.number AS receipt, s.created_at, s.return_of_id,
                p.name AS product, p.article, p.code, p.ntin,
                (SELECT b.code FROM barcode b WHERE b.product_id = p.id
                  ORDER BY b.is_primary DESC LIMIT 1) AS barcode,
                u.short_name AS unit,
                si.qty, si.price, si.discount_sum,
                cp.name AS customer
           FROM sale_item si
           JOIN sale s ON s.id = si.sale_id
           JOIN product p ON p.id = si.product_id
           LEFT JOIN unit u ON u.id = p.unit_id
           LEFT JOIN counterparty cp ON cp.id = s.customer_id
          WHERE s.account_id = $1 AND s.created_at >= $2 AND s.created_at < $3
          ORDER BY s.created_at, s.number`, [accountId, from, to]);

      const head = ['Штрих-код', 'Код', 'Артикул', 'Номенклатура', 'Характеристика',
                    'Количество', 'Цена', 'Сумма', 'Код НКТ', 'Ед.изм',
                    'Документ', 'Дата', 'Покупатель'];

      const body = rows.map((r: any) => {
        const isReturn = !!r.return_of_id;
        const qty = isReturn ? -Number(r.qty) : Number(r.qty);
        const price = Number(r.price) - (Number(r.discount_sum) / Math.max(Number(r.qty), 1));
        return [
          r.barcode ?? '', r.code ?? '', r.article ?? '', r.product,
          '',                                   // характеристика: у нас в названии варианта
          qty, Math.round(price * 100) / 100, Math.round(qty * price * 100) / 100,
          r.ntin ?? '', r.unit ?? 'шт',
          (isReturn ? 'Возврат № ' : 'Чек № ') + r.receipt,
          new Date(r.created_at).toLocaleDateString('ru-RU'),
          r.customer ?? '',
        ];
      });

      return this.book([head, ...body], 'Реализация');
    });
  }

  /**
   * Номенклатура → Excel в колонках нашего же импорта (kz-шаблон части 2).
   * Круг «выгрузил → поправил → загрузил обратно» работает без переделки.
   */
  async goods(accountId: string, q?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.name, p.article, cat.name AS category, u.short_name AS unit,
                p.purchase_price, p.min_price, p.vat_rate, p.ntin,
                -- розничная цена живёт в product_price (типы цен, часть 2):
                -- берём её так же, как список товаров в кабинете
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                  WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL) AS sale_price,
                coalesce(string_agg(b.code, ' '), '') AS barcodes,
                coalesce((SELECT sum(sb.qty) FROM stock_balance sb WHERE sb.product_id = p.id), 0) AS qty
           FROM product p
           LEFT JOIN category cat ON cat.id = p.category_id
           LEFT JOIN unit u ON u.id = p.unit_id
           LEFT JOIN barcode b ON b.product_id = p.id
          WHERE p.deleted_at IS NULL
            AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%')
          GROUP BY p.id, cat.name, u.short_name
          ORDER BY cat.name NULLS LAST, p.name`, [q?.trim() || null]);

      const head = ['Наименование', 'Штрихкод', 'Код НКТ (NTIN)', 'Категория',
        'Единица измерения', 'Цена закупки', 'Цена', 'Количество', 'НДС', 'Артикул', 'Мин. цена'];
      const body = rows.map((r: any) => [
        r.name, r.barcodes, r.ntin ?? '', r.category ?? '', r.unit ?? 'шт',
        Number(r.purchase_price ?? 0), Number(r.sale_price ?? 0), Number(r.qty ?? 0),
        Number(r.vat_rate ?? 0), r.article ?? '',
        r.min_price != null ? Number(r.min_price) : '',
      ]);
      return { buffer: this.book([head, ...body], 'Номенклатура'), count: rows.length };
    });
  }

  /** Остатки → Excel (для инвентаризации на бумаге: печатают и ходят по полкам) */
  async stock(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.name, cat.name AS category, coalesce(string_agg(DISTINCT b.code, ' '), '') AS barcodes,
                sum(sb.qty) AS qty, u.short_name AS unit,
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                  WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL) AS sale_price,
                sum(sb.qty) * p.purchase_price AS cost_sum
           FROM stock_balance sb
           JOIN product p ON p.id = sb.product_id
           LEFT JOIN category cat ON cat.id = p.category_id
           LEFT JOIN unit u ON u.id = p.unit_id
           LEFT JOIN barcode b ON b.product_id = p.id
          WHERE p.deleted_at IS NULL
          GROUP BY p.id, cat.name, u.short_name
         HAVING sum(sb.qty) <> 0
          ORDER BY cat.name NULLS LAST, p.name`);
      const head = ['Наименование', 'Категория', 'Штрихкод', 'Остаток', 'Ед.', 'Цена', 'Сумма по закупке'];
      const body = rows.map((r: any) => [r.name, r.category ?? '', r.barcodes,
        Number(r.qty), r.unit ?? 'шт', Number(r.sale_price ?? 0), Number(r.cost_sum ?? 0)]);
      return { buffer: this.book([head, ...body], 'Остатки'), count: rows.length };
    });
  }

  /** Покупатели и долги → Excel */
  async customers(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT cp.name, cp.phone, cp.iin_bin, cp.debt_limit,
                coalesce(cb.balance,0) AS debt, coalesce(bb.balance,0) AS bonuses
           FROM counterparty cp
           LEFT JOIN counterparty_balance cb ON cb.counterparty_id = cp.id
           LEFT JOIN bonus_balance bb ON bb.counterparty_id = cp.id
          WHERE cp.deleted_at IS NULL AND cp.is_customer
          ORDER BY coalesce(cb.balance,0) DESC, cp.name`);
      const head = ['Имя', 'Телефон', 'ИИН/БИН', 'Лимит долга', 'Долг', 'Бонусы'];
      const body = rows.map((r: any) => [r.name, r.phone ?? '', r.iin_bin ?? '',
        r.debt_limit != null ? Number(r.debt_limit) : '', Number(r.debt), Number(r.bonuses)]);
      return { buffer: this.book([head, ...body], 'Покупатели'), count: rows.length };
    });
  }

  /**
   * Любой отчёт → Excel. Универсальный мост: отчёт уже посчитан сервисом
   * отчётов, здесь только раскладка в таблицу — новые отчёты подключаются
   * одной строкой, а не копией экспорта.
   */
  async report(accountId: string, kind: string, p: { from: string; to: string }) {
    const titles: Record<string, string> = {
      sales: 'Продажи по товарам', shifts: 'Отчёт по сменам', cashiers: 'Отчёт по кассирам',
      consultants: 'Консультанты', abc: 'ABC-анализ', profitability: 'Рентабельность',
      categories: 'Продажи по категориям', receipts: 'Продажи по чекам',
    };
    if (!titles[kind]) throw new BadRequestException(`Неизвестный отчёт: ${kind}`);

    const data: any[] = await (async () => {
      switch (kind) {
        case 'shifts': return this.rep.shifts(accountId, p);
        case 'cashiers': return this.rep.cashiers(accountId, p);
        case 'consultants': return this.rep.consultants(accountId, p);
        case 'abc': return (await this.rep.abc(accountId, p)) as any;
        case 'profitability': return (await this.rep.profitability(accountId, p)) as any;
        case 'categories': return (await this.rep.salesBy(accountId, 'category', p)) as any;
        case 'receipts': return (await this.rep.salesByReceipt(accountId, p)) as any;
        default: return (await this.rep.salesByProduct(accountId, p)) as any;
      }
    })();

    const rows: any[] = Array.isArray(data) ? data : (data as any).items ?? (data as any).rows ?? [];
    if (!rows.length) return { buffer: this.book([[titles[kind]], ['Нет данных за период']], 'Отчёт'), count: 0 };

    // русские подписи для известных колонок; неизвестные — как есть,
    // чтобы новый отчёт выгружался и без правки словаря
    const RU: Record<string, string> = {
      name: 'Наименование', receipts: 'Чеков', revenue: 'Выручка', profit: 'Прибыль',
      qty: 'Количество', total: 'Сумма', cost: 'Себестоимость', margin: 'Маржа, %',
      commission: 'К выплате', commissionPercent: 'Процент', refunds: 'Возвраты',
      base: 'База', discount_sum: 'Скидка', expected_cash: 'Ожидалось в кассе',
      actual_cash: 'Факт в кассе', discrepancy: 'Расхождение', opened_at: 'Открыта',
      closed_at: 'Закрыта', number: '№', class: 'Класс', share: 'Доля, %',
      grossProfit: 'Валовая прибыль', avgCheck: 'Средний чек',
    };
    const keys = Object.keys(rows[0]).filter((k) => !k.endsWith('_id') && k !== 'id');
    const head = keys.map((k) => RU[k] ?? k);
    const body = rows.map((r) => keys.map((k) => {
      const v = r[k];
      if (v == null) return '';
      if (v instanceof Date) return v.toLocaleString('ru-RU');
      return typeof v === 'object' ? JSON.stringify(v) : v;
    }));
    return {
      buffer: this.book([[`${titles[kind]}: ${p.from} — ${p.to}`], [], head, ...body], 'Отчёт'),
      count: rows.length,
    };
  }

  // ============ БРЕНДИРОВАНИЕ ============

  async getBranding(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const b = (await c.query(`SELECT * FROM branding WHERE account_id=$1`, [accountId])).rows[0];
      return {
        logo: b?.logo_base64 ?? null,
        receiptAdText: b?.receipt_ad_text ?? null,
        hasReceiptLogo: !!b?.receipt_logo_raster,
        receiptLogoSize: b ? { width: b.receipt_logo_width, height: b.receipt_logo_height } : null,
      };
    });
  }

  /**
   * Логотип: одна картинка → и в документы (base64), и в чек (растр).
   * Владелец грузит один файл, а не два, и не думает про форматы.
   */
  async setLogo(accountId: string, employeeId: string | null,
                d: { base64: string; mime: string; printerWidth?: 384 | 576 }) {
    const clean = d.base64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length) throw new BadRequestException('Пустой файл');
    if (buf.length > MAX_LOGO_BYTES)
      throw new BadRequestException(`Логотип больше 500 КБ (${Math.round(buf.length / 1024)} КБ) — уменьшите картинку`);
    if (!/png|jpe?g/i.test(d.mime)) throw new BadRequestException('Только PNG или JPG');

    let raster;
    try {
      raster = toEscPosRaster(buf, d.mime, d.printerWidth ?? 384);
    } catch (e: any) {
      throw new BadRequestException(`Не удалось прочитать картинку: ${e.message}`);
    }

    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO branding (account_id, logo_base64, logo_mime, receipt_logo_raster,
                               receipt_logo_width, receipt_logo_height, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (account_id) DO UPDATE SET logo_base64=$2, logo_mime=$3,
           receipt_logo_raster=$4, receipt_logo_width=$5, receipt_logo_height=$6,
           updated_by=$7, updated_at=now()`,
        [accountId, `data:${d.mime};base64,${clean}`, d.mime,
         raster.raster, raster.width, raster.height, employeeId]);
      return { ok: true, receiptLogo: { width: raster.width, height: raster.height } };
    });
  }

  /** Рекламный текст под итогом чека (модель Wipon) */
  async setAdText(accountId: string, employeeId: string | null, text: string) {
    if ((text ?? '').length > 200) throw new BadRequestException('Не длиннее 200 символов — это чек, а не буклет');
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO branding (account_id, receipt_ad_text, updated_by, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (account_id) DO UPDATE SET receipt_ad_text=$2, updated_by=$3, updated_at=now()`,
        [accountId, text?.trim() || null, employeeId]);
      return { ok: true };
    });
  }

  async clearLogo(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE branding SET logo_base64=NULL, receipt_logo_raster=NULL,
                     receipt_logo_width=NULL, receipt_logo_height=NULL WHERE account_id=$1`, [accountId]);
      return { ok: true };
    });
  }

  /** Печать и подпись организации (модель МС «Логотип, печать и подпись») */
  async setOrgImage(accountId: string, kind: 'stamp' | 'signature', base64: string, mime: string) {
    const clean = base64.replace(/^data:[^;]+;base64,/, '');
    if (Buffer.from(clean, 'base64').length > MAX_LOGO_BYTES)
      throw new BadRequestException('Файл больше 500 КБ');
    return this.db.withTenant(accountId, async (c) => {
      const col = kind === 'stamp' ? 'stamp_base64' : 'signature_base64';
      const { rowCount } = await c.query(
        `UPDATE organization SET ${col}=$1 WHERE deleted_at IS NULL
          AND id = (SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1)`,
        [`data:${mime};base64,${clean}`]);
      if (!rowCount) throw new BadRequestException('Сначала заполните реквизиты организации');
      return { ok: true };
    });
  }
}

// =====================================================================
@Controller('export')
export class ExportController {
  constructor(private ex: ExportService) {}

  private file(name: string, buf: Buffer, count: number) {
    return { fileName: name, base64: buf.toString('base64'), rows: count };
  }

  @Get('goods') @RequirePermission('goods', 'view')
  async goods(@Ctx() ctx: EmployeeContext, @Query('q') q?: string) {
    const r = await this.ex.goods(ctx.accountId, q);
    return this.file(`Номенклатура_${new Date().toISOString().slice(0, 10)}.xlsx`, r.buffer, r.count);
  }

  /** Продажи для 1С: лист Excel в колонках её загрузки «Реализация». */
  @Get('sales-1c') @RequirePermission('reports', 'view')
  async sales1c(@Ctx() ctx: EmployeeContext, @Query('from') from?: string, @Query('to') to?: string) {
    const t = to ?? new Date().toISOString();
    const f = from ?? new Date(Date.now() - 30 * 86400000).toISOString();
    const buf = await this.ex.salesFor1C(ctx.accountId, f, t);
    return this.file(`Реализация_для_1С_${t.slice(0, 10)}.xlsx`, buf, 0);
  }

  @Get('stock') @RequirePermission('stock', 'view')
  async stock(@Ctx() ctx: EmployeeContext) {
    const r = await this.ex.stock(ctx.accountId);
    return this.file(`Остатки_${new Date().toISOString().slice(0, 10)}.xlsx`, r.buffer, r.count);
  }

  @Get('customers') @RequirePermission('contragents', 'view')
  async customers(@Ctx() ctx: EmployeeContext) {
    const r = await this.ex.customers(ctx.accountId);
    return this.file(`Покупатели_${new Date().toISOString().slice(0, 10)}.xlsx`, r.buffer, r.count);
  }

  @Get('report/:kind') @RequirePermission('reports', 'view')
  async report(@Ctx() ctx: EmployeeContext, @Param('kind') kind: string, @Query() q: any) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? to;
    const r = await this.ex.report(ctx.accountId, kind, { from, to: `${to}T23:59:59.999` });
    return this.file(`${kind}_${from}_${to}.xlsx`, r.buffer, r.count);
  }
}

@Controller('branding')
export class BrandingController {
  constructor(private ex: ExportService) {}

  @Get() @RequirePermission('settings', 'view')
  get(@Ctx() ctx: EmployeeContext) { return this.ex.getBranding(ctx.accountId); }

  @Post('logo') @RequirePermission('settings', 'edit')
  logo(@Ctx() ctx: EmployeeContext, @Body() d: { base64: string; mime: string; printerWidth?: 384 | 576 }) {
    return this.ex.setLogo(ctx.accountId, ctx.employeeId, d);
  }

  @Post('ad-text') @RequirePermission('settings', 'edit')
  adText(@Ctx() ctx: EmployeeContext, @Body() d: { text: string }) {
    return this.ex.setAdText(ctx.accountId, ctx.employeeId, d.text);
  }

  @Post('logo/clear') @RequirePermission('settings', 'edit')
  clear(@Ctx() ctx: EmployeeContext) { return this.ex.clearLogo(ctx.accountId); }

  @Post('org-image') @RequirePermission('settings', 'edit')
  orgImage(@Ctx() ctx: EmployeeContext, @Body() d: { kind: 'stamp' | 'signature'; base64: string; mime: string }) {
    return this.ex.setOrgImage(ctx.accountId, d.kind, d.base64, d.mime);
  }
}

@Module({
  imports: [AdminApiModule],          // берём готовые ReportService и DbService
  controllers: [ExportController, BrandingController],
  providers: [ExportService],
})
export class ExportModule {}
