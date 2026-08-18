-- =====================================================================
-- 067_request_price.sql — цена при одобрении заявки задаётся руками.
--
-- НАЙДЕНО СВЕРКОЙ ПОВЕДЕНИЯ. У них при одобрении заявки на устройство
-- владелец платформы ВВОДИТ ЦЕНУ прямо в листе подтверждения, и рядом
-- показано, если партнёр предложил не прайсовую.
--
-- У меня цена бралась из прайса молча. Разница житейская: партнёр
-- договорился с клиентом на 2 000 вместо 3 000 — при молчаливом прайсе
-- это выяснится через месяц, когда клиент откажется платить по счёту.
--
-- Ноль тоже разрешён: строка появится бесплатной. Так дают вторую
-- кассу в подарок при переходе на год — и это видно в счёте, а не
-- держится в голове.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_request_decide(
  p_request uuid, p_actor uuid, p_approve boolean, p_note text,
  p_unit_price bigint DEFAULT NULL)
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
    -- Цена, которую ввёл владелец платформы. Ноль разрешён: бывает,
    -- что вторую кассу дают в подарок — и это должно быть видно в
    -- счёте строкой на ноль, а не держаться в голове.
    v_unit := coalesce(p_unit_price,
      CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
           ELSE v_set.price_extra_pos END);
    SELECT count(*) + 2 INTO v_n FROM plan_line pl
     WHERE pl.account_id = v_r.account_id AND pl.kind = v_kind AND pl.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, v_kind,
            CASE WHEN v_kind = 'store' THEN 'Точка №' ELSE 'Касса №' END || v_n, 1, v_unit);
    v_effect := CASE WHEN v_unit > 0
      THEN 'Строка счёта добавлена на ' || money_ru(v_unit) || ' ₸/мес'
      ELSE 'Строка счёта добавлена бесплатной' END;

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := coalesce(p_unit_price,
      CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
           THEN v_set.price_pro ELSE v_set.price_base END);
    UPDATE plan_line SET ends_at = now()
     WHERE plan_line.account_id = v_r.account_id AND plan_line.kind = 'base'
       AND plan_line.ends_at IS NULL;
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (v_r.account_id, 'base', 'Тариф', 1, v_unit);
    v_effect := 'Тариф изменён на ' || money_ru(v_unit) || ' ₸/мес';

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
GRANT EXECUTE ON FUNCTION platform_request_decide(uuid, uuid, boolean, text, bigint) TO shop_app;

-- Предпросмотр отдаёт и прайсовую цену: она подставляется в поле, и
-- владелец видит, от чего отталкивается.
-- Набор полей изменился — старую убираем.
DROP FUNCTION IF EXISTS platform_request_preview(uuid);

CREATE OR REPLACE FUNCTION platform_request_preview(p_request uuid)
RETURNS TABLE (
  kind text, client text, account_id uuid,
  what text, effect text, amount bigint, days_left integer,
  listed_price bigint)
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

  SELECT ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int INTO v_days
    FROM subscription s WHERE s.account_id = v_r.account_id;
  v_days := greatest(coalesce(v_days, 0), 0);

  IF v_r.kind = 'device' THEN
    v_kind := coalesce(v_r.payload->>'device', 'pos');
    v_unit := CASE WHEN v_kind = 'store' THEN v_set.price_extra_store
                   ELSE v_set.price_extra_pos END;
    IF v_days >= 10 THEN v_pro := round(v_unit * v_days / 30.0); END IF;
    v_what := CASE WHEN v_kind = 'store' THEN 'Вторая точка' ELSE 'Вторая касса' END;
    v_effect := 'Появится строка счёта на ' || money_ru(v_unit) || ' ₸/мес'
      || CASE WHEN v_pro > 0
              THEN '. Доплата за остаток периода: ' || money_ru(v_pro) || ' ₸'
              ELSE '. Доплаты нет — до конца периода меньше десяти дней' END;

  ELSIF v_r.kind = 'tariff' THEN
    v_unit := CASE WHEN coalesce(v_r.payload->>'tier', 'pro') = 'pro'
                   THEN v_set.price_pro ELSE v_set.price_base END;
    v_what := 'Смена тарифа на ' || CASE WHEN coalesce(v_r.payload->>'tier','pro') = 'pro'
                                         THEN '«Стандарт»' ELSE '«Старт»' END;
    v_effect := 'Основная строка счёта станет ' || money_ru(v_unit)
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
                      v_what, v_effect, v_pro, v_days, v_unit;
END; $$;
GRANT EXECUTE ON FUNCTION platform_request_preview(uuid) TO shop_app;
