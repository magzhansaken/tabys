import { Injectable, BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { DbService } from '../db/db.service';

/**
 * ИМПОРТ НОМЕНКЛАТУРЫ. Первое, что делает новый клиент: у него уже есть
 * Excel или выгрузка из UMAG. Кривой импорт = клиент ушёл в первый день.
 *
 * Взято: у МоегоСклада — выбор поля для поиска существующих позиций,
 * автогенерация штрихкода, шаблон «Казахстан»; у Wipon — сопоставление
 * столбцов и флаг «первая строка — заголовок».
 *
 * Добавлено от себя: МойСклад честно предупреждает, что криво созданные
 * импортом товары удаляются только вручную. У нас есть кнопка отката.
 */

/** Как колонки называют в реальных файлах: от 1С, UMAG, Wipon и просто от руки. */
const ALIASES: Record<string, string[]> = {
  name: ['наименование', 'название', 'товар', 'name', 'номенклатура', 'наименование товара'],
  barcode: ['штрихкод', 'штрих-код', 'штрих код', 'barcode', 'ean', 'шк'],
  article: ['артикул', 'article', 'sku'],
  ntin: ['ntin', 'нтин', 'код нкт', 'нкт', 'код нкт (ntin)'],
  unit: ['единица', 'ед. изм.', 'ед изм', 'единица измерения', 'unit', 'ед.изм'],
  category: ['категория', 'группа', 'category'],
  purchase_price: ['цена закупки', 'закупочная цена', 'закуп', 'себестоимость', 'цена прихода'],
  price: ['цена', 'цена продажи', 'розничная цена', 'price'],
  quantity: ['количество', 'кол-во', 'остаток', 'qty'],
  vat_rate: ['ндс', 'vat', 'ставка ндс'],
  country: ['страна'],
  min_stock: ['минимальный остаток', 'критический остаток', 'неснижаемый остаток'],
};
const norm = (s: any) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const num = (v: any) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));

@Injectable()
export class ImportService {
  constructor(private db: DbService) {}

  /** Предел размера файла. Библиотека чтения таблиц имеет известную
   *  уязвимость без исправления от разработчика, и защита у неё одна —
   *  не давать ей огромные и подозрительные файлы. Прайс магазина даже
   *  на 50 тысяч позиций весит единицы мегабайт. */
  private static readonly MAX_IMPORT_BYTES = 15 * 1024 * 1024;

  private read(buffer: Buffer, hasHeader: boolean) {
    if (!buffer?.length) throw new BadRequestException('Файл пуст');
    if (buffer.length > ImportService.MAX_IMPORT_BYTES)
      throw new BadRequestException(
        `Файл больше ${ImportService.MAX_IMPORT_BYTES / 1024 / 1024} МБ. ` +
        'Разделите прайс на части или пришлите в формате CSV');

    // Читаем «плоско»: без формул, без макросов, без внешних ссылок.
    // Опасность в этой библиотеке связана с разбором сложных структур —
    // а для прайса нужны только значения ячеек.
    const wb = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,   // формулы не разбираем
      cellHTML: false,      // разметку не разбираем
      cellStyles: false,    // оформление не нужно
      bookVBA: false,       // макросы не читаем
    });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new BadRequestException('В файле нет ни одного листа');
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    if (!rows.length) throw new BadRequestException('Файл пуст');
    const header = hasHeader ? rows[0].map((c: any) => String(c ?? '')) : rows[0].map((_: any, i: number) => `Колонка ${i + 1}`);
    return { header, body: hasHeader ? rows.slice(1) : rows };
  }

  private obj(row: any[], mapping: Record<string, string>) {
    const o: Record<string, any> = {};
    for (const [f, i] of Object.entries(mapping)) o[f] = row[Number(i)];
    return o;
  }

  /**
   * ПРЕДПРОСМОТР: показываем, что получится, ДО создания чего-либо.
   * МойСклад советует «попробуйте сначала на 5–10 позициях» — это признание,
   * что их предпросмотр не даёт уверенности. Мы проверяем весь файл сразу.
   */
  async preview(accountId: string, employeeId: string | null, buffer: Buffer, fileName: string, hasHeader = true) {
    const { header, body } = this.read(buffer, hasHeader);

    // Умное сопоставление: Wipon заставляет сопоставлять всё руками,
    // хотя 90% файлов называют колонки одинаково.
    const mapping: Record<string, string> = {};
    const unmapped: string[] = [];
    header.forEach((h: string, i: number) => {
      const field = Object.entries(ALIASES).find(([, a]) => a.includes(norm(h)))?.[0];
      if (field && !(field in mapping)) mapping[field] = String(i);
      else if (hasHeader && h) unmapped.push(h);
    });
    if (!('name' in mapping))
      throw new BadRequestException('Не нашли колонку с наименованием. Укажите сопоставление вручную.');

    const problems: { row: number; error: string }[] = [];
    const seen = new Map<string, number>();
    body.forEach((r: any[], i: number) => {
      const o = this.obj(r, mapping);
      const n = i + (hasHeader ? 2 : 1);
      if (!String(o.name ?? '').trim()) problems.push({ row: n, error: 'Пустое наименование' });
      const bc = String(o.barcode ?? '').trim();
      if (bc) {
        if (!/^[0-9]{6,14}$/.test(bc)) problems.push({ row: n, error: `Штрихкод «${bc}» — не число из 6–14 цифр` });
        else if (seen.has(bc)) problems.push({ row: n, error: `Штрихкод ${bc} повторяется (строка ${seen.get(bc)})` });
        else seen.set(bc, n);
      }
      if (num(o.price) != null && num(o.price)! < 0) problems.push({ row: n, error: 'Отрицательная цена' });
      const nt = String(o.ntin ?? '').trim();
      if (nt && !/^[0-9]{8,14}$/.test(nt)) problems.push({ row: n, error: `NTIN «${nt}» — не число из 8–14 цифр` });
    });

    // через withTenant: RLS не даст вставить строку без контекста аккаунта
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO import_session (account_id, employee_id, file_name, mapping, total_rows, errors, error_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [accountId, employeeId, fileName, JSON.stringify(mapping), body.length,
         JSON.stringify(problems.slice(0, 100)), problems.length])).rows);

    return {
      sessionId: rows[0].id, columns: header, mapping, unmapped,
      totalRows: body.length,
      sample: body.slice(0, 5).map((r: any[]) => this.obj(r, mapping)),
      problems: problems.slice(0, 20), problemCount: problems.length,
    };
  }

  /**
   * ЗАПУСК. Критерий Части 2 — 1000 товаров за минуты, поэтому справочники
   * читаются один раз, а поиск существующих идёт пачками: 1000 отдельных
   * поездок до базы превратили бы минуты в десятки минут.
   */
  async run(accountId: string, sessionId: string, buffer: Buffer, opts: {
    hasHeader?: boolean; matchField?: 'barcode' | 'article' | 'name'; generateBarcodes?: boolean;
  } = {}) {
    const t0 = Date.now();
    const hasHeader = opts.hasHeader ?? true;
    const matchField = opts.matchField ?? 'barcode';

    const sess = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM import_session WHERE id=$1`, [sessionId])).rows[0]);
    if (!sess) throw new BadRequestException('Сеанс импорта не найден');
    const mapping = sess.mapping as Record<string, string>;
    const { body } = this.read(buffer, hasHeader);

    await this.db.withTenant(accountId, async (c) =>
      c.query(`UPDATE import_session SET status='running', started_at=now(), match_field=$2 WHERE id=$1`, [sessionId, matchField]));

    let created = 0, updated = 0, errors = 0;

    await this.db.withTenant(accountId, async (c) => {
      const units = new Map<string, string>();
      for (const u of (await c.query(`SELECT id, lower(name) n, lower(short_name) s FROM unit`)).rows) {
        units.set(u.n, u.id); units.set(u.s, u.id);
      }
      const cats = new Map<string, string>();
      for (const g of (await c.query(`SELECT id, lower(name) n FROM category WHERE deleted_at IS NULL`)).rows) cats.set(g.n, g.id);
      await c.query(`SELECT ensure_price_types($1)`, [accountId]);
      const retail = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;

      for (let s = 0; s < body.length; s += 200) {
        const chunk = body.slice(s, s + 200);
        const prepared = chunk.map((r: any[], i: number) => ({ o: this.obj(r, mapping), row: s + i + (hasHeader ? 2 : 1) }))
          .filter((p) => { if (String(p.o.name ?? '').trim()) return true; errors++; return false; });
        if (!prepared.length) continue;

        // одним запросом узнаём, что уже есть (модель МС: поиск по выбранному полю)
        const keys = prepared.map((p) => String(p.o[matchField] ?? '').trim()).filter(Boolean);
        const existing = new Map<string, any>();
        if (keys.length) {
          const q = matchField === 'barcode'
            ? `SELECT b.code AS key, p.id, p.name, p.purchase_price, p.ntin FROM barcode b JOIN product p ON p.id=b.product_id WHERE b.code = ANY($1)`
            : `SELECT ${matchField}::text AS key, id, name, purchase_price, ntin FROM product WHERE ${matchField}::text = ANY($1) AND deleted_at IS NULL`;
          for (const r of (await c.query(q, [keys])).rows) existing.set(String(r.key), r);
        }

        // Категории создаём ДО точек сохранения. Иначе так: категория создана
        // внутри точки сохранения, строка упала, откат убрал категорию из базы —
        // но она осталась в кэше, и все следующие строки падают на внешнем ключе.
        for (const p of prepared) {
          if (!p.o.category) continue;
          const cn = norm(p.o.category);
          if (cats.has(cn)) continue;
          const id = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,$2) RETURNING id`,
            [accountId, String(p.o.category).trim()])).rows[0].id;
          cats.set(cn, id);
        }

        for (const p of prepared) {
          // Точка сохранения на строку: без неё первая же ошибка ломает
          // транзакцию целиком, и импорт 1000 позиций умирает из-за одной.
          await c.query('SAVEPOINT row_sp');
          try {
            const o = p.o;
            const name = String(o.name).trim();
            const key = String(o[matchField] ?? '').trim();
            const found = key ? existing.get(key) : null;
            const unitId = o.unit ? units.get(norm(o.unit)) ?? null : null;
            const catId: string | null = o.category ? cats.get(norm(o.category)) ?? null : null;

            if (found) {
              await c.query(
                `INSERT INTO import_row (session_id, account_id, row_number, product_id, action, before) VALUES ($1,$2,$3,$4,'updated',$5)`,
                [sessionId, accountId, p.row, found.id,
                 JSON.stringify({ name: found.name, purchase_price: found.purchase_price, ntin: found.ntin })]);
              await c.query(
                `UPDATE product SET name=$2, purchase_price=coalesce($3,purchase_price), ntin=coalesce($4,ntin),
                        category_id=coalesce($5,category_id), unit_id=coalesce($6,unit_id) WHERE id=$1`,
                [found.id, name, num(o.purchase_price), String(o.ntin ?? '').trim() || null, catId, unitId]);
              if (num(o.price) != null)
                await c.query(
                  `INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (product_id, price_type_id, store_id)
                   DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
                  [accountId, found.id, retail, num(o.price)]);
              updated++;
            } else {
              const kind = o.unit && /кг|kg|килограмм/i.test(String(o.unit)) ? 'weight' : 'simple';
              const pid = (await c.query(
                `INSERT INTO product (account_id, name, kind, article, ntin, ntin_source, category_id, unit_id,
                                      purchase_price, vat_rate, country, min_stock, import_session_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
                [accountId, name, kind, String(o.article ?? '') || null,
                 String(o.ntin ?? '').trim() || null, o.ntin ? 'import' : null,
                 catId, unitId, num(o.purchase_price), num(o.vat_rate) ?? 12,
                 String(o.country ?? '') || null, num(o.min_stock), sessionId])).rows[0].id;

              const bc = String(o.barcode ?? '').trim();
              if (bc) {
                await c.query(
                  `INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,$3,$4,true)
                   ON CONFLICT (account_id, code) DO NOTHING`,
                  [accountId, pid, bc, bc.length === 13 ? 'ean13' : bc.length === 8 ? 'ean8' : 'code128']);
              } else if (opts.generateBarcodes) {
                // модель МС: «если штрихкод не указан, EAN13 генерируется автоматически»
                const code = (await c.query(`SELECT code FROM product WHERE id=$1`, [pid])).rows[0].code;
                if (code != null) {
                  const gen = (await c.query(`SELECT gen_internal_barcode($1,$2) AS b`, [accountId, code])).rows[0].b;
                  await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,$3,'internal',true)
                                 ON CONFLICT (account_id, code) DO NOTHING`, [accountId, pid, gen]);
                }
              }

              if (num(o.price) != null)
                await c.query(
                  `INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (product_id, price_type_id, store_id)
                   DO UPDATE SET value=EXCLUDED.value`,
                  [accountId, pid, retail, num(o.price)]);

              await c.query(`INSERT INTO import_row (session_id, account_id, row_number, product_id, action) VALUES ($1,$2,$3,$4,'created')`,
                [sessionId, accountId, p.row, pid]);
              created++;
            }
            await c.query('RELEASE SAVEPOINT row_sp');
          } catch (e: any) {
            errors++;
            await c.query('ROLLBACK TO SAVEPOINT row_sp');
            await c.query(`INSERT INTO import_row (session_id, account_id, row_number, action, error) VALUES ($1,$2,$3,'error',$4)`,
              [sessionId, accountId, p.row, (e.message ?? String(e)).slice(0, 300)]);
            if (process.env.IMPORT_DEBUG) console.error('строка', p.row, e.message);
          }
        }
      }
    });

    await this.db.withTenant(accountId, async (c) =>
      c.query(`UPDATE import_session SET status='done', finished_at=now(), created_count=$2, updated_count=$3, error_count=$4 WHERE id=$1`,
        [sessionId, created, updated, errors]));

    return { created, updated, errors, elapsedMs: Date.now() - t0 };
  }

  /** Откат импорта — то, чего нет ни у одного из троих. */
  async rollback(accountId: string, sessionId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM rollback_import($1,$2)`, [accountId, sessionId]);
    return { archived: rows[0].archived, restored: rows[0].restored };
  }

  async history(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, file_name, status, total_rows, created_count, updated_count, error_count,
                started_at, finished_at, rolled_back_at
           FROM import_session ORDER BY created_at DESC LIMIT 50`)).rows);
  }

  /** Шаблон для скачивания. У МоегоСклада их три; «Казахстан» — с колонкой НКТ. */
  template(kind: 'simple' | 'full' | 'kz' = 'kz') {
    const cols: Record<string, string[]> = {
      simple: ['Наименование', 'Штрихкод', 'Цена'],
      full: ['Наименование', 'Штрихкод', 'Артикул', 'Категория', 'Единица измерения', 'Цена закупки', 'Цена', 'Количество', 'НДС', 'Страна'],
      kz: ['Наименование', 'Штрихкод', 'Код НКТ (NTIN)', 'Категория', 'Единица измерения', 'Цена закупки', 'Цена', 'Количество', 'НДС'],
    };
    const example: Record<string, any[]> = {
      simple: ['Молоко Айналайын 2.5%', '4870204391234', 450],
      full: ['Молоко Айналайын 2.5%', '4870204391234', 'MLK-25', 'Молочное', 'шт', 380, 450, 24, 12, 'Казахстан'],
      kz: ['Молоко Айналайын 2.5%', '4870204391234', '04870204391234', 'Молочное', 'шт', 380, 450, 24, 12],
    };
    const ws = XLSX.utils.aoa_to_sheet([cols[kind], example[kind]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
}
