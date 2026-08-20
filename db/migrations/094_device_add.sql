-- =====================================================================
-- 094_device_add.sql — добавить устройство целиком, а не полдела.
--
-- РАЗОБРАНО У ДОНОРА. За одно действие они делают четыре вещи одной
-- сделкой — либо всё, либо ничего:
--   поднимают предел, сколько устройств этого вида разрешено;
--   добавляют строку счёта, НО только если цена больше нуля;
--   заводят САМО УСТРОЙСТВО с кодом привязки;
--   пишут в журнал — с ценой или пометкой «без платы».
--
-- У МЕНЯ БЫЛО ПОЛДЕЛА: добавлялась строка счёта, и всё. Я брал деньги
-- за кассу, а самой кассы не заводил — клиенту нечего привязывать,
-- кода нет. Он платит за то, чего у него не появилось.
--
-- Имя даётся само по числу уже заведённых: «Касса 2», «Точка 3».
--
-- БЕСПЛАТНОЕ УСТРОЙСТВО ВОЗМОЖНО, как у них: цена ноль — строки счёта
-- нет, но устройство работает. Нужно, когда касса даётся в подарок за
-- годовую оплату или на замену сломанной.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_device_add(
  p_account uuid, p_kind text, p_price bigint, p_name text DEFAULT NULL)
RETURNS TABLE (device_id uuid, device_name text, code text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_store uuid; v_n integer; v_name text; v_code text; v_id uuid;
BEGIN
  -- Точка, к которой привязать. Берём первую по имени — как донор.
  SELECT id INTO v_store FROM store
   WHERE account_id = p_account AND deleted_at IS NULL
   ORDER BY name LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'У магазина нет ни одной точки — сначала заведите точку';
  END IF;

  IF p_kind = 'pos' THEN
    SELECT count(*) + 1 INTO v_n FROM cash_register
     WHERE account_id = p_account AND deleted_at IS NULL;
    v_name := coalesce(nullif(btrim(p_name), ''), 'Касса ' || v_n);
    v_code := 'TBS-' || upper(substr(md5(random()::text), 1, 4))
              || '-' || lpad((1000 + floor(random() * 9000))::int::text, 4, '0');

    INSERT INTO cash_register (account_id, store_id, name)
    VALUES (p_account, v_store, v_name) RETURNING id INTO v_id;
  ELSE
    SELECT count(*) + 1 INTO v_n FROM store
     WHERE account_id = p_account AND deleted_at IS NULL;
    v_name := coalesce(nullif(btrim(p_name), ''), 'Точка ' || v_n);
    v_code := NULL;

    INSERT INTO store (account_id, name) VALUES (p_account, v_name)
    RETURNING id INTO v_id;
  END IF;

  -- Строка счёта — ТОЛЬКО если устройство платное. Ноль значит подарок
  -- или замена: устройство есть, денег за него не берём.
  IF p_price > 0 THEN
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (p_account, p_kind, v_name, 1, p_price);
  END IF;

  RETURN QUERY SELECT v_id, v_name, v_code;
END; $$;
GRANT EXECUTE ON FUNCTION platform_device_add(uuid, text, bigint, text) TO shop_app;
