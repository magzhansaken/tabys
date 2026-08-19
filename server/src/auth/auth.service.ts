import { Injectable, UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { createSmsProvider } from './sms.provider';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { EmployeeContext, PermissionMatrix } from './permissions';

const ACCESS_TTL = '15m';
const REFRESH_DAYS = 30;
const OTP_TTL_MIN = 5;
const PIN_LOCK_FAILS = 5;
// В бою — 12 (медленный хэш = перебор PIN бессмыслен). В тестах — 4, иначе
// прогон 40 проверок упирается в bcrypt, а не в логику.
let _sms: any = null;
/** Шлюз создаётся один раз: разбирать настройки на каждый код незачем. */
const getSmsProvider = () => (_sms ??= createSmsProvider());

const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const pinFingerprint = (accountId: string, pin: string) =>
  createHmac('sha256', process.env.PIN_FP_SECRET ?? 'dev_secret').update(`${accountId}:${pin}`).digest('hex');

@Injectable()
export class AuthService {
  constructor(private db: DbService, private jwt: JwtService) {}

  // ==================================================================
  // РЕГИСТРАЦИЯ (владелец) — по SMS-коду, а не по почте:
  // у владельца магазина в КЗ телефон есть всегда, почты может не быть.
  // ==================================================================
  async requestOtp(phone: string, purpose: 'register' | 'reset_password', ip?: string) {
    const { rows } = await this.db.raw(
      `SELECT count(*)::int AS n FROM otp_code WHERE phone=$1 AND sent_at > now() - interval '1 hour'`, [phone]);
    if (rows[0].n >= 3) throw new BadRequestException('Слишком много запросов кода. Попробуйте через час.');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.db.raw(
      `INSERT INTO otp_code (phone, purpose, code_hash, expires_at, ip)
       VALUES ($1,$2,$3, now() + interval '${OTP_TTL_MIN} minutes', $4)`,
      [phone, purpose, sha256(code), ip ?? null]);

    // Отправка кода. Пока СМС-шлюз не подключён, есть аварийный режим:
    // при OTP_LOG=1 код пишется в ЛОГ СЕРВЕРА. Это безопаснее, чем отдавать
    // его в ответе API: лог виден только тому, у кого есть доступ к серверу,
    // а через ответ любой человек мог бы регистрировать аккаунты на чужие
    // номера. Включается только на время запуска, до подключения шлюза.
    if (process.env.OTP_LOG === '1')
      console.log(`[OTP] ${phone} (${purpose}): код ${code} — действует ${OTP_TTL_MIN} мин`);

    // Отправка через шлюз, если он подключён. Ошибка отправки НЕ ломает
    // запрос кода: код уже создан и живёт в базе. Иначе неоплаченный
    // счёт у оператора связи останавливал бы регистрацию новых клиентов.
    const sms = getSmsProvider();
    if (sms.name !== 'mock') {
      const text = (process.env.SMS_TEMPLATE ?? 'Табыс: код {code}. Никому его не сообщайте')
        .replace('{code}', code);
      const res = await sms.send(phone, text).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!res.ok) console.warn(`[SMS] не отправлено на ${phone}: ${res.error}`);
    }

    // TODO(Часть 14): реальная отправка через SMS-шлюз РК (Mobizon/SMSC/AutoCall).
    return process.env.NODE_ENV === 'production' ? { sent: true } : { sent: true, devCode: code };
  }

  async register(dto: { phone: string; code?: string; businessName: string; ownerName: string; password: string; lang?: 'ru' | 'kk'; note?: string }) {
    // Код из СМС требуется, только когда подключён шлюз (REQUIRE_OTP=1).
    // Пока шлюза нет — регистрация по телефону и паролю, а телефон
    // проверяет живой звонок оператора при активации. Для платного B2B
    // это надёжнее автоматической СМС: владелец говорит с каждым клиентом.
    if (process.env.REQUIRE_OTP === '1') {
      if (!dto.code) throw new BadRequestException('Введите код из СМС');
      const ok = await this.db.raw(`SELECT auth_consume_otp($1,'register',$2) AS ok`, [dto.phone, sha256(dto.code)]);
      if (!ok.rows[0].ok) throw new UnauthorizedException('Неверный или просроченный код');
    }

    const exists = await this.db.findLoginByPhone(dto.phone);
    if (exists) throw new BadRequestException('Этот номер уже зарегистрирован');

    const r = await this.db.raw(`SELECT * FROM register_account($1,$2,$3,$4)`,
      [dto.phone, dto.businessName, dto.ownerName, dto.lang ?? 'ru']);
    const { account_id, employee_id } = r.rows[0];

    // Заявка ждёт активации оператором. Пока REQUIRE_OTP выключен, это
    // единственная проверка «живой ли клиент» — и она сильнее СМС.
    // Нужна ли модерация заявки оператором:
    //   MODERATE_SIGNUP=1 — да, =0 — нет;
    //   по умолчанию ВКЛЮЧЕНА везде, кроме тестов (иначе каждый тест
    //   упирался бы в «ожидает активации» — а в бою безопасность важнее).
    const moderate = process.env.MODERATE_SIGNUP === '1' ? true
      : process.env.MODERATE_SIGNUP === '0' ? false
      : process.env.NODE_ENV !== 'test';

    // Через withTenant, а не raw: таблица под построчной защитой, и запрос
    // без контекста магазина просто не увидел бы строку — обновление ушло
    // бы «в пустоту» молча, а аккаунт остался бы активным.
    if (moderate)
      await this.db.withTenant(account_id, async (c) => {
        await c.query(`UPDATE account SET status='pending', signup_note=$2 WHERE id=$1`,
          [account_id, dto.note ?? null]);
      });

    // Пробный период стартует сразу при регистрации (модель UMAG/Wipon):
    // иначе новый клиент открыл бы кассу и упёрся в «Нет подписки».
    await this.db.withTenant(account_id, async (c) => {
      await c.query(
        `INSERT INTO subscription (account_id, tariff_id, status, price_locked, price_locked_until,
                                   stores_paid, paid_until)
         SELECT $1, t.id, 'trial', t.price_month, current_date + interval '1 year', 1, current_date + 14
           FROM tariff t WHERE t.code = 'start'
          -- Ровно одна строка. Без ограничения при двух тарифах с
          -- одним кодом вставка даёт две записи и падает на
          -- «подзапрос вернул больше одной строки» — регистрация
          -- клиента встаёт целиком.
          ORDER BY t.created_at LIMIT 1
         ON CONFLICT (account_id) DO NOTHING`, [account_id]);
    });

    await this.db.withTenant(account_id, async (c) => {
      await c.query(`UPDATE employee SET password_hash=$1 WHERE id=$2`,
        [await bcrypt.hash(dto.password, BCRYPT_COST), employee_id]);
    });
    // КАРТОЧКА КЛИЕНТА для платформы. Записавшийся с сайта — самый
    // важный клиент: он пришёл сам, его никто не ведёт, и если не
    // позвонить в первый день, он уйдёт.
    //
    // Без карточки у владельца платформы в списке пусто в колонках
    // «владелец» и «телефон» — позвонить нечем, и поиск по имени его
    // не находит.
    await this.db.raw(`SELECT platform_ensure_card($1)`, [account_id]).catch(() => {});

    return this.issueTokens(account_id, employee_id);
  }

  // ==================================================================
  // ВХОД В КАБИНЕТ: телефон + пароль (модель UMAG/Wipon, не почта как МС)
  // ==================================================================
  async login(phone: string, password: string, meta: { ip?: string; ua?: string } = {}) {
    const locked = await this.db.raw(`SELECT auth_is_locked_out($1,'admin_password') AS l`, [phone]);
    if (locked.rows[0].l) throw new ForbiddenException('Слишком много попыток. Подождите 5 минут.');

    const e = await this.db.findLoginByPhone(phone);
    const fail = async (reason: string) => {
      await this.db.raw(`SELECT auth_log_attempt($1,$2,NULL,'admin_password',$3,false,$4,$5,$6)`,
        [e?.account_id ?? null, e?.employee_id ?? null, phone, reason, meta.ip ?? null, meta.ua ?? null]);
      throw new UnauthorizedException('Неверный телефон или пароль');
    };

    if (!e || !e.password_hash) return fail('no_user');
    if (!(await bcrypt.compare(password, e.password_hash))) return fail('bad_password');
    if (e.dismissed || !e.is_active) return fail('dismissed');           // «бывшие сотрудники» (UMAG)
    if (!e.can_login_admin) return fail('no_admin_access');              // кассиру в кабинет нельзя
    if (e.account_status === 'suspended') return fail('account_suspended');

    await this.db.raw(`SELECT auth_log_attempt($1,$2,NULL,'admin_password',$3,true,NULL,$4,$5)`,
      [e.account_id, e.employee_id, phone, meta.ip ?? null, meta.ua ?? null]);

    return this.issueTokens(e.account_id, e.employee_id, meta);
  }

  // ==================================================================
  // ТОКЕНЫ. Refresh с ротацией: повторное использование старого токена —
  // признак кражи, гасим всё семейство и требуем вход заново.
  // ==================================================================
  private async issueTokens(accountId: string, employeeId: string, meta: { ip?: string; ua?: string } = {}, familyId?: string) {
    const ctx = await this.loadContext(accountId, employeeId);
    const access = await this.jwt.signAsync(
      { sub: employeeId, acc: accountId, role: ctx.roleCode, owner: ctx.isOwner },
      { expiresIn: ACCESS_TTL });

    const refresh = randomBytes(32).toString('base64url');
    const family = familyId ?? randomUUID();
    await this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO refresh_token (account_id, employee_id, family_id, token_hash, expires_at, ip, user_agent)
         VALUES ($1,$2,$3,$4, now() + interval '${REFRESH_DAYS} days', $5,$6)`,
        [accountId, employeeId, family, sha256(refresh), meta.ip ?? null, meta.ua ?? null]);
      await c.query(`UPDATE employee SET last_login_at = now() WHERE id=$1`, [employeeId]);
    });
    return { access, refresh, employee: ctx };
  }

  async refresh(token: string, meta: { ip?: string; ua?: string } = {}) {
    // Проверка и пометка «использован» происходят одной операцией в БД —
    // иначе два параллельных запроса с одним токеном оба прошли бы.
    const { rows } = await this.db.raw(`SELECT * FROM auth_use_refresh($1)`, [sha256(token)]);
    const t = rows[0];
    if (!t) throw new UnauthorizedException('Сессия не найдена');
    if (t.reuse) throw new UnauthorizedException('Сессия скомпрометирована, войдите заново');
    if (t.expired) throw new UnauthorizedException('Сессия истекла');
    if (t.blocked) throw new UnauthorizedException('Сотрудник отключён');
    return this.issueTokens(t.account_id, t.employee_id, meta, t.family_id);
  }

  async logout(refreshToken: string) {
    await this.db.raw(`SELECT auth_revoke_refresh($1,'logout')`, [sha256(refreshToken)]);
    return { ok: true };
  }

  async resetPassword(phone: string, code: string, newPassword: string) {
    const ok = await this.db.raw(`SELECT auth_consume_otp($1,'reset_password',$2) AS ok`, [phone, sha256(code)]);
    if (!ok.rows[0].ok) throw new UnauthorizedException('Неверный или просроченный код');
    const e = await this.db.findLoginByPhone(phone);
    if (!e) throw new BadRequestException('Номер не найден');

    await this.db.withTenant(e.account_id, async (c) => {
      await c.query(`UPDATE employee SET password_hash=$1 WHERE id=$2`,
        [await bcrypt.hash(newPassword, BCRYPT_COST), e.employee_id]);
      // при сбросе пароля все сессии гасим (как в МоемСкладе: старый пароль перестаёт работать)
      await c.query(`UPDATE refresh_token SET revoked_at=now(), revoke_reason='password_reset'
                      WHERE employee_id=$1 AND revoked_at IS NULL`, [e.employee_id]);
    });
    return { ok: true };
  }

  /**
   * Смена пароля, когда текущий известен (Wipon: текущий → новый → повтор).
   * Остальные сессии гасим: если пароль меняют из-за подозрений, старые
   * входы должны отвалиться немедленно.
   */
  async changePassword(accountId: string, employeeId: string, currentPassword: string, newPassword: string) {
    return this.db.withTenant(accountId, async (c) => {
      const e = (await c.query(`SELECT password_hash FROM employee WHERE id=$1`, [employeeId])).rows[0];
      if (!e?.password_hash) throw new BadRequestException('Пароль не задан');
      if (!(await bcrypt.compare(currentPassword, e.password_hash)))
        throw new UnauthorizedException('Текущий пароль неверен');
      await c.query(`UPDATE employee SET password_hash=$1 WHERE id=$2`,
        [await bcrypt.hash(newPassword, BCRYPT_COST), employeeId]);
      await c.query(`UPDATE refresh_token SET revoked_at=now(), revoke_reason='password_changed'
                      WHERE employee_id=$1 AND revoked_at IS NULL`, [employeeId]);
      return { ok: true };
    });
  }

  // ==================================================================
  // КАССА: привязка устройства одноразовым ключом (модель UMAG).
  // ==================================================================
  async createPairingCode(accountId: string, cashRegisterId: string, name?: string) {
    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 символов, читается вслух по телефону
    return this.db.withTenant(accountId, async (c) => {
      // RLS защищает строку, которую мы пишем, но НЕ проверяет чужие ссылки:
      // без этой проверки чужой аккаунт выдал бы ключ привязки к нашей кассе.
      const own = await c.query(`SELECT id FROM cash_register WHERE id=$1 AND deleted_at IS NULL`, [cashRegisterId]);
      if (!own.rows[0]) throw new ForbiddenException('Касса не найдена в вашем аккаунте');
      await c.query(`UPDATE device SET deleted_at=now() WHERE cash_register_id=$1 AND token_hash IS NULL`, [cashRegisterId]);
      const { rows } = await c.query(
        `INSERT INTO device (account_id, cash_register_id, name, pairing_code, pairing_expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '15 minutes') RETURNING id, pairing_expires_at`,
        [accountId, cashRegisterId, name ?? null, code]);
      return { code, deviceId: rows[0].id, expiresAt: rows[0].pairing_expires_at };
    });
  }

  async pairDevice(code: string, platform: string, appVersion: string, ip?: string) {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await this.db.raw(`SELECT * FROM auth_pair_device($1,$2,$3,$4)`,
      [code.trim().toUpperCase(), sha256(token), platform, appVersion]);
    if (!rows[0]) {
      await this.db.raw(`SELECT auth_log_attempt(NULL,NULL,NULL,'device_pairing',$1,false,'bad_or_expired_code',$2,NULL)`,
        [code, ip ?? null]);
      throw new UnauthorizedException('Ключ неверен или истёк. Сгенерируйте новый в кабинете.');
    }
    const d = rows[0];
    await this.db.raw(`SELECT auth_log_attempt($1,NULL,$2,'device_pairing',$3,true,NULL,$4,NULL)`,
      [d.account_id, d.device_id, code, ip ?? null]);

    return { deviceToken: token, deviceId: d.device_id, accountId: d.account_id, cashRegisterId: d.cash_register_id };
  }

  /** Проверка токена устройства (заголовок X-Device-Token). */
  async resolveDevice(token: string) {
    const { rows } = await this.db.raw(`SELECT * FROM auth_find_device_by_token($1)`, [sha256(token)]);
    const d = rows[0];
    if (!d) throw new UnauthorizedException('Устройство не привязано');
    if (d.is_blocked) throw new ForbiddenException('Устройство заблокировано');
    if (d.account_status === 'suspended') throw new ForbiddenException('Аккаунт приостановлен');
    await this.db.raw(`SELECT auth_touch_device($1)`, [d.device_id]);
    return d;
  }

  /**
   * Пакет для офлайн-работы: хэши PIN, роли и разрешения кассы уезжают на
   * устройство, чтобы вход и проверка прав работали БЕЗ интернета.
   * Это то, чего нет в документации UMAG (офлайн не упомянут ни разу)
   * и что у Wipon требует онлайна (вход по телефону и паролю).
   */
  async posBootstrap(accountId: string, deviceId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const dev = (await c.query(
        `SELECT d.cash_register_id, cr.store_id, cr.warehouse_id,
                coalesce(cr.pos_profile_id, s.pos_profile_id) AS profile_id
           FROM device d
           JOIN cash_register cr ON cr.id = d.cash_register_id
           JOIN store s ON s.id = cr.store_id
          WHERE d.id=$1`, [deviceId])).rows[0];

      const staff = (await c.query(
        `SELECT e.id, e.first_name, e.last_name, e.pos_pin_hash, e.badge_barcode,
                e.is_shift_admin, e.is_owner, r.code AS role_code, r.permissions,
                r.can_see_purchase_price, r.can_see_revenue
           FROM employee e
           LEFT JOIN role r ON r.id = e.role_id
           LEFT JOIN employee_store es ON es.employee_id = e.id
          WHERE e.can_login_pos AND e.is_active AND e.dismissed_at IS NULL AND e.deleted_at IS NULL
            AND (es.store_id = $1 OR e.is_owner)
          GROUP BY e.id, r.code, r.permissions, r.can_see_purchase_price, r.can_see_revenue`,
        [dev.store_id])).rows;

      const profile = dev.profile_id
        ? (await c.query(`SELECT * FROM pos_profile WHERE id=$1`, [dev.profile_id])).rows[0]
        : null;

      // Бонусная программа: правила задаются в кабинете, касса лишь исполняет
      // (модель МоегоСклада: «настройка — в вебе, оплата баллами — в кассе»)
      const lp = (await c.query(
        `SELECT id, earn_percent, spend_percent, max_spend, min_purchase
           FROM loyalty_program
          WHERE kind='cashback' AND is_active AND deleted_at IS NULL
            AND (store_id IS NULL OR store_id = $1)
          ORDER BY store_id NULLS LAST LIMIT 1`, [dev.store_id])).rows[0];

      // консультанты точки — для выбора «продавца в чеке» офлайн (UMAG)
      const consultants = (await c.query(
        `SELECT id, name FROM consultant
          WHERE is_active AND deleted_at IS NULL AND (store_id IS NULL OR store_id = $1)
          ORDER BY name`, [dev.store_id])).rows;

      // брендирование чека (часть 21): растр логотипа сервер собрал заранее —
      // касса печатает готовые байты, ей не нужен декодер картинок
      const br = (await c.query(
        `SELECT receipt_logo_raster, receipt_logo_width, receipt_logo_height, receipt_ad_text
           FROM branding WHERE account_id=$1`, [accountId])).rows[0];

      return { device: dev, staff, posProfile: profile, consultants,
               branding: br ? {
                 logoRaster: br.receipt_logo_raster, logoWidth: br.receipt_logo_width,
                 logoHeight: br.receipt_logo_height, adText: br.receipt_ad_text,
               } : null,
               loyaltyProgram: lp ? { id: lp.id, earnPercent: Number(lp.earn_percent),
                 spendPercent: Number(lp.spend_percent), maxSpend: Number(lp.max_spend),
                 minPurchase: Number(lp.min_purchase) } : null,
               syncedAt: new Date().toISOString() };
    });
  }

  // ==================================================================
  // ВХОД НА КАССУ ПО PIN (модель UMAG: 4 цифры).
  // PIN бесполезен без привязанного устройства — поэтому короткий PIN здесь
  // безопасен: устройство = фактор владения, PIN = фактор знания.
  // ==================================================================
  async posLogin(accountId: string, deviceId: string, pin: string, offline = false) {
    const locked = await this.db.raw(`SELECT auth_is_locked_out($1,'pos_pin') AS l`, [deviceId]);
    if (locked.rows[0].l) throw new ForbiddenException('Слишком много неверных PIN. Подождите 5 минут.');

    return this.db.withTenant(accountId, async (c) => {
      const dev = (await c.query(
        `SELECT d.cash_register_id, cr.store_id FROM device d
           LEFT JOIN cash_register cr ON cr.id=d.cash_register_id WHERE d.id=$1`, [deviceId])).rows[0];

      const staff = (await c.query(
        `SELECT e.id, e.pos_pin_hash FROM employee e
           LEFT JOIN employee_store es ON es.employee_id=e.id
          WHERE e.can_login_pos AND e.is_active AND e.dismissed_at IS NULL AND e.deleted_at IS NULL
            AND e.pos_pin_hash IS NOT NULL AND (es.store_id=$1 OR e.is_owner)
          GROUP BY e.id`, [dev?.store_id ?? null])).rows;

      let found: string | null = null;
      for (const s of staff) if (await bcrypt.compare(pin, s.pos_pin_hash)) { found = s.id; break; }

      if (!found) {
        await c.query(`SELECT auth_log_attempt($1,NULL,$2,'pos_pin',$3,false,'bad_pin',NULL,NULL)`,
          [accountId, deviceId, deviceId]);
        throw new UnauthorizedException('Неверный PIN');
      }

      // мультиаккаунт (Wipon): предыдущая сессия закрывается, смена продолжается
      await c.query(
        `UPDATE pos_session SET ended_at=now(), end_reason='switch_user' WHERE device_id=$1 AND ended_at IS NULL`,
        [deviceId]);
      const session = (await c.query(
        `INSERT INTO pos_session (account_id, device_id, cash_register_id, employee_id, offline)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, started_at`,
        [accountId, deviceId, dev?.cash_register_id ?? null, found, offline])).rows[0];
      await c.query(`SELECT auth_log_attempt($1,$2,$3,'pos_pin',$4,true,NULL,NULL,NULL)`,
        [accountId, found, deviceId, deviceId]);

      const ctx = await this.loadContext(accountId, found, c);
      return { sessionId: session.id, startedAt: session.started_at, employee: ctx };
    });
  }

  /**
   * Подтверждение действия старшим (UMAG: скан штрихкода администратора).
   * Наше расширение: бейдж ИЛИ PIN, обе подписи в журнале, работает офлайн.
   */
  async approveAction(accountId: string, dto: {
    id?: string; deviceId: string; requestedBy: string; action: string;
    badge?: string; pin?: string; entity?: string; entityId?: string; offline?: boolean;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const candidates = (await c.query(
        `SELECT e.id, e.pos_pin_hash, e.badge_barcode, e.is_owner, r.code AS role_code
           FROM employee e LEFT JOIN role r ON r.id=e.role_id
          WHERE e.is_active AND e.dismissed_at IS NULL AND e.deleted_at IS NULL
            AND (e.is_owner OR r.code IN ('owner','admin') OR e.is_shift_admin)`)).rows;

      let approver: any = null;
      if (dto.badge) approver = candidates.find((x) => x.badge_barcode && x.badge_barcode === dto.badge);
      else if (dto.pin) for (const x of candidates) if (x.pos_pin_hash && await bcrypt.compare(dto.pin, x.pos_pin_hash)) { approver = x; break; }
      if (!approver) throw new ForbiddenException('Подтверждение не принято: нужен администратор');

      const { rows } = await c.query(
        `INSERT INTO action_approval (id, account_id, device_id, requested_by, approved_by, action, entity, entity_id, method, approved_at, offline, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, now())
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [dto.id ?? randomUUID(), accountId, dto.deviceId, dto.requestedBy, approver.id,
         dto.action, dto.entity ?? null, dto.entityId ?? null, dto.badge ? 'badge' : 'pin', dto.offline ?? false]);

      await c.query(
        `INSERT INTO audit_log (account_id, employee_id, device_id, action, entity, entity_id, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [accountId, dto.requestedBy, dto.deviceId, `approved:${dto.action}`, dto.entity ?? null, dto.entityId ?? null, approver.id]);

      return { approved: true, approvalId: rows[0]?.id, approvedBy: approver.id };
    });
  }

  // ==================================================================
  // Сотрудники: список, приём, изменение, увольнение.
  // До этого сотрудники создавались только в тестах прямым SQL —
  // кабинету нужен настоящий приём на работу.
  // ==================================================================
  async listEmployees(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT e.id, e.first_name, e.last_name, e.phone, e.position, e.is_owner, e.is_active,
                e.is_shift_admin, e.can_login_admin, e.can_login_pos, e.last_login_at,
                r.code AS role_code, r.name AS role_name,
                (e.pos_pin_hash IS NOT NULL) AS has_pin,
                COALESCE(json_agg(es.store_id) FILTER (WHERE es.store_id IS NOT NULL), '[]') AS store_ids
           FROM employee e
           LEFT JOIN role r ON r.id = e.role_id
           LEFT JOIN employee_store es ON es.employee_id = e.id
          WHERE e.deleted_at IS NULL
          GROUP BY e.id, r.code, r.name
          ORDER BY e.is_owner DESC, e.created_at`)).rows);
  }

  async createEmployee(accountId: string, dto: {
    firstName: string; lastName?: string; phone: string; roleCode: string;
    position?: string; password?: string; pin?: string; storeIds?: string[];
    isShiftAdmin?: boolean; canLoginAdmin?: boolean; canLoginPos?: boolean;
  }) {
    if (!dto.firstName?.trim()) throw new BadRequestException('Имя обязательно');
    if (!/^\+7\d{10}$/.test(dto.phone ?? '')) throw new BadRequestException('Телефон в формате +7XXXXXXXXXX');
    return this.db.withTenant(accountId, async (c) => {
      const role = (await c.query(
        `SELECT id, code FROM role WHERE code=$1 AND (account_id=$2 OR account_id IS NULL) ORDER BY account_id NULLS LAST LIMIT 1`,
        [dto.roleCode, accountId])).rows[0];
      if (!role) throw new BadRequestException(`Роль «${dto.roleCode}» не найдена`);
      const dup = (await c.query(`SELECT 1 FROM employee WHERE phone=$1 AND deleted_at IS NULL`, [dto.phone])).rows[0];
      if (dup) throw new BadRequestException('Сотрудник с таким телефоном уже есть');

      const { rows } = await c.query(
        `INSERT INTO employee (account_id, role_id, first_name, last_name, phone, position,
                               password_hash, can_login_admin, can_login_pos, is_shift_admin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, first_name, last_name, phone, is_active`,
        [accountId, role.id, dto.firstName.trim(), dto.lastName ?? null, dto.phone, dto.position ?? null,
         dto.password ? await bcrypt.hash(dto.password, BCRYPT_COST) : null,
         dto.canLoginAdmin ?? false, dto.canLoginPos ?? true, dto.isShiftAdmin ?? false]);
      const emp = rows[0];

      // Точки: явно указанные, а без них — все активные. Магазин у дома
      // обычно один: «принял кассира — он уже может встать за кассу»,
      // без скрытого шага привязки (о который и споткнулся bootstrap).
      const storeIds = dto.storeIds?.length
        ? dto.storeIds
        : (await c.query(`SELECT id FROM store WHERE deleted_at IS NULL`)).rows.map((r: any) => r.id);
      for (const s of storeIds)
        await c.query(`INSERT INTO employee_store (employee_id, store_id, account_id) VALUES ($1,$2,$3)`,
          [emp.id, s, accountId]);

      let pin: string | undefined;
      if (dto.pin) {
        // В ТОЙ ЖЕ транзакции: setPin открывал новое подключение и не видел
        // ещё не закоммиченного сотрудника — PIN молча не сохранялся.
        if (!/^\d{4}$/.test(dto.pin)) throw new BadRequestException('PIN — ровно 4 цифры');
        await c.query(`UPDATE employee SET pos_pin_hash=$2 WHERE id=$1`,
          [emp.id, await bcrypt.hash(dto.pin, BCRYPT_COST)]);
        pin = dto.pin;
      }
      return { ...emp, roleCode: role.code, pin };
    });
  }

  async updateEmployee(accountId: string, id: string, dto: {
    firstName?: string; lastName?: string; position?: string; roleCode?: string;
    isActive?: boolean; isShiftAdmin?: boolean; canLoginAdmin?: boolean; canLoginPos?: boolean;
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const emp = (await c.query(`SELECT id, is_owner FROM employee WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!emp) throw new BadRequestException('Сотрудник не найден');
      // Владельца нельзя уволить или разжаловать — иначе аккаунт останется без хозяина
      if (emp.is_owner && (dto.isActive === false || dto.roleCode))
        throw new BadRequestException('Владельца нельзя уволить или сменить ему роль');

      let roleId: string | undefined;
      if (dto.roleCode) {
        const role = (await c.query(
          `SELECT id FROM role WHERE code=$1 AND (account_id=$2 OR account_id IS NULL) ORDER BY account_id NULLS LAST LIMIT 1`,
          [dto.roleCode, accountId])).rows[0];
        if (!role) throw new BadRequestException(`Роль «${dto.roleCode}» не найдена`);
        roleId = role.id;
      }
      await c.query(
        `UPDATE employee SET
           first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
           position = COALESCE($4, position), role_id = COALESCE($5, role_id),
           is_active = COALESCE($6, is_active), is_shift_admin = COALESCE($7, is_shift_admin),
           can_login_admin = COALESCE($8, can_login_admin), can_login_pos = COALESCE($9, can_login_pos),
           dismissed_at = CASE WHEN $6 = false THEN now() WHEN $6 = true THEN NULL ELSE dismissed_at END,
           updated_at = now()
         WHERE id=$1`,
        [id, dto.firstName ?? null, dto.lastName ?? null, dto.position ?? null, roleId ?? null,
         dto.isActive ?? null, dto.isShiftAdmin ?? null, dto.canLoginAdmin ?? null, dto.canLoginPos ?? null]);
      return { ok: true };
    });
  }

  async listRoles(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id, code, name, is_system, can_see_purchase_price, can_see_revenue
           FROM role WHERE (account_id=$1 OR account_id IS NULL) AND deleted_at IS NULL ORDER BY is_system DESC, name`,
        [accountId])).rows);
  }

  // ==================================================================
  // PIN: установка с проверкой уникальности внутри аккаунта
  // ==================================================================
  async setPin(accountId: string, employeeId: string, pin: string) {
    if (!/^\d{4}$/.test(pin)) throw new BadRequestException('PIN — ровно 4 цифры');
    const fp = pinFingerprint(accountId, pin);
    const uniq = await this.db.raw(`SELECT check_pin_unique($1,$2,$3) AS ok`, [accountId, fp, employeeId]);
    if (!uniq.rows[0].ok) throw new BadRequestException('Такой PIN уже занят другим сотрудником');

    await this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE employee SET pos_pin_hash=$1, pos_pin_fp=$2 WHERE id=$3`,
        [await bcrypt.hash(pin, BCRYPT_COST), fp, employeeId]);
    });
    return { ok: true };
  }

  // ==================================================================
  // Контекст сотрудника: права, точки, флаги
  // ==================================================================
  async loadContext(accountId: string, employeeId: string, client?: any): Promise<EmployeeContext> {
    const run = async (c: any) => {
      const e = (await c.query(
        `SELECT e.id, e.is_owner, e.is_shift_admin, r.code AS role_code, r.permissions,
                r.can_see_purchase_price, r.can_see_revenue
           FROM employee e LEFT JOIN role r ON r.id=e.role_id WHERE e.id=$1`, [employeeId])).rows[0];
      if (!e) throw new UnauthorizedException('Сотрудник не найден');
      const stores = (await c.query(`SELECT store_id FROM employee_store WHERE employee_id=$1`, [employeeId])).rows;
      // статус аккаунта нужен проверке прав: неактивированная заявка (pending)
      // не должна работать с товарами и кассой, пока оператор не подтвердит
      const acc = (await c.query(`SELECT status FROM account WHERE id=$1`, [accountId])).rows[0];
      return {
        employeeId: e.id,
        accountId,
        accountStatus: acc?.status ?? 'trial',
        roleCode: e.role_code,
        permissions: (e.permissions ?? {}) as PermissionMatrix,
        // владелец и админ не ограничены точками (модель МС), остальные — по списку (модель UMAG)
        storeIds: e.is_owner || e.role_code === 'admin' ? [] : stores.map((s: any) => s.store_id),
        canSeePurchasePrice: !!e.can_see_purchase_price,
        canSeeRevenue: !!e.can_see_revenue,
        isOwner: !!e.is_owner,
        isShiftAdmin: !!e.is_shift_admin || !!e.is_owner,   // у владельца всегда (Wipon)
      };
    };
    return client ? run(client) : this.db.withTenant(accountId, run);
  }

  // ==================================================================
  // «ВЫДАТЬ ДОСТУП» (UMAG) — наш ответ на боль «не дозвониться в поддержку».
  // Специалист входит под своим аккаунтом; пароль клиента не передаётся.
  // ==================================================================
  async grantSupport(accountId: string, byEmployeeId: string, granteePhone: string, hours = 24, scope: any = {}) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO support_access (account_id, grantee_phone, scope, granted_by, expires_at)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval) RETURNING id, expires_at`,
        [accountId, granteePhone, scope, byEmployeeId, String(hours)]);
      return rows[0];
    });
  }

  async revokeSupport(accountId: string, accessId: string) {
    await this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE support_access SET revoked_at=now() WHERE id=$1`, [accessId]);
      await c.query(`UPDATE support_session SET ended_at=now() WHERE access_id=$1 AND ended_at IS NULL`, [accessId]);
    });
    return { ok: true };
  }

  /** Какие чужие аккаунты сейчас открыты специалисту (для его экрана). */
  async listSupportGrants(granteePhone: string) {
    const { rows } = await this.db.raw(`SELECT * FROM auth_list_support_grants($1)`, [granteePhone]);
    return rows;
  }

  /**
   * Вход специалиста в чужой аккаунт по выданному доступу (UMAG «Выдать доступ»).
   * Пароль клиента не передаётся; все действия помечаются в журнале.
   */
  async enterSupportSession(granteePhone: string, accountId: string, ip?: string) {
    const { rows } = await this.db.raw(`SELECT auth_check_support_access($1,$2) AS access_id`, [granteePhone, accountId]);
    const accessId = rows[0]?.access_id;
    if (!accessId) throw new ForbiddenException('Доступ не выдан или отозван');
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `INSERT INTO support_session (access_id, account_id, grantee_phone, ip) VALUES ($1,$2,$3,$4)
         RETURNING id, started_at`, [accessId, accountId, granteePhone, ip ?? null])).rows[0];
      return { supportSessionId: s.id, accountId, startedAt: s.started_at };
    });
  }
}
