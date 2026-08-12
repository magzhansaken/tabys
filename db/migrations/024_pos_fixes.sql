-- =====================================================================
-- 024_pos_fixes.sql — Часть 16: починка расчёта смены.
--
-- Сквозной тест кассы (part16.pos-app.e2e) поймал два бага shift_totals,
-- которые не проявлялись в онлайн-тестах, потому что там платили без сдачи
-- и без размена:
--   1. cash = sum(paid_cash) БЕЗ вычета сдачи: покупатель дал 5000 при чеке
--      1025 — в «наличных за смену» оседало 5000, а не 1025. Z-отчёт
--      показывал недостачу размером со сдачу.
--   2. Размен попадал в expected_cash дважды: полем смены opening_float
--      И операцией kind='opening_float' в внесениях.
-- =====================================================================

CREATE OR REPLACE FUNCTION shift_totals(p_account uuid, p_shift uuid)
RETURNS TABLE (receipts integer, cash numeric, card numeric, qr numeric, credit numeric,
               returns_sum numeric, deposits numeric, withdrawals numeric,
               opening_float numeric, expected_cash numeric, revenue numeric, profit numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM shift WHERE id = p_shift AND account_id = p_account),
  sales AS (
    SELECT count(*)::integer AS n,
           -- наличными В КАССЕ осталась оплата минус сдача
           coalesce(sum(paid_cash - change_given), 0) AS cash,
           coalesce(sum(paid_card), 0) AS card,
           coalesce(sum(paid_qr), 0) AS qr, coalesce(sum(paid_credit), 0) AS credit,
           coalesce(sum(total), 0) AS revenue, coalesce(sum(profit), 0) AS profit
      FROM sale WHERE shift_id = p_shift AND status = 'completed' AND return_of_id IS NULL
  ),
  rets AS (
    -- онлайн-возврат хранит положительные суммы, офлайн — отрицательный чек;
    -- abs() приводит обе схемы к одному знаку
    SELECT coalesce(sum(abs(total)), 0) AS ret, coalesce(sum(abs(paid_cash)), 0) AS ret_cash
      FROM sale WHERE shift_id = p_shift AND return_of_id IS NOT NULL AND status = 'completed'
  ),
  ops AS (
    -- размен НЕ входит во внесения: он уже отражён полем смены opening_float
    SELECT coalesce(sum(amount) FILTER (WHERE kind = 'deposit'), 0) AS dep,
           coalesce(sum(amount) FILTER (WHERE kind IN ('withdrawal','collection')), 0) AS wdr
      FROM cash_operation WHERE shift_id = p_shift
  )
  SELECT sales.n, sales.cash, sales.card, sales.qr, sales.credit,
         rets.ret, ops.dep, ops.wdr, s.opening_float,
         s.opening_float + sales.cash + ops.dep - ops.wdr - rets.ret_cash,
         sales.revenue, sales.profit
    FROM s, sales, rets, ops;
$$;
GRANT EXECUTE ON FUNCTION shift_totals(uuid,uuid) TO shop_app;
