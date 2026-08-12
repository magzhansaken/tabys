import { PoolClient } from 'pg';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DbService } from '../db/db.service';

/**
 * ЛОЯЛЬНОСТЬ И МАРКЕТИНГ.
 *
 * Эталон — Wipon Cashback. У UMAG модуля лояльности нет вообще: в карточке
 * покупателя есть поле «бонусы», но программы, которая их начисляет, в
 * документации не описано. Это наше видимое преимущество №2 после офлайна.
 *
 * Два отличия от Wipon, оба принципиальные:
 *
 * 1. У них бесплатная версия урезана до одной программы и ручного добавления
 *    клиентов; аналитика, уровни, дни рождения — за деньги, Wallet только в
 *    тарифе PRO. У нас всё входит в тариф: для магазина у дома лояльность и
 *    есть способ конкурировать с сетью через дорогу.
 *
 * 2. Акций (N+1, счастливые часы) нет ни у кого из троих. При этом «третий
 *    кофе бесплатно» — то, чем магазин у дома живёт.
 */

export interface SmsGateway {
  readonly name: string;
  send(phone: string, text: string): Promise<{ ok: boolean; error?: string; cost?: number }>;
  balance?(): Promise<number>;
}

/**
 * SMS-шлюз Казахстана (Mobizon, SMSC).
 *
 * ЧЕСТНО: договор со шлюзом — открытый вопрос с Части 1, внешние домены здесь
 * закрыты. Форма зафиксирована, отправка подключается за день.
 */
export class KzSmsGateway implements SmsGateway {
  readonly name = 'kz_sms';
  private log = new Logger('Sms');
  async send(phone: string, text: string) {
    this.log.warn(`SMS на ${phone}: шлюз не подключён — нужен договор с Mobizon или SMSC`);
    return { ok: false, error: 'SMS-шлюз не настроен: нужен договор с оператором рассылок' };
  }
}

export class MockSmsGateway implements SmsGateway {
  readonly name = 'mock';
  sent: { phone: string; text: string }[] = [];
  failNext = 0;
  async send(phone: string, text: string) {
    if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'Оператор недоступен' }; }
    this.sent.push({ phone, text });
    return { ok: true, cost: smsCost(text).cost };
  }
}

/**
 * Стоимость SMS. Wipon считает её «на основе количества клиентов и длины и
 * языка текста» — язык здесь ключевой: латиница помещается по 160 символов в
 * сегмент, кириллица только по 67. Один и тот же текст по-русски стоит вдвое
 * дороже, и владелец должен видеть это ДО отправки, а не в счёте.
 */
export function smsCost(text: string, pricePerSegment = 6) {
  const hasCyrillic = /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/.test(text);
  const limit = hasCyrillic ? 70 : 160;
  const multiLimit = hasCyrillic ? 67 : 153;   // в склейке часть символов уходит на заголовок
  const len = text.length;
  const segments = len <= limit ? 1 : Math.ceil(len / multiLimit);
  return {
    encoding: hasCyrillic ? 'кириллица' : 'латиница',
    length: len, segments, cost: segments * pricePerSegment,
    hint: hasCyrillic && len > limit
      ? `Кириллица помещается по ${limit} символов. Текст займёт ${segments} SMS — латиницей влез бы в ${Math.ceil(len / 153)}`
      : undefined,
  };
}

@Injectable()
export class LoyaltyService {
  private log = new Logger('Loyalty');
  private sms: SmsGateway = new KzSmsGateway();
  constructor(private db: DbService) {}

  setSmsGateway(g: SmsGateway) { this.sms = g; }

  // ==================================================================
  // 10.1 БОНУСНЫЕ ПРОГРАММЫ
  // ==================================================================
  async createProgram(accountId: string, dto: {
    kind?: 'cashback' | 'birthday' | 'welcome'; name: string;
    earnPercent?: number; spendPercent?: number; maxSpend?: number;
    minPurchase?: number; expireDays?: number; bonusAmount?: number;
    bonusValidDays?: number; earnDelayDays?: number; storeId?: string;
  }) {
    const kind = dto.kind ?? 'cashback';
    // границы из документации Wipon: не даём выставить бессмысленное
    if (dto.earnPercent != null && (dto.earnPercent < 0 || dto.earnPercent > 10))
      throw new BadRequestException('Процент начисления — от 0 до 10%');
    if (dto.spendPercent != null && (dto.spendPercent < 0 || dto.spendPercent > 90))
      throw new BadRequestException('Процент списания — от 0 до 90% суммы чека');
    if (dto.expireDays != null && (dto.expireDays < 10 || dto.expireDays > 360))
      throw new BadRequestException('Срок сгорания бонусов — от 10 до 360 дней');
    if (kind !== 'cashback' && dto.bonusAmount != null && (dto.bonusAmount < 10 || dto.bonusAmount > 5000))
      throw new BadRequestException('Сумма бонуса — от 10 до 5 000 ₸');

    return this.db.withTenant(accountId, async (c) => {
      // одна активная программа каждого вида: две «накопительные» сразу —
      // это вопрос «а какая из них сработала?»
      await c.query(
        `UPDATE loyalty_program SET is_active=false
          WHERE kind=$1::loyalty_kind AND is_active AND deleted_at IS NULL`, [kind]);
      const { rows } = await c.query(
        `INSERT INTO loyalty_program (account_id, kind, name, earn_percent, spend_percent, max_spend,
                                      min_purchase, expire_days, bonus_amount, bonus_valid_days,
                                      earn_delay_days, store_id)
         VALUES ($1,$2::loyalty_kind,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8,
                 $9::numeric,$10,$11,$12) RETURNING *`,
        [accountId, kind, dto.name, dto.earnPercent ?? 3, dto.spendPercent ?? 50,
         dto.maxSpend ?? 5000, dto.minPurchase ?? 1000, dto.expireDays ?? 180,
         dto.bonusAmount ?? null, dto.bonusValidDays ?? null, dto.earnDelayDays ?? 0, dto.storeId ?? null]);
      return rows[0];
    });
  }

  async programs(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT * FROM loyalty_program WHERE deleted_at IS NULL ORDER BY kind, created_at DESC`)).rows
        .map((r: any) => ({
          ...r, earn_percent: Number(r.earn_percent), spend_percent: Number(r.spend_percent),
          max_spend: Number(r.max_spend), min_purchase: Number(r.min_purchase),
          bonus_amount: r.bonus_amount == null ? null : Number(r.bonus_amount),
        })));
  }

  /** Регистрация клиента в программе: приветственные бонусы (Wipon). */
  async joinLoyalty(accountId: string, counterpartyId: string, birthday?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cp = (await c.query(`SELECT id, name, joined_loyalty_at FROM counterparty WHERE id=$1`, [counterpartyId])).rows[0];
      if (!cp) throw new BadRequestException('Клиент не найден');
      if (cp.joined_loyalty_at) return { joined: false, reason: 'Клиент уже в программе' };

      // номер карты: по нему клиента находят на кассе и в Wallet
      const card = randomBytes(6).toString('hex').toUpperCase();
      await c.query(
        `UPDATE counterparty SET joined_loyalty_at=now(), loyalty_card=$2, birthday=coalesce($3::date, birthday)
          WHERE id=$1`, [counterpartyId, card, birthday ?? null]);

      const welcome = (await c.query(
        `SELECT * FROM loyalty_program WHERE kind='welcome' AND is_active AND deleted_at IS NULL LIMIT 1`)).rows[0];
      let bonus = 0;
      if (welcome?.bonus_amount) {
        const expires = welcome.bonus_valid_days
          ? new Date(Date.now() + welcome.bonus_valid_days * 86400000) : null;
        await c.query(
          `SELECT apply_bonus_move($1,$2,$3::numeric,'welcome',$4,NULL,NULL,$5,$6::timestamptz)`,
          [accountId, counterpartyId, welcome.bonus_amount, welcome.id,
           'Приветственные бонусы', expires]);
        bonus = Number(welcome.bonus_amount);
      }
      return { joined: true, card, welcomeBonus: bonus };
    });
  }

  async balance(accountId: string, counterpartyId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const b = (await c.query(
        `SELECT * FROM bonus_balance WHERE counterparty_id=$1`, [counterpartyId])).rows[0];
      const soon = (await c.query(
        `SELECT sum(amount - used_amount) AS s, min(expires_at) AS at FROM bonus_move
          WHERE counterparty_id=$1 AND amount > used_amount AND amount > 0
            AND expires_at IS NOT NULL AND expires_at <= now() + interval '14 days'
            AND expires_at > now()`, [counterpartyId])).rows[0];
      return {
        balance: Number(b?.balance ?? 0),
        earnedTotal: Number(b?.earned_total ?? 0),
        spentTotal: Number(b?.spent_total ?? 0),
        expiredTotal: Number(b?.expired_total ?? 0),
        expiringSoon: soon?.s ? { amount: Number(soon.s), at: soon.at } : null,
      };
    });
  }

  /**
   * Сколько бонусов можно списать в этом чеке.
   * Ограничений три (все из Wipon): процент от чека, максимум за раз, баланс.
   */
  async spendable(accountId: string, counterpartyId: string, saleTotal: number) {
    return this.db.withTenant(accountId, async (c) => {
      const p = (await c.query(
        `SELECT * FROM loyalty_program WHERE kind='cashback' AND is_active AND deleted_at IS NULL LIMIT 1`)).rows[0];
      if (!p) return { canSpend: 0, reason: 'Бонусная программа не настроена' };

      const bal = Number((await c.query(
        `SELECT balance FROM bonus_balance WHERE counterparty_id=$1`, [counterpartyId])).rows[0]?.balance ?? 0);
      if (bal <= 0) return { canSpend: 0, reason: 'У клиента нет бонусов' };

      const byPercent = Math.floor(saleTotal * Number(p.spend_percent) / 100);
      const byMax = Number(p.max_spend);
      const canSpend = Math.min(bal, byPercent, byMax);

      return {
        canSpend, balance: bal,
        limits: { byPercent, byMax, byBalance: bal },
        reason: canSpend === 0 ? 'Сумма чека слишком мала для списания' : undefined,
        // объясняем, почему нельзя списать всё: кассиру придётся это сказать вслух
        hint: canSpend < bal
          ? (byPercent < byMax
              ? `Списать можно не больше ${Number(p.spend_percent)}% чека — это ${byPercent} ₸`
              : `Максимум за одну покупку — ${byMax} ₸`)
          : undefined,
      };
    });
  }

  /** Списание бонусов в оплату чека. */
  async spend(accountId: string, dto: { counterpartyId: string; saleId: string; amount: number; saleTotal: number; employeeId?: string }) {
    const s = await this.spendable(accountId, dto.counterpartyId, dto.saleTotal);
    if (dto.amount > s.canSpend)
      throw new BadRequestException(s.hint ?? `Можно списать не больше ${s.canSpend} ₸`);
    const { rows } = await this.db.raw(`SELECT * FROM spend_bonuses($1,$2,$3::numeric,$4,$5)`,
      [accountId, dto.counterpartyId, dto.amount, dto.saleId, dto.employeeId ?? null]);
    return { spent: Number(rows[0].spent), balance: Number(rows[0].new_balance) };
  }

  /**
   * Начисление бонусов за покупку.
   *
   * Начисляем на сумму ПОСЛЕ скидок — на те деньги, которые покупатель реально
   * заплатил. МойСклад решает конфликт запретом («накопительные и персональные
   * скидки не применяются одновременно с бонусной программой»); мы просто не
   * платим бонусами за скидку, которую сами же и дали. И не начисляем бонусы
   * на бонусы: иначе получается вечный двигатель.
   */
  async earn(accountId: string, saleId: string) {
    return this.db.withTenant(accountId, (c) => this.earnTx(c, accountId, saleId));
  }

  /**
   * Транзакционная версия (часть 17): вызывается кассовым обработчиком
   * ВНУТРИ транзакции офлайн-чека — начисление и чек либо вместе, либо никак.
   */
  async earnTx(c: PoolClient, accountId: string, saleId: string) {
    {
      const s = (await c.query(
        `SELECT * FROM sale WHERE id=$1 AND status='completed' AND return_of_id IS NULL`, [saleId])).rows[0];
      if (!s) return { earned: 0, reason: 'Чек не найден или это возврат' };
      if (!s.customer_id) return { earned: 0, reason: 'Чек без покупателя' };

      const done = (await c.query(
        `SELECT 1 FROM bonus_move WHERE sale_id=$1 AND reason='earn' LIMIT 1`, [saleId])).rows[0];
      if (done) return { earned: 0, reason: 'Бонусы за этот чек уже начислены' };

      const p = (await c.query(
        `SELECT * FROM loyalty_program WHERE kind='cashback' AND is_active AND deleted_at IS NULL
            AND (store_id IS NULL OR store_id = $1) ORDER BY store_id NULLS LAST LIMIT 1`, [s.store_id])).rows[0];
      if (!p) return { earned: 0, reason: 'Бонусная программа не настроена' };

      // сумма, с которой считаем: чек минус то, что оплачено бонусами
      const paidByBonus = Number(s.paid_bonus ?? 0);
      const base = Number(s.total) - paidByBonus;
      if (base < Number(p.min_purchase))
        return { earned: 0, reason: `Бонусы начисляются от ${Number(p.min_purchase)} ₸ (в чеке ${base} ₸)` };

      const amount = Math.floor(base * Number(p.earn_percent) / 100);
      if (amount <= 0) return { earned: 0, reason: 'Сумма начисления округлилась до нуля' };

      const expires = p.expire_days ? new Date(Date.now() + p.expire_days * 86400000) : null;
      const { rows } = await c.query(
        `SELECT * FROM apply_bonus_move($1,$2,$3::numeric,'earn',$4,$5,$6,NULL,$7::timestamptz)`,
        [accountId, s.customer_id, amount, p.id, saleId, s.employee_id, expires]);

      return {
        earned: amount, balance: Number(rows[0].new_balance), expiresAt: expires,
        // это печатается на чеке: клиент должен знать, что получил и когда сгорит
        receiptLine: `Начислено бонусов: ${amount} ₸${expires ? `, действуют до ${expires.toLocaleDateString('ru-RU')}` : ''}`,
      };
    }
  }

  /**
   * Возврат покупки: начисленные бонусы отзываем, потраченные возвращаем.
   * Иначе возврат превращается в способ печатать бонусы.
   */
  async handleRefund(accountId: string, refundSaleId: string, originalSaleId: string) {
    return this.db.withTenant(accountId, (c) => this.handleRefundTx(c, accountId, refundSaleId, originalSaleId));
  }

  async handleRefundTx(c: PoolClient, accountId: string, refundSaleId: string, originalSaleId: string) {
    {
      const orig = (await c.query(`SELECT customer_id FROM sale WHERE id=$1`, [originalSaleId])).rows[0];
      if (!orig?.customer_id) return { revoked: 0, returned: 0 };

      const earned = Number((await c.query(
        `SELECT coalesce(sum(amount), 0) AS s FROM bonus_move
          WHERE sale_id=$1 AND reason='earn'`, [originalSaleId])).rows[0].s);
      const spent = Number((await c.query(
        `SELECT coalesce(sum(-amount), 0) AS s FROM bonus_move
          WHERE sale_id=$1 AND reason='spend'`, [originalSaleId])).rows[0].s);

      let revoked = 0, returned = 0;
      if (earned > 0) {
        const bal = Number((await c.query(
          `SELECT balance FROM bonus_balance WHERE counterparty_id=$1`, [orig.customer_id])).rows[0]?.balance ?? 0);
        // если клиент уже потратил начисленное — в минус не уводим
        revoked = Math.min(earned, bal);
        if (revoked > 0)
          await c.query(
            `SELECT apply_bonus_move($1,$2,$3::numeric,'refund_revoke',NULL,$4,NULL,$5,NULL)`,
            [accountId, orig.customer_id, -revoked, refundSaleId, 'Возврат покупки: начисленные бонусы отозваны']);
      }
      if (spent > 0) {
        returned = spent;
        await c.query(
          `SELECT apply_bonus_move($1,$2,$3::numeric,'refund_return',NULL,$4,NULL,$5,NULL)`,
          [accountId, orig.customer_id, returned, refundSaleId, 'Возврат покупки: потраченные бонусы возвращены']);
      }
      return { revoked, returned };
    }
  }

  /** Бонусы ко дню рождения — начисляются автоматически (Wipon). */
  async grantBirthdayBonuses(accountId: string) {
    const clients = (await this.db.raw(`SELECT * FROM birthday_clients($1)`, [accountId])).rows;
    if (!clients.length) return { granted: 0, clients: [] as any[] };

    return this.db.withTenant(accountId, async (c) => {
      const p = (await c.query(
        `SELECT * FROM loyalty_program WHERE kind='birthday' AND is_active AND deleted_at IS NULL LIMIT 1`)).rows[0];
      if (!p?.bonus_amount) return { granted: 0, clients: [] as any[], reason: 'Программа «День рождения» не настроена' };

      const out: any[] = [];
      for (const cl of clients as any[]) {
        const expires = p.bonus_valid_days ? new Date(Date.now() + p.bonus_valid_days * 86400000) : null;
        await c.query(
          `SELECT apply_bonus_move($1,$2,$3::numeric,'birthday',$4,NULL,NULL,$5,$6::timestamptz)`,
          [accountId, cl.counterparty_id, p.bonus_amount, p.id, 'Бонусы ко дню рождения', expires]);
        out.push({ name: cl.name, phone: cl.phone, amount: Number(p.bonus_amount), expiresAt: expires });
      }
      return { granted: out.length, clients: out };
    });
  }

  /** Сгорание бонусов. Запускается по расписанию. */
  async expireBonuses(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM expire_bonuses($1)`, [accountId]);
    return { clients: rows.length, total: rows.reduce((s: number, r: any) => s + Number(r.expired), 0) };
  }

  /** Кому скоро сгорят бонусы — повод для рассылки. */
  async expiringSoon(accountId: string, days = 14) {
    const { rows } = await this.db.raw(`SELECT * FROM bonuses_expiring($1,$2)`, [accountId, days]);
    return rows.map((r: any) => ({
      counterpartyId: r.counterparty_id, name: r.name, phone: r.phone,
      amount: Number(r.amount), expiresAt: r.expires_at,
    }));
  }

  // ==================================================================
  // 10.2 АКЦИИ — нет ни у Wipon, ни у UMAG, ни у МоегоСклада
  // ==================================================================
  async createPromo(accountId: string, dto: {
    kind: 'n_plus_one' | 'happy_hours'; name: string;
    productId?: string; categoryId?: string; storeId?: string;
    buyQty?: number; freeQty?: number;
    percent?: number; hourFrom?: number; hourTo?: number; weekdays?: number[];
    startsAt?: string; endsAt?: string;
  }) {
    if (!dto.productId && !dto.categoryId)
      throw new BadRequestException('Выберите товар или категорию для акции');
    if (dto.kind === 'n_plus_one' && !(dto.buyQty > 0))
      throw new BadRequestException('Укажите, сколько нужно купить (например, 2 — тогда третий бесплатно)');
    if (dto.kind === 'happy_hours') {
      if (!(dto.percent > 0 && dto.percent <= 100)) throw new BadRequestException('Укажите процент скидки');
      if (dto.hourFrom == null || dto.hourTo == null) throw new BadRequestException('Укажите часы акции');
    }

    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO promo (account_id, kind, name, product_id, category_id, store_id,
                            buy_qty, free_qty, percent, hour_from, hour_to, weekdays, starts_at, ends_at)
         VALUES ($1,$2::promo_kind,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12::smallint[],$13::timestamptz,$14::timestamptz)
         RETURNING *`,
        [accountId, dto.kind, dto.name, dto.productId ?? null, dto.categoryId ?? null, dto.storeId ?? null,
         dto.buyQty ?? null, dto.freeQty ?? 1, dto.percent ?? null,
         dto.hourFrom ?? null, dto.hourTo ?? null, dto.weekdays ?? null,
         dto.startsAt ?? null, dto.endsAt ?? null]);
      return rows[0];
    });
  }

  /**
   * Подобрать акции для корзины. Считается на кассе, поэтому правило простое
   * и не требует сервера.
   */
  async applyPromos(accountId: string, saleId: string, at?: Date) {
    const now = at ?? new Date();
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(`SELECT * FROM sale WHERE id=$1`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');

      const items = (await c.query(
        `SELECT i.*, p.category_id, p.name FROM sale_item i JOIN product p ON p.id = i.product_id
          WHERE i.sale_id=$1`, [saleId])).rows;
      if (!items.length) return { applied: [] as any[], totalDiscount: 0 };

      const promos = (await c.query(
        `SELECT * FROM promo WHERE is_active AND deleted_at IS NULL
            AND (store_id IS NULL OR store_id = $1)
            AND (starts_at IS NULL OR starts_at <= now())
            AND (ends_at IS NULL OR ends_at >= now())`, [s.store_id])).rows;

      const applied: any[] = [];
      for (const pr of promos) {
        const matching = items.filter((i: any) =>
          (pr.product_id && i.product_id === pr.product_id) ||
          (pr.category_id && i.category_id === pr.category_id));
        if (!matching.length) continue;

        if (pr.kind === 'happy_hours') {
          const hour = now.getHours();
          const weekday = now.getDay() === 0 ? 7 : now.getDay();   // 1=пн … 7=вс
          const inHours = pr.hour_from <= pr.hour_to
            ? hour >= pr.hour_from && hour < pr.hour_to
            : hour >= pr.hour_from || hour < pr.hour_to;           // акция через полночь
          const inDays = !pr.weekdays?.length || pr.weekdays.includes(weekday);
          if (!inHours || !inDays) continue;

          for (const it of matching) {
            const disc = Math.round(Number(it.total) * Number(pr.percent) / 100 * 100) / 100;
            await c.query(
              `UPDATE sale_item SET discount_percent=$2::numeric, discount_sum=$3::numeric,
                      total = qty * price - $3::numeric WHERE id=$1`,
              [it.id, pr.percent, disc]);
            applied.push({ promo: pr.name, kind: pr.kind, product: it.name, discount: disc });
          }
        }

        if (pr.kind === 'n_plus_one') {
          // всего штук подходящих товаров в чеке
          const totalQty = matching.reduce((sum: number, i: any) => sum + Number(i.qty), 0);
          const groupSize = Number(pr.buy_qty) + Number(pr.free_qty);
          const freeCount = Math.floor(totalQty / groupSize) * Number(pr.free_qty);
          if (freeCount <= 0) continue;

          // дарим самое дешёвое: магазин не должен дарить сыр вместо жвачки
          const sorted = [...matching].sort((a, b) => Number(a.price) - Number(b.price));
          let toFree = freeCount;
          for (const it of sorted) {
            if (toFree <= 0) break;
            const n = Math.min(toFree, Number(it.qty));
            const disc = Math.round(n * Number(it.price) * 100) / 100;
            const already = Number(it.discount_sum ?? 0);
            await c.query(
              `UPDATE sale_item SET discount_sum=$2::numeric, total = qty * price - $2::numeric WHERE id=$1`,
              [it.id, already + disc]);
            applied.push({ promo: pr.name, kind: pr.kind, product: it.name, freeQty: n, discount: disc });
            toFree -= n;
          }
        }
      }

      if (applied.length) await this.recalcSale(c, saleId);
      return { applied, totalDiscount: applied.reduce((s: number, a: any) => s + a.discount, 0) };
    });
  }

  private async recalcSale(c: any, saleId: string) {
    await c.query(
      `UPDATE sale SET
         subtotal = coalesce((SELECT sum(qty*price) FROM sale_item WHERE sale_id=$1), 0),
         discount_sum = coalesce((SELECT sum(discount_sum) FROM sale_item WHERE sale_id=$1), 0),
         total = coalesce((SELECT sum(total) FROM sale_item WHERE sale_id=$1), 0),
         cost_total = coalesce((SELECT sum(qty*cost) FROM sale_item WHERE sale_id=$1), 0),
         profit = coalesce((SELECT sum(total - qty*cost) FROM sale_item WHERE sale_id=$1), 0)
       WHERE id=$1`, [saleId]);
  }

  // ==================================================================
  // 10.3 СЕГМЕНТЫ (Wipon: название и цвет) + автоматические
  // ==================================================================
  async createSegment(accountId: string, dto: { name: string; color?: string; autoRule?: 'lapsed' | 'regular' | 'big_check' | 'new' }) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO segment (account_id, name, color, auto_rule) VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, name) DO UPDATE SET color=EXCLUDED.color, deleted_at=NULL
         RETURNING *`,
        [accountId, dto.name, dto.color ?? '#7C3AED', dto.autoRule ?? null]);
      return rows[0];
    });
  }

  async addToSegment(accountId: string, segmentId: string, counterpartyIds: string[]) {
    return this.db.withTenant(accountId, async (c) => {
      let added = 0;
      for (const id of counterpartyIds) {
        const r = await c.query(
          `INSERT INTO segment_member (segment_id, counterparty_id, account_id) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`, [segmentId, id, accountId]);
        added += r.rowCount ?? 0;
      }
      return { added };
    });
  }

  /**
   * Автоматические сегменты. У Wipon клиентов в сегмент добавляют руками —
   * это работает, пока их сорок. Здесь система считает сама, и сегмент не
   * устаревает.
   */
  async refreshAutoSegments(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const segments = (await c.query(
        `SELECT * FROM segment WHERE auto_rule IS NOT NULL AND deleted_at IS NULL`)).rows;
      const out: any[] = [];

      for (const seg of segments) {
        let sql = '';
        switch (seg.auto_rule) {
          case 'lapsed':      // покупал раньше, но давно не заходил
            sql = `SELECT c.id FROM counterparty c
                    WHERE c.account_id=$1 AND c.is_customer AND c.deleted_at IS NULL
                      AND EXISTS (SELECT 1 FROM sale s WHERE s.customer_id=c.id)
                      AND NOT EXISTS (SELECT 1 FROM sale s WHERE s.customer_id=c.id
                                       AND s.completed_at > now() - interval '60 days')`;
            break;
          case 'regular':     // 5+ покупок за два месяца
            sql = `SELECT c.id FROM counterparty c
                    WHERE c.account_id=$1 AND c.is_customer AND c.deleted_at IS NULL
                      AND (SELECT count(*) FROM sale s WHERE s.customer_id=c.id
                            AND s.completed_at > now() - interval '60 days' AND s.return_of_id IS NULL) >= 5`;
            break;
          case 'big_check':   // средний чек выше общего среднего в полтора раза
            sql = `SELECT c.id FROM counterparty c
                    WHERE c.account_id=$1 AND c.is_customer AND c.deleted_at IS NULL
                      AND (SELECT avg(s.total) FROM sale s WHERE s.customer_id=c.id AND s.return_of_id IS NULL) >
                          (SELECT avg(s2.total)*1.5 FROM sale s2 WHERE s2.account_id=$1 AND s2.return_of_id IS NULL)`;
            break;
          case 'new':         // в программе меньше месяца
            sql = `SELECT c.id FROM counterparty c
                    WHERE c.account_id=$1 AND c.is_customer AND c.deleted_at IS NULL
                      AND c.joined_loyalty_at > now() - interval '30 days'`;
            break;
          default: continue;
        }
        const ids = (await c.query(sql, [accountId])).rows.map((r: any) => r.id);
        await c.query(`DELETE FROM segment_member WHERE segment_id=$1`, [seg.id]);
        for (const id of ids)
          await c.query(
            `INSERT INTO segment_member (segment_id, counterparty_id, account_id) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [seg.id, id, accountId]);
        out.push({ segment: seg.name, rule: seg.auto_rule, members: ids.length });
      }
      return out;
    });
  }

  async segments(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT s.id, s.name, s.color, s.auto_rule,
                (SELECT count(*)::int FROM segment_member m WHERE m.segment_id = s.id) AS members
           FROM segment s WHERE s.deleted_at IS NULL ORDER BY s.name`)).rows);
  }

  // ==================================================================
  // 10.4 РАССЫЛКИ
  // ==================================================================

  /** Прогноз стоимости ДО отправки (ключевая деталь Wipon). */
  async estimateCampaign(accountId: string, dto: { text: string; segmentId?: string; counterpartyIds?: string[] }) {
    const recipients = await this.resolveRecipients(accountId, dto.segmentId, dto.counterpartyIds);
    const c = smsCost(dto.text);
    return {
      recipients: recipients.length,
      withoutPhone: recipients.filter((r) => !r.phone).length,
      ...c,
      totalCost: c.cost * recipients.filter((r) => r.phone).length,
    };
  }

  private async resolveRecipients(accountId: string, segmentId?: string, ids?: string[]) {
    return this.db.withTenant(accountId, async (c) => {
      if (segmentId)
        return (await c.query(
          `SELECT cp.id, cp.name, cp.phone FROM segment_member m
             JOIN counterparty cp ON cp.id = m.counterparty_id
            WHERE m.segment_id=$1 AND cp.deleted_at IS NULL`, [segmentId])).rows;
      if (ids?.length)
        return (await c.query(
          `SELECT id, name, phone FROM counterparty WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])).rows;
      return (await c.query(
        `SELECT id, name, phone FROM counterparty
          WHERE is_customer AND deleted_at IS NULL AND archived_at IS NULL AND phone IS NOT NULL`)).rows;
    });
  }

  async createCampaign(accountId: string, dto: {
    name: string; text: string; channel?: 'sms' | 'whatsapp';
    segmentId?: string; counterpartyIds?: string[]; employeeId?: string;
  }) {
    if (!dto.text?.trim()) throw new BadRequestException('Текст сообщения обязателен');
    const est = await this.estimateCampaign(accountId, dto);
    if (!est.recipients) throw new BadRequestException('Некому отправлять: в списке нет клиентов');

    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO campaign (account_id, name, channel, text, segment_id, recipients,
                               segments_per_sms, cost_estimate, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9) RETURNING *`,
        [accountId, dto.name, dto.channel ?? 'sms', dto.text, dto.segmentId ?? null,
         est.recipients, est.segments, est.totalCost, dto.employeeId ?? null]);

      const list = await this.resolveRecipients(accountId, dto.segmentId, dto.counterpartyIds);
      for (const r of list) {
        if (!r.phone) continue;
        await c.query(
          `INSERT INTO campaign_recipient (account_id, campaign_id, counterparty_id, phone)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [accountId, rows[0].id, r.id, r.phone]);
      }
      return { ...rows[0], estimate: est };
    });
  }

  async sendCampaign(accountId: string, campaignId: string) {
    const camp = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM campaign WHERE id=$1`, [campaignId])).rows[0]);
    if (!camp) throw new BadRequestException('Рассылка не найдена');
    if (camp.status === 'sent') return { sent: false, reason: 'Рассылка уже отправлена' };

    await this.db.withTenant(accountId, async (c) =>
      c.query(`UPDATE campaign SET status='sending' WHERE id=$1`, [campaignId]));

    const list = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT * FROM campaign_recipient WHERE campaign_id=$1 AND status='pending'`, [campaignId])).rows);

    let sent = 0, failed = 0, cost = 0;
    for (const r of list) {
      const res = await this.sms.send(r.phone, camp.text);
      await this.db.withTenant(accountId, async (c) =>
        c.query(
          `UPDATE campaign_recipient SET status=$2, error=$3, sent_at=CASE WHEN $2='sent' THEN now() END
            WHERE id=$1`, [r.id, res.ok ? 'sent' : 'failed', res.error ?? null]));
      if (res.ok) { sent++; cost += res.cost ?? 0; } else failed++;
    }

    await this.db.withTenant(accountId, async (c) =>
      c.query(
        `UPDATE campaign SET status=$2, sent_count=$3, failed_count=$4, cost_actual=$5::numeric, sent_at=now()
          WHERE id=$1`,
        [campaignId, failed && !sent ? 'failed' : 'sent', sent, failed, cost]));

    return { sent, failed, cost, gateway: this.sms.name };
  }

  async campaigns(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT c.*, s.name AS segment FROM campaign c LEFT JOIN segment s ON s.id = c.segment_id
          ORDER BY c.created_at DESC LIMIT 100`)).rows
        .map((r: any) => ({
          ...r, cost_estimate: r.cost_estimate == null ? null : Number(r.cost_estimate),
          cost_actual: r.cost_actual == null ? null : Number(r.cost_actual),
        })));
  }

  // ==================================================================
  // 10.5 WALLET-КАРТЫ
  // ==================================================================

  /**
   * Содержимое карты Apple/Google Wallet.
   *
   * ЧЕСТНО: Apple Wallet требует сертификат Pass Type ID (платный аккаунт
   * разработчика), Google Wallet — сервисный аккаунт и Issuer ID. Это не код,
   * это учётные записи и деньги. Wipon держит Wallet в тарифе PRO ровно
   * поэтому.
   *
   * Делаем то, что от нас зависит: содержимое, QR и брендирование. Подписание
   * пасса — когда будут аккаунты.
   */
  async walletCard(accountId: string, counterpartyId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const cp = (await c.query(
        `SELECT c.id, c.name, c.loyalty_card, c.phone, coalesce(b.balance, 0) AS bonuses
           FROM counterparty c LEFT JOIN bonus_balance b ON b.counterparty_id = c.id
          WHERE c.id=$1`, [counterpartyId])).rows[0];
      if (!cp) throw new BadRequestException('Клиент не найден');
      if (!cp.loyalty_card) throw new BadRequestException('Клиент не в программе лояльности');

      const store = (await c.query(
        `SELECT s.name, o.name AS org FROM store s
           CROSS JOIN (SELECT name FROM organization WHERE deleted_at IS NULL
                        ORDER BY is_default DESC LIMIT 1) o LIMIT 1`)).rows[0];
      const prog = (await c.query(
        `SELECT earn_percent FROM loyalty_program WHERE kind='cashback' AND is_active
            AND deleted_at IS NULL LIMIT 1`)).rows[0];

      return {
        // общее содержимое для обеих платформ
        cardNumber: cp.loyalty_card,
        holder: cp.name,
        bonuses: Number(cp.bonuses),
        organization: store?.org ?? store?.name,
        // по QR клиента находят на кассе — сценарий Wipon
        qrData: `LOYALTY:${cp.loyalty_card}`,
        earnPercent: prog ? Number(prog.earn_percent) : null,
        // структура пасса Apple
        applePass: {
          formatVersion: 1,
          organizationName: store?.org ?? store?.name,
          description: 'Карта лояльности',
          storeCard: {
            primaryFields: [{ key: 'balance', label: 'Бонусы', value: `${Number(cp.bonuses)} ₸` }],
            secondaryFields: [{ key: 'holder', label: 'Владелец', value: cp.name }],
            auxiliaryFields: prog ? [{ key: 'earn', label: 'Начисление', value: `${Number(prog.earn_percent)}%` }] : [],
          },
          barcode: { format: 'PKBarcodeFormatQR', message: `LOYALTY:${cp.loyalty_card}`, messageEncoding: 'iso-8859-1' },
        },
        // структура объекта Google Wallet
        googlePass: {
          loyaltyPoints: { label: 'Бонусы', balance: { string: `${Number(cp.bonuses)} ₸` } },
          accountName: cp.name,
          accountId: cp.loyalty_card,
          barcode: { type: 'QR_CODE', value: `LOYALTY:${cp.loyalty_card}` },
        },
        // не выдаём желаемое за действительное
        ready: false,
        note: 'Содержимое карты готово. Для выпуска нужны сертификат Apple Pass Type ID и Issuer ID Google Wallet',
      };
    });
  }

  /** Поиск клиента по карте: касса сканирует QR. */
  async findByCard(accountId: string, card: string) {
    const clean = card.replace(/^LOYALTY:/, '');
    return this.db.withTenant(accountId, async (c) => {
      const r = (await c.query(
        `SELECT c.id, c.name, c.phone, coalesce(b.balance, 0) AS bonuses
           FROM counterparty c LEFT JOIN bonus_balance b ON b.counterparty_id = c.id
          WHERE c.loyalty_card=$1 AND c.deleted_at IS NULL`, [clean])).rows[0];
      if (!r) return null;
      return { id: r.id, name: r.name, phone: r.phone, bonuses: Number(r.bonuses) };
    });
  }

  // ==================================================================
  // АНАЛИТИКА (показатели Wipon)
  // ==================================================================
  async analytics(accountId: string, from: string, to: string) {
    const { rows } = await this.db.raw(`SELECT * FROM loyalty_analytics($1,$2::timestamptz,$3::timestamptz)`,
      [accountId, from, to]);
    const r = rows[0];
    const n = (v: any) => Number(v ?? 0);
    return {
      period: { from, to },
      bonuses: { earned: n(r.earned), spent: n(r.spent), expired: n(r.expired) },
      clients: { total: r.clients_total, active: r.clients_active, withBonuses: r.clients_with_bonuses },
      sales: { withCard: r.sales_with_card, total: r.sales_total, cardShare: n(r.bonus_share) },
      avgCheck: { withCard: n(r.avg_check_card), anonymous: n(r.avg_check_anon) },
      // главный вопрос владельца: окупается ли программа
      effect: n(r.avg_check_card) > n(r.avg_check_anon)
        ? `Клиенты с картой тратят на ${Math.round((n(r.avg_check_card) / Math.max(n(r.avg_check_anon), 1) - 1) * 100)}% больше`
        : 'Клиенты с картой пока не тратят больше остальных',
    };
  }
}
