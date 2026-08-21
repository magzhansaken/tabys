-- УДАЧНЫЙ ВХОД СБРАСЫВАЕТ СЧЁТЧИК ПОПЫТОК.
--
-- Владелец жаловался: вход в кабинет работает ЧЕРЕЗ РАЗ.
--
-- Причина: счётчик считал неудачи за пять минут и НЕ ОБНУЛЯЛСЯ при
-- удачном входе.
--
-- Владелец ошибается паролем четыре раза — это нормально: пароль выдан
-- один раз, он ищет его в переписке. Потом входит. Счётчик всё равно
-- четыре.
--
-- Через минуту опечатался ОДИН раз — и заперт на пять минут, хотя
-- только что входил успешно. Отсюда «через раз».
--
-- Защита от подбора при этом остаётся: пять неудач ПОДРЯД, без единого
-- удачного входа между ними, по-прежнему запирают. Подбирающий пароль
-- удачных входов не делает — ему сбрасывать нечего.

CREATE OR REPLACE FUNCTION auth_is_locked_out(p_identifier text, p_kind login_kind)
RETURNS boolean
STABLE SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT count(*) >= 5
    FROM login_attempt
   WHERE identifier = p_identifier
     AND kind = p_kind
     AND NOT success
     AND ts > now() - interval '5 minutes'
     -- СЧИТАЕМ ТОЛЬКО ПОСЛЕ ПОСЛЕДНЕГО УДАЧНОГО ВХОДА.
     -- Вошёл — прошлые опечатки прощены.
     AND ts > coalesce(
       (SELECT max(ts) FROM login_attempt s
         WHERE s.identifier = p_identifier AND s.kind = p_kind AND s.success),
       '-infinity'::timestamptz);
$$;

COMMENT ON FUNCTION auth_is_locked_out(text, login_kind) IS
  'Заперт ли вход. Считает неудачи ПОСЛЕ последнего удачного входа: вошёл — прошлые опечатки прощены';
