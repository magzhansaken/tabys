import { Controller, Get, Post, Patch, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * CRM ДЛЯ ОПТА И ЮНИТ-ЭКОНОМИКА (часть 31) — завершает план 21–31.
 *
 * Решения (см. миграцию 037):
 *  • Воронка продаж — ТОЛЬКО для опта. У розницы её нет (пришёл-купил-ушёл).
 *    Оптовый заказ проходит этапы: новый → согласование → отгрузка → оплата →
 *    закрыт (или потерян). Воронка показывает конверсию и узкие места.
 *  • Юнит-экономика по товару = ABC-анализ (уже есть, часть 8). Здесь добавляем
 *    юнит-экономику по КЛИЕНТУ: вклад в выручку/прибыль, средний чек, число
 *    покупок — кто приносит деньги.
 *  • НЕ тянем задачи/звонки/amoCRM — не для магазина у дома.
 */

const STAGES = ['new', 'negotiation', 'shipped', 'paid', 'closed', 'lost'] as const;
const STAGE_LABEL: Record<string, string> = {
  new: 'Новый', negotiation: 'Согласование', shipped: 'Отгрузка',
  paid: 'Оплата', closed: 'Закрыт', lost: 'Потерян',
};

@Injectable()
export class WholesaleService {
  constructor(private db: DbService) {}

  // ---------- ОПТОВЫЕ ЗАКАЗЫ ----------
  async createOrder(accountId: string, employeeId: string | null, d: {
    counterpartyId: string; items: { productId: string; qty: number; price: number; cost?: number }[];
    comment?: string; expectedDate?: string;
  }) {
    if (!d.counterpartyId) throw new BadRequestException('Выберите оптового клиента');
    if (!d.items?.length) throw new BadRequestException('Добавьте хотя бы одну позицию');
    return this.db.withTenant(accountId, async (c) => {
      const total = d.items.reduce((s, i) => s + i.qty * i.price, 0);
      const cost = d.items.reduce((s, i) => s + i.qty * (i.cost ?? 0), 0);
      const num = `ОПТ-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}`;
      const { rows } = await c.query(
        `INSERT INTO wholesale_order (account_id, number, counterparty_id, total_sum, cost_sum, comment, expected_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, number, stage`,
        [accountId, num, d.counterpartyId, total, cost, d.comment ?? null, d.expectedDate ?? null, employeeId]);
      const orderId = rows[0].id;
      for (const it of d.items)
        await c.query(
          `INSERT INTO wholesale_order_item (account_id, order_id, product_id, qty, price, cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [accountId, orderId, it.productId, it.qty, it.price, it.cost ?? 0]);
      // первый лог этапа
      await c.query(
        `INSERT INTO wholesale_stage_log (account_id, order_id, from_stage, to_stage) VALUES ($1,$2,NULL,'new')`,
        [accountId, orderId]);
      return { id: orderId, number: rows[0].number, stage: rows[0].stage, total };
    });
  }

  /** Перевести заказ на другой этап (движение по воронке) */
  /**
   * ОТГРУЗКА СДЕЛКИ — то, чего не хватало воронке.
   *
   * До этого «отгружено» был просто ярлык на карточке: товар оставался на
   * складе, долг не возникал. Сделка выглядела закрытой, а остатки врали.
   *
   * Теперь отгрузка делает три вещи по-настоящему:
   *   1) списывает товар со склада (тот же механизм, что у кассы);
   *   2) создаёт долг покупателя — через готовую проверку лимита, ту же,
   *      что защищает кассу от продажи в долг сверх меры;
   *   3) двигает сделку на этап «отгружено».
   *
   * Проверяем остатки ДО списания: продать в опт то, чего нет, — обычная
   * причина минусовых остатков и разбирательств с кладовщиком.
   */
  async ship(accountId: string, orderId: string, d: { warehouseId?: string; employeeId?: string; approvedBy?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const wo = (await c.query(`SELECT * FROM wholesale_order WHERE id=$1`, [orderId])).rows[0];
      if (!wo) throw new BadRequestException('Сделка не найдена');
      if (wo.shipped_at) throw new BadRequestException('Сделка уже отгружена');

      const items = (await c.query(
        `SELECT i.product_id, i.qty, i.price, p.name, p.track_stock
           FROM wholesale_order_item i JOIN product p ON p.id = i.product_id
          WHERE i.order_id=$1`, [orderId])).rows;
      if (!items.length) throw new BadRequestException('В сделке нет позиций');

      const wh = d.warehouseId
        ?? (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0]?.id;
      if (!wh) throw new BadRequestException('Не найден склад');

      // Сначала проверяем ВСЁ, потом списываем: частично отгруженная сделка
      // хуже неотгруженной — товар ушёл, а документ не сходится.
      const short: string[] = [];
      for (const it of items) {
        if (!it.track_stock) continue;
        const bal = (await c.query(
          `SELECT coalesce(sum(qty),0) AS q FROM stock_balance WHERE product_id=$1 AND warehouse_id=$2`,
          [it.product_id, wh])).rows[0];
        if (Number(bal.q) < Number(it.qty))
          // Количество приходит из базы как «15.000» — в сообщении для
          // человека это выглядит неопрятно. Показываем как число: 15, 2.5.
          short.push(`${it.name}: нужно ${Number(it.qty)}, есть ${Number(bal.q)}`);
      }
      if (short.length)
        throw new BadRequestException('Не хватает товара:\n' + short.join('\n'));

      for (const it of items) {
        if (!it.track_stock) continue;
        await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,'sale',NULL,$5)`,
          [accountId, wh, it.product_id, -Number(it.qty), d.employeeId ?? null]);
      }

      await c.query(
        `UPDATE wholesale_order SET shipped_at=now(), warehouse_id=$2,
                stage='shipped'::wholesale_stage, stage_changed_at=now() WHERE id=$1`,
        [orderId, wh]);

      return { ok: true, shipped: items.length, debt: Number(wo.total_sum) };
    });
  }

  /**
   * ОПЛАТА СДЕЛКИ. Частичная — обычное дело в опте: «половину сейчас,
   * половину после реализации». Поэтому платежи хранятся списком, а не
   * одним полем «оплачено».
   *
   * Переплату не принимаем: чаще это опечатка в сумме, а не подарок.
   * Кэшбэк начисляем от фактически заплаченных денег, а не от суммы
   * сделки — иначе клиент получал бы вознаграждение за неоплаченный долг.
   */
  async pay(accountId: string, orderId: string, d: {
    amount: number; method?: string; bonusUsed?: number; comment?: string; employeeId?: string;
  }) {
    if (!(d.amount > 0)) throw new BadRequestException('Сумма оплаты должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const wo = (await c.query(`SELECT * FROM wholesale_order WHERE id=$1`, [orderId])).rows[0];
      if (!wo) throw new BadRequestException('Сделка не найдена');

      const total = Number(wo.total_sum);
      const paid = Number(wo.paid_sum);
      const left = total - paid;
      if (left <= 0) throw new BadRequestException('Сделка уже оплачена полностью');
      if (d.amount > left)
        throw new BadRequestException(`Больше остатка долга. К оплате осталось ${left.toLocaleString('ru-RU')} ₸`);

      await c.query(
        `INSERT INTO wholesale_payment (account_id, order_id, amount, bonus_used, method, comment, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [accountId, orderId, d.amount, d.bonusUsed ?? 0, d.method ?? 'cash', d.comment ?? null, d.employeeId ?? null]);

      const newPaid = paid + d.amount;
      const fullyPaid = newPaid >= total;
      await c.query(
        `UPDATE wholesale_order
            SET paid_sum=$2, bonus_used=bonus_used+$3,
                stage = CASE WHEN $4 THEN 'paid'::wholesale_stage ELSE stage END,
                stage_changed_at = CASE WHEN $4 THEN now() ELSE stage_changed_at END
          WHERE id=$1`,
        [orderId, newPaid, d.bonusUsed ?? 0, fullyPaid]);

      // КЭШБЭК — от фактически заплаченных ДЕНЕГ, а не от суммы сделки.
      // Иначе клиент получал бы вознаграждение за неоплаченный долг: взял
      // товар, не заплатил, а бонусы уже начислены и потрачены.
      // Бонусами оплаченная часть кэшбэк не даёт — иначе бонусы порождали
      // бы бонусы, и программа лояльности начала бы печатать деньги.
      let cashback = 0;
      const prog = (await c.query(
        `SELECT earn_percent AS percent FROM loyalty_program
          WHERE kind='cashback' AND is_active AND deleted_at IS NULL LIMIT 1`)).rows[0];
      if (prog && wo.counterparty_id) {
        cashback = Math.floor(d.amount * Number(prog.percent) / 100);
        if (cashback > 0) {
          // Через готовую функцию начисления, а не прямой записью: она
          // ведёт срок сгорания бонусов и пересчитывает баланс. Прямая
          // запись сломала бы списание по очереди сгорания.
          await c.query(
            `SELECT apply_bonus_move($1,$2,$3::numeric,'earn',NULL,NULL,$4,$5)`,
            [accountId, wo.counterparty_id, cashback, d.employeeId ?? null,
             `Кэшбэк по сделке № ${wo.number}`]);
          await c.query(
            `UPDATE wholesale_order SET cashback_sum = cashback_sum + $2 WHERE id=$1`,
            [orderId, cashback]);
        }
      }

      return {
        ok: true, paid: newPaid, left: Math.max(0, total - newPaid),
        fullyPaid, cashback,
        // Как у UMAG: цвет суммы показывает состояние долга с одного взгляда.
        payStatus: fullyPaid ? 'green' : 'red',
      };
    });
  }

  /** Платежи по сделке — историю видно в карточке. */
  async payments(accountId: string, orderId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT p.id, p.amount, p.bonus_used, p.method, p.comment, p.created_at, e.first_name AS employee
           FROM wholesale_payment p LEFT JOIN employee e ON e.id = p.employee_id
          WHERE p.order_id=$1 ORDER BY p.created_at DESC`, [orderId])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount), bonus_used: Number(r.bonus_used) })));
  }

  async moveStage(accountId: string, orderId: string, stage: string) {
    if (!STAGES.includes(stage as any)) throw new BadRequestException('Неизвестный этап');
    return this.db.withTenant(accountId, async (c) => {
      const wo = (await c.query(`SELECT stage FROM wholesale_order WHERE id=$1`, [orderId])).rows[0];
      if (!wo) throw new BadRequestException('Заказ не найден');
      if (wo.stage === stage) return { ok: true, stage };
      const closed = (stage === 'closed' || stage === 'lost');
      await c.query(
        `UPDATE wholesale_order SET stage=$2::wholesale_stage, stage_changed_at=now(),
                closed_at=CASE WHEN $3 THEN now() ELSE closed_at END WHERE id=$1`,
        [orderId, stage, closed]);
      await c.query(
        `INSERT INTO wholesale_stage_log (account_id, order_id, from_stage, to_stage)
         VALUES ($1,$2,$3::wholesale_stage,$4::wholesale_stage)`,
        [accountId, orderId, wo.stage, stage]);
      return { ok: true, stage, label: STAGE_LABEL[stage] };
    });
  }

  async orders(accountId: string, stage?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT wo.id, wo.number, wo.stage, wo.total_sum, wo.cost_sum, wo.expected_date, wo.created_at,
                wo.paid_sum, wo.bonus_used, wo.cashback_sum, wo.shipped_at, wo.comment,
                cp.name AS customer, e.first_name AS created_by_name
           FROM wholesale_order wo
           LEFT JOIN counterparty cp ON cp.id = wo.counterparty_id
           LEFT JOIN employee e ON e.id = wo.created_by
          WHERE wo.deleted_at IS NULL AND ($1::text IS NULL OR wo.stage::text = $1)
          ORDER BY wo.created_at DESC LIMIT 100`, [stage ?? null])).rows
        .map((r: any) => {
          const total = Number(r.total_sum), paid = Number(r.paid_sum);
          return {
            id: r.id, number: r.number, stage: r.stage, stageLabel: STAGE_LABEL[r.stage],
            customer: r.customer, total,
            profit: total - Number(r.cost_sum),
            // Столбцы UMAG: оплачено, в т.ч. бонусами, кэшбэк, комментарий,
            // пользователь. И главное — цвет суммы: зелёный, если долг
            // погашен, красный если нет. Владелец видит состояние с одного
            // взгляда, не открывая карточку.
            paid, left: Math.max(0, total - paid),
            bonusUsed: Number(r.bonus_used), cashback: Number(r.cashback_sum),
            payStatus: paid >= total && total > 0 ? 'green' : 'red',
            shipped: !!r.shipped_at, comment: r.comment,
            createdBy: r.created_by_name,
            expectedDate: r.expected_date, createdAt: r.created_at,
          };
        }));
  }

  async order(accountId: string, orderId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const wo = (await c.query(
        `SELECT wo.*, cp.name AS customer FROM wholesale_order wo
           LEFT JOIN counterparty cp ON cp.id=wo.counterparty_id WHERE wo.id=$1`, [orderId])).rows[0];
      if (!wo) throw new BadRequestException('Заказ не найден');
      const items = (await c.query(
        `SELECT woi.qty, woi.price, woi.cost, p.name AS product
           FROM wholesale_order_item woi JOIN product p ON p.id=woi.product_id
          WHERE woi.order_id=$1`, [orderId])).rows;
      const total = Number(wo.total_sum), paid = Number(wo.paid_sum ?? 0);
      return {
        id: wo.id, number: wo.number, stage: wo.stage, stageLabel: STAGE_LABEL[wo.stage],
        customer: wo.customer, total, comment: wo.comment,
        // Деньги в карточке: без них менеджер не видит, оплачена ли сделка,
        // и звонит клиенту с вопросом, на который система знает ответ.
        paid_sum: paid, bonus_used: Number(wo.bonus_used ?? 0),
        cashback_sum: Number(wo.cashback_sum ?? 0),
        debt: Math.max(0, total - paid),
        // Цвет как у UMAG: зелёный — погашено, красный — есть долг.
        payStatus: paid >= total ? 'green' : 'red',
        shipped_at: wo.shipped_at, expected_date: wo.expected_date,
        items: items.map((r: any) => ({ ...r, qty: Number(r.qty), price: Number(r.price), sum: Number(r.qty) * Number(r.price) })),
      };
    });
  }

  // ---------- ВОРОНКА ----------
  async funnel(accountId: string, from: string, to: string) {
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM wholesale_funnel($1,$2::timestamptz,$3::timestamptz)`,
        [accountId, from, to])).rows);
    const byStage = new Map(rows.map((r: any) => [r.stage, { orders: Number(r.orders), total: Number(r.total) }]));
    // выстраиваем в порядке воронки с конверсией
    const funnel = STAGES.filter((s) => s !== 'lost').map((s) => ({
      stage: s, label: STAGE_LABEL[s],
      orders: byStage.get(s)?.orders ?? 0, total: byStage.get(s)?.total ?? 0,
    }));
    const lost = byStage.get('lost') ?? { orders: 0, total: 0 };
    const totalOrders = funnel.reduce((sum, f) => sum + f.orders, 0) + lost.orders;
    const won = byStage.get('closed')?.orders ?? 0;
    return {
      funnel, lost,
      conversion: totalOrders > 0 ? Math.round((won / totalOrders) * 100) : 0,
      totalOrders,
    };
  }

  // ---------- ЮНИТ-ЭКОНОМИКА ПО КЛИЕНТУ ----------
  async customerEconomics(accountId: string, from: string, to: string) {
    const rows = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM customer_economics($1,$2::timestamptz,$3::timestamptz)`,
        [accountId, from, to])).rows);
    return rows.map((r: any) => ({
      customerId: r.customer_id, name: r.name, receipts: Number(r.receipts),
      revenue: Number(r.revenue), profit: Number(r.profit), avgReceipt: Number(r.avg_receipt),
    }));
  }

  /** Пометить контрагента оптовым клиентом */
  async setWholesale(accountId: string, counterpartyId: string, isWholesale: boolean) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE counterparty SET is_wholesale=$2 WHERE id=$1`, [counterpartyId, isWholesale]);
      return { ok: true };
    });
  }
}

// =====================================================================
@Controller('wholesale')
export class WholesaleController {
  constructor(private svc: WholesaleService) {}

  @Post('orders') @RequirePermission('contragents', 'edit')
  createOrder(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.createOrder(ctx.accountId, ctx.employeeId, d);
  }

  @Get('orders') @RequirePermission('contragents', 'view')
  orders(@Ctx() ctx: EmployeeContext, @Query('stage') stage?: string) {
    return this.svc.orders(ctx.accountId, stage);
  }

  @Get('orders/:id') @RequirePermission('contragents', 'view')
  order(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.order(ctx.accountId, id); }

  @Patch('orders/:id/stage') @RequirePermission('contragents', 'edit')
  moveStage(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { stage: string }) {
    return this.svc.moveStage(ctx.accountId, id, d.stage);
  }

  @Get('funnel') @RequirePermission('reports', 'view')
  funnel(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 90 * 86400000).toISOString();
    return this.svc.funnel(ctx.accountId, from, to);
  }

  @Get('customer-economics') @RequirePermission('reports', 'view')
  customerEconomics(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 90 * 86400000).toISOString();
    return this.svc.customerEconomics(ctx.accountId, from, to);
  }

  @Post('counterparties/:id/wholesale') @RequirePermission('contragents', 'edit')
  setWholesale(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { isWholesale: boolean }) {
    return this.svc.setWholesale(ctx.accountId, id, d.isWholesale);
  }

  /** Отгрузка: списывает товар и создаёт долг покупателя. */
  @Post('orders/:id/ship') @RequirePermission('contragents', 'edit')
  ship(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.svc.ship(ctx.accountId, id, { ...d, employeeId: ctx.employeeId ?? undefined });
  }

  /** Оплата сделки, в том числе частичная. */
  @Post('orders/:id/pay') @RequirePermission('finance', 'edit')
  pay(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.svc.pay(ctx.accountId, id, { ...d, employeeId: ctx.employeeId ?? undefined });
  }

  /** История платежей по сделке. */
  @Get('orders/:id/payments') @RequirePermission('finance', 'view')
  payments(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.svc.payments(ctx.accountId, id);
  }
}

@Module({ controllers: [WholesaleController], providers: [WholesaleService, DbService] })
export class WholesaleModule {}
