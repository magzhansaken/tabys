-- =====================================================================
-- 101_code_for_register.sql — код для НУЖНОЙ кассы, а не всегда первой.
--
-- НАЙДЕНО ПРИ ПРОВЕРКЕ СПИСКА УСТРОЙСТВ. Кнопка «Код для кассы» брала
-- ПЕРВУЮ кассу по времени заведения — и только её.
--
-- Пока касса одна, это незаметно и работает. Но мы только что научились
-- добавлять вторую: клиент купил её, платит три тысячи в месяц, просит
-- код — а система снова и снова выдаёт код первой.
--
-- Он вводит его на новом планшете, тот привязывается к СТАРОЙ кассе, и
-- две кассы начинают спорить за одно рабочее место. Разобраться в этом
-- по звонку почти нельзя.
--
-- Теперь можно указать, какой кассе нужен код. Без указания — первой,
-- как раньше: у большинства клиентов касса одна, и лишний выбор им ни к
-- чему.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_pairing_code(
  p_account uuid, p_register uuid DEFAULT NULL)
RETURNS TABLE (code text, expires_at timestamptz, register_name text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_reg record; v_code text;
BEGIN
  -- Какой кассе. Указали — берём её, проверив, что она этого клиента:
  -- иначе чужой код выдали бы по ошибке в ключе.
  IF p_register IS NOT NULL THEN
    SELECT cr.id, cr.name INTO v_reg FROM cash_register cr
     WHERE cr.id = p_register AND cr.account_id = p_account
       AND cr.deleted_at IS NULL;
    IF v_reg.id IS NULL THEN
      RAISE EXCEPTION 'Касса не найдена у этого клиента';
    END IF;
  ELSE
    -- Не указали — первая, как было. У большинства касса одна.
    SELECT cr.id, cr.name INTO v_reg FROM cash_register cr
     WHERE cr.account_id = p_account AND cr.deleted_at IS NULL
     ORDER BY cr.created_at LIMIT 1;
    IF v_reg.id IS NULL THEN RETURN; END IF;
  END IF;

  -- Код из восьми знаков в верхнем регистре: его диктуют по телефону,
  -- и так он читается вслух без «а это буква или цифра».
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

  -- Прежний непривязанный код гасим: иначе у кассы окажется два живых
  -- кода, и непонятно, какой ввели.
  UPDATE device SET deleted_at = now()
   WHERE cash_register_id = v_reg.id AND token_hash IS NULL AND deleted_at IS NULL;

  INSERT INTO device (account_id, cash_register_id, name, pairing_code, pairing_expires_at)
  VALUES (p_account, v_reg.id, v_reg.name, v_code, now() + interval '30 minutes');

  RETURN QUERY SELECT v_code, now() + interval '30 minutes', v_reg.name;
END; $$;
GRANT EXECUTE ON FUNCTION platform_pairing_code(uuid, uuid) TO shop_app;
