-- =====================================================================
-- 047_api_keys.sql — Этап 11: публичный API с ключами.
--
-- ЗАЧЕМ. У нас 286 готовых обращений к серверу, но снаружи ими
-- пользоваться нельзя: вход только по паролю владельца. А просить у
-- клиента пароль от кабинета, чтобы бухгалтерская программа забирала
-- продажи, — недопустимо: пароль даёт всё, включая смену тарифа и
-- удаление данных.
--
-- Ключ решает это: он выдаётся под конкретную задачу, ограничен по
-- правам, его видно в списке и можно отозвать одной кнопкой, не меняя
-- пароль и не разлогинивая людей.
--
-- ХРАНИМ ТОЛЬКО ОТПЕЧАТОК КЛЮЧА, как пароль. Даже мы не можем его
-- подсмотреть. Если клиент потерял ключ — выдаём новый, а не
-- «восстанавливаем»: восстановить можно только то, что где-то лежит
-- открытым, а такого быть не должно.
--
-- ПРЕФИКС храним отдельно и показываем в списке: tby_a1b2… Без него
-- владелец не отличит «ключ для 1С» от «ключа для сайта», если сам
-- их не подписал, и в случае утечки не поймёт, какой отзывать.
-- =====================================================================

CREATE TABLE IF NOT EXISTS api_key (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,                   -- «Для 1С», «Сайт магазина»
  key_hash      text NOT NULL,                   -- отпечаток, не сам ключ
  prefix        text NOT NULL,                   -- начало ключа для опознания
  -- Права: список разделов с уровнем. Пусто = только чтение отчётов.
  -- Отдельный уровень, а не «всё или ничего»: программе, которая
  -- забирает продажи, не нужно право менять цены.
  scopes        text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES employee(id),
  last_used_at  timestamptz,
  last_used_ip  text,
  calls_count   bigint NOT NULL DEFAULT 0,
  expires_at    timestamptz,                     -- необязательный срок
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_hash)
);
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_key_isolation ON api_key;
CREATE POLICY api_key_isolation ON api_key
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key TO shop_app;
CREATE INDEX IF NOT EXISTS idx_api_key_account ON api_key(account_id) WHERE revoked_at IS NULL;

/**
 * Поиск ключа по отпечатку. SECURITY DEFINER, потому что на входе мы
 * ещё не знаем магазин — именно ключ его и определяет. Обычный запрос
 * под построчной защитой не увидел бы ни одной строки.
 *
 * Отдаём ровно то, что нужно для проверки доступа, и ничего больше.
 */
CREATE OR REPLACE FUNCTION api_key_lookup(p_hash text)
RETURNS TABLE (id uuid, account_id uuid, scopes text[], name text,
               expired boolean, revoked boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT k.id, k.account_id, k.scopes, k.name,
         (k.expires_at IS NOT NULL AND k.expires_at < now()),
         (k.revoked_at IS NOT NULL)
    FROM api_key k WHERE k.key_hash = p_hash;
$$;
GRANT EXECUTE ON FUNCTION api_key_lookup(text) TO shop_app;

/**
 * Отметка использования. Пишем в ту же строку без блокировок: счётчик
 * обращений и время последнего вызова нужны, чтобы владелец видел
 * живой ключ или забытый. Забытый ключ — это дверь, о которой никто
 * не помнит.
 */
CREATE OR REPLACE FUNCTION api_key_touch(p_id uuid, p_ip text)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  UPDATE api_key SET last_used_at = now(), last_used_ip = p_ip,
                     calls_count = calls_count + 1
   WHERE id = p_id;
$$;
GRANT EXECUTE ON FUNCTION api_key_touch(uuid, text) TO shop_app;
