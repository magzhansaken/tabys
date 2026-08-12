import { Controller, Get, Post, Body, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * RFM-АНАЛИЗ КЛИЕНТОВ (часть 37) — догоняем МойСклад.
 *
 * Recency (давность), Frequency (частота), Monetary (сумма). Баллы 1-3,
 * раскладка по именованным сегментам с рекомендацией действия. В отличие от
 * МоегоСклада (платный шаблон только для печати) — встроено и с готовыми
 * сегментами. Результат можно отправить в рассылку (связь с лояльностью).
 *
 * НЕ ML-прогноз оттока/CLV — для магазина у дома важна понятная сегментация.
 */

// классификация сегмента по R/F/M-баллам (модель розничного RFM)
function classify(r: number, f: number, m: number): { segment: string; tone: string; action: string } {
  const sum = r + f + m;
  // чемпионы: недавно, часто, много
  if (r === 3 && f === 3 && m >= 2) return { segment: 'Чемпионы', tone: 'ok', action: 'Поощряйте — эксклюзивы, ранний доступ' };
  // лояльные: часто покупают, ещё активны
  if (f === 3 && r >= 2) return { segment: 'Лояльные', tone: 'ok', action: 'Программа лояльности, допродажи' };
  // крупные, но давно не были — под угрозой оттока
  if (m === 3 && r === 1) return { segment: 'Под угрозой оттока', tone: 'bad', action: 'Срочно вернуть — персональная скидка' };
  // были часто, но давно не приходят
  if (f >= 2 && r === 1) return { segment: 'Засыпающие', tone: 'warn', action: 'Реактивация — напоминание, спецпредложение' };
  // новички: недавно, но мало покупок
  if (r === 3 && f === 1) return { segment: 'Новички', tone: 'ok', action: 'Второй визит — welcome-бонус' };
  // потерянные: давно и мало
  if (sum <= 3) return { segment: 'Потерянные', tone: 'dim', action: 'Дешёвая реактивация или не тратить бюджет' };
  return { segment: 'Обычные', tone: 'dim', action: 'Поддерживать интерес общими акциями' };
}

@Injectable()
export class RfmService {
  constructor(private db: DbService) {}

  async analyze(accountId: string, opts: { from: string; to: string; rHot?: number; rWarm?: number; fHot?: number; fWarm?: number }) {
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT * FROM rfm_analysis($1,$2::timestamptz,$3::timestamptz,$4,$5,$6,$7)`,
        [accountId, opts.from, opts.to, opts.rHot ?? 14, opts.rWarm ?? 45, opts.fHot ?? 5, opts.fWarm ?? 2])).rows);

    const customers = rows.map((r: any) => {
      const rr = Number(r.r), ff = Number(r.f), mm = Number(r.m);
      const cls = classify(rr, ff, mm);
      return {
        customerId: r.customer_id, name: r.name,
        lastDays: r.last_days != null ? Number(r.last_days) : null,
        purchases: Number(r.purchases), total: Number(r.total), avgCheck: Number(r.avg_check),
        r: rr, f: ff, m: mm, rfm: r.rfm,
        segment: cls.segment, tone: cls.tone, action: cls.action,
      };
    });

    // сводка по сегментам
    const bySegment = new Map<string, { count: number; total: number; tone: string; action: string }>();
    for (const c of customers) {
      const cur = bySegment.get(c.segment) ?? { count: 0, total: 0, tone: c.tone, action: c.action };
      cur.count++; cur.total += c.total;
      bySegment.set(c.segment, cur);
    }
    const segments = [...bySegment.entries()].map(([segment, v]) => ({
      segment, count: v.count, total: v.total, tone: v.tone, action: v.action,
    })).sort((a, b) => b.total - a.total);

    return { customers, segments, totalCustomers: customers.length };
  }

  /** Клиенты одного сегмента — для отправки в рассылку/скидку */
  async segmentCustomers(accountId: string, opts: { from: string; to: string; segment: string }) {
    const { customers } = await this.analyze(accountId, opts);
    return customers.filter((c) => c.segment === opts.segment);
  }
}

// =====================================================================
@Controller('rfm')
export class RfmController {
  constructor(private svc: RfmService) {}

  private range(q: any) {
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 180 * 86400000).toISOString();
    return { from, to };
  }

  @Get() @RequirePermission('reports', 'view')
  analyze(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.svc.analyze(ctx.accountId, {
      ...this.range(q),
      rHot: q.rHot ? +q.rHot : undefined, rWarm: q.rWarm ? +q.rWarm : undefined,
      fHot: q.fHot ? +q.fHot : undefined, fWarm: q.fWarm ? +q.fWarm : undefined,
    });
  }

  @Get('segment') @RequirePermission('reports', 'view')
  segment(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.segment) throw new BadRequestException('Укажите сегмент');
    return this.svc.segmentCustomers(ctx.accountId, { ...this.range(q), segment: q.segment });
  }
}

@Module({ controllers: [RfmController], providers: [RfmService, DbService] })
export class RfmModule {}
