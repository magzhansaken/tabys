import { Module } from '@nestjs/common';
import { PosService } from './pos.service';
import { DbService } from '../db/db.service';
import { GoodsService } from '../goods/goods.service';
import { SyncModule } from '../sync/sync.module';
import { LoyaltyService } from '../loyalty/loyalty.service';

/**
 * Модуль кассы. Подключён к синхронизации: при старте регистрирует
 * обработчики офлайн-чеков, смен и отмен.
 */
@Module({
  imports: [SyncModule],
  providers: [PosService, DbService, GoodsService, LoyaltyService],
  exports: [PosService],
})
export class PosModule {}
