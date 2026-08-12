-- =====================================================================
-- 025_consultants.sql — Часть 18: процент консультанта.
--
-- UMAG привязывает консультанта к продаже «чтобы вести учёт и статистику» —
-- и всё: посчитать зарплату продавцу владелец должен сам в Excel.
-- Мы добавляем процент и считаем «к выплате» за период автоматически.
-- Возвраты вычитаются из базы комиссии: продал и приняли обратно — процента нет.
-- =====================================================================
ALTER TABLE consultant ADD COLUMN IF NOT EXISTS commission_percent numeric(5,2) NOT NULL DEFAULT 0;

-- Отчёт по консультантам: чеки, выручка, возвраты по их чекам, комиссия.
CREATE OR REPLACE FUNCTION consultant_report(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (consultant_id uuid, name text, commission_percent numeric,
               receipts integer, revenue numeric, refunds numeric, base numeric, commission numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH sales AS (
    SELECT s.consultant_id AS cid, count(*)::integer AS n, coalesce(sum(s.total),0) AS rev
      FROM sale s
     WHERE s.account_id = p_account AND s.status IN ('completed','returned')
       AND s.return_of_id IS NULL AND s.consultant_id IS NOT NULL
       AND s.completed_at >= p_from AND s.completed_at < p_to
     GROUP BY s.consultant_id
  ),
  refs AS (
    -- возврат сам не несёт консультанта: берём его из исходного чека
    SELECT orig.consultant_id AS cid, coalesce(sum(abs(r.total)),0) AS ret
      FROM sale r JOIN sale orig ON orig.id = r.return_of_id
     WHERE r.account_id = p_account AND r.status = 'completed'
       AND orig.consultant_id IS NOT NULL
       AND r.completed_at >= p_from AND r.completed_at < p_to
     GROUP BY orig.consultant_id
  )
  SELECT c.id, c.name, c.commission_percent,
         coalesce(sales.n, 0), coalesce(sales.rev, 0), coalesce(refs.ret, 0),
         greatest(coalesce(sales.rev,0) - coalesce(refs.ret,0), 0) AS base,
         round(greatest(coalesce(sales.rev,0) - coalesce(refs.ret,0), 0)
               * c.commission_percent / 100, 2) AS commission
    FROM consultant c
    LEFT JOIN sales ON sales.cid = c.id
    LEFT JOIN refs  ON refs.cid  = c.id
   WHERE c.account_id = p_account AND c.deleted_at IS NULL
   ORDER BY base DESC;
$$;
GRANT EXECUTE ON FUNCTION consultant_report(uuid,timestamptz,timestamptz) TO shop_app;
