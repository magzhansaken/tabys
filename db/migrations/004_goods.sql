-- =====================================================================
-- 004_goods.sql — ТОВАРЫ (номенклатура)
-- Решения и обоснования: docs/2_Решения_товары.md
-- Ключевое для КЗ: NTIN (код НКТ) как у UMAG, весовые штрихкоды формата
-- МоегоСклада, PLU для весов как у Wipon.
-- =====================================================================

CREATE TYPE product_kind AS ENUM ('simple','weight','service','bundle','variant_parent');
CREATE TYPE barcode_type AS ENUM ('ean13','ean8','upc','code128','code39','internal','weight','plu');
CREATE TYPE marking_kind AS ENUM ('none','tobacco','shoes','pharma','alcohol','beer','other');

-- ---------------------------------------------------------------------
-- КАТЕГОРИИ. Иерархия любой глубины (у UMAG категория+подкатегория,
-- у МС «группы»). Наценка на категорию — находка UMAG: завёл товар в
-- «Молочку», цена посчиталась сама. Для 3000 позиций это недели работы.
-- ---------------------------------------------------------------------
CREATE TABLE category (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES category(id),
  name          text NOT NULL,
  name_kk       text,
  markup_percent numeric(6,2),                    -- наценка по умолчанию (UMAG)
  ntin_aggregate text,                            -- агрегированный код НКТ на всю группу (UMAG)
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON category(account_id) WHERE deleted_at IS NULL;
CREATE INDEX ON category(parent_id);

-- ---------------------------------------------------------------------
-- ТИПЫ ЦЕН (модель МоегоСклада). Розница и опт есть у всех троих,
-- остальное клиент добавляет сам.
-- ---------------------------------------------------------------------
CREATE TABLE price_type (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  code          text NOT NULL,                    -- retail / wholesale / ...
  is_default    boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT price_type_code_uniq UNIQUE (account_id, code)
);
CREATE INDEX ON price_type(account_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- ТОВАР.
-- Обязательны только название и единица. UMAG и Wipon требуют штрихкод —
-- но у носков с барахолки его нет, и продавец выдумывает. Мы генерируем.
-- ---------------------------------------------------------------------
CREATE TABLE product (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          product_kind NOT NULL DEFAULT 'simple',
  parent_id     uuid REFERENCES product(id),      -- для вариантов: ссылка на родителя
  code          integer,                          -- короткий числовой код: весовой ШК и быстрый ввод
  name          text NOT NULL,
  name_kk       text,
  full_name     text,                             -- для чека, если длиннее
  category_id   uuid REFERENCES category(id),
  unit_id       uuid REFERENCES unit(id),
  article       text,                             -- артикул (МС «артикул», UMAG)
  external_code text,                             -- код из чужой системы (импорт)

  -- КАЗАХСТАНСКАЯ ОБЯЗАЛОВКА: код НКТ. Модель UMAG.
  ntin          text,
  ntin_source   text,                             -- manual / category_aggregate / import
  ntin_checked_at timestamptz,

  -- цены (сами значения — в product_price; здесь то, что едино для позиции)
  purchase_price numeric(14,2),                   -- закупочная (все трое)
  min_price     numeric(14,2),                    -- минимальная: защита от продажи в убыток (МС)
  markup_percent numeric(6,2),                    -- своя наценка; NULL = берём у категории (UMAG)
  vat_rate      numeric(5,2),                     -- ставка НДС

  -- склад
  min_stock     numeric(14,3),                    -- неснижаемый остаток / критический (МС, UMAG)
  track_stock   boolean NOT NULL DEFAULT true,    -- услуга — false
  weight_kg     numeric(10,3),
  volume_l      numeric(10,3),

  -- весовые (для магазина у дома это половина оборота)
  plu_code      integer,                          -- номер на весах (Wipon: выгрузка PLU)
  shelf_life_days integer,                        -- срок годности; учёт партий → Часть 3

  -- специальное
  marking       marking_kind NOT NULL DEFAULT 'none',  -- Дата-Матрикс (Wipon: сигареты, обувь, фарма)
  is_quick      boolean NOT NULL DEFAULT false,        -- быстрый товар (UMAG, Wipon)
  quick_group   text,
  supplier_id   uuid,                             -- поставщик → Часть 6
  country       text,
  description   text,

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,                      -- архив, а не удаление: история продаж ссылается
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT ntin_format CHECK (ntin IS NULL OR ntin ~ '^[0-9]{8,14}$'),
  CONSTRAINT variant_has_parent CHECK (kind <> 'variant_parent' OR parent_id IS NULL)
);
CREATE INDEX ON product(account_id) WHERE deleted_at IS NULL;
CREATE INDEX ON product(account_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX ON product(parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX product_code_uniq ON product(account_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX product_plu_uniq ON product(account_id, plu_code) WHERE plu_code IS NOT NULL AND deleted_at IS NULL;
-- поиск: кассир вводит «молок» и должен найти «Молоко Простоквашино 2.5%»
CREATE INDEX product_name_trgm ON product USING gin (name gin_trgm_ops);
CREATE INDEX ON product(account_id) WHERE ntin IS NULL AND deleted_at IS NULL;  -- фильтр «без НКТ» (UMAG)

-- ---------------------------------------------------------------------
-- ХАРАКТЕРИСТИКИ ВАРИАНТОВ (цвет, размер).
-- Значения хранятся в справочнике и переиспользуются — как у МоегоСклада:
-- один раз создал «Размер: 42,43,44», дальше выбираешь из списка.
-- ---------------------------------------------------------------------
CREATE TABLE attribute (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,                    -- «Цвет», «Размер»
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT attribute_name_uniq UNIQUE (account_id, name)
);

CREATE TABLE attribute_value (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  attribute_id  uuid NOT NULL REFERENCES attribute(id) ON DELETE CASCADE,
  value         text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT attribute_value_uniq UNIQUE (attribute_id, value)
);

-- Какие характеристики у конкретного варианта: «Цвет=Красный, Размер=42»
CREATE TABLE product_attribute (
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  attribute_id  uuid NOT NULL REFERENCES attribute(id),
  value_id      uuid NOT NULL REFERENCES attribute_value(id),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, attribute_id)
);

-- ---------------------------------------------------------------------
-- ШТРИХКОДЫ. Много на позицию (модель МС).
-- Из доки UMAG: жвачка приходит коробкой со своим штрихкодом, а на пачке
-- другой — оба должны находиться поиском.
-- ---------------------------------------------------------------------
CREATE TABLE barcode (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  code          text NOT NULL,
  type          barcode_type NOT NULL DEFAULT 'ean13',
  is_primary    boolean NOT NULL DEFAULT false,
  pack_qty      numeric(14,3),                    -- штрихкод упаковки: сколько единиц внутри (МС)
  pack_name     text,                             -- «Блок», «Ящик»
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX barcode_uniq ON barcode(account_id, code);
CREATE INDEX ON barcode(product_id);

-- ---------------------------------------------------------------------
-- ЦЕНЫ: товар × тип цены × точка.
-- Цена в карточке не даёт разных цен по точкам, а это нужно даже двум
-- магазинам через улицу.
-- ---------------------------------------------------------------------
CREATE TABLE product_price (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  price_type_id uuid NOT NULL REFERENCES price_type(id) ON DELETE CASCADE,
  store_id      uuid REFERENCES store(id),        -- NULL = цена для всех точек
  value         numeric(14,2) NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT price_uniq UNIQUE (product_id, price_type_id, store_id)
);
CREATE INDEX ON product_price(account_id, product_id);

-- ---------------------------------------------------------------------
-- КОМПЛЕКТ: набор, который продаётся как целое, а списываются компоненты
-- (модель МС/UMAG). Производственный сценарий Wipon («сначала произведи»)
-- — это кофейня, вертикаль №2.
-- ---------------------------------------------------------------------
CREATE TABLE bundle_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  bundle_id     uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  component_id  uuid NOT NULL REFERENCES product(id),
  qty           numeric(14,3) NOT NULL DEFAULT 1,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT bundle_item_uniq UNIQUE (bundle_id, component_id),
  CONSTRAINT no_self_bundle CHECK (bundle_id <> component_id)
);

-- Доп. расходы комплекта (UMAG: упаковка подарочного набора)
ALTER TABLE product ADD COLUMN bundle_extra_cost numeric(14,2);

-- ---------------------------------------------------------------------
-- ИЗОБРАЖЕНИЯ (МС: до 10, первое — обложка)
-- ---------------------------------------------------------------------
CREATE TABLE product_image (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  url           text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON product_image(product_id);

-- ---------------------------------------------------------------------
-- НАСТРОЙКИ НОМЕНКЛАТУРЫ на аккаунт: префикс весовых штрихкодов
-- (формат МоегоСклада ПП ККККК ВВВВВ Х — отраслевой стандарт весов)
-- ---------------------------------------------------------------------
CREATE TABLE goods_settings (
  account_id       uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  weight_prefix    text NOT NULL DEFAULT '20',    -- ПП
  weight_in_grams  boolean NOT NULL DEFAULT false, -- вес в граммах или в тысячных кг
  internal_prefix  text NOT NULL DEFAULT '2',     -- внутренние EAN-13 начинаются с 2
  next_code        integer NOT NULL DEFAULT 1,    -- счётчик коротких кодов
  next_plu         integer NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- RLS + права
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['category','price_type','product','attribute','attribute_value',
                           'product_attribute','barcode','product_price','bundle_item',
                           'product_image','goods_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['category','price_type','product','attribute','attribute_value',
                           'product_attribute','barcode','product_price','bundle_item','product_image']
  LOOP
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
CREATE POLICY tenant_isolation ON goods_settings USING
  (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- триггеры seq/updated_at
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['category','price_type','product','attribute']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_row()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- КОНТРОЛЬНАЯ ЦИФРА EAN-13. Генерируем внутренние штрихкоды сами —
-- у товара с барахолки заводского нет, а продавец не должен выдумывать.
-- =====================================================================
CREATE OR REPLACE FUNCTION ean13_check_digit(p_12 text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s integer := 0; i integer; d integer;
BEGIN
  IF length(p_12) <> 12 OR p_12 !~ '^[0-9]{12}$' THEN
    RAISE EXCEPTION 'Нужно ровно 12 цифр, получено: %', p_12;
  END IF;
  FOR i IN 1..12 LOOP
    d := substr(p_12, i, 1)::integer;
    s := s + CASE WHEN i % 2 = 1 THEN d ELSE d * 3 END;
  END LOOP;
  RETURN ((10 - (s % 10)) % 10)::text;
END $$;

-- Внутренний штрихкод: префикс 2 + короткий код + контрольная цифра
CREATE OR REPLACE FUNCTION gen_internal_barcode(p_account uuid, p_code integer)
RETURNS text SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE pref text; base text;
BEGIN
  SELECT internal_prefix INTO pref FROM goods_settings WHERE account_id = p_account;
  pref := coalesce(pref, '2');
  base := pref || lpad(p_code::text, 12 - length(pref), '0');
  RETURN base || ean13_check_digit(base);
END $$;
GRANT EXECUTE ON FUNCTION gen_internal_barcode(uuid,integer) TO shop_app;

-- =====================================================================
-- РАЗБОР ВЕСОВОГО ШТРИХКОДА: ПП ККККК ВВВВВ Х (стандарт весов, модель МС).
-- Весы печатают такой код после взвешивания; касса обязана достать из него
-- и товар, и вес — иначе кассир вбивает вес руками и ошибается.
-- =====================================================================
CREATE OR REPLACE FUNCTION parse_weight_barcode(p_account uuid, p_barcode text)
RETURNS TABLE (product_id uuid, product_name text, qty numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE pref text; in_grams boolean; code_part integer; weight_part integer;
BEGIN
  IF p_barcode !~ '^[0-9]{13}$' THEN RETURN; END IF;
  SELECT weight_prefix, weight_in_grams INTO pref, in_grams FROM goods_settings WHERE account_id = p_account;
  IF pref IS NULL OR substr(p_barcode, 1, length(pref)) <> pref THEN RETURN; END IF;

  code_part   := substr(p_barcode, length(pref) + 1, 5)::integer;
  weight_part := substr(p_barcode, length(pref) + 6, 5)::integer;

  RETURN QUERY
  SELECT p.id, p.name,
         CASE WHEN in_grams THEN weight_part::numeric / 1000 ELSE weight_part::numeric / 1000 END
  FROM product p
  WHERE p.account_id = p_account AND p.code = code_part AND p.deleted_at IS NULL AND p.kind = 'weight';
END $$;
GRANT EXECUTE ON FUNCTION parse_weight_barcode(uuid,text) TO shop_app;

-- =====================================================================
-- ЦЕНА С УЧЁТОМ НАЦЕНКИ КАТЕГОРИИ (находка UMAG).
-- Своя наценка товара важнее; если её нет — берём у категории, поднимаясь
-- вверх по дереву. Завёл товар в «Молочку» — цена посчиталась сама.
-- =====================================================================
CREATE OR REPLACE FUNCTION effective_markup(p_product uuid)
RETURNS numeric SECURITY DEFINER SET search_path = public LANGUAGE plpgsql STABLE AS $$
DECLARE m numeric; cat uuid;
BEGIN
  SELECT markup_percent, category_id INTO m, cat FROM product WHERE id = p_product;
  IF m IS NOT NULL THEN RETURN m; END IF;
  WHILE cat IS NOT NULL LOOP
    SELECT markup_percent, parent_id INTO m, cat FROM category WHERE id = cat;
    IF m IS NOT NULL THEN RETURN m; END IF;
  END LOOP;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION effective_markup(uuid) TO shop_app;
