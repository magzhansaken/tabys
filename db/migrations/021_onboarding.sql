-- =====================================================================
-- 021_onboarding.sql — ОНБОРДИНГ И МИГРАЦИЯ [РУБЕЖ]
-- Решения: docs/12_Решения_онбординг.md
--
-- У Wipon в документации есть тег «для клиентов Umag», под которым одна
-- страница: канал перетока они застолбили, но наполнить не смогли.
-- Наш ход — сделать переезд кнопкой, а не статьёй.
-- =====================================================================

-- Откуда переехали: нужно и для поддержки, и для понимания, кто наш клиент
ALTER TABLE account ADD COLUMN IF NOT EXISTS came_from text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS onboarding_done_at timestamptz;

-- Импорт из Части 2 умел товары. Переезжающему магазину нужны ещё
-- контрагенты и долги — то, ради чего он вёл тетрадку.
ALTER TABLE import_session ADD COLUMN IF NOT EXISTS source text;      -- umag / wipon / moysklad / custom
ALTER TABLE import_session ADD COLUMN IF NOT EXISTS entity text NOT NULL DEFAULT 'product';
ALTER TABLE import_session ADD COLUMN IF NOT EXISTS duplicates jsonb NOT NULL DEFAULT '[]';

-- =====================================================================
-- МАСТЕР ПЕРВОГО ЗАПУСКА. Помнит, где остановились: владелец закрывает
-- ноутбук на полуслове, потому что пришёл покупатель.
-- =====================================================================
CREATE TABLE onboarding_step (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',   -- pending / done / skipped
  payload       jsonb NOT NULL DEFAULT '{}',
  done_at       timestamptz,
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code)
);
CREATE INDEX ON onboarding_step(account_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['onboarding_step']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER onboarding_touch BEFORE UPDATE ON onboarding_step FOR EACH ROW EXECUTE FUNCTION touch_row();

-- =====================================================================
-- ГОТОВНОСТЬ МАГАЗИНА. Ничего не блокирует: торговать можно и на трёх шагах.
-- =====================================================================
CREATE OR REPLACE FUNCTION onboarding_state(p_account uuid)
RETURNS TABLE (code text, title text, status text, hint text, blocking boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH steps(code, title, ord, blocking, hint) AS (VALUES
    ('organization', 'Реквизиты организации', 1, false, 'Нужны для чеков и документов: БИН, название, адрес'),
    ('store',        'Магазин и склад',        2, true,  'Без точки продавать некуда'),
    ('employees',    'Сотрудники',             3, false, 'Кассиры со своим ПИН-кодом — видно, кто что пробил'),
    ('products',     'Товары',                 4, true,  'Перенесите из старой программы или заведите вручную'),
    ('prices',       'Цены',                   5, true,  'Без цены товар не пробить'),
    ('stock',        'Остатки',                6, false, 'Внесите, что лежит на полках'),
    ('fiscal',       'Фискализация',           7, false, 'Чтобы чеки уходили в налоговую'),
    ('equipment',    'Оборудование',           8, false, 'Весы, принтер этикеток, сканер'),
    ('first_sale',   'Первая продажа',         9, false, 'Проверьте, что всё работает')
  ),
  facts AS (
    SELECT
      EXISTS (SELECT 1 FROM organization WHERE account_id = p_account AND tin IS NOT NULL AND deleted_at IS NULL) AS has_org,
      EXISTS (SELECT 1 FROM store s JOIN warehouse w ON w.store_id = s.id
               WHERE s.account_id = p_account AND s.deleted_at IS NULL) AS has_store,
      (SELECT count(*) FROM employee WHERE account_id = p_account AND deleted_at IS NULL AND NOT is_owner) > 0 AS has_emp,
      (SELECT count(*) FROM product WHERE account_id = p_account AND archived_at IS NULL) > 0 AS has_products,
      EXISTS (SELECT 1 FROM product_price pp JOIN product p ON p.id = pp.product_id
               WHERE p.account_id = p_account AND pp.value > 0) AS has_prices,
      EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.account_id = p_account AND sb.qty > 0) AS has_stock,
      EXISTS (SELECT 1 FROM kkm WHERE account_id = p_account AND deleted_at IS NULL) AS has_kkm,
      EXISTS (SELECT 1 FROM equipment WHERE account_id = p_account AND deleted_at IS NULL) AS has_eq,
      EXISTS (SELECT 1 FROM sale WHERE account_id = p_account AND status = 'completed') AS has_sale
  )
  SELECT s.code, s.title,
         CASE
           WHEN os.status = 'skipped' THEN 'skipped'
           WHEN (CASE s.code
                   WHEN 'organization' THEN f.has_org WHEN 'store' THEN f.has_store
                   WHEN 'employees' THEN f.has_emp   WHEN 'products' THEN f.has_products
                   WHEN 'prices' THEN f.has_prices   WHEN 'stock' THEN f.has_stock
                   WHEN 'fiscal' THEN f.has_kkm      WHEN 'equipment' THEN f.has_eq
                   WHEN 'first_sale' THEN f.has_sale ELSE false END) THEN 'done'
           ELSE 'pending'
         END,
         s.hint, s.blocking
    FROM steps s CROSS JOIN facts f
    LEFT JOIN onboarding_step os ON os.account_id = p_account AND os.code = s.code
   ORDER BY s.ord;
$$;
GRANT EXECUTE ON FUNCTION onboarding_state(uuid) TO shop_app;

-- =====================================================================
-- ПОИСК ДУБЛЕЙ ПЕРЕД ИМПОРТОМ.
-- Переезд — единственный момент, когда в базу заливают тысячи строк разом.
-- Два «Молока» с одним штрихкодом дадут магазину вечную путаницу в остатках.
-- =====================================================================
CREATE OR REPLACE FUNCTION find_import_duplicates(p_account uuid, p_barcodes text[], p_names text[])
RETURNS TABLE (kind text, value text, existing_name text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT 'barcode', b.code, p.name FROM barcode b JOIN product p ON p.id = b.product_id
   WHERE b.account_id = p_account AND b.code = ANY(p_barcodes) AND p.archived_at IS NULL
  UNION ALL
  SELECT 'name', p.name, p.name FROM product p
   WHERE p.account_id = p_account AND lower(p.name) = ANY(SELECT lower(unnest(p_names)))
     AND p.archived_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION find_import_duplicates(uuid,text[],text[]) TO shop_app;
