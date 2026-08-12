import { Injectable, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { SyncService } from '../sync/sync.service';
import { GoodsService } from '../goods/goods.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

/**
 * КАССА.
 *
 * Главное решение: чек считается на кассе целиком, включая себестоимость.
 * Сервер принимает факт, а не пересчитывает. После суток офлайна пересчёт
 * на сервере дал бы другие цифры: цену в кабинете могли поменять, а
 * покупатель платил по той, что была на кассе в момент продажи.
 *
 * Отменённые товары — контроль UMAG: кассир пробил товар, покупатель дал
 * наличные, кассир отменил позицию и забрал деньги. Без журнала это невидимо.
 *
 * Округление — модель Wipon (единственный, кто это документирует): два типа,
 * до 1 или 5 тенге. В Казахстане мелочь вышла из обихода.
 */

export type PayMethod = 'cash' | 'card' | 'qr' | 'credit' | 'bonus';

export interface PaymentInput { method: PayMethod; amount: number; received?: number; ref?: string; approvedBy?: string; }

@Injectable()
export class PosService {
  constructor(private db: DbService, private goods: GoodsService, private sync?: SyncService,
              private loyalty?: LoyaltyService) {
    // Регистрируем обработчики офлайн-событий кассы. В 1.3 карта сущностей была
    // заготовкой с пометкой «Части 2–4 дописывают сюда sale» — вот это дописывание.
    if (sync) {
      sync.registerHandler('shift', (c, a, e, ctx) => this.applyOfflineShift(c, a, e, ctx));
      sync.registerHandler('sale', (c, a, e, ctx) => this.applyOfflineSale(c, a, e, ctx));
      sync.registerHandler('cancelled_item', (c, a, e, ctx) => this.applyOfflineCancel(c, a, e, ctx));
      sync.registerHandler('cash_operation', (c, a, e, ctx) => this.applyOfflineCashOp(c, a, e, ctx));
      sync.registerHandler('debt_payment', (c, a, e, ctx) => this.applyOfflineDebtPayment(c, a, e, ctx));
      sync.registerHandler('customer', (c, a, e, ctx) => this.applyOfflineNewCustomer(c, a, e));
    }
  }

  // ==================================================================
  // 4.6 СМЕНЫ
  // ==================================================================
  async openShift(accountId: string, dto: { cashRegisterId: string; employeeId: string; openingFloat?: number; offline?: boolean; deviceId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const open = (await c.query(`SELECT id, number FROM shift WHERE cash_register_id=$1 AND status='open'`, [dto.cashRegisterId])).rows[0];
      if (open) throw new BadRequestException(`Смена №${open.number} уже открыта — закройте её`);

      const reg = (await c.query(`SELECT store_id, warehouse_id FROM cash_register WHERE id=$1`, [dto.cashRegisterId])).rows[0];
      if (!reg) throw new BadRequestException('Касса не найдена');

      const num = (await c.query(`SELECT next_shift_number($1,$2) AS n`, [accountId, dto.cashRegisterId])).rows[0].n;
      const { rows } = await c.query(
        `INSERT INTO shift (account_id, cash_register_id, store_id, number, opened_by, opening_float, offline_opened, device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [accountId, dto.cashRegisterId, reg.store_id, num, dto.employeeId, dto.openingFloat ?? 0, dto.offline ?? false, dto.deviceId ?? null]);

      if (dto.openingFloat) {
        await c.query(
          `INSERT INTO cash_operation (account_id, shift_id, cash_register_id, kind, amount, comment, employee_id)
           VALUES ($1,$2,$3,'opening_float',$4,'Размен на начало смены',$5)`,
          [accountId, rows[0].id, dto.cashRegisterId, dto.openingFloat, dto.employeeId]);
      }
      return rows[0];
    });
  }

  /** X-отчёт: сколько в кассе сейчас, без закрытия смены. */
  async xReport(accountId: string, shiftId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM shift_totals($1,$2)`, [accountId, shiftId]);
    const t = rows[0];
    if (!t) throw new BadRequestException('Смена не найдена');
    return {
      receipts: t.receipts, cash: Number(t.cash), card: Number(t.card), qr: Number(t.qr),
      credit: Number(t.credit), returns: Number(t.returns_sum),
      deposits: Number(t.deposits), withdrawals: Number(t.withdrawals),
      openingFloat: Number(t.opening_float),
      expectedCash: Number(t.expected_cash),
      revenue: Number(t.revenue), profit: Number(t.profit),
    };
  }

  /**
   * Z-отчёт и закрытие. Расхождение факта и расчёта требует комментария:
   * не «недостача 3000, ну ладно», а «недостача 3000, объясни».
   */
  async closeShift(accountId: string, shiftId: string, dto: { employeeId: string; actualCash: number; comment?: string }) {
    const totals = await this.xReport(accountId, shiftId);
    const discrepancy = Math.round((dto.actualCash - totals.expectedCash) * 100) / 100;

    if (Math.abs(discrepancy) >= 1 && !dto.comment)
      throw new BadRequestException(
        `Расхождение ${discrepancy > 0 ? 'излишек' : 'недостача'} ${Math.abs(discrepancy)} ₸ — нужен комментарий`);

    return this.db.withTenant(accountId, async (c) => {
      const parked = (await c.query(`SELECT count(*)::int n FROM sale WHERE shift_id=$1 AND status='parked'`, [shiftId])).rows[0].n;
      if (parked > 0) throw new BadRequestException(`Есть ${parked} отложенных чеков — оформите или удалите их (отложить можно только до конца смены)`);

      const { rows } = await c.query(
        `UPDATE shift SET status='closed', closed_at=now(), closed_by=$2,
                cash_sales=$3, card_sales=$4, qr_sales=$5, credit_sales=$6, returns_sum=$7,
                deposits=$8, withdrawals=$9, expected_cash=$10, actual_cash=$11,
                discrepancy=$12, discrepancy_comment=$13, receipts_count=$14
          WHERE id=$1 AND status='open' RETURNING *`,
        [shiftId, dto.employeeId, totals.cash, totals.card, totals.qr, totals.credit, totals.returns,
         totals.deposits, totals.withdrawals, totals.expectedCash, dto.actualCash,
         discrepancy, dto.comment ?? null, totals.receipts]);
      if (!rows[0]) throw new BadRequestException('Смена уже закрыта');
      return { ...totals, actualCash: dto.actualCash, discrepancy, shift: rows[0] };
    });
  }

  /** Внесение и изъятие (размен утром, выемка выручки вечером). */
  async cashOperation(accountId: string, dto: { shiftId: string; kind: 'deposit' | 'withdrawal' | 'collection'; amount: number; comment?: string; employeeId: string; approvedBy?: string }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const sh = (await c.query(`SELECT id, cash_register_id, status FROM shift WHERE id=$1`, [dto.shiftId])).rows[0];
      if (!sh) throw new BadRequestException('Смена не найдена');
      if (sh.status !== 'open') throw new BadRequestException('Смена закрыта');

      if (dto.kind !== 'deposit') {
        const t = await this.xReport(accountId, dto.shiftId);
        if (dto.amount > t.expectedCash)
          throw new BadRequestException(`В кассе ${t.expectedCash} ₸ — изъять ${dto.amount} ₸ нельзя`);
      }
      const { rows } = await c.query(
        `INSERT INTO cash_operation (account_id, shift_id, cash_register_id, kind, amount, comment, employee_id, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [accountId, dto.shiftId, sh.cash_register_id, dto.kind, dto.amount, dto.comment ?? null, dto.employeeId, dto.approvedBy ?? null]);
      return rows[0];
    });
  }

  // ==================================================================
  // 4.1 ЭКРАН ПРОДАЖИ
  // ==================================================================
  async newSale(accountId: string, dto: { shiftId: string; employeeId: string; consultantId?: string; customerId?: string; offline?: boolean; deviceId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const sh = (await c.query(`SELECT * FROM shift WHERE id=$1 AND status='open'`, [dto.shiftId])).rows[0];
      if (!sh) throw new BadRequestException('Нет открытой смены');
      const reg = (await c.query(`SELECT store_id, warehouse_id FROM cash_register WHERE id=$1`, [sh.cash_register_id])).rows[0];
      const { rows } = await c.query(
        `INSERT INTO sale (account_id, shift_id, cash_register_id, store_id, warehouse_id, employee_id,
                           consultant_id, customer_id, status, offline_created, device_id, local_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11) RETURNING *`,
        [accountId, dto.shiftId, sh.cash_register_id, reg?.store_id, reg?.warehouse_id, dto.employeeId,
         dto.consultantId ?? null, dto.customerId ?? null, dto.offline ?? false, dto.deviceId ?? null,
         // локальный номер сквозной и вечный — у Wipon он живёт «в рамках сессии» и теряется при переустановке
         `${sh.number}-${Date.now()}`]);
      return rows[0];
    });
  }

  /** Добавление позиции: сканером, поиском или из быстрых товаров. */
  async addToCart(accountId: string, saleId: string, dto: { productId?: string; barcode?: string; qty?: number }) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = await this.getEditableSale(c, saleId);

      let productId = dto.productId;
      let qty = dto.qty ?? 1;

      if (dto.barcode) {
        const f = await this.goods.scan(accountId, dto.barcode);
        if (!f?.found || !f.product?.id) throw new BadRequestException(`Штрихкод ${dto.barcode} не найден`);
        productId = f.product.id;
        qty = dto.qty ?? Number(f.qty ?? 1);      // весовой штрихкод несёт вес, упаковка — количество
      }
      if (!productId) throw new BadRequestException('Не указан товар');

      const p = (await c.query(
        `SELECT p.*, (SELECT code FROM barcode b WHERE b.product_id=p.id AND b.is_primary LIMIT 1) AS bc
           FROM product p WHERE p.id=$1 AND p.deleted_at IS NULL`, [productId])).rows[0];
      if (!p) throw new BadRequestException('Товар не найден');
      if (p.archived_at) throw new BadRequestException(`«${p.name}» в архиве — продавать нельзя`);

      const price = await this.priceOf(c, productId, sale.store_id);
      if (price == null) throw new BadRequestException(`У «${p.name}» не указана цена`);

      const cost = p.track_stock
        ? Number((await c.query(`SELECT avg_cost FROM stock_balance WHERE warehouse_id=$1 AND product_id=$2`,
            [sale.warehouse_id, productId])).rows[0]?.avg_cost ?? p.purchase_price ?? 0)
        : 0;

      const exists = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1 AND product_id=$2 AND discount_sum=0`, [saleId, productId])).rows[0];
      if (exists) {
        const newQty = Number(exists.qty) + qty;
        await c.query(`UPDATE sale_item SET qty=$2::numeric, total=round($2::numeric*price,2) WHERE id=$1`, [exists.id, newQty]);
      } else {
        await c.query(
          `INSERT INTO sale_item (account_id, sale_id, product_id, qty, price, total, cost, vat_rate, ntin)
           VALUES ($1,$2,$3,$4::numeric,$5::numeric,round($4::numeric*$5::numeric,2),$6,$7,$8)`,
          [accountId, saleId, productId, qty, price, cost, p.vat_rate ?? 12, p.ntin]);
      }
      await this.applyAutoDiscounts(c, accountId, saleId);
      return this.recalc(c, accountId, saleId);
    });
  }

  /**
   * Отмена позиции — с записью в журнал (контроль UMAG).
   * Формат UMAG: «100→98» — добавили 100, отменили 98.
   */
  async cancelItem(accountId: string, saleId: string, productId: string, qty?: number, approvedBy?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = await this.getEditableSale(c, saleId);
      const item = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1 AND product_id=$2`, [saleId, productId])).rows[0];
      if (!item) throw new BadRequestException('Позиции нет в чеке');

      const cancelQty = qty ?? Number(item.qty);
      if (cancelQty > Number(item.qty)) throw new BadRequestException('Отменяется больше, чем в чеке');

      await c.query(
        `INSERT INTO cancelled_item (account_id, sale_id, cash_register_id, shift_id, employee_id,
                                     product_id, qty_added, qty_cancelled, price, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [accountId, saleId, sale.cash_register_id, sale.shift_id, sale.employee_id,
         productId, item.qty, cancelQty, item.price, approvedBy ?? null]);

      if (cancelQty >= Number(item.qty)) await c.query(`DELETE FROM sale_item WHERE id=$1`, [item.id]);
      else await c.query(`UPDATE sale_item SET qty=qty-$2::numeric, total=round((qty-$2::numeric)*price,2) WHERE id=$1`, [item.id, cancelQty]);

      return this.recalc(c, accountId, saleId);
    });
  }

  private async getEditableSale(c: PoolClient, saleId: string) {
    const s = (await c.query(`SELECT * FROM sale WHERE id=$1`, [saleId])).rows[0];
    if (!s) throw new BadRequestException('Чек не найден');
    if (s.status === 'completed') throw new BadRequestException('Чек уже пробит');
    if (s.status === 'cancelled') throw new BadRequestException('Чек отменён');
    return s;
  }

  private async priceOf(c: PoolClient, productId: string, storeId: string | null) {
    const r = (await c.query(
      `SELECT pp.value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
        WHERE pp.product_id=$1 AND pt.code='retail' AND (pp.store_id=$2 OR pp.store_id IS NULL)
        ORDER BY pp.store_id NULLS LAST LIMIT 1`, [productId, storeId])).rows[0];
    return r ? Number(r.value) : null;
  }

  // ==================================================================
  // 4.2 СКИДКИ (модель Wipon: товар/чек, %/сумма, авто/ручные)
  // ==================================================================
  private async applyAutoDiscounts(c: PoolClient, accountId: string, saleId: string) {
    const items = (await c.query(
      `SELECT i.*, p.category_id FROM sale_item i JOIN product p ON p.id=i.product_id WHERE i.sale_id=$1`, [saleId])).rows;
    const subtotal = items.reduce((s: number, i: any) => s + Number(i.qty) * Number(i.price), 0);

    const discounts = (await c.query(
      `SELECT * FROM discount WHERE is_active AND auto_apply
         AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at >= now())`)).rows;

    for (const it of items) {
      const d = discounts.find((x: any) =>
        (x.scope === 'product' && x.product_id === it.product_id) ||
        (x.scope === 'category' && x.category_id && x.category_id === it.category_id));
      if (!d) continue;
      const line = Number(it.qty) * Number(it.price);
      const sum = d.percent != null ? Math.round(line * Number(d.percent)) / 100 : Number(d.amount) * Number(it.qty);
      await c.query(`UPDATE sale_item SET discount_percent=$2::numeric, discount_sum=$3::numeric, total=round($4::numeric-$3::numeric,2) WHERE id=$1`,
        [it.id, d.percent ?? 0, Math.min(sum, line), line]);
    }

    const receiptD = discounts.find((x: any) => x.scope === 'receipt' && (x.min_sum == null || subtotal >= Number(x.min_sum)));
    if (receiptD) await this.setReceiptDiscount(c, accountId, saleId, receiptD.percent, receiptD.amount, true);
  }

  /** Ручная скидка: с пределом из разрешений кассы и защитой минимальной цены. */
  async setDiscount(accountId: string, saleId: string, dto: { percent?: number; amount?: number; productId?: string; employeeId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = await this.getEditableSale(c, saleId);
      const prof = (await c.query(
        `SELECT pp.max_manual_discount FROM pos_profile pp JOIN store s ON s.pos_profile_id = pp.id WHERE s.id=$1`,
        [sale.store_id])).rows[0];
      const limit = Number(prof?.max_manual_discount ?? 10);
      if (dto.percent != null && dto.percent > limit)
        throw new BadRequestException(`Скидка больше ${limit}% — нужно разрешение старшего`);

      if (dto.productId) {
        const it = (await c.query(
          `SELECT i.*, p.min_price, p.name FROM sale_item i JOIN product p ON p.id=i.product_id
            WHERE i.sale_id=$1 AND i.product_id=$2`, [saleId, dto.productId])).rows[0];
        if (!it) throw new BadRequestException('Позиции нет в чеке');
        const line = Number(it.qty) * Number(it.price);
        const sum = dto.percent != null ? Math.round(line * dto.percent) / 100 : Number(dto.amount);
        const newPrice = (line - sum) / Number(it.qty);
        // защита из Части 2: ниже минимальной цены не продаём даже «по доброте»
        if (it.min_price != null && newPrice < Number(it.min_price))
          throw new BadRequestException(`Со скидкой цена «${it.name}» станет ${Math.round(newPrice)} ₸ — это ниже минимальной ${it.min_price} ₸`);
        await c.query(`UPDATE sale_item SET discount_percent=$2::numeric, discount_sum=$3::numeric, total=round($4::numeric-$3::numeric,2) WHERE id=$1`,
          [it.id, dto.percent ?? 0, sum, line]);
      } else {
        await this.setReceiptDiscount(c, accountId, saleId, dto.percent, dto.amount, false);
      }
      return this.recalc(c, accountId, saleId);
    });
  }

  private async setReceiptDiscount(c: PoolClient, accountId: string, saleId: string, percent?: number, amount?: number, auto = false) {
    const items = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1`, [saleId])).rows;
    const subtotal = items.reduce((s: number, i: any) => s + Number(i.qty) * Number(i.price), 0);
    if (!subtotal) return;
    const total = percent != null ? Math.round(subtotal * percent) / 100 : Number(amount ?? 0);

    // скидка на чек раскидывается по позициям пропорционально — иначе возврат
    // одной позиции нельзя посчитать честно
    for (const it of items) {
      const line = Number(it.qty) * Number(it.price);
      const share = Math.round(total * (line / subtotal) * 100) / 100;
      await c.query(`UPDATE sale_item SET discount_sum=$2::numeric, total=round($3::numeric-$2::numeric,2) WHERE id=$1`, [it.id, share, line]);
    }
  }

  /** Пересчёт чека: суммы, округление, себестоимость, прибыль. */
  private async recalc(c: PoolClient, accountId: string, saleId: string) {
    const sale = (await c.query(`SELECT * FROM sale WHERE id=$1`, [saleId])).rows[0];
    const items = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1`, [saleId])).rows;

    const prof = (await c.query(
      `SELECT pp.round_mode, pp.round_to FROM pos_profile pp JOIN store s ON s.pos_profile_id=pp.id WHERE s.id=$1`,
      [sale.store_id])).rows[0] ?? { round_mode: 'total', round_to: 1 };

    let subtotal = 0, discount = 0, total = 0, cost = 0;
    for (const i of items) {
      const line = Number(i.qty) * Number(i.price);
      let lineTotal = line - Number(i.discount_sum);
      // построчное округление (второй тип у Wipon): нет расхождения строк с итогом
      if (prof.round_mode === 'line_and_total') {
        const r = (await c.query(`SELECT round_money($1,$2,true) AS v`, [lineTotal, prof.round_to])).rows[0].v;
        lineTotal = Number(r);
        await c.query(`UPDATE sale_item SET total=$2 WHERE id=$1`, [i.id, lineTotal]);
      }
      subtotal += line; discount += Number(i.discount_sum); total += lineTotal;
      cost += Number(i.qty) * Number(i.cost);
    }

    let rounded = total;
    if (prof.round_mode !== 'none') {
      rounded = Number((await c.query(`SELECT round_money($1,$2,true) AS v`, [total, prof.round_to])).rows[0].v);
    }
    const rounding = Math.round((rounded - total) * 100) / 100;

    const { rows } = await c.query(
      `UPDATE sale SET subtotal=$2, discount_sum=$3, rounding=$4, total=$5, cost_total=$6, profit=$7 WHERE id=$1 RETURNING *`,
      [saleId, Math.round(subtotal * 100) / 100, Math.round(discount * 100) / 100, rounding,
       rounded, Math.round(cost * 100) / 100, Math.round((rounded - cost) * 100) / 100]);
    return rows[0];
  }

  // ==================================================================
  // 4.3 ОПЛАТА
  // ==================================================================
  async pay(accountId: string, saleId: string, payments: PaymentInput[]) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = await this.getEditableSale(c, saleId);
      const items = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1`, [saleId])).rows;
      if (!items.length) throw new BadRequestException('Чек пустой');

      const fresh = await this.recalc(c, accountId, saleId);
      const total = Number(fresh.total);
      const paid = payments.reduce((s, p) => s + Number(p.amount), 0);

      if (Math.round((paid - total) * 100) / 100 < 0)
        throw new BadRequestException(`Не хватает ${Math.round((total - paid) * 100) / 100} ₸`);

      // в долг — только при выбранном покупателе (правило Wipon)
      if (payments.some((p) => p.method === 'credit') && !sale.customer_id)
        throw new BadRequestException('Продажа в долг возможна только с выбранным покупателем');

      // бонусами — тоже: бонусы принадлежат конкретному человеку
      if (payments.some((p) => p.method === 'bonus') && !sale.customer_id)
        throw new BadRequestException('Оплата бонусами возможна только с выбранным покупателем');

      const sums: Record<string, number> = { cash: 0, card: 0, qr: 0, credit: 0, bonus: 0 };
      let change = 0;
      for (const p of payments) {
        sums[p.method] += Number(p.amount);
        const received = p.method === 'cash' ? Number(p.received ?? p.amount) : null;
        const ch = p.method === 'cash' && received != null ? Math.max(0, received - Number(p.amount)) : 0;
        change += ch;
        await c.query(
          `INSERT INTO sale_payment (account_id, sale_id, method, amount, received, change_given, terminal_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [accountId, saleId, p.method, p.amount, received, ch || null, p.ref ?? null]);
      }

      const num = (await c.query(`SELECT next_sale_number($1,$2) AS n`, [accountId, sale.cash_register_id])).rows[0].n;

      // списываем товар: остаток — это сумма движений (принцип из 1.3)
      for (const it of items) {
        const p = (await c.query(`SELECT track_stock, kind, bundle_mode FROM product WHERE id=$1`, [it.product_id])).rows[0];
        // ТЕХКАРТА (часть 35): готовое блюдо-рецепт списывает ИНГРЕДИЕНТЫ, не себя.
        // Кофе = зёрна + молоко + стакан; сам «кофе» остатка не ведёт.
        if (p.kind === 'bundle' && p.bundle_mode === 'recipe') {
          const comps = (await c.query(
            `SELECT bi.component_id, bi.qty, pr.track_stock, pr.recipe_yield
               FROM bundle_item bi JOIN product pr ON pr.id = bi.component_id
              WHERE bi.bundle_id=$1`, [it.product_id])).rows;
          const y = (await c.query(`SELECT recipe_yield FROM product WHERE id=$1`, [it.product_id])).rows[0].recipe_yield;
          for (const comp of comps) {
            const cp = (await c.query(`SELECT track_stock FROM product WHERE id=$1`, [comp.component_id])).rows[0];
            if (!cp?.track_stock) continue;
            // на 1 порцию блюда: qty ингредиента / выход рецепта
            const perUnit = Number(comp.qty) / Math.max(Number(y), 1);
            await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,'sale',NULL,$5)`,
              [accountId, sale.warehouse_id, comp.component_id, -(perUnit * Number(it.qty)), sale.employee_id]);
          }
          continue;
        }
        if (!p.track_stock) continue;
        await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,'sale',NULL,$5)`,
          [accountId, sale.warehouse_id, it.product_id, -Number(it.qty), sale.employee_id]);
      }

      const { rows } = await c.query(
        `UPDATE sale SET status='completed', completed_at=now(), number=$2,
                paid_cash=$3, paid_card=$4, paid_qr=$5, paid_credit=$6, paid_bonus=$8, change_given=$7, parked_at=NULL
          WHERE id=$1 RETURNING *`,
        [saleId, num, sums.cash, sums.card, sums.qr, sums.credit, change, sums.bonus]);

      // долг в книгу, бонусы списать/начислить — единый помощник части 17.
      // Онлайн offline:false — сервер вправе отказать (лимит долга, нехватка
      // бонусов) ДО того, как чек уйдёт в печать.
      await this.applyCustomerEffects(c, accountId, {
        saleId, customerId: sale.customer_id ?? null,
        employeeId: sale.employee_id ?? null, shiftId: sale.shift_id ?? null,
        credit: sums.credit, bonus: sums.bonus,
        approvedBy: (payments.find((pp: any) => pp.approvedBy)?.approvedBy) ?? null,
        offline: false,
      });
      return { ...rows[0], change };
    });
  }

  // ==================================================================
  // 4.4 ВОЗВРАТЫ
  // ==================================================================
  async refund(accountId: string, dto: {
    saleId: string; shiftId: string; employeeId: string;
    items?: { productId: string; qty: number }[]; approvedBy?: string; comment?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const orig = (await c.query(`SELECT * FROM sale WHERE id=$1 AND status='completed'`, [dto.saleId])).rows[0];
      if (!orig) throw new BadRequestException('Чек не найден или не пробит');
      if (orig.return_of_id) throw new BadRequestException('Нельзя вернуть возврат');

      const origItems = (await c.query(`SELECT * FROM sale_item WHERE sale_id=$1`, [dto.saleId])).rows;
      const toReturn = dto.items ?? origItems.map((i: any) => ({ productId: i.product_id, qty: Number(i.qty) - Number(i.returned_qty) }));

      const ref = (await c.query(
        `INSERT INTO sale (account_id, shift_id, cash_register_id, store_id, warehouse_id, employee_id,
                           customer_id, consultant_id, status, return_of_id, comment, local_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11) RETURNING *`,
        [accountId, dto.shiftId, orig.cash_register_id, orig.store_id, orig.warehouse_id, dto.employeeId,
         orig.customer_id, orig.consultant_id, dto.saleId, dto.comment ?? null, `R-${Date.now()}`])).rows[0];

      let total = 0, cost = 0;
      for (const r of toReturn) {
        if (r.qty <= 0) continue;
        const oi = origItems.find((i: any) => i.product_id === r.productId);
        if (!oi) throw new BadRequestException('Такого товара не было в чеке');
        const left = Number(oi.qty) - Number(oi.returned_qty);
        if (r.qty > left) throw new BadRequestException(`По «${r.productId}» уже возвращено; осталось ${left}`);

        // возвращаем по цене чека со скидкой — иначе покупатель получит больше, чем платил
        const unit = Number(oi.total) / Number(oi.qty);
        const sum = Math.round(unit * r.qty * 100) / 100;
        await c.query(
          `INSERT INTO sale_item (account_id, sale_id, product_id, qty, price, total, cost, vat_rate, ntin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [accountId, ref.id, r.productId, r.qty, oi.price, sum, oi.cost, oi.vat_rate, oi.ntin]);
        await c.query(`UPDATE sale_item SET returned_qty=returned_qty+$2 WHERE id=$1`, [oi.id, r.qty]);

        const p = (await c.query(`SELECT track_stock FROM product WHERE id=$1`, [r.productId])).rows[0];
        if (p.track_stock)
          await c.query(`SELECT apply_stock_move($1,$2,$3,$4,$5,'sale_return',NULL,$6)`,
            [accountId, orig.warehouse_id, r.productId, r.qty, Number(oi.cost), dto.employeeId]);

        total += sum; cost += Number(oi.cost) * r.qty;
      }
      if (total === 0) throw new BadRequestException('Нечего возвращать');

      const num = (await c.query(`SELECT next_sale_number($1,$2) AS n`, [accountId, orig.cash_register_id])).rows[0].n;
      const { rows } = await c.query(
        `UPDATE sale SET status='completed', completed_at=now(), number=$2, total=$3, subtotal=$3,
                cost_total=$4, profit=$5, paid_cash=$3 WHERE id=$1 RETURNING *`,
        [ref.id, num, Math.round(total * 100) / 100, Math.round(cost * 100) / 100, Math.round((total - cost) * 100) / 100]);

      // помечаем исходный чек, если вернули всё
      const rest = (await c.query(
        `SELECT sum(qty - returned_qty) AS left FROM sale_item WHERE sale_id=$1`, [dto.saleId])).rows[0];
      if (Number(rest.left) === 0) await c.query(`UPDATE sale SET status='returned' WHERE id=$1`, [dto.saleId]);

      // бонусы: отозвать начисленное за исходный чек, вернуть потраченное —
      // иначе возврат превращается в станок для печати бонусов (часть 10)
      if (this.loyalty) await this.loyalty.handleRefundTx(c, accountId, ref.id, dto.saleId);

      return rows[0];
    });
  }

  // ==================================================================
  // 4.5 ОТЛОЖЕННЫЕ ЧЕКИ (модель МС: до конца смены, лимит 100)
  // ==================================================================
  async park(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = await this.getEditableSale(c, saleId);
      const items = (await c.query(`SELECT count(*)::int n FROM sale_item WHERE sale_id=$1`, [saleId])).rows[0].n;
      if (!items) throw new BadRequestException('Пустой чек откладывать незачем');

      const prof = (await c.query(
        `SELECT pp.max_parked_sales FROM pos_profile pp JOIN store s ON s.pos_profile_id=pp.id WHERE s.id=$1`,
        [sale.store_id])).rows[0];
      const limit = Number(prof?.max_parked_sales ?? 100);
      const parked = (await c.query(`SELECT count(*)::int n FROM sale WHERE shift_id=$1 AND status='parked'`, [sale.shift_id])).rows[0].n;
      if (parked >= limit) throw new BadRequestException(`Нельзя отложить больше ${limit} чеков`);

      const { rows } = await c.query(`UPDATE sale SET status='parked', parked_at=now() WHERE id=$1 RETURNING *`, [saleId]);
      return rows[0];
    });
  }

  /**
   * Вернуться к отложенному чеку. МойСклад предупреждает: «кассир не сможет
   * оформить чек, если изменилась цена продажи или товар удалили».
   * Мы не запрещаем, а показываем, что изменилось, — решает человек.
   */
  async unpark(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = (await c.query(`SELECT * FROM sale WHERE id=$1 AND status='parked'`, [saleId])).rows[0];
      if (!sale) throw new BadRequestException('Отложенный чек не найден');

      const items = (await c.query(
        `SELECT i.*, p.name, p.deleted_at, p.archived_at FROM sale_item i JOIN product p ON p.id=i.product_id
          WHERE i.sale_id=$1`, [saleId])).rows;

      const warnings: string[] = [];
      for (const it of items) {
        if (it.deleted_at) { warnings.push(`«${it.name}» удалён из номенклатуры`); continue; }
        if (it.archived_at) warnings.push(`«${it.name}» отправлен в архив`);
        const now = await this.priceOf(c, it.product_id, sale.store_id);
        if (now != null && Math.abs(now - Number(it.price)) >= 0.01)
          warnings.push(`«${it.name}»: цена изменилась ${it.price} → ${now} ₸`);
      }

      await c.query(`UPDATE sale SET status='draft', parked_at=NULL WHERE id=$1`, [saleId]);
      const fresh = await this.recalc(c, accountId, saleId);
      return { sale: fresh, warnings };
    });
  }

  async parkedList(accountId: string, shiftId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT s.id, s.local_number, s.total, s.parked_at,
                (SELECT count(*) FROM sale_item i WHERE i.sale_id=s.id) AS items
           FROM sale s WHERE s.shift_id=$1 AND s.status='parked' ORDER BY s.parked_at`, [shiftId])).rows);
  }

  /** Пречек — печатается из отложенного чека (модель МС). */
  async preReceipt(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(`SELECT * FROM sale WHERE id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');
      const items = (await c.query(
        `SELECT i.qty, i.price, i.total, i.discount_sum, p.name FROM sale_item i
           JOIN product p ON p.id=i.product_id WHERE i.sale_id=$1`, [saleId])).rows;
      return {
        isPreReceipt: true, localNumber: s.local_number,
        items: items.map((i: any) => ({ name: i.name, qty: Number(i.qty), price: Number(i.price), total: Number(i.total) })),
        subtotal: Number(s.subtotal), discount: Number(s.discount_sum),
        rounding: Number(s.rounding), total: Number(s.total),
      };
    });
  }

  // ==================================================================
  // ОТЧЁТЫ
  // ==================================================================
  /** Отменённые товары — раздел UMAG. Формат количества: «100→98». */
  async cancelledItems(accountId: string, f: { from?: string; cashRegisterId?: string; employeeId?: string } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT ci.cancelled_at, cr.name AS cash_register, e.first_name AS employee,
                p.name AS product, ci.qty_added, ci.qty_cancelled, ci.price,
                (ci.qty_added - ci.qty_cancelled) AS qty_left, a.first_name AS approved_by
           FROM cancelled_item ci
           LEFT JOIN cash_register cr ON cr.id = ci.cash_register_id
           LEFT JOIN employee e ON e.id = ci.employee_id
           LEFT JOIN employee a ON a.id = ci.approved_by
           JOIN product p ON p.id = ci.product_id
          WHERE ($1::timestamptz IS NULL OR ci.cancelled_at >= $1)
            AND ($2::uuid IS NULL OR ci.cash_register_id = $2)
            AND ($3::uuid IS NULL OR ci.employee_id = $3)
          ORDER BY ci.cancelled_at DESC LIMIT 200`,
        [f.from ?? null, f.cashRegisterId ?? null, f.employeeId ?? null]);
      // формат UMAG дословно: «100→98» значит добавили 100, отменили 98, осталось 2.
      // Дробные хвосты убираем: numeric отдаёт «100.000», а кассиру нужно «100».
      const fmt = (v: any) => {
        const n = Number(v);
        return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '');
      };
      return rows.map((r: any) => ({
        ...r,
        qty_added: Number(r.qty_added), qty_cancelled: Number(r.qty_cancelled),
        display: Number(r.qty_left) > 0 ? `${fmt(r.qty_added)}→${fmt(r.qty_cancelled)}` : fmt(r.qty_cancelled),
      }));
    });
  }

  async saleReceipt(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `SELECT s.*, e.first_name AS cashier, con.name AS consultant, cr.name AS register
           FROM sale s LEFT JOIN employee e ON e.id=s.employee_id
           LEFT JOIN consultant con ON con.id=s.consultant_id
           LEFT JOIN cash_register cr ON cr.id=s.cash_register_id
          WHERE s.id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');
      const items = (await c.query(
        `SELECT i.*, p.name FROM sale_item i JOIN product p ON p.id=i.product_id WHERE i.sale_id=$1`, [saleId])).rows;
      const pays = (await c.query(`SELECT method, amount, received, change_given FROM sale_payment WHERE sale_id=$1`, [saleId])).rows;
      return { sale: s, items, payments: pays };
    });
  }

  // ==================================================================
  // 4.7 ПРИЁМ ОФЛАЙН-ДАННЫХ
  //
  // Касса посчитала чек сама и прислала факт. Сервер НЕ пересчитывает:
  // после суток офлайна цену в кабинете могли поменять, а покупатель платил
  // по той, что была на кассе. Пересчёт исказил бы историю.
  //
  // Идемпотентность держится на UUID чека: повтор отправки не создаёт дубль.
  // ==================================================================

  /** Применить смену, открытую офлайн. */
  async applyOfflineShift(c: PoolClient, accountId: string, e: any, ctx: { deviceId?: string }) {
    const p = e.payload ?? {};
    const reg = (await c.query(
      `SELECT cr.id, cr.store_id FROM device d JOIN cash_register cr ON cr.id = d.cash_register_id WHERE d.id=$1`,
      [ctx.deviceId])).rows[0];
    if (!reg) throw new Error('Устройство не привязано к кассе');

    // ЗАКРЫТИЕ СМЕНЫ, СДЕЛАННОЕ ОФЛАЙН (часть 16). До этого обработчик умел
    // только открывать: смена, закрытая без интернета, на сервере висела бы
    // «открытой» вечно, и кабинет показывал бы неправду. Итоги считаем на
    // сервере из принятых чеков (они приходят в том же батче раньше по
    // clientSeq), факт наличных и комментарий — с кассы.
    if (e.op === 'update' && p.closedAt) {
      const t = (await c.query(`SELECT * FROM shift_totals($1,$2)`, [accountId, e.entityId])).rows[0];
      if (!t) return;                          // смена не доехала — событие уйдёт в карантин выше
      const actual = Number(p.actualCash ?? t.expected_cash);
      const discrepancy = Math.round((actual - Number(t.expected_cash)) * 100) / 100;
      await c.query(
        `UPDATE shift SET status='closed', closed_at=$2, closed_by=$3,
                cash_sales=$4, card_sales=$5, qr_sales=$6, credit_sales=$7, returns_sum=$8,
                deposits=$9, withdrawals=$10, expected_cash=$11, actual_cash=$12,
                discrepancy=$13, discrepancy_comment=$14, receipts_count=$15
          WHERE id=$1 AND status='open'`,
        [e.entityId, p.closedAt, e.employeeId ?? null, t.cash, t.card, t.qr, t.credit, t.returns_sum,
         t.deposits, t.withdrawals, t.expected_cash, actual, discrepancy,
         p.comment ?? (discrepancy !== 0 ? 'Закрыто офлайн' : null), t.receipts]);
      return;
    }

    await c.query(
      `INSERT INTO shift (id, account_id, cash_register_id, store_id, number, opened_by, opened_at,
                          opening_float, offline_opened, device_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,'open')
       ON CONFLICT (id) DO NOTHING`,
      [e.entityId, accountId, reg.id, reg.store_id, p.number ?? 1, e.employeeId ?? null,
       p.openedAt ?? new Date().toISOString(), p.openingFloat ?? 0, ctx.deviceId ?? null]);

    if (p.openingFloat) {
      await c.query(
        `INSERT INTO cash_operation (account_id, shift_id, cash_register_id, kind, amount, comment, employee_id)
         SELECT $1,$2,$3,'opening_float',$4,'Размен на начало смены',$5
          WHERE NOT EXISTS (SELECT 1 FROM cash_operation WHERE shift_id=$2 AND kind='opening_float')`,
        [accountId, e.entityId, reg.id, p.openingFloat, e.employeeId ?? null]);
    }
  }

  /** Применить чек, пробитый офлайн: шапка, позиции, оплаты, списание товара. */
  async applyOfflineSale(c: PoolClient, accountId: string, e: any, ctx: { deviceId?: string }) {
    const p = e.payload ?? {};
    const exists = (await c.query(`SELECT id FROM sale WHERE id=$1`, [e.entityId])).rows[0];
    if (exists) return;                       // повтор отправки — не дубль

    const reg = (await c.query(
      `SELECT cr.id, cr.store_id, cr.warehouse_id FROM device d JOIN cash_register cr ON cr.id = d.cash_register_id WHERE d.id=$1`,
      [ctx.deviceId])).rows[0];
    if (!reg) throw new Error('Устройство не привязано к кассе');

    const num = (await c.query(`SELECT next_sale_number($1,$2) AS n`, [accountId, reg.id])).rows[0].n;
    const pay = p.payment ?? {};
    // НОРМАЛИЗАЦИЯ ВОЗВРАТА (часть 18): касса шлёт возврат отрицательным
    // чеком, онлайн-путь хранит положительные суммы. Приводим к одной
    // конвенции ПРИ ЗАПИСИ — «возвратность» несёт return_of_id, а не знак.
    // Иначе каждый отчёт (дашборд, смены, консультанты…) обязан помнить
    // про abs() — и однажды кто-то забудет.
    const isRefund = !!p.refundOf;
    const norm = (v: any) => (isRefund ? Math.abs(Number(v ?? 0)) : Number(v ?? 0));
    const total = norm(p.total);
    const cost = norm(p.costTotal);

    await c.query(
      `INSERT INTO sale (id, account_id, shift_id, cash_register_id, store_id, warehouse_id, number, local_number,
                         status, employee_id, consultant_id, customer_id, return_of_id, subtotal, discount_sum, rounding,
                         total, cost_total, profit, paid_cash, paid_card, paid_qr, paid_credit, paid_bonus, change_given,
                         offline_created, device_id, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,true,$25,$26,$26)`,
      [e.entityId, accountId, p.shiftId ?? null, reg.id, reg.store_id, reg.warehouse_id, num, p.localNumber ?? null,
       e.employeeId ?? null, p.consultantId ?? null, p.customerId ?? null, p.refundOf ?? null,
       norm(p.subtotal ?? total), p.discountSum ?? 0, p.rounding ?? 0, total, cost,
       Math.round((total - cost) * 100) / 100,
       pay.cash ?? 0, pay.card ?? 0, pay.qr ?? 0, pay.credit ?? 0, pay.bonus ?? 0, pay.change ?? 0,
       ctx.deviceId ?? null, e.clientTs ?? new Date().toISOString()]);

    for (const it of p.items ?? []) {
      const qty = norm(it.qty);
      await c.query(
        `INSERT INTO sale_item (account_id, sale_id, product_id, qty, price, discount_sum, total, cost, vat_rate, ntin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [accountId, e.entityId, it.productId, qty, it.price, it.discountSum ?? 0,
         norm(it.total ?? Math.round(Number(it.qty) * Number(it.price) * 100) / 100),
         it.cost ?? 0, it.vatRate ?? null, it.ntin ?? null]);

      // остаток — сумма движений (принцип из 1.3): два дня офлайна двух касс
      // сложатся правильно, потому что каждая прислала свои «−2», а не «остаток=5».
      // Возврат двигает склад в плюс.
      const tracked = (await c.query(`SELECT track_stock, kind, bundle_mode, recipe_yield FROM product WHERE id=$1`, [it.productId])).rows[0];
      // ТЕХКАРТА (часть 35): готовое блюдо-рецепт списывает ИНГРЕДИЕНТЫ, не себя.
      // Продали латте → ушли зёрна+молоко+стакан; сам латте остатка не ведёт.
      if (tracked?.kind === 'bundle' && tracked?.bundle_mode === 'recipe') {
        const y = Math.max(Number(tracked.recipe_yield ?? 1), 1);
        const comps = (await c.query(
          `SELECT bi.component_id, bi.qty, pr.track_stock FROM bundle_item bi
             JOIN product pr ON pr.id = bi.component_id WHERE bi.bundle_id=$1`, [it.productId])).rows;
        for (const comp of comps) {
          if (!comp.track_stock) continue;
          const perUnit = Number(comp.qty) / y;   // на 1 порцию блюда
          const move = perUnit * qty;
          await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,$5,NULL,$6)`,
            [accountId, reg.warehouse_id, comp.component_id, isRefund ? move : -move,
             isRefund ? 'sale_return' : 'sale', e.employeeId ?? null]);
        }
      } else if (tracked?.track_stock)
        await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,$5,NULL,$6)`,
          [accountId, reg.warehouse_id, it.productId, isRefund ? qty : -qty,
           isRefund ? 'sale_return' : 'sale', e.employeeId ?? null]);
    }

    for (const [method, amount] of Object.entries(pay)) {
      if (!amount || method === 'change') continue;
      await c.query(
        `INSERT INTO sale_payment (account_id, sale_id, method, amount) VALUES ($1,$2,$3::pay_method,$4)`,
        [accountId, e.entityId, method, Math.abs(Number(amount))]);
    }

    // ЭФФЕКТЫ ПОКУПАТЕЛЯ (часть 17). До этого «в долг» писал только цифру в
    // чек — долговая книга не росла, а бонусы не начислялись вовсе.
    await this.applyCustomerEffects(c, accountId, {
      saleId: e.entityId, customerId: p.customerId ?? null,
      employeeId: e.employeeId ?? null, shiftId: p.shiftId ?? null,
      credit: Number(pay.credit ?? 0), bonus: Number(pay.bonus ?? 0),
      approvedBy: p.approvedBy ?? null, offline: true,
      refundOf: p.refundOf ?? null,
    });
  }

  /**
   * Долг и бонусы по чеку — одна точка для онлайн и офлайн пути.
   * Офлайн-факт нельзя отклонить (чек уже пробит): превышение лимита долга
   * записывается с пометкой, владелец увидит его в долговой книге.
   * Онлайн — жёстко: сервер вправе отказать до печати чека.
   */
  async applyCustomerEffects(c: PoolClient, accountId: string, o: {
    saleId: string; customerId: string | null; employeeId: string | null; shiftId: string | null;
    credit: number; bonus: number; approvedBy: string | null; offline: boolean; refundOf?: string | null;
  }) {
    // возврат: отзыв начисленного и возврат потраченного — модель части 10
    if (o.refundOf) {
      if (this.loyalty) await this.loyalty.handleRefundTx(c, accountId, o.saleId, o.refundOf);
      return;
    }
    if (!o.customerId) return;

    // --- долг: правило Wipon (только с покупателем) + лимит части 6 ---
    if (o.credit > 0) {
      const chk = (await c.query(`SELECT * FROM check_debt_limit($1,$2,$3::numeric)`,
        [accountId, o.customerId, o.credit])).rows[0];
      if (!chk.allowed && !o.approvedBy && !o.offline)
        throw new BadRequestException(chk.reason ?? 'Лимит долга превышен');
      const cp = (await c.query(`SELECT debt_days FROM counterparty WHERE id=$1`, [o.customerId])).rows[0];
      const due = cp?.debt_days ? new Date(Date.now() + cp.debt_days * 86400000) : null;
      const comment = !chk.allowed
        ? (o.approvedBy ? 'Сверх лимита, разрешил старший' : 'Сверх лимита: пробито офлайн')
        : null;
      await c.query(
        `SELECT apply_balance_move($1,$2,$3::numeric,'sale_credit',$4,NULL,'credit'::pay_method,$5,$6,$7,$8)`,
        [accountId, o.customerId, o.credit, o.saleId, o.employeeId, o.shiftId, comment, due]);
    }

    // --- оплата бонусами: FIFO по сгоранию (функция части 10) ---
    if (o.bonus > 0) {
      const bal = (await c.query(`SELECT coalesce(balance,0) AS b FROM bonus_balance WHERE counterparty_id=$1`,
        [o.customerId])).rows[0];
      if (!o.offline && Number(bal?.b ?? 0) < o.bonus)
        throw new BadRequestException(`Бонусов ${Number(bal?.b ?? 0)} ₸ — не хватает на ${o.bonus} ₸`);
      await c.query(`SELECT * FROM spend_bonuses($1,$2,$3::numeric,$4,$5)`,
        [accountId, o.customerId, o.bonus, o.saleId, o.employeeId]);
    }

    // --- начисление: идемпотентно по sale_id, та же транзакция, что и чек ---
    if (this.loyalty) await this.loyalty.earnTx(c, accountId, o.saleId);
  }

  /**
   * Внесение/изъятие, сделанное офлайн (часть 16). Без этого Z-отчёт после
   * суток без сети врал бы: размен утром и выемка вечером не доехали бы,
   * и expected_cash на сервере разошёлся бы с кассой.
   */
  async applyOfflineCashOp(c: PoolClient, accountId: string, e: any, ctx: { deviceId?: string }) {
    const p = e.payload ?? {};
    const reg = (await c.query(
      `SELECT cr.id FROM device d JOIN cash_register cr ON cr.id = d.cash_register_id WHERE d.id=$1`, [ctx.deviceId])).rows[0];
    await c.query(
      `INSERT INTO cash_operation (id, account_id, shift_id, cash_register_id, kind, amount, comment, employee_id, approved_by, created_at)
       VALUES ($1,$2,$3,$4,$5::cash_op_kind,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [e.entityId, accountId, p.shiftId, reg?.id ?? null, p.kind, p.amount, p.comment ?? null,
       e.employeeId ?? null, p.approvedBy ?? null, e.clientTs ?? new Date().toISOString()]);
  }

  /**
   * Новый покупатель, записанный кассиром (часть 17): в магазине у дома
   * должников заводят у кассы, а не в кабинете. Только базовые поля —
   * ИИН, лимит и прочее владелец дозаполнит в кабинете.
   */
  async applyOfflineNewCustomer(c: PoolClient, accountId: string, e: any) {
    const p = e.payload ?? {};
    if (!p.name?.trim()) throw new Error('Имя покупателя обязательно');
    await c.query(
      `INSERT INTO counterparty (id, account_id, name, kind, is_customer, phone)
       VALUES ($1,$2,$3,'person',true,$4) ON CONFLICT (id) DO NOTHING`,
      [e.entityId, accountId, p.name.trim(), p.phone ?? null]);
    await c.query(
      `INSERT INTO counterparty_balance (counterparty_id, account_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`, [e.entityId, accountId]);
  }

  /**
   * Погашение долга, принятое кассиром офлайн (модель долговой книги Wipon:
   * сумма, тип оплаты, дата, остаток). Долг мог уменьшиться с другой кассы,
   * пока эта была без сети — платёж срезается до остатка, излишек помечается.
   * Наличные попадают в кассу смены отдельной строкой внесения.
   */
  async applyOfflineDebtPayment(c: PoolClient, accountId: string, e: any, ctx: { deviceId?: string }) {
    const p = e.payload ?? {};
    const cp = (await c.query(
      `SELECT b.balance, cp.name FROM counterparty_balance b JOIN counterparty cp ON cp.id=b.counterparty_id
        WHERE b.counterparty_id=$1 FOR UPDATE`, [p.counterpartyId])).rows[0];
    const debt = Number(cp?.balance ?? 0);
    if (debt <= 0) return;                    // долг уже закрыт другой кассой — платёж «в воздух» не пишем
    const amount = Math.min(Number(p.amount ?? 0), debt);
    if (amount <= 0) return;

    await c.query(
      `SELECT apply_balance_move($1,$2,$3::numeric,'debt_payment',NULL,NULL,$4::pay_method,$5,$6,$7,NULL)`,
      [accountId, p.counterpartyId, -amount, p.method ?? 'cash', e.employeeId ?? null,
       p.shiftId ?? null,
       amount < Number(p.amount ?? 0) ? `Принято ${p.amount} ₸, долг был ${debt} ₸ — срезано офлайн` : null]);

    // наличные — в ящик смены: X/Z-отчёт обязан их видеть
    if ((p.method ?? 'cash') === 'cash' && p.shiftId) {
      const reg = (await c.query(
        `SELECT cr.id FROM device d JOIN cash_register cr ON cr.id=d.cash_register_id WHERE d.id=$1`,
        [ctx.deviceId])).rows[0];
      await c.query(
        `INSERT INTO cash_operation (id, account_id, shift_id, cash_register_id, kind, amount, comment, employee_id, created_at)
         VALUES ($1,$2,$3,$4,'deposit',$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [e.entityId, accountId, p.shiftId, reg?.id ?? null, amount,
         `Погашение долга: ${cp.name}`, e.employeeId ?? null, e.clientTs ?? new Date().toISOString()]);
    }
  }

  /** Отмена позиции, сделанная офлайн (контроль UMAG работает и без сети). */
  async applyOfflineCancel(c: PoolClient, accountId: string, e: any, ctx: { deviceId?: string }) {
    const p = e.payload ?? {};
    const reg = (await c.query(
      `SELECT cr.id FROM device d JOIN cash_register cr ON cr.id = d.cash_register_id WHERE d.id=$1`, [ctx.deviceId])).rows[0];
    await c.query(
      `INSERT INTO cancelled_item (id, account_id, sale_id, cash_register_id, shift_id, employee_id,
                                   product_id, qty_added, qty_cancelled, price, approved_by, cancelled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [e.entityId, accountId, p.saleId ?? null, reg?.id ?? null, p.shiftId ?? null, e.employeeId ?? null,
       p.productId, p.qtyAdded, p.qtyCancelled, p.price ?? null, p.approvedBy ?? null,
       e.clientTs ?? new Date().toISOString()]);
  }
}
