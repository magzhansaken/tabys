import { Controller, Get, Post, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { CounterpartyCheckProvider, MockCounterpartyCheckProvider, KgdCounterpartyCheckProvider, assessRisk,
         KkmCheckProvider, MockKkmCheckProvider, KgdKkmCheckProvider, assessKkm } from './verification.provider';

/**
 * ПРОВЕРКА КОНТРАГЕНТА (часть 34) — защита от налоговых рисков КЗ.
 *
 * Проверяем поставщика по БИН/ИИН перед приёмкой и оптовой сделкой: плательщик
 * ли НДС, режим, в реестре неблагонадёжных ли, есть ли долг. Предупреждаем о
 * риске ДО сделки — иначе КГД не примет НДС к зачёту, и доначисления лягут на
 * нас (не на контрагента).
 *
 * Wipon проверяет ККМ (kaspi/kgd-check) — мы проверяем контрагента, что
 * реально защищает деньги владельца.
 */

@Injectable()
export class VerificationService {
  constructor(private db: DbService) {}

  private providers = new Map<string, CounterpartyCheckProvider>([['mock', new MockCounterpartyCheckProvider()]]);
  setProvider(name: string, p: CounterpartyCheckProvider) { this.providers.set(name, p); }

  /** Проверить контрагента по БИН/ИИН. Кэшируем и обновляем статус на карточке. */
  async check(accountId: string, employeeId: string | null, d: {
    binOrIin: string; counterpartyId?: string; provider?: string;
  }) {
    const clean = (d.binOrIin ?? '').replace(/\D/g, '');
    if (clean.length !== 12) throw new BadRequestException('БИН/ИИН должен содержать 12 цифр');
    const providerName = d.provider ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'kgd');
    const prov = this.providers.get(providerName) ?? this.providers.get('mock')!;

    const info = await prov.checkByBin(clean);
    const risk = assessRisk(info);

    return this.db.withTenant(accountId, async (c) => {
      // журнал
      await c.query(
        `INSERT INTO counterparty_check (account_id, counterparty_id, iin_bin, provider, found, name,
                  vat_payer, vat_since, tax_regime, is_unreliable, has_tax_debt, risk_level, raw, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [accountId, d.counterpartyId ?? null, clean, providerName, info.found, info.name ?? null,
         info.vatPayer ?? null, info.vatSince ?? null, info.taxRegime ?? null,
         info.isUnreliable ?? null, info.hasTaxDebt ?? null, risk.level, JSON.stringify(info), employeeId]);

      // обновляем карточку контрагента, если указан
      if (d.counterpartyId && info.found)
        await c.query(
          `UPDATE counterparty SET vat_payer=$2, vat_since=$3, tax_regime=$4,
                  is_unreliable=$5, has_tax_debt=$6, checked_at=now() WHERE id=$1`,
          [d.counterpartyId, info.vatPayer ?? null, info.vatSince ?? null, info.taxRegime ?? null,
           info.isUnreliable ?? null, info.hasTaxDebt ?? null]);

      return {
        found: info.found, name: info.name,
        vatPayer: info.vatPayer, vatSince: info.vatSince, taxRegime: info.taxRegime,
        isUnreliable: info.isUnreliable, hasTaxDebt: info.hasTaxDebt,
        risk: risk.level, reasons: risk.reasons,
      };
    });
  }

  /**
   * ПРОВЕРКА КАССЫ в налоговой (то, что делает Wipon).
   *
   * Владельцу важно знать состояние заранее, а не при проверке: если
   * касса снята с учёта, чеки не доходят в налоговую, и штраф выпишут
   * задним числом за всё время.
   */
  private kkmProviders = new Map<string, KkmCheckProvider>([['mock', new MockKkmCheckProvider()]]);

  async checkKkm(accountId: string, employeeId: string | null, d: { number: string; provider?: string }) {
    if (!d.number?.trim()) throw new BadRequestException('Укажите номер кассы');
    const providerName = d.provider ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'kgd');
    const prov = this.kkmProviders.get(providerName) ?? this.kkmProviders.get('mock')!;

    const info = await prov.checkKkm(d.number.trim());
    const verdict = assessKkm(info);

    return this.db.withTenant(accountId, async (c) => {
      // Пишем в тот же журнал проверок: владельцу удобнее один список,
      // а не два похожих в разных местах.
      await c.query(
        `INSERT INTO counterparty_check (account_id, iin_bin, provider, found, name,
                  tax_regime, risk_level, raw, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [accountId, d.number.trim(), 'kkm:' + providerName, info.found,
         info.model ? `ККМ ${info.model}` : 'ККМ', info.ofd ?? null,
         verdict.level, JSON.stringify(info), employeeId]);

      return { ...info, risk: verdict.level, reasons: verdict.reasons };
    });
  }

  /** История проверок */
  async history(accountId: string, counterpartyId?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, iin_bin, name, vat_payer, tax_regime, is_unreliable, has_tax_debt, risk_level, created_at
           FROM counterparty_check
          WHERE account_id=$1 AND ($2::uuid IS NULL OR counterparty_id=$2)
          ORDER BY created_at DESC LIMIT 50`, [accountId, counterpartyId ?? null])).rows);
  }

  /**
   * Проверка перед приёмкой: берём поставщика документа, проверяем и возвращаем
   * риск. Если danger — вызывающий код может предупредить/заблокировать.
   */
  async checkSupplierOfDoc(accountId: string, employeeId: string | null, stockDocId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const sup = (await c.query(
        `SELECT cp.id, cp.name, cp.iin_bin FROM stock_doc sd
           JOIN counterparty cp ON cp.id = sd.supplier_id WHERE sd.id=$1`, [stockDocId])).rows[0];
      if (!sup) throw new BadRequestException('У документа нет поставщика или документ не найден');
      if (!sup.iin_bin) throw new BadRequestException(`У поставщика «${sup.name}» не указан БИН/ИИН`);
      return this.check(accountId, employeeId, { binOrIin: sup.iin_bin, counterpartyId: sup.id });
    });
  }
}

// =====================================================================
@Controller('verification')
export class VerificationController {
  constructor(private svc: VerificationService) {}

  @Post('check') @RequirePermission('contragents', 'view')
  check(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.check(ctx.accountId, ctx.employeeId, d);
  }

  @Get('history') @RequirePermission('contragents', 'view')
  history(@Ctx() ctx: EmployeeContext, @Query('counterpartyId') cid?: string) {
    return this.svc.history(ctx.accountId, cid);
  }

  /** Проверка кассы в налоговой (модель Wipon). */
  @Post('check-kkm') @RequirePermission('settings', 'view')
  checkKkm(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.checkKkm(ctx.accountId, ctx.employeeId, d);
  }

  @Post('check-supplier/:stockDocId') @RequirePermission('stock', 'view')
  checkSupplier(@Ctx() ctx: EmployeeContext, @Param('stockDocId') id: string) {
    return this.svc.checkSupplierOfDoc(ctx.accountId, ctx.employeeId, id);
  }
}

@Module({ controllers: [VerificationController], providers: [VerificationService, DbService] })
export class VerificationModule {}
