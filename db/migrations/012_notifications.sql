-- =====================================================================
-- 012_notifications.sql — УВЕДОМЛЕНИЯ О КРИТИЧЕСКИХ ОСТАТКАХ (3.7)
-- UMAG шлёт письмо каждое утро в 9:00 со ссылкой на склад с фильтром.
-- МойСклад даёт настройку «на телефон или e-mail» + кнопку «Пополнить».
--
-- Наше отличие: не слать одно и то же каждый день. Если товар кончился и
-- его неделю не заказали, UMAG будет слать одинаковое письмо семь дней —
-- так уведомления отключают и перестают узнавать о важном.
-- =====================================================================
CREATE TYPE notify_channel AS ENUM ('push','sms','email','telegram');
CREATE TYPE notify_kind AS ENUM ('low_stock','sync_lost','shift_open_long','inventory_ready','ntin_missing');

CREATE TABLE notify_setting (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id   uuid REFERENCES employee(id) ON DELETE CASCADE,
  kind          notify_kind NOT NULL,
  channels      notify_channel[] NOT NULL DEFAULT ARRAY['push']::notify_channel[],
  enabled       boolean NOT NULL DEFAULT true,
  send_at       time NOT NULL DEFAULT '09:00',        -- у UMAG жёстко 9:00; у нас настраивается
  repeat_days   integer NOT NULL DEFAULT 3,           -- не повторять то же самое чаще, чем раз в N дней
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, employee_id, kind)
);

CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id   uuid REFERENCES employee(id) ON DELETE CASCADE,
  kind          notify_kind NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  link          text,                                  -- ссылка на готовый фильтр (находка UMAG)
  payload       jsonb NOT NULL DEFAULT '{}',
  fingerprint   text,                                  -- отпечаток содержимого: не слать то же самое
  channels      notify_channel[] NOT NULL DEFAULT ARRAY['push']::notify_channel[],
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notification(account_id, created_at DESC);
CREATE INDEX ON notification(account_id, kind, fingerprint, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notify_setting','notification']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПОПОЛНЕНИЕ ДО НЕСНИЖАЕМОГО ОСТАТКА (модель МС «Пополнить резервы»).
-- Считаем, сколько докупить, и подсказываем, есть ли излишек на другом
-- складе — тогда достаточно перемещения, а не закупки.
-- =====================================================================
CREATE OR REPLACE FUNCTION replenishment_plan(p_account uuid, p_warehouse uuid)
RETURNS TABLE (product_id uuid, name text, qty numeric, min_stock numeric,
               to_order numeric, available_elsewhere numeric, other_warehouse uuid)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name, coalesce(b.qty, 0), p.min_stock,
         p.min_stock - coalesce(b.qty, 0) AS to_order,
         coalesce(o.surplus, 0) AS available_elsewhere,
         o.warehouse_id
    FROM product p
    LEFT JOIN stock_balance b ON b.product_id = p.id AND b.warehouse_id = p_warehouse
    LEFT JOIN LATERAL (
      -- где ещё лежит этот товар сверх собственного минимума
      SELECT b2.warehouse_id, b2.qty - coalesce(p.min_stock, 0) AS surplus
        FROM stock_balance b2
       WHERE b2.product_id = p.id AND b2.warehouse_id <> p_warehouse
         AND b2.qty - coalesce(p.min_stock, 0) > 0
       ORDER BY b2.qty DESC LIMIT 1
    ) o ON true
   WHERE p.account_id = p_account AND p.min_stock IS NOT NULL AND p.min_stock > 0
     AND coalesce(b.qty, 0) < p.min_stock
     AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.track_stock
   ORDER BY (p.min_stock - coalesce(b.qty, 0)) DESC;
$$;
GRANT EXECUTE ON FUNCTION replenishment_plan(uuid,uuid) TO shop_app;

-- =====================================================================
-- ПОДГОТОВКА УВЕДОМЛЕНИЯ О КРИТИЧЕСКИХ ОСТАТКАХ.
-- fingerprint — отпечаток списка. Список не изменился и не прошло
-- repeat_days — молчим. Это ровно то, чего не делает UMAG.
-- =====================================================================
CREATE OR REPLACE FUNCTION build_low_stock_notification(p_account uuid, p_employee uuid)
RETURNS TABLE (created boolean, reason text, items integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  s record; v_items integer; v_fp text; v_last record; v_names text; v_title text; v_body text;
BEGIN
  SELECT * INTO s FROM notify_setting
   WHERE account_id = p_account AND kind = 'low_stock'
     AND (employee_id = p_employee OR employee_id IS NULL) AND enabled
   ORDER BY employee_id NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'Уведомления выключены'::text, 0; RETURN; END IF;

  SELECT count(*), string_agg(name || ' (' || trim(to_char(qty, 'FM999990.###')) || ')', ', ' ORDER BY name),
         md5(string_agg(product_id::text || ':' || qty::text, ',' ORDER BY product_id::text))
    INTO v_items, v_names, v_fp
    FROM low_stock(p_account, NULL);

  IF coalesce(v_items, 0) = 0 THEN RETURN QUERY SELECT false, 'Нечего сообщать'::text, 0; RETURN; END IF;

  -- то же самое, что и в прошлый раз, и срок повтора не вышел → молчим
  SELECT * INTO v_last FROM notification
   WHERE account_id = p_account AND kind = 'low_stock'
     AND (employee_id = p_employee OR employee_id IS NULL)
   ORDER BY created_at DESC LIMIT 1;

  IF FOUND AND v_last.fingerprint = v_fp
     AND v_last.created_at > now() - (s.repeat_days || ' days')::interval THEN
    RETURN QUERY SELECT false, 'Список не изменился — не спамим'::text, v_items; RETURN;
  END IF;

  v_title := 'Заканчивается товар: ' || v_items || ' поз.';
  v_body  := 'Ниже критического остатка: ' || left(v_names, 500);

  INSERT INTO notification (account_id, employee_id, kind, title, body, link, fingerprint, channels, payload)
  VALUES (p_account, p_employee, 'low_stock', v_title, v_body,
          '/stock?filter=low_stock',                   -- ссылка на готовый фильтр (находка UMAG)
          v_fp, s.channels, jsonb_build_object('count', v_items));
  RETURN QUERY SELECT true, 'Создано'::text, v_items;
END $$;
GRANT EXECUTE ON FUNCTION build_low_stock_notification(uuid,uuid) TO shop_app;

-- каждому новому клиенту — включённые уведомления с разумными настройками
CREATE OR REPLACE FUNCTION ensure_notify_settings(p_account uuid, p_employee uuid)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notify_setting (account_id, employee_id, kind, channels, send_at, repeat_days)
  VALUES (p_account, p_employee, 'low_stock', ARRAY['push']::notify_channel[], '09:00', 3)
  ON CONFLICT (account_id, employee_id, kind) DO NOTHING;
END $$;
GRANT EXECUTE ON FUNCTION ensure_notify_settings(uuid,uuid) TO shop_app;
