import { Controller, Post, Get, Patch, Param, Body, Req, UseGuards, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { AuthService } from './auth.service';
import { DbService } from '../db/db.service';
import { JwtAuthGuard, PermissionsGuard, DeviceGuard, Public, RequirePermission, Ctx, Dev } from './guards';
import { EmployeeContext } from './permissions';

// ---------- Проверка входных данных ----------
const KZ_PHONE = /^\+7[0-9]{10}$/;   // формат Казахстана: +7 и 10 цифр

class PhoneDto { @Matches(KZ_PHONE, { message: 'Телефон в формате +77011234567' }) phone: string; }
class RegisterDto extends PhoneDto {
  // Код необязателен: он нужен только когда подключён СМС-шлюз
  // (REQUIRE_OTP=1). Обязательность проверяет сервис, а не эта схема,
  // иначе форма без СМС отбивалась бы ещё до попадания в логику.
  // ValidateIf, а не IsOptional: «необязательный» пропускает только
  // отсутствующее значение, а форма может прислать пустую строку — и тогда
  // проверка длины срабатывала бы на пустоте. Проверяем длину только если
  // код реально введён.
  @ValidateIf((o: any) => o.code !== undefined && o.code !== null && o.code !== '')
  @Length(6, 6) code?: string;
  @Length(2, 100) businessName: string;
  @Length(2, 60) ownerName: string;
  @Length(8, 72, { message: 'Пароль от 8 символов' }) password: string;
  @IsOptional() @IsIn(['ru', 'kk']) lang?: 'ru' | 'kk';
  @IsOptional() @Length(0, 300) note?: string;   // «магазин у дома, 2 кассы»
}
class LoginDto extends PhoneDto { @IsString() password: string; }
class ResetDto extends PhoneDto { @Length(6, 6) code: string; @Length(8, 72) password: string; }
class ChangePasswordDto { @IsString() currentPassword: string; @Length(8, 72) newPassword: string; }
class PairDto {
  @Length(4, 16) code: string;
  @IsIn(['windows', 'android', 'ios', 'web', 'linux']) platform: string;
  @IsString() appVersion: string;
}
class PinDto { @Matches(/^\d{4}$/, { message: 'PIN — 4 цифры' }) pin: string; @IsOptional() offline?: boolean; }
class SetPinDto extends PinDto { @IsString() employeeId: string; }
class ApproveDto {
  @IsOptional() @IsString() id?: string;
  /* КЛЮЧ вошедшего кассира, а не имя. Раньше сюда проходило любое
     слово, база отбивала его при записи, и сервер падал с «внутренней
     ошибкой» — кассир видел стену вместо объяснения. */
  @IsOptional() @IsUUID() requestedBy?: string;
  @IsString() action: string;
  @IsOptional() @IsString() badge?: string;
  @IsOptional() @Matches(/^\d{4}$/) pin?: string;
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() offline?: boolean;
}

// =====================================================================
// КАБИНЕТ
// =====================================================================
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Post('otp')
  otp(@Body() d: PhoneDto & { purpose?: 'register' | 'reset_password' }, @Req() r: any) {
    return this.auth.requestOtp(d.phone, d.purpose ?? 'register', r.ip);
  }

  @Public() @Post('register')
  register(@Body() d: RegisterDto) { return this.auth.register(d); }

  @Public() @Post('login')
  login(@Body() d: LoginDto, @Req() r: any) {
    return this.auth.login(d.phone, d.password, { ip: r.ip, ua: r.headers['user-agent'] });
  }

  @Public() @Post('refresh')
  refresh(@Body() d: { refresh: string }, @Req() r: any) {
    return this.auth.refresh(d.refresh, { ip: r.ip, ua: r.headers['user-agent'] });
  }

  @Public() @Post('logout')
  logout(@Body() d: { refresh: string }) { return this.auth.logout(d.refresh); }

  @Public() @Post('password/reset')
  reset(@Body() d: ResetDto) { return this.auth.resetPassword(d.phone, d.code, d.password); }

  @Get('me')
  me(@Ctx() ctx: EmployeeContext) { return ctx; }

  @Post('password/change')
  changePassword(@Ctx() ctx: EmployeeContext, @Body() d: ChangePasswordDto) {
    return this.auth.changePassword(ctx.accountId, ctx.employeeId, d.currentPassword, d.newPassword);
  }

  // --- сотрудники: список, приём, изменение ---
  @Get('employees') @RequirePermission('employees', 'view')
  employees(@Ctx() ctx: EmployeeContext) { return this.auth.listEmployees(ctx.accountId); }

  @Post('employees') @RequirePermission('employees', 'create')
  createEmployee(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.auth.createEmployee(ctx.accountId, d); }

  @Patch('employees/:id') @RequirePermission('employees', 'edit')
  updateEmployee(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.auth.updateEmployee(ctx.accountId, id, d);
  }

  @Get('roles') @RequirePermission('employees', 'view')
  roles(@Ctx() ctx: EmployeeContext) { return this.auth.listRoles(ctx.accountId); }

  // --- сотрудники: PIN ---
  @Post('employees/pin') @RequirePermission('employees', 'edit')
  setPin(@Ctx() ctx: EmployeeContext, @Body() d: SetPinDto) {
    return this.auth.setPin(ctx.accountId, d.employeeId, d.pin);
  }

  // --- устройства: одноразовый ключ привязки кассы (модель UMAG) ---
  @Post('devices/pairing-code') @RequirePermission('devices', 'create')
  pairingCode(@Ctx() ctx: EmployeeContext, @Body() d: { cashRegisterId: string; name?: string }) {
    return this.auth.createPairingCode(ctx.accountId, d.cashRegisterId, d.name);
  }

  // --- «Выдать доступ» техспециалисту (модель UMAG) ---
  @Post('support/grant') @RequirePermission('settings', 'edit')
  grant(@Ctx() ctx: EmployeeContext, @Body() d: { phone: string; hours?: number; scope?: any }) {
    return this.auth.grantSupport(ctx.accountId, ctx.employeeId, d.phone, d.hours ?? 24, d.scope ?? {});
  }

  @Post('support/revoke') @RequirePermission('settings', 'edit')
  revoke(@Ctx() ctx: EmployeeContext, @Body() d: { accessId: string }) {
    return this.auth.revokeSupport(ctx.accountId, d.accessId);
  }
}

// =====================================================================
// КАССА
// =====================================================================
@Controller('pos')
export class PosController {
  constructor(private auth: AuthService) {}

  /** Привязка кассы одноразовым ключом из кабинета. */
  @Public() @Post('pair')
  pair(@Body() d: PairDto, @Req() r: any) {
    return this.auth.pairDevice(d.code, d.platform, d.appVersion, r.ip);
  }

  /** Пакет для офлайна: сотрудники с хэшами PIN, права, разрешения кассы. */
  /**
   * СТУК СВЯЗИ. Касса спрашивает его, когда отправлять нечего.
   *
   * Без этого пустая очередь давала кассиру зелёную точку ВСЕГДА —
   * даже при мёртвой сети. Он видит зелёное, пробивает чеки, а они
   * копятся, и узнаёт об этом только когда первый попробует уйти.
   *
   * Через сторожа устройства нарочно: заодно узнаём, что устройство не
   * заблокировано и магазин не отключён. Пустой стук этого не покажет.
   */
  @Public() @UseGuards(DeviceGuard) @Get('ping')
  ping() { return { ok: true, at: new Date().toISOString() }; }

  /**
   * КАНАРЕЙКА: касса упала — мы узнали.
   *
   * Касса падает у клиента в Шымкенте, кассир перезапускает её и
   * работает дальше — ему некогда звонить. Без этого мы не узнаём
   * НИКОГДА, а падение повторяется каждый день у десяти клиентов.
   *
   * БЕЗ СТОРОЖА УСТРОЙСТВА нарочно: касса могла упасть ДО привязки, и
   * токена у неё нет. Отчёт важнее строгости — иначе мы не узнаем как
   * раз о самых тяжёлых случаях, когда касса не доходит до входа.
   */
  @Public() @Post('client-error')
  clientError(@Body() d: any) {
    return this.auth.posClientError(d ?? {});
  }

  @Public() @UseGuards(DeviceGuard) @Get('bootstrap')
  bootstrap(@Dev() dev: any) { return this.auth.posBootstrap(dev.account_id, dev.device_id); }

  /** Вход кассира по PIN. Работает и когда касса офлайн (флаг offline). */
  @Public() @UseGuards(DeviceGuard) @Post('login')
  posLogin(@Dev() dev: any, @Body() d: PinDto) {
    return this.auth.posLogin(dev.account_id, dev.device_id, d.pin, d.offline ?? false);
  }

  /** Переключение кассира внутри смены (модель Wipon «администратор смены»). */
  @Public() @UseGuards(DeviceGuard) @Post('switch-user')
  switchUser(@Dev() dev: any, @Body() d: PinDto) {
    return this.auth.posLogin(dev.account_id, dev.device_id, d.pin, d.offline ?? false);
  }

  /**
   * КАССИР УХОДИТ — закрываем явку. Их правило: «„Я ухожу" — тот же
   * PIN, но явка закрывается и касса прощается с человеком, назвав
   * отработанное время».
   *
   * Раньше явка открывалась при входе и не закрывалась вовсе.
   * Владелец смотрит, кто на смене, — видит Айгуль, а она ушла домой
   * три часа назад.
   *
   * Отработанное время возвращаем: это не только учёт, но и уважение —
   * человек видит, сколько отработал, и знает, что это записано.
   */
  @Public() @UseGuards(DeviceGuard) @Post('clock-out')
  clockOut(@Dev() dev: any, @Body() d: PinDto) {
    return this.auth.posClockOut(dev.account_id, dev.device_id, d.pin);
  }

  /** Подтверждение действия старшим: бейдж или PIN (расширенный UMAG). */
  @Public() @UseGuards(DeviceGuard) @Post('approve')
  approve(@Dev() dev: any, @Body() d: ApproveDto) {
    return this.auth.approveAction(dev.account_id, { ...d, deviceId: dev.device_id });
  }
}

// =====================================================================
// МОДУЛЬ
// =====================================================================
@Module({
  imports: [JwtModule.register({
    secret: process.env.JWT_SECRET ?? 'dev_only_secret_change_in_prod',
    signOptions: { issuer: 'shop-api' },
  })],
  controllers: [AuthController, PosController],
  providers: [
    AuthService, DbService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, DbService],
})
export class AuthModule {}
