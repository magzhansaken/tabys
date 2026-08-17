-- =====================================================================
-- 056_clients_table.sql — раздел «Клиенты» как у донора: таблица.
--
-- Их раскладка взята точно: пять чисел сверху, поиск, порядок,
-- отбор по партнёру, семь вкладок состояний, группировка по партнёру,
-- таблица с семью столбцами.
--
-- ЧТО ЗДЕСЬ ЛУЧШЕ: считает всё база одним заходом. У них пять чисел
-- сверху приходили в одном ответе со списком, но порядок и группировка
-- делались в браузере — при сотне клиентов это заметно, а при пятистах
-- уже больно.
--
-- ЧЕТЫРЕ ПОРЯДКА, как у них:
--   due     — сначала просроченные: где деньги уже теряются;
--   price   — сначала дорогие: кем нельзя рисковать;
--   revenue — по выручке магазина: живёт ли клиент;
--   name    — по названию: когда ищешь конкретного.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_clients_filtered(text, uuid, text, text, uuid);

CREATE OR REPLACE FUNCTION platform_clients_filtered(
  p_role text, p_user uuid,
  p_q text DEFAULT NULL, p_filter text DEFAULT 'all',
  p_partner text DEFAULT 'all', p_sort text DEFAULT 'due')
RETURNS TABLE (
  id uuid, name text, phone text, status text, city text,
  owner_name text, owner_phone text, deal_stage text, deal_note text,
  touched_at timestamptz, is_demo boolean,
  partner_id uuid, partner_name text, partner_bp integer,
  paid_until timestamptz, days_left integer,
  tariff_name text, monthly bigint,
  revenue_30d numeric, stores bigint, registers bigint,
  pending_payments bigint,          -- сколько оплат ждёт подтверждения
  state text,                       -- состояние для вкладки и значка
  created_at timestamptz, total_count bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT a.id, a.name, a.phone, a.status::text AS acc_status, a.created_at,
           tc.city, tc.owner_name, tc.owner_phone, tc.deal_stage, tc.deal_note,
           tc.touched_at, coalesce(tc.is_demo, false) AS is_demo,
           tc.partner_id, pu.full_name AS partner_name,
           coalesce(pu.commission_bp, 0) AS partner_bp,
           s.paid_until,
           CASE WHEN s.paid_until IS NULL THEN NULL
                ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END AS days_left,
           t.name AS tariff_name,
           coalesce(
             (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
             coalesce(t.price_month, 0) * 100)::bigint AS monthly,
           coalesce((SELECT sum(sl.total) FROM sale sl
              WHERE sl.account_id = a.id AND sl.return_of_id IS NULL
                AND sl.created_at > now() - interval '30 days'), 0) AS revenue_30d,
           (SELECT count(*) FROM store st WHERE st.account_id = a.id) AS stores,
           (SELECT count(*) FROM cash_register cr WHERE cr.account_id = a.id) AS registers,
           (SELECT count(*) FROM tenant_payment tp
             WHERE tp.account_id = a.id AND tp.status = 'pending') AS pending_payments
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN platform_user pu ON pu.id = tc.partner_id
      LEFT JOIN subscription s ON s.account_id = a.id
      LEFT JOIN tariff t ON t.id = s.tariff_id
     WHERE a.deleted_at IS NULL
       AND (p_role = 'super' OR tc.partner_id = p_user)
  ), st AS (
    -- Состояние клиента одним словом. Порядок проверок важен: сначала
    -- то, что требует действия, потом спокойное.
    SELECT b.*, CASE
      WHEN b.acc_status = 'suspended'          THEN 'suspended'   -- отключён
      WHEN b.pending_payments > 0              THEN 'pending_pay' -- ждёт подтверждения
      WHEN b.paid_until IS NULL                THEN 'setup'       -- настройка
      WHEN b.paid_until < now()                THEN 'expired'     -- срок вышел
      WHEN b.acc_status = 'trial'
       AND b.partner_id IS NULL                THEN 'approval'    -- ждёт одобрения
      ELSE 'active' END AS state
      FROM base b
  ), picked AS (
    SELECT * FROM st
     WHERE (p_filter = 'all' OR state = p_filter)
       AND (p_partner = 'all'
            OR (p_partner = 'none' AND partner_id IS NULL)
            OR partner_id::text = p_partner)
       AND (p_q IS NULL OR p_q = '' OR
            name ILIKE '%'||p_q||'%' OR owner_name ILIKE '%'||p_q||'%'
            OR city ILIKE '%'||p_q||'%' OR partner_name ILIKE '%'||p_q||'%'
            OR phone_tail(phone) = phone_tail(p_q)
            OR phone_tail(owner_phone) = phone_tail(p_q))
  )
  SELECT p.id, p.name, p.phone, p.state, p.city,
         p.owner_name, p.owner_phone, p.deal_stage, p.deal_note,
         p.touched_at, p.is_demo,
         p.partner_id, p.partner_name, p.partner_bp,
         p.paid_until, p.days_left, p.tariff_name, p.monthly,
         p.revenue_30d, p.stores, p.registers, p.pending_payments,
         p.state, p.created_at,
         count(*) OVER () AS total_count
    FROM picked p
   ORDER BY
     CASE p_sort
       -- Сначала просроченные: где деньги уже теряются.
       WHEN 'due'     THEN NULL END,
     CASE WHEN p_sort = 'due' THEN (p.days_left IS NULL) END,
     CASE WHEN p_sort = 'due' THEN p.days_left END,
     -- Сначала дорогие: этими клиентами нельзя рисковать.
     CASE WHEN p_sort = 'price' THEN -p.monthly END,
     -- По выручке магазина: живёт ли клиент вообще.
     CASE WHEN p_sort = 'revenue' THEN -p.revenue_30d END,
     CASE WHEN p_sort = 'name' THEN p.name END,
     p.created_at DESC
   LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_filtered(text, uuid, text, text, text, text) TO shop_app;

/** Пять чисел сверху и счётчики вкладок — одним заходом. */
DROP FUNCTION IF EXISTS platform_clients_counts(text, uuid);

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
           coalesce(
             (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
             coalesce(t.price_month, 0) * 100)::bigint AS monthly
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
