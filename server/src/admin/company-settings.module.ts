import { Controller, Get, Patch, Body, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { ReportService } from '../reports/report.service';

/**
 * НАСТРОЙКИ КОМПАНИИ (этап 12).
 *
 * Сюда собираем решения, которые зависят от конкретного магазина и
 * которые нельзя зашивать в код. Пока это граница операционного дня,
 * дальше добавится остальное.
 */
@Injectable()
export class CompanySettingsService {
  constructor(private db: DbService) {}

  async get(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const a = (await c.query(
        `SELECT name, phone, day_start_hour, status FROM account WHERE id=$1`, [accountId])).rows[0];
      return {
        name: a.name, phone: a.phone, status: a.status,
        dayStartHour: Number(a.day_start_hour),
        dayStartHint: Number(a.day_start_hour) === 0
          ? 'День считается с полуночи — как в обычном магазине'
          : `День считается с ${a.day_start_hour}:00 — ночная выручка остаётся во вчерашнем дне`,
      };
    });
  }

  /**
   * Смена границы дня. Меняет ТОЛЬКО то, как считаются отчёты «за
   * сегодня» и «за вчера» — сами продажи и их время не трогаются.
   *
   * Предупреждение обязательно: после смены вчерашние отчёты покажут
   * другие цифры, и это нормально, но владелец должен понимать почему,
   * иначе решит, что система потеряла деньги.
   */
  async setDayStart(accountId: string, hour: number) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
      throw new BadRequestException('Час от 0 до 23');
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE account SET day_start_hour=$2 WHERE id=$1`, [accountId, hour]);
      // Сбрасываем запомненное значение сразу: иначе владелец меняет
      // границу, смотрит отчёт и видит старые цифры — решает, что
      // настройка не сработала, и меняет ещё раз.
      ReportService.forgetDayStart(accountId);
      return {
        ok: true, dayStartHour: hour,
        note: hour === 0
          ? 'День считается с полуночи'
          : `День считается с ${hour}:00. Продажи ночью до ${hour}:00 попадут во вчерашний день — ` +
            'отчёты за прошлые дни покажут другие цифры, это ожидаемо',
      };
    });
  }
}

@Controller('company')
export class CompanySettingsController {
  constructor(private svc: CompanySettingsService) {}

  @Get('settings') @RequirePermission('settings', 'view')
  get(@Ctx() ctx: EmployeeContext) { return this.svc.get(ctx.accountId); }

  @Patch('day-start') @RequirePermission('settings', 'edit')
  setDayStart(@Ctx() ctx: EmployeeContext, @Body() d: { hour: number }) {
    return this.svc.setDayStart(ctx.accountId, Number(d?.hour));
  }
}

@Module({ controllers: [CompanySettingsController], providers: [CompanySettingsService, DbService] })
export class CompanySettingsModule {}
