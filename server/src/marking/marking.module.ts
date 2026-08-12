import { Controller, Get, Post, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * МАРКИРОВКА (часть 30) — ИС МПТ Казахстан.
 *
 * Завершаем цикл, заложенный в части 18: «принял → продал/вернул → вывел из
 * оборота», с журналом обмена с ИС МПТ и сверкой при приёмке.
 *
 * Код DataMatrix = GTIN (01) + серийный (21) в формате GS1. При розничной
 * продаже маркированный товар ВЫВОДИТСЯ ИЗ ОБОРОТА (сообщается в ИС МПТ) —
 * это требование закона, за непроведённый вывод штраф.
 *
 * ЧЕСТНО: боевой API ИС МПТ (markirovka.kz) требует регистрации участника
 * оборота и ключей — как ЭСФ и фискализация. Механика (парсинг, приёмка,
 * вывод, журнал, идемпотентность) готова до границы; отправка в ИС МПТ
 * включается по регистрации. Здесь вывод помечается и кладётся в журнал
 * со статусом; боевая доставка — воркером по настроенному обмену.
 */

@Injectable()
export class MarkingService {
  constructor(private db: DbService) {}

  /** Разобрать код DataMatrix GS1: 01<14 GTIN>21<серийный> */
  parseDataMatrix(code: string) {
    const clean = code.trim();
    const m = clean.match(/^01(\d{14})21([^\u001d]{1,20})/);
    if (!m) return { valid: false as const, reason: 'Код не в формате GS1 DataMatrix (ожидается 01<GTIN>21<серийный>)' };
    return { valid: true as const, gtin: m[1], serial: m[2], code: clean };
  }

  /**
   * Приёмка маркированного товара со сверкой. Если передан ожидаемый список
   * от поставщика (expectedCodes) — сверяем: что привезли, чего не хватает,
   * что лишнее. Модель ИС МПТ «сверка списка от поставщика и факта».
   */
  async receive(accountId: string, dto: {
    docId?: string; productId: string; codes: string[]; expectedCodes?: string[];
  }) {
    if (!dto.productId) throw new BadRequestException('Укажите товар');
    if (!dto.codes?.length) throw new BadRequestException('Отсканируйте хотя бы один код');
    return this.db.withTenant(accountId, async (c) => {
      const accepted: string[] = [], rejected: any[] = [];
      for (const raw of dto.codes) {
        const p = this.parseDataMatrix(raw);
        if (!p.valid) { rejected.push({ code: raw, reason: p.reason }); continue; }
        const dup = (await c.query(`SELECT status FROM marking_code WHERE code=$1`, [p.code])).rows[0];
        if (dup) { rejected.push({ code: raw, reason: `Код уже в системе (${dup.status})` }); continue; }
        await c.query(
          `INSERT INTO marking_code (account_id, code, gtin, serial, product_id, doc_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [accountId, p.code, p.gtin, p.serial, dto.productId, dto.docId ?? null]);
        accepted.push(p.code);
      }
      // сверка с ожидаемым списком поставщика
      let reconciliation = null;
      if (dto.expectedCodes?.length) {
        const acc = new Set(accepted);
        const exp = new Set(dto.expectedCodes.map((x) => this.parseDataMatrix(x).valid ? this.parseDataMatrix(x).code : x));
        reconciliation = {
          missing: [...exp].filter((x) => !acc.has(x)),       // в накладной есть, не привезли
          unexpected: [...acc].filter((x) => !exp.has(x)),    // привезли, в накладной нет
          matched: [...acc].filter((x) => exp.has(x)).length,
        };
      }
      return { accepted: accepted.length, rejected, reconciliation };
    });
  }

  /**
   * Продажа маркированного товара → вывод из оборота. Проверяем, что код на
   * складе и не продан (защита от двойной продажи). Помечаем sold и ставим в
   * журнал вывода из оборота (withdrawal). Идемпотентно.
   */
  async sellCode(accountId: string, dto: { code: string; saleId?: string; productId?: string }) {
    const parsed = this.parseDataMatrix(dto.code);
    const code = parsed.valid ? parsed.code : dto.code.trim();
    return this.db.withTenant(accountId, async (c) => {
      const mc = (await c.query(`SELECT * FROM marking_code WHERE code=$1 FOR UPDATE`, [code])).rows[0];
      if (!mc) throw new BadRequestException('Код маркировки не найден на складе — товар не принимали');
      if (mc.status === 'sold') throw new BadRequestException('Код уже продан — повторная продажа маркированного товара запрещена');
      if (mc.status === 'written_off') throw new BadRequestException('Код списан и не может быть продан');
      if (dto.productId && mc.product_id !== dto.productId)
        throw new BadRequestException('Код маркировки от другого товара');

      await c.query(
        `UPDATE marking_code SET status='sold', sale_id=$2, sold_at=now(), withdrawal_status='pending' WHERE id=$1`,
        [mc.id, dto.saleId ?? null]);
      // ставим в журнал вывода из оборота
      await c.query(
        `INSERT INTO marking_report (account_id, kind, code, marking_code_id) VALUES ($1,'withdrawal',$2,$3)`,
        [accountId, code, mc.id]);
      return { ok: true, gtin: mc.gtin, serial: mc.serial,
        note: 'Код продан и поставлен на вывод из оборота. Отправка в ИС МПТ — по настроенному обмену.' };
    });
  }

  /**
   * Возврат маркированного товара → код возвращается в оборот. Ставим в
   * журнал возврат (return). Только для проданных кодов.
   */
  async returnCode(accountId: string, dto: { code: string }) {
    const parsed = this.parseDataMatrix(dto.code);
    const code = parsed.valid ? parsed.code : dto.code.trim();
    return this.db.withTenant(accountId, async (c) => {
      const mc = (await c.query(`SELECT * FROM marking_code WHERE code=$1 FOR UPDATE`, [code])).rows[0];
      if (!mc) throw new BadRequestException('Код маркировки не найден');
      if (mc.status !== 'sold') throw new BadRequestException('Вернуть можно только проданный код');
      await c.query(
        `UPDATE marking_code SET status='returned', withdrawal_status='none' WHERE id=$1`, [mc.id]);
      await c.query(
        `INSERT INTO marking_report (account_id, kind, code, marking_code_id) VALUES ($1,'return',$2,$3)`,
        [accountId, code, mc.id]);
      return { ok: true, note: 'Код возвращён в оборот и поставлен на возврат в ИС МПТ' };
    });
  }

  /** Проверить код перед продажей (касса): на складе ли, можно ли продать */
  async checkCode(accountId: string, code: string) {
    const parsed = this.parseDataMatrix(code);
    const clean = parsed.valid ? parsed.code : code.trim();
    return this.db.withTenant(accountId, async (c) => {
      const mc = (await c.query(
        `SELECT mc.status, mc.gtin, mc.serial, p.name AS product
           FROM marking_code mc LEFT JOIN product p ON p.id=mc.product_id
          WHERE mc.code=$1`, [clean])).rows[0];
      if (!mc) return { found: false, sellable: false, reason: 'Код не принимали на склад' };
      return {
        found: true, product: mc.product, gtin: mc.gtin, serial: mc.serial, status: mc.status,
        sellable: mc.status === 'in_stock',
        reason: mc.status === 'sold' ? 'Уже продан' : mc.status === 'in_stock' ? null : `Статус: ${mc.status}`,
      };
    });
  }

  /**
   * Обработать журнал вывода из оборота: отправить pending-записи в ИС МПТ.
   * Боевой API включается по регистрации участника; сейчас механика доставки
   * готова, отправку делает воркер. Возвращает, сколько в очереди.
   */
  async processReportQueue(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const pending = (await c.query(
        `SELECT count(*)::int AS n FROM marking_report WHERE status='pending'`)).rows[0].n;
      return { pending, note: pending > 0
        ? `${pending} операций ждут отправки в ИС МПТ (уйдут по настроенному обмену)`
        : 'Все операции с маркировкой отправлены' };
    });
  }

  async reports(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, kind, code, status, created_at, reported_at
           FROM marking_report WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, [accountId])).rows);
  }

  async stock(accountId: string) {
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM marking_stock($1)`, [accountId])).rows);
    return rows.map((r: any) => ({
      productId: r.product_id, product: r.product_name, marking: r.marking,
      inStock: Number(r.in_stock), sold: Number(r.sold), returned: Number(r.returned),
    }));
  }
}

// =====================================================================
@Controller('marking')
export class MarkingController {
  constructor(private svc: MarkingService) {}

  @Post('receive') @RequirePermission('stock', 'edit')
  receive(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.receive(ctx.accountId, d); }

  @Post('sell') @RequirePermission('goods', 'view')
  sell(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.sellCode(ctx.accountId, d); }

  @Post('return') @RequirePermission('stock', 'edit')
  returnCode(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.returnCode(ctx.accountId, d); }

  @Get('check') @RequirePermission('goods', 'view')
  check(@Ctx() ctx: EmployeeContext, @Query('code') code: string) { return this.svc.checkCode(ctx.accountId, code); }

  @Get('reports') @RequirePermission('stock', 'view')
  reports(@Ctx() ctx: EmployeeContext) { return this.svc.reports(ctx.accountId); }

  @Post('process-queue') @RequirePermission('stock', 'edit')
  processQueue(@Ctx() ctx: EmployeeContext) { return this.svc.processReportQueue(ctx.accountId); }

  @Get('stock') @RequirePermission('stock', 'view')
  stock(@Ctx() ctx: EmployeeContext) { return this.svc.stock(ctx.accountId); }
}

@Module({ controllers: [MarkingController], providers: [MarkingService, DbService] })
export class MarkingModule {}
