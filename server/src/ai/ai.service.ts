import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * ИИ-ФУНКЦИИ.
 *
 * Отвечают на главную жалобу клиентов UMAG — «технические трудности при
 * внесении позиций». Вместо семи полей руками — фотография этикетки.
 *
 * Wipon подошёл ближе всех со своей автоприёмкой («принимать товар прямо в
 * момент его добавления в корзину»), но у них честно написано:
 * «В офлайн-режиме автоприемка недоступна». Мы офлайн-first с 1.3, поэтому
 * распознавание уходит в очередь: фото снято сейчас, разобрано когда появится
 * связь.
 *
 * ЧЕСТНО: модели здесь нет — внешние домены закрыты, ключа к провайдеру нет.
 * Это открытый вопрос уровня договора, как ОФД и ИС ЭСФ. Контракт, очередь,
 * порог уверенности, подтверждение человеком, сборка черновика приёмки и
 * подсказки дозаказа — сделаны и проверены. Сам вызов модели подключается
 * за день.
 */

export interface AiProvider {
  readonly name: string;
  recognizeLabel(image: Buffer | string): Promise<AiResult<ProductDraft>>;
  parseVoice(text: string): Promise<AiResult<ProductDraft>>;
  recognizeInvoice(image: Buffer | string): Promise<AiResult<InvoiceDraft>>;
}

export interface AiResult<T> { ok: boolean; data?: T; confidence?: number; error?: string; retryable?: boolean; }
export interface ProductDraft {
  name?: string; barcode?: string; price?: number; purchasePrice?: number;
  unit?: string; category?: string; weight?: boolean;
}
export interface InvoiceDraft {
  supplier?: string; supplierBin?: string; number?: string; date?: string;
  items: { name: string; qty: number; price: number; barcode?: string; unit?: string }[];
}

/** Провайдер распознавания. Контракт зафиксирован, вызов подключается по ключу. */
export class LlmProvider implements AiProvider {
  readonly name = 'llm';
  private log = new Logger('Ai');
  private fail(): AiResult<any> {
    this.log.warn('ИИ-провайдер не подключён: нужен ключ доступа');
    return { ok: false, error: 'Распознавание не настроено: нужен доступ к ИИ-провайдеру', retryable: false };
  }
  async recognizeLabel() { return this.fail(); }
  async parseVoice() { return this.fail(); }
  async recognizeInvoice() { return this.fail(); }
}

/** Симулятор: проверяем очередь, пороги и подтверждение, а не саму модель. */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  failNext = 0;
  lowConfidence = false;
  labelResult: ProductDraft = { name: 'Молоко Айран 1л', barcode: '4870000000017', price: 480, unit: 'шт' };
  invoiceResult: InvoiceDraft = {
    supplier: 'ТОО Караван', supplierBin: '070740008064', number: 'Н-105', date: '2026-07-17',
    items: [
      { name: 'Молоко Айран 1л', qty: 20, price: 300, barcode: '4870000000017' },
      { name: 'Хлеб бородинский', qty: 30, price: 150 },
    ],
  };

  private wrap<T>(data: T): AiResult<T> {
    if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'Провайдер недоступен', retryable: true }; }
    return { ok: true, data, confidence: this.lowConfidence ? 0.42 : 0.94 };
  }
  async recognizeLabel() { return this.wrap(this.labelResult); }
  async recognizeInvoice() { return this.wrap(this.invoiceResult); }
  async parseVoice(text: string) {
    // «Молоко Айран литр двести восемьдесят тенге»
    const price = parseSpokenPrice(text);
    const name = text.replace(/\s*(за\s+)?[\d\s]*тенге.*$/i, '').replace(/\s+(двести|триста|сто|пятьсот|четыреста|шестьсот|семьсот|восемьсот|девятьсот|тысяч[аи]?|восемьдесят|девяносто|семьдесят|шестьдесят|пятьдесят|сорок|тридцать|двадцать|десять)\b.*$/i, '').trim();
    return this.wrap({ name: name || undefined, price, unit: 'шт' } as ProductDraft);
  }
}

/** «двести восемьдесят тенге» → 280. Продавец говорит словами, а не цифрами. */
export function parseSpokenPrice(text: string): number | undefined {
  const t = text.toLowerCase();
  const digits = t.match(/(\d[\d\s]*)\s*(тг|тенге|₸)/);
  if (digits) return Number(digits[1].replace(/\s/g, ''));
  const words: Record<string, number> = {
    ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
    восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13,
    четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18,
    девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
    семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200, триста: 300,
    четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  };
  let total = 0, current = 0, found = false;
  for (const w of t.split(/[\s,]+/)) {
    if (/^тысяч/.test(w)) { current = (current || 1) * 1000; total += current; current = 0; found = true; continue; }
    const v = words[w];
    if (v == null) continue;
    found = true;
    current += v;
  }
  total += current;
  return found && total > 0 ? total : undefined;
}

/** Количество для инвентаризации: «двадцать» → 20, «15» → 15. */
export function parseSpokenQty(text: string): number | undefined {
  const t = text.toLowerCase();
  const digits = t.match(/\b(\d+)\b/);
  if (digits) return Number(digits[1]);
  // переиспользуем разбор чисел словами (без привязки к тенге)
  const words: Record<string, number> = {
    ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
    восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13,
    четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18,
    девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
    семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100,
  };
  let total = 0, found = false;
  for (const w of t.split(/[\s,]+/)) {
    const v = words[w];
    if (v == null) continue;
    found = true; total += v;
  }
  return found ? total : undefined;
}

@Injectable()
export class AiService {
  private log = new Logger('AiService');
  private provider: AiProvider = process.env.NODE_ENV === 'test' ? new MockAiProvider() : new LlmProvider();
  /** Ниже этого порога не предлагаем сохранять молча — просим проверить. */
  private readonly MIN_CONFIDENCE = 0.7;

  constructor(private db: DbService) {}
  setProvider(p: AiProvider) { this.provider = p; }

  // ==================================================================
  // 13.1 КАРТОЧКА ТОВАРА ПО ФОТО И ГОЛОСОМ
  // ==================================================================

  /**
   * Фото этикетки → черновик карточки.
   * В офлайне задача просто ложится в очередь — у Wipon автоприёмка в офлайне
   * недоступна вовсе.
   */
  async productFromPhoto(accountId: string, dto: { imageRef: string; employeeId?: string; deviceId?: string }) {
    return this.enqueue(accountId, 'product_photo', { inputRef: dto.imageRef, ...dto });
  }

  async productFromVoice(accountId: string, dto: { text: string; employeeId?: string; deviceId?: string }) {
    if (!dto.text?.trim()) throw new BadRequestException('Пустая расшифровка');
    return this.enqueue(accountId, 'product_voice', { inputText: dto.text, ...dto });
  }

  async invoiceFromPhoto(accountId: string, dto: { imageRef: string; employeeId?: string; deviceId?: string }) {
    return this.enqueue(accountId, 'invoice_photo', { inputRef: dto.imageRef, ...dto });
  }

  private async enqueue(accountId: string, kind: string, dto: any) {
    const id = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO ai_task (account_id, kind, status, input_ref, input_text, employee_id, device_id, provider)
         VALUES ($1,$2::ai_task_kind,'queued',$3,$4,$5,$6,$7) RETURNING id`,
        [accountId, kind, dto.inputRef ?? null, dto.inputText ?? null,
         dto.employeeId ?? null, dto.deviceId ?? null, this.provider.name])).rows[0].id);
    // пробуем сразу; если связи нет — задача останется в очереди
    const r: any = await this.process(accountId, id).catch((): any => null);
    return r ?? { taskId: id, status: 'queued', note: 'Нет связи — распознаем, когда появится' };
  }

  /** Обработка одной задачи. */
  async process(accountId: string, taskId: string) {
    const task = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM ai_task WHERE id=$1`, [taskId])).rows[0]);
    if (!task) throw new BadRequestException('Задача не найдена');
    if (['done', 'confirmed'].includes(task.status))
      return { taskId, status: task.status, result: task.result, confidence: Number(task.confidence ?? 0) };

    await this.db.withTenant(accountId, async (c) =>
      c.query(`UPDATE ai_task SET status='running', attempts=attempts+1 WHERE id=$1`, [taskId]));

    let r: AiResult<any>;
    if (task.kind === 'product_photo') r = await this.provider.recognizeLabel(task.input_ref);
    else if (task.kind === 'product_voice') r = await this.provider.parseVoice(task.input_text);
    else if (task.kind === 'invoice_photo') r = await this.provider.recognizeInvoice(task.input_ref);
    else throw new BadRequestException('Неизвестный вид задачи');

    if (!r.ok) {
      const backoff = Math.min(2 ** (Number(task.attempts) + 1), 300);
      await this.db.withTenant(accountId, async (c) =>
        c.query(
          `UPDATE ai_task SET status=$2::ai_task_status, error=$3,
                  next_try_at = CASE WHEN $4::boolean THEN now() + ($5 || ' seconds')::interval END
            WHERE id=$1`,
          [taskId, r.retryable ? 'queued' : 'failed', r.error, r.retryable ?? false, backoff]));
      return { taskId, status: r.retryable ? 'queued' : 'failed', error: r.error, retryable: r.retryable };
    }

    await this.db.withTenant(accountId, async (c) =>
      c.query(
        `UPDATE ai_task SET status='done', result=$2, confidence=$3::numeric, error=NULL, next_try_at=NULL
          WHERE id=$1`, [taskId, JSON.stringify(r.data), r.confidence ?? null]));

    const low = (r.confidence ?? 0) < this.MIN_CONFIDENCE;
    return {
      taskId, status: 'done', result: r.data, confidence: r.confidence,
      lowConfidence: low,
      // никогда не пишем в базу молча: неверная цена — это деньги владельца
      needsReview: true,
      hint: low
        ? 'Распознали неуверенно — проверьте каждое поле'
        : 'Проверьте и подтвердите: сохраняем только после вашего подтверждения',
    };
  }

  /** Очередь: связь появилась — задачи разобрались. */
  async processQueue(accountId: string, limit = 20) {
    const jobs = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id FROM ai_task WHERE status='queued' AND (next_try_at IS NULL OR next_try_at <= now())
          ORDER BY created_at LIMIT $1`, [limit])).rows);
    let done = 0, failed = 0;
    for (const j of jobs) {
      const r: any = await this.process(accountId, j.id).catch((): any => null);
      r?.status === 'done' ? done++ : failed++;
    }
    return { processed: jobs.length, done, failed };
  }

  /**
   * Подтверждение карточки человеком — только теперь пишем в базу.
   * Человек может поправить любое поле: модель ошибается.
   */
  async confirmProduct(accountId: string, dto: {
    taskId: string; employeeId: string; overrides?: ProductDraft;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const task = (await c.query(`SELECT * FROM ai_task WHERE id=$1`, [dto.taskId])).rows[0];
      if (!task) throw new BadRequestException('Задача не найдена');
      if (task.status === 'confirmed') return { created: false, reason: 'Уже подтверждено', productId: task.created_entity_id };
      if (task.status !== 'done') throw new BadRequestException('Распознавание ещё не завершено');

      const d: ProductDraft = { ...(task.result ?? {}), ...(dto.overrides ?? {}) };
      if (!d.name?.trim()) throw new BadRequestException('Без названия товар не создать');

      const unit = (await c.query(
        `SELECT id FROM unit WHERE short_name = coalesce($1,'шт') OR $1 IS NULL ORDER BY (short_name=$1) DESC LIMIT 1`,
        [d.unit ?? null])).rows[0];
      let categoryId: string | null = null;
      if (d.category) {
        const cat = (await c.query(
          `INSERT INTO category (account_id, name) VALUES ($1,$2)
           ON CONFLICT DO NOTHING RETURNING id`, [accountId, d.category])).rows[0]
          ?? (await c.query(`SELECT id FROM category WHERE account_id=$1 AND name=$2`, [accountId, d.category])).rows[0];
        categoryId = cat?.id ?? null;
      }

      // штрихкод мог уже быть у другого товара — не задваиваем
      if (d.barcode) {
        const dup = (await c.query(
          `SELECT p.name FROM barcode b JOIN product p ON p.id=b.product_id
            WHERE b.code=$1 AND p.archived_at IS NULL`, [d.barcode])).rows[0];
        if (dup) throw new BadRequestException(`Штрихкод ${d.barcode} уже у товара «${dup.name}»`);
      }

      const p = (await c.query(
        `INSERT INTO product (account_id, name, kind, unit_id, category_id, purchase_price)
         VALUES ($1,$2,$3::product_kind,$4,$5,$6::numeric) RETURNING id, name`,
        [accountId, d.name.trim(), d.weight ? 'weight' : 'simple', unit?.id ?? null,
         categoryId, d.purchasePrice ?? null])).rows[0];

      if (d.barcode)
        await c.query(
          `INSERT INTO barcode (account_id, product_id, code, is_primary) VALUES ($1,$2,$3,true)`,
          [accountId, p.id, d.barcode]);
      if (d.price)
        await c.query(
          `INSERT INTO product_price (account_id, product_id, price_type_id, value)
           VALUES ($1,$2,(SELECT id FROM price_type WHERE code='retail' LIMIT 1),$3::numeric)`,
          [accountId, p.id, d.price]);

      await c.query(
        `UPDATE ai_task SET status='confirmed', confirmed_by=$2, confirmed_at=now(), created_entity_id=$3
          WHERE id=$1`, [dto.taskId, dto.employeeId, p.id]);

      return { created: true, productId: p.id, name: p.name, price: d.price ?? null };
    });
  }

  async rejectTask(accountId: string, taskId: string, employeeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `UPDATE ai_task SET status='rejected', confirmed_by=$2, confirmed_at=now() WHERE id=$1`,
        [taskId, employeeId ?? null]);
      return { rejected: true };
    });
  }

  // ==================================================================
  // 13.2 АВТОПРИЁМКА
  // ==================================================================

  /**
   * Приёмка из входящего ЭСФ в один клик.
   *
   * Развитие идеи Wipon: у них автоприёмка — это принять товар в момент
   * продажи. Но если поставщик выписал ЭСФ (Часть 9), в нём уже лежат позиции,
   * количества, цены и НКТ — точные данные из государственной системы, а не
   * распознавание. Приёмка собирается сама.
   */
  async receiveFromEsf(accountId: string, dto: { govDocId: string; warehouseId: string; employeeId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(
        `SELECT * FROM gov_doc WHERE id=$1 AND kind='esf' AND deleted_at IS NULL`, [dto.govDocId])).rows[0];
      if (!doc) throw new BadRequestException('ЭСФ не найден');
      if (doc.direction !== 'received')
        throw new BadRequestException('Приёмка собирается из входящего ЭСФ — этот выписан нами');
      if (doc.doc_id) return { created: false, reason: 'По этому ЭСФ приёмка уже сделана', docId: doc.doc_id };

      const items = (await c.query(
        `SELECT * FROM gov_doc_item WHERE gov_doc_id=$1 ORDER BY line_no`, [dto.govDocId])).rows;
      if (!items.length) throw new BadRequestException('В ЭСФ нет позиций');

      const num = (await c.query(`SELECT next_doc_number($1,'supply') AS n`, [accountId])).rows[0].n;
      const sd = (await c.query(
        `INSERT INTO stock_doc (account_id, kind, number, warehouse_id, supplier_id, employee_id, status, comment)
         VALUES ($1,'supply',$2,$3,$4,$5,'draft',$6) RETURNING id, number`,
        [accountId, num, dto.warehouseId, doc.counterparty_id, dto.employeeId ?? null,
         `Собрано из ЭСФ №${doc.gov_number ?? doc.number}`])).rows[0];

      const matched: any[] = [], unmatched: any[] = [];
      for (const it of items) {
        // ищем товар по НКТ, потом по названию: НКТ точнее, он из госкаталога
        const p = (await c.query(
          `SELECT id, name FROM product
            WHERE archived_at IS NULL AND (($1::text IS NOT NULL AND ntin = $1) OR lower(name) = lower($2))
            ORDER BY (ntin = $1) DESC LIMIT 1`, [it.ntin, it.name])).rows[0];
        if (!p) { unmatched.push({ name: it.name, ntin: it.ntin, qty: Number(it.qty) }); continue; }
        await c.query(
          `INSERT INTO stock_doc_item (account_id, doc_id, product_id, qty, price)
           VALUES ($1,$2,$3,$4::numeric,$5::numeric)`,
          [accountId, sd.id, p.id, it.qty, it.price]);
        matched.push({ name: p.name, qty: Number(it.qty), price: Number(it.price) });
      }

      await c.query(`UPDATE gov_doc SET doc_id=$2 WHERE id=$1`, [dto.govDocId, sd.id]);

      return {
        created: true, docId: sd.id, number: sd.number,
        matched: matched.length, unmatched,
        // черновик, а не проведённый документ: человек смотрит и проводит
        status: 'draft',
        hint: unmatched.length
          ? `${unmatched.length} позиций нет в каталоге — заведите их или сопоставьте вручную`
          : 'Все позиции сопоставлены. Проверьте и проведите приёмку',
      };
    });
  }

  /** Фото накладной → черновик приёмки (когда ЭСФ нет). */
  async receiveFromInvoicePhoto(accountId: string, dto: {
    taskId: string; warehouseId: string; employeeId?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const task = (await c.query(`SELECT * FROM ai_task WHERE id=$1 AND kind='invoice_photo'`, [dto.taskId])).rows[0];
      if (!task) throw new BadRequestException('Задача не найдена');
      if (task.status !== 'done') throw new BadRequestException('Накладная ещё не распознана');
      const inv: InvoiceDraft = task.result;
      if (!inv?.items?.length) throw new BadRequestException('В накладной не распознано ни одной позиции');

      // поставщика ищем по БИН, потом по названию
      const sup = (await c.query(
        `SELECT id, name FROM counterparty
          WHERE deleted_at IS NULL AND (($1::text IS NOT NULL AND iin_bin = $1) OR lower(name) = lower($2))
          LIMIT 1`, [inv.supplierBin ?? null, inv.supplier ?? ''])).rows[0];

      const num = (await c.query(`SELECT next_doc_number($1,'supply') AS n`, [accountId])).rows[0].n;
      const sd = (await c.query(
        `INSERT INTO stock_doc (account_id, kind, number, warehouse_id, supplier_id, employee_id, status, comment)
         VALUES ($1,'supply',$2,$3,$4,$5,'draft',$6) RETURNING id, number`,
        [accountId, num, dto.warehouseId, sup?.id ?? null, dto.employeeId ?? null,
         `Распознано с фото накладной${inv.number ? ` №${inv.number}` : ''}`])).rows[0];

      const matched: any[] = [], unmatched: any[] = [];
      for (const it of inv.items) {
        const p = (await c.query(
          `SELECT p.id, p.name FROM product p
            LEFT JOIN barcode b ON b.product_id = p.id
            WHERE p.archived_at IS NULL
              AND (($1::text IS NOT NULL AND b.code = $1) OR lower(p.name) = lower($2))
            LIMIT 1`, [it.barcode ?? null, it.name])).rows[0];
        if (!p) { unmatched.push({ name: it.name, qty: it.qty, price: it.price }); continue; }
        await c.query(
          `INSERT INTO stock_doc_item (account_id, doc_id, product_id, qty, price)
           VALUES ($1,$2,$3,$4::numeric,$5::numeric)`, [accountId, sd.id, p.id, it.qty, it.price]);
        matched.push({ name: p.name, qty: it.qty, price: it.price });
      }

      await c.query(`UPDATE ai_task SET status='confirmed', created_entity_id=$2, confirmed_by=$3, confirmed_at=now() WHERE id=$1`,
        [dto.taskId, sd.id, dto.employeeId ?? null]);

      return {
        created: true, docId: sd.id, number: sd.number, status: 'draft',
        supplier: sup?.name ?? inv.supplier,
        supplierFound: !!sup,
        matched: matched.length, unmatched,
        confidence: Number(task.confidence ?? 0),
        hint: 'Это черновик: сверьте с бумагой и проведите. Распознавание может ошибаться',
      };
    });
  }

  /**
   * AI-ПРИЁМКА НА МАКСИМУМ (часть 33): сверка распознанной накладной с заказом
   * поставщику и с историей цен. Показывает расхождения ДО проведения:
   *  • недовоз (заказали 10 — в накладной 8), перевоз;
   *  • подорожание (цена в накладной выше прошлой поставки);
   *  • новый товар (нет в каталоге).
   * Ничего не пишет в остатки — только предупреждает человека.
   */
  async checkInvoiceAgainstOrder(accountId: string, dto: { taskId: string; orderId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const task = (await c.query(`SELECT * FROM ai_task WHERE id=$1 AND kind='invoice_photo'`, [dto.taskId])).rows[0];
      if (!task) throw new BadRequestException('Задача не найдена');
      if (task.status !== 'done') throw new BadRequestException('Накладная ещё не распознана');
      const inv: InvoiceDraft = task.result;
      if (!inv?.items?.length) throw new BadRequestException('В накладной нет позиций');

      // заказанные количества (если указан заказ поставщику)
      const ordered = new Map<string, { qty: number; productId: string; name: string }>();
      if (dto.orderId) {
        const rows = (await c.query(
          `SELECT poi.product_id, poi.qty, p.name FROM purchase_order_item poi
             JOIN product p ON p.id = poi.product_id WHERE poi.order_id=$1`, [dto.orderId])).rows;
        for (const r of rows) ordered.set(r.name.toLowerCase(), { qty: Number(r.qty), productId: r.product_id, name: r.name });
      }

      // чистим прошлые проверки этой задачи
      await c.query(`DELETE FROM ai_receipt_check WHERE task_id=$1`, [dto.taskId]);
      const checks: any[] = [];
      const seenOrdered = new Set<string>();

      for (const it of inv.items) {
        // ищем товар по ШК/названию
        const prod = (await c.query(
          `SELECT p.id, p.name FROM product p LEFT JOIN barcode b ON b.product_id=p.id
            WHERE p.archived_at IS NULL AND (($1::text IS NOT NULL AND b.code=$1) OR lower(p.name)=lower($2)) LIMIT 1`,
          [it.barcode ?? null, it.name])).rows[0];

        if (!prod) {
          checks.push({ kind: 'new_product', product_name: it.name, invoice_qty: it.qty, invoice_price: it.price,
            note: 'Нет в каталоге — будет создан новый товар' });
          continue;
        }

        // контроль цены: сравнение с последней закупкой
        const lastPrice = (await c.query(`SELECT last_purchase_price($1,$2) AS p`, [accountId, prod.id])).rows[0].p;
        if (lastPrice != null && Number(it.price) > Number(lastPrice)) {
          const pct = Math.round(((Number(it.price) - Number(lastPrice)) / Number(lastPrice)) * 100);
          checks.push({ kind: 'price_up', product_id: prod.id, product_name: prod.name,
            last_price: Number(lastPrice), invoice_price: it.price,
            note: `Подорожание на ${pct}% (было ${lastPrice}, стало ${it.price})` });
        } else if (lastPrice != null && Number(it.price) < Number(lastPrice)) {
          checks.push({ kind: 'price_down', product_id: prod.id, product_name: prod.name,
            last_price: Number(lastPrice), invoice_price: it.price, note: 'Подешевело' });
        }

        // сверка с заказом
        const ord = ordered.get(it.name.toLowerCase());
        if (ord) {
          seenOrdered.add(it.name.toLowerCase());
          if (Number(it.qty) < ord.qty)
            checks.push({ kind: 'shortfall', product_id: prod.id, product_name: prod.name,
              ordered_qty: ord.qty, invoice_qty: it.qty, note: `Недовоз: заказали ${ord.qty}, привезли ${it.qty}` });
          else if (Number(it.qty) > ord.qty)
            checks.push({ kind: 'surplus', product_id: prod.id, product_name: prod.name,
              ordered_qty: ord.qty, invoice_qty: it.qty, note: `Перевоз: заказали ${ord.qty}, привезли ${it.qty}` });
        }
      }

      // заказанное, но не привезённое вовсе
      for (const [key, ord] of ordered) {
        if (!seenOrdered.has(key))
          checks.push({ kind: 'shortfall', product_id: ord.productId, product_name: ord.name,
            ordered_qty: ord.qty, invoice_qty: 0, note: `Не привезли вовсе (заказали ${ord.qty})` });
      }

      // сохраняем
      for (const ch of checks)
        await c.query(
          `INSERT INTO ai_receipt_check (account_id, task_id, product_id, product_name, kind,
                    ordered_qty, invoice_qty, last_price, invoice_price, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [accountId, dto.taskId, ch.product_id ?? null, ch.product_name, ch.kind,
           ch.ordered_qty ?? null, ch.invoice_qty ?? null, ch.last_price ?? null, ch.invoice_price ?? null, ch.note]);

      return {
        checks,
        summary: {
          shortfall: checks.filter((x) => x.kind === 'shortfall').length,
          surplus: checks.filter((x) => x.kind === 'surplus').length,
          priceUp: checks.filter((x) => x.kind === 'price_up').length,
          newProducts: checks.filter((x) => x.kind === 'new_product').length,
        },
        clean: checks.length === 0,
      };
    });
  }

  /**
   * ГОЛОСОВАЯ ИНВЕНТАРИЗАЦИЯ: продавец наговаривает «сахар двадцать, мука
   * пятнадцать» — распознаём в позиции факта. Руки заняты товаром, считать
   * удобнее голосом. Возвращает распознанные пары товар→количество для
   * подтверждения человеком (в базу пишет обычная инвентаризация).
   */
  async parseVoiceInventory(accountId: string, dto: { text: string }) {
    if (!dto.text?.trim()) throw new BadRequestException('Пустая запись');
    return this.db.withTenant(accountId, async (c) => {
      // разбиваем по запятым/«и»/переводам строк: «сахар двадцать, мука пятнадцать»
      const parts = dto.text.split(/[,\n;]|\sи\s/).map((s) => s.trim()).filter(Boolean);
      const recognized: any[] = [], notFound: any[] = [];
      for (const part of parts) {
        const qty = parseSpokenQty(part);
        if (qty == null) continue;
        // имя товара = часть до числа (цифрой или словом). \b плохо работает с
        // кириллицей, поэтому режем по пробелу перед числительным.
        const name = part
          .replace(/\s+\d+.*$/i, '')  // цифрой
          .replace(/\s+(ноль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто)(\s.*)?$/i, '')
          .trim();
        if (!name) continue;
        const prod = (await c.query(
          `SELECT id, name FROM product WHERE archived_at IS NULL AND lower(name) LIKE lower($1) LIMIT 1`,
          [`%${name}%`])).rows[0];
        if (prod) recognized.push({ productId: prod.id, product: prod.name, qty, said: part });
        else notFound.push({ said: part, name, qty });
      }
      return { recognized, notFound,
        hint: 'Проверьте распознанное и создайте инвентаризацию с этими количествами' };
    });
  }

  // ==================================================================
  // 13.3 ПОДСКАЗКИ ДОЗАКАЗА
  // ==================================================================

  /**
   * План пополнения из Части 3 знает только минимальный остаток. Здесь —
   * скорость продаж и дни до нуля: то, чего формула не видит.
   */
  async restockAdvice(accountId: string, days = 30) {
    const { rows } = await this.db.raw(`SELECT * FROM restock_advice($1,$2)`, [accountId, days]);
    const items = rows.map((r: any) => {
      const perDay = Number(r.per_day);
      const daysLeft = r.days_left == null ? null : Number(r.days_left);
      const suggest = Math.max(0, Math.ceil(Number(r.suggest_qty)));
      return {
        productId: r.product_id, name: r.name,
        stock: Number(r.stock), minStock: r.min_stock == null ? null : Number(r.min_stock),
        soldQty: Number(r.sold_qty), perDay, daysLeft,
        suggestQty: suggest,
        supplier: r.supplier, supplierId: r.supplier_id,
        urgency: r.urgency,
        // человеческая формулировка: владелец читает её на бегу
        advice: r.urgency === 'out'
          ? `«${r.name}» закончился${perDay > 0 ? `, продавалось ${perDay} в день` : ''}. Взять ${suggest}`
          : daysLeft != null
            ? `«${r.name}» кончится через ${daysLeft} дн. (${perDay} в день). Взять ${suggest}`
            : `«${r.name}»: осталось ${Number(r.stock)}, ниже минимума. Взять ${suggest}`,
      };
    });
    const bySupplier = new Map<string, any>();
    for (const i of items) {
      const key = i.supplierId ?? 'none';
      if (!bySupplier.has(key))
        bySupplier.set(key, { supplierId: i.supplierId, supplier: i.supplier ?? 'Без поставщика', items: [] });
      bySupplier.get(key).items.push(i);
    }
    return {
      items,
      urgent: items.filter((i: any) => i.urgency === 'out' || i.urgency === 'critical'),
      // заказ собирают по поставщикам, а не по товарам
      bySupplier: [...bySupplier.values()],
      summary: {
        out: items.filter((i: any) => i.urgency === 'out').length,
        critical: items.filter((i: any) => i.urgency === 'critical').length,
        soon: items.filter((i: any) => i.urgency === 'soon').length,
        total: items.length,
      },
    };
  }

  async tasks(accountId: string, f: { kind?: string; status?: string; limit?: number } = {}) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, kind, status, confidence, result, error, created_at, confirmed_at
           FROM ai_task
          WHERE ($1::text IS NULL OR kind::text = $1) AND ($2::text IS NULL OR status::text = $2)
          ORDER BY created_at DESC LIMIT $3`,
        [f.kind ?? null, f.status ?? null, f.limit ?? 50])).rows
        .map((r: any) => ({ ...r, confidence: r.confidence == null ? null : Number(r.confidence) })));
  }
}
