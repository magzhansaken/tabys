-- =====================================================================
-- 088_wipe_accounts.sql — стереть все магазины разом.
--
-- Нужно ровно одному: скрипту 15_demo_data.sh, который чистит
-- платформу перед заведением данных для проверки.
--
-- Отдельной функцией, а не запросом из скрипта, по той же причине, по
-- которой все действия платформы идут функциями: у приложения нет
-- права писать в чужие строки, и это правильно. Защиту строк не
-- обходят «на минутку» — иначе она перестаёт значить что-либо.
--
-- Функция НЕ трогает владельца платформы: без него в панель не войти.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_wipe_accounts()
RETURNS integer
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  -- Порядок: сперва то, что ссылается на магазин.
  DELETE FROM employee;
  DELETE FROM subscription;
  DELETE FROM account;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;
GRANT EXECUTE ON FUNCTION platform_wipe_accounts() TO shop_app;


-- =====================================================================
-- Поставить срок оплаты. Тоже для скрипта данных проверки.
--
-- Прямая правка подписки из скрипта НИЧЕГО НЕ МЕНЯЕТ и не жалуется:
-- защита строк не пускает к чужим подпискам, а UPDATE без строк —
-- это не ошибка, это ноль строк. Правка «проходит», данные прежние.
--
-- Ровно так и вышло: просроченные магазины оставались с завтрашним
-- сроком, и раздел «Срок вышел» был пуст.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_set_paid_until(p_account uuid, p_days integer)
RETURNS timestamptz
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v timestamptz;
BEGIN
  UPDATE subscription
     SET paid_until = now() + (p_days::text || ' days')::interval
   WHERE account_id = p_account
  RETURNING paid_until INTO v;
  RETURN v;
END; $$;
GRANT EXECUTE ON FUNCTION platform_set_paid_until(uuid, integer) TO shop_app;

-- Город в карточке — тем же путём и по той же причине.
CREATE OR REPLACE FUNCTION platform_set_city(p_account uuid, p_city text)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE tenant_card SET city = p_city WHERE account_id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_set_city(uuid, text) TO shop_app;
