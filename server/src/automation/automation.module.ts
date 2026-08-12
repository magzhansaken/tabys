import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * АВТОМАТИЗАЦИЯ И СВЯЗЬ (часть 27).
 *
 * Философия — не конструктор, а готовая польза:
 *  • Автоотчёт: одна галочка «слать вечернюю сводку», а не настройка шаблонов.
 *  • Вебхуки: как у МоегоСклада (POST при событии), с журналом доставки —
 *    без журнала не понять, дошло ли (у МоегоСклада журнала нет).
 *  • Сценарии: «условие → уведомление владельцу». Магазину не нужен язык
 *    программирования и резервы, ему нужно «мало товара → напиши мне».
 *  • Новости и чат — канал оператора к клиентам (модель Wipon).
 */

@Injectable()
export class AutomationService {
  constructor(private db: DbService) {}

  // ---------- ВЕБХУКИ ----------
  async createWebhook(accountId: string, d: { url: string; events?: string[]; secret?: string }) {
    if (!/^https?:\/\//.test(d.url ?? '')) throw new BadRequestException('URL должен начинаться с http:// или https://');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO webhook (account_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING id, url, events, enabled`,
        [accountId, d.url, d.events ?? ['sale.created'], d.secret ?? null])).rows[0]);
  }

  async webhooks(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT id, url, events, enabled, created_at FROM webhook ORDER BY created_at DESC`)).rows);
  }

  async deleteWebhook(accountId: string, id: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`DELETE FROM webhook WHERE id=$1`, [id]);
      return { ok: true };
    });
  }

  /**
   * Разослать событие подписанным вебхукам. Тело подписывается HMAC (secret),
   * чтобы получатель убедился в подлинности. Доставка идёт в журнал: успех/
   * ошибка/код ответа — видно, дошло ли (чего нет у МоегоСклада).
   * Вызывается из бизнес-логики (продажа, приёмка) — здесь механика.
   */
  async fireEvent(accountId: string, event: string, payload: any) {
    return this.db.withTenant(accountId, async (c) => {
      const hooks = (await c.query(
        `SELECT * FROM webhook WHERE enabled AND $1 = ANY(events)`, [event])).rows;
      for (const h of hooks) {
        const body = JSON.stringify({ event, id: payload.id, type: payload.type ?? event, data: payload, ts: new Date().toISOString() });
        const del = (await c.query(
          `INSERT INTO webhook_delivery (account_id, webhook_id, event, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
          [accountId, h.id, event, body])).rows[0];
        try {
          const sig = h.secret ? crypto.createHmac('sha256', h.secret).update(body).digest('hex') : undefined;
          const r = await fetch(h.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Shop-Signature': sig } : {}) },
            body, signal: AbortSignal.timeout(5000),
          });
          await c.query(
            `UPDATE webhook_delivery SET status=$2, response_code=$3, attempts=1,
                    delivered_at=CASE WHEN $2='ok' THEN now() ELSE NULL END WHERE id=$1`,
            [del.id, r.ok ? 'ok' : 'failed', r.status]);
        } catch (e: any) {
          await c.query(`UPDATE webhook_delivery SET status='failed', error=$2, attempts=1 WHERE id=$1`,
            [del.id, e.message?.slice(0, 200)]);
        }
      }
      return { fired: hooks.length };
    });
  }

  async deliveries(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT wd.id, wd.event, wd.status, wd.response_code, wd.error, wd.created_at, w.url
           FROM webhook_delivery wd JOIN webhook w ON w.id = wd.webhook_id
          WHERE wd.account_id=$1 ORDER BY wd.created_at DESC LIMIT 50`, [accountId])).rows);
  }

  // ---------- СЦЕНАРИИ ----------
  async createScenario(accountId: string, d: { name: string; trigger: string; threshold?: number; action?: string }) {
    if (!d.name?.trim()) throw new BadRequestException('Название сценария обязательно');
    if (!['low_stock', 'big_refund', 'shift_long'].includes(d.trigger))
      throw new BadRequestException('Событие: мало товара, крупный возврат или долгая смена');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO scenario (account_id, name, trigger, threshold, action)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, name, trigger, threshold, enabled`,
        [accountId, d.name.trim(), d.trigger, d.threshold ?? null, d.action ?? 'notify_owner'])).rows[0]);
  }

  async scenarios(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM scenario ORDER BY created_at DESC`)).rows.map((r: any) => ({
        ...r, threshold: r.threshold != null ? Number(r.threshold) : null })));
  }

  async toggleScenario(accountId: string, id: string, enabled: boolean) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE scenario SET enabled=$2 WHERE id=$1`, [id, enabled]);
      return { ok: true };
    });
  }

  /**
   * Проверить сценарии на событие. Вызывается из бизнес-логики: при возврате
   * проверяем big_refund, при продаже — low_stock и т.д. Создаёт уведомление
   * владельцу, если условие выполнено. Возвращает сработавшие.
   */
  async checkScenarios(accountId: string, trigger: string, value: number, context: any = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const scs = (await c.query(
        `SELECT * FROM scenario WHERE enabled AND trigger=$1`, [trigger])).rows;
      const fired: any[] = [];
      for (const s of scs) {
        const th = s.threshold != null ? Number(s.threshold) : 0;
        // low_stock: мало товара (value < threshold); big_refund/shift_long: value > threshold
        const hit = trigger === 'low_stock' ? value <= th : value >= th;
        if (!hit) continue;
        const owner = (await c.query(`SELECT id FROM employee WHERE is_owner LIMIT 1`)).rows[0];
        const titles: Record<string, string> = {
          low_stock: 'Мало товара', big_refund: 'Крупный возврат', shift_long: 'Долгая смена',
        };
        await c.query(
          `INSERT INTO notification (account_id, employee_id, kind, title, body, payload)
           VALUES ($1,$2,'low_stock',$3,$4,$5)`,
          [accountId, owner?.id ?? null, `Сценарий: ${s.name}`,
           `${titles[trigger]}: ${context.name ?? ''} (${value})`, JSON.stringify({ scenario: s.id, ...context })]);
        fired.push({ scenario: s.name, trigger });
      }
      return { fired };
    });
  }

  // ---------- АВТООТЧЁТЫ ----------
  /**
   * Расписание отправки. Отчётов теперь два:
   *   daily_summary  — итоги дня, по умолчанию вечером (21:00);
   *   low_stock      — что заканчивается, по умолчанию УТРОМ (9:00).
   *
   * Час по умолчанию зависит от отчёта, и это не мелочь: сводку по итогам
   * читают вечером, а заказ поставщику делают утром — поставщик принимает
   * заявки днём. Прислать список «что заканчивается» в девять вечера почти
   * бесполезно. У UMAG это письмо приходит ровно в 9:00, и они правы.
   */
  async createSchedule(accountId: string, d: {
    channel?: string; target: string; sendAtHour?: number; report?: string;
  }) {
    if (!d.target?.trim()) throw new BadRequestException('Укажите email или chat_id для отправки');
    const report = d.report === 'low_stock' ? 'low_stock' : 'daily_summary';
    const hour = d.sendAtHour ?? (report === 'low_stock' ? 9 : 21);
    if (hour < 0 || hour > 23) throw new BadRequestException('Час отправки: 0–23');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO report_schedule (account_id, report, channel, target, send_at_hour)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, report, channel, target, send_at_hour, enabled`,
        [accountId, report, d.channel ?? 'email', d.target.trim(), hour])).rows[0]);
  }

  async schedules(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM report_schedule ORDER BY created_at DESC`)).rows);
  }

  async deleteSchedule(accountId: string, id: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`DELETE FROM report_schedule WHERE id=$1`, [id]);
      return { ok: true };
    });
  }

  /**
   * Собрать вечернюю сводку за день (для отправки). Отдаём текст — планировщик
   * отправит его на email/telegram. Здесь считаем, доставку делает воркер
   * (email-провайдер настраивается при деплое, как SMS).
   */
  async buildDailySummary(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const today = new Date().toISOString().slice(0, 10);
      const r = (await c.query(
        `SELECT count(*) FILTER (WHERE return_of_id IS NULL) AS receipts,
                coalesce(sum(CASE WHEN return_of_id IS NULL THEN total ELSE -total END),0) AS revenue,
                coalesce(sum(CASE WHEN return_of_id IS NULL THEN total-cost_total ELSE -(total-cost_total) END),0) AS profit
           FROM sale WHERE account_id=$1 AND created_at::date = $2`, [accountId, today])).rows[0];
      return {
        date: today, receipts: Number(r.receipts),
        revenue: Number(r.revenue), profit: Number(r.profit),
        text: `Сводка за ${today}: чеков ${r.receipts}, выручка ${Number(r.revenue).toLocaleString('ru-RU')} ₸, прибыль ${Number(r.profit).toLocaleString('ru-RU')} ₸`,
      };
    });
  }

  // ---------- НОВОСТИ ----------
  /**
   * УТРЕННЯЯ СВОДКА ПО ЗАКАНЧИВАЮЩИМСЯ ТОВАРАМ (модель UMAG).
   *
   * У них дословно: «каждое утро в 9:00 вам будет приходить уведомление
   * о том, что товар заканчивается», и ссылка ведёт сразу на склад с уже
   * включённым фильтром.
   *
   * Почему именно утро, а не вечер: вечерняя сводка у нас уже есть, но она
   * про итоги дня. Заказывать товар нужно утром — поставщик принимает
   * заявки днём, и решение «что довезти» принимается до открытия.
   *
   * Показываем не просто «заканчивается», а СКОЛЬКО ДОЗАКАЗАТЬ и на какую
   * сумму: владельцу нужно решение, а не список тревог.
   */
  async buildLowStockDigest(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const rows = (await c.query(
        `SELECT p.id, p.name, p.min_stock,
                coalesce(sum(b.qty), 0) AS qty,
                coalesce(p.purchase_price, 0) AS price
           FROM product p
           LEFT JOIN stock_balance b ON b.product_id = p.id
          WHERE p.account_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL
            AND p.track_stock AND p.min_stock IS NOT NULL AND p.min_stock > 0
          GROUP BY p.id, p.name, p.min_stock, p.purchase_price
         HAVING coalesce(sum(b.qty), 0) < p.min_stock
          ORDER BY (coalesce(sum(b.qty),0) / nullif(p.min_stock,0)) ASC
          LIMIT 50`, [accountId])).rows;

      const items = rows.map((r: any) => {
        const qty = Number(r.qty), min = Number(r.min_stock);
        const need = Math.max(0, min - qty);
        return {
          id: r.id, name: r.name, qty, minStock: min, need,
          // Закончился совсем — это уже потерянные продажи, а не риск.
          out: qty <= 0,
          sum: Math.round(need * Number(r.price)),
        };
      });

      const out = items.filter((i) => i.out);
      const total = items.reduce((a, b) => a + b.sum, 0);

      const lines = items.slice(0, 12).map((i) =>
        `· ${i.name}: ${i.qty} из ${i.minStock}${i.out ? ' — ЗАКОНЧИЛСЯ' : ''}, дозаказать ${i.need}`);

      return {
        items, count: items.length, outCount: out.length, orderSum: total,
        // Ссылка ведёт сразу на склад с включённым фильтром — приём UMAG.
        link: '/stock?filter=low',
        text: items.length === 0
          ? 'Доброе утро! Товаров ниже критического остатка нет.'
          : `Доброе утро! Заканчивается товаров: ${items.length}` +
            (out.length ? `, из них закончилось совсем: ${out.length}` : '') +
            `.\nНа дозаказ нужно примерно ${total.toLocaleString('ru-RU')} ₸.\n\n` +
            lines.join('\n') +
            (items.length > 12 ? `\n… и ещё ${items.length - 12}` : ''),
      };
    });
  }

  async news(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT n.id, n.title, n.body, n.is_important, n.published_at,
                (nr.news_id IS NOT NULL) AS is_read
           FROM news_post n
           LEFT JOIN news_read nr ON nr.news_id = n.id AND nr.account_id = $1
          ORDER BY n.published_at DESC LIMIT 30`, [accountId])).rows);
  }

  async markNewsRead(accountId: string, newsId: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO news_read (account_id, news_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, newsId]);
      return { ok: true };
    });
  }

  // ---------- ЧАТ ПОДДЕРЖКИ ----------
  async chatHistory(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, from_side, body, created_at FROM support_message
          WHERE account_id=$1 ORDER BY created_at`, [accountId])).rows);
  }

  async sendChatMessage(accountId: string, fromSide: 'client' | 'operator', body: string) {
    if (!body?.trim()) throw new BadRequestException('Пустое сообщение');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO support_message (account_id, from_side, body) VALUES ($1,$2,$3) RETURNING id, from_side, body, created_at`,
        [accountId, fromSide, body.trim()])).rows[0]);
  }
}

// =====================================================================
@Controller('automation')
export class AutomationController {
  constructor(private svc: AutomationService) {}

  // вебхуки
  @Post('webhooks') @RequirePermission('settings', 'edit')
  createWebhook(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.createWebhook(ctx.accountId, d); }
  @Get('webhooks') @RequirePermission('settings', 'view')
  webhooks(@Ctx() ctx: EmployeeContext) { return this.svc.webhooks(ctx.accountId); }
  @Delete('webhooks/:id') @RequirePermission('settings', 'edit')
  deleteWebhook(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.deleteWebhook(ctx.accountId, id); }
  @Get('webhooks/deliveries') @RequirePermission('settings', 'view')
  deliveries(@Ctx() ctx: EmployeeContext) { return this.svc.deliveries(ctx.accountId); }
  @Post('webhooks/test') @RequirePermission('settings', 'edit')
  fireTest(@Ctx() ctx: EmployeeContext, @Body() d: { event?: string }) {
    return this.svc.fireEvent(ctx.accountId, d.event ?? 'test.ping', { id: 'test', type: 'test', message: 'проверка вебхука' });
  }

  // сценарии
  @Post('scenarios') @RequirePermission('settings', 'edit')
  createScenario(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.createScenario(ctx.accountId, d); }
  @Get('scenarios') @RequirePermission('settings', 'view')
  scenarios(@Ctx() ctx: EmployeeContext) { return this.svc.scenarios(ctx.accountId); }
  @Patch('scenarios/:id') @RequirePermission('settings', 'edit')
  toggleScenario(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { enabled: boolean }) {
    return this.svc.toggleScenario(ctx.accountId, id, d.enabled);
  }
  @Post('scenarios/check') @RequirePermission('settings', 'edit')
  checkScenario(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.checkScenarios(ctx.accountId, d.trigger, d.value, d.context);
  }

  // автоотчёты
  @Post('schedules') @RequirePermission('settings', 'edit')
  createSchedule(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.createSchedule(ctx.accountId, d); }
  @Get('schedules') @RequirePermission('settings', 'view')
  schedules(@Ctx() ctx: EmployeeContext) { return this.svc.schedules(ctx.accountId); }
  @Delete('schedules/:id') @RequirePermission('settings', 'edit')
  deleteSchedule(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.deleteSchedule(ctx.accountId, id); }
  @Get('daily-summary') @RequirePermission('reports', 'view')
  dailySummary(@Ctx() ctx: EmployeeContext) { return this.svc.buildDailySummary(ctx.accountId); }

  /** Утренняя сводка: что заканчивается и сколько дозаказать (модель UMAG). */
  @Get('low-stock-digest') @RequirePermission('stock', 'view')
  lowStockDigest(@Ctx() ctx: EmployeeContext) { return this.svc.buildLowStockDigest(ctx.accountId); }

  // новости
  @Get('news') @RequirePermission('settings', 'view')
  news(@Ctx() ctx: EmployeeContext) { return this.svc.news(ctx.accountId); }
  @Post('news/:id/read') @RequirePermission('settings', 'view')
  markRead(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.markNewsRead(ctx.accountId, id); }

  // чат
  @Get('chat') @RequirePermission('settings', 'view')
  chat(@Ctx() ctx: EmployeeContext) { return this.svc.chatHistory(ctx.accountId); }
  @Post('chat') @RequirePermission('settings', 'view')
  sendChat(@Ctx() ctx: EmployeeContext, @Body() d: { body: string }) {
    return this.svc.sendChatMessage(ctx.accountId, 'client', d.body);
  }
}

@Module({ controllers: [AutomationController], providers: [AutomationService, DbService] })
export class AutomationModule {}
