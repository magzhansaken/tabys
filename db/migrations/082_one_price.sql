-- =====================================================================
-- 082_one_price.sql — цена тарифа жила в двух местах.
--
-- НАЙДЕНО СВЕРКОЙ. Владелец меняет цену «Старта» с 6 900 на 8 900,
-- видит «Новые цены применятся к следующим счетам» — и НИЧЕГО НЕ
-- ПРИМЕНЯЕТСЯ. Новые клиенты заводятся по старой цене.
--
-- ПРИЧИНА: цена хранится дважды.
--   platform_settings.price_base — сюда пишет правка в настройках;
--   tariff.price_month           — отсюда берётся счёт клиента.
--
-- Заметить можно только сложив: «я поднял до 8 900, а платят 6 900».
-- И чем дольше платформа работает, тем больше клиентов заведено по
-- цене, которой давно нет.
--
-- Сводим к одному: цена живёт в ПРАЙСЕ ПЛАТФОРМЫ, а тариф берёт её
-- оттуда. Правка прайса теперь и вправду доходит до счетов.
-- =====================================================================

-- Подтягиваем тарифы к прайсу разом: у заведённых раньше цена могла
-- разойтись, и оставлять её незачем.
UPDATE tariff t SET price_month = s.price_base / 100.0
  FROM platform_settings s
 WHERE t.code = 'start' AND t.price_month <> s.price_base / 100.0;

UPDATE tariff t SET price_month = s.price_pro / 100.0
  FROM platform_settings s
 WHERE t.code = 'standard' AND t.price_month <> s.price_pro / 100.0;

-- И дальше держим их вместе: правка прайса меняет тариф сразу.
CREATE OR REPLACE FUNCTION platform_sync_tariff_price()
RETURNS trigger
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tariff SET price_month = NEW.price_base / 100.0
   WHERE code = 'start' AND price_month <> NEW.price_base / 100.0;
  UPDATE tariff SET price_month = NEW.price_pro / 100.0
   WHERE code = 'standard' AND price_month <> NEW.price_pro / 100.0;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS platform_settings_price_sync ON platform_settings;
CREATE TRIGGER platform_settings_price_sync
  AFTER UPDATE OF price_base, price_pro ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION platform_sync_tariff_price();
