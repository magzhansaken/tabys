-- =====================================================================
-- 099_partner_sees_requests.sql — партнёр видит заявки своих клиентов.
--
-- НАЙДЕНО ПРИ ПРОВЕРКЕ. Владелец магазина подал заявку на вторую кассу
-- из своего кабинета — и его партнёр её НЕ УВИДЕЛ.
--
-- Отбор сравнивал «кто подал». Владелец магазина подаёт сам, значит
-- для партнёра заявка чужая, и она уходила владельцу платформы через
-- голову того, кто ведёт клиента.
--
-- А ведёт клиента ПАРТНЁР: он звонит, объясняет, знает, нужна ли
-- вторая касса вправду. Мимо него решать нельзя — иначе он узнает о
-- решении последним и не сможет ни отговорить, ни поддержать.
-- =====================================================================

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
     -- ПАРТНЁР ВИДИТ ЗАЯВКИ СВОИХ КЛИЕНТОВ, а не только свои поданные.
     --
     -- Раньше сравнивалось «кто подал»: владелец магазина подавал сам,
     -- и его партнёр этой заявки НЕ ВИДЕЛ. Она уходила владельцу
     -- платформы через голову того, кто ведёт клиента.
     --
     -- А ведёт клиента партнёр: он звонит, объясняет, знает, нужна ли
     -- вторая касса вправду. Мимо него решать нельзя.
     AND (p_role = 'super'
          OR tr.created_by = p_user
          OR EXISTS (SELECT 1 FROM tenant_card tc
                      WHERE tc.account_id = tr.account_id
                        AND tc.partner_id = p_user))
   ORDER BY tr.created_at DESC LIMIT 200;
$$;
GRANT EXECUTE ON FUNCTION platform_requests(text, text, uuid) TO shop_app;
