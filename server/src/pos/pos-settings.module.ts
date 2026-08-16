import { Controller, Get, Patch, Post, Body, Module, Injectable, BadRequestException } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission, Public, DeviceGuard, Dev } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { UseGuards, Query } from '@nestjs/common';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AuthModule } from '../auth/auth.module';

/**
 * НАСТРОЙКИ КАССЫ (часть 47).
 *
 * Три вещи, взятые у конкурентов и переосмысленные:
 *
 * 1. ПРАВА ПО ДЕЙСТВИЯМ (модель UMAG). Не запрет, а разрешение с
 *    подтверждением: кассир может сделать почти всё, но опасное —
 *    только с PIN администратора. Кассир не заблокирован, очередь не
 *    стоит, а действие оставляет след и сделано с чужого ведома.
 *
 * 2. ПОТОЛОК СКИДКИ (модель МоегоСклада). Запретить скидки совсем —
 *    плохо: продавцу иногда нужно уступить сто тенге, чтобы не
 *    потерять покупателя. Потолок честнее: «до 15% можно, дальше зови
 *    администратора».
 *
 * 3. ТЕКСТ ЧЕКА (модель UMAG и МоегоСклада). Заголовок и подвал задаёт
 *    владелец: адрес, телефон, «Спасибо за покупку». Чек — единственное,
 *    что покупатель уносит домой.
 */

const DEFAULTS = {
  act_refund: 'everyone', act_refund_free: 'admin_only',
  act_remove_item: 'everyone', act_reduce_qty: 'everyone',
  act_discount: 'everyone', act_price_change: 'admin_only',
  act_cash_out: 'admin_only',
  discount_allowed: true, discount_max_pct: 100, no_price_down: false,
  receipt_header: null as string | null, receipt_footer: 'Спасибо за покупку!' as string | null,
  // Бумажный чек: always / ask / never. Фискализацию не отключает —
  // в налоговую чек уходит в любом случае, не печатается только бумага.
  receipt_print_mode: 'always',
};

/** Что именно ограничиваем — с человеческими названиями для кабинета. */
export const POS_ACTIONS = [
  { code: 'act_refund', label: 'Возврат по чеку',
    why: 'Обычная операция, но ею же выносят деньги за несуществующую покупку' },
  { code: 'act_refund_free', label: 'Возврат без чека',
    why: 'Покупатель потерял чек. Проверить покупку нечем — самый рискованный возврат' },
  { code: 'act_remove_item', label: 'Удаление позиции из чека',
    why: 'Пробил, убрал, деньги забрал — классическая схема' },
  { code: 'act_reduce_qty', label: 'Уменьшение количества',
    why: 'То же самое, но незаметнее: было три, стало два' },
  { code: 'act_discount', label: 'Скидка',
    why: '«Скидка своим» не выглядит воровством: товар продан, чек пробит' },
  { code: 'act_price_change', label: 'Изменение цены',
    why: 'Снижение цены на кассе — самый тихий способ отдать товар дешевле' },
  { code: 'act_cash_out', label: 'Изъятие денег из кассы',
    why: 'Деньги уходят из ящика' },
] as const;

@Injectable()
export class PosSettingsService {
  constructor(private db: DbService) {}

  async get(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const r = (await c.query(`SELECT * FROM pos_settings WHERE account_id=$1`, [accountId])).rows[0];
      if (!r) return { ...DEFAULTS, accountId };
      return { ...r, discount_max_pct: Number(r.discount_max_pct) };
    });
  }

  async update(accountId: string, d: any) {
    const pct = d.discount_max_pct != null ? Number(d.discount_max_pct) : null;
    if (pct != null && (pct < 0 || pct > 100)) throw new BadRequestException('Потолок скидки от 0 до 100%');

    return this.db.withTenant(accountId, async (c) => {
      const cur = (await c.query(`SELECT * FROM pos_settings WHERE account_id=$1`, [accountId])).rows[0] ?? DEFAULTS;
      const v = { ...cur, ...d };
      await c.query(
        `INSERT INTO pos_settings (account_id, act_refund, act_refund_free, act_remove_item,
                act_reduce_qty, act_discount, act_price_change, act_cash_out,
                discount_allowed, discount_max_pct, no_price_down, receipt_header, receipt_footer,
                receipt_print_mode, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (account_id) DO UPDATE SET
           act_refund=$2, act_refund_free=$3, act_remove_item=$4, act_reduce_qty=$5,
           act_discount=$6, act_price_change=$7, act_cash_out=$8,
           discount_allowed=$9, discount_max_pct=$10, no_price_down=$11,
           receipt_header=$12, receipt_footer=$13, receipt_print_mode=$14, updated_at=now()`,
        [accountId, v.act_refund, v.act_refund_free, v.act_remove_item, v.act_reduce_qty,
         v.act_discount, v.act_price_change, v.act_cash_out,
         v.discount_allowed, v.discount_max_pct, v.no_price_down,
         v.receipt_header ?? null, v.receipt_footer ?? null,
         ['always','ask','never'].includes(v.receipt_print_mode) ? v.receipt_print_mode : 'always']);
      return this.get(accountId);
    });
  }

  /**
   * Проверка PIN администратора — для подтверждения действия на кассе.
   *
   * Возвращаем не «да/нет», а имя подтвердившего: оно попадает в журнал,
   * и владелец видит, кто именно разрешил. Без имени журнал бесполезен.
   */
  async approveByPin(accountId: string, pin: string) {
    return this.db.withTenant(accountId, async (c) => {
      const rows = (await c.query(
        `SELECT e.id, e.first_name, e.pin_hash, r.code AS role
           FROM employee e LEFT JOIN role r ON r.id = e.role_id
          WHERE e.account_id=$1 AND e.deleted_at IS NULL AND e.pin_hash IS NOT NULL
            AND (e.is_owner OR r.code IN ('owner','admin'))`, [accountId])).rows;

      const bcrypt = require('bcryptjs');
      for (const e of rows) {
        if (await bcrypt.compare(String(pin), e.pin_hash))
          return { ok: true, employeeId: e.id, name: e.first_name };
      }
      return { ok: false, reason: 'PIN не подошёл. Нужен PIN администратора или владельца' };
    });
  }

  /** Журнал действий кассира — для отчёта владельцу. */
  /** Последние действия по магазину — для показа на кассе при пересменке. */
  async shiftLog(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT l.action, l.product_name, l.amount, l.comment, l.at,
                e.first_name AS employee,
                a.first_name AS approved_by
           FROM pos_action_log l
           LEFT JOIN employee e ON e.id = l.employee_id
           LEFT JOIN employee a ON a.id = l.approved_by
          WHERE l.at > now() - interval '24 hours'
          ORDER BY l.at DESC LIMIT 50`)).rows
        .map((r: any) => ({
          action: r.action, product: r.product_name,
          amount: r.amount == null ? null : Number(r.amount),
          at: r.at, employee: r.employee, comment: r.comment,
          approvedBy: r.approved_by,        // кто разрешил, если действие требовало старшего
        })));
  }

  async log(accountId: string, d: {
    shiftId?: string; action: string; employeeId?: string; approvedBy?: string;
    productName?: string; amount?: number; comment?: string;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO pos_action_log (account_id, shift_id, action, employee_id, approved_by,
                product_name, amount, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [accountId, d.shiftId ?? null, d.action, d.employeeId ?? null, d.approvedBy ?? null,
         d.productName ?? null, d.amount ?? null, d.comment ?? null]);
      return { ok: true };
    });
  }

  /** Отчёт: что делали кассиры. Сгруппировано по человеку — владельцу
   *  важно не «сколько отмен всего», а «почему у Ерлана их втрое больше». */
  async actionReport(accountId: string, from: string, to: string) {
    return this.db.withTenant(accountId, async (c) => {
      const items = (await c.query(
        `SELECT l.id, l.action, l.product_name, l.amount, l.comment, l.at,
                e.first_name AS employee, a.first_name AS approved_by
           FROM pos_action_log l
           LEFT JOIN employee e ON e.id = l.employee_id
           LEFT JOIN employee a ON a.id = l.approved_by
          WHERE l.account_id=$1 AND l.at >= $2 AND l.at < $3
          ORDER BY l.at DESC LIMIT 500`, [accountId, from, to])).rows
        .map((r: any) => ({ ...r, amount: r.amount == null ? null : Number(r.amount) }));

      const by = new Map<string, any>();
      for (const it of items) {
        const k = it.employee ?? '—';
        const cur = by.get(k) ?? { employee: k, total: 0, refunds: 0, removals: 0, discounts: 0, sum: 0 };
        cur.total++;
        if (it.action.startsWith('refund')) cur.refunds++;
        if (it.action === 'remove_item' || it.action === 'reduce_qty') cur.removals++;
        if (it.action === 'discount') cur.discounts++;
        cur.sum += Number(it.amount ?? 0);
        by.set(k, cur);
      }
      return { items, byEmployee: [...by.values()].sort((a, b) => b.total - a.total), count: items.length };
    });
  }
}

// =====================================================================
@Controller('pos-settings')
export class PosSettingsController {
  constructor(private svc: PosSettingsService) {}

  @Get() @RequirePermission('settings', 'view')
  get(@Ctx() ctx: EmployeeContext) { return this.svc.get(ctx.accountId); }

  @Get('actions') @RequirePermission('settings', 'view')
  actions() { return POS_ACTIONS; }

  @Patch() @RequirePermission('settings', 'edit')
  update(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.update(ctx.accountId, d); }

  @Get('action-log') @RequirePermission('reports', 'view')
  report(@Ctx() ctx: EmployeeContext, @Body() _b: any) {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    return this.svc.actionReport(ctx.accountId, from, to);
  }
}

/** Что касса запрашивает у сервера: настройки и подтверждение PIN. */
@UseGuards(DeviceGuard)
@Controller('pos/settings')
export class PosDeviceSettingsController {
  constructor(private svc: PosSettingsService, private billing: BillingService) {}

  @Public() @Get()
  async get(@Dev() dev: any) {
    // Настройки и состояние подписки — ОДНИМ ответом. Касса спрашивает
    // их при входе и раз в час; второй запрос ради одного поля означал
    // бы лишнее ожидание там, где связь и так медленная.
    const [settings, access] = await Promise.all([
      this.svc.get(dev.account_id),
      this.billing.access(dev.account_id).catch((): any => null),
    ]);
    return { ...settings, lock: (access as any)?.lock ?? null,
             paidUntil: (access as any)?.paidUntil ?? null };
  }

  @Public() @Post('approve')
  approve(@Dev() dev: any, @Body() d: { pin: string }) {
    return this.svc.approveByPin(dev.account_id, d?.pin ?? '');
  }

  @Public() @Post('log')
  log(@Dev() dev: any, @Body() d: any) { return this.svc.log(dev.account_id, d); }

  /**
   * Журнал действий за текущую смену — для кассы.
   *
   * Отдельно от отчёта в кабинете: тот требует прав на отчёты, которых
   * у кассира нет и быть не должно. Здесь смотрят другое и по другой
   * причине — сменщик принимает кассу и хочет видеть, что делали до
   * него. Это снимает главное условие кражи: незаметность.
   *
   * Только последние 50 записей: это взгляд перед пересменкой, а не
   * отчёт. Полная история — у владельца в кабинете.
   */
  @Public() @Get('log')
  posLog(@Dev() dev: any) { return this.svc.shiftLog(dev.account_id); }
}

/**
 * Бонусы на кассе: сколько можно списать.
 *
 * Считает СЕРВЕР, а не касса. У программы лояльности есть потолок
 * (обычно половина чека) и срок сгорания — если повторить это правило
 * в кассе, появится второе место, где живёт та же логика, и однажды
 * они разойдутся. Расходиться будут деньги клиента.
 */
@UseGuards(DeviceGuard)
@Controller('pos/bonus')
export class PosBonusController {
  constructor(private loyalty: LoyaltyService) {}

  @Public() @Get('spendable')
  spendable(@Dev() dev: any, @Query('customerId') customerId: string, @Query('total') total: string) {
    return this.loyalty.spendable(dev.account_id, customerId, Number(total ?? 0));
  }
}

@Module({
  // AuthModule нужен из-за DeviceGuard: он проверяет токен устройства и
  // просит для этого службу входа. Без импорта сервер не поднимается
  // вовсе — компилятор такую ошибку не ловит, только запуск.
  imports: [AuthModule],
  controllers: [PosSettingsController, PosDeviceSettingsController, PosBonusController],
  providers: [PosSettingsService, LoyaltyService, DbService, BillingService],
})
export class PosSettingsModule {}
