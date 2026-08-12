-- =====================================================================
-- 043_rfm.sql — Часть 37: RFM-анализ клиентов.
--
-- Разбор рынка (веб-поиск 2026):
--  • RFM = Recency (давность последней покупки), Frequency (число покупок),
--    Monetary (сумма/средний чек). Каждый → балл; итог трёхзначный код.
--  • Для РОЗНИЦЫ: R = дни с последней покупки, F = число чеков за период,
--    M = сумма покупок. Пороги подбираются под бизнес.
--  • Сегменты: чемпионы (высокие R/F/M), лояльные, под угрозой оттока
--    (низкий R, высокие F/M), новички, потерянные (низкий R и F).
--  • Цель: не просто «вклад клиента» (это у нас уже есть, часть 31), а
--    СЕГМЕНТАЦИЯ ДЛЯ ДЕЙСТВИЙ — кому скидку, кого реактивировать.
--
-- Разбор конкурентов:
--  • МойСклад: RFM есть, но платным шаблоном (доп. опция CRM), только для
--    печати, пороги вручную в Excel. Мы делаем встроенным и с готовыми
--    сегментами-рекомендациями.
--  • Wipon, UMAG: RFM нет.
--
-- Что было у нас: customer_economics (часть 31 — вклад, средний чек),
-- segment/segment_member (лояльность — для рассылок). RFM надстраивается:
-- считает R/F/M-баллы и раскладывает по именованным сегментам, которые можно
-- отправить в рассылку.
--
-- НАШ ВЫВОД:
--  1) RFM-баллы 1-3 (для магазина у дома проще и понятнее, чем 1-5):
--     R: ≤14 дн=3, ≤45=2, иначе=1;  F: ≥5 покупок=3, ≥2=2, иначе=1;
--     M: по средней сумме — верхняя треть=3, средняя=2, нижняя=1.
--  2) Сегменты по сумме баллов и паттерну — с человеческими названиями и
--     рекомендацией действия.
--  3) НЕ делаем ML-прогноз оттока/CLV — избыточно; для магазина у дома важна
--     понятная сегментация, а не модель.
-- =====================================================================

-- RFM по клиентам за период. Пороги R/F передаются параметрами (гибко под
-- бизнес). M считается относительно распределения (треть/треть/треть).
CREATE OR REPLACE FUNCTION rfm_analysis(
  p_account uuid, p_from timestamptz, p_to timestamptz,
  p_r_hot integer DEFAULT 14, p_r_warm integer DEFAULT 45,
  p_f_hot integer DEFAULT 5, p_f_warm integer DEFAULT 2)
RETURNS TABLE (
  customer_id uuid, name text, last_days integer, purchases bigint,
  total numeric, avg_check numeric, r integer, f integer, m integer, rfm text
) LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT cp.id, cp.name,
           EXTRACT(DAY FROM (p_to - max(s.created_at)))::int AS last_days,
           count(*) FILTER (WHERE s.return_of_id IS NULL) AS purchases,
           coalesce(sum(CASE WHEN s.return_of_id IS NULL THEN s.total ELSE -s.total END), 0) AS total,
           coalesce(avg(s.total) FILTER (WHERE s.return_of_id IS NULL), 0) AS avg_check
      FROM sale s
      JOIN counterparty cp ON cp.id = s.customer_id
     WHERE s.account_id = p_account AND s.customer_id IS NOT NULL
       AND s.created_at >= p_from AND s.created_at < p_to
     GROUP BY cp.id, cp.name
  ),
  scored AS (
    SELECT *,
      CASE WHEN last_days <= p_r_hot THEN 3 WHEN last_days <= p_r_warm THEN 2 ELSE 1 END AS r,
      CASE WHEN purchases >= p_f_hot THEN 3 WHEN purchases >= p_f_warm THEN 2 ELSE 1 END AS f,
      ntile(3) OVER (ORDER BY total) AS m
    FROM base
  )
  SELECT id, name, last_days, purchases, total, avg_check, r, f, m,
         (r::text || f::text || m::text) AS rfm
    FROM scored
   ORDER BY (r + f + m) DESC, total DESC;
$$;
