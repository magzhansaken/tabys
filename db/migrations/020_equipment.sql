-- =====================================================================
-- 020_equipment.sql — ОБОРУДОВАНИЕ
-- Решения: docs/11_Решения_оборудование.md
--
-- Диагностика у всех вынесена наружу: МойСклад отправляет за утилитой АТОЛ
-- («отключите ККТ от Кассы, скачайте из центра загрузок, раскройте таблицу 15»),
-- Wipon пишет «переберите порты, пока устройство не подключится».
-- Здесь всё внутри программы: одна кнопка и человеческое объяснение.
-- =====================================================================
CREATE TYPE equipment_kind AS ENUM (
  'scales_print',    -- весы с печатью этикеток (Rongta)
  'scales_simple',   -- весы без печати, по COM-порту
  'label_printer',   -- принтер этикеток (Xprinter, Gprinter)
  'receipt_printer', -- чековый принтер
  'scanner',         -- сканер штрихкодов
  'customer_display',-- второй экран покупателя
  'cash_drawer',     -- денежный ящик
  'pos_terminal'     -- POS-терминал банка
);
CREATE TYPE equipment_conn AS ENUM ('lan','usb','com','bluetooth','builtin');
CREATE TYPE check_status AS ENUM ('ok','warning','error','skipped');

CREATE TABLE equipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind            equipment_kind NOT NULL,
  name            text NOT NULL,
  vendor          text,                          -- rongta / xprinter / gprinter
  model           text,
  connection      equipment_conn NOT NULL DEFAULT 'usb',

  -- сеть (весы Rongta по LAN — схема Wipon)
  ip_address      inet,
  port            integer,
  mac_address     text,
  -- COM/USB
  com_port        text,
  baud_rate       integer DEFAULT 9600,

  cash_register_id uuid REFERENCES cash_register(id),
  store_id        uuid REFERENCES store(id),
  device_id       uuid REFERENCES device(id),

  settings        jsonb NOT NULL DEFAULT '{}',   -- смещение печати, ширина этикетки и т.п.
  is_active       boolean NOT NULL DEFAULT true,
  last_seen_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON equipment(account_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX ON equipment(cash_register_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- ЯЧЕЙКИ PLU В ПАМЯТИ ВЕСОВ.
-- Модель Wipon: «Выберите ячейку → назначьте товар → Сохранить». Но у весов
-- Rongta память на тысячи ячеек — назначать по одной мышкой невозможно,
-- поэтому даём автоназначение и пакетную выгрузку.
-- =====================================================================
CREATE TABLE scale_plu (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  equipment_id  uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  cell          integer NOT NULL,                -- номер ячейки в памяти весов
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  price         numeric(12,2) NOT NULL,
  name_line1    text NOT NULL,                   -- на экране весов мало места
  name_line2    text,
  shelf_life_days integer,                       -- срок годности печатается на этикетке
  tare          numeric(8,3) DEFAULT 0,
  uploaded_at   timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (equipment_id, cell),
  UNIQUE (equipment_id, product_id)
);
CREATE INDEX ON scale_plu(account_id, equipment_id);

-- Журнал диагностики: видно, что проверяли и чем кончилось
CREATE TABLE equipment_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  equipment_id  uuid REFERENCES equipment(id) ON DELETE CASCADE,
  check_code    text NOT NULL,
  status        check_status NOT NULL,
  message       text,
  details       jsonb,
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON equipment_check(account_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['equipment','scale_plu','equipment_check']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER equipment_touch BEFORE UPDATE ON equipment FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- СВОБОДНАЯ ЯЧЕЙКА ВЕСОВ: назначаем сами, человек не должен помнить,
-- какая занята
-- =====================================================================
CREATE OR REPLACE FUNCTION next_free_cell(p_equipment uuid)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(min(c), 1) FROM generate_series(1, 4000) c
   WHERE c NOT IN (SELECT cell FROM scale_plu WHERE equipment_id = p_equipment);
$$;
GRANT EXECUTE ON FUNCTION next_free_cell(uuid) TO shop_app;

-- Весовые товары, которых ещё нет в памяти весов
CREATE OR REPLACE FUNCTION scale_pending_products(p_account uuid, p_equipment uuid)
RETURNS TABLE (product_id uuid, name text, plu integer, price numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name, p.plu_code,
         coalesce((SELECT pp.value FROM product_price pp
                    JOIN price_type pt ON pt.id = pp.price_type_id AND pt.code = 'retail'
                   WHERE pp.product_id = p.id LIMIT 1), 0)
    FROM product p
   WHERE p.account_id = p_account AND p.kind = 'weight' AND p.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM scale_plu s WHERE s.equipment_id = p_equipment AND s.product_id = p.id)
   ORDER BY p.name;
$$;
GRANT EXECUTE ON FUNCTION scale_pending_products(uuid,uuid) TO shop_app;
