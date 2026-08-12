import { randomUUID } from 'crypto';
import { Injectable, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';

/**
 * КОНТРАГЕНТЫ И ДОЛГИ.
 *
 * Критерий части — «тетрадь долгов магазина полностью в системе». Ровно это
 * обещает МойСклад в статье про Казахстан: «Учёт продаж в долг заменяет
 * тетрадку должников». Но у них же ниже: погашение долга — «в разработке»,
 * возврат — «в разработке», отчёты — «в разработке». То есть продать в долг
 * можно, а погасить нельзя, и тетрадка остаётся на бумаге.
 *
 * Здесь цикл закрыт целиком: долг, погашение частями, история, лимит, срок.
 *
 * Баланс — сумма движений, а не поле (принцип из 1.3): две кассы, работавшие
 * офлайн, не затрут долг друг друга.
 */

export interface CounterpartyInput {
  name: string;
  kind?: 'person' | 'company' | 'entrepreneur';
  isCustomer?: boolean;
  isSupplier?: boolean;
  phone?: string;
  iinBin?: string;
  fullName?: string;
  director?: string;
  legalAddress?: string;
  actualAddress?: string;
  groupName?: string;
  storeId?: string;
  priceTypeId?: string;
  debtLimit?: number;
  debtDays?: number;
  allowCredit?: boolean;
  comment?: string;
}

/**
 * Справочник госреестра. Wipon: «Введите ИИН/БИН → Проверить → данные
 * автоматически подгружаются через stat.gov.kz».
 *
 * ЧЕСТНО: внешние домены в этой среде закрыты, настоящий ответ реестра
 * проверить нельзя. Поэтому здесь интерфейс, как с операторами фискализации:
 * форма зафиксирована, запрос подключается, когда есть доступ.
 */
export interface GovRegistry {
  lookup(iinBin: string): Promise<{ found: boolean; fullName?: string; director?: string; address?: string; kind?: string; error?: string }>;
}

export class StatGovRegistry implements GovRegistry {
  async lookup(iinBin: string) {
    try {
      const r = await fetch(`https://stat.gov.kz/api/juridical/counter/api/?bin=${iinBin}&lang=ru`,
        { signal: AbortSignal.timeout(8000) });
      const j: any = await r.json();
      if (!j?.obj) return { found: false, error: 'В реестре не найден' };
      return {
        found: true,
        fullName: j.obj.name, director: j.obj.director, address: j.obj.addressRu,
        kind: j.obj.katoCode ? 'company' : 'entrepreneur',
      };
    } catch (e: any) {
      return { found: false, error: `Реестр недоступен: ${e.message}` };
    }
  }
}

@Injectable()
export class ContragentService {
  private registry: GovRegistry = new StatGovRegistry();
  constructor(private db: DbService) {}

  setRegistry(r: GovRegistry) { this.registry = r; }

  // ==================================================================
  // 6.1 СПРАВОЧНИК
  // ==================================================================

  /**
   * Один справочник с ролями, а не два. UMAG и Wipon держат покупателей и
   * поставщиков раздельно, но ИП Ержан привозит воду (поставщик) и берёт
   * сигареты себе в киоск (покупатель) — это одно лицо.
   */
  async create(accountId: string, dto: CounterpartyInput) {
    if (!dto.name?.trim()) throw new BadRequestException('Имя обязательно');   // единственное обязательное поле (UMAG)
    return this.db.withTenant(accountId, async (c) => {
      if (dto.iinBin) {
        const dup = (await c.query(
          `SELECT id, name FROM counterparty WHERE iin_bin=$1 AND deleted_at IS NULL`, [dto.iinBin])).rows[0];
        if (dup) throw new BadRequestException(`ИИН/БИН уже у «${dup.name}»`);
      }
      const { rows } = await c.query(
        `INSERT INTO counterparty (account_id, name, kind, is_customer, is_supplier, phone, iin_bin,
                                   full_name, director, legal_address, actual_address, group_name,
                                   store_id, price_type_id, debt_limit, debt_days, allow_credit, comment)
         VALUES ($1,$2,$3::cp_kind,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [accountId, dto.name.trim(), dto.kind ?? 'person', dto.isCustomer ?? true, dto.isSupplier ?? false,
         dto.phone ?? null, dto.iinBin ?? null, dto.fullName ?? null, dto.director ?? null,
         dto.legalAddress ?? null, dto.actualAddress ?? null, dto.groupName ?? null,
         dto.storeId ?? null, dto.priceTypeId ?? null, dto.debtLimit ?? null, dto.debtDays ?? null,
         dto.allowCredit ?? true, dto.comment ?? null]);
      await c.query(`INSERT INTO counterparty_balance (counterparty_id, account_id) VALUES ($1,$2)
                     ON CONFLICT DO NOTHING`, [rows[0].id, accountId]);

      // Дельта на кассы (часть 17): новый покупатель из кабинета должен быть
      // доступен для «в долг» на кассе без переснимка справочника.
      if (rows[0].is_customer !== false) {
        await c.query(
          `INSERT INTO oplog (id, account_id, entity, entity_id, op, payload, client_ts, applied_at)
           VALUES ($1,$2,'customer',$3,'insert',$4,now(),now()) ON CONFLICT (id) DO NOTHING`,
          [randomUUID(), accountId, rows[0].id, JSON.stringify({
            name: rows[0].name, phone: rows[0].phone ?? null,
            loyaltyCard: rows[0].loyalty_card ?? null,
            debtLimit: rows[0].debt_limit != null ? Number(rows[0].debt_limit) : null,
          })]);
      }
      return rows[0];
    });
  }

  /** Заполнение по ИИН/БИН из госреестра — модель Wipon. */
  async lookupByIinBin(accountId: string, iinBin: string) {
    if (!/^\d{12}$/.test(iinBin)) throw new BadRequestException('ИИН/БИН — это 12 цифр');
    const r = await this.registry.lookup(iinBin);
    if (!r.found) return { found: false, reason: r.error ?? 'Не найден', canFillManually: true };
    return {
      found: true,
      suggestion: {
        iinBin, fullName: r.fullName, name: r.fullName, director: r.director,
        legalAddress: r.address, kind: r.kind ?? 'company',
      },
    };
  }

  async createFromIinBin(accountId: string, iinBin: string, extra: Partial<CounterpartyInput> = {}) {
    const l = await this.lookupByIinBin(accountId, iinBin);
    if (!l.found) throw new BadRequestException(`${l.reason}. Заполните данные вручную`);
    const s = l.suggestion!;
    const cp = await this.create(accountId, {
      name: extra.name ?? s.name ?? iinBin,
      kind: (s.kind as any) ?? 'company',
      iinBin, fullName: s.fullName, director: s.director, legalAddress: s.legalAddress,
      ...extra,
    });
    await this.db.withTenant(accountId, async (c) =>
      c.query(`UPDATE counterparty SET gov_synced_at=now() WHERE id=$1`, [cp.id]));
    return cp;
  }

  async update(accountId: string, id: string, dto: Partial<CounterpartyInput>) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `UPDATE counterparty SET
           name = coalesce($2, name), phone = coalesce($3, phone), iin_bin = coalesce($4, iin_bin),
           full_name = coalesce($5, full_name), director = coalesce($6, director),
           legal_address = coalesce($7, legal_address), group_name = coalesce($8, group_name),
           debt_limit = CASE WHEN $9::boolean THEN $10 ELSE debt_limit END,
           debt_days = coalesce($11, debt_days), allow_credit = coalesce($12, allow_credit),
           comment = coalesce($13, comment), is_customer = coalesce($14, is_customer),
           is_supplier = coalesce($15, is_supplier), price_type_id = coalesce($16, price_type_id)
         WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
        [id, dto.name ?? null, dto.phone ?? null, dto.iinBin ?? null, dto.fullName ?? null,
         dto.director ?? null, dto.legalAddress ?? null, dto.groupName ?? null,
         dto.debtLimit !== undefined, dto.debtLimit ?? null, dto.debtDays ?? null,
         dto.allowCredit ?? null, dto.comment ?? null, dto.isCustomer ?? null,
         dto.isSupplier ?? null, dto.priceTypeId ?? null]);
      if (!rows[0]) throw new BadRequestException('Контрагент не найден');
      return rows[0];
    });
  }

  /** Список с балансом. Wipon показывает общую задолженность всех — берём. */
  async list(accountId: string, f: {
    q?: string; role?: 'customer' | 'supplier'; withDebtOnly?: boolean;
    archived?: boolean; groupName?: string; limit?: number;
  } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const w: string[] = ['c.deleted_at IS NULL'];
      const p: any[] = [];
      w.push(f.archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL');
      if (f.q) { p.push(f.q); w.push(`(c.name ILIKE '%'||$${p.length}||'%' OR c.phone LIKE '%'||$${p.length}||'%' OR c.iin_bin = $${p.length})`); }
      if (f.role === 'customer') w.push('c.is_customer');
      if (f.role === 'supplier') w.push('c.is_supplier');
      if (f.groupName) { p.push(f.groupName); w.push(`c.group_name = $${p.length}`); }
      if (f.withDebtOnly) w.push('coalesce(b.balance,0) > 0');
      p.push(Math.min(f.limit ?? 100, 500));

      const { rows } = await c.query(
        `SELECT c.id, c.code, c.name, c.kind, c.phone, c.iin_bin, c.is_customer, c.is_supplier,
                c.group_name, c.debt_limit, c.allow_credit, c.created_at, c.archived_at,
                coalesce(b.balance, 0) AS balance, s.name AS store
           FROM counterparty c
           LEFT JOIN counterparty_balance b ON b.counterparty_id = c.id
           LEFT JOIN store s ON s.id = c.store_id
          WHERE ${w.join(' AND ')} ORDER BY c.name LIMIT $${p.length}`, p);

      const totals = (await c.query(
        `SELECT coalesce(sum(balance) FILTER (WHERE balance > 0), 0) AS owed_to_us,
                coalesce(sum(-balance) FILTER (WHERE balance < 0), 0) AS we_owe
           FROM counterparty_balance b JOIN counterparty c ON c.id = b.counterparty_id
          WHERE c.deleted_at IS NULL`)).rows[0];

      return {
        items: rows.map((r: any) => ({ ...r, balance: Number(r.balance) })),
        // аналитика Wipon: общая задолженность всех клиентов
        totalOwedToUs: Number(totals.owed_to_us),
        totalWeOwe: Number(totals.we_owe),
      };
    });
  }

  /** Карточка: реквизиты, баланс и список операций (модель UMAG). */
  async card(accountId: string, id: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cp = (await c.query(
        `SELECT c.*, coalesce(b.balance, 0) AS balance FROM counterparty c
           LEFT JOIN counterparty_balance b ON b.counterparty_id = c.id
          WHERE c.id=$1`, [id])).rows[0];
      if (!cp) throw new BadRequestException('Контрагент не найден');

      const ops = (await c.query(
        `SELECT m.ts, m.reason, m.amount, m.payment_method, m.comment, m.due_at,
                s.number AS sale_number, d.number AS doc_number, e.first_name AS employee
           FROM balance_move m
           LEFT JOIN sale s ON s.id = m.sale_id
           LEFT JOIN stock_doc d ON d.id = m.doc_id
           LEFT JOIN employee e ON e.id = m.employee_id
          WHERE m.counterparty_id=$1 ORDER BY m.ts DESC LIMIT 100`, [id])).rows;

      return {
        ...cp,
        balance: Number(cp.balance),
        debtLimit: cp.debt_limit == null ? null : Number(cp.debt_limit),
        // «Список операций» с раскрытием — модель UMAG
        operations: ops.map((o: any) => ({
          ts: o.ts, reason: o.reason, amount: Number(o.amount),
          method: o.payment_method, comment: o.comment, dueAt: o.due_at,
          ref: o.sale_number ? `Чек №${o.sale_number}` : o.doc_number ? `Документ №${o.doc_number}` : null,
          employee: o.employee,
        })),
      };
    });
  }

  /** Архив (Wipon: Текущие / Архивные), удаление мягкое (UMAG: остаются в базе). */
  async archive(accountId: string, id: string, archive = true) {
    return this.db.withTenant(accountId, async (c) => {
      if (archive) {
        const bal = (await c.query(`SELECT balance FROM counterparty_balance WHERE counterparty_id=$1`, [id])).rows[0];
        if (bal && Number(bal.balance) !== 0)
          throw new BadRequestException(`Нельзя архивировать: баланс ${Number(bal.balance)} ₸ не закрыт`);
      }
      await c.query(`UPDATE counterparty SET archived_at = $2 WHERE id=$1`, [id, archive ? new Date() : null]);
      return { ok: true };
    });
  }

  // ==================================================================
  // 6.2 ДОЛГОВАЯ КНИГА
  // ==================================================================

  /**
   * Проверка лимита перед продажей в долг — наше добавление.
   * Чистая функция в базе: касса считает это офлайн, когда сервера рядом нет.
   */
  async checkDebtLimit(accountId: string, counterpartyId: string, amount: number) {
    const { rows } = await this.db.raw(`SELECT * FROM check_debt_limit($1,$2,$3::numeric)`,
      [accountId, counterpartyId, amount]);
    const r = rows[0];
    return {
      allowed: r.allowed,
      currentDebt: Number(r.current_debt),
      debtLimit: r.debt_limit == null ? null : Number(r.debt_limit),
      overBy: Number(r.over_by ?? 0),
      reason: r.reason,
    };
  }

  /**
   * Записать долг по чеку. Вызывается кассой при оплате «в долг».
   * Фискальный чек здесь НЕ пробивается: денег не поступило (модель МС).
   */
  async recordSaleDebt(accountId: string, dto: {
    counterpartyId: string; saleId: string; amount: number;
    employeeId?: string; shiftId?: string; approvedBy?: string;
  }) {
    const check = await this.checkDebtLimit(accountId, dto.counterpartyId, dto.amount);
    if (!check.allowed && !dto.approvedBy) throw new BadRequestException(check.reason!);

    return this.db.withTenant(accountId, async (c) => {
      const cp = (await c.query(`SELECT debt_days, name FROM counterparty WHERE id=$1`, [dto.counterpartyId])).rows[0];
      const due = cp?.debt_days ? new Date(Date.now() + cp.debt_days * 86400000) : null;

      const { rows } = await c.query(
        `SELECT * FROM apply_balance_move($1,$2,$3::numeric,'sale_credit',$4,NULL,'credit'::pay_method,$5,$6,$7,$8)`,
        [accountId, dto.counterpartyId, dto.amount, dto.saleId, dto.employeeId ?? null,
         dto.shiftId ?? null, dto.approvedBy ? 'Сверх лимита, разрешил старший' : null, due]);
      return {
        moveId: rows[0].move_id, newDebt: Number(rows[0].new_balance),
        dueAt: due, overLimit: !check.allowed,
      };
    });
  }

  /**
   * Погашение долга — то, что у МоегоСклада «в разработке».
   * Частями: должен 12 000, принёс 5000, потом ещё 3000. Так работает тетрадка.
   */
  async payDebt(accountId: string, dto: {
    counterpartyId: string; amount: number; method?: 'cash' | 'card' | 'qr';
    employeeId?: string; shiftId?: string; comment?: string;
  }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма погашения должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const cur = (await c.query(
        `SELECT b.balance, c.name FROM counterparty_balance b JOIN counterparty c ON c.id = b.counterparty_id
          WHERE b.counterparty_id=$1 FOR UPDATE`, [dto.counterpartyId])).rows[0];
      if (!cur) throw new BadRequestException('Контрагент не найден');
      const debt = Number(cur.balance);
      if (debt <= 0) throw new BadRequestException(`За «${cur.name}» долга нет`);
      if (dto.amount > debt)
        throw new BadRequestException(`Долг «${cur.name}» — ${debt} ₸, принято ${dto.amount} ₸. Переплата не записывается в минус: примите ${debt} ₸`);

      const { rows } = await c.query(
        `SELECT * FROM apply_balance_move($1,$2,$3::numeric,'debt_payment',NULL,NULL,$4::pay_method,$5,$6,$7,NULL)`,
        [accountId, dto.counterpartyId, -dto.amount, dto.method ?? 'cash',
         dto.employeeId ?? null, dto.shiftId ?? null, dto.comment ?? null]);

      const left = Number(rows[0].new_balance);
      return {
        moveId: rows[0].move_id, paid: dto.amount, debtLeft: left, closed: left === 0,
        message: left === 0 ? `Долг «${cur.name}» закрыт полностью` : `Осталось ${left} ₸`,
      };
    });
  }

  /** Долговая книга — модель Wipon debtbook. */
  async debtBook(accountId: string, overdueOnly = false) {
    const { rows } = await this.db.raw(`SELECT * FROM debt_book($1,$2)`, [accountId, overdueOnly]);
    const items = rows.map((r: any) => ({
      counterpartyId: r.counterparty_id, name: r.name, iinBin: r.iin_bin, phone: r.phone,
      debt: Number(r.debt), debtLimit: r.debt_limit == null ? null : Number(r.debt_limit),
      lastPaymentAt: r.last_payment_at, oldestDebtAt: r.oldest_debt_at,
      dueAt: r.due_at, daysOverdue: r.due_at && new Date(r.due_at) < new Date() ? r.days_overdue : 0,
    }));
    return {
      items,
      total: items.reduce((s: number, i: any) => s + i.debt, 0),
      overdueCount: items.filter((i: any) => i.daysOverdue > 0).length,
    };
  }

  /** История погашений (Wipon: сумма погашения, тип оплаты, дата, остаток). */
  async paymentHistory(accountId: string, counterpartyId?: string, limit = 100) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT m.ts, m.amount, m.payment_method, m.comment, c.name, c.iin_bin, c.phone,
                e.first_name AS employee
           FROM balance_move m
           JOIN counterparty c ON c.id = m.counterparty_id
           LEFT JOIN employee e ON e.id = m.employee_id
          WHERE m.reason = 'debt_payment' AND ($1::uuid IS NULL OR m.counterparty_id = $1)
          ORDER BY m.ts DESC LIMIT $2`, [counterpartyId ?? null, limit]);
      // в базе погашение хранится со знаком «минус» — в истории показываем сумму
      return rows.map((r: any) => ({ ...r, amount: Math.abs(Number(r.amount)) }));
    });
  }

  /** Мы должны поставщику: приёмка без оплаты. */
  async recordSupplyDebt(accountId: string, dto: { counterpartyId: string; docId: string; amount: number; employeeId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM apply_balance_move($1,$2,$3::numeric,'supply',NULL,$4,NULL,$5,NULL,NULL,NULL)`,
        [accountId, dto.counterpartyId, -dto.amount, dto.docId, dto.employeeId ?? null]);
      return { moveId: rows[0].move_id, weOwe: Math.abs(Number(rows[0].new_balance)) };
    });
  }

  async paySupplier(accountId: string, dto: { counterpartyId: string; amount: number; method?: 'cash' | 'card' | 'qr'; employeeId?: string; comment?: string }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const cur = (await c.query(
        `SELECT b.balance, c.name FROM counterparty_balance b JOIN counterparty c ON c.id=b.counterparty_id
          WHERE b.counterparty_id=$1 FOR UPDATE`, [dto.counterpartyId])).rows[0];
      if (!cur) throw new BadRequestException('Контрагент не найден');
      const owe = -Number(cur.balance);
      if (owe <= 0) throw new BadRequestException(`«${cur.name}» ничего не должны`);
      if (dto.amount > owe) throw new BadRequestException(`Долг перед «${cur.name}» — ${owe} ₸, платёж ${dto.amount} ₸ больше`);

      const { rows } = await c.query(
        `SELECT * FROM apply_balance_move($1,$2,$3::numeric,'supply_payment',NULL,NULL,$4::pay_method,$5,NULL,$6,NULL)`,
        [accountId, dto.counterpartyId, dto.amount, dto.method ?? 'cash', dto.employeeId ?? null, dto.comment ?? null]);
      const left = -Number(rows[0].new_balance);
      return { paid: dto.amount, leftToPay: Math.max(0, left), closed: left <= 0 };
    });
  }

  // ==================================================================
  // 6.3 АКТ СВЕРКИ (модель МС)
  // ==================================================================
  async reconciliationAct(accountId: string, counterpartyId: string, from: string, to: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cp = (await c.query(`SELECT name, iin_bin, full_name FROM counterparty WHERE id=$1`, [counterpartyId])).rows[0];
      if (!cp) throw new BadRequestException('Контрагент не найден');
      const org = (await c.query(`SELECT name FROM account LIMIT 1`)).rows[0];

      const { rows } = await c.query(`SELECT * FROM reconciliation_act($1,$2,$3::timestamptz,$4::timestamptz)`,
        [accountId, counterpartyId, from, to]);

      const opening = Number(rows[0]?.running ?? 0);
      const lines = rows.slice(1).map((r: any) => ({
        ts: r.ts, reason: r.reason, ref: r.doc_ref,
        debit: r.debit == null ? null : Number(r.debit),
        credit: r.credit == null ? null : Number(r.credit),
        running: Number(r.running), comment: r.comment,
      }));
      const closing = lines.length ? lines[lines.length - 1].running : opening;

      return {
        organization: org?.name, counterparty: { name: cp.name, iinBin: cp.iin_bin, fullName: cp.full_name },
        period: { from, to },
        openingBalance: opening,
        lines,
        closingBalance: closing,
        turnoverDebit: lines.reduce((s: number, l: any) => s + (l.debit ?? 0), 0),
        turnoverCredit: lines.reduce((s: number, l: any) => s + (l.credit ?? 0), 0),
        conclusion: closing > 0
          ? `Задолженность «${cp.name}» перед нами: ${closing} ₸`
          : closing < 0 ? `Наша задолженность перед «${cp.name}»: ${-closing} ₸`
          : 'Взаиморасчёты закрыты',
      };
    });
  }

  // ==================================================================
  // 6.4 ЗАКАЗЫ ПОСТАВЩИКАМ
  // Правило МС дословно: «Заказы поставщикам не меняют количество товара
  // на складе» — количество меняет только приёмка.
  // ==================================================================
  async createOrder(accountId: string, dto: {
    counterpartyId?: string; warehouseId?: string; employeeId?: string;
    comment?: string; expectedAt?: string; createdFrom?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const wh = dto.warehouseId ?? (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0]?.id;
      const num = (await c.query(`SELECT next_po_number($1) AS n`, [accountId])).rows[0].n;
      const { rows } = await c.query(
        `INSERT INTO purchase_order (account_id, number, counterparty_id, warehouse_id, employee_id,
                                     comment, expected_at, created_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [accountId, num, dto.counterpartyId ?? null, wh, dto.employeeId ?? null,
         dto.comment ?? null, dto.expectedAt ?? null, dto.createdFrom ?? null]);
      return rows[0];
    });
  }

  async addOrderItem(accountId: string, orderId: string, item: { productId: string; qty: number; price?: number; packageId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(`SELECT status FROM purchase_order WHERE id=$1 AND deleted_at IS NULL`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      if (o.status === 'received') throw new BadRequestException('Заказ уже принят — изменить нельзя');

      let qty = item.qty;
      if (item.packageId) {
        const pkg = (await c.query(`SELECT quantity FROM package WHERE id=$1`, [item.packageId])).rows[0];
        if (!pkg) throw new BadRequestException('Упаковка не найдена');
        qty = item.qty * Number(pkg.quantity);      // заказываем блоками, приходят пачки
      }
      const price = item.price ?? Number((await c.query(`SELECT purchase_price FROM product WHERE id=$1`, [item.productId])).rows[0]?.purchase_price ?? 0);

      await c.query(
        `INSERT INTO purchase_order_item (account_id, order_id, product_id, package_id, qty, price)
         VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric)
         ON CONFLICT (order_id, product_id) DO UPDATE SET qty = purchase_order_item.qty + EXCLUDED.qty`,
        [accountId, orderId, item.productId, item.packageId ?? null, qty, price]);
      // Пересчёт и чтение — в ТОМ ЖЕ соединении. Вложенный withTenant взял бы
      // другое соединение из пула и не увидел бы незакоммиченную вставку:
      // сумма заказа возвращалась без последней позиции.
      const { rows } = await c.query(
        `UPDATE purchase_order SET total_sum = coalesce((SELECT sum(qty*coalesce(price,0))
           FROM purchase_order_item WHERE order_id=$1),0) WHERE id=$1 RETURNING *`, [orderId]);
      const items = (await c.query(
        `SELECT i.*, p.name FROM purchase_order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=$1`,
        [orderId])).rows;
      return {
        ...rows[0], total_sum: Number(rows[0].total_sum),
        items: items.map((i: any) => ({ ...i, qty: Number(i.qty), price: Number(i.price ?? 0) })),
      };
    });
  }

  /** Заказ по плану пополнения из 3.7: система уже знает, чего не хватает. */
  async createOrderFromReplenishment(accountId: string, dto: {
    warehouseId: string; counterpartyId?: string; employeeId?: string;
  }) {
    const plan = await this.db.raw(`SELECT * FROM replenishment_plan($1,$2)`, [accountId, dto.warehouseId]);
    let rows = plan.rows;
    // если задан поставщик — берём только его товары
    if (dto.counterpartyId) {
      const mine = await this.db.withTenant(accountId, async (c) =>
        (await c.query(`SELECT id FROM product WHERE supplier_id=$1`, [dto.counterpartyId])).rows.map((r: any) => r.id));
      rows = rows.filter((r: any) => mine.includes(r.product_id));
    }
    if (!rows.length) return { created: false, reason: 'Нечего заказывать — всё выше неснижаемого остатка' };

    const order = await this.createOrder(accountId, {
      counterpartyId: dto.counterpartyId, warehouseId: dto.warehouseId, employeeId: dto.employeeId,
      comment: 'Пополнение до неснижаемого остатка', createdFrom: 'replenishment',
    });
    for (const r of rows) await this.addOrderItem(accountId, order.id, { productId: r.product_id, qty: Number(r.to_order) });
    return { created: true, orderId: order.id, number: order.number, items: rows.length };
  }

  async sendOrder(accountId: string, orderId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const items = (await c.query(`SELECT count(*)::int n FROM purchase_order_item WHERE order_id=$1`, [orderId])).rows[0].n;
      if (!items) throw new BadRequestException('В заказе нет позиций');
      const { rows } = await c.query(
        `UPDATE purchase_order SET status='sent', sent_at=now() WHERE id=$1 AND status='draft' RETURNING *`, [orderId]);
      if (!rows[0]) throw new BadRequestException('Отправить можно только черновик');
      return rows[0];
    });
  }

  /**
   * Приёмка одним нажатием (у МС это «создать документ на основании»).
   * Создаёт черновик приёмки с позициями заказа — владелец сверяет с
   * накладной и проводит.
   */
  async receiveOrder(accountId: string, orderId: string, employeeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(`SELECT * FROM purchase_order WHERE id=$1 AND deleted_at IS NULL`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      if (o.status === 'received') throw new BadRequestException(`Заказ уже принят документом №${o.received_doc_id}`);
      if (o.status === 'cancelled') throw new BadRequestException('Заказ отменён');

      const items = (await c.query(`SELECT * FROM purchase_order_item WHERE order_id=$1`, [orderId])).rows;
      if (!items.length) throw new BadRequestException('В заказе нет позиций');

      const num = (await c.query(`SELECT next_doc_number($1,'supply') AS n`, [accountId])).rows[0].n;
      const doc = (await c.query(
        `INSERT INTO stock_doc (account_id, kind, number, warehouse_id, supplier_id, employee_id, comment)
         VALUES ($1,'supply',$2,$3,$4,$5,$6) RETURNING *`,
        [accountId, num, o.warehouse_id, o.counterparty_id, employeeId ?? o.employee_id,
         `Приёмка по заказу №${o.number}`])).rows[0];

      for (const it of items) {
        await c.query(
          `INSERT INTO stock_doc_item (account_id, doc_id, product_id, package_id, qty, price)
           VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric)`,
          [accountId, doc.id, it.product_id, it.package_id, it.qty, it.price]);
      }
      await c.query(
        `UPDATE stock_doc SET total_sum = coalesce((SELECT sum(qty*coalesce(price,0))
           FROM stock_doc_item WHERE doc_id=$1),0) WHERE id=$1`, [doc.id]);
      await c.query(`UPDATE purchase_order SET status='received', received_doc_id=$2 WHERE id=$1`, [orderId, doc.id]);

      return {
        docId: doc.id, docNumber: doc.number, items: items.length,
        // правило МС дословно: заказ не меняет остаток, меняет приёмка
        note: 'Создан черновик приёмки. Сверьте с накладной и проведите — только тогда изменится остаток.',
      };
    });
  }

  async order(accountId: string, orderId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(
        `SELECT po.*, c.name AS supplier, w.name AS warehouse, d.number AS received_doc_number
           FROM purchase_order po
           LEFT JOIN counterparty c ON c.id = po.counterparty_id
           LEFT JOIN warehouse w ON w.id = po.warehouse_id
           LEFT JOIN stock_doc d ON d.id = po.received_doc_id
          WHERE po.id=$1`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      const items = (await c.query(
        `SELECT i.*, p.name FROM purchase_order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=$1`,
        [orderId])).rows;
      return { ...o, total_sum: Number(o.total_sum), items: items.map((i: any) => ({ ...i, qty: Number(i.qty), price: Number(i.price ?? 0) })) };
    });
  }

  async orders(accountId: string, status?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT po.id, po.number, po.status, po.total_sum, po.expected_at, po.created_at, po.created_from,
                c.name AS supplier, (SELECT count(*) FROM purchase_order_item i WHERE i.order_id = po.id) AS items
           FROM purchase_order po LEFT JOIN counterparty c ON c.id = po.counterparty_id
          WHERE po.deleted_at IS NULL AND ($1::text IS NULL OR po.status::text = $1)
          ORDER BY po.created_at DESC LIMIT 100`, [status ?? null])).rows);
  }

  /** Уведомление о просроченных долгах (механика из 3.7 — не спамим одинаковым). */
  async buildDebtNotification(accountId: string, employeeId: string) {
    const book = await this.debtBook(accountId, true);
    if (!book.items.length) return { created: false, reason: 'Просроченных долгов нет' };

    return this.db.withTenant(accountId, async (c) => {
      const names = book.items.map((i: any) => `${i.name} (${i.debt} ₸, ${i.daysOverdue} дн.)`).join(', ');
      const fp = book.items.map((i: any) => `${i.counterpartyId}:${i.debt}`).sort().join(',');

      const last = (await c.query(
        `SELECT fingerprint, created_at FROM notification
          WHERE kind='low_stock' AND payload->>'type'='debt' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      if (last && last.fingerprint === fp && new Date(last.created_at) > new Date(Date.now() - 3 * 86400000))
        return { created: false, reason: 'Список не изменился — не спамим' };

      await c.query(
        `INSERT INTO notification (account_id, employee_id, kind, title, body, link, fingerprint, payload)
         VALUES ($1,$2,'low_stock',$3,$4,'/debts?filter=overdue',$5,$6)`,
        [accountId, employeeId, `Просроченные долги: ${book.items.length}`,
         `Не вернули вовремя: ${names.slice(0, 400)}`, fp, JSON.stringify({ type: 'debt', count: book.items.length })]);
      return { created: true, count: book.items.length, total: book.total };
    });
  }
}
