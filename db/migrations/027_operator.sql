-- =====================================================================
-- 027_operator.sql — Часть 20: операторская админка (владелец SaaS).
--
-- Данные всех аккаунтов закрыты RLS — и это правильно. Оператор ходит
-- через SECURITY DEFINER-функции: доступ ровно к тому набору полей,
-- который нужен для поддержки и биллинга, ни строкой больше. Авторизация
-- оператора — на HTTP-слое ключом OPERATOR_KEY (как заявки части 19).
--
-- Метрики — стандарт SaaS + реальность Казахстана: оплата часто приходит
-- переводом на Kaspi, поэтому главный инструмент — ручное продление
-- с фиксацией платежа в billing_move (аудит: кто, когда, сколько, зачем).
-- =====================================================================

-- ---------- Сводка ----------
CREATE OR REPLACE FUNCTION operator_overview()
RETURNS TABLE (
  accounts_total integer, new_7d integer,
  trials integer, paying integer, frozen integer, readonly_cnt integer,
  mrr numeric,                       -- сумма зафиксированных цен активных подписок
  alive_7d integer,                  -- аккаунты с продажами за 7 дней («дышат»)
  leads_new integer,
  payments_30d numeric               -- поступления за 30 дней (topup)
) SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT count(*)::int FROM account WHERE deleted_at IS NULL),
    (SELECT count(*)::int FROM account WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'),
    (SELECT count(*)::int FROM subscription WHERE status = 'trial'),
    (SELECT count(*)::int FROM subscription WHERE status = 'active'),
    (SELECT count(*)::int FROM subscription WHERE status = 'frozen'),
    (SELECT count(*)::int FROM subscription WHERE status = 'readonly'),
    (SELECT coalesce(sum(price_locked), 0) FROM subscription WHERE status = 'active'),
    (SELECT count(DISTINCT account_id)::int FROM sale
      WHERE completed_at > now() - interval '7 days' AND status = 'completed'),
    (SELECT count(*)::int FROM lead WHERE status = 'new'),
    (SELECT coalesce(sum(amount), 0) FROM billing_move
      WHERE kind = 'topup' AND created_at > now() - interval '30 days');
$$;

-- ---------- Список аккаунтов ----------
CREATE OR REPLACE FUNCTION operator_accounts(p_q text DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, phone text, lang text, created_at timestamptz,
  sub_status text, tariff text, paid_until date, balance numeric,
  receipts_7d integer, last_sale_at timestamptz, devices integer
) SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, a.phone, a.lang, a.created_at,
         s.status::text, t.name,
         s.paid_until, coalesce(s.balance, 0),
         coalesce(sl.n, 0)::int, sl.last_at,
         coalesce(d.n, 0)::int
    FROM account a
    LEFT JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, max(completed_at) AS last_at FROM sale
       WHERE account_id = a.id AND status = 'completed'
         AND completed_at > now() - interval '7 days') sl ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM device WHERE account_id = a.id AND paired_at IS NOT NULL) d ON true
   WHERE a.deleted_at IS NULL
     AND (p_q IS NULL OR a.name ILIKE '%' || p_q || '%' OR a.phone LIKE '%' || p_q || '%')
   ORDER BY a.created_at DESC LIMIT 200;
$$;

-- ---------- Ручное продление (оплата пришла на Kaspi) ----------
CREATE OR REPLACE FUNCTION operator_extend(p_account uuid, p_days integer, p_amount numeric, p_comment text)
RETURNS TABLE (paid_until date, status text, balance numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE s subscription;
BEGIN
  SELECT * INTO s FROM subscription WHERE account_id = p_account FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Подписка не найдена'; END IF;
  IF p_days <= 0 OR p_days > 400 THEN RAISE EXCEPTION 'Срок продления: 1–400 дней'; END IF;

  UPDATE subscription
     SET paid_until = greatest(coalesce(subscription.paid_until, current_date), current_date) + p_days,
         status = 'active', frozen_at = NULL, grace_until = NULL, updated_at = now()
   WHERE account_id = p_account;

  -- платёж — в историю биллинга: клиент видит его в своём кабинете
  INSERT INTO billing_move (account_id, amount, kind, comment, period_from, period_to, balance_after)
  VALUES (p_account, coalesce(p_amount, 0), 'topup',
          coalesce(p_comment, 'Продление оператором'),
          current_date, current_date + p_days, s.balance);

  RETURN QUERY SELECT sub.paid_until, sub.status::text, sub.balance
    FROM subscription sub WHERE sub.account_id = p_account;
END $$;

-- ---------- Заморозка / разморозка ----------
CREATE OR REPLACE FUNCTION operator_set_status(p_account uuid, p_status text)
RETURNS text SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  IF p_status NOT IN ('active', 'frozen', 'readonly') THEN
    RAISE EXCEPTION 'Допустимо: active | frozen | readonly';
  END IF;
  UPDATE subscription SET status = p_status::sub_status,
         frozen_at = CASE WHEN p_status = 'frozen' THEN now() ELSE NULL END,
         updated_at = now()
   WHERE account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'Подписка не найдена'; END IF;
  RETURN p_status;
END $$;

-- ---------- Последние платежи (все аккаунты) ----------
CREATE OR REPLACE FUNCTION operator_payments(p_limit integer DEFAULT 50)
RETURNS TABLE (created_at timestamptz, account_name text, amount numeric, kind text, comment text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT m.created_at, a.name, m.amount, m.kind, m.comment
    FROM billing_move m JOIN account a ON a.id = m.account_id
   ORDER BY m.created_at DESC LIMIT least(p_limit, 200);
$$;

GRANT EXECUTE ON FUNCTION operator_overview() TO shop_app;
GRANT EXECUTE ON FUNCTION operator_accounts(text) TO shop_app;
GRANT EXECUTE ON FUNCTION operator_extend(uuid,integer,numeric,text) TO shop_app;
GRANT EXECUTE ON FUNCTION operator_set_status(uuid,text) TO shop_app;
GRANT EXECUTE ON FUNCTION operator_payments(integer) TO shop_app;
