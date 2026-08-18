-- =====================================================================
-- 068_monthly_base.sql — счёт складывается из тарифа И строк.
--
-- НАЙДЕНО СВЕРКОЙ НА ЖИВЫХ ДАННЫХ. Правило было такое: если у клиента
-- есть хоть одна строка счёта — считаем только строки, тариф не
-- берём. Задумка понятна: строка «Основа» заменяет тариф.
--
-- НО: партнёр попросил вторую кассу, владелец одобрил — появилась
-- строка «Касса №2» на 2 500. Основы среди строк НЕТ, её никто не
-- заводил. И месячный счёт клиента стал 2 500 вместо 6 900 + 2 500.
--
-- Клиент платит вчетверо меньше, и заметить это можно только сложив
-- цифры руками. Худший вид ошибки: всё выглядит правильно.
--
-- Правильное правило: тариф берётся, ЕСЛИ СРЕДИ СТРОК НЕТ ОСНОВЫ.
-- Строка «Основа» его заменяет — для этого она и заводится.
--
-- Расчёт вынесен в ОДНУ функцию: он повторялся в пяти местах, и
-- поправить его в четырёх из пяти — вопрос времени.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_monthly(p_account uuid)
RETURNS bigint
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT
    -- Доплаты и скидки: всё, кроме основы.
    coalesce((SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = p_account AND pl.ends_at IS NULL
                 AND pl.kind <> 'base'), 0)
    +
    -- Основа: своя строка, если она есть, иначе цена тарифа.
    coalesce(
      (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
        WHERE pl.account_id = p_account AND pl.ends_at IS NULL
          AND pl.kind = 'base'),
      (SELECT coalesce(t.price_month, 0) * 100 FROM subscription s
         LEFT JOIN tariff t ON t.id = s.tariff_id
        WHERE s.account_id = p_account),
      0)::bigint;
$$;
GRANT EXECUTE ON FUNCTION platform_monthly(uuid) TO shop_app;


-- ── platform_clients_filtered: расчёт через platform_monthly ──
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
  pending_payments bigint,
  state text,
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
           platform_monthly(a.id)::bigint AS monthly,
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
    SELECT b.*, CASE
      WHEN b.acc_status = 'suspended'          THEN 'suspended'
      WHEN b.pending_payments > 0              THEN 'pending_pay'
      WHEN b.paid_until IS NULL                THEN 'setup'
      WHEN b.paid_until < now()                THEN 'expired'
      WHEN b.acc_status = 'trial'
       AND b.partner_id IS NULL                THEN 'approval'
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
     -- У кого срок не начат — в конец, а не вперемешку.
     CASE WHEN p_sort = 'due' THEN (p.days_left IS NULL) END,
     CASE WHEN p_sort = 'due' THEN p.days_left END,
     CASE WHEN p_sort = 'price' THEN -p.monthly END,
     CASE WHEN p_sort = 'revenue' THEN -p.revenue_30d END,
     -- ДОБОР ПО НАЗВАНИЮ, ПО-РУССКИ. Список обновляется сам каждые
     -- 30 секунд: без устойчивого добора строки с одинаковым сроком
     -- прыгают, и человек тянется к строке, которая уехала.
     p.name COLLATE "ru-RU-x-icu"
   LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_filtered(text, uuid, text, text, text, text) TO shop_app;

-- ── platform_requests: расчёт через platform_monthly ──
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
         platform_monthly(a.id)::bigint,
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

-- ── platform_partners_full: расчёт через platform_monthly ──
CREATE OR REPLACE FUNCTION platform_partners_full(p_days integer DEFAULT 30)
RETURNS TABLE (
  id uuid, full_name text, email text, phone text, role text,
  commission_bp integer, is_active boolean,
  last_login_at timestamptz, created_at timestamptz,
  clients bigint, active_clients bigint, lost_clients bigint,
  earned_period bigint, earned_total bigint,
  brought_period bigint, brought_total bigint,
  mrr bigint, days_silent integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu.id, pu.full_name, pu.email, pu.phone, pu.role::text,
         pu.commission_bp, pu.is_active, pu.last_login_at, pu.created_at,

         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND a.deleted_at IS NULL),
         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
            JOIN subscription s ON s.account_id = a.id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND a.deleted_at IS NULL AND s.paid_until > now()),
         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
            LEFT JOIN subscription s ON s.account_id = a.id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND (a.deleted_at IS NOT NULL
                  OR s.paid_until < now() - interval '30 days')),

         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'
              AND tp.approved_at > now() - (p_days || ' days')::interval), 0),
         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'), 0),

         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'
              AND tp.approved_at > now() - (p_days || ' days')::interval), 0),
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'), 0),

         coalesce((SELECT sum(platform_monthly(a.id))
           FROM tenant_card tc
           JOIN account a ON a.id = tc.account_id
           JOIN subscription s ON s.account_id = a.id
           LEFT JOIN tariff t ON t.id = s.tariff_id
          WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
            AND a.deleted_at IS NULL AND s.paid_until > now()), 0),

         CASE WHEN pu.last_login_at IS NULL THEN NULL
              ELSE extract(day FROM now() - pu.last_login_at)::int END

    FROM platform_user pu
   -- ВСЕ люди платформы, а не только партнёры: раздел отвечает на
   -- вопрос «кто имеет доступ», и забытая учётка совладельца должна
   -- быть видна.
   WHERE pu.deleted_at IS NULL
   ORDER BY (pu.role <> 'super'),        -- владельцы первыми
            (SELECT coalesce(sum(tp.amount), 0) FROM tenant_payment tp
              WHERE tp.partner_id = pu.id AND tp.status = 'approved'
                AND tp.approved_at > now() - (p_days || ' days')::interval) DESC,
            pu.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION platform_partners_full(integer) TO shop_app;
