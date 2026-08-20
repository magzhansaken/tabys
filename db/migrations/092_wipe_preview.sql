-- =====================================================================
-- 092_wipe_preview.sql — сосчитать, что уйдёт при очистке.
--
-- ВЫНЕСЕНО СТОРОЖЕМ ИЗ 091, которая уже применена на сервере. Дописки
-- в применённый файл туда НЕ ПОПАДАЮТ: миграции отмечаются по имени, и
-- развёртывание пропустит его со словами «уже применена».
--
-- Сторож поймал это второй раз за день. Пусть ловит и дальше.
-- =====================================================================
-- =====================================================================
-- Сосчитать, что уйдёт при очистке.
--
-- Прямой подсчёт магазинов из приложения даёт НОЛЬ: защита строк не
-- пускает к чужим, а «ноль строк» — это не ошибка. Скрипт очистки
-- показывал «магазинов: 0» перед тем, как стереть одиннадцать.
--
-- Врать перед необратимым действием нельзя: человек решает по этим
-- числам, стирать ему или нет.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_wipe_preview()
RETURNS TABLE (accounts bigint, employees bigint, payments bigint,
               requests bigint, partners bigint, journal bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM account),
         (SELECT count(*) FROM employee),
         (SELECT count(*) FROM tenant_payment),
         (SELECT count(*) FROM tenant_request),
         (SELECT count(*) FROM platform_user WHERE role = 'partner'),
         (SELECT count(*) FROM platform_audit);
$$;
GRANT EXECUTE ON FUNCTION platform_wipe_preview() TO shop_app;
