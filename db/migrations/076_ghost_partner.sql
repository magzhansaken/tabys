-- =====================================================================
-- 076_ghost_partner.sql — клиент не должен числиться за призраком.
--
-- НАЙДЕНО СВЕРКОЙ КРАЙНИХ СОСТОЯНИЙ. Партнёра пометили удалённым — он
-- исчез из списка партнёров, вход ему закрыт, старый ключ отбит. Всё
-- верно.
--
-- НО КЛИЕНТ ПО-ПРЕЖНЕМУ ЧИСЛИТСЯ ЗА НИМ. В списке стоит «ведёт Ерлан»,
-- в воронке тоже, в оплатах доля начисляется на несуществующего
-- человека. А в отборе по партнёру Ерлана НЕТ — его некем выбрать,
-- и отобрать этих клиентов нельзя ничем.
--
-- Клиент повисает: он есть, он платит, но его никто не ведёт — и
-- заметить это можно только случайно.
--
-- Удаления партнёра из кабинета нет (и не надо — есть отключение).
-- Но если метка проставлена руками в базе, клиенты должны стать
-- ничьими: пусть лучше «без партнёра», чем за тем, кого нет.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_free_ghost_clients()
RETURNS integer
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE tenant_card tc
     SET partner_id = NULL, updated_at = now()
   WHERE tc.partner_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM platform_user pu
                  WHERE pu.id = tc.partner_id AND pu.deleted_at IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION platform_free_ghost_clients() TO shop_app;

-- Освобождаем тех, кто уже повис.
SELECT platform_free_ghost_clients();

-- И дальше не даём привязать клиента к удалённому: раньше это
-- проверялось только в кабинете, а кабинет не единственная дверь.
CREATE OR REPLACE FUNCTION platform_assign_partner(
  p_account uuid, p_partner uuid)
RETURNS TABLE (note text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_name text;
BEGIN
  IF p_partner IS NOT NULL THEN
    SELECT pu.full_name INTO v_name FROM platform_user pu
     WHERE pu.id = p_partner AND pu.deleted_at IS NULL AND pu.role = 'partner';
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Партнёр не найден или удалён';
    END IF;
  END IF;

  INSERT INTO tenant_card (account_id, partner_id, touched_at)
  VALUES (p_account, p_partner, now())
  ON CONFLICT (account_id) DO UPDATE SET
    partner_id = p_partner, updated_at = now();

  RETURN QUERY SELECT CASE
    WHEN p_partner IS NULL THEN 'Клиент стал ничьим — ведёт платформа'
    ELSE 'Клиента ведёт ' || v_name || '. Доля считается с будущих оплат'
  END;
END; $$;
GRANT EXECUTE ON FUNCTION platform_assign_partner(uuid, uuid) TO shop_app;
