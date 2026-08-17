-- =====================================================================
-- 059_rename_account.sql — правка названия магазина из платформы.
--
-- Название лежит в account, закрытом правилом «только свой магазин»:
-- прямой запрос из платформы обновляет ноль строк МОЛЧА. Ловушка та
-- же, что и пять раз до этого, — поэтому сразу функцией.
--
-- Зачем правка вообще: опечатку в названии гонять через лист
-- подтверждения незачем — это не деньги. Приём донора: клик по
-- значению превращает его в поле.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_rename_account(p_account uuid, p_name text)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account SET name = p_name
   WHERE id = p_account AND deleted_at IS NULL AND p_name <> '';
$$;
GRANT EXECUTE ON FUNCTION platform_rename_account(uuid, text) TO shop_app;
