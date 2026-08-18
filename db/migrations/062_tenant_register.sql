-- =====================================================================
-- 062_tenant_register.sql — новому клиенту сразу заводится касса.
--
-- НАЙДЕНО СВЕРКОЙ: platform_create_tenant заводил точку и сотрудника,
-- но НЕ КАССУ. Значит код привязки взять было неоткуда, и владелец
-- магазина не мог начать работать: заходит в кабинет, а продавать
-- нечем.
--
-- Партнёр в этот момент стоит в магазине. Заставить его вернуться
-- второй раз из-за недостающей кассы — худшее, что можно сделать в
-- первый день работы с клиентом.
--
-- Заодно склад: без него приход товара некуда оприходовать.
-- =====================================================================
-- Набор полей изменился (добавился register_id) — старую убираем.
DROP FUNCTION IF EXISTS platform_create_tenant(text, text, text, text, integer, uuid);

CREATE OR REPLACE FUNCTION platform_create_tenant(
  p_name text, p_phone text, p_owner text, p_hash text,
  p_trial_days integer DEFAULT 14, p_partner uuid DEFAULT NULL)
RETURNS TABLE (out_account uuid, out_employee uuid, out_store uuid, out_register uuid)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_acc uuid; v_emp uuid; v_store uuid; v_reg uuid; v_role uuid; v_wh uuid;
BEGIN
  INSERT INTO account (name, phone, status)
  VALUES (p_name, p_phone, 'trial') RETURNING id INTO v_acc;

  -- Роль владельца берём ОБЩУЮ системную: своя роль с тем же кодом
  -- ломает регистрацию с сайта (см. 058).
  SELECT r.id INTO v_role FROM role r
   WHERE r.code = 'owner' AND r.account_id IS NULL LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Нет системной роли владельца — база не размечена';
  END IF;

  INSERT INTO employee (account_id, role_id, first_name, phone, password_hash,
                        is_owner, can_login_admin, can_login_pos, position)
  VALUES (v_acc, v_role, p_owner, p_phone, p_hash, true, true, true, 'Владелец')
  RETURNING id INTO v_emp;

  INSERT INTO store (account_id, name) VALUES (v_acc, p_name) RETURNING id INTO v_store;
  INSERT INTO employee_store (employee_id, store_id, account_id)
  VALUES (v_emp, v_store, v_acc);

  -- Склад: без него приход товара некуда оприходовать.
  INSERT INTO warehouse (account_id, store_id, name, is_primary)
  VALUES (v_acc, v_store, 'Основной склад', true) RETURNING id INTO v_wh;
  UPDATE store SET default_warehouse_id = v_wh WHERE id = v_store;

  -- КАССА. Без неё нет кода привязки, и владелец не может продавать.
  INSERT INTO cash_register (account_id, store_id, name)
  VALUES (v_acc, v_store, 'Касса 1') RETURNING id INTO v_reg;

  INSERT INTO subscription (account_id, tariff_id, status, price_locked,
                            price_locked_until, stores_paid, paid_until)
  SELECT v_acc, t.id, 'trial', t.price_month,
         current_date + interval '1 year', 1,
         now() + (p_trial_days || ' days')::interval
    FROM tariff t WHERE t.code = 'start'
   ORDER BY t.created_at LIMIT 1
  ON CONFLICT (account_id) DO NOTHING;

  INSERT INTO tenant_card (account_id, partner_id, touched_at)
  VALUES (v_acc, p_partner, now())
  ON CONFLICT (account_id) DO UPDATE SET partner_id = p_partner;

  RETURN QUERY SELECT v_acc, v_emp, v_store, v_reg;
END; $$;
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text, integer, uuid) TO shop_app;
