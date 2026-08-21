-- УЧЕБНЫЕ ТОВАРЫ ПОМЕЧЕНЫ.
--
-- Владелец спросил: почему у всех новых магазинов есть товары?
--
-- Причина двойная:
--   галка «наполнить учебными товарами» стояла ЗАРАНЕЕ — товары уходили
--     в каждый магазин, даже когда их не просили;
--   товары НЕ БЫЛИ ПОМЕЧЕНЫ: «Хлеб «Тандыр» · 250 ₸» не отличить от
--     настоящего.
--
-- Владелец открывал кабинет, видел двенадцать товаров, которых у него
-- нет, и думал, что система нашла их сама. А кассир пробивал «Хлеб» с
-- выдуманной ценой, и покупатель платил не ту сумму.
--
-- Галку сняли в форме. Здесь помечаем товары: «(учебный)» в названии и
-- «УЧЕБНЫЙ» в артикуле — видно в списке, видно на кассе, и удалить все
-- разом можно одним отбором.

CREATE OR REPLACE FUNCTION public.seed_demo_goods(p_account uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pt uuid; v_cat uuid; v_unit_pcs uuid; v_unit_kg uuid;
  v_id uuid; v_n integer := 0;
  r record;
BEGIN
  -- Вид цены: без него цена ни к чему не привяжется, и касса пробьёт
  -- товар за ноль.
  SELECT id INTO v_pt FROM price_type
   WHERE account_id = p_account ORDER BY is_default DESC LIMIT 1;
  IF v_pt IS NULL THEN
    INSERT INTO price_type (account_id, name, code, is_default)
    VALUES (p_account, 'Розница', 'retail', true) RETURNING id INTO v_pt;
  END IF;

  SELECT id INTO v_unit_pcs FROM unit
   WHERE short_name = 'шт' AND (account_id = p_account OR account_id IS NULL) LIMIT 1;
  SELECT id INTO v_unit_kg FROM unit
   WHERE short_name = 'кг' AND (account_id = p_account OR account_id IS NULL) LIMIT 1;

  FOR r IN
    SELECT * FROM (VALUES
      ('Хлеб и выпечка', 'Хлеб «Тандыр»',        250, 'simple', NULL, 'none',    true),
      ('Хлеб и выпечка', 'Батон нарезной',       220, 'simple', NULL, 'none',    false),
      ('Молочное',       'Молоко 2,5% 1 л',      480, 'simple', NULL, 'none',    true),
      ('Молочное',       'Айран 0,5 л',          220, 'simple', NULL, 'none',    true),
      ('Молочное',       'Сыр «Российский»',    4270, 'weight', '101', 'none',   false),
      ('Овощи и фрукты', 'Картофель',            280, 'weight', '301', 'none',   true),
      ('Овощи и фрукты', 'Яблоки',               690, 'weight', '306', 'none',   false),
      ('Бакалея',        'Сахар 1 кг',           520, 'simple', NULL, 'none',    true),
      ('Бакалея',        'Масло подсолнечное',   950, 'simple', NULL, 'none',    false),
      ('Напитки',        'Вода 1,5 л',           280, 'simple', NULL, 'none',    true),
      ('Табак',          'Сигареты',            1200, 'simple', NULL, 'tobacco', true),
      ('Хозтовары',      'Пакет-майка',           30, 'simple', NULL, 'none',    true)
    ) AS t(кат, имя, цена, вид, plu, марка, ходовой)
  LOOP
    -- Товар с таким именем уже есть — не задваиваем.
    IF EXISTS (SELECT 1 FROM product
                WHERE account_id = p_account AND name = r.имя AND deleted_at IS NULL) THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_cat FROM category
     WHERE account_id = p_account AND name = r.кат AND deleted_at IS NULL LIMIT 1;
    IF v_cat IS NULL THEN
      INSERT INTO category (account_id, name, is_active)
      VALUES (p_account, r.кат, true) RETURNING id INTO v_cat;
    END IF;

    -- УЧЕБНЫЙ ТОВАР ПОМЕЧЕН, и это главное.
    --
    -- Было: «Хлеб «Тандыр» · 250 ₸» — не отличить от настоящего.
    -- Владелец открывал кабинет, видел двенадцать товаров, которых у
    -- него нет, и думал, что система нашла их сама. А кассир пробивал
    -- «Хлеб» с выдуманной ценой, и покупатель платил не ту сумму.
    --
    -- Теперь в артикуле стоит УЧЕБНЫЙ: видно в списке, видно при
    -- поиске, и можно удалить все разом одним отбором.
    INSERT INTO product (account_id, kind, name, category_id, unit_id,
                         plu_code, marking, is_quick, track_stock, vat_rate,
                         is_active, article)
    VALUES (p_account, r.вид::product_kind, r.имя || ' (учебный)', v_cat,
            CASE WHEN r.вид = 'weight' THEN v_unit_kg ELSE v_unit_pcs END,
            r.plu::integer, r.марка::marking_kind, r.ходовой, true, 12, true,
            'УЧЕБНЫЙ')
    RETURNING id INTO v_id;

    INSERT INTO product_price (account_id, product_id, price_type_id, value)
    VALUES (p_account, v_id, v_pt, r.цена);

    /* Штрихкод только штучным: весовые читаются кодом весов.

       КОД ТОВАРА БЕРЁМ ЗАНОВО. Номер присваивается при вставке, и
       переменная v_id его не несёт — отдельный запрос возвращал пусто,
       штрихкод выходил пустым, и вставка падала. */
    IF r.вид = 'simple' THEN
      DECLARE v_code integer;
      BEGIN
        SELECT code INTO v_code FROM product WHERE id = v_id;
        IF v_code IS NOT NULL THEN
          INSERT INTO barcode (account_id, product_id, code, is_primary)
          VALUES (p_account, v_id, gen_internal_barcode(p_account, v_code), true)
          ON CONFLICT DO NOTHING;
        END IF;
      END;
    END IF;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END $function$;



-- ПРЕЖНИЕ ТОВАРЫ НЕ ТРОГАЕМ.
--
-- Отобрать их надёжно нельзя: владелец мог завести «Хлеб «Тандыр»» сам,
-- и мы переименуем ЕГО товар в учебный. Это хуже, чем оставить как
-- есть.
--
-- В старых магазинах учебные узнаются просто: их ровно двенадцать и они
-- не продавались ни разу. Владелец удалит их сам — это минута.

COMMENT ON FUNCTION seed_demo_goods(uuid) IS
  'Учебные товары для показа. Помечены «(учебный)» и артикулом УЧЕБНЫЙ: их видно и можно удалить разом';
