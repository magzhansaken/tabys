-- =====================================================================
-- 006_import.sql — ИМПОРТ НОМЕНКЛАТУРЫ
-- МойСклад прямо предупреждает: «Удалить некорректно созданные товары и
-- группы импортом не получится, это нужно будет делать вручную».
-- Владелец залил 2000 строк криво — и разгребает руками неделю.
-- Наш ответ: каждый импорт — сеанс с журналом и КНОПКОЙ ОТКАТА.
-- =====================================================================
CREATE TYPE import_status AS ENUM ('preview','running','done','failed','rolled_back');

CREATE TABLE import_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id  uuid REFERENCES employee(id),
  file_name    text,
  status       import_status NOT NULL DEFAULT 'preview',
  match_field  text NOT NULL DEFAULT 'barcode',    -- по чему искать существующие (модель МС)
  mapping      jsonb NOT NULL DEFAULT '{}',        -- столбец файла → поле карточки (модель Wipon)
  total_rows   integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  error_count  integer NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]',
  started_at   timestamptz,
  finished_at  timestamptz,
  rolled_back_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON import_session(account_id, created_at DESC);

-- что именно сделал импорт: без этого откат невозможен
CREATE TABLE import_row (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES import_session(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  product_id  uuid,
  action      text NOT NULL,                       -- created / updated / skipped / error
  before      jsonb,                               -- прежние значения: для отката обновлений
  error       text
);
CREATE INDEX ON import_row(session_id);

ALTER TABLE product ADD COLUMN import_session_id uuid REFERENCES import_session(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_session','import_row']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ОТКАТ ИМПОРТА — то, чего нет ни у одного из троих.
-- Созданные товары уходят в архив (не удаляем: на них уже могли
-- сослаться продажи), обновлённым возвращаются прежние значения.
-- =====================================================================
CREATE OR REPLACE FUNCTION rollback_import(p_account uuid, p_session uuid)
RETURNS TABLE (archived integer, restored integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE a integer := 0; r integer := 0; rec record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM import_session WHERE id = p_session AND account_id = p_account) THEN
    RAISE EXCEPTION 'Импорт не найден';
  END IF;

  UPDATE product SET deleted_at = now()
   WHERE account_id = p_account AND import_session_id = p_session
     AND id IN (SELECT product_id FROM import_row WHERE session_id = p_session AND action = 'created')
     AND deleted_at IS NULL;
  GET DIAGNOSTICS a = ROW_COUNT;

  FOR rec IN SELECT product_id, before FROM import_row
              WHERE session_id = p_session AND action = 'updated' AND before IS NOT NULL
  LOOP
    UPDATE product SET
      name = coalesce(rec.before->>'name', name),
      purchase_price = coalesce((rec.before->>'purchase_price')::numeric, purchase_price),
      ntin = rec.before->>'ntin'
     WHERE id = rec.product_id AND account_id = p_account;
    r := r + 1;
  END LOOP;

  UPDATE import_session SET status = 'rolled_back', rolled_back_at = now() WHERE id = p_session;
  RETURN QUERY SELECT a, r;
END $$;
GRANT EXECUTE ON FUNCTION rollback_import(uuid,uuid) TO shop_app;
