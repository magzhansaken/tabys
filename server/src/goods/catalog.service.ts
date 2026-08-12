import { Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * КАТАЛОГ: фильтры, архив, упаковки, цены по точкам (подчасти 2.5–2.6).
 *
 * Набор фильтров взят у Wipon (он самый полный из троих) плюс смарт-фильтр
 * UMAG «код НКТ = нет» — именно он превращает заполнение НКТ из разгребания
 * двух тысяч строк в выполнимую задачу.
 *
 * Архив — модель МоегоСклада: «записи будут скрыты, но не удалены».
 * Упаковки — модель МоегоСклада: блок сигарет = 10 пачек.
 * Цены по точкам — бесплатно, в отличие от платного модуля прайс-листов Wipon.
 */
@Injectable()
export class CatalogService {
  constructor(private db: DbService) {}

  /** Фильтры каталога: объединение всех трёх конкурентов. */
  async filter(accountId: string, f: {
    q?: string; categoryId?: string; kind?: string; storeId?: string;
    noNtin?: boolean; hasNtin?: boolean; weightOnly?: boolean; marked?: boolean;
    priceFrom?: number; priceTo?: number; createdFrom?: string; changedFrom?: string;
    supplierId?: string; archived?: boolean; limit?: number; offset?: number;
  } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const w: string[] = ['p.deleted_at IS NULL'];
      const p: any[] = [];
      const add = (cond: string, val: any) => { p.push(val); w.push(cond.replace('$$', `$${p.length}`)); };

      // архив: по умолчанию показываем только живые (модель МС)
      w.push(f.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL');

      if (f.q) { p.push(f.q); const i = p.length;
        w.push(`(p.name ILIKE '%'||$${i}||'%' OR p.article = $${i} OR p.code::text = $${i}
                 OR EXISTS (SELECT 1 FROM barcode b WHERE b.product_id=p.id AND b.code=$${i}))`); }
      if (f.categoryId) add('p.category_id = $$', f.categoryId);
      if (f.kind) add('p.kind::text = $$', f.kind);
      if (f.supplierId) add('p.supplier_id = $$', f.supplierId);
      if (f.noNtin) w.push('p.ntin IS NULL');                    // смарт-фильтр UMAG
      if (f.hasNtin) w.push('p.ntin IS NOT NULL');               // «синхронизирован с НКТ» (Wipon)
      if (f.weightOnly) w.push(`p.kind = 'weight'`);             // вкладка «Весовые» (UMAG)
      if (f.marked) w.push(`p.marking <> 'none'`);
      if (f.createdFrom) add('p.created_at >= $$', f.createdFrom);
      if (f.changedFrom) add('p.updated_at >= $$', f.changedFrom); // «по последнему изменению» (Wipon)

      // цена: берём точку, если задана (цены по точкам — у Wipon это платный модуль)
      p.push(f.storeId ?? null); const si = p.length;
      const priceExpr = `(SELECT pp.value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                           WHERE pp.product_id=p.id AND pt.code='retail'
                             AND (pp.store_id = $${si} OR pp.store_id IS NULL)
                           ORDER BY pp.store_id NULLS LAST LIMIT 1)`;
      if (f.priceFrom != null) add(`${priceExpr} >= $$`, f.priceFrom);
      if (f.priceTo != null) add(`${priceExpr} <= $$`, f.priceTo);

      p.push(Math.min(f.limit ?? 50, 500)); const li = p.length;
      p.push(f.offset ?? 0); const oi = p.length;

      const { rows } = await c.query(
        `SELECT p.id, p.name, p.name_kk, p.kind, p.ntin, p.article, p.code, p.archived_at,
                p.category_id, cat.name AS category, p.purchase_price, p.marking,
                ${priceExpr} AS price,
                (SELECT code FROM barcode b WHERE b.product_id=p.id AND b.is_primary LIMIT 1) AS barcode,
                count(*) OVER() AS total_count
           FROM product p LEFT JOIN category cat ON cat.id = p.category_id
          WHERE ${w.join(' AND ')}
          ORDER BY p.name LIMIT $${li} OFFSET $${oi}`, p);

      return { total: rows.length ? Number(rows[0].total_count) : 0, items: rows.map(({ total_count, ...r }: any) => r) };
    });
  }

  /** Архив (модель МС): скрыть, но не удалять — на товар ссылаются продажи. */
  async archive(accountId: string, ids: string[], archive = true) {
    const { rows } = await this.db.raw(`SELECT * FROM archive_products($1,$2,$3)`, [accountId, ids, archive]);
    const blocked: string[] = rows[0].blocked_names ?? [];
    return {
      affected: rows[0].affected,
      blocked,
      message: blocked.length
        ? `Не отправлены в архив: ${blocked.join(', ')} — они входят в комплекты. Сначала уберите их из комплектов.`
        : archive ? `В архиве: ${rows[0].affected}` : `Восстановлено: ${rows[0].affected}`,
    };
  }

  // ==================================================================
  // УПАКОВКИ (МС): блок сигарет = 10 пачек. Приёмка блоками, продажа пачками.
  // Ни UMAG, ни Wipon этого не умеют, а сигареты и вода — половина оборота.
  // ==================================================================
  async addPackage(accountId: string, dto: { productId: string; name: string; quantity: number; barcode?: string; defaultPurchase?: boolean }) {
    if (!(dto.quantity > 0)) throw new BadRequestException('Количество в упаковке должно быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const pkg = (await c.query(
        `INSERT INTO package (account_id, product_id, name, quantity, is_default_purchase)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, name, quantity`,
        [accountId, dto.productId, dto.name, dto.quantity, dto.defaultPurchase ?? false])).rows[0];
      if (dto.barcode) {
        await c.query(
          `INSERT INTO barcode (account_id, product_id, package_id, code, type) VALUES ($1,$2,$3,$4,'ean13')
           ON CONFLICT (account_id, code) DO NOTHING`,
          [accountId, dto.productId, pkg.id, dto.barcode]);
      }
      return pkg;
    });
  }

  async packages(accountId: string, productId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT pk.id, pk.name, pk.quantity, pk.is_default_purchase,
                (SELECT code FROM barcode b WHERE b.package_id = pk.id LIMIT 1) AS barcode
           FROM package pk WHERE pk.product_id=$1 AND pk.deleted_at IS NULL ORDER BY pk.quantity`,
        [productId])).rows);
  }

  // ==================================================================
  // ЦЕНЫ ПО ТОЧКАМ. У Wipon это платный модуль «Прайслист»; у магазина с
  // двумя точками цены разные всегда — брать за это деньги нечестно.
  // ==================================================================
  async setPrice(accountId: string, dto: { productId: string; typeCode?: string; value: number; storeId?: string }) {
    if (dto.value < 0) throw new BadRequestException('Цена не может быть отрицательной');
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`SELECT ensure_price_types($1)`, [accountId]);
      const t = (await c.query(`SELECT id FROM price_type WHERE code=$1 LIMIT 1`, [dto.typeCode ?? 'retail'])).rows[0];
      if (!t) throw new BadRequestException('Тип цены не найден');

      // минимальная цена (МС): защита от продажи в убыток
      const min = (await c.query(`SELECT min_price, name FROM product WHERE id=$1`, [dto.productId])).rows[0];
      if (min?.min_price != null && dto.value < Number(min.min_price) && (dto.typeCode ?? 'retail') === 'retail')
        throw new BadRequestException(`Цена ниже минимальной (${min.min_price} ₸) для «${min.name}»`);

      const { rows } = await c.query(
        `INSERT INTO product_price (account_id, product_id, price_type_id, store_id, value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (product_id, price_type_id, store_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
         RETURNING id, value`,
        [accountId, dto.productId, t.id, dto.storeId ?? null, dto.value]);
      return rows[0];
    });
  }

  /** Все цены товара: по типам и точкам — то, что Wipon зовёт прайс-листом. */
  async prices(accountId: string, productId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT pt.code, pt.name AS type_name, pp.store_id, s.name AS store, pp.value
           FROM product_price pp
           JOIN price_type pt ON pt.id = pp.price_type_id
           LEFT JOIN store s ON s.id = pp.store_id
          WHERE pp.product_id=$1 ORDER BY pt.sort_order, s.name NULLS FIRST`, [productId])).rows);
  }

  /** Цена для конкретной точки: своя, иначе общая. */
  async priceFor(accountId: string, productId: string, storeId?: string, typeCode = 'retail') {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT pp.value, pp.store_id FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
          WHERE pp.product_id=$1 AND pt.code=$2 AND (pp.store_id=$3 OR pp.store_id IS NULL)
          ORDER BY pp.store_id NULLS LAST LIMIT 1`, [productId, typeCode, storeId ?? null]);
      return rows[0] ? { value: Number(rows[0].value), fromStore: !!rows[0].store_id } : null;
    });
  }
}
