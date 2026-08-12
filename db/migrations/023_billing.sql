-- =====================================================================
-- 023_billing.sql — ТАРИФЫ, БИЛЛИНГ, ЭКСПЛУАТАЦИЯ
-- Решения: docs/14_Решения_эксплуатация.md
--
-- UMAG считает по числу касс и берёт 4 600 ₸ за сотрудника. Мы считаем по
-- торговым точкам: безлимит устройств и сотрудников. Цена фиксируется
-- в договоре на 12 месяцев — это ответ на их рост до +570%.
-- =====================================================================
CREATE TYPE sub_status AS ENUM ('trial','active','grace','readonly','frozen','cancelled');

CREATE TABLE tariff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  price_month   numeric(12,2) NOT NULL,
  stores_included integer NOT NULL DEFAULT 1,
  price_extra_store numeric(12,2) NOT NULL DEFAULT 0,
  -- то, за что берут деньги конкуренты, а мы нет
  devices_limit integer,                       -- NULL = безлимит
  employees_limit integer,                     -- NULL = безлимит
  features      jsonb NOT NULL DEFAULT '{}',
  is_public     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  tariff_id     uuid NOT NULL REFERENCES tariff(id),
  status        sub_status NOT NULL DEFAULT 'trial',
  -- ЦЕНА ЗАФИКСИРОВАНА: главный страх переехавшего клиента — что поднимут,
  -- когда уходить поздно. Храним то, о чём договорились.
  price_locked  numeric(12,2) NOT NULL,
  price_locked_until date NOT NULL,
  stores_paid   integer NOT NULL DEFAULT 1,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  paid_until    date,
  grace_until   date,
  frozen_at     timestamptz,
  auto_unfreeze boolean NOT NULL DEFAULT true,  -- механика UMAG
  balance       numeric(12,2) NOT NULL DEFAULT 0,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id)
);

CREATE TABLE billing_move (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL,
  kind          text NOT NULL,                 -- topup / charge / refund / bonus
  comment       text,
  period_from   date,
  period_to     date,
  balance_after numeric(12,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON billing_move(account_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription','billing_move']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
  EXECUTE 'GRANT SELECT ON tariff TO shop_app';
END $$;
CREATE TRIGGER sub_touch BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- Тарифы. Ниже UMAG (Старт 8 800 / Стандарт 19 900) и без платы за
-- устройства и сотрудников.
INSERT INTO tariff (code, name, price_month, stores_included, price_extra_store, devices_limit, employees_limit, features) VALUES
  ('start',    'Старт',    6900,  1, 4900, NULL, NULL,
   '{"pos":true,"stock":true,"reports":true,"loyalty":true,"debts":true,"equipment":true}'),
  ('standard', 'Стандарт', 14900, 1, 4900, NULL, NULL,
   '{"pos":true,"stock":true,"reports":true,"loyalty":true,"debts":true,"equipment":true,"documents":true,"ai":true,"api":true}')
ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- СПИСАНИЕ. При неуплате не рубим кассу: сначала льготные 7 дней, потом
-- только чтение. Остановить торговлю из-за забытого платежа — это выручка
-- магазина за день.
-- =====================================================================
CREATE OR REPLACE FUNCTION billing_charge(p_account uuid)
RETURNS TABLE (charged numeric, new_balance numeric, new_status text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE s record; t record; amount numeric; st sub_status;
BEGIN
  SELECT * INTO s FROM subscription WHERE account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'Подписки нет'; END IF;
  IF s.status = 'frozen' THEN
    RETURN QUERY SELECT 0::numeric, s.balance, s.status::text; RETURN;
  END IF;
  SELECT * INTO t FROM tariff WHERE id = s.tariff_id;

  -- платим по точкам, а не по кассам и не по людям
  amount := s.price_locked + greatest(0, s.stores_paid - t.stores_included) * t.price_extra_store;

  IF s.balance >= amount THEN
    UPDATE subscription SET balance = balance - amount, status = 'active',
           paid_until = coalesce(greatest(paid_until, current_date), current_date) + 30,
           grace_until = NULL
     WHERE account_id = p_account RETURNING balance, status INTO s.balance, st;
    INSERT INTO billing_move (account_id, amount, kind, comment, period_from, period_to, balance_after)
    VALUES (p_account, -amount, 'charge', 'Абонентская плата', current_date, current_date + 30, s.balance);
  ELSE
    -- денег нет: льготный период, потом только чтение
    IF s.grace_until IS NULL THEN
      UPDATE subscription SET status = 'grace', grace_until = current_date + 7
       WHERE account_id = p_account RETURNING status INTO st;
    ELSIF s.grace_until < current_date THEN
      UPDATE subscription SET status = 'readonly' WHERE account_id = p_account RETURNING status INTO st;
    ELSE
      st := s.status;
    END IF;
    amount := 0;
  END IF;

  RETURN QUERY SELECT amount, s.balance, st::text;
END $$;
GRANT EXECUTE ON FUNCTION billing_charge(uuid) TO shop_app;

-- =====================================================================
-- АДМИНКА ПОДДЕРЖКИ: состояние аккаунта одним запросом.
-- Боль UMAG из отзывов — до поддержки не дозвониться. Оператор должен видеть
-- всё сразу, а не выспрашивать по телефону.
-- =====================================================================
CREATE OR REPLACE FUNCTION support_snapshot(p_account uuid)
RETURNS TABLE (account_name text, phone text, came_from text, status text,
               tariff text, paid_until date, balance numeric,
               stores integer, devices integer, employees integer,
               products integer, sales_today integer, revenue_today numeric,
               fiscal_pending integer, devices_offline integer, last_sale_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.name, a.phone, a.came_from, coalesce(s.status::text, 'нет подписки'),
         t.name, s.paid_until, coalesce(s.balance, 0),
         (SELECT count(*)::int FROM store WHERE account_id = p_account AND deleted_at IS NULL),
         (SELECT count(*)::int FROM device WHERE account_id = p_account AND deleted_at IS NULL),
         (SELECT count(*)::int FROM employee WHERE account_id = p_account AND deleted_at IS NULL),
         (SELECT count(*)::int FROM product WHERE account_id = p_account AND archived_at IS NULL),
         (SELECT count(*)::int FROM sale WHERE account_id = p_account AND status='completed'
            AND return_of_id IS NULL AND completed_at::date = current_date),
         (SELECT coalesce(sum(total), 0) FROM sale WHERE account_id = p_account AND status='completed'
            AND return_of_id IS NULL AND completed_at::date = current_date),
         (SELECT count(*)::int FROM fiscal_receipt WHERE account_id = p_account AND status IN ('pending','failed')),
         (SELECT count(*)::int FROM device WHERE account_id = p_account AND deleted_at IS NULL
            AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 minutes')),
         (SELECT max(completed_at) FROM sale WHERE account_id = p_account AND status='completed')
    FROM account a
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.id = p_account;
$$;
GRANT EXECUTE ON FUNCTION support_snapshot(uuid) TO shop_app;

-- Триггер обновления строки из Части 1 проставляет и порядковый номер для
-- синхронизации — без колонки seq он падает.
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS seq bigint NOT NULL DEFAULT nextval('global_seq');
