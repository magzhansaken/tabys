-- =====================================================================
-- 033_warehouse_plus.sql — Часть 26: склад++.
--
-- Разбор конкурентов:
--  • МойСклад: адресное хранение — до 10 зон, ячейки с адресом и штрихкодом;
--    инвентаризация по ячейкам. ТСД — приложение на терминале Атол, сканирует
--    в заказ/инвентаризацию. Волна отбора — единый документ сборки ЗАКАЗОВ
--    ПОКУПАТЕЛЕЙ.
--  • Wipon, UMAG: адресного хранения и ТСД нет.
--
-- НАШ ВЫВОД (честно про масштаб):
--  1) Ячейки магазину у дома не нужны (это для склада 500+ м²). Но задел
--     полезен растущим клиентам — делаем ОПЦИОНАЛЬНО (флаг на складе). Пока
--     выключено, всё работает как раньше (по складу целиком).
--  2) ТСД — это НАША касса-Android со сканером (часть 16). Отдельное железо
--     Атол не нужно: продавец сканирует в приёмку/инвентаризацию телефоном.
--     В этой части — серверная поддержка «скан в документ по ячейкам».
--  3) Волну отбора НЕ делаем: у магазина у дома НЕТ заказов покупателей и
--     роли комплектовщика (проверено — в схеме есть заказы ПОСТАВЩИКУ, а не
--     покупателю). Вместо WMS-волны — «лист отбора»: печатный маршрут по
--     ячейкам для сбора товара (инвентаризация/перемещение), где это реально
--     помогает. Гнаться за WMS для нашего сегмента — распыление.
-- =====================================================================

-- адресное хранение включается на складе (по умолчанию выкл — как было)
ALTER TABLE warehouse ADD COLUMN IF NOT EXISTS bin_enabled boolean NOT NULL DEFAULT false;

-- ----- ЗОНЫ И ЯЧЕЙКИ -----
CREATE TABLE IF NOT EXISTS warehouse_zone (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE warehouse_zone ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS warehouse_zone_isolation ON warehouse_zone;
CREATE POLICY warehouse_zone_isolation ON warehouse_zone
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_zone TO shop_app;

CREATE TABLE IF NOT EXISTS warehouse_cell (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  zone_id       uuid REFERENCES warehouse_zone(id) ON DELETE SET NULL,
  address       text NOT NULL,                     -- «А-01-03», печатается на ярлыке
  barcode       text,                              -- штрихкод ячейки (скан ТСД)
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (warehouse_id, address)
);
ALTER TABLE warehouse_cell ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS warehouse_cell_isolation ON warehouse_cell;
CREATE POLICY warehouse_cell_isolation ON warehouse_cell
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_cell TO shop_app;
CREATE INDEX IF NOT EXISTS idx_cell_wh ON warehouse_cell(warehouse_id) WHERE deleted_at IS NULL;

-- остаток товара в разрезе ячейки (сумма по ячейкам = общий остаток товара).
-- Отдельная таблица: не ломаем stock_balance, который работает по складу.
CREATE TABLE IF NOT EXISTS cell_balance (
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  cell_id       uuid NOT NULL REFERENCES warehouse_cell(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (cell_id, product_id)
);
ALTER TABLE cell_balance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cell_balance_isolation ON cell_balance;
CREATE POLICY cell_balance_isolation ON cell_balance
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON cell_balance TO shop_app;
CREATE INDEX IF NOT EXISTS idx_cell_balance_prod ON cell_balance(account_id, product_id);

-- разместить/забрать товар в ячейке (атомарно, с проверкой на минус)
CREATE OR REPLACE FUNCTION apply_cell_move(
  p_account uuid, p_cell uuid, p_product uuid, p_qty numeric
) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE new_qty numeric;
BEGIN
  INSERT INTO cell_balance (account_id, cell_id, product_id, qty)
    VALUES (p_account, p_cell, p_product, p_qty)
    ON CONFLICT (cell_id, product_id) DO UPDATE SET qty = cell_balance.qty + p_qty
    RETURNING qty INTO new_qty;
  IF new_qty < 0 THEN
    RAISE EXCEPTION 'В ячейке недостаточно товара (нужно %, есть %)', p_qty, new_qty - p_qty;
  END IF;
  RETURN new_qty;
END;
$$;

-- ----- ЛИСТ ОТБОРА -----
-- Маршрут сбора товара по ячейкам: печатается, кладовщик идёт по адресам.
-- Заменяет WMS-волну для нашего сегмента (без заказов покупателей).
CREATE TABLE IF NOT EXISTS picking_list (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouse(id),
  number        text,
  status        text NOT NULL DEFAULT 'open',      -- open / done
  comment       text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
ALTER TABLE picking_list ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS picking_list_isolation ON picking_list;
CREATE POLICY picking_list_isolation ON picking_list
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON picking_list TO shop_app;

CREATE TABLE IF NOT EXISTS picking_list_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  list_id       uuid NOT NULL REFERENCES picking_list(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id),
  cell_id       uuid REFERENCES warehouse_cell(id),   -- откуда брать (адрес)
  qty           numeric(14,3) NOT NULL,
  picked        boolean NOT NULL DEFAULT false        -- отмечено собранным
);
ALTER TABLE picking_list_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS picking_list_item_isolation ON picking_list_item;
CREATE POLICY picking_list_item_isolation ON picking_list_item
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON picking_list_item TO shop_app;
CREATE INDEX IF NOT EXISTS idx_picking_item_list ON picking_list_item(list_id);
