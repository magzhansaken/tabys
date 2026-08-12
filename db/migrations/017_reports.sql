-- =====================================================================
-- 017_reports.sql — ОТЧЁТЫ И ДАШБОРД
-- Решения: docs/8_Решения_отчеты.md
--
-- Отчёты считаются в базе, а не в приложении: владелец открывает дашборд с
-- телефона в подвале магазина — надо отдать цифры за одну поездку.
-- =====================================================================

-- «Разрешён ли отрицательный баланс» — колонка из таблицы «Счета» на Главной
-- UMAG. У банковского счёта бывает овердрафт, у наличной кассы — никогда.
ALTER TABLE fin_account ADD COLUMN IF NOT EXISTS allow_negative boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN fin_account.allow_negative IS 'Флаг из таблицы «Счета» UMAG: разрешён ли минус на счёте';

-- =====================================================================
-- ДАШБОРД ДНЯ — «Показатели по магазинам» UMAG.
--
-- ВАЖНО: у UMAG «Количество продаж — это количество проданных товаров», но
-- «Средний чек = Выручка / Количество продаж». Если это штуки — формула даёт
-- среднюю цену позиции, а не средний чек. Считаем обе величины раздельно.
-- =====================================================================
CREATE OR REPLACE FUNCTION dashboard_day(p_account uuid, p_from timestamptz, p_to timestamptz,
                                         p_stores uuid[] DEFAULT NULL)
RETURNS TABLE (
  revenue numeric,          -- Выручка = продажи − возвраты
  receipts integer,         -- чеков (покупателей)
  items_sold numeric,       -- позиций (штук) — это и есть «количество продаж» UMAG
  avg_receipt numeric,      -- Средний чек = Выручка / чеки
  avg_items numeric,        -- среднее число позиций в чеке: работает ли допродажа
  cost numeric,             -- себестоимость
  gross_profit numeric,     -- Валовая = Выручка − Себестоимость
  margin_percent numeric,
  refunds numeric,
  refund_count integer,
  cash numeric, card numeric, qr numeric, credit numeric,
  discounts numeric,
  cancelled_count integer   -- отменённые позиции: контроль из Части 4
)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT * FROM sale
     WHERE account_id = p_account AND status IN ('completed','returned')
       AND completed_at >= p_from AND completed_at <= p_to
       AND (p_stores IS NULL OR store_id = ANY(p_stores))
  ),
  sales AS (SELECT * FROM s WHERE return_of_id IS NULL),
  rets  AS (SELECT * FROM s WHERE return_of_id IS NOT NULL),
  it AS (
    SELECT coalesce(sum(i.qty), 0) AS qty
      FROM sale_item i JOIN sales ON sales.id = i.sale_id
  ),
  canc AS (
    SELECT count(*)::integer AS n FROM cancelled_item
     WHERE account_id = p_account AND cancelled_at >= p_from AND cancelled_at <= p_to
  )
  SELECT
    coalesce((SELECT sum(total) FROM sales), 0) - coalesce((SELECT sum(total) FROM rets), 0),
    (SELECT count(*)::integer FROM sales),
    (SELECT qty FROM it),
    CASE WHEN (SELECT count(*) FROM sales) > 0
      THEN round((coalesce((SELECT sum(total) FROM sales), 0) - coalesce((SELECT sum(total) FROM rets), 0))
                 / (SELECT count(*) FROM sales), 2) ELSE 0 END,
    CASE WHEN (SELECT count(*) FROM sales) > 0
      THEN round((SELECT qty FROM it) / (SELECT count(*) FROM sales), 2) ELSE 0 END,
    coalesce((SELECT sum(cost_total) FROM sales), 0) - coalesce((SELECT sum(cost_total) FROM rets), 0),
    (coalesce((SELECT sum(total) FROM sales), 0) - coalesce((SELECT sum(total) FROM rets), 0))
      - (coalesce((SELECT sum(cost_total) FROM sales), 0) - coalesce((SELECT sum(cost_total) FROM rets), 0)),
    CASE WHEN coalesce((SELECT sum(total) FROM sales), 0) > 0
      THEN round(((coalesce((SELECT sum(total) FROM sales), 0) - coalesce((SELECT sum(total) FROM rets), 0)
                   - coalesce((SELECT sum(cost_total) FROM sales), 0) + coalesce((SELECT sum(cost_total) FROM rets), 0))
                  / coalesce((SELECT sum(total) FROM sales), 1) * 100)::numeric, 2) ELSE 0 END,
    coalesce((SELECT sum(total) FROM rets), 0),
    (SELECT count(*)::integer FROM rets),
    coalesce((SELECT sum(paid_cash) FROM sales), 0),
    coalesce((SELECT sum(paid_card) FROM sales), 0),
    coalesce((SELECT sum(paid_qr) FROM sales), 0),
    coalesce((SELECT sum(paid_credit) FROM sales), 0),
    coalesce((SELECT sum(discount_sum) FROM sales), 0),
    (SELECT n FROM canc);
$$;
GRANT EXECUTE ON FUNCTION dashboard_day(uuid,timestamptz,timestamptz,uuid[]) TO shop_app;

-- График выручки: «сумма выручки за каждый отдельный день» (UMAG)
CREATE OR REPLACE FUNCTION revenue_chart(p_account uuid, p_from timestamptz, p_to timestamptz,
                                         p_stores uuid[] DEFAULT NULL)
RETURNS TABLE (day date, revenue numeric, receipts integer, profit numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT d::date,
         coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         count(*) FILTER (WHERE s.return_of_id IS NULL)::integer,
         coalesce(sum(s.profit) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.profit) FILTER (WHERE s.return_of_id IS NOT NULL), 0)
    FROM generate_series(p_from::date, p_to::date, '1 day') d
    LEFT JOIN sale s ON s.completed_at::date = d::date AND s.account_id = p_account
                    AND s.status IN ('completed','returned')
                    AND (p_stores IS NULL OR s.store_id = ANY(p_stores))
   GROUP BY d ORDER BY d;
$$;
GRANT EXECUTE ON FUNCTION revenue_chart(uuid,timestamptz,timestamptz,uuid[]) TO shop_app;

-- =====================================================================
-- СТАТИСТИКА ПРОДАЖ ПО ТОВАРАМ (вкладка «По товарам» UMAG: количество продаж
-- и возвратов, сумма, себестоимость, прибыль, рентабельность, наценка)
-- =====================================================================
CREATE OR REPLACE FUNCTION sales_by_product(p_account uuid, p_from timestamptz, p_to timestamptz,
                                            p_category uuid DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (product_id uuid, name text, barcode text, unit text, category text,
               qty_sold numeric, qty_returned numeric, revenue numeric, cost numeric,
               profit numeric, margin_percent numeric, markup_percent numeric, receipts integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name,
         (SELECT code FROM barcode b WHERE b.product_id = p.id AND b.is_primary LIMIT 1),
         u.short_name, c.name,
         coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0),
         coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         (coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0))
         - (coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NOT NULL), 0)),
         -- рентабельность: прибыль к выручке
         CASE WHEN coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0) > 0
           THEN round((((coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
                        - coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL), 0))
                       / sum(i.total) FILTER (WHERE s.return_of_id IS NULL)) * 100)::numeric, 2)
           ELSE 0 END,
         -- наценка: прибыль к себестоимости
         CASE WHEN coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL), 0) > 0
           THEN round((((coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
                        - coalesce(sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL), 0))
                       / sum(i.qty * i.cost) FILTER (WHERE s.return_of_id IS NULL)) * 100)::numeric, 2)
           ELSE 0 END,
         count(DISTINCT s.id) FILTER (WHERE s.return_of_id IS NULL)::integer
    FROM sale_item i
    JOIN sale s ON s.id = i.sale_id
    JOIN product p ON p.id = i.product_id
    LEFT JOIN unit u ON u.id = p.unit_id
    LEFT JOIN category c ON c.id = p.category_id
   WHERE s.account_id = p_account AND s.status IN ('completed','returned')
     AND s.completed_at >= p_from AND s.completed_at <= p_to
     AND (p_category IS NULL OR p.category_id = p_category)
   GROUP BY p.id, p.name, u.short_name, c.name
   HAVING coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0) > 0
   ORDER BY 7 DESC LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION sales_by_product(uuid,timestamptz,timestamptz,uuid,integer) TO shop_app;

-- Разрезы «По категориям», «По поставщикам», «По покупателям», «По чекам» (UMAG)
CREATE OR REPLACE FUNCTION sales_by_dimension(p_account uuid, p_from timestamptz, p_to timestamptz,
                                              p_dim text)
RETURNS TABLE (id uuid, name text, qty numeric, revenue numeric, cost numeric,
               profit numeric, margin_percent numeric, receipts integer)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY EXECUTE format($q$
    SELECT g.id, coalesce(g.name, 'Без значения'),
           coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0),
           coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
           coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
           (coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0))
           - (coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NOT NULL), 0)),
           CASE WHEN coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0) > 0
             THEN round((((coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
                          - coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NULL), 0))
                         / sum(i.total) FILTER (WHERE s.return_of_id IS NULL)) * 100)::numeric, 2)
             ELSE 0 END,
           count(DISTINCT s.id) FILTER (WHERE s.return_of_id IS NULL)::integer
      FROM sale_item i
      JOIN sale s ON s.id = i.sale_id
      JOIN product p ON p.id = i.product_id
      LEFT JOIN %s g ON g.id = %s
     WHERE s.account_id = $1 AND s.status IN ('completed','returned')
       AND s.completed_at >= $2 AND s.completed_at <= $3
     GROUP BY g.id, g.name
     ORDER BY 4 DESC LIMIT 200
  $q$,
  CASE p_dim WHEN 'category' THEN 'category' WHEN 'supplier' THEN 'counterparty'
             WHEN 'customer' THEN 'counterparty' ELSE 'category' END,
  CASE p_dim WHEN 'category' THEN 'p.category_id' WHEN 'supplier' THEN 'p.supplier_id'
             WHEN 'customer' THEN 's.customer_id' ELSE 'p.category_id' END)
  USING p_account, p_from, p_to;
END $$;
GRANT EXECUTE ON FUNCTION sales_by_dimension(uuid,timestamptz,timestamptz,text) TO shop_app;

-- =====================================================================
-- ABC-АНАЛИЗ — модель UMAG: две оценки (по розничной цене и по прибыли)
-- плюс сводная. A — 80%, B — 15%, C — 5%.
-- Товар может быть «AC»: гонит выручку, а прибыли не даёт.
-- =====================================================================
CREATE OR REPLACE FUNCTION abc_analysis(p_account uuid, p_from timestamptz, p_to timestamptz,
                                        p_category uuid DEFAULT NULL)
RETURNS TABLE (product_id uuid, name text, purchase_price numeric, markup_percent numeric,
               retail_price numeric, qty numeric, cost_sum numeric, revenue_sum numeric,
               abc_revenue text, profit numeric, abc_profit text, abc_combined text, hint text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT p.id, p.name, p.purchase_price,
           coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NOT NULL), 0) AS q,
           coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0) AS rev,
           coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NULL), 0)
             - coalesce(sum(i.qty*i.cost) FILTER (WHERE s.return_of_id IS NOT NULL), 0) AS cst,
           max(i.price) AS price
      FROM sale_item i
      JOIN sale s ON s.id = i.sale_id
      JOIN product p ON p.id = i.product_id
     WHERE s.account_id = p_account AND s.status IN ('completed','returned')
       AND s.completed_at >= p_from AND s.completed_at <= p_to
       AND (p_category IS NULL OR p.category_id = p_category)
     GROUP BY p.id, p.name, p.purchase_price
    HAVING coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0) > 0
  ),
  tot AS (SELECT sum(rev) AS trev, sum(rev - cst) AS tprof FROM base WHERE rev > 0),
  ranked AS (
    SELECT b.*, (b.rev - b.cst) AS prof,
           sum(b.rev) OVER (ORDER BY b.rev DESC, b.id) / nullif((SELECT trev FROM tot), 0) AS cum_rev,
           sum(b.rev - b.cst) OVER (ORDER BY (b.rev - b.cst) DESC, b.id) / nullif((SELECT tprof FROM tot), 0) AS cum_prof
      FROM base b
  ),
  graded AS (
    SELECT r.*,
           CASE WHEN r.cum_rev <= 0.8 THEN 'A' WHEN r.cum_rev <= 0.95 THEN 'B' ELSE 'C' END AS g_rev,
           CASE WHEN r.cum_prof <= 0.8 THEN 'A' WHEN r.cum_prof <= 0.95 THEN 'B' ELSE 'C' END AS g_prof
      FROM ranked r
  )
  SELECT g.id, g.name, g.purchase_price,
         CASE WHEN g.cst > 0 THEN round(((g.rev - g.cst) / g.cst * 100)::numeric, 1) ELSE 0 END,
         g.price, g.q, g.cst, g.rev, g.g_rev, g.prof, g.g_prof,
         g.g_rev || g.g_prof,
         -- подсказка словами: две буквы владельцу ничего не говорят
         CASE g.g_rev || g.g_prof
           WHEN 'AA' THEN 'Локомотив: и оборот, и прибыль. Следите, чтобы не кончался'
           WHEN 'AC' THEN 'Оборот даёт, прибыль нет. Проверьте закупочную цену или поднимите наценку'
           WHEN 'AB' THEN 'Хороший оборот, прибыль средняя'
           WHEN 'CA' THEN 'Продаётся редко, но с высокой маржой. Стоит выложить заметнее'
           WHEN 'CC' THEN 'Ни оборота, ни прибыли. Кандидат на вывод из ассортимента'
           WHEN 'BB' THEN 'Крепкий середняк'
           ELSE 'Средние показатели'
         END
    FROM graded g ORDER BY g.rev DESC;
$$;
GRANT EXECUTE ON FUNCTION abc_analysis(uuid,timestamptz,timestamptz,uuid) TO shop_app;

-- =====================================================================
-- ОТЧЁТ ПО КАССИРАМ (модель UMAG: Имя, Сумма по отчётам, Сумма по продажам,
-- Безнал, Возврат, Итого = Продажи − Возвраты).
-- Наше добавление: расхождения по сменам и отменённые позиции — то, ради
-- чего этот отчёт вообще открывают.
-- =====================================================================
CREATE OR REPLACE FUNCTION cashier_report(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (employee_id uuid, name text, shifts integer, receipts integer,
               sales numeric, cashless numeric, refunds numeric, total numeric,
               shift_reports numeric, discrepancy_count integer, discrepancy_sum numeric,
               cancelled_count integer, cancelled_sum numeric, avg_receipt numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT e.id, e.first_name,
         (SELECT count(*)::integer FROM shift sh WHERE sh.closed_by = e.id
           AND sh.closed_at >= p_from AND sh.closed_at <= p_to),
         count(*) FILTER (WHERE s.return_of_id IS NULL)::integer,
         coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0),
         coalesce(sum(s.paid_card + s.paid_qr) FILTER (WHERE s.return_of_id IS NULL), 0),
         coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         -- «Сумма по отчётам» UMAG: конечные остатки смен этого кассира
         (SELECT coalesce(sum(sh.actual_cash), 0) FROM shift sh WHERE sh.closed_by = e.id
           AND sh.closed_at >= p_from AND sh.closed_at <= p_to),
         (SELECT count(*)::integer FROM shift sh WHERE sh.closed_by = e.id
           AND sh.closed_at >= p_from AND sh.closed_at <= p_to AND abs(coalesce(sh.discrepancy, 0)) >= 1),
         (SELECT coalesce(sum(sh.discrepancy), 0) FROM shift sh WHERE sh.closed_by = e.id
           AND sh.closed_at >= p_from AND sh.closed_at <= p_to),
         (SELECT count(*)::integer FROM cancelled_item ci WHERE ci.employee_id = e.id
           AND ci.cancelled_at >= p_from AND ci.cancelled_at <= p_to),
         (SELECT coalesce(sum(ci.qty_cancelled * coalesce(ci.price, 0)), 0) FROM cancelled_item ci
           WHERE ci.employee_id = e.id AND ci.cancelled_at >= p_from AND ci.cancelled_at <= p_to),
         CASE WHEN count(*) FILTER (WHERE s.return_of_id IS NULL) > 0
           THEN round((coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0)
                       / count(*) FILTER (WHERE s.return_of_id IS NULL))::numeric, 2)
           ELSE 0 END
    FROM employee e
    LEFT JOIN sale s ON s.employee_id = e.id AND s.status IN ('completed','returned')
                    AND s.completed_at >= p_from AND s.completed_at <= p_to
   WHERE e.account_id = p_account AND e.deleted_at IS NULL
   GROUP BY e.id, e.first_name
  HAVING count(s.id) > 0 OR (SELECT count(*) FROM shift sh WHERE sh.closed_by = e.id
           AND sh.closed_at >= p_from AND sh.closed_at <= p_to) > 0
   ORDER BY 8 DESC;
$$;
GRANT EXECUTE ON FUNCTION cashier_report(uuid,timestamptz,timestamptz) TO shop_app;

-- =====================================================================
-- СВОДНЫЙ ОТЧЁТ ПО ККМ — идея Wipon (5 июня 2026).
-- Организация и ККМ, продажи/возвраты, ДДС по типам оплаты, внесения и
-- изъятия, остаток на начало и конец, обороты по секциям (у нас — категории).
-- =====================================================================
CREATE OR REPLACE FUNCTION kkm_summary(p_account uuid, p_register uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  sales_count integer, sales_sum numeric, refunds_count integer, refunds_sum numeric,
  cash_sum numeric, card_sum numeric, qr_sum numeric, credit_sum numeric,
  deposits numeric, withdrawals numeric, opening_cash numeric, closing_cash numeric,
  shifts_count integer, fiscal_ok integer, fiscal_pending integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT * FROM sale WHERE account_id = p_account AND cash_register_id = p_register
      AND status IN ('completed','returned') AND completed_at >= p_from AND completed_at <= p_to
  ),
  ops AS (
    SELECT * FROM cash_operation WHERE account_id = p_account AND cash_register_id = p_register
      AND created_at >= p_from AND created_at <= p_to
  ),
  fr AS (
    SELECT fr.status FROM fiscal_receipt fr JOIN kkm k ON k.id = fr.kkm_id
     WHERE fr.account_id = p_account AND k.cash_register_id = p_register
       AND fr.punched_at >= p_from AND fr.punched_at <= p_to
  )
  SELECT
    (SELECT count(*)::integer FROM s WHERE return_of_id IS NULL),
    (SELECT coalesce(sum(total), 0) FROM s WHERE return_of_id IS NULL),
    (SELECT count(*)::integer FROM s WHERE return_of_id IS NOT NULL),
    (SELECT coalesce(sum(total), 0) FROM s WHERE return_of_id IS NOT NULL),
    (SELECT coalesce(sum(paid_cash), 0) FROM s WHERE return_of_id IS NULL),
    (SELECT coalesce(sum(paid_card), 0) FROM s WHERE return_of_id IS NULL),
    (SELECT coalesce(sum(paid_qr), 0) FROM s WHERE return_of_id IS NULL),
    (SELECT coalesce(sum(paid_credit), 0) FROM s WHERE return_of_id IS NULL),
    (SELECT coalesce(sum(amount), 0) FROM ops WHERE kind IN ('deposit','opening_float')),
    (SELECT coalesce(sum(amount), 0) FROM ops WHERE kind IN ('withdrawal','collection')),
    -- остаток на начало периода: размен первой смены в периоде
    (SELECT coalesce(opening_float, 0) FROM shift WHERE cash_register_id = p_register
       AND opened_at >= p_from ORDER BY opened_at LIMIT 1),
    -- остаток на конец: факт последней закрытой смены
    (SELECT coalesce(actual_cash, 0) FROM shift WHERE cash_register_id = p_register
       AND closed_at <= p_to AND status = 'closed' ORDER BY closed_at DESC LIMIT 1),
    (SELECT count(*)::integer FROM shift WHERE cash_register_id = p_register
       AND opened_at >= p_from AND opened_at <= p_to),
    (SELECT count(*)::integer FROM fr WHERE status = 'ok'),
    (SELECT count(*)::integer FROM fr WHERE status IN ('pending','failed'));
$$;
GRANT EXECUTE ON FUNCTION kkm_summary(uuid,uuid,timestamptz,timestamptz) TO shop_app;

-- Обороты по секциям (у Wipon — секции ККМ, у нас — категории товаров)
CREATE OR REPLACE FUNCTION kkm_sections(p_account uuid, p_register uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (section text, qty numeric, revenue numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT coalesce(c.name, 'Без категории'),
         coalesce(sum(i.qty) FILTER (WHERE s.return_of_id IS NULL), 0),
         coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(i.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0)
    FROM sale_item i
    JOIN sale s ON s.id = i.sale_id
    JOIN product p ON p.id = i.product_id
    LEFT JOIN category c ON c.id = p.category_id
   WHERE s.account_id = p_account AND s.cash_register_id = p_register
     AND s.status IN ('completed','returned')
     AND s.completed_at >= p_from AND s.completed_at <= p_to
   GROUP BY c.name ORDER BY 3 DESC;
$$;
GRANT EXECUTE ON FUNCTION kkm_sections(uuid,uuid,timestamptz,timestamptz) TO shop_app;

-- =====================================================================
-- СИНХРОНИЗАЦИЯ КАСС — таблица «Синхронизация с сервером» с Главной UMAG.
-- Светофор: красный / жёлтый / зелёный.
-- =====================================================================
CREATE OR REPLACE FUNCTION sync_status_board(p_account uuid)
RETURNS TABLE (device_id uuid, cash_register text, store text, status text,
               last_sync timestamptz, minutes_ago integer, pending_events integer)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT d.id, coalesce(cr.name, 'Без кассы'), coalesce(st.name, '—'),
         CASE
           WHEN d.last_seen_at IS NULL THEN 'red'
           WHEN d.last_seen_at < now() - interval '30 minutes' THEN 'red'
           WHEN d.last_seen_at < now() - interval '5 minutes' THEN 'yellow'
           ELSE 'green'
         END,
         d.last_seen_at,
         CASE WHEN d.last_seen_at IS NULL THEN NULL
           ELSE (extract(epoch FROM (now() - d.last_seen_at)) / 60)::integer END,
         (SELECT count(*)::integer FROM oplog o WHERE o.device_id = d.id AND o.applied_at IS NULL)
    FROM device d
    LEFT JOIN cash_register cr ON cr.id = d.cash_register_id
    LEFT JOIN store st ON st.id = cr.store_id
   WHERE d.account_id = p_account AND d.deleted_at IS NULL AND NOT d.is_blocked
   ORDER BY d.last_seen_at NULLS FIRST;
$$;
GRANT EXECUTE ON FUNCTION sync_status_board(uuid) TO shop_app;
