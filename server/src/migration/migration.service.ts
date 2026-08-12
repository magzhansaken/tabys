import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * ОНБОРДИНГ И МИГРАЦИЯ. [РУБЕЖ: массовое подключение]
 *
 * У Wipon в документации есть тег «для клиентов Umag» — и под ним ровно одна
 * страница. Канал перетока конкурент застолбил, но наполнить не смог. Наш ход:
 * сделать переезд кнопкой, а не статьёй.
 *
 * Модель импорта берём у Wipon («Импорт номенклатуры»): Excel → сопоставление
 * столбцов → загрузка, с галочкой «Заголовок» и двумя режимами — с остатками
 * и без. Но у них столбцы сопоставляет человек, который первый раз видит слово
 * «номенклатура». У нас колонки узнаются сами: заголовки выгрузок UMAG и Wipon
 * известны из их же документации.
 *
 * ЧЕСТНО: живого кабинета UMAG нет — подписка 8800 ₸ и реальные выгрузки висят
 * в открытых вопросах с Части 1. Поэтому словари построены на заголовках из их
 * документации, а незнакомая колонка не ломает импорт: она уходит в ручное
 * сопоставление, которое и так есть.
 */

export type ImportEntity = 'product' | 'counterparty' | 'debt';
export type Source = 'umag' | 'wipon' | 'moysklad' | 'custom';

/** Наши поля и то, как их называют в выгрузках трёх систем. */
const FIELD_ALIASES: Record<string, string[]> = {
  name: ['наименование', 'название', 'товар', 'name', 'атауы', 'тауар', 'номенклатура'],
  barcode: ['штрихкод', 'штрих-код', 'штрих код', 'barcode', 'ean', 'шк'],
  code: ['артикул', 'код', 'код товара', 'article', 'sku'],
  unit: ['единица измерения', 'ед. изм.', 'ед изм', 'единица', 'unit', 'өлшем бірлігі'],
  price: ['цена продажи', 'цена', 'розничная цена', 'price', 'сату бағасы', 'цена розничная'],
  purchasePrice: ['цена закупки', 'закупочная цена', 'себестоимость', 'закуп', 'сатып алу бағасы'],
  qty: ['количество', 'кол-во', 'остаток', 'qty', 'саны', 'қалдық'],
  category: ['категория', 'группа', 'категория товара', 'санат', 'тауар санаты'],
  vatRate: ['ндс', 'ставка ндс', 'vat', 'ққс'],
  ntin: ['ntin', 'нкт', 'код нкт'],
  // контрагенты
  phone: ['телефон', 'номер телефона', 'phone', 'телефон нөмірі'],
  iinBin: ['иин', 'бин', 'иин/бин', 'бин/иин', 'жсн', 'бсн'],
  address: ['адрес', 'адрес доставки', 'мекенжай'],
  debt: ['долг', 'задолженность', 'сумма долга', 'баланс', 'қарыз'],
  email: ['email', 'почта', 'e-mail'],
  birthday: ['день рождения', 'дата рождения', 'birthday'],
};

/** Отпечатки выгрузок: по ним узнаём, откуда файл. */
const SIGNATURES: { source: Source; entity: ImportEntity; must: string[]; hints: string[] }[] = [
  // UMAG «Список товаров»: наименование, штрихкод, категория, цена, остаток
  { source: 'umag', entity: 'product', must: ['name', 'barcode'], hints: ['category', 'qty', 'purchasePrice'] },
  // UMAG «Покупатели»: имя, телефон, сумма долга, бонусы
  { source: 'umag', entity: 'counterparty', must: ['name', 'phone'], hints: ['debt'] },
  // Wipon: обязательные поля из их статьи «Импорт номенклатуры»
  { source: 'wipon', entity: 'product', must: ['name', 'unit', 'price', 'barcode'], hints: ['qty', 'purchasePrice'] },
  { source: 'moysklad', entity: 'product', must: ['name', 'code'], hints: ['price', 'barcode'] },
];

@Injectable()
export class MigrationService {
  private log = new Logger('Migration');
  constructor(private db: DbService) {}

  // ==================================================================
  // РАСПОЗНАВАНИЕ КОЛОНОК
  // ==================================================================

  /** Наше поле по заголовку колонки. */
  private matchField(header: string): string | null {
    const h = String(header ?? '').trim().toLowerCase().replace(/[«»"']/g, '');
    if (!h) return null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.some((a) => h === a)) return field;
    }
    // частичное совпадение: «Цена продажи, ₸» тоже должна найтись
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.some((a) => h.startsWith(a) || h.includes(a))) return field;
    }
    return null;
  }

  /**
   * Что за файл нам дали.
   *
   * Wipon после загрузки запускает «процесс определения столбцов таблицы» —
   * то есть человек сопоставляет вручную. Мы делаем это сами и оставляем
   * человеку подтверждение.
   */
  detectFormat(headers: string[]) {
    const mapping: Record<string, string> = {};
    const unknown: string[] = [];
    headers.forEach((h, i) => {
      const f = this.matchField(h);
      if (f && !Object.values(mapping).includes(f)) mapping[String(i)] = f;
      else if (!f) unknown.push(h);
    });

    const fields = new Set(Object.values(mapping));
    let best: any = null;
    for (const sig of SIGNATURES) {
      if (!sig.must.every((m) => fields.has(m))) continue;
      const score = sig.must.length * 2 + sig.hints.filter((x) => fields.has(x)).length;
      if (!best || score > best.score) best = { ...sig, score };
    }

    const entity: ImportEntity = best?.entity
      ?? (fields.has('debt') || (fields.has('phone') && !fields.has('price')) ? 'counterparty' : 'product');

    return {
      source: (best?.source ?? 'custom') as Source,
      entity,
      mapping,
      recognized: Object.keys(mapping).length,
      unknownColumns: unknown,
      // без чего импорт не имеет смысла
      missing: entity === 'product'
        ? ['name'].filter((f) => !fields.has(f))
        : ['name'].filter((f) => !fields.has(f)),
      withStock: fields.has('qty'),   // «С остатками» / «Без остатков» (Wipon)
      confidence: best ? (best.score >= 8 ? 'high' : 'medium') : 'low',
    };
  }

  /**
   * Первая строка — это заголовки?
   *
   * Wipon просит поставить галочку «Заголовок» вручную и предупреждает, что
   * иначе будут проблемы. Проверить это может и программа: заголовки не бывают
   * числами и обычно узнаются словарём.
   */
  looksLikeHeader(firstRow: any[]) {
    const cells = firstRow.map((c) => String(c ?? '').trim()).filter(Boolean);
    if (!cells.length) return false;
    const numeric = cells.filter((c) => /^-?[\d\s.,]+$/.test(c)).length;
    if (numeric > cells.length / 2) return false;     // строка из чисел — это данные
    const known = cells.filter((c) => this.matchField(c)).length;
    return known >= Math.max(1, Math.floor(cells.length / 3));
  }

  // ==================================================================
  // ДУБЛИ
  // ==================================================================

  /**
   * Что задвоится, если импортировать как есть.
   * Показываем ДО импорта: после — это уже путаница в остатках.
   */
  async checkDuplicates(accountId: string, rows: any[][], mapping: Record<string, string>) {
    const col = (f: string) => Object.entries(mapping).find(([, v]) => v === f)?.[0];
    const bcCol = col('barcode'), nameCol = col('name');

    const inFile: any[] = [];
    const seenBc = new Map<string, number>();
    const seenName = new Map<string, number>();

    rows.forEach((r, i) => {
      const bc = bcCol != null ? String(r[Number(bcCol)] ?? '').trim() : '';
      const nm = nameCol != null ? String(r[Number(nameCol)] ?? '').trim().toLowerCase() : '';
      if (bc) {
        if (seenBc.has(bc)) inFile.push({ kind: 'barcode_in_file', value: bc, rows: [seenBc.get(bc), i + 1] });
        else seenBc.set(bc, i + 1);
      }
      if (nm) {
        if (seenName.has(nm)) inFile.push({ kind: 'name_in_file', value: r[Number(nameCol!)], rows: [seenName.get(nm), i + 1] });
        else seenName.set(nm, i + 1);
      }
    });

    const inBase = await this.db.raw(
      `SELECT * FROM find_import_duplicates($1,$2::text[],$3::text[])`,
      [accountId, [...seenBc.keys()], [...seenName.keys()]]);

    return {
      inFile,
      inBase: inBase.rows.map((r: any) => ({ kind: r.kind, value: r.value, existing: r.existing_name })),
      total: inFile.length + inBase.rows.length,
      hint: inFile.length
        ? 'В файле есть повторы. Если импортировать как есть, остатки будут расходиться каждый день'
        : undefined,
    };
  }

  // ==================================================================
  // ИМПОРТ КОНТРАГЕНТОВ И ДОЛГОВ
  // ==================================================================

  /**
   * Wipon импортирует номенклатуру. Но у переезжающего магазина есть ещё
   * долги покупателей — то, ради чего он и вёл тетрадку. Без них переезд
   * не переезд.
   */
  async importCounterparties(accountId: string, dto: {
    rows: any[][]; mapping: Record<string, string>; employeeId?: string;
    source?: Source; asSuppliers?: boolean; dryRun?: boolean;
  }) {
    const col = (f: string) => {
      const e = Object.entries(dto.mapping).find(([, v]) => v === f);
      return e ? Number(e[0]) : null;
    };
    const cName = col('name'), cPhone = col('phone'), cBin = col('iinBin');
    const cDebt = col('debt'), cAddr = col('address'), cEmail = col('email');
    if (cName == null) throw new BadRequestException('Не найдена колонка с именем контрагента');

    const created: any[] = [], skipped: any[] = [], withDebt: any[] = [];

    return this.db.withTenant(accountId, async (c) => {
      const sess = (await c.query(
        `INSERT INTO import_session (account_id, employee_id, file_name, status, entity, source, mapping, total_rows)
         VALUES ($1,$2,$3,'running','counterparty',$4,$5,$6) RETURNING id`,
        [accountId, dto.employeeId ?? null, 'counterparties', dto.source ?? 'custom',
         JSON.stringify(dto.mapping), dto.rows.length])).rows[0].id;

      for (const [i, r] of dto.rows.entries()) {
        const name = String(r[cName] ?? '').trim();
        if (!name) { skipped.push({ row: i + 1, reason: 'Пустое имя' }); continue; }

        const phone = cPhone != null ? normalizePhone(r[cPhone]) : null;
        const bin = cBin != null ? String(r[cBin] ?? '').replace(/\D/g, '') || null : null;
        const debt = cDebt != null ? parseMoney(r[cDebt]) : 0;

        // тот же человек мог быть и в списке покупателей, и в списке должников
        const exists = (await c.query(
          `SELECT id, name FROM counterparty
            WHERE deleted_at IS NULL AND (($1::text IS NOT NULL AND phone = $1)
               OR ($2::text IS NOT NULL AND iin_bin = $2) OR lower(name) = lower($3))
            LIMIT 1`, [phone, bin, name])).rows[0];

        if (exists) { skipped.push({ row: i + 1, name, reason: `Уже есть: «${exists.name}»` }); continue; }
        if (dto.dryRun) { created.push({ row: i + 1, name, phone, debt }); continue; }

        const cp = (await c.query(
          `INSERT INTO counterparty (account_id, name, kind, phone, iin_bin, legal_address, email,
                                     is_customer, is_supplier, allow_credit)
           VALUES ($1,$2,'person',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [accountId, name, phone, bin, cAddr != null ? String(r[cAddr] ?? '') || null : null,
           cEmail != null ? String(r[cEmail] ?? '') || null : null,
           !dto.asSuppliers, !!dto.asSuppliers, debt > 0])).rows[0];
        created.push({ row: i + 1, name, id: cp.id });

        // долг переносим движением — источник правды тот же, что в Части 6
        if (debt > 0) {
          // причина 'adjustment' — та же, что для ручных правок долга в Части 6:
          // перенос из старой программы это не продажа, а установка начального сальдо
          await c.query(
            `SELECT apply_balance_move($1,$2,$3::numeric,'adjustment'::balance_reason,
                                       NULL,NULL,NULL,$4::uuid,NULL,$5)`,
            [accountId, cp.id, debt, dto.employeeId ?? null, 'Долг перенесён из старой программы']);
          withDebt.push({ name, debt });
        }
      }

      await c.query(
        `UPDATE import_session SET status='done', created_count=$2, error_count=$3, finished_at=now()
          WHERE id=$1`, [sess, created.length, skipped.length]);

      return {
        sessionId: sess, created: created.length, skipped: skipped.length,
        debtsTransferred: withDebt.length,
        debtTotal: withDebt.reduce((s, d) => s + d.debt, 0),
        details: { created: created.slice(0, 50), skipped: skipped.slice(0, 50) },
        dryRun: !!dto.dryRun,
      };
    });
  }

  // ==================================================================
  // МАСТЕР ПЕРВОГО ЗАПУСКА
  // ==================================================================

  /** Где мы находимся: мастер помнит, владелец закрывает ноутбук на полуслове. */
  async onboardingState(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM onboarding_state($1)`, [accountId]);
    const steps = rows.map((r: any) => ({
      code: r.code, title: r.title, status: r.status, hint: r.hint, blocking: r.blocking,
    }));
    const done = steps.filter((s: any) => s.status === 'done').length;
    const blockers = steps.filter((s: any) => s.blocking && s.status === 'pending');

    return {
      steps,
      progress: Math.round((done / steps.length) * 100),
      done, total: steps.length,
      // ничего не блокируем: магазин может начать торговать на трёх шагах
      canSell: blockers.length === 0,
      blockers: blockers.map((b: any) => b.title),
      nextStep: steps.find((s: any) => s.status === 'pending')?.code ?? null,
      message: blockers.length
        ? `Чтобы начать продавать, осталось: ${blockers.map((b: any) => b.title.toLowerCase()).join(', ')}`
        : done === steps.length ? 'Магазин настроен полностью'
        : 'Можно продавать. Остальное настроите по ходу',
    };
  }

  async completeStep(accountId: string, code: string, payload?: any, employeeId?: string) {
    await this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO onboarding_step (account_id, code, status, payload, done_at, employee_id)
         VALUES ($1,$2,'done',$3,now(),$4)
         ON CONFLICT (account_id, code) DO UPDATE SET status='done', payload=EXCLUDED.payload, done_at=now()`,
        [accountId, code, JSON.stringify(payload ?? {}), employeeId ?? null]);
    });
    // состояние читаем ПОСЛЕ коммита: вложенный вызов взял бы из пула другое
    // соединение и не увидел бы только что вставленную строку
    return this.onboardingState(accountId);
  }

  async skipStep(accountId: string, code: string) {
    await this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO onboarding_step (account_id, code, status) VALUES ($1,$2,'skipped')
         ON CONFLICT (account_id, code) DO UPDATE SET status='skipped'`, [accountId, code]);
    });
    return this.onboardingState(accountId);
  }

  /** Откуда переехали: нужно поддержке и для понимания, кто наш клиент. */
  async setSource(accountId: string, source: Source) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE account SET came_from=$2 WHERE id=$1`, [accountId, source]);
      return { source };
    });
  }
}

/** Телефон в выгрузках пишут как попало: 8 707…, +7 707…, 707… */
export function normalizePhone(v: any): string | null {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) return '+7' + d.slice(1);
  if (d.length === 10) return '+7' + d;
  if (d.length === 11 && d[0] === '7') return '+' + d;
  return d.length >= 10 ? '+' + d : null;
}

/** «1 500,50 ₸», «1500.5», «1 500» — всё это одна сумма. */
export function parseMoney(v: any): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\s/g, '');
  if (!s) return 0;
  // запятая как десятичный разделитель: 1500,50
  const norm = s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(norm);
  return Number.isFinite(n) ? n : 0;
}

/**
 * КАЗАХСКАЯ ТЕРМИНОЛОГИЯ.
 *
 * Собрана из казахского зеркала документации Wipon — это живые термины, на
 * которых уже работают казахстанские магазины, а не машинный перевод.
 * Особенно важны аббревиатуры документов: ЭСФ → ЭШФ, СНТ → ТІЖ, АВР → ОЖА.
 * Их не угадать переводом.
 */
export const KK_TERMS: Record<string, { ru: string; kk: string }> = {
  nomenclature:   { ru: 'Номенклатура',      kk: 'Номенклатура' },
  goods:          { ru: 'Товары',            kk: 'Тауарлар' },
  stock_balance:  { ru: 'Остатки товаров',   kk: 'Тауар қалдықтары' },
  name:           { ru: 'Наименование',      kk: 'Атауы' },
  category:       { ru: 'Категория товара',  kk: 'Тауар санаты' },
  barcode:        { ru: 'Штрихкод',          kk: 'Штрихкод' },
  qty:            { ru: 'Количество',        kk: 'Саны' },
  purchase_price: { ru: 'Цена закупки',      kk: 'Сатып алу бағасы' },
  sale_price:     { ru: 'Цена продажи',      kk: 'Сату бағасы' },
  vat:            { ru: 'НДС',               kk: 'ҚҚС' },
  service:        { ru: 'Услуга',            kk: 'Қызмет' },
  bundle:         { ru: 'Составной товар',   kk: 'Құрама тауар' },
  variant:        { ru: 'Многотипный товар', kk: 'Көптүрлі тауар' },
  receipt_stock:  { ru: 'Оприходование',     kk: 'Кіріске алу' },
  counterparties: { ru: 'Контрагенты',       kk: 'Контрагенттер' },
  suppliers:      { ru: 'Поставщики',        kk: 'Жабдықтаушылар' },
  clients:        { ru: 'Клиенты',           kk: 'Клиенттер' },
  debt_book:      { ru: 'Долговая книга',    kk: 'Қарыз кітабы' },
  documents:      { ru: 'Документы',         kk: 'Құжаттар' },
  esf:            { ru: 'ЭСФ',               kk: 'ЭШФ' },
  snt:            { ru: 'СНТ',               kk: 'ТІЖ' },
  avr:            { ru: 'АВР',               kk: 'ОЖА' },
  poa:            { ru: 'Доверенности',      kk: 'Сенімхаттар' },
  reconciliation: { ru: 'Акты сверки',       kk: 'Салыстырып тексеру актілері' },
  sold_goods:     { ru: 'Продаваемые товары', kk: 'Сатылған тауарлар' },
  profitable:     { ru: 'Доходные товары',   kk: 'Табысты тауарлар' },
  import_header:  { ru: 'Заголовок',         kk: 'Тақырып' },
  with_stock:     { ru: 'С остатками',       kk: 'Қалдықтарымен' },
  without_stock:  { ru: 'Без остатков',      kk: 'Қалдықтарсыз' },
  required_fields:{ ru: 'Обязательные поля', kk: 'Міндетті өрістер' },
  unit:           { ru: 'Единица измерения', kk: 'Өлшем бірлігі' },
  mass_ops:       { ru: 'Массовые операции', kk: 'Жаппай операциялар' },
};

export function t(key: string, lang: 'ru' | 'kk' = 'ru'): string {
  return KK_TERMS[key]?.[lang] ?? key;
}
