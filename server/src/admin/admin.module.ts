/**
 * HTTP-слой кабинета. Вся бизнес-логика уже написана и покрыта тестами
 * на уровне сервисов (части 3–14) — здесь только тонкие контроллеры:
 * разбор запроса → вызов сервиса → ответ. Никакой логики в контроллерах,
 * иначе она уйдёт из-под 900 тестов.
 *
 * Права проверяются декоратором @RequirePermission по списку из
 * shared/permissions.json — единая точка на сервер, кассу и кабинет.
 */
import {
  Controller, Get, Post, Patch, Delete, Body, Query, Param, Module,
  BadRequestException,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SyncModule } from '../sync/sync.module';
import { GoodsModule } from '../goods/goods.module';
import { RequirePermission, Ctx, Public } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { DbService } from '../db/db.service';
import { SyncGateway } from '../sync/sync.gateway';
import { SyncService } from '../sync/sync.service';
import { GoodsService } from '../goods/goods.service';
import { ReportService, Period } from '../reports/report.service';
import { StockService } from '../stock/stock.service';
import { ContragentService } from '../contragents/contragent.service';
import { FinanceService } from '../finance/finance.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { DocumentService } from '../documents/document.service';
import { EquipmentService } from '../equipment/equipment.service';
import { BillingService } from '../billing/billing.service';
import { AiService } from '../ai/ai.service';
import { MigrationService } from '../migration/migration.service';
import { LabelsService } from '../goods/labels.service';
import { ImportService } from '../goods/import.service';
import { FiscalService } from '../fiscal/fiscal.service';

/**
 * Период отчёта: либо быстрый пресет (?period=week — как кнопки в UMAG),
 * либо произвольные границы (?from=...&to=...). Разбирается в одном месте,
 * чтобы все отчёты понимали параметры одинаково.
 */
/**
 * Дата без времени в «по» означает «по конец дня включительно»: владелец,
 * выбравший from=to=сегодня, ждёт сегодняшние продажи, а не пустой отчёт
 * (граблю поймал приёмочный тест части 18).
 */
function dayEnd(to: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999` : to;
}

function period(rep: ReportService, q: { period?: string; from?: string; to?: string }): Period {
  if (q.from && q.to) return { from: q.from, to: dayEnd(q.to) };
  const name = (q.period ?? 'today') as any;
  const allowed = ['today', 'yesterday', 'week', 'month', 'prev_month', 'quarter'];
  if (!allowed.includes(name)) throw new BadRequestException(`Период: ${allowed.join(', ')} или from+to`);
  return rep.quickPeriod(name);
}

// =====================================================================
// ОТЧЁТЫ И ДАШБОРД (модель «Главной» UMAG + отчёты Wipon)
// =====================================================================
@Controller('reports')
export class ReportsController {
  constructor(private rep: ReportService) {}

  @Get('dashboard') @RequirePermission('dashboard', 'view')
  dashboard(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.dashboardDay(ctx.accountId, q.period || q.from ? period(this.rep, q) : undefined,
      ctx.storeIds.length ? ctx.storeIds : undefined);
  }

  // Живой снимок для мобильного кабинета (часть 28): сводка дня + открытые смены
  @Get('mobile/snapshot') @RequirePermission('dashboard', 'view')
  mobileSnapshot(@Ctx() ctx: EmployeeContext) {
    return this.rep.mobileSnapshot(ctx.accountId, ctx.storeIds.length ? ctx.storeIds : undefined);
  }

  @Get('revenue-chart') @RequirePermission('dashboard', 'view')
  revenue(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.revenueChart(ctx.accountId, period(this.rep, q), ctx.storeIds.length ? ctx.storeIds : undefined);
  }

  @Get('mobile') @RequirePermission('dashboard', 'view')
  mobile(@Ctx() ctx: EmployeeContext) {
    return this.rep.ownerMobile(ctx.accountId, ctx.storeIds.length ? ctx.storeIds : undefined);
  }

  @Get('sales/products') @RequirePermission('reports', 'view')
  salesProducts(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.salesByProduct(ctx.accountId, period(this.rep, q),
      { categoryId: q.categoryId, limit: q.limit ? +q.limit : undefined });
  }

  @Get('sales/by/:dim') @RequirePermission('reports', 'view')
  salesBy(@Ctx() ctx: EmployeeContext, @Param('dim') dim: string, @Query() q: any) {
    if (!['category', 'supplier', 'customer'].includes(dim)) throw new BadRequestException('dim: category|supplier|customer');
    return this.rep.salesBy(ctx.accountId, dim as any, period(this.rep, q));
  }

  @Get('abc') @RequirePermission('reports', 'view')
  abc(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.abc(ctx.accountId, period(this.rep, q), q.categoryId);
  }

  @Get('cashiers') @RequirePermission('reports', 'view')
  cashiers(@Ctx() ctx: EmployeeContext, @Query() q: any) { return this.rep.cashiers(ctx.accountId, period(this.rep, q)); }

  @Get('shifts') @RequirePermission('reports', 'view')
  shifts(@Ctx() ctx: EmployeeContext, @Query() q: any) { return this.rep.shifts(ctx.accountId, period(this.rep, q)); }

  /** Отчёт по скидкам (модель UMAG) + кто их раздал. */
  @Get('discounts') @RequirePermission('reports', 'view')
  discounts(@Ctx() ctx: EmployeeContext, @Query() q: any) { return this.rep.discounts(ctx.accountId, period(this.rep, q)); }

  /** По консультантам: выручка, возвраты, «к выплате» (часть 18) */
  @Get('consultants') @RequirePermission('reports', 'view')
  consultants(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.consultants(ctx.accountId, period(this.rep, q));
  }

  @Get('shifts/:id') @RequirePermission('reports', 'view')
  shift(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.rep.shiftDetail(ctx.accountId, id); }

  @Get('profitability') @RequirePermission('reports', 'view')
  profitability(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.rep.profitability(ctx.accountId, period(this.rep, q), q.limit ? +q.limit : undefined);
  }

  /** Сводный отчёт по ККМ — для сверки с ОФД, как в Wipon */
  @Get('kkm/:registerId') @RequirePermission('reports', 'view')
  kkm(@Ctx() ctx: EmployeeContext, @Param('registerId') id: string, @Query() q: any) {
    return this.rep.kkmSummary(ctx.accountId, id, period(this.rep, q));
  }
}

// =====================================================================
// СКЛАД: приёмка, списание, перемещение, инвентаризация, остатки
// =====================================================================
@Controller('stock')
export class StockController {
  constructor(private stock: StockService) {}

  @Get('balance') @RequirePermission('stock', 'view')
  balance(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.stock.balance(ctx.accountId,
      { warehouseId: q.warehouseId, productId: q.productId, onlyNonZero: q.onlyNonZero === 'true' });
  }

  @Get('low') @RequirePermission('stock', 'view')
  low(@Ctx() ctx: EmployeeContext, @Query('warehouseId') wh?: string) { return this.stock.lowStock(ctx.accountId, wh); }

  @Get('replenishment') @RequirePermission('stock', 'view')
  replenishment(@Ctx() ctx: EmployeeContext, @Query('warehouseId') wh: string) {
    return this.stock.replenishmentPlan(ctx.accountId, wh);
  }

  @Get('notifications') @RequirePermission('stock', 'view')
  notifications(@Ctx() ctx: EmployeeContext) { return this.stock.notifications(ctx.accountId, ctx.employeeId); }

  @Get('docs') @RequirePermission('stock', 'view')
  docs(@Ctx() ctx: EmployeeContext, @Query('kind') kind?: string, @Query('status') status?: string,
       @Query('deleted') deleted?: string, @Query('q') q?: string) {
    return this.stock.docs(ctx.accountId, kind as any, status,
      { includeDeleted: deleted === 'true', q });
  }

  /** Вернуть удалённый документ (модель UMAG: удаление обратимо).
   *  Возвращается в черновик — чтобы человек посмотрел и провёл заново
   *  осознанно, а не чтобы движения появились сами собой. */
  @Post('docs/:id/restore') @RequirePermission('stock', 'edit')
  restoreDoc(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.stock.restoreDoc(ctx.accountId, id);
  }

  /** Комментарий к документу — заметка владельца, её можно менять всегда. */
  @Patch('docs/:id/comment') @RequirePermission('stock', 'edit')
  setDocComment(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { comment: string }) {
    return this.stock.setComment(ctx.accountId, id, d?.comment ?? '');
  }

  @Post('docs') @RequirePermission('stock', 'create')
  createDoc(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.stock.createDoc(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('docs/:id/items') @RequirePermission('stock', 'edit')
  addItem(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.stock.addItem(ctx.accountId, id, d);
  }

  /** Сканер в документ: штрихкод → строка (быстрая приёмка Wipon) */
  @Post('docs/:id/scan') @RequirePermission('stock', 'edit')
  scan(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { barcode: string; qty?: number }) {
    return this.stock.scanInto(ctx.accountId, id, d.barcode, d.qty);
  }

  @Post('docs/:id/fact') @RequirePermission('stock', 'edit')
  fact(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { productId: string; qty: number }) {
    return this.stock.setFact(ctx.accountId, id, d.productId, d.qty);
  }

  @Get('docs/:id/validate') @RequirePermission('stock', 'view')
  validate(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.stock.validate(ctx.accountId, id); }

  /** Проведение — только после него документ влияет на остатки (модель UMAG) */
  @Post('docs/:id/process') @RequirePermission('stock', 'edit')
  process(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { force?: boolean }) {
    return this.stock.process(ctx.accountId, id, { force: d?.force });
  }

  @Delete('docs/:id') @RequirePermission('stock', 'delete')
  del(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.stock.deleteDoc(ctx.accountId, id); }

  @Get('docs/:id/inventory-report') @RequirePermission('stock', 'view')
  invReport(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.stock.inventoryReport(ctx.accountId, id); }
}

// =====================================================================
// КОНТРАГЕНТЫ: покупатели, поставщики, долговая книга, заказы
// =====================================================================
@Controller('contragents')
export class ContragentsController {
  constructor(private cp: ContragentService) {}

  @Get() @RequirePermission('contragents', 'view')
  list(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.cp.list(ctx.accountId, { q: q.q, role: q.role, withDebtOnly: q.withDebt === 'true',
      archived: q.archived === 'true', groupName: q.groupName, limit: q.limit ? +q.limit : undefined });
  }

  @Post() @RequirePermission('contragents', 'create')
  create(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.cp.create(ctx.accountId, d); }

  /** Долговая книга — одна из главных страниц Wipon */
  @Get('debts') @RequirePermission('contragents', 'view')
  debts(@Ctx() ctx: EmployeeContext, @Query('overdueOnly') o?: string) {
    return this.cp.debtBook(ctx.accountId, o === 'true');
  }

  @Post('debts/pay') @RequirePermission('contragents', 'edit')
  payDebt(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.cp.payDebt(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('suppliers/pay') @RequirePermission('purchases', 'edit')
  paySupplier(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.cp.paySupplier(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Get('payments') @RequirePermission('contragents', 'view')
  payments(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.cp.paymentHistory(ctx.accountId, q.counterpartyId, q.limit ? +q.limit : undefined);
  }

  /** Реквизиты по ИИН/БИН — чтобы не набирать вручную */
  @Get('lookup/:iinBin') @RequirePermission('contragents', 'view')
  lookup(@Ctx() ctx: EmployeeContext, @Param('iinBin') v: string) { return this.cp.lookupByIinBin(ctx.accountId, v); }

  @Post('from-iin/:iinBin') @RequirePermission('contragents', 'create')
  fromIin(@Ctx() ctx: EmployeeContext, @Param('iinBin') v: string, @Body() d: any) {
    return this.cp.createFromIinBin(ctx.accountId, v, d ?? {});
  }

  // Заказы поставщикам (закупки)
  @Get('orders') @RequirePermission('purchases', 'view')
  orders(@Ctx() ctx: EmployeeContext, @Query('status') status?: string) { return this.cp.orders(ctx.accountId, status); }

  @Post('orders') @RequirePermission('purchases', 'create')
  createOrder(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.cp.createOrder(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Get('orders/:id') @RequirePermission('purchases', 'view')
  order(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.cp.order(ctx.accountId, id); }

  @Post('orders/:id/items') @RequirePermission('purchases', 'edit')
  orderItem(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.cp.addOrderItem(ctx.accountId, id, d);
  }

  @Post('orders/:id/send') @RequirePermission('purchases', 'edit')
  sendOrder(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.cp.sendOrder(ctx.accountId, id); }

  @Post('orders/:id/receive') @RequirePermission('purchases', 'edit')
  receiveOrder(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.cp.receiveOrder(ctx.accountId, id, ctx.employeeId);
  }

  @Get(':id/reconciliation') @RequirePermission('contragents', 'view')
  reconciliation(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.cp.reconciliationAct(ctx.accountId, id, q.from, dayEnd(q.to));
  }

  @Get(':id') @RequirePermission('contragents', 'view')
  card(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.cp.card(ctx.accountId, id); }

  @Patch(':id') @RequirePermission('contragents', 'edit')
  update(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.cp.update(ctx.accountId, id, d);
  }

  @Post(':id/archive') @RequirePermission('contragents', 'delete')
  archive(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.cp.archive(ctx.accountId, id, d?.archive ?? true);
  }
}

// =====================================================================
// ФИНАНСЫ: счета, ДДС, прибыли и убытки
// =====================================================================
@Controller('finance')
export class FinanceController {
  constructor(private fin: FinanceService) {}

  @Get('accounts') @RequirePermission('finance', 'view')
  accounts(@Ctx() ctx: EmployeeContext) { return this.fin.accounts(ctx.accountId); }

  @Post('accounts') @RequirePermission('finance', 'create')
  createAccount(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.fin.createAccount(ctx.accountId, d); }

  @Get('categories') @RequirePermission('finance', 'view')
  categories(@Ctx() ctx: EmployeeContext, @Query('direction') dir?: 'in' | 'out') {
    return this.fin.categories(ctx.accountId, dir);
  }

  @Post('categories') @RequirePermission('finance', 'create')
  createCategory(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.fin.createCategory(ctx.accountId, d); }

  @Post('expense') @RequirePermission('finance', 'create')
  expense(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.expense(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('income') @RequirePermission('finance', 'create')
  income(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.income(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('transfer') @RequirePermission('finance', 'edit')
  transfer(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.transfer(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  /** Инкассация выручки смены на счёт */
  @Post('collect') @RequirePermission('finance', 'edit')
  collect(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.collectFromShift(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('owner-draw') @RequirePermission('finance', 'edit')
  ownerDraw(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.ownerDraw(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Post('owner-deposit') @RequirePermission('finance', 'edit')
  ownerDeposit(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fin.ownerDeposit(ctx.accountId, { ...d, employeeId: d.employeeId ?? ctx.employeeId });
  }

  @Get('cash-flow') @RequirePermission('finance', 'view')
  cashFlow(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.fin.cashFlow(ctx.accountId, q.from, dayEnd(q.to), q.finAccountId);
  }

  @Get('pnl') @RequirePermission('finance', 'view')
  pnl(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.fin.profitLoss(ctx.accountId, q.from, dayEnd(q.to));
  }

  @Get('history') @RequirePermission('finance', 'view')
  history(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.fin.history(ctx.accountId, { finAccountId: q.finAccountId, from: q.from, to: q.to,
      kind: q.kind, limit: q.limit ? +q.limit : undefined });
  }
}

// =====================================================================
// ЛОЯЛЬНОСТЬ: бонусы, акции, сегменты, рассылки
// =====================================================================
@Controller('loyalty')
export class LoyaltyController {
  constructor(private loy: LoyaltyService) {}

  @Get('programs') @RequirePermission('loyalty', 'view')
  programs(@Ctx() ctx: EmployeeContext) { return this.loy.programs(ctx.accountId); }

  @Post('programs') @RequirePermission('loyalty', 'create')
  createProgram(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.loy.createProgram(ctx.accountId, d); }

  @Post('join') @RequirePermission('loyalty', 'edit')
  join(@Ctx() ctx: EmployeeContext, @Body() d: { counterpartyId: string; birthday?: string }) {
    return this.loy.joinLoyalty(ctx.accountId, d.counterpartyId, d.birthday);
  }

  @Get('balance/:counterpartyId') @RequirePermission('loyalty', 'view')
  balance(@Ctx() ctx: EmployeeContext, @Param('counterpartyId') id: string) { return this.loy.balance(ctx.accountId, id); }

  @Get('expiring') @RequirePermission('loyalty', 'view')
  expiring(@Ctx() ctx: EmployeeContext, @Query('days') days?: string) {
    return this.loy.expiringSoon(ctx.accountId, days ? +days : undefined);
  }

  @Post('promos') @RequirePermission('loyalty', 'create')
  createPromo(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.loy.createPromo(ctx.accountId, d); }

  @Get('segments') @RequirePermission('loyalty', 'view')
  segments(@Ctx() ctx: EmployeeContext) { return this.loy.segments(ctx.accountId); }

  @Get('campaigns') @RequirePermission('loyalty', 'view')
  campaigns(@Ctx() ctx: EmployeeContext) { return this.loy.campaigns(ctx.accountId); }

  @Get('analytics') @RequirePermission('loyalty', 'view')
  analytics(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.loy.analytics(ctx.accountId, q.from, q.to);
  }
}

// =====================================================================
// ДОКУМЕНТЫ КАЗАХСТАНА: ЭСФ, АВР, доверенности, налоговые регистры
// =====================================================================
@Controller('documents')
export class DocumentsController {
  constructor(private doc: DocumentService) {}

  @Get() @RequirePermission('documents', 'view')
  list(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.doc.list(ctx.accountId, { kind: q.kind, status: q.status, counterpartyId: q.counterpartyId,
      from: q.from, to: q.to, limit: q.limit ? +q.limit : undefined });
  }

  @Get('keys/health') @RequirePermission('documents', 'view')
  keyHealth(@Ctx() ctx: EmployeeContext) { return this.doc.keyHealth(ctx.accountId); }

  @Post('keys') @RequirePermission('settings', 'edit')
  addKey(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.doc.addKey(ctx.accountId, d); }

  @Post('esf/from-supply/:stockDocId') @RequirePermission('documents', 'create')
  esfSupply(@Ctx() ctx: EmployeeContext, @Param('stockDocId') id: string) {
    return this.doc.esfFromSupply(ctx.accountId, id, ctx.employeeId);
  }

  @Post('esf/from-sale/:saleId') @RequirePermission('documents', 'create')
  esfSale(@Ctx() ctx: EmployeeContext, @Param('saleId') id: string) {
    return this.doc.esfFromSale(ctx.accountId, id, ctx.employeeId);
  }

  @Post(':id/send') @RequirePermission('documents', 'edit')
  send(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.doc.sendDoc(ctx.accountId, id, d?.keyId);
  }

  @Post('avr') @RequirePermission('documents', 'create')
  avr(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.doc.createAvr(ctx.accountId, d); }

  @Post('poa') @RequirePermission('documents', 'create')
  poa(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.doc.createPoa(ctx.accountId, d); }

  @Get('print/:form/:sourceId') @RequirePermission('documents', 'view')
  print(@Ctx() ctx: EmployeeContext, @Param('form') form: string, @Param('sourceId') id: string) {
    return this.doc.printForm(ctx.accountId, form as any, id);
  }

  @Get('tax/income') @RequirePermission('documents', 'view')
  taxIncome(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.doc.taxRegisterIncome(ctx.accountId, q.from, q.to);
  }

  @Get('tax/purchases') @RequirePermission('documents', 'view')
  taxPurchases(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    if (!q.from || !q.to) throw new BadRequestException('Нужны from и to');
    return this.doc.taxRegisterPurchases(ctx.accountId, q.from, q.to);
  }
}

// =====================================================================
// ТОЧКИ И КАССЫ (часть 16): без этого владельцу нечем создать кассу,
// а без кассы не выписать код привязки. Модель UMAG «Управление кассами»:
// таблица касс с платформой/последней синхронизацией + одноразовый ключ
// авторизации (он у нас в /auth/devices/pairing-code).
// =====================================================================
@Controller('admin/stores')
export class AdminStoresController {
  constructor(private db: DbService) {}

  @Get() @RequirePermission('settings', 'view')
  list(@Ctx() ctx: EmployeeContext) {
    return this.db.withTenant(ctx.accountId, async (c) => {
      const stores = (await c.query(
        `SELECT s.id, s.name, s.address,
                (SELECT id FROM warehouse w WHERE w.store_id = s.id LIMIT 1) AS warehouse_id
           FROM store s WHERE s.deleted_at IS NULL ORDER BY s.created_at`)).rows;
      const regs = (await c.query(
        `SELECT cr.id, cr.store_id, cr.name, cr.is_active,
                (SELECT count(*)::int FROM device dd WHERE dd.cash_register_id = cr.id AND NOT dd.is_blocked) AS devices,
                (SELECT max(d.last_seen_at) FROM device d WHERE d.cash_register_id = cr.id) AS last_seen_at
           FROM cash_register cr
          WHERE cr.deleted_at IS NULL ORDER BY cr.created_at`)).rows;
      return stores.map((s: any) => ({ ...s, registers: regs.filter((r: any) => r.store_id === s.id) }));
    });
  }

  @Post('registers') @RequirePermission('devices', 'create')
  createRegister(@Ctx() ctx: EmployeeContext, @Body() d: { storeId?: string; name?: string }) {
    return this.db.withTenant(ctx.accountId, async (c) => {
      const store = d.storeId
        ? (await c.query(`SELECT id FROM store WHERE id=$1`, [d.storeId])).rows[0]
        : (await c.query(`SELECT id FROM store WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`)).rows[0];
      if (!store) throw new BadRequestException('Точка не найдена');
      const wh = (await c.query(`SELECT id FROM warehouse WHERE store_id=$1 LIMIT 1`, [store.id])).rows[0];
      const n = (await c.query(`SELECT count(*)::int + 1 AS n FROM cash_register WHERE store_id=$1`, [store.id])).rows[0].n;
      const { rows } = await c.query(
        `INSERT INTO cash_register (account_id, store_id, warehouse_id, name)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [ctx.accountId, store.id, wh?.id ?? null, d.name ?? `Касса ${n}`]);
      return rows[0];
    });
  }
}

// =====================================================================
// ОБОРУДОВАНИЕ: весы, принтеры этикеток, дисплеи покупателя
// =====================================================================
@Controller('equipment')
export class EquipmentController {
  constructor(private eq: EquipmentService) {}

  @Get() @RequirePermission('devices', 'view')
  list(@Ctx() ctx: EmployeeContext, @Query('kind') kind?: string) { return this.eq.list(ctx.accountId, kind); }

  @Post() @RequirePermission('devices', 'create')
  add(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.eq.add(ctx.accountId, d); }

  @Post('discover') @RequirePermission('devices', 'view')
  discover(@Ctx() ctx: EmployeeContext, @Body() d: { subnet: string; port?: number; timeoutMs?: number }) {
    return this.eq.discover(ctx.accountId, d.subnet, { port: d.port, timeoutMs: d.timeoutMs });
  }

  @Post(':id/auto-assign') @RequirePermission('devices', 'edit')
  autoAssign(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.eq.autoAssign(ctx.accountId, id); }

  /** Выгрузка PLU в весы — сценарий Rongta из Wipon */
  @Post(':id/plu') @RequirePermission('devices', 'edit')
  uploadPlu(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.eq.uploadPlu(ctx.accountId, id); }

  @Get(':id/plu-diff') @RequirePermission('devices', 'view')
  pluDiff(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.eq.pluDiff(ctx.accountId, id); }

  @Post(':id/sync-prices') @RequirePermission('devices', 'edit')
  syncPrices(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.eq.syncPrices(ctx.accountId, id); }

  @Post(':id/test-label') @RequirePermission('devices', 'edit')
  testLabel(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.eq.printTestLabel(ctx.accountId, id); }

  @Get('diagnose') @RequirePermission('devices', 'view')
  diagnose(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.eq.diagnose(ctx.accountId, { cashRegisterId: q.cashRegisterId, employeeId: ctx.employeeId });
  }

  @Get('troubleshoot/:symptom') @RequirePermission('devices', 'view')
  troubleshoot(@Param('symptom') s: string) { return this.eq.troubleshoot(s as any); }
}

// =====================================================================
// БИЛЛИНГ И ПОДПИСКА
// =====================================================================
/**
 * ПОДПИСКА И ПЛАТЕЖИ — своё право `billing`, а не общее `settings`.
 *
 * Зачем разделили: подписка это деньги, а настройки это фискализация,
 * оборудование и доступы. Владелец должен уметь дать бухгалтеру оплату
 * счетов, не открывая ему настройку кассовых аппаратов. Раньше это было
 * одно право на двоих, и раздел «Подписка» пришлось бы прятать от всех,
 * кому не доверены настройки.
 */
@Controller('billing')
export class BillingController {
  constructor(private bill: BillingService) {}

  @Get('tariffs') @RequirePermission('billing', 'view')
  tariffs() { return this.bill.tariffs(); }

  @Get('access') @RequirePermission('billing', 'view')
  access(@Ctx() ctx: EmployeeContext) { return this.bill.access(ctx.accountId); }



  @Post('subscribe') @RequirePermission('billing', 'edit')
  subscribe(@Ctx() ctx: EmployeeContext, @Body() d: { tariffCode: string; stores?: number }) {
    return this.bill.subscribe(ctx.accountId, d.tariffCode, d.stores ?? 1);
  }

  @Post('topup') @RequirePermission('billing', 'edit')
  topup(@Ctx() ctx: EmployeeContext, @Body() d: { amount: number; comment?: string }) {
    return this.bill.topup(ctx.accountId, d.amount, d.comment);
  }

  // ---- онлайн-оплата (часть 29) ----
  @Post('invoice') @RequirePermission('billing', 'edit')
  createInvoice(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.bill.createInvoice(ctx.accountId, d);
  }

  @Get('invoices') @RequirePermission('billing', 'view')
  invoices(@Ctx() ctx: EmployeeContext) { return this.bill.invoices(ctx.accountId); }

  @Post('auto-renew') @RequirePermission('billing', 'edit')
  autoRenew(@Ctx() ctx: EmployeeContext, @Body() d: { enabled: boolean }) {
    return this.bill.setAutoRenew(ctx.accountId, d.enabled);
  }

  /**
   * Подписка глазами владельца магазина — ОДНИМ ответом.
   *
   * Порядок в ответе обратный привычному, как у соседей: сначала
   * состояние одной фразой, потом куда платить, и только затем
   * подробности. У них «Куда платить» стояло под четырьмя равными
   * карточками, а «Я оплатил» — в самом низу, после настроек зала.
   *
   * Суммы и скидки берём с сервера как есть и на стороне кабинета не
   * пересчитываем: владелец платформы меняет их у себя, и если считать
   * по-своему, клиент увидит одно, а заплатит другое.
   */
  @Get('subscription') @RequirePermission('billing', 'view')
  subscription(@Ctx() ctx: EmployeeContext) { return this.bill.clientView(ctx.accountId); }

  /**
   * «Я оплатил» — клиент говорит, что деньги отправлены.
   *
   * Доступ при этом НЕ открывается: только владелец платформы сверяет
   * поступление и подтверждает. Но сообщение уходит ему сразу, а
   * клиент видит, что заявление принято, и не звонит с вопросом.
   */
  @Post('declare-payment') @RequirePermission('billing', 'edit')
  declare(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.bill.declarePayment(ctx.accountId, ctx.employeeId, d ?? {});
  }

  @Post('run-auto-renew') @RequirePermission('billing', 'edit')
  runAutoRenew(@Ctx() ctx: EmployeeContext) { return this.bill.runAutoRenew(ctx.accountId); }

  // ПУБЛИЧНЫЙ webhook оплаты — приходит от провайдера, без токена, но с
  // проверкой подписи. Идемпотентен (двойной вызов не задвоит баланс).
  @Public() @Post('payment-webhook/:provider')
  paymentWebhook(@Param('provider') provider: string, @Body() body: any,
                 @Query('signature') sig?: string) {
    // подпись обычно в заголовке; для простоты и теста принимаем и в query
    return this.bill.handlePaymentWebhook(provider, JSON.stringify(body), sig, body);
  }

  @Get('history') @RequirePermission('billing', 'view')
  history(@Ctx() ctx: EmployeeContext) { return this.bill.history(ctx.accountId); }

  /** Журнал действий сотрудников — «кто удалил товар» */
  @Get('audit') @RequirePermission('billing', 'view')
  audit(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.bill.audit(ctx.accountId, { entity: q.entity, employeeId: q.employeeId,
      limit: q.limit ? +q.limit : undefined });
  }
}

// =====================================================================
// ИИ-ФУНКЦИИ: товар по фото/голосу, накладная по фото, советы по закупу
// =====================================================================
@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}

  @Post('product-from-photo') @RequirePermission('goods', 'create')
  productPhoto(@Ctx() ctx: EmployeeContext, @Body() d: { imageRef: string }) {
    return this.ai.productFromPhoto(ctx.accountId, { imageRef: d.imageRef, employeeId: ctx.employeeId ?? undefined });
  }

  @Post('product-from-voice') @RequirePermission('goods', 'create')
  productVoice(@Ctx() ctx: EmployeeContext, @Body() d: { text: string }) {
    return this.ai.productFromVoice(ctx.accountId, { text: d.text, employeeId: ctx.employeeId ?? undefined });
  }

  @Post('invoice-from-photo') @RequirePermission('stock', 'create')
  invoicePhoto(@Ctx() ctx: EmployeeContext, @Body() d: { imageRef: string }) {
    return this.ai.invoiceFromPhoto(ctx.accountId, { imageRef: d.imageRef, employeeId: ctx.employeeId ?? undefined });
  }

  // AI-приёмка на максимум (часть 33)
  @Post('process-queue') @RequirePermission('goods', 'edit')
  aiProcessQueue(@Ctx() ctx: EmployeeContext) { return this.ai.processQueue(ctx.accountId); }

  @Post('receive-from-photo') @RequirePermission('stock', 'create')
  receiveFromPhoto(@Ctx() ctx: EmployeeContext, @Body() d: { taskId: string; warehouseId: string }) {
    return this.ai.receiveFromInvoicePhoto(ctx.accountId, { taskId: d.taskId, warehouseId: d.warehouseId, employeeId: ctx.employeeId ?? undefined });
  }

  @Post('check-invoice') @RequirePermission('stock', 'view')
  checkInvoice(@Ctx() ctx: EmployeeContext, @Body() d: { taskId: string; orderId?: string }) {
    return this.ai.checkInvoiceAgainstOrder(ctx.accountId, d);
  }

  @Post('voice-inventory') @RequirePermission('stock', 'view')
  voiceInventory(@Ctx() ctx: EmployeeContext, @Body() d: { text: string }) {
    return this.ai.parseVoiceInventory(ctx.accountId, d);
  }

  @Get('tasks') @RequirePermission('goods', 'view')
  tasks(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    return this.ai.tasks(ctx.accountId, { kind: q.kind, status: q.status, limit: q.limit ? +q.limit : undefined });
  }

  @Post('tasks/:id/confirm') @RequirePermission('goods', 'create')
  confirm(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.ai.confirmProduct(ctx.accountId, { ...d, taskId: id, employeeId: ctx.employeeId ?? undefined });
  }

  @Post('tasks/:id/reject') @RequirePermission('goods', 'edit')
  reject(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.ai.rejectTask(ctx.accountId, id, ctx.employeeId ?? undefined);
  }

  @Get('restock-advice') @RequirePermission('reports', 'view')
  restock(@Ctx() ctx: EmployeeContext, @Query('days') days?: string) {
    return this.ai.restockAdvice(ctx.accountId, days ? +days : undefined);
  }
}

// =====================================================================
// ОНБОРДИНГ И ПЕРЕЕЗД С UMAG
// =====================================================================
@Controller('onboarding')
export class OnboardingController {
  constructor(private mig: MigrationService) {}

  @Get() @RequirePermission('settings', 'view')
  state(@Ctx() ctx: EmployeeContext) { return this.mig.onboardingState(ctx.accountId); }

  @Post('steps/:code/complete') @RequirePermission('settings', 'edit')
  complete(@Ctx() ctx: EmployeeContext, @Param('code') code: string, @Body() payload: any) {
    return this.mig.completeStep(ctx.accountId, code, payload, ctx.employeeId ?? undefined);
  }

  @Post('steps/:code/skip') @RequirePermission('settings', 'edit')
  skip(@Ctx() ctx: EmployeeContext, @Param('code') code: string) { return this.mig.skipStep(ctx.accountId, code); }

  @Post('source') @RequirePermission('settings', 'edit')
  source(@Ctx() ctx: EmployeeContext, @Body() d: { source: string }) {
    return this.mig.setSource(ctx.accountId, d.source as any);
  }
}

// =====================================================================
// ЭТИКЕТКИ И ЦЕННИКИ
// =====================================================================
@Controller('labels')
export class LabelsController {
  constructor(private lbl: LabelsService) {}

  @Get('templates') @RequirePermission('goods', 'view')
  templates(@Ctx() ctx: EmployeeContext, @Query('kind') kind?: 'label' | 'price_tag') {
    return this.lbl.templates(ctx.accountId, kind);
  }

  @Post('templates') @RequirePermission('goods', 'edit')
  saveTemplate(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.lbl.saveTemplate(ctx.accountId, d); }

  @Post('render') @RequirePermission('goods', 'view')
  render(@Ctx() ctx: EmployeeContext, @Body() d: { templateId: string; items: any[]; storeId?: string }) {
    return this.lbl.render(ctx.accountId, d.templateId, d.items, d.storeId);
  }

  @Post('print') @RequirePermission('goods', 'view')
  print(@Ctx() ctx: EmployeeContext, @Body() d: { templateId: string; items: any[]; storeId?: string }) {
    return this.lbl.print(ctx.accountId, ctx.employeeId, d.templateId, d.items, d.storeId);
  }

  @Get('history') @RequirePermission('goods', 'view')
  history(@Ctx() ctx: EmployeeContext, @Query('limit') limit?: string) {
    return this.lbl.history(ctx.accountId, limit ? +limit : undefined);
  }

  @Post('history/:id/repeat') @RequirePermission('goods', 'view')
  repeat(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.lbl.repeat(ctx.accountId, ctx.employeeId, id);
  }
}

// =====================================================================
// ИМПОРТ ТОВАРОВ ИЗ EXCEL (файл приходит как base64 — таблицы небольшие)
// =====================================================================
@Controller('import')
export class ImportController {
  constructor(private imp: ImportService) {}

  @Get('template') @RequirePermission('goods', 'view')
  template(@Query('kind') kind?: 'simple' | 'full' | 'kz') {
    const buf = this.imp.template(kind ?? 'kz');
    return { fileName: `import_${kind ?? 'kz'}.xlsx`, base64: buf.toString('base64') };
  }

  @Post('preview') @RequirePermission('goods', 'create')
  preview(@Ctx() ctx: EmployeeContext, @Body() d: { fileName: string; base64: string; hasHeader?: boolean }) {
    return this.imp.preview(ctx.accountId, ctx.employeeId, Buffer.from(d.base64, 'base64'), d.fileName, d.hasHeader ?? true);
  }

  @Post('run') @RequirePermission('goods', 'create')
  run(@Ctx() ctx: EmployeeContext, @Body() d: { sessionId: string; base64: string; mapping?: any; mode?: any }) {
    return this.imp.run(ctx.accountId, d.sessionId, Buffer.from(d.base64, 'base64'), { mapping: d.mapping, mode: d.mode } as any);
  }

  @Post(':sessionId/rollback') @RequirePermission('goods', 'delete')
  rollback(@Ctx() ctx: EmployeeContext, @Param('sessionId') id: string) { return this.imp.rollback(ctx.accountId, id); }

  @Get('history') @RequirePermission('goods', 'view')
  history(@Ctx() ctx: EmployeeContext) { return this.imp.history(ctx.accountId); }
}

// =====================================================================
// ФИСКАЛИЗАЦИЯ (настройка ККМ; сами чеки уходят с кассы)
// =====================================================================
@Controller('fiscal')
export class FiscalController {
  constructor(private fis: FiscalService) {}

  @Post('register') @RequirePermission('settings', 'edit')
  register(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.fis.registerKkm(ctx.accountId, d); }

  @Get('health') @RequirePermission('settings', 'view')
  health(@Ctx() ctx: EmployeeContext) { return this.fis.health(ctx.accountId); }

  @Post('process-queue') @RequirePermission('settings', 'edit')
  processQueue(@Ctx() ctx: EmployeeContext, @Query('limit') limit?: string) {
    return this.fis.processQueue(ctx.accountId, limit ? +limit : undefined);
  }

  // ---- боевой режим (часть 23) ----
  @Get('readiness') @RequirePermission('settings', 'view')
  readiness(@Ctx() ctx: EmployeeContext) { return this.fis.readiness(ctx.accountId); }

  @Post('check-connection') @RequirePermission('settings', 'edit')
  checkConnection(@Ctx() ctx: EmployeeContext, @Body() d: { kkmId: string }) {
    return this.fis.checkConnection(ctx.accountId, d.kkmId);
  }

  @Post('set-env') @RequirePermission('settings', 'edit')
  setEnv(@Ctx() ctx: EmployeeContext, @Body() d: { kkmId: string; env: 'test' | 'production' }) {
    return this.fis.setEnv(ctx.accountId, d.kkmId, d.env);
  }

  @Post('correction') @RequirePermission('settings', 'edit')
  correction(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.fis.correction(ctx.accountId, ctx.employeeId, d);
  }

  @Get('corrections') @RequirePermission('settings', 'view')
  corrections(@Ctx() ctx: EmployeeContext) { return this.fis.corrections(ctx.accountId); }
}

// =====================================================================
// Провайдеры. ReportService получает шлюз синхронизации, чтобы пуши
// «дашборд обновился» уходили в открытые кабинеты по WebSocket.
// =====================================================================

// =====================================================================
// КОНСУЛЬТАНТЫ (часть 18). Справочник UMAG (ID, имя, телефон) + наш
// процент: отчёт сам считает «к выплате», а не оставляет владельца с Excel.
// =====================================================================
@Controller('admin/consultants')
export class AdminConsultantsController {
  constructor(private db: DbService) {}

  @Get() @RequirePermission('employees', 'view')
  list(@Ctx() ctx: EmployeeContext) {
    return this.db.withTenant(ctx.accountId, async (c) =>
      (await c.query(`SELECT id, name, phone, commission_percent, is_active
                        FROM consultant WHERE deleted_at IS NULL ORDER BY name`)).rows
        .map((r: any) => ({ ...r, commission_percent: Number(r.commission_percent) })));
  }

  @Post() @RequirePermission('employees', 'create')
  create(@Ctx() ctx: EmployeeContext, @Body() d: { name: string; phone?: string; commissionPercent?: number }) {
    if (!d.name?.trim()) throw new BadRequestException('Имя обязательно');
    const pct = d.commissionPercent ?? 0;
    if (pct < 0 || pct > 50) throw new BadRequestException('Процент консультанта: 0–50');
    return this.db.withTenant(ctx.accountId, async (c) =>
      (await c.query(
        `INSERT INTO consultant (account_id, name, phone, commission_percent)
         VALUES ($1,$2,$3,$4) RETURNING id, name, phone, commission_percent, is_active`,
        [ctx.accountId, d.name.trim(), d.phone ?? null, pct])).rows[0]);
  }

  @Patch(':id') @RequirePermission('employees', 'edit')
  update(@Ctx() ctx: EmployeeContext, @Param('id') id: string,
         @Body() d: { name?: string; phone?: string; commissionPercent?: number; isActive?: boolean }) {
    return this.db.withTenant(ctx.accountId, async (c) => {
      const { rows } = await c.query(
        `UPDATE consultant SET name = coalesce($2, name), phone = coalesce($3, phone),
                commission_percent = coalesce($4, commission_percent),
                is_active = coalesce($5, is_active), updated_at = now()
          WHERE id=$1 AND deleted_at IS NULL RETURNING id, name, phone, commission_percent, is_active`,
        [id, d.name ?? null, d.phone ?? null, d.commissionPercent ?? null, d.isActive ?? null]);
      if (!rows[0]) throw new BadRequestException('Консультант не найден');
      return rows[0];
    });
  }
}

@Module({
  imports: [AuthModule, SyncModule, GoodsModule],
  // ReportService отдаём наружу: экспорт в Excel (часть 21) считает те же
  // отчёты, что кабинет, — второй копии сервиса быть не должно
  exports: [ReportService, DbService],
  controllers: [
    AdminStoresController,
    AdminConsultantsController,
    ReportsController, StockController, ContragentsController, FinanceController,
    LoyaltyController, DocumentsController, EquipmentController, BillingController,
    AiController, OnboardingController, LabelsController, ImportController, FiscalController,
  ],
  providers: [
    DbService,
    { provide: ReportService, useFactory: (db: DbService, gw: SyncGateway) => new ReportService(db, gw), inject: [DbService, SyncGateway] },
    { provide: StockService, useFactory: (db: DbService, sync: SyncService, goods: GoodsService) => new StockService(db, sync, goods), inject: [DbService, SyncService, GoodsService] },
    ContragentService, FinanceService, LoyaltyService, DocumentService,
    EquipmentService, BillingService, AiService, MigrationService,
    LabelsService, ImportService, FiscalService,
  ],
})
export class AdminApiModule {}
