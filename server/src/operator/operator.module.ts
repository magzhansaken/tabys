import { Controller, Get, Post, Body, Param, Query, Headers, Module,
  BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Public } from '../auth/guards';
import { requireOperator } from '../leads/leads.module';

/**
 * ОПЕРАТОРСКАЯ АДМИНКА (часть 20) — инструмент владельца SaaS, не магазинов.
 *
 * Реальность Казахстана: значительная часть оплат приходит переводом на
 * Kaspi — поэтому центральная операция здесь ручное продление с фиксацией
 * платежа в billing_move (клиент увидит его в своём кабинете, у нас — аудит).
 * Данные ходят через SECURITY DEFINER-функции миграции 027: RLS для
 * аккаунтов не ослабляется ни на строку.
 */
@Controller('operator')
export class OperatorController {
  constructor(private db: DbService) {}

  @Public() @Get('overview')
  async overview(@Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const o = (await this.db.raw(`SELECT * FROM operator_overview()`)).rows[0];
    const payments = (await this.db.raw(`SELECT * FROM operator_payments(20)`)).rows;
    return {
      accounts: { total: o.accounts_total, new7d: o.new_7d, alive7d: o.alive_7d },
      subscriptions: { trials: o.trials, paying: o.paying, frozen: o.frozen, readonly: o.readonly_cnt },
      mrr: Number(o.mrr), payments30d: Number(o.payments_30d),
      leadsNew: o.leads_new,
      recentPayments: payments.map((p: any) => ({ ...p, amount: Number(p.amount) })),
    };
  }

  @Public() @Get('accounts')
  async accounts(@Query('q') q: string | undefined, @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const { rows } = await this.db.raw(`SELECT * FROM operator_accounts($1)`, [q?.trim() || null]);
    return { items: rows.map((r: any) => ({ ...r, balance: Number(r.balance) })), total: rows.length };
  }

  /** Оплата пришла (Kaspi/счёт) → продлеваем и фиксируем платёж */
  @Public() @Post('accounts/:id/extend')
  async extend(@Param('id') id: string,
               @Body() d: { days: number; amount?: number; comment?: string },
               @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    if (!d?.days) throw new BadRequestException('days обязателен');
    const { rows } = await this.db.raw(`SELECT * FROM operator_extend($1,$2,$3,$4)`,
      [id, d.days, d.amount ?? null, d.comment ?? null]);
    return { ok: true, ...rows[0] };
  }

  /** frozen — злостный неплательщик; active — разморозка; readonly — мягкий стоп */
  @Public() @Post('accounts/:id/status')
  async setStatus(@Param('id') id: string, @Body() d: { status: string },
                  @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const { rows } = await this.db.raw(`SELECT operator_set_status($1,$2) AS s`, [id, d?.status]);
    return { ok: true, status: rows[0].s };
  }

  // ==================================================================
  // ЗАЯВКИ НА РЕГИСТРАЦИЮ (часть 38). Пока нет СМС-шлюза, телефон
  // проверяет живой звонок оператора — для платного B2B это надёжнее.
  // ==================================================================

  /** Новые заявки: кто зарегистрировался и ждёт активации */
  @Public() @Get('signups')
  async signups(@Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const { rows } = await this.db.raw(`SELECT * FROM operator_signups()`);
    return { items: rows, total: rows.length };
  }

  /** Активировать заявку: pending → trial (пробный период уже начислен) */
  @Public() @Post('accounts/:id/activate')
  async activate(@Param('id') id: string,
                 @Body() d: { by?: string; status?: string },
                 @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const target = d?.status === 'active' ? 'active' : 'trial';
    const { rows } = await this.db.raw(`SELECT * FROM operator_activate($1,$2,$3)`,
      [id, target, d?.by ?? 'оператор']);
    if (!rows[0]) throw new BadRequestException('Заявка не найдена или уже активирована');
    return { ok: true, ...rows[0] };
  }

  /**
   * Сброс пароля владельца. Обязателен, пока нет СМС: восстановление
   * пароля шло по коду, и без этого забытый пароль означал бы потерю
   * доступа навсегда. Новый пароль оператор передаёт клиенту лично.
   */
  @Public() @Post('accounts/:id/reset-password')
  async resetPassword(@Param('id') id: string,
                      @Body() d: { password: string },
                      @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    if (!d?.password || d.password.length < 8)
      throw new BadRequestException('Пароль не короче 8 знаков');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(d.password, 12);
    const { rows } = await this.db.raw(`SELECT operator_reset_owner_password($1,$2) AS id`, [id, hash]);
    if (!rows[0]?.id) throw new BadRequestException('Владелец не найден');
    return { ok: true, hint: 'Передайте новый пароль клиенту лично' };
  }
}

@Module({ controllers: [OperatorController], providers: [DbService] })
export class OperatorModule {}
