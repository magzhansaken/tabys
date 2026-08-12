-- =====================================================================
-- 015_contragents.sql — КОНТРАГЕНТЫ И ДОЛГИ
-- Решения: docs/6_Решения_контрагенты.md
--
-- Один справочник с ролями, а не два (UMAG и Wipon держат покупателей и
-- поставщиков раздельно). В магазине у дома ИП Ержан привозит воду и берёт
-- сигареты себе в киоск — это одно лицо.
--
-- Баланс — сумма движений, а не поле (принцип из 1.3). Иначе две кассы,
-- работавшие офлайн, затрут долг друг друга.
-- =====================================================================
CREATE TYPE cp_kind AS ENUM ('person','company','entrepreneur');   -- тип контрагента (UMAG)
CREATE TYPE balance_reason AS ENUM (
  'sale_credit',        -- продажа в долг
  'debt_payment',       -- должник принёс деньги
  'supply',             -- приёмка: мы должны поставщику
  'supply_payment',     -- мы заплатили поставщику
  'refund_credit',      -- возврат товара, купленного в долг
  'adjustment'          -- ручная правка с комментарием
);

-- =====================================================================
-- КОНТРАГЕНТ
-- =====================================================================
CREATE TABLE counterparty (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code          serial,                          -- «номер» в списке UMAG
  name          text NOT NULL,                   -- единственное обязательное поле (UMAG)
  kind          cp_kind NOT NULL DEFAULT 'person',
  -- роли: контрагент может быть и покупателем, и поставщиком одновременно
  is_customer   boolean NOT NULL DEFAULT true,
  is_supplier   boolean NOT NULL DEFAULT false,

  phone         text,
  email         text,
  -- реквизиты КЗ (UMAG: ИИН/БИН, полное название, юр. и физ. адреса)
  iin_bin       text,
  full_name     text,
  director      text,                            -- Wipon фильтрует поставщиков по директору
  legal_address text,
  actual_address text,
  bank_account  text,
  bank_bic      text,
  gov_synced_at timestamptz,                     -- когда подтянули из госреестра (Wipon: stat.gov.kz)

  group_name    text,                            -- группы поставщиков (Wipon)
  store_id      uuid REFERENCES store(id),       -- «магазин, в котором обслуживается» (UMAG)
  price_type_id uuid REFERENCES price_type(id),  -- оптовику — оптовая цена автоматически

  -- ДОЛГ: лимит и срок — наше добавление, нет ни у кого из троих
  debt_limit    numeric(14,2),                   -- «Азамату больше 50 000 не давать»
  debt_days     integer,                         -- «обещал вернуть за неделю»
  allow_credit  boolean NOT NULL DEFAULT true,

  comment       text,                            -- комментарий в карточке (UMAG)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,                     -- «Архивные клиенты» (Wipon)
  deleted_at    timestamptz,                     -- «Показать удалённых» (UMAG): в базе остаются
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON counterparty(account_id) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX ON counterparty(account_id, phone);
CREATE UNIQUE INDEX cp_iin_uniq ON counterparty(account_id, iin_bin) WHERE iin_bin IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cp_name_search ON counterparty USING gin (to_tsvector('simple', name));

-- =====================================================================
-- ДВИЖЕНИЕ БАЛАНСА — ИСТОЧНИК ПРАВДЫ ПО ДОЛГУ.
-- Знак: «+» — контрагент должен нам, «−» — мы должны ему.
-- Ничего не перезаписывается, только складывается.
-- =====================================================================
CREATE TABLE balance_move (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparty(id) ON DELETE CASCADE,
  amount          numeric(14,2) NOT NULL,
  reason          balance_reason NOT NULL,
  sale_id         uuid REFERENCES sale(id) ON DELETE SET NULL,
  doc_id          uuid REFERENCES stock_doc(id) ON DELETE SET NULL,
  payment_method  pay_method,                    -- чем гасили (Wipon: «тип оплаты погашения»)
  shift_id        uuid REFERENCES shift(id),
  employee_id     uuid REFERENCES employee(id),
  comment         text,
  due_at          timestamptz,                   -- когда обещал вернуть
  ts              timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT balance_not_zero CHECK (amount <> 0)
);
CREATE INDEX ON balance_move(account_id, counterparty_id, ts);
CREATE INDEX ON balance_move(sale_id);

-- материализованный баланс: карточка должна открываться мгновенно,
-- но истина — в движениях, и баланс всегда пересобирается
CREATE TABLE counterparty_balance (
  counterparty_id uuid PRIMARY KEY REFERENCES counterparty(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  balance         numeric(14,2) NOT NULL DEFAULT 0,   -- + должен нам, − мы должны
  last_move_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON counterparty_balance(account_id) WHERE balance <> 0;

-- =====================================================================
-- ЗАКАЗ ПОСТАВЩИКУ (модель МС, упрощённая до цикла магазина у дома).
-- Правило МС дословно: «Заказы поставщикам не меняют количество товара
-- на складе» — количество меняет только приёмка.
-- =====================================================================
CREATE TYPE po_status AS ENUM ('draft','sent','received','cancelled');

CREATE TABLE purchase_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  number          integer NOT NULL,
  status          po_status NOT NULL DEFAULT 'draft',
  counterparty_id uuid REFERENCES counterparty(id),
  warehouse_id    uuid REFERENCES warehouse(id),
  employee_id     uuid REFERENCES employee(id),
  total_sum       numeric(14,2) NOT NULL DEFAULT 0,
  comment         text,
  expected_at     timestamptz,                   -- когда обещали привезти
  sent_at         timestamptz,
  received_doc_id uuid REFERENCES stock_doc(id), -- приёмка, созданная из заказа
  created_from    text,                          -- 'replenishment' — из плана пополнения (3.7)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX po_number_uniq ON purchase_order(account_id, number) WHERE deleted_at IS NULL;
CREATE INDEX ON purchase_order(account_id, status, created_at DESC);

CREATE TABLE purchase_order_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id),
  package_id    uuid REFERENCES package(id),     -- заказываем блоками, а не пачками
  qty           numeric(14,3) NOT NULL,
  price         numeric(14,2),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (order_id, product_id)
);
CREATE INDEX ON purchase_order_item(order_id);

-- связи-заготовки из прошлых частей получают хозяина
ALTER TABLE sale ADD CONSTRAINT sale_customer_fk FOREIGN KEY (customer_id) REFERENCES counterparty(id);
ALTER TABLE stock_doc ADD CONSTRAINT doc_supplier_fk FOREIGN KEY (supplier_id) REFERENCES counterparty(id);
ALTER TABLE product ADD CONSTRAINT product_supplier_fk FOREIGN KEY (supplier_id) REFERENCES counterparty(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['counterparty','balance_move','counterparty_balance','purchase_order','purchase_order_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER cp_touch BEFORE UPDATE ON counterparty FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER po_touch BEFORE UPDATE ON purchase_order FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПРИМЕНЕНИЕ ДВИЖЕНИЯ БАЛАНСА.
-- Как apply_stock_move для склада: только «+» и «−», никаких перезаписей.
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_balance_move(
  p_account uuid, p_cp uuid, p_amount numeric, p_reason balance_reason,
  p_sale uuid DEFAULT NULL, p_doc uuid DEFAULT NULL, p_method pay_method DEFAULT NULL,
  p_employee uuid DEFAULT NULL, p_shift uuid DEFAULT NULL, p_comment text DEFAULT NULL,
  p_due timestamptz DEFAULT NULL)
RETURNS TABLE (move_id uuid, new_balance numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_move uuid; v_bal numeric;
BEGIN
  INSERT INTO balance_move (account_id, counterparty_id, amount, reason, sale_id, doc_id,
                            payment_method, employee_id, shift_id, comment, due_at)
  VALUES (p_account, p_cp, p_amount, p_reason, p_sale, p_doc, p_method, p_employee, p_shift, p_comment, p_due)
  RETURNING id INTO v_move;

  INSERT INTO counterparty_balance (counterparty_id, account_id, balance, last_move_at)
  VALUES (p_cp, p_account, p_amount, now())
  ON CONFLICT (counterparty_id) DO UPDATE
    SET balance = counterparty_balance.balance + p_amount,
        last_move_at = now(), updated_at = now()
  RETURNING balance INTO v_bal;

  RETURN QUERY SELECT v_move, v_bal;
END $$;
GRANT EXECUTE ON FUNCTION apply_balance_move(uuid,uuid,numeric,balance_reason,uuid,uuid,pay_method,uuid,uuid,text,timestamptz) TO shop_app;

-- Пересборка баланса из движений — как recalc_stock для склада
CREATE OR REPLACE FUNCTION recalc_balance(p_account uuid, p_cp uuid DEFAULT NULL)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH sums AS (
    SELECT counterparty_id, sum(amount) AS s, max(ts) AS last_ts
      FROM balance_move
     WHERE account_id = p_account AND (p_cp IS NULL OR counterparty_id = p_cp)
     GROUP BY counterparty_id
  )
  UPDATE counterparty_balance b SET balance = sums.s, last_move_at = sums.last_ts, updated_at = now()
    FROM sums WHERE b.counterparty_id = sums.counterparty_id AND b.balance IS DISTINCT FROM sums.s;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION recalc_balance(uuid,uuid) TO shop_app;

-- =====================================================================
-- ПРОВЕРКА ЛИМИТА ДОЛГА — наше добавление.
-- «Азамату больше 50 000 не давать» сейчас живёт в голове у хозяина и не
-- живёт в голове у сменщицы. Чистая функция: касса считает это офлайн.
-- =====================================================================
CREATE OR REPLACE FUNCTION check_debt_limit(p_account uuid, p_cp uuid, p_amount numeric)
RETURNS TABLE (allowed boolean, current_debt numeric, debt_limit numeric, over_by numeric, reason text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql STABLE AS $$
DECLARE cp record; bal numeric;
BEGIN
  SELECT * INTO cp FROM counterparty WHERE id = p_cp AND account_id = p_account AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::numeric, 0::numeric, 'Покупатель не найден'::text; RETURN;
  END IF;
  IF NOT cp.allow_credit THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::numeric, 0::numeric,
                        format('«%s»: продажа в долг запрещена', cp.name); RETURN;
  END IF;

  SELECT coalesce(balance, 0) INTO bal FROM counterparty_balance WHERE counterparty_id = p_cp;
  bal := coalesce(bal, 0);

  IF cp.debt_limit IS NULL THEN
    RETURN QUERY SELECT true, bal, NULL::numeric, 0::numeric, NULL::text; RETURN;
  END IF;

  IF bal + p_amount > cp.debt_limit THEN
    RETURN QUERY SELECT false, bal, cp.debt_limit, (bal + p_amount - cp.debt_limit),
      format('«%s»: долг станет %s ₸ при лимите %s ₸ — нужно разрешение старшего',
             cp.name, round(bal + p_amount), round(cp.debt_limit));
  ELSE
    RETURN QUERY SELECT true, bal, cp.debt_limit, 0::numeric, NULL::text;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION check_debt_limit(uuid,uuid,numeric) TO shop_app;

-- =====================================================================
-- ДОЛГОВАЯ КНИГА (модель Wipon debtbook: имя, ИИН/БИН, телефон, сумма
-- погашения, тип оплаты, дата, остаток долга).
-- Wipon показывает общую задолженность всех клиентов — берём.
-- =====================================================================
CREATE OR REPLACE FUNCTION debt_book(p_account uuid, p_overdue_only boolean DEFAULT false)
RETURNS TABLE (counterparty_id uuid, name text, iin_bin text, phone text, debt numeric,
               debt_limit numeric, last_payment_at timestamptz, oldest_debt_at timestamptz,
               due_at timestamptz, days_overdue integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, c.iin_bin, c.phone, b.balance, c.debt_limit,
         (SELECT max(ts) FROM balance_move m WHERE m.counterparty_id = c.id AND m.reason = 'debt_payment'),
         (SELECT min(ts) FROM balance_move m WHERE m.counterparty_id = c.id AND m.reason = 'sale_credit'),
         (SELECT min(due_at) FROM balance_move m WHERE m.counterparty_id = c.id AND m.due_at IS NOT NULL),
         GREATEST(0, (extract(epoch FROM (now() - (SELECT min(due_at) FROM balance_move m
            WHERE m.counterparty_id = c.id AND m.due_at IS NOT NULL))) / 86400)::integer)
    FROM counterparty c
    JOIN counterparty_balance b ON b.counterparty_id = c.id
   WHERE c.account_id = p_account AND b.balance > 0 AND c.deleted_at IS NULL
     AND (NOT p_overdue_only OR EXISTS (
            SELECT 1 FROM balance_move m WHERE m.counterparty_id = c.id
             AND m.due_at IS NOT NULL AND m.due_at < now()))
   ORDER BY b.balance DESC;
$$;
GRANT EXECUTE ON FUNCTION debt_book(uuid,boolean) TO shop_app;

-- =====================================================================
-- АКТ СВЕРКИ (модель МС): остаток на начало, документы за период, итог.
-- =====================================================================
CREATE OR REPLACE FUNCTION reconciliation_act(p_account uuid, p_cp uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ts timestamptz, reason balance_reason, doc_ref text, debit numeric, credit numeric,
               running numeric, comment text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH opening AS (
    SELECT coalesce(sum(amount), 0) AS bal FROM balance_move
     WHERE account_id = p_account AND counterparty_id = p_cp AND ts < p_from
  ),
  moves AS (
    SELECT m.ts, m.reason, m.comment, m.amount,
           coalesce('Чек №' || s.number::text, 'Документ №' || d.number::text, '') AS doc_ref
      FROM balance_move m
      LEFT JOIN sale s ON s.id = m.sale_id
      LEFT JOIN stock_doc d ON d.id = m.doc_id
     WHERE m.account_id = p_account AND m.counterparty_id = p_cp
       AND m.ts >= p_from AND m.ts <= p_to
  )
  SELECT p_from, 'adjustment'::balance_reason, 'Остаток на начало периода'::text,
         NULL::numeric, NULL::numeric, (SELECT bal FROM opening), NULL::text
  UNION ALL
  SELECT m.ts, m.reason, m.doc_ref,
         CASE WHEN m.amount > 0 THEN m.amount END,
         CASE WHEN m.amount < 0 THEN -m.amount END,
         (SELECT bal FROM opening) + sum(m.amount) OVER (ORDER BY m.ts, m.doc_ref),
         m.comment
    FROM moves m
   ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION reconciliation_act(uuid,uuid,timestamptz,timestamptz) TO shop_app;

CREATE OR REPLACE FUNCTION next_po_number(p_account uuid)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(max(number), 0) + 1 FROM purchase_order WHERE account_id = p_account;
$$;
GRANT EXECUTE ON FUNCTION next_po_number(uuid) TO shop_app;

-- =====================================================================
-- ИСПРАВЛЕНИЕ ЧАСТИ 5, найденное при анализе Части 6.
--
-- МойСклад, «Продажа в долг (Казахстан, Узбекистан)»: «Все операции в долг
-- не фискализируются». Это логика закона: фискальный чек пробивается на
-- ПРИХОД ДЕНЕГ. Отдали товар в долг — денег не поступило, пробивать нечего.
-- Пришёл должник с деньгами — вот тогда фискальный чек.
--
-- Было: в режиме «фискализировать все» чек, оплаченный только в долг,
-- уходил оператору. Проверка на живой базе это подтвердила.
-- =====================================================================
CREATE OR REPLACE FUNCTION needs_fiscal(p_mode fiscal_mode, p_cash numeric, p_card numeric,
                                        p_allow_cashless boolean DEFAULT true, p_allow_cash boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_mode = 'off' THEN RETURN false; END IF;

  -- Денег не поступило вовсе (продажа целиком в долг) — фискализировать нечего.
  -- Фискальный чек будет при погашении долга.
  IF coalesce(p_cash, 0) = 0 AND coalesce(p_card, 0) = 0 THEN RETURN false; END IF;

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
