-- =====================================================================
-- 002_auth.sql — АУТЕНТИФИКАЦИЯ
-- Решения и обоснования: docs/1.2_Решения_аутентификация.md
-- Модель: кабинет = телефон+пароль (JWT+refresh с ротацией),
--         касса = привязанное устройство (одноразовый ключ, UMAG) + PIN 4 цифры,
--         офлайн-вход — локальная проверка PIN на устройстве.
-- =====================================================================

-- Wipon «Администратор смены»: одна смена, переключение сотрудников.
-- У владельца включён всегда и не снимается.
ALTER TABLE employee ADD COLUMN is_shift_admin boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN employee.is_shift_admin IS 'Может управлять общей сменой и переключать кассиров (Wipon multi-account)';

-- PIN уникален внутри аккаунта: иначе подписи операций будут врать.
-- Храним хэш, поэтому уникальность обеспечиваем по отдельному «отпечатку».
ALTER TABLE employee ADD COLUMN pos_pin_fp text;
COMMENT ON COLUMN employee.pos_pin_fp IS 'HMAC-отпечаток PIN для контроля уникальности в аккаунте (сам PIN не хранится)';
CREATE UNIQUE INDEX employee_pin_uniq ON employee(account_id, pos_pin_fp)
  WHERE pos_pin_fp IS NOT NULL AND deleted_at IS NULL AND dismissed_at IS NULL;

-- =====================================================================
-- REFRESH-ТОКЕНЫ. Ротация: каждое обновление гасит старый и выдаёт новый.
-- Повторное использование погашенного = признак кражи → гасим всё семейство.
-- =====================================================================
CREATE TABLE refresh_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,                       -- цепочка ротации одного входа
  token_hash    text NOT NULL,                       -- sha256 от токена
  user_agent    text,
  ip            inet,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,                         -- когда обменян на новый
  revoked_at    timestamptz,
  revoke_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON refresh_token(token_hash);
CREATE INDEX ON refresh_token(account_id, employee_id);
CREATE INDEX ON refresh_token(family_id);

-- =====================================================================
-- OTP: SMS-коды. Регистрация и восстановление пароля — по телефону,
-- потому что почты у владельца магазина может не быть (в отличие от МС).
-- =====================================================================
CREATE TYPE otp_purpose AS ENUM ('register','reset_password','change_phone','confirm');

CREATE TABLE otp_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  purpose     otp_purpose NOT NULL,
  code_hash   text NOT NULL,                         -- сам код не храним
  attempts    smallint NOT NULL DEFAULT 0,           -- попыток ввода (лимит 3)
  sent_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                  -- +5 минут
  used_at     timestamptz,
  ip          inet
);
CREATE INDEX ON otp_code(phone, purpose, sent_at DESC);

-- =====================================================================
-- ЖУРНАЛ ПОПЫТОК ВХОДА: защита от перебора + владелец видит, кто ломился.
-- =====================================================================
CREATE TYPE login_kind AS ENUM ('admin_password','pos_pin','device_pairing','otp','support');

CREATE TABLE login_attempt (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES account(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employee(id) ON DELETE SET NULL,
  device_id   uuid REFERENCES device(id) ON DELETE SET NULL,
  kind        login_kind NOT NULL,
  identifier  text,                                  -- телефон / код привязки
  success     boolean NOT NULL,
  reason      text,                                  -- почему отказ
  ip          inet,
  user_agent  text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON login_attempt(identifier, ts DESC);
CREATE INDEX ON login_attempt(account_id, ts DESC);
CREATE INDEX ON login_attempt(device_id, ts DESC);

-- =====================================================================
-- СЕССИЯ НА КАССЕ: кто сейчас за кассой. Мультиаккаунт (Wipon): одна смена,
-- несколько кассиров, каждая операция подписана реальным исполнителем.
-- =====================================================================
CREATE TABLE pos_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  cash_register_id uuid REFERENCES cash_register(id),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  end_reason    text,                                -- switch_user / logout / timeout
  offline       boolean NOT NULL DEFAULT false,      -- вход прошёл без сети
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pos_session(account_id, device_id, started_at DESC);
CREATE UNIQUE INDEX one_active_session_per_device ON pos_session(device_id) WHERE ended_at IS NULL;

-- =====================================================================
-- ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ СТАРШИМ (UMAG: скан штрихкода администратора).
-- Наше расширение: бейдж ИЛИ PIN, работает офлайн, две подписи в журнале.
-- =====================================================================
CREATE TABLE action_approval (
  id            uuid PRIMARY KEY,                    -- UUID с устройства (офлайн!)
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES device(id),
  requested_by  uuid NOT NULL REFERENCES employee(id),   -- кто выполнял
  approved_by   uuid NOT NULL REFERENCES employee(id),   -- кто разрешил
  action        text NOT NULL,                       -- refund / refund_no_receipt / remove_line / decrease_qty / price_edit
  entity        text,
  entity_id     uuid,
  method        text NOT NULL CHECK (method IN ('badge','pin')),
  approved_at   timestamptz NOT NULL,
  offline       boolean NOT NULL DEFAULT false,
  synced_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON action_approval(account_id, approved_at DESC);
CREATE INDEX ON action_approval(requested_by);

-- =====================================================================
-- ДОСТУП ПОДДЕРЖКИ: у нас уже есть support_access (001). Добавляем сессии —
-- чтобы каждое действие «от имени поддержки» было видно в журнале.
-- =====================================================================
CREATE TABLE support_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_id     uuid NOT NULL REFERENCES support_access(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  grantee_phone text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  ip            inet,
  actions_count integer NOT NULL DEFAULT 0
);
CREATE INDEX ON support_session(account_id, started_at DESC);

-- аудит: помечаем действия, сделанные поддержкой
ALTER TABLE audit_log ADD COLUMN support_session_id uuid REFERENCES support_session(id);
ALTER TABLE audit_log ADD COLUMN approved_by uuid REFERENCES employee(id);

-- =====================================================================
-- RLS для новых таблиц с account_id
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['refresh_token','login_attempt','pos_session','action_approval','support_session']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON otp_code TO shop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- login_attempt пишется ДО того, как известен аккаунт (неверный телефон),
-- поэтому строки с account_id IS NULL должны быть вставляемы:
DROP POLICY tenant_isolation ON login_attempt;
CREATE POLICY login_attempt_policy ON login_attempt USING
  (account_id IS NULL OR account_id = nullif(current_setting('app.account_id', true), '')::uuid);

-- =====================================================================
-- ФУНКЦИЯ: не даём завести PIN, который уже занят другим сотрудником.
-- (Сам PIN не хранится — сравниваем отпечатки.)
-- =====================================================================
CREATE OR REPLACE FUNCTION check_pin_unique(p_account uuid, p_fp text, p_employee uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM employee
    WHERE account_id = p_account AND pos_pin_fp = p_fp
      AND deleted_at IS NULL AND dismissed_at IS NULL
      AND (p_employee IS NULL OR id <> p_employee)
  );
$$;
GRANT EXECUTE ON FUNCTION check_pin_unique(uuid,text,uuid) TO shop_app;

-- =====================================================================
-- ФУНКЦИЯ: блокировка перебора. 5 неудач за 5 минут → блок на 5 минут.
-- Работает и для PIN на кассе (когда касса онлайн), и для входа в кабинет.
-- =====================================================================
CREATE OR REPLACE FUNCTION is_locked_out(p_identifier text, p_kind login_kind)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT count(*) >= 5 FROM login_attempt
  WHERE identifier = p_identifier AND kind = p_kind
    AND NOT success AND ts > now() - interval '5 minutes';
$$;
GRANT EXECUTE ON FUNCTION is_locked_out(text, login_kind) TO shop_app;

-- =====================================================================
-- ФУНКЦИИ ВХОДА (SECURITY DEFINER).
-- Проблема: до успешного входа аккаунт неизвестен, а RLS закрывает employee.
-- Решение: узкие функции, отдающие РОВНО минимум для проверки пароля.
-- Они не возвращают ни бизнес-данные, ни чужие строки.
-- =====================================================================
CREATE OR REPLACE FUNCTION auth_find_employee_by_phone(p_phone text)
RETURNS TABLE (
  employee_id uuid, account_id uuid, password_hash text, role_id uuid,
  is_active boolean, can_login_admin boolean, dismissed boolean,
  account_status account_status, first_name text
)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT e.id, e.account_id, e.password_hash, e.role_id,
         e.is_active, e.can_login_admin, (e.dismissed_at IS NOT NULL),
         a.status, e.first_name
  FROM employee e JOIN account a ON a.id = e.account_id
  WHERE e.phone = p_phone AND e.deleted_at IS NULL
  ORDER BY e.is_owner DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION auth_find_employee_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_employee_by_phone(text) TO shop_app;

-- Поиск устройства по хэшу токена (касса шлёт токен в заголовке)
CREATE OR REPLACE FUNCTION auth_find_device_by_token(p_hash text)
RETURNS TABLE (
  device_id uuid, account_id uuid, cash_register_id uuid, store_id uuid,
  is_blocked boolean, account_status account_status
)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT d.id, d.account_id, d.cash_register_id, c.store_id, d.is_blocked, a.status
  FROM device d
  JOIN account a ON a.id = d.account_id
  LEFT JOIN cash_register c ON c.id = d.cash_register_id
  WHERE d.token_hash = p_hash AND d.deleted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION auth_find_device_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_device_by_token(text) TO shop_app;

-- Привязка устройства одноразовым ключом (модель UMAG).
-- Ключ одноразовый: после успешной привязки он гасится.
CREATE OR REPLACE FUNCTION auth_pair_device(p_code text, p_token_hash text, p_platform platform_type, p_version text)
RETURNS TABLE (device_id uuid, account_id uuid, cash_register_id uuid)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  SELECT * INTO d FROM device
   WHERE pairing_code = p_code AND pairing_expires_at > now()
     AND token_hash IS NULL AND deleted_at IS NULL AND NOT is_blocked;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE device SET token_hash = p_token_hash, platform = p_platform, app_version = p_version,
         paired_at = now(), pairing_code = NULL, pairing_expires_at = NULL, last_seen_at = now()
   WHERE id = d.id;
  UPDATE cash_register SET platform = p_platform, app_version = p_version, last_seen_at = now()
   WHERE id = d.cash_register_id;

  RETURN QUERY SELECT d.id, d.account_id, d.cash_register_id;
END $$;
REVOKE ALL ON FUNCTION auth_pair_device(text,text,platform_type,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_pair_device(text,text,platform_type,text) TO shop_app;

-- Проверка OTP по телефону (до входа аккаунта нет)
CREATE OR REPLACE FUNCTION auth_consume_otp(p_phone text, p_purpose otp_purpose, p_code_hash text)
RETURNS boolean SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  SELECT * INTO o FROM otp_code
   WHERE phone = p_phone AND purpose = p_purpose AND used_at IS NULL
     AND expires_at > now() AND attempts < 3
   ORDER BY sent_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  IF o.code_hash <> p_code_hash THEN
    UPDATE otp_code SET attempts = attempts + 1 WHERE id = o.id;
    RETURN false;
  END IF;

  UPDATE otp_code SET used_at = now() WHERE id = o.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION auth_consume_otp(text,otp_purpose,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_consume_otp(text,otp_purpose,text) TO shop_app;

-- =====================================================================
-- ФУНКЦИИ ДЛЯ ОПЕРАЦИЙ «ДО ТЕНАНТА».
-- Ловушка: при входе app.account_id ещё не установлен, поэтому RLS закрывает
-- login_attempt и refresh_token — счётчик попыток читал бы 0 строк, и защита
-- от перебора молча не работала бы. Поэтому — узкие SECURITY DEFINER функции.
-- =====================================================================

-- Журнал попытки входа (пишется и когда аккаунт ещё неизвестен)
CREATE OR REPLACE FUNCTION auth_log_attempt(
  p_account uuid, p_employee uuid, p_device uuid, p_kind login_kind,
  p_identifier text, p_success boolean, p_reason text DEFAULT NULL,
  p_ip inet DEFAULT NULL, p_ua text DEFAULT NULL)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  INSERT INTO login_attempt (account_id, employee_id, device_id, kind, identifier, success, reason, ip, user_agent)
  VALUES (p_account, p_employee, p_device, p_kind, p_identifier, p_success, p_reason, p_ip, p_ua);
$$;
REVOKE ALL ON FUNCTION auth_log_attempt(uuid,uuid,uuid,login_kind,text,boolean,text,inet,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_log_attempt(uuid,uuid,uuid,login_kind,text,boolean,text,inet,text) TO shop_app;

-- Счётчик неудач (SECURITY DEFINER, иначе RLS вернёт 0 и блокировки не будет)
CREATE OR REPLACE FUNCTION auth_is_locked_out(p_identifier text, p_kind login_kind)
RETURNS boolean SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT count(*) >= 5 FROM login_attempt
  WHERE identifier = p_identifier AND kind = p_kind
    AND NOT success AND ts > now() - interval '5 minutes';
$$;
REVOKE ALL ON FUNCTION auth_is_locked_out(text, login_kind) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_is_locked_out(text, login_kind) TO shop_app;
DROP FUNCTION IF EXISTS is_locked_out(text, login_kind);

-- Обмен refresh-токена: находит токен и сразу помечает использованным.
-- Возвращает признак повторного использования — это детект кражи.
CREATE OR REPLACE FUNCTION auth_use_refresh(p_hash text)
RETURNS TABLE (account_id uuid, employee_id uuid, family_id uuid, reuse boolean, expired boolean, blocked boolean)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  SELECT rt.*, e.is_active, e.dismissed_at INTO t
    FROM refresh_token rt JOIN employee e ON e.id = rt.employee_id
   WHERE rt.token_hash = p_hash;
  IF NOT FOUND THEN RETURN; END IF;

  IF t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL THEN
    -- токен уже обменивали → гасим всю цепочку входа
    UPDATE refresh_token SET revoked_at = now(), revoke_reason = 'reuse_detected'
     WHERE refresh_token.family_id = t.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT t.account_id, t.employee_id, t.family_id, true, false, false;
    RETURN;
  END IF;

  IF t.expires_at < now() THEN
    RETURN QUERY SELECT t.account_id, t.employee_id, t.family_id, false, true, false; RETURN;
  END IF;
  IF NOT t.is_active OR t.dismissed_at IS NOT NULL THEN
    RETURN QUERY SELECT t.account_id, t.employee_id, t.family_id, false, false, true; RETURN;
  END IF;

  UPDATE refresh_token SET used_at = now() WHERE id = t.id;
  RETURN QUERY SELECT t.account_id, t.employee_id, t.family_id, false, false, false;
END $$;
REVOKE ALL ON FUNCTION auth_use_refresh(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_use_refresh(text) TO shop_app;

-- Гашение сессии при выходе
CREATE OR REPLACE FUNCTION auth_revoke_refresh(p_hash text, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE refresh_token SET revoked_at = now(), revoke_reason = p_reason
   WHERE token_hash = p_hash AND revoked_at IS NULL;
$$;
REVOKE ALL ON FUNCTION auth_revoke_refresh(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_revoke_refresh(text,text) TO shop_app;

-- Отметка «устройство на связи» (вызывается до установки тенанта)
CREATE OR REPLACE FUNCTION auth_touch_device(p_device uuid)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE device SET last_seen_at = now() WHERE id = p_device;
$$;
REVOKE ALL ON FUNCTION auth_touch_device(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_touch_device(uuid) TO shop_app;

-- Список аккаунтов, открывших доступ специалисту (экран поддержки)
CREATE OR REPLACE FUNCTION auth_list_support_grants(p_phone text)
RETURNS TABLE (access_id uuid, account_id uuid, account_name text, expires_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT sa.id, sa.account_id, a.name, sa.expires_at
    FROM support_access sa JOIN account a ON a.id = sa.account_id
   WHERE sa.grantee_phone = p_phone AND sa.revoked_at IS NULL
     AND (sa.expires_at IS NULL OR sa.expires_at > now());
$$;
REVOKE ALL ON FUNCTION auth_list_support_grants(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_list_support_grants(text) TO shop_app;

-- Проверка, что доступ поддержки действительно выдан (перед входом в чужой аккаунт)
CREATE OR REPLACE FUNCTION auth_check_support_access(p_phone text, p_account uuid)
RETURNS uuid SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT sa.id FROM support_access sa
   WHERE sa.grantee_phone = p_phone AND sa.account_id = p_account
     AND sa.revoked_at IS NULL AND (sa.expires_at IS NULL OR sa.expires_at > now())
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION auth_check_support_access(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_check_support_access(text,uuid) TO shop_app;

-- Проверка уникальности PIN выполняется ДО установки тенанта (в сервисе),
-- поэтому обычная функция читала бы employee через RLS и всегда отвечала
-- «уникален». Делаем SECURITY DEFINER с явным ограничением по аккаунту.
CREATE OR REPLACE FUNCTION check_pin_unique(p_account uuid, p_fp text, p_employee uuid DEFAULT NULL)
RETURNS boolean SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM employee
    WHERE account_id = p_account AND pos_pin_fp = p_fp
      AND deleted_at IS NULL AND dismissed_at IS NULL
      AND (p_employee IS NULL OR id <> p_employee)
  );
$$;
REVOKE ALL ON FUNCTION check_pin_unique(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_pin_unique(uuid,text,uuid) TO shop_app;
