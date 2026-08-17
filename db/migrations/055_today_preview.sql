-- =====================================================================
-- 055_today_preview.sql — последствие прямо в ленте «Сегодня».
--
-- Приём донора, и он лучше моего: под оплатой сразу написано
-- «продлит до 01.10.2026». Владелец видит результат НЕ НАЖИМАЯ —
-- а у меня для этого надо было нажать «Подтвердить» и ждать окна.
--
-- Многоточие на кнопках («Подтвердить…») у них означает, что дальше
-- спросят ещё раз. Это честно: кнопка без многоточия должна делать
-- сразу, с многоточием — открывать разговор.
--
-- Плюс: кто отметил оплату и когда — «отметил Ерлан · 01.08, 17:01».
-- Без этого непонятно, чьё решение подтверждаешь.
-- =====================================================================
-- Набор полей изменился — старую надо убрать: база не даёт менять
-- список возвращаемых столбцов на месте.
-- Разряды пробелом, а не запятой: «20 700 ₸», как принято в Казахстане.
-- Запятая читается как десятичный знак — «двадцать целых семьсот».
CREATE OR REPLACE FUNCTION money_ru(p_tiyn bigint)
RETURNS text IMMUTABLE LANGUAGE sql AS $$
  SELECT replace(to_char(round(p_tiyn / 100.0), 'FM999G999G999'), ',', ' ');
$$;
GRANT EXECUTE ON FUNCTION money_ru(bigint) TO shop_app;

DROP FUNCTION IF EXISTS platform_today(text, uuid);

CREATE OR REPLACE FUNCTION platform_today(p_role text, p_user uuid)
RETURNS TABLE (
  id text, grp text, kind text,
  account_id uuid, client text,
  what text, why text, meta text,
  amount bigint, sort_key numeric,
  payment_id uuid, request_id uuid,
  -- Что произойдёт, если согласиться. Считается сразу, показывается
  -- под карточкой — нажимать для этого не нужно.
  effect text, actor text, at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  -- 1. Просроченные: деньги уже теряются.
  SELECT 'overdue-' || a.id, 'overdue', 'tenant', a.id, a.name,
         'Срок вышел ' || abs(extract(day FROM now() - s.paid_until)::int) || ' дн. назад',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         -extract(epoch FROM now() - s.paid_until) / 86400,
         NULL::uuid, NULL::uuid,
         'продажи закрыты, кабинет открыт',
         NULL, NULL::timestamptz
    FROM account a
    JOIN subscription s ON s.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT tc.*, pu.full_name AS partner_name_cached
        FROM tenant_card tc LEFT JOIN platform_user pu ON pu.id = tc.partner_id
       WHERE tc.account_id = a.id
    ) tc ON true
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
     AND s.paid_until < now()
     AND (p_role = 'super' OR tc.partner_id = p_user)

  UNION ALL
  -- 2. Оплаты на подтверждении. Под каждой — до какой даты продлит.
  SELECT 'pay-' || tp.id,
         CASE WHEN tp.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'payment', a.id, a.name,
         'Оплата ' || money_ru(tp.amount) || ' ₸ · '
           || tp.months || ' мес.'
           || CASE tp.method WHEN 'kaspi' THEN ' · Каспи'
                             WHEN 'cash' THEN ' · наличными'
                             WHEN 'bank' THEN ' · переводом'
                             ELSE '' END,
         tp.comment,
         concat_ws(' · ', tc.city, tc.owner_name),
         tp.amount,
         extract(epoch FROM tp.created_at) / 86400,
         tp.id, NULL::uuid,
         -- Последствие: от большей из дат, как и при подтверждении.
         'продлит до ' || to_char(
           greatest(coalesce(s.paid_until, now()), now())
             + (tp.months || ' months')::interval, 'DD.MM.YYYY'),
         coalesce(pu.full_name, 'клиент'),
         tp.created_at
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
    LEFT JOIN subscription s ON s.account_id = tp.account_id
    LEFT JOIN platform_user pu ON pu.id = tp.created_by
   WHERE tp.status = 'pending'
     AND (p_role = 'super' OR tp.partner_id = p_user)

  UNION ALL
  -- 3. Заявки партнёров.
  SELECT 'req-' || tr.id,
         CASE WHEN tr.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'request', a.id, a.name,
         CASE tr.kind
           WHEN 'device' THEN 'Просит устройство'
           WHEN 'tariff' THEN 'Просит смену тарифа'
           WHEN 'grace'  THEN 'Просит отсрочку'
           ELSE 'Заявка' END,
         tr.comment,
         concat_ws(' · ', tc.city),
         NULL::bigint,
         extract(epoch FROM tr.created_at) / 86400,
         NULL::uuid, tr.id,
         CASE tr.kind
           WHEN 'device' THEN 'добавит строку в счёт'
           WHEN 'tariff' THEN 'сменит основную строку счёта'
           WHEN 'grace'  THEN 'сдвинет срок на '
             || coalesce((tr.payload->>'days'), '7') || ' дн.'
           ELSE 'решается словами' END,
         coalesce(pu.full_name, '—'),
         tr.created_at
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = tr.account_id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
   WHERE tr.status = 'pending'
     AND (p_role = 'super' OR tr.created_by = p_user)

  UNION ALL
  -- 4. Самозаписи с сайта.
  SELECT 'signup-' || a.id,
         CASE WHEN a.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'signup', a.id, a.name,
         'Регистрация: владелец завёл магазин сам',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, a.phone),
         NULL::bigint,
         extract(epoch FROM a.created_at) / 86400,
         NULL::uuid, NULL::uuid,
         'откроет пробный период на 14 дн.',
         'сайт', a.created_at
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
   WHERE a.deleted_at IS NULL AND a.status = 'trial'
     AND coalesce(tc.is_demo, false) = false
     AND tc.partner_id IS NULL
     AND p_role = 'super'

  UNION ALL
  -- 5. Скоро платить.
  SELECT 'soon-' || a.id, 'soon', 'tenant', a.id, a.name,
         'Платить через ' || extract(day FROM s.paid_until - now())::int || ' дн.',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         extract(epoch FROM s.paid_until - now()) / 86400,
         NULL::uuid, NULL::uuid,
         'позвонить сейчас уместно, через неделю — уже выбивание',
         NULL, s.paid_until
    FROM account a
    JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
     AND s.paid_until BETWEEN now() AND now() + interval '7 days'
     AND (p_role = 'super' OR tc.partner_id = p_user)

  ORDER BY 2, 10;
$$;
GRANT EXECUTE ON FUNCTION platform_today(text, uuid) TO shop_app;

