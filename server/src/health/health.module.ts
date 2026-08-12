import { Controller, Get, Module } from '@nestjs/common';
import { Public } from '../auth/guards';
import { DbService } from '../db/db.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Живость и версия. Нужны с первого дня: магазин звонит «не работает» —
 * поддержка должна за секунду видеть, жив ли сервер и какая на нём сборка.
 */
@Controller()
export class HealthController {
  constructor(private db: DbService) {}

  @Public() @Get('health')
  async health() {
    const t0 = Date.now();
    let dbOk = false;
    try { await this.db.raw('SELECT 1'); dbOk = true; } catch {}
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk,
      dbLatencyMs: Date.now() - t0,
      uptimeSec: Math.round(process.uptime()),
      version: process.env.APP_VERSION ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }

  /** Минимальная версия клиента: старую кассу надо уметь заставить обновиться. */
  @Public() @Get('version')
  version() {
    return {
      server: process.env.APP_VERSION ?? '0.1.0',
      minPosVersion: process.env.MIN_POS_VERSION ?? '0.1.0',
      minAdminVersion: process.env.MIN_ADMIN_VERSION ?? '0.1.0',
    };
  }
}

@Module({ imports: [AuthModule], controllers: [HealthController], providers: [DbService] })
export class HealthModule {}
