import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Module, Injectable,
  CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Public } from '../auth/guards';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

/**
 * ПЛАТФОРМА: владелец сервиса и партнёры.
 *
 * Модель перенесена из проекта автоматизации ресторанов, где обкатана
 * на живых клиентах. Взят не код — там другой стек, — а модель и
 * правила, которые за ней стоят.
 *
 * ГЛАВНОЕ ПРАВИЛО: партнёр доводит клиента до работы, деньги включает
 * владелец платформы. Партнёр заводит клиентов, ведёт их, отмечает
 * полученную оплату — но доступ открывается только после подтверждения
 * владельцем. Это единственная точка, где оплата превращается в
 * работающую систему, и она должна быть одна.
 *
 * ПАРТНЁР НЕ ВИДИТ ЧУЖИХ КЛИЕНТОВ. Не косметика: чужие обороты и
 * телефоны владельцев — не его дело.
 */

const PLATFORM_SECRET = process.env.PLATFORM_SECRET ?? process.env.JWT_SECRET ?? 'dev-platform';
const money = (tiyn: number) => Math.round(tiyn / 100);   // тиыны → тенге

export interface PlatformCtx {
  userId: string;
  role: 'super' | 'partner';
  name: string;
  commissionBp: number;
}

@Injectable()
export class PlatformService {
  constructor(private db: DbService) {}

  /** Прямой запрос вне изоляции магазинов: платформа смотрит сверху. */
  private q(sql: string, params: any[] = []) { return this.db.raw(sql, params); }

  /** Даём сторожу доступ к базе: он проверяет, не закрыт ли доступ. */
  onModuleInit() { PlatformGuard.db = this.db; }

  /** Жив ли человек: ключ подписан, но доступ могли закрыть после входа. */
  async alive(ctx: PlatformCtx) {
    const u = (await this.q(
      `SELECT is_active, deleted_at FROM platform_user WHERE id = $1`,
      [ctx.userId])).rows[0];
    if (!u || u.deleted_at) throw new UnauthorizedException('Учётная запись удалена');
    if (!u.is_active)
      throw new ForbiddenException('Доступ отключён владельцем платформы');
    return ctx;
  }

  // ── ВХОД ────────────────────────────────────────────────────────────
  async login(email: string, password: string) {
    const u = (await this.q(
      `SELECT id, email, password_hash, full_name, role, is_active, commission_bp
         FROM platform_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [String(email ?? '').trim()])).rows[0];

    // Одинаковый ответ на «нет такого» и «неверный пароль»: иначе по
    // разнице ответов подбирают существующие адреса.
    const ok = u && await bcrypt.compare(String(password ?? ''), u.password_hash);
    if (!ok) throw new UnauthorizedException('Неверная почта или пароль');
    if (!u.is_active) throw new ForbiddenException('Доступ отключён владельцем платформы');

    await this.q(`UPDATE platform_user SET last_login_at = now() WHERE id = $1`, [u.id]);

    const token = jwt.sign(
      { sub: u.id, role: u.role, name: u.full_name, bp: u.commission_bp },
      PLATFORM_SECRET, { expiresIn: '12h' });

    return { token, user: { id: u.id, name: u.full_name, email: u.email, role: u.role } };
  }

  // ── РАЗДЕЛ «СЕГОДНЯ» ────────────────────────────────────────────────
  /**
   * Лента решений на утро. Замысел донора: день начинается не со
   * списка клиентов, а с того, что требует решения сегодня.
   *
   * ОДНИМ ЗАПРОСОМ. У донора экран собирал ленту в браузере из четырёх
   * ответов — четыре ожидания подряд на стартовом экране, и половина
   * данных приходит устаревшей относительно другой половины.
   *
   * Партнёру не показываем то, чего он не может: денежные решения
   * принимает платформа, и рисовать ему кнопки, которые ответят
   * «нельзя», нечестно.
   */
  async today(ctx: PlatformCtx) {
    const rows = (await this.q(
      `SELECT * FROM platform_today($1, $2)`, [ctx.role, ctx.userId])).rows;

    const groups: Record<string, any> = {
      overdue: { key: 'overdue', title: 'Просрочены',
                 hint: 'деньги уже потеряны, каждый день считается', items: [] },
      today:   { key: 'today', title: 'Пришло сегодня',
                 hint: 'свежее — пока помнят разговор', items: [] },
      waiting: { key: 'waiting', title: 'Ждёт решения',
                 hint: 'висит со вчера и раньше', items: [] },
      soon:    { key: 'soon', title: 'Скоро платить',
                 hint: 'семь дней и меньше', items: [] },
    };

    for (const r of rows) {
      groups[r.grp]?.items.push({
        id: r.id, kind: r.kind,
        accountId: r.account_id, client: r.client,
        what: r.what, why: r.why, meta: r.meta,
        amount: r.amount == null ? null : money(Number(r.amount)),
        paymentId: r.payment_id, requestId: r.request_id,
        // Последствие видно СРАЗУ, без нажатия: «продлит до 01.10.2026».
        // Приём донора, и он лучше окна с предпросмотром — владелец
        // читает результат, не трогая мышь.
        effect: r.effect, actor: r.actor, at: r.at,
        // Что можно сделать прямо из ленты. Партнёру денежные решения
        // не показываем — он их всё равно не примет.
        can: {
          approve: r.kind === 'payment' && ctx.role === 'super',
          decide:  r.kind === 'request' && ctx.role === 'super',
          signup:  r.kind === 'signup'  && ctx.role === 'super',
          call:    true,
        },
      });
    }

    const list = Object.values(groups).filter((g: any) => g.items.length);
    const n = rows.length;
    // «1 решение ждёт вас» — число словами, как у донора. Голая цифра
    // не говорит, что с ней делать.
    const word = n % 10 === 1 && n % 100 !== 11 ? 'решение ждёт'
      : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'решения ждут'
      : 'решений ждут';

    return {
      groups: list,
      total: n,
      headline: ctx.role === 'super'
        ? (n > 0 ? `${n} ${word} вас` : 'Решений нет — всё разобрано')
        : (n > 0 ? `${n} дел по вашим клиентам` : 'По вашим клиентам всё спокойно'),
      // Дата в заголовке: «Сегодня, 17 августа». Кабинет открывают
      // утром и держат весь день — без даты непонятно, свежее ли это.
      dateLabel: new Date().toLocaleDateString('ru-RU',
        { day: 'numeric', month: 'long' }),
      // Пустая лента — это хорошая новость, и сказать об этом надо
      // словами: пустой экран читается как поломка.
      empty: rows.length === 0
        ? 'Ничего не ждёт решения. Просроченных нет, оплаты подтверждены, заявок нет.'
        : null,
    };
  }

  // ── СПИСОК КЛИЕНТОВ ─────────────────────────────────────────────────
  /**
   * Что видно в списке — набор столбцов взят у донора, он обкатан:
   * магазин, владелец с телефоном (звонить прямо отсюда), статус,
   * оплачено до с остатком дней, тариф и ВЫРУЧКА ЗА 30 ДНЕЙ.
   *
   * Последнее — главный столбец. Он отвечает на вопрос «живёт ли
   * клиент»: если система у него не работает, продлевать он не будет,
   * и звонить надо сейчас, а не когда кончится срок.
   */
  /**
   * Список клиентов с отбором и счётчиками — одним ответом.
   *
   * ОТБОР В БАЗЕ, а не в браузере. У донора список приходил целиком и
   * фильтровался на стороне кабинета: при сотне клиентов это лишние
   * сотни строк по сети на каждое нажатие «показать просроченных».
   *
   * Счётчики приходят вместе со списком: цифра на вкладке и её
   * содержимое считаются в одном месте и не могут разойтись.
   */
  /**
   * Клиенты: таблица со счётчиками, отбором, порядком и группировкой.
   *
   * Раскладка донора: пять чисел сверху, поиск, четыре порядка, отбор
   * по партнёру, семь вкладок состояний. Всё считает база одним
   * заходом — у них порядок и группировка делались в браузере, и при
   * сотне клиентов это заметно.
   */
  async clients(ctx: PlatformCtx, opts: {
    q?: string; filter?: string; partnerId?: string; sort?: string;
  } = {}) {
    const states = ['all', 'approval', 'active', 'pending_pay', 'setup', 'expired', 'suspended'];
    const filter = states.includes(opts.filter ?? '') ? opts.filter! : 'all';
    const sorts = ['due', 'price', 'revenue', 'name'];
    const sort = sorts.includes(opts.sort ?? '') ? opts.sort! : 'due';
    const partner = opts.partnerId || 'all';

    const [rows, counts, partners] = await Promise.all([
      this.q(`SELECT * FROM platform_clients_filtered($1,$2,$3,$4,$5,$6)`,
        [ctx.role, ctx.userId, opts.q?.trim() || null, filter, partner, sort]),
      this.q(`SELECT * FROM platform_clients_counts($1,$2)`, [ctx.role, ctx.userId]),
      ctx.role === 'super'
        ? this.q(`SELECT id, full_name FROM platform_user
                   WHERE role='partner' AND deleted_at IS NULL ORDER BY full_name`)
        : Promise.resolve({ rows: [] } as any),
    ]);

    const c = counts.rows[0] ?? {};

    return {
      rows: rows.rows.map((r: any) => ({
        id: r.id, name: r.name, phone: r.phone, city: r.city,
        owner: r.owner_name, ownerPhone: r.owner_phone,
        state: r.state, tariff: r.tariff_name,
        partner: r.partner_name, partnerId: r.partner_id,
        partnerPercent: Number(r.partner_bp) / 100,
        dealStage: r.deal_stage, dealNote: r.deal_note, touchedAt: r.touched_at,
        isDemo: r.is_demo,
        paidUntil: r.paid_until, daysLeft: r.days_left,
        monthly: money(Number(r.monthly)),
        pendingPayments: Number(r.pending_payments),
        expiringSoon: r.days_left != null && r.days_left >= 0 && r.days_left <= 7,
        expired: r.days_left != null && r.days_left < 0,
        revenue30d: Math.round(Number(r.revenue_30d)),
        stores: Number(r.stores), registers: Number(r.registers),
        createdAt: r.created_at,
      })),
      total: Number(rows.rows[0]?.total_count ?? 0),
      // Пять чисел сверху, как у них.
      stats: {
        total: Number(c.total ?? 0),
        active: Number(c.active ?? 0),
        pendingPay: Number(c.pending_pay ?? 0),
        expired: Number(c.expired ?? 0),
        mrr: money(Number(c.mrr ?? 0)),
      },
      // Счётчики вкладок отбора.
      counts: {
        all: Number(c.total ?? 0),
        approval: Number(c.approval ?? 0),
        active: Number(c.active ?? 0),
        pending_pay: Number(c.pending_pay ?? 0),
        setup: Number(c.setup ?? 0),
        expired: Number(c.expired ?? 0),
        suspended: Number(c.suspended ?? 0),
        demo: Number(c.demo ?? 0),
        nobody: Number(c.nobody ?? 0),
        // «Доход в месяц» над таблицей: база его считает, а сервер не
        // передавал — карточка рисовала пустоту.
        mrr: money(Number(c.mrr ?? 0)),
      },
      partners: partners.rows.map((p: any) => ({ id: p.id, name: p.full_name })),
      filter, sort, partnerId: partner,
    };
  }

  // ── СВОДКА ──────────────────────────────────────────────────────────
  /** Пять чисел наверху. Демо исключены отовсюду — иначе сводка врёт. */
  async summary(ctx: PlatformCtx) {
    const r = (await this.q(
      `SELECT * FROM platform_summary($1, $2)`,
      [ctx.role, ctx.userId])).rows[0];

    const pending = (await this.q(
      `SELECT count(*) AS n FROM tenant_payment WHERE status = 'pending'`)).rows[0];

    return {
      total: Number(r.total), active: Number(r.active), expired: Number(r.expired),
      pendingPayments: Number(pending.n),
      mrr: Math.round(Number(r.mrr)),
    };
  }

  // ── ОПЛАТЫ ──────────────────────────────────────────────────────────
  /** Партнёр отмечает полученные деньги. Доступ пока НЕ продлевается. */
  async recordPayment(ctx: PlatformCtx, d: {
    accountId: string; amount: number; months?: number; method?: string; comment?: string;
  }) {
    if (!d.accountId) throw new BadRequestException('Выберите клиента');
    const amount = Math.round(Number(d.amount) * 100);          // тенге → тиыны
    if (!(amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    const months = Math.max(1, Math.floor(Number(d.months ?? 1)));

    // Партнёр может отметить оплату только своему клиенту.
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id = $1 AND partner_id = $2`,
        [d.accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }

    const row = (await this.q(
      `INSERT INTO tenant_payment (account_id, amount, months, method, comment, created_by, partner_id)
       VALUES ($1,$2,$3,$4,$5,$6,
               (SELECT partner_id FROM tenant_card WHERE account_id = $1))
       RETURNING id, amount, months, status`,
      [d.accountId, amount, months, d.method ?? 'kaspi', d.comment ?? null, ctx.userId])).rows[0];

    await this.audit(ctx, 'payment_recorded', d.accountId, { amount: money(amount), months });
    return { ...row, amount: money(row.amount),
      note: 'Оплата записана. Доступ продлится после подтверждения владельцем платформы.' };
  }

  /**
   * Подтверждение — единственное место, где оплата превращается в
   * доступ. Только владелец платформы.
   *
   * ДОСРОЧНАЯ ОПЛАТА НЕ СЖИГАЕТ ОСТАТОК: новый период считается от
   * БОЛЬШЕЙ из дат — сегодня или нынешний конец оплаченного периода.
   * Иначе клиент, заплативший за неделю до срока, теряет эту неделю —
   * и больше никогда не платит заранее.
   */
  async approvePayment(ctx: PlatformCtx, paymentId: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Подтверждает только владелец платформы');

    // Одной операцией в базе: доля партнёра, продление, отрезок,
    // отметки. Если упадёт посередине — не должно остаться половины:
    // оплата подтверждена, а доступ не продлён, или наоборот.
    let r: any;
    try {
      r = (await this.q(`SELECT * FROM platform_approve_payment($1,$2)`,
        [paymentId, ctx.userId])).rows[0];
    } catch (e: any) {
      // Сообщения из базы уже человеческие — отдаём как есть.
      throw new BadRequestException(String(e.message ?? '').replace(/^.*?:\s*/, ''));
    }

    await this.audit(ctx, 'payment_approved', null, {
      amount: money(Number(r.amount)), months: r.months,
      paidUntil: r.paid_until, partnerShare: money(Number(r.partner_share)),
    });

    return {
      ok: true,
      paidUntil: r.paid_until,
      periodFrom: r.period_from,
      partnerShare: money(Number(r.partner_share)),
      // Доля ПЛАТФОРМЫ — чужие деньги. Партнёру видно, сколько
      // заработал он; сколько осталось платформе — не его дело, и
      // показывать это значит рассказывать ему про чужой карман.
      platformShare: ctx.role === 'super'
        ? money(Number(r.platform_share)) : null,
      note: `Доступ продлён до ${new Date(r.paid_until).toLocaleDateString('ru-RU')}`,
    };
  }

  /**
   * ЧТО ПРОИЗОЙДЁТ, ЕСЛИ ПОДТВЕРДИТЬ. Считает сервер, кабинет
   * показывает.
   *
   * Дизайнер верно заметил: он выводил дату продления и долю партнёра
   * по правилу сервера прямо в кабинете — то есть правило о деньгах
   * начинало жить в двух местах. Разъедутся на первой правке, и
   * владелец увидит одну цифру, а система применит другую.
   *
   * Здесь тот же расчёт, что и при подтверждении, но без записи. Одно
   * правило, два способа спросить.
   */
  async previewPayment(ctx: PlatformCtx, paymentId: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');

    const p = (await this.q(`SELECT * FROM tenant_payment WHERE id = $1`, [paymentId])).rows[0];
    if (!p) throw new BadRequestException('Оплата не найдена');

    // Имя партнёра и его процент — в последствиях они нужны словами:
    // «Партнёру · Ерлан (15%) → 3 750 ₸» читается, а «партнёру 3 750»
    // заставляет вспоминать, кому именно.
    const pr = p.partner_id
      ? (await this.q(`SELECT full_name, commission_bp FROM platform_user WHERE id = $1`,
          [p.partner_id])).rows[0]
      : null;
    const bp = Number(pr?.commission_bp ?? 0);
    const partnerShare = Math.round(Number(p.amount) * bp / 10000);

    // Дату считаем той же функцией, что и при подтверждении, — но в
    // откате, чтобы ничего не записалось. Так предпросмотр не может
    // разойтись с делом даже теоретически.
    const c = await (this.db as any).pool.connect();
    let until: string;
    try {
      await c.query('BEGIN');
      until = (await c.query(`SELECT platform_extend_subscription($1,$2) AS until`,
        [p.account_id, Number(p.months)])).rows[0].until;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }

    return {
      paidUntil: until,
      partnerShare: money(partnerShare),
      platformShare: money(Number(p.amount) - partnerShare),
      amount: money(Number(p.amount)),
      months: Number(p.months),
      partnerPercent: bp / 100,
      partnerName: pr?.full_name ?? null,
      client: (await this.q(
        `SELECT name FROM platform_clients('super', NULL, NULL) WHERE id = $1`,
        [p.account_id])).rows[0]?.name ?? null,
    };
  }

  /** Отклонение ТРЕБУЕТ причины: партнёр должен понять, что не так. */
  async rejectPayment(ctx: PlatformCtx, paymentId: string, reason: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Отклоняет только владелец платформы');
    if (!reason?.trim()) throw new BadRequestException('Напишите причину — партнёр должен понять, что не так');

    const r = await this.q(
      `UPDATE tenant_payment SET status='rejected', reject_reason=$2, approved_by=$3, approved_at=now()
        WHERE id=$1 AND status='pending' RETURNING account_id`, [paymentId, reason.trim(), ctx.userId]);
    if (!r.rows[0]) throw new BadRequestException('Оплата не найдена или уже обработана');

    await this.audit(ctx, 'payment_rejected', r.rows[0].account_id, { reason: reason.trim() });
    return { ok: true };
  }

  /**
   * Деньги: список оплат с итогами.
   *
   * ИТОГИ ПО ТЕМ ЖЕ СТРОКАМ, что показываются. У донора сумма сверху
   * бралась отдельным запросом, и при отборе «ждут подтверждения» она
   * показывала итог по всем — цифра не совпадала со списком под ней.
   *
   * В доход идут только ПОДТВЕРЖДЁННЫЕ: ждущие и отклонённые — это ещё
   * не деньги.
   */
  async payments(ctx: PlatformCtx, opts: { status?: string; days?: number } = {}) {
    const ok = ['pending', 'approved', 'rejected'];
    const status = ok.includes(opts.status ?? '') ? opts.status : null;
    const days = Math.min(365, Math.max(7, Math.floor(Number(opts.days ?? 90))));

    const rows = (await this.q(
      `SELECT * FROM platform_money($1,$2,$3,$4)`,
      [status, ctx.role, ctx.userId, days])).rows;

    const t = rows[0] ?? {};
    return {
      rows: rows.map((r: any) => ({
        id: r.id, accountId: r.account_id, client: r.client,
        partner: r.partner, partnerId: r.partner_id,
        amount: money(Number(r.amount)), months: r.months,
        method: r.method, comment: r.comment,
        status: r.status, rejectReason: r.reject_reason,
        // Отрезок записан при подтверждении и не пересчитывается: это
        // ответ на вопрос «за что я платил», он не должен меняться от
        // того, что случилось потом.
        periodFrom: r.period_from, periodTo: r.period_to,
        partnerShare: money(Number(r.partner_share)),
        // Доля ПЛАТФОРМЫ — чужие деньги. Партнёру видно, сколько
        // заработал он; сколько осталось платформе — не его дело.
        platformShare: ctx.role === 'super'
          ? money(Number(r.platform_share)) : null,
        createdAt: r.created_at, approvedAt: r.approved_at,
        // Кто подтвердил: когда владельцев платформы несколько, вопрос
        // «кто это пропустил» возникает первым.
        approvedBy: r.approved_by_name,
        // Что будет, если подтвердить — считает база тем же способом,
        // что и само подтверждение: строка не разойдётся с делом.
        willExtendTo: r.will_extend_to,
        willPartnerShare: r.will_partner_share == null
          ? null : money(Number(r.will_partner_share)),
        canApprove: r.status === 'pending' && ctx.role === 'super',
      })),
      totals: {
        count: Number(t.cnt ?? 0),
        amount: money(Number(t.sum_amount ?? 0)),
        partnerShare: money(Number(t.sum_partner ?? 0)),
        // Итог платформы — тоже чужие деньги для партнёра.
        platformShare: ctx.role === 'super'
          ? money(Number(t.sum_platform ?? 0)) : null,
      },
      status: status ?? 'all', days,
    };
  }

  // ── ПАРТНЁРЫ ────────────────────────────────────────────────────────
  /**
   * Партнёры: кто продаёт и сколько заработал.
   *
   * У донора список плоский: имя, комиссия, число клиентов, заработок
   * одним числом. Для решения этого мало — а решать здесь надо одно:
   * кому платить и с кем расставаться.
   *
   * ДОБАВЛЕНО: сколько ПРИВЁЛ денег платформе (это другое число, и оно
   * важнее заработка — партнёр с малой комиссией может приносить
   * больше), сколько клиентов УШЛО, и давно ли он заходил.
   */
  async partners(ctx: PlatformCtx, days = 30) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const n = Math.min(365, Math.max(7, Math.floor(Number(days))));

    const rows = (await this.q(`SELECT * FROM platform_partners_full($1)`, [n])).rows;

    return {
      rows: rows.map((r: any) => ({
        id: r.id, name: r.full_name, email: r.email, phone: r.phone,
        // Владельцы платформы тоже в списке: раздел отвечает на вопрос
        // «кто имеет доступ», и забытая учётка совладельца открывает
        // деньги всех клиентов.
        role: r.role,
        isSuperUser: r.role === 'super',
        commissionPercent: Number(r.commission_bp) / 100,
        isActive: r.is_active, lastLoginAt: r.last_login_at, createdAt: r.created_at,

        clients: Number(r.clients),
        activeClients: Number(r.active_clients),
        lostClients: Number(r.lost_clients),

        earned: money(Number(r.earned_period)),
        earnedTotal: money(Number(r.earned_total)),
        brought: money(Number(r.brought_period)),
        broughtTotal: money(Number(r.brought_total)),
        mrr: money(Number(r.mrr)),

        daysSilent: r.days_silent,
        // Не заходил месяц — скорее всего перестал работать, а его
        // клиенты остались без сопровождения.
        inactive: r.days_silent != null && r.days_silent >= 30,
        neverLoggedIn: r.last_login_at == null,
      })),
      days: n,
      totals: {
        // Считаем только партнёров: владельцы клиентов не приводят.
        partners: rows.filter((r: any) => r.role === 'partner').length,
        brought: money(rows.reduce((a: number, r: any) => a + Number(r.brought_period), 0)),
        paidOut: money(rows.reduce((a: number, r: any) => a + Number(r.earned_period), 0)),
      },
    };
  }

  /**
   * Что произойдёт, если отключить партнёра. Опасное действие
   * показывает последствие ДО нажатия — у донора кнопка просто
   * отключала.
   */
  async partnerOffPreview(ctx: PlatformCtx, id: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const r = (await this.q(`SELECT * FROM platform_partner_off_preview($1)`, [id])).rows[0];
    if (!r) throw new BadRequestException('Партнёр не найден');
    return {
      name: r.full_name,
      clients: Number(r.clients),
      activeClients: Number(r.active_clients),
      mrr: money(Number(r.mrr)),
      effect: Number(r.clients) === 0
        ? 'Вход закроется. Клиентов у него нет.'
        : `Вход закроется. Его ${r.clients} клиентов продолжат работать, `
          + `но останутся без сопровождения — назначьте им другого партнёра.`,
    };
  }

  async createPartner(ctx: PlatformCtx, d: {
    name: string; email: string; password: string; commissionPercent?: number; phone?: string;
  }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    if (!d.name?.trim() || !d.email?.trim() || !d.password) 
      throw new BadRequestException('Нужны имя, почта и пароль');
    if (String(d.password).length < 8) throw new BadRequestException('Пароль от 8 знаков');

    const bp = Math.round(Number(d.commissionPercent ?? 0) * 100);
    if (bp < 0 || bp > 10000) throw new BadRequestException('Комиссия от 0 до 100%');

    const exists = (await this.q(
      `SELECT 1 FROM platform_user WHERE lower(email) = lower($1)`, [d.email.trim()])).rows[0];
    if (exists) throw new BadRequestException('Партнёр с такой почтой уже есть');

    const row = (await this.q(
      `INSERT INTO platform_user (email, password_hash, full_name, role, commission_bp, phone)
       VALUES ($1,$2,$3,'partner',$4,$5) RETURNING id, email, full_name`,
      [d.email.trim(), await bcrypt.hash(d.password, 10), d.name.trim(), bp, d.phone ?? null])).rows[0];

    await this.audit(ctx, 'partner_created', null, { partner: row.full_name, commissionBp: bp });
    return { ...row,
      note: 'Пароль показан один раз — передайте партнёру лично. В базе он хранится отпечатком.' };
  }

  async togglePartner(ctx: PlatformCtx, id: string, active: boolean) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    await this.q(`UPDATE platform_user SET is_active = $2 WHERE id = $1`, [id, active]);
    await this.audit(ctx, active ? 'partner_enabled' : 'partner_disabled', null, { id });
    // Отключение закрывает вход, но НЕ трогает его клиентов: они
    // продолжают работать, просто ведёт их теперь кто-то другой.
    return { ok: true, note: active ? 'Вход открыт' : 'Вход закрыт. Клиенты продолжают работать' };
  }

  /**
   * Назначить клиенту партнёра.
   *
   * Проверка «партнёр существует и не удалён» живёт В БАЗЕ, а не
   * здесь: клиент, привязанный к удалённому, повисает — он есть, он
   * платит, но в отборе по партнёру его не выбрать ничем, потому что
   * такого партнёра в списке нет.
   */
  async assignPartner(ctx: PlatformCtx, accountId: string, partnerId: string | null) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    let r: any;
    try {
      r = (await this.q(
        `SELECT * FROM platform_assign_partner($1,$2)`, [accountId, partnerId])).rows[0];
    } catch (e: any) {
      // База говорит по-русски — доносим это до экрана, иначе там
      // будет «Internal server error», и человек не поймёт, что не так.
      throw new BadRequestException(
        /удал/i.test(String(e?.message))
          ? 'Этот партнёр удалён — выберите другого или оставьте клиента ничьим'
          : String(e?.message ?? 'Не удалось назначить партнёра'));
    }
    await this.audit(ctx, 'partner_assigned', accountId, { partnerId });
    return { ok: true, note: r?.note };
  }

  // ── СТРОКИ СЧЁТА ────────────────────────────────────────────────────
  /**
   * Состав счёта клиента. Владелец платформы видит, из чего сложилась
   * сумма, и правит по строке — а не меняет итог одним числом.
   */
  async planLines(ctx: PlatformCtx, accountId: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const lines = (await this.q(
      `SELECT id, kind, title, qty, unit_price, starts_at, ends_at
         FROM plan_line WHERE account_id = $1 ORDER BY starts_at`, [accountId])).rows;
    return lines.map((r: any) => ({
      id: r.id, kind: r.kind, title: r.title, qty: Number(r.qty),
      price: money(Number(r.unit_price)),
      sum: money(Number(r.unit_price) * Number(r.qty)),
      active: !r.ends_at, startsAt: r.starts_at, endsAt: r.ends_at,
    }));
  }

  async addPlanLine(ctx: PlatformCtx, accountId: string, d: {
    kind: string; title: string; qty?: number; price: number;
  }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Цены назначает владелец платформы');
    if (!d.title?.trim()) throw new BadRequestException('Назовите строку: «Касса №2», «Скидка за год»');
    const kinds = ['base', 'pos', 'store', 'module', 'discount'];
    if (!kinds.includes(d.kind)) throw new BadRequestException('Неизвестный вид строки');

    // Скидка — строка с отрицательной ценой. Так она попадает в тот же
    // расчёт и видна в том же списке, а не живёт отдельным полем, о
    // котором забывают.
    const price = Math.round(Number(d.price) * 100) * (d.kind === 'discount' ? -1 : 1);

    const r = (await this.q(
      `INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [accountId, d.kind, d.title.trim(), Math.max(1, Math.floor(Number(d.qty ?? 1))), price])).rows[0];

    await this.audit(ctx, 'plan_line_added', accountId,
      { title: d.title, price: money(price), kind: d.kind });
    return { ...r, note: 'Строка добавлена. Новая сумма применится со следующего счёта.' };
  }

  /** Закрыть строку. Не удаляем: счета прошлых месяцев должны сходиться. */
  async closePlanLine(ctx: PlatformCtx, id: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const r = await this.q(
      `UPDATE plan_line SET ends_at = now() WHERE id = $1 AND ends_at IS NULL
       RETURNING account_id, title`, [id]);
    if (!r.rows[0]) throw new BadRequestException('Строка не найдена или уже закрыта');
    await this.audit(ctx, 'plan_line_closed', r.rows[0].account_id, { title: r.rows[0].title });
    return { ok: true };
  }

  // ── ДОПЛАТА ЗА УСТРОЙСТВО ───────────────────────────────────────────
  /**
   * Сколько стоит добавить кассу или точку прямо сейчас.
   *
   * ПРАВИЛО ДЕСЯТИ ДНЕЙ, взятое у донора: доплата за остаток
   * оплаченного периода берётся, только если до конца десять дней и
   * больше. Меньше — не берём вовсе.
   *
   * Причина житейская: спорить с клиентом из-за трёхсот тенге в конце
   * месяца дороже самих трёхсот тенге. А ощущение «содрали за неделю
   * как за месяц» он запомнит надолго.
   *
   * У клиента при этом всегда ОДНА дата платежа, сколько бы устройств
   * он ни добавил.
   */
  async deviceAddPreview(ctx: PlatformCtx, accountId: string, kind: 'pos' | 'store') {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');

    const set = (await this.q(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};
    const unit = Number(kind === 'pos' ? set.price_extra_pos : set.price_extra_store);

    // Через функцию с обходом изоляции: прямой запрос к подписке из
    // платформы возвращает пусто — молча, без ошибки.
    const until = (await this.q(
      `SELECT platform_paid_until($1) AS d`, [accountId])).rows[0]?.d;

    let days = 0, proRata = 0;
    if (until && new Date(until) > new Date()) {
      days = Math.ceil((new Date(until).getTime() - Date.now()) / 86400000);
      if (days >= 10) proRata = Math.round(unit * days / 30);
    }

    return {
      kind, monthly: money(unit), daysLeft: days, proRata: money(proRata),
      note: days === 0 ? 'Период не оплачен — доплаты нет, устройство войдёт в следующий счёт'
        : proRata === 0
          ? `До конца периода ${days} дн. — доплату не берём, устройство войдёт в следующий счёт`
          : `Доплата за ${days} дн. до конца оплаченного периода`,
    };
  }

  // ── ЗАЯВКИ ПАРТНЁРА ─────────────────────────────────────────────────
  /** Партнёр просит: вторую кассу, другой тариф, отсрочку. */
  async createRequest(ctx: PlatformCtx, d: {
    accountId: string; kind: string; comment?: string; payload?: any;
  }) {
    if (!['device', 'tariff', 'grace', 'other'].includes(d.kind))
      throw new BadRequestException('Неизвестный вид заявки');
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [d.accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }
    const r = (await this.q(
      `INSERT INTO tenant_request (account_id, kind, payload, comment, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, status`,
      [d.accountId, d.kind, JSON.stringify(d.payload ?? {}), d.comment ?? null, ctx.userId])).rows[0];
    await this.audit(ctx, 'request_created', d.accountId, { kind: d.kind });
    return { ...r, note: 'Заявка отправлена владельцу платформы' };
  }

  async requests(ctx: PlatformCtx, status?: string) {
    const rows = (await this.q(
      `SELECT * FROM platform_requests($1, $2, $3)`,
      [status ?? null, ctx.role, ctx.userId])).rows;

    // Деньги клиента идут вместе с заявкой: решая про отсрочку, надо
    // видеть, сколько он платит и не просрочен ли уже.
    return rows.map((r: any) => ({
      ...r,
      monthly: money(Number(r.monthly ?? 0)),
      paidUntil: r.paid_until,
      daysLeft: r.days_left,
      pendingAmount: money(Number(r.pending_amount ?? 0)),
      expired: r.days_left != null && r.days_left < 0,
      expiringSoon: r.days_left != null && r.days_left >= 0 && r.days_left <= 7,
    }));
  }

  /**
   * Что произойдёт, если одобрить заявку.
   *
   * У донора кнопка «Одобрить» просто делала, и увидеть последствие
   * можно было только после. С деньгами так нельзя: одобряя вторую
   * кассу, владелец должен видеть, что клиенту прилетит доплата.
   *
   * Считает тем же кодом, что и само одобрение — предпросмотр не может
   * разойтись с делом.
   */
  async requestPreview(ctx: PlatformCtx, id: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Решает владелец платформы');
    const r = (await this.q(`SELECT * FROM platform_request_preview($1)`, [id])).rows[0];
    if (!r) throw new BadRequestException('Заявка не найдена');
    return {
      kind: r.kind, client: r.client, accountId: r.account_id,
      what: r.what, effect: r.effect,
      proRata: money(Number(r.amount ?? 0)),
      daysLeft: r.days_left,
      // Цена по прайсу — как подсказка в поле: владелец видит, от
      // чего отталкиваться, и может задать свою.
      listedPrice: money(Number(r.listed_price ?? 0)),
    };
  }

  /**
   * Решение по заявке. Одобрение САМО выполняет действие, а не просто
   * ставит отметку: одобрил вторую кассу — строка счёта появилась.
   *
   * Иначе возможно состояние «одобрено, но не сделано» — самое
   * неприятное, потому что все считают, что сделано.
   *
   * Отказ требует причины: партнёр должен понять, что не так.
   */
  async decideRequest(ctx: PlatformCtx, id: string, approve: boolean,
                      note?: string, unitPrice?: number) {
    if (ctx.role !== 'super') throw new ForbiddenException('Решает владелец платформы');
    if (!approve && !note?.trim())
      throw new BadRequestException('Напишите причину отказа — партнёр должен понять, что не так');

    let r: any;
    try {
      // Цена строки задаётся при одобрении: партнёр мог договориться
      // не по прайсу, и узнавать об этом через месяц поздно.
      r = (await this.q(`SELECT * FROM platform_request_decide($1,$2,$3,$4,$5)`,
        [id, ctx.userId, approve, note?.trim() ?? null,
         unitPrice == null ? null : Math.round(Number(unitPrice) * 100)])).rows[0];
    } catch (e: any) {
      throw new BadRequestException(String(e.message ?? '').replace(/^.*?:\s*/, ''));
    }

    await this.audit(ctx, approve ? 'request_approved' : 'request_rejected',
      r.account_id, { kind: r.kind, effect: r.effect, note });

    return { ok: true, effect: r.effect,
      note: approve ? `${r.effect}. Клиент увидит изменение в своём кабинете` : 'Отказано' };
  }

  // ── ПРАЙС-ЛИСТ ──────────────────────────────────────────────────────
  /**
   * Прайс. Партнёру он НУЖЕН: он называет цену клиенту и подаёт заявку
   * на устройство, где цена подставляется подсказкой.
   *
   * А вот РЕКВИЗИТЫ — не нужны: клиенты платят напрямую платформе,
   * партнёр в этом не участвует, и знать чужой счёт ему незачем. Их
   * отдаём только владельцу.
   */
  async priceBook(ctx: PlatformCtx) {
    const s = (await this.q(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};
    const isSuper = ctx.role === 'super';
    return {
      base: money(Number(s.price_base)), pro: money(Number(s.price_pro)),
      extraPos: money(Number(s.price_extra_pos)), extraStore: money(Number(s.price_extra_store)),
      discount6m: Number(s.discount_6m_bp) / 100, discount12m: Number(s.discount_12m_bp) / 100,
      payQr: isSuper ? s.pay_qr_url : null,
      payDetails: isSuper ? s.pay_details : null,
    };
  }

  /**
   * Правка прайса. ПРОВЕРКИ ЖИВУТ ЗДЕСЬ, а не только в кабинете:
   * кабинет — не единственная дверь, и запрос можно послать напрямую.
   *
   * Без них скидка 150% давала клиенту отрицательный счёт — платформа
   * оказывалась должна ему 41 400 ₸. А цена ноль обнуляла доход со
   * всех клиентов разом, и заметить это можно было только по пустой
   * сводке через месяц.
   */
  async setPriceBook(ctx: PlatformCtx, d: any) {
    for (const [key, name] of [
      ['base', 'Тариф «Старт»'], ['pro', 'Тариф «Стандарт»'],
      ['extraPos', 'Вторая касса'], ['extraStore', 'Вторая точка'],
    ] as const) {
      if (d[key] == null) continue;
      const v = Number(d[key]);
      if (!Number.isFinite(v) || v < 0)
        throw new BadRequestException(`${name}: цена не может быть отрицательной`);
      // Верхний предел — от опечатки: 6900 с лишним нулём это 69 000,
      // и клиент увидит его в своём счёте раньше, чем кто-то заметит.
      if (v > 1_000_000)
        throw new BadRequestException(`${name}: цена больше миллиона — проверьте, не лишний ли ноль`);
    }

    for (const [key, name] of [
      ['discount6m', 'Скидка за полгода'], ['discount12m', 'Скидка за год'],
    ] as const) {
      if (d[key] == null) continue;
      const v = Number(d[key]);
      // Половина — предел: больше это уже не скидка, а другой тариф, и
      // заводить его надо строкой счёта, а не процентом.
      if (!Number.isFinite(v) || v < 0 || v > 50)
        throw new BadRequestException(`${name}: от 0 до 50%`);
    }

    if (ctx.role !== 'super') throw new ForbiddenException('Цены назначает владелец платформы');
    const t = (v: any) => v == null ? null : Math.round(Number(v) * 100);
    await this.q(
      `UPDATE platform_settings SET
         price_base = coalesce($1, price_base),
         price_pro = coalesce($2, price_pro),
         price_extra_pos = coalesce($3, price_extra_pos),
         price_extra_store = coalesce($4, price_extra_store),
         discount_6m_bp = coalesce($5, discount_6m_bp),
         discount_12m_bp = coalesce($6, discount_12m_bp),
         pay_qr_url = coalesce($7, pay_qr_url),
         pay_details = coalesce($8, pay_details),
         updated_at = now() WHERE id`,
      [t(d.base), t(d.pro), t(d.extraPos), t(d.extraStore),
       d.discount6m == null ? null : Math.round(Number(d.discount6m) * 100),
       d.discount12m == null ? null : Math.round(Number(d.discount12m) * 100),
       d.payQr ?? null, d.payDetails ?? null]);
    await this.audit(ctx, 'price_book_changed', null, d);
    // Цены на витрине берутся отсюда же — менять в двух местах не нужно.
    return { ok: true, note: 'Новые цены применятся к следующим счетам. Оплаченные периоды не меняются.' };
  }

  // ── МАССОВЫЕ ДЕЙСТВИЯ ───────────────────────────────────────────────
  /**
   * Что произойдёт, если применить действие к нескольким клиентам.
   *
   * ВСЕГДА СНАЧАЛА ПРЕДПРОСМОТР. Массовое действие затрагивает чужие
   * деньги, и «применилось к 47 клиентам» узнавать постфактум нельзя.
   *
   * УЧЕБНЫЕ МАГАЗИНЫ В МАССОВЫЕ ПРАВКИ НЕ ПОПАДАЮТ НИКОГДА — правило
   * донора. Иначе демо однажды окажется в списке на отключение.
   */
  async bulkPreview(ctx: PlatformCtx, d: { action: string; accountIds: string[]; days?: number }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const ids = (d.accountIds ?? []).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Выберите клиентов');

    const rows = (await this.q(
      `SELECT * FROM platform_bulk_targets($1::uuid[])`, [ids])).rows;

    const demo = rows.filter((r: any) => r.is_demo);
    const real = rows.filter((r: any) => !r.is_demo);

    return {
      action: d.action,
      willAffect: real.length,
      skippedDemo: demo.length,
      clients: real.map((r: any) => ({
        id: r.id, name: r.name, paidUntil: r.paid_until,
        after: d.action === 'grace' && d.days
          ? new Date(new Date(r.paid_until ?? Date.now()).getTime() + d.days * 86400000).toISOString()
          : null,
      })),
      note: demo.length
        ? `${real.length} клиентов затронет. Учебных пропущено: ${demo.length} — они не участвуют в деньгах`
        : `${real.length} клиентов затронет`,
    };
  }

  async bulkApply(ctx: PlatformCtx, d: { action: string; accountIds: string[]; days?: number }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const ids = (d.accountIds ?? []).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Выберите клиентов');

    // Учебные отсекаются ВНУТРИ функции, а не здесь: правило «демо не
    // участвует в деньгах» должно жить в одном месте, иначе новое
    // массовое действие однажды заденет учебный магазин партнёра.
    const done = Number((await this.q(
      `SELECT platform_bulk_apply($1::uuid[], $2, $3) AS n`,
      [ids, d.action, d.days ?? null])).rows[0].n);

    const total = Number((await this.q(
      `SELECT count(*) AS n FROM platform_bulk_targets($1::uuid[])`, [ids])).rows[0].n);

    await this.audit(ctx, 'bulk_' + d.action, null, { count: done, days: d.days });
    return { ok: true, affected: done, skippedDemo: total - done };
  }

  // ── УЧЕБНЫЙ МАГАЗИН ─────────────────────────────────────────────────
  /**
   * Демо для партнёра: показывать систему на боевом клиенте нельзя.
   * Исключён из всех денег и сводок — иначе они врут.
   */
  async markDemo(ctx: PlatformCtx, accountId: string, isDemo: boolean) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    await this.q(
      `INSERT INTO tenant_card (account_id, is_demo) VALUES ($1,$2)
       ON CONFLICT (account_id) DO UPDATE SET is_demo = $2, updated_at = now()`,
      [accountId, isDemo]);
    await this.audit(ctx, isDemo ? 'marked_demo' : 'unmarked_demo', accountId, {});
    return { ok: true, note: isDemo
      ? 'Магазин помечен учебным: не попадает в деньги, сводки и массовые действия'
      : 'Пометка снята — магазин снова участвует в деньгах и сводках' };
  }

  // ── РАЗДЕЛ «СВОДКА» ─────────────────────────────────────────────────
  /**
   * Где мы сейчас и куда движемся.
   *
   * Замысел донора верный: живые таблицы знают только «сейчас», для
   * «месяц назад было лучше или хуже» нужны снимки по дням.
   *
   * НАЙДЕНА ИХ СЛАБОСТЬ: снимок писался ПРИ ОТКРЫТИИ ЭКРАНА. Не
   * заходил неделю — недели в истории нет. Уехал в отпуск — в графике
   * дыра, и понять, что происходило, уже нельзя.
   *
   * У нас снимок пишет запускальщик раз в сутки, а деньги по дням
   * берутся из самих оплат — они восстановимы за любой день, даже если
   * снимка нет. Дыра портит счётчики клиентов, но не деньги.
   */
  async metrics(ctx: PlatformCtx, days = 30) {

    // Срез пишется ДВУМЯ путями, и это не лишнее.
    //
    // Планировщик в 03:00 записывает день, даже если панель никто не
    // открывал — у донора этого нет, и не заходил неделю значит
    // недели в истории нет.
    //
    // Открытие сводки страхует планировщик: если сервер лежал в три
    // ночи, день всё равно запишется, когда владелец зайдёт. Заполнить
    // такую дырку потом нечем — данные за прошлый день уже изменились.
    //
    // Задвоения не будет: день — ключ, повтор обновляет запись.
    await this.q(`SELECT platform_snapshot()`).catch(() => {});
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const n = Math.min(365, Math.max(7, Math.floor(Number(days))));

    const rows = (await this.q(`SELECT * FROM platform_summary_series($1)`, [n])).rows;

    const series = rows.map((r: any) => ({
      day: r.day,
      tenants: Number(r.tenants), active: Number(r.active),
      trial: Number(r.trial), expired: Number(r.expired),
      mrr: money(Number(r.mrr)),
      payments: Number(r.paid_count),
      amount: money(Number(r.paid_amount)),
      partnerShare: money(Number(r.partner_share)),
    }));

    const sum = (k: string) => series.reduce((a: number, d: any) => a + d[k], 0);
    const last: any = series[series.length - 1] ?? {};

    // Сравнение с прошлым таким же периодом: цифра без сравнения ничего
    // не значит. «Пришло 140 тысяч» — это много или мало?
    const prev = (await this.q(
      `SELECT coalesce(sum(tp.amount), 0) AS amt, count(*)::int AS cnt
         FROM tenant_payment tp
         LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
        WHERE tp.status = 'approved'
          AND tp.approved_at >= current_date - ($1 * 2 - 1)
          AND tp.approved_at <  current_date - ($1 - 1)
          AND coalesce(tc.is_demo, false) = false`, [n])).rows[0];

    // Ждущие одобрения и приход за сегодня — одним заходом.
    const extra = (await this.q(
      `SELECT
         (SELECT count(*) FROM account a
            LEFT JOIN tenant_card tc ON tc.account_id = a.id
           WHERE a.deleted_at IS NULL AND a.status = 'trial'
             AND tc.partner_id IS NULL
             AND coalesce(tc.is_demo, false) = false) AS pending,
         (SELECT coalesce(sum(tp.amount), 0) FROM tenant_payment tp
            LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
           WHERE tp.status = 'approved'
             AND tp.approved_at::date = current_date
             AND coalesce(tc.is_demo, false) = false) AS today_amount`)).rows[0];

    const nowAmount = sum('amount');
    const prevAmount = money(Number(prev.amt));

    return {
      series,
      days: n,
      now: {
        tenants: last.tenants ?? 0, active: last.active ?? 0,
        trial: last.trial ?? 0, expired: last.expired ?? 0,
        mrr: last.mrr ?? 0,
        // Ждут одобрения и поступило СЕГОДНЯ — их карточки. Первая
        // говорит, что кто-то стоит у двери; вторая отвечает на
        // вопрос, с которого начинается день владельца платформы.
        pending: Number(extra.pending ?? 0),
        revenueToday: money(Number(extra.today_amount ?? 0)),
      },
      period: {
        amount: nowAmount,
        payments: sum('payments'),
        partnerShare: sum('partnerShare'),
        platformShare: nowAmount - sum('partnerShare'),
      },
      // Рост или падение к прошлому такому же периоду. Направление
      // важнее величины: 140 тысяч при падении на треть — плохая
      // новость, при росте вдвое — хорошая.
      change: {
        amount: nowAmount - prevAmount,
        percent: prevAmount > 0
          ? Math.round((nowAmount - prevAmount) / prevAmount * 100) : null,
        prevAmount,
      },
      // Если снимков нет вовсе — сказать об этом, а не рисовать нули.
      // Пустой график читается как «дела плохи», хотя дело в другом.
      note: series.every((d: any) => d.tenants === 0)
        ? 'Снимки по дням ещё не собраны — счётчики клиентов появятся завтра. Деньги показаны за все дни.'
        : null,
    };
  }

  /**
   * Сбросить пароль владельцу магазина.
   *
   * Партнёру звонит клиент «забыл пароль» — и это должно решаться на
   * месте, а не походом в другой раздел. Новый пароль показывается
   * ОДИН раз: передать его надо голосом, а не письмом.
   */
  async resetOwnerPassword(ctx: PlatformCtx, accountId: string) {
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }
    // Пароль из букв и цифр без похожих знаков: его будут диктовать по
    // телефону, и «l» с «1» там не различить.
    const abc = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pass = Array.from({ length: 10 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');

    const r = await this.q(`SELECT platform_reset_owner_password($1, $2) AS ok`,
      [accountId, await bcrypt.hash(pass, 10)]);
    if (!r.rows[0]?.ok) throw new BadRequestException('У магазина нет владельца');

    await this.audit(ctx, 'owner_password_reset', accountId, {});
    return { password: pass,
      note: 'Пароль показан один раз — продиктуйте владельцу сейчас. Записывать его никуда не нужно.' };
  }

  /** Добавить кассу или точку с доплатой по правилу десяти дней. */
  async deviceAdd(ctx: PlatformCtx, accountId: string, kind: 'pos' | 'store') {
    if (ctx.role !== 'super') throw new ForbiddenException('Устройства подключает владелец платформы');

    const pv = await this.deviceAddPreview(ctx, accountId, kind);
    const set = (await this.q(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};
    const unit = Number(kind === 'pos' ? set.price_extra_pos : set.price_extra_store);

    // Строка счёта — чтобы со следующего месяца цена выросла на
    // понятную величину, а не стала другой цифрой без объяснения.
    const n = Number((await this.q(
      `SELECT count(*) AS n FROM plan_line
        WHERE account_id=$1 AND kind=$2 AND ends_at IS NULL`, [accountId, kind])).rows[0].n) + 2;

    await this.q(
      `INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
       VALUES ($1,$2,$3,1,$4)`,
      [accountId, kind, kind === 'pos' ? `Касса №${n}` : `Точка №${n}`, unit]);

    await this.audit(ctx, 'device_added', accountId, { kind, proRata: pv.proRata });
    return { ...pv, ok: true,
      note: pv.proRata > 0
        ? `Добавлено. Доплата ${pv.proRata} ₸ за остаток периода войдёт в счёт`
        : 'Добавлено. Доплаты нет — устройство войдёт в следующий счёт' };
  }

  /**
   * Удаление клиента. Требует набрать название СЛОВО В СЛОВО.
   *
   * Приём донора: удаление необратимо, а «случайно нажал» с чужими
   * деньгами не шутка. Набирая название, человек успевает подумать.
   *
   * На деле это мягкое удаление: магазин перестаёт работать, но данные
   * остаются — их могут спросить и через год, при разбирательстве.
   */
  async deleteTenant(ctx: PlatformCtx, accountId: string, confirmName: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Удаляет только владелец платформы');

    const acc = (await this.q(
      `SELECT * FROM platform_clients('super', NULL, NULL) WHERE id = $1`, [accountId])).rows[0];
    if (!acc) throw new BadRequestException('Клиент не найден');

    if (String(confirmName ?? '').trim() !== String(acc.name).trim())
      throw new BadRequestException(`Наберите название магазина слово в слово: «${acc.name}»`);

    await this.q(`SELECT platform_soft_delete_account($1)`, [accountId]);
    await this.audit(ctx, 'tenant_deleted', accountId, { name: acc.name });
    return { ok: true,
      note: 'Магазин отключён. Данные сохранены — их могут спросить и через год.' };
  }

  // ── ВОРОНКА И КАРТОЧКА ──────────────────────────────────────────────
  /**
   * Правка карточки клиента.
   *
   * ПРОВЕРКИ ТЕ ЖЕ, ЧТО ПРИ ЗАВЕДЕНИИ. Без них можно было испортить
   * правкой то, что не пропустили при создании: стереть название,
   * вписать телефон буквами (а по нему владелец входит в кабинет),
   * растянуть имя на двести знаков и разорвать таблицу.
   */
  async updateCard(ctx: PlatformCtx, accountId: string, d: any) {
    if (d.name != null) {
      const n = String(d.name).trim();
      if (!n) throw new BadRequestException('Название не может быть пустым');
      if (n.length > 80)
        throw new BadRequestException('Название длиннее 80 знаков — сократите');
      d = { ...d, name: n };
    }
    if (d.ownerPhone != null && String(d.ownerPhone).trim() !== '') {
      const digits = String(d.ownerPhone).replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15)
        throw new BadRequestException(
          'Телефон владельца непохож на номер — по нему он входит в кабинет');
    }
    for (const [key, label, max] of [
      ['city', 'Город', 60], ['ownerName', 'Имя владельца', 80],
      ['dealNote', 'Заметка', 500],
    ] as const) {
      if (d[key] != null && String(d[key]).length > max)
        throw new BadRequestException(`${label}: не длиннее ${max} знаков`);
    }

    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }

    // Название лежит в другой таблице и закрыто изоляцией — через
    // функцию. Правка на месте: опечатку гонять через лист
    // подтверждения незачем, это не деньги.
    if (d.name?.trim()) {
      await this.q(`SELECT platform_rename_account($1,$2)`, [accountId, d.name.trim()]);
    }

    await this.q(
      `INSERT INTO tenant_card (account_id, deal_stage, deal_note, city, owner_name, owner_phone, note, touched_at)
       VALUES ($1, coalesce($2,'new'), $3, $4, $5, $6, $7, now())
       ON CONFLICT (account_id) DO UPDATE SET
         deal_stage = coalesce($2, tenant_card.deal_stage),
         deal_note = coalesce($3, tenant_card.deal_note),
         city = coalesce($4, tenant_card.city),
         owner_name = coalesce($5, tenant_card.owner_name),
         owner_phone = coalesce($6, tenant_card.owner_phone),
         note = coalesce($7, tenant_card.note),
         touched_at = now(), updated_at = now()`,
      [accountId, d.dealStage ?? null, d.dealNote ?? null, d.city ?? null,
       d.ownerName ?? null, d.ownerPhone ?? null, d.note ?? null]);

    // Правка карточки ПИШЕТСЯ В ЖУРНАЛ. Журнал нужен ровно для вопроса
    // «кто это поменял», а название, город и телефон правят чаще
    // всего — и до сих пор эта правка следа не оставляла.
    //
    // Пишем ТОЛЬКО заполненные поля: иначе запись выглядит как
    // «поменял всё», хотя человек тронул одно.
    const changed = Object.fromEntries(
      Object.entries({
        name: d.name, city: d.city, ownerName: d.ownerName,
        ownerPhone: d.ownerPhone, dealStage: d.dealStage, dealNote: d.dealNote,
      }).filter(([, v]) => v != null && v !== ''));
    if (Object.keys(changed).length > 0) {
      await this.audit(ctx, 'card_updated', accountId, changed);
    }

    return { ok: true };
  }

  // ── КАРТОЧКА КЛИЕНТА ────────────────────────────────────────────────
  /**
   * Всё об одном клиенте на одном экране: контакты, подписка, состав
   * счёта, оплаты, заявки, устройства.
   *
   * Одним ответом, а не пятью запросами: карточку открывают, когда
   * звонит клиент, и ждать пять ожиданий по очереди при живом
   * разговоре нельзя.
   */
  async tenantCard(ctx: PlatformCtx, accountId: string) {
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }

    const [client, lines, pays, reqs] = await Promise.all([
      // Берём у ТОЙ ЖЕ функции, что и список клиентов: карточка
      // смотрела в platform_clients, а та счёт вовсе не считает — в
      // карточке стоял ноль, хотя в списке рядом 6 900.
      this.q(`SELECT * FROM platform_clients_filtered($1,$2,NULL,'all','all','due')
               WHERE id = $3`,
        [ctx.role, ctx.userId, accountId]),
      this.q(`SELECT id, kind, title, qty, unit_price, ends_at FROM plan_line
               WHERE account_id=$1 ORDER BY starts_at`, [accountId]),
      this.q(`SELECT * FROM platform_payments(NULL,'super',NULL) WHERE account_id=$1 LIMIT 20`,
        [accountId]),
      this.q(`SELECT * FROM platform_requests(NULL,'super',NULL) WHERE account_id=$1 LIMIT 20`,
        [accountId]),
    ]);

    const c = client.rows[0];
    if (!c) throw new BadRequestException('Клиент не найден');

    const days = c.paid_until
      ? Math.ceil((new Date(c.paid_until).getTime() - Date.now()) / 86400000) : null;

    return {
      id: c.id, name: c.name, phone: c.phone, city: c.city,
      owner: c.owner_name, ownerPhone: c.owner_phone,
      status: c.status, isDemo: c.is_demo,
      partner: c.partner_name, partnerId: c.partner_id,
      // Тариф и доля: карточка их рисует, а сервер не отдавал —
      // плашка тарифа была пустой, а «Ваша доля» показывала ноль.
      tariff: c.tariff_name,
      partnerPercent: Number(c.partner_bp ?? 0) / 100,
      dealStage: c.deal_stage, dealNote: c.deal_note, touchedAt: c.touched_at,
      paidUntil: c.paid_until, daysLeft: days,
      revenue30d: Math.round(Number(c.revenue_30d)),
      stores: Number(c.stores), registers: Number(c.registers),
      lines: lines.rows.map((r: any) => ({
        id: r.id, kind: r.kind, title: r.title, qty: Number(r.qty),
        price: money(Number(r.unit_price)), active: !r.ends_at,
      })),
      // Счёт берём у БАЗЫ, а не считаем заново: раньше карточка
      // складывала только строки и у клиента без своих строк
      // показывала НОЛЬ, хотя в списке рядом стояло 6 900. Седьмое
      // место с тем же расчётом — теперь их снова одно.
      monthly: money(Number(c.monthly ?? 0)),
      payments: pays.rows.map((r: any) => ({
        id: r.id, amount: money(Number(r.amount)), months: r.months,
        status: r.status, at: r.created_at,
      })),
      requests: reqs.rows,
    };
  }

  // ── ЗАВЕДЕНИЕ КЛИЕНТА ───────────────────────────────────────────────
  /**
   * Партнёр заводит клиента сам, не дожидаясь его самозаписи.
   *
   * Магазин создаётся сразу с владельцем и одноразовым паролем:
   * партнёр приезжает, ставит систему и отдаёт вход хозяину. Пароль
   * показан ОДИН раз — его диктуют голосом, а не пишут в переписке.
   *
   * Дубли ловим по последним десяти цифрам телефона: люди пишут номер
   * то с +7, то с 8. Урок донора, стоил им разбирательств.
   */
  async createTenant(ctx: PlatformCtx, d: {
    name: string; ownerName: string; ownerPhone: string; city?: string; trialDays?: number;
    /** Учебный магазин: ему срок не нужен, он не продаётся. */
    isDemo?: boolean;
  }) {
    const name = String(d.name ?? '').trim();
    if (!name) throw new BadRequestException('Укажите название магазина');
    // Длина: имя выводится в таблице, в ленте, в листах подтверждения
    // и в чужих кабинетах. Двести знаков разрывают строку везде разом.
    if (name.length > 80)
      throw new BadRequestException('Название длиннее 80 знаков — сократите');

    const phone = String(d.ownerPhone ?? '').trim();
    if (!phone) throw new BadRequestException('Укажите телефон владельца');
    // Телефон — это ВХОД владельца. «не телефон» и «+7701» принимались
    // молча, магазин заводился, а войти по такому нельзя: человек
    // получал доступ, которым не может воспользоваться.
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15)
      throw new BadRequestException(
        'Телефон владельца непохож на номер — по нему он будет входить в кабинет');

    // Пробный период: отрицательный кончается до начала, а десять лет
    // это не пробный, а бесплатный навсегда.
    //
    // Учебный магазин — исключение: ему десять лет дают НАРОЧНО. Он не
    // продаётся, на нём показывают систему, и срок ему не нужен.
    const trial = Number(d.trialDays ?? 14);
    if (!Number.isFinite(trial) || trial < 1 || (trial > 90 && !d.isDemo))
      throw new BadRequestException('Пробный период — от 1 до 90 дней');

    const dup = (await this.q(
      `SELECT id, name FROM platform_find_by_phone($1)`, [d.ownerPhone])).rows[0];
    if (dup) throw new BadRequestException(
      `Такой телефон уже у магазина «${dup.name}» — проверьте, не он ли это`);

    const abc = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pass = Array.from({ length: 10 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');

    // Функция отдаёт четыре поля: магазин, сотрудник, точка и КАССА.
    // Касса нужна, чтобы сразу выдать код привязки — партнёр в этот
    // момент стоит в магазине.
    const made = (await this.q(
      `SELECT * FROM platform_create_tenant($1,$2,$3,$4,$5,$6)`,
      [name, phone, d.ownerName?.trim() || 'Владелец',
       await bcrypt.hash(pass, 10), Math.floor(trial),
       ctx.role === 'partner' ? ctx.userId : null])).rows[0];
    const acc = { id: made.out_account };

    if (d.city) await this.q(
      `UPDATE tenant_card SET city=$2 WHERE account_id=$1`, [acc.id, d.city]);

    await this.audit(ctx, 'tenant_created', acc.id, { name: d.name, trialDays: d.trialDays ?? 14 });

    // Код привязки кассы отдаём СРАЗУ: партнёр в этот момент стоит в
    // магазине, и заставлять его лезть за кодом отдельно — значит
    // заставить приехать второй раз.
    const code = (await this.q(`SELECT * FROM platform_pairing_code($1)`, [acc.id]))
      .rows[0]?.code ?? null;

    return { id: acc.id, phone: d.ownerPhone, password: pass,
      ownerPhone: d.ownerPhone, activationCode: code,
      note: 'Пароль показан один раз — продиктуйте владельцу сейчас. Пробный период открыт.' };
  }

  // ── САМОЗАПИСЬ С САЙТА ──────────────────────────────────────────────
  /** Заявки с сайта: кто оставил телефон и ждёт звонка. */
  async leads(ctx: PlatformCtx, status?: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Заявки с сайта смотрит владелец платформы');
    return (await this.q(
      `SELECT id, name, phone, city, comment, status, created_at
         FROM lead WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC LIMIT 200`, [status ?? null])).rows;
  }

  /** Отметить, на каком этапе разговор с заявкой. */
  async setLead(ctx: PlatformCtx, id: string, status: string, note?: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const ok = ['new', 'called', 'demo', 'won', 'lost'];
    if (!ok.includes(status)) throw new BadRequestException('Неизвестный этап');
    await this.q(
      `UPDATE lead SET status=$2, comment=coalesce($3, comment) WHERE id=$1`,
      [id, status, note ?? null]);
    await this.audit(ctx, 'lead_updated', null, { id, status });
    return { ok: true };
  }

  /**
   * Одобрить самозапись: клиент зарегистрировался сам и ждёт.
   * Одобрение открывает пробный период.
   */
  async approveSignup(ctx: PlatformCtx, accountId: string, trialDays = 14) {
    if (ctx.role !== 'super') throw new ForbiddenException('Одобряет владелец платформы');
    const until = (await this.q(
      `SELECT platform_approve_signup($1,$2) AS until`,
      [accountId, Math.max(1, Math.floor(Number(trialDays)))])).rows[0]?.until;
    if (!until) throw new BadRequestException('Магазин не найден');
    await this.audit(ctx, 'signup_approved', accountId, { trialDays });
    return { ok: true, trialUntil: until,
      note: `Доступ открыт на ${trialDays} дней. Позвоните владельцу и помогите завести товары.` };
  }

  /** Отклонить самозапись. Причина обязательна — как и везде с отказами. */
  async rejectSignup(ctx: PlatformCtx, accountId: string, reason: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    if (!reason?.trim()) throw new BadRequestException('Напишите причину отказа');
    await this.q(`SELECT platform_soft_delete_account($1)`, [accountId]);
    await this.audit(ctx, 'signup_rejected', accountId, { reason: reason.trim() });
    return { ok: true };
  }

  // ── КОД АКТИВАЦИИ ───────────────────────────────────────────────────
  /**
   * Код для привязки кассы. Партнёр приезжает к клиенту, берёт код
   * здесь и вводит на планшете — не заходя в кабинет магазина.
   */
  async activationCode(ctx: PlatformCtx, accountId: string) {
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }
    const r = (await this.q(`SELECT * FROM platform_pairing_code($1)`, [accountId])).rows[0];
    if (!r?.code) throw new BadRequestException('У магазина нет кассы — сначала добавьте её');
    await this.audit(ctx, 'activation_code_taken', accountId, {});
    return { code: r.code, expiresAt: r.expires_at, register: r.register_name,
      note: 'Код одноразовый и живёт недолго. Введите его на кассе сейчас.' };
  }

  // ── СОСТОЯНИЕ И ТАРИФ ───────────────────────────────────────────────
  /** Заморозить или разморозить магазин. */
  async setTenantStatus(ctx: PlatformCtx, accountId: string, active: boolean) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    await this.q(`SELECT platform_set_status($1,$2)`, [accountId, active ? 'active' : 'suspended']);
    await this.audit(ctx, active ? 'tenant_enabled' : 'tenant_suspended', accountId, {});
    return { ok: true, note: active
      ? 'Магазин работает'
      : 'Магазин заморожен: продажи закрыты, кабинет открыт — владелец видит свои цифры' };
  }

  /**
   * Сменить тариф. Меняем ТОЛЬКО основную строку счёта: доплаты за
   * устройства и персональные скидки трогать нельзя — это отдельные
   * договорённости с клиентом. Правило донора.
   */
  async setTier(ctx: PlatformCtx, accountId: string, tier: 'base' | 'pro') {
    if (ctx.role !== 'super') throw new ForbiddenException('Тариф назначает владелец платформы');

    const set = (await this.q(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};
    const price = Number(tier === 'pro' ? set.price_pro : set.price_base);
    const title = tier === 'pro' ? 'Тариф «Стандарт»' : 'Тариф «Старт»';

    await this.q(`UPDATE plan_line SET ends_at = now()
                   WHERE account_id=$1 AND kind='base' AND ends_at IS NULL`, [accountId]);
    await this.q(`INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
                  VALUES ($1,'base',$2,1,$3)`, [accountId, title, price]);

    await this.audit(ctx, 'tier_changed', accountId, { tier, price: money(price) });
    return { ok: true, tier, monthly: money(price),
      note: 'Новый тариф войдёт в следующий счёт. Оплаченный период не меняется.' };
  }

  // ── ПРАВКИ ──────────────────────────────────────────────────────────
  /** Правка строки счёта: название, количество, цена. */
  async planLineEdit(ctx: PlatformCtx, id: string, d: {
    title?: string; qty?: number; price?: number;
  }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const cur = (await this.q(`SELECT * FROM plan_line WHERE id=$1`, [id])).rows[0];
    if (!cur) throw new BadRequestException('Строка не найдена');
    if (cur.ends_at) throw new BadRequestException('Строка закрыта — её нельзя править');

    const price = d.price != null
      ? Math.round(Number(d.price) * 100) * (cur.kind === 'discount' ? -1 : 1)
      : Number(cur.unit_price);

    await this.q(
      `UPDATE plan_line SET title=coalesce($2,title), qty=coalesce($3,qty), unit_price=$4
        WHERE id=$1`,
      [id, d.title?.trim() ?? null, d.qty != null ? Math.max(1, Math.floor(Number(d.qty))) : null, price]);

    await this.audit(ctx, 'plan_line_edited', cur.account_id, { id, ...d });
    return { ok: true, note: 'Новая сумма применится со следующего счёта' };
  }

  /**
   * Правка партнёра: имя, почта, телефон, доля, пароль.
   *
   * Почта — это ВХОД, поэтому меняется отдельной проверкой на занятость:
   * два партнёра с одной почтой означали бы, что один не сможет войти,
   * и виноватым окажется тот, кто заводил вторым.
   */
  async updatePartner(ctx: PlatformCtx, id: string, d: {
    name?: string; email?: string; phone?: string;
    commissionPercent?: number; password?: string;
  }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');

    const bp = d.commissionPercent != null ? Math.round(Number(d.commissionPercent) * 100) : null;
    if (bp != null && (bp < 0 || bp > 10000))
      throw new BadRequestException('Доля партнёра от 0 до 100%');

    if (d.email?.trim()) {
      const taken = (await this.q(
        `SELECT 1 FROM platform_user WHERE lower(email) = lower($1) AND id <> $2`,
        [d.email.trim(), id])).rows[0];
      if (taken) throw new BadRequestException('Эта почта уже занята другим человеком');
    }

    if (d.password && d.password.length < 8)
      throw new BadRequestException('Пароль не короче восьми знаков');

    await this.q(
      `UPDATE platform_user SET
         full_name     = coalesce($2, full_name),
         email         = coalesce($3, email),
         phone         = coalesce($4, phone),
         commission_bp = coalesce($5, commission_bp),
         password_hash = coalesce($6, password_hash)
       WHERE id = $1 AND role = 'partner'`,
      [id, d.name?.trim() || null, d.email?.trim() || null, d.phone || null, bp,
       d.password ? await bcrypt.hash(d.password, 10) : null]);

    await this.audit(ctx, 'partner_updated', null,
      { id, ...d, password: d.password ? '(сменён)' : undefined });

    // Прошлые выплаты не пересчитываются: доля заморожена при
    // подтверждении оплаты.
    return { ok: true, note: bp != null
      ? 'Новая доля — для будущих оплат. Уже подтверждённые хранят свою'
      : d.password ? 'Пароль сменён. Старый перестал работать' : 'Сохранено' };
  }

  /** Правка карточки клиента: контакты и заметки. */
  async updateTenant(ctx: PlatformCtx, accountId: string, d: any) {
    return this.updateCard(ctx, accountId, d);
  }

  // ── УЧЕБНЫЙ МАГАЗИН ─────────────────────────────────────────────────
  /**
   * Завести партнёру учебный магазин: показывать систему на боевом
   * клиенте нельзя. Наполняется теми же пробными данными, что и обычный.
   */
  async createDemo(ctx: PlatformCtx) {
    const who = ctx.role === 'partner' ? ctx.userId : null;
    const name = `Учебный магазин — ${ctx.name}`;

    const r = await this.createTenant(ctx, {
      name, ownerName: ctx.name, ownerPhone: '+7700' + Math.floor(1000000 + Math.random() * 8999999),
      trialDays: 3650, isDemo: true,
    });
    await this.q(
      `UPDATE tenant_card SET is_demo = true, partner_id = coalesce($2, partner_id)
        WHERE account_id = $1`, [r.id, who]);

    await this.audit(ctx, 'demo_created', r.id, {});
    return { ...r, isDemo: true,
      note: 'Учебный магазин создан. Он не участвует в деньгах, сводках и массовых действиях.' };
  }

  // ── РЕКВИЗИТЫ ОПЛАТЫ ────────────────────────────────────────────────
  /** Куда платить: картинка QR и текст с реквизитами. */
  /**
   * Куда платят магазины. Пять полей, а не одно «реквизиты словами»:
   * каждое отвечает за свою строку на экране клиента.
   *
   * Разница житейская: «Kaspi 7777 7777 7777, получатель Магжан С.»
   * одной строкой человек копирует ЦЕЛИКОМ и вставляет в поле номера —
   * перевод не проходит, и виноватой оказывается система.
   */
  async paySettings(ctx: PlatformCtx) {
    // Реквизиты видит только владелец: клиенты платят напрямую ему,
    // партнёр получает долю расчётом и чужой счёт знать не должен.
    if (ctx.role !== 'super')
      throw new ForbiddenException('Реквизиты видит владелец платформы');
    const s = (await this.q(
      `SELECT pay_url, pay_qr_url, pay_name, pay_phone, pay_note, pay_details
         FROM platform_settings WHERE id`)).rows[0] ?? {};
    return {
      payUrl: s.pay_url ?? '',
      payQrUrl: s.pay_qr_url ?? '',
      payName: s.pay_name ?? '',
      payPhone: s.pay_phone ?? '',
      payNote: s.pay_note ?? '',
      payDetails: s.pay_details ?? '',
    };
  }

  async savePaySettings(ctx: PlatformCtx, d: {
    payUrl?: string; payQrUrl?: string; payName?: string;
    payPhone?: string; payNote?: string; payDetails?: string;
  }) {
    if (ctx.role !== 'super') throw new ForbiddenException('Реквизиты меняет владелец платформы');
    // Пустую строку СОХРАНЯЕМ: владелец может намеренно убрать поле,
    // и coalesce вернул бы старое значение — поле нельзя было бы
    // очистить вовсе.
    await this.q(
      `UPDATE platform_settings SET
         pay_url     = coalesce($1, pay_url),
         pay_qr_url  = coalesce($2, pay_qr_url),
         pay_name    = coalesce($3, pay_name),
         pay_phone   = coalesce($4, pay_phone),
         pay_note    = coalesce($5, pay_note),
         pay_details = coalesce($6, pay_details),
         updated_at  = now() WHERE id`,
      [d.payUrl ?? null, d.payQrUrl ?? null, d.payName ?? null,
       d.payPhone ?? null, d.payNote ?? null, d.payDetails ?? null]);
    await this.audit(ctx, 'pay_settings_changed', null, {});
    // Клиент видит их в своём кабинете на странице подписки.
    return { ok: true, note: 'Клиенты увидят новые реквизиты сразу' };
  }

  // ── РАЗДЕЛ «ВОРОНКА» ────────────────────────────────────────────────
  /**
   * Воронка: карточки по этапам.
   *
   * Замысел донора: этап ВЫВОДИТСЯ ИЗ ФАКТОВ, пока его не двигали
   * руками. Заплатил — «Оплатил», идёт пробный — «Пробный». Ручной
   * сдвиг сильнее: человек знает о клиенте больше, чем база.
   *
   * СДЕЛАНО ЛУЧШЕ: вывод считает СЕРВЕР. У донора этап вычислялся при
   * отрисовке — два человека, открывшие воронку одновременно, могли
   * увидеть разное и не понять почему.
   *
   * Плюс различаем выведенный этап и поставленный руками. У донора это
   * было неразличимо: «Оплатил» означало и «система увидела оплату», и
   * «партнёр перетащил карточку».
   */
  async funnel(ctx: PlatformCtx, partnerId?: string) {
    const rows = (await this.q(
      `SELECT * FROM platform_funnel($1,$2,$3)`,
      [ctx.role, ctx.userId, partnerId || null])).rows;

    const stages = [
      { key: 'new',       title: 'Новые',     hint: 'нашли, ещё не говорили' },
      { key: 'contacted', title: 'Связались', hint: 'разговор идёт' },
      { key: 'trial',     title: 'Пробный',   hint: 'работает бесплатно' },
      { key: 'paid',      title: 'Оплатил',   hint: 'деньги пришли' },
      { key: 'lost',      title: 'Отказ',     hint: 'не сложилось' },
    ].map((st) => ({ ...st, cards: [] as any[], sum: 0 }));

    const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));

    for (const r of rows) {
      const card = {
        id: r.id, name: r.name, city: r.city,
        owner: r.owner_name, ownerPhone: r.owner_phone,
        stage: r.stage, isManual: r.stage_manual, derivedStage: r.derived_stage,
        note: r.deal_note, touchedAt: r.touched_at,
        // Сколько дней молчим — главный столбец воронки: сделка умирает
        // не от отказа, а от того, что о ней забыли.
        daysSilent: r.days_silent,
        cold: r.days_silent != null && r.days_silent >= 7,
        paidUntil: r.paid_until, daysLeft: r.days_left,
        monthly: money(Number(r.monthly)),
        partner: r.partner_name, partnerId: r.partner_id,
        createdAt: r.created_at,
      };
      const st = byKey[r.stage] ?? byKey.new;
      st.cards.push(card);
      st.sum += card.monthly;
    }

    return {
      stages: stages.map((s) => ({ ...s, count: s.cards.length })),
      // Сколько денег стоит на каждом этапе — это и есть смысл воронки:
      // видно, где застревают деньги, а не просто карточки.
      total: rows.length,
    };
  }

  /** Сдвинуть карточку. Ручной сдвиг сильнее вывода из фактов. */
  async funnelMove(ctx: PlatformCtx, accountId: string, stage: string, note?: string) {
    // 'auto' — снять ручную отметку и вернуть карточку к выводу из
    // фактов. Без него карточка, двинутая в сердцах в «Отказ»,
    // застревала там навсегда: клиент платит, а в воронке архив.
    const ok = ['new', 'contacted', 'trial', 'paid', 'lost', 'auto'];
    if (!ok.includes(stage)) throw new BadRequestException('Неизвестный этап');

    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
    }

    const r = (await this.q(`SELECT * FROM platform_funnel_move($1,$2,$3)`,
      [accountId, stage, note?.trim() ?? null])).rows[0];
    await this.audit(ctx, 'funnel_moved', accountId, { stage, note });
    return { ok: true, stage: r?.stage, manual: r?.manual, note: r?.note };
  }

  // ── ЖУРНАЛ ──────────────────────────────────────────────────────────
  private async audit(ctx: PlatformCtx, action: string, accountId: string | null, details: any) {
    await this.q(
      `INSERT INTO platform_audit (actor_id, actor_name, action, account_id, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.userId, ctx.name, action, accountId, JSON.stringify(details ?? {})]);
  }

  /**
   * Журнал: кто что сделал.
   *
   * Три мысли донора взяты: отбор делает сервер (партнёру чужие записи
   * не приходят вовсе, а не прячутся при отрисовке), листание по
   * времени последней записи (журнал растёт, и номера страниц
   * съезжают), денежные записи весомее прочих.
   *
   * СДЕЛАНО ЛУЧШЕ: запись описывается словами на сервере. У донора
   * кабинет знал список действий и переводил сам — появилось новое,
   * кабинет показал его кодом вроде «tenant_suspended», и человек
   * гадает, что это было.
   */
  async auditLog(ctx: PlatformCtx, opts: {
    before?: string; accountId?: string; actorId?: string;
    weight?: string; limit?: number;
  } = {}) {
    const rows = (await this.q(
      `SELECT * FROM platform_journal($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.role, ctx.userId,
       // Курсор — ПОРЯДКОВЫЙ НОМЕР, а не время: массовое действие
       // пишет несколько записей одним мгновением, и листание по
       // времени пропускало все, кроме первой.
       opts.before ? Number(opts.before) : null,
       opts.accountId || null, opts.actorId || null,
       opts.weight || null, Math.min(200, Math.max(1, Number(opts.limit ?? 50)))])).rows;

    return {
      rows: rows.map((r: any) => ({
        id: String(r.id), at: r.at,
        actor: r.actor, actorId: r.actor_id,
        action: r.action, title: r.title, detail: r.detail,
        // money — деньги, access — доступ, other — прочее. Кабинет
        // показывает по весу, а не решает сам, что важнее.
        weight: r.weight,
        accountId: r.account_id, client: r.client,
        amount: r.amount == null ? null : money(Number(r.amount)),
      })),
      // Курсор для следующей страницы: НОМЕР последней записи. Номера
      // страниц не годятся — журнал растёт, и они съезжают. Время не
      // годится тоже: записи одной секунды теряются на границе.
      nextBefore: rows.length ? String(rows[rows.length - 1].seq) : null,
      hasMore: rows.length >= Math.min(200, Math.max(1, Number(opts.limit ?? 50))),
    };
  }
}

// =====================================================================
/** Проверка входа в платформу. Отдельно от входа в магазин: другие люди. */
@Injectable()
export class PlatformGuard implements CanActivate {
  /**
   * Проверка живости живёт ЗДЕСЬ, в сторожевом слое, а не в каждом
   * методе службы: через него проходит каждое обращение, и пропустить
   * её нельзя, даже если завтра появится новый раздел.
   *
   * База нужна потому, что ключ подписан и не истёк — но это не
   * значит, что человеку всё ещё можно. Партнёру закрыли вход, а его
   * старый ключ работал: он видел клиентов, отмечал оплаты, заводил
   * новых.
   */
  static db: any = null;

  async canActivateAsync(x: ExecutionContext): Promise<boolean> {
    this.canActivate(x);
    const req = x.switchToHttp().getRequest();
    const id = req.platform?.userId;
    if (id && PlatformGuard.db) {
      const u = (await PlatformGuard.db.raw(
        `SELECT is_active, deleted_at FROM platform_user WHERE id = $1`, [id])).rows[0];
      if (!u || u.deleted_at) throw new UnauthorizedException('Учётная запись удалена');
      if (!u.is_active)
        throw new ForbiddenException('Доступ отключён владельцем платформы');
    }
    return true;
  }

  canActivate(x: ExecutionContext): boolean {
    const req = x.switchToHttp().getRequest();
    const h = String(req.headers.authorization ?? '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw new UnauthorizedException('Нужен вход в платформу');
    try {
      const p: any = jwt.verify(token, PLATFORM_SECRET);
      req.platform = { userId: p.sub, role: p.role, name: p.name, commissionBp: p.bp ?? 0 };
      return true;
    } catch { throw new UnauthorizedException('Сессия платформы истекла — войдите заново'); }
  }
}

/**
 * Достать, кто пришёл. Заодно ПРОВЕРИТЬ, ЖИВ ЛИ ОН.
 *
 * Найдено сверкой: партнёру закрыли вход, а его СТАРЫЙ КЛЮЧ продолжал
 * работать — он видел клиентов, отмечал оплаты, заводил новых.
 * «Закрыть вход» закрывало только повторный вход, а тот, кто уже
 * вошёл, оставался внутри до конца срока ключа.
 *
 * Проверка живёт здесь, потому что через Pl() проходит КАЖДОЕ
 * обращение: пропустить её нельзя, даже если завтра появится новый
 * раздел.
 */
const Pl = (req: any): PlatformCtx => req.platform;

@Controller('platform')
export class PlatformController {
  constructor(private svc: PlatformService) {}

  @Public() @Post('login')
  login(@Body() d: any) { return this.svc.login(d?.email, d?.password); }

  @Public() @Get('clients')
  async clients(@Req() r: any, @Query('q') q?: string, @Query('filter') filter?: string,
          @Query('partnerId') partnerId?: string, @Query('sort') sort?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.clients(Pl(r), { q, filter, partnerId, sort });
  }

  @Public() @Get('today')
  async today(@Req() r: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.today(Pl(r));
  }

  @Public() @Get('summary')
  async summary(@Req() r: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.summary(Pl(r));
  }

  @Public() @Get('payments')
  async payments(@Req() r: any, @Query('status') st?: string, @Query('days') days?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.payments(Pl(r), { status: st, days: days ? Number(days) : undefined });
  }

  @Public() @Post('payments')
  async record(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.recordPayment(Pl(r), d);
  }

  @Public() @Post('payments/:id/approve')
  async approve(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.approvePayment(Pl(r), id);
  }

  @Public() @Get('payments/:id/preview')
  async preview(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.previewPayment(Pl(r), id);
  }

  @Public() @Post('payments/:id/reject')
  async reject(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.rejectPayment(Pl(r), id, d?.reason);
  }

  @Public() @Get('partners')
  async partners(@Req() r: any, @Query('days') days?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.partners(Pl(r), days ? Number(days) : 30);
  }

  @Public() @Get('partners/:id/off-preview')
  async partnerOff(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.partnerOffPreview(Pl(r), id);
  }

  @Public() @Post('partners')
  async createPartner(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createPartner(Pl(r), d);
  }

  /**
   * Правка партнёра: имя, почта, доля, пароль, включение и отключение.
   *
   * РАНЬШЕ ЭТОТ АДРЕС ВЁЛ ТОЛЬКО НА ОТКЛЮЧЕНИЕ, а правка жила на
   * отдельном. Кабинет слал сюда всё — и имя с долей молча терялись,
   * а в ответ приходило «Вход закрыт», хотя никто ничего не закрывал.
   */
  @Public() @Patch('partners/:id')
  async patchPartner(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    const ctx = Pl(r);

    // Включение и отключение — отдельным действием: у него свой
    // ответ и своя запись в журнале.
    if (d && typeof d.isActive === 'boolean' && Object.keys(d).length === 1) {
      return this.svc.togglePartner(ctx, id, d.isActive);
    }
    return this.svc.updatePartner(ctx, id, d ?? {});
  }

  @Public() @Post('clients/:id/partner')
  async assign(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.assignPartner(Pl(r), id, d?.partnerId ?? null);
  }

  @Public() @Patch('clients/:id')
  async updateCard(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.updateCard(Pl(r), id, d ?? {});
  }

  // ── строки счёта ──
  @Public() @Get('clients/:id/lines')
  async lines(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.planLines(Pl(r), id);
  }

  @Public() @Post('clients/:id/lines')
  async addLine(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.addPlanLine(Pl(r), id, d);
  }

  @Public() @Delete('lines/:id')
  async closeLine(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.closePlanLine(Pl(r), id);
  }

  // ── доплата за устройство ──
  @Public() @Get('clients/:id/device-preview')
  async devicePreview(@Req() r: any, @Param('id') id: string, @Query('kind') kind: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.deviceAddPreview(Pl(r), id, kind === 'store' ? 'store' : 'pos');
  }

  // ── заявки ──
  @Public() @Get('requests')
  async requests(@Req() r: any, @Query('status') st?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.requests(Pl(r), st);
  }

  @Public() @Post('requests')
  async createRequest(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createRequest(Pl(r), d);
  }

  @Public() @Get('requests/:id/preview')
  async requestPreview(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.requestPreview(Pl(r), id);
  }

  @Public() @Post('requests/:id/decide')
  async decide(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.decideRequest(Pl(r), id, !!d?.approve, d?.note, d?.unitPrice);
  }

  // ── прайс-лист ──
  @Public() @Get('price-book')
  async priceBook(@Req() r: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.priceBook(Pl(r));
  }

  @Public() @Post('price-book')
  async setPriceBook(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.setPriceBook(Pl(r), d ?? {});
  }

  // ── массовые действия: всегда сначала предпросмотр ──
  @Public() @Post('bulk/preview')
  async bulkPreview(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.bulkPreview(Pl(r), d ?? {});
  }

  @Public() @Post('bulk/apply')
  async bulkApply(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.bulkApply(Pl(r), d ?? {});
  }

  // ── учебный магазин ──
  @Public() @Post('clients/:id/demo')
  async demo(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.markDemo(Pl(r), id, d?.isDemo !== false);
  }

  // ── сводка по дням ──
  @Public() @Get('metrics')
  async metrics(@Req() r: any, @Query('days') days?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.metrics(Pl(r), Number(days ?? 30));
  }

  @Public() @Post('reset-owner-password')
  async resetPass(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.resetOwnerPassword(Pl(r), d?.tenantId ?? d?.accountId);
  }

  @Public() @Post('device/add')
  async deviceAdd(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.deviceAdd(Pl(r), d?.tenantId ?? d?.accountId, d?.kind === 'store' ? 'store' : 'pos');
  }

  @Public() @Post('tenant/delete')
  async del(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.deleteTenant(Pl(r), d?.tenantId ?? d?.accountId, d?.confirmName ?? d?.name);
  }

  @Public() @Post('assign')
  async assignFlat(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.assignPartner(Pl(r), d?.tenantId ?? d?.accountId, d?.partnerId ?? null);
  }

  // ── карточка клиента ──
  @Public() @Get('clients/:id/card')
  async card(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.tenantCard(Pl(r), id);
  }

  // ── заведение клиента и учебного магазина ──
  @Public() @Post('tenants')
  async createTenant(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createTenant(Pl(r), d ?? {});
  }

  @Public() @Post('demo')
  async createDemo(@Req() r: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createDemo(Pl(r));
  }

  // ── заявки с сайта ──
  @Public() @Get('leads')
  async leads(@Req() r: any, @Query('status') st?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.leads(Pl(r), st);
  }

  @Public() @Post('leads/:id')
  async setLead(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.setLead(Pl(r), id, d?.status, d?.note);
  }

  @Public() @Post('signups/:id/approve')
  async approveSignup(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.approveSignup(Pl(r), id, Number(d?.trialDays ?? 14));
  }

  @Public() @Post('signups/:id/reject')
  async rejectSignup(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.rejectSignup(Pl(r), id, d?.reason);
  }

  // ── код активации кассы ──
  @Public() @Get('clients/:id/activation')
  async activation(@Req() r: any, @Param('id') id: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.activationCode(Pl(r), id);
  }

  // ── состояние и тариф ──
  @Public() @Post('clients/:id/status')
  async setStatus(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.setTenantStatus(Pl(r), id, d?.active !== false);
  }

  @Public() @Post('clients/:id/tier')
  async setTier(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.setTier(Pl(r), id, d?.tier === 'pro' ? 'pro' : 'base');
  }

  // ── правки ──
  @Public() @Patch('lines/:id')
  async editLine(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.planLineEdit(Pl(r), id, d ?? {});
  }

  @Public() @Post('partners/:id/update')
  async updatePartner(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.updatePartner(Pl(r), id, d ?? {});
  }

  // ── реквизиты оплаты ──
  @Public() @Get('pay-settings')
  async paySettings(@Req() r: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.paySettings(Pl(r));
  }

  @Public() @Post('pay-settings')
  async savePaySettings(@Req() r: any, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.savePaySettings(Pl(r), d ?? {});
  }

  @Public() @Get('funnel')
  async funnel(@Req() r: any, @Query('partnerId') pid?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.funnel(Pl(r), pid);
  }

  @Public() @Post('funnel/:id')
  async funnelMove(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.funnelMove(Pl(r), id, d?.stage, d?.note);
  }

  @Public() @Get('audit')
  async audit(@Req() r: any, @Query('accountId') accountId?: string,
        @Query('before') before?: string, @Query('actorId') actorId?: string,
        @Query('weight') weight?: string, @Query('limit') limit?: string) {
    await new PlatformGuard().canActivateAsync({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.auditLog(Pl(r), { accountId, before, actorId, weight,
      limit: limit ? Number(limit) : undefined });
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService, DbService] })
export class PlatformModule {}
