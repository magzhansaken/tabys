-- =====================================================================
-- 096_request_device.sql — одобрение заявки заводит устройство.
--
-- РАЗОБРАНО У ДОНОРА. Их довод взят вместе с кодом:
--
--   «И само устройство — иначе цепочка обрывалась на полпути. Раньше
--    одобрение поднимало лимит и заводило строку в счёт, а устройства
--    не появлялось: клиент платил за то, чего у него нет, и не
--    понимал, где взять код.»
--
-- РОВНО ЭТО БЫЛО И У МЕНЯ. Партнёр просит вторую кассу, владелец
-- платформы одобряет и назначает цену, счёт вырастает на три тысячи —
-- а кассы не возникает. Клиенту нечего привязывать.
--
-- Теперь одобрение зовёт ту же функцию, что и ручное добавление:
-- устройство, код привязки и строка счёта одной сделкой.
--
-- ЦЕНУ НАЗНАЧАЕТ ВЛАДЕЛЕЦ ПЛАТФОРМЫ при одобрении — как у них: партнёр
-- в заявке предлагает, а решает платформа. Ноль разрешён: вторую кассу
-- дают в подарок за годовую оплату, и это должно быть видно строкой.
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_request_decide(
  p_request uuid, p_actor uuid, p_approve boolean, p_note text,
  p_unit_price bigint DEFAULT NULL)
RETURNS TABLE (account_id uuid, kind text, effect text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_dev_name text; v_dev_code text;
  v_r record; v_set record; v_unit bigint; v_kind text; v_days integer;
  v_effect text := ''; v_n integer;
BEGIN
  SELECT * INTO v_r FROM tenant_request WHERE id = p_request FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Заявка не найдена'; END IF;
  IF v_r.status <> 'pending' THEN RAISE EXCEPTION 'Заявка уже решена'; END IF;

  UPDATE tenant_request
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decision_note = p_note, decided_by = p_actor, decided_at = now()
   WHERE id = p_request;

  IF NOT p_approve THEN
    RETURN QUERY SELECT v_r.account_id, v_r.kind, 'Отказано'::text;
    RETURN;
  END IF;

  SELECT * INTO v_set FROM platform_settings WHERE id;

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    -- Цена, которую ввёл владелец платформы. Ноль разрешён: бывает,
    -- что вторую кассу дают в подарок — и это должно быть видно в
    -- счёте строкой на ноль, а не держаться в голове.
    v_unit := coalesce(p_unit_price,
      CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
           ELSE v_set.price_extra_pos END);
    -- ЗАВОДИМ САМО УСТРОЙСТВО, а не только строку счёта.
    --
    -- Донорский довод, взятый вместе с кодом: «раньше одобрение
    -- поднимало лимит и заводило строку в счёт, а устройства не
    -- появлялось: клиент платил за то, чего у него нет, и не понимал,
    -- где взять код».
    --
    -- Ровно это было и у меня: партнёр просил кассу, владелец
    -- платформы одобрял, счёт вырастал — а кассы не возникало.
    SELECT device_name, code INTO v_dev_name, v_dev_code
      FROM platform_device_add(v_r.account_id, v_kind, v_unit, NULL);

    v_effect := CASE WHEN v_unit > 0
      THEN v_dev_name || ' подключена · ' || money_ru(v_unit) || ' ₸/мес'
      ELSE v_dev_name || ' подключена бесплатно' END;

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := coalesce(p_unit_price,
      CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
           THEN v_set.price_pro ELSE v_set.price_base END);
    UPDATE plan_line SET ends_at = now()
     WHERE plan_line.account_id = v_r.account_id AND plan_line.kind = 'base'
       AND plan_line.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, 'base', 'Тариф', 1, v_unit);
    v_effect := 'Тариф изменён на ' || money_ru(v_unit) || ' ₸/мес';

  ELSIF v_r.kind = 'grace' THEN
    v_days := coalesce((v_r.payload->>'days')::int, 7);
    UPDATE subscription
       SET paid_until = greatest(coalesce(paid_until, now()), now())
                        + (v_days || ' days')::interval,
           status = 'active'
     WHERE subscription.account_id = v_r.account_id;
    UPDATE account SET status = 'active'
     WHERE id = v_r.account_id AND status <> 'active';
    v_effect := 'Отсрочка на ' || v_days || ' дн. дана';

  ELSE
    v_effect := 'Отмечено решённым';
  END IF;

  RETURN QUERY SELECT v_r.account_id, v_r.kind, v_effect;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_decide(uuid, uuid, boolean, text, bigint) TO shop_app;
