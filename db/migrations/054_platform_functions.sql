-- =====================================================================
-- 054_platform_functions.sql — функции платформы, дописанные в 052
-- уже после того, как она применилась на сервере.
--
-- ТА ЖЕ ЛОВУШКА, ВТОРОЙ РАЗ. Миграция отмечается применённой по имени
-- файла: на сервере 052 стояла в том виде, каким была при первой
-- выкладке, — четыре функции. Пятнадцать дописанных позже туда не
-- доехали, и наполнение падало на «function does not exist».
--
-- Вывод, теперь окончательный: в применённые миграции не дописывают
-- НИЧЕГО. Даже одну строку. Только новый файл.
-- =====================================================================


CREATE OR REPLACE FUNCTION platform_paid_until(p_account uuid)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT paid_until FROM subscription WHERE account_id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_paid_until(uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_bulk_targets(p_ids uuid[])
RETURNS TABLE (id uuid, name text, paid_until timestamptz, is_demo boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, s.paid_until, coalesce(tc.is_demo, false)
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN subscription s ON s.account_id = a.id
   WHERE a.id = ANY(p_ids) AND a.deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION platform_bulk_targets(uuid[]) TO shop_app;

CREATE OR REPLACE FUNCTION platform_bulk_apply(
  p_ids uuid[], p_action text, p_days integer DEFAULT NULL)
RETURNS integer
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_done integer := 0; v_id uuid;
BEGIN
  FOR v_id IN
    SELECT a.id FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
     WHERE a.id = ANY(p_ids) AND a.deleted_at IS NULL
       AND coalesce(tc.is_demo, false) = false
  LOOP
    IF p_action = 'grace' AND p_days IS NOT NULL THEN
      UPDATE subscription
         SET paid_until = greatest(coalesce(paid_until, now()), now()) + (p_days || ' days')::interval,
             status = 'active'
       WHERE account_id = v_id;
    ELSIF p_action = 'disable' THEN
      UPDATE account SET status = 'suspended' WHERE id = v_id;
    ELSIF p_action = 'enable' THEN
      UPDATE account SET status = 'active' WHERE id = v_id;
    ELSE
      CONTINUE;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END; $$;
GRANT EXECUTE ON FUNCTION platform_bulk_apply(uuid[], text, integer) TO shop_app;

CREATE OR REPLACE FUNCTION platform_reset_owner_password(p_account uuid, p_hash text)
RETURNS boolean
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT e.id INTO v_id FROM employee e
    JOIN role r ON r.id = e.role_id
   WHERE e.account_id = p_account AND r.code = 'owner' AND e.deleted_at IS NULL
   LIMIT 1;
  IF v_id IS NULL THEN RETURN false; END IF;
  UPDATE employee SET password_hash = p_hash WHERE id = v_id;
  RETURN true;
END; $$;
GRANT EXECUTE ON FUNCTION platform_reset_owner_password(uuid, text) TO shop_app;

-- Мягкое удаление: магазин перестаёт работать, данные остаются. Их
-- могут спросить и через год, при разбирательстве.
CREATE OR REPLACE FUNCTION platform_soft_delete_account(p_account uuid)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account SET deleted_at = now(), status = 'deleted' WHERE id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_soft_delete_account(uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_create_account(
  p_name text, p_phone text, p_status account_status DEFAULT 'active')
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO account (name, phone, status) VALUES (p_name, p_phone, p_status)
    RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
GRANT EXECUTE ON FUNCTION platform_create_account(text, text, account_status) TO shop_app;

CREATE OR REPLACE FUNCTION platform_set_subscription(
  p_account uuid, p_days integer, p_status text DEFAULT 'active')
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_t record;
BEGIN
  SELECT id, price_month INTO v_t FROM tariff WHERE is_public ORDER BY price_month LIMIT 1;
  IF v_t.id IS NULL THEN RETURN; END IF;
  INSERT INTO subscription (account_id, tariff_id, status, paid_until, starts_at,
                            price_locked, price_locked_until)
  VALUES (p_account, v_t.id, p_status::sub_status,
          now() + (p_days || ' days')::interval, now(),
          v_t.price_month, now() + interval '1 year')
  ON CONFLICT (account_id) DO UPDATE
    SET paid_until = EXCLUDED.paid_until, status = EXCLUDED.status;
END; $$;
GRANT EXECUTE ON FUNCTION platform_set_subscription(uuid, integer, text) TO shop_app;

CREATE OR REPLACE FUNCTION platform_payments(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  id uuid, amount bigint, months integer, method text, comment text,
  status text, reject_reason text, created_at timestamptz, approved_at timestamptz,
  partner_share bigint, platform_share bigint,
  client text, account_id uuid, partner text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tp.id, tp.amount, tp.months, tp.method, tp.comment,
         tp.status::text, tp.reject_reason, tp.created_at, tp.approved_at,
         tp.partner_share, tp.platform_share,
         a.name, a.id, pu.full_name
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN platform_user pu ON pu.id = tp.partner_id
   WHERE (p_status IS NULL OR tp.status::text = p_status)
     AND (p_role = 'super' OR tp.partner_id = p_user)
   ORDER BY tp.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_payments(text, text, uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_partners()
RETURNS TABLE (
  id uuid, full_name text, email text, phone text, commission_bp integer,
  is_active boolean, last_login_at timestamptz, created_at timestamptz,
  clients bigint, active_clients bigint, earned_30d numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu.id, pu.full_name, pu.email, pu.phone, pu.commission_bp,
         pu.is_active, pu.last_login_at, pu.created_at,
         (SELECT count(*) FROM tenant_card tc WHERE tc.partner_id = pu.id),
         (SELECT count(*) FROM tenant_card tc
            JOIN subscription s ON s.account_id = tc.account_id
           WHERE tc.partner_id = pu.id AND s.paid_until > now()),
         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
           WHERE tp.partner_id = pu.id AND tp.status = 'approved'
             AND tp.approved_at > now() - interval '30 days'), 0)
    FROM platform_user pu
   WHERE pu.role = 'partner' AND pu.deleted_at IS NULL
   ORDER BY pu.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION platform_partners() TO shop_app;

CREATE OR REPLACE FUNCTION platform_requests(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  id uuid, kind text, payload jsonb, comment text, status text,
  decision_note text, created_at timestamptz, decided_at timestamptz,
  client text, account_id uuid, author text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tr.id, tr.kind, tr.payload, tr.comment, tr.status,
         tr.decision_note, tr.created_at, tr.decided_at,
         a.name, a.id, pu.full_name
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
   WHERE (p_status IS NULL OR tr.status = p_status)
     AND (p_role = 'super' OR tr.created_by = p_user)
   ORDER BY tr.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_requests(text, text, uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_find_by_phone(p_phone text)
RETURNS TABLE (id uuid, name text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name FROM account a
   WHERE a.deleted_at IS NULL AND phone_tail(a.phone) = phone_tail(p_phone)
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION platform_find_by_phone(text) TO shop_app;

CREATE OR REPLACE FUNCTION platform_create_tenant(
  p_name text, p_phone text, p_owner text, p_hash text,
  p_trial_days integer, p_partner uuid)
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_acc uuid; v_role uuid; v_store uuid; v_t record;
BEGIN
  INSERT INTO account (name, phone, status) VALUES (p_name, p_phone, 'trial')
    RETURNING id INTO v_acc;

  SELECT id INTO v_role FROM role WHERE account_id = v_acc AND code = 'owner';
  IF v_role IS NULL THEN
    INSERT INTO role (account_id, code, name, is_system)
    VALUES (v_acc, 'owner', 'Владелец', true) RETURNING id INTO v_role;
  END IF;

  -- Владельцу нужен вход и в кабинет, и на кассу. Без can_login_admin
  -- он заводится, но войти не может — поймал на живой проверке: пароль
  -- подходит, отпечаток верный, а вход отбивается.
  INSERT INTO employee (account_id, role_id, first_name, phone, password_hash,
                        can_login_admin, can_login_pos, is_active)
  VALUES (v_acc, v_role, p_owner, p_phone, p_hash, true, true, true);

  INSERT INTO store (account_id, name) VALUES (v_acc, p_name) RETURNING id INTO v_store;

  SELECT id, price_month INTO v_t FROM tariff WHERE is_public ORDER BY price_month LIMIT 1;
  IF v_t.id IS NOT NULL THEN
    INSERT INTO subscription (account_id, tariff_id, status, paid_until, starts_at,
                              price_locked, price_locked_until)
    VALUES (v_acc, v_t.id, 'trial', now() + (p_trial_days || ' days')::interval, now(),
            v_t.price_month, now() + interval '1 year');
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_acc, 'base', 'Тариф', 1, v_t.price_month * 100);
  END IF;

  INSERT INTO tenant_card (account_id, partner_id, owner_name, owner_phone, deal_stage)
  VALUES (v_acc, p_partner, p_owner, p_phone, 'won');

  RETURN v_acc;
END; $$;
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text, integer, uuid) TO shop_app;

CREATE OR REPLACE FUNCTION platform_approve_signup(p_account uuid, p_days integer)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_until timestamptz;
BEGIN
  v_until := now() + (p_days || ' days')::interval;
  UPDATE account SET status = 'trial' WHERE id = p_account AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE subscription SET paid_until = v_until, status = 'trial' WHERE account_id = p_account;
  RETURN v_until;
END; $$;
GRANT EXECUTE ON FUNCTION platform_approve_signup(uuid, integer) TO shop_app;

CREATE OR REPLACE FUNCTION platform_set_status(p_account uuid, p_status account_status)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account SET status = p_status WHERE id = p_account AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION platform_set_status(uuid, account_status) TO shop_app;

CREATE OR REPLACE FUNCTION platform_pairing_code(p_account uuid)
RETURNS TABLE (code text, expires_at timestamptz, register_name text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_reg record; v_code text;
BEGIN
  SELECT cr.id, cr.name INTO v_reg FROM cash_register cr
   WHERE cr.account_id = p_account ORDER BY cr.created_at LIMIT 1;
  IF v_reg.id IS NULL THEN RETURN; END IF;

  -- Код из восьми знаков в верхнем регистре: его диктуют по телефону,
  -- и так он читается вслух без «а это буква или цифра».
  v_code := upper(encode(gen_random_bytes(4), 'hex'));

  -- Прежний непривязанный код гасим: иначе у кассы окажется два живых
  -- кода, и непонятно, какой ввели.
  UPDATE device SET deleted_at = now()
   WHERE cash_register_id = v_reg.id AND token_hash IS NULL AND deleted_at IS NULL;

  INSERT INTO device (account_id, cash_register_id, name, pairing_code, pairing_expires_at)
  VALUES (p_account, v_reg.id, v_reg.name, v_code, now() + interval '30 minutes');

  RETURN QUERY SELECT v_code, now() + interval '30 minutes', v_reg.name;
END; $$;
GRANT EXECUTE ON FUNCTION platform_pairing_code(uuid) TO shop_app;

