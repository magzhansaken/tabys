import { Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { PaymentProvider, MockPaymentProvider, KaspiPaymentProvider } from './payment.provider';

/**
 * ТАРИФЫ, БИЛЛИНГ, ЭКСПЛУАТАЦИЯ.
 *
 * UMAG считает по числу касс («количество магазинов и касс по данному тарифу»)
 * и берёт 4 600 ₸ за сотрудника. Мы считаем по торговым точкам: устройства и
 * сотрудники безлимитны — это не наш расход, а продавать безопасность отдельно
 * плохо: без учёток кассиров не работает ни контроль смен, ни отчёт по кассирам.
 *
 * Цена фиксируется в договоре на 12 месяцев — прямой ответ на их рост до +570%,
 * который случился с клиентами, уже перенёсшими туда весь товар.
 */
@Injectable()
export class BillingService {
  constructor(private db: DbService) {}

  // реестр провайдеров оплаты (mock для тестов; kaspi/card по договору)
  private payProviders = new Map<string, PaymentProvider>([['mock', new MockPaymentProvider()]]);
  setPayProvider(name: string, p: PaymentProvider) { this.payProviders.set(name, p); }
  getPayProvider(name: string) { return this.payProviders.get(name); }

  async tariffs() {
    return this.db.raw(`SELECT * FROM tariff WHERE is_public ORDER BY price_month`)
      .then((r) => r.rows.map((t: any) => ({
        ...t, price_month: Number(t.price_month), price_extra_store: Number(t.price_extra_store),
        // то, за что берут конкуренты
        devicesUnlimited: t.devices_limit == null,
        employeesUnlimited: t.employees_limit == null,
      })));
  }

  /** Подключение. Цена запоминается на год — это условие оферты, а не обещание. */
  async subscribe(accountId: string, tariffCode: string, stores = 1) {
    const t = (await this.db.raw(`SELECT * FROM tariff WHERE code=$1`, [tariffCode])).rows[0];
    if (!t) throw new BadRequestException('Тариф не найден');
    const lockedUntil = new Date();
    lockedUntil.setFullYear(lockedUntil.getFullYear() + 1);

    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO subscription (account_id, tariff_id, status, price_locked, price_locked_until,
                                   stores_paid, paid_until)
         VALUES ($1,$2,'trial',$3::numeric,$4::date,$5, current_date + 14)
         ON CONFLICT (account_id) DO UPDATE SET tariff_id=EXCLUDED.tariff_id, stores_paid=EXCLUDED.stores_paid
         RETURNING *`,
        [accountId, t.id, t.price_month, lockedUntil.toISOString().slice(0, 10), stores]);
      return {
        ...rows[0], price_locked: Number(rows[0].price_locked),
        tariff: t.name,
        promise: `Цена ${Number(t.price_month)} ₸ зафиксирована до ${rows[0].price_locked_until}. Изменение — не раньше чем за 60 дней с правом выгрузить данные и уйти`,
      };
    });
  }

  async topup(accountId: string, amount: number, comment?: string) {
    if (!(amount > 0)) throw new BadRequestException('Сумма пополнения должна быть больше нуля');
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `UPDATE subscription SET balance = balance + $2::numeric WHERE account_id=$1 RETURNING *`,
        [accountId, amount])).rows[0];
      if (!s) throw new BadRequestException('Подписка не найдена');
      await c.query(
        `INSERT INTO billing_move (account_id, amount, kind, comment, balance_after)
         VALUES ($1,$2::numeric,'topup',$3,$4::numeric)`, [accountId, amount, comment ?? 'Пополнение', s.balance]);

      // авторазморозка при пополнении — механика UMAG
      let unfrozen = false;
      if (s.status === 'frozen' && s.auto_unfreeze) {
        await c.query(`UPDATE subscription SET status='active', frozen_at=NULL WHERE account_id=$1`, [accountId]);
        unfrozen = true;
      }
      return { balance: Number(s.balance), unfrozen };
    });
  }

  async charge(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM billing_charge($1)`, [accountId]);
    const r = rows[0];
    return {
      charged: Number(r.charged), balance: Number(r.new_balance), status: r.new_status,
      message: r.new_status === 'grace'
        ? 'Денег на счету не хватило. Даём 7 дней — касса работает как обычно'
        : r.new_status === 'readonly'
          ? 'Льготный период кончился: работа только на чтение. Пополните счёт — всё вернётся'
          : undefined,
    };
  }

  /** Заморозка: магазин закрылся на месяц — платить не надо, данные целы. */
  async freeze(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE subscription SET status='frozen', frozen_at=now() WHERE account_id=$1`, [accountId]);
      return { frozen: true, note: 'Данные сохранены. При пополнении счёта работа возобновится' };
    });
  }

  /**
   * Что можно делать при текущем состоянии подписки.
   * Даже в «только чтение» не запрещаем закрыть смену: деньги в ящике надо
   * сдать, а чек из налоговой не отзовёшь.
   */
  async access(accountId: string) {
    const s = await this.db.withTenant(accountId, async (c) =>
      (await c.query(`SELECT * FROM subscription WHERE account_id=$1`, [accountId])).rows[0]);
    if (!s) return { canSell: false, canRead: false, reason: 'Нет подписки' };
    const active = ['trial', 'active', 'grace'].includes(s.status);
    return {
      status: s.status, canSell: active, canRead: s.status !== 'cancelled',
      canCloseShift: s.status !== 'cancelled',
      balance: Number(s.balance), paidUntil: s.paid_until,
      priceLocked: Number(s.price_locked), priceLockedUntil: s.price_locked_until,
      autoRenew: s.auto_renew,
      reason: s.status === 'readonly' ? 'Не оплачено: работа только на чтение'
        : s.status === 'frozen' ? 'Компания заморожена' : undefined,
      // Предупреждение за три дня, за день и в день окончания. Модель
      // взята у соседнего проекта, где обкатана на живых клиентах:
      // человек должен узнать заранее, а не когда смена уже встала.
      ...this.warning(s.paid_until, s.status),
    };
  }

  /**
   * Предупреждение о конце подписки — одно место на всю систему.
   *
   * Правило соседей: правил о деньгах в двух копиях быть не должно.
   * Разъедутся на первой же правке, и одно устройство закроется, а
   * другое продолжит работать.
   *
   * Тон меняется по мере приближения: за три дня — «оплатите заранее»,
   * в последний день — «завтра работа закроется», после — «продажи
   * закрыты, но бэк-офис открыт». Последнее важно: человек должен
   * видеть свои цифры и суметь заплатить, а не упереться в стену.
   */
  private warning(paidUntil: any, status: string) {
    if (!paidUntil || status === 'cancelled') return {};
    const ms = new Date(paidUntil).getTime() - Date.now();
    const days = Math.ceil(ms / 86400000);
    const date = new Date(paidUntil).toLocaleDateString('ru-RU');

    if (ms <= 0) return {
      lock: {
        kind: 'block' as const, days: Math.max(1, Math.floor(-ms / 86400000)),
        title: `Срок подписки закончился ${date}`,
        message: 'Продажи закрыты. Кабинет открыт — там сумма и реквизиты; '
               + 'после оплаты касса оживёт сама.',
        // Закрытие смены и снятие отчёта работают ВСЕГДА: в ящике чужие
        // деньги, они обязаны сойтись, что бы ни случилось с оплатой.
        canCloseShift: true,
      },
    };

    if (days <= 3) {
      const when = days <= 0 ? 'сегодня' : days === 1 ? 'завтра'
        : days === 2 ? 'послезавтра' : `через ${days} дн.`;
      return {
        lock: {
          kind: 'warn' as const, days,
          title: `Подписка заканчивается ${when} (${date})`,
          message: 'После этого продажи закроются — оплатите заранее, чтобы смена не встала.',
          canCloseShift: true,
        },
      };
    }
    return {};
  }

  /**
   * Подписка глазами владельца магазина.
   *
   * Одним ответом: состояние, куда платить, состав счёта строками,
   * варианты продления со скидками, история платежей.
   *
   * СОСТАВ СЧЁТА СТРОКАМИ — приём соседей. Клиент добавил вторую кассу:
   * цена должна вырасти на понятную величину, а не стать другой цифрой
   * без объяснения. Скидка идёт строкой с минусом, в том же списке, а
   * не отдельным полем, о котором забывают.
   */
  async clientView(accountId: string) {
    const sub = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT s.*, t.name AS tariff_name, t.price_month
           FROM subscription s LEFT JOIN tariff t ON t.id = s.tariff_id
          WHERE s.account_id = $1`, [accountId])).rows[0]);

    const set = (await this.db.raw(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};

    // Счёт СТРОКАМИ ЦЕЛИКОМ, включая тариф.
    //
    // Замысел был верный — «нет строк, покажем тариф». Но условие
    // срабатывало, только когда строк НЕТ ВОВСЕ. Стоило появиться
    // доплате за вторую кассу — и тариф пропадал: клиент видел
    // «К оплате 9 900 ₸», а в составе одну «Кассу №2 — 3 000 ₸».
    //
    // Теперь основа приходит из базы всегда: своя строка, если она
    // заведена, иначе тариф подписки. Сумма строк равна итогу.
    const lines = (await this.db.raw(
      `SELECT * FROM platform_bill_lines($1)`, [accountId])).rows
      .map((r: any) => ({
        kind: r.kind, title: r.title, qty: Number(r.qty),
        price: Math.round(Number(r.unit_price) / 100),
        sum: Math.round(Number(r.unit_price) * Number(r.qty) / 100),
      }));

    // Счёт берём у БАЗЫ, из той же функции, что и панель платформы.
    //
    // Раньше здесь был свой расчёт: «есть строки — тариф не берём».
    // Одобрили вторую кассу, появилась строка на 3 000 — и клиент
    // видел в своём кабинете 3 000 вместо 9 900. Хуже, чем в панели:
    // там неверную цифру видит владелец платформы, а здесь — сам
    // клиент, и он по ней платит.
    const monthly = Math.round(Number((await this.db.raw(
      `SELECT platform_monthly($1) AS m`, [accountId])).rows[0]?.m ?? 0) / 100);

    // Варианты продления. Скидка за срок считается ЗДЕСЬ, а не в
    // кабинете: если считать по-своему, клиент увидит одно, а заплатит
    // другое.
    const periods = [1, 3, 6, 12].map((months) => {
      const bp = months >= 12 ? Number(set.discount_12m_bp ?? 0)
        : months >= 6 ? Number(set.discount_6m_bp ?? 0) : 0;
      const full = monthly * months;
      const amount = Math.round(full * (10000 - bp) / 10000);
      return { months, percent: bp / 100, amount, save: full - amount };
    });

    const days = sub?.paid_until
      ? Math.ceil((new Date(sub.paid_until).getTime() - Date.now()) / 86400000) : null;

    // Ждёт ли подтверждения уже отправленная оплата. Если да — не
    // показываем «Я оплатил» второй раз, иначе клиент отправит дважды
    // и будет ждать вдвое.
    const pending = (await this.db.raw(
      `SELECT id, amount, months, created_at FROM tenant_payment
        WHERE account_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`, [accountId])).rows[0];

    return {
      // 1. Состояние одной фразой — первым, как у соседей.
      state: {
        status: sub?.status ?? 'none',
        paidUntil: sub?.paid_until ?? null,
        daysLeft: days,
        title: !sub ? 'Подписка не оформлена'
          : days == null ? 'Срок ещё не начат'
          : days < 0 ? `Срок закончился ${new Date(sub.paid_until).toLocaleDateString('ru-RU')}`
          : days === 0 ? 'Подписка заканчивается сегодня'
          : `Оплачено до ${new Date(sub.paid_until).toLocaleDateString('ru-RU')}`,
        tariff: sub?.tariff_name ?? null,
      },
      // 2. Куда платить — вторым, а не в самом низу.
      //
      // Пять полей, а не одна строка «реквизиты»: владелец магазина
      // копирует номер целиком и вставляет в поле перевода. Если номер
      // слит с именем получателя в один текст, перевод не проходит — и
      // виноватой оказывается система.
      pay: {
        url: set.pay_url ?? null,          // «Оплатить» одним нажатием
        qr: set.pay_qr_url ?? null,        // навёл камеру и заплатил
        name: set.pay_name ?? null,        // проверить, туда ли платит
        phone: set.pay_phone ?? null,      // отдельным полем — копируют
        note: set.pay_note ?? null,        // что писать в комментарии
        details: set.pay_details ?? null,  // остальное словами
      },
      pendingPayment: pending
        ? { amount: Math.round(Number(pending.amount) / 100), months: pending.months,
            at: pending.created_at,
            note: 'Оплата отправлена и ждёт подтверждения. Обычно это занимает несколько часов.' }
        : null,
      // 3. Подробности — последними.
      monthly,
      lines,
      periods,
    };
  }

  /**
   * «Я оплатил». Доступ НЕ открывается — только владелец платформы
   * сверяет поступление и подтверждает. Но заявление уходит сразу, и
   * клиент видит, что оно принято.
   */
  async declarePayment(accountId: string, employeeId: string | null, d: {
    months?: number; amount?: number; method?: string; comment?: string;
  }) {
    const months = Math.max(1, Math.floor(Number(d.months ?? 1)));

    // Сумму берём из своего же расчёта, а не из того, что прислал
    // кабинет: иначе её можно подменить в запросе и заявить оплату на
    // тенге.
    const view = await this.clientView(accountId);
    const period = view.periods.find((p: any) => p.months === months) ?? view.periods[0];

    const dup = (await this.db.raw(
      `SELECT id FROM tenant_payment WHERE account_id=$1 AND status='pending'`, [accountId])).rows[0];
    if (dup) throw new BadRequestException(
      'Предыдущая оплата ещё ждёт подтверждения — отправлять вторую не нужно');

    const row = (await this.db.raw(
      `INSERT INTO tenant_payment (account_id, amount, months, method, comment,
                                   partner_id, declared_by)
       VALUES ($1,$2,$3,$4,$5,
               -- Доля идёт партнёру клиента: он привёл, доля его.
               (SELECT partner_id FROM tenant_card WHERE account_id=$1),
               -- А отметил оплату САМ КЛИЕНТ — иначе в ленте будет
               -- «отметил Ерлан», и разбираться пойдут не к тому.
               'client')
       RETURNING id, amount, months`,
      [accountId, period.amount * 100, months, d.method ?? 'kaspi', d.comment ?? null])).rows[0];

    await this.db.raw(
      `INSERT INTO platform_audit (actor_name, action, account_id, details)
       VALUES ('клиент', 'payment_declared', $1, $2)`,
      [accountId, JSON.stringify({ amount: period.amount, months })]);

    return {
      ok: true, amount: period.amount, months,
      note: 'Спасибо! Оплата отмечена и ждёт подтверждения. '
          + 'Как только деньги поступят, срок продлится автоматически.',
    };
  }

  async history(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT * FROM billing_move WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`, [accountId])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount), balance_after: Number(r.balance_after ?? 0) })));
  }

  /** Админка поддержки: всё об аккаунте одним запросом. */
  async supportSnapshot(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM support_snapshot($1)`, [accountId]);
    const r = rows[0];
    if (!r) throw new BadRequestException('Аккаунт не найден');
    const problems: string[] = [];
    if (Number(r.fiscal_pending) > 0) problems.push(`${r.fiscal_pending} чеков не ушли в налоговую`);
    if (Number(r.devices_offline) > 0) problems.push(`${r.devices_offline} касс не на связи`);
    if (r.status === 'readonly') problems.push('Не оплачено: работа только на чтение');
    if (Number(r.balance) < 0) problems.push('Отрицательный баланс');
    return {
      account: { name: r.account_name, phone: r.phone, cameFrom: r.came_from },
      subscription: { status: r.status, tariff: r.tariff, paidUntil: r.paid_until, balance: Number(r.balance) },
      scale: { stores: r.stores, devices: r.devices, employees: r.employees, products: r.products },
      today: { sales: r.sales_today, revenue: Number(r.revenue_today), lastSaleAt: r.last_sale_at },
      problems,
      health: problems.length === 0 ? 'ok' : problems.length > 2 ? 'bad' : 'warning',
    };
  }

  /** Аудит: кто что сделал. Каркас с Части 1, здесь наполняем. */
  async audit(accountId: string, f: { entity?: string; employeeId?: string; limit?: number } = {}) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT a.*, e.first_name AS employee FROM audit_log a
           LEFT JOIN employee e ON e.id = a.employee_id
          WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::uuid IS NULL OR a.employee_id = $2)
          ORDER BY a.ts DESC LIMIT $3`,
        [f.entity ?? null, f.employeeId ?? null, f.limit ?? 100])).rows);
  }

  // ==================================================================
  // ОНЛАЙН-ОПЛАТА ПОДПИСКИ (часть 29)
  // ==================================================================

  /**
   * Создать счёт на пополнение. Обращаемся к провайдеру за ссылкой/QR,
   * сохраняем счёт со статусом pending. Клиент платит → webhook подтвердит.
   */
  async createInvoice(accountId: string, d: { amount: number; provider?: string; purpose?: 'topup' | 'renew' }) {
    if (!(d.amount > 0)) throw new BadRequestException('Сумма пополнения должна быть больше нуля');
    const providerName = d.provider ?? 'mock';
    const prov = this.payProviders.get(providerName);
    if (!prov) throw new BadRequestException(`Провайдер оплаты «${providerName}» не подключён`);

    const res = await prov.createInvoice({
      accountId, amount: d.amount, purpose: d.purpose ?? 'topup', description: 'Оплата подписки Shop' });
    if (!res.ok) throw new BadRequestException(`Не удалось создать счёт: ${res.error}`);

    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO billing_invoice (account_id, amount, provider, external_id, pay_url, purpose, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + interval '1 hour') RETURNING id, amount, pay_url, status`,
        [accountId, d.amount, providerName, res.externalId ?? null, res.payUrl ?? null, d.purpose ?? 'topup']);
      return { id: rows[0].id, amount: Number(rows[0].amount), payUrl: rows[0].pay_url, status: rows[0].status };
    });
  }

  /**
   * Обработать webhook оплаты. Проверяем подпись, находим счёт по external_id,
   * проводим оплату идемпотентно (двойной webhook не задвоит баланс).
   * Вызывается публичным эндпоинтом (без авторизации — но с проверкой подписи).
   */
  async handlePaymentWebhook(providerName: string, rawBody: string, signature: string | undefined, parsed: any) {
    const prov = this.payProviders.get(providerName);
    if (!prov) throw new BadRequestException('Неизвестный провайдер');
    if (!prov.verifyWebhook(rawBody, signature))
      throw new BadRequestException('Неверная подпись webhook');

    const externalId = parsed?.invoiceId ?? parsed?.externalId ?? parsed?.id;
    const status = parsed?.status;
    if (!externalId) throw new BadRequestException('В webhook нет идентификатора счёта');

    // находим счёт БЕЗ tenant-контекста (webhook приходит извне) через
    // SECURITY DEFINER функцию — по паре провайдер+external_id
    const inv = (await this.db.raw(
      `SELECT * FROM find_invoice_by_external($1,$2)`,
      [providerName, externalId])).rows[0];
    if (!inv) throw new BadRequestException('Счёт не найден');

    if (status && status !== 'paid' && status !== 'success') {
      await this.db.withTenant(inv.account_id, async (c) =>
        c.query(`UPDATE billing_invoice SET status='failed' WHERE id=$1`, [inv.id]));
      return { ok: true, applied: false, reason: 'not_paid' };
    }

    // проводим оплату идемпотентно через SQL-функцию, в контексте аккаунта счёта
    // (функция читает subscription под RLS — нужен tenant)
    const r = await this.db.withTenant(inv.account_id, async (c) =>
      (await c.query(`SELECT * FROM apply_invoice_payment($1)`, [inv.id])).rows[0]);
    return { ok: true, applied: r.applied, balance: Number(r.new_balance) };
  }

  async invoices(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, amount, provider, status, purpose, pay_url, created_at, paid_at
           FROM billing_invoice WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, [accountId])).rows
        .map((r: any) => ({ ...r, amount: Number(r.amount) })));
  }

  /** Включить/выключить автопродление */
  async setAutoRenew(accountId: string, enabled: boolean) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE subscription SET auto_renew=$2 WHERE account_id=$1`, [accountId, enabled]);
      return { ok: true, autoRenew: enabled };
    });
  }

  /**
   * Автопродление: для аккаунтов с включённым auto_renew, у которых
   * оплаченный период на исходе, выставляем счёт на месячную цену. Вызывается
   * планировщиком (как charge). Возвращает, сколько счетов выставлено.
   */
  async runAutoRenew(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `SELECT * FROM subscription WHERE account_id=$1 AND auto_renew`, [accountId])).rows[0];
      if (!s) return { renewed: false, reason: 'auto_renew_off' };
      // если баланса не хватает на следующий месяц — выставляем счёт
      if (Number(s.balance) >= Number(s.price_locked))
        return { renewed: false, reason: 'balance_enough' };

      const amount = Number(s.price_locked) - Number(s.balance);
      const inv = await this.createInvoice(accountId, { amount, provider: 'mock', purpose: 'renew' });
      return { renewed: true, invoiceId: inv.id, amount };
    });
  }
}
