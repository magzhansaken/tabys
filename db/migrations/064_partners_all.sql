-- =====================================================================
-- 064_partners_all.sql — в списке видны и владельцы платформы.
--
-- НАЙДЕНО СВЕРКОЙ. У них раздел показывает ВСЕХ людей платформы:
-- партнёров и владельцев, вторые помечены значком «супер».
--
-- Зачем это нужно: раздел отвечает на вопрос «кто имеет доступ к
-- платформе». Если владельцев не видно, забытая учётка совладельца
-- или бывшего сотрудника не всплывёт никогда — а она открывает
-- деньги всех клиентов.
--
-- Правка владельцев запрещена: доля у них не считается, а пароль
-- каждый меняет себе сам.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_partners_full(integer);

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

         coalesce((SELECT sum(coalesce(
             (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
             coalesce(t.price_month, 0) * 100))
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
