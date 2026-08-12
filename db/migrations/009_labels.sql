-- =====================================================================
-- 009_labels.sql — ЭТИКЕТКИ И ЦЕННИКИ
-- Решения: docs/2_Решения_товары.md, подчасть 2.4
-- Размеры — реальные рулоны из UMAG (58×40, 58×30, 43×25, 30×20) плюс
-- А4-сетка (МС) для тех, у кого нет термопринтера. Два языка на этикетке
-- (RU+KK) — модель UMAG. История печати с повтором — модель Wipon.
-- =====================================================================
CREATE TYPE label_kind AS ENUM ('label','price_tag');     -- UMAG разделяет: этикетка и ценник
CREATE TYPE paper_kind AS ENUM ('roll','a4');             -- термолента или обычный лист (МС)

CREATE TABLE label_template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          label_kind NOT NULL DEFAULT 'label',
  paper         paper_kind NOT NULL DEFAULT 'roll',
  width_mm      numeric(6,2) NOT NULL DEFAULT 58,
  height_mm     numeric(6,2) NOT NULL DEFAULT 40,
  -- А4-сетка: сколько этикеток на листе и отступы (модель МС)
  cols          integer NOT NULL DEFAULT 1,
  rows_per_page integer NOT NULL DEFAULT 1,
  margin_mm     numeric(5,2) NOT NULL DEFAULT 5,
  gap_mm        numeric(5,2) NOT NULL DEFAULT 2,
  font_scale    numeric(4,2) NOT NULL DEFAULT 1.0,        -- ползунок 0.2×–1.7× (UMAG)
  lang1         text NOT NULL DEFAULT 'ru',
  lang2         text,                                      -- максимум 2 языка (UMAG)
  fields        jsonb NOT NULL DEFAULT '{}',               -- что показывать (галочки UMAG)
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT font_scale_range CHECK (font_scale BETWEEN 0.2 AND 1.7),
  CONSTRAINT two_langs_max CHECK (lang2 IS NULL OR lang2 <> lang1)
);
CREATE INDEX ON label_template(account_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX label_default_uniq ON label_template(account_id, kind) WHERE is_default AND deleted_at IS NULL;

-- ИСТОРИЯ ПЕЧАТИ (модель Wipon): партия смялась в принтере — нажал «повторить»
-- и не собираешь список заново.
CREATE TABLE label_print_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id   uuid REFERENCES employee(id),
  template_id   uuid REFERENCES label_template(id),
  store_id      uuid REFERENCES store(id),
  items         jsonb NOT NULL,                            -- [{productId, qty}] — для повтора
  total_labels  integer NOT NULL DEFAULT 0,
  printed_at    timestamptz NOT NULL DEFAULT now(),
  repeated_from uuid REFERENCES label_print_job(id)
);
CREATE INDEX ON label_print_job(account_id, printed_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['label_template','label_print_job']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER label_template_touch BEFORE UPDATE ON label_template FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- Готовые шаблоны каждому новому клиенту: размеры реальных рулонов (UMAG)
CREATE OR REPLACE FUNCTION ensure_label_templates(p_account uuid)
RETURNS void SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM label_template WHERE account_id = p_account) THEN RETURN; END IF;
  INSERT INTO label_template (account_id, name, kind, paper, width_mm, height_mm, lang1, lang2, is_default, fields) VALUES
    (p_account, 'Этикетка 58×40', 'label', 'roll', 58, 40, 'ru', 'kk', true,
     '{"name":true,"barcode":true,"price":true,"article":false,"country":false,"date":true}'),
    (p_account, 'Этикетка 43×25', 'label', 'roll', 43, 25, 'ru', NULL, false,
     '{"name":true,"barcode":true,"price":true}'),
    (p_account, 'Этикетка 30×20', 'label', 'roll', 30, 20, 'ru', NULL, false,
     '{"name":true,"barcode":true,"price":false}'),
    (p_account, 'Ценник 58×30', 'price_tag', 'roll', 58, 30, 'ru', 'kk', true,
     '{"name":true,"price":true,"barcode":false}'),
    (p_account, 'Ценники на А4 (24 шт)', 'price_tag', 'a4', 70, 37, 'ru', 'kk', false,
     '{"name":true,"price":true,"barcode":false}');
  UPDATE label_template SET cols = 3, rows_per_page = 8 WHERE account_id = p_account AND paper = 'a4';
END $$;
GRANT EXECUTE ON FUNCTION ensure_label_templates(uuid) TO shop_app;

-- регистрация сразу даёт готовые шаблоны: клиент печатает в первый день
CREATE OR REPLACE FUNCTION register_account(p_phone text, p_name text, p_owner_name text, p_lang text DEFAULT 'ru')
RETURNS TABLE (account_id uuid, employee_id uuid)
SECURITY DEFINER SET search_path = public AS $$
DECLARE a_id uuid; e_id uuid; s_id uuid; w_id uuid; p_id uuid;
BEGIN
  INSERT INTO account (phone, name, lang) VALUES (p_phone, p_name, p_lang) RETURNING id INTO a_id;
  INSERT INTO pos_profile (account_id, name, is_default) VALUES (a_id, 'Стандартный', true) RETURNING id INTO p_id;
  INSERT INTO store (account_id, name, pos_profile_id) VALUES (a_id, p_name, p_id) RETURNING id INTO s_id;
  INSERT INTO warehouse (account_id, store_id, name, is_primary) VALUES (a_id, s_id, 'Основной склад', true) RETURNING id INTO w_id;
  UPDATE store SET default_warehouse_id = w_id WHERE id = s_id;
  INSERT INTO employee (account_id, role_id, first_name, phone, is_owner, can_login_admin, can_login_pos, position)
  VALUES (a_id, (SELECT id FROM role WHERE code='owner'), p_owner_name, p_phone, true, true, true, 'Владелец')
  RETURNING id INTO e_id;
  INSERT INTO employee_store (employee_id, store_id, account_id) VALUES (e_id, s_id, a_id);
  PERFORM ensure_price_types(a_id);
  PERFORM ensure_label_templates(a_id);
  RETURN QUERY SELECT a_id, e_id;
END $$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION register_account(text,text,text,text) TO shop_app;

DO $$
DECLARE a record;
BEGIN
  FOR a IN SELECT id FROM account LOOP PERFORM ensure_label_templates(a.id); END LOOP;
END $$;
