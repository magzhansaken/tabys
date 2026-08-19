-- =====================================================================
-- 080_base_line_shown.sql — счёт должен объяснять сам себя.
--
-- НАЙДЕНО СВЕРКОЙ. Клиент видит «К оплате 9 900 ₸/мес», а в составе
-- счёта одна строка: «Касса №2 — 3 000 ₸». Где остальные 6 900?
--
-- Их нет в списке, потому что ТАРИФ НЕ СТРОКА: он приходит из
-- подписки, а строки — это доплаты сверх него. Устройство разумное,
-- но человек этого не знает: он видит итог, который не сходится с
-- тем, что перед ним.
--
-- То же в панели платформы: владелец открывает состав счёта и видит
-- 3 000 при итоге 9 900.
--
-- Даём функцию, которая возвращает счёт СТРОКАМИ ЦЕЛИКОМ: тариф
-- первой строкой (или своя «Основа», если она заведена), дальше
-- доплаты. Сумма строк равна итогу — счёт объясняет сам себя.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_bill_lines(p_account uuid)
RETURNS TABLE (
  id uuid, kind text, title text, qty integer, unit_price bigint, is_base boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  -- Основа: своя строка, если заведена…
  SELECT pl.id, pl.kind::text, pl.title, pl.qty, pl.unit_price, true
    FROM plan_line pl
   WHERE pl.account_id = p_account AND pl.ends_at IS NULL AND pl.kind = 'base'

  UNION ALL

  -- …иначе тариф подписки, показанный как строка.
  SELECT NULL::uuid, 'base', coalesce(t.name, 'Тариф'), 1,
         (coalesce(t.price_month, 0) * 100)::bigint, true
    FROM subscription s
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE s.account_id = p_account
     AND NOT EXISTS (SELECT 1 FROM plan_line pl
                      WHERE pl.account_id = p_account
                        AND pl.ends_at IS NULL AND pl.kind = 'base')

  UNION ALL

  -- Доплаты и скидки сверх основы.
  SELECT pl.id, pl.kind::text, pl.title, pl.qty, pl.unit_price, false
    FROM plan_line pl
   WHERE pl.account_id = p_account AND pl.ends_at IS NULL AND pl.kind <> 'base'
   ORDER BY 6 DESC, 3;
$$;
GRANT EXECUTE ON FUNCTION platform_bill_lines(uuid) TO shop_app;
