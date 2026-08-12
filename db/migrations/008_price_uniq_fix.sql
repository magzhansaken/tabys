-- =====================================================================
-- 008_price_uniq_fix.sql
-- Найдено тестом импорта: уникальность цены была по (товар, тип, точка),
-- но store_id = NULL означает «во всех точках», а в Postgres NULL не равен
-- NULL — значит повторный импорт плодил бы дубли цен на один товар.
-- Postgres 15+ умеет NULLS NOT DISTINCT — это ровно наш случай.
-- =====================================================================
ALTER TABLE product_price DROP CONSTRAINT IF EXISTS price_uniq;
DROP INDEX IF EXISTS price_uniq;
CREATE UNIQUE INDEX price_uniq ON product_price (product_id, price_type_id, store_id) NULLS NOT DISTINCT;
