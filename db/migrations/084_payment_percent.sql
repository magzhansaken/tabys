-- =====================================================================
-- 084_payment_percent.sql — процент доли на момент оплаты.
--
-- НАЙДЕНО ОПИСЬЮ ПОЛЕЙ. У оплаты хранится partner_bp — доля партнёра
-- в момент, когда оплату подтвердили. Она ЗАМОРОЖЕНА: если процент
-- потом меняли, старая оплата хранит свой.
--
-- Но в кабинет он не доходил. При споре «почему мне начислили 1 035,
-- а не 2 070» ответить нечем: сумма верная, а объяснить её нельзя —
-- сегодня в настройках стоит 30%, и партнёр считает по ним.
--
-- Теперь процент виден рядом с суммой: «партнёру 1 035 ₸ (15%)».
-- =====================================================================
DROP FUNCTION IF EXISTS platform_money(text, text, uuid, integer);

CREATE OR REPLACE FUNCTION platform_money(
  p_status text, p_role text, p_user uuid, p_days integer DEFAULT 90)
RETURNS TABLE (
  partner_bp integer,
  declared_by text,
  id uuid, account_id uuid, client text, partner text, partner_id uuid,
  amount bigint, months integer, method text, comment text,
  status text, reject_reason text,
  period_from timestamptz, period_to timestamptz,
  partner_share bigint, platform_share bigint,
  created_at timestamptz, approved_at timestamptz,
  approved_by_name text,        -- кто подтвердил: «кто это пропустил»
  will_extend_to timestamptz,   -- что будет, если подтвердить
  will_partner_share bigint,
  sum_amount bigint, sum_partner bigint, sum_platform bigint, cnt bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH picked AS (
    SELECT tp.*, a.name AS client_name, pu.full_name AS partner_name,
           ap.full_name AS approver_name,
           coalesce(pu.commission_bp, 0) AS bp,
           -- Считаем тем же способом, что и подтверждение: от большей
           -- из дат «сегодня» и конца оплаченного периода.
           greatest(coalesce(s.paid_until, now()), now())
             + (tp.months || ' months')::interval AS extend_to
      FROM tenant_payment tp
      JOIN account a ON a.id = tp.account_id
      LEFT JOIN platform_user pu ON pu.id = tp.partner_id
      LEFT JOIN platform_user ap ON ap.id = tp.approved_by
      LEFT JOIN subscription s ON s.account_id = tp.account_id
      LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
     WHERE (p_status IS NULL OR tp.status::text = p_status)
       AND (p_role = 'super' OR tp.partner_id = p_user)
       AND coalesce(tc.is_demo, false) = false
       AND tp.created_at > now() - (p_days || ' days')::interval
  )
  SELECT p.partner_bp, p.declared_by, p.id, p.account_id, p.client_name, p.partner_name, p.partner_id,
         p.amount, p.months, p.method, p.comment,
         p.status::text, p.reject_reason,
         p.period_from, p.period_to,
         p.partner_share, p.platform_share,
         p.created_at, p.approved_at,
         p.approver_name,
         CASE WHEN p.status = 'pending' THEN p.extend_to END,
         CASE WHEN p.status = 'pending'
              THEN round(p.amount * p.bp / 10000.0)::bigint END,
         sum(p.amount) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.partner_share) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.platform_share) FILTER (WHERE p.status = 'approved') OVER (),
         count(*) OVER ()
    FROM picked p
   ORDER BY (p.status <> 'pending'), p.created_at DESC
   LIMIT 300;
$$;
GRANT EXECUTE ON FUNCTION platform_money(text, text, uuid, integer) TO shop_app;
