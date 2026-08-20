-- =====================================================================
-- 093_paid_beats_manual.sql — оплата сильнее ручного этапа.
--
-- НАЙДЕНО ВАМИ. Подтвердили оплату, а карточка в воронке осталась в
-- «Связались». Проверено: так и есть, если этап когда-то двигали
-- руками.
--
-- ПОЧЕМУ ТАК БЫЛО. Ручной этап сильнее выведенного — и это верно:
-- человек знает больше системы. Поставил «связались» — значит вправду
-- звонил, система об этом знать не может.
--
-- НО ОПЛАТА ЭТО ФАКТ, А НЕ ДОГАДКА. Деньги пришли и подтверждены,
-- спорить не о чем. Воронка показывала вчерашний день, а по ней
-- решают, кому звонить.
--
-- У ДОНОРА ТА ЖЕ БЕДА, И ХУЖЕ: у них любой этап, кроме «новый»,
-- держится навсегда — «if (dealStage !== NEW) return dealStage».
-- Оплатил человек или ушёл, карточка стоит где поставили.
--
-- ИСКЛЮЧЕНИЕ ОДНО — «отказ». Человек мог узнать об уходе клиента
-- раньше, чем это стало видно системе: клиент сказал «мы уходим», но
-- оплаченный срок ещё идёт. Затирать такое знание нельзя.
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_funnel(p_role text, p_user uuid, p_partner uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, city text, owner_name text, owner_phone text,
  stage text, stage_manual boolean, derived_stage text,
  deal_note text, touched_at timestamptz, days_silent integer,
  paid_until timestamptz, days_left integer, monthly bigint,
  partner_id uuid, partner_name text, created_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, tc.city, tc.owner_name, tc.owner_phone,
         -- ОПЛАТА СИЛЬНЕЕ РУКИ. Ручной этап сильнее выведенного —
         -- человек знает больше базы. Но оплата это ФАКТ, а не
         -- догадка: деньги пришли и подтверждены, спорить не о чем.
         --
         -- Исключение — «отказ»: человек мог узнать об уходе клиента
         -- раньше, чем это стало видно системе, и затирать это нельзя.
         CASE WHEN d.derived = 'paid' AND coalesce(tc.deal_stage, '') <> 'lost'
                THEN 'paid'
              WHEN coalesce(tc.stage_manual, false) THEN coalesce(tc.deal_stage, 'new')
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
