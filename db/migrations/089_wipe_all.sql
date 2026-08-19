-- =====================================================================
-- 089_wipe_all.sql — стереть все магазины по-настоящему.
--
-- НАЙДЕНО НА СЕРВЕРЕ. Прошлая попытка стирала три таблицы — магазины,
-- подписки, сотрудников — и падала:
--
--   «update or delete on table employee violates foreign key
--    constraint pos_session_employee_id_fkey»
--
-- На магазин ссылается 131 ТАБЛИЦА: смены кассиров, чеки, товары,
-- остатки, поставки, долги, бонусы. Перечислять их руками нельзя —
-- список меняется с каждой миграцией, и однажды его забудут дополнить.
--
-- Поэтому чистим ОДНОЙ КОМАНДОЙ с продолжением по ссылкам: база сама
-- знает, кто на кого ссылается, и делает это вернее любого списка.
--
-- ЧТО ОСТАНЕТСЯ: владелец платформы, тарифы, настройки платформы,
-- список миграций, заявки с сайта, новости, налоговые ставки.
-- Проверено — они ни на что не ссылаются.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_wipe_accounts()
RETURNS integer
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM account;

  -- ОБЩИЕ СТРОКИ сохраняем. Роли (владелец, кассир, администратор) и
  -- единицы измерения лежат в тех же таблицах, что и магазинные, но
  -- без привязки к магазину. Очистка по ссылкам сносит их заодно — и
  -- следующее заведение падает: «Нет системной роли владельца».
  CREATE TEMP TABLE _roles ON COMMIT DROP AS
    SELECT * FROM role WHERE account_id IS NULL;
  CREATE TEMP TABLE _units ON COMMIT DROP AS
    SELECT * FROM unit WHERE account_id IS NULL;

  -- CASCADE идёт по ссылкам сам: 131 таблица очистится в верном
  -- порядке. Список руками не пишем — он устареет молча.
  TRUNCATE TABLE account CASCADE;

  INSERT INTO role SELECT * FROM _roles;
  INSERT INTO unit SELECT * FROM _units;

  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION platform_wipe_accounts() TO shop_app;
