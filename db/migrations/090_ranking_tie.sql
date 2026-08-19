-- =====================================================================
-- 090_ranking_tie.sql — при равенстве решают деньги.
--
-- НАЙДЕНО НА ЖИВЫХ ДАННЫХ. В рейтинге вышло так:
--
--   1. 🦅 Орёл  Ерлан  платят 2 · 16 800 ₸
--   2. 🐺 Волк  Галым  платят 2 · 17 800 ₸   ← ПРИНОСИТ БОЛЬШЕ
--
-- Место считается по числу платящих — у обоих по два. При равенстве по
-- общему числу клиентов — у обоих по три. Больше правил у донора НЕТ,
-- и порядок при полном равенстве зависит от того, как база вернула
-- строки. То есть случаен.
--
-- Расчёт не ошибается, но выглядит несправедливо: человек приносит
-- больше денег и стоит ниже. А рейтинг для того и висит, чтобы люди
-- смотрели, кто выше, — если он врёт, смотреть перестанут.
--
-- Добавлен третий ключ: ДОХОД ИХ КЛИЕНТОВ. Совпасть по всем трём почти
-- невозможно, а если совпадёт — сортируем по имени, чтобы порядок хотя
-- бы не прыгал при каждом открытии.
-- =====================================================================
CREATE OR REPLACE FUNCTION platform_ranking(p_role text, p_user uuid)
RETURNS TABLE (
  place integer, animal text, name text, is_me boolean,
  clients integer, paid integer, mrr bigint)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE
  ANIMALS text[] := ARRAY['🐀 Крыса','🐌 Улитка','🐹 Хомяк','🐰 Заяц',
                          '🦊 Лиса','🐺 Волк','🦁 Лев','🦅 Орёл'];
  n integer;
BEGIN
  CREATE TEMP TABLE _rank ON COMMIT DROP AS
  SELECT pu.id,
         pu.full_name,
         count(*)::integer AS clients,
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
    -- Место: платящие, потом все клиенты, потом ДЕНЬГИ. Третий ключ
    -- добавлен нами: без него двое с равным числом клиентов вставали в
    -- случайном порядке, и тот, кто приносит больше, оказывался ниже.
    SELECT r.*, row_number() OVER (
             ORDER BY r.paid DESC, r.clients DESC, r.mrr DESC, r.full_name
           )::integer AS pl
      FROM _rank r
  )
  SELECT o.pl,
         ANIMALS[1 + CASE WHEN n <= 1 THEN array_length(ANIMALS, 1) - 1
                          ELSE greatest(0, least(array_length(ANIMALS, 1) - 1,
                            round((n - o.pl)::numeric / (n - 1)
                                  * (array_length(ANIMALS, 1) - 1))::integer))
                     END],
         CASE WHEN p_role = 'super' OR o.id = p_user THEN o.full_name
              ELSE NULL END,
         o.id = p_user,
         o.clients, o.paid, o.mrr
    FROM ordered o
   ORDER BY o.pl;
END; $$;
GRANT EXECUTE ON FUNCTION platform_ranking(text, uuid) TO shop_app;
