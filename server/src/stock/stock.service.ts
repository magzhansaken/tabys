import { Injectable, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { SyncService } from '../sync/sync.service';
import { GoodsService } from '../goods/goods.service';

/**
 * СКЛАД.
 *
 * Принцип из 1.3: остаток — это сумма движений, а не перезаписываемое поле.
 * Две кассы не могут затереть остаток друг друга, потому что присылают
 * «−2» и «−1», а не «остаток = 5».
 *
 * Себестоимость — средневзвешенная скользящая. У МоегоСклада и UMAG это
 * FIFO, но FIFO требует строгого порядка документов: МойСклад сам пишет,
 * что при продаже раньше закупки себестоимость станет нулевой. У нас касса
 * работает офлайн и отдаёт события с задержкой — продажа в 14:03 может
 * приехать в 19:00, позже приёмки. FIFO ломался бы регулярно.
 */

export type DocKind = 'supply' | 'supplier_return' | 'transfer' | 'write_off' | 'adjustment' | 'inventory';

export interface DocItemInput {
  productId: string;
  qty: number;
  price?: number;
  packageId?: string;
  qtyPackages?: number;
  reason?: string;
}

@Injectable()
export class StockService {
  constructor(private db: DbService, private sync: SyncService, private goods: GoodsService) {}

  // ==================================================================
  // ЧЕРНОВИК ДОКУМЕНТА (модель UMAG: черновик не влияет на учёт)
  // ==================================================================
  async createDoc(accountId: string, dto: {
    kind: DocKind; warehouseId?: string; warehouseToId?: string; supplierId?: string;
    storeId?: string; comment?: string; employeeId?: string; blind?: boolean; extraCosts?: number;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const wh = dto.warehouseId ?? (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0]?.id;
      if (!wh) throw new BadRequestException('Не указан склад');
      if (dto.kind === 'transfer' && !dto.warehouseToId) throw new BadRequestException('Для перемещения нужен склад-получатель');
      if (dto.kind === 'transfer' && dto.warehouseToId === wh) throw new BadRequestException('Склады отправителя и получателя совпадают');

      const num = (await c.query(`SELECT next_doc_number($1,$2) AS n`, [accountId, dto.kind])).rows[0].n;
      const { rows } = await c.query(
        `INSERT INTO stock_doc (account_id, kind, number, warehouse_id, warehouse_to_id, supplier_id,
                                store_id, comment, employee_id, blind, extra_costs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [accountId, dto.kind, num, wh, dto.warehouseToId ?? null, dto.supplierId ?? null,
         dto.storeId ?? null, dto.comment ?? null, dto.employeeId ?? null, dto.blind ?? false, dto.extraCosts ?? 0]);
      return rows[0];
    });
  }

  /**
   * Добавление позиции. Для инвентаризации фиксируем учётный остаток НА МОМЕНТ
   * ПЕРВОГО сканирования — находка UMAG: «система фиксирует время первого
   * сканирования и остаток на момент первого сканирования». Магазин продолжает
   * торговать во время пересчёта, и продажи не портят результат.
   *
   * Товары с одинаковым штрихкодом суммируются (тоже UMAG).
   */
  async addItem(accountId: string, docId: string, item: DocItemInput) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = await this.getDocForEdit(c, docId);

      let qty = item.qty;
      if (item.packageId) {   // приёмка блоками (упаковки из 2.6)
        const pkg = (await c.query(`SELECT quantity FROM package WHERE id=$1 AND deleted_at IS NULL`, [item.packageId])).rows[0];
        if (!pkg) throw new BadRequestException('Упаковка не найдена');
        qty = Number(item.qtyPackages ?? item.qty) * Number(pkg.quantity);
      }

      let qtyBook: number | null = null;
      if (doc.kind === 'inventory') {
        const exists = (await c.query(`SELECT qty_book FROM stock_doc_item WHERE doc_id=$1 AND product_id=$2`,
          [docId, item.productId])).rows[0];
        if (exists) qtyBook = exists.qty_book;      // уже фиксировали — не трогаем
        else {
          const b = (await c.query(`SELECT qty FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
            [doc.warehouse_id, item.productId])).rows[0];
          qtyBook = Number(b?.qty ?? 0);
        }
      }

      const { rows } = await c.query(
        `INSERT INTO stock_doc_item (account_id, doc_id, product_id, package_id, qty, qty_packages, price, qty_book, book_at, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric, CASE WHEN $8::numeric IS NULL THEN NULL ELSE now() END, $9)
         ON CONFLICT (doc_id, product_id) DO UPDATE
           SET qty = stock_doc_item.qty + EXCLUDED.qty,
               price = coalesce(EXCLUDED.price, stock_doc_item.price),
               qty_packages = coalesce(EXCLUDED.qty_packages, stock_doc_item.qty_packages)
         RETURNING *`,
        [accountId, docId, item.productId, item.packageId ?? null, qty,
         item.qtyPackages ?? null, item.price ?? null, qtyBook, item.reason ?? null]);
      await this.recalcTotal(c, docId);
      return rows[0];
    });
  }

  /** Установить факт (инвентаризация): не прибавляем, а заменяем. */
  async setFact(accountId: string, docId: string, productId: string, qty: number) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = await this.getDocForEdit(c, docId);
      if (doc.kind !== 'inventory') throw new BadRequestException('Факт указывается только в инвентаризации');
      const cur = (await c.query(`SELECT id FROM stock_doc_item WHERE doc_id=$1 AND product_id=$2`, [docId, productId])).rows[0];
      if (!cur) return this.addItemInternal(c, accountId, doc, productId, qty);
      const { rows } = await c.query(`UPDATE stock_doc_item SET qty=$3 WHERE doc_id=$1 AND product_id=$2 RETURNING *`,
        [docId, productId, qty]);
      return rows[0];
    });
  }

  private async addItemInternal(c: PoolClient, accountId: string, doc: any, productId: string, qty: number) {
    const b = (await c.query(`SELECT qty FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
      [doc.warehouse_id, productId])).rows[0];
    const { rows } = await c.query(
      `INSERT INTO stock_doc_item (account_id, doc_id, product_id, qty, qty_book, book_at)
       VALUES ($1,$2,$3,$4,$5, now()) RETURNING *`,
      [accountId, doc.id, productId, qty, Number(b?.qty ?? 0)]);
    return rows[0];
  }

  private async getDocForEdit(c: PoolClient, docId: string) {
    const doc = (await c.query(`SELECT * FROM stock_doc WHERE id=$1 AND deleted_at IS NULL`, [docId])).rows[0];
    if (!doc) throw new BadRequestException('Документ не найден');
    if (doc.status === 'done') throw new BadRequestException('Документ уже проведён — изменить нельзя');
    return doc;
  }

  private async recalcTotal(c: PoolClient, docId: string) {
    await c.query(
      `UPDATE stock_doc SET total_sum = coalesce((SELECT sum(qty * coalesce(price,0)) FROM stock_doc_item WHERE doc_id=$1),0)
        WHERE id=$1`, [docId]);
  }

  /**
   * Добавить из не отсканированных / массовое обнуление (UMAG):
   * то, что не нашли на полке, — это ноль.
   */
  async addMissingAsZero(accountId: string, docId: string, filter: { categoryId?: string } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = await this.getDocForEdit(c, docId);
      const { rows } = await c.query(
        `INSERT INTO stock_doc_item (account_id, doc_id, product_id, qty, qty_book, book_at)
         SELECT $1, $2, p.id, 0, coalesce(b.qty, 0), now()
           FROM product p
           LEFT JOIN stock_balance b ON b.product_id = p.id AND b.warehouse_id = $3
          WHERE p.account_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.track_stock
            AND ($4::uuid IS NULL OR p.category_id = $4)
            AND NOT EXISTS (SELECT 1 FROM stock_doc_item i WHERE i.doc_id = $2 AND i.product_id = p.id)
         RETURNING id`,
        [accountId, docId, doc.warehouse_id, filter.categoryId ?? null]);
      return { added: rows.length };
    });
  }

  // ==================================================================
  // ВАЛИДАЦИЯ ПЕРЕД ПРОВЕДЕНИЕМ (модель UMAG: ошибки показываются заранее)
  // ==================================================================
  async validate(accountId: string, docId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT * FROM stock_doc WHERE id=$1`, [docId])).rows[0];
      if (!doc) throw new BadRequestException('Документ не найден');
      const problems: { productId?: string; error: string }[] = [];

      const items = (await c.query(
        `SELECT i.*, p.name, p.track_stock, p.deleted_at, p.archived_at
           FROM stock_doc_item i JOIN product p ON p.id = i.product_id WHERE i.doc_id=$1`, [docId])).rows;
      if (!items.length) problems.push({ error: 'В документе нет ни одной позиции' });

      for (const it of items) {
        if (it.deleted_at) problems.push({ productId: it.product_id, error: `«${it.name}» удалён из номенклатуры` });
        if (!it.track_stock) problems.push({ productId: it.product_id, error: `«${it.name}» — услуга, остатки не ведутся` });
        if (doc.kind === 'supply' && (it.price == null || Number(it.price) < 0))
          problems.push({ productId: it.product_id, error: `У «${it.name}» не указана цена закупки` });
        if (doc.kind !== 'inventory' && Number(it.qty) <= 0)
          problems.push({ productId: it.product_id, error: `У «${it.name}» количество должно быть больше нуля` });
      }

      // Расход не может увести остаток в минус, если это запрещено настройкой
      const acc = (await c.query(`SELECT allow_negative_stock FROM account WHERE id=$1`, [accountId])).rows[0];
      if (!acc.allow_negative_stock && ['write_off', 'transfer', 'supplier_return'].includes(doc.kind)) {
        for (const it of items) {
          const b = (await c.query(`SELECT qty FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
            [doc.warehouse_id, it.product_id])).rows[0];
          if (Number(b?.qty ?? 0) < Number(it.qty))
            problems.push({ productId: it.product_id, error: `«${it.name}»: на складе ${b?.qty ?? 0}, списывается ${it.qty}` });
        }
      }
      return { valid: problems.length === 0, problems };
    });
  }

  /**
   * Готовность к инвентаризации — ответ на предупреждение UMAG
   * «кассы должны быть синхронизированы, иначе остатки могут быть неточными».
   * Мы не предупреждаем — мы знаем (механика из 1.3).
   */
  async inventoryReadiness(accountId: string, storeId?: string) {
    return this.sync.readiness(accountId, storeId);
  }

  // ==================================================================
  // ПРОВЕДЕНИЕ
  // ==================================================================
  async process(accountId: string, docId: string, opts: { force?: boolean } = {}) {
    const v = await this.validate(accountId, docId);
    if (!v.valid) throw new BadRequestException(`Документ не проведён: ${v.problems.map((p) => p.error).join('; ')}`);

    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT * FROM stock_doc WHERE id=$1 FOR UPDATE`, [docId])).rows[0];
      if (doc.status === 'done') throw new BadRequestException('Документ уже проведён');

      // Инвентаризация: перед проведением сверяемся, все ли кассы отдали события.
      // UMAG в этом месте лишь предупреждает — мы блокируем.
      if (doc.kind === 'inventory' && !opts.force) {
        const r = await this.sync.readiness(accountId, doc.store_id ?? undefined);
        if (!r.ready) throw new BadRequestException(r.message);
      }

      await c.query(`UPDATE stock_doc SET status='processing' WHERE id=$1`, [docId]);
      const items = (await c.query(`SELECT * FROM stock_doc_item WHERE doc_id=$1`, [docId])).rows;

      // накладные расходы (модель МС): распределяем пропорционально сумме позиции
      const extra = Number(doc.extra_costs ?? 0);
      const total = items.reduce((s: number, i: any) => s + Number(i.qty) * Number(i.price ?? 0), 0);

      let surplus = 0, shortage = 0, shortageSum = 0;

      for (const it of items) {
        const qty = Number(it.qty);
        let price = it.price == null ? null : Number(it.price);

        if (doc.kind === 'supply' && extra > 0 && total > 0 && price != null) {
          const share = (qty * price) / total;
          price = price + (extra * share) / qty;      // доставка увеличивает себестоимость
        }

        switch (doc.kind) {
          case 'supply':
            await this.move(c, accountId, doc.warehouse_id, it.product_id, qty, price, 'supply', docId, doc.employee_id);
            await c.query(`UPDATE product SET purchase_price=$2::numeric WHERE id=$1 AND $2::numeric IS NOT NULL`, [it.product_id, it.price]);
            break;
          case 'supplier_return':
            await this.move(c, accountId, doc.warehouse_id, it.product_id, -qty, null, 'supplier_return', docId, doc.employee_id);
            break;
          case 'write_off':
            await this.move(c, accountId, doc.warehouse_id, it.product_id, -qty, null, 'write_off', docId, doc.employee_id);
            break;
          case 'adjustment':
            await this.move(c, accountId, doc.warehouse_id, it.product_id, qty, price, 'adjustment', docId, doc.employee_id);
            break;
          case 'transfer':
            await this.move(c, accountId, doc.warehouse_id, it.product_id, -qty, null, 'transfer_out', docId, doc.employee_id);
            const cost = (await c.query(`SELECT avg_cost FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
              [doc.warehouse_id, it.product_id])).rows[0]?.avg_cost ?? 0;
            await this.move(c, accountId, doc.warehouse_to_id, it.product_id, qty, Number(cost), 'transfer_in', docId, doc.employee_id);
            break;
          case 'inventory': {
            // разница считается от остатка НА МОМЕНТ ПЕРВОГО СКАНИРОВАНИЯ (UMAG)
            const book = Number(it.qty_book ?? 0);
            const diff = qty - book;
            if (diff === 0) break;
            if (diff > 0) {
              await this.move(c, accountId, doc.warehouse_id, it.product_id, diff, null, 'inventory_surplus', docId, doc.employee_id);
              surplus++;
            } else {
              const b = (await c.query(`SELECT avg_cost FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
                [doc.warehouse_id, it.product_id])).rows[0];
              await this.move(c, accountId, doc.warehouse_id, it.product_id, diff, null, 'inventory_shortage', docId, doc.employee_id);
              shortage++;
              shortageSum += Math.abs(diff) * Number(b?.avg_cost ?? 0);
            }
            break;
          }
        }
      }

      await c.query(`UPDATE stock_doc SET status='done', processed_at=now() WHERE id=$1`, [docId]);
      return { ok: true, kind: doc.kind, items: items.length, surplus, shortage, shortageSum: Math.round(shortageSum * 100) / 100 };
    });
  }

  private async move(c: PoolClient, accountId: string, wh: string, product: string,
                     qty: number, price: number | null, reason: string, docId: string, employeeId: string | null) {
    await c.query(`SELECT * FROM apply_stock_move($1,$2,$3,$4,$5,$6::move_reason,$7,$8)`,
      [accountId, wh, product, qty, price, reason, docId, employeeId]);
  }

  /** Удаление — только в черновике (UMAG). Проведённый документ отменяется сторно. */
  async deleteDoc(accountId: string, docId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT status FROM stock_doc WHERE id=$1`, [docId])).rows[0];
      if (!doc) throw new BadRequestException('Документ не найден');
      if (doc.status === 'done') throw new BadRequestException('Проведённый документ удалить нельзя — сделайте сторно');
      await c.query(`UPDATE stock_doc SET status='deleted', deleted_at=now() WHERE id=$1`, [docId]);
      return { ok: true };
    });
  }

  /** Восстановление удалённого черновика (UMAG: возвращается в черновик). */
  async restoreDoc(accountId: string, docId: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE stock_doc SET status='draft', deleted_at=NULL WHERE id=$1 AND status='deleted'`, [docId]);
      return { ok: true };
    });
  }

  /**
   * Объединение черновиков (UMAG): считали втроём разными устройствами —
   * потом свели в один документ.
   */
  async mergeDrafts(accountId: string, docIds: string[]) {
    if (docIds.length < 2) throw new BadRequestException('Нужно минимум два черновика');
    return this.db.withTenant(accountId, async (c) => {
      const docs = (await c.query(
        `SELECT * FROM stock_doc WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY number`, [docIds])).rows;
      if (docs.length !== docIds.length) throw new BadRequestException('Не все документы найдены');
      if (docs.some((d: any) => d.status !== 'draft')) throw new BadRequestException('Объединять можно только черновики');
      if (new Set(docs.map((d: any) => d.kind)).size > 1) throw new BadRequestException('Документы разного вида');
      if (new Set(docs.map((d: any) => d.warehouse_id)).size > 1) throw new BadRequestException('Документы по разным складам');

      const target = docs[0];
      const rest = docs.slice(1);

      for (const d of rest) {
        // одинаковые товары суммируются; учётный остаток берём самый ранний
        await c.query(
          `INSERT INTO stock_doc_item (account_id, doc_id, product_id, qty, price, qty_book, book_at)
           SELECT account_id, $1, product_id, qty, price, qty_book, book_at FROM stock_doc_item WHERE doc_id=$2
           ON CONFLICT (doc_id, product_id) DO UPDATE
             SET qty = stock_doc_item.qty + EXCLUDED.qty,
                 qty_book = CASE WHEN EXCLUDED.book_at < stock_doc_item.book_at
                                 THEN EXCLUDED.qty_book ELSE stock_doc_item.qty_book END,
                 book_at = least(stock_doc_item.book_at, EXCLUDED.book_at)`,
          [target.id, d.id]);
        await c.query(`UPDATE stock_doc SET status='deleted', deleted_at=now() WHERE id=$1`, [d.id]);
      }

      const numbers = rest.map((d: any) => d.number);
      await c.query(
        `UPDATE stock_doc SET merged_from=$2, comment = coalesce(comment,'') || $3 WHERE id=$1`,
        [target.id, JSON.stringify(numbers), ` Объединены документы: ${numbers.join(', ')}.`]);
      await this.recalcTotal(c, target.id);
      return { docId: target.id, merged: numbers };
    });
  }

  // ==================================================================
  // ОТЧЁТЫ
  // ==================================================================
  async balance(accountId: string, opts: { warehouseId?: string; productId?: string; onlyNonZero?: boolean } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT b.warehouse_id, w.name AS warehouse, b.product_id, p.name, p.kind,
                b.qty, b.avg_cost, round(b.qty * b.avg_cost, 2) AS total_cost, p.min_stock
           FROM stock_balance b
           JOIN product p ON p.id = b.product_id
           JOIN warehouse w ON w.id = b.warehouse_id
          WHERE ($1::uuid IS NULL OR b.warehouse_id = $1)
            AND ($2::uuid IS NULL OR b.product_id = $2)
            AND ($3 = false OR b.qty <> 0)
            AND p.deleted_at IS NULL
          ORDER BY p.name`,
        [opts.warehouseId ?? null, opts.productId ?? null, opts.onlyNonZero ?? false]);
      return rows.map((r: any) => ({ ...r, qty: Number(r.qty), avg_cost: Number(r.avg_cost), total_cost: Number(r.total_cost) }));
    });
  }

  /** Критические остатки (UMAG) = неснижаемый остаток (МС). */
  async lowStock(accountId: string, warehouseId?: string) {
    const { rows } = await this.db.raw(`SELECT * FROM low_stock($1,$2)`, [accountId, warehouseId ?? null]);
    return rows.map((r: any) => ({
      productId: r.product_id, name: r.name, warehouseId: r.warehouse_id,
      qty: Number(r.qty), minStock: Number(r.min_stock), deficit: Number(r.deficit),
    }));
  }

  /** Отчёт по инвентаризации: недостача и излишки (модель UMAG). */
  async inventoryReport(accountId: string, docId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT i.product_id, p.name, i.qty_book AS book, i.qty AS fact, (i.qty - i.qty_book) AS diff,
                coalesce(b.avg_cost, p.purchase_price, 0) AS cost,
                round((i.qty - i.qty_book) * coalesce(b.avg_cost, p.purchase_price, 0), 2) AS diff_sum
           FROM stock_doc_item i
           JOIN product p ON p.id = i.product_id
           LEFT JOIN stock_balance b ON b.product_id = i.product_id
            AND b.warehouse_id = (SELECT warehouse_id FROM stock_doc WHERE id = $1)
          WHERE i.doc_id = $1 ORDER BY (i.qty - i.qty_book)`, [docId]);

      const shortage = rows.filter((r: any) => Number(r.diff) < 0);
      const surplus = rows.filter((r: any) => Number(r.diff) > 0);
      return {
        items: rows,
        shortageCount: shortage.length,
        shortageSum: Math.round(shortage.reduce((s: number, r: any) => s + Math.abs(Number(r.diff_sum)), 0) * 100) / 100,
        surplusCount: surplus.length,
        surplusQty: surplus.reduce((s: number, r: any) => s + Number(r.diff), 0),
        matched: rows.length - shortage.length - surplus.length,
      };
    });
  }

  /**
   * Список документов. Удалённые по умолчанию скрыты, но их можно
   * показать: у UMAG удалённый документ не исчезает навсегда, его видно
   * и можно вернуть. Владельцу это важнее аккуратного списка — удалить
   * по ошибке приёмку на полмиллиона и потерять её насовсем недопустимо.
   *
   * Поиск по комментарию (q): комментарий у документа был всегда, но
   * искать по нему было нельзя — а владельцы пишут туда самое важное
   * («вернуть поставщику», «пересчитать с Маратом»).
   */
  async docs(accountId: string, kind?: DocKind, status?: string,
             opts?: { includeDeleted?: boolean; q?: string }) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT d.id, d.kind, d.number, d.status, d.comment, d.total_sum, d.created_at, d.processed_at,
                d.deleted_at,
                w.name AS warehouse, e.first_name AS employee,
                (SELECT count(*) FROM stock_doc_item i WHERE i.doc_id = d.id) AS items
           FROM stock_doc d
           LEFT JOIN warehouse w ON w.id = d.warehouse_id
           LEFT JOIN employee e ON e.id = d.employee_id
          WHERE ($1::text IS NULL OR d.kind::text = $1) AND ($2::text IS NULL OR d.status::text = $2)
            AND ($3::boolean IS TRUE OR d.deleted_at IS NULL)
            AND ($4::text IS NULL OR d.comment ILIKE '%' || $4 || '%' OR d.number::text ILIKE '%' || $4 || '%')
          ORDER BY d.created_at DESC LIMIT 100`,
        [kind ?? null, status ?? null, opts?.includeDeleted ?? false, opts?.q ?? null])).rows);
  }

  /** Комментарий можно поправить у любого документа, включая проведённый:
   *  это заметка владельца, а не часть учёта, и она не меняет цифры. */
  async setComment(accountId: string, docId: string, comment: string) {
    return this.db.withTenant(accountId, async (c) => {
      const r = await c.query(
        `UPDATE stock_doc SET comment=$2 WHERE id=$1 RETURNING id, comment`, [docId, comment || null]);
      if (!r.rows[0]) throw new BadRequestException('Документ не найден');
      return r.rows[0];
    });
  }

  // ==================================================================
  // 3.6 РЕЖИМЫ ИНВЕНТАРИЗАЦИИ
  // ==================================================================

  /**
   * Сканер-режим (способ №2 у UMAG: «пройдите сканером по товарам —
   * они автоматически добавятся в таблицу»).
   * Принимает штрихкод, а не идентификатор товара: кассир не знает никаких
   * идентификаторов, у него в руках сканер.
   * Понимает штрихкод упаковки (блок = 10 пачек) и весовой штрихкод.
   */
  async scanInto(accountId: string, docId: string, barcode: string, qtyOverride?: number) {
    const found = await this.goods.scan(accountId, barcode);
    if (!found?.found || !found.product?.id)
      throw new BadRequestException(`Штрихкод ${barcode} не найден в номенклатуре`);

    // у весового штрихкода вес зашит внутрь, у упаковки — количество в ней
    const qty = qtyOverride ?? Number(found.qty ?? 1);
    const item = await this.addItem(accountId, docId, { productId: found.product.id, qty });
    return {
      product: { id: found.product.id, name: found.product.name },
      added: qty, source: found.source, total: Number(item.qty),
    };
  }

  /**
   * Частичная инвентаризация (UMAG: «если товаров много, можно разбить их на
   * несколько документов — по дате, месту хранения, типу товаров, далее их
   * можно будет объединить»).
   * Берём срез номенклатуры и заполняем учётными остатками; кассир правит факт.
   */
  async startPartialInventory(accountId: string, dto: {
    warehouseId?: string; storeId?: string; categoryId?: string; employeeId?: string;
    blind?: boolean; comment?: string;
  }) {
    const doc = await this.createDoc(accountId, {
      kind: 'inventory', warehouseId: dto.warehouseId, storeId: dto.storeId,
      employeeId: dto.employeeId, blind: dto.blind ?? true,
      comment: dto.comment ?? (dto.categoryId ? 'Частичная инвентаризация по категории' : 'Инвентаризация'),
    });
    const r = await this.addMissingAsZero(accountId, doc.id, { categoryId: dto.categoryId });
    return { docId: doc.id, number: doc.number, products: r.added, blind: doc.blind };
  }

  /**
   * Слепой пересчёт: кассиру не показываем учётный остаток, пока он не введёт
   * факт. Иначе человек видит «10» и пишет «10», не считая. Ни у одного из
   * троих этого нет — а без этого инвентаризация превращается в переписывание
   * учётных цифр.
   */
  async countingList(accountId: string, docId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT * FROM stock_doc WHERE id=$1`, [docId])).rows[0];
      if (!doc) throw new BadRequestException('Документ не найден');
      const { rows } = await c.query(
        `SELECT i.product_id, p.name, i.qty AS fact, i.qty_book, i.book_at
           FROM stock_doc_item i JOIN product p ON p.id = i.product_id
          WHERE i.doc_id = $1 ORDER BY p.name`, [docId]);
      return rows.map((r: any) => ({
        productId: r.product_id, name: r.name, fact: Number(r.fact),
        // в слепом режиме учётный остаток скрыт
        book: doc.blind ? null : Number(r.qty_book ?? 0),
        countedAt: r.book_at,
      }));
    });
  }

  // ==================================================================
  // 3.7 УВЕДОМЛЕНИЯ И ПОПОЛНЕНИЕ
  // ==================================================================

  /**
   * План пополнения (модель МС «Пополнить резервы»): сколько докупить.
   * Плюс подсказка, которой у МС нет прямо в списке: если товар лежит с
   * избытком на другом складе, закупать не нужно — достаточно перемещения.
   */
  async replenishmentPlan(accountId: string, warehouseId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM replenishment_plan($1,$2)`, [accountId, warehouseId]);
    return rows.map((r: any) => ({
      productId: r.product_id, name: r.name,
      qty: Number(r.qty), minStock: Number(r.min_stock), toOrder: Number(r.to_order),
      availableElsewhere: Number(r.available_elsewhere ?? 0),
      otherWarehouseId: r.other_warehouse,
      action: Number(r.available_elsewhere ?? 0) >= Number(r.to_order) ? 'transfer' : 'purchase',
    }));
  }

  /** Черновик перемещения по плану пополнения — из склада, где есть излишек. */
  async createReplenishmentTransfer(accountId: string, toWarehouseId: string, employeeId?: string) {
    const plan = await this.replenishmentPlan(accountId, toWarehouseId);
    const movable = plan.filter((p: any) => p.action === 'transfer' && p.otherWarehouseId);
    if (!movable.length) return { created: false, reason: 'Нечего перемещать — товара нет с избытком на других складах' };

    const from = movable[0].otherWarehouseId;
    const sameSource = movable.filter((p: any) => p.otherWarehouseId === from);
    const doc = await this.createDoc(accountId, {
      kind: 'transfer', warehouseId: from, warehouseToId: toWarehouseId,
      employeeId, comment: 'Пополнение до неснижаемого остатка',
    });
    for (const p of sameSource) await this.addItem(accountId, doc.id, { productId: p.productId, qty: p.toOrder });
    return { created: true, docId: doc.id, number: doc.number, items: sameSource.length };
  }

  /**
   * Сборка уведомления о критических остатках.
   * UMAG шлёт письмо каждое утро в 9:00 — одно и то же, пока товар не заказали.
   * Мы шлём, когда список изменился; иначе — не чаще, чем раз в repeat_days.
   */
  async buildLowStockNotification(accountId: string, employeeId: string) {
    await this.db.raw(`SELECT ensure_notify_settings($1,$2)`, [accountId, employeeId]);
    const { rows } = await this.db.raw(`SELECT * FROM build_low_stock_notification($1,$2)`, [accountId, employeeId]);
    return { created: rows[0].created, reason: rows[0].reason, items: rows[0].items };
  }

  async notifications(accountId: string, employeeId?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, kind, title, body, link, created_at, read_at FROM notification
          WHERE ($1::uuid IS NULL OR employee_id = $1 OR employee_id IS NULL)
          ORDER BY created_at DESC LIMIT 50`, [employeeId ?? null])).rows);
  }
}
