import { Controller, Get, Module, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * «ВАЖНОЕ» — сигналы для колокола в шапке кабинета.
 *
 * ОДИН ответ, а не шесть. Шапка живёт на каждой странице, и шесть
 * запросов при каждом переходе между разделами заметны — особенно в
 * областях, где связь медленная. Собираем на сервере одним заходом.
 *
 * ЧТО СЮДА ПОПАДАЕТ. Только то, на что владелец может ответить
 * действием прямо сейчас. «Выручка выросла на 3%» — не сигнал, это
 * отчёт. Сигнал — «смена не закрыта со вчера»: надо позвонить
 * продавцу.
 *
 * ПОРЯДОК ВАЖЕН. Сначала то, где теряются деньги (расхождение по
 * смене, закончившийся товар), потом то, где теряется время (заявки,
 * заказы). Владелец читает сверху вниз и до конца обычно не доходит.
 *
 * ЛЁГКОСТЬ. Каждая выборка ограничена и не считает лишнего: колокол
 * дёргается на каждой странице, и тяжёлый запрос здесь замедлит весь
 * кабинет.
 */
@Injectable()
export class AlertsService {
  constructor(private db: DbService) {}

  async list(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const out: any[] = [];

      // ── 1. Расхождение по последней закрытой смене ────────────────
      // Первым: это прямой признак недостачи, и чем раньше владелец
      // спросит, тем больше шансов вспомнить, что было в тот день.
      const shift = (await c.query(
        `SELECT s.id, s.number, s.discrepancy, st.name AS store
           FROM shift s
           LEFT JOIN cash_register cr ON cr.id = s.cash_register_id
           LEFT JOIN store st ON st.id = cr.store_id
          WHERE s.closed_at IS NOT NULL AND coalesce(s.discrepancy,0) <> 0
          ORDER BY s.closed_at DESC LIMIT 1`)).rows[0];
      if (shift) {
        const d = Number(shift.discrepancy);
        out.push({
          kind: 'shift_diff', tone: 'bad',
          title: d < 0 ? `Недостача ${Math.abs(d).toLocaleString('ru-RU')} ₸`
                       : `Излишек ${d.toLocaleString('ru-RU')} ₸`,
          sub: `Смена №${shift.number}${shift.store ? ', ' + shift.store : ''}`,
          href: '/reports',
        });
      }

      // ── 2. Смена не закрыта со вчера ──────────────────────────────
      // Открытая смена сама по себе норма — магазин работает. Сигнал
      // только если она висит со вчерашнего дня: продавец ушёл, не
      // закрыв, и выручка не сошлась.
      const stale = (await c.query(
        `SELECT count(*)::int AS n FROM shift
          WHERE closed_at IS NULL AND opened_at < now() - interval '18 hours'`)).rows[0];
      if (stale.n > 0) {
        out.push({
          kind: 'shift_open', tone: 'bad',
          title: stale.n === 1 ? 'Смена не закрыта со вчера' : `${stale.n} смены не закрыты со вчера`,
          sub: 'Выручка за неё не посчитана',
          href: '/reports',
        });
      }

      // ── 3. Товар закончился совсем ────────────────────────────────
      // Отдельно от «мало осталось»: пустая полка — это уже потерянные
      // продажи, а не риск.
      const out0 = (await c.query(
        `SELECT count(*)::int AS n FROM product p
          WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.track_stock
            AND p.min_stock IS NOT NULL AND p.min_stock > 0
            AND coalesce((SELECT sum(b.qty) FROM stock_balance b WHERE b.product_id = p.id), 0) <= 0`)).rows[0];
      if (out0.n > 0) {
        out.push({
          kind: 'out_of_stock', tone: 'bad',
          title: `Закончилось товаров: ${out0.n}`,
          sub: 'Полка пустая — продажи уже теряются',
          href: '/stock',
        });
      }

      // ── 4. Заканчивается ──────────────────────────────────────────
      const low = (await c.query(
        `SELECT count(*)::int AS n FROM product p
          WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.track_stock
            AND p.min_stock IS NOT NULL AND p.min_stock > 0
            AND coalesce((SELECT sum(b.qty) FROM stock_balance b WHERE b.product_id = p.id), 0)
                BETWEEN 0.0001 AND p.min_stock`)).rows[0];
      if (low.n > 0) {
        out.push({
          kind: 'low_stock', tone: 'warn',
          title: `Заканчивается: ${low.n}`,
          sub: 'Пора заказывать',
          href: '/stock',
        });
      }

      // ── 5. Заказы Kaspi ждут обработки ────────────────────────────
      const mp = (await c.query(
        `SELECT count(*)::int AS n FROM marketplace_order
          WHERE state = 'new'`)).rows[0];
      if (mp.n > 0) {
        out.push({
          kind: 'kaspi', tone: 'warn',
          title: `Заказов Kaspi: ${mp.n}`,
          sub: 'Ждут подтверждения',
          href: '/marketplace',
        });
      }

      // ── 6. Подписка кончается ─────────────────────────────────────
      // Последним по порядку, но за 3 дня становится первым по тону:
      // когда доступ закроется, остальные сигналы будут неважны.
      // Дата окончания живёт в подписке, а у новых магазинов её ещё нет —
      // тогда смотрим конец пробного периода. Иначе владелец на пробном
      // не увидит, что оно кончается, и однажды просто не сможет продать.
      const sub = (await c.query(
        `SELECT s.paid_until, a.trial_ends_at, a.status
           FROM account a
           LEFT JOIN subscription s ON s.account_id = a.id
          WHERE a.id = $1
          ORDER BY s.created_at DESC NULLS LAST LIMIT 1`, [accountId])).rows[0];
      const until = sub?.paid_until ?? sub?.trial_ends_at;
      if (until) {
        const days = Math.ceil((new Date(until).getTime() - Date.now()) / 86400000);
        if (days <= 7) {
          out.push({
            kind: 'billing', tone: days <= 3 ? 'bad' : 'warn',
            title: days <= 0
              ? (sub?.paid_until ? 'Подписка закончилась' : 'Пробный период закончился')
              : (sub?.paid_until ? `Подписка кончается через ${days} дн.` : `Пробный период: ${days} дн.`),
            sub: 'Продлите, чтобы продажи не остановились',
            href: '/billing',
          });
        }
      }

      return out;
    });
  }
}

@Controller('admin')
export class AlertsController {
  constructor(private svc: AlertsService) {}

  /** Сигналы для шапки. Право `dashboard` — самое широкое: колокол
   *  видят все, кому вообще открыт кабинет. */
  @Get('alerts') @RequirePermission('dashboard', 'view')
  alerts(@Ctx() ctx: EmployeeContext) { return this.svc.list(ctx.accountId); }
}

@Module({ controllers: [AlertsController], providers: [AlertsService, DbService] })
export class AlertsModule {}
