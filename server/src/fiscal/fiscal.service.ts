import { Injectable, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { FiscalProvider, MockProvider, WebKassaProvider, ReKassaProvider, FiscalSaleRequest, FiscalCredentials } from './provider';
import { renderReceipt, ReceiptData } from './escpos';

/**
 * ФИСКАЛИЗАЦИЯ.
 *
 * Режимы — модель Wipon (4 штуки + исключения). Отложенная фискализация —
 * тоже Wipon: «в офлайне... после перехода в онлайн автоматически пробивается
 * фискальный признак». Мы делаем это надёжнее: очередь с повторами, а не
 * одна попытка при подключении.
 *
 * Чек выдан покупателю и деньги взяты ДО фискализации — иначе касса встанет
 * при первом обрыве связи, а магазин у дома без интернета живёт неделями.
 */
@Injectable()
export class FiscalService {
  private providers = new Map<string, FiscalProvider>();

  constructor(private db: DbService) {
    this.providers.set('webkassa', new WebKassaProvider());
    this.providers.set('rekassa', new ReKassaProvider());
    this.providers.set('mock', new MockProvider());
  }

  /** Подмена оператора — для тестов и демо-режима. */
  setProvider(name: string, p: FiscalProvider) { this.providers.set(name, p); }
  getProvider(name: string) { return this.providers.get(name); }

  // ==================================================================
  // НАСТРОЙКА ККМ
  // ==================================================================
  async registerKkm(accountId: string, dto: {
    cashRegisterId: string; provider: 'webkassa' | 'rekassa' | 'kaspi' | 'mock' | 'none';
    mode?: 'all' | 'cash_only' | 'card_only' | 'off';
    regNumber?: string; serialNumber?: string; kkmId?: string;
    apiLogin?: string; apiPassword?: string; apiUrl?: string;
    allowCashlessFiscal?: boolean; allowCashFiscal?: boolean; vatEnabled?: boolean;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const reg = (await c.query(`SELECT store_id FROM cash_register WHERE id=$1`, [dto.cashRegisterId])).rows[0];
      if (!reg) throw new BadRequestException('Касса не найдена');
      const prov = dto.provider === 'mock' ? 'none' : dto.provider;   // 'mock' в базе не храним
      // Идемпотентно: у кассы одна активная ККМ (уникальный индекс). Повторное
      // сохранение настроек ОБНОВЛЯЕТ её, а не плодит дубли — иначе владелец,
      // дописав РНМ, получил бы вторую запись, а проверенная связь осталась бы
      // на «старой». Обновление сохраняет уже пройденную проверку связи.
      const existing = (await c.query(
        `SELECT id FROM kkm WHERE cash_register_id=$1 AND is_active AND deleted_at IS NULL`,
        [dto.cashRegisterId])).rows[0];
      const params = [accountId, dto.cashRegisterId, reg.store_id, prov, dto.mode ?? 'all',
        dto.regNumber ?? null, dto.serialNumber ?? null, dto.kkmId ?? null,
        dto.apiLogin ?? null, dto.apiPassword ?? null, dto.apiUrl ?? null,
        dto.allowCashlessFiscal ?? false, dto.allowCashFiscal ?? true, dto.vatEnabled ?? true,
        JSON.stringify({ providerImpl: dto.provider })];
      if (existing) {
        const { rows } = await c.query(
          `UPDATE kkm SET provider=$1::fiscal_provider, mode=$2::fiscal_mode, reg_number=$3,
                  serial_number=$4, kkm_id=$5, api_login=$6, api_password_enc=$7, api_url=$8,
                  allow_cashless_fiscal=$9, allow_cash_fiscal=$10, vat_enabled=$11, extra=$12
             WHERE id=$13 RETURNING *`,
          [prov, dto.mode ?? 'all', dto.regNumber ?? null, dto.serialNumber ?? null, dto.kkmId ?? null,
           dto.apiLogin ?? null, dto.apiPassword ?? null, dto.apiUrl ?? null,
           dto.allowCashlessFiscal ?? false, dto.allowCashFiscal ?? true, dto.vatEnabled ?? true,
           JSON.stringify({ providerImpl: dto.provider }), existing.id]);
        return rows[0];
      }
      const { rows } = await c.query(
        `INSERT INTO kkm (account_id, cash_register_id, store_id, provider, mode, reg_number, serial_number,
                          kkm_id, api_login, api_password_enc, api_url, allow_cashless_fiscal, allow_cash_fiscal,
                          vat_enabled, connected_at, extra)
         VALUES ($1,$2,$3,$4::fiscal_provider,$5::fiscal_mode,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15) RETURNING *`,
        params);
      return rows[0];
    });
  }

  private credOf(kkm: any): FiscalCredentials {
    return { login: kkm.api_login, password: kkm.api_password_enc, apiUrl: kkm.api_url,
             kkmId: kkm.kkm_id, serialNumber: kkm.serial_number, extra: kkm.extra };
  }
  private implOf(kkm: any): FiscalProvider | undefined {
    const name = kkm.extra?.providerImpl ?? kkm.provider;
    return this.providers.get(name);
  }

  // ==================================================================
  // ПОСТАНОВКА ЧЕКА В ОЧЕРЕДЬ.
  // Вызывается сразу после оплаты — в том числе когда чек приехал из офлайна.
  // ==================================================================
  async enqueueSale(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const sale = (await c.query(`SELECT * FROM sale WHERE id=$1 AND status IN ('completed','returned')`, [saleId])).rows[0];
      if (!sale) throw new BadRequestException('Чек не найден или не пробит');

      const kkm = (await c.query(
        `SELECT * FROM kkm WHERE cash_register_id=$1 AND is_active AND deleted_at IS NULL`, [sale.cash_register_id])).rows[0];
      if (!kkm || kkm.provider === 'none' && !kkm.extra?.providerImpl) {
        return { status: 'not_required', reason: 'ККМ не подключена к этой кассе' };
      }

      // таблица режимов Wipon: нужен ли этому чеку фискальный признак
      const need = (await c.query(
        `SELECT needs_fiscal($1::fiscal_mode, $2::numeric, $3::numeric, $4, $5) AS v`,
        [kkm.mode, Number(sale.paid_cash) + Number(sale.paid_qr), Number(sale.paid_card),
         kkm.allow_cashless_fiscal, kkm.allow_cash_fiscal])).rows[0].v;

      const op = sale.return_of_id ? 'refund' : 'sale';
      if (!need) {
        await c.query(
          `INSERT INTO fiscal_receipt (account_id, kkm_id, sale_id, op, status)
           VALUES ($1,$2,$3,$4::fiscal_op,'not_required') ON CONFLICT (sale_id, op) WHERE sale_id IS NOT NULL DO NOTHING`,
          [accountId, kkm.id, saleId, op]);
        return { status: 'not_required', reason: `Режим «${kkm.mode}»: этот способ оплаты не фискализируется` };
      }

      // один чек — одна фискальная операция. Двойной фискальный чек = штраф
      const { rows } = await c.query(
        `INSERT INTO fiscal_receipt (account_id, kkm_id, sale_id, op, status, next_attempt_at)
         VALUES ($1,$2,$3,$4::fiscal_op,'pending', now())
         ON CONFLICT (sale_id, op) WHERE sale_id IS NOT NULL DO NOTHING RETURNING *`,
        [accountId, kkm.id, saleId, op]);
      return rows[0] ? { status: 'pending', id: rows[0].id } : { status: 'duplicate', reason: 'Чек уже в очереди' };
    });
  }

  /** Собрать запрос к оператору из нашего чека. */
  private async buildRequest(c: PoolClient, saleId: string): Promise<FiscalSaleRequest> {
    const s = (await c.query(
      `SELECT s.*, e.first_name AS cashier FROM sale s LEFT JOIN employee e ON e.id=s.employee_id WHERE s.id=$1`,
      [saleId])).rows[0];
    const items = (await c.query(
      `SELECT i.*, p.name FROM sale_item i JOIN product p ON p.id=i.product_id WHERE i.sale_id=$1`, [saleId])).rows;
    const pays = (await c.query(`SELECT method, amount FROM sale_payment WHERE sale_id=$1`, [saleId])).rows;

    return {
      externalId: saleId,
      items: items.map((i: any) => ({
        name: i.name, qty: Number(i.qty), price: Number(i.price), total: Number(i.total),
        discount: Number(i.discount_sum) || undefined, vatRate: i.vat_rate == null ? undefined : Number(i.vat_rate),
        ntin: i.ntin ?? undefined,
      })),
      payments: pays.length ? pays.map((p: any) => ({ method: p.method, amount: Number(p.amount) }))
        : [{ method: 'cash', amount: Number(s.total) }],
      total: Number(s.total),
      discount: Number(s.discount_sum) || undefined,
      rounding: Number(s.rounding) || undefined,
      change: Number(s.change_given) || undefined,
      cashier: s.cashier ?? undefined,
      // время ПРОДАЖИ, а не отправки: чек мог сутки ждать в офлайне
      datetime: (s.completed_at ?? s.created_at).toISOString(),
      isRefund: !!s.return_of_id,
    };
  }

  /**
   * Обработка очереди. Оператор лежит — торговля не останавливается,
   * чеки ждут и повторяются с растущей паузой.
   */
  async processQueue(accountId: string, limit = 50) {
    const pending = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT fr.*, k.* , fr.id AS fr_id, k.id AS k_id FROM fiscal_receipt fr
           JOIN kkm k ON k.id = fr.kkm_id
          WHERE fr.status IN ('pending','failed')
            AND (fr.next_attempt_at IS NULL OR fr.next_attempt_at <= now())
          ORDER BY fr.created_at LIMIT $1`, [limit])).rows);

    let ok = 0, failed = 0;
    for (const row of pending) {
      const prov = this.implOf(row);
      if (!prov) { failed++; continue; }

      const req = await this.db.withTenant(accountId, async (c) => this.buildRequest(c, row.sale_id));
      const res = row.op === 'refund'
        ? await prov.registerRefund(this.credOf(row), req)
        : await prov.registerSale(this.credOf(row), req);

      await this.db.withTenant(accountId, async (c) => {
        if (res.ok) {
          await c.query(
            `UPDATE fiscal_receipt SET status='ok', fiscal_number=$2, fiscal_ticket=$3, check_url=$4,
                    response=$5, sent_at=now(), error=NULL, attempts=attempts+1 WHERE id=$1`,
            [row.fr_id, res.fiscalNumber, res.ticketNumber, res.checkUrl, JSON.stringify(res.raw ?? {})]);
          await c.query(`UPDATE sale SET fiscal_id=$2, fiscal_at=now() WHERE id=$1`, [row.sale_id, res.fiscalNumber]);
          await c.query(`UPDATE kkm SET last_ok_at=now(), offline_since=NULL WHERE id=$1`, [row.k_id]);
          ok++;
        } else {
          // временная ошибка — повторим с растущей паузой; постоянная — ждём человека
          const attempts = Number(row.attempts) + 1;
          const backoffMin = res.retryable ? Math.min(2 ** attempts, 60) : null;
          await c.query(
            `UPDATE fiscal_receipt SET status='failed', error=$2, attempts=$3,
                    next_attempt_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4 || ' minutes')::interval END
              WHERE id=$1`,
            [row.fr_id, res.error ?? 'Неизвестная ошибка', attempts, backoffMin]);
          if (res.retryable)
            await c.query(`UPDATE kkm SET offline_since=coalesce(offline_since, now()) WHERE id=$1`, [row.k_id]);
          failed++;
        }
      });
    }
    return { processed: pending.length, ok, failed };
  }

  // ==================================================================
  // ФИСКАЛЬНЫЕ СМЕНЫ (модель Wipon: смена ККМ отдельно от смены кассы)
  // ==================================================================
  async openFiscalShift(accountId: string, kkmId: string, shiftId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const kkm = (await c.query(`SELECT * FROM kkm WHERE id=$1`, [kkmId])).rows[0];
      if (!kkm) throw new BadRequestException('ККМ не найдена');
      const prov = this.implOf(kkm);
      if (!prov) throw new BadRequestException('Оператор не подключён');

      const res = await prov.openShift(this.credOf(kkm));
      const { rows } = await c.query(
        `INSERT INTO fiscal_shift (account_id, kkm_id, shift_id, number, status, error)
         VALUES ($1,$2,$3,$4,$5::fiscal_status,$6) RETURNING *`,
        [accountId, kkmId, shiftId ?? null, res.shiftNumber ?? null, res.ok ? 'ok' : 'failed', res.error ?? null]);
      return rows[0];
    });
  }

  /** Z-отчёт: закрытие фискальной смены. */
  async closeFiscalShift(accountId: string, kkmId: string) {
    const kkm = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM kkm WHERE id=$1`, [kkmId])).rows[0]);
    if (!kkm) throw new BadRequestException('ККМ не найдена');
    const prov = this.implOf(kkm);
    if (!prov) throw new BadRequestException('Оператор не подключён');

    // нельзя закрывать смену, пока чеки не уехали: Z-отчёт разойдётся с выручкой
    const stuck = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM fiscal_receipt WHERE kkm_id=$1 AND status IN ('pending','failed')`, [kkmId])).rows[0].n);
    if (stuck > 0)
      throw new BadRequestException(`${stuck} чеков ещё не отправлены оператору — Z-отчёт разойдётся с выручкой. Дождитесь отправки.`);

    const res = await prov.closeShift(this.credOf(kkm));
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `UPDATE fiscal_shift SET closed_at=now(), status=$2::fiscal_status, z_report=$3, error=$4
          WHERE kkm_id=$1 AND closed_at IS NULL RETURNING *`,
        [kkmId, res.ok ? 'ok' : 'failed', JSON.stringify(res.raw ?? {}), res.error ?? null]);
      return { ok: res.ok, error: res.error, shift: rows[0], zReport: res.raw };
    });
  }

  async xReport(accountId: string, kkmId: string) {
    const kkm = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM kkm WHERE id=$1`, [kkmId])).rows[0]);
    if (!kkm) throw new BadRequestException('ККМ не найдена');
    const prov = this.implOf(kkm);
    if (!prov) throw new BadRequestException('Оператор не подключён');
    return prov.xReport(this.credOf(kkm));
  }

  /**
   * Здоровье фискализации (наше добавление).
   * У Wipon режим задан — а что не пробилось, узнаёшь по факту.
   */
  async health(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM fiscal_health($1)`, [accountId]);
    const h = rows[0];
    const pending = Number(h.pending ?? 0), failed = Number(h.failed ?? 0);
    return {
      total: Number(h.total ?? 0), ok: Number(h.ok ?? 0), pending, failed,
      oldestPending: h.oldest_pending, lastError: h.last_error,
      healthy: pending === 0 && failed === 0,
      message: failed > 0
        ? `${failed} чеков не ушли оператору: ${h.last_error ?? ''}`
        : pending > 0 ? `${pending} чеков ждут отправки` : 'Все чеки фискализированы',
    };
  }

  // ==================================================================
  // БОЕВОЙ РЕЖИМ (часть 23)
  // ==================================================================

  /** Готовность касс к бою — чек-лист для кабинета (есть ключи, РНМ/ЗНМ, связь) */
  async readiness(accountId: string) {
    // функция читает kkm под RLS — нужен tenant-контекст, как у health нет
    // (health передаёт accountId в SQL и не зависит от RLS-политики kkm)
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM kkm_readiness($1)`, [accountId])).rows);
    return rows.map((r: any) => ({
      kkmId: r.kkm_id, cashRegister: r.cash_register, provider: r.provider, env: r.env,
      hasCredentials: r.has_credentials, hasRegNumber: r.has_reg_number,
      connectionOk: r.connection_ok, connectionCheckedAt: r.connection_checked_at,
      isActive: r.is_active, readyForProduction: r.ready_for_production,
    }));
  }

  /**
   * Проверка связи с ОФД. Отправляем лёгкий вызов боевыми ключами: если
   * оператор ответил — ключи верны и касса зарегистрирована. Результат
   * сохраняем; боевой режим включится только если проверка прошла.
   * Это защита от «включили прод, а первый чек ушёл в никуда».
   */
  async checkConnection(accountId: string, kkmId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const kkm = (await c.query(`SELECT * FROM kkm WHERE id=$1`, [kkmId])).rows[0];
      if (!kkm) throw new BadRequestException('Касса не найдена');
      const prov = this.implOf(kkm);
      if (!prov?.checkConnection)
        throw new BadRequestException('Провайдер не поддерживает проверку связи');

      const res = await prov.checkConnection(this.credOf(kkm));
      await c.query(
        `UPDATE kkm SET connection_ok=$2, connection_checked_at=now(),
                        connection_error=$3, ofd_check_url=coalesce($4, ofd_check_url)
           WHERE id=$1`,
        [kkmId, res.ok, res.ok ? null : res.error, res.checkUrl ?? null]);
      return {
        ok: res.ok,
        message: res.ok ? 'Связь с оператором есть — можно включать боевой режим'
                        : `Нет связи: ${res.error}`,
        checkUrl: res.checkUrl,
      };
    });
  }

  /**
   * Перевод кассы в боевой режим. Только после успешной проверки связи —
   * иначе отказ. Обратный перевод в test разрешён всегда (например, чтобы
   * потренироваться), боевые чеки при этом не уходят.
   */
  async setEnv(accountId: string, kkmId: string, env: 'test' | 'production') {
    return this.db.withTenant(accountId, async (c) => {
      const kkm = (await c.query(`SELECT * FROM kkm WHERE id=$1`, [kkmId])).rows[0];
      if (!kkm) throw new BadRequestException('Касса не найдена');
      if (env === 'production') {
        if (!kkm.reg_number || !kkm.serial_number)
          throw new BadRequestException('Сначала укажите РНМ и ЗНМ (получите их в Кабинете налогоплательщика)');
        if (!kkm.connection_ok)
          throw new BadRequestException('Сначала пройдите проверку связи с оператором');
      }
      await c.query(`UPDATE kkm SET env=$2::fiscal_env WHERE id=$1`, [kkmId, env]);
      return { ok: true, env,
        message: env === 'production' ? 'Касса переведена в боевой режим — чеки уходят оператору'
                                      : 'Касса в тестовом режиме — боевые чеки не отправляются' };
    });
  }

  /**
   * Чек коррекции (модель МоегоСклада: приход / возврат прихода).
   * Нужен, когда выручка прошла мимо кассы (сбой, забыли пробить) —
   * налоговая требует её оформить. Отдельная операция, не привязана к чеку.
   */
  async correction(accountId: string, employeeId: string | null, d: {
    kkmId: string; kind: 'income' | 'income_refund'; reason: string;
    amount: number; cash?: number; card?: number;
  }) {
    if (!d.reason?.trim()) throw new BadRequestException('Укажите причину коррекции — её смотрит налоговая');
    if (!(d.amount > 0)) throw new BadRequestException('Сумма коррекции должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const kkm = (await c.query(`SELECT * FROM kkm WHERE id=$1 AND is_active`, [d.kkmId])).rows[0];
      if (!kkm) throw new BadRequestException('Касса не найдена или отключена');
      const prov = this.implOf(kkm);
      if (!prov?.registerCorrection)
        throw new BadRequestException('Провайдер не поддерживает чек коррекции');

      const { rows } = await c.query(
        `INSERT INTO fiscal_correction (account_id, kkm_id, kind, reason, amount, cash, card, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [accountId, d.kkmId, d.kind, d.reason.trim(), d.amount, d.cash ?? 0, d.card ?? 0, employeeId]);
      const id = rows[0].id;

      const res = await prov.registerCorrection(this.credOf(kkm), {
        kind: d.kind, reason: d.reason.trim(), amount: d.amount, cash: d.cash, card: d.card });

      await c.query(
        `UPDATE fiscal_correction SET status=$2::fiscal_status, fiscal_number=$3,
                error=$4, fiscalized_at=CASE WHEN $2='ok' THEN now() ELSE NULL END
           WHERE id=$1`,
        [id, res.ok ? 'ok' : 'failed', res.fiscalNumber ?? null, res.ok ? null : res.error]);

      if (!res.ok) throw new BadRequestException(`Оператор отклонил коррекцию: ${res.error}`);
      return { id, ok: true, fiscalNumber: res.fiscalNumber, checkUrl: res.checkUrl };
    });
  }

  async corrections(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT fc.id, fc.kind, fc.reason, fc.amount, fc.status, fc.fiscal_number,
                fc.created_at, cr.name AS cash_register
           FROM fiscal_correction fc
           JOIN kkm k ON k.id = fc.kkm_id
           JOIN cash_register cr ON cr.id = k.cash_register_id
          WHERE fc.account_id=$1 ORDER BY fc.created_at DESC LIMIT 50`, [accountId])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount) })));
  }

  // ==================================================================
  // ПЕЧАТЬ (5.4)
  // ==================================================================
  async receiptBytes(accountId: string, saleId: string, opts: { width?: number; lang?: 'ru' | 'kk' } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `SELECT s.*, e.first_name AS cashier, con.name AS consultant,
                a.name AS brand_name, a.phone AS brand_phone,
                st.name AS store_name, st.address AS store_address
           FROM sale s
           LEFT JOIN employee e ON e.id=s.employee_id
           LEFT JOIN consultant con ON con.id=s.consultant_id
           LEFT JOIN store st ON st.id=s.store_id
           JOIN account a ON a.id=s.account_id
          WHERE s.id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');

      const items = (await c.query(
        `SELECT i.*, p.name FROM sale_item i JOIN product p ON p.id=i.product_id WHERE i.sale_id=$1`, [saleId])).rows;
      const pays = (await c.query(`SELECT method, amount FROM sale_payment WHERE sale_id=$1`, [saleId])).rows;
      const fr = (await c.query(
        `SELECT fiscal_number, check_url FROM fiscal_receipt WHERE sale_id=$1 AND status='ok' LIMIT 1`, [saleId])).rows[0];
      const kkm = (await c.query(
        `SELECT reg_number, serial_number FROM kkm WHERE cash_register_id=$1 AND is_active`, [s.cash_register_id])).rows[0];

      const data: ReceiptData = {
        // брендирование: название магазина, а не наше (идея Wipon)
        brand: { name: s.store_name ?? s.brand_name, address: s.store_address ?? undefined, phone: s.brand_phone ?? undefined },
        kkm: kkm ? { regNumber: kkm.reg_number, serialNumber: kkm.serial_number } : undefined,
        receiptNumber: s.number ?? s.local_number,
        cashier: s.cashier, consultant: s.consultant,
        datetime: s.completed_at ?? s.created_at,
        items: items.map((i: any) => ({
          name: i.name, qty: Number(i.qty), price: Number(i.price), total: Number(i.total),
          discount: Number(i.discount_sum) || undefined, ntin: i.ntin ?? undefined,
        })),
        subtotal: Number(s.subtotal), discount: Number(s.discount_sum) || undefined,
        rounding: Number(s.rounding) || undefined, total: Number(s.total),
        payments: pays.map((p: any) => ({ method: p.method, amount: Number(p.amount) })),
        change: Number(s.change_given) || undefined,
        fiscalNumber: fr?.fiscal_number, checkUrl: fr?.check_url,
        isRefund: !!s.return_of_id,
        lang: opts.lang ?? 'ru',
      };
      return renderReceipt(data, opts.width ?? 32);
    });
  }
}
