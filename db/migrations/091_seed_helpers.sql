-- =====================================================================
-- 091_seed_helpers.sql — вспомогательные функции для данных проверки.
--
-- ВЫНЕСЕНО ИЗ 089 СТОРОЖЕМ МИГРАЦИЙ. Я дописал их в файл, который уже
-- применён на сервере, — а такие дописки НЕ ПОПАДАЮТ туда молча:
-- миграции отмечаются по имени файла, и развёртывание пропустит его со
-- словами «уже применена».
--
-- Сторож поймал это до выкладки. Ровно ради такого он и написан.
-- =====================================================================
-- =====================================================================
-- Поставить тариф. Тоже для данных проверки.
--
-- Та же беда, что была со сроком: прямая правка подписки не видит
-- чужие строки и молча ничего не меняет. Магазин оставался на
-- «Старте», и проверить второй тариф было не на чем.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_set_tariff(p_account uuid, p_code text)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE subscription s
     SET tariff_id = t.id, price_locked = t.price_month
    FROM tariff t
   WHERE s.account_id = p_account AND t.code = p_code;
$$;
GRANT EXECUTE ON FUNCTION platform_set_tariff(uuid, text) TO shop_app;

-- Пометить магазин учебным — по той же причине.
CREATE OR REPLACE FUNCTION platform_set_demo(p_account uuid)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE tenant_card SET is_demo = true WHERE account_id = p_account;
$$;
GRANT EXECUTE ON FUNCTION platform_set_demo(uuid) TO shop_app;

-- Добавить строку счёта, в том числе закрытую.
CREATE OR REPLACE FUNCTION platform_add_line(
  p_account uuid, p_kind text, p_title text, p_price bigint,
  p_ended_days integer DEFAULT NULL)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO plan_line (account_id, kind, title, qty, unit_price, ends_at)
  VALUES (p_account, p_kind, p_title, 1, p_price,
          CASE WHEN p_ended_days IS NULL THEN NULL
               ELSE now() - (p_ended_days::text || ' days')::interval END);
$$;
GRANT EXECUTE ON FUNCTION platform_add_line(uuid, text, text, bigint, integer) TO shop_app;
