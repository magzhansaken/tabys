import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SyncGateway } from '../sync/sync.gateway';

/**
 * ОТЧЁТЫ И ДАШБОРД.
 *
 * Структура дашборда — «Показатели по магазинам» UMAG: выручка, продажи,
 * средний чек, себестоимость, валовая прибыль, график, счета, синхронизация
 * касс, последние изменения. С тремя поправками:
 *
 * 1. У UMAG «Количество продаж — это количество проданных товаров», но
 *    «Средний чек = Выручка / Количество продаж». Если это штуки — выходит
 *    средняя цена позиции, а не средний чек. Считаем обе величины раздельно.
 * 2. Дашборд живой: с 1.3 есть WebSocket, страницу не надо обновлять руками.
 * 3. Мобильному отдаём всё одним запросом — владелец открывает телефон в
 *    подвале магазина, где связь одна палка.
 */

export interface Period { from: string; to: string; }

@Injectable()
export class ReportService {
  constructor(private db: DbService, private gateway?: SyncGateway) {}

  /** Граница операционного дня из настроек магазина. Держим в памяти
   *  минуту: дёргать базу ради одного числа в каждом отчёте расточительно,
   *  а меняется оно раз в жизни. */
  private static dayStartCache = new Map<string, { h: number; at: number }>();

  /** Забыть запомненную границу — вызывается при её смене в настройках. */
  static forgetDayStart(accountId: string) { ReportService.dayStartCache.delete(accountId); }
  private async dayStartHour(accountId: string): Promise<number> {
    const c = ReportService.dayStartCache.get(accountId);
    if (c && Date.now() - c.at < 60000) return c.h;
    try {
      const r = await this.db.withTenant(accountId, async (cl) =>
        (await cl.query(`SELECT day_start_hour FROM account WHERE id=$1`, [accountId])).rows[0]);
      const h = Number(r?.day_start_hour ?? 0);
      ReportService.dayStartCache.set(accountId, { h, at: Date.now() });
      return h;
    } catch { return 0; }
  }

  /**
   * Операционный день с учётом границы.
   *
   * Пример при границе 6 утра: сейчас 01:30 ночи 11 августа — это ещё
   * «день 10 августа». Выручка ночной смены не перескакивает в новый
   * день, иначе отчёт «за вчера» не сойдётся с деньгами в кассе.
   */
  private day(offset = 0, startHour = 0): Period {
    const now = new Date();
    const d = new Date(now);
    if (startHour > 0 && now.getHours() < startHour) d.setDate(d.getDate() - 1);
    d.setHours(startHour, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    const to = new Date(d);
    to.setDate(to.getDate() + 1);
    to.setMilliseconds(to.getMilliseconds() - 1);
    return { from: d.toISOString(), to: to.toISOString() };
  }

  /** День конкретного магазина — с его настройкой границы. */
  async dayFor(accountId: string, offset = 0): Promise<Period> {
    return this.day(offset, await this.dayStartHour(accountId));
  }

  /** Быстрые фильтры Wipon: текущий месяц, прошлый месяц, квартал. */
  quickPeriod(name: 'today' | 'yesterday' | 'week' | 'month' | 'prev_month' | 'quarter'): Period {
    const now = new Date();
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    const start = new Date(now); start.setHours(0, 0, 0, 0);

    switch (name) {
      case 'today': return this.day();
      case 'yesterday': return this.day(-1);
      case 'week': start.setDate(start.getDate() - 6); return { from: start.toISOString(), to: end.toISOString() };
      case 'month': start.setDate(1); return { from: start.toISOString(), to: end.toISOString() };
      case 'prev_month': {
        const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        return { from: s.toISOString(), to: e.toISOString() };
      }
      case 'quarter': {
        const q = Math.floor(now.getMonth() / 3);
        const s = new Date(now.getFullYear(), q * 3, 1);
        return { from: s.toISOString(), to: end.toISOString() };
      }
    }
  }

  // ==================================================================
  // 8.1 ДАШБОРД ДНЯ
  // ==================================================================
  async dashboardDay(accountId: string, p?: Period, storeIds?: string[]) {
    const period = p ?? await this.dayFor(accountId);
    const { rows } = await this.db.raw(`SELECT * FROM dashboard_day($1,$2::timestamptz,$3::timestamptz,$4::uuid[])`,
      [accountId, period.from, period.to, storeIds?.length ? storeIds : null]);
    const r = rows[0];
    const n = (v: any) => Number(v ?? 0);

    return {
      period,
      revenue: n(r.revenue),
      receipts: r.receipts,               // чеков — то есть покупателей
      itemsSold: n(r.items_sold),         // позиций — это и есть «количество продаж» UMAG
      // Средний чек = Выручка / чеки. У UMAG в знаменателе «количество продаж»,
      // которое в их же определении — штуки товара.
      avgReceipt: n(r.avg_receipt),
      avgItemsPerReceipt: n(r.avg_items),
      cost: n(r.cost),
      grossProfit: n(r.gross_profit),     // Валовая = Выручка − Себестоимость (формула UMAG)
      marginPercent: n(r.margin_percent),
      refunds: { sum: n(r.refunds), count: r.refund_count },
      payments: { cash: n(r.cash), card: n(r.card), qr: n(r.qr), credit: n(r.credit) },
      discounts: n(r.discounts),
      cancelledItems: r.cancelled_count,  // контроль из Части 4
    };
  }

  /**
   * Живой снимок для мобильного кабинета владельца (часть 28). Модель
   * МоегоСклада «владелец следит, какие точки открылись»: сводка за сегодня
   * + список открытых смен по точкам (кто на кассе прямо сейчас). Один
   * компактный запрос для телефона — не тянем весь дашборд.
   */
  async mobileSnapshot(accountId: string, storeIds?: string[]) {
    const today = await this.dayFor(accountId);
    const dash = await this.dashboardDay(accountId, today, storeIds);
    const openShifts = await this.openShifts(accountId);
    return {
      today: {
        revenue: dash.revenue, receipts: dash.receipts, profit: dash.grossProfit,
        avgReceipt: dash.avgReceipt, refunds: dash.refunds,
      },
      openShifts,
      openStoresCount: new Set(openShifts.map((s: any) => s.store)).size,
    };
  }

  /**
   * Короткий список заканчивающихся товаров — для мобильного.
   *
   * Пять самых острых, а не все: у магазина таких позиций бывает
   * тридцать-сорок, и на телефоне это простыня, которую не читают.
   * Порядок — по тому, насколько остаток провалился ниже порога:
   * товар, которого нет совсем, важнее того, которого мало.
   */
  async lowStockShort(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const rows = (await c.query(
        `SELECT p.id, p.name, p.min_stock, coalesce(sum(b.qty), 0) AS qty
           FROM product p
           LEFT JOIN stock_balance b ON b.product_id = p.id
          WHERE p.account_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL
            AND p.track_stock AND p.min_stock IS NOT NULL AND p.min_stock > 0
          GROUP BY p.id, p.name, p.min_stock
         HAVING coalesce(sum(b.qty), 0) < p.min_stock
          ORDER BY (coalesce(sum(b.qty),0) / nullif(p.min_stock,0)) ASC`, [accountId])).rows;

      const items = rows.map((r: any) => {
        const qty = Number(r.qty), min = Number(r.min_stock);
        return { id: r.id, name: r.name, qty, minStock: min,
                 need: Math.max(0, min - qty), out: qty <= 0 };
      });
      return {
        items: items.slice(0, 5),
        total: items.length,
        outCount: items.filter((i) => i.out).length,
      };
    });
  }

  /**
   * Открытые смены: где сейчас торгуют, кто за кассой, сколько наторговали.
   *
   * Вынесено в отдельный метод, потому что нужно двум ответам сразу. Две
   * копии одной выборки рано или поздно разъезжаются, и одна из них
   * начинает показывать не то — а это как раз тот случай, когда владелец
   * смотрит с телефона и принимает решение.
   *
   * Зачем владельцу: «какие точки открылись» — одна из главных причин
   * вообще лезть в телефон. Он видит, что смена не открыта в девять
   * утра, и звонит продавцу, а не узнаёт об этом вечером из отчёта.
   */
  async openShifts(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT s.id, s.opened_at, st.name AS store, cr.name AS register,
                (e.first_name || ' ' || coalesce(e.last_name,'')) AS cashier,
                coalesce((SELECT sum(CASE WHEN sl.return_of_id IS NULL THEN sl.total ELSE -sl.total END)
                            FROM sale sl WHERE sl.shift_id = s.id), 0) AS revenue,
                (SELECT count(*) FROM sale sl WHERE sl.shift_id = s.id AND sl.return_of_id IS NULL) AS receipts
           FROM shift s
           LEFT JOIN cash_register cr ON cr.id = s.cash_register_id
           LEFT JOIN store st ON st.id = cr.store_id
           LEFT JOIN employee e ON e.id = s.opened_by
          WHERE s.account_id = $1 AND s.closed_at IS NULL
          ORDER BY s.opened_at`, [accountId])).rows
        .map((r: any) => ({
          id: r.id, store: r.store, register: r.register, cashier: (r.cashier ?? '').trim() || '—',
          openedAt: r.opened_at, revenue: Number(r.revenue), receipts: Number(r.receipts),
        })));
  }

  /** График выручки: «сумма выручки за каждый отдельный день» (UMAG). */
  async revenueChart(accountId: string, p: Period, storeIds?: string[]) {
    const { rows } = await this.db.raw(`SELECT * FROM revenue_chart($1,$2::timestamptz,$3::timestamptz,$4::uuid[])`,
      [accountId, p.from, p.to, storeIds?.length ? storeIds : null]);
    return rows.map((r: any) => ({
      day: r.day, revenue: Number(r.revenue), receipts: r.receipts, profit: Number(r.profit),
    }));
  }

  /** Таблица «Счета» с Главной UMAG, включая флаг «разрешён отрицательный баланс». */
  async accountsBoard(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.name, a.kind, a.allow_negative, s.name AS store,
                coalesce(b.balance, a.opening_balance) AS balance
           FROM fin_account a
           LEFT JOIN fin_balance b ON b.fin_account_id = a.id
           LEFT JOIN store s ON s.id = a.store_id
          WHERE a.deleted_at IS NULL AND a.is_active ORDER BY a.kind, a.name`);
      return rows.map((r: any) => {
        const balance = Number(r.balance);
        return {
          ...r, balance,
          // в денежном ящике минуса не бывает; на банковском счёте — бывает овердрафт
          problem: balance < 0 && !r.allow_negative,
        };
      });
    });
  }

  /** Таблица «Синхронизация с сервером» — светофор UMAG. */
  async syncBoard(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM sync_status_board($1)`, [accountId]);
    return rows.map((r: any) => ({
      deviceId: r.device_id, cashRegister: r.cash_register, store: r.store,
      status: r.status,                        // green / yellow / red — как у UMAG
      lastSync: r.last_sync, minutesAgo: r.minutes_ago, pendingEvents: r.pending_events,
      message: r.status === 'red'
        ? (r.last_sync ? `Не выходит на связь ${r.minutes_ago} мин.` : 'Ни разу не синхронизировалась')
        : r.status === 'yellow' ? `Последняя связь ${r.minutes_ago} мин. назад` : 'На связи',
    }));
  }

  /** Таблица «Последние изменения» (UMAG): документ, статус, кто и когда. */
  async recentChanges(accountId: string, limit = 20) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT d.id, d.kind::text AS doc_kind, d.number, d.status::text, d.created_at, d.updated_at,
                st.name AS store, e.first_name AS employee
           FROM stock_doc d
           LEFT JOIN warehouse w ON w.id = d.warehouse_id
           LEFT JOIN store st ON st.id = w.store_id
           LEFT JOIN employee e ON e.id = d.employee_id
          WHERE d.deleted_at IS NULL
          ORDER BY d.updated_at DESC LIMIT $1`, [limit])).rows);
  }

  /**
   * Живой дашборд: касса пробила чек — цифры на экране владельца обновились
   * сами. У UMAG «Главную» надо перезагружать руками.
   *
   * Канал тот же, что у синхронизации (механика 1.3): плодить второй канал ради
   * отчётов незачем — данные те же самые, а лишнее соединение это лишний расход
   * батареи телефона.
   */
  notifyDashboard(accountId: string, seq = 0) {
    return this.gateway?.notifyAccount(accountId, { type: 'dashboard_update', seq }) ?? 0;
  }

  // ==================================================================
  // 8.2 СТАТИСТИКА ПРОДАЖ — пять разрезов UMAG
  // ==================================================================
  async salesByProduct(accountId: string, p: Period, f: { categoryId?: string; limit?: number } = {}) {
    const { rows } = await this.db.raw(
      `SELECT * FROM sales_by_product($1,$2::timestamptz,$3::timestamptz,$4,$5)`,
      [accountId, p.from, p.to, f.categoryId ?? null, f.limit ?? 100]);
    return rows.map((r: any) => ({
      productId: r.product_id, name: r.name, barcode: r.barcode, unit: r.unit, category: r.category,
      qtySold: Number(r.qty_sold), qtyReturned: Number(r.qty_returned),
      revenue: Number(r.revenue), cost: Number(r.cost), profit: Number(r.profit),
      marginPercent: Number(r.margin_percent),     // рентабельность (колонка UMAG)
      markupPercent: Number(r.markup_percent),     // наценка (колонка UMAG)
      receipts: r.receipts,
    }));
  }

  /** Разрезы «По категориям», «По поставщикам», «По покупателям». */
  async salesBy(accountId: string, dim: 'category' | 'supplier' | 'customer', p: Period) {
    const { rows } = await this.db.raw(
      `SELECT * FROM sales_by_dimension($1,$2::timestamptz,$3::timestamptz,$4)`,
      [accountId, p.from, p.to, dim]);
    return rows.map((r: any) => ({
      id: r.id, name: r.name, qty: Number(r.qty), revenue: Number(r.revenue),
      cost: Number(r.cost), profit: Number(r.profit),
      marginPercent: Number(r.margin_percent), receipts: r.receipts,
    }));
  }

  /** Разрез «По чекам» (UMAG). */
  async salesByReceipt(accountId: string, p: Period, limit = 100) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT s.id, s.number, s.completed_at, s.total, s.cost_total, s.profit, s.discount_sum,
                e.first_name AS cashier, con.name AS consultant, cp.name AS customer, cr.name AS register,
                (SELECT count(*) FROM sale_item i WHERE i.sale_id = s.id) AS items,
                (s.return_of_id IS NOT NULL) AS is_refund
           FROM sale s
           LEFT JOIN employee e ON e.id = s.employee_id
           LEFT JOIN consultant con ON con.id = s.consultant_id
           LEFT JOIN counterparty cp ON cp.id = s.customer_id
           LEFT JOIN cash_register cr ON cr.id = s.cash_register_id
          WHERE s.status IN ('completed','returned')
            AND s.completed_at >= $1::timestamptz AND s.completed_at <= $2::timestamptz
          ORDER BY s.completed_at DESC LIMIT $3`, [p.from, p.to, limit])).rows
        .map((r: any) => ({
          ...r, total: Number(r.total), cost_total: Number(r.cost_total),
          profit: Number(r.profit), discount_sum: Number(r.discount_sum), items: Number(r.items),
        })));
  }

  // ==================================================================
  // 8.3 ABC — модель UMAG: две оценки и свод
  // ==================================================================
  async abc(accountId: string, p: Period, categoryId?: string) {
    const { rows } = await this.db.raw(`SELECT * FROM abc_analysis($1,$2::timestamptz,$3::timestamptz,$4)`,
      [accountId, p.from, p.to, categoryId ?? null]);
    const items = rows.map((r: any) => ({
      productId: r.product_id, name: r.name,
      purchasePrice: Number(r.purchase_price ?? 0), markupPercent: Number(r.markup_percent),
      retailPrice: Number(r.retail_price ?? 0), qty: Number(r.qty),
      costSum: Number(r.cost_sum), revenueSum: Number(r.revenue_sum),
      abcRevenue: r.abc_revenue,        // «ABC по р/ц» (колонка UMAG)
      profit: Number(r.profit),
      abcProfit: r.abc_profit,          // «ABC по прибыли» (колонка UMAG)
      abcCombined: r.abc_combined,      // «Свод» (колонка UMAG)
      hint: r.hint,                     // наше: две буквы владельцу ничего не говорят
    }));
    const count = (g: string) => items.filter((i: any) => i.abcRevenue === g).length;
    return {
      period: p, items,
      summary: { a: count('A'), b: count('B'), c: count('C'), total: items.length },
      // то, ради чего ABC и смотрят
      attention: items.filter((i: any) => i.abcCombined === 'AC' || i.abcCombined === 'CC').slice(0, 10),
    };
  }

  // ==================================================================
  // 8.4 СМЕНЫ И КАССИРЫ
  // ==================================================================
  async cashiers(accountId: string, p: Period) {
    const { rows } = await this.db.raw(`SELECT * FROM cashier_report($1,$2::timestamptz,$3::timestamptz)`,
      [accountId, p.from, p.to]);
    return rows.map((r: any) => ({
      employeeId: r.employee_id, name: r.name, shifts: r.shifts, receipts: r.receipts,
      sales: Number(r.sales),                    // «Сумма по продажам» (UMAG)
      cashless: Number(r.cashless),              // «Безнал» (UMAG)
      refunds: Number(r.refunds),                // «Возврат» (UMAG)
      total: Number(r.total),                    // «Итого = Продажи − Возвраты» (UMAG)
      shiftReports: Number(r.shift_reports),     // «Сумма по отчётам» (UMAG)
      avgReceipt: Number(r.avg_receipt),
      // наше добавление: то, ради чего этот отчёт открывают
      discrepancies: { count: r.discrepancy_count, sum: Number(r.discrepancy_sum) },
      cancelled: { count: r.cancelled_count, sum: Number(r.cancelled_sum) },
      flags: [
        ...(r.discrepancy_count > 0 ? [`Расхождения в ${r.discrepancy_count} сменах на ${Number(r.discrepancy_sum)} ₸`] : []),
        ...(r.cancelled_count > 5 ? [`Много отмен: ${r.cancelled_count} позиций на ${Number(r.cancelled_sum)} ₸`] : []),
      ],
    }));
  }

  /**
   * ОТЧЁТ ПО СКИДКАМ (модель UMAG, раздел «Отчёты по скидкам»).
   *
   * У них столбцы: штрихкод, количество, единица, начальная цена, скидка,
   * цена со скидкой, время продажи. Мы повторяем их набор и добавляем ДВА
   * своих столбца, которых у них нет:
   *
   *   · КТО ДАЛ СКИДКУ — без этого отчёт показывает, что деньги ушли,
   *     но не показывает кому предъявить вопрос. Скидка «своим» — самый
   *     частый способ увести деньги из кассы;
   *   · ДОЛЯ ОТ ЦЕНЫ — 200 тенге с чашки кофе и 200 тенге с телевизора
   *     это разные вещи, а в столбце суммы выглядят одинаково.
   *
   * Возвраты исключены: вернули товар — скидки по нему не было.
   */
  async discounts(accountId: string, p: Period) {
    return this.db.withTenant(accountId, async (c) => {
      const rows = (await c.query(
        `SELECT si.id, p.name AS product,
                (SELECT b.code FROM barcode b WHERE b.product_id = p.id ORDER BY b.is_primary DESC LIMIT 1) AS barcode,
                u.short_name AS unit,
                si.qty, si.price AS base_price, si.discount_sum, si.discount_percent,
                (si.price * si.qty - si.discount_sum) AS paid_sum,
                s.created_at, s.number AS receipt,
                e.first_name AS cashier, cr.name AS register
           FROM sale_item si
           JOIN sale s ON s.id = si.sale_id
           JOIN product p ON p.id = si.product_id
           LEFT JOIN unit u ON u.id = p.unit_id
           LEFT JOIN employee e ON e.id = s.employee_id
           LEFT JOIN cash_register cr ON cr.id = s.cash_register_id
          WHERE s.account_id = $1 AND s.created_at >= $2 AND s.created_at < $3
            AND s.return_of_id IS NULL AND si.discount_sum > 0
          ORDER BY s.created_at DESC
          LIMIT 500`, [accountId, p.from, p.to])).rows;

      const items = rows.map((r: any) => {
        const base = Number(r.base_price) * Number(r.qty);
        const disc = Number(r.discount_sum);
        return {
          id: r.id, product: r.product, barcode: r.barcode, unit: r.unit ?? 'шт',
          qty: Number(r.qty), basePrice: Number(r.base_price), baseSum: base,
          discount: disc,
          discountShare: base > 0 ? Math.round((disc / base) * 1000) / 10 : 0,  // доля от цены, %
          paid: Number(r.paid_sum),
          cashier: r.cashier, register: r.register, receipt: r.receipt, at: r.created_at,
        };
      });

      // Сводка по кассирам: кто сколько раздал. Главный вопрос владельца
      // не «сколько скидок», а «почему у одного их втрое больше».
      const byCashier = new Map<string, { cashier: string; count: number; sum: number }>();
      for (const it of items) {
        const key = it.cashier ?? '—';
        const cur = byCashier.get(key) ?? { cashier: key, count: 0, sum: 0 };
        cur.count++; cur.sum += it.discount;
        byCashier.set(key, cur);
      }

      return {
        items,
        total: items.reduce((a, b) => a + b.discount, 0),
        count: items.length,
        byCashier: [...byCashier.values()].sort((a, b) => b.sum - a.sum),
      };
    });
  }

  /** Список смен + детальный отчёт (модель UMAG: приход, расход, остатки). */
  async shifts(accountId: string, p: Period) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT sh.id, sh.number, sh.status, sh.opened_at, sh.closed_at, sh.opening_float,
                sh.cash_sales, sh.card_sales, sh.qr_sales, sh.credit_sales, sh.returns_sum,
                sh.expected_cash, sh.actual_cash, sh.discrepancy, sh.discrepancy_comment,
                sh.receipts_count, cr.name AS register, e.first_name AS cashier,
                -- Прибыль за смену: выручка минус себестоимость проданного.
                -- У UMAG эта колонка есть, и она отвечает на главный вопрос
                -- владельца: смена наторговала — но заработала ли.
                -- Возвраты вычитаются: вернули товар — прибыли не было.
                coalesce((SELECT sum((si.price - si.discount_sum / nullif(si.qty,0)) * si.qty - si.cost * si.qty)
                            FROM sale s2 JOIN sale_item si ON si.sale_id = s2.id
                           WHERE s2.shift_id = sh.id AND s2.return_of_id IS NULL), 0) AS profit,
                -- Скидок отдано за смену: сколько денег роздано «по-доброму».
                coalesce((SELECT sum(s3.discount_sum) FROM sale s3
                           WHERE s3.shift_id = sh.id AND s3.return_of_id IS NULL), 0) AS discounts_given
           FROM shift sh
           LEFT JOIN cash_register cr ON cr.id = sh.cash_register_id
           LEFT JOIN employee e ON e.id = coalesce(sh.closed_by, sh.opened_by)
          WHERE sh.opened_at >= $1::timestamptz AND sh.opened_at <= $2::timestamptz
          ORDER BY sh.opened_at DESC`, [p.from, p.to])).rows
        .map((r: any) => ({
          ...r,
          opening_float: Number(r.opening_float), cash_sales: Number(r.cash_sales),
          card_sales: Number(r.card_sales), qr_sales: Number(r.qr_sales),
          credit_sales: Number(r.credit_sales), returns_sum: Number(r.returns_sum),
          profit: Number(r.profit), discounts_given: Number(r.discounts_given),
          expected_cash: r.expected_cash == null ? null : Number(r.expected_cash),
          actual_cash: r.actual_cash == null ? null : Number(r.actual_cash),
          discrepancy: r.discrepancy == null ? null : Number(r.discrepancy),
        })));
  }

  /** Детальный отчёт по смене — вкладка «Обзор» UMAG. */
  async shiftDetail(accountId: string, shiftId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM shift_totals($1,$2)`, [accountId, shiftId]);
    const t = rows[0];
    if (!t) return null;
    return this.db.withTenant(accountId, async (c) => {
      const sh = (await c.query(
        `SELECT sh.*, cr.name AS register, e.first_name AS cashier FROM shift sh
           LEFT JOIN cash_register cr ON cr.id = sh.cash_register_id
           LEFT JOIN employee e ON e.id = coalesce(sh.closed_by, sh.opened_by)
          WHERE sh.id=$1`, [shiftId])).rows[0];
      const n = (v: any) => Number(v ?? 0);
      const income = n(t.cash) + n(t.deposits);
      const outcome = n(t.withdrawals) + n(t.returns_sum);
      return {
        shift: { number: sh.number, register: sh.register, cashier: sh.cashier,
                 openedAt: sh.opened_at, closedAt: sh.closed_at, status: sh.status },
        // структура вкладки «Обзор» UMAG
        cash: {
          opening: n(t.opening_float),      // остаток на начало смены
          income,                            // приход: продажи, внесения
          outcome,                           // расход: изъятия, возвраты
          expected: n(t.expected_cash),      // остаток на конец
          actual: sh.actual_cash == null ? null : n(sh.actual_cash),
          discrepancy: sh.discrepancy == null ? null : n(sh.discrepancy),
          discrepancyComment: sh.discrepancy_comment,
        },
        revenue: { total: n(t.revenue), cash: n(t.cash), card: n(t.card), qr: n(t.qr), credit: n(t.credit) },
        profit: n(t.profit), receipts: t.receipts, returns: n(t.returns_sum),
      };
    });
  }

  // ==================================================================
  // 8.5 ПРИБЫЛЬНОСТЬ ПО ТОВАРАМ
  // ==================================================================
  async profitability(accountId: string, p: Period, limit = 50) {
    const items = await this.salesByProduct(accountId, p, { limit: 500 });
    const sorted = [...items].sort((a, b) => b.profit - a.profit);
    const totalProfit = items.reduce((s, i) => s + i.profit, 0);
    return {
      period: p,
      totalProfit,
      top: sorted.slice(0, limit),
      // товары, которые продаются в минус: сюда владелец должен смотреть первым делом
      losing: items.filter((i) => i.profit < 0).sort((a, b) => a.profit - b.profit),
      zeroMargin: items.filter((i) => i.profit >= 0 && i.marginPercent < 5).slice(0, 20),
    };
  }

  // ==================================================================
  // 8.6 СВОДНЫЙ ОТЧЁТ ПО ККМ — идея Wipon
  // ==================================================================
  async kkmSummary(accountId: string, cashRegisterId: string, p: Period) {
    const { rows } = await this.db.raw(`SELECT * FROM kkm_summary($1,$2,$3::timestamptz,$4::timestamptz)`,
      [accountId, cashRegisterId, p.from, p.to]);
    const r = rows[0];
    const sections = await this.db.raw(`SELECT * FROM kkm_sections($1,$2,$3::timestamptz,$4::timestamptz)`,
      [accountId, cashRegisterId, p.from, p.to]);
    const n = (v: any) => Number(v ?? 0);

    const info = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        // «Данные организации» (Wipon) — это юрлицо с ИИН/БИН, а не учётная
        // запись: в одном аккаунте может быть несколько организаций.
        `SELECT coalesce(o.name, a.name) AS organization, o.tin AS bin, cr.name AS register,
                k.reg_number, k.serial_number, k.provider::text, k.mode::text
           FROM cash_register cr
           CROSS JOIN account a
           LEFT JOIN kkm k ON k.cash_register_id = cr.id AND k.deleted_at IS NULL
           LEFT JOIN organization o ON o.account_id = a.id AND o.deleted_at IS NULL AND o.is_default
          WHERE cr.id = $1 AND a.id = $2`, [cashRegisterId, accountId])).rows[0]);

    return {
      period: p,
      // «Данные организации и ККМ» (Wipon)
      organization: info?.organization, bin: info?.bin,
      kkm: { register: info?.register, regNumber: info?.reg_number, serial: info?.serial_number,
             provider: info?.provider, mode: info?.mode },
      // «Суммы продаж, возвратов»
      sales: { count: r.sales_count, sum: n(r.sales_sum) },
      refunds: { count: r.refunds_count, sum: n(r.refunds_sum) },
      // «Движение денежных средств по типам оплаты»
      payments: { cash: n(r.cash_sum), card: n(r.card_sum), qr: n(r.qr_sum), credit: n(r.credit_sum) },
      // «Операции внесения и изъятия наличных»
      cashOps: { deposits: n(r.deposits), withdrawals: n(r.withdrawals) },
      // «Остаток денег в кассе на начало и конец периода»
      cash: { opening: n(r.opening_cash), closing: n(r.closing_cash) },
      shifts: r.shifts_count,
      // наше: раз это отчёт по ККМ, показываем и состояние фискализации
      fiscal: { ok: r.fiscal_ok, pending: r.fiscal_pending },
      // «Разбивка оборотов по секциям» — у нас секции это категории товаров
      sections: sections.rows.map((s: any) => ({
        section: s.section, qty: Number(s.qty), revenue: Number(s.revenue),
      })),
    };
  }

  /** Печать сводного отчёта на чековой ленте (Wipon умеет — и мы умеем). */
  async kkmSummaryReceipt(accountId: string, cashRegisterId: string, p: Period, width = 32) {
    const s = await this.kkmSummary(accountId, cashRegisterId, p);
    const line = (l: string, r: string) => {
      const dots = Math.max(1, width - l.length - r.length);
      return l + ' '.repeat(dots) + r;
    };
    const money = (v: number) => `${v.toFixed(2)}`;
    const rows: string[] = [
      center('СВОДНЫЙ ОТЧЁТ', width),
      center(String(s.organization ?? ''), width),
      `Касса: ${s.kkm.register ?? ''}`,
      ...(s.kkm.regNumber ? [`РНМ: ${s.kkm.regNumber}`] : []),
      ...(s.kkm.serial ? [`ЗНМ: ${s.kkm.serial}`] : []),
      '-'.repeat(width),
      line('Смен:', String(s.shifts)),
      line('Чеков:', String(s.sales.count)),
      line('Продажи:', money(s.sales.sum)),
      line('Возвраты:', money(s.refunds.sum)),
      '-'.repeat(width),
      line('Наличные:', money(s.payments.cash)),
      line('Карта:', money(s.payments.card)),
      line('QR:', money(s.payments.qr)),
      ...(s.payments.credit ? [line('В долг:', money(s.payments.credit))] : []),
      '-'.repeat(width),
      line('Внесения:', money(s.cashOps.deposits)),
      line('Изъятия:', money(s.cashOps.withdrawals)),
      line('В кассе на начало:', money(s.cash.opening)),
      line('В кассе на конец:', money(s.cash.closing)),
      '-'.repeat(width),
      ...(s.sections.length ? [center('ПО СЕКЦИЯМ', width),
        ...s.sections.map((x: any) => line(x.section.slice(0, width - 12), money(x.revenue)))] : []),
    ];
    return { text: rows.join('\n'), summary: s };
  }

  // ==================================================================
  // 8.7 МОБИЛЬНЫЙ РЕЖИМ ВЛАДЕЛЬЦА
  // Паритет главной фишке UMAG: показатели магазина в кармане.
  // Всё одним запросом — владелец открывает телефон в подвале магазина.
  // ==================================================================
  async ownerMobile(accountId: string, storeIds?: string[]) {
    const today = await this.dayFor(accountId);
    const yesterday = this.day(-1);
    const week = this.quickPeriod('week');

    const [d, y, chart, accounts, sync, top, low, shifts] = await Promise.all([
      this.dashboardDay(accountId, today, storeIds),
      this.dashboardDay(accountId, yesterday, storeIds),
      this.revenueChart(accountId, week, storeIds),
      this.accountsBoard(accountId),
      this.syncBoard(accountId),
      this.salesByProduct(accountId, today, { limit: 5 }),
      // «Что заканчивается» — единственное, чего не хватало мобильному.
      // Идёт СЕДЬМЫМ в том же наборе, а не отдельным запросом: в областях
      // связь медленная, и два ожидания вместо одного заметны на телефоне.
      this.lowStockShort(accountId),
      // Открытые смены — восьмым в том же наборе. «Какие точки открылись» —
      // одна из главных причин лезть в телефон: владелец видит, что смена
      // не открыта в девять утра, и звонит продавцу, а не узнаёт вечером.
      this.openShifts(accountId),
    ]);

    const delta = y.revenue > 0 ? Math.round(((d.revenue - y.revenue) / y.revenue) * 100) : null;
    const problems: string[] = [];
    for (const s of sync) if (s.status === 'red') problems.push(`Касса «${s.cashRegister}»: ${s.message}`);
    for (const a of accounts) if (a.problem) problems.push(`Счёт «${a.name}»: минус ${a.balance} ₸`);

    return {
      today: {
        revenue: d.revenue, receipts: d.receipts, avgReceipt: d.avgReceipt,
        grossProfit: d.grossProfit, marginPercent: d.marginPercent,
      },
      // «на сколько лучше вчерашнего» — первое, что хочет знать владелец
      vsYesterday: { revenue: y.revenue, deltaPercent: delta },
      week: chart,
      money: { total: accounts.reduce((s: number, a: any) => s + a.balance, 0), accounts },
      problems,                                  // если пусто — всё спокойно
      topProducts: top.map((t) => ({ name: t.name, qty: t.qtySold, revenue: t.revenue, profit: t.profit })),
      // Пять самых острых позиций и общее число: владельцу с телефона
      // нужен не полный список из сорока, а «что везти сегодня».
      lowStock: low,
      openShifts: shifts,
      // Число точек, а не смен: на одной точке может быть две кассы, и
      // «открыто 2» при одном работающем магазине сбивает с толку.
      openStoresCount: new Set(shifts.map((x: any) => x.store)).size,
    };
  }

  /**
   * Отчёт по консультантам (часть 18). UMAG лишь «ведёт статистику» —
   * мы считаем «к выплате»: (выручка − возвраты по его чекам) × процент.
   */
  async consultants(accountId: string, p: Period) {
    const { rows } = await this.db.raw(
      `SELECT * FROM consultant_report($1,$2,$3)`, [accountId, p.from, p.to]);
    return rows.map((r: any) => ({
      consultantId: r.consultant_id, name: r.name,
      commissionPercent: Number(r.commission_percent),
      receipts: r.receipts, revenue: Number(r.revenue), refunds: Number(r.refunds),
      base: Number(r.base), commission: Number(r.commission),
    }));
  }
}

function center(s: string, width: number) {
  const pad = Math.max(0, Math.floor((width - s.length) / 2));
  return ' '.repeat(pad) + s;
}
