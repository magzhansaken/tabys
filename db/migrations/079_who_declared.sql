-- =====================================================================
-- 079_who_declared.sql — кто отметил оплату и кому идёт доля.
--
-- НАЙДЕНО СВЕРКОЙ ПУТИ КЛИЕНТА. Владелец магазина сам нажал «Я
-- оплатил» — а в ленте платформы написано «отметил Ерлан».
--
-- ПРИЧИНА: поле partner_id у оплаты отвечало на ДВА разных вопроса.
--   кому начислить долю — тут партнёр клиента верен всегда:
--     он привёл клиента, доля его, кто нажал кнопку неважно;
--   кто отметил оплату — а тут неверно: отметил клиент.
--
-- Одно поле на два смысла — отсюда и путаница. Разводим: доля
-- остаётся за partner_id, а «кто отметил» получает своё поле.
--
-- Зачем это нужно. Когда через полгода разбирают спорную оплату,
-- первый вопрос — «кто её провёл». Ответ «Ерлан» отправит разбираться
-- к партнёру, который её не проводил.
-- =====================================================================
ALTER TABLE tenant_payment
  ADD COLUMN IF NOT EXISTS declared_by text;   -- 'client' | 'partner' | 'super'

COMMENT ON COLUMN tenant_payment.declared_by IS
  'Кто отметил оплату. Доля всё равно идёт партнёру клиента — это partner_id.';

-- Заведённым раньше: если партнёр есть, считаем что отметил он.
UPDATE tenant_payment SET declared_by = CASE
  WHEN partner_id IS NULL THEN 'super' ELSE 'partner' END
 WHERE declared_by IS NULL;

-- Дописка к 079: функция оплат отдаёт, КТО отметил.
DROP FUNCTION IF EXISTS platform_payments(text, text, uuid);

CREATE OR REPLACE FUNCTION platform_payments(
  p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  declared_by text,
  id uuid, amount bigint, months integer, method text, comment text,
  status text, reject_reason text, created_at timestamptz, approved_at timestamptz,
  partner_share bigint, platform_share bigint,
  client text, account_id uuid, partner text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT tp.declared_by, tp.id, tp.amount, tp.months, tp.method, tp.comment,
         tp.status::text, tp.reject_reason, tp.created_at, tp.approved_at,
         tp.partner_share, tp.platform_share,
         a.name, a.id, pu.full_name
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN platform_user pu ON pu.id = tp.partner_id
   WHERE (p_status IS NULL OR tp.status::text = p_status)
     AND (p_role = 'super' OR tp.partner_id = p_user)
   ORDER BY tp.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_payments(text, text, uuid) TO shop_app;

-- Дописка к 079: список денег отдаёт, КТО отметил оплату.
-- Правил platform_payments, а список берёт из platform_money — цифра
-- «отметил Ерлан» так и стояла у оплаты, которую сделал сам клиент.
DROP FUNCTION IF EXISTS platform_money(text, text, uuid, integer);

CREATE OR REPLACE FUNCTION platform_money(
  p_status text, p_role text, p_user uuid, p_days integer DEFAULT 90)
RETURNS TABLE (
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
  SELECT p.declared_by, p.id, p.account_id, p.client_name, p.partner_name, p.partner_id,
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
