-- =====================================================================
-- 022_ai.sql — ИИ-ФУНКЦИИ
-- Решения: docs/13_Решения_ИИ.md
--
-- Ответ на главную жалобу клиентов UMAG: «технические трудности при внесении
-- позиций». Вместо семи полей — фотография этикетки.
--
-- Wipon подошёл ближе всех со своей автоприёмкой, но у них она «в офлайн-режиме
-- недоступна». У нас распознавание уходит в очередь: фото снято сейчас,
-- разобрано когда появится связь.
-- =====================================================================
CREATE TYPE ai_task_kind AS ENUM ('product_photo','product_voice','invoice_photo','restock_advice');
CREATE TYPE ai_task_status AS ENUM ('queued','running','done','failed','confirmed','rejected');

CREATE TABLE ai_task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          ai_task_kind NOT NULL,
  status        ai_task_status NOT NULL DEFAULT 'queued',
  input_ref     text,                          -- ссылка на фото или расшифровку
  input_text    text,                          -- для голоса
  result        jsonb,                         -- что распознали
  confidence    numeric(4,3),                  -- насколько уверены
  provider      text,
  attempts      integer NOT NULL DEFAULT 0,
  next_try_at   timestamptz,
  error         text,
  -- ничего не пишем в базу без человека: модель ошибается, а неверная цена
  -- это деньги владельца
  confirmed_by  uuid REFERENCES employee(id),
  confirmed_at  timestamptz,
  created_entity_id uuid,
  employee_id   uuid REFERENCES employee(id),
  device_id     uuid REFERENCES device(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON ai_task(account_id, kind, status);
CREATE INDEX ON ai_task(status, next_try_at) WHERE status IN ('queued','running');

DO $$
BEGIN
  EXECUTE 'ALTER TABLE ai_task ENABLE ROW LEVEL SECURITY';
  EXECUTE $f$CREATE POLICY tenant_isolation ON ai_task USING
    (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ai_task TO shop_app';
END $$;
CREATE TRIGGER ai_task_touch BEFORE UPDATE ON ai_task FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПОДСКАЗКИ ДОЗАКАЗА.
-- План пополнения из Части 3 знает только минимальный остаток. Здесь —
-- скорость продаж и дни до нуля: то, чего формула не видит.
-- =====================================================================
CREATE OR REPLACE FUNCTION restock_advice(p_account uuid, p_days integer DEFAULT 30)
RETURNS TABLE (product_id uuid, name text, stock numeric, min_stock numeric,
               sold_qty numeric, per_day numeric, days_left numeric,
               suggest_qty numeric, supplier text, supplier_id uuid, urgency text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH sales AS (
    SELECT i.product_id, sum(i.qty) AS sold
      FROM sale_item i JOIN sale s ON s.id = i.sale_id
     WHERE s.account_id = p_account AND s.status = 'completed' AND s.return_of_id IS NULL
       AND s.completed_at > now() - (p_days || ' days')::interval
     GROUP BY i.product_id
  ),
  st AS (
    SELECT product_id, sum(qty) AS qty FROM stock_balance
     WHERE account_id = p_account GROUP BY product_id
  )
  SELECT p.id, p.name, coalesce(st.qty, 0), p.min_stock,
         coalesce(sales.sold, 0),
         round(coalesce(sales.sold, 0) / p_days, 3) AS per_day,
         CASE WHEN coalesce(sales.sold, 0) > 0
           THEN round(coalesce(st.qty, 0) / (sales.sold / p_days), 1) ELSE NULL END AS days_left,
         -- берём запас на две недели вперёд, но не меньше минимума
         CASE WHEN coalesce(sales.sold, 0) > 0
           THEN greatest(ceil((sales.sold / p_days) * 14 - coalesce(st.qty, 0)),
                         coalesce(p.min_stock, 0) - coalesce(st.qty, 0))
           ELSE coalesce(p.min_stock, 0) - coalesce(st.qty, 0) END AS suggest,
         c.name, c.id,
         CASE
           WHEN coalesce(st.qty, 0) <= 0 THEN 'out'
           WHEN coalesce(sales.sold, 0) > 0 AND coalesce(st.qty, 0) / (sales.sold / p_days) <= 2 THEN 'critical'
           WHEN coalesce(sales.sold, 0) > 0 AND coalesce(st.qty, 0) / (sales.sold / p_days) <= 5 THEN 'soon'
           WHEN p.min_stock IS NOT NULL AND coalesce(st.qty, 0) <= p.min_stock THEN 'below_min'
           ELSE 'ok'
         END
    FROM product p
    LEFT JOIN st ON st.product_id = p.id
    LEFT JOIN sales ON sales.product_id = p.id
    LEFT JOIN counterparty c ON c.id = p.supplier_id
   WHERE p.account_id = p_account AND p.archived_at IS NULL AND p.track_stock
     AND (coalesce(st.qty, 0) <= 0
          OR (p.min_stock IS NOT NULL AND coalesce(st.qty, 0) <= p.min_stock)
          OR (coalesce(sales.sold, 0) > 0 AND coalesce(st.qty, 0) / (sales.sold / p_days) <= 5))
   ORDER BY CASE WHEN coalesce(st.qty, 0) <= 0 THEN 0 ELSE 1 END,
            coalesce(st.qty, 0) / nullif(coalesce(sales.sold, 0) / p_days, 0) NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION restock_advice(uuid,integer) TO shop_app;
