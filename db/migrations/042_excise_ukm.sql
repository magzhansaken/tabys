-- =====================================================================
-- 042_excise_ukm.sql — Часть 36: акцизные марки алкоголя (УКМ).
--
-- Разбор рынка (веб-поиск, КЗ 2026):
--  • УКМ (учётно-контрольная марка) — наклейка с штрих-кодом (PDF417/DataMatrix)
--    на алкоголь (кроме вина наливом, пива). Выдаёт ИС Банкнотной фабрики
--    Нацбанка. Содержит: серию, номер, наименование, объём, крепость,
--    данные производителя.
--  • Проверка подлинности: приложение e-Sapa (КГД РК + НИТ) и портал КГД
--    «Проверка достоверности УКМ». По скану штрих-кода ИЛИ по серии+номеру.
--    Результат: «Код присутствует в базе» + инфо, либо «не найдена».
--  • Новые правила: Приказ Минфина №682 от 07.11.2025.
--  • Риск: хранение/продажа немаркированного или контрафактного алкоголя →
--    штрафы, конфискация, лишение лицензии. Проверка марки защищает магазин.
--
-- Разбор конкурентов:
--  • Wipon Pro: раздел УКМ — проверка акцизных марок алкогольной продукции.
--    Это то, что мы догоняем.
--  • UMAG, МойСклад: проверки УКМ по КЗ нет.
--
-- Что было у нас: marking_kind='alcohol' (часть 4), общая маркировка ИС МПТ
-- (часть 30, DataMatrix для обуви/табака/фармы). НО УКМ — ОТДЕЛЬНЫЙ механизм:
-- проверка подлинности по серии/номеру через e-Sapa/КГД, не вывод из оборота
-- ИС МПТ. Алкоголь в КЗ идёт по УКМ, а не по ИС МПТ.
--
-- НАШ ВЫВОД:
--  1) Проверка УКМ по серии+номеру (или скану) через провайдер (Mock + КГД/
--     e-Sapa каркас). При приёмке и продаже алкоголя — подтвердить подлинность.
--  2) Учёт марок: какие УКМ на складе, проданы, забракованы. Защита от
--     повторной продажи одной марки (контрафакт клонирует номера).
--  3) Провайдерный паттерн (как verification/marketplace). Боевой доступ к
--     e-Sapa/КГД по ЭЦП НУЦ РК.
--  4) НЕ делаем заявки на выдачу УКМ (это для производителя/импортёра через
--     ИС Банкнотной фабрики) — магазин у дома получает уже маркированный
--     алкоголь и только проверяет + учитывает.
-- =====================================================================

-- учтённые акцизные марки алкоголя
CREATE TABLE IF NOT EXISTS excise_mark (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  series        text NOT NULL,                  -- серия УКМ
  number        text NOT NULL,                  -- номер УКМ
  product_id    uuid REFERENCES product(id),
  product_name  text,                           -- по данным проверки
  volume        numeric(8,3),                   -- объём тары, л
  strength      numeric(5,2),                   -- крепость, %
  producer      text,                           -- производитель/поставщик
  status        text NOT NULL DEFAULT 'in_stock', -- in_stock / sold / rejected
  verified      boolean NOT NULL DEFAULT false, -- подтверждена подлинность
  doc_id        uuid REFERENCES stock_doc(id),  -- приёмка
  sale_id       uuid REFERENCES sale(id),       -- продажа
  verified_at   timestamptz,
  sold_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, series, number)           -- одна марка учитывается один раз
);
ALTER TABLE excise_mark ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS excise_mark_isolation ON excise_mark;
CREATE POLICY excise_mark_isolation ON excise_mark
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON excise_mark TO shop_app;
CREATE INDEX IF NOT EXISTS idx_excise_mark ON excise_mark(account_id, status);

-- журнал проверок УКМ (аудит: что проверяли, что вернул сервис)
CREATE TABLE IF NOT EXISTS excise_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  series        text NOT NULL,
  number        text NOT NULL,
  provider      text NOT NULL DEFAULT 'esapa',
  found         boolean NOT NULL DEFAULT false,
  product_name  text,
  result        text,                            -- ok / not_found / already_sold
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE excise_check ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS excise_check_isolation ON excise_check;
CREATE POLICY excise_check_isolation ON excise_check
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON excise_check TO shop_app;
CREATE INDEX IF NOT EXISTS idx_excise_check ON excise_check(account_id, created_at DESC);

-- остатки марок по товару (для отчёта)
CREATE OR REPLACE FUNCTION excise_stock(p_account uuid)
RETURNS TABLE (product_id uuid, product_name text, in_stock bigint, sold bigint, rejected bigint)
LANGUAGE sql STABLE AS $$
  SELECT em.product_id, coalesce(p.name, em.product_name),
         count(*) FILTER (WHERE em.status = 'in_stock'),
         count(*) FILTER (WHERE em.status = 'sold'),
         count(*) FILTER (WHERE em.status = 'rejected')
    FROM excise_mark em
    LEFT JOIN product p ON p.id = em.product_id
   WHERE em.account_id = p_account
   GROUP BY em.product_id, coalesce(p.name, em.product_name)
   ORDER BY 2;
$$;
