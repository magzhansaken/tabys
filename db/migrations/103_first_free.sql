-- =====================================================================
-- 103_first_free.sql — первое устройство каждого вида входит в тариф.
--
-- ПРАВИЛО ДОНОРА, взятое вместе с их доводом:
--
--   «Владелец платформы смотрел список и не мог отличить кассу,
--    которая идёт в основе, от второй — платной. Правило простое и
--    совпадает с тем, как считаются деньги: ПЕРВОЕ устройство каждого
--    вида входит в тариф, остальные оплачиваются отдельно.»
--
-- У НАС ЭТОГО ПРАВИЛА НЕ БЫЛО ВОВСЕ. Тариф давал магазин, а каждая
-- касса — включая первую — считалась отдельно. Значит клиент платил за
-- то, что и так входит в тариф, либо мы не брали за вторую.
--
-- Теперь как у них: первая касса, первая точка — в тарифе. Вторая и
-- дальше — строкой счёта.
--
-- ЦЕНУ БЕРЁМ ИЗ СТРОКИ СЧЁТА того же вида, а не считаем заново: иначе
-- в списке устройств будет одна цифра, а в счёте другая, и человек не
-- поймёт, какой верить.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_devices(uuid);
CREATE FUNCTION platform_devices(p_account uuid)
RETURNS TABLE (
  id uuid, name text, kind text, code text,
  paired boolean, last_seen timestamptz, blocked boolean,
  -- Входит в тариф или доплачено сверх него.
  in_plan boolean,
  -- Сколько стоит в месяц. Ноль значит входит в тариф.
  monthly bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH price AS (
    -- Цена вида — из действующей строки счёта. Если строки нет, вид
    -- бесплатен: значит все такие устройства в тарифе.
    SELECT pl.kind::text AS kind, max(pl.unit_price) AS unit
      FROM plan_line pl
     WHERE pl.account_id = p_account AND pl.ends_at IS NULL
       AND pl.kind NOT IN ('base', 'discount')
     GROUP BY pl.kind
  ),
  all_dev AS (
    SELECT cr.id, cr.name, 'pos'::text AS kind,
           CASE WHEN d.paired_at IS NULL AND d.pairing_expires_at > now()
                THEN d.pairing_code END AS code,
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
    -- Порядок по времени заведения: ПЕРВОЕ каждого вида — в тарифе.
    SELECT a.*, row_number() OVER (PARTITION BY a.kind ORDER BY a.created_at) AS n
      FROM all_dev a
  )
  SELECT r.id, r.name, r.kind, r.code, r.paired, r.last_seen_at, r.blocked,
         r.n = 1,
         CASE WHEN r.n = 1 THEN 0 ELSE coalesce(p.unit, 0) END
    FROM ranked r
    LEFT JOIN price p ON p.kind = r.kind
   ORDER BY r.kind DESC, r.n;
$$;
GRANT EXECUTE ON FUNCTION platform_devices(uuid) TO shop_app;
