-- =====================================================================
-- 085_request_decider.sql — кто решил заявку.
--
-- НАЙДЕНО ОПИСЬЮ ПОЛЕЙ. У оплаты видно «подтвердил Магжан Сакен,
-- 19 авг 13:44». У заявки — только «отказано» и причина, а КТО отказал,
-- нет. Хотя поле в базе есть и заполняется.
--
-- Когда владельцев платформы несколько, вопрос «кто это решил»
-- возникает первым. У оплат он закрыт, заявки пропустили.
--
-- Партнёр получил отказ и хочет переспросить — не знает, к кому идти.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_requests(text, text, uuid);

CREATE OR REPLACE FUNCTION platform_requests(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  decided_by_name text,
  id uuid, kind text, payload jsonb, comment text, status text,
  decision_note text, created_at timestamptz, decided_at timestamptz,
  client text, account_id uuid, author text,
  -- Деньги клиента: сколько платит, до какого числа, что ждёт.
  monthly bigint, paid_until timestamptz, days_left integer,
  pending_amount bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu2.full_name, tr.id, tr.kind, tr.payload, tr.comment, tr.status,
         tr.decision_note, tr.created_at, tr.decided_at,
         a.name, a.id, pu.full_name,
         platform_monthly(a.id)::bigint,
         s.paid_until,
         CASE WHEN s.paid_until IS NULL THEN NULL
              ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END,
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'pending'), 0)::bigint
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN platform_user pu2 ON pu2.id = tr.decided_by
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE (p_status IS NULL OR tr.status = p_status)
     AND (p_role = 'super' OR tr.created_by = p_user)
   ORDER BY tr.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_requests(text, text, uuid) TO shop_app;
