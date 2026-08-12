-- =====================================================================
-- 005_goods_extra.sql — ДОПОЛНЕНИЕ К ТОВАРАМ по итогам сверки с доками
-- Добавлено: упаковки (МС «блок сигарет»), аналоги (МС), массовое
-- присвоение NTIN и смарт-фильтр (главная находка UMAG), отчёт готовности
-- к фискализации (наше), применение наценки категории (UMAG).
-- =====================================================================

-- ---------------------------------------------------------------------
-- УПАКОВКИ (МС «Штрихкоды для упаковки»): блок сигарет = 10 пачек,
-- ящик = 20 бутылок. Приёмка идёт коробками, продажа — штуками.
-- ---------------------------------------------------------------------
CREATE TABLE package (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  name        text NOT NULL,                       -- «Блок», «Ящик», «Упаковка»
  quantity    numeric(14,3) NOT NULL,              -- сколько базовых единиц внутри
  is_default_purchase boolean NOT NULL DEFAULT false,  -- в приёмку подставляется эта упаковка
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  seq         bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT package_qty_positive CHECK (quantity > 0)
);
CREATE INDEX ON package(product_id) WHERE deleted_at IS NULL;
CREATE INDEX ON package(account_id) WHERE deleted_at IS NULL;

-- штрихкод может принадлежать упаковке, а не штуке (блок сканируется отдельно)
ALTER TABLE barcode ADD COLUMN package_id uuid REFERENCES package(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- АНАЛОГИ (МС): «если товар закончится, можно быстро предложить похожий».
-- Дёшево в реализации, заметно в жизни магазина.
-- ---------------------------------------------------------------------
CREATE TABLE product_analog (
  product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  analog_id   uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, analog_id),
  CONSTRAINT analog_not_self CHECK (product_id <> analog_id)
);

-- ---------------------------------------------------------------------
-- Комплект: дополнительные расходы (упаковка, лента) — поле есть у UMAG
-- («дополнительные расходы») и у МС («стоимость приготовления»).
-- ---------------------------------------------------------------------
ALTER TABLE product ADD COLUMN IF NOT EXISTS bundle_extra_cost numeric(14,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- RLS и права
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['package','product_analog']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER package_touch BEFORE UPDATE ON package FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- МАССОВОЕ ПРИСВОЕНИЕ NTIN — главная находка UMAG.
-- «Для товаров без заводского штрихкода (носки, игрушки с барахолки)
-- можно взять один агрегированный код на категорию и присвоить группе».
-- UMAG предупреждает: «У X из Y товаров уже указан код — он будет
-- перезаписан». Возвращаем это число, чтобы показать то же предупреждение.
-- =====================================================================
CREATE OR REPLACE FUNCTION assign_ntin_bulk(p_account uuid, p_ids uuid[], p_ntin text, p_source text DEFAULT 'manual')
RETURNS TABLE (updated integer, overwritten integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer; o integer;
BEGIN
  IF p_ntin !~ '^[0-9]{8,14}$' THEN RAISE EXCEPTION 'NTIN должен быть числом из 8–14 цифр'; END IF;
  SELECT count(*) INTO o FROM product
   WHERE account_id = p_account AND id = ANY(p_ids) AND ntin IS NOT NULL AND ntin <> p_ntin AND deleted_at IS NULL;
  UPDATE product SET ntin = p_ntin, ntin_source = p_source, ntin_checked_at = now()
   WHERE account_id = p_account AND id = ANY(p_ids) AND deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT n, o;
END $$;
REVOKE ALL ON FUNCTION assign_ntin_bulk(uuid,uuid[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_ntin_bulk(uuid,uuid[],text,text) TO shop_app;

-- Сколько товаров перезапишется — спрашиваем ДО операции (UMAG показывает
-- это в модальном окне перед подтверждением).
CREATE OR REPLACE FUNCTION count_ntin_overwrite(p_account uuid, p_ids uuid[], p_ntin text)
RETURNS TABLE (total integer, already_set integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer,
         count(*) FILTER (WHERE ntin IS NOT NULL AND ntin <> p_ntin)::integer
  FROM product WHERE account_id = p_account AND id = ANY(p_ids) AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION count_ntin_overwrite(uuid,uuid[],text) TO shop_app;

-- =====================================================================
-- ГОТОВНОСТЬ К ФИСКАЛИЗАЦИИ (наше добавление).
-- UMAG в FAQ: «база НКТ дорабатывается, ошибки пока не ведут к штрафам,
-- идёт адаптационный период». Период кончится — клиент должен узнать
-- об этом от нас, а не от налоговой.
-- =====================================================================
CREATE OR REPLACE FUNCTION ntin_readiness(p_account uuid)
RETURNS TABLE (total bigint, with_ntin bigint, without_ntin bigint,
               weight_without bigint, marked_without bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT count(*),
         count(*) FILTER (WHERE ntin IS NOT NULL),
         count(*) FILTER (WHERE ntin IS NULL),
         count(*) FILTER (WHERE ntin IS NULL AND kind = 'weight'),
         count(*) FILTER (WHERE ntin IS NULL AND marking <> 'none')
  FROM product
  WHERE account_id = p_account AND deleted_at IS NULL AND track_stock;
$$;
GRANT EXECUTE ON FUNCTION ntin_readiness(uuid) TO shop_app;

-- =====================================================================
-- НАЦЕНКА КАТЕГОРИИ (находка UMAG): «на бакалею накидываем 25%» вместо
-- назначения цены каждому из 2000 товаров. Своя наценка товара важнее.
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_category_markup(p_account uuid, p_category uuid, p_price_type uuid DEFAULT NULL)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer; v_type uuid;
BEGIN
  v_type := coalesce(p_price_type, (SELECT id FROM price_type WHERE code = 'retail' AND account_id IS NULL LIMIT 1));

  WITH target AS (
    SELECT p.id, round(p.purchase_price * (1 + effective_markup(p.id) / 100), 2) AS new_price
    FROM product p
    WHERE p.account_id = p_account AND p.category_id = p_category
      AND p.purchase_price IS NOT NULL AND p.deleted_at IS NULL
      AND effective_markup(p.id) IS NOT NULL
  )
  INSERT INTO product_price (account_id, product_id, price_type_id, value)
  SELECT p_account, t.id, v_type, t.new_price FROM target t
  ON CONFLICT (product_id, price_type_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION apply_category_markup(uuid,uuid,uuid) TO shop_app;
