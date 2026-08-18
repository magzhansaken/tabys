-- =====================================================================
-- 073_funnel_auto.sql — вернуть карточку к выводу из фактов.
--
-- НАЙДЕНО СВЕРКОЙ. Ручной этап сильнее выведенного — это верно:
-- человек знает больше системы. Но ОТМЕНИТЬ его было нельзя.
--
-- Что из этого следовало. Партнёр в сердцах двинул карточку в «Отказ»,
-- клиент через неделю оплатил — и карточка НАВСЕГДА осталась в
-- «Отказе». Она платит, работает, приносит деньги, а в воронке лежит
-- в архиве. Вернуть её в живые этапы можно было только руками, и
-- дальше она снова застревает.
--
-- Теперь: этап 'auto' снимает ручную отметку, и карточка снова
-- слушается фактов.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_funnel_move(uuid, text, text);

CREATE OR REPLACE FUNCTION platform_funnel_move(
  p_account uuid, p_stage text, p_note text DEFAULT NULL)
RETURNS TABLE (stage text, manual boolean, note text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_auto boolean := (p_stage = 'auto');
BEGIN
  INSERT INTO tenant_card (account_id, deal_stage, stage_manual, deal_note, touched_at)
  VALUES (p_account,
          CASE WHEN v_auto THEN 'new' ELSE p_stage END,
          NOT v_auto,
          p_note, now())
  ON CONFLICT (account_id) DO UPDATE SET
    -- 'auto' СНИМАЕТ ручную отметку: карточка снова слушается фактов.
    -- Прежний этап оставляем как есть — поле не терпит пустоты, а
    -- показываться всё равно будет выведенный: воронка смотрит на
    -- stage_manual, а не на это поле.
    deal_stage  = CASE WHEN v_auto THEN tenant_card.deal_stage ELSE p_stage END,
    stage_manual = NOT v_auto,
    -- Пустая заметка не стирает прежнюю: человек мог не трогать поле.
    deal_note   = coalesce(nullif(p_note, ''), tenant_card.deal_note),
    touched_at  = now(),
    updated_at  = now();

  RETURN QUERY
    SELECT CASE WHEN v_auto THEN 'auto' ELSE p_stage END,
           NOT v_auto,
           CASE WHEN v_auto
                THEN 'Этап снова выводится из фактов'
                ELSE 'Этап поставлен руками — он сильнее того, что система выводит из фактов'
           END;
END; $$;
GRANT EXECUTE ON FUNCTION platform_funnel_move(uuid, text, text) TO shop_app;
