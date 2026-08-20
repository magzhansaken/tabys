-- =====================================================================
-- 100_device_list.sql — список устройств клиента с кодами.
--
-- В карточке стояли одни счётчики: «Кассы 2 из 2». Владелец платформы
-- видел ЧИСЛО, но не мог ответить на вопрос, с которым к нему звонят:
-- «какой код у моей второй кассы?»
--
-- Приходилось лезть в базу руками. Теперь список рядом со счётчиком.
--
-- УСТРОЙСТВО тут не то же, что КАССА. Касса — рабочее место в
-- магазине. Устройство — телефон или планшет, привязанный к этой
-- кассе. У кассы может не быть привязанного устройства (её завели, но
-- ещё не подключили), и это самое частое состояние сразу после
-- продажи: код выдан, а приложение ещё не поставили.
--
-- Поэтому показываем КАССЫ, а код и живость берём у привязанного к ней
-- устройства, если оно есть.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_devices(p_account uuid)
RETURNS TABLE (
  id uuid, name text, kind text, code text,
  paired boolean, last_seen timestamptz, blocked boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT cr.id, cr.name, 'pos'::text,
         -- Код показываем, только если он ЖИВОЙ и касса не привязана.
         --
         -- Код живёт полчаса и выдаётся кнопкой — это верно, он как
         -- ключ от двери. Показывать просроченный нельзя: человек
         -- продиктует его, а он не подойдёт, и виноватой окажется
         -- система.
         CASE WHEN d.paired_at IS NULL AND d.pairing_expires_at > now()
              THEN d.pairing_code END,
         d.paired_at IS NOT NULL,
         d.last_seen_at,
         coalesce(d.is_blocked, false)
    FROM cash_register cr
    LEFT JOIN LATERAL (
      SELECT * FROM device dv
       WHERE dv.cash_register_id = cr.id AND dv.deleted_at IS NULL
       ORDER BY dv.paired_at DESC NULLS LAST, dv.created_at DESC
       LIMIT 1
    ) d ON true
   WHERE cr.account_id = p_account AND cr.deleted_at IS NULL

  UNION ALL

  -- Точки: у них кода нет, они не подключаются приложением.
  SELECT s.id, s.name, 'store'::text, NULL, true, NULL, false
    FROM store s
   WHERE s.account_id = p_account AND s.deleted_at IS NULL

   ORDER BY 3 DESC, 2;
$$;
GRANT EXECUTE ON FUNCTION platform_devices(uuid) TO shop_app;
