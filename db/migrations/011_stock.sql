-- =====================================================================
-- 011_stock.sql — СКЛАД
-- Решения: docs/3_Решения_склад.md
-- Принцип из 1.3: остаток — это СУММА ДВИЖЕНИЙ, а не перезаписываемое поле.
-- Две кассы не могут затереть остаток друг друга, потому что они присылают
-- «-2» и «-1», а не «остаток = 5».
-- Себестоимость — средневзвешенная скользящая (обоснование в документе:
-- у МС и UMAG — FIFO, но их касса не работает офлайн так, как наша).
-- =====================================================================

CREATE TYPE doc_kind AS ENUM ('supply','supplier_return','transfer','write_off','adjustment','inventory');
CREATE TYPE doc_status AS ENUM ('draft','counting','processing','done','deleted');   -- статусы UMAG
CREATE TYPE move_reason AS ENUM ('supply','supplier_return','transfer_out','transfer_in',
                                 'write_off','adjustment','inventory_surplus','inventory_shortage',
                                 'sale','sale_return','bundle_disassembly');

-- =====================================================================
-- ДОКУМЕНТ СКЛАДА. Один тип строки на все операции: у них общий жизненный
-- цикл (черновик → проведён), общая нумерация и общий список позиций.
-- =====================================================================
CREATE TABLE stock_doc (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind           doc_kind NOT NULL,
  number         integer NOT NULL,                       -- сквозной номер в рамках вида (UMAG)
  status         doc_status NOT NULL DEFAULT 'draft',

  warehouse_id   uuid REFERENCES warehouse(id),          -- откуда / куда
  warehouse_to_id uuid REFERENCES warehouse(id),         -- для перемещения
  store_id       uuid REFERENCES store(id),
  supplier_id    uuid,                                   -- поставщик (Часть 6)

  -- накладные расходы (модель МС): доставка увеличивает себестоимость
  extra_costs    numeric(14,2) NOT NULL DEFAULT 0,
  total_sum      numeric(14,2) NOT NULL DEFAULT 0,

  comment        text,                                   -- комментарий к документу (UMAG)
  merged_from    jsonb,                                  -- номера объединённых черновиков (UMAG)
  blind          boolean NOT NULL DEFAULT false,         -- слепой пересчёт — наше добавление
  employee_id    uuid REFERENCES employee(id),
  device_id      uuid REFERENCES device(id),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  deleted_at     timestamptz,
  seq            bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT transfer_has_target CHECK (kind <> 'transfer' OR warehouse_to_id IS NOT NULL),
  CONSTRAINT transfer_not_same CHECK (warehouse_to_id IS NULL OR warehouse_to_id <> warehouse_id)
);
CREATE UNIQUE INDEX stock_doc_number_uniq ON stock_doc(account_id, kind, number) WHERE deleted_at IS NULL;
CREATE INDEX ON stock_doc(account_id, kind, status, created_at DESC);
CREATE INDEX ON stock_doc(account_id, warehouse_id);

-- =====================================================================
-- ПОЗИЦИЯ ДОКУМЕНТА.
-- Для инвентаризации: qty_fact — что насчитали, qty_book — остаток
-- НА МОМЕНТ ПЕРВОГО СКАНИРОВАНИЯ (находка UMAG: магазин торгует во время
-- пересчёта, и продажи не должны портить результат).
-- =====================================================================
CREATE TABLE stock_doc_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  doc_id        uuid NOT NULL REFERENCES stock_doc(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id),
  package_id    uuid REFERENCES package(id),             -- приёмка блоками (2.6)
  qty           numeric(14,3) NOT NULL DEFAULT 0,        -- в базовых единицах
  qty_packages  numeric(14,3),                           -- сколько упаковок ввели
  price         numeric(14,2),                           -- цена закупки (приёмка)
  qty_book      numeric(14,3),                           -- учётный остаток на момент первого скана
  book_at       timestamptz,                             -- когда зафиксировали (UMAG)
  reason        text,                                    -- причина списания
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (doc_id, product_id)                            -- одинаковые штрихкоды суммируются (UMAG)
);
CREATE INDEX ON stock_doc_item(doc_id);
CREATE INDEX ON stock_doc_item(product_id);

-- =====================================================================
-- ДВИЖЕНИЯ — ИСТОЧНИК ПРАВДЫ ПО ОСТАТКАМ (принцип из 1.3).
-- Ничего не перезаписывается: только «+» и «−».
-- =====================================================================
CREATE TABLE stock_move (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouse(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  qty           numeric(14,3) NOT NULL,                  -- + приход, − расход
  cost          numeric(14,2),                           -- себестоимость единицы на момент движения
  reason        move_reason NOT NULL,
  doc_id        uuid REFERENCES stock_doc(id) ON DELETE CASCADE,
  employee_id   uuid REFERENCES employee(id),
  ts            timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT move_not_zero CHECK (qty <> 0)
);
CREATE INDEX ON stock_move(account_id, warehouse_id, product_id, ts);
CREATE INDEX ON stock_move(doc_id);

-- =====================================================================
-- ОСТАТОК: материализованная сумма движений. Касса должна отвечать
-- мгновенно, но истина — в движениях, и остаток всегда можно пересчитать.
-- Здесь же живёт средневзвешенная себестоимость.
-- =====================================================================
CREATE TABLE stock_balance (
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  avg_cost      numeric(14,4) NOT NULL DEFAULT 0,        -- средневзвешенная скользящая
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE INDEX ON stock_balance(account_id, product_id);
CREATE INDEX ON stock_balance(account_id, warehouse_id) WHERE qty <> 0;

-- =====================================================================
-- НАСТРОЙКИ СКЛАДА
-- =====================================================================
ALTER TABLE account ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN account.allow_negative_stock IS 'Магазин у дома торгует «в минус» до приёмки: запрещать жёстко нельзя, но предупреждать надо';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_doc','stock_doc_item','stock_move','stock_balance']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER stock_doc_touch BEFORE UPDATE ON stock_doc FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПРИМЕНЕНИЕ ДВИЖЕНИЯ: остаток и средневзвешенная себестоимость.
--
-- Формула прихода: новая_средняя = (старый_остаток×старая_средняя + приход×цена)
--                                  / (старый_остаток + приход)
-- Расход среднюю не меняет — он списывает по текущей средней.
-- Это и делает метод устойчивым к порядку прихода событий с офлайн-касс,
-- в отличие от FIFO у МоегоСклада и UMAG.
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_stock_move(
  p_account uuid, p_warehouse uuid, p_product uuid, p_qty numeric,
  p_price numeric, p_reason move_reason, p_doc uuid DEFAULT NULL, p_employee uuid DEFAULT NULL)
RETURNS TABLE (move_id uuid, new_qty numeric, new_cost numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE b record; v_cost numeric; v_new_qty numeric; v_new_cost numeric; v_move uuid;
BEGIN
  SELECT * INTO b FROM stock_balance WHERE warehouse_id = p_warehouse AND product_id = p_product FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO stock_balance (account_id, warehouse_id, product_id, qty, avg_cost)
    VALUES (p_account, p_warehouse, p_product, 0, 0)
    ON CONFLICT (warehouse_id, product_id) DO NOTHING;
    SELECT * INTO b FROM stock_balance WHERE warehouse_id = p_warehouse AND product_id = p_product FOR UPDATE;
  END IF;

  v_new_qty := b.qty + p_qty;

  IF p_qty > 0 THEN
    -- приход: пересчитываем среднюю
    v_cost := coalesce(p_price, b.avg_cost);
    IF v_new_qty > 0 THEN
      v_new_cost := round((greatest(b.qty, 0) * b.avg_cost + p_qty * v_cost) / (greatest(b.qty, 0) + p_qty), 4);
    ELSE
      v_new_cost := v_cost;
    END IF;
  ELSE
    -- расход: списывается по текущей средней, сама средняя не меняется
    v_cost := b.avg_cost;
    v_new_cost := b.avg_cost;
  END IF;

  INSERT INTO stock_move (account_id, warehouse_id, product_id, qty, cost, reason, doc_id, employee_id)
  VALUES (p_account, p_warehouse, p_product, p_qty, v_cost, p_reason, p_doc, p_employee)
  RETURNING id INTO v_move;

  UPDATE stock_balance SET qty = v_new_qty, avg_cost = v_new_cost, updated_at = now()
   WHERE warehouse_id = p_warehouse AND product_id = p_product;

  RETURN QUERY SELECT v_move, v_new_qty, v_new_cost;
END $$;
GRANT EXECUTE ON FUNCTION apply_stock_move(uuid,uuid,uuid,numeric,numeric,move_reason,uuid,uuid) TO shop_app;

-- =====================================================================
-- ПЕРЕСЧЁТ ОСТАТКА ИЗ ДВИЖЕНИЙ.
-- У МоегоСклада есть статья «Если остатки считаются неверно» — там советуют
-- писать в поддержку. У нас остаток всегда можно пересобрать из фактов.
-- =====================================================================
CREATE OR REPLACE FUNCTION recalc_stock(p_account uuid, p_warehouse uuid DEFAULT NULL)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH sums AS (
    SELECT warehouse_id, product_id, sum(qty) AS q
      FROM stock_move
     WHERE account_id = p_account AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
     GROUP BY warehouse_id, product_id
  )
  UPDATE stock_balance b SET qty = s.q, updated_at = now()
    FROM sums s
   WHERE b.warehouse_id = s.warehouse_id AND b.product_id = s.product_id
     AND b.qty IS DISTINCT FROM s.q;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION recalc_stock(uuid,uuid) TO shop_app;

-- =====================================================================
-- СЛЕДУЮЩИЙ НОМЕР ДОКУМЕНТА (UMAG: уникальный номер при создании)
-- =====================================================================
CREATE OR REPLACE FUNCTION next_doc_number(p_account uuid, p_kind doc_kind)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(max(number), 0) + 1 FROM stock_doc WHERE account_id = p_account AND kind = p_kind;
$$;
GRANT EXECUTE ON FUNCTION next_doc_number(uuid, doc_kind) TO shop_app;

-- =====================================================================
-- КРИТИЧЕСКИЕ ОСТАТКИ (UMAG) = неснижаемый остаток (МС).
-- Поле min_stock есть с Части 2.
-- =====================================================================
CREATE OR REPLACE FUNCTION low_stock(p_account uuid, p_warehouse uuid DEFAULT NULL)
RETURNS TABLE (product_id uuid, name text, warehouse_id uuid, qty numeric, min_stock numeric, deficit numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name, b.warehouse_id, b.qty, p.min_stock, p.min_stock - b.qty
    FROM product p
    JOIN stock_balance b ON b.product_id = p.id
   WHERE p.account_id = p_account AND p.min_stock IS NOT NULL AND p.min_stock > 0
     AND b.qty < p.min_stock
     AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.track_stock
     AND (p_warehouse IS NULL OR b.warehouse_id = p_warehouse)
   ORDER BY (p.min_stock - b.qty) DESC;
$$;
GRANT EXECUTE ON FUNCTION low_stock(uuid,uuid) TO shop_app;
