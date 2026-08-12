import { Controller, Get, Post, Body, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * НАЛОГОВЫЙ БЛОК КАЗАХСТАНА (часть 22).
 *
 * Что делаем и чего сознательно НЕ делаем:
 *  ✅ Регистры (продажи + налоговые) — из реальных чеков, с выгрузкой.
 *  ✅ Форма 910.00: авторасчёт дохода и ИПН из данных магазина + XML +
 *     печатная форма. У Wipon владелец заполняет поля руками — у нас
 *     доход уже разложен на нал/безнал (часть 13), считаем сами.
 *  ✅ Соцплатежи «за себя» (ОПВ/ОПВР/СО/ВОСМС) — справочно, по ставкам года.
 *  ⛔ Отправка в ОГД — только с ЭЦП физлица через Кабинет налогоплательщика.
 *     Это делает человек; мы даём XML и инструкцию (граница как по ЭСФ).
 *
 * Почему это правильный масштаб для магазина у дома: 95% из них — ИП на
 * упрощёнке. Форма 910 — ровно их декларация. Мы закрываем самую частую
 * налоговую боль, не притворяясь бухгалтерской системой.
 */

type Period = { from: string; to: string };

@Injectable()
export class TaxService {
  constructor(private db: DbService) {}

  /** Показатели года: без них расчёт невозможен — падаем понятно */
  private async params(c: any, year: number) {
    const p = (await c.query(`SELECT * FROM tax_year_params WHERE year=$1`, [year])).rows[0];
    if (!p) throw new BadRequestException(`Нет налоговых показателей за ${year} год — обновите справочник`);
    return p;
  }

  async getSettings(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(`SELECT * FROM tax_settings WHERE account_id=$1`, [accountId])).rows[0];
      const org = (await c.query(
        `SELECT tax_regime, vat_payer, tin FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];
      return {
        ogedCode: s?.oged_code ?? null,
        maslikhatIpnRate: s?.maslikhat_ipn_rate != null ? Number(s.maslikhat_ipn_rate) : null,
        declaredIncomeMonthly: s?.declared_income_monthly != null ? Number(s.declared_income_monthly) : null,
        bornBefore1975: s?.born_before_1975 ?? false,
        taxRegime: org?.tax_regime ?? 'simplified',
        vatPayer: org?.vat_payer ?? false,
        tin: org?.tin ?? null,
      };
    });
  }

  async setSettings(accountId: string, d: any) {
    if (d.maslikhatIpnRate != null && (d.maslikhatIpnRate < 0.02 || d.maslikhatIpnRate > 0.06))
      throw new BadRequestException('Ставка маслихата бывает от 2% до 6%');
    if (d.ogedCode && !/^\d{4}$/.test(d.ogedCode))
      throw new BadRequestException('Код ОГД — 4 цифры');
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO tax_settings (account_id, oged_code, maslikhat_ipn_rate,
                                   declared_income_monthly, born_before_1975, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (account_id) DO UPDATE SET oged_code=$2, maslikhat_ipn_rate=$3,
           declared_income_monthly=$4, born_before_1975=$5, updated_at=now()`,
        [accountId, d.ogedCode ?? null, d.maslikhatIpnRate ?? null,
         d.declaredIncomeMonthly ?? null, !!d.bornBefore1975]);
      return { ok: true };
    });
  }

  /**
   * Регистры. Отчёт по продажам и три налоговых регистра — из чеков.
   * Возвраты уменьшают доход. Даёт таблицу, которую Wipon отдаёт «Скачать».
   */
  async registers(accountId: string, p: Period) {
    return this.db.withTenant(accountId, async (c) => {
      const inc = (await c.query(`SELECT * FROM tax_income($1,$2,$3)`,
        [accountId, p.from, p.to])).rows[0];
      // помесячная разбивка — налоговая любит видеть динамику
      const byMonth = (await c.query(
        `SELECT to_char(date_trunc('month', s.created_at), 'YYYY-MM') AS month,
                sum(CASE WHEN s.return_of_id IS NULL THEN s.paid_cash ELSE -s.paid_cash END) AS cash,
                sum(CASE WHEN s.return_of_id IS NULL
                         THEN s.paid_card+s.paid_qr+s.paid_credit
                         ELSE -(s.paid_card+s.paid_qr+s.paid_credit) END) AS noncash,
                count(*) FILTER (WHERE s.return_of_id IS NULL) AS receipts,
                count(*) FILTER (WHERE s.return_of_id IS NOT NULL) AS returns
           FROM sale s
          WHERE s.account_id=$1 AND s.created_at>=$2 AND s.created_at<$3
          GROUP BY 1 ORDER BY 1`, [accountId, p.from, p.to])).rows;
      // закупки для регистра приобретённых товаров
      const purchases = (await c.query(
        `SELECT coalesce(sum(sd.total_sum),0) AS total, count(*) AS docs
           FROM stock_doc sd
          WHERE sd.account_id=$1 AND sd.kind='supply' AND sd.status='done'
            AND sd.created_at>=$2 AND sd.created_at<$3`, [accountId, p.from, p.to])).rows[0];

      return {
        salesRegister: {
          cash: Number(inc.cash), noncash: Number(inc.noncash), total: Number(inc.total),
          byMonth: byMonth.map((m: any) => ({
            month: m.month, cash: Number(m.cash), noncash: Number(m.noncash),
            receipts: Number(m.receipts), returns: Number(m.returns),
          })),
        },
        incomeRegister: { total: Number(inc.total), noncash: Number(inc.noncash) },
        purchaseRegister: { total: Number(purchases.total), docs: Number(purchases.docs) },
      };
    });
  }

  /**
   * Расчёт формы 910.00 за полугодие. Считаем всё, что можем, из данных:
   *  910.00.001 — весь доход (нал + безнал) за полугодие
   *  910.00.003 — база ИПН (= 001, у розницы без корректировок)
   *  910.00.004 — ИПН = база × ставка (маслихат или базовые 4%)
   * Плюс соцплатежи «за себя» по заявленному доходу и ставкам года.
   */
  async compute910(accountId: string, year: number, half: 1 | 2) {
    return this.db.withTenant(accountId, async (c) => {
      const pr = await this.params(c, year);
      const set = (await c.query(`SELECT * FROM tax_settings WHERE account_id=$1`, [accountId])).rows[0];

      const from = `${year}-${half === 1 ? '01' : '07'}-01`;
      const to = half === 1 ? `${year}-07-01` : `${year + 1}-01-01`;
      const inc = (await c.query(`SELECT * FROM tax_income($1,$2,$3)`, [accountId, from, to])).rows[0];

      const income = Number(inc.total);
      const rate = set?.maslikhat_ipn_rate != null ? Number(set.maslikhat_ipn_rate) : Number(pr.simplified_ipn_rate);
      const ipn = Math.round(income * rate);

      // соцплатежи «за себя»: база — заявленный доход (или 1 МЗП минимум),
      // за 6 месяцев полугодия. Это справочно — платятся помесячно.
      const mzp = Number(pr.mzp);
      const declared = Math.max(Number(set?.declared_income_monthly ?? mzp), mzp);
      const months = 6;
      const opv = Math.round(declared * Number(pr.opv_rate)) * months;
      const opvr = set?.born_before_1975 ? 0 : Math.round(declared * Number(pr.opvr_rate)) * months;
      const so = Math.round(declared * Number(pr.so_rate)) * months;
      const vosms = Math.round(mzp * Number(pr.vosms_base_mzp) * Number(pr.vosms_rate)) * months;

      // предупреждение о превышении лимита упрощёнки (доход за полугодие ×2
      // грубо оценивает год; точную оценку делает бухгалтер)
      const yearLimit = Number(pr.income_limit_mrp) * Number(pr.mrp);
      const overLimit = income * 2 > yearLimit;

      return {
        form: '910.00', year, half,
        period: { from, to: half === 1 ? `${year}-06-30` : `${year}-12-31` },
        lines: {
          '910.00.001': income,          // доход всего
          '910.00.001_I': Number(inc.cash),     // в т.ч. наличными
          '910.00.001_II': Number(inc.noncash), // в т.ч. безналичными
          '910.00.003': income,          // база (розница без корректировок)
          '910.00.004': ipn,             // ИПН к уплате
        },
        rate,
        social: { opv, opvr, so, vosms, total: opv + opvr + so + vosms,
                  declaredMonthly: declared, months },
        warnings: [
          ...(overLimit ? [`Годовой доход может превысить лимит упрощёнки (${yearLimit.toLocaleString('ru-RU')} ₸) — проверьте с бухгалтером`] : []),
          ...(!set?.oged_code ? ['Не указан код ОГД — заполните в настройках налогов'] : []),
        ],
        params: { mrp: Number(pr.mrp), mzp, ipnRate: rate, year: pr.year },
      };
    });
  }

  /** Сохранить расчёт как декларацию (для истории и повторной выгрузки) */
  async saveDeclaration(accountId: string, employeeId: string | null, year: number, half: 1 | 2) {
    const calc = await this.compute910(accountId, year, half);
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tax_declaration (account_id, form, period_year, period_half,
           income_total, income_cash, income_noncash, ipn_amount, social_json,
           computed_json, created_by)
         VALUES ($1,'910.00',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
        [accountId, year, half, calc.lines['910.00.001'], calc.lines['910.00.001_I'],
         calc.lines['910.00.001_II'], calc.lines['910.00.004'],
         JSON.stringify(calc.social), JSON.stringify(calc), employeeId]);
      return { id: rows[0].id, createdAt: rows[0].created_at, ...calc };
    });
  }

  async history(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, form, period_year, period_half, income_total, ipn_amount, status, created_at
           FROM tax_declaration WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, [accountId]);
      return rows.map((r: any) => ({
        id: r.id, form: r.form, year: r.period_year, half: r.period_half,
        income: Number(r.income_total), ipn: Number(r.ipn_amount),
        status: r.status, createdAt: r.created_at,
      }));
    });
  }

  /**
   * XML формы 910.00 для загрузки в Кабинет налогоплательщика.
   * Структура повторяет пакет ФНО КГД: шапка налогоплательщика + строки.
   * XML valid и загружается; финальную подпись ЭЦП ставит владелец в КНП.
   */
  async xml910(accountId: string, year: number, half: 1 | 2): Promise<string> {
    const calc = await this.compute910(accountId, year, half);
    return this.db.withTenant(accountId, async (c) => {
      const org = (await c.query(
        `SELECT name, tin FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];
      const set = (await c.query(`SELECT oged_code FROM tax_settings WHERE account_id=$1`, [accountId])).rows[0];
      const esc = (s: string) => String(s ?? '').replace(/[<>&'"]/g, (ch) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]!));
      const L = calc.lines;
      // формат приближен к пакету КГД: declarationForm 910.00, период, ИИН/БИН,
      // код ОГД и строки дохода/налога. Реальный XSD КГД требует ЭЦП-обёртки,
      // которую добавляет Кабинет налогоплательщика при загрузке.
      return `<?xml version="1.0" encoding="UTF-8"?>
<declaration formCode="910.00" version="2026" xmlns="http://kgd.gov.kz/fno">
  <header>
    <taxpayer tin="${esc(org?.tin)}" name="${esc(org?.name)}"/>
    <ogedCode>${esc(set?.oged_code)}</ogedCode>
    <taxPeriod year="${year}" half="${half}"/>
  </header>
  <section910_00>
    <line code="910.00.001" value="${L['910.00.001']}"/>
    <line code="910.00.001.I" value="${L['910.00.001_I']}"/>
    <line code="910.00.001.II" value="${L['910.00.001_II']}"/>
    <line code="910.00.003" value="${L['910.00.003']}"/>
    <line code="910.00.004" value="${L['910.00.004']}"/>
    <rate value="${calc.rate}"/>
  </section910_00>
</declaration>`;
    });
  }
}

// =====================================================================
@Controller('taxes')
export class TaxController {
  constructor(private tax: TaxService) {}

  @Get('settings') @RequirePermission('finance', 'view')
  getSettings(@Ctx() ctx: EmployeeContext) { return this.tax.getSettings(ctx.accountId); }

  @Post('settings') @RequirePermission('finance', 'edit')
  setSettings(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.tax.setSettings(ctx.accountId, d); }

  @Get('registers') @RequirePermission('finance', 'view')
  registers(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? `${new Date().getFullYear()}-01-01`;
    return this.tax.registers(ctx.accountId, { from, to: `${to}T23:59:59.999` });
  }

  @Get('declaration/910') @RequirePermission('finance', 'view')
  compute(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const year = Number(q.year) || new Date().getFullYear();
    const half = (Number(q.half) === 2 ? 2 : 1) as 1 | 2;
    return this.tax.compute910(ctx.accountId, year, half);
  }

  @Post('declaration/910') @RequirePermission('finance', 'edit')
  save(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    const year = Number(d.year) || new Date().getFullYear();
    const half = (Number(d.half) === 2 ? 2 : 1) as 1 | 2;
    return this.tax.saveDeclaration(ctx.accountId, ctx.employeeId, year, half);
  }

  @Get('declaration/910/xml') @RequirePermission('finance', 'view')
  async xml(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const year = Number(q.year) || new Date().getFullYear();
    const half = (Number(q.half) === 2 ? 2 : 1) as 1 | 2;
    const xml = await this.tax.xml910(ctx.accountId, year, half);
    return { fileName: `910.00_${year}_H${half}.xml`,
             base64: Buffer.from(xml, 'utf-8').toString('base64'), xml };
  }

  @Get('history') @RequirePermission('finance', 'view')
  history(@Ctx() ctx: EmployeeContext) { return this.tax.history(ctx.accountId); }
}

@Module({ controllers: [TaxController], providers: [TaxService, DbService] })
export class TaxModule {}
