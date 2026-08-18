-- =====================================================================
-- 069_monthly_rest.sql — оставшиеся три места с тем же расчётом.
--
-- В 068 расчёт был исправлен в трёх функциях. Проверка показала, что
-- он живёт ещё в трёх:
--
--   platform_clients_counts — «Доход в месяц» в числах над таблицей;
--   platform_funnel         — сумма на этапе воронки;
--   platform_snapshot       — ЕЖЕДНЕВНЫЙ СРЕЗ.
--
-- Последнее хуже всех. Срез пишется раз в сутки и больше НЕ
-- пересчитывается: каждый день с неверной цифрой остаётся в истории
-- навсегда, и график дохода в сводке врёт задним числом.
--
-- Это ровно то, ради чего расчёт и выносился в одну функцию: пока он
-- переписан в шести местах, шестое всегда найдётся позже.
-- =====================================================================

-- ── platform_clients_counts ──
CREATE OR REPLACE FUNCTION platform_clients_counts(p_role text, p_user uuid)
RETURNS TABLE (
  total bigint, active bigint, pending_pay bigint, expired bigint,
  approval bigint, setup bigint, suspended bigint, demo bigint,
  mrr bigint, nobody bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT a.status::text AS acc_status, s.paid_until, tc.partner_id,
           coalesce(tc.is_demo, false) AS is_demo,
           (SELECT count(*) FROM tenant_payment tp
             WHERE tp.account_id = a.id AND tp.status = 'pending') AS pend,
           platform_monthly(a.id)::bigint AS monthly
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN subscription s ON s.account_id = a.id
      LEFT JOIN tariff t ON t.id = s.tariff_id
     WHERE a.deleted_at IS NULL AND (p_role = 'super' OR tc.partner_id = p_user)
  ), w AS (
    SELECT *, CASE
      WHEN acc_status = 'suspended'        THEN 'suspended'
      WHEN pend > 0                        THEN 'pending_pay'
      WHEN paid_until IS NULL              THEN 'setup'
      WHEN paid_until < now()              THEN 'expired'
      WHEN acc_status = 'trial' AND partner_id IS NULL THEN 'approval'
      ELSE 'active' END AS state
      FROM b
  )
  SELECT count(*),
         count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (WHERE state = 'pending_pay'),
         count(*) FILTER (WHERE state = 'expired'),
         count(*) FILTER (WHERE state = 'approval'),
         count(*) FILTER (WHERE state = 'setup'),
         count(*) FILTER (WHERE state = 'suspended'),
         count(*) FILTER (WHERE is_demo),
         -- Доход в месяц: только по тем, у кого срок не вышел. Учебные
         -- в деньги не идут никогда.
         coalesce(sum(monthly) FILTER (WHERE paid_until > now() AND NOT is_demo), 0),
         count(*) FILTER (WHERE partner_id IS NULL AND NOT is_demo)
    FROM w;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_counts(text, uuid) TO shop_app;

-- ── platform_funnel ──
CREATE OR REPLACE FUNCTION platform_funnel(p_role text, p_user uuid, p_partner uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, city text, owner_name text, owner_phone text,
  stage text, stage_manual boolean, derived_stage text,
  deal_note text, touched_at timestamptz, days_silent integer,
  paid_until timestamptz, days_left integer, monthly bigint,
  partner_id uuid, partner_name text, created_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, tc.city, tc.owner_name, tc.owner_phone,
         -- Ручной этап сильнее выведенного: человек знает больше базы.
         CASE WHEN coalesce(tc.stage_manual, false) THEN coalesce(tc.deal_stage, 'new')
              ELSE d.derived END,
         coalesce(tc.stage_manual, false),
         d.derived,
         tc.deal_note, tc.touched_at,
         -- Сколько дней молчим. Главный столбец воронки: сделка
         -- умирает не от отказа, а от того, что о ней забыли.
         CASE WHEN tc.touched_at IS NULL THEN NULL
              ELSE extract(day FROM now() - tc.touched_at)::int END,
         s.paid_until,
         CASE WHEN s.paid_until IS NULL THEN NULL
              ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END,
         platform_monthly(a.id)::bigint,
         tc.partner_id, pu.full_name, a.created_at
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tc.partner_id
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
    CROSS JOIN LATERAL (
      SELECT CASE
        -- Порядок важен: сначала самые определённые факты.
        WHEN EXISTS (SELECT 1 FROM tenant_payment tp
                      WHERE tp.account_id = a.id AND tp.status = 'approved') THEN 'paid'
        WHEN a.deleted_at IS NOT NULL OR a.status = 'suspended' THEN 'lost'
        WHEN s.paid_until > now() THEN 'trial'
        WHEN tc.touched_at IS NOT NULL THEN 'contacted'
        ELSE 'new' END AS derived
    ) d
   WHERE a.deleted_at IS NULL
     AND coalesce(tc.is_demo, false) = false      -- учебные не в воронке
     AND (p_role = 'super' OR tc.partner_id = p_user)
     AND (p_partner IS NULL OR tc.partner_id = p_partner)
   ORDER BY tc.touched_at NULLS FIRST, a.created_at DESC
   LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_funnel(text, uuid, uuid) TO shop_app;

-- ── platform_snapshot ──
CREATE OR REPLACE FUNCTION platform_snapshot()
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO platform_daily (day, tenants, active, trial, expired, mrr, taken_at)
  SELECT current_date,
         count(*),
         count(*) FILTER (WHERE s.paid_until > now()),
         count(*) FILTER (WHERE a.status = 'trial'),
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
