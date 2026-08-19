-- =====================================================================
-- 078_series_gaps.sql — день без снимка не равен нулю.
--
-- НАЙДЕНО СВЕРКОЙ. Снимок пишется, когда открывают панель или в 03:00
-- планировщиком. Если не было ни того ни другого — дня в истории нет.
--
-- База подставляла на его место НОЛЬ, и график падал в пол:
--   30 июля  6 900 ₸
--   31 июля      0 ₸   ← панель не открывали
--   ...
--   16 авг   6 900 ₸
--
-- Человек видит обвал дохода и идёт разбираться, что случилось. А
-- клиенты никуда не девались и деньги шли — просто снимок не сняли.
--
-- Теперь база отдаёт ПУСТОТУ, а кабинет подставляет значение
-- предыдущего дня и помечает такую точку. Приход денег за день не
-- повторяется: его не было, и ноль тут честен.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_summary_series(integer);

CREATE OR REPLACE FUNCTION platform_summary_series(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date, tenants integer, active integer, trial integer, expired integer,
  mrr bigint, paid_count integer, paid_amount bigint, partner_share bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH days AS (
    SELECT generate_series(current_date - (p_days - 1), current_date, '1 day')::date AS d
  ), pays AS (
    SELECT tp.approved_at::date AS d,
           count(*)::int AS cnt,
           sum(tp.amount) AS amt,
           sum(tp.partner_share) AS shr
      FROM tenant_payment tp
      LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
     WHERE tp.status = 'approved'
       AND tp.approved_at >= current_date - (p_days - 1)
       AND coalesce(tc.is_demo, false) = false
     GROUP BY 1
  )
  SELECT d.d,
         -- ПУСТОТУ НЕ ПРЯЧЕМ ЗА НОЛЬ: день без снимка и день с нулём
         -- клиентов — разные вещи. Ноль здесь означал бы «все ушли», а
         -- на деле просто не заходили в панель. Кабинет подставит
         -- значение предыдущего дня.
         pd.tenants, pd.active, pd.trial, pd.expired, pd.mrr,
         coalesce(p.cnt, 0), coalesce(p.amt, 0), coalesce(p.shr, 0)
    FROM days d
    LEFT JOIN platform_daily pd ON pd.day = d.d
    LEFT JOIN pays p ON p.d = d.d
   ORDER BY d.d;
$$;
GRANT EXECUTE ON FUNCTION platform_summary_series(integer) TO shop_app;
