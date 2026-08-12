import { Controller, Get, Post, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { ExciseCheckProvider, MockExciseCheckProvider, EsapaExciseCheckProvider } from './excise.provider';

/**
 * АКЦИЗНЫЕ МАРКИ АЛКОГОЛЯ УКМ (часть 36) — догоняем Wipon Pro.
 *
 * Проверка подлинности УКМ (как e-Sapa) при приёмке и продаже алкоголя + учёт
 * марок. Защита от контрафакта: продажа немаркированного/поддельного алкоголя
 * грозит штрафами, конфискацией, лишением лицензии.
 *
 * Отличие от ИС МПТ (часть 30): алкоголь в КЗ идёт по УКМ (серия+номер, проверка
 * через e-Sapa/КГД), а не по DataMatrix ИС МПТ. Разные системы — не путаем.
 */

@Injectable()
export class ExciseService {
  constructor(private db: DbService) {}

  private providers = new Map<string, ExciseCheckProvider>([['mock', new MockExciseCheckProvider()]]);
  setProvider(name: string, p: ExciseCheckProvider) { this.providers.set(name, p); }
  private prov() {
    return this.providers.get(process.env.NODE_ENV === 'test' ? 'mock' : 'esapa') ?? this.providers.get('mock')!;
  }

  /** Проверить УКМ по серии+номеру или по штрих-коду. Пишет в журнал. */
  async check(accountId: string, employeeId: string | null, d: { series?: string; number?: string; barcode?: string }) {
    const prov = this.prov();
    let series = d.series, number = d.number;
    if (d.barcode) {
      const parsed = prov.parseBarcode(d.barcode);
      if (!parsed) throw new BadRequestException('Не удалось разобрать штрих-код УКМ');
      series = parsed.series; number = parsed.number;
    }
    if (!series || !number) throw new BadRequestException('Укажите серию и номер УКМ (или штрих-код)');

    const info = await prov.check(series, number);

    return this.db.withTenant(accountId, async (c) => {
      // уже продавали эту марку? (защита от контрафакта-клона)
      const existing = (await c.query(
        `SELECT status FROM excise_mark WHERE series=$1 AND number=$2`, [series, number])).rows[0];
      const alreadySold = existing?.status === 'sold';
      const result = !info.found ? 'not_found' : alreadySold ? 'already_sold' : 'ok';

      await c.query(
        `INSERT INTO excise_check (account_id, series, number, provider, found, product_name, result, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [accountId, series, number, prov.name, info.found, info.productName ?? null, result, employeeId]);

      return {
        found: info.found, series, number,
        productName: info.productName, kind: info.kind, volume: info.volume,
        strength: info.strength, producer: info.producer,
        result,
        ok: info.found && !alreadySold,
        warning: !info.found ? 'УКМ не найдена в базе — возможен контрафакт'
          : alreadySold ? 'Эта марка уже продана — возможен клон' : null,
      };
    });
  }

  /**
   * Принять марки на склад при приёмке алкоголя. Проверяет подлинность каждой,
   * учитывает. Забракованные (не найдены) не принимаются.
   */
  async receive(accountId: string, employeeId: string | null, d: {
    productId: string; docId?: string; marks: { series: string; number: string }[];
  }) {
    if (!d.productId) throw new BadRequestException('Укажите товар');
    if (!d.marks?.length) throw new BadRequestException('Отсканируйте хотя бы одну марку');
    const prov = this.prov();
    return this.db.withTenant(accountId, async (c) => {
      const accepted: any[] = [], rejected: any[] = [];
      for (const m of d.marks) {
        const info = await prov.check(m.series, m.number);
        // журналируем проверку и при приёмке (аудит)
        await c.query(
          `INSERT INTO excise_check (account_id, series, number, provider, found, product_name, result, employee_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [accountId, m.series, m.number, prov.name, info.found, info.productName ?? null,
           info.found ? 'ok' : 'not_found', employeeId]);
        if (!info.found) { rejected.push({ ...m, reason: 'Не найдена в базе (контрафакт)' }); continue; }
        const dup = (await c.query(
          `SELECT status FROM excise_mark WHERE series=$1 AND number=$2`, [m.series, m.number])).rows[0];
        if (dup) { rejected.push({ ...m, reason: `Уже учтена (${dup.status})` }); continue; }
        await c.query(
          `INSERT INTO excise_mark (account_id, series, number, product_id, product_name, volume, strength, producer,
                    status, verified, doc_id, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_stock',true,$9,now())`,
          [accountId, m.series, m.number, d.productId, info.productName ?? null,
           info.volume ?? null, info.strength ?? null, info.producer ?? null, d.docId ?? null]);
        accepted.push({ ...m, product: info.productName });
      }
      return { accepted: accepted.length, rejected };
    });
  }

  /** Продать марку → списать. Защита от повторной продажи. */
  async sell(accountId: string, d: { series: string; number: string; saleId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const mark = (await c.query(
        `SELECT * FROM excise_mark WHERE series=$1 AND number=$2 FOR UPDATE`, [d.series, d.number])).rows[0];
      if (!mark) throw new BadRequestException('Марка не учтена на складе — примите алкоголь с проверкой УКМ');
      if (mark.status === 'sold') throw new BadRequestException('Марка уже продана — повторная продажа запрещена');
      if (mark.status === 'rejected') throw new BadRequestException('Марка забракована и не может быть продана');
      await c.query(
        `UPDATE excise_mark SET status='sold', sale_id=$2, sold_at=now() WHERE id=$1`, [mark.id, d.saleId ?? null]);
      return { ok: true, product: mark.product_name };
    });
  }

  async history(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT series, number, found, product_name, result, created_at
           FROM excise_check WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, [accountId])).rows);
  }

  async stock(accountId: string) {
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM excise_stock($1)`, [accountId])).rows);
    return rows.map((r: any) => ({
      productId: r.product_id, product: r.product_name,
      inStock: Number(r.in_stock), sold: Number(r.sold), rejected: Number(r.rejected),
    }));
  }
}

// =====================================================================
@Controller('excise')
export class ExciseController {
  constructor(private svc: ExciseService) {}

  @Post('check') @RequirePermission('goods', 'view')
  check(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.check(ctx.accountId, ctx.employeeId, d); }

  @Post('receive') @RequirePermission('stock', 'edit')
  receive(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.receive(ctx.accountId, ctx.employeeId, d); }

  @Post('sell') @RequirePermission('goods', 'view')
  sell(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.sell(ctx.accountId, d); }

  @Get('history') @RequirePermission('stock', 'view')
  history(@Ctx() ctx: EmployeeContext) { return this.svc.history(ctx.accountId); }

  @Get('stock') @RequirePermission('stock', 'view')
  stock(@Ctx() ctx: EmployeeContext) { return this.svc.stock(ctx.accountId); }
}

@Module({ controllers: [ExciseController], providers: [ExciseService, DbService] })
export class ExciseModule {}
