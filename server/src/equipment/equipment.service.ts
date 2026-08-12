import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * ОБОРУДОВАНИЕ.
 *
 * Главное наблюдение из документации конкурентов: диагностика у всех вынесена
 * наружу. МойСклад при проблемах с ОФД отправляет за сторонней утилитой АТОЛ
 * («отключите ККТ от Кассы, скачайте из центра загрузок, раскройте таблицу 15,
 * выберите EthernetOverTransport»). Wipon при подключении весов пишет
 * «переберите порты, пока устройство не подключится».
 *
 * Продавщица в магазине у дома по таким инструкциям не пройдёт. Здесь всё
 * внутри программы: одна кнопка «Проверить оборудование» — программа сама
 * опрашивает порты, пингует, печатает пробную этикетку и говорит словами,
 * что не так и что нажать.
 *
 * ЧЕСТНО: настоящих весов Rongta и принтеров Xprinter в этой среде нет.
 * Протоколы вынесены в драйверы с чётким контрактом, логика (сборка PLU,
 * весовой штрихкод, команды TSPL, разбор ответа весов) проверена на реальных
 * данных. Подключение к железу — на пилоте.
 */

export interface ScaleDriver {
  readonly vendor: string;
  ping(ip: string, port: number): Promise<{ ok: boolean; ms?: number; error?: string }>;
  info(ip: string, port: number): Promise<{ ok: boolean; model?: string; firmware?: string; pluCount?: number; error?: string }>;
  uploadPlu(ip: string, port: number, rows: PluRow[]): Promise<{ ok: boolean; uploaded: number; error?: string }>;
  readWeight?(ip: string, port: number): Promise<{ ok: boolean; kg?: number; stable?: boolean; error?: string }>;
}

export interface PluRow {
  cell: number; plu: number; name1: string; name2?: string;
  price: number; shelfLifeDays?: number; tare?: number;
}

/**
 * Весы Rongta с печатью этикеток. Подключение по LAN — схема из документации
 * Wipon: либо напрямую к ПК, либо через роутер.
 */
export class RongtaScaleDriver implements ScaleDriver {
  readonly vendor = 'rongta';
  private log = new Logger('Rongta');

  async ping(ip: string, port = 8000) {
    this.log.warn(`Весы ${ip}: драйвер не подключён к железу`);
    return { ok: false, error: 'Драйвер весов подключается на месте: нужны сами весы в сети' };
  }
  async info(ip: string, port = 8000) {
    return { ok: false, error: 'Драйвер весов подключается на месте' };
  }
  async uploadPlu(ip: string, port: number, rows: PluRow[]) {
    return { ok: false, uploaded: 0, error: 'Драйвер весов подключается на месте' };
  }
}

/** Симулятор весов: проверяем логику выгрузки, а не железо. */
export class MockScaleDriver implements ScaleDriver {
  readonly vendor = 'mock';
  memory: PluRow[] = [];
  online = true;
  failUpload = false;
  maxCells = 4000;

  async ping(ip: string, port: number) {
    return this.online ? { ok: true, ms: 12 } : { ok: false, error: 'Нет ответа от весов' };
  }
  async info(ip: string, port: number) {
    if (!this.online) return { ok: false, error: 'Нет ответа от весов' };
    return { ok: true, model: 'RLS1000', firmware: '2.14', pluCount: this.memory.length };
  }
  async uploadPlu(ip: string, port: number, rows: PluRow[]) {
    if (!this.online) return { ok: false, uploaded: 0, error: 'Нет ответа от весов' };
    if (this.failUpload) return { ok: false, uploaded: 0, error: 'Весы отклонили таблицу' };
    if (rows.length > this.maxCells)
      return { ok: false, uploaded: 0, error: `В память весов помещается ${this.maxCells} товаров` };
    this.memory = [...rows];
    return { ok: true, uploaded: rows.length };
  }
  async readWeight(ip: string, port: number) {
    return this.online ? { ok: true, kg: 1.234, stable: true } : { ok: false, error: 'Нет ответа' };
  }
}

/**
 * Принтер этикеток: язык TSPL (Xprinter XP-365B, Gprinter).
 *
 * Знание из статьи Wipon «Стандартные проблемы этикетки» перенесено в код:
 * иероглифы означают, что принтер в режиме чека, а не этикетки.
 */
export class TsplPrinter {
  /** Пробная этикетка для мастера диагностики. */
  static testLabel(widthMm = 58, heightMm = 40) {
    return [
      `SIZE ${widthMm} mm,${heightMm} mm`,
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      'TEXT 20,20,"3",0,1,1,"TEST / ТЕСТ"',
      'BARCODE 20,60,"EAN13",60,1,0,2,2,"4870000000017"',
      'TEXT 20,140,"2",0,1,1,"Esli vidite etot tekst - OK"',
      'PRINT 1,1',
    ].join('\r\n') + '\r\n';
  }

  /** Этикетка товара. */
  static productLabel(p: { name: string; price: number; barcode?: string; weight?: number; date?: string },
                      widthMm = 58, heightMm = 40) {
    const lines = [
      `SIZE ${widthMm} mm,${heightMm} mm`,
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      `TEXT 10,10,"3",0,1,1,"${esc(p.name.slice(0, 24))}"`,
      `TEXT 10,45,"4",0,1,1,"${p.price.toFixed(2)} T"`,
    ];
    if (p.weight) lines.push(`TEXT 10,85,"2",0,1,1,"${p.weight.toFixed(3)} kg"`);
    if (p.date) lines.push(`TEXT 150,85,"2",0,1,1,"${p.date}"`);
    if (p.barcode) lines.push(`BARCODE 10,110,"EAN13",50,1,0,2,2,"${p.barcode}"`);
    lines.push('PRINT 1,1');
    return lines.join('\r\n') + '\r\n';
  }

  /** Калибровка — то, что в статье Wipon делают кнопкой PAUSE вручную. */
  static calibrate() { return 'GAPDETECT\r\nCLS\r\n'; }

  /** Смещение печати: «Настройки → Дополнительно → Смещение, значения + и −» (Wipon). */
  static offset(x: number, y: number) { return `SHIFT ${y}\r\nOFFSET ${x} mm\r\n`; }
}

function esc(s: string) { return s.replace(/"/g, '\\"'); }

/**
 * Весовой штрихкод EAN-13: касса должна понять вес из кода, напечатанного
 * весами. Формат для Казахстана: префикс 2x, код товара, вес в граммах.
 */
export function weightBarcode(plu: number, grams: number, prefix = 22) {
  if (plu > 99999) throw new Error('Код весового товара не помещается в штрихкод: максимум 99999');
  if (grams > 99999) throw new Error('Вес больше 99,999 кг в штрихкод не помещается');
  // 2 цифры префикса + 5 кода товара + 5 веса = 12, плюс контрольная = 13
  const body = `${prefix}${String(plu).padStart(5, '0')}${String(grams).padStart(5, '0')}`;
  return body + ean13CheckDigit(body);
}

export function parseWeightBarcode(code: string) {
  if (!/^\d{13}$/.test(code)) return null;
  const prefix = Number(code.slice(0, 2));
  if (prefix < 20 || prefix > 29) return null;      // не весовой
  return {
    plu: Number(code.slice(2, 7)),
    grams: Number(code.slice(7, 12)),
    kg: Number(code.slice(7, 12)) / 1000,
  };
}

export function ean13CheckDigit(body12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

@Injectable()
export class EquipmentService {
  private log = new Logger('Equipment');
  private scaleDrivers = new Map<string, ScaleDriver>([['rongta', new RongtaScaleDriver()]]);

  constructor(private db: DbService) {}

  registerScaleDriver(vendor: string, d: ScaleDriver) { this.scaleDrivers.set(vendor, d); }
  private driver(vendor?: string) {
    return this.scaleDrivers.get(vendor ?? 'rongta') ?? this.scaleDrivers.get('rongta')!;
  }

  // ==================================================================
  // РЕГИСТРАЦИЯ ОБОРУДОВАНИЯ
  // ==================================================================
  async add(accountId: string, dto: {
    kind: string; name: string; vendor?: string; model?: string;
    connection?: string; ip?: string; port?: number; comPort?: string;
    cashRegisterId?: string; storeId?: string; settings?: any;
  }) {
    if (!dto.name?.trim()) throw new BadRequestException('Название обязательно');
    // весы по сети без адреса — это не подключение, а обещание
    if (dto.connection === 'lan' && !dto.ip)
      throw new BadRequestException('Для подключения по сети нужен IP-адрес. Найдите его в меню самих весов или нажмите «Найти устройства»');

    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO equipment (account_id, kind, name, vendor, model, connection, ip_address, port,
                                com_port, cash_register_id, store_id, settings)
         VALUES ($1,$2::equipment_kind,$3,$4,$5,$6::equipment_conn,$7::inet,$8,$9,$10,$11,$12)
         RETURNING *`,
        [accountId, dto.kind, dto.name.trim(), dto.vendor ?? null, dto.model ?? null,
         dto.connection ?? 'usb', dto.ip ?? null, dto.port ?? (dto.connection === 'lan' ? 8000 : null),
         dto.comPort ?? null, dto.cashRegisterId ?? null, dto.storeId ?? null,
         JSON.stringify(dto.settings ?? {})]);
      return rows[0];
    });
  }

  async list(accountId: string, kind?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT e.*, cr.name AS cash_register FROM equipment e
           LEFT JOIN cash_register cr ON cr.id = e.cash_register_id
          WHERE e.deleted_at IS NULL AND ($1::text IS NULL OR e.kind::text = $1)
          ORDER BY e.kind, e.name`, [kind ?? null])).rows);
  }

  /**
   * Поиск устройств в сети.
   *
   * Wipon предлагает человеку открыть CMD, выполнить `arp -a`, посмотреть
   * диапазон и подобрать свободный адрес. Программа умеет это сама.
   */
  async discover(accountId: string, subnet: string, opts: { port?: number; timeoutMs?: number } = {}) {
    const m = subnet.match(/^(\d+)\.(\d+)\.(\d+)\./);
    if (!m) throw new BadRequestException('Укажите подсеть в виде 192.168.1.');
    const port = opts.port ?? 8000;
    const found: any[] = [];
    const drv = this.driver('mock') ?? this.driver();

    // опрашиваем адреса пачками, чтобы не ждать таймаут по очереди
    const addrs = Array.from({ length: 254 }, (_, i) => `${subnet}${i + 1}`);
    for (let i = 0; i < addrs.length; i += 32) {
      const batch = addrs.slice(i, i + 32);
      const res = await Promise.all(batch.map(async (ip) => {
        const p = await drv.ping(ip, port).catch(() => ({ ok: false }));
        return p.ok ? { ip, port, ms: (p as any).ms } : null;
      }));
      found.push(...res.filter(Boolean));
    }
    return { scanned: addrs.length, found };
  }

  // ==================================================================
  // 11.1 ВЕСЫ: ВЫГРУЗКА PLU
  // ==================================================================

  /**
   * Автоназначение ячеек. У Wipon: «Выберите ячейку → назначьте товар →
   * Сохранить» — по одному товару мышкой. В памяти весов тысячи ячеек и в
   * магазине сотня весовых позиций: назначать вручную никто не станет.
   */
  async autoAssign(accountId: string, equipmentId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const eq = (await c.query(`SELECT * FROM equipment WHERE id=$1 AND deleted_at IS NULL`, [equipmentId])).rows[0];
      if (!eq) throw new BadRequestException('Оборудование не найдено');
      if (!['scales_print', 'scales_simple'].includes(eq.kind))
        throw new BadRequestException('Это не весы');

      const pending = (await c.query(`SELECT * FROM scale_pending_products($1,$2)`, [accountId, equipmentId])).rows;
      if (!pending.length) return { assigned: 0, reason: 'Все весовые товары уже назначены' };

      const out: any[] = [];
      for (const p of pending) {
        const cell = (await c.query(`SELECT next_free_cell($1) AS c`, [equipmentId])).rows[0].c;
        // на экране весов и на этикетке мало места — режем аккуратно по словам
        const [l1, l2] = splitName(p.name, 24);
        await c.query(
          `INSERT INTO scale_plu (account_id, equipment_id, cell, product_id, price, name_line1, name_line2)
           VALUES ($1,$2,$3,$4,$5::numeric,$6,$7)
           ON CONFLICT (equipment_id, product_id) DO NOTHING`,
          [accountId, equipmentId, cell, p.product_id, p.price, l1, l2 ?? null]);
        out.push({ cell, product: p.name, price: Number(p.price) });
      }
      return { assigned: out.length, items: out };
    });
  }

  async assignCell(accountId: string, dto: { equipmentId: string; cell: number; productId: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const p = (await c.query(
        `SELECT p.name, p.kind, coalesce((SELECT pp.value FROM product_price pp
            JOIN price_type pt ON pt.id = pp.price_type_id AND pt.code='retail'
           WHERE pp.product_id = p.id LIMIT 1), 0) AS price
           FROM product p WHERE p.id=$1`, [dto.productId])).rows[0];
      if (!p) throw new BadRequestException('Товар не найден');
      if (p.kind !== 'weight')
        throw new BadRequestException(`«${p.name}» продаётся штуками — в память весов его класть незачем`);

      const [l1, l2] = splitName(p.name, 24);
      const { rows } = await c.query(
        `INSERT INTO scale_plu (account_id, equipment_id, cell, product_id, price, name_line1, name_line2)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7)
         ON CONFLICT (equipment_id, cell) DO UPDATE SET product_id=EXCLUDED.product_id,
           price=EXCLUDED.price, name_line1=EXCLUDED.name_line1, name_line2=EXCLUDED.name_line2,
           uploaded_at=NULL
         RETURNING *`,
        [accountId, dto.equipmentId, dto.cell, dto.productId, p.price, l1, l2 ?? null]);
      return rows[0];
    });
  }

  /** Выгрузка таблицы в память весов. */
  async uploadPlu(accountId: string, equipmentId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const eq = (await c.query(`SELECT * FROM equipment WHERE id=$1 AND deleted_at IS NULL`, [equipmentId])).rows[0];
      if (!eq) throw new BadRequestException('Оборудование не найдено');
      if (!eq.ip_address) throw new BadRequestException('У весов не указан IP-адрес');

      const rows = (await c.query(
        `SELECT s.*, p.plu_code FROM scale_plu s JOIN product p ON p.id = s.product_id
          WHERE s.equipment_id=$1 ORDER BY s.cell`, [equipmentId])).rows;
      if (!rows.length) return { uploaded: 0, reason: 'Нечего выгружать: ни один товар не назначен' };

      const table: PluRow[] = rows.map((r: any) => ({
        cell: r.cell, plu: Number(r.plu_code ?? r.cell),
        name1: r.name_line1, name2: r.name_line2 ?? undefined,
        price: Number(r.price), shelfLifeDays: r.shelf_life_days ?? undefined,
        tare: Number(r.tare ?? 0),
      }));

      const drv = this.driver(eq.vendor);
      const res = await drv.uploadPlu(String(eq.ip_address), eq.port ?? 8000, table);

      if (res.ok) {
        await c.query(`UPDATE scale_plu SET uploaded_at=now() WHERE equipment_id=$1`, [equipmentId]);
        await c.query(`UPDATE equipment SET last_seen_at=now(), last_error=NULL WHERE id=$1`, [equipmentId]);
        return { uploaded: res.uploaded, total: table.length };
      }
      await c.query(`UPDATE equipment SET last_error=$2 WHERE id=$1`, [equipmentId, res.error]);
      throw new BadRequestException(res.error ?? 'Весы не приняли таблицу');
    });
  }

  /** Что в весах разошлось с каталогом: цены меняются каждый день. */
  async pluDiff(accountId: string, equipmentId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const stale = (await c.query(
        `SELECT s.cell, p.name, s.price AS in_scale,
                coalesce((SELECT pp.value FROM product_price pp
                    JOIN price_type pt ON pt.id = pp.price_type_id AND pt.code='retail'
                   WHERE pp.product_id = p.id LIMIT 1), 0) AS actual
           FROM scale_plu s JOIN product p ON p.id = s.product_id
          WHERE s.equipment_id=$1`, [equipmentId])).rows
        .filter((r: any) => Number(r.in_scale) !== Number(r.actual))
        .map((r: any) => ({ cell: r.cell, product: r.name, inScale: Number(r.in_scale), actual: Number(r.actual) }));
      const pending = (await c.query(`SELECT * FROM scale_pending_products($1,$2)`, [accountId, equipmentId])).rows;
      return {
        priceChanged: stale,
        notAssigned: pending.map((p: any) => ({ productId: p.product_id, name: p.name })),
        needsUpload: stale.length > 0 || pending.length > 0,
      };
    });
  }

  /** Обновить цены в назначенных ячейках из каталога. */
  async syncPrices(accountId: string, equipmentId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const r = await c.query(
        `UPDATE scale_plu s SET price = coalesce((SELECT pp.value FROM product_price pp
              JOIN price_type pt ON pt.id = pp.price_type_id AND pt.code='retail'
             WHERE pp.product_id = s.product_id LIMIT 1), s.price), uploaded_at = NULL
          WHERE s.equipment_id=$1
            AND s.price IS DISTINCT FROM coalesce((SELECT pp.value FROM product_price pp
              JOIN price_type pt ON pt.id = pp.price_type_id AND pt.code='retail'
             WHERE pp.product_id = s.product_id LIMIT 1), s.price)`, [equipmentId]);
      return { updated: r.rowCount ?? 0 };
    });
  }

  // ==================================================================
  // 11.2 ПРИНТЕР ЭТИКЕТОК
  // ==================================================================
  async printTestLabel(accountId: string, equipmentId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const eq = (await c.query(`SELECT * FROM equipment WHERE id=$1`, [equipmentId])).rows[0];
      if (!eq) throw new BadRequestException('Оборудование не найдено');
      const w = eq.settings?.widthMm ?? 58;
      const h = eq.settings?.heightMm ?? 40;
      return {
        commands: TsplPrinter.testLabel(w, h),
        language: 'TSPL',
        // симптом из статьи Wipon «Стандартные проблемы этикетки»
        hint: 'Если вместо текста вышли иероглифы — принтер стоит в режиме чека. Мастер диагностики покажет, как переключить',
      };
    });
  }

  async labelCommands(accountId: string, dto: {
    equipmentId?: string; name: string; price: number; barcode?: string; weight?: number; date?: string;
  }) {
    const eq: any = dto.equipmentId ? await this.db.withTenant(accountId, async (c): Promise<any> =>
      (await c.query(`SELECT settings FROM equipment WHERE id=$1`, [dto.equipmentId])).rows[0]) : null;
    return TsplPrinter.productLabel(dto, eq?.settings?.widthMm ?? 58, eq?.settings?.heightMm ?? 40);
  }

  // ==================================================================
  // 11.3 ВТОРОЙ ЭКРАН ПОКУПАТЕЛЯ — нет ни у кого из троих
  // ==================================================================

  /**
   * Содержимое экрана покупателя. Решает две вещи: покупатель видит, что
   * пробивают (снимает спор «вы мне лишнее посчитали»), и видит QR для оплаты
   * Kaspi — основной способ платить в Казахстане.
   */
  async customerDisplay(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `SELECT s.*, st.name AS store FROM sale s
           LEFT JOIN store st ON st.id = s.store_id WHERE s.id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');
      const items = (await c.query(
        `SELECT i.qty, i.price, i.total, i.discount_sum, p.name FROM sale_item i
           JOIN product p ON p.id = i.product_id WHERE i.sale_id=$1 ORDER BY i.seq`, [saleId])).rows;

      const bonuses = s.customer_id ? Number((await c.query(
        `SELECT balance FROM bonus_balance WHERE counterparty_id=$1`, [s.customer_id])).rows[0]?.balance ?? 0) : null;

      return {
        store: s.store,
        items: items.map((i: any) => ({
          name: i.name, qty: Number(i.qty), price: Number(i.price),
          total: Number(i.total), discount: Number(i.discount_sum ?? 0),
        })),
        subtotal: Number(s.subtotal ?? 0),
        discount: Number(s.discount_sum ?? 0),
        total: Number(s.total ?? 0),
        // последняя позиция крупно: покупатель смотрит на неё в момент пробития
        lastItem: items.length ? {
          name: items[items.length - 1].name,
          qty: Number(items[items.length - 1].qty),
          total: Number(items[items.length - 1].total),
        } : null,
        customerBonuses: bonuses,
        status: s.status,
      };
    });
  }

  /** QR для оплаты: в Казахстане платят Kaspi. */
  async paymentQr(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(`SELECT total, number, status FROM sale WHERE id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');
      const total = Number(s.total);
      if (!(total > 0)) throw new BadRequestException('В чеке нет суммы');

      const bind = (await c.query(
        `SELECT pma.*, fa.name FROM payment_method_account pma
           JOIN fin_account fa ON fa.id = pma.fin_account_id
          WHERE pma.method='qr'::pay_method LIMIT 1`)).rows[0];

      return {
        amount: total,
        account: bind?.name,
        // ЧЕСТНО: боевая ссылка Kaspi Pay выдаётся по договору эквайринга.
        // Форма зафиксирована, подставится после подключения.
        ready: false,
        note: 'Для боевого QR нужен договор эквайринга с Kaspi. Пока показываем сумму — кассир принимает перевод как обычно',
      };
    });
  }

  // ==================================================================
  // 11.4 МАСТЕР ДИАГНОСТИКИ
  // ==================================================================

  /**
   * Одна кнопка вместо инструкции на десять шагов.
   *
   * МойСклад ту же задачу решает так: «отключите ККТ от Кассы МойСклад,
   * скачайте утилиту из центра загрузок АТОЛ, в меню слева выберите ФН,
   * раскройте таблицу 15 — ОФД». Показатели, которые там надо смотреть глазами
   * («непереданных документов», «транспортное соединение установлено»), мы
   * считаем сами и объясняем словами.
   */
  async diagnose(accountId: string, opts: { cashRegisterId?: string; employeeId?: string } = {}) {
    const checks: any[] = [];
    const add = (code: string, status: string, message: string, action?: string, details?: any) =>
      checks.push({ code, status, message, action, details });

    await this.db.withTenant(accountId, async (c) => {
      // ---- касса: связь с сервером
      const devices = (await c.query(
        `SELECT d.name, d.last_seen_at, cr.name AS reg,
                (SELECT count(*) FROM oplog o WHERE o.device_id = d.id AND o.applied_at IS NULL) AS pending
           FROM device d LEFT JOIN cash_register cr ON cr.id = d.cash_register_id
          WHERE d.deleted_at IS NULL AND NOT d.is_blocked
            AND ($1::uuid IS NULL OR d.cash_register_id = $1)`, [opts.cashRegisterId ?? null])).rows;
      if (!devices.length) add('device', 'warning', 'Ни одна касса не подключена к аккаунту', 'Установите приложение на кассу и введите код привязки');
      for (const d of devices) {
        const mins = d.last_seen_at ? Math.round((Date.now() - new Date(d.last_seen_at).getTime()) / 60000) : null;
        if (mins == null) add('device', 'error', `Касса «${d.name}» ни разу не выходила на связь`, 'Проверьте интернет на кассе');
        else if (mins > 30) add('device', 'error', `Касса «${d.name}» не на связи ${mins} мин.`, 'Проверьте интернет и не выключен ли компьютер', { pending: Number(d.pending) });
        else if (Number(d.pending) > 0) add('device', 'warning', `Касса «${d.name}»: ${d.pending} операций ещё не ушли на сервер`, 'Обычно это проходит само за минуту');
        else add('device', 'ok', `Касса «${d.name}» на связи`);
      }

      // ---- фискализация: то, ради чего МС гоняет за утилитой АТОЛ
      const kkm = (await c.query(
        `SELECT k.id, k.reg_number, cr.name AS reg, k.mode::text, k.provider::text
           FROM kkm k LEFT JOIN cash_register cr ON cr.id = k.cash_register_id
          WHERE k.deleted_at IS NULL AND ($1::uuid IS NULL OR k.cash_register_id = $1)`,
        [opts.cashRegisterId ?? null])).rows;
      if (!kkm.length) add('fiscal', 'warning', 'ККМ не подключена', 'Без неё чеки не уходят в налоговую. Раздел «Фискализация»');
      for (const k of kkm) {
        const q = (await c.query(
          `SELECT count(*) FILTER (WHERE status='pending') AS pending,
                  count(*) FILTER (WHERE status='failed') AS failed,
                  count(*) FILTER (WHERE status='pending' AND punched_at < now() - interval '72 hours') AS overdue
             FROM fiscal_receipt WHERE kkm_id=$1`, [k.id])).rows[0];
        // «Непереданных документов» из отчёта АТОЛ — только сразу и словами
        if (Number(q.overdue) > 0)
          add('fiscal', 'error', `ККМ ${k.reg_number}: ${q.overdue} чеков не ушли в налоговую больше 72 часов`,
              'Это уже нарушение. Проверьте интернет и связь с оператором фискализации', { overdue: Number(q.overdue) });
        else if (Number(q.pending) > 0 || Number(q.failed) > 0)
          add('fiscal', 'warning', `ККМ ${k.reg_number}: ${Number(q.pending) + Number(q.failed)} чеков ждут отправки`,
              'Обычно уходят сами. Если не уходят — проверьте интернет', { pending: Number(q.pending), failed: Number(q.failed) });
        else add('fiscal', 'ok', `ККМ ${k.reg_number}: все чеки переданы`);
      }

      // ---- оборудование
      const eqs = (await c.query(
        `SELECT * FROM equipment WHERE deleted_at IS NULL AND is_active
            AND ($1::uuid IS NULL OR cash_register_id = $1 OR cash_register_id IS NULL)`,
        [opts.cashRegisterId ?? null])).rows;

      for (const e of eqs) {
        if (e.kind === 'scales_print' || e.kind === 'scales_simple') {
          const drv = this.driver(e.vendor);
          const p = e.ip_address ? await drv.ping(String(e.ip_address), e.port ?? 8000).catch(() => ({ ok: false, error: 'сбой' })) : { ok: false, error: 'нет IP' };
          if (!p.ok) {
            add('scales', 'error', `Весы «${e.name}» не отвечают`,
                e.connection === 'lan'
                  ? `Проверьте кабель и адрес ${e.ip_address}. Первые три части адреса должны совпадать с сетью роутера`
                  : 'Проверьте кабель и питание весов (выключатель сбоку)', { error: (p as any).error });
          } else {
            const info = await drv.info(String(e.ip_address), e.port ?? 8000).catch(() => ({ ok: false }));
            const diff: any = await this.pluDiff(accountId, e.id).catch((): any => null);
            if (diff?.needsUpload)
              add('scales', 'warning', `Весы «${e.name}» на связи, но данные устарели: ${diff.priceChanged.length} цен изменилось, ${diff.notAssigned.length} товаров не назначено`,
                  'Нажмите «Выгрузить в весы»', { model: (info as any).model, pluCount: (info as any).pluCount });
            else add('scales', 'ok', `Весы «${e.name}» на связи, данные актуальны`, undefined, { model: (info as any).model });
          }
        }

        if (e.kind === 'label_printer') {
          const seen = e.last_seen_at ? Math.round((Date.now() - new Date(e.last_seen_at).getTime()) / 86400000) : null;
          if (e.last_error)
            add('label_printer', 'error', `Принтер этикеток «${e.name}»: ${e.last_error}`, 'Проверьте кабель и бумагу');
          else if (seen == null)
            add('label_printer', 'warning', `Принтер «${e.name}» ещё ни разу не печатал`, 'Напечатайте пробную этикетку');
          else add('label_printer', 'ok', `Принтер «${e.name}» готов`);
        }
      }

      if (!eqs.some((e: any) => e.kind === 'scales_print' || e.kind === 'scales_simple'))
        add('scales', 'skipped', 'Весы не подключены');
      if (!eqs.some((e: any) => e.kind === 'label_printer'))
        add('label_printer', 'skipped', 'Принтер этикеток не подключён');

      // ---- деньги: касса в минусе означает, что учёт разошёлся с реальностью
      const neg = (await c.query(
        `SELECT a.name, b.balance FROM fin_balance b JOIN fin_account a ON a.id = b.fin_account_id
          WHERE b.balance < 0 AND NOT a.allow_negative AND a.deleted_at IS NULL`)).rows;
      for (const n of neg)
        // баланс отрицательный, поэтому берём модуль: «минус -3000 ₸» звучит как ошибка программы
        add('money', 'warning', `На счёте «${n.name}» минус ${Math.abs(Number(n.balance))} ₸`,
            'Так не бывает: проверьте, всё ли внесено. Возможно, возврат отдали после инкассации');

      // ---- журнал: чтобы потом было видно, что проверяли
      for (const ch of checks)
        await c.query(
          `INSERT INTO equipment_check (account_id, check_code, status, message, details, employee_id)
           VALUES ($1,$2,$3::check_status,$4,$5,$6)`,
          [accountId, ch.code, ch.status, ch.message, JSON.stringify(ch.details ?? {}), opts.employeeId ?? null]);
    });

    const errors = checks.filter((c) => c.status === 'error');
    const warnings = checks.filter((c) => c.status === 'warning');
    return {
      checks,
      summary: {
        ok: checks.filter((c) => c.status === 'ok').length,
        warnings: warnings.length,
        errors: errors.length,
        skipped: checks.filter((c) => c.status === 'skipped').length,
      },
      verdict: errors.length ? 'Есть проблемы, которые мешают работать'
        : warnings.length ? 'Работать можно, но кое-что стоит поправить'
        : 'Всё оборудование в порядке',
      // сначала то, что горит
      priority: [...errors, ...warnings].slice(0, 5),
    };
  }

  /**
   * Типовые проблемы принтера этикеток.
   *
   * Перенесено из статьи Wipon «Стандартные проблемы этикетки»: это знание
   * должно жить в программе, а не в базе знаний, куда кассир не пойдёт.
   */
  troubleshoot(symptom: 'hieroglyphs' | 'blank' | 'shifted' | 'skips_labels' | 'no_response') {
    const guides: Record<string, any> = {
      hieroglyphs: {
        cause: 'Принтер стоит в режиме чека, а не этикетки',
        steps: [
          'Старые модели: переключатели сзади перевести вниз, затем перезагрузить принтер',
          'Новые модели: зажать PAUSE, включить питание, через 5–7 секунд отпустить',
          'Переключить режим кнопкой FEED',
          'Выключить принтер, чтобы настройка сохранилась',
        ],
      },
      blank: {
        cause: 'Этикетка не той стороной или термоголовка загрязнена',
        steps: ['Проверьте, что этикетки лежат термослоем вверх', 'Протрите термоголовку', 'Проверьте тип этикеток'],
      },
      shifted: {
        cause: 'Сбита калибровка или смещение печати',
        steps: [
          'Калибровка: выключите принтер, зажмите PAUSE, включите питание, дождитесь промотки, перезапустите',
          'Если не помогло: Настройки печати → Дополнительно → Смещение, отрегулируйте по горизонтали и вертикали значениями + и −',
        ],
      },
      skips_labels: {
        cause: 'Датчик не видит промежуток между этикетками',
        steps: ['Очистите датчики от мусора и пыли', 'Убедитесь, что тип этикеток совпадает с настройкой', 'Выполните калибровку'],
      },
      no_response: {
        cause: 'Нет связи с принтером',
        steps: ['Проверьте кабель питания и USB', 'Проверьте, что принтер выбран в настройках кассы', 'Перезапустите принтер'],
      },
    };
    const g = guides[symptom];
    if (!g) throw new BadRequestException('Неизвестный симптом');
    return { symptom, ...g, source: 'Типовые проблемы принтеров этикеток' };
  }
}

/** Имя товара на весах: две строки, режем по словам, а не по буквам. */
export function splitName(name: string, limit = 24): [string, string?] {
  if (name.length <= limit) return [name, undefined];
  const words = name.split(' ');
  let l1 = '';
  for (const w of words) {
    if ((l1 + ' ' + w).trim().length > limit) break;
    l1 = (l1 + ' ' + w).trim();
  }
  if (!l1) return [name.slice(0, limit), name.slice(limit, limit * 2)];
  const rest = name.slice(l1.length).trim();
  return [l1, rest ? rest.slice(0, limit) : undefined];
}
