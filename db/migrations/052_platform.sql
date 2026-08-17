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

-- ── Функции для полного набора действий платформы ────────────────────
-- Всё, что трогает данные магазинов, — здесь. Правило, выведенное
-- пятью одинаковыми ловушками: прямой запрос из платформы к закрытым
-- таблицам возвращает пусто МОЛЧА, без ошибки.

/** Поиск по последним десяти цифрам телефона: люди пишут то +7, то 8. */
CREATE OR REPLACE FUNCTION platform_find_by_phone(p_phone text)
RETURNS TABLE (id uuid, name text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name FROM account a
   WHERE a.deleted_at IS NULL AND phone_tail(a.phone) = phone_tail(p_phone)
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION platform_find_by_phone(text) TO shop_app;

/**
 * Завести магазин с владельцем и пробным периодом.
 *
 * Всё одной операцией: магазин, точка, роль владельца, сотрудник,
 * подписка, карточка. Половина заведённого магазина хуже незаведённого
 * — в него нельзя войти, но он занимает телефон.
 */
CREATE OR REPLACE FUNCTION platform_create_tenant(
  p_name text, p_phone text, p_owner text, p_hash text,
  p_trial_days integer, p_partner uuid)
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_acc uuid; v_role uuid; v_store uuid; v_t record;
BEGIN
  INSERT INTO account (name, phone, status) VALUES (p_name, p_phone, 'trial')
    RETURNING id INTO v_acc;

  SELECT id INTO v_role FROM role WHERE account_id = v_acc AND code = 'owner';
  IF v_role IS NULL THEN
    INSERT INTO role (account_id, code, name, is_system)
    VALUES (v_acc, 'owner', 'Владелец', true) RETURNING id INTO v_role;
  END IF;

  -- Владельцу нужен вход и в кабинет, и на кассу. Без can_login_admin
  -- он заводится, но войти не может — поймал на живой проверке: пароль
  -- подходит, отпечаток верный, а вход отбивается.
  INSERT INTO employee (account_id, role_id, first_name, phone, password_hash,
                        can_login_admin, can_login_pos, is_active)
  VALUES (v_acc, v_role, p_owner, p_phone, p_hash, true, true, true);

  INSERT INTO store (account_id, name) VALUES (v_acc, p_name) RETURNING id INTO v_store;

  SELECT id, price_month INTO v_t FROM tariff WHERE is_public ORDER BY price_month LIMIT 1;
  IF v_t.id IS NOT NULL THEN
    INSERT INTO subscription (account_id, tariff_id, status, paid_until, starts_at,
                              price_locked, price_locked_until)
    VALUES (v_acc, v_t.id, 'trial', now() + (p_trial_days || ' days')::interval, now(),
            v_t.price_month, now() + interval '1 year');
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_acc, 'base', 'Тариф', 1, v_t.price_month * 100);
  END IF;

  INSERT INTO tenant_card (account_id, partner_id, owner_name, owner_phone, deal_stage)
  VALUES (v_acc, p_partner, p_owner, p_phone, 'won');

  RETURN v_acc;
END; $$;
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text, integer, uuid) TO shop_app;

/** Одобрить самозапись: открыть пробный период. */
CREATE OR REPLACE FUNCTION platform_approve_signup(p_account uuid, p_days integer)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_until timestamptz;
BEGIN
  v_until := now() + (p_days || ' days')::interval;
  UPDATE account SET status = 'trial' WHERE id = p_account AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE subscription SET paid_until = v_until, status = 'trial' WHERE account_id = p_account;
  RETURN v_until;
END; $$;
GRANT EXECUTE ON FUNCTION platform_approve_signup(uuid, integer) TO shop_app;

/** Заморозить или разморозить магазин. */
CREATE OR REPLACE FUNCTION platform_set_status(p_account uuid, p_status account_status)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account SET status = p_status WHERE id = p_account AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION platform_set_status(uuid, account_status) TO shop_app;

/**
 * Код привязки кассы. Берёт первую кассу магазина и выдаёт свежий код.
 * Партнёр приезжает к клиенту и вводит его на планшете, не заходя в
 * кабинет магазина.
 */
CREATE OR REPLACE FUNCTION platform_pairing_code(p_account uuid)
RETURNS TABLE (code text, expires_at timestamptz, register_name text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_reg record; v_code text;
BEGIN
  SELECT cr.id, cr.name INTO v_reg FROM cash_register cr
   WHERE cr.account_id = p_account ORDER BY cr.created_at LIMIT 1;
  IF v_reg.id IS NULL THEN RETURN; END IF;

  -- Код из восьми знаков в верхнем регистре: его диктуют по телефону,
  -- и так он читается вслух без «а это буква или цифра».
  v_code := upper(encode(gen_random_bytes(4), 'hex'));

  -- Прежний непривязанный код гасим: иначе у кассы окажется два живых
  -- кода, и непонятно, какой ввели.
  UPDATE device SET deleted_at = now()
   WHERE cash_register_id = v_reg.id AND token_hash IS NULL AND deleted_at IS NULL;

  INSERT INTO device (account_id, cash_register_id, name, pairing_code, pairing_expires_at)
  VALUES (p_account, v_reg.id, v_reg.name, v_code, now() + interval '30 minutes');

  RETURN QUERY SELECT v_code, now() + interval '30 minutes', v_reg.name;
END; $$;
GRANT EXECUTE ON FUNCTION platform_pairing_code(uuid) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 1: «СЕГОДНЯ» — лента решений.
--
-- Замысел взят у донора и он верный: день начинается не со списка
-- клиентов, а с решений. Кто просрочен, что пришло сегодня, что висит
-- со вчера, кому платить на неделе.
--
-- ОДНИМ ЗАПРОСОМ, а не четырьмя. У донора экран собирал ленту в
-- браузере из четырёх ответов: список клиентов, оплаты, заявки,
-- партнёры. Это четыре ожидания подряд на стартовом экране, который
-- открывают первым делом с утра — и половина данных приходит уже
-- устаревшей относительно другой половины.
--
-- ЧЕТЫРЕ ОЧЕРЕДИ, порядок важен:
--   overdue — деньги уже потеряны, каждый день считается;
--   today   — свежее, пока помнят разговор;
--   waiting — висит со вчера и раньше;
--   soon    — семь дней и меньше до оплаты.
--
-- Учебные магазины исключены отовсюду: они не участвуют в деньгах.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_today(p_role text, p_user uuid)
RETURNS TABLE (
  id text, grp text, kind text,
  account_id uuid, client text,
  what text, why text, meta text,
  amount bigint, sort_key numeric,
  payment_id uuid, request_id uuid)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  -- 1. Просроченные: срок вышел, продажи закрыты, деньги теряются.
  SELECT 'overdue-' || a.id, 'overdue', 'tenant', a.id, a.name,
         'Срок вышел ' || abs(extract(day FROM now() - s.paid_until)::int) || ' дн. назад',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         -extract(epoch FROM now() - s.paid_until) / 86400,
         NULL::uuid, NULL::uuid
    FROM account a
    JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
     AND s.paid_until < now()
     AND (p_role = 'super' OR tc.partner_id = p_user)

  UNION ALL
  -- 2. Оплаты на подтверждении. Сегодняшние — в «пришло сегодня»,
  --    вчерашние и старше — в «ждёт решения»: висящая оплата означает,
  --    что клиент заплатил и ждёт, а доступ ему до сих пор не открыли.
  SELECT 'pay-' || tp.id,
         CASE WHEN tp.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'payment', a.id, a.name,
         'Оплата ' || round(tp.amount / 100.0) || ' ₸ · ' || tp.months || ' мес.',
         tp.comment,
         concat_ws(' · ', tc.city, tc.owner_name, pu.full_name),
         tp.amount,
         extract(epoch FROM tp.created_at) / 86400,
         tp.id, NULL::uuid
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tp.partner_id
   WHERE tp.status = 'pending'
     AND (p_role = 'super' OR tp.partner_id = p_user)

  UNION ALL
  -- 3. Заявки партнёров: вторая касса, отсрочка, смена тарифа.
  SELECT 'req-' || tr.id,
         CASE WHEN tr.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'request', a.id, a.name,
         CASE tr.kind
           WHEN 'device' THEN 'Просит устройство'
           WHEN 'tariff' THEN 'Просит смену тарифа'
           WHEN 'grace'  THEN 'Просит отсрочку'
           ELSE 'Заявка' END,
         tr.comment,
         concat_ws(' · ', tc.city, pu.full_name),
         NULL::bigint,
         extract(epoch FROM tr.created_at) / 86400,
         NULL::uuid, tr.id
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
   WHERE tr.status = 'pending'
     AND (p_role = 'super' OR tr.created_by = p_user)

  UNION ALL
  -- 4. Самозаписи: владелец зарегистрировался сам и ждёт одобрения.
  --    Пока не одобрили — он не может работать, а мы теряем клиента.
  SELECT 'signup-' || a.id,
         CASE WHEN a.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'signup', a.id, a.name,
         'Регистрация: владелец завёл магазин сам',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, a.phone),
         NULL::bigint,
         extract(epoch FROM a.created_at) / 86400,
         NULL::uuid, NULL::uuid
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
   WHERE a.deleted_at IS NULL AND a.status = 'trial'
     AND coalesce(tc.is_demo, false) = false
     AND tc.partner_id IS NULL          -- ничей: партнёр ещё не назначен
     AND p_role = 'super'

  UNION ALL
  -- 5. Скоро платить: семь дней и меньше. Звонок сейчас уместен,
  --    а через неделю выглядит выбиванием долга.
  SELECT 'soon-' || a.id, 'soon', 'tenant', a.id, a.name,
         'Платить через ' || extract(day FROM s.paid_until - now())::int || ' дн.',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         extract(epoch FROM s.paid_until - now()) / 86400,
         NULL::uuid, NULL::uuid
    FROM account a
    JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
     AND s.paid_until BETWEEN now() AND now() + interval '7 days'
     AND (p_role = 'super' OR tc.partner_id = p_user)

  ORDER BY 2, 10;
$$;
GRANT EXECUTE ON FUNCTION platform_today(text, uuid) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 2: «КЛИЕНТЫ» — список с отборами и карточка.
--
-- Замысел донора взят: карточка — СТРАНИЦА, а не окно-тупик. У них
-- раньше было модальное окно, которое показывало всё и не давало
-- сделать ничего: единственная кнопка «Закрыть». Изучил клиента —
-- закрывай и ищи заново.
--
-- СДЕЛАНО ИНАЧЕ: отбор и подсчёты — в базе, а не в браузере. У донора
-- список приходил целиком и фильтровался на стороне кабинета: при
-- сотне клиентов это лишние сотни строк по сети на каждое нажатие
-- «показать просроченных».
-- =====================================================================

/**
 * Список клиентов с отбором. Один запрос вместо «привези всё и
 * отфильтруй у себя».
 *
 * p_filter: all | active | expiring | expired | trial | demo
 * p_partner: NULL = все, иначе только этого партнёра
 */
CREATE OR REPLACE FUNCTION platform_clients_filtered(
  p_role text, p_user uuid,
  p_q text DEFAULT NULL, p_filter text DEFAULT 'all', p_partner uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, phone text, status text, city text,
  owner_name text, owner_phone text, deal_stage text, is_demo boolean,
  partner_id uuid, partner_name text, partner_bp integer,
  paid_until timestamptz, days_left integer,
  tariff_name text, monthly bigint,
  revenue_30d numeric, stores bigint, registers bigint,
  created_at timestamptz,
  -- Заметка и дата касания: без них воронка показывает этап, но не
  -- помнит, о чём говорили. Через две недели «показали» ничего не значит.
  deal_note text, touched_at timestamptz,
  total_count bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT a.id, a.name, a.phone, a.status::text AS status, a.created_at,
           tc.city, tc.owner_name, tc.owner_phone, tc.deal_stage,
           tc.deal_note, tc.touched_at,
           coalesce(tc.is_demo, false) AS is_demo,
           tc.partner_id, pu.full_name AS partner_name,
           coalesce(pu.commission_bp, 0) AS partner_bp,
           s.paid_until,
           CASE WHEN s.paid_until IS NULL THEN NULL
                ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END AS days_left,
           t.name AS tariff_name,
           -- Месячная цена: из строк счёта, если они есть; иначе из
           -- тарифа. Клиент видит одну сумму, платформа — ту же.
           coalesce(
             (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
             coalesce(t.price_month, 0) * 100)::bigint AS monthly,
           coalesce((SELECT sum(sl.total) FROM sale sl
              WHERE sl.account_id = a.id AND sl.return_of_id IS NULL
                AND sl.created_at > now() - interval '30 days'), 0) AS revenue_30d,
           (SELECT count(*) FROM store st WHERE st.account_id = a.id) AS stores,
           (SELECT count(*) FROM cash_register cr WHERE cr.account_id = a.id) AS registers
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN platform_user pu ON pu.id = tc.partner_id
      LEFT JOIN subscription s ON s.account_id = a.id
      LEFT JOIN tariff t ON t.id = s.tariff_id
     WHERE a.deleted_at IS NULL
       AND (p_role = 'super' OR tc.partner_id = p_user)
       AND (p_partner IS NULL OR tc.partner_id = p_partner)
       AND (p_q IS NULL OR p_q = '' OR
            a.name ILIKE '%'||p_q||'%' OR tc.owner_name ILIKE '%'||p_q||'%'
            OR tc.city ILIKE '%'||p_q||'%'
            OR phone_tail(a.phone) = phone_tail(p_q)
            OR phone_tail(tc.owner_phone) = phone_tail(p_q))
  ), picked AS (
    SELECT * FROM base
     WHERE CASE p_filter
             WHEN 'active'   THEN days_left >= 0 AND NOT is_demo
             WHEN 'expiring' THEN days_left BETWEEN 0 AND 7 AND NOT is_demo
             WHEN 'expired'  THEN days_left < 0 AND NOT is_demo
             WHEN 'trial'    THEN status = 'trial' AND NOT is_demo
             WHEN 'demo'     THEN is_demo
             ELSE true
           END
  )
  SELECT p.id, p.name, p.phone, p.status, p.city,
         p.owner_name, p.owner_phone, p.deal_stage, p.is_demo,
         p.partner_id, p.partner_name, p.partner_bp,
         p.paid_until, p.days_left, p.tariff_name, p.monthly,
         p.revenue_30d, p.stores, p.registers, p.created_at,
         p.deal_note, p.touched_at,
         count(*) OVER () AS total_count
    FROM picked p
   -- Порядок: сначала те, где горит. Просроченные, потом истекающие,
   -- потом остальные по свежести. Владелец читает сверху.
   ORDER BY (p.days_left IS NULL), p.days_left NULLS LAST, p.created_at DESC
   LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_filtered(text, uuid, text, text, uuid) TO shop_app;

/** Счётчики для вкладок отбора: сколько в каждой. */
CREATE OR REPLACE FUNCTION platform_clients_counts(p_role text, p_user uuid)
RETURNS TABLE (all_n bigint, active_n bigint, expiring_n bigint,
               expired_n bigint, trial_n bigint, demo_n bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT coalesce(tc.is_demo, false) AS is_demo, a.status::text AS st,
           CASE WHEN s.paid_until IS NULL THEN NULL
                ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END AS d
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN subscription s ON s.account_id = a.id
     WHERE a.deleted_at IS NULL AND (p_role = 'super' OR tc.partner_id = p_user)
  )
  SELECT count(*),
         count(*) FILTER (WHERE d >= 0 AND NOT is_demo),
         count(*) FILTER (WHERE d BETWEEN 0 AND 7 AND NOT is_demo),
         count(*) FILTER (WHERE d < 0 AND NOT is_demo),
         count(*) FILTER (WHERE st = 'trial' AND NOT is_demo),
         count(*) FILTER (WHERE is_demo)
    FROM b;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_counts(text, uuid) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 3: «ДЕНЬГИ» — оплаты, доли, сводка по деньгам.
--
-- СДЕЛАНО ИНАЧЕ, ЧЕМ У ДОНОРА. У них оплаченный отрезок («с какого по
-- какое») вычислялся пересчётом ВСЕЙ цепочки оплат клиента при каждом
-- открытии карточки: берут первую подтверждённую, прибавляют месяцы,
-- потом вторую и так далее.
--
-- Что с этим не так: цепочка живая. Одну оплату отклонили задним
-- числом, другую подтвердили не по порядку — и все отрезки съехали.
-- Клиент видит «оплачено с 5 марта», хотя платил 12-го.
--
-- У нас период записывается В МОМЕНТ ПОДТВЕРЖДЕНИЯ и больше не
-- меняется. Что было, то было — это ответ на вопрос «за что я платил»,
-- и он не должен зависеть от того, что случилось потом.
-- =====================================================================
ALTER TABLE tenant_payment
  ADD COLUMN IF NOT EXISTS period_from timestamptz,
  ADD COLUMN IF NOT EXISTS period_to   timestamptz;

COMMENT ON COLUMN tenant_payment.period_from IS
  'За какой отрезок заплачено. Пишется при подтверждении и не пересчитывается';

/**
 * Подтверждение оплаты — одним заходом в базе.
 *
 * Считает долю партнёра, продлевает подписку, записывает отрезок,
 * ставит отметки. Всё в одной операции: если что-то упадёт посередине,
 * не должно остаться половины — оплата подтверждена, а доступ не
 * продлён, или наоборот.
 *
 * Возвращает всё, что нужно показать: до какой даты продлили, сколько
 * кому досталось.
 */
CREATE OR REPLACE FUNCTION platform_approve_payment(
  p_payment uuid, p_actor uuid)
RETURNS TABLE (
  paid_until timestamptz, period_from timestamptz,
  partner_share bigint, platform_share bigint, amount bigint, months integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_p record; v_bp integer := 0; v_share bigint; v_from timestamptz; v_until timestamptz;
BEGIN
  SELECT * INTO v_p FROM tenant_payment WHERE id = p_payment FOR UPDATE;
  IF v_p.id IS NULL THEN RAISE EXCEPTION 'Оплата не найдена'; END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'Оплата уже %', CASE WHEN v_p.status = 'approved'
      THEN 'подтверждена' ELSE 'отклонена' END;
  END IF;

  -- Доля партнёра замораживается СЕЙЧАС. Поменяют ему комиссию позже —
  -- прошлые выплаты не пересчитаются задним числом, иначе отчёт за
  -- прошлый месяц изменится сам собой.
  IF v_p.partner_id IS NOT NULL THEN
    SELECT commission_bp INTO v_bp FROM platform_user WHERE id = v_p.partner_id;
  END IF;
  v_share := round(v_p.amount * coalesce(v_bp, 0) / 10000.0);

  -- Отрезок: от БОЛЬШЕЙ из дат — сегодня или конец оплаченного
  -- периода. Досрочная оплата не сжигает остаток.
  SELECT s.paid_until INTO v_from FROM subscription s WHERE s.account_id = v_p.account_id;
  v_from := greatest(coalesce(v_from, now()), now());
  v_until := v_from + (v_p.months || ' months')::interval;

  UPDATE tenant_payment
     SET status = 'approved', approved_by = p_actor, approved_at = now(),
         partner_bp = coalesce(v_bp, 0),
         partner_share = v_share,
         platform_share = v_p.amount - v_share,
         period_from = v_from, period_to = v_until
   WHERE id = p_payment;

  PERFORM platform_extend_subscription(v_p.account_id, v_p.months);

  RETURN QUERY SELECT v_until, v_from, v_share,
                      v_p.amount - v_share, v_p.amount, v_p.months;
END; $$;
GRANT EXECUTE ON FUNCTION platform_approve_payment(uuid, uuid) TO shop_app;

/**
 * Деньги: список оплат с отбором и итогами.
 *
 * Итоги считаются по ТЕМ ЖЕ строкам, что показываются: у донора сумма
 * сверху бралась отдельным запросом, и при отборе «ждут» она
 * показывала итог по всем — цифра не совпадала со списком под ней.
 */
CREATE OR REPLACE FUNCTION platform_money(
  p_status text, p_role text, p_user uuid, p_days integer DEFAULT 90)
RETURNS TABLE (
  id uuid, account_id uuid, client text, partner text, partner_id uuid,
  amount bigint, months integer, method text, comment text,
  status text, reject_reason text,
  period_from timestamptz, period_to timestamptz,
  partner_share bigint, platform_share bigint,
  created_at timestamptz, approved_at timestamptz,
  sum_amount bigint, sum_partner bigint, sum_platform bigint, cnt bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH picked AS (
    SELECT tp.*, a.name AS client_name, pu.full_name AS partner_name
      FROM tenant_payment tp
      JOIN account a ON a.id = tp.account_id
      LEFT JOIN platform_user pu ON pu.id = tp.partner_id
      LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
     WHERE (p_status IS NULL OR tp.status::text = p_status)
       AND (p_role = 'super' OR tp.partner_id = p_user)
       -- Учебные магазины в деньги не идут никогда.
       AND coalesce(tc.is_demo, false) = false
       AND tp.created_at > now() - (p_days || ' days')::interval
  )
  SELECT p.id, p.account_id, p.client_name, p.partner_name, p.partner_id,
         p.amount, p.months, p.method, p.comment,
         p.status::text, p.reject_reason,
         p.period_from, p.period_to,
         p.partner_share, p.platform_share,
         p.created_at, p.approved_at,
         -- Итоги только по ПОДТВЕРЖДЁННЫМ: ждущие и отклонённые — это
         -- ещё не деньги, складывать их в доход нельзя.
         sum(p.amount) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.partner_share) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.platform_share) FILTER (WHERE p.status = 'approved') OVER (),
         count(*) OVER ()
    FROM picked p
   -- Ждущие первыми: это то, что требует действия. Остальные по дате.
   ORDER BY (p.status <> 'pending'), p.created_at DESC
   LIMIT 300;
$$;
GRANT EXECUTE ON FUNCTION platform_money(text, text, uuid, integer) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 4: «ЗАЯВКИ» — партнёр просит, платформа решает.
--
-- Замысел донора взят: одобрение САМО ВЫПОЛНЯЕТ действие, а не просто
-- ставит отметку. Одобрил вторую кассу — строка счёта появилась.
-- Иначе владелец одобряет, а сделать забывает, и партнёр звонит через
-- неделю: «вы же согласились».
--
-- СДЕЛАНО ЛУЧШЕ: у решения есть ПРЕДПРОСМОТР — что именно произойдёт,
-- если одобрить. У донора кнопка «Одобрить» просто делала, и увидеть
-- последствие можно было только после. С деньгами так нельзя.
--
-- ЧЕТЫРЕ ВИДА, все под магазин, а не под ресторан:
--   device — вторая касса или точка;
--   tariff — смена тарифа;
--   grace  — отсрочка платежа;
--   other  — всё прочее, решается словами.
-- =====================================================================

/** Что произойдёт, если одобрить. Считает то же, что и одобрение. */
CREATE OR REPLACE FUNCTION platform_request_preview(p_request uuid)
RETURNS TABLE (
  kind text, client text, account_id uuid,
  what text, effect text, amount bigint, days_left integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_r record; v_set record; v_unit bigint := 0; v_days integer := 0;
  v_pro bigint := 0; v_kind text; v_what text; v_effect text;
BEGIN
  SELECT tr.*, a.name AS client_name INTO v_r
    FROM tenant_request tr JOIN account a ON a.id = tr.account_id
   WHERE tr.id = p_request;
  IF v_r.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_set FROM platform_settings WHERE id;

  -- Сколько дней до конца оплаченного периода: от этого зависит доплата.
  SELECT ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int INTO v_days
    FROM subscription s WHERE s.account_id = v_r.account_id;
  v_days := greatest(coalesce(v_days, 0), 0);

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    v_unit := CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
                   ELSE v_set.price_extra_pos END;
    -- Правило десяти дней: меньше — доплату не берём вовсе.
    IF v_days >= 10 THEN v_pro := round(v_unit * v_days / 30.0); END IF;
    v_what := CASE WHEN v_kind = 'store' THEN 'Вторая точка' ELSE 'Вторая касса' END;
    v_effect := 'Появится строка счёта на ' || round(v_unit / 100.0) || ' ₸/мес'
      || CASE WHEN v_pro > 0
              THEN '. Доплата за остаток периода: ' || round(v_pro / 100.0) || ' ₸'
              ELSE '. Доплаты нет — до конца периода меньше десяти дней' END;

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := CASE WHEN coalesce(v_r.payload->>'tier', 'pro') = 'pro'
                   THEN v_set.price_pro ELSE v_set.price_base END;
    v_what := 'Смена тарифа на ' || CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
                                         THEN '«Стандарт»' ELSE '«Старт»' END;
    v_effect := 'Основная строка счёта станет ' || round(v_unit / 100.0)
      || ' ₸/мес. Доплаты за устройства и скидки не изменятся';

  ELSIF v_r.kind = 'grace' THEN
    v_days := coalesce((v_r.payload->>'days')::int, 7);
    v_what := 'Отсрочка на ' || v_days || ' дн.';
    v_effect := 'Срок подписки сдвинется на ' || v_days
      || ' дн. вперёд. Деньги не поступят — это уступка, а не оплата';

  ELSE
    v_what := 'Прочее';
    v_effect := 'Решается словами: система ничего не изменит';
  END IF;

  RETURN QUERY SELECT v_r.kind, v_r.client_name, v_r.account_id,
                      v_what, v_effect, v_pro, v_days;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_preview(uuid) TO shop_app;

/**
 * Решение по заявке. Одобрение САМО выполняет действие.
 *
 * Всё одной операцией: отметка о решении и само действие. Иначе
 * возможно состояние «одобрено, но не сделано» — самое неприятное,
 * потому что все считают, что сделано.
 */
CREATE OR REPLACE FUNCTION platform_request_decide(
  p_request uuid, p_actor uuid, p_approve boolean, p_note text)
RETURNS TABLE (account_id uuid, kind text, effect text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_r record; v_set record; v_unit bigint; v_kind text; v_days integer;
  v_effect text := ''; v_n integer;
BEGIN
  SELECT * INTO v_r FROM tenant_request WHERE id = p_request FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Заявка не найдена'; END IF;
  IF v_r.status <> 'pending' THEN RAISE EXCEPTION 'Заявка уже решена'; END IF;

  UPDATE tenant_request
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decision_note = p_note, decided_by = p_actor, decided_at = now()
   WHERE id = p_request;

  IF NOT p_approve THEN
    RETURN QUERY SELECT v_r.account_id, v_r.kind, 'Отказано'::text;
    RETURN;
  END IF;

  SELECT * INTO v_set FROM platform_settings WHERE id;

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    v_unit := CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
                   ELSE v_set.price_extra_pos END;
    SELECT count(*) + 2 INTO v_n FROM plan_line pl
     WHERE pl.account_id = v_r.account_id AND pl.kind = v_kind AND pl.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, v_kind,
            CASE WHEN v_kind = 'store' THEN 'Точка №' ELSE 'Касса №' END || v_n, 1, v_unit);
    v_effect := 'Строка счёта добавлена';

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
                   THEN v_set.price_pro ELSE v_set.price_base END;
    -- Только основная строка: доплаты и скидки — отдельные
    -- договорённости, их менять нельзя.
    UPDATE plan_line SET ends_at = now()
     WHERE plan_line.account_id = v_r.account_id AND plan_line.kind = 'base'
       AND plan_line.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, 'base', 'Тариф', 1, v_unit);
    v_effect := 'Тариф изменён';

  ELSIF v_r.kind = 'grace' THEN
    v_days := coalesce((v_r.payload->>'days')::int, 7);
    UPDATE subscription
       SET paid_until = greatest(coalesce(paid_until, now()), now())
                        + (v_days || ' days')::interval,
           status = 'active'
     WHERE subscription.account_id = v_r.account_id;
    UPDATE account SET status = 'active'
     WHERE id = v_r.account_id AND status <> 'active';
    v_effect := 'Отсрочка на ' || v_days || ' дн. дана';

  ELSE
    v_effect := 'Отмечено решённым';
  END IF;

  RETURN QUERY SELECT v_r.account_id, v_r.kind, v_effect;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_decide(uuid, uuid, boolean, text) TO shop_app;
