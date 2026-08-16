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
  async clients(ctx: PlatformCtx, q?: string) {
    // Через функцию с обходом изоляции: account, sale и store закрыты
    // правилом «только свой магазин», и платформа без этого видит
    // пустой список — молча, без ошибки. Фильтр по партнёру тоже
    // внутри функции: правило «видит только своих» должно жить в одном
    // месте, иначе однажды забудут добавить условие в новый запрос.
    const rows = (await this.q(
      `SELECT * FROM platform_clients($1, $2, $3)`,
      [ctx.role, ctx.userId, q?.trim() || null])).rows;

    return rows.map((r: any) => {
      const days = r.paid_until
        ? Math.ceil((new Date(r.paid_until).getTime() - Date.now()) / 86400000) : null;
      return {
        id: r.id, name: r.name, phone: r.phone, city: r.city,
        owner: r.owner_name, ownerPhone: r.owner_phone,
        status: r.status, subStatus: r.sub_status,
        tariff: r.tariff_name, partner: r.partner_name, partnerId: r.partner_id,
        dealStage: r.deal_stage, isDemo: r.is_demo,
        dealNote: r.deal_note, touchedAt: r.touched_at,
        paidUntil: r.paid_until, daysLeft: days,
        // Подсвечиваем за неделю: у донора именно так, и это тот срок,
        // когда звонок ещё уместен, а не выглядит выбиванием долга.
        expiringSoon: days != null && days <= 7 && days >= 0,
        expired: days != null && days < 0,
        revenue30d: Math.round(Number(r.revenue_30d)),
        stores: Number(r.stores), registers: Number(r.registers),
      };
    });
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

    const p = (await this.q(
      `SELECT * FROM tenant_payment WHERE id = $1`, [paymentId])).rows[0];
    if (!p) throw new BadRequestException('Оплата не найдена');
    if (p.status !== 'pending') throw new BadRequestException(`Оплата уже ${p.status === 'approved' ? 'подтверждена' : 'отклонена'}`);

    // Доля партнёра считается и ЗАМОРАЖИВАЕТСЯ сейчас. Поменяют
    // комиссию позже — прошлые выплаты не пересчитаются задним числом.
    const bp = p.partner_id
      ? Number((await this.q(`SELECT commission_bp FROM platform_user WHERE id = $1`,
          [p.partner_id])).rows[0]?.commission_bp ?? 0)
      : 0;
    const partnerShare = Math.round(Number(p.amount) * bp / 10000);
    const platformShare = Number(p.amount) - partnerShare;

    await this.q(
      `UPDATE tenant_payment
          SET status='approved', approved_by=$2, approved_at=now(),
              partner_bp=$3, partner_share=$4, platform_share=$5
        WHERE id=$1`,
      [paymentId, ctx.userId, bp, partnerShare, platformShare]);

    // Продление — через функцию с правом обхода изоляции. Таблица
    // подписок закрыта правилом «только свой магазин», и платформа,
    // которая смотрит на магазины сверху, не видит из неё ни строки.
    // Молча: запрос выполняется, обновляет ноль строк, ошибки нет.
    //
    // Правило «досрочная оплата не сжигает остаток» живёт там же, в
    // функции, а не повторяется здесь — чтобы не разъехалось.
    const until = new Date((await this.q(
      `SELECT platform_extend_subscription($1, $2) AS until`,
      [p.account_id, Number(p.months)])).rows[0].until);

    await this.audit(ctx, 'payment_approved', p.account_id,
      { amount: money(p.amount), months: p.months, paidUntil: until.toISOString(),
        partnerShare: money(partnerShare) });

    return {
      ok: true, paidUntil: until.toISOString(),
      partnerShare: money(partnerShare), platformShare: money(platformShare),
      note: `Доступ продлён до ${until.toLocaleDateString('ru-RU')}`,
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

    const bp = p.partner_id
      ? Number((await this.q(`SELECT commission_bp FROM platform_user WHERE id = $1`,
          [p.partner_id])).rows[0]?.commission_bp ?? 0)
      : 0;
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

  async payments(ctx: PlatformCtx, status?: string) {
    return (await this.q(
      `SELECT tp.id, tp.amount, tp.months, tp.method, tp.comment, tp.status,
              tp.reject_reason, tp.created_at, tp.approved_at,
              tp.partner_share, tp.platform_share,
              a.name AS client, a.id AS account_id,
              pu.full_name AS partner
         FROM tenant_payment tp
         JOIN account a ON a.id = tp.account_id
         LEFT JOIN platform_user pu ON pu.id = tp.partner_id
        WHERE ($1::text IS NULL OR tp.status::text = $1)
          AND ($2::text = 'super' OR tp.partner_id = $3::uuid)
        ORDER BY tp.created_at DESC LIMIT 200`,
      [status ?? null, ctx.role, ctx.userId])).rows
      .map((r: any) => ({ ...r, amount: money(r.amount),
        partnerShare: money(r.partner_share), platformShare: money(r.platform_share) }));
  }

  // ── ПАРТНЁРЫ ────────────────────────────────────────────────────────
  async partners(ctx: PlatformCtx) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    return (await this.q(
      `SELECT pu.id, pu.full_name, pu.email, pu.phone, pu.commission_bp,
              pu.is_active, pu.last_login_at, pu.created_at,
              (SELECT count(*) FROM tenant_card tc WHERE tc.partner_id = pu.id) AS clients,
              (SELECT count(*) FROM tenant_card tc
                 JOIN subscription s ON s.account_id = tc.account_id
                WHERE tc.partner_id = pu.id AND s.paid_until > now()) AS active_clients,
              (SELECT coalesce(sum(tp.partner_share), 0) FROM tenant_payment tp
                WHERE tp.partner_id = pu.id AND tp.status = 'approved'
                  AND tp.approved_at > now() - interval '30 days') AS earned_30d
         FROM platform_user pu
        WHERE pu.role = 'partner' AND pu.deleted_at IS NULL
        ORDER BY pu.created_at DESC`)).rows
      .map((r: any) => ({
        id: r.id, name: r.full_name, email: r.email, phone: r.phone,
        commissionPercent: r.commission_bp / 100,
        isActive: r.is_active, lastLoginAt: r.last_login_at,
        clients: Number(r.clients), activeClients: Number(r.active_clients),
        earned30d: money(Number(r.earned_30d)),
      }));
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

  /** Назначить клиенту партнёра. */
  async assignPartner(ctx: PlatformCtx, accountId: string, partnerId: string | null) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    await this.q(
      `INSERT INTO tenant_card (account_id, partner_id) VALUES ($1,$2)
       ON CONFLICT (account_id) DO UPDATE SET partner_id = $2, updated_at = now()`,
      [accountId, partnerId]);
    await this.audit(ctx, 'partner_assigned', accountId, { partnerId });
    return { ok: true };
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
    return (await this.q(
      `SELECT tr.id, tr.kind, tr.payload, tr.comment, tr.status, tr.decision_note,
              tr.created_at, tr.decided_at, a.name AS client, a.id AS account_id,
              pu.full_name AS author
         FROM tenant_request tr
         JOIN account a ON a.id = tr.account_id
         LEFT JOIN platform_user pu ON pu.id = tr.created_by
        WHERE ($1::text IS NULL OR tr.status = $1)
          AND ($2::text = 'super' OR tr.created_by = $3::uuid)
        ORDER BY tr.created_at DESC LIMIT 200`,
      [status ?? null, ctx.role, ctx.userId])).rows;
  }

  /** Решение по заявке. Отказ требует причины — как и с оплатой. */
  async decideRequest(ctx: PlatformCtx, id: string, approve: boolean, note?: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Решает владелец платформы');
    if (!approve && !note?.trim())
      throw new BadRequestException('Напишите причину отказа — партнёр должен понять, что не так');

    const r = await this.q(
      `UPDATE tenant_request SET status=$2, decision_note=$3, decided_by=$4, decided_at=now()
        WHERE id=$1 AND status='pending' RETURNING account_id, kind`,
      [id, approve ? 'approved' : 'rejected', note?.trim() ?? null, ctx.userId]);
    if (!r.rows[0]) throw new BadRequestException('Заявка не найдена или уже решена');

    await this.audit(ctx, approve ? 'request_approved' : 'request_rejected',
      r.rows[0].account_id, { kind: r.rows[0].kind, note });
    return { ok: true };
  }

  // ── ПРАЙС-ЛИСТ ──────────────────────────────────────────────────────
  async priceBook(ctx: PlatformCtx) {
    const s = (await this.q(`SELECT * FROM platform_settings WHERE id`)).rows[0] ?? {};
    return {
      base: money(Number(s.price_base)), pro: money(Number(s.price_pro)),
      extraPos: money(Number(s.price_extra_pos)), extraStore: money(Number(s.price_extra_store)),
      discount6m: Number(s.discount_6m_bp) / 100, discount12m: Number(s.discount_12m_bp) / 100,
      payQr: s.pay_qr_url, payDetails: s.pay_details,
    };
  }

  async setPriceBook(ctx: PlatformCtx, d: any) {
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

  // ── СВОДКА ПО ДНЯМ ──────────────────────────────────────────────────
  /** Как менялись деньги и число клиентов. Демо исключены. */
  async metrics(ctx: PlatformCtx, days = 30) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    const n = Math.min(365, Math.max(7, Math.floor(Number(days))));
    return (await this.q(
      `SELECT date_trunc('day', tp.approved_at)::date AS day,
              sum(tp.amount) AS amount,
              sum(tp.partner_share) AS partner_share,
              count(*)::int AS payments
         FROM tenant_payment tp
         LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
        WHERE tp.status = 'approved' AND tp.approved_at > now() - ($1 || ' days')::interval
          AND coalesce(tc.is_demo, false) = false
        GROUP BY 1 ORDER BY 1`, [n])).rows
      .map((r: any) => ({ day: r.day, amount: money(Number(r.amount)),
                          partnerShare: money(Number(r.partner_share)), payments: r.payments }));
  }

  // ── ВОРОНКА И КАРТОЧКА ──────────────────────────────────────────────
  async updateCard(ctx: PlatformCtx, accountId: string, d: any) {
    if (ctx.role === 'partner') {
      const own = (await this.q(
        `SELECT 1 FROM tenant_card WHERE account_id=$1 AND partner_id=$2`,
        [accountId, ctx.userId])).rows[0];
      if (!own) throw new ForbiddenException('Это не ваш клиент');
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
    return { ok: true };
  }

  // ── ЖУРНАЛ ──────────────────────────────────────────────────────────
  private async audit(ctx: PlatformCtx, action: string, accountId: string | null, details: any) {
    await this.q(
      `INSERT INTO platform_audit (actor_id, actor_name, action, account_id, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.userId, ctx.name, action, accountId, JSON.stringify(details ?? {})]);
  }

  async auditLog(ctx: PlatformCtx, accountId?: string) {
    if (ctx.role !== 'super') throw new ForbiddenException('Только владелец платформы');
    return (await this.q(
      `SELECT actor_name, action, account_id, details, at
         FROM platform_audit
        WHERE ($1::uuid IS NULL OR account_id = $1)
        ORDER BY at DESC LIMIT 200`, [accountId ?? null])).rows;
  }
}

// =====================================================================
/** Проверка входа в платформу. Отдельно от входа в магазин: другие люди. */
@Injectable()
export class PlatformGuard implements CanActivate {
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

const Pl = (req: any): PlatformCtx => req.platform;

@Controller('platform')
export class PlatformController {
  constructor(private svc: PlatformService) {}

  @Public() @Post('login')
  login(@Body() d: any) { return this.svc.login(d?.email, d?.password); }

  @Public() @Get('clients')
  clients(@Req() r: any, @Query('q') q?: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.clients(Pl(r), q);
  }

  @Public() @Get('summary')
  summary(@Req() r: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.summary(Pl(r));
  }

  @Public() @Get('payments')
  payments(@Req() r: any, @Query('status') s?: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.payments(Pl(r), s);
  }

  @Public() @Post('payments')
  record(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.recordPayment(Pl(r), d);
  }

  @Public() @Post('payments/:id/approve')
  approve(@Req() r: any, @Param('id') id: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.approvePayment(Pl(r), id);
  }

  @Public() @Get('payments/:id/preview')
  preview(@Req() r: any, @Param('id') id: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.previewPayment(Pl(r), id);
  }

  @Public() @Post('payments/:id/reject')
  reject(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.rejectPayment(Pl(r), id, d?.reason);
  }

  @Public() @Get('partners')
  partners(@Req() r: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.partners(Pl(r));
  }

  @Public() @Post('partners')
  createPartner(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createPartner(Pl(r), d);
  }

  @Public() @Patch('partners/:id')
  togglePartner(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.togglePartner(Pl(r), id, !!d?.isActive);
  }

  @Public() @Post('clients/:id/partner')
  assign(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.assignPartner(Pl(r), id, d?.partnerId ?? null);
  }

  @Public() @Patch('clients/:id')
  updateCard(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.updateCard(Pl(r), id, d ?? {});
  }

  // ── строки счёта ──
  @Public() @Get('clients/:id/lines')
  lines(@Req() r: any, @Param('id') id: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.planLines(Pl(r), id);
  }

  @Public() @Post('clients/:id/lines')
  addLine(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.addPlanLine(Pl(r), id, d);
  }

  @Public() @Delete('lines/:id')
  closeLine(@Req() r: any, @Param('id') id: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.closePlanLine(Pl(r), id);
  }

  // ── доплата за устройство ──
  @Public() @Get('clients/:id/device-preview')
  devicePreview(@Req() r: any, @Param('id') id: string, @Query('kind') kind: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.deviceAddPreview(Pl(r), id, kind === 'store' ? 'store' : 'pos');
  }

  // ── заявки ──
  @Public() @Get('requests')
  requests(@Req() r: any, @Query('status') st?: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.requests(Pl(r), st);
  }

  @Public() @Post('requests')
  createRequest(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.createRequest(Pl(r), d);
  }

  @Public() @Post('requests/:id/decide')
  decide(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.decideRequest(Pl(r), id, !!d?.approve, d?.note);
  }

  // ── прайс-лист ──
  @Public() @Get('price-book')
  priceBook(@Req() r: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.priceBook(Pl(r));
  }

  @Public() @Post('price-book')
  setPriceBook(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.setPriceBook(Pl(r), d ?? {});
  }

  // ── массовые действия: всегда сначала предпросмотр ──
  @Public() @Post('bulk/preview')
  bulkPreview(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.bulkPreview(Pl(r), d ?? {});
  }

  @Public() @Post('bulk/apply')
  bulkApply(@Req() r: any, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.bulkApply(Pl(r), d ?? {});
  }

  // ── учебный магазин ──
  @Public() @Post('clients/:id/demo')
  demo(@Req() r: any, @Param('id') id: string, @Body() d: any) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.markDemo(Pl(r), id, d?.isDemo !== false);
  }

  // ── сводка по дням ──
  @Public() @Get('metrics')
  metrics(@Req() r: any, @Query('days') days?: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.metrics(Pl(r), Number(days ?? 30));
  }

  @Public() @Get('audit')
  audit(@Req() r: any, @Query('accountId') a?: string) {
    new PlatformGuard().canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as any);
    return this.svc.auditLog(Pl(r), a);
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService, DbService] })
export class PlatformModule {}
