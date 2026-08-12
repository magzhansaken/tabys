import { Controller, Get, Post, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * КАССА++ (часть 25): авансы и подарочные сертификаты.
 *
 * Стратегия — обгон в незакрытых у конкурентов функциях:
 *  • Сертификаты у МоегоСклада «в разработке» и требуют внешних систем
 *    (Бонус Плюс, Teyca). У нас — СВОИ и полные: продажа, гашение частями,
 *    баланс, срок. У Wipon и UMAG их нет вовсе.
 *  • Авансы у МоегоСклада только на Android-кассе. У нас — в облаке и офлайн.
 *
 * Аванс — деньги покупателя вперёд (на его счёт авансов), зачитываются в
 * будущую продажу. Отличается от долга: долг — мы ждём денег, аванс — деньги
 * уже у нас. И от предоплаты: в чеке за аванс товар не указывается (модель МС).
 */

/** Код сертификата: 12 цифр, читаемых с чека/карты. Без похожих символов. */
function genCertCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 10);
  return s;
}

@Injectable()
export class CashPlusService {
  constructor(private db: DbService) {}

  // ---------- АВАНСЫ ----------

  /** Внести аванс на счёт покупателя */
  async depositAdvance(accountId: string, employeeId: string | null, d: {
    counterpartyId: string; amount: number; comment?: string;
  }) {
    if (!d.counterpartyId) throw new BadRequestException('Укажите покупателя — аванс всегда именной');
    if (!(d.amount > 0)) throw new BadRequestException('Сумма аванса должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const balance = (await c.query(
        `SELECT apply_advance($1,$2,$3::numeric,'deposit',NULL,$4,$5) AS b`,
        [accountId, d.counterpartyId, d.amount, employeeId, d.comment ?? null])).rows[0].b;
      return { ok: true, balance: Number(balance) };
    });
  }

  /** Зачесть аванс в оплату продажи (списание со счёта авансов) */
  async redeemAdvance(accountId: string, employeeId: string | null, d: {
    counterpartyId: string; amount: number; saleId?: string;
  }) {
    if (!(d.amount > 0)) throw new BadRequestException('Сумма зачёта должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      // проверяем остаток заранее — иначе RAISE из функции превратится в 500
      const cur = (await c.query(
        `SELECT balance FROM advance_balance WHERE counterparty_id=$1`, [d.counterpartyId])).rows[0];
      const have = cur ? Number(cur.balance) : 0;
      if (have < d.amount)
        throw new BadRequestException(`На счёте аванса только ${have} ₸ — зачесть ${d.amount} ₸ нельзя`);
      const balance = (await c.query(
        `SELECT apply_advance($1,$2,$3::numeric,'redeem',$4,$5,NULL) AS b`,
        [accountId, d.counterpartyId, -d.amount, d.saleId ?? null, employeeId])).rows[0].b;
      return { ok: true, balance: Number(balance) };
    });
  }

  async advanceBalance(accountId: string, counterpartyId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const b = (await c.query(
        `SELECT balance FROM advance_balance WHERE counterparty_id=$1`, [counterpartyId])).rows[0];
      return { balance: b ? Number(b.balance) : 0 };
    });
  }

  async advanceHistory(accountId: string, counterpartyId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, amount, kind, comment, created_at FROM advance_move
          WHERE counterparty_id=$1 ORDER BY created_at DESC LIMIT 50`, [counterpartyId])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount) })));
  }

  // ---------- ПОДАРОЧНЫЕ СЕРТИФИКАТЫ ----------

  /**
   * Продать сертификат. Генерируем код, ставим номинал = баланс. Продажа
   * фиксируется как sold_sale_id если пробита через кассу. Именной — если
   * указан покупатель, иначе на предъявителя (гасится по коду).
   */
  async sellCertificate(accountId: string, employeeId: string | null, d: {
    nominal: number; customerId?: string; validDays?: number; saleId?: string; code?: string;
  }) {
    if (!(d.nominal > 0)) throw new BadRequestException('Номинал сертификата должен быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      let code = d.code?.trim() || genCertCode();
      // гарантируем уникальность кода
      for (let i = 0; i < 5; i++) {
        const dup = (await c.query(`SELECT 1 FROM gift_certificate WHERE code=$1`, [code])).rows[0];
        if (!dup) break;
        code = genCertCode();
      }
      const validUntil = d.validDays
        ? new Date(Date.now() + d.validDays * 86400000).toISOString().slice(0, 10) : null;
      const { rows } = await c.query(
        `INSERT INTO gift_certificate (account_id, code, nominal, balance, sold_sale_id, customer_id, valid_until, created_by)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7) RETURNING id, code, nominal, balance, valid_until`,
        [accountId, code, d.nominal, d.saleId ?? null, d.customerId ?? null, validUntil, employeeId]);
      await c.query(
        `INSERT INTO gift_certificate_move (account_id, certificate_id, amount, sale_id)
         VALUES ($1,$2,$3,$4)`, [accountId, rows[0].id, d.nominal, d.saleId ?? null]);
      return { ok: true, id: rows[0].id, code: rows[0].code,
               nominal: Number(rows[0].nominal), balance: Number(rows[0].balance),
               validUntil: rows[0].valid_until };
    });
  }

  /** Проверить сертификат по коду (для кассы перед гашением) */
  async checkCertificate(accountId: string, code: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cert = (await c.query(
        `SELECT id, code, nominal, balance, status, valid_until FROM gift_certificate WHERE code=$1`,
        [code.trim()])).rows[0];
      if (!cert) throw new BadRequestException('Сертификат с таким кодом не найден');
      const expired = cert.valid_until && new Date(cert.valid_until) < new Date();
      return {
        id: cert.id, code: cert.code, nominal: Number(cert.nominal), balance: Number(cert.balance),
        status: expired ? 'expired' : cert.status, validUntil: cert.valid_until,
        usable: !expired && cert.status === 'active' && Number(cert.balance) > 0,
      };
    });
  }

  /**
   * Погасить сертификат при оплате (частично или полностью). Списываем с
   * баланса; при нуле — статус used. Проверяем срок и активность.
   */
  async redeemCertificate(accountId: string, d: { code: string; amount: number; saleId?: string }) {
    if (!(d.amount > 0)) throw new BadRequestException('Сумма гашения должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const cert = (await c.query(
        `SELECT * FROM gift_certificate WHERE code=$1 FOR UPDATE`, [d.code.trim()])).rows[0];
      if (!cert) throw new BadRequestException('Сертификат не найден');
      if (cert.status !== 'active') throw new BadRequestException(`Сертификат ${cert.status === 'used' ? 'уже использован' : 'недоступен'}`);
      if (cert.valid_until && new Date(cert.valid_until) < new Date())
        throw new BadRequestException('Срок действия сертификата истёк');
      if (Number(cert.balance) < d.amount)
        throw new BadRequestException(`На сертификате только ${Number(cert.balance)} ₸`);

      const newBalance = Number(cert.balance) - d.amount;
      await c.query(
        `UPDATE gift_certificate SET balance=$2::numeric, status=CASE WHEN $2::numeric<=0 THEN 'used' ELSE 'active' END WHERE id=$1`,
        [cert.id, newBalance]);
      await c.query(
        `INSERT INTO gift_certificate_move (account_id, certificate_id, amount, sale_id)
         VALUES ($1,$2,$3,$4)`, [accountId, cert.id, -d.amount, d.saleId ?? null]);
      return { ok: true, balance: newBalance, fullyUsed: newBalance <= 0 };
    });
  }

  async certificates(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT gc.id, gc.code, gc.nominal, gc.balance, gc.status, gc.valid_until, gc.created_at,
                cp.name AS customer_name
           FROM gift_certificate gc
           LEFT JOIN counterparty cp ON cp.id = gc.customer_id
          WHERE gc.account_id=$1 ORDER BY gc.created_at DESC LIMIT 100`, [accountId])).rows
        .map((r: any) => ({
          id: r.id, code: r.code, nominal: Number(r.nominal), balance: Number(r.balance),
          status: r.valid_until && new Date(r.valid_until) < new Date() ? 'expired' : r.status,
          validUntil: r.valid_until, customerName: r.customer_name, createdAt: r.created_at,
        })));
  }

  // ---------- НАСТРОЙКИ ТОЧКИ (price-checker, Kaspi POS) ----------
  async storeSettings(accountId: string, storeId: string, d: { priceChecker?: boolean; kaspiPos?: boolean }) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `UPDATE store SET price_checker_enabled=coalesce($2, price_checker_enabled),
                          kaspi_pos_enabled=coalesce($3, kaspi_pos_enabled) WHERE id=$1`,
        [storeId, d.priceChecker ?? null, d.kaspiPos ?? null]);
      return { ok: true };
    });
  }

  /**
   * Price-checker: поиск товара по штрихкоду (модель Wipon — клиент сканирует
   * на полке, видит цену). Лёгкий эндпоинт: код → название + цена. Без входа
   * в кабинет, работает на простом устройстве в зале.
   */
  async priceCheck(accountId: string, barcode: string) {
    return this.db.withTenant(accountId, async (c) => {
      const p = (await c.query(
        `SELECT p.name, p.name_kk,
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                  WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL) AS price
           FROM product p JOIN barcode b ON b.product_id=p.id
          WHERE b.code=$1 AND p.deleted_at IS NULL LIMIT 1`, [barcode.trim()])).rows[0];
      if (!p) return { found: false };
      return { found: true, name: p.name, nameKk: p.name_kk, price: p.price != null ? Number(p.price) : null };
    });
  }
}

// =====================================================================
@Controller('cash')
export class CashPlusController {
  constructor(private svc: CashPlusService) {}

  // авансы
  @Post('advance/deposit') @RequirePermission('finance', 'edit')
  deposit(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.depositAdvance(ctx.accountId, ctx.employeeId, d); }

  @Post('advance/redeem') @RequirePermission('finance', 'edit')
  redeem(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.redeemAdvance(ctx.accountId, ctx.employeeId, d); }

  @Get('advance/:cpId') @RequirePermission('contragents', 'view')
  advBalance(@Ctx() ctx: EmployeeContext, @Param('cpId') cpId: string) { return this.svc.advanceBalance(ctx.accountId, cpId); }

  @Get('advance/:cpId/history') @RequirePermission('contragents', 'view')
  advHistory(@Ctx() ctx: EmployeeContext, @Param('cpId') cpId: string) { return this.svc.advanceHistory(ctx.accountId, cpId); }

  // сертификаты
  @Post('certificate/sell') @RequirePermission('finance', 'edit')
  sellCert(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.sellCertificate(ctx.accountId, ctx.employeeId, d); }

  @Get('certificate/check') @RequirePermission('goods', 'view')
  checkCert(@Ctx() ctx: EmployeeContext, @Query('code') code: string) { return this.svc.checkCertificate(ctx.accountId, code); }

  @Post('certificate/redeem') @RequirePermission('finance', 'edit')
  redeemCert(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.redeemCertificate(ctx.accountId, d); }

  @Get('certificates') @RequirePermission('finance', 'view')
  certs(@Ctx() ctx: EmployeeContext) { return this.svc.certificates(ctx.accountId); }

  // точка
  @Post('store/:id/settings') @RequirePermission('settings', 'edit')
  storeSettings(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.svc.storeSettings(ctx.accountId, id, d);
  }

  // price-checker (лёгкий, для устройства в зале)
  @Get('price-check') @RequirePermission('goods', 'view')
  priceCheck(@Ctx() ctx: EmployeeContext, @Query('barcode') barcode: string) {
    return this.svc.priceCheck(ctx.accountId, barcode);
  }
}

@Module({ controllers: [CashPlusController], providers: [CashPlusService, DbService] })
export class CashPlusModule {}
