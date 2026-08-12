-- =====================================================================
-- 045_operator_signup_functions.sql — Часть 38 (продолжение).
--
-- Отдельным файлом от 044 сознательно: статус 'pending' добавлен там, а
-- pisать функции, использующие его, можно только в СЛЕДУЮЩЕЙ транзакции.
-- apply.sh применяет каждый файл одной транзакцией, поэтому разделение
-- файлов решает вопрос без ухищрений.
--
-- Оператор живёт вне магазинов, поэтому построчная защита его запросы не
-- пропускает. Как и остальные операторские выборки (миграция 027), делаем
-- SECURITY DEFINER-функции: доступ ровно к нужным полям, не больше.
-- =====================================================================

CREATE OR REPLACE FUNCTION operator_signups()
RETURNS TABLE (id uuid, name text, phone text, owner_name text,
               signup_note text, created_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT a.id, a.name, a.phone,
         (SELECT e.first_name FROM employee e
           WHERE e.account_id = a.id AND e.is_owner LIMIT 1),
         a.signup_note, a.created_at
    FROM account a
   WHERE a.status = 'pending'
   ORDER BY a.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION operator_signups() TO shop_app;

-- Активация заявки: pending → trial (пробный период уже начислен при
-- регистрации) или сразу active, если клиент оплатил.
CREATE OR REPLACE FUNCTION operator_activate(p_account uuid, p_status text, p_by text)
RETURNS TABLE (id uuid, name text, status account_status)
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE account
     SET status = (CASE WHEN p_status = 'active' THEN 'active' ELSE 'trial' END)::account_status,
         activated_at = now(), activated_by = p_by
   WHERE id = p_account AND status = 'pending'
  RETURNING id, name, status;
$$;
GRANT EXECUTE ON FUNCTION operator_activate(uuid, text, text) TO shop_app;

-- Сброс пароля владельца оператором (пока нет СМС-восстановления).
CREATE OR REPLACE FUNCTION operator_reset_owner_password(p_account uuid, p_hash text)
RETURNS uuid
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE employee SET password_hash = p_hash
   WHERE account_id = p_account AND is_owner
  RETURNING id;
$$;
GRANT EXECUTE ON FUNCTION operator_reset_owner_password(uuid, text) TO shop_app;
