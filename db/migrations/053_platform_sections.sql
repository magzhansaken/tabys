-- =====================================================================
-- 053_platform_sections.sql — восемь разделов кабинета платформы.
--
-- ОТДЕЛЬНЫМ ФАЙЛОМ, а не дописками в 052. Причина найдена на живом
-- сервере: миграции отмечаются применёнными ПО ИМЕНИ ФАЙЛА, и дописки
-- в уже применённый файл туда не попадают. Развёртывание говорит
-- «уже применена» и идёт дальше — молча, без ошибки.
--
-- Отсюда и «Internal server error» в кабинете: код звал функции,
-- которых на сервере не было.
-- =====================================================================

-- =====================================================================
-- РАЗДЕЛ 1: «СЕГОДНЯ» — лента решений.
--
-- Замысел взят у донора и он верный: день начинается не со списка
-- клиентов, а с решений. Кто просрочен, что пришло сегодня, что висит
-- со вчера, кому платить на неделе.
--
-- ОДНИМ ЗАПРОСОМ, а не четырьмя. У донора экран собирал ленту в
-- браузере из четырёх ответов: список клиентов, оплаты, заявки,
-- партнёры. Это четыре ожидания подряд на стартовом экране, который
-- открывают первым делом с утра — и половина данных приходит уже
-- устаревшей относительно другой половины.
--
-- ЧЕТЫРЕ ОЧЕРЕДИ, порядок важен:
--   overdue — деньги уже потеряны, каждый день считается;
--   today   — свежее, пока помнят разговор;
--   waiting — висит со вчера и раньше;
--   soon    — семь дней и меньше до оплаты.
--
-- Учебные магазины исключены отовсюду: они не участвуют в деньгах.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_today(p_role text, p_user uuid)
RETURNS TABLE (
  id text, grp text, kind text,
  account_id uuid, client text,
  what text, why text, meta text,
  amount bigint, sort_key numeric,
  payment_id uuid, request_id uuid)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  -- 1. Просроченные: срок вышел, продажи закрыты, деньги теряются.
  SELECT 'overdue-' || a.id, 'overdue', 'tenant', a.id, a.name,
         'Срок вышел ' || abs(extract(day FROM now() - s.paid_until)::int) || ' дн. назад',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         -extract(epoch FROM now() - s.paid_until) / 86400,
         NULL::uuid, NULL::uuid
    FROM account a
    JOIN subscription s ON s.account_id = a.id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN tariff t ON t.id = s.tariff_id
   WHERE a.deleted_at IS NULL AND coalesce(tc.is_demo, false) = false
     AND s.paid_until < now()
     AND (p_role = 'super' OR tc.partner_id = p_user)

  UNION ALL
  -- 2. Оплаты на подтверждении. Сегодняшние — в «пришло сегодня»,
  --    вчерашние и старше — в «ждёт решения»: висящая оплата означает,
  --    что клиент заплатил и ждёт, а доступ ему до сих пор не открыли.
  SELECT 'pay-' || tp.id,
         CASE WHEN tp.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'payment', a.id, a.name,
         'Оплата ' || round(tp.amount / 100.0) || ' ₸ · ' || tp.months || ' мес.',
         tp.comment,
         concat_ws(' · ', tc.city, tc.owner_name, pu.full_name),
         tp.amount,
         extract(epoch FROM tp.created_at) / 86400,
         tp.id, NULL::uuid
    FROM tenant_payment tp
    JOIN account a ON a.id = tp.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tp.partner_id
   WHERE tp.status = 'pending'
     AND (p_role = 'super' OR tp.partner_id = p_user)

  UNION ALL
  -- 3. Заявки партнёров: вторая касса, отсрочка, смена тарифа.
  SELECT 'req-' || tr.id,
         CASE WHEN tr.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'request', a.id, a.name,
         CASE tr.kind
           WHEN 'device' THEN 'Просит устройство'
           WHEN 'tariff' THEN 'Просит смену тарифа'
           WHEN 'grace'  THEN 'Просит отсрочку'
           ELSE 'Заявка' END,
         tr.comment,
         concat_ws(' · ', tc.city, pu.full_name),
         NULL::bigint,
         extract(epoch FROM tr.created_at) / 86400,
         NULL::uuid, tr.id
    FROM tenant_request tr
    JOIN account a ON a.id = tr.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
   WHERE tr.status = 'pending'
     AND (p_role = 'super' OR tr.created_by = p_user)

  UNION ALL
  -- 4. Самозаписи: владелец зарегистрировался сам и ждёт одобрения.
  --    Пока не одобрили — он не может работать, а мы теряем клиента.
  SELECT 'signup-' || a.id,
         CASE WHEN a.created_at::date = current_date THEN 'today' ELSE 'waiting' END,
         'signup', a.id, a.name,
         'Регистрация: владелец завёл магазин сам',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, a.phone),
         NULL::bigint,
         extract(epoch FROM a.created_at) / 86400,
         NULL::uuid, NULL::uuid
    FROM account a
    LEFT JOIN tenant_card tc ON tc.account_id = a.id
   WHERE a.deleted_at IS NULL AND a.status = 'trial'
     AND coalesce(tc.is_demo, false) = false
     AND tc.partner_id IS NULL          -- ничей: партнёр ещё не назначен
     AND p_role = 'super'

  UNION ALL
  -- 5. Скоро платить: семь дней и меньше. Звонок сейчас уместен,
  --    а через неделю выглядит выбиванием долга.
  SELECT 'soon-' || a.id, 'soon', 'tenant', a.id, a.name,
         'Платить через ' || extract(day FROM s.paid_until - now())::int || ' дн.',
         NULL,
         concat_ws(' · ', tc.city, tc.owner_name, tc.owner_phone),
         coalesce(t.price_month, 0)::bigint * 100,
         extract(epoch FROM s.paid_until - now()) / 86400,
         NULL::uuid, NULL::uuid
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

-- =====================================================================
-- РАЗДЕЛ 2: «КЛИЕНТЫ» — список с отборами и карточка.
--
-- Замысел донора взят: карточка — СТРАНИЦА, а не окно-тупик. У них
-- раньше было модальное окно, которое показывало всё и не давало
-- сделать ничего: единственная кнопка «Закрыть». Изучил клиента —
-- закрывай и ищи заново.
--
-- СДЕЛАНО ИНАЧЕ: отбор и подсчёты — в базе, а не в браузере. У донора
-- список приходил целиком и фильтровался на стороне кабинета: при
-- сотне клиентов это лишние сотни строк по сети на каждое нажатие
-- «показать просроченных».
-- =====================================================================

/**
 * Список клиентов с отбором. Один запрос вместо «привези всё и
 * отфильтруй у себя».
 *
 * p_filter: all | active | expiring | expired | trial | demo
 * p_partner: NULL = все, иначе только этого партнёра
 */
CREATE OR REPLACE FUNCTION platform_clients_filtered(
  p_role text, p_user uuid,
  p_q text DEFAULT NULL, p_filter text DEFAULT 'all', p_partner uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, phone text, status text, city text,
  owner_name text, owner_phone text, deal_stage text, is_demo boolean,
  partner_id uuid, partner_name text, partner_bp integer,
  paid_until timestamptz, days_left integer,
  tariff_name text, monthly bigint,
  revenue_30d numeric, stores bigint, registers bigint,
  created_at timestamptz,
  -- Заметка и дата касания: без них воронка показывает этап, но не
  -- помнит, о чём говорили. Через две недели «показали» ничего не значит.
  deal_note text, touched_at timestamptz,
  total_count bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT a.id, a.name, a.phone, a.status::text AS status, a.created_at,
           tc.city, tc.owner_name, tc.owner_phone, tc.deal_stage,
           tc.deal_note, tc.touched_at,
           coalesce(tc.is_demo, false) AS is_demo,
           tc.partner_id, pu.full_name AS partner_name,
           coalesce(pu.commission_bp, 0) AS partner_bp,
           s.paid_until,
           CASE WHEN s.paid_until IS NULL THEN NULL
                ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END AS days_left,
           t.name AS tariff_name,
           -- Месячная цена: из строк счёта, если они есть; иначе из
           -- тарифа. Клиент видит одну сумму, платформа — ту же.
           coalesce(
             (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
               WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
             coalesce(t.price_month, 0) * 100)::bigint AS monthly,
           coalesce((SELECT sum(sl.total) FROM sale sl
              WHERE sl.account_id = a.id AND sl.return_of_id IS NULL
                AND sl.created_at > now() - interval '30 days'), 0) AS revenue_30d,
           (SELECT count(*) FROM store st WHERE st.account_id = a.id) AS stores,
           (SELECT count(*) FROM cash_register cr WHERE cr.account_id = a.id) AS registers
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN platform_user pu ON pu.id = tc.partner_id
      LEFT JOIN subscription s ON s.account_id = a.id
      LEFT JOIN tariff t ON t.id = s.tariff_id
     WHERE a.deleted_at IS NULL
       AND (p_role = 'super' OR tc.partner_id = p_user)
       AND (p_partner IS NULL OR tc.partner_id = p_partner)
       AND (p_q IS NULL OR p_q = '' OR
            a.name ILIKE '%'||p_q||'%' OR tc.owner_name ILIKE '%'||p_q||'%'
            OR tc.city ILIKE '%'||p_q||'%'
            OR phone_tail(a.phone) = phone_tail(p_q)
            OR phone_tail(tc.owner_phone) = phone_tail(p_q))
  ), picked AS (
    SELECT * FROM base
     WHERE CASE p_filter
             WHEN 'active'   THEN days_left >= 0 AND NOT is_demo
             WHEN 'expiring' THEN days_left BETWEEN 0 AND 7 AND NOT is_demo
             WHEN 'expired'  THEN days_left < 0 AND NOT is_demo
             WHEN 'trial'    THEN status = 'trial' AND NOT is_demo
             WHEN 'demo'     THEN is_demo
             ELSE true
           END
  )
  SELECT p.id, p.name, p.phone, p.status, p.city,
         p.owner_name, p.owner_phone, p.deal_stage, p.is_demo,
         p.partner_id, p.partner_name, p.partner_bp,
         p.paid_until, p.days_left, p.tariff_name, p.monthly,
         p.revenue_30d, p.stores, p.registers, p.created_at,
         p.deal_note, p.touched_at,
         count(*) OVER () AS total_count
    FROM picked p
   -- Порядок: сначала те, где горит. Просроченные, потом истекающие,
   -- потом остальные по свежести. Владелец читает сверху.
   ORDER BY (p.days_left IS NULL), p.days_left NULLS LAST, p.created_at DESC
   LIMIT 500;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_filtered(text, uuid, text, text, uuid) TO shop_app;

/** Счётчики для вкладок отбора: сколько в каждой. */
CREATE OR REPLACE FUNCTION platform_clients_counts(p_role text, p_user uuid)
RETURNS TABLE (all_n bigint, active_n bigint, expiring_n bigint,
               expired_n bigint, trial_n bigint, demo_n bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT coalesce(tc.is_demo, false) AS is_demo, a.status::text AS st,
           CASE WHEN s.paid_until IS NULL THEN NULL
                ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END AS d
      FROM account a
      LEFT JOIN tenant_card tc ON tc.account_id = a.id
      LEFT JOIN subscription s ON s.account_id = a.id
     WHERE a.deleted_at IS NULL AND (p_role = 'super' OR tc.partner_id = p_user)
  )
  SELECT count(*),
         count(*) FILTER (WHERE d >= 0 AND NOT is_demo),
         count(*) FILTER (WHERE d BETWEEN 0 AND 7 AND NOT is_demo),
         count(*) FILTER (WHERE d < 0 AND NOT is_demo),
         count(*) FILTER (WHERE st = 'trial' AND NOT is_demo),
         count(*) FILTER (WHERE is_demo)
    FROM b;
$$;
GRANT EXECUTE ON FUNCTION platform_clients_counts(text, uuid) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 3: «ДЕНЬГИ» — оплаты, доли, сводка по деньгам.
--
-- СДЕЛАНО ИНАЧЕ, ЧЕМ У ДОНОРА. У них оплаченный отрезок («с какого по
-- какое») вычислялся пересчётом ВСЕЙ цепочки оплат клиента при каждом
-- открытии карточки: берут первую подтверждённую, прибавляют месяцы,
-- потом вторую и так далее.
--
-- Что с этим не так: цепочка живая. Одну оплату отклонили задним
-- числом, другую подтвердили не по порядку — и все отрезки съехали.
-- Клиент видит «оплачено с 5 марта», хотя платил 12-го.
--
-- У нас период записывается В МОМЕНТ ПОДТВЕРЖДЕНИЯ и больше не
-- меняется. Что было, то было — это ответ на вопрос «за что я платил»,
-- и он не должен зависеть от того, что случилось потом.
-- =====================================================================
ALTER TABLE tenant_payment
  ADD COLUMN IF NOT EXISTS period_from timestamptz,
  ADD COLUMN IF NOT EXISTS period_to   timestamptz;

COMMENT ON COLUMN tenant_payment.period_from IS
  'За какой отрезок заплачено. Пишется при подтверждении и не пересчитывается';

/**
 * Подтверждение оплаты — одним заходом в базе.
 *
 * Считает долю партнёра, продлевает подписку, записывает отрезок,
 * ставит отметки. Всё в одной операции: если что-то упадёт посередине,
 * не должно остаться половины — оплата подтверждена, а доступ не
 * продлён, или наоборот.
 *
 * Возвращает всё, что нужно показать: до какой даты продлили, сколько
 * кому досталось.
 */
CREATE OR REPLACE FUNCTION platform_approve_payment(
  p_payment uuid, p_actor uuid)
RETURNS TABLE (
  paid_until timestamptz, period_from timestamptz,
  partner_share bigint, platform_share bigint, amount bigint, months integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_p record; v_bp integer := 0; v_share bigint; v_from timestamptz; v_until timestamptz;
BEGIN
  SELECT * INTO v_p FROM tenant_payment WHERE id = p_payment FOR UPDATE;
  IF v_p.id IS NULL THEN RAISE EXCEPTION 'Оплата не найдена'; END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'Оплата уже %', CASE WHEN v_p.status = 'approved'
      THEN 'подтверждена' ELSE 'отклонена' END;
  END IF;

  -- Доля партнёра замораживается СЕЙЧАС. Поменяют ему комиссию позже —
  -- прошлые выплаты не пересчитаются задним числом, иначе отчёт за
  -- прошлый месяц изменится сам собой.
  IF v_p.partner_id IS NOT NULL THEN
    SELECT commission_bp INTO v_bp FROM platform_user WHERE id = v_p.partner_id;
  END IF;
  v_share := round(v_p.amount * coalesce(v_bp, 0) / 10000.0);

  -- Отрезок: от БОЛЬШЕЙ из дат — сегодня или конец оплаченного
  -- периода. Досрочная оплата не сжигает остаток.
  SELECT s.paid_until INTO v_from FROM subscription s WHERE s.account_id = v_p.account_id;
  v_from := greatest(coalesce(v_from, now()), now());
  v_until := v_from + (v_p.months || ' months')::interval;

  UPDATE tenant_payment
     SET status = 'approved', approved_by = p_actor, approved_at = now(),
         partner_bp = coalesce(v_bp, 0),
         partner_share = v_share,
         platform_share = v_p.amount - v_share,
         period_from = v_from, period_to = v_until
   WHERE id = p_payment;

  PERFORM platform_extend_subscription(v_p.account_id, v_p.months);

  RETURN QUERY SELECT v_until, v_from, v_share,
                      v_p.amount - v_share, v_p.amount, v_p.months;
END; $$;
GRANT EXECUTE ON FUNCTION platform_approve_payment(uuid, uuid) TO shop_app;

/**
 * Деньги: список оплат с отбором и итогами.
 *
 * Итоги считаются по ТЕМ ЖЕ строкам, что показываются: у донора сумма
 * сверху бралась отдельным запросом, и при отборе «ждут» она
 * показывала итог по всем — цифра не совпадала со списком под ней.
 */
CREATE OR REPLACE FUNCTION platform_money(
  p_status text, p_role text, p_user uuid, p_days integer DEFAULT 90)
RETURNS TABLE (
  id uuid, account_id uuid, client text, partner text, partner_id uuid,
  amount bigint, months integer, method text, comment text,
  status text, reject_reason text,
  period_from timestamptz, period_to timestamptz,
  partner_share bigint, platform_share bigint,
  created_at timestamptz, approved_at timestamptz,
  sum_amount bigint, sum_partner bigint, sum_platform bigint, cnt bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH picked AS (
    SELECT tp.*, a.name AS client_name, pu.full_name AS partner_name
      FROM tenant_payment tp
      JOIN account a ON a.id = tp.account_id
      LEFT JOIN platform_user pu ON pu.id = tp.partner_id
      LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
     WHERE (p_status IS NULL OR tp.status::text = p_status)
       AND (p_role = 'super' OR tp.partner_id = p_user)
       -- Учебные магазины в деньги не идут никогда.
       AND coalesce(tc.is_demo, false) = false
       AND tp.created_at > now() - (p_days || ' days')::interval
  )
  SELECT p.id, p.account_id, p.client_name, p.partner_name, p.partner_id,
         p.amount, p.months, p.method, p.comment,
         p.status::text, p.reject_reason,
         p.period_from, p.period_to,
         p.partner_share, p.platform_share,
         p.created_at, p.approved_at,
         -- Итоги только по ПОДТВЕРЖДЁННЫМ: ждущие и отклонённые — это
         -- ещё не деньги, складывать их в доход нельзя.
         sum(p.amount) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.partner_share) FILTER (WHERE p.status = 'approved') OVER (),
         sum(p.platform_share) FILTER (WHERE p.status = 'approved') OVER (),
         count(*) OVER ()
    FROM picked p
   -- Ждущие первыми: это то, что требует действия. Остальные по дате.
   ORDER BY (p.status <> 'pending'), p.created_at DESC
   LIMIT 300;
$$;
GRANT EXECUTE ON FUNCTION platform_money(text, text, uuid, integer) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 4: «ЗАЯВКИ» — партнёр просит, платформа решает.
--
-- Замысел донора взят: одобрение САМО ВЫПОЛНЯЕТ действие, а не просто
-- ставит отметку. Одобрил вторую кассу — строка счёта появилась.
-- Иначе владелец одобряет, а сделать забывает, и партнёр звонит через
-- неделю: «вы же согласились».
--
-- СДЕЛАНО ЛУЧШЕ: у решения есть ПРЕДПРОСМОТР — что именно произойдёт,
-- если одобрить. У донора кнопка «Одобрить» просто делала, и увидеть
-- последствие можно было только после. С деньгами так нельзя.
--
-- ЧЕТЫРЕ ВИДА, все под магазин, а не под ресторан:
--   device — вторая касса или точка;
--   tariff — смена тарифа;
--   grace  — отсрочка платежа;
--   other  — всё прочее, решается словами.
-- =====================================================================

/** Что произойдёт, если одобрить. Считает то же, что и одобрение. */
CREATE OR REPLACE FUNCTION platform_request_preview(p_request uuid)
RETURNS TABLE (
  kind text, client text, account_id uuid,
  what text, effect text, amount bigint, days_left integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_r record; v_set record; v_unit bigint := 0; v_days integer := 0;
  v_pro bigint := 0; v_kind text; v_what text; v_effect text;
BEGIN
  SELECT tr.*, a.name AS client_name INTO v_r
    FROM tenant_request tr JOIN account a ON a.id = tr.account_id
   WHERE tr.id = p_request;
  IF v_r.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_set FROM platform_settings WHERE id;

  -- Сколько дней до конца оплаченного периода: от этого зависит доплата.
  SELECT ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int INTO v_days
    FROM subscription s WHERE s.account_id = v_r.account_id;
  v_days := greatest(coalesce(v_days, 0), 0);

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    v_unit := CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
                   ELSE v_set.price_extra_pos END;
    -- Правило десяти дней: меньше — доплату не берём вовсе.
    IF v_days >= 10 THEN v_pro := round(v_unit * v_days / 30.0); END IF;
    v_what := CASE WHEN v_kind = 'store' THEN 'Вторая точка' ELSE 'Вторая касса' END;
    v_effect := 'Появится строка счёта на ' || round(v_unit / 100.0) || ' ₸/мес'
      || CASE WHEN v_pro > 0
              THEN '. Доплата за остаток периода: ' || round(v_pro / 100.0) || ' ₸'
              ELSE '. Доплаты нет — до конца периода меньше десяти дней' END;

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := CASE WHEN coalesce(v_r.payload->>'tier', 'pro') = 'pro'
                   THEN v_set.price_pro ELSE v_set.price_base END;
    v_what := 'Смена тарифа на ' || CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
                                         THEN '«Стандарт»' ELSE '«Старт»' END;
    v_effect := 'Основная строка счёта станет ' || round(v_unit / 100.0)
      || ' ₸/мес. Доплаты за устройства и скидки не изменятся';

  ELSIF v_r.kind = 'grace' THEN
    v_days := coalesce((v_r.payload->>'days')::int, 7);
    v_what := 'Отсрочка на ' || v_days || ' дн.';
    v_effect := 'Срок подписки сдвинется на ' || v_days
      || ' дн. вперёд. Деньги не поступят — это уступка, а не оплата';

  ELSE
    v_what := 'Прочее';
    v_effect := 'Решается словами: система ничего не изменит';
  END IF;

  RETURN QUERY SELECT v_r.kind, v_r.client_name, v_r.account_id,
                      v_what, v_effect, v_pro, v_days;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_preview(uuid) TO shop_app;

/**
 * Решение по заявке. Одобрение САМО выполняет действие.
 *
 * Всё одной операцией: отметка о решении и само действие. Иначе
 * возможно состояние «одобрено, но не сделано» — самое неприятное,
 * потому что все считают, что сделано.
 */
CREATE OR REPLACE FUNCTION platform_request_decide(
  p_request uuid, p_actor uuid, p_approve boolean, p_note text)
RETURNS TABLE (account_id uuid, kind text, effect text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_r record; v_set record; v_unit bigint; v_kind text; v_days integer;
  v_effect text := ''; v_n integer;
BEGIN
  SELECT * INTO v_r FROM tenant_request WHERE id = p_request FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Заявка не найдена'; END IF;
  IF v_r.status <> 'pending' THEN RAISE EXCEPTION 'Заявка уже решена'; END IF;

  UPDATE tenant_request
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decision_note = p_note, decided_by = p_actor, decided_at = now()
   WHERE id = p_request;

  IF NOT p_approve THEN
    RETURN QUERY SELECT v_r.account_id, v_r.kind, 'Отказано'::text;
    RETURN;
  END IF;

  SELECT * INTO v_set FROM platform_settings WHERE id;

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    v_unit := CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
                   ELSE v_set.price_extra_pos END;
    SELECT count(*) + 2 INTO v_n FROM plan_line pl
     WHERE pl.account_id = v_r.account_id AND pl.kind = v_kind AND pl.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, v_kind,
            CASE WHEN v_kind = 'store' THEN 'Точка №' ELSE 'Касса №' END || v_n, 1, v_unit);
    v_effect := 'Строка счёта добавлена';

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
                   THEN v_set.price_pro ELSE v_set.price_base END;
    -- Только основная строка: доплаты и скидки — отдельные
    -- договорённости, их менять нельзя.
    UPDATE plan_line SET ends_at = now()
     WHERE plan_line.account_id = v_r.account_id AND plan_line.kind = 'base'
       AND plan_line.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, 'base', 'Тариф', 1, v_unit);
    v_effect := 'Тариф изменён';

  ELSIF v_r.kind = 'grace' THEN
    v_days := coalesce((v_r.payload->>'days')::int, 7);
    UPDATE subscription
       SET paid_until = greatest(coalesce(paid_until, now()), now())
                        + (v_days || ' days')::interval,
           status = 'active'
     WHERE subscription.account_id = v_r.account_id;
    UPDATE account SET status = 'active'
     WHERE id = v_r.account_id AND status <> 'active';
    v_effect := 'Отсрочка на ' || v_days || ' дн. дана';

  ELSE
    v_effect := 'Отмечено решённым';
  END IF;

  RETURN QUERY SELECT v_r.account_id, v_r.kind, v_effect;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_decide(uuid, uuid, boolean, text) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 5: «ВОРОНКА» — от знакомства до оплаты.
--
-- Замысел донора взят целиком и он умный: этап ВЫВОДИТСЯ ИЗ ФАКТОВ,
-- пока его не двигали руками. Заплатил — «Оплатил». Идёт пробный —
-- «Пробный». Ручной сдвиг сильнее вывода: человек знает о клиенте
-- больше, чем база.
--
-- СДЕЛАНО ЛУЧШЕ: вывод считается на СЕРВЕРЕ, а не в браузере. У донора
-- этап вычислялся при отрисовке — значит два человека, открывшие
-- воронку одновременно, могли увидеть разное, и никто из них не понял
-- бы почему.
--
-- Плюс мы храним, ВЫВЕДЕН этап или поставлен руками. У донора это было
-- неразличимо: колонка «Оплатил» могла означать и «система увидела
-- оплату», и «партнёр перетащил карточку». Разница важна — вторая
-- держится, даже если оплата отклонена.
-- =====================================================================
ALTER TABLE tenant_card
  ADD COLUMN IF NOT EXISTS stage_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenant_card.stage_manual IS
  'true = этап поставлен руками и сильнее вывода из фактов';

/**
 * Воронка: карточки по этапам с выводом из фактов.
 *
 * Пять этапов, как у донора:
 *   new       — нашли, ещё не говорили;
 *   contacted — разговор идёт;
 *   trial     — работает бесплатно;
 *   paid      — деньги пришли;
 *   lost      — не сложилось.
 */
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
         coalesce(
           (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
             WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
           coalesce(t.price_month, 0) * 100)::bigint,
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

/** Сдвинуть карточку по воронке. Ручной сдвиг помечается как ручной. */
CREATE OR REPLACE FUNCTION platform_funnel_move(
  p_account uuid, p_stage text, p_note text DEFAULT NULL)
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO tenant_card (account_id, deal_stage, stage_manual, deal_note, touched_at)
  VALUES (p_account, p_stage, true, p_note, now())
  ON CONFLICT (account_id) DO UPDATE SET
    deal_stage = p_stage,
    stage_manual = true,
    deal_note = coalesce(p_note, tenant_card.deal_note),
    touched_at = now(),
    updated_at = now();
$$;
GRANT EXECUTE ON FUNCTION platform_funnel_move(uuid, text, text) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 6: «ПАРТНЁРЫ» — кто продаёт и сколько заработал.
--
-- У донора список плоский: имя, комиссия, число клиентов, заработок за
-- месяц одним числом. Этого мало для решения — а решать здесь надо
-- одно: кому платить и с кем расставаться.
--
-- ДОБАВЛЕНО СВЕРХ ДОНОРА:
--
-- 1. К ВЫПЛАТЕ — сколько партнёру причитается за период. У донора
--    «заработал за 30 дней» смешивал в одну цифру и то, что уже
--    выплачено, и то, что ещё нет.
--
-- 2. ПРИВЁЛ ДЕНЕГ ВСЕГО — за всё время, а не за месяц. Партнёр,
--    приведший пятерых год назад, ценнее приведшего одного вчера.
--
-- 3. СКОЛЬКО КЛИЕНТОВ УШЛО — обратная сторона. Партнёр может заводить
--    много и терять столько же.
--
-- 4. ДАВНО ЛИ ЗАХОДИЛ — партнёр, не заходивший месяц, скорее всего
--    перестал работать, и его клиенты остались без сопровождения.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_partners_full(p_days integer DEFAULT 30)
RETURNS TABLE (
  id uuid, full_name text, email text, phone text,
  commission_bp integer, is_active boolean,
  last_login_at timestamptz, created_at timestamptz,
  clients bigint, active_clients bigint, lost_clients bigint,
  earned_period bigint, earned_total bigint,
  brought_period bigint, brought_total bigint,
  mrr bigint, days_silent integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu.id, pu.full_name, pu.email, pu.phone,
         pu.commission_bp, pu.is_active, pu.last_login_at, pu.created_at,

         -- Клиенты: всего, работающих, потерянных. Учебные не в счёт.
         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND a.deleted_at IS NULL),
         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
            JOIN subscription s ON s.account_id = a.id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND a.deleted_at IS NULL AND s.paid_until > now()),
         -- Ушедшие: удалённые или просроченные больше месяца. Партнёр
         -- может заводить много и терять столько же — это видно только
         -- рядом с первой цифрой.
         (SELECT count(*) FROM tenant_card tc
            JOIN account a ON a.id = tc.account_id
            LEFT JOIN subscription s ON s.account_id = a.id
           WHERE tc.partner_id = pu.id AND NOT coalesce(tc.is_demo, false)
             AND (a.deleted_at IS NOT NULL
                  OR s.paid_until < now() - interval '30 days')),

         -- Заработок партнёра: за период и за всё время.
         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'
              AND tp.approved_at > now() - (p_days || ' days')::interval), 0),
         coalesce((SELECT sum(tp.partner_share) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'), 0),

         -- Сколько ДЕНЕГ ПРИВЁЛ платформе — это другое число, и оно
         -- важнее заработка: партнёр с малой комиссией может приносить
         -- больше, чем с большой.
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'
              AND tp.approved_at > now() - (p_days || ' days')::interval), 0),
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.partner_id = pu.id AND tp.status = 'approved'), 0),

         -- Сколько его клиенты дают в месяц сейчас: будущий доход.
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

         -- Давно ли заходил: не заходивший месяц скорее всего перестал
         -- работать, а его клиенты остались без сопровождения.
         CASE WHEN pu.last_login_at IS NULL THEN NULL
              ELSE extract(day FROM now() - pu.last_login_at)::int END

    FROM platform_user pu
   WHERE pu.role = 'partner' AND pu.deleted_at IS NULL
   ORDER BY (SELECT coalesce(sum(tp.amount), 0) FROM tenant_payment tp
              WHERE tp.partner_id = pu.id AND tp.status = 'approved'
                AND tp.approved_at > now() - (p_days || ' days')::interval) DESC,
            pu.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION platform_partners_full(integer) TO shop_app;

/**
 * Что произойдёт, если отключить партнёра.
 *
 * Опасное действие показывает последствие до нажатия: сколько клиентов
 * останется без сопровождения и на какую сумму в месяц. У донора
 * кнопка просто отключала.
 */
CREATE OR REPLACE FUNCTION platform_partner_off_preview(p_partner uuid)
RETURNS TABLE (full_name text, clients bigint, active_clients bigint, mrr bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pu.full_name,
         (SELECT count(*) FROM tenant_card tc WHERE tc.partner_id = pu.id),
         (SELECT count(*) FROM tenant_card tc
            JOIN subscription s ON s.account_id = tc.account_id
           WHERE tc.partner_id = pu.id AND s.paid_until > now()),
         coalesce((SELECT sum(coalesce(t.price_month, 0) * 100)
           FROM tenant_card tc
           JOIN subscription s ON s.account_id = tc.account_id
           LEFT JOIN tariff t ON t.id = s.tariff_id
          WHERE tc.partner_id = pu.id AND s.paid_until > now()), 0)
    FROM platform_user pu WHERE pu.id = p_partner;
$$;
GRANT EXECUTE ON FUNCTION platform_partner_off_preview(uuid) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 7: «СВОДКА» — где мы сейчас и куда движемся.
--
-- Замысел донора верный: живые таблицы знают только «сейчас». Чтобы
-- ответить «месяц назад было лучше или хуже», нужны снимки по дням.
--
-- НАЙДЕНА СЛАБОСТЬ: у них снимок писался ПРИ ОТКРЫТИИ ЭКРАНА. Не
-- заходил в сводку неделю — недели в истории нет. Уехал в отпуск —
-- в графике дыра, и понять, что происходило, уже нельзя.
--
-- У НАС ДВА ИСТОЧНИКА:
--   1. Снимок пишет запускальщик раз в сутки — независимо от того,
--      открывал кто-то экран или нет.
--   2. Деньги по дням берутся из самих оплат, а не из снимков: платежи
--      никуда не деваются, и этот ряд восстановим за любой день, даже
--      если снимка нет.
--
-- Так дыра в снимках портит только счётчики клиентов, но не деньги —
-- а деньги важнее.
-- =====================================================================
CREATE TABLE IF NOT EXISTS platform_daily (
  day           date PRIMARY KEY,
  tenants       integer NOT NULL DEFAULT 0,   -- всего боевых магазинов
  active        integer NOT NULL DEFAULT 0,   -- с оплаченным сроком
  trial         integer NOT NULL DEFAULT 0,   -- на пробном
  expired       integer NOT NULL DEFAULT 0,   -- срок вышел
  mrr           bigint  NOT NULL DEFAULT 0,   -- доход в месяц, тиыны
  taken_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON platform_daily TO shop_app;

/** Снять срез на сегодня. Зовётся запускальщиком раз в сутки. */
CREATE OR REPLACE FUNCTION platform_snapshot()
RETURNS void
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO platform_daily (day, tenants, active, trial, expired, mrr, taken_at)
  SELECT current_date,
         count(*),
         count(*) FILTER (WHERE s.paid_until > now()),
         count(*) FILTER (WHERE a.status = 'trial'),
         count(*) FILTER (WHERE s.paid_until <= now()),
         coalesce(sum(coalesce(
           (SELECT sum(pl.unit_price * pl.qty) FROM plan_line pl
             WHERE pl.account_id = a.id AND pl.ends_at IS NULL),
           coalesce(t.price_month, 0) * 100))
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

/**
 * Сводка за период: ряд по дням и итоги.
 *
 * Деньги по дням — ИЗ САМИХ ОПЛАТ, а не из снимков: платежи никуда не
 * деваются, и этот ряд восстановим за любой день. Дыра в снимках
 * портит счётчики клиентов, но не деньги.
 *
 * Дни без событий тоже в ряду: пропуск в графике читается как сбой, а
 * не как «в тот день ничего не платили».
 */
CREATE OR REPLACE FUNCTION platform_summary_series(p_days integer DEFAULT 30)
RETURNS TABLE (
  day date, tenants integer, active integer, trial integer, expired integer,
  mrr bigint, paid_count integer, paid_amount bigint, partner_share bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH days AS (
    SELECT generate_series(current_date - (p_days - 1), current_date, '1 day')::date AS d
  ), pays AS (
    SELECT tp.approved_at::date AS d,
           count(*)::int AS cnt,
           sum(tp.amount) AS amt,
           sum(tp.partner_share) AS shr
      FROM tenant_payment tp
      LEFT JOIN tenant_card tc ON tc.account_id = tp.account_id
     WHERE tp.status = 'approved'
       AND tp.approved_at >= current_date - (p_days - 1)
       AND coalesce(tc.is_demo, false) = false
     GROUP BY 1
  )
  SELECT d.d,
         coalesce(pd.tenants, 0), coalesce(pd.active, 0),
         coalesce(pd.trial, 0), coalesce(pd.expired, 0),
         coalesce(pd.mrr, 0),
         coalesce(p.cnt, 0), coalesce(p.amt, 0), coalesce(p.shr, 0)
    FROM days d
    LEFT JOIN platform_daily pd ON pd.day = d.d
    LEFT JOIN pays p ON p.d = d.d
   ORDER BY d.d;
$$;
GRANT EXECUTE ON FUNCTION platform_summary_series(integer) TO shop_app;

-- =====================================================================
-- РАЗДЕЛ 8: «ЖУРНАЛ» — кто что сделал.
--
-- Три мысли донора взяты, все верные:
--   отбор делает сервер — партнёру записи по чужим клиентам не
--     приходят вовсе, а не прячутся при отрисовке;
--   листание по времени последней показанной записи, а не по номеру
--     страницы: журнал растёт, и номера страниц съезжают;
--   денежные записи весомее прочих — цена ошибки в них другая.
--
-- СДЕЛАНО ЛУЧШЕ: запись описывается СЛОВАМИ здесь, а не собирается в
-- браузере из кода действия и подробностей. У донора кабинет знал
-- список действий и переводил их сам — появилось новое действие,
-- кабинет показал его кодом, вроде «tenant_suspended», и человек
-- гадает, что это было.
--
-- Здесь же считается ВЕС записи: деньги, доступ, прочее. Кабинет
-- показывает по весу, а не решает сам, что важнее.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_journal(
  p_role text, p_user uuid,
  p_before timestamptz DEFAULT NULL,
  p_account uuid DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_weight text DEFAULT NULL,
  p_limit integer DEFAULT 50)
RETURNS TABLE (
  id bigint, at timestamptz, actor text, actor_id uuid,
  action text, title text, detail text, weight text,
  account_id uuid, client text, amount bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pa.id, pa.at, pa.actor_name, pa.actor_id, pa.action,

    -- Описание словами. Новое действие без перевода покажется своим
    -- кодом — но хотя бы один раз и в одном месте, а не в каждом
    -- кабинете по-разному.
    CASE pa.action
      WHEN 'payment_recorded'    THEN 'Отмечена оплата'
      WHEN 'payment_approved'    THEN 'Оплата подтверждена'
      WHEN 'payment_rejected'    THEN 'Оплата отклонена'
      WHEN 'payment_declared'    THEN 'Клиент сообщил об оплате'
      WHEN 'partner_created'     THEN 'Заведён партнёр'
      WHEN 'partner_updated'     THEN 'Изменён партнёр'
      WHEN 'partner_enabled'     THEN 'Партнёру открыт вход'
      WHEN 'partner_disabled'    THEN 'Партнёру закрыт вход'
      WHEN 'partner_assigned'    THEN 'Назначен партнёр'
      WHEN 'tenant_created'      THEN 'Заведён магазин'
      WHEN 'tenant_deleted'      THEN 'Магазин отключён'
      WHEN 'tenant_suspended'    THEN 'Магазин заморожен'
      WHEN 'tenant_enabled'      THEN 'Магазин разморожен'
      WHEN 'tier_changed'        THEN 'Сменён тариф'
      WHEN 'plan_line_added'     THEN 'Добавлена строка счёта'
      WHEN 'plan_line_edited'    THEN 'Изменена строка счёта'
      WHEN 'plan_line_closed'    THEN 'Закрыта строка счёта'
      WHEN 'price_book_changed'  THEN 'Изменены цены платформы'
      WHEN 'pay_settings_changed' THEN 'Изменены реквизиты оплаты'
      WHEN 'device_added'        THEN 'Подключено устройство'
      WHEN 'request_created'     THEN 'Подана заявка'
      WHEN 'request_approved'    THEN 'Заявка одобрена'
      WHEN 'request_rejected'    THEN 'Заявка отклонена'
      WHEN 'signup_approved'     THEN 'Одобрена самозапись'
      WHEN 'signup_rejected'     THEN 'Отклонена самозапись'
      WHEN 'owner_password_reset' THEN 'Сброшен пароль владельцу'
      WHEN 'activation_code_taken' THEN 'Взят код активации кассы'
      WHEN 'funnel_moved'        THEN 'Сдвинута карточка в воронке'
      WHEN 'marked_demo'         THEN 'Помечен учебным'
      WHEN 'unmarked_demo'       THEN 'Снята пометка учебного'
      WHEN 'lead_updated'        THEN 'Обновлена заявка с сайта'
      WHEN 'billing_reminder'    THEN 'Напоминание о подписке'
      WHEN 'bulk_grace'          THEN 'Массовая отсрочка'
      WHEN 'bulk_disable'        THEN 'Массовая заморозка'
      WHEN 'bulk_enable'         THEN 'Массовая разморозка'
      ELSE pa.action
    END,

    -- Подробности одной строкой: что именно поменялось.
    nullif(concat_ws(' · ',
      CASE WHEN pa.details ? 'amount'
           THEN (pa.details->>'amount') || ' ₸' END,
      CASE WHEN pa.details ? 'months'
           THEN (pa.details->>'months') || ' мес.' END,
      CASE WHEN pa.details ? 'partnerShare'
           THEN 'партнёру ' || (pa.details->>'partnerShare') || ' ₸' END,
      CASE WHEN pa.details ? 'reason' THEN 'причина: ' || (pa.details->>'reason') END,
      CASE WHEN pa.details ? 'note' AND pa.details->>'note' <> ''
           THEN pa.details->>'note' END,
      CASE WHEN pa.details ? 'title' THEN pa.details->>'title' END,
      CASE WHEN pa.details ? 'stage' THEN 'этап: ' || (pa.details->>'stage') END,
      CASE WHEN pa.details ? 'count' THEN 'затронуто: ' || (pa.details->>'count') END,
      CASE WHEN pa.details ? 'name' THEN pa.details->>'name' END
    ), ''),

    -- Вес записи. Деньги весомее прочего: цена ошибки в них другая.
    -- Считаем здесь, чтобы кабинет не решал сам, что важнее.
    CASE
      WHEN pa.action LIKE 'payment%' OR pa.action LIKE 'plan_line%'
        OR pa.action IN ('tier_changed','price_book_changed','device_added',
                         'pay_settings_changed','bulk_grace')
        THEN 'money'
      WHEN pa.action IN ('tenant_deleted','tenant_suspended','owner_password_reset',
                         'partner_disabled','bulk_disable','signup_rejected')
        THEN 'access'
      ELSE 'other'
    END,

    pa.account_id, a.name,
    CASE WHEN pa.details ? 'amount'
         THEN ((pa.details->>'amount')::numeric * 100)::bigint END

    FROM platform_audit pa
    LEFT JOIN account a ON a.id = pa.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = pa.account_id
   WHERE (p_before IS NULL OR pa.at < p_before)
     AND (p_account IS NULL OR pa.account_id = p_account)
     AND (p_actor IS NULL OR pa.actor_id = p_actor)
     -- Партнёру записи по чужим клиентам не приходят ВОВСЕ, а не
     -- прячутся при отрисовке.
     AND (p_role = 'super'
          OR pa.actor_id = p_user
          OR tc.partner_id = p_user)
     AND (p_weight IS NULL OR p_weight = 'all' OR
          p_weight = CASE
            WHEN pa.action LIKE 'payment%' OR pa.action LIKE 'plan_line%'
              OR pa.action IN ('tier_changed','price_book_changed','device_added',
                               'pay_settings_changed','bulk_grace') THEN 'money'
            WHEN pa.action IN ('tenant_deleted','tenant_suspended','owner_password_reset',
                               'partner_disabled','bulk_disable','signup_rejected') THEN 'access'
            ELSE 'other' END)
   ORDER BY pa.at DESC
   LIMIT least(greatest(p_limit, 1), 200);
$$;
GRANT EXECUTE ON FUNCTION platform_journal(text, uuid, timestamptz, uuid, uuid, text, integer) TO shop_app;
