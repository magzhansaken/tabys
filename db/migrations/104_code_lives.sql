-- =====================================================================
-- 104_code_lives.sql — код живёт до привязки, а не полчаса.
--
-- КАК У ДОНОРА. У них код рождается вместе с устройством и живёт, пока
-- его не ввели: владелец платформы открывает список и видит все коды
-- разом — диктует нужный, не нажимая ничего.
--
-- У МЕНЯ БЫЛО ИНАЧЕ: код брался кнопкой и жил полчаса. В списке его не
-- было, пока не нажмёшь.
--
-- ПОЧЕМУ ИХ ЛУЧШЕ. Код нужен ОДИН раз при первом запуске и работает
-- только на привязку. Полчаса — это звонок владельцу, поиск кассира,
-- установка приложения, «а где тут ввести». Не успел — звони заново.
-- Так и будет каждый раз.
--
-- Опасность мала: украсть код значит привязать свой планшет к чужой
-- кассе, а это видно в тот же час — настоящая касса перестанет
-- работать, и хозяин позвонит.
--
-- КОД ГАСНЕТ ПРИ ПРИВЯЗКЕ — это осталось. Введённый второй раз он не
-- подойдёт: одно устройство, один код.
-- =====================================================================

-- Живущим устройствам без кода выдаём его: они заведены до этой
-- правки и остались бы без кода навсегда.
INSERT INTO device (account_id, cash_register_id, name, pairing_code, pairing_expires_at)
SELECT cr.account_id, cr.id, cr.name,
       'TBS-' || upper(substr(md5(random()::text || cr.id::text), 1, 4))
              || '-' || lpad((1000 + floor(random() * 9000))::int::text, 4, '0'),
       now() + interval '10 years'
  FROM cash_register cr
 WHERE cr.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM device d
                    WHERE d.cash_register_id = cr.id AND d.deleted_at IS NULL);

-- Прежним непривязанным продлеваем срок: они выданы кнопкой и вот-вот
-- сгорят, а человек, может быть, как раз диктует их по телефону.
UPDATE device SET pairing_expires_at = now() + interval '10 years'
 WHERE paired_at IS NULL AND deleted_at IS NULL
   AND pairing_expires_at < now() + interval '1 year';

-- =====================================================================
-- Добавление устройства теперь сразу даёт ему код.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_device_add(
  p_account uuid, p_kind text, p_price bigint, p_name text DEFAULT NULL)
RETURNS TABLE (device_id uuid, device_name text, code text)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  v_store uuid; v_n integer; v_name text; v_code text; v_id uuid;
BEGIN
  SELECT id INTO v_store FROM store
   WHERE account_id = p_account AND deleted_at IS NULL
   ORDER BY name LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'У магазина нет ни одной точки — сначала заведите точку';
  END IF;

  IF p_kind = 'pos' THEN
    SELECT count(*) + 1 INTO v_n FROM cash_register
     WHERE account_id = p_account AND deleted_at IS NULL;
    v_name := coalesce(nullif(btrim(p_name), ''), 'Касса ' || v_n);
    v_code := 'TBS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4))
              || '-' || lpad((1000 + floor(random() * 9000))::int::text, 4, '0');

    INSERT INTO cash_register (account_id, store_id, name)
    VALUES (p_account, v_store, v_name) RETURNING id INTO v_id;

    -- КОД СРАЗУ, а не по кнопке. Человек заводит кассу и тут же
    -- диктует код — без второго действия и без гонки с получасом.
    INSERT INTO device (account_id, cash_register_id, name,
                        pairing_code, pairing_expires_at)
    VALUES (p_account, v_id, v_name, v_code, now() + interval '10 years');
  ELSE
    SELECT count(*) + 1 INTO v_n FROM store
     WHERE account_id = p_account AND deleted_at IS NULL;
    v_name := coalesce(nullif(btrim(p_name), ''), 'Точка ' || v_n);
    v_code := NULL;

    INSERT INTO store (account_id, name) VALUES (p_account, v_name)
    RETURNING id INTO v_id;
  END IF;

  IF p_price > 0 THEN
    INSERT INTO plan_line (account_id, kind, title, qty, unit_price)
    VALUES (p_account, p_kind, v_name, 1, p_price);
  END IF;

  RETURN QUERY SELECT v_id, v_name, v_code;
END; $$;
GRANT EXECUTE ON FUNCTION platform_device_add(uuid, text, bigint, text) TO shop_app;

-- =====================================================================
-- Список: код показываем, пока устройство не привязано. Срок больше не
-- смотрим — он теперь десять лет и ни о чём не говорит.
-- =====================================================================
DROP FUNCTION IF EXISTS platform_devices(uuid);
CREATE FUNCTION platform_devices(p_account uuid)
RETURNS TABLE (
  id uuid, name text, kind text, code text,
  paired boolean, last_seen timestamptz, blocked boolean,
  in_plan boolean, monthly bigint, line_title text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH price AS (
    SELECT pl.kind::text AS kind, max(pl.unit_price) AS unit,
           max(pl.title) AS title
      FROM plan_line pl
     WHERE pl.account_id = p_account AND pl.ends_at IS NULL
       AND pl.kind NOT IN ('base', 'discount')
     GROUP BY pl.kind
  ),
  all_dev AS (
    SELECT cr.id, cr.name, 'pos'::text AS kind,
           -- Код виден, ПОКА НЕ ПРИВЯЗАНО. Срок не смотрим: он теперь
           -- десять лет и ни о чём не говорит.
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
         CASE WHEN r.n = 1 THEN 0 ELSE coalesce(p.unit, 0) END,
         -- Название строки счёта: человек видит, ЗА ЧТО именно платит.
         CASE WHEN r.n = 1 THEN NULL ELSE p.title END
    FROM ranked r
    LEFT JOIN price p ON p.kind = r.kind
   ORDER BY r.kind DESC, r.n;
$$;
GRANT EXECUTE ON FUNCTION platform_devices(uuid) TO shop_app;
