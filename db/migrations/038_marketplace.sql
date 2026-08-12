-- =====================================================================
-- 038_marketplace.sql — Часть 32: интеграция с маркетплейсом (Kaspi Магазин).
--
-- Разбор рынка (веб-поиск, реальный протокол Kaspi Shop API v2 2026):
--  • Формат JSON:API. Заголовки: X-Auth-Token, Content-Type: application/vnd.api+json.
--  • Заказы: GET /shop/api/v2/orders?filter[orders][state]=NEW&
--    filter[orders][status]=APPROVED_BY_BANK (пагинация page[number]/page[size]).
--  • state (этап): NEW → SIGN_REQUIRED → PICKUP/DELIVERY/KASPI_DELIVERY → ARCHIVE.
--  • status: APPROVED_BY_BANK → ACCEPTED_BY_MERCHANT (принять) → COMPLETED/CANCELLED.
--  • Принять заказ: POST со status=ACCEPTED_BY_MERCHANT.
--  • Позиции: GET /orders/{id}/entries — code товара, name, basePrice, quantity.
--  • deliveryMode: DELIVERY_PICKUP (самовывоз) / DELIVERY_REGIONAL_TODOOR.
--  • Выгрузка товаров: прайс (цена+остаток по городам), НЕ выгружать то, чего нет.
--  • >90% онлайн-торговли КЗ — через Kaspi. Это канал №1.
--
-- Разбор конкурентов:
--  • МойСклад: интеграция с Kaspi Магазин (заказы, товары, остатки, цены),
--    авто-приёмка/автокомплектация заказов; модели FBO/FBS; +Ozon/WB/ЯМаркет.
--  • Wipon, UMAG: интеграции с маркетплейсами НЕТ.
--
-- НАШ ВЫВОД:
--  1) Kaspi — единственный маркетплейс, критичный для КЗ. Делаем его первым.
--     Провайдерный паттерн (как fiscal/payment): интерфейс + Mock + Kaspi.
--  2) Два потока: ВЫГРУЗКА (наш каталог → цены/остатки на Kaspi) и ЗАКАЗЫ
--     (Kaspi → наши заказы, принять/собрать/выдать, списание со склада).
--  3) Маппинг товаров: наш product ↔ Kaspi SKU (по коду). Без маппинга —
--     «нераспознанные позиции» (грабли МоегоСклада, обходим).
--  4) Остаток на Kaspi = остаток на складе. Продали в рознице → уменьшили и
--     на Kaspi. Продали на Kaspi → списали со склада. Единый остаток, не
--     двойные продажи (главная боль продавца на маркетплейсе).
--  5) Модель FBS (товар у продавца) — наш случай: заказ пришёл → собрали →
--     передали. FBO (товар на складе Kaspi) — задел.
--  6) Боевой ключ (X-Auth-Token) по договору мерчанта Kaspi — механика до
--     границы, как фискализация.
-- =====================================================================

-- подключение к маркетплейсу
CREATE TABLE IF NOT EXISTS marketplace_connection (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'kaspi',   -- kaspi / mock (задел: ozon, wb)
  merchant_id   text,                             -- id продавца на маркетплейсе
  auth_token    text,                             -- X-Auth-Token (боевой по договору)
  enabled       boolean NOT NULL DEFAULT false,
  auto_accept   boolean NOT NULL DEFAULT false,   -- авто-принятие новых заказов
  price_type    text NOT NULL DEFAULT 'retail',   -- какой тип цены выгружать
  last_sync_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider)
);
ALTER TABLE marketplace_connection ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mp_conn_isolation ON marketplace_connection;
CREATE POLICY mp_conn_isolation ON marketplace_connection
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_connection TO shop_app;

-- маппинг наш товар ↔ SKU на маркетплейсе (без него — нераспознанные позиции)
CREATE TABLE IF NOT EXISTS marketplace_listing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'kaspi',
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  sku           text NOT NULL,                    -- код товара на маркетплейсе
  published     boolean NOT NULL DEFAULT true,    -- выгружать ли
  last_price    numeric(14,2),                    -- последняя выгруженная цена
  last_qty      numeric(14,3),                    -- последний выгруженный остаток
  synced_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, sku)
);
ALTER TABLE marketplace_listing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mp_listing_isolation ON marketplace_listing;
CREATE POLICY mp_listing_isolation ON marketplace_listing
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_listing TO shop_app;
CREATE INDEX IF NOT EXISTS idx_mp_listing_product ON marketplace_listing(product_id);

-- заказы с маркетплейса
CREATE TABLE IF NOT EXISTS marketplace_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'kaspi',
  external_id   text NOT NULL,                    -- id заказа на маркетплейсе (идемпотентность)
  code          text,                             -- человекочитаемый код заказа
  state         text NOT NULL DEFAULT 'new',      -- new/sign_required/pickup/delivery/archive
  status        text NOT NULL DEFAULT 'approved_by_bank', -- approved_by_bank/accepted/completed/cancelled
  customer_name text,
  customer_phone text,
  delivery_mode text,                             -- pickup / todoor / kaspi_delivery
  total_price   numeric(14,2) NOT NULL DEFAULT 0,
  accepted_at   timestamptz,
  completed_at  timestamptz,
  sale_id       uuid REFERENCES sale(id),         -- чек, если провели через кассу
  raw           jsonb,                            -- полный ответ маркетплейса
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, external_id)
);
ALTER TABLE marketplace_order ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mp_order_isolation ON marketplace_order;
CREATE POLICY mp_order_isolation ON marketplace_order
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_order TO shop_app;
CREATE INDEX IF NOT EXISTS idx_mp_order ON marketplace_order(account_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_order_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES marketplace_order(id) ON DELETE CASCADE,
  sku           text NOT NULL,
  product_id    uuid REFERENCES product(id),      -- сопоставлен ли с нашим товаром
  name          text,
  qty           numeric(14,3) NOT NULL,
  price         numeric(14,2) NOT NULL
);
ALTER TABLE marketplace_order_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mp_order_item_isolation ON marketplace_order_item;
CREATE POLICY mp_order_item_isolation ON marketplace_order_item
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_order_item TO shop_app;
CREATE INDEX IF NOT EXISTS idx_mp_order_item ON marketplace_order_item(order_id);

-- журнал синхронизации (выгрузка/заказы) — видно, что и когда обменяли
CREATE TABLE IF NOT EXISTS marketplace_sync_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'kaspi',
  kind          text NOT NULL,                    -- price_push / orders_pull / order_accept
  ok            boolean NOT NULL DEFAULT true,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketplace_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mp_sync_isolation ON marketplace_sync_log;
CREATE POLICY mp_sync_isolation ON marketplace_sync_log
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_sync_log TO shop_app;
CREATE INDEX IF NOT EXISTS idx_mp_sync ON marketplace_sync_log(account_id, created_at DESC);

-- прайс для выгрузки: товар + цена (по типу) + остаток по складам.
-- Не выгружаем то, чего нет в наличии (правило Kaspi).
CREATE OR REPLACE FUNCTION marketplace_price_feed(p_account uuid, p_price_type text)
RETURNS TABLE (product_id uuid, name text, price numeric, qty numeric) LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name,
         coalesce((SELECT pp.value FROM product_price pp
                    JOIN price_type pt ON pt.id = pp.price_type_id
                   WHERE pp.product_id = p.id AND pt.code = p_price_type
                     AND pp.store_id IS NULL LIMIT 1), 0),
         coalesce((SELECT sum(sb.qty) FROM stock_balance sb WHERE sb.product_id = p.id), 0)
    FROM product p
   WHERE p.account_id = p_account AND p.deleted_at IS NULL
     AND coalesce((SELECT sum(sb.qty) FROM stock_balance sb WHERE sb.product_id = p.id), 0) > 0;
$$;
