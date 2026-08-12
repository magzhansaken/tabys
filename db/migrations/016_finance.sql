-- =====================================================================
-- 016_finance.sql — ФИНАНСЫ
-- Решения: docs/7_Решения_финансы.md
--
-- Деньги — сумма движений, а не поле с балансом. Третий раз тот же принцип:
-- остатки (1.3), долги (Часть 6), теперь деньги.
--
-- Инкассация — ПЕРЕВОД между счетами, а не расход. UMAG в «Прибылях и
-- убытках» относит её к операционным расходам — это искажает отчёт: чем чаще
-- владелец возит выручку в банк, тем «убыточнее» выглядит магазин.
-- =====================================================================
CREATE TYPE fin_account_kind AS ENUM ('cash','bank','ewallet');
CREATE TYPE fin_direction AS ENUM ('in','out');
CREATE TYPE fin_move_kind AS ENUM (
  'sale',              -- выручка с продажи
  'refund',            -- возврат покупателю
  'debt_payment',      -- должник вернул деньги
  'supply_payment',    -- заплатили поставщику
  'transfer_in',       -- перевод между своими счетами (приход)
  'transfer_out',      -- перевод между своими счетами (расход)
  'income',            -- прочий доход по статье
  'expense',           -- расход по статье
  'acquiring_fee',     -- комиссия банка за приём карты
  'owner_draw',        -- изъятие собственника: НЕ расход бизнеса
  'owner_deposit',     -- вложение собственника
  'correction'         -- корректировка с комментарием
);

-- =====================================================================
-- СЧЁТ. Wipon держит «Банковские счета» и «Кассы» в разных разделах, но это
-- одно и то же: место, где лежат деньги. Реквизиты КЗ — у Wipon дословно:
-- ИИК, БИК, КБЕ.
-- =====================================================================
CREATE TABLE fin_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          fin_account_kind NOT NULL DEFAULT 'cash',
  name          text NOT NULL,
  store_id      uuid REFERENCES store(id),        -- «1 Касса — 1 Склад» (Wipon)
  cash_register_id uuid REFERENCES cash_register(id),
  -- реквизиты банка (Wipon: наименование банка, ИИК, КБЕ, БИК)
  bank_name     text,
  iik           text,                             -- индивидуальный идентификационный код
  bik           text,                             -- банковский идентификационный код
  kbe           text,                             -- код бенефициара
  is_default    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON fin_account(account_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX fin_account_default_uniq ON fin_account(account_id, kind) WHERE is_default AND deleted_at IS NULL;

-- =====================================================================
-- СПОСОБ ОПЛАТЫ → СЧЁТ (модель Wipon: «при создании метода оплаты вы
-- выбираете банковский счёт для зачисления»).
-- Плюс комиссия эквайринга, которой нет ни у кого из троих: пробили 10 000
-- картой, банк удержал 2% — на счёт пришло 9800. Это прямой минус из прибыли.
-- =====================================================================
CREATE TABLE payment_method_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  method        pay_method NOT NULL,
  store_id      uuid REFERENCES store(id),
  fin_account_id uuid NOT NULL REFERENCES fin_account(id),
  acquiring_percent numeric(6,3) NOT NULL DEFAULT 0,   -- комиссия банка, %
  acquiring_fixed   numeric(10,2) NOT NULL DEFAULT 0,  -- фиксированная часть
  settlement_days integer NOT NULL DEFAULT 1,          -- через сколько дней банк зачислит
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, method, store_id)
);

-- =====================================================================
-- СТАТЬИ ДОХОДОВ И РАСХОДОВ.
-- Wipon: «Категории денежных движений» — отдельно категории внесений и
-- изъятий. У МоегоСклада статья «Статьи расходов» — «в разработке».
-- =====================================================================
CREATE TABLE fin_category (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  direction     fin_direction NOT NULL,
  name          text NOT NULL,
  code          text,
  -- операционная статья входит в «Операционные расходы» отчёта П&У.
  -- Инкассация и изъятия собственника — НЕ операционные (ошибка UMAG).
  is_operating  boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (account_id, direction, name)
);
CREATE INDEX ON fin_category(account_id, direction) WHERE deleted_at IS NULL;

-- =====================================================================
-- ДВИЖЕНИЕ ДЕНЕГ — ИСТОЧНИК ПРАВДЫ.
-- Знак: «+» приход, «−» расход. Ничего не перезаписывается.
-- =====================================================================
CREATE TABLE fin_move (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  fin_account_id  uuid NOT NULL REFERENCES fin_account(id) ON DELETE CASCADE,
  amount          numeric(14,2) NOT NULL,
  kind            fin_move_kind NOT NULL,
  category_id     uuid REFERENCES fin_category(id),
  counterparty_id uuid REFERENCES counterparty(id),
  sale_id         uuid REFERENCES sale(id) ON DELETE SET NULL,
  doc_id          uuid REFERENCES stock_doc(id) ON DELETE SET NULL,
  shift_id        uuid REFERENCES shift(id),
  transfer_id     uuid,                            -- две половинки перевода
  employee_id     uuid REFERENCES employee(id),
  comment         text,
  ts              timestamptz NOT NULL DEFAULT now(),   -- когда прошли деньги
  -- дата начисления (модель МС): «оплатили аренду за апрель в марте» →
  -- расход относится к апрелю. У МоегоСклада это платная опция; у нас нет.
  accrual_date    date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT fin_amount_not_zero CHECK (amount <> 0)
);
CREATE INDEX ON fin_move(account_id, ts);
CREATE INDEX ON fin_move(fin_account_id, ts);
CREATE INDEX ON fin_move(account_id, kind, ts);
CREATE INDEX ON fin_move(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX ON fin_move(account_id, accrual_date) WHERE accrual_date IS NOT NULL;

CREATE TABLE fin_balance (
  fin_account_id uuid PRIMARY KEY REFERENCES fin_account(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  balance        numeric(14,2) NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fin_balance(account_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_account','payment_method_account','fin_category','fin_move','fin_balance']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER fin_account_touch BEFORE UPDATE ON fin_account FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПРИМЕНЕНИЕ ДВИЖЕНИЯ (как apply_stock_move и apply_balance_move)
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_fin_move(
  p_account uuid, p_fin_account uuid, p_amount numeric, p_kind fin_move_kind,
  p_category uuid DEFAULT NULL, p_counterparty uuid DEFAULT NULL, p_sale uuid DEFAULT NULL,
  p_doc uuid DEFAULT NULL, p_shift uuid DEFAULT NULL, p_employee uuid DEFAULT NULL,
  p_comment text DEFAULT NULL, p_transfer uuid DEFAULT NULL, p_accrual date DEFAULT NULL,
  p_ts timestamptz DEFAULT NULL)
RETURNS TABLE (move_id uuid, new_balance numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_move uuid; v_bal numeric;
BEGIN
  INSERT INTO fin_move (account_id, fin_account_id, amount, kind, category_id, counterparty_id,
                        sale_id, doc_id, shift_id, employee_id, comment, transfer_id, accrual_date, ts)
  VALUES (p_account, p_fin_account, p_amount, p_kind, p_category, p_counterparty,
          p_sale, p_doc, p_shift, p_employee, p_comment, p_transfer, p_accrual, coalesce(p_ts, now()))
  RETURNING id INTO v_move;

  INSERT INTO fin_balance (fin_account_id, account_id, balance)
  VALUES (p_fin_account, p_account, p_amount)
  ON CONFLICT (fin_account_id) DO UPDATE
    SET balance = fin_balance.balance + p_amount, updated_at = now()
  RETURNING balance INTO v_bal;

  RETURN QUERY SELECT v_move, v_bal;
END $$;
GRANT EXECUTE ON FUNCTION apply_fin_move(uuid,uuid,numeric,fin_move_kind,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,date,timestamptz) TO shop_app;

CREATE OR REPLACE FUNCTION recalc_fin_balance(p_account uuid, p_fin_account uuid DEFAULT NULL)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH sums AS (
    SELECT m.fin_account_id, sum(m.amount) + max(a.opening_balance) AS s
      FROM fin_move m JOIN fin_account a ON a.id = m.fin_account_id
     WHERE m.account_id = p_account AND (p_fin_account IS NULL OR m.fin_account_id = p_fin_account)
     GROUP BY m.fin_account_id
  )
  UPDATE fin_balance b SET balance = sums.s, updated_at = now()
    FROM sums WHERE b.fin_account_id = sums.fin_account_id AND b.balance IS DISTINCT FROM sums.s;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION recalc_fin_balance(uuid,uuid) TO shop_app;

-- =====================================================================
-- ОТЧЁТ ДДС (движение денежных средств).
-- У UMAG три колонки: Закупы / Расходы / Вложения — этого мало, чтобы
-- понять, куда делись деньги. Даём поступления и выплаты по статьям.
-- =====================================================================
CREATE OR REPLACE FUNCTION cash_flow(p_account uuid, p_from timestamptz, p_to timestamptz,
                                     p_fin_account uuid DEFAULT NULL)
RETURNS TABLE (direction fin_direction, kind fin_move_kind, category text, amount numeric, ops integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN sum(m.amount) >= 0 THEN 'in' ELSE 'out' END::fin_direction,
         m.kind,
         coalesce(c.name, CASE m.kind
           WHEN 'sale' THEN 'Выручка'
           WHEN 'refund' THEN 'Возвраты покупателям'
           WHEN 'debt_payment' THEN 'Погашение долгов покупателями'
           WHEN 'supply_payment' THEN 'Оплата поставщикам'
           WHEN 'acquiring_fee' THEN 'Комиссия банка (эквайринг)'
           WHEN 'owner_draw' THEN 'Изъятие собственника'
           WHEN 'owner_deposit' THEN 'Вложение собственника'
           WHEN 'transfer_in' THEN 'Переводы между счетами (приход)'
           WHEN 'transfer_out' THEN 'Переводы между счетами (расход)'
           ELSE 'Прочее' END),
         sum(m.amount), count(*)::integer
    FROM fin_move m
    LEFT JOIN fin_category c ON c.id = m.category_id
   WHERE m.account_id = p_account AND m.ts >= p_from AND m.ts <= p_to
     AND (p_fin_account IS NULL OR m.fin_account_id = p_fin_account)
   GROUP BY m.kind, c.name
   ORDER BY 1, 4 DESC;
$$;
GRANT EXECUTE ON FUNCTION cash_flow(uuid,timestamptz,timestamptz,uuid) TO shop_app;

-- =====================================================================
-- ОТЧЁТ «ПРИБЫЛИ И УБЫТКИ» — структура UMAG:
--   Выручка = Продажи − Возврат;  Продажи = Наличные + Безнал + В долг
--   Себестоимость (проданных / возвращённых)
--   Валовая прибыль = Выручка − Себестоимость
--   Операционные расходы
--   Чистая прибыль
--
-- Методология исправлена: инкассация и изъятия собственника в операционные
-- расходы НЕ входят (у UMAG входят — это делает магазин тем «убыточнее»,
-- чем чаще владелец возит выручку в банк).
--
-- Расходы берутся по ДАТЕ НАЧИСЛЕНИЯ (модель МС), если она указана.
-- =====================================================================
CREATE OR REPLACE FUNCTION profit_loss(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  sales_cash numeric, sales_card numeric, sales_qr numeric, sales_credit numeric,
  sales_total numeric, refunds numeric, revenue numeric,
  cost_sold numeric, cost_returned numeric, cost_total numeric,
  gross_profit numeric, opex numeric, acquiring numeric, writeoffs numeric,
  net_profit numeric, margin_percent numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql STABLE AS $$
DECLARE r record; e numeric; a numeric; w numeric;
BEGIN
  SELECT
    coalesce(sum(s.paid_cash) FILTER (WHERE s.return_of_id IS NULL), 0) AS cash,
    coalesce(sum(s.paid_card) FILTER (WHERE s.return_of_id IS NULL), 0) AS card,
    coalesce(sum(s.paid_qr) FILTER (WHERE s.return_of_id IS NULL), 0) AS qr,
    coalesce(sum(s.paid_credit) FILTER (WHERE s.return_of_id IS NULL), 0) AS credit,
    coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0) AS sales,
    coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0) AS rets,
    coalesce(sum(s.cost_total) FILTER (WHERE s.return_of_id IS NULL), 0) AS cost_s,
    coalesce(sum(s.cost_total) FILTER (WHERE s.return_of_id IS NOT NULL), 0) AS cost_r
  INTO r
  FROM sale s
  WHERE s.account_id = p_account AND s.status IN ('completed','returned')
    AND s.completed_at >= p_from AND s.completed_at <= p_to;

  -- операционные расходы: только статьи с is_operating.
  -- Изъятия собственника и переводы сюда не попадают по построению.
  SELECT coalesce(sum(-m.amount), 0) INTO e
    FROM fin_move m LEFT JOIN fin_category c ON c.id = m.category_id
   WHERE m.account_id = p_account AND m.kind = 'expense'
     AND coalesce(c.is_operating, true)
     AND coalesce(m.accrual_date, m.ts::date) >= p_from::date
     AND coalesce(m.accrual_date, m.ts::date) <= p_to::date;

  SELECT coalesce(sum(-m.amount), 0) INTO a
    FROM fin_move m WHERE m.account_id = p_account AND m.kind = 'acquiring_fee'
     AND m.ts >= p_from AND m.ts <= p_to;

  -- списанный товар — тоже потеря денег, хотя и не платёж
  SELECT coalesce(sum(abs(sm.qty) * sm.cost), 0) INTO w
    FROM stock_move sm
   WHERE sm.account_id = p_account AND sm.reason IN ('write_off','inventory_shortage')
     AND sm.ts >= p_from AND sm.ts <= p_to;

  RETURN QUERY SELECT
    r.cash, r.card, r.qr, r.credit, r.sales, r.rets,
    (r.sales - r.rets),                                  -- Выручка (формула UMAG)
    r.cost_s, r.cost_r, (r.cost_s - r.cost_r),
    (r.sales - r.rets) - (r.cost_s - r.cost_r),          -- Валовая прибыль
    e, a, w,
    (r.sales - r.rets) - (r.cost_s - r.cost_r) - e - a - w,   -- Чистая прибыль
    CASE WHEN (r.sales - r.rets) > 0
      THEN round((((r.sales - r.rets) - (r.cost_s - r.cost_r) - e - a - w) / (r.sales - r.rets) * 100)::numeric, 2)
      ELSE 0 END;
END $$;
GRANT EXECUTE ON FUNCTION profit_loss(uuid,timestamptz,timestamptz) TO shop_app;

-- =====================================================================
-- Готовые счета и статьи при регистрации: клиент начинает работать сразу
-- =====================================================================
CREATE OR REPLACE FUNCTION ensure_finance(p_account uuid)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_store uuid; v_cash uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM fin_account WHERE account_id = p_account) THEN RETURN; END IF;
  SELECT id INTO v_store FROM store WHERE account_id = p_account ORDER BY created_at LIMIT 1;

  INSERT INTO fin_account (account_id, kind, name, store_id, is_default)
  VALUES (p_account, 'cash', 'Касса магазина', v_store, true) RETURNING id INTO v_cash;
  INSERT INTO fin_account (account_id, kind, name, is_default)
  VALUES (p_account, 'bank', 'Расчётный счёт', true);
  INSERT INTO fin_balance (fin_account_id, account_id, balance)
    SELECT id, p_account, 0 FROM fin_account WHERE account_id = p_account
    ON CONFLICT DO NOTHING;

  -- наличные попадают в кассу магазина (модель Wipon: способ оплаты знает счёт)
  INSERT INTO payment_method_account (account_id, method, fin_account_id)
  VALUES (p_account, 'cash', v_cash) ON CONFLICT DO NOTHING;

  -- статьи расходов: то, на что реально тратит магазин у дома (список UMAG
  -- из «Операционных расходов», минус инкассация — она не расход)
  INSERT INTO fin_category (account_id, direction, name, is_operating, is_system, sort_order) VALUES
    (p_account, 'out', 'Аренда', true, true, 10),
    (p_account, 'out', 'Зарплата', true, true, 20),
    (p_account, 'out', 'Коммунальные услуги', true, true, 30),
    (p_account, 'out', 'Закуп мелочей', true, true, 40),
    (p_account, 'out', 'Реклама', true, true, 50),
    (p_account, 'out', 'Транспорт', true, true, 60),
    (p_account, 'out', 'Налоги', true, true, 70),
    (p_account, 'out', 'Прочие расходы', true, true, 100),
    (p_account, 'in', 'Прочий доход', true, true, 100)
  ON CONFLICT DO NOTHING;
END $$;
GRANT EXECUTE ON FUNCTION ensure_finance(uuid) TO shop_app;

CREATE OR REPLACE FUNCTION register_account(p_phone text, p_name text, p_owner_name text, p_lang text DEFAULT 'ru')
RETURNS TABLE (account_id uuid, employee_id uuid)
SECURITY DEFINER SET search_path = public AS $$
DECLARE a_id uuid; e_id uuid; s_id uuid; w_id uuid; p_id uuid;
BEGIN
  INSERT INTO account (phone, name, lang) VALUES (p_phone, p_name, p_lang) RETURNING id INTO a_id;
  INSERT INTO pos_profile (account_id, name, is_default) VALUES (a_id, 'Стандартный', true) RETURNING id INTO p_id;
  INSERT INTO store (account_id, name, pos_profile_id) VALUES (a_id, p_name, p_id) RETURNING id INTO s_id;
  INSERT INTO warehouse (account_id, store_id, name, is_primary) VALUES (a_id, s_id, 'Основной склад', true) RETURNING id INTO w_id;
  UPDATE store SET default_warehouse_id = w_id WHERE id = s_id;
  INSERT INTO employee (account_id, role_id, first_name, phone, is_owner, can_login_admin, can_login_pos, position)
  VALUES (a_id, (SELECT id FROM role WHERE code='owner'), p_owner_name, p_phone, true, true, true, 'Владелец')
  RETURNING id INTO e_id;
  INSERT INTO employee_store (employee_id, store_id, account_id) VALUES (e_id, s_id, a_id);
  PERFORM ensure_price_types(a_id);
  PERFORM ensure_label_templates(a_id);
  PERFORM ensure_finance(a_id);
  RETURN QUERY SELECT a_id, e_id;
END $$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION register_account(text,text,text,text) TO shop_app;

DO $$
DECLARE a record;
BEGIN
  FOR a IN SELECT id FROM account LOOP PERFORM ensure_finance(a.id); END LOOP;
END $$;
