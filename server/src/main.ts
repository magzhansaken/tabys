import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { ValidationPipe, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';
import { GoodsModule } from './goods/goods.module';
import { SyncGateway } from './sync/sync.gateway';
import { PosModule } from './pos/pos.module';
import { LeadsModule } from './leads/leads.module';
import { OperatorModule } from './operator/operator.module';
import { ExportModule } from './export/export.module';
import { TaxModule } from './taxes/tax.module';
import { PeopleModule } from './people/people.module';
import { CashPlusModule } from './cash/cash.module';
import { MarkingModule } from './marking/marking.module';
import { WholesaleModule } from './wholesale/wholesale.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { VerificationModule } from './verification/verification.module';
import { ExciseModule } from './excise/excise.module';
import { RfmModule } from './rfm/rfm.module';
import { PosUpdateModule } from './pos/pos-update.module';
import { PublicApiModule } from './api/public-api.module';
import { PosSettingsModule } from './pos/pos-settings.module';
import { CompanySettingsModule } from './admin/company-settings.module';
import { AlertsModule } from './admin/alerts.module';
import { WarehousePlusModule } from './warehouse/warehouse.module';
import { AutomationModule } from './automation/automation.module';
import { PosService } from './pos/pos.service';
import { AdminApiModule } from './admin/admin.module';

@Module({ imports: [AuthModule, SyncModule, HealthModule, GoodsModule, PosModule, AdminApiModule, LeadsModule, OperatorModule, ExportModule, TaxModule, PeopleModule, CashPlusModule, WarehousePlusModule, AutomationModule, MarkingModule, WholesaleModule, MarketplaceModule, VerificationModule, ExciseModule, RfmModule, PosUpdateModule, PublicApiModule, CompanySettingsModule, PosSettingsModule, AlertsModule] })
export class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule,
    { logger: ['error', 'warn'], bodyParser: false });
  // Тело до 2 МБ: импорт Excel и логотипы (часть 21) приходят как base64.
  // По умолчанию express режет на 100 КБ — и честный логотип на 400 КБ
  // отбивался бы кодом 413 ДО нашей проверки «не больше 500 КБ», а владелец
  // видел бы непонятную ошибку вместо внятного «уменьшите картинку».
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ limit: '2mb', extended: true }));

  // Кабинет и касса живут на других адресах, поэтому браузер считает запрос к
  // серверу «чужим» и блокирует его, пока сервер явно не разрешит источник.
  // В разработке пускаем локальные адреса; в бою список задаётся через
  // переменную CORS_ORIGINS (через запятую).
  const origins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
  app.enableCors({
    origin: origins,
    credentials: true,          // чтобы уходили куки с токеном обновления
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // Одна строка при старте: на боевом сервере иначе непонятно, живой ли
  // процесс — логгер настроен только на ошибки, и пустой лог пугает.
  console.log(`Табыс: сервер слушает порт ${port}, база ${process.env.PGDATABASE ?? 'shop_dev'}`);

  // WebSocket живёт на том же порту: одна дырка в файрволе магазина вместо двух
  app.get(SyncGateway).attach(app.getHttpServer());

  // Касса регистрирует обработчики офлайн-событий (чеки, смены, отмены):
  // без этого события с кассы уходили бы в карантин как «неизвестная сущность»
  app.get(PosService);
}
bootstrap();
