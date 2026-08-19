-- =====================================================================
-- 087_partner_ranking.sql — рейтинг партнёров со шкалой зверей.
--
-- ВЗЯТО У ДОНОРА ДОСЛОВНО: восемь зверей, расчёт места и формула
-- растяжки. Их комментарий: «Дешёвая мотивация, которая работает:
-- люди смотрят, кто выше».
--
-- ШКАЛА снизу вверх: Крыса · Улитка · Хомяк · Заяц · Лиса · Волк ·
-- Лев · Орёл.
--
-- МЕСТО по числу ПЛАТЯЩИХ клиентов, при равенстве — по общему числу.
--
-- ЗВЕРЬ не по месту, а по ДОЛЕ в списке: восемь зверей растягиваются
-- на любое число партнёров. Один партнёр — сразу Орёл, двое — Орёл и
-- Крыса, двадцать — каждый третий меняет зверя.
--
-- СДЕЛАНО ИНАЧЕ, ЧЕМ У ДОНОРА, — ОДНО. У них раздел закрыт для
-- партнёра целиком: «if role !== SUPER throw Forbidden». То есть
-- соревнование видит только тот, кто в нём не участвует.
--
-- У нас партнёр видит таблицу, но ЧУЖИЕ ИМЕНА СКРЫТЫ: вместо имени
-- стоит зверь. Своя строка — с именем и пометкой «вы». Так человек
-- видит, на каком он месте и насколько отстал, но не знает, кого
-- именно обгонять — и не пойдёт переманивать чужих клиентов.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_ranking(p_role text, p_user uuid)
RETURNS TABLE (
  place integer, animal text, name text, is_me boolean,
  clients integer, paid integer, mrr bigint)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  -- Шкала донора дословно. Порядок важен: первый — последнее место.
  ANIMALS text[] := ARRAY['🐀 Крыса','🐌 Улитка','🐹 Хомяк','🐰 Заяц',
                          '🦊 Лиса','🐺 Волк','🦁 Лев','🦅 Орёл'];
  n integer;
BEGIN
  CREATE TEMP TABLE _rank ON COMMIT DROP AS
  SELECT pu.id,
         pu.full_name,
         count(*)::integer AS clients,
         -- ПЛАТЯТ — тем же правилом, что в сводке: срок не вышел И
         -- была хоть одна подтверждённая оплата. Иначе рейтинг скажет
         -- одно, а сводка другое, и обеим перестанут верить.
         count(*) FILTER (WHERE s.paid_until > now() AND EXISTS (
           SELECT 1 FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'approved'))::integer AS paid,
         coalesce(sum(platform_monthly(a.id)) FILTER (
           WHERE s.paid_until > now() AND EXISTS (
             SELECT 1 FROM tenant_payment tp
              WHERE tp.account_id = a.id AND tp.status = 'approved')), 0)::bigint AS mrr
    FROM platform_user pu
    JOIN tenant_card tc ON tc.partner_id = pu.id
    JOIN account a ON a.id = tc.account_id AND a.deleted_at IS NULL
    LEFT JOIN subscription s ON s.account_id = a.id
   WHERE pu.role = 'partner' AND pu.deleted_at IS NULL
     AND coalesce(tc.is_demo, false) = false
   GROUP BY pu.id, pu.full_name;

  SELECT count(*) INTO n FROM _rank;
  IF n = 0 THEN RETURN; END IF;

  RETURN QUERY
  WITH ordered AS (
    -- Место: платящие, при равенстве — общее число клиентов.
    SELECT r.*, row_number() OVER (ORDER BY r.paid DESC, r.clients DESC)::integer AS pl
      FROM _rank r
  )
  SELECT o.pl,
         -- Формула донора: доля в списке растягивает восемь зверей.
         ANIMALS[1 + CASE WHEN n <= 1 THEN array_length(ANIMALS, 1) - 1
                          ELSE greatest(0, least(array_length(ANIMALS, 1) - 1,
                            round((n - o.pl)::numeric / (n - 1)
                                  * (array_length(ANIMALS, 1) - 1))::integer))
                     END],
         -- ЧУЖИЕ ИМЕНА СКРЫТЫ от партнёра: он видит своё место и
         -- насколько отстал, но не знает, у кого переманивать клиентов.
         CASE WHEN p_role = 'super' OR o.id = p_user THEN o.full_name
              ELSE NULL END,
         o.id = p_user,
         o.clients, o.paid, o.mrr
    FROM ordered o
   ORDER BY o.pl;
END; $$;
GRANT EXECUTE ON FUNCTION platform_ranking(text, uuid) TO shop_app;
