-- =====================================================================
-- 039_ai_receiving.sql — Часть 33: AI-приёмка на максимум.
--
-- Разбор рынка (веб-поиск 2026):
--  • OCR-приёмка сокращает время приёмки товара на 70%, убирает ошибки в
--    артикулах/массе/реквизитах.
--  • Ключевой приём: «сопоставление данных накладной с ЗАКАЗАМИ в реальном
--    времени» — снижает налоговые риски, ускоряет оприходование.
--  • 1С:Распознавание, Saby, ПланФикс-Датамайнер — но это ERP/бухгалтерия,
--    НЕ касса магазина у дома. Человек всегда проверяет перед записью.
--
-- Разбор конкурентов (розница КЗ):
--  • Wipon, UMAG, МойСклад: распознавания накладных из фото НЕТ. Это фишка
--    1С/ERP, которую мы приносим в кассу магазина у дома — наше УТП.
--
-- Что было у нас (часть 22): ai_task (очередь), recognizeInvoice,
-- invoiceFromPhoto, receiveFromInvoicePhoto (черновик приёмки с сопоставлением
-- товаров matched/unmatched), receiveFromEsf, productFromPhoto/Voice,
-- confirmProduct, restockAdvice. Уже сильнее всех. Человек подтверждает.
--
-- НАШ ВЫВОД — усилить до «максимума»:
--  1) СВЕРКА накладной с заказом поставщику: заказали 10 — привезли 8 (недовоз),
--     цена в накладной выше заказанной (подорожание) — подсветить ДО приёмки.
--  2) КОНТРОЛЬ ЦЕН: цена закупки в накладной выше прошлой поставки — предупредить
--     (защита от ошибки распознавания и от «накрутки» поставщика).
--  3) ГОЛОСОВАЯ ИНВЕНТАРИЗАЦИЯ: продавец наговаривает «сахар двадцать, мука
--     пятнадцать» — распознаётся в факт инвентаризации. Руки заняты товаром.
--  4) Всё это — с подтверждением человеком (ничего в базу без него).
-- =====================================================================

-- расхождения при сверке распознанной накладной с заказом/историей цен.
-- Хранит результат сверки для показа человеку перед подтверждением приёмки.
CREATE TABLE IF NOT EXISTS ai_receipt_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES ai_task(id) ON DELETE CASCADE,
  product_id    uuid REFERENCES product(id),
  product_name  text,
  kind          text NOT NULL,          -- shortfall/surplus/price_up/price_down/new_product/unmatched
  ordered_qty   numeric(14,3),
  invoice_qty   numeric(14,3),
  last_price    numeric(14,2),
  invoice_price numeric(14,2),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_receipt_check ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_receipt_check_isolation ON ai_receipt_check;
CREATE POLICY ai_receipt_check_isolation ON ai_receipt_check
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_receipt_check TO shop_app;
CREATE INDEX IF NOT EXISTS idx_ai_receipt_check ON ai_receipt_check(task_id);

-- последняя цена закупки товара (для контроля подорожания). Берём из
-- позиций приёмок. Функция — последняя цена по завершённым supply.
CREATE OR REPLACE FUNCTION last_purchase_price(p_account uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT sdi.price
    FROM stock_doc_item sdi
    JOIN stock_doc sd ON sd.id = sdi.doc_id
   WHERE sd.account_id = p_account AND sdi.product_id = p_product
     AND sd.kind = 'supply' AND sd.status = 'done' AND sdi.price IS NOT NULL
   ORDER BY sd.created_at DESC
   LIMIT 1;
$$;
