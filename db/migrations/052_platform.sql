-- =====================================================================
-- 052_platform.sql — Платформа: партнёры, строки счёта, оплаты, заявки.
--
-- Перенос модели из проекта автоматизации ресторанов (Дастархан), где
-- она обкатана на живых клиентах. Берём не код — код там на другом
-- стеке, — а модель и правила, которые за ней стоят.
--
-- ГЛАВНАЯ МЫСЛЬ ДОНОРА: партнёр доводит клиента до работы, деньги
-- включает владелец платформы. Партнёр может ошибиться или
-- поторопиться; включение доступа — единственная точка, где оплата
-- превращается в работающую систему, и она должна быть одна.
--
-- ПЛАТФОРМЕННЫЕ ТАБЛИЦЫ ВНЕ ПОСТРОЧНОЙ ИЗОЛЯЦИИ. У нас каждая таблица
-- закрыта правилом «только свой магазин», но платформа смотрит НА
-- магазины сверху — для неё такое правило означало бы, что она не
-- видит ничего. Доступ закрыт иначе: своей ролью и ключом.
-- =====================================================================

-- ── Пользователи платформы: владелец сервиса и партнёры ──────────────
CREATE TYPE platform_role AS ENUM ('super', 'partner');

CREATE TABLE IF NOT EXISTS platform_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          platform_role NOT NULL DEFAULT 'partner',
  is_active     boolean NOT NULL DEFAULT true,
  -- Комиссия в базисных пунктах: 1500 = 15%. Целым числом, потому что
  -- дробные проценты в деньгах округляются по-разному в разных местах,
  -- и партнёр однажды недосчитается тенге.
  commission_bp integer NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),
  phone         text,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_platform_user_role ON platform_user(role) WHERE deleted_at IS NULL;

-- ── Карточка клиента глазами платформы ───────────────────────────────
-- Отдельно от account: там учётные данные магазина, здесь — отношения
-- с ним как с клиентом сервиса. Смешивать нельзя: у магазина может
-- смениться партнёр, а данные магазина от этого не меняются.
CREATE TABLE IF NOT EXISTS tenant_card (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES account(id) ON DELETE CASCADE,

  partner_id  uuid REFERENCES platform_user(id),

  -- Воронка продаж: где клиент в разговоре, а не в оплате.
  deal_stage  text NOT NULL DEFAULT 'new'
    CHECK (deal_stage IN ('new','contacted','demo','proposal','won','lost')),
  deal_note   text,
  touched_at  timestamptz,           -- когда последний раз общались

  -- Учебный магазин партнёра: показывать систему на боевом клиенте
  -- нельзя. Исключается из всех денег и сводок — иначе они врут.
  is_demo     boolean NOT NULL DEFAULT false,

  city        text,
  owner_name  text,
  owner_phone text,
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_card_partner ON tenant_card(partner_id);
CREATE INDEX IF NOT EXISTS idx_tenant_card_stage ON tenant_card(deal_stage) WHERE is_demo = false;

-- ── Строки счёта ─────────────────────────────────────────────────────
-- Счёт — НЕ одно число, а строки. Причина из донора: клиент добавляет
-- вторую кассу — цена должна вырасти на понятную величину, а не стать
-- другой цифрой без объяснения. Владелец видит, из чего сложилась сумма.
--
-- Скидка — строка с ОТРИЦАТЕЛЬНОЙ ценой. Так она попадает в тот же
-- расчёт и видна в том же списке, а не живёт отдельным полем, о
-- котором забывают.
CREATE TABLE IF NOT EXISTS plan_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,

  kind        text NOT NULL
    CHECK (kind IN ('base','pos','store','module','discount')),
  title       text NOT NULL,          -- «Касса №2», «Скидка за год»
  qty         integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  -- Цена в ТИЫНАХ, целым числом. Дробные деньги в разных местах
  -- округляются по-разному, и итог не сходится на копейки — а на кассе
  -- это выглядит как недостача.
  unit_price  bigint NOT NULL,

  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,            -- пусто = строка живая
  billed_until timestamptz,           -- до какой даты уже оплачена

  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_line_account ON plan_line(account_id) WHERE ends_at IS NULL;

-- ── Оплаты ───────────────────────────────────────────────────────────
CREATE TYPE tenant_payment_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE IF NOT EXISTS tenant_payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,

  amount        bigint NOT NULL CHECK (amount > 0),   -- тиыны
  months        integer NOT NULL DEFAULT 1 CHECK (months > 0),
  method        text NOT NULL DEFAULT 'kaspi',
  comment       text,

  -- Доля партнёра считается и ЗАМОРАЖИВАЕТСЯ в момент подтверждения.
  -- Если позже поменять ему комиссию, прошлые выплаты не должны
  -- пересчитаться задним числом — иначе отчёт за прошлый месяц
  -- изменится сам собой.
  partner_id     uuid REFERENCES platform_user(id),
  partner_bp     integer NOT NULL DEFAULT 0,
  partner_share  bigint NOT NULL DEFAULT 0,
  platform_share bigint NOT NULL DEFAULT 0,

  status        tenant_payment_status NOT NULL DEFAULT 'pending',
  reject_reason text,                 -- партнёр должен понять, что не так

  created_by    uuid REFERENCES platform_user(id),
  approved_by   uuid REFERENCES platform_user(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_payment_status ON tenant_payment(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_payment_account ON tenant_payment(account_id, created_at DESC);

-- ── Заявки партнёра ──────────────────────────────────────────────────
-- Партнёр не решает про деньги, но может попросить: вторую кассу,
-- другой тариф, отсрочку. Владелец платформы отвечает да или нет.
CREATE TABLE IF NOT EXISTS tenant_request (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,

  kind        text NOT NULL CHECK (kind IN ('device','tariff','grace','other')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  comment     text,

  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  decision_note text,

  created_by  uuid REFERENCES platform_user(id),
  decided_by  uuid REFERENCES platform_user(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_request_status ON tenant_request(status, created_at DESC);

-- ── Настройки платформы ──────────────────────────────────────────────
-- Одна строка на всю систему: прайс, реквизиты, ссылка на картинку QR
-- для оплаты. Хранится в базе, а не в настройках сервера, потому что
-- владелец меняет их сам, без выкладки.
CREATE TABLE IF NOT EXISTS platform_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  price_base    bigint NOT NULL DEFAULT 690000,    -- «Старт», тиыны
  price_pro     bigint NOT NULL DEFAULT 1490000,   -- «Стандарт»
  price_extra_pos bigint NOT NULL DEFAULT 300000,  -- вторая и следующая касса
  price_extra_store bigint NOT NULL DEFAULT 500000,-- вторая и следующая точка
  discount_6m_bp integer NOT NULL DEFAULT 500,     -- 5% за полгода
  discount_12m_bp integer NOT NULL DEFAULT 1000,   -- 10% за год
  pay_qr_url    text,
  pay_details   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- ── Журнал решений платформы ─────────────────────────────────────────
-- Кто что решил и когда. Нужен не для отчётности, а для разговора:
-- «почему у клиента открыт доступ, хотя оплаты нет» — ответ должен
-- находиться, а не восстанавливаться по памяти.
CREATE TABLE IF NOT EXISTS platform_audit (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES platform_user(id),
  actor_name  text,                   -- копией: пользователя могут удалить
  action      text NOT NULL,
  account_id  uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_account ON platform_audit(account_id, at DESC);

-- ── Права на платформенные таблицы ───────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_user, tenant_card, plan_line,
  tenant_payment, tenant_request, platform_settings, platform_audit TO shop_app;
GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO shop_app;

-- ── Поиск клиента по телефону ────────────────────────────────────────
-- Дубли ловятся по ПОСЛЕДНИМ ДЕСЯТИ цифрам: люди пишут номер то с +7,
-- то с 8, то с пробелами. Урок донора, стоил им разбирательств.
CREATE OR REPLACE FUNCTION phone_tail(p text)
RETURNS text IMMUTABLE LANGUAGE sql AS $$
  SELECT right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10);
$$;
CREATE INDEX IF NOT EXISTS idx_account_phone_tail ON account(phone_tail(phone));

-- ── Продление подписки платформой ────────────────────────────────────
-- Отдельной функцией с правом обхода изоляции, а не запросом из кода.
--
-- Причина: таблица подписок закрыта правилом «только свой магазин», и
-- платформа, которая смотрит НА магазины сверху, не видит из неё ни
-- одной строки. Молча: запрос выполняется, обновляет ноль строк,
-- ошибки нет. Поймал на живой проверке — оплата подтверждалась, доля
-- партнёра считалась, а доступ не продлевался.
--
-- Здесь же продление и считается — чтобы правило «досрочная оплата не
-- сжигает остаток» жило в одном месте, а не повторялось в коде.
CREATE OR REPLACE FUNCTION platform_extend_subscription(
  p_account uuid, p_months integer)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_from timestamptz; v_until timestamptz; v_id uuid;
BEGIN
  SELECT id, paid_until INTO v_id, v_from FROM subscription WHERE account_id = p_account;

  -- От БОЛЬШЕЙ из дат: сегодня или нынешний конец оплаченного периода.
  -- Иначе заплативший за неделю до срока теряет эту неделю — и больше
  -- никогда не платит заранее.
  v_from := greatest(coalesce(v_from, now()), now());
  v_until := v_from + (p_months || ' months')::interval;

  IF v_id IS NULL THEN
    INSERT INTO subscription (account_id, tariff_id, status, paid_until, starts_at,
                              price_locked, price_locked_until)
    SELECT p_account, t.id, 'active', v_until, now(), t.price_month, now() + interval '1 year'
      FROM tariff t WHERE t.is_active ORDER BY t.price_month LIMIT 1;
  ELSE
    UPDATE subscription SET paid_until = v_until, status = 'active' WHERE id = v_id;
  END IF;

  UPDATE account SET status = 'active' WHERE id = p_account AND status <> 'active';
  RETURN v_until;
END; $$;
GRANT EXECUTE ON FUNCTION platform_extend_subscription(uuid, integer) TO shop_app;

-- ── Список клиентов и сводка для платформы ───────────────────────────
-- Тоже функциями с обходом изоляции: account, sale и store закрыты
-- правилом «только свой магазин». Платформа смотрит сверху и без этого
-- видит пустой список — молча, без ошибки.
--
-- Фильтр по партнёру внутри функции, а не в вызывающем коде: правило
-- «партнёр видит только своих» должно жить в одном месте. Забыть
-- добавить условие в новом запросе — значит показать партнёру чужие
-- обороты и телефоны владельцев.
CREATE OR REPLACE FUNCTION platform_clients(
  p_role text, p_user uuid, p_q text DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, phone text, status text, city text,
  owner_name text, owner_phone text, deal_stage text, is_demo boolean,
  partner_id uuid, partner_name text, paid_until timestamptz,
  tariff_name text, revenue_30d numeric, stores bigint, registers bigint,
  -- Заметка и дата последнего касания. Без них воронка бесполезна:
  -- партнёр видит этап, но не помнит, о чём говорили и когда. Через
  -- две недели «связались» ничего не значит.
  deal_note text, touched_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, a.phone, a.status::text, tc.city,
         tc.owner_name, tc.owner_phone, tc.deal_stage, coalesce(tc.is_demo, false),
         tc.partner_id, pu.full_name, s.paid_until, t.name,
         coalesce((SELECT sum(sl.total) FROM sale sl
                    WHERE sl.account_id = a.id AND sl.return_of_id IS NULL
                      AND sl.created_at > now() - interval '30 days'), 0),
         (SELECT count(*) FROM store st WHERE st.account_id = a.id),
         (SELECT count(*) FROM cash_register cr WHERE cr.account_id = a.id),
         tc.deal_note, tc.touched_at
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tc.partner_id
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL
     AND (p_role = 'super' OR tc.partner_id = p_user)
     AND (p_q IS NULL OR a.name ILIKE '%'||p_q||'%'
          OR tc.owner_name ILIKE '%'||p_q||'%' OR tc.city ILIKE '%'||p_q||'%'
          OR phone_tail(a.phone) = phone_tail(p_q)
          OR phone_tail(tc.owner_phone) = phone_tail(p_q))
   ORDER BY a.created_at DESC LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_clients(text, uuid, text) TO shop_app;

CREATE OR REPLACE FUNCTION platform_summary(p_role text, p_user uuid)
RETURNS TABLE (total bigint, active bigint, expired bigint, mrr numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT count(*),
         count(*) FILTER (WHERE s.paid_until > now()),
         count(*) FILTER (WHERE s.paid_until <= now()),
         coalesce(sum(t.price_month) FILTER (WHERE s.paid_until > now()), 0)
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL
     -- Демо исключены из всех денег и счётчиков: иначе сводка врёт,
     -- а по ней принимают решения.
     AND coalesce(tc.is_demo, false) = false
     AND (p_role = 'super' OR tc.partner_id = p_user);
$$;
GRANT EXECUTE ON FUNCTION platform_summary(text, uuid) TO shop_app;

-- ── Дата окончания подписки для платформы ────────────────────────────
-- Ещё одно место, где нужен обход изоляции. Прямой запрос к подписке
-- из платформы возвращает пусто — молча, без ошибки. Ловлю это уже
-- третий раз, поэтому выношу в функцию: теперь один адрес на все
-- случаи, и наступить снова некуда.
CREATE OR REPLACE FUNCTION platform_paid_until(p_account uuid)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT paid_until FROM subscription WHERE account_id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_paid_until(uuid) TO shop_app;

-- ── Отбор клиентов для массового действия ────────────────────────────
-- И снова обход изоляции: account закрыт правилом «только свой
-- магазин», и массовое действие видело ноль строк — молча, показывая
-- «затронет 0 клиентов».
--
-- Учебные отсекаются ЗДЕСЬ, а не в коде: правило «демо не участвует в
-- деньгах» должно жить в одном месте, иначе новое массовое действие
-- однажды заденет учебный магазин партнёра.
CREATE OR REPLACE FUNCTION platform_bulk_targets(p_ids uuid[])
RETURNS TABLE (id uuid, name text, paid_until timestamptz, is_demo boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, s.paid_until, coalesce(tc.is_demo, false)
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN subscription s ON s.account_id = a.id
   WHERE a.id = ANY(p_ids) AND a.deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION platform_bulk_targets(uuid[]) TO shop_app;

/** Применение массового действия. Учебные отсечены на входе. */
CREATE OR REPLACE FUNCTION platform_bulk_apply(
  p_ids uuid[], p_action text, p_days integer DEFAULT NULL)
RETURNS integer
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_done integer := 0; v_id uuid;
BEGIN
  FOR v_id IN
    SELECT a.id FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
     WHERE a.id = ANY(p_ids) AND a.deleted_at IS NULL
       AND coalesce(tc.is_demo, false) = false
  LOOP
    IF p_action = 'grace' AND p_days IS NOT NULL THEN
      UPDATE subscription
         SET paid_until = greatest(coalesce(paid_until, now()), now()) + (p_days || ' days')::interval,
             status = 'active'
       WHERE account_id = v_id;
    ELSIF p_action = 'disable' THEN
      UPDATE account SET status = 'suspended' WHERE id = v_id;
    ELSIF p_action = 'enable' THEN
      UPDATE account SET status = 'active' WHERE id = v_id;
    ELSE
      CONTINUE;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END; $$;
GRANT EXECUTE ON FUNCTION platform_bulk_apply(uuid[], text, integer) TO shop_app;

-- ── Сброс пароля владельцу и мягкое удаление ─────────────────────────
-- Обе через обход изоляции: employee и account закрыты правилом
-- «только свой магазин».
CREATE OR REPLACE FUNCTION platform_reset_owner_password(p_account uuid, p_hash text)
RETURNS boolean
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT e.id INTO v_id FROM employee e
    JOIN role r ON r.id = e.role_id
   WHERE e.account_id = p_account AND r.code = 'owner' AND e.deleted_at IS NULL
   LIMIT 1;
  IF v_id IS NULL THEN RETURN false; END IF;
  UPDATE employee SET password_hash = p_hash WHERE id = v_id;
  RETURN true;
END; $$;
GRANT EXECUTE ON FUNCTION platform_reset_owner_password(uuid, text) TO shop_app;

-- Мягкое удаление: магазин перестаёт работать, данные остаются. Их
-- могут спросить и через год, при разбирательстве.
CREATE OR REPLACE FUNCTION platform_soft_delete_account(p_account uuid)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account SET deleted_at = now(), status = 'deleted' WHERE id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_soft_delete_account(uuid) TO shop_app;

-- ── Заведение магазина платформой ────────────────────────────────────
-- Нужна для наполнения пробными данными и для будущего «завести
-- клиента» из кабинета платформы. Обход изоляции: вставка в account
-- из-под роли приложения отбивается правилом «только свой магазин».
CREATE OR REPLACE FUNCTION platform_create_account(
  p_name text, p_phone text, p_status account_status DEFAULT 'active')
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO account (name, phone, status) VALUES (p_name, p_phone, p_status)
    RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION platform_create_account(text, text, account_status) TO shop_app;

/** Подписка с нужной датой — для пробных данных и переноса клиентов. */
CREATE OR REPLACE FUNCTION platform_set_subscription(
  p_account uuid, p_days integer, p_status text DEFAULT 'active')
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_t record;
BEGIN
  SELECT id, price_month INTO v_t FROM tariff WHERE is_public ORDER BY price_month LIMIT 1;
  IF v_t.id IS NULL THEN RETURN; END IF;
  INSERT INTO subscription (account_id, tariff_id, status, paid_until, starts_at,
                            price_locked, price_locked_until)
  VALUES (p_account, v_t.id, p_status::sub_status,
          now() + (p_days || ' days')::interval, now(),
          v_t.price_month, now() + interval '1 year')
  ON CONFLICT (account_id) DO UPDATE
    SET paid_until = EXCLUDED.paid_until, status = EXCLUDED.status;
END; $$;
GRANT EXECUTE ON FUNCTION platform_set_subscription(uuid, integer, text) TO shop_app;

-- ── Оплаты, партнёры и заявки со сведениями о магазине ───────────────
-- Все три запроса соединяются с account, который закрыт правилом
-- «только свой магазин» — и платформа получала ПУСТЫЕ списки. Молча:
-- запрос выполняется, строк ноль, ошибки нет.
--
-- Это уже пятый случай той же природы. Поэтому здесь не заплатка, а
-- правило: любой запрос платформы, который трогает данные магазинов,
-- живёт функцией с обходом изоляции. В коде остаётся только вызов.
CREATE OR REPLACE FUNCTION platform_payments(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  id uuid, amount bigint, months integer, method text, comment text,
  status text, reject_reason text, created_at timestamptz, approved_at timestamptz,
  partner_share bigint, platform_share bigint,
  client text, account_id uuid, partner text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tp.id, tp.amount, tp.months, tp.method, tp.comment,
         tp.status::text, tp.reject_reason, tp.created_at, tp.approved_at,
         tp.partner_share, tp.platform_share,
         a.name, a.id, pu.full_name
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN platform_user pu ON pu.id = tp.partner_id
   WHERE (p_status IS NULL OR tp.status::text = p_status)
     AND (p_role = 'super' OR tp.partner_id = p_user)
   ORDER BY tp.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_payments(text, text, uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_partners()
RETURNS TABLE (
  id uuid, full_name text, email text, phone text, commission_bp integer,
  is_active boolean, last_login_at timestamptz, created_at timestamptz,
  clients bigint, active_clients bigint, earned_30d numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu.id, pu.full_name, pu.email, pu.phone, pu.commission_bp,
         pu.is_active, pu.last_login_at, pu.created_at,
         (SELECT count(*) FROM tenant_card tc WHERE tc.partner_id = pu.id),
         (SELECT count(*) FROM tenant_card tc
            JOIN subscription s ON s.account_id = tc.account_id
           WHERE tc.partner_id = pu.id AND s.paid_until > now()),
         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
           WHERE tp.partner_id = pu.id AND tp.status = 'approved'
             AND tp.approved_at > now() - interval '30 days'), 0)
    FROM platform_user pu
   WHERE pu.role = 'partner' AND pu.deleted_at IS NULL
   ORDER BY pu.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION platform_partners() TO shop_app;

CREATE OR REPLACE FUNCTION platform_requests(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  id uuid, kind text, payload jsonb, comment text, status text,
  decision_note text, created_at timestamptz, decided_at timestamptz,
  client text, account_id uuid, author text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tr.id, tr.kind, tr.payload, tr.comment, tr.status,
         tr.decision_note, tr.created_at, tr.decided_at,
         a.name, a.id, pu.full_name
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
   WHERE (p_status IS NULL OR tr.status = p_status)
     AND (p_role = 'super' OR tr.created_by = p_user)
   ORDER BY tr.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_requests(text, text, uuid) TO shop_app;
