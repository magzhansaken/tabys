import { Controller, Get, Post, Patch, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { MarketplaceProvider, MockMarketplaceProvider, KaspiMarketplaceProvider, MpOrder } from './marketplace.provider';

/**
 * ИНТЕГРАЦИЯ С МАРКЕТПЛЕЙСОМ (часть 32) — Kaspi Магазин.
 *
 * Два потока:
 *  • ВЫГРУЗКА: наш каталог → цены и остатки на маркетплейс (только то, что
 *    в наличии — правило Kaspi). Единый остаток: не выгружаем больше, чем есть.
 *  • ЗАКАЗЫ: маркетплейс → наши заказы. Принять → собрать → выдать. При
 *    завершении списываем товар со склада (единый остаток, без двойных продаж).
 *
 * Маппинг product ↔ SKU обязателен — иначе «нераспознанные позиции» (грабли
 * МоегоСклада, которые мы обходим явным маппингом).
 */

@Injectable()
export class MarketplaceService {
  constructor(private db: DbService) {}

  private providers = new Map<string, MarketplaceProvider>([['mock', new MockMarketplaceProvider()]]);
  setProvider(name: string, p: MarketplaceProvider) { this.providers.set(name, p); }
  getProvider(name: string) { return this.providers.get(name); }

  // ---------- ПОДКЛЮЧЕНИЕ ----------
  async connect(accountId: string, d: { provider?: string; merchantId?: string; authToken?: string; autoAccept?: boolean; priceType?: string }) {
    const provider = d.provider ?? 'kaspi';
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO marketplace_connection (account_id, provider, merchant_id, auth_token, enabled, auto_accept, price_type)
         VALUES ($1,$2,$3,$4,true,$5,$6)
         ON CONFLICT (account_id, provider) DO UPDATE SET
           merchant_id=$3, auth_token=$4, enabled=true, auto_accept=$5, price_type=$6
         RETURNING id, provider, enabled, auto_accept, price_type`,
        [accountId, provider, d.merchantId ?? null, d.authToken ?? null, d.autoAccept ?? false, d.priceType ?? 'retail']);
      return rows[0];
    });
  }

  async connection(accountId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, provider, merchant_id, enabled, auto_accept, price_type, last_sync_at
           FROM marketplace_connection WHERE provider=$1`, [provider])).rows[0] ?? null);
  }

  // ---------- МАППИНГ ТОВАРОВ ----------
  async createListing(accountId: string, d: { provider?: string; productId: string; sku: string }) {
    if (!d.productId || !d.sku?.trim()) throw new BadRequestException('Нужны товар и SKU маркетплейса');
    const provider = d.provider ?? 'kaspi';
    return this.db.withTenant(accountId, async (c) => {
      const dup = (await c.query(
        `SELECT 1 FROM marketplace_listing WHERE provider=$1 AND sku=$2`, [provider, d.sku.trim()])).rows[0];
      if (dup) throw new BadRequestException(`SKU «${d.sku}» уже сопоставлен`);
      return (await c.query(
        `INSERT INTO marketplace_listing (account_id, provider, product_id, sku)
         VALUES ($1,$2,$3,$4) RETURNING id, sku, published`,
        [accountId, provider, d.productId, d.sku.trim()])).rows[0];
    });
  }

  async listings(accountId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT ml.id, ml.sku, ml.published, ml.last_price, ml.last_qty, ml.synced_at, p.name AS product
           FROM marketplace_listing ml JOIN product p ON p.id = ml.product_id
          WHERE ml.provider=$1 ORDER BY p.name`, [provider])).rows
        .map((r: any) => ({ ...r, last_price: r.last_price != null ? Number(r.last_price) : null,
          last_qty: r.last_qty != null ? Number(r.last_qty) : null })));
  }

  // ---------- ВЫГРУЗКА ЦЕН И ОСТАТКОВ ----------
  async pushPrices(accountId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) => {
      const conn = (await c.query(`SELECT * FROM marketplace_connection WHERE provider=$1 AND enabled`, [provider])).rows[0];
      if (!conn) throw new BadRequestException('Маркетплейс не подключён');

      // только сопоставленные и опубликованные товары, что есть в наличии
      const feed = (await c.query(
        `SELECT ml.sku, ml.product_id,
                coalesce((SELECT pp.value FROM product_price pp
                           JOIN price_type pt ON pt.id=pp.price_type_id
                          WHERE pp.product_id=ml.product_id AND pt.code=$2 AND pp.store_id IS NULL LIMIT 1),0) AS price,
                coalesce((SELECT sum(sb.qty) FROM stock_balance sb WHERE sb.product_id=ml.product_id),0) AS qty
           FROM marketplace_listing ml
          WHERE ml.provider=$1 AND ml.published`, [provider, conn.price_type])).rows;

      // Kaspi не принимает отсутствующие — выгружаем только qty>0
      const rows = feed.filter((r: any) => Number(r.qty) > 0)
        .map((r: any) => ({ sku: r.sku, price: Number(r.price), qty: Number(r.qty) }));

      const prov = this.providers.get(provider);
      if (!prov) throw new BadRequestException('Провайдер не подключён');
      const res = await prov.pushPriceFeed({ merchantId: conn.merchant_id, authToken: conn.auth_token }, rows);

      // фиксируем выгруженные значения
      for (const r of rows)
        await c.query(
          `UPDATE marketplace_listing SET last_price=$2, last_qty=$3, synced_at=now()
            WHERE provider=$1 AND sku=$4`, [provider, r.price, r.qty, r.sku]);
      await c.query(`UPDATE marketplace_connection SET last_sync_at=now() WHERE id=$1`, [conn.id]);
      await c.query(
        `INSERT INTO marketplace_sync_log (account_id, provider, kind, ok, detail)
         VALUES ($1,$2,'price_push',$3,$4)`,
        [accountId, provider, res.ok, `Выгружено позиций: ${res.pushed}`]);
      return { ok: res.ok, pushed: res.pushed, skipped: feed.length - rows.length };
    });
  }

  // ---------- ЗАКАЗЫ ----------
  /** Забрать новые заказы с маркетплейса и сохранить у нас */
  async pullOrders(accountId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) => {
      const conn = (await c.query(`SELECT * FROM marketplace_connection WHERE provider=$1 AND enabled`, [provider])).rows[0];
      if (!conn) throw new BadRequestException('Маркетплейс не подключён');
      const prov = this.providers.get(provider);
      if (!prov) throw new BadRequestException('Провайдер не подключён');

      const orders = await prov.fetchNewOrders({ merchantId: conn.merchant_id, authToken: conn.auth_token });
      let saved = 0, accepted = 0;
      for (const o of orders) {
        // идемпотентность по external_id
        const exists = (await c.query(
          `SELECT id FROM marketplace_order WHERE provider=$1 AND external_id=$2`, [provider, o.externalId])).rows[0];
        if (exists) continue;

        const { rows } = await c.query(
          `INSERT INTO marketplace_order (account_id, provider, external_id, code, state, status,
                    customer_name, customer_phone, delivery_mode, total_price, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [accountId, provider, o.externalId, o.code, o.state, o.status, o.customerName ?? null,
           o.customerPhone ?? null, o.deliveryMode ?? null, o.totalPrice, JSON.stringify(o)]);
        const orderId = rows[0].id;

        for (const it of o.items) {
          // сопоставляем позицию с нашим товаром по SKU
          const listing = (await c.query(
            `SELECT product_id FROM marketplace_listing WHERE provider=$1 AND sku=$2`, [provider, it.sku])).rows[0];
          await c.query(
            `INSERT INTO marketplace_order_item (account_id, order_id, sku, product_id, name, qty, price)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [accountId, orderId, it.sku, listing?.product_id ?? null, it.name, it.qty, it.price]);
        }
        saved++;

        // авто-принятие, если включено
        if (conn.auto_accept) {
          const r = await prov.acceptOrder({ authToken: conn.auth_token }, o.externalId, o.code);
          if (r.ok) {
            await c.query(`UPDATE marketplace_order SET status='accepted', accepted_at=now() WHERE id=$1`, [orderId]);
            accepted++;
          }
        }
      }
      await c.query(
        `INSERT INTO marketplace_sync_log (account_id, provider, kind, ok, detail)
         VALUES ($1,$2,'orders_pull',true,$3)`, [accountId, provider, `Новых заказов: ${saved}, принято авто: ${accepted}`]);
      return { fetched: orders.length, saved, accepted };
    });
  }

  async orders(accountId: string, provider = 'kaspi', state?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, code, state, status, customer_name, delivery_mode, total_price, accepted_at, created_at
           FROM marketplace_order
          WHERE provider=$1 AND ($2::text IS NULL OR state=$2)
          ORDER BY created_at DESC LIMIT 100`, [provider, state ?? null])).rows
        .map((r: any) => ({ ...r, total_price: Number(r.total_price) })));
  }

  async order(accountId: string, orderId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(`SELECT * FROM marketplace_order WHERE id=$1`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      const items = (await c.query(
        `SELECT moi.sku, moi.name, moi.qty, moi.price, moi.product_id, p.name AS matched_product
           FROM marketplace_order_item moi LEFT JOIN product p ON p.id = moi.product_id
          WHERE moi.order_id=$1`, [orderId])).rows;
      return {
        id: o.id, code: o.code, state: o.state, status: o.status,
        customer: o.customer_name, phone: o.customer_phone, deliveryMode: o.delivery_mode,
        total: Number(o.total_price), accepted: !!o.accepted_at,
        items: items.map((r: any) => ({ ...r, qty: Number(r.qty), price: Number(r.price),
          matched: !!r.product_id })),
        unmatchedCount: items.filter((r: any) => !r.product_id).length,
      };
    });
  }

  /** Принять заказ вручную */
  async acceptOrder(accountId: string, orderId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(`SELECT * FROM marketplace_order WHERE id=$1`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      if (o.accepted_at) return { ok: true, alreadyAccepted: true };
      const conn = (await c.query(`SELECT * FROM marketplace_connection WHERE provider=$1`, [provider])).rows[0];
      const prov = this.providers.get(provider);
      const r = await prov!.acceptOrder({ authToken: conn?.auth_token }, o.external_id, o.code);
      if (!r.ok) throw new BadRequestException(`Не удалось принять: ${r.error}`);
      await c.query(`UPDATE marketplace_order SET status='accepted', accepted_at=now() WHERE id=$1`, [orderId]);
      await c.query(
        `INSERT INTO marketplace_sync_log (account_id, provider, kind, ok, detail)
         VALUES ($1,$2,'order_accept',true,$3)`, [accountId, provider, `Заказ ${o.code} принят`]);
      return { ok: true };
    });
  }

  /**
   * Завершить заказ (выдан/собран) → списать товар со склада. Единый остаток:
   * продажа на маркетплейсе уменьшает тот же склад, что и розница.
   */
  async completeOrder(accountId: string, orderId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) => {
      const o = (await c.query(`SELECT * FROM marketplace_order WHERE id=$1`, [orderId])).rows[0];
      if (!o) throw new BadRequestException('Заказ не найден');
      if (!o.accepted_at) throw new BadRequestException('Сначала примите заказ');
      if (o.completed_at) return { ok: true, alreadyCompleted: true };

      const items = (await c.query(
        `SELECT product_id, qty FROM marketplace_order_item WHERE order_id=$1`, [orderId])).rows;
      const unmatched = items.filter((r: any) => !r.product_id);
      if (unmatched.length) throw new BadRequestException(`${unmatched.length} позиций не сопоставлены с товаром — сначала настройте маппинг`);

      // основной склад
      const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0];
      for (const it of items) {
        const p = (await c.query(`SELECT track_stock FROM product WHERE id=$1`, [it.product_id])).rows[0];
        if (!p?.track_stock) continue;
        await c.query(`SELECT apply_stock_move($1,$2,$3,$4,NULL,'sale',NULL,NULL)`,
          [accountId, wh.id, it.product_id, -Number(it.qty)]);
      }

      const conn = (await c.query(`SELECT * FROM marketplace_connection WHERE provider=$1`, [provider])).rows[0];
      const prov = this.providers.get(provider);
      await prov!.updateOrderStatus({ authToken: conn?.auth_token }, o.external_id, o.code, 'completed');
      await c.query(`UPDATE marketplace_order SET status='completed', state='archive', completed_at=now() WHERE id=$1`, [orderId]);
      return { ok: true, itemsShipped: items.length };
    });
  }

  async syncLog(accountId: string, provider = 'kaspi') {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT kind, ok, detail, created_at FROM marketplace_sync_log
          WHERE provider=$1 ORDER BY created_at DESC LIMIT 50`, [provider])).rows);
  }
}

// =====================================================================
@Controller('marketplace')
export class MarketplaceController {
  constructor(private svc: MarketplaceService) {}

  @Post('connect') @RequirePermission('settings', 'edit')
  connect(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.connect(ctx.accountId, d); }

  @Get('connection') @RequirePermission('settings', 'view')
  connection(@Ctx() ctx: EmployeeContext, @Query('provider') p?: string) { return this.svc.connection(ctx.accountId, p); }

  @Post('listings') @RequirePermission('goods', 'edit')
  createListing(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.createListing(ctx.accountId, d); }

  @Get('listings') @RequirePermission('goods', 'view')
  listings(@Ctx() ctx: EmployeeContext, @Query('provider') p?: string) { return this.svc.listings(ctx.accountId, p); }

  @Post('push-prices') @RequirePermission('goods', 'edit')
  pushPrices(@Ctx() ctx: EmployeeContext, @Body() d: { provider?: string }) { return this.svc.pushPrices(ctx.accountId, d.provider); }

  @Post('pull-orders') @RequirePermission('contragents', 'edit')
  pullOrders(@Ctx() ctx: EmployeeContext, @Body() d: { provider?: string }) { return this.svc.pullOrders(ctx.accountId, d.provider); }

  @Get('orders') @RequirePermission('contragents', 'view')
  orders(@Ctx() ctx: EmployeeContext, @Query() q: any) { return this.svc.orders(ctx.accountId, q.provider, q.state); }

  @Get('orders/:id') @RequirePermission('contragents', 'view')
  order(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.order(ctx.accountId, id); }

  @Post('orders/:id/accept') @RequirePermission('contragents', 'edit')
  accept(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { provider?: string }) {
    return this.svc.acceptOrder(ctx.accountId, id, d.provider);
  }

  @Post('orders/:id/complete') @RequirePermission('contragents', 'edit')
  complete(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { provider?: string }) {
    return this.svc.completeOrder(ctx.accountId, id, d.provider);
  }

  @Get('sync-log') @RequirePermission('settings', 'view')
  syncLog(@Ctx() ctx: EmployeeContext, @Query('provider') p?: string) { return this.svc.syncLog(ctx.accountId, p); }

  // ТЕСТОВЫЙ эндпоинт: положить заказ в mock-очередь (работает только в NODE_ENV=test)
  @Post('_mock-seed-order') @RequirePermission('settings', 'edit')
  mockSeed(@Body() o: any) {
    if (process.env.NODE_ENV !== 'test') throw new BadRequestException('Только для тестов');
    const prov: any = this.svc.getProvider('mock');
    if (prov?.seedOrder) prov.seedOrder(o);
    return { ok: true };
  }
}

@Module({ controllers: [MarketplaceController], providers: [MarketplaceService, DbService] })
export class MarketplaceModule {}
