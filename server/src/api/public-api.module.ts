import {
  Controller, Get, Post, Delete, Body, Param, Req, Module, Injectable, UseGuards,
  CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission, Public } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import * as crypto from 'crypto';

/**
 * ПУБЛИЧНЫЙ API (этап 11).
 *
 * У нас 286 готовых обращений к серверу, но снаружи ими пользоваться
 * было нельзя. А задачи есть настоящие: бухгалтерская программа
 * забирает продажи, сайт магазина показывает остатки, партнёр сверяет
 * заказы.
 *
 * Просить у клиента пароль от кабинета для этого недопустимо: пароль
 * даёт ВСЁ, включая смену тарифа и удаление данных. Ключ — под задачу,
 * с ограниченными правами, отзывается одной кнопкой.
 */

const KEY_PREFIX = 'tby_';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Разделы, к которым можно дать доступ. Список закрытый: разрешать
 *  произвольные строки — значит однажды выдать доступ ко всему опечаткой. */
export const API_SCOPES = [
  'goods:read', 'goods:write',
  'stock:read', 'stock:write',
  'sales:read',
  'customers:read', 'customers:write',
  'reports:read',
] as const;

@Injectable()
export class ApiKeyService {
  constructor(private db: DbService) {}

  /**
   * Создание ключа. Открытое значение показывается ОДИН РАЗ — здесь и
   * больше нигде. Это не строгость ради строгости: если ключ можно
   * подсмотреть позже, значит он где-то лежит открытым, и утечка базы
   * становится утечкой всех ключей разом.
   */
  async create(accountId: string, employeeId: string | null, d: {
    name: string; scopes?: string[]; expiresInDays?: number;
  }) {
    if (!d.name?.trim()) throw new BadRequestException('Назовите ключ: «Для 1С», «Сайт магазина»');
    const scopes = (d.scopes ?? ['reports:read']).filter((s) => (API_SCOPES as readonly string[]).includes(s));
    if (!scopes.length) throw new BadRequestException('Укажите хотя бы одно право из списка');

    // Ключ длинный и случайный: подобрать перебором невозможно.
    const secret = crypto.randomBytes(24).toString('base64url');
    const key = KEY_PREFIX + secret;
    const prefix = key.slice(0, 12);

    const expires = d.expiresInDays
      ? new Date(Date.now() + d.expiresInDays * 86400000).toISOString() : null;

    const row = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO api_key (account_id, name, key_hash, prefix, scopes, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, prefix, scopes, expires_at, created_at`,
        [accountId, d.name.trim(), sha256(key), prefix, scopes, employeeId, expires])).rows[0]);

    return {
      ...row,
      key,                          // единственный раз, когда он виден
      warning: 'Сохраните ключ сейчас — увидеть его снова будет нельзя. ' +
               'Передавайте только тому, кому доверяете: ключ действует без пароля.',
    };
  }

  async list(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, name, prefix, scopes, last_used_at, last_used_ip, calls_count,
                expires_at, revoked_at, created_at
           FROM api_key ORDER BY created_at DESC`)).rows
        .map((r: any) => ({
          ...r, calls_count: Number(r.calls_count),
          // Забытый ключ — это дверь, о которой никто не помнит.
          // Подсказываем владельцу прямо в списке.
          status: r.revoked_at ? 'отозван'
            : (r.expires_at && new Date(r.expires_at) < new Date()) ? 'просрочен'
            : !r.last_used_at ? 'ни разу не использован'
            : 'работает',
        })));
  }

  /** Отзыв. Не удаляем строку: журнал использования нужен, если ключ
   *  утёк и надо понять, что им успели сделать. */
  async revoke(accountId: string, id: string) {
    return this.db.withTenant(accountId, async (c) => {
      const r = await c.query(
        `UPDATE api_key SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id, name`, [id]);
      if (!r.rows[0]) throw new BadRequestException('Ключ не найден или уже отозван');
      return { ok: true, name: r.rows[0].name };
    });
  }
}

/**
 * Проверка ключа на входе. Отдельно от входа по паролю: у ключа нет
 * сотрудника, смены и прав в привычном виде — только магазин и список
 * разрешённых разделов.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private db: DbService) {}

  async canActivate(x: ExecutionContext): Promise<boolean> {
    const req = x.switchToHttp().getRequest();
    const key = req.headers['x-api-key'];
    if (!key) throw new UnauthorizedException('Нужен ключ доступа в заголовке X-Api-Key');

    const found = (await this.db.raw(`SELECT * FROM api_key_lookup($1)`, [sha256(String(key))])).rows[0];
    if (!found) throw new UnauthorizedException('Ключ не найден');
    if (found.revoked) throw new UnauthorizedException('Ключ отозван');
    if (found.expired) throw new UnauthorizedException('Срок действия ключа истёк');

    req.apiKey = found;
    // Отметку об использовании делаем, но не ждём её: медленная запись
    // не должна задерживать ответ клиенту.
    this.db.raw(`SELECT api_key_touch($1,$2)`, [found.id, req.ip ?? null]).catch(() => {});
    return true;
  }
}

/** Проверка права по разделу. */
function needScope(req: any, scope: string) {
  const scopes: string[] = req.apiKey?.scopes ?? [];
  if (!scopes.includes(scope))
    throw new ForbiddenException(`У ключа нет права «${scope}». Права ключа: ${scopes.join(', ') || 'нет'}`);
}

// =====================================================================
/** Управление ключами — из кабинета, владельцем. */
@Controller('api-keys')
export class ApiKeyController {
  constructor(private svc: ApiKeyService) {}

  @Get() @RequirePermission('settings', 'view')
  list(@Ctx() ctx: EmployeeContext) { return this.svc.list(ctx.accountId); }

  @Get('scopes') @RequirePermission('settings', 'view')
  scopes() {
    return API_SCOPES.map((s) => ({
      code: s,
      label: {
        'goods:read': 'Товары — читать', 'goods:write': 'Товары — изменять',
        'stock:read': 'Остатки — читать', 'stock:write': 'Склад — изменять',
        'sales:read': 'Продажи — читать',
        'customers:read': 'Клиенты — читать', 'customers:write': 'Клиенты — изменять',
        'reports:read': 'Отчёты — читать',
      }[s],
    }));
  }

  @Post() @RequirePermission('settings', 'edit')
  create(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.create(ctx.accountId, ctx.employeeId, d);
  }

  @Delete(':id') @RequirePermission('settings', 'edit')
  revoke(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.svc.revoke(ctx.accountId, id);
  }
}

// =====================================================================
/**
 * Сам публичный API. Обращения короткие и понятные: сторонний
 * разработчик не должен изучать наш кабинет, чтобы забрать остатки.
 */
/**
 * Проверка ключа применяется ТОЛЬКО к этому разделу, а не ко всему
 * серверу: кабинет и касса ходят своими способами входа, и общая
 * проверка ключа сломала бы их. Ставим её на контроллер.
 */
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicApiController {
  constructor(private db: DbService) {}

  private tenant(req: any) { return req.apiKey.account_id; }

  @Public() @Get('ping')
  ping(@Req() req: any) {
    // Первое, что делает разработчик — проверяет, что ключ рабочий.
    // Отдаём название ключа и права: сразу видно, тем ли ключом стучится.
    return { ok: true, key: req.apiKey?.name, scopes: req.apiKey?.scopes };
  }

  @Public() @Get('goods')
  async goods(@Req() req: any) {
    needScope(req, 'goods:read');
    return this.db.withTenant(this.tenant(req), async (c) =>
      (await c.query(
        `SELECT p.id, p.name, p.article, p.ntin,
                (SELECT b.code FROM barcode b WHERE b.product_id=p.id ORDER BY b.is_primary DESC LIMIT 1) AS barcode,
                coalesce((SELECT pp.value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                           WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL LIMIT 1),0) AS price
           FROM product p WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
          ORDER BY p.name LIMIT 1000`)).rows
        .map((r: any) => ({ ...r, price: Number(r.price) })));
  }

  @Public() @Get('stock')
  async stock(@Req() req: any) {
    needScope(req, 'stock:read');
    return this.db.withTenant(this.tenant(req), async (c) =>
      (await c.query(
        `SELECT p.id AS product_id, p.name, coalesce(sum(b.qty),0) AS qty
           FROM product p LEFT JOIN stock_balance b ON b.product_id=p.id
          WHERE p.deleted_at IS NULL AND p.track_stock
          GROUP BY p.id, p.name HAVING coalesce(sum(b.qty),0) <> 0
          ORDER BY p.name LIMIT 1000`)).rows
        .map((r: any) => ({ ...r, qty: Number(r.qty) })));
  }

  @Public() @Get('sales')
  async sales(@Req() req: any) {
    needScope(req, 'sales:read');
    return this.db.withTenant(this.tenant(req), async (c) =>
      (await c.query(
        `SELECT s.id, s.number, s.total, s.discount_sum, s.created_at,
                cp.name AS customer,
                (SELECT count(*) FROM sale_item si WHERE si.sale_id=s.id) AS items
           FROM sale s LEFT JOIN counterparty cp ON cp.id=s.customer_id
          WHERE s.created_at >= now() - interval '30 days' AND s.return_of_id IS NULL
          ORDER BY s.created_at DESC LIMIT 500`)).rows
        .map((r: any) => ({ ...r, total: Number(r.total), discount_sum: Number(r.discount_sum),
                            items: Number(r.items) })));
  }

  @Public() @Get('customers')
  async customers(@Req() req: any) {
    needScope(req, 'customers:read');
    return this.db.withTenant(this.tenant(req), async (c) =>
      (await c.query(
        `SELECT id, name, phone, iin_bin, debt_limit FROM counterparty
          WHERE deleted_at IS NULL AND is_customer ORDER BY name LIMIT 1000`)).rows);
  }
}

@Module({
  controllers: [ApiKeyController, PublicApiController],
  providers: [ApiKeyService, ApiKeyGuard, DbService],
})
export class PublicApiModule {}
