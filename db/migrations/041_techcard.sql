-- =====================================================================
-- 041_techcard.sql — Часть 35: составной товар и техкарты (мини-общепит).
--
-- Разбор конкурентов:
--  • Wipon: «Составной товар» (Тип: Комплект) — товар из нескольких товаров.
--    Прямо указано: «для бизнесов, требующих калькуляции затрат (Кофейни,
--    места Общественного питания)». Но это НАБОР, не рецепт со списанием сырья.
--  • МойСклад: техкарты (материалы → продукция), заказы на производство,
--    производственные задания, плановая себестоимость, разукомплектовка,
--    веб-приложение для рабочих. Это ПОЛНОЕ производство — избыточно для
--    магазина у дома.
--  • UMAG: базовые комплекты.
--
-- Что было у нас (часть 4): bundle_item (компоненты), product_kind='bundle',
-- bundle_extra_cost. НО при продаже bundle списывался САМ bundle, а не его
-- компоненты — это годится для набора-упаковки, но НЕ для техкарты общепита.
--
-- НАШ ВЫВОД (сегмент — магазин у дома с кофейней/выпечкой, НЕ завод):
--  1) Техкарта = bundle в режиме РЕЦЕПТ: при продаже готового блюда (кофе)
--     списываются ИНГРЕДИЕНТЫ (зёрна, молоко, стакан), а не сам «кофе».
--     Сам bundle остатка не ведёт — он «производится на лету» при продаже.
--  2) Флаг на bundle: 'kit' (набор — списывается сам, как было) vs 'recipe'
--     (техкарта — списываются компоненты). Не ломаем существующие наборы.
--  3) Себестоимость блюда = сумма себестоимостей ингредиентов (× кол-во) +
--     bundle_extra_cost. Это плановая себестоимость МоегоСклада, но считается
--     автоматически при продаже — без заказов на производство и заданий.
--  4) Выход (порций из рецепта) — коэффициент: рецепт на 10 булочек из мешка
--     муки. НЕ делаем заказы на производство/задания/веб-приложение рабочих —
--     магазину у дома это не нужно, это распыление.
-- =====================================================================

-- режим составного товара: kit (набор, списывается сам) / recipe (техкарта,
-- списываются ингредиенты). По умолчанию kit — не ломаем старые наборы.
ALTER TABLE product ADD COLUMN IF NOT EXISTS bundle_mode text NOT NULL DEFAULT 'kit';

-- сколько порций/единиц готового получается из состава (выход рецепта).
-- Рецепт «тесто на 10 булочек»: yield=10, ингредиенты на всю партию.
ALTER TABLE bundle_item ADD COLUMN IF NOT EXISTS unit text;   -- ед. изм. ингредиента (для отображения)

ALTER TABLE product ADD COLUMN IF NOT EXISTS recipe_yield numeric(14,3) NOT NULL DEFAULT 1;

-- Себестоимость блюда по техкарте: сумма (кол-во ингредиента × его последняя
-- закупочная цена) / выход + доп. расходы. Читается при продаже и в карточке.
CREATE OR REPLACE FUNCTION recipe_cost(p_account uuid, p_bundle uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(
           bi.qty * coalesce(
             (SELECT sdi.price FROM stock_doc_item sdi
                JOIN stock_doc sd ON sd.id = sdi.doc_id
               WHERE sd.account_id = p_account AND sdi.product_id = bi.component_id
                 AND sd.kind = 'supply' AND sd.status = 'done' AND sdi.price IS NOT NULL
               ORDER BY sd.created_at DESC LIMIT 1),
             (SELECT p.purchase_price FROM product p WHERE p.id = bi.component_id), 0)
         ), 0) / greatest((SELECT recipe_yield FROM product WHERE id = p_bundle), 1)
         + coalesce((SELECT bundle_extra_cost FROM product WHERE id = p_bundle), 0)
    FROM bundle_item bi
   WHERE bi.bundle_id = p_bundle AND bi.account_id = p_account;
$$;
