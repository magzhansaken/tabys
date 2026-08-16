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
