-- =====================================================================
-- 001_core.sql — ЯДРО ДАННЫХ
-- Проект: система автоматизации магазинов (Казахстан)
-- Основано на анализе: UMAG (структура, разрешения кассы, привязка устройств),
-- Wipon (компании КЗ, склады, единицы, доступы), МойСклад (юрлица, роли).
-- Решения и обоснования: docs/1.1_Решения_ядро_данных.md
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- поиск по названиям (нужен со 2-й части)

-- ---------------------------------------------------------------------
-- Служебное: единый счётчик изменений (seq) для синхронизации.
-- Каждая изменённая строка получает номер из этой последовательности.
-- Клиент синхронизируется запросом «дай всё, что новее моего seq».
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS global_seq;

CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.seq := nextval('global_seq');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Типы-перечисления: КЗ-специфика
CREATE TYPE org_type       AS ENUM ('ip', 'too', 'ao', 'other');           -- ИП, ТОО, АО
CREATE TYPE tax_regime     AS ENUM ('general','simplified','retail_tax','patent','fixed','tis');
CREATE TYPE account_status AS ENUM ('trial','active','suspended','deleted');
CREATE TYPE platform_type  AS ENUM ('windows','android','ios','web','linux');
CREATE TYPE fiscal_mode    AS ENUM ('all','selective','cashless_only','off');
CREATE TYPE fiscal_provider AS ENUM ('webkassa','rekassa','none');
CREATE TYPE actor_scope    AS ENUM ('admins','all','nobody');              -- UMAG: кто может делать действие
CREATE TYPE oplog_op       AS ENUM ('insert','update','delete');

-- =====================================================================
-- 1. АККАУНТ (тенант) — один бизнес клиента. Регистрация по телефону.
--    Решение: телефон как логин (UMAG, Wipon), e-mail необязателен.
-- =====================================================================
CREATE TABLE account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE,                 -- E.164: +7701...
  email           text,
  name            text NOT NULL,                        -- как называть бизнес
  lang            text NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','kk')),  -- KK с 1-го дня (Wipon)
  timezone        text NOT NULL DEFAULT 'Asia/Almaty',
  currency        char(3) NOT NULL DEFAULT 'KZT',
  status          account_status NOT NULL DEFAULT 'trial',
  trial_ends_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
COMMENT ON TABLE account IS 'Тенант: бизнес клиента. Логин — номер телефона владельца.';

-- =====================================================================
-- 2. ОРГАНИЗАЦИЯ (юрлицо: ИП/ТОО) — на неё оформляются документы и ККМ.
--    Решение: отдельная сущность (МС+Wipon), т.к. в КЗ часто ИП+ТОО вместе.
--    Поля — по карточке компании Wipon (уже выверены под КЗ).
-- =====================================================================
CREATE TABLE organization (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  type            org_type NOT NULL DEFAULT 'ip',
  name            text NOT NULL,                        -- ТОО «Ромашка» / ИП Иванов
  short_name      text,
  tin             text,                                 -- ИИН (физлицо/ИП) или БИН (юрлицо), 12 цифр
  tax_regime      tax_regime NOT NULL DEFAULT 'simplified',
  vat_payer       boolean NOT NULL DEFAULT false,       -- плательщик НДС
  vat_series      text,                                 -- серия свидетельства НДС
  vat_number      text,
  vat_date        date,
  director_name   text,
  accountant_name text,
  address         text,
  phone           text,
  bank_name       text,
  bank_bic        text,
  bank_account    text,                                 -- ИИК (KZ...)
  business_category text,                               -- категория/специализация (Wipon)
  stamp_url       text,                                 -- печать (Wipon: «загрузка печати»)
  signature_url   text,                                 -- подпись
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT tin_format CHECK (tin IS NULL OR tin ~ '^[0-9]{12}$')
);
CREATE INDEX ON organization(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 3. ПРОФИЛЬ РАЗРЕШЕНИЙ КАССЫ — главная находка UMAG («Настройка
--    разрешений на кассе»), вынесенная в именованный профиль.
--    Решение: профиль вешается на точку, касса может переопределить.
-- =====================================================================
CREATE TABLE pos_profile (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name            text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,

  -- Основные (UMAG)
  allow_minimize          boolean NOT NULL DEFAULT false,  -- сворачивать окно кассы
  instant_sync            boolean NOT NULL DEFAULT true,   -- немедленная синхронизация
  show_sales_history      boolean NOT NULL DEFAULT true,   -- показывать историю продаж
  new_shift_receipt       boolean NOT NULL DEFAULT true,   -- чек нового образца при закрытии смены
  global_catalog_search   boolean NOT NULL DEFAULT true,   -- поиск по глобальной базе штрихкодов

  -- Функции (UMAG)
  allow_universal_product boolean NOT NULL DEFAULT true,   -- товар без штрихкода
  allow_edit_product      boolean NOT NULL DEFAULT false,  -- изменение товара с кассы
  allow_park_receipt      boolean NOT NULL DEFAULT true,   -- отложка
  allow_discount          boolean NOT NULL DEFAULT true,
  allow_credit_sale       boolean NOT NULL DEFAULT true,   -- продажа в долг
  allow_cash_in_out       boolean NOT NULL DEFAULT true,   -- внос/вынос
  split_contragents       boolean NOT NULL DEFAULT false,  -- контрагенты не пересекаются между точками
  allow_wholesale         boolean NOT NULL DEFAULT false,  -- оптовые продажи на кассе
  allow_create_product    boolean NOT NULL DEFAULT false,  -- создавать товар с кассы (МС)
  choose_cashier          boolean NOT NULL DEFAULT false,  -- выбирать кассира при продаже (МС)

  -- Финансы (UMAG)
  allow_price_check       boolean NOT NULL DEFAULT true,   -- проверка цены без продажи
  forbid_price_decrease   boolean NOT NULL DEFAULT false,
  allow_price_edit        boolean NOT NULL DEFAULT false,
  allow_cashless          boolean NOT NULL DEFAULT true,
  allow_sales_over_million boolean NOT NULL DEFAULT false, -- продажи свыше 1 млн ₸
  max_discount_percent    numeric(5,2),                    -- максимальная скидка % (МС); NULL = без лимита
  allow_negative_stock    boolean NOT NULL DEFAULT false,  -- продажа с недостачей (Wipon) = учёт остатков выкл (МС)

  -- Кто может (UMAG: администраторы / все / никто)
  who_can_refund          actor_scope NOT NULL DEFAULT 'admins',
  who_can_refund_no_receipt actor_scope NOT NULL DEFAULT 'admins',
  who_can_remove_line     actor_scope NOT NULL DEFAULT 'all',
  who_can_decrease_qty    actor_scope NOT NULL DEFAULT 'all',

  -- Округление (UMAG) и фискализация (UMAG WebKassa / Wipon склад)
  rounding_weight         numeric(6,2) NOT NULL DEFAULT 0,   -- шаг округления весовых
  rounding_discount       numeric(6,2) NOT NULL DEFAULT 0,
  rounding_total          numeric(6,2) NOT NULL DEFAULT 0,   -- округление итога чека
  fiscal_default_mode     fiscal_mode NOT NULL DEFAULT 'all',

  extra           jsonb NOT NULL DEFAULT '{}',              -- задел под новые флаги без миграций
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON pos_profile(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 4. ТОРГОВАЯ ТОЧКА (магазин)
--    Решение: точка отдельно от склада (МС/UMAG), но склад автосоздаётся.
-- =====================================================================
CREATE TABLE store (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organization(id),      -- юрлицо точки по умолчанию (МС)
  pos_profile_id  uuid REFERENCES pos_profile(id),        -- профиль разрешений кассы
  name            text NOT NULL,
  code            text,                                   -- префикс номеров документов (МС)
  region          text,                                   -- область (Wipon)
  city            text,
  address         text,
  address_comment text,
  phone           text,
  lat             numeric(9,6),
  lon             numeric(9,6),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON store(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 5. СКЛАД
--    Решение: основной склад создаётся автоматически и не удаляется (Wipon).
--    Виртуальный склад — для брака/списаний (у Wipon есть флаг).
-- =====================================================================
CREATE TABLE warehouse (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  store_id        uuid REFERENCES store(id),              -- NULL = общий склад на несколько точек
  name            text NOT NULL,
  is_primary      boolean NOT NULL DEFAULT false,         -- основной, неудаляемый
  is_virtual      boolean NOT NULL DEFAULT false,
  sales_enabled   boolean NOT NULL DEFAULT true,          -- «режим продаж» (Wipon): можно ли продавать с этого склада
  address         text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON warehouse(account_id) WHERE deleted_at IS NULL;
CREATE INDEX ON warehouse(store_id);

ALTER TABLE store ADD COLUMN default_warehouse_id uuid REFERENCES warehouse(id);

-- =====================================================================
-- 6. АГЕНТ ФИСКАЛИЗАЦИИ (UMAG: «Агенты фискализации» — посредник до КГД)
--    Детали API — Часть 5. Здесь только хранилище привязки.
-- =====================================================================
CREATE TABLE fiscal_agent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organization(id),
  provider        fiscal_provider NOT NULL DEFAULT 'webkassa',
  name            text NOT NULL,
  login           text,
  secret_enc      bytea,                                  -- пароль/токен: шифруется, не хранится текстом
  extra           jsonb NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  last_check_at   timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON fiscal_agent(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 7. КАССА (рабочее место). Решение: поля статуса/версии/синхронизации —
--    как в таблице касс UMAG; «секция» — от Wipon; настройки чека — UMAG.
-- =====================================================================
CREATE TABLE cash_register (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES store(id),
  warehouse_id    uuid REFERENCES warehouse(id),          -- с какого склада продаёт
  pos_profile_id  uuid REFERENCES pos_profile(id),        -- переопределение профиля точки
  fiscal_agent_id uuid REFERENCES fiscal_agent(id),
  name            text NOT NULL,
  section         text,                                   -- «Молочка» (Wipon)
  is_active       boolean NOT NULL DEFAULT true,

  -- Фискальная привязка (заполняется в Части 5)
  fiscal_mode     fiscal_mode NOT NULL DEFAULT 'all',
  fiscal_cashbox_id text,                                 -- ID кассы у провайдера
  fiscal_reg_number text,                                 -- РНМ (регистрационный номер ККМ)
  fiscal_serial   text,                                   -- ЗНМ (заводской номер)
  fiscal_ofd_name text,
  fiscal_registered_at timestamptz,

  -- Настройки чека (UMAG «Настройка чека»)
  receipt_header  text,
  receipt_footer  text,
  receipt_width   smallint NOT NULL DEFAULT 58,           -- 58 / 80 мм
  receipt_codepage smallint NOT NULL DEFAULT 866,         -- кодировка кириллицы принтера
  receipt_table_view boolean NOT NULL DEFAULT false,
  receipt_print_vat  boolean NOT NULL DEFAULT false,

  -- Телеметрия (UMAG: версия, платформа, последняя синхронизация)
  app_version     text,
  platform        platform_type,
  last_sync_at    timestamptz,
  last_seen_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON cash_register(account_id) WHERE deleted_at IS NULL;
CREATE INDEX ON cash_register(store_id);

-- =====================================================================
-- 8. РОЛИ (кабинет). Матрица прав в JSONB: {"goods":{"view":true,...}}
--    Решение: 3 системные роли (МС) + свои роли (UMAG/Wipon).
-- =====================================================================
CREATE TABLE role (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid REFERENCES account(id) ON DELETE CASCADE,  -- NULL = системная роль
  name            text NOT NULL,
  code            text,                                   -- owner/admin/cashier для системных
  is_system       boolean NOT NULL DEFAULT false,
  permissions     jsonb NOT NULL DEFAULT '{}',            -- разделы × действия
  -- спец-права (UMAG «просмотр закупочных цен», Wipon «сумма продаж кассиру»)
  can_see_purchase_price boolean NOT NULL DEFAULT false,
  can_see_revenue        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON role(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 9. СОТРУДНИК. Решение: телефон+пароль (кабинет) и PIN 4 цифры (касса, UMAG),
--    штрихкод-бейдж для подтверждения действий (UMAG), увольнение = soft delete.
-- =====================================================================
CREATE TABLE employee (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  role_id         uuid REFERENCES role(id),
  first_name      text NOT NULL,
  last_name       text,
  phone           text NOT NULL,                          -- логин в кабинет
  email           text,
  password_hash   text,
  pos_pin_hash    text,                                   -- PIN 4 цифры (хэш)
  badge_barcode   text,                                   -- штрихкод сотрудника (UMAG)
  position        text,                                   -- должность (UMAG «Должности»)
  can_login_admin boolean NOT NULL DEFAULT false,
  can_login_pos   boolean NOT NULL DEFAULT true,          -- UMAG «Разрешить вход на кассу»
  is_owner        boolean NOT NULL DEFAULT false,         -- владелец аккаунта (МС), один на аккаунт
  is_active       boolean NOT NULL DEFAULT true,
  dismissed_at    timestamptz,                            -- «бывшие пользователи» (UMAG)
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT employee_phone_uniq UNIQUE (account_id, phone)
);
CREATE INDEX ON employee(account_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX one_owner_per_account ON employee(account_id) WHERE is_owner AND deleted_at IS NULL;
CREATE UNIQUE INDEX badge_uniq ON employee(account_id, badge_barcode) WHERE badge_barcode IS NOT NULL AND deleted_at IS NULL;

-- Сотрудник ↔ торговые точки (UMAG: пользователь работает в списке точек)
CREATE TABLE employee_store (
  employee_id     uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, store_id)
);

-- =====================================================================
-- 10. УСТРОЙСТВО. Решение: привязка одноразовым кодом (UMAG «Сгенерировать
--     одноразовый ключ»), после привязки — долгоживущий токен устройства.
-- =====================================================================
CREATE TABLE device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  cash_register_id uuid REFERENCES cash_register(id),
  name            text,
  platform        platform_type,
  app_version     text,
  pairing_code    text,                                   -- одноразовый ключ
  pairing_expires_at timestamptz,
  token_hash      text,                                   -- токен устройства после привязки
  paired_at       timestamptz,
  last_seen_at    timestamptz,
  last_sync_seq   bigint NOT NULL DEFAULT 0,              -- докуда устройство вычитало oplog
  is_blocked      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON device(account_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX device_pairing_code_uniq ON device(pairing_code) WHERE pairing_code IS NOT NULL;

-- =====================================================================
-- 11. КОНСУЛЬТАНТ (UMAG) — продавец без доступа в систему, привязывается
--     к продаже для статистики.
-- =====================================================================
CREATE TABLE consultant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text,
  store_id        uuid REFERENCES store(id),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON consultant(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- 12. ЕДИНИЦЫ ИЗМЕРЕНИЯ (Wipon: «от условной единицы до пары», можно свои)
-- =====================================================================
CREATE TABLE unit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid REFERENCES account(id) ON DELETE CASCADE,   -- NULL = системная
  name            text NOT NULL,
  short_name      text NOT NULL,
  name_kk         text,                                   -- казахское название (наше отличие)
  short_name_kk   text,
  kind            text NOT NULL DEFAULT 'piece' CHECK (kind IN ('piece','weight','volume','length','area','time','other')),
  precision       smallint NOT NULL DEFAULT 0,            -- знаков после запятой: шт=0, кг=3
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON unit(account_id);

-- =====================================================================
-- 13. ДОСТУП ПОДДЕРЖКИ (UMAG «Выдать доступ») — временный вход техспециалиста
--     без передачи пароля. Наш ответ на боль «не дозвониться в поддержку».
-- =====================================================================
CREATE TABLE support_access (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  grantee_phone   text NOT NULL,                          -- кому выдан
  grantee_name    text,
  scope           jsonb NOT NULL DEFAULT '{}',            -- какие точки/разделы
  granted_by      uuid REFERENCES employee(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON support_access(account_id);

-- =====================================================================
-- 14. OPLOG — журнал операций. Сердце синхронизации.
--     id генерирует КЛИЕНТ → повторная отправка не создаёт дубль.
-- =====================================================================
CREATE TABLE oplog (
  id              uuid PRIMARY KEY,                       -- UUID от клиента (идемпотентность!)
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  seq             bigserial NOT NULL,                     -- глобальный порядок применения
  entity          text NOT NULL,                          -- 'sale', 'product', ...
  entity_id       uuid NOT NULL,
  op              oplog_op NOT NULL,
  payload         jsonb NOT NULL,
  device_id       uuid REFERENCES device(id),
  employee_id     uuid REFERENCES employee(id),
  store_id        uuid REFERENCES store(id),
  client_ts       timestamptz NOT NULL,                   -- время на устройстве
  server_ts       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oplog_pull_idx ON oplog(account_id, seq);
CREATE INDEX ON oplog(entity, entity_id);

-- =====================================================================
-- 15. АУДИТ — кто что изменил (нужен и для поддержки, и для споров с кассирами)
-- =====================================================================
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id     uuid REFERENCES employee(id),
  device_id       uuid REFERENCES device(id),
  action          text NOT NULL,
  entity          text,
  entity_id       uuid,
  before          jsonb,
  after           jsonb,
  ip              inet,
  ts              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log(account_id, ts DESC);

-- =====================================================================
-- ТРИГГЕРЫ updated_at + seq на все таблицы ядра
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account','organization','pos_profile','store','warehouse',
                           'fiscal_agent','cash_register','role','employee','device',
                           'consultant','unit','support_access']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_row()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- РОЛЬ ПРИЛОЖЕНИЯ. Критично: сервер ходит в БД под НЕ-суперпользователем,
-- иначе RLS молча отключается (суперпользователь обходит все политики).
-- Миграции — под владельцем (shop), рантайм — под shop_app.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shop_app') THEN
    CREATE ROLE shop_app LOGIN PASSWORD 'change_me_in_prod' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO shop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shop_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shop_app;

-- =====================================================================
-- RLS — страховка мультитенантности на уровне БД.
-- Приложение обязано выставлять SET LOCAL app.account_id = '<uuid>'.
-- Даже при ошибке в коде запроса чужие данные не отдадутся.
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization','pos_profile','store','warehouse','fiscal_agent',
                           'cash_register','employee','employee_store','device','consultant',
                           'support_access','oplog','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;

-- Аккаунт виден только сам себе (у него нет account_id — политика по id)
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_self ON account USING
  (id = nullif(current_setting('app.account_id', true), '')::uuid);

-- Регистрация нового аккаунта: до неё app.account_id ещё не существует,
-- поэтому вход только через контролируемую функцию (обходит RLS осознанно).
CREATE OR REPLACE FUNCTION register_account(p_phone text, p_name text, p_owner_name text, p_lang text DEFAULT 'ru')
RETURNS TABLE (account_id uuid, employee_id uuid)
SECURITY DEFINER SET search_path = public AS $$
DECLARE a_id uuid; e_id uuid; s_id uuid; w_id uuid; p_id uuid;
BEGIN
  INSERT INTO account (phone, name, lang) VALUES (p_phone, p_name, p_lang) RETURNING id INTO a_id;
  -- профиль разрешений кассы по умолчанию
  INSERT INTO pos_profile (account_id, name, is_default) VALUES (a_id, 'Стандартный', true) RETURNING id INTO p_id;
  -- первая точка и её склад создаются сразу: клиент начинает работать, а не настраивать
  INSERT INTO store (account_id, name, pos_profile_id) VALUES (a_id, p_name, p_id) RETURNING id INTO s_id;
  INSERT INTO warehouse (account_id, store_id, name, is_primary) VALUES (a_id, s_id, 'Основной склад', true) RETURNING id INTO w_id;
  UPDATE store SET default_warehouse_id = w_id WHERE id = s_id;
  INSERT INTO employee (account_id, role_id, first_name, phone, is_owner, can_login_admin, can_login_pos, position)
  VALUES (a_id, (SELECT id FROM role WHERE code='owner'), p_owner_name, p_phone, true, true, true, 'Владелец')
  RETURNING id INTO e_id;
  INSERT INTO employee_store (employee_id, store_id, account_id) VALUES (e_id, s_id, a_id);
  RETURN QUERY SELECT a_id, e_id;
END $$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION register_account(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_account(text,text,text,text) TO shop_app;

-- Системные справочники (unit, role): видны всем + свои
ALTER TABLE unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY unit_visibility ON unit USING
  (account_id IS NULL OR account_id = nullif(current_setting('app.account_id', true), '')::uuid);
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_visibility ON role USING
  (account_id IS NULL OR account_id = nullif(current_setting('app.account_id', true), '')::uuid);

-- =====================================================================
-- СИСТЕМНЫЕ ДАННЫЕ: роли и единицы измерения (RU + KK)
-- =====================================================================
INSERT INTO role (id, account_id, name, code, is_system, permissions, can_see_purchase_price, can_see_revenue) VALUES
 (gen_random_uuid(), NULL, 'Владелец',      'owner',   true, '{"*":{"view":true,"create":true,"edit":true,"delete":true}}', true,  true),
 (gen_random_uuid(), NULL, 'Администратор', 'admin',   true, '{"*":{"view":true,"create":true,"edit":true,"delete":true}}', true,  true),
 (gen_random_uuid(), NULL, 'Кассир',        'cashier', true,
    '{"pos":{"view":true,"create":true},"goods":{"view":true},"clients":{"view":true,"create":true}}', false, false);

INSERT INTO unit (account_id, name, short_name, name_kk, short_name_kk, kind, precision) VALUES
 (NULL,'Штука','шт','Дана','дана','piece',0),
 (NULL,'Килограмм','кг','Килограмм','кг','weight',3),
 (NULL,'Грамм','г','Грамм','г','weight',0),
 (NULL,'Литр','л','Литр','л','volume',3),
 (NULL,'Метр','м','Метр','м','length',2),
 (NULL,'Упаковка','упак','Қаптама','қапт','piece',0),
 (NULL,'Коробка','кор','Қорап','қор','piece',0),
 (NULL,'Пара','пара','Жұп','жұп','piece',0),
 (NULL,'Услуга','усл','Қызмет','қызм','other',0);
