-- =====================================================================
-- 013_pos.sql — КАССА
-- Решения: docs/4_Решения_касса.md
-- Главное: чек считается на кассе целиком (включая себестоимость),
-- сервер принимает факт. После суток офлайна пересчёт на сервере дал бы
-- другие цифры — покупатель платил по цене, которая была на кассе.
-- =====================================================================
CREATE TYPE shift_status AS ENUM ('open','closed');
CREATE TYPE sale_status AS ENUM ('draft','parked','completed','returned','cancelled');
CREATE TYPE pay_method AS ENUM ('cash','card','qr','credit','bonus','mixed');
CREATE TYPE cash_op_kind AS ENUM ('deposit','withdrawal','opening_float','collection');
CREATE TYPE round_mode AS ENUM ('none','total','line_and_total');   -- два типа Wipon

-- =====================================================================
-- СМЕНА. У Wipon их три (ККМ, программа, терминал) — у нас смена кассы
-- и смена ККМ (Часть 5) разные, но закрываются одной кнопкой.
-- =====================================================================
CREATE TABLE shift (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  cash_register_id uuid NOT NULL REFERENCES cash_register(id),
  store_id        uuid REFERENCES store(id),
  number          integer NOT NULL,
  status          shift_status NOT NULL DEFAULT 'open',
  opened_by       uuid REFERENCES employee(id),
  closed_by       uuid REFERENCES employee(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  opening_float   numeric(14,2) NOT NULL DEFAULT 0,      -- размен утром
  -- итоги (считает касса, сервер принимает)
  cash_sales      numeric(14,2) NOT NULL DEFAULT 0,
  card_sales      numeric(14,2) NOT NULL DEFAULT 0,
  qr_sales        numeric(14,2) NOT NULL DEFAULT 0,
  credit_sales    numeric(14,2) NOT NULL DEFAULT 0,
  returns_sum     numeric(14,2) NOT NULL DEFAULT 0,
  deposits        numeric(14,2) NOT NULL DEFAULT 0,
  withdrawals     numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash   numeric(14,2),                          -- сколько должно быть
  actual_cash     numeric(14,2),                          -- сколько насчитал кассир
  discrepancy     numeric(14,2),                          -- расхождение
  discrepancy_comment text,                               -- наше: объясни расхождение
  receipts_count  integer NOT NULL DEFAULT 0,
  offline_opened  boolean NOT NULL DEFAULT false,
  device_id       uuid REFERENCES device(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX shift_number_uniq ON shift(account_id, cash_register_id, number);
CREATE UNIQUE INDEX shift_one_open ON shift(cash_register_id) WHERE status = 'open';
CREATE INDEX ON shift(account_id, opened_at DESC);

-- =====================================================================
-- ЧЕК
-- =====================================================================
CREATE TABLE sale (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  shift_id        uuid REFERENCES shift(id),
  cash_register_id uuid REFERENCES cash_register(id),
  store_id        uuid REFERENCES store(id),
  warehouse_id    uuid REFERENCES warehouse(id),
  number          integer,                                -- сквозной номер чека
  local_number    text,                                   -- номер на кассе: вечный, а не «в рамках сессии» как у Wipon
  status          sale_status NOT NULL DEFAULT 'draft',

  employee_id     uuid REFERENCES employee(id),           -- кассир
  consultant_id   uuid REFERENCES consultant(id),         -- продавец (модель UMAG)
  customer_id     uuid,                                   -- покупатель (Часть 6)

  subtotal        numeric(14,2) NOT NULL DEFAULT 0,       -- до скидок
  discount_sum    numeric(14,2) NOT NULL DEFAULT 0,
  rounding        numeric(14,2) NOT NULL DEFAULT 0,       -- поправка округления (Wipon)
  total           numeric(14,2) NOT NULL DEFAULT 0,
  cost_total      numeric(14,2) NOT NULL DEFAULT 0,       -- себестоимость: считает касса
  profit          numeric(14,2) NOT NULL DEFAULT 0,

  paid_cash       numeric(14,2) NOT NULL DEFAULT 0,
  paid_card       numeric(14,2) NOT NULL DEFAULT 0,
  paid_qr         numeric(14,2) NOT NULL DEFAULT 0,
  paid_credit     numeric(14,2) NOT NULL DEFAULT 0,
  change_given    numeric(14,2) NOT NULL DEFAULT 0,

  return_of_id    uuid REFERENCES sale(id),               -- для возврата: какой чек возвращаем
  parked_at       timestamptz,                            -- отложен (модель МС)
  comment         text,
  offline_created boolean NOT NULL DEFAULT false,
  device_id       uuid REFERENCES device(id),
  fiscal_id       text,                                   -- фискальный признак (Часть 5)
  fiscal_at       timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON sale(account_id, completed_at DESC);
CREATE INDEX ON sale(shift_id);
CREATE INDEX ON sale(account_id, status) WHERE status = 'parked';
CREATE UNIQUE INDEX sale_number_uniq ON sale(account_id, cash_register_id, number) WHERE number IS NOT NULL;

CREATE TABLE sale_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  sale_id         uuid NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES product(id),
  package_id      uuid REFERENCES package(id),
  qty             numeric(14,3) NOT NULL,
  price           numeric(14,2) NOT NULL,                 -- цена на момент продажи
  discount_percent numeric(6,2) NOT NULL DEFAULT 0,
  discount_sum    numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL,
  cost            numeric(14,4) NOT NULL DEFAULT 0,       -- себестоимость единицы
  vat_rate        numeric(5,2),
  ntin            text,                                   -- уезжает в фискальный чек
  returned_qty    numeric(14,3) NOT NULL DEFAULT 0,       -- сколько уже вернули (частичный возврат)
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT item_qty_not_zero CHECK (qty <> 0)
);
CREATE INDEX ON sale_item(sale_id);
CREATE INDEX ON sale_item(account_id, product_id);

CREATE TABLE sale_payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  sale_id       uuid NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  method        pay_method NOT NULL,
  amount        numeric(14,2) NOT NULL,
  received      numeric(14,2),                            -- сколько дал покупатель (наличные)
  change_given  numeric(14,2),
  terminal_ref  text,                                     -- ссылка на операцию терминала/QR
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sale_payment(sale_id);

-- =====================================================================
-- ОТМЕНЁННЫЕ ТОВАРЫ — контроль UMAG.
-- Кассир пробил товар, покупатель дал наличные, кассир отменил позицию и
-- забрал деньги. Без этого журнала такое невидимо.
-- Формат количества UMAG: «100→98» — добавили 100, отменили 98.
-- =====================================================================
CREATE TABLE cancelled_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  sale_id         uuid REFERENCES sale(id) ON DELETE SET NULL,
  cash_register_id uuid REFERENCES cash_register(id),
  shift_id        uuid REFERENCES shift(id),
  employee_id     uuid REFERENCES employee(id),
  product_id      uuid NOT NULL REFERENCES product(id),
  qty_added       numeric(14,3) NOT NULL,                 -- было добавлено
  qty_cancelled   numeric(14,3) NOT NULL,                 -- отменено
  price           numeric(14,2),
  approved_by     uuid REFERENCES employee(id),           -- кто разрешил (наше добавление)
  cancelled_at    timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON cancelled_item(account_id, cancelled_at DESC);
CREATE INDEX ON cancelled_item(account_id, employee_id);

-- =====================================================================
-- ДЕНЬГИ В КАССЕ: внесение и изъятие
-- =====================================================================
CREATE TABLE cash_operation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  shift_id      uuid NOT NULL REFERENCES shift(id) ON DELETE CASCADE,
  cash_register_id uuid REFERENCES cash_register(id),
  kind          cash_op_kind NOT NULL,
  amount        numeric(14,2) NOT NULL,
  comment       text,
  employee_id   uuid REFERENCES employee(id),
  approved_by   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT cash_amount_positive CHECK (amount > 0)
);
CREATE INDEX ON cash_operation(shift_id);

-- =====================================================================
-- СКИДКИ (модель Wipon: товар/чек, %/сумма, авто/ручная)
-- =====================================================================
CREATE TABLE discount (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  percent       numeric(6,2),
  amount        numeric(14,2),
  scope         text NOT NULL DEFAULT 'receipt',          -- receipt / product / category
  product_id    uuid REFERENCES product(id),
  category_id   uuid REFERENCES category(id),
  auto_apply    boolean NOT NULL DEFAULT false,           -- подтягивается сама (Wipon)
  min_sum       numeric(14,2),                            -- порог чека
  starts_at     timestamptz,
  ends_at       timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT discount_has_value CHECK (percent IS NOT NULL OR amount IS NOT NULL)
);
CREATE INDEX ON discount(account_id) WHERE is_active;

-- =====================================================================
-- НАСТРОЙКИ КАССЫ: округление (модель Wipon)
-- =====================================================================
ALTER TABLE pos_profile ADD COLUMN IF NOT EXISTS round_mode round_mode NOT NULL DEFAULT 'total';
ALTER TABLE pos_profile ADD COLUMN IF NOT EXISTS round_to numeric(6,2) NOT NULL DEFAULT 1;
ALTER TABLE pos_profile ADD COLUMN IF NOT EXISTS max_manual_discount numeric(6,2) NOT NULL DEFAULT 10;
ALTER TABLE pos_profile ADD COLUMN IF NOT EXISTS max_parked_sales integer NOT NULL DEFAULT 100;
COMMENT ON COLUMN pos_profile.round_to IS 'До скольки тенге округлять: 1 или 5 (в КЗ мелочь вышла из обихода)';
COMMENT ON COLUMN pos_profile.max_parked_sales IS 'Лимит отложенных чеков — как у МС (100)';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift','sale','sale_item','sale_payment','cancelled_item','cash_operation','discount']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER shift_touch BEFORE UPDATE ON shift FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER sale_touch BEFORE UPDATE ON sale FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ОКРУГЛЕНИЕ (модель Wipon). При продаже — в пользу покупателя (вниз):
-- копейки магазину не важны, а спор у кассы стоит дороже.
-- =====================================================================
CREATE OR REPLACE FUNCTION round_money(p_value numeric, p_to numeric, p_down boolean DEFAULT true)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_to IS NULL OR p_to <= 0 THEN round(p_value, 2)
    WHEN p_down THEN floor(p_value / p_to) * p_to
    ELSE round(p_value / p_to) * p_to
  END;
$$;

-- =====================================================================
-- НОМЕР СМЕНЫ И ЧЕКА
-- =====================================================================
CREATE OR REPLACE FUNCTION next_shift_number(p_account uuid, p_register uuid)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(max(number), 0) + 1 FROM shift WHERE account_id = p_account AND cash_register_id = p_register;
$$;
GRANT EXECUTE ON FUNCTION next_shift_number(uuid,uuid) TO shop_app;

CREATE OR REPLACE FUNCTION next_sale_number(p_account uuid, p_register uuid)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(max(number), 0) + 1 FROM sale WHERE account_id = p_account AND cash_register_id = p_register;
$$;
GRANT EXECUTE ON FUNCTION next_sale_number(uuid,uuid) TO shop_app;

-- =====================================================================
-- ИТОГИ СМЕНЫ: X-отчёт (без закрытия) и основа Z-отчёта.
-- =====================================================================
CREATE OR REPLACE FUNCTION shift_totals(p_account uuid, p_shift uuid)
RETURNS TABLE (receipts integer, cash numeric, card numeric, qr numeric, credit numeric,
               returns_sum numeric, deposits numeric, withdrawals numeric,
               opening_float numeric, expected_cash numeric, revenue numeric, profit numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM shift WHERE id = p_shift AND account_id = p_account),
  sales AS (
    SELECT count(*)::integer AS n,
           coalesce(sum(paid_cash), 0) AS cash, coalesce(sum(paid_card), 0) AS card,
           coalesce(sum(paid_qr), 0) AS qr, coalesce(sum(paid_credit), 0) AS credit,
           coalesce(sum(total), 0) AS revenue, coalesce(sum(profit), 0) AS profit
      FROM sale WHERE shift_id = p_shift AND status = 'completed' AND return_of_id IS NULL
  ),
  rets AS (
    SELECT coalesce(sum(total), 0) AS ret, coalesce(sum(paid_cash), 0) AS ret_cash
      FROM sale WHERE shift_id = p_shift AND return_of_id IS NOT NULL AND status = 'completed'
  ),
  ops AS (
    SELECT coalesce(sum(amount) FILTER (WHERE kind IN ('deposit','opening_float')), 0) AS dep,
           coalesce(sum(amount) FILTER (WHERE kind IN ('withdrawal','collection')), 0) AS wdr
      FROM cash_operation WHERE shift_id = p_shift
  )
  SELECT sales.n, sales.cash, sales.card, sales.qr, sales.credit,
         rets.ret, ops.dep, ops.wdr, s.opening_float,
         -- в кассе должно быть: размен + наличные продажи + внесения − изъятия − возвраты наличными
         s.opening_float + sales.cash + ops.dep - ops.wdr - rets.ret_cash,
         sales.revenue, sales.profit
    FROM s, sales, rets, ops;
$$;
GRANT EXECUTE ON FUNCTION shift_totals(uuid,uuid) TO shop_app;
