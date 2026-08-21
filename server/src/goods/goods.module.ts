import { Controller, Post, Get, Patch, Body, Query, Param, Module, BadRequestException } from '@nestjs/common';
import { IsString, IsOptional, IsIn, IsNumber, IsArray, Length, Matches } from 'class-validator';
import { GoodsService } from './goods.service';
import { DbService } from '../db/db.service';
import { AuthModule } from '../auth/auth.module';
import { RequirePermission, Ctx, Dev, Public } from '../auth/guards';
import { UseGuards } from '@nestjs/common';
import { DeviceGuard } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';

class CreateProductDto {
  @Length(1, 200) name: string;
  @IsOptional() @IsIn(['simple','weight','service','bundle']) kind?: string;
  @IsOptional() @IsString() nameKk?: string;
  @IsOptional() @IsString() unitId?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsNumber() purchasePrice?: number;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() minPrice?: number;
  @IsOptional() @IsNumber() markupPercent?: number;
  @IsOptional() @Matches(/^\d{8,14}$/, { message: 'NTIN — от 8 до 14 цифр' }) ntin?: string;
  @IsOptional() @IsNumber() pluCode?: number;
  @IsOptional() @IsString() article?: string;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsIn(['none','tobacco','shoes','pharma','alcohol','beer','other']) marking?: string;
  @IsOptional() isQuick?: boolean;
  @IsOptional() @IsString() quickGroup?: string;
}
class AssignNtinDto {
  @IsArray() productIds: string[];
  @Matches(/^\d{8,14}$/) ntin: string;
  @IsOptional() force?: boolean;
}
class VariantsDto { @IsArray() attributes: { name: string; values: string[] }[]; }
class BundleDto { @IsArray() items: { productId: string; qty: number; unit?: string }[]; @IsOptional() @IsNumber() extraCost?: number; @IsOptional() @IsIn(['kit','recipe']) mode?: 'kit'|'recipe'; @IsOptional() @IsNumber() yield?: number; }
class PriceDto { @IsString() typeCode: string; @IsNumber() value: number; @IsOptional() @IsString() storeId?: string; }
class CategoryDto {
  @Length(1, 120) name: string;
  @IsOptional() @IsString() nameKk?: string;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsNumber() markupPercent?: number;
}

// =====================================================================
// ТОВАРЫ В КАБИНЕТЕ
// =====================================================================
@Controller('goods')
export class GoodsController {
  constructor(private goods: GoodsService) {}

  @Post() @RequirePermission('goods', 'create')
  create(@Ctx() ctx: EmployeeContext, @Body() d: CreateProductDto) { return this.goods.create(ctx.accountId, d); }

  @Get() @RequirePermission('goods', 'view')
  search(@Ctx() ctx: EmployeeContext, @Query('q') q = '', @Query('categoryId') categoryId?: string,
         @Query('kind') kind?: string, @Query('noNtin') noNtin?: string, @Query('limit') limit?: string) {
    return this.goods.search(ctx.accountId, q, { categoryId, kind, noNtin: noNtin === 'true', limit: limit ? +limit : undefined });
  }

  @Get('ntin/stats') @RequirePermission('goods', 'view')
  ntinStats(@Ctx() ctx: EmployeeContext) { return this.goods.ntinStats(ctx.accountId); }

  /** Массовое присвоение кода НКТ (модель UMAG) */
  @Post('ntin/assign') @RequirePermission('goods', 'edit')
  assignNtin(@Ctx() ctx: EmployeeContext, @Body() d: AssignNtinDto) {
    return this.goods.assignNtin(ctx.accountId, d.productIds, d.ntin, d.force ?? false);
  }

  /** Агрегированный код НКТ на категорию — для товаров без заводского штрихкода */
  @Post('ntin/category/:id') @RequirePermission('goods', 'edit')
  assignNtinCat(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { ntin: string; onlyEmpty?: boolean }) {
    return this.goods.assignNtinByCategory(ctx.accountId, id, d.ntin, d.onlyEmpty ?? true);
  }

  @Get('plu') @RequirePermission('goods', 'view')
  plu(@Ctx() ctx: EmployeeContext) { return this.goods.pluExport(ctx.accountId); }

  /* ВЫДАТЬ ШТРИХКОД — кнопка «+» в карточке товара.
     У товара без кода сканер бесполезен, и кассир ищет его руками при
     очереди. Код выдаёт система: вписанный от руки столкнётся с
     чужим товаром. */
  @Post(':id/barcode') @RequirePermission('goods', 'edit')
  issueBarcode(@Ctx() ctx: any, @Param('id') id: string) {
    return this.goods.issueBarcode(ctx.accountId, id);
  }

  @Post('plu/assign') @RequirePermission('goods', 'edit')
  assignPlu(@Ctx() ctx: EmployeeContext) { return this.goods.assignPlu(ctx.accountId); }

  @Get('categories') @RequirePermission('goods', 'view')
  categories(@Ctx() ctx: EmployeeContext) { return this.goods.categories(ctx.accountId); }

  @Post('categories') @RequirePermission('goods', 'create')
  createCategory(@Ctx() ctx: EmployeeContext, @Body() d: CategoryDto) { return this.goods.createCategory(ctx.accountId, d); }

  @Get(':id') @RequirePermission('goods', 'view')
  get(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.goods.get(ctx.accountId, id); }

  @Post(':id/variants') @RequirePermission('goods', 'create')
  variants(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: VariantsDto) {
    return this.goods.createVariants(ctx.accountId, id, d.attributes);
  }

  @Post(':id/bundle') @RequirePermission('goods', 'edit')
  bundle(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: BundleDto) {
    return this.goods.setBundle(ctx.accountId, id, d.items, d.extraCost, { mode: d.mode, yield: d.yield });
  }

  /** Список артикулов со сводкой (модель UMAG: раздел «Артикулы»). */
  @Get('articles/list') @RequirePermission('goods', 'view')
  articles(@Ctx() ctx: EmployeeContext) { return this.goods.articles(ctx.accountId); }

  /** Массовое присвоение артикула выбранным товарам. */
  @Post('articles/bulk') @RequirePermission('goods', 'edit')
  bulkArticle(@Ctx() ctx: EmployeeContext, @Body() d: any) { return this.goods.bulkSetArticle(ctx.accountId, d); }

  @Get(':id/recipe-cost') @RequirePermission('goods', 'view')
  recipeCost(@Ctx() ctx: EmployeeContext, @Param('id') id: string) {
    return this.goods.recipeCost(ctx.accountId, id);
  }

  @Patch(':id/price') @RequirePermission('goods', 'edit')
  price(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: PriceDto) {
    return this.goods.updatePrice(ctx.accountId, id, d.typeCode, d.value, d.storeId);
  }

  @Post(':id/archive') @RequirePermission('goods', 'delete')
  archive(@Ctx() ctx: EmployeeContext, @Param('id') id: string) { return this.goods.archive(ctx.accountId, id); }
}

// =====================================================================
// ТОВАРЫ НА КАССЕ (по токену устройства)
// =====================================================================
@Controller('pos/goods')
export class PosGoodsController {
  constructor(private goods: GoodsService) {}

  @Public() @UseGuards(DeviceGuard) @Get('search')
  search(@Dev() dev: any, @Query('q') q = '') { return this.goods.search(dev.account_id, q, { limit: 30 }); }

  /** Полный снимок каталога при привязке: дальше касса живёт дельтами sync/pull */
  @Public() @UseGuards(DeviceGuard) @Get('catalog')
  catalog(@Dev() dev: any) { return this.goods.posCatalog(dev.account_id, dev.store_id); }

  /** Сканер: обычный штрихкод или весовой (вес достаётся из кода) */
  @Public() @UseGuards(DeviceGuard) @Get('scan')
  scan(@Dev() dev: any, @Query('code') code: string) { return this.goods.scan(dev.account_id, code); }
}


// =====================================================================
// ПОКУПАТЕЛИ ДЛЯ КАССЫ (часть 17). Снимок при привязке — как каталог
// товаров: выбор покупателя, долг и лимит должны работать ОФЛАЙН.
// Свежий баланс (долг/бонусы) касса спрашивает онлайн перед оплатой,
// если сеть есть; без сети действует локальный снимок + лимит.
// =====================================================================
@Controller('pos/customers')
export class PosCustomersController {
  constructor(private db: DbService) {}

  /** Полный снимок покупателей + serverSeq (дельты 'customer' — из /sync/pull) */
  @Public() @UseGuards(DeviceGuard) @Get('catalog')
  catalog(@Dev() dev: any) {
    return this.db.withTenant(dev.account_id, async (c) => {
      const { rows: customers } = await c.query(
        `SELECT cp.id, cp.name, cp.phone, cp.iin_bin, cp.loyalty_card,
                cp.debt_limit, cp.debt_days,
                coalesce(cb.balance, 0)  AS debt,
                coalesce(bb.balance, 0)  AS bonuses
           FROM counterparty cp
           LEFT JOIN counterparty_balance cb ON cb.counterparty_id = cp.id
           LEFT JOIN bonus_balance bb ON bb.counterparty_id = cp.id
          WHERE cp.deleted_at IS NULL AND cp.is_customer
          ORDER BY cp.name`);
      const head = (await c.query(`SELECT coalesce(max(seq),0)::bigint AS s FROM oplog`)).rows[0].s;
      return { customers, serverSeq: Number(head), snapshotAt: new Date().toISOString() };
    });
  }

  /** Свежий баланс одного покупателя — касса зовёт перед «в долг»/«бонусами» */
  @Public() @UseGuards(DeviceGuard) @Get(':id')
  one(@Dev() dev: any, @Param('id') id: string) {
    return this.db.withTenant(dev.account_id, async (c) => {
      const r = (await c.query(
        `SELECT cp.id, cp.name, cp.debt_limit,
                coalesce(cb.balance,0) AS debt, coalesce(bb.balance,0) AS bonuses
           FROM counterparty cp
           LEFT JOIN counterparty_balance cb ON cb.counterparty_id = cp.id
           LEFT JOIN bonus_balance bb ON bb.counterparty_id = cp.id
          WHERE cp.id=$1 AND cp.deleted_at IS NULL`, [id])).rows[0];
      if (!r) throw new BadRequestException('Покупатель не найден');
      return { ...r, debt: Number(r.debt), bonuses: Number(r.bonuses),
               debt_limit: r.debt_limit == null ? null : Number(r.debt_limit) };
    });
  }
}

@Module({
  imports: [AuthModule],
  controllers: [GoodsController, PosGoodsController, PosCustomersController],
  providers: [GoodsService, DbService],
  exports: [GoodsService],
})
export class GoodsModule {}
