-- =====================================================================
-- 102_charges.sql — разовые доплаты копятся и платятся разом.
--
-- НАЙДЕНО. Мы показывали «Доплата 1 400 ₸ за остаток периода войдёт в
-- счёт» — и НИКУДА ЕЁ НЕ ЗАПИСЫВАЛИ. Ни строкой счёта, ни оплатой, ни
-- долгом. Слова есть, денег нет.
--
-- Клиент добавил кассу в середине месяца: пообещали доплату, не взяли,
-- следующий счёт вышел обычный. Платформа подарила две недели работы
-- кассы и не заметила.
--
-- ЗАМЫСЕЛ ВЛАДЕЛЬЦА ПЛАТФОРМЫ: клиент не должен платить за каждое
-- устройство порознь. Всё сходится в ОДИН счёт, точный и понятный.
--
-- Поэтому доплата не берётся сразу, а ЛОЖИТСЯ В ОЖИДАНИЕ. Клиент
-- видит: «к оплате 9 900 в месяц + 1 400 разово за остаток периода =
-- 11 300». Платит один раз, а не два.
--
-- Почему отдельной таблицей, а не строкой счёта: строка счёта — это
-- КАЖДЫЙ МЕСЯЦ, а доплата разовая. Смешать их значит брать её вечно.
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenant_charge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title       text NOT NULL,
  amount      bigint NOT NULL,
  -- Когда войдёт в оплату. Пока пусто — ждёт.
  settled_at  timestamptz,
  payment_id  uuid REFERENCES tenant_payment(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES platform_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_charge_waiting
  ON tenant_charge (account_id) WHERE settled_at IS NULL;

COMMENT ON TABLE tenant_charge IS
  'Разовые доплаты: за остаток периода при добавлении устройства. Копятся и входят в один счёт.';

ALTER TABLE tenant_charge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_charge;
CREATE POLICY tenant_isolation ON tenant_charge
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON tenant_charge TO shop_app;

-- =====================================================================
-- Записать доплату. Зовётся при добавлении устройства.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_charge_add(
  p_account uuid, p_title text, p_amount bigint, p_by uuid DEFAULT NULL)
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_amount <= 0 THEN RETURN NULL; END IF;
  INSERT INTO tenant_charge (account_id, title, amount, created_by)
  VALUES (p_account, p_title, p_amount, p_by) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION platform_charge_add(uuid, text, bigint, uuid) TO shop_app;

-- =====================================================================
-- Сколько ждёт доплат и какие. Клиент видит их в своём кабинете,
-- владелец платформы — в карточке.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_charges(p_account uuid)
RETURNS TABLE (id uuid, title text, amount bigint, created_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT c.id, c.title, c.amount, c.created_at
    FROM tenant_charge c
   WHERE c.account_id = p_account AND c.settled_at IS NULL
   ORDER BY c.created_at;
$$;
GRANT EXECUTE ON FUNCTION platform_charges(uuid) TO shop_app;

-- =====================================================================
-- Закрыть доплаты подтверждённой оплатой.
--
-- Зовётся при подтверждении: если клиент заплатил столько, что хватило
-- и на месяц, и на доплаты, — доплаты гасятся. Иначе висят дальше.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_charges_settle(p_account uuid, p_payment uuid)
RETURNS bigint
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_sum bigint;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO v_sum
    FROM tenant_charge WHERE account_id = p_account AND settled_at IS NULL;

  UPDATE tenant_charge SET settled_at = now(), payment_id = p_payment
   WHERE account_id = p_account AND settled_at IS NULL;

  RETURN v_sum;
END; $$;
GRANT EXECUTE ON FUNCTION platform_charges_settle(uuid, uuid) TO shop_app;
