-- =====================================================================
-- 037_wholesale_crm.sql — Часть 31: CRM для опта и юнит-экономика.
--
-- Разбор конкурентов:
--  • МойСклад: воронка продаж по СТАТУСАМ заказов покупателей (конверсия по
--    этапам, «узкие места»), юнит-экономика товаров по каналам продаж, CRM
--    (заявки из каналов, задачи, история). Интеграция с amoCRM. Всё платно.
--  • Wipon, UMAG: розничная касса, CRM для опта нет.
--
-- НАШ ВЫВОД (ключевое решение из плана):
--  ВОРОНКА ПРОДАЖ ИМЕЕТ СМЫСЛ ТОЛЬКО ДЛЯ ОПТА. У магазина у дома нет «сделок»
--  и этапов — покупатель пришёл, купил, ушёл (это розница, там воронки нет).
--  Но у части наших клиентов есть ОПТОВОЕ направление (продажа другим точкам,
--  ИП, кафе). Для них делаем лёгкую CRM: оптовый заказ со статусами-этапами
--  (новый → согласование → отгрузка → оплата → закрыт), воронка по конверсии.
--
--  Юнит-экономику по ТОВАРУ мы уже закрыли ABC-анализом (часть 8, модель UMAG:
--  ABC по выручке/прибыли/своду). Добавляем юнит-экономику по КЛИЕНТУ: вклад
--  каждого в выручку и прибыль, средний чек, LTV — то, чего нет у ABC товаров.
--
--  НЕ тянем полноценную CRM МоегоСклада (задачи, звонки, amoCRM) — это не для
--  магазина у дома. Даём ровно оптовую воронку и клиентскую аналитику.
-- =====================================================================

-- этапы оптовой сделки (воронка). Порядок задаёт конверсию.
CREATE TYPE wholesale_stage AS ENUM ('new', 'negotiation', 'shipped', 'paid', 'closed', 'lost');

-- пометка контрагента как оптового клиента (у него своя цена и воронка)
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS is_wholesale boolean NOT NULL DEFAULT false;

-- ОПТОВЫЙ ЗАКАЗ (сделка). Зеркало purchase_order, но для клиента и с воронкой.
CREATE TABLE IF NOT EXISTS wholesale_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  number        text,
  counterparty_id uuid REFERENCES counterparty(id),
  stage         wholesale_stage NOT NULL DEFAULT 'new',
  total_sum     numeric(14,2) NOT NULL DEFAULT 0,
  cost_sum      numeric(14,2) NOT NULL DEFAULT 0,      -- себестоимость (для прибыли сделки)
  comment       text,
  expected_date date,                                   -- планируемая отгрузка
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  deleted_at    timestamptz
);
ALTER TABLE wholesale_order ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wholesale_order_isolation ON wholesale_order;
CREATE POLICY wholesale_order_isolation ON wholesale_order
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON wholesale_order TO shop_app;
CREATE INDEX IF NOT EXISTS idx_wholesale_stage ON wholesale_order(account_id, stage, created_at DESC);

CREATE TABLE IF NOT EXISTS wholesale_order_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES wholesale_order(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES product(id),
  qty           numeric(14,3) NOT NULL,
  price         numeric(14,2) NOT NULL,
  cost          numeric(14,2) NOT NULL DEFAULT 0
);
ALTER TABLE wholesale_order_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wholesale_item_isolation ON wholesale_order_item;
CREATE POLICY wholesale_item_isolation ON wholesale_order_item
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON wholesale_order_item TO shop_app;
CREATE INDEX IF NOT EXISTS idx_wholesale_item ON wholesale_order_item(order_id);

-- журнал переходов по этапам — для воронки «прошёл / пропустил этап»
CREATE TABLE IF NOT EXISTS wholesale_stage_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES wholesale_order(id) ON DELETE CASCADE,
  from_stage    wholesale_stage,
  to_stage      wholesale_stage NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wholesale_stage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wholesale_log_isolation ON wholesale_stage_log;
CREATE POLICY wholesale_log_isolation ON wholesale_stage_log
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON wholesale_stage_log TO shop_app;

-- воронка: сколько сделок и на какую сумму в каждом этапе
CREATE OR REPLACE FUNCTION wholesale_funnel(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (stage text, orders bigint, total numeric) LANGUAGE sql STABLE AS $$
  SELECT wo.stage::text, count(*), coalesce(sum(wo.total_sum), 0)
    FROM wholesale_order wo
   WHERE wo.account_id = p_account AND wo.deleted_at IS NULL
     AND wo.created_at >= p_from AND wo.created_at < p_to
   GROUP BY wo.stage;
$$;

-- юнит-экономика по клиенту: вклад в выручку и прибыль из розничных продаж
-- (по customer_id в чеках). Средний чек, число покупок, прибыль.
CREATE OR REPLACE FUNCTION customer_economics(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (customer_id uuid, name text, receipts bigint, revenue numeric,
               profit numeric, avg_receipt numeric) LANGUAGE sql STABLE AS $$
  SELECT cp.id, cp.name,
         count(*) FILTER (WHERE s.return_of_id IS NULL),
         coalesce(sum(CASE WHEN s.return_of_id IS NULL THEN s.total ELSE -s.total END), 0),
         coalesce(sum(CASE WHEN s.return_of_id IS NULL THEN s.total - s.cost_total
                           ELSE -(s.total - s.cost_total) END), 0),
         coalesce(avg(s.total) FILTER (WHERE s.return_of_id IS NULL), 0)
    FROM sale s
    JOIN counterparty cp ON cp.id = s.customer_id
   WHERE s.account_id = p_account AND s.customer_id IS NOT NULL
     AND s.created_at >= p_from AND s.created_at < p_to
   GROUP BY cp.id, cp.name
   ORDER BY 4 DESC;
$$;
