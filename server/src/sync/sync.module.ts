import { Controller, Post, Get, Body, Query, UseGuards, Module } from '@nestjs/common';
import { IsArray, IsOptional, IsInt, Min } from 'class-validator';
import { SyncService, SyncEvent } from './sync.service';
import { SyncGateway } from './sync.gateway';
import { AuthModule } from '../auth/auth.module';
import { DbService } from '../db/db.service';
import { DeviceGuard, Public, Ctx, Dev, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

class PushDto {
  @IsArray() events: SyncEvent[];
  @IsOptional() @IsInt() @Min(0) pendingHint?: number;
}

// =====================================================================
// СИНХРОНИЗАЦИЯ С КАССОЙ (по токену устройства)
// =====================================================================
@Controller('sync')
export class SyncController {
  constructor(private sync: SyncService, private gateway: SyncGateway) {}

  /** Касса отдаёт накопленные события (в том числе за долгий офлайн). */
  @Public() @UseGuards(DeviceGuard) @Post('push')
  push(@Dev() dev: any, @Body() d: PushDto) {
    return this.sync.push(dev.account_id, { deviceId: dev.device_id }, d.events, d.pendingHint ?? 0);
  }

  /** Касса забирает изменения с места, где остановилась. */
  @Public() @UseGuards(DeviceGuard) @Get('pull')
  pull(@Dev() dev: any, @Query('since') since = '0', @Query('limit') limit = '200') {
    return this.sync.pull(dev.account_id, Number(since), Number(limit), dev.device_id);
  }

  /** Диагностика: сколько устройств на связи прямо сейчас. */
  @Public() @UseGuards(DeviceGuard) @Get('status')
  async status(@Dev() dev: any) {
    return { online: this.gateway.connectionsOf(dev.account_id) };
  }
}

// =====================================================================
// СИНХРОНИЗАЦИЯ И ДИАГНОСТИКА В КАБИНЕТЕ (по JWT)
// =====================================================================
@Controller('admin/sync')
export class AdminSyncController {
  constructor(private sync: SyncService) {}

  /* ВЕРНУТЬ ЧЕКИ ИЗ КАРАНТИНА. Владелец видит ноль в отчёте, а деньги
     взяты — этой кнопкой они возвращаются в учёт. */
  @Post('retry-quarantine') @RequirePermission('settings', 'edit')
  retryQuarantine(@Ctx() ctx: EmployeeContext) {
    return this.sync.retryQuarantine(ctx.accountId);
  }

  @Post('push') @RequirePermission('settings', 'edit')
  push(@Ctx() ctx: EmployeeContext, @Body() d: PushDto) {
    return this.sync.push(ctx.accountId, { employeeId: ctx.employeeId }, d.events, 0);
  }

  @Get('pull') @RequirePermission('dashboard', 'view')
  pull(@Ctx() ctx: EmployeeContext, @Query('since') since = '0') {
    return this.sync.pull(ctx.accountId, Number(since));
  }

  /**
   * Готовность к инвентаризации — ответ на предупреждение UMAG
   * «остатки могут быть неточными». Мы не гадаем, а знаем.
   */
  @Get('readiness') @RequirePermission('stock', 'view')
  readiness(@Ctx() ctx: EmployeeContext, @Query('storeId') storeId?: string) {
    return this.sync.readiness(ctx.accountId, storeId);
  }

  /** Карантин: что не удалось применить. Ничего не теряется молча. */
  @Get('quarantine') @RequirePermission('settings', 'view')
  quarantine(@Ctx() ctx: EmployeeContext) { return this.sync.deadLetters(ctx.accountId); }

  /** Журнал конфликтов: чья правка победила. */
  @Get('conflicts') @RequirePermission('settings', 'view')
  conflicts(@Ctx() ctx: EmployeeContext) { return this.sync.conflicts(ctx.accountId); }
}

@Module({
  imports: [AuthModule],
  controllers: [SyncController, AdminSyncController],
  providers: [SyncService, SyncGateway, DbService],
  exports: [SyncService, SyncGateway],
})
export class SyncModule {}
