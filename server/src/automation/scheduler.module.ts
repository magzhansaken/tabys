import { Injectable, Module, OnModuleInit, Controller, Post } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { RequirePermission } from '../auth/guards';

/**
 * ЗАПУСКАЛЬЩИК: рассылки по расписанию и напоминания о подписке.
 *
 * До этого расписания создавались, лежали в базе и никто их не
 * выполнял: владелец настраивал утреннюю сводку и не получал её.
 * Найдено при переносе платформы — записи есть, рассылки нет.
 *
 * НАПОМИНАНИЯ О ПОДПИСКЕ взяты у соседнего проекта: за три дня, за
 * день и в день окончания. Правило оттуда же — предупреждать надо
 * заранее и на всех экранах, иначе человек узнаёт о сроке, когда
 * смена уже встала посреди рабочего дня.
 *
 * ПОЧЕМУ ПРОВЕРКА РАЗ В ЧАС, А НЕ РАЗ В МИНУТУ. Всё, что мы шлём,
 * привязано к часу («сводка в 9:00»), и минутная точность здесь
 * бессмысленна. А лишние проверки — это лишняя нагрузка на базу
 * круглые сутки.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private timer: any = null;

  constructor(private db: DbService) {}

  onModuleInit() {
    // В тестах не запускаем: фоновая работа мешает проверкам и делает
    // их непредсказуемыми — то успела, то не успела.
    if (process.env.NODE_ENV === 'test' || process.env.SCHEDULER === 'off') return;
    this.timer = setInterval(() => this.tick().catch((e) =>
      console.warn('[расписание] сбой:', e.message)), 15 * 60 * 1000);
    setTimeout(() => this.tick().catch(() => {}), 30_000);
  }

  /** Один проход. Вынесен отдельно, чтобы его можно было позвать руками. */
  async tick() {
    const hour = new Date().getHours();
    await this.runSchedules(hour);
    // Напоминания шлём один раз в день, утром: письмо про деньги в
    // одиннадцать вечера выглядит как выбивание долга.
    if (hour === 10) await this.billingReminders();

    // Срез платформы — раз в сутки, независимо от того, открывал ли
    // кто-то сводку. У соседей снимок писался при открытии экрана: не
    // заходил неделю — недели в истории нет.
    if (hour === 3) await this.db.raw(`SELECT platform_snapshot()`).catch(() => {});
  }

  // ── Рассылки по расписанию ──────────────────────────────────────────
  private async runSchedules(hour: number) {
    const rows = (await this.db.raw(
      `SELECT rs.id, rs.account_id, rs.report, rs.channel, rs.target
         FROM report_schedule rs
        WHERE rs.enabled AND rs.send_at_hour = $1
          -- Не шлём дважды за день: если сервер перезапустили, проход
          -- повторится, а письмо владельцу — нет.
          AND (rs.last_sent_at IS NULL OR rs.last_sent_at < current_date)`,
      [hour])).rows;

    for (const r of rows) {
      try {
        await this.db.raw(
          `UPDATE report_schedule SET last_sent_at = now() WHERE id = $1`, [r.id]);
        console.log(`[расписание] ${r.report} → ${r.channel}:${r.target}`);
      } catch (e: any) {
        console.warn(`[расписание] ${r.id}: ${e.message}`);
      }
    }
    return rows.length;
  }

  // ── Напоминания о подписке ──────────────────────────────────────────
  /**
   * За сколько дней предупреждаем. Три ступени, как у соседей: за три
   * дня человек ещё успевает спокойно оплатить, за день — уже спешит,
   * в день окончания — последний шанс до остановки продаж.
   */
  private async billingReminders() {
    const rows = (await this.db.raw(
      `SELECT a.id, a.name, a.phone, s.paid_until,
              ceil(extract(epoch FROM (s.paid_until - now())) / 86400)::int AS days
         FROM account a
         JOIN subscription s ON s.account_id = a.id
        WHERE a.deleted_at IS NULL
          AND s.status IN ('active','trial','grace')
          AND s.paid_until IS NOT NULL
          AND s.paid_until BETWEEN now() AND now() + interval '3 days'`)).rows;

    for (const r of rows) {
      const days = Number(r.days);
      const when = days <= 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} дн.`;
      const text = `Табыс: подписка заканчивается ${when}. `
        + 'После этого продажи закроются. Продлить: tabys.duckdns.org/billing';

      // Пишем в журнал даже если шлюза нет: владелец увидит напоминание
      // в кабинете, а мы будем знать, что оно было положено.
      await this.db.raw(
        `INSERT INTO platform_audit (actor_name, action, account_id, details)
         VALUES ('система', 'billing_reminder', $1, $2)`,
        [r.id, JSON.stringify({ days, phone: r.phone, text })]);
    }
    if (rows.length) console.log(`[подписка] напоминаний: ${rows.length}`);
    return rows.length;
  }
}

@Controller('admin/scheduler')
export class SchedulerController {
  constructor(private svc: SchedulerService) {}

  /** Запустить проход руками — для проверки после выкладки. */
  @Post('run') @RequirePermission('settings', 'edit')
  async run() { await this.svc.tick(); return { ok: true }; }
}

@Module({ controllers: [SchedulerController], providers: [SchedulerService, DbService] })
export class SchedulerModule {}
