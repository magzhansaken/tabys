-- ЛЕНТЫ ДЛЯ НАКЛЕЕК: без них печатать не на чем.
--
-- Устройство печати было готово, а образцов лент НЕ БЫЛО НИ ОДНОГО:
-- таблица label_template пуста. Владелец открывал печать наклеек и
-- видел пустой список — печатать не на чем.
--
-- Заводим три ленты, которые вправду продаются в Казахстане. Главная —
-- 60 мм: на неё помещается название товара и штрихкод под ним, и её
-- клеят на товар без ценника.
--
-- КАЖДОМУ МАГАЗИНУ СВОИ: общих быть не может, и это верно — магазин
-- правит и удаляет свои ленты, не задевая чужих.

INSERT INTO label_template
  (account_id, name, kind, paper, width_mm, height_mm, cols, rows_per_page,
   margin_mm, gap_mm, font_scale, lang1, fields, is_default)
SELECT a.id, л.name, л.kind::label_kind, 'roll'::paper_kind,
       л.w, л.h, 1, 1, 2, 2, л.scale, 'ru', л.fields::jsonb, л.def
  FROM account a
 CROSS JOIN (VALUES
   -- ГЛАВНАЯ. Наклейка на товар: название и штрихкод под ним.
   -- Шесть сантиметров — самая ходовая лента для термопринтеров.
   ('Наклейка 60×40 мм', 'label', 60, 40, 1.0,
    '{"name": true, "barcode": true, "price": false}', true),

   -- Узкая: на мелкий товар, где 60 мм не наклеить.
   ('Наклейка 40×30 мм', 'label', 40, 30, 0.9,
    '{"name": true, "barcode": true, "price": false}', false),

   -- ЦЕННИК на полку: название крупно и цена. Штрихкод не нужен —
   -- покупатель его не сканирует.
   ('Ценник 60×40 мм', 'price_tag', 60, 40, 1.0,
    '{"name": true, "price": true, "barcode": false, "unit": true}', true)
 ) AS л(name, kind, w, h, scale, fields, def)
 WHERE a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM label_template t
      WHERE t.account_id = a.id AND t.name = л.name AND t.deleted_at IS NULL);

COMMENT ON TABLE label_template IS
  'Ленты для наклеек и ценников. Заводятся каждому магазину: он правит и удаляет свои, не задевая чужих';
