import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';

/**
 * ФИНАНСЫ.
 *
 * Деньги — сумма движений, а не поле с балансом. Третий раз тот же принцип:
 * остатки (1.3), долги (Часть 6), теперь деньги.
 *
 * Две вещи здесь сделаны иначе, чем у конкурентов, и обе — сознательно:
 *
 * 1. Инкассация — ПЕРЕВОД между счетами, а не расход. UMAG относит её к
 *    операционным расходам, из-за чего магазин выглядит тем убыточнее, чем
 *    чаще владелец возит выручку в банк. Деньги не исчезли — они переехали.
 *
 * 2. Комиссия эквайринга считается. Пробили 10 000 картой, банк удержал 2% —
 *    на счёт пришло 9800. Ни один из троих этого не видит, а это прямой
 *    минус из прибыли магазина каждый день.
 */

export type MoveKind = 'income' | 'expense' | 'owner_draw' | 'owner_deposit' | 'correction';

@Injectable()
export class FinanceService {
  constructor(private db: DbService) {}

  // ==================================================================
  // 7.1 СЧЕТА
  // ==================================================================
  async createAccount(accountId: string, dto: {
    kind?: 'cash' | 'bank' | 'ewallet'; name: string; storeId?: string; cashRegisterId?: string;
    bankName?: string; iik?: string; bik?: string; kbe?: string; openingBalance?: number; isDefault?: boolean;
  }) {
    if (!dto.name?.trim()) throw new BadRequestException('Название счёта обязательно');
    return this.db.withTenant(accountId, async (c) => {
      if (dto.isDefault)
        await c.query(`UPDATE fin_account SET is_default=false WHERE account_id=$1 AND kind=$2::fin_account_kind`,
          [accountId, dto.kind ?? 'cash']);
      const { rows } = await c.query(
        `INSERT INTO fin_account (account_id, kind, name, store_id, cash_register_id,
                                  bank_name, iik, bik, kbe, opening_balance, is_default)
         VALUES ($1,$2::fin_account_kind,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11) RETURNING *`,
        [accountId, dto.kind ?? 'cash', dto.name.trim(), dto.storeId ?? null, dto.cashRegisterId ?? null,
         dto.bankName ?? null, dto.iik ?? null, dto.bik ?? null, dto.kbe ?? null,
         dto.openingBalance ?? 0, dto.isDefault ?? false]);
      await c.query(
        `INSERT INTO fin_balance (fin_account_id, account_id, balance) VALUES ($1,$2,$3::numeric)
         ON CONFLICT DO NOTHING`, [rows[0].id, accountId, dto.openingBalance ?? 0]);
      return rows[0];
    });
  }

  /** Сколько у меня денег и где. */
  async accounts(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.kind, a.name, a.bank_name, a.iik, a.bik, a.kbe, a.is_default,
                coalesce(b.balance, a.opening_balance) AS balance, s.name AS store
           FROM fin_account a
           LEFT JOIN fin_balance b ON b.fin_account_id = a.id
           LEFT JOIN store s ON s.id = a.store_id
          WHERE a.deleted_at IS NULL AND a.is_active
          ORDER BY a.kind, a.name`);
      const items = rows.map((r: any) => ({
        ...r, balance: Number(r.balance),
        // Отрицательный остаток физически невозможен: в ящике не бывает
        // «минус 3000 ₸». Значит учёт разошёлся с реальностью — например,
        // возврат покупателю пробили после того, как всю выручку
        // инкассировали. Молчать об этом нельзя: владелец должен разобраться,
        // пока помнит день.
        negative: Number(r.balance) < 0,
      }));
      const problems = items.filter((i: any) => i.negative);
      return {
        items,
        totalCash: items.filter((i: any) => i.kind === 'cash').reduce((s: number, i: any) => s + i.balance, 0),
        totalBank: items.filter((i: any) => i.kind !== 'cash').reduce((s: number, i: any) => s + i.balance, 0),
        total: items.reduce((s: number, i: any) => s + i.balance, 0),
        warnings: problems.map((p: any) =>
          `На счёте «${p.name}» отрицательный остаток ${p.balance} ₸ — так не бывает. ` +
          `Проверьте, всё ли внесено: возможно, возврат отдали уже после инкассации.`),
      };
    });
  }

  /**
   * Способ оплаты → счёт (модель Wipon) + комиссия эквайринга.
   * Без этой привязки вопрос «сколько у меня денег» не имеет ответа.
   */
  async bindPaymentMethod(accountId: string, dto: {
    method: 'cash' | 'card' | 'qr' | 'credit'; finAccountId: string; storeId?: string;
    acquiringPercent?: number; acquiringFixed?: number; settlementDays?: number;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO payment_method_account (account_id, method, store_id, fin_account_id,
                                             acquiring_percent, acquiring_fixed, settlement_days)
         VALUES ($1,$2::pay_method,$3,$4,$5::numeric,$6::numeric,$7)
         ON CONFLICT (account_id, method, store_id) DO UPDATE
           SET fin_account_id = EXCLUDED.fin_account_id,
               acquiring_percent = EXCLUDED.acquiring_percent,
               acquiring_fixed = EXCLUDED.acquiring_fixed,
               settlement_days = EXCLUDED.settlement_days
         RETURNING *`,
        [accountId, dto.method, dto.storeId ?? null, dto.finAccountId,
         dto.acquiringPercent ?? 0, dto.acquiringFixed ?? 0, dto.settlementDays ?? 1]);
      return rows[0];
    });
  }

  // ==================================================================
  // 7.3 СТАТЬИ ДОХОДОВ И РАСХОДОВ
  // (Wipon: «Категории денежных движений»; у МС статья «в разработке»)
  // ==================================================================
  async createCategory(accountId: string, dto: { direction: 'in' | 'out'; name: string; isOperating?: boolean }) {
    if (!dto.name?.trim()) throw new BadRequestException('Название статьи обязательно');
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO fin_category (account_id, direction, name, is_operating)
         VALUES ($1,$2::fin_direction,$3,$4)
         ON CONFLICT (account_id, direction, name) DO UPDATE SET deleted_at = NULL
         RETURNING *`,
        [accountId, dto.direction, dto.name.trim(), dto.isOperating ?? true]);
      return rows[0];
    });
  }

  async categories(accountId: string, direction?: 'in' | 'out') {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, direction, name, is_operating, is_system FROM fin_category
          WHERE deleted_at IS NULL AND ($1::text IS NULL OR direction::text = $1)
          ORDER BY sort_order, name`, [direction ?? null])).rows);
  }

  // ==================================================================
  // 7.2 ПЛАТЕЖИ
  // ==================================================================

  /**
   * Расход по статье. Дата начисления — модель МС: «оплатили аренду за апрель
   * в марте» → расход относится к апрелю. У МоегоСклада это платная опция.
   */
  async expense(accountId: string, dto: {
    finAccountId?: string; amount: number; categoryId?: string; counterpartyId?: string;
    comment?: string; employeeId?: string; accrualDate?: string; ts?: string;
  }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма расхода должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const acc = await this.resolveAccount(c, dto.finAccountId, 'cash');
      const bal = (await c.query(`SELECT balance FROM fin_balance WHERE fin_account_id=$1`, [acc])).rows[0];
      if (bal && Number(bal.balance) < dto.amount) {
        const a = (await c.query(`SELECT name FROM fin_account WHERE id=$1`, [acc])).rows[0];
        throw new BadRequestException(`На счёте «${a?.name}» только ${Number(bal.balance)} ₸ — списать ${dto.amount} ₸ нельзя`);
      }
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'expense',$4,$5,NULL,NULL,NULL,$6,$7,NULL,$8::date,$9::timestamptz)`,
        [accountId, acc, -dto.amount, dto.categoryId ?? null, dto.counterpartyId ?? null,
         dto.employeeId ?? null, dto.comment ?? null, dto.accrualDate ?? null, dto.ts ?? null]);
      return { moveId: rows[0].move_id, balance: Number(rows[0].new_balance) };
    });
  }

  async income(accountId: string, dto: {
    finAccountId?: string; amount: number; categoryId?: string; counterpartyId?: string;
    comment?: string; employeeId?: string; accrualDate?: string;
  }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма дохода должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const acc = await this.resolveAccount(c, dto.finAccountId, 'cash');
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'income',$4,$5,NULL,NULL,NULL,$6,$7,NULL,$8::date,NULL)`,
        [accountId, acc, dto.amount, dto.categoryId ?? null, dto.counterpartyId ?? null,
         dto.employeeId ?? null, dto.comment ?? null, dto.accrualDate ?? null]);
      return { moveId: rows[0].move_id, balance: Number(rows[0].new_balance) };
    });
  }

  /**
   * Перевод между своими счетами. Две половинки с общим transfer_id.
   * Прибыль от перевода не меняется — деньги просто переехали.
   */
  async transfer(accountId: string, dto: {
    fromId: string; toId: string; amount: number; comment?: string; employeeId?: string;
  }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма перевода должна быть больше нуля');
    if (dto.fromId === dto.toId) throw new BadRequestException('Счёт списания и зачисления совпадают');

    return this.db.withTenant(accountId, async (c) => {
      const from = (await c.query(
        `SELECT a.name, coalesce(b.balance, 0) AS balance FROM fin_account a
           LEFT JOIN fin_balance b ON b.fin_account_id = a.id WHERE a.id=$1`, [dto.fromId])).rows[0];
      if (!from) throw new BadRequestException('Счёт списания не найден');
      const to = (await c.query(`SELECT name FROM fin_account WHERE id=$1`, [dto.toId])).rows[0];
      if (!to) throw new BadRequestException('Счёт зачисления не найден');
      if (Number(from.balance) < dto.amount)
        throw new BadRequestException(`На «${from.name}» только ${Number(from.balance)} ₸`);

      const tid = randomUUID();
      const cm = dto.comment ?? `Перевод: ${from.name} → ${to.name}`;
      const out = (await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'transfer_out',NULL,NULL,NULL,NULL,NULL,$4,$5,$6::uuid,NULL,NULL)`,
        [accountId, dto.fromId, -dto.amount, dto.employeeId ?? null, cm, tid])).rows[0];
      const inn = (await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'transfer_in',NULL,NULL,NULL,NULL,NULL,$4,$5,$6::uuid,NULL,NULL)`,
        [accountId, dto.toId, dto.amount, dto.employeeId ?? null, cm, tid])).rows[0];

      return {
        transferId: tid, amount: dto.amount,
        from: { name: from.name, balance: Number(out.new_balance) },
        to: { name: to.name, balance: Number(inn.new_balance) },
        note: 'Перевод не влияет на прибыль — деньги переехали, а не потрачены',
      };
    });
  }

  /**
   * 7.4 ИНКАССАЦИЯ ИЗ СМЕНЫ.
   *
   * UMAG считает это операционным расходом («Инкассация: расходы, связанные с
   * изъятием денег из кассы»). Это неверно: чем чаще возишь выручку в банк,
   * тем «убыточнее» магазин. У нас — перевод касса → банк.
   */
  async collectFromShift(accountId: string, dto: {
    shiftId: string; amount: number; toAccountId?: string; employeeId?: string; comment?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const sh = (await c.query(
        `SELECT s.id, s.cash_register_id, s.store_id, s.status FROM shift s WHERE s.id=$1`, [dto.shiftId])).rows[0];
      if (!sh) throw new BadRequestException('Смена не найдена');

      // счёт кассы: сначала свой у этой кассы, потом наличный счёт точки
      const cash = (await c.query(
        `SELECT id, name FROM fin_account
          WHERE deleted_at IS NULL AND kind='cash'
            AND (cash_register_id = $1 OR store_id = $2 OR is_default)
          ORDER BY (cash_register_id = $1) DESC, (store_id = $2) DESC, is_default DESC LIMIT 1`,
        [sh.cash_register_id, sh.store_id])).rows[0];
      if (!cash) throw new BadRequestException('Нет наличного счёта для этой кассы');

      const bank = dto.toAccountId
        ? (await c.query(`SELECT id, name FROM fin_account WHERE id=$1`, [dto.toAccountId])).rows[0]
        : (await c.query(`SELECT id, name FROM fin_account WHERE kind='bank' AND deleted_at IS NULL
                           ORDER BY is_default DESC LIMIT 1`)).rows[0];
      if (!bank) throw new BadRequestException('Нет банковского счёта — создайте его');

      const bal = Number((await c.query(`SELECT balance FROM fin_balance WHERE fin_account_id=$1`, [cash.id])).rows[0]?.balance ?? 0);
      if (bal < dto.amount) throw new BadRequestException(`В кассе ${bal} ₸ — инкассировать ${dto.amount} ₸ нельзя`);

      const tid = randomUUID();
      const cm = dto.comment ?? 'Инкассация из смены';
      await c.query(
        `SELECT apply_fin_move($1,$2,$3::numeric,'transfer_out',NULL,NULL,NULL,NULL,$4,$5,$6,$7::uuid,NULL,NULL)`,
        [accountId, cash.id, -dto.amount, dto.shiftId, dto.employeeId ?? null, cm, tid]);
      const inn = (await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'transfer_in',NULL,NULL,NULL,NULL,$4,$5,$6,$7::uuid,NULL,NULL)`,
        [accountId, bank.id, dto.amount, dto.shiftId, dto.employeeId ?? null, cm, tid])).rows[0];

      // фиксируем в кассовых операциях смены (Часть 4)
      await c.query(
        `INSERT INTO cash_operation (account_id, shift_id, cash_register_id, kind, amount, comment, employee_id)
         VALUES ($1,$2,$3,'collection',$4::numeric,$5,$6)`,
        [accountId, dto.shiftId, sh.cash_register_id, dto.amount, cm, dto.employeeId ?? null]);

      return {
        transferId: tid, amount: dto.amount,
        from: cash.name, to: bank.name, bankBalance: Number(inn.new_balance),
        note: 'Это перевод, а не расход: прибыль магазина не изменилась',
      };
    });
  }

  /** Изъятие собственника — тоже не операционный расход, а вывод прибыли. */
  async ownerDraw(accountId: string, dto: { finAccountId?: string; amount: number; employeeId?: string; comment?: string }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const acc = await this.resolveAccount(c, dto.finAccountId, 'cash');
      const bal = Number((await c.query(`SELECT balance FROM fin_balance WHERE fin_account_id=$1`, [acc])).rows[0]?.balance ?? 0);
      if (bal < dto.amount) throw new BadRequestException(`На счёте ${bal} ₸ — изъять ${dto.amount} ₸ нельзя`);
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'owner_draw',NULL,NULL,NULL,NULL,NULL,$4,$5,NULL,NULL,NULL)`,
        [accountId, acc, -dto.amount, dto.employeeId ?? null, dto.comment ?? 'Изъятие собственника']);
      return {
        moveId: rows[0].move_id, balance: Number(rows[0].new_balance),
        note: 'Изъятие собственника не входит в операционные расходы — иначе непонятно, сколько заработал бизнес',
      };
    });
  }

  async ownerDeposit(accountId: string, dto: { finAccountId?: string; amount: number; employeeId?: string; comment?: string }) {
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const acc = await this.resolveAccount(c, dto.finAccountId, 'cash');
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'owner_deposit',NULL,NULL,NULL,NULL,NULL,$4,$5,NULL,NULL,NULL)`,
        [accountId, acc, dto.amount, dto.employeeId ?? null, dto.comment ?? 'Вложение собственника']);
      return { moveId: rows[0].move_id, balance: Number(rows[0].new_balance) };
    });
  }

  // ==================================================================
  // 7.5 ВЫРУЧКА И КОМИССИЯ ЭКВАЙРИНГА
  // ==================================================================

  /**
   * Разнести чек по счетам. Вызывается после оплаты.
   *
   * Здесь считается комиссия эквайринга: в чеке 10 000, банк удержал 2%,
   * на счёт пришло 9800. Ни UMAG, ни Wipon, ни МойСклад этого не показывают —
   * владелец не видит, что отдаёт банку каждый день.
   *
   * Долг в деньги не попадает: денег не поступило (то же правило, что и в
   * фискализации).
   */
  async postSale(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(`SELECT * FROM sale WHERE id=$1 AND status IN ('completed','returned')`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден или не пробит');

      const done = (await c.query(
        `SELECT 1 FROM fin_move WHERE sale_id=$1 AND kind IN ('sale','refund') LIMIT 1`, [saleId])).rows[0];
      if (done) return { posted: false, reason: 'Чек уже разнесён' };   // идемпотентность

      const isRefund = !!s.return_of_id;
      const pays = (await c.query(`SELECT method, amount FROM sale_payment WHERE sale_id=$1`, [saleId])).rows;
      const rows: any[] = pays.length ? pays : [
        ...(Number(s.paid_cash) ? [{ method: 'cash', amount: s.paid_cash }] : []),
        ...(Number(s.paid_card) ? [{ method: 'card', amount: s.paid_card }] : []),
        ...(Number(s.paid_qr) ? [{ method: 'qr', amount: s.paid_qr }] : []),
      ];

      const result: any = { posted: true, lines: [], acquiringFee: 0 };
      for (const p of rows) {
        // долг деньгами не является: денег не поступало
        if (p.method === 'credit' || p.method === 'bonus') continue;

        const bind = (await c.query(
          `SELECT pma.*, fa.name FROM payment_method_account pma
             JOIN fin_account fa ON fa.id = pma.fin_account_id
            WHERE pma.method = $1::pay_method AND (pma.store_id = $2 OR pma.store_id IS NULL)
            ORDER BY pma.store_id NULLS LAST LIMIT 1`, [p.method, s.store_id])).rows[0];

        const finAccount = bind?.fin_account_id ?? await this.resolveAccount(c, undefined, p.method === 'cash' ? 'cash' : 'bank');
        const gross = Number(p.amount) * (isRefund ? -1 : 1);

        await c.query(
          `SELECT apply_fin_move($1,$2,$3::numeric,$4::fin_move_kind,NULL,$5,$6,NULL,$7,$8,NULL,NULL,NULL,$9::timestamptz)`,
          [accountId, finAccount, gross, isRefund ? 'refund' : 'sale', s.customer_id, saleId,
           s.shift_id, s.employee_id, s.completed_at]);
        result.lines.push({ method: p.method, amount: gross, account: bind?.name });

        // комиссия банка: на счёт пришло меньше, чем пробито
        const pct = Number(bind?.acquiring_percent ?? 0);
        const fix = Number(bind?.acquiring_fixed ?? 0);
        if (!isRefund && (pct > 0 || fix > 0)) {
          const fee = Math.round((Number(p.amount) * pct / 100 + fix) * 100) / 100;
          if (fee > 0) {
            await c.query(
              `SELECT apply_fin_move($1,$2,$3::numeric,'acquiring_fee',NULL,NULL,$4,NULL,$5,NULL,$6,NULL,NULL,$7::timestamptz)`,
              [accountId, finAccount, -fee, saleId, s.shift_id,
               `Комиссия банка ${pct}% с ${Number(p.amount)} ₸`, s.completed_at]);
            result.acquiringFee += fee;
          }
        }
      }
      return result;
    });
  }

  /** Погашение долга покупателем — это уже настоящие деньги. */
  async postDebtPayment(accountId: string, dto: {
    counterpartyId: string; amount: number; method?: 'cash' | 'card' | 'qr';
    employeeId?: string; shiftId?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const bind = (await c.query(
        `SELECT fin_account_id FROM payment_method_account WHERE method=$1::pay_method
          ORDER BY store_id NULLS LAST LIMIT 1`, [dto.method ?? 'cash'])).rows[0];
      const acc = bind?.fin_account_id ?? await this.resolveAccount(c, undefined, dto.method === 'cash' || !dto.method ? 'cash' : 'bank');
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'debt_payment',NULL,$4,NULL,NULL,$5,$6,'Погашение долга',NULL,NULL,NULL)`,
        [accountId, acc, dto.amount, dto.counterpartyId, dto.shiftId ?? null, dto.employeeId ?? null]);
      return { moveId: rows[0].move_id, balance: Number(rows[0].new_balance) };
    });
  }

  async postSupplierPayment(accountId: string, dto: {
    counterpartyId: string; amount: number; method?: 'cash' | 'card' | 'qr'; employeeId?: string; docId?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const acc = await this.resolveAccount(c, undefined, dto.method === 'cash' || !dto.method ? 'cash' : 'bank');
      const bal = Number((await c.query(`SELECT balance FROM fin_balance WHERE fin_account_id=$1`, [acc])).rows[0]?.balance ?? 0);
      if (bal < dto.amount) throw new BadRequestException(`На счёте ${bal} ₸ — заплатить ${dto.amount} ₸ нечем`);
      const { rows } = await c.query(
        `SELECT * FROM apply_fin_move($1,$2,$3::numeric,'supply_payment',NULL,$4,NULL,$5,NULL,$6,'Оплата поставщику',NULL,NULL,NULL)`,
        [accountId, acc, -dto.amount, dto.counterpartyId, dto.docId ?? null, dto.employeeId ?? null]);
      return { moveId: rows[0].move_id, balance: Number(rows[0].new_balance) };
    });
  }

  // ==================================================================
  // 7.6 ОТЧЁТЫ
  // ==================================================================

  /**
   * ДДС. У UMAG три колонки (Закупы, Расходы, Вложения) — этого мало, чтобы
   * понять, куда делись деньги. Даём по статьям, с остатком на начало и конец.
   */
  async cashFlow(accountId: string, from: string, to: string, finAccountId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(`SELECT * FROM cash_flow($1,$2::timestamptz,$3::timestamptz,$4)`,
        [accountId, from, to, finAccountId ?? null]);

      const opening = Number((await c.query(
        `SELECT coalesce(sum(m.amount), 0) + coalesce((SELECT sum(opening_balance) FROM fin_account
            WHERE deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2)), 0) AS v
           FROM fin_move m WHERE m.ts < $1::timestamptz AND ($2::uuid IS NULL OR m.fin_account_id = $2)`,
        [from, finAccountId ?? null])).rows[0].v);

      const inflow = rows.filter((r: any) => Number(r.amount) > 0)
        .map((r: any) => ({ kind: r.kind, category: r.category, amount: Number(r.amount), ops: r.ops }));
      const outflow = rows.filter((r: any) => Number(r.amount) < 0)
        .map((r: any) => ({ kind: r.kind, category: r.category, amount: Math.abs(Number(r.amount)), ops: r.ops }));

      const totalIn = inflow.reduce((s: number, r: any) => s + r.amount, 0);
      const totalOut = outflow.reduce((s: number, r: any) => s + r.amount, 0);

      return {
        period: { from, to },
        openingBalance: opening,
        inflow, outflow,
        totalIn, totalOut,
        netFlow: totalIn - totalOut,
        closingBalance: opening + totalIn - totalOut,
      };
    });
  }

  /**
   * Прибыли и убытки — структура UMAG, методология исправлена.
   * Инкассация и изъятия собственника в операционные расходы не входят.
   */
  async profitLoss(accountId: string, from: string, to: string) {
    const { rows } = await this.db.raw(`SELECT * FROM profit_loss($1,$2::timestamptz,$3::timestamptz)`,
      [accountId, from, to]);
    const r = rows[0];
    const n = (v: any) => Number(v ?? 0);

    const byCategory = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT coalesce(cat.name, 'Без статьи') AS name, sum(-m.amount) AS amount
           FROM fin_move m LEFT JOIN fin_category cat ON cat.id = m.category_id
          WHERE m.kind = 'expense' AND coalesce(cat.is_operating, true)
            AND coalesce(m.accrual_date, m.ts::date) >= $1::date
            AND coalesce(m.accrual_date, m.ts::date) <= $2::date
          GROUP BY cat.name ORDER BY 2 DESC`, [from, to])).rows);

    return {
      period: { from, to },
      // Выручка = Продажи − Возврат; Продажи = Наличные + Безнал + В долг (формула UMAG)
      revenue: {
        cash: n(r.sales_cash), card: n(r.sales_card), qr: n(r.sales_qr), credit: n(r.sales_credit),
        sales: n(r.sales_total), refunds: n(r.refunds), total: n(r.revenue),
      },
      cost: { sold: n(r.cost_sold), returned: n(r.cost_returned), total: n(r.cost_total) },
      grossProfit: n(r.gross_profit),
      operatingExpenses: {
        total: n(r.opex),
        byCategory: byCategory.map((b: any) => ({ name: b.name, amount: Number(b.amount) })),
      },
      // то, чего нет ни у кого из троих
      acquiringFees: n(r.acquiring),
      writeOffs: n(r.writeoffs),
      netProfit: n(r.net_profit),
      marginPercent: n(r.margin_percent),
      note: 'Инкассация и изъятия собственника в расходы не включены: деньги переехали, а не потрачены',
    };
  }

  /** История операций по счёту. */
  async history(accountId: string, f: { finAccountId?: string; from?: string; to?: string; kind?: string; limit?: number } = {}) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT m.ts, m.kind, m.amount, m.comment, m.accrual_date,
                a.name AS account, cat.name AS category, cp.name AS counterparty,
                e.first_name AS employee, s.number AS sale_number
           FROM fin_move m
           JOIN fin_account a ON a.id = m.fin_account_id
           LEFT JOIN fin_category cat ON cat.id = m.category_id
           LEFT JOIN counterparty cp ON cp.id = m.counterparty_id
           LEFT JOIN employee e ON e.id = m.employee_id
           LEFT JOIN sale s ON s.id = m.sale_id
          WHERE ($1::uuid IS NULL OR m.fin_account_id = $1)
            AND ($2::timestamptz IS NULL OR m.ts >= $2)
            AND ($3::timestamptz IS NULL OR m.ts <= $3)
            AND ($4::text IS NULL OR m.kind::text = $4)
          ORDER BY m.ts DESC LIMIT $5`,
        [f.finAccountId ?? null, f.from ?? null, f.to ?? null, f.kind ?? null, Math.min(f.limit ?? 100, 500)])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount) })));
  }

  private async resolveAccount(c: any, id: string | undefined, kind: 'cash' | 'bank') {
    if (id) return id;
    const r = (await c.query(
      `SELECT id FROM fin_account WHERE kind=$1::fin_account_kind AND deleted_at IS NULL AND is_active
        ORDER BY is_default DESC LIMIT 1`, [kind])).rows[0];
    if (!r) throw new BadRequestException(`Нет счёта типа «${kind === 'cash' ? 'касса' : 'банк'}»`);
    return r.id;
  }
}
