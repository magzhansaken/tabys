import { randomUUID } from 'crypto';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';

/**
 * НОМЕНКЛАТУРА.
 *
 * Ключевые отличия от конкурентов заложены здесь:
 *  - штрихкод не обязателен при создании (UMAG и Wipon требуют — но у носков
 *    с барахолки его нет), внутренний генерируется сам;
 *  - NTIN по модели UMAG: массовое присвоение, фильтр «без кода»,
 *    агрегированный код на категорию;
 *  - наценка наследуется от категории (находка UMAG);
 *  - вариант наследует поля родителя (модель МС), а не копирует их (UMAG).
 */
@Injectable()
export class GoodsService {
  constructor(private db: DbService) {}

  // ==================================================================
  // СОЗДАНИЕ ТОВАРА
  // ==================================================================
  async create(accountId: string, dto: {
    name: string; kind?: string; unitId?: string; categoryId?: string;
    barcode?: string; purchasePrice?: number; salePrice?: number; markupPercent?: number;
    ntin?: string; pluCode?: number; article?: string; minStock?: number;
    marking?: string; isQuick?: boolean; quickGroup?: string; minPrice?: number;
    nameKk?: string; generateBarcode?: boolean;
  }) {
    if (!dto.name?.trim()) throw new BadRequestException('Название обязательно');

    return this.db.withTenant(accountId, async (c) => {
      await this.ensureSettings(c, accountId);

      // короткий код нужен для весового штрихкода (5 цифр) и быстрого ввода
      const code = (await c.query(
        `UPDATE goods_settings SET next_code = next_code + 1 WHERE account_id=$1 RETURNING next_code - 1 AS code`,
        [accountId])).rows[0].code;

      const unitId = dto.unitId ?? (await c.query(
        `SELECT id FROM unit WHERE account_id IS NULL AND short_name = $1 LIMIT 1`,
        [dto.kind === 'weight' ? 'кг' : 'шт'])).rows[0]?.id;

      const p = (await c.query(
        `INSERT INTO product (account_id, kind, code, name, name_kk, category_id, unit_id, article,
                              purchase_price, min_price, markup_percent, ntin, ntin_source, plu_code,
                              min_stock, marking, is_quick, quick_group, track_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [accountId, dto.kind ?? 'simple', code, dto.name.trim(), dto.nameKk ?? null,
         dto.categoryId ?? null, unitId ?? null, dto.article ?? null,
         dto.purchasePrice ?? null, dto.minPrice ?? null, dto.markupPercent ?? null,
         dto.ntin ?? null, dto.ntin ? 'manual' : null, dto.pluCode ?? null,
         dto.minStock ?? null, dto.marking ?? 'none', dto.isQuick ?? false, dto.quickGroup ?? null,
         (dto.kind ?? 'simple') !== 'service'])).rows[0];

      // штрихкод: свой или сгенерированный. Продавец не должен ничего выдумывать.
      if (dto.barcode) {
        await this.addBarcode(c, accountId, p.id, dto.barcode, undefined, true);
      } else if (dto.generateBarcode !== false) {
        const gen = (await c.query(`SELECT gen_internal_barcode($1,$2) AS bc`, [accountId, code])).rows[0].bc;
        await this.addBarcode(c, accountId, p.id, gen, 'internal', true);
      }

      // цена: явная или посчитанная от наценки категории (находка UMAG)
      const price = dto.salePrice ?? await this.priceFromMarkup(c, p.id, dto.purchasePrice);
      if (price != null) await this.setPrice(c, accountId, p.id, 'retail', price);

      // Событие в oplog той же транзакцией (часть 16): кассы узнают о новом
      // товаре через /sync/pull. Кабинет пишет в таблицы напрямую, поэтому
      // журнал надо кормить явно — иначе дельт для устройств не существует.
      await this.emitToDevices(c, accountId, 'product', p.id, 'insert', {
        name: p.name, kind: p.kind, price: price ?? 0,
        cost: p.purchase_price != null ? Number(p.purchase_price) : 0,
        minPrice: p.min_price != null ? Number(p.min_price) : null,
        vatRate: p.vat_rate != null ? Number(p.vat_rate) : null,
        ntin: p.ntin, trackStock: p.track_stock,
      });

      return this.getOne(c, accountId, p.id);
    });
  }

  /**
   * Регистрация кабинетного изменения в журнале синхронизации.
   * Только регистрирует (данные уже записаны выше по транзакции) и помечает
   * применённым. WebSocket-толчок придёт со следующим событием или по
   * таймеру кассы (30 с) — для правки цены это достаточно быстро.
   */
  private async emitToDevices(c: PoolClient, accountId: string, entity: string, entityId: string, op: string, payload: Record<string, any>) {
    // Прямой INSERT: sync_push_event рассчитан на устройства (ведёт их курсор),
    // а у кабинетного события устройства нет.
    await c.query(
      `INSERT INTO oplog (id, account_id, entity, entity_id, op, payload, client_ts, applied_at)
       VALUES ($1,$2,$3,$4,$5::oplog_op,$6,now(),now()) ON CONFLICT (id) DO NOTHING`,
      [randomUUID(), accountId, entity, entityId, op, JSON.stringify(payload)]);
  }

  private async ensureSettings(c: PoolClient, accountId: string) {
    await c.query(`INSERT INTO goods_settings (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [accountId]);
    await c.query(
      `INSERT INTO price_type (account_id, name, code, is_default, sort_order)
       VALUES ($1,'Розничная','retail',true,0), ($1,'Оптовая','wholesale',false,1)
       ON CONFLICT (account_id, code) DO NOTHING`, [accountId]);
  }

  /** Цена = закупка + наценка категории. Для 3000 позиций это недели работы. */
  private async priceFromMarkup(c: PoolClient, productId: string, purchase?: number) {
    if (purchase == null) return null;
    const m = (await c.query(`SELECT effective_markup($1) AS m`, [productId])).rows[0].m;
    if (m == null) return null;
    return Math.round(purchase * (1 + Number(m) / 100) * 100) / 100;
  }

  private async addBarcode(c: PoolClient, accountId: string, productId: string, code: string, type?: string, primary = false) {
    const t = type ?? (/^\d{13}$/.test(code) ? 'ean13' : /^\d{8}$/.test(code) ? 'ean8' : 'code128');
    await c.query(
      `INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, code) DO NOTHING`, [accountId, productId, code.trim(), t, primary]);
  }

  /**
   * ВЫДАТЬ ШТРИХКОД УЖЕ ЗАВЕДЁННОМУ ТОВАРУ.
   *
   * При создании код выдаётся сам. А у товара, который завели раньше —
   * ввезли из таблицы, перенесли из старой системы, завели наспех —
   * кода может не быть вовсе. Сканером его не пробить, и кассир ищет
   * руками при очереди.
   *
   * Вписывать выдуманный код нельзя: он столкнётся с чужим товаром.
   * Свой код магазина начинается с двойки — эта область отведена под
   * внутренние коды и не пересекается с заводскими.
   */
  async issueBarcode(accountId: string, productId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const p = (await c.query(
        `SELECT id, name, code FROM product
          WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
        [productId, accountId])).rows[0];

      if (!p) throw new BadRequestException('Товар не найден');

      /* УЖЕ ЕСТЬ — НЕ ВЫДАЁМ ВТОРОЙ. Иначе на товаре окажутся два
         кода: наклеили один, а в базе главный другой, и при возврате
         товар не опознается. */
      const есть = (await c.query(
        `SELECT code FROM barcode WHERE product_id = $1 ORDER BY is_primary DESC LIMIT 1`,
        [productId])).rows[0];

      if (есть) {
        return { code: есть.code, created: false,
          note: 'У товара уже есть штрихкод' };
      }

      const gen = (await c.query(
        `SELECT gen_internal_barcode($1,$2) AS bc`, [accountId, p.code])).rows[0].bc;

      await this.addBarcode(c, accountId, productId, gen, 'internal', true);

      /* Кассы узнают о коде через обмен: без этого товар не пробьётся
         сканером, пока касса не перезапустится. */
      await this.emitToDevices(c, accountId, 'barcode', productId, 'insert',
        { productId, code: gen });

      return { code: gen, created: true, productName: p.name };
    });
  }

  private async setPrice(c: PoolClient, accountId: string, productId: string, typeCode: string, value: number, storeId?: string) {
    const pt = (await c.query(`SELECT id FROM price_type WHERE code=$1 LIMIT 1`, [typeCode])).rows[0];
    if (!pt) throw new BadRequestException(`Нет типа цены ${typeCode}`);
    await c.query(
      `INSERT INTO product_price (account_id, product_id, price_type_id, store_id, value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_id, price_type_id, store_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now(), seq = nextval('global_seq')`,
      [accountId, productId, pt.id, storeId ?? null, value]);
  }

  async updatePrice(accountId: string, productId: string, typeCode: string, value: number, storeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      await this.setPrice(c, accountId, productId, typeCode, value, storeId);
      // касса узнаёт новую цену дельтой, а не переснимком каталога
      if (typeCode === 'retail') {
        await this.emitToDevices(c, accountId, 'price', productId, 'update', { productId, value });
      }
      return { ok: true };
    });
  }

  private async getOne(c: PoolClient, accountId: string, id: string) {
    const p = (await c.query(`SELECT * FROM product WHERE id=$1`, [id])).rows[0];
    if (!p) throw new NotFoundException('Товар не найден');
    p.barcodes = (await c.query(`SELECT code, type, is_primary, pack_qty, pack_name FROM barcode WHERE product_id=$1`, [id])).rows;
    p.prices = (await c.query(
      `SELECT pt.code, pt.name, pp.value, pp.store_id FROM product_price pp
         JOIN price_type pt ON pt.id = pp.price_type_id WHERE pp.product_id=$1`, [id])).rows;
    return p;
  }

  async get(accountId: string, id: string) {
    return this.db.withTenant(accountId, (c) => this.getOne(c, accountId, id));
  }

  // ==================================================================
  // ПОИСК: по названию, штрихкоду, коду, артикулу.
  // Кассир вводит «молок» — должен найти «Молоко Простоквашино 2.5%».
  // ==================================================================
  async search(accountId: string, q: string, opts: { categoryId?: string; kind?: string; noNtin?: boolean; limit?: number } = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const where: string[] = ['p.deleted_at IS NULL'];
      const args: any[] = [];
      if (q?.trim()) {
        args.push(`%${q.trim()}%`, q.trim());
        where.push(`(p.name ILIKE $${args.length - 1} OR p.article ILIKE $${args.length - 1}
                     OR EXISTS (SELECT 1 FROM barcode b WHERE b.product_id = p.id AND b.code = $${args.length})
                     OR p.code::text = $${args.length})`);
      }
      if (opts.categoryId) { args.push(opts.categoryId); where.push(`p.category_id = $${args.length}`); }
      if (opts.kind) { args.push(opts.kind); where.push(`p.kind = $${args.length}`); }
      // фильтр «код НКТ = нет» — прямо как у UMAG: показать, что дозаполнить
      if (opts.noNtin) where.push(`p.ntin IS NULL`);
      args.push(Math.min(opts.limit ?? 50, 200));

      const { rows } = await c.query(
        `SELECT p.id, p.code, p.name, p.kind, p.ntin, p.plu_code, p.article,
                c.name AS category, u.short_name AS unit,
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                  WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL) AS price,
                (SELECT code FROM barcode b WHERE b.product_id=p.id AND b.is_primary LIMIT 1) AS barcode
           FROM product p
           LEFT JOIN category c ON c.id = p.category_id
           LEFT JOIN unit u ON u.id = p.unit_id
          WHERE ${where.join(' AND ')}
          ORDER BY p.name LIMIT $${args.length}`, args);
      return rows;
    });
  }

  /**
   * Поиск по сканеру: обычный штрихкод или весовой.
   * Весы печатают код после взвешивания — касса обязана достать из него
   * и товар, и вес, иначе кассир вбивает вес руками и ошибается.
   */
  async scan(accountId: string, code: string) {
    return this.db.withTenant(accountId, async (c) => {
      // Упаковка (модель МС): у блока сигарет свой штрихкод. Сканируешь блок —
      // должно прийти 10 пачек, а не одна. Без учёта package_id приёмка блоками
      // считала бы штуками, и остаток врал бы в десять раз.
      const direct = (await c.query(
        `SELECT p.*, b.pack_qty, b.package_id, pk.name AS package_name, pk.quantity AS package_qty
           FROM barcode b
           JOIN product p ON p.id = b.product_id
           LEFT JOIN package pk ON pk.id = b.package_id AND pk.deleted_at IS NULL
          WHERE b.code = $1 AND p.deleted_at IS NULL`, [code.trim()])).rows[0];
      if (direct) {
        const qty = Number(direct.package_qty ?? direct.pack_qty ?? 1);
        return {
          found: true, product: direct, qty,
          package: direct.package_id ? { id: direct.package_id, name: direct.package_name, quantity: qty } : null,
          source: direct.package_id ? 'package' : 'barcode',
        };
      }

      const w = (await c.query(`SELECT * FROM parse_weight_barcode($1,$2)`, [accountId, code.trim()])).rows[0];
      if (w) return { found: true, product: { id: w.product_id, name: w.product_name }, qty: Number(w.qty), source: 'weight_barcode' };

      return { found: false };
    });
  }

  // ==================================================================
  // КОДЫ НКТ (NTIN) — казахстанская обязаловка. Модель UMAG целиком.
  // ==================================================================

  /** Сколько позиций без кода — чтобы клиент узнал об этом не от кассира на кассе. */
  async ntinStats(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const r = (await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ntin IS NULL)::int AS without_ntin,
                count(*) FILTER (WHERE ntin IS NULL AND kind = 'weight')::int AS weight_without_ntin
           FROM product WHERE deleted_at IS NULL AND kind <> 'service'`)).rows[0];
      return { ...r, ready: r.without_ntin === 0 };
    });
  }

  /**
   * Массовое присвоение NTIN (UMAG: выделил → «Присвоить код НКТ»).
   * Предупреждение о перезаписи — тоже их находка: «У Х из Y товаров уже
   * указан код — он будет перезаписан».
   */
  async assignNtin(accountId: string, productIds: string[], ntin: string, force = false) {
    if (!/^\d{8,14}$/.test(ntin)) throw new BadRequestException('NTIN — от 8 до 14 цифр');
    return this.db.withTenant(accountId, async (c) => {
      const existing = (await c.query(
        `SELECT count(*)::int AS n FROM product WHERE id = ANY($1) AND ntin IS NOT NULL AND ntin <> $2`,
        [productIds, ntin])).rows[0].n;

      if (existing > 0 && !force) {
        return { needConfirm: true, willOverwrite: existing, total: productIds.length,
                 message: `У ${existing} из ${productIds.length} товаров уже указан код НКТ — он будет перезаписан` };
      }

      const r = await c.query(
        `UPDATE product SET ntin=$2, ntin_source='manual', ntin_checked_at=now()
          WHERE id = ANY($1) AND deleted_at IS NULL`, [productIds, ntin]);
      return { updated: r.rowCount, overwritten: existing };
    });
  }

  /**
   * Агрегированный код НКТ на категорию (UMAG): для товаров без заводского
   * штрихкода — носки, игрушки с барахолки — берётся один общий код на группу.
   */
  async assignNtinByCategory(accountId: string, categoryId: string, ntin: string, onlyEmpty = true) {
    if (!/^\d{8,14}$/.test(ntin)) throw new BadRequestException('NTIN — от 8 до 14 цифр');
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE category SET ntin_aggregate=$2 WHERE id=$1`, [categoryId, ntin]);
      const r = await c.query(
        `UPDATE product SET ntin=$2, ntin_source='category_aggregate', ntin_checked_at=now()
          WHERE category_id=$1 AND deleted_at IS NULL AND kind <> 'service'
            AND ($3::boolean = false OR ntin IS NULL)`, [categoryId, ntin, onlyEmpty]);
      return { updated: r.rowCount };
    });
  }

  // ==================================================================
  // ТОВАРНАЯ СЕТКА (мастер UMAG + наследование МС).
  // У UMAG сетка порождает независимые товары: поменял название родителя —
  // иди правь тридцать штук. У нас вариант берёт всё у родителя.
  // ==================================================================
  /**
   * МАССОВОЕ ПРИСВОЕНИЕ АРТИКУЛОВ (модель UMAG, раздел «Артикулы»).
   *
   * У них артикул — общий признак группы товаров: одна модель, разные
   * цвета и размеры. Присваивать его каждому товару вручную при сотне
   * позиций — работа на вечер, и её никто не делает. Отсюда каталоги, где
   * артикул заполнен у трёх товаров из двухсот.
   *
   * Два способа сразу:
   *   · задать один артикул выбранным товарам;
   *   · сгенерировать по образцу с номером: ФУТБ-001, ФУТБ-002 …
   *
   * Уже заполненные не перетираем без явного разрешения: артикул часто
   * приходит от поставщика, и затереть его пакетной операцией — потерять
   * связь с его прайсом.
   */
  async bulkSetArticle(accountId: string, dto: {
    productIds: string[]; article?: string; pattern?: string; startFrom?: number; overwrite?: boolean;
  }) {
    if (!dto.productIds?.length) throw new BadRequestException('Выберите товары');
    if (!dto.article && !dto.pattern) throw new BadRequestException('Укажите артикул или образец');

    return this.db.withTenant(accountId, async (c) => {
      let n = 0, skipped = 0;
      let counter = dto.startFrom ?? 1;

      for (const id of dto.productIds) {
        const cur = (await c.query(`SELECT article FROM product WHERE id=$1`, [id])).rows[0];
        if (!cur) continue;
        if (cur.article && !dto.overwrite) { skipped++; continue; }

        // Образец: «ФУТБ-{n}» → ФУТБ-001. Номер дополняем нулями до трёх
        // знаков, чтобы сортировка в списке шла по-человечески: 001, 002,
        // 010 — а не 1, 10, 2.
        const value = dto.pattern
          ? dto.pattern.replace('{n}', String(counter++).padStart(3, '0'))
          : dto.article!;
        await c.query(`UPDATE product SET article=$2 WHERE id=$1`, [id, value]);
        n++;
      }
      return { updated: n, skipped,
        hint: skipped ? `${skipped} товаров пропущено: артикул уже был. Чтобы перезаписать, включите замену` : undefined };
    });
  }

  /** Список артикулов со сводкой: сколько товаров в каждом. */
  async articles(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT p.article, count(*)::int AS products,
                coalesce(sum(b.qty), 0) AS qty
           FROM product p
           LEFT JOIN stock_balance b ON b.product_id = p.id
          WHERE p.account_id = $1 AND p.deleted_at IS NULL AND p.article IS NOT NULL
          GROUP BY p.article ORDER BY p.article`, [accountId])).rows
        .map((r: any) => ({ article: r.article, products: r.products, qty: Number(r.qty) })));
  }

  async createVariants(accountId: string, parentId: string, attrs: { name: string; values: string[] }[]) {
    if (!attrs.length) throw new BadRequestException('Нужна хотя бы одна характеристика');
    return this.db.withTenant(accountId, async (c) => {
      const parent = (await c.query(`SELECT * FROM product WHERE id=$1`, [parentId])).rows[0];
      if (!parent) throw new NotFoundException('Родительский товар не найден');
      await c.query(`UPDATE product SET kind='variant_parent', track_stock=false WHERE id=$1`, [parentId]);

      // характеристики и значения живут в справочнике и переиспользуются (модель МС)
      const prepared: { attrId: string; values: { id: string; value: string }[] }[] = [];
      for (const a of attrs) {
        const attr = (await c.query(
          `INSERT INTO attribute (account_id, name) VALUES ($1,$2)
           ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [accountId, a.name])).rows[0];
        const vals: { id: string; value: string }[] = [];
        for (const v of a.values) {
          const val = (await c.query(
            `INSERT INTO attribute_value (account_id, attribute_id, value) VALUES ($1,$2,$3)
             ON CONFLICT (attribute_id, value) DO UPDATE SET value = EXCLUDED.value RETURNING id, value`,
            [accountId, attr.id, v])).rows[0];
          vals.push(val);
        }
        prepared.push({ attrId: attr.id, values: vals });
      }

      // пересечение всех характеристик: 2 размера × 2 цвета = 4 варианта
      let combos: { attrId: string; valId: string; value: string }[][] = [[]];
      for (const p of prepared) {
        const next: typeof combos = [];
        for (const combo of combos)
          for (const v of p.values) next.push([...combo, { attrId: p.attrId, valId: v.id, value: v.value }]);
        combos = next;
      }

      const created: any[] = [];
      for (const combo of combos) {
        const code = (await c.query(
          `UPDATE goods_settings SET next_code = next_code + 1 WHERE account_id=$1 RETURNING next_code - 1 AS code`,
          [accountId])).rows[0].code;
        const suffix = combo.map((x) => x.value).join(' / ');
        const v = (await c.query(
          `INSERT INTO product (account_id, kind, parent_id, code, name, category_id, unit_id,
                                article, purchase_price, markup_percent, ntin, marking)
           VALUES ($1,'simple',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, code`,
          [accountId, parentId, code, `${parent.name} (${suffix})`, parent.category_id, parent.unit_id,
           parent.article, parent.purchase_price, parent.markup_percent, parent.ntin, parent.marking])).rows[0];

        for (const x of combo)
          await c.query(
            `INSERT INTO product_attribute (product_id, attribute_id, value_id, account_id) VALUES ($1,$2,$3,$4)`,
            [v.id, x.attrId, x.valId, accountId]);

        const bc = (await c.query(`SELECT gen_internal_barcode($1,$2) AS bc`, [accountId, v.code])).rows[0].bc;
        await this.addBarcode(c, accountId, v.id, bc, 'internal', true);
        created.push({ id: v.id, name: v.name, barcode: bc });
      }
      return { parentId, created: created.length, variants: created };
    });
  }

  // ==================================================================
  // КОМПЛЕКТ: продаётся как целое, списываются компоненты (модель МС/UMAG).
  // ==================================================================
  async setBundle(accountId: string, bundleId: string, items: { productId: string; qty: number; unit?: string }[],
                  extraCost?: number, opts?: { mode?: 'kit' | 'recipe'; yield?: number }) {
    return this.db.withTenant(accountId, async (c) => {
      const mode = opts?.mode ?? 'kit';
      const recipeYield = opts?.yield ?? 1;
      await c.query(`UPDATE product SET kind='bundle', bundle_extra_cost=$2, bundle_mode=$3, recipe_yield=$4 WHERE id=$1`,
        [bundleId, extraCost ?? null, mode, recipeYield]);
      await c.query(`DELETE FROM bundle_item WHERE bundle_id=$1`, [bundleId]);
      for (const i of items) {
        if (i.productId === bundleId) throw new BadRequestException('Комплект не может включать сам себя');
        await c.query(
          `INSERT INTO bundle_item (account_id, bundle_id, component_id, qty, unit) VALUES ($1,$2,$3,$4,$5)`,
          [accountId, bundleId, i.productId, i.qty, i.unit ?? null]);
      }
      // себестоимость: для набора (kit) — сумма закупочных; для рецепта (recipe) —
      // через recipe_cost (учитывает выход и последнюю закупку ингредиента)
      let total: number;
      if (mode === 'recipe') {
        total = Number((await c.query(`SELECT recipe_cost($1,$2) AS c`, [accountId, bundleId])).rows[0].c);
      } else {
        const cost = (await c.query(
          `SELECT coalesce(sum(p.purchase_price * bi.qty), 0) AS c FROM bundle_item bi
             JOIN product p ON p.id = bi.component_id WHERE bi.bundle_id=$1`, [bundleId])).rows[0].c;
        total = Number(cost) + Number(extraCost ?? 0);
      }
      await c.query(`UPDATE product SET purchase_price=$2 WHERE id=$1`, [bundleId, total]);
      return { bundleId, components: items.length, cost: total, mode, yield: recipeYield };
    });
  }

  /** Себестоимость рецепта (техкарты) — для карточки и отчётов. */
  async recipeCost(accountId: string, bundleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cost = Number((await c.query(`SELECT recipe_cost($1,$2) AS c`, [accountId, bundleId])).rows[0].c);
      const comps = (await c.query(
        `SELECT bi.qty, bi.unit, p.name, p.purchase_price FROM bundle_item bi
           JOIN product p ON p.id = bi.component_id WHERE bi.bundle_id=$1 ORDER BY p.name`, [bundleId])).rows;
      const prod = (await c.query(`SELECT recipe_yield, bundle_mode FROM product WHERE id=$1`, [bundleId])).rows[0];
      return {
        cost, yield: Number(prod?.recipe_yield ?? 1), mode: prod?.bundle_mode,
        components: comps.map((r: any) => ({ name: r.name, qty: Number(r.qty), unit: r.unit,
          purchasePrice: r.purchase_price != null ? Number(r.purchase_price) : null })),
      };
    });
  }

  // ==================================================================
  // ВЫГРУЗКА PLU НА ВЕСЫ (модель Wipon: PLU, наименование, штрихкод, цена)
  // ==================================================================
  async pluExport(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.plu_code, p.name,
                (SELECT code FROM barcode b WHERE b.product_id=p.id AND b.is_primary LIMIT 1) AS barcode,
                (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                  WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL) AS price
           FROM product p
          WHERE p.kind='weight' AND p.plu_code IS NOT NULL AND p.deleted_at IS NULL
          ORDER BY p.plu_code`);
      return rows;
    });
  }

  /** Присвоить PLU весовым товарам, у которых его нет. */
  async assignPlu(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      await this.ensureSettings(c, accountId);
      const { rows } = await c.query(
        `SELECT id FROM product WHERE kind='weight' AND plu_code IS NULL AND deleted_at IS NULL ORDER BY code`);
      let n = 0;
      for (const r of rows) {
        const plu = (await c.query(
          `UPDATE goods_settings SET next_plu = next_plu + 1 WHERE account_id=$1 RETURNING next_plu - 1 AS plu`,
          [accountId])).rows[0].plu;
        await c.query(`UPDATE product SET plu_code=$2 WHERE id=$1`, [r.id, plu]);
        n++;
      }
      return { assigned: n };
    });
  }

  // ==================================================================
  // АРХИВ вместо удаления: история продаж ссылается на товар
  // ==================================================================
  async archive(accountId: string, id: string) {
    return this.db.withTenant(accountId, async (c) => {
      const used = (await c.query(`SELECT count(*)::int n FROM bundle_item WHERE component_id=$1`, [id])).rows[0].n;
      if (used > 0) throw new BadRequestException(`Товар входит в ${used} комплект(ов) — сначала уберите из них`);
      await c.query(`UPDATE product SET deleted_at=now(), is_active=false WHERE id=$1`, [id]);
      // кассы архивируют товар у себя той же дельтой
      await this.emitToDevices(c, accountId, 'product', id, 'delete', {});
      return { ok: true };
    });
  }

  async categories(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT c.id, c.parent_id, c.name, c.markup_percent, c.ntin_aggregate,
                (SELECT count(*)::int FROM product p WHERE p.category_id=c.id AND p.deleted_at IS NULL) AS products
           FROM category c WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name`);
      return rows;
    });
  }

  async createCategory(accountId: string, dto: { name: string; parentId?: string; markupPercent?: number; nameKk?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO category (account_id, name, name_kk, parent_id, markup_percent) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [accountId, dto.name, dto.nameKk ?? null, dto.parentId ?? null, dto.markupPercent ?? null]);
      return rows[0];
    });
  }

  /**
   * СНИМОК КАТАЛОГА ДЛЯ КАССЫ (часть 16).
   *
   * Свежепривязанное устройство должно уметь торговать офлайн сразу, а oplog
   * содержит только изменения — не начальное состояние. Поэтому касса при
   * привязке забирает весь каталог одним запросом вместе с текущим seq
   * журнала: дальше догоняется дельтами через /sync/pull с этого seq.
   * Модель UMAG «Синхронизация с сервером» + «Полная синхронизация» Wipon,
   * но без ручной кнопки — снимок и курсор согласованы атомарно.
   */
  async posCatalog(accountId: string, storeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows: products } = await c.query(
        `SELECT p.id, p.code, p.name, p.name_kk, p.full_name, p.kind, p.category_id,
                p.ntin, p.plu_code, p.article, p.vat_rate, p.min_price, p.track_stock,
                p.is_quick, p.quick_group, p.purchase_price,
                /* МАРКИРОВКА. Без неё касса не знает, что на товар нужна
                   марка: сигареты и водка прошли бы БЕЗ КОДА, и товар
                   ушёл бы мимо налоговой. Найдено на живом магазине. */
                p.marking,
                u.short_name AS unit,
                coalesce(
                  (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                    WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id=$1),
                  (SELECT value FROM product_price pp JOIN price_type pt ON pt.id=pp.price_type_id
                    WHERE pp.product_id=p.id AND pt.code='retail' AND pp.store_id IS NULL)
                ) AS price,
                coalesce((SELECT avg_cost FROM stock_balance sb WHERE sb.product_id=p.id LIMIT 1), p.purchase_price, 0) AS cost,
                coalesce((SELECT json_agg(json_build_object('code', b.code, 'primary', b.is_primary))
                   FROM barcode b WHERE b.product_id=p.id), '[]') AS barcodes
           FROM product p
           LEFT JOIN unit u ON u.id = p.unit_id
          WHERE p.deleted_at IS NULL AND p.parent_id IS NULL
          ORDER BY p.name`, [storeId ?? null]);

      const { rows: categories } = await c.query(
        `SELECT id, name, name_kk, parent_id FROM category WHERE deleted_at IS NULL ORDER BY name`);

      // seq берётся в той же транзакции, что и снимок: дельты после него
      // гарантированно не потеряют и не задвоят ни одного изменения
      const head = (await c.query(`SELECT coalesce(max(seq),0)::bigint AS s FROM oplog`)).rows[0].s;

      return { products, categories, serverSeq: Number(head), snapshotAt: new Date().toISOString() };
    });
  }
}
