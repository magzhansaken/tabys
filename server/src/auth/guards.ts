import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException,
  ForbiddenException, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { can, Section, Action } from './permissions';

/** @Public() — эндпоинт без токена (вход, регистрация, привязка кассы). */
export const Public = () => SetMetadata('isPublic', true);

/** @RequirePermission('goods','create') — единственный способ закрыть эндпоинт. */
export const RequirePermission = (section: Section, action: Action) =>
  SetMetadata('perm', { section, action });

/** @Ctx() — контекст сотрудника в аргументах метода. */
export const Ctx = createParamDecorator((_d, x: ExecutionContext) => x.switchToHttp().getRequest().ctx);
/** @Dev() — контекст устройства (касса). */
export const Dev = createParamDecorator((_d, x: ExecutionContext) => x.switchToHttp().getRequest().device);

/**
 * Вход в кабинет по JWT. Access живёт 15 минут и проверяется без БД —
 * права подгружаются отдельно, чтобы изменение роли действовало сразу,
 * а не через 15 минут (иначе уволенный кассир доработал бы четверть часа).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private auth: AuthService, private reflector: Reflector) {}

  async canActivate(x: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>('isPublic', [x.getHandler(), x.getClass()])) return true;

    const req = x.switchToHttp().getRequest();
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException('Нужен токен');

    let payload: any;
    try { payload = await this.jwt.verifyAsync(h.slice(7)); }
    catch { throw new UnauthorizedException('Токен недействителен или истёк'); }

    // Поддержка: специалист работает в чужом аккаунте по выданному доступу (UMAG)
    const targetAccount = req.headers['x-support-account'] as string | undefined;
    if (targetAccount && targetAccount !== payload.acc) {
      const grants = await this.auth.listSupportGrants(payload.phone ?? '');
      if (!grants.some((g: any) => g.account_id === targetAccount))
        throw new ForbiddenException('Доступ к этому аккаунту не выдан');
      req.ctx = await this.auth.loadContext(targetAccount, payload.sub);
      req.ctx.viaSupport = true;
      return true;
    }

    req.ctx = await this.auth.loadContext(payload.acc, payload.sub);
    return true;
  }
}

/**
 * Проверка прав. Одно место на весь сервер: права размазанные по 14 модулям —
 * это гарантированная дыра.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(x: ExecutionContext): boolean {
    const need = this.reflector.getAllAndOverride<{ section: Section; action: Action }>('perm', [x.getHandler(), x.getClass()]);
    if (!need) return true;
    const req = x.switchToHttp().getRequest();
    if (!req.ctx) throw new UnauthorizedException('Нет контекста сотрудника');

    // Заявка ещё не активирована оператором: вход разрешён (человек видит
    // экран «ожидает активации»), но рабочие операции закрыты. Одна проверка
    // в одном месте — надёжнее, чем расставлять её по всем модулям.
    if (req.ctx.accountStatus === 'pending')
      throw new ForbiddenException(
        'Аккаунт ожидает активации. Мы свяжемся с вами по указанному телефону.');

    if (!can(req.ctx, need.section, need.action))
      throw new ForbiddenException(`Нет права: ${need.section}.${need.action}`);
    return true;
  }
}

/**
 * Касса ходит с токеном устройства (X-Device-Token), а не с JWT:
 * устройство живёт годами, JWT такой срок держать нельзя.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(private auth: AuthService) {}

  async canActivate(x: ExecutionContext): Promise<boolean> {
    const req = x.switchToHttp().getRequest();
    const token = req.headers['x-device-token'] as string;
    if (!token) throw new UnauthorizedException('Нужен токен устройства');
    req.device = await this.auth.resolveDevice(token);
    return true;
  }
}
