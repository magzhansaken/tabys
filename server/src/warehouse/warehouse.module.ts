import { Controller, Get, Post, Patch, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

/**
 * СКЛАД++ (часть 26): адресное хранение и лист отбора.
 *
 * Решения (см. миграцию 033):
 *  • Ячейки ОПЦИОНАЛЬНЫ (флаг на складе). Магазину у дома не нужны, но задел
 *    для растущих клиентов есть. Пока выключено — всё работает по складу.
 *  • ТСД — это наша касса-Android (часть 16). Здесь серверная поддержка
 *    «скан товара в ячейку»: размещение и снятие по штрихкоду.
 *  • Лист отбора вместо WMS-волны: у магазина нет заказов покупателей и
 *    комплектовщиков. Лист — печатный маршрут по ячейкам для сбора товара.
 */

@Injectable()
export class WarehousePlusService {
  constructor(private db: DbService) {}

  // ---------- ВКЛючение адресного хранения ----------
  async list(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, name, bin_enabled, is_primary FROM warehouse
          WHERE deleted_at IS NULL ORDER BY is_primary DESC, name`)).rows);
  }

  async setBinEnabled(accountId: string, warehouseId: string, enabled: boolean) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE warehouse SET bin_enabled=$2 WHERE id=$1`, [warehouseId, enabled]);
      return { ok: true, binEnabled: enabled };
    });
  }

  // ---------- ЗОНЫ ----------
  async createZone(accountId: string, warehouseId: string, name: string) {
    if (!name?.trim()) throw new BadRequestException('Название зоны обязательно');
    return this.db.withTenant(accountId, async (c) => {
      // ограничение МоегоСклада: не более 10 зон на склад
      const cnt = (await c.query(`SELECT count(*)::int AS n FROM warehouse_zone WHERE warehouse_id=$1`, [warehouseId])).rows[0].n;
      if (cnt >= 10) throw new BadRequestException('На складе не больше 10 зон');
      return (await c.query(
        `INSERT INTO warehouse_zone (account_id, warehouse_id, name) VALUES ($1,$2,$3) RETURNING id, name`,
        [accountId, warehouseId, name.trim()])).rows[0];
    });
  }

  // ---------- ЯЧЕЙКИ ----------
  async createCell(accountId: string, d: { warehouseId: string; zoneId?: string; address: string; barcode?: string }) {
    if (!d.address?.trim()) throw new BadRequestException('Адрес ячейки обязателен (например, А-01-03)');
    return this.db.withTenant(accountId, async (c) => {
      const dup = (await c.query(
        `SELECT 1 FROM warehouse_cell WHERE warehouse_id=$1 AND address=$2 AND deleted_at IS NULL`,
        [d.warehouseId, d.address.trim()])).rows[0];
      if (dup) throw new BadRequestException(`Ячейка «${d.address}» уже есть`);
      return (await c.query(
        `INSERT INTO warehouse_cell (account_id, warehouse_id, zone_id, address, barcode)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, address, barcode`,
        [accountId, d.warehouseId, d.zoneId ?? null, d.address.trim(), d.barcode?.trim() ?? null])).rows[0];
    });
  }

  async cells(accountId: string, warehouseId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT wc.id, wc.address, wc.barcode, wz.name AS zone,
                coalesce((SELECT sum(qty) FROM cell_balance cb WHERE cb.cell_id=wc.id), 0) AS total_qty,
                (SELECT count(*) FROM cell_balance cb WHERE cb.cell_id=wc.id AND cb.qty<>0)::int AS products
           FROM warehouse_cell wc
           LEFT JOIN warehouse_zone wz ON wz.id = wc.zone_id
          WHERE wc.warehouse_id=$1 AND wc.deleted_at IS NULL
          ORDER BY wc.address`, [warehouseId])).rows
        .map((r: any) => ({ ...r, total_qty: Number(r.total_qty) })));
  }

  /** Разместить/снять товар в ячейке (ТСД: скан ячейки → скан товара → кол-во) */
  async placeInCell(accountId: string, d: { cellId: string; productId: string; qty: number }) {
    if (!d.qty || d.qty === 0) throw new BadRequestException('Количество не может быть нулём');
    return this.db.withTenant(accountId, async (c) => {
      // при снятии проверяем остаток заранее — иначе RAISE даст 500
      if (d.qty < 0) {
        const cur = (await c.query(
          `SELECT qty FROM cell_balance WHERE cell_id=$1 AND product_id=$2`, [d.cellId, d.productId])).rows[0];
        const have = cur ? Number(cur.qty) : 0;
        if (have + d.qty < 0)
          throw new BadRequestException(`В ячейке только ${have} — снять ${-d.qty} нельзя`);
      }
      const qty = (await c.query(`SELECT apply_cell_move($1,$2,$3,$4::numeric) AS q`,
        [accountId, d.cellId, d.productId, d.qty])).rows[0].q;
      return { ok: true, cellQty: Number(qty) };
    });
  }

  /** Скан по штрихкоду ячейки — для кассы-ТСД (штрихкод → ячейка) */
  async cellByBarcode(accountId: string, barcode: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cell = (await c.query(
        `SELECT wc.id, wc.address, wz.name AS zone FROM warehouse_cell wc
           LEFT JOIN warehouse_zone wz ON wz.id=wc.zone_id
          WHERE wc.barcode=$1 AND wc.deleted_at IS NULL LIMIT 1`, [barcode.trim()])).rows[0];
      if (!cell) throw new BadRequestException('Ячейка с таким штрихкодом не найдена');
      return cell;
    });
  }

  /** Где лежит товар (по всем ячейкам) — для листа отбора и поиска */
  async productLocations(accountId: string, productId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT wc.id AS cell_id, wc.address, cb.qty
           FROM cell_balance cb JOIN warehouse_cell wc ON wc.id=cb.cell_id
          WHERE cb.product_id=$1 AND cb.qty>0 AND wc.deleted_at IS NULL
          ORDER BY wc.address`, [productId])).rows
        .map((r: any) => ({ ...r, qty: Number(r.qty) })));
  }

  // ---------- ЛИСТ ОТБОРА ----------
  /**
   * Создать лист отбора: по списку товаров подбираем ячейки (где лежит) и
   * строим маршрут по адресам. Кладовщик печатает и идёт собирать.
   */
  async createPickingList(accountId: string, employeeId: string | null, d: {
    warehouseId: string; items: { productId: string; qty: number }[]; comment?: string;
  }) {
    if (!d.items?.length) throw new BadRequestException('Список пуст — добавьте товары');
    return this.db.withTenant(accountId, async (c) => {
      const num = `ЛО-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}`;
      const { rows } = await c.query(
        `INSERT INTO picking_list (account_id, warehouse_id, number, comment, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [accountId, d.warehouseId, num, d.comment ?? null, employeeId]);
      const listId = rows[0].id;

      for (const it of d.items) {
        // берём ячейку с максимальным остатком товара (проще собрать в одном месте)
        const cell = (await c.query(
          `SELECT wc.id FROM cell_balance cb JOIN warehouse_cell wc ON wc.id=cb.cell_id
            WHERE cb.product_id=$1 AND cb.qty>0 AND wc.warehouse_id=$2 AND wc.deleted_at IS NULL
            ORDER BY cb.qty DESC LIMIT 1`, [it.productId, d.warehouseId])).rows[0];
        await c.query(
          `INSERT INTO picking_list_item (account_id, list_id, product_id, cell_id, qty)
           VALUES ($1,$2,$3,$4,$5)`, [accountId, listId, it.productId, cell?.id ?? null, it.qty]);
      }
      return { id: listId, number: num };
    });
  }

  async pickingList(accountId: string, listId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const list = (await c.query(`SELECT * FROM picking_list WHERE id=$1`, [listId])).rows[0];
      if (!list) throw new BadRequestException('Лист отбора не найден');
      const items = (await c.query(
        `SELECT pli.id, pli.qty, pli.picked, p.name AS product, wc.address AS cell
           FROM picking_list_item pli
           JOIN product p ON p.id = pli.product_id
           LEFT JOIN warehouse_cell wc ON wc.id = pli.cell_id
          WHERE pli.list_id=$1
          ORDER BY wc.address NULLS LAST`, [listId])).rows;
      return {
        id: list.id, number: list.number, status: list.status, comment: list.comment,
        items: items.map((r: any) => ({ ...r, qty: Number(r.qty) })),
      };
    });
  }

  async markPicked(accountId: string, itemId: string, picked: boolean) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE picking_list_item SET picked=$2 WHERE id=$1`, [itemId, picked]);
      return { ok: true };
    });
  }

  async closePickingList(accountId: string, listId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const notPicked = (await c.query(
        `SELECT count(*)::int AS n FROM picking_list_item WHERE list_id=$1 AND NOT picked`, [listId])).rows[0].n;
      await c.query(`UPDATE picking_list SET status='picked', done_at=now() WHERE id=$1`, [listId]);
      return { ok: true, notPicked };
    });
  }

  async pickingLists(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT pl.id, pl.number, pl.status, pl.created_at,
                (SELECT count(*) FROM picking_list_item WHERE list_id=pl.id)::int AS items,
                (SELECT count(*) FROM picking_list_item WHERE list_id=pl.id AND picked)::int AS picked
           FROM picking_list pl WHERE pl.account_id=$1 ORDER BY pl.created_at DESC LIMIT 50`, [accountId])).rows);
  }
}

// =====================================================================
@Controller('warehouse')
export class WarehousePlusController {
  constructor(private svc: WarehousePlusService) {}

  @Get('list') @RequirePermission('stock', 'view')
  list(@Ctx() ctx: EmployeeContext) { return this.svc.list(ctx.accountId); }

  @Post(':id/bin-enabled') @RequirePermission('stock', 'edit')
  setBin(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { enabled: boolean }) {
    return this.svc.setBinEnabled(ctx.accountId, id, d.enabled);
  }

  @Post(':id/zones') @RequirePermission('stock', 'edit')
  createZone(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { name: string }) {
    return this.svc.createZone(ctx.accountId, id, d.name);
  }

  @Post('cells') @RequirePermission('stock', 'edit')
  createCell(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.createCell(ctx.accountId, d); }

  @Get(':id/cells') @RequirePermission('stock', 'view')
  cells(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.cells(ctx.accountId, id); }

  @Post('cells/place') @RequirePermission('stock', 'edit')
  place(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.svc.placeInCell(ctx.accountId, d); }

  @Get('cells/by-barcode') @RequirePermission('stock', 'view')
  cellByBarcode(@Ctx() ctx: EmployeeContext, @Query('barcode') barcode: string) {
    return this.svc.cellByBarcode(ctx.accountId, barcode);
  }

  @Get('product/:id/locations') @RequirePermission('stock', 'view')
  locations(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.svc.productLocations(ctx.accountId, id);
  }

  // лист отбора
  @Post('picking') @RequirePermission('stock', 'edit')
  createPicking(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.createPickingList(ctx.accountId, ctx.employeeId, d);
  }

  @Get('picking') @RequirePermission('stock', 'view')
  pickingLists(@Ctx() ctx: EmployeeContext) { return this.svc.pickingLists(ctx.accountId); }

  @Get('picking/:id') @RequirePermission('stock', 'view')
  pickingList(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.svc.pickingList(ctx.accountId, id); }

  @Post('picking/item/:id/picked') @RequirePermission('stock', 'edit')
  markPicked(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { picked: boolean }) {
    return this.svc.markPicked(ctx.accountId, id, d.picked);
  }

  @Post('picking/:id/close') @RequirePermission('stock', 'edit')
  closePicking(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.svc.closePickingList(ctx.accountId, id);
  }
}

@Module({ controllers: [WarehousePlusController], providers: [WarehousePlusService, DbService] })
export class WarehousePlusModule {}
