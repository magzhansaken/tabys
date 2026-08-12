-- =====================================================================
-- 014_fiscal.sql — ФИСКАЛИЗАЦИЯ (Часть 5)
-- Решения: docs/5_Решения_фискализация.md
--
-- Каркас заложен в 001_core: fiscal_agent (термин UMAG «агент фискализации»)
-- и привязка кассы. Здесь — рабочая часть: ККМ, очередь чеков, смены ККМ.
--
-- Оператор сменный (UMAG жёстко привязан к WebKassa): он может лечь, поднять
-- цены или потерять аккредитацию — магазин от этого не должен закрыться.
-- Офлайн-чеки получают фискальный признак задним числом — модель Wipon.
-- =====================================================================

-- Kaspi Касса — отдельная ККМ, Wipon её документирует (Kaspi Pay → «О кассе»)
ALTER TYPE fiscal_provider ADD VALUE IF NOT EXISTS 'kaspi';
-- режимы Wipon по способу оплаты (в 001 уже есть all / selective / cashless_only / off)
ALTER TYPE fiscal_mode ADD VALUE IF NOT EXISTS 'cash_only';
ALTER TYPE fiscal_mode ADD VALUE IF NOT EXISTS 'card_only';
CREATE TYPE fiscal_op AS ENUM ('sale','refund','deposit','withdrawal','x_report','z_report');
CREATE TYPE fiscal_status AS ENUM ('pending','ok','failed','not_required','expired');

-- =====================================================================
-- ККМ — конкретная касса у оператора.
-- Поля повторяют таблицу «Кассы с фискализацией» UMAG (POS ID, название,
-- точка, заводской номер, логин) плюс карточку «О кассе» из Kaspi Pay
-- (регномер, заводской номер, ID, дата подключения, статус, НДС).
-- =====================================================================
CREATE TABLE kkm (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  cash_register_id uuid REFERENCES cash_register(id) ON DELETE CASCADE,
  store_id        uuid REFERENCES store(id),
  provider        fiscal_provider NOT NULL DEFAULT 'webkassa',
  mode            fiscal_mode NOT NULL DEFAULT 'all',
  reg_number      text,                       -- РНМ: регистрационный номер в КГД
  serial_number   text,                       -- ЗНМ: заводской номер
  kkm_id          text,                       -- идентификатор кассы у оператора
  api_login       text,
  api_password_enc bytea,                     -- шифруется, текстом не хранится
  api_url         text,
  token           text,
  token_until     timestamptz,
  -- Wipon: «Разрешить фискализацию безналичных» — отдельная опция
  allow_cashless_fiscal boolean NOT NULL DEFAULT false,  -- опция Wipon: её включают осознанно
  allow_cash_fiscal boolean NOT NULL DEFAULT true,
  vat_enabled     boolean NOT NULL DEFAULT true,   -- Kaspi Pay: включить/выключить чеки с НДС
  -- автономный период ККМ по договору с оператором (обычно 72 часа):
  -- чек старше не тонет молча, а попадает в «требует внимания»
  autonomous_hours integer NOT NULL DEFAULT 72,
  shift_number    integer,
  shift_opened_at timestamptz,
  connected_at    timestamptz,
  last_ok_at      timestamptz,
  offline_since   timestamptz,                -- когда оператор перестал отвечать
  is_active       boolean NOT NULL DEFAULT true,
  extra           jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX kkm_register_uniq ON kkm(cash_register_id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX ON kkm(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- ФИСКАЛЬНЫЙ ЧЕК: и очередь, и результат в одной таблице.
-- Wipon: «в офлайне после перехода в онлайн автоматически пробивается
-- фискальный признак». Строка переживает перезапуск кассы: чек покупателю
-- уже отдан, переспрашивать поздно.
-- =====================================================================
CREATE TABLE fiscal_receipt (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kkm_id          uuid NOT NULL REFERENCES kkm(id) ON DELETE CASCADE,
  sale_id         uuid REFERENCES sale(id) ON DELETE CASCADE,
  op              fiscal_op NOT NULL DEFAULT 'sale',
  status          fiscal_status NOT NULL DEFAULT 'pending',
  fiscal_number   text,                       -- фискальный признак
  fiscal_ticket   text,                       -- номер чека у оператора
  check_url       text,                       -- ссылка проверки (в QR на чеке)
  qr_data         text,
  shift_number    integer,
  amount          numeric(14,2),
  refund_of_id    uuid REFERENCES fiscal_receipt(id),   -- возврат ссылается на исходный чек
  attempts        integer NOT NULL DEFAULT 0,
  error           text,
  response        jsonb,
  punched_at      timestamptz NOT NULL DEFAULT now(),   -- когда пробит на кассе
  next_attempt_at timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX fiscal_receipt_sale_uniq ON fiscal_receipt(sale_id, op) WHERE sale_id IS NOT NULL;
CREATE INDEX ON fiscal_receipt(account_id, status, next_attempt_at);
CREATE INDEX ON fiscal_receipt(kkm_id, created_at DESC);

-- =====================================================================
-- СМЕНА ККМ. У Wipon это отдельная смена (ККМ / программа / терминал),
-- и закрывать надо все — закрытие через «Продажи» закрывает три сразу.
-- =====================================================================
CREATE TABLE fiscal_shift (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kkm_id        uuid NOT NULL REFERENCES kkm(id) ON DELETE CASCADE,
  shift_id      uuid REFERENCES shift(id),    -- наша кассовая смена
  number        integer,
  status        fiscal_status NOT NULL DEFAULT 'pending',
  z_report      jsonb,
  error         text,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON fiscal_shift(kkm_id, opened_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kkm','fiscal_receipt','fiscal_shift']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER kkm_touch BEFORE UPDATE ON kkm FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ЗДОРОВЬЕ ФИСКАЛИЗАЦИИ: что показать владельцу одним взглядом.
-- Отдельно считаем чеки, просроченные сверх автономного периода.
-- =====================================================================
CREATE OR REPLACE FUNCTION fiscal_health(p_account uuid)
RETURNS TABLE (total bigint, ok bigint, pending bigint, failed bigint,
               oldest_pending timestamptz, last_error text, overdue bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $fn$
  SELECT count(*),
         count(*) FILTER (WHERE fr.status = 'ok'),
         count(*) FILTER (WHERE fr.status = 'pending'),
         count(*) FILTER (WHERE fr.status = 'failed'),
         min(fr.punched_at) FILTER (WHERE fr.status IN ('pending','failed')),
         (SELECT error FROM fiscal_receipt e
           WHERE e.account_id = p_account AND e.status = 'failed'
           ORDER BY e.punched_at DESC LIMIT 1),
         count(*) FILTER (WHERE fr.status IN ('pending','failed')
                           AND fr.punched_at < now() - (k.autonomous_hours || ' hours')::interval)
    FROM fiscal_receipt fr JOIN kkm k ON k.id = fr.kkm_id
   WHERE fr.account_id = p_account;
$fn$;
GRANT EXECUTE ON FUNCTION fiscal_health(uuid) TO shop_app;

-- =====================================================================
-- НУЖНО ЛИ ФИСКАЛИЗИРОВАТЬ (модель Wipon: настройка по способу оплаты).
-- Режим 'selective' из UMAG («кассир сам выбирает, проводить оплату с
-- фискализацией или без») трактуем как 'all': решать, платить ли налоги, —
-- не работа кассира, и подставлять владельца под штраф мы не будем.
-- =====================================================================
CREATE OR REPLACE FUNCTION needs_fiscalization(p_kkm uuid, p_cash numeric, p_card numeric, p_qr numeric)
RETURNS boolean SECURITY DEFINER SET search_path = public LANGUAGE plpgsql STABLE AS $$
DECLARE k record;
BEGIN
  SELECT * INTO k FROM kkm WHERE id = p_kkm AND is_active AND deleted_at IS NULL;
  IF NOT FOUND OR k.mode = 'off' OR k.provider = 'none' THEN RETURN false; END IF;
  IF k.mode = 'all' OR k.mode = 'selective' THEN RETURN true; END IF;
  -- смешанная оплата фискализируется в обоих режимах (правило Wipon)
  IF k.mode = 'cash_only' THEN RETURN coalesce(p_cash, 0) > 0; END IF;
  IF k.mode = 'card_only' OR k.mode = 'cashless_only' THEN
    RETURN (coalesce(p_card, 0) > 0 OR coalesce(p_qr, 0) > 0) AND k.allow_cashless_fiscal;
  END IF;
  RETURN false;
END $$;
GRANT EXECUTE ON FUNCTION needs_fiscalization(uuid,numeric,numeric,numeric) TO shop_app;

-- Чеки, не уехавшие за автономный период — «требует внимания», а не тишина
CREATE OR REPLACE FUNCTION fiscal_overdue(p_account uuid)
RETURNS TABLE (receipt_id uuid, sale_id uuid, punched_at timestamptz, hours_late numeric, attempts integer, error text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT fr.id, fr.sale_id, fr.punched_at,
         round((extract(epoch FROM (now() - fr.punched_at)) / 3600)::numeric, 1),
         fr.attempts, fr.error
    FROM fiscal_receipt fr JOIN kkm k ON k.id = fr.kkm_id
   WHERE fr.account_id = p_account AND fr.status IN ('pending','failed')
     AND fr.punched_at < now() - (k.autonomous_hours || ' hours')::interval
   ORDER BY fr.punched_at;
$$;
GRANT EXECUTE ON FUNCTION fiscal_overdue(uuid) TO shop_app;

-- =====================================================================
-- ТАБЛИЦА РЕЖИМОВ WIPON: нужен ли этому чеку фискальный признак.
-- Принимает режим и суммы, а не идентификатор ККМ: касса решает это офлайн,
-- когда сервера рядом нет, — значит правило должно быть чистой функцией.
--
-- Режим 'selective' из UMAG («кассир сам выбирает, проводить оплату с
-- фискализацией или без») трактуем как 'all': решать, платить ли налоги, —
-- не работа кассира, и подставлять владельца под штраф мы не станем.
-- =====================================================================
CREATE OR REPLACE FUNCTION needs_fiscal(p_mode fiscal_mode, p_cash numeric, p_card numeric,
                                        p_allow_cashless boolean DEFAULT true, p_allow_cash boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_mode = 'off' THEN RETURN false; END IF;
  IF p_mode = 'all' OR p_mode = 'selective' THEN RETURN true; END IF;

  -- «Только наличные». Смешанная оплата попадает сюда же: в ней есть наличные.
  -- Плюс исключение Wipon: переключатель «Разрешить фискализацию безналичных»
  -- включает карту даже в этом режиме.
  IF p_mode = 'cash_only' THEN
    RETURN (coalesce(p_cash, 0) > 0 AND coalesce(p_allow_cash, true))
        OR (coalesce(p_card, 0) > 0 AND coalesce(p_allow_cashless, false));
  END IF;

  -- «Только карта»: смешанная оплата тоже фискализируется — в ней есть карта.
  IF p_mode = 'card_only' OR p_mode = 'cashless_only' THEN
    RETURN coalesce(p_card, 0) > 0;
  END IF;

  RETURN false;
END $$;
GRANT EXECUTE ON FUNCTION needs_fiscal(fiscal_mode,numeric,numeric,boolean,boolean) TO shop_app;
