-- =====================================================================
-- 074_snapshot_split.sql — «работают» и «на пробном» пересекались.
--
-- НАЙДЕНО СВЕРКОЙ ЧЕСТНОСТИ ЦИФР. В сводке стояло:
--   всего магазинов 3 · работают 3 · на пробном 1
--
-- Третий сидел в ОБЕИХ карточках: срок у него не вышел (значит
-- «работает»), и он не платил ни разу (значит «на пробном»).
--
-- Человек складывает 3 + 1 = 4 при трёх магазинах — и перестаёт
-- доверять сводке целиком, потому что не понимает, где ошибся.
--
-- Разведено: «платят» — срок не вышел И была подтверждённая оплата;
-- «на пробном» — срок не вышел, но оплат не было. Теперь
-- платят + пробные + просрочены = всего.
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_snapshot()
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO platform_daily (day, tenants, active, trial, expired, mrr, taken_at)
  SELECT current_date,
         count(*),
         -- ПЛАТЯТ: срок не вышел И была хоть одна подтверждённая
         -- оплата. Раньше сюда попадали и пробные — «работают 3» при
         -- трёх магазинах, из которых платят двое. Человек складывал
         -- «работают» и «на пробном» и получал больше, чем всего.
         count(*) FILTER (WHERE s.paid_until > now() AND EXISTS (
           SELECT 1 FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'approved')),
         -- НА ПРОБНОМ: срок не вышел, но не платил ни разу.
         count(*) FILTER (WHERE s.paid_until > now() AND NOT EXISTS (
           SELECT 1 FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'approved')),
         count(*) FILTER (WHERE s.paid_until <= now()),
         coalesce(sum(platform_monthly(a.id))
           FILTER (WHERE s.paid_until > now()), 0),
         now()
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
  ON CONFLICT (day) DO UPDATE SET
    tenants = EXCLUDED.tenants, active = EXCLUDED.active,
    trial = EXCLUDED.trial, expired = EXCLUDED.expired,
    mrr = EXCLUDED.mrr, taken_at = now();
$$;
GRANT EXECUTE ON FUNCTION platform_snapshot() TO shop_app;
