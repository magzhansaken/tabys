-- =====================================================================
-- 036_marking.sql — Часть 30: маркировка товаров (ИС МПТ Казахстан).
--
-- Разбор рынка (веб-поиск, KZ 2026):
--  • ИС МПТ (markirovka.kz) — гос. система маркировки. Код DataMatrix =
--    GTIN (01) + серийный номер (21) в формате GS1.
--  • Обязательна: табак, обувь, лекарства, алкоголь, молочка, пиво (с 02.2026),
--    моторные масла (с 02.2026), лёгкая промышленность.
--  • Три точки для розницы: ПРИЁМКА (скан + сверка с поставщиком),
--    хранение, ВЫВОД ИЗ ОБОРОТА при розничной продаже (касса → ИС МПТ).
--  • Требуется регистрация в ИС МПТ и API. Автоблокировка операций с
--    непринятыми/уже выведенными кодами.
--
-- Разбор конкурентов:
--  • Wipon: модуль «Маркировка» (только Wipon Pro) — приёмка через скан кода
--    с выбором категории, извлечение GTIN. Wipon Pro (УКМ) — проверка
--    акцизных марок алкоголя.
--  • МойСклад: российская маркировка (Честный ЗНАК), не адаптирована под КЗ.
--  • UMAG: базовая поддержка.
--
-- Что было у нас (часть 18): таблица marking_code (код/gtin/serial/статусы
-- in_stock/sold/returned, привязка к приёмке и чеку), parseDataMatrix,
-- приёмка и продажа кода. НО: не выведено в API, нет журнала отправки в
-- ИС МПТ, нет сверки при приёмке, нет возврата в оборот, нет отчётности.
--
-- НАШ ВЫВОД: завершаем маркировку до рабочего цикла «принял → продал/вернул →
-- вывел из оборота», с журналом обмена с ИС МПТ (как ЭСФ/фискализация:
-- механика до границы, боевой API по регистрации в ИС МПТ). НЕ делаем заказ
-- кодов маркировки (это забота производителя/импортёра, не магазина у дома).
-- =====================================================================

-- статус вывода из оборота у кода (сообщили ли в ИС МПТ)
ALTER TABLE marking_code ADD COLUMN IF NOT EXISTS withdrawal_status text NOT NULL DEFAULT 'none';
  -- none / pending / reported / failed
ALTER TABLE marking_code ADD COLUMN IF NOT EXISTS withdrawal_error text;

-- журнал обмена с ИС МПТ: что отправили, когда, с каким результатом.
-- Без журнала не понять, ушёл ли вывод из оборота (штраф за непроведённый).
CREATE TABLE IF NOT EXISTS marking_report (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          text NOT NULL,                 -- 'withdrawal' (вывод) / 'return' (возврат в оборот)
  code          text NOT NULL,
  marking_code_id uuid REFERENCES marking_code(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending', -- pending / ok / failed
  response_code integer,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reported_at   timestamptz
);
ALTER TABLE marking_report ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marking_report_isolation ON marking_report;
CREATE POLICY marking_report_isolation ON marking_report
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marking_report TO shop_app;
CREATE INDEX IF NOT EXISTS idx_marking_report ON marking_report(account_id, created_at DESC);

-- реестр остатков маркированных кодов по товару (для отчёта и контроля)
CREATE OR REPLACE FUNCTION marking_stock(p_account uuid)
RETURNS TABLE (product_id uuid, product_name text, marking text,
               in_stock bigint, sold bigint, returned bigint)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.name, p.marking::text,
         count(*) FILTER (WHERE mc.status = 'in_stock'),
         count(*) FILTER (WHERE mc.status = 'sold'),
         count(*) FILTER (WHERE mc.status = 'returned')
    FROM marking_code mc
    JOIN product p ON p.id = mc.product_id
   WHERE mc.account_id = p_account
   GROUP BY p.id, p.name, p.marking
   ORDER BY p.name;
$$;
