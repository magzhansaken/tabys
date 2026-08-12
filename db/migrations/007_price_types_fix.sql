-- =====================================================================
-- 007_price_types_fix.sql
-- Найдено тестом импорта: типы цен заводятся на аккаунт, но регистрация
-- их не создавала — новый клиент оставался без розничной цены, и любой
-- импорт падал на первой же строке.
-- Чиним в корне: регистрация сразу заводит «Розничная» и «Оптовая»
-- (модель МС «типы цен» + оптовая цена UMAG).
-- =====================================================================

CREATE OR REPLACE FUNCTION ensure_price_types(p_account uuid)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO price_type (account_id, name, code, is_default, sort_order)
  SELECT p_account, 'Розничная', 'retail', true, 1
   WHERE NOT EXISTS (SELECT 1 FROM price_type WHERE account_id = p_account AND code = 'retail');
  INSERT INTO price_type (account_id, name, code, is_default, sort_order)
  SELECT p_account, 'Оптовая', 'wholesale', false, 2
   WHERE NOT EXISTS (SELECT 1 FROM price_type WHERE account_id = p_account AND code = 'wholesale');
END $$;
GRANT EXECUTE ON FUNCTION ensure_price_types(uuid) TO shop_app;

-- регистрация: добавляем создание типов цен
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
  PERFORM ensure_price_types(a_id);     -- иначе первый же импорт упадёт без розничной цены
  RETURN QUERY SELECT a_id, e_id;
END $$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION register_account(text,text,text,text) TO shop_app;

-- существующим аккаунтам достраиваем
DO $$
DECLARE a record;
BEGIN
  FOR a IN SELECT id FROM account LOOP PERFORM ensure_price_types(a.id); END LOOP;
END $$;
