-- =====================================================================
-- 098_device_request.sql — три пути к новому устройству.
--
-- ЗАМЫСЕЛ ВЛАДЕЛЬЦА ПЛАТФОРМЫ, записан здесь целиком, чтобы через
-- полгода не гадать, почему сделано именно так.
--
-- ПУТЬ 1 — ВЛАДЕЛЕЦ МАГАЗИНА. Просит из своего кабинета по цене,
--   которую задала платформа. Менять её не может: он покупатель, а не
--   продавец. Заявка идёт ЕГО ПАРТНЁРУ, а если партнёра нет — владельцу
--   платформы.
--
-- ПУТЬ 2 — ПАРТНЁР. Заводит устройство своему клиенту сам, но заявка
--   всё равно идёт владельцу платформы: устройство заработает только
--   после подтверждения. Цену партнёр может СНИЗИТЬ — это его доля, он
--   вправе уступить из неё. Поднять не может: клиент увидел бы цену
--   выше платформенной и решил, что его обманывают.
--
-- ПУТЬ 3 — ВЛАДЕЛЕЦ ПЛАТФОРМЫ. Заводит кому угодно и подтверждает сам.
--
-- ОБЩЕЕ ПРАВИЛО: устройство работает только после подтверждения
-- оплаты. Иначе платформа раздаёт кассы в долг и узнаёт об этом
-- последней.
-- =====================================================================

-- Предложенная цена хранится в заявке: партнёр мог снизить, и владелец
-- платформы должен видеть, что именно предложили, а не только прайс.
ALTER TABLE tenant_request
  ADD COLUMN IF NOT EXISTS asked_price bigint;

COMMENT ON COLUMN tenant_request.asked_price IS
  'Цена, предложенная в заявке. Партнёр вправе снизить прайсовую, владелец магазина — нет.';

-- =====================================================================
-- Подать заявку на устройство. Одна дверь для всех трёх путей: кто
-- подаёт, решает функция по роли, а не тот, кто её зовёт.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_device_request(
  p_account uuid, p_kind text, p_role text, p_user uuid,
  p_price bigint DEFAULT NULL, p_comment text DEFAULT NULL)
RETURNS TABLE (request_id uuid, price bigint, note text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_list bigint; v_price bigint; v_id uuid; v_partner uuid; v_note text;
BEGIN
  -- Цена платформы — от неё пляшут все.
  SELECT CASE WHEN p_kind = 'store' THEN price_extra_store
              ELSE price_extra_pos END INTO v_list
    FROM platform_settings LIMIT 1;

  SELECT partner_id INTO v_partner FROM tenant_card WHERE account_id = p_account;

  IF p_role = 'owner' THEN
    -- ВЛАДЕЛЕЦ МАГАЗИНА цену не выбирает: он видит прайс и просит по нему.
    v_price := v_list;
    v_note  := CASE WHEN v_partner IS NULL
      THEN 'Заявка ушла владельцу платформы'
      ELSE 'Заявка ушла вашему партнёру' END;

  ELSIF p_role = 'partner' THEN
    -- ПАРТНЁР вправе СНИЗИТЬ: это его доля, он уступает из своего.
    -- Поднять нельзя — клиент увидел бы цену выше платформенной.
    v_price := least(coalesce(p_price, v_list), v_list);
    IF coalesce(p_price, v_list) > v_list THEN
      RAISE EXCEPTION 'Цена выше прайса платформы — можно только снизить';
    END IF;
    v_note := 'Заявка ушла владельцу платформы. Устройство заработает после подтверждения';

  ELSE
    -- ВЛАДЕЛЕЦ ПЛАТФОРМЫ ставит любую, включая ноль: подарок за год.
    v_price := coalesce(p_price, v_list);
    v_note  := 'Решение за вами — подтвердите в разделе «Заявки»';
  END IF;

  IF v_price < 0 THEN
    RAISE EXCEPTION 'Цена не может быть отрицательной';
  END IF;

  INSERT INTO tenant_request (account_id, kind, payload, comment, asked_price, created_by)
  VALUES (p_account, 'device',
          jsonb_build_object('device', p_kind),
          nullif(btrim(coalesce(p_comment, '')), ''),
          v_price, p_user)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_price, v_note;
END; $$;
GRANT EXECUTE ON FUNCTION platform_device_request(uuid, text, text, uuid, bigint, text) TO shop_app;
