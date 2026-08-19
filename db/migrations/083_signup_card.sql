-- =====================================================================
-- 083_signup_card.sql — записавшийся с сайта без карточки.
--
-- НАЙДЕНО СВЕРКОЙ ВОЗМОЖНОСТЕЙ. Человек записался с сайта сам:
-- магазин создан, сотрудник-владелец есть, войти он может. А КАРТОЧКИ
-- КЛИЕНТА НЕТ — её заводит только платформа, когда клиента приводит
-- партнёр.
--
-- Что из этого следовало у владельца платформы:
--   в списке клиентов пусто в колонках «владелец» и «телефон» —
--     позвонить и помочь завести товары НЕЧЕМ;
--   поиск по имени владельца его не находит;
--   в воронке карточка без владельца;
--   этап сделки не проставлен.
--
-- А это САМЫЙ ВАЖНЫЙ клиент: он пришёл сам, его никто не ведёт, и
-- если ему не позвонить в первый день — он уйдёт.
--
-- Заводим карточку при записи и заполняем из сотрудника-владельца.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_ensure_card(p_account uuid)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_card (account_id, owner_name, owner_phone, deal_stage, touched_at)
  SELECT p_account, e.first_name, e.phone, 'new', now()
    FROM employee e
   WHERE e.account_id = p_account AND e.is_owner
   LIMIT 1
  ON CONFLICT (account_id) DO UPDATE SET
    owner_name  = coalesce(tenant_card.owner_name, EXCLUDED.owner_name),
    owner_phone = coalesce(tenant_card.owner_phone, EXCLUDED.owner_phone);
END; $$;
GRANT EXECUTE ON FUNCTION platform_ensure_card(uuid) TO shop_app;

-- Заводим карточки тем, кто записался раньше и остался без неё.
SELECT platform_ensure_card(a.id)
  FROM account a
 WHERE a.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM tenant_card tc WHERE tc.account_id = a.id);
