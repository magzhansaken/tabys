-- =====================================================================
-- 085_client_note.sql — общая заметка о клиенте писалась и пропадала.
--
-- НАЙДЕНО ОПИСЬЮ ПОЛЕЙ. У карточки клиента есть поле note — заметка
-- о самом клиенте, отдельная от заметки о сделке.
--
-- Правка её сохраняет: пишешь «владелец глухой на левое ухо, звонить
-- громче» — в базе появляется. А прочитать НЕГДЕ: ни в списке
-- клиентов, ни в карточке, ни в воронке.
--
-- Человек записал важное и потерял. В следующий раз он запишет это в
-- тетрадку — и панель перестанет быть местом, где хранят знание о
-- клиентах.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_clients_filtered(text, uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION platform_clients_filtered(
  p_role text, p_user uuid,
  p_q text DEFAULT NULL, p_filter text DEFAULT 'all',
  p_partner text DEFAULT 'all', p_sort text DEFAULT 'due')
RETURNS TABLE (
  note text,
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
           tc.note,
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
            -- По телефону ищем ТОЛЬКО если в запросе вообще есть
            -- цифры. Иначе phone_tail('Астана') даёт пустоту, а она
            -- совпадает с пустотой у клиента без телефона — и отбор
            -- пропускает всех подряд.
            OR (phone_tail(p_q) <> '' AND (
                  phone_tail(phone) = phone_tail(p_q)
               OR phone_tail(owner_phone) = phone_tail(p_q))))
  )
  SELECT p.note, p.id, p.name, p.phone, p.state, p.city,
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
