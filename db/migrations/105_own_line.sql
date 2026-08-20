-- =====================================================================
-- 105_own_line.sql — устройство показывает СВОЮ строку счёта.
--
-- НАЙДЕНО ПРИ ПРОВЕРКЕ. В колонке «в счёте» у второй и третьей кассы
-- стояла одна и та же строка — «Касса 3».
--
-- Я брал название по ВИДУ устройства, а строк этого вида несколько.
-- Человек искал бы в счёте «Касса 3», а платил за «Касса 2».
--
-- Связываем по имени: строка счёта называется так же, как устройство —
-- добавление их так и заводит. Если своей строки нет, показываем цену
-- вида без названия: значит устройство завели, а строку правили руками.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_devices(uuid);
CREATE FUNCTION platform_devices(p_account uuid)
RETURNS TABLE (
  id uuid, name text, kind text, code text,
  paired boolean, last_seen timestamptz, blocked boolean,
  in_plan boolean, monthly bigint, line_title text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH price AS (
    SELECT pl.kind::text AS kind, max(pl.unit_price) AS unit
      FROM plan_line pl
     WHERE pl.account_id = p_account AND pl.ends_at IS NULL
       AND pl.kind NOT IN ('base', 'discount')
     GROUP BY pl.kind
  ),
  all_dev AS (
    SELECT cr.id, cr.name, 'pos'::text AS kind,
           CASE WHEN d.paired_at IS NULL THEN d.pairing_code END AS code,
           d.paired_at IS NOT NULL AS paired,
           d.last_seen_at, coalesce(d.is_blocked, false) AS blocked,
           cr.created_at
      FROM cash_register cr
      LEFT JOIN LATERAL (
        SELECT * FROM device dv
         WHERE dv.cash_register_id = cr.id AND dv.deleted_at IS NULL
         ORDER BY dv.paired_at DESC NULLS LAST, dv.created_at DESC
         LIMIT 1
      ) d ON true
     WHERE cr.account_id = p_account AND cr.deleted_at IS NULL

    UNION ALL

    SELECT s.id, s.name, 'store'::text, NULL, true, NULL, false, s.created_at
      FROM store s
     WHERE s.account_id = p_account AND s.deleted_at IS NULL
  ),
  ranked AS (
    SELECT a.*, row_number() OVER (PARTITION BY a.kind ORDER BY a.created_at) AS n
      FROM all_dev a
  )
  SELECT r.id, r.name, r.kind, r.code, r.paired, r.last_seen_at, r.blocked,
         r.n = 1,
         -- Цена: своя строка, а нет своей — цена вида.
         CASE WHEN r.n = 1 THEN 0
              ELSE coalesce(own.unit_price, p.unit, 0) END,
         -- СВОЯ строка счёта, найденная по имени. Раньше бралась
         -- любая строка вида, и вторая касса показывала строку
         -- третьей: человек искал в счёте не то.
         CASE WHEN r.n = 1 THEN NULL ELSE own.title END
    FROM ranked r
    LEFT JOIN price p ON p.kind = r.kind
    LEFT JOIN LATERAL (
      SELECT pl.title, pl.unit_price FROM plan_line pl
       WHERE pl.account_id = p_account AND pl.ends_at IS NULL
         AND pl.kind::text = r.kind AND pl.title = r.name
       LIMIT 1
    ) own ON true
   ORDER BY r.kind DESC, r.n;
$$;
GRANT EXECUTE ON FUNCTION platform_devices(uuid) TO shop_app;
