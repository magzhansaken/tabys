-- =====================================================================
-- 061_requests_money.sql — деньги клиента прямо в заявке.
--
-- Приём донора. Решая «дать ли отсрочку», владелец платформы должен
-- видеть, сколько клиент платит и не просрочен ли он уже. Иначе идёшь
-- смотреть в раздел клиентов и теряешь место в списке заявок.
--
-- Просрочен — подсвечивается красным, кончается на неделе — жёлтым.
-- Это ровно те два состояния, которые меняют решение: просроченному
-- отсрочку дают иначе, чем исправному.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_requests(text, text, uuid);

CREATE OR REPLACE FUNCTION platform_requests(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  id uuid, kind text, payload jsonb, comment text, status text,
  decision_note text, created_at timestamptz, decided_at timestamptz,
  client text, account_id uuid, author text,
  -- Деньги клиента: сколько платит, до какого числа, что ждёт.
  monthly bigint, paid_until timestamptz, days_left integer,
  pending_amount bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tr.id, tr.kind, tr.payload, tr.comment, tr.status,
         tr.decision_note, tr.created_at, tr.decided_at,
         a.name, a.id, pu.full_name,
         coalesce(
           (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
             WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
           coalesce(t.price_month, 0) * 100)::bigint,
         s.paid_until,
         CASE WHEN s.paid_until IS NULL THEN NULL
              ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END,
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'pending'), 0)::bigint
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE (p_status IS NULL OR tr.status = p_status)
     AND (p_role = 'super' OR tr.created_by = p_user)
   ORDER BY tr.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_requests(text, text, uuid) TO shop_app;
