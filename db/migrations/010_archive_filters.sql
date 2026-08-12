-- =====================================================================
-- 010_archive_filters.sql — АРХИВ И ФИЛЬТРЫ (2.5)
-- МойСклад: «помещайте товары в архив — записи будут скрыты, но не удалены».
-- Архив и удаление — разные вещи: на товар ссылаются прошлые продажи,
-- поэтому настоящего удаления быть не может.
-- =====================================================================
ALTER TABLE product ADD COLUMN IF NOT EXISTS archived_at timestamptz;
COMMENT ON COLUMN product.archived_at IS 'Архив (МС): скрыт из списков и кассы, но виден в отчётах и восстановим';
CREATE INDEX IF NOT EXISTS product_active_idx ON product(account_id)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

ALTER TABLE category ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- =====================================================================
-- Архивирование с проверкой: товар, который состоит в комплекте, архивировать
-- нельзя — иначе комплект будет продаваться и списывать несуществующее.
-- =====================================================================
CREATE OR REPLACE FUNCTION archive_products(p_account uuid, p_ids uuid[], p_archive boolean DEFAULT true)
RETURNS TABLE (affected integer, blocked_names text[])
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer; blocked text[];
BEGIN
  IF p_archive THEN
    SELECT array_agg(DISTINCT p.name) INTO blocked
      FROM product p
     WHERE p.account_id = p_account AND p.id = ANY(p_ids)
       AND EXISTS (SELECT 1 FROM bundle_item bi JOIN product b ON b.id = bi.bundle_id
                    WHERE bi.component_id = p.id AND b.deleted_at IS NULL AND b.archived_at IS NULL);

    UPDATE product SET archived_at = now()
     WHERE account_id = p_account AND id = ANY(p_ids) AND deleted_at IS NULL AND archived_at IS NULL
       AND (blocked IS NULL OR name <> ALL(blocked));
  ELSE
    UPDATE product SET archived_at = NULL
     WHERE account_id = p_account AND id = ANY(p_ids) AND deleted_at IS NULL;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT n, coalesce(blocked, ARRAY[]::text[]);
END $$;
GRANT EXECUTE ON FUNCTION archive_products(uuid,uuid[],boolean) TO shop_app;
