-- СКЛАД У КАССЫ: чеки уходили в карантин.
--
-- Владелец пробил продажу по свежему клиенту — деньги взяли, а в
-- кабинете чека НЕТ.
--
-- Сервер принимал чек и клал его в КАРАНТИН: «null value in column
-- warehouse». Касса заводилась БЕЗ СКЛАДА, хотя склад у магазина есть,
-- и списать товар было неоткуда.
--
-- Это худший вид беды: касса говорит «оплачено», кассир отдаёт сдачу,
-- а учёта нет. Владелец видит пустой отчёт и не понимает, куда делись
-- деньги.

CREATE OR REPLACE FUNCTION public.platform_create_tenant(p_name text, p_phone text, p_owner text, p_hash text, p_trial_days integer DEFAULT 14, p_partner uuid DEFAULT NULL::uuid)
 RETURNS TABLE(out_account uuid, out_employee uuid, out_store uuid, out_register uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- СКЛАД У КАССЫ ОБЯЗАТЕЛЕН.
  --
  -- Найдено владельцем: продажу пробили, деньги взяли, а в кабинете
  -- чека НЕТ. Сервер принимал чек и клал его в КАРАНТИН — «null value
  -- in column warehouse»: списать товар неоткуда.
  --
  -- Касса заводилась без склада, хотя склад у магазина есть.
  INSERT INTO cash_register (account_id, store_id, name, warehouse_id)
  VALUES (v_acc, v_store, 'Касса 1', v_wh) RETURNING id INTO v_reg;

  INSERT INTO subscription (account_id, tariff_id, status, price_locked,
                            price_locked_until, stores_paid, paid_until)
  SELECT v_acc, t.id, 'trial', t.price_month,
         current_date + interval '1 year', 1,
         now() + (p_trial_days || ' days')::interval
    FROM tariff t WHERE t.code = 'start'
   ORDER BY t.created_at LIMIT 1
  ON CONFLICT (account_id) DO NOTHING;

  -- Имя и телефон владельца пишем В КАРТОЧКУ. Раньше туда шёл только
  -- партнёр: в списке клиентов колонка «владелец» пустовала, поиск по
  -- имени не находил ничего, а позвонить из ленты было некому —
  -- телефон брать было неоткуда.
  INSERT INTO tenant_card (account_id, partner_id, owner_name, owner_phone, touched_at)
  VALUES (v_acc, p_partner, p_owner, p_phone, now())
  ON CONFLICT (account_id) DO UPDATE SET
    partner_id  = p_partner,
    owner_name  = coalesce(tenant_card.owner_name, p_owner),
    owner_phone = coalesce(tenant_card.owner_phone, p_phone);

  RETURN QUERY SELECT v_acc, v_emp, v_store, v_reg;
END; $function$;


-- И ЧИНИМ УЖЕ ЗАВЕДЁННЫЕ КАССЫ: у них склад тоже пуст.
UPDATE cash_register cr
   SET warehouse_id = s.default_warehouse_id
  FROM store s
 WHERE s.id = cr.store_id
   AND cr.warehouse_id IS NULL
   AND s.default_warehouse_id IS NOT NULL;

COMMENT ON COLUMN cash_register.warehouse_id IS
  'Склад кассы. Без него чеки уходят в карантин: списать товар неоткуда';
